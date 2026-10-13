import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { db } from '../src/db/index.js';
import { setup } from './helpers.js';

let api: Awaited<ReturnType<typeof setup>>['api'];
let app: Awaited<ReturnType<typeof setup>>['app'];
beforeAll(async () => {
  ({ api, app } = await setup());
});

async function signIn(email: string) {
  const agent = request.agent(app);
  await agent.post('/api/auth/login').set('X-Requested-With', 'addendum-crm').send({ email, password: 'addendum-demo' });
  return {
    post: (url: string, body: object = {}) => agent.post(url).set('X-Requested-With', 'addendum-crm').send(body),
    patch: (url: string, body: object = {}) => agent.patch(url).set('X-Requested-With', 'addendum-crm').send(body),
  };
}

import { renderTemplate } from '../src/lib/template.js';

describe('Filling in placeholders', () => {
  it('drops empty placeholders and the word that introduces them', () => {
    expect(renderTemplate('Book your move-up with {stylist}: {bookingUrl}', { stylist: '', bookingUrl: 'x.com' })).toBe('Book your move-up: x.com');
    expect(renderTemplate('See you on {date} at {time}!', { date: 'Oct 14', time: '' })).toBe('See you on Oct 14!');
    expect(renderTemplate('Hi {firstName}, see you with {stylist}.', { firstName: 'Ava', stylist: 'Tori' })).toBe('Hi Ava, see you with Tori.');
  });
});

describe('Saved replies', () => {
  it('comes with a starter set the salon can edit', async () => {
    const s = (await api.get('/api/settings')).body.settings;
    expect(s.replies.items.length).toBeGreaterThanOrEqual(10);
    expect(s.replies.items.every((r: any) => r.title && r.body && Array.isArray(r.situations))).toBe(true);
  });

  it('suggests the replies that fit a follow-up first, filled in for that client', async () => {
    const task = await db().one<any>(
      `SELECT t.id, c.first_name FROM tasks t JOIN clients c ON c.id = t.client_id WHERE t.type = 'rebook' AND t.status = 'due' LIMIT 1`);
    const r = (await api.post('/api/messages/replies/suggest', { taskId: task.id })).body;
    expect(r.situation).toBe('rebooking');
    expect(r.replies[0].matches).toBe(true);
    expect(r.replies[0].situations).toContain('rebooking');
    expect(r.replies[0].text).toContain(task.first_name);
    expect(r.replies[0].text).not.toMatch(/\{\w+\}/); // every placeholder filled
    // Non-matching replies are still offered, after the matching ones.
    const firstNonMatch = r.replies.findIndex((x: any) => !x.matches);
    expect(r.replies.slice(firstNonMatch).every((x: any) => !x.matches)).toBe(true);
  });

  it('reads what a text is about (e.g. a pricing question)', async () => {
    const inbound = await api.post('/api/demo/inbound-sms', { from: '+16195558801', body: 'Hi! How much is a full balayage?' });
    const r = (await api.post('/api/messages/replies/suggest', { conversationId: inbound.body.conversationId })).body;
    expect(r.situation).toBe('pricing');
    expect(r.replies[0].situations).toContain('pricing');
  });

  it('saves custom replies and uses them straight away', async () => {
    const s = (await api.get('/api/settings')).body.settings;
    const custom = { id: 'custom-1', title: 'Extensions care', situations: ['thanks', 'general'], body: 'Hi {firstName}! Remember to brush from the ends up 💛 {signature}' };
    const saved = await api.patch('/api/settings', { replies: { items: [custom, ...s.replies.items] } });
    expect(saved.status).toBe(200);
    const client = (await api.get('/api/clients?q=Olivia')).body.clients[0];
    const r = (await api.post('/api/messages/replies/suggest', { clientId: client.id })).body;
    const mine = r.replies.find((x: any) => x.id === 'custom-1');
    expect(mine.text).toBe('Hi Olivia! Remember to brush from the ends up 💛 — Addendum Salon');
  });

  it('rejects replies without a name or message', async () => {
    expect((await api.patch('/api/settings', { replies: { items: [{ id: 'x', title: '', body: 'Hi', situations: [] }] } })).status).toBe(400);
    expect((await api.patch('/api/settings', { replies: { items: [{ id: 'x', title: 'Hi', body: '', situations: [] }] } })).status).toBe(400);
  });

  it('receptionists can use saved replies but only admins change them; stylists have no texting', async () => {
    const receptionist = await signIn('frontdesk@addendumsalon.com');
    const client = (await api.get('/api/clients?q=Olivia')).body.clients[0];
    expect((await receptionist.post('/api/messages/replies/suggest', { clientId: client.id })).status).toBe(200);
    expect((await receptionist.patch('/api/settings', { replies: { items: [] } })).status).toBe(403);
    const stylist = await signIn('jennifer@addendumsalon.com');
    expect((await stylist.post('/api/messages/replies/suggest', { clientId: client.id })).status).toBe(403);
  });
});
