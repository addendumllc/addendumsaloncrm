import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../src/db/index.js';
import { runRules } from '../src/domain/rulesEngine.js';
import { renderTemplate } from '../src/lib/template.js';
import { setup } from './helpers.js';

let api: Awaited<ReturnType<typeof setup>>['api'];
beforeAll(async () => {
  ({ api } = await setup());
});

const outboundCount = async () => (await db().one<any>("SELECT count(*)::int n FROM messages WHERE direction = 'outbound'")).n as number;

describe('Message templates', () => {
  it('fills placeholders and tidies blanks', () => {
    expect(renderTemplate('Hi {firstName}! See you {date} at {time} with {stylist}.', { firstName: 'Ava', date: 'Oct 9', time: '2:00 PM', stylist: '' }))
      .toBe('Hi Ava! See you Oct 9 at 2:00 PM.');
    expect(renderTemplate('Thanks {firstName} — {reviewUrl}', { firstName: 'Mia', reviewUrl: 'https://g.page/r/x' })).toBe('Thanks Mia — https://g.page/r/x');
  });
});

describe('Appointment reminders + review requests', () => {
  it("drafts reminders with the owner's template for staff to send from Messages", async () => {
    await api.patch('/api/settings', {
      reminders: { enabled: true, offsetsHours: [48, 24], template: 'Hi {firstName}, reminder: {service} on {date} at {time}. Reply C to confirm.' },
      messaging: { quietHoursStart: '00:00', quietHoursEnd: '00:00' }, // no quiet hours for the test
    });
    const before = await outboundCount();
    await runRules();
    const reminder = await db().one<any>("SELECT * FROM tasks WHERE type = 'appointment_reminder' AND status = 'due' LIMIT 1");
    expect(reminder).toBeTruthy();

    const draft = (await api.post('/api/messages/draft', { taskId: reminder.id })).body.draft as string;
    expect(draft).toMatch(/^Hi \w+, reminder: .+ on [A-Z][a-z]+ \d{1,2} at \d{1,2}:\d{2}\s?[AP]M\. Reply C to confirm\.$/);
    // Rules create follow-ups only; no text is sent in the background.
    expect(await outboundCount()).toBe(before);
    await api.patch('/api/settings', { reminders: { enabled: false } });
  });
});

describe('No background texting', () => {
  it('ignores attempts to switch automatic sending on', async () => {
    await api.patch('/api/settings', { reminders: { autoSend: true }, reviews: { autoSend: true }, ai: { autoSend: true } });
    const s = (await api.get('/api/settings')).body.settings;
    expect(s.reminders.autoSend).toBe(false);
    expect(s.reviews.autoSend).toBe(false);
    expect(s.ai.autoSend).toBe(false);
  });

  it('never replies to an incoming text by itself', async () => {
    const r = await api.post('/api/demo/inbound-sms', { from: '+16195558102', body: 'How much is a balayage?' });
    expect(r.status).toBe(200);
    const out = await db().one<any>("SELECT count(*)::int n FROM messages WHERE conversation_id = $1 AND direction = 'outbound'", [r.body.conversationId]);
    expect(out.n).toBe(0);
  });
});
