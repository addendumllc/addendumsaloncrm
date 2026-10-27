import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { db } from '../src/db/index.js';
import { setGmailOverride, type GmailClient, type GmailMessage } from '../src/integrations/google/gmail.js';
import { classify, parseShowit } from '../src/domain/showit.js';
import { setKV } from '../src/repos/settings.js';
import { setup } from './helpers.js';

let api: Awaited<ReturnType<typeof setup>>['api'];
const SHOWIT = 'noreply@showit.co';
const ext = (name: string, email: string, phone = '(949) 555-0142') => [
  `First and Last Name: ${name}`, `Email: ${email}`, `Phone: ${phone}`, 'Instagram Handle: @hair.by.me',
  'Have you worn extensions before? If so, how was the experience?: Yes, tape-ins, loved them',
  'What goals are you hoping to achieve?: Length and volume', 'How often can you come in for maintenance?: Every 8 weeks',
  'Page: https://addendumsalon.com/contact',
].join('\n');

/** A simulated mailbox: messages, labels added, and what was searched. */
class FakeGmail implements GmailClient {
  msgs: GmailMessage[] = [];
  labelled = new Map<string, string[]>();
  async email() { return 'salon.addendum@gmail.com'; }
  async ensureLabel(name: string) { return `Label_${name.length}`; }
  async search(q: string) { const from = [...q.matchAll(/from:(\S+?)[ }]/g)].map((m) => m[1]); return this.msgs.filter((m) => !from.length || from.some((f) => m.from.includes(f))).map((m) => m.id).reverse(); }
  async get(id: string) { return this.msgs.find((m) => m.id === id)!; }
  async addLabel(id: string, labelId: string) { this.labelled.set(id, [...(this.labelled.get(id) ?? []), labelId]); }
  add(id: string, text: string, from = `Showit <${SHOWIT}>`, subject = 'New form submission') {
    this.msgs.push({ id, threadId: id, from, subject, date: new Date().toISOString(), snippet: text.slice(0, 80), text, labelIds: ['INBOX'] });
  }
}
const gmail = new FakeGmail();

beforeAll(async () => {
  ({ api } = await setup());
  setGmailOverride(gmail);
  await setKV('showit.settings', null as any);
  await db().query('DELETE FROM showit_messages');
});
afterAll(() => setGmailOverride(undefined));

describe('Website Inquiries (Showit → Gmail)', () => {
  it('parses a Showit notification and tells extension consultations from general inquiries', () => {
    const p = parseShowit(ext('Ava Stone', 'ava@example.com'));
    expect(p.contact).toMatchObject({ name: 'Ava Stone', email: 'ava@example.com', phone: '+19495550142', instagram: '@hair.by.me' });
    expect(p.page).toBe('https://addendumsalon.com/contact');
    expect(classify(p).kind).toBe('extension');
    expect(classify(parseShowit('Name: Bo Lee\nEmail: bo@example.com\nMessage: Do you do balayage?\nPhone: 949 555 0100')).kind).toBe('general');
    expect(classify(parseShowit('Name: Bo Lee\nEmail: bo@example.com\nMessage: Do you do k-tips?')).kind).toBeNull(); // unclear → review
    expect(classify(parseShowit('Hello there')).kind).toBeNull();
  });

  it('reads nothing until a sender is verified; candidates are shown for checking first', async () => {
    gmail.add('m1', ext('Ava Stone', 'ava@example.com'));
    expect((await api.post('/api/integrations/showit/check')).body.result.skipped).toMatch(/No Showit sender/);
    const c = (await api.get('/api/integrations/showit/candidates')).body.candidates;
    expect(c[0]).toMatchObject({ sender: SHOWIT, classification: { kind: 'extension' } });
    expect((await db().query('SELECT 1 FROM showit_messages')).length).toBe(0);
  });

  it('files each submission once — extension to its person, general to the front desk, unclear to review — with one follow-up', async () => {
    const staff = await db().query<any>("SELECT id FROM staff WHERE active ORDER BY name LIMIT 2");
    await api.put('/api/integrations/showit/settings', { senders: [SHOWIT], extensionAssigneeId: staff[0].id, frontDeskAssigneeId: staff[1].id });
    // Notifications from before the sender was verified aren't brought in; new ones are.
    gmail.msgs = [];
    gmail.add('m2', ext('Ava Stone', 'ava@example.com'));
    gmail.add('m3', 'Name: Bo Lee\nEmail: bo@example.com\nPhone: 949 555 0100\nMessage: Do you do balayage?');
    gmail.add('m4', 'Name: Cy Park\nEmail: cy@example.com\nMessage: Are k-tips right for me?');
    gmail.add('m5', 'Name: Spam\nEmail: x@example.com\nMessage: hi', 'Someone <someone@example.com>');
    const r = (await api.post('/api/integrations/showit/check')).body.result;
    expect(r).toMatchObject({ read: 3, processed: 2, review: 1 });
    expect(gmail.labelled.has('m5')).toBe(false); // not a verified sender: never read or labelled
    expect([...gmail.labelled.keys()].sort()).toEqual(['m2', 'm3', 'm4']);
    const ava = await db().one<any>("SELECT * FROM leads WHERE email = 'ava@example.com'");
    expect(ava).toMatchObject({ source: 'Website', service_interest: 'Extension consultation', assigned_staff_id: staff[0].id });
    expect(ava.notes).toMatch(/addendumsalon\.com\/contact/);
    const bo = await db().one<any>("SELECT * FROM leads WHERE email = 'bo@example.com'");
    expect(bo).toMatchObject({ service_interest: 'General inquiry', assigned_staff_id: staff[1].id });
    expect((await db().query("SELECT 1 FROM tasks WHERE lead_id = $1 AND status <> 'done'", [ava.id])).length).toBe(1);
    // Checking again files nothing twice; the same submission arriving again is a duplicate.
    expect((await api.post('/api/integrations/showit/check')).body.result.read).toBe(0);
    gmail.add('m6', ext('Ava Stone', 'ava@example.com'));
    gmail.msgs.at(-1)!.date = gmail.msgs.find((m) => m.id === 'm2')!.date;
    expect((await api.post('/api/integrations/showit/check')).body.result.duplicate).toBe(1);
    expect((await db().query("SELECT 1 FROM leads WHERE email = 'ava@example.com'")).length).toBe(1);
    // Follow-Ups → Website inquiries lists the submissions (not duplicates), the unclear one waiting for review.
    const listed = (await api.get('/api/leads/website-inquiries')).body.history;
    expect(listed.map((h: any) => h.status).sort()).toEqual(['processed', 'processed', 'review']);
    // The unclear one is filed (from Follow-Ups or Settings).
    const resolved = await api.post('/api/leads/website-inquiries/m4/resolve', { action: 'extension', phone: '949 555 0199' });
    expect(resolved.status).toBe(200);
    expect(await db().one<any>("SELECT service_interest FROM leads WHERE email = 'cy@example.com'")).toMatchObject({ service_interest: 'Extension consultation' });
    const overview = (await api.get('/api/integrations/showit')).body;
    expect(overview.history.map((h: any) => h.status).sort()).toEqual(['duplicate', 'processed', 'processed', 'processed']);
  });

  it('a new submission from an open inquiry adds a note and one follow-up instead of a second inquiry', async () => {
    const ava = await db().one<any>("SELECT id FROM leads WHERE email = 'ava@example.com'");
    gmail.add('m7', ext('Ava Stone', 'ava@example.com').replace('Length and volume', 'Now just volume'));
    expect((await api.post('/api/integrations/showit/check')).body.result.processed).toBe(1);
    expect((await db().query("SELECT 1 FROM leads WHERE email = 'ava@example.com'")).length).toBe(1);
    expect((await db().query('SELECT 1 FROM notes WHERE lead_id = $1', [ava.id])).length).toBe(1);
    expect((await db().query("SELECT 1 FROM tasks WHERE dedupe_key = 'showit:m7'")).length).toBe(1);
  });
});
