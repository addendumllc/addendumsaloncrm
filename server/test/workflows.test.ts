import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../src/db/index.js';
import { runRules } from '../src/domain/rulesEngine.js';
import { runSquareSync } from '../src/domain/squareSync.js';
import { demoSquareSimulator, loadDemoSquare } from '../src/integrations/square/MockSquareService.js';
import { loadDemoHL } from '../src/integrations/highlevel/MockHighLevelService.js';
import { computeRebooking } from '../src/domain/rebooking.js';
import { verifySquareSignature } from '../src/integrations/square/webhooks.js';
import crypto from 'node:crypto';
import { setup } from './helpers.js';

let api: Awaited<ReturnType<typeof setup>>['api'];
let agent: Awaited<ReturnType<typeof setup>>['agent'];

beforeAll(async () => {
  ({ api, agent } = await setup());
});

/** Opens a text in Apple Messages (simulated) and marks it sent, like staff do. */
async function textViaMessages(body: object, completeTaskId?: string) {
  const opened = await api.post('/api/messages/handoff', body);
  expect(opened.status).toBe(200);
  const marked = await api.post(`/api/messages/${opened.body.message.id}/outcome`, { outcome: 'sent', completeTaskId });
  expect(marked.status).toBe(200);
  return marked.body.message;
}

describe('Workflow 1 — Square appointment → imported → calendar → linked to client', () => {
  it('imports a new Square booking and links it to the client', async () => {
    const sq = await loadDemoSquare();
    const customer = { id: 'wf1-cust', given_name: 'Tessa', family_name: 'Moreno', phone_number: '(619) 555-7001', email_address: 'tessa@example.com' };
    const start = new Date(Date.now() + 2 * 86400_000);
    await demoSquareSimulator.createBooking({
      status: 'ACCEPTED', start_at: start.toISOString(), location_id: sq.locations[0].id, customer_id: customer.id,
      appointment_segments: [{ duration_minutes: 90, service_variation_id: sq.services[0].variationId, team_member_id: sq.team[1].id }],
    }, customer);

    const sync = await api.post('/api/integrations/square/sync');
    expect(sync.status).toBe(200);
    expect(sync.body.result.ok).toBe(true);
    expect(sync.body.result.created).toBeGreaterThanOrEqual(1);

    const cal = await api.get(`/api/appointments?from=${new Date(start.getTime() - 3600_000).toISOString()}&to=${new Date(start.getTime() + 3600_000).toISOString()}`);
    const appt = cal.body.appointments.find((a: any) => a.clientName === 'Tessa Moreno');
    expect(appt).toBeTruthy();
    expect(appt.squareBookingId).toMatch(/^demo-bk-/);
    expect(appt.serviceNames).toEqual([sq.services[0].name]);
    expect(appt.displayStatus).toBe('confirmed');
    expect(appt.clientPhone).toBe('+16195557001');

    const profile = await api.get(`/api/clients/${appt.clientId}`);
    expect(profile.status).toBe(200);
    expect(profile.body.client.squareCustomerId).toBe('wf1-cust');
    expect(profile.body.client.nextAppointmentAt).toBe(appt.startAt);
  });

  it('reports a friendly status and keeps data when a sync fails', async () => {
    const before = (await db().one<any>('SELECT count(*)::int n FROM appointments')).n;
    const { setIntegrationOverride } = await import('../src/integrations/registry.js');
    const { IntegrationError } = await import('../src/lib/errors.js');
    const { MockSquareService } = await import('../src/integrations/square/MockSquareService.js');
    const broken = new MockSquareService();
    broken.listBookings = async () => { throw new IntegrationError('square', 'Square connection expired. Please reconnect.', false, true); };
    setIntegrationOverride({ square: broken });
    const r = await runSquareSync();
    expect(r.ok).toBe(false);
    expect(r.message).toBe('Square connection expired. Please reconnect.');
    expect((await db().one<any>('SELECT count(*)::int n FROM appointments')).n).toBe(before);
    setIntegrationOverride({ square: new MockSquareService() });
  });
});

describe('Workflow 2 — Square cancellation → detected → rebooking recommendation', () => {
  it('detects the cancellation and creates a cancellation follow-up, which auto-closes on rebook', async () => {
    const appts = (await api.get('/api/appointments?range=upcoming')).body.appointments;
    const target = appts.find((a: any) => a.clientName === 'Penelope Wright' && a.displayStatus === 'confirmed');
    expect(target).toBeTruthy();

    // Client cancels in Square → booking.updated webhook (simulated) → sync.
    const r = await api.post(`/api/demo/square/${target.id}/cancel`);
    expect(r.body.change.events).toContain('cancelled');

    const after = (await api.get(`/api/appointments/${target.id}`)).body;
    expect(after.appointment.displayStatus).toBe('cancelled');
    expect(after.events.map((e: any) => e.event)).toContain('cancelled');

    await runRules(new Date(Date.now() + 3 * 3600_000));
    const tasks = (await api.get(`/api/tasks?clientId=${target.clientId}`)).body.tasks;
    const followUp = tasks.find((t: any) => t.type === 'cancellation');
    expect(followUp).toBeTruthy();
    expect(followUp.appointmentId).toBe(target.id);

    const dash = (await api.get('/api/dashboard')).body;
    expect(dash.actions.some((a: any) => a.key === 'cancellation')).toBe(true);

    // Client rebooks in Square → follow-up closes itself.
    await api.post('/api/demo/square/book', { clientId: target.clientId, daysFromNow: 6 });
    const closed = (await api.get(`/api/tasks/${followUp.id}`)).body.task;
    expect(closed.status).toBe('completed');
  });

  it('detects a reschedule and records the original time', async () => {
    const appts = (await api.get('/api/appointments?range=upcoming')).body.appointments;
    const target = appts.find((a: any) => a.displayStatus === 'confirmed' && !a.rescheduledFrom);
    const r = await api.post(`/api/demo/square/${target.id}/reschedule`);
    expect(r.body.change.events).toContain('rescheduled');
    const after = (await api.get(`/api/appointments/${target.id}`)).body.appointment;
    expect(after.rescheduledFrom).toBe(target.startAt);
  });
});

describe('Workflow 3 — New lead → follow-up → staff texts → task completed', () => {
  it('runs the whole lead flow', async () => {
    const created = await api.post('/api/leads', { name: 'Morgan Blake', phone: '619-555-7302', source: 'Instagram', serviceInterest: 'Balayage' });
    expect(created.status).toBe(201);
    const leadId = created.body.id;

    const list = (await api.get('/api/leads')).body.leads;
    expect(list.find((l: any) => l.id === leadId)?.status).toBe('new');

    const tasks = (await api.get(`/api/tasks?leadId=${leadId}`)).body.tasks;
    const task = tasks.find((t: any) => t.type === 'new_lead');
    expect(task).toBeTruthy();
    expect(task.priority).toBe('high');

    const draft = await api.post('/api/messages/draft', { taskId: task.id });
    expect(draft.body.kind).toBe('lead_reply');
    expect(draft.body.draft).toMatch(/Morgan/);

    // Opening Messages doesn't send anything, so nothing is marked done yet.
    const opened = await api.post('/api/messages/handoff', { leadId, body: draft.body.draft, aiGenerated: true, taskId: task.id });
    expect(opened.status).toBe(200);
    expect(opened.body.phone).toBe('+16195557302');
    expect(opened.body.message.status).toBe('opened_in_messages');
    expect((await api.get(`/api/tasks/${task.id}`)).body.task.status).not.toBe('completed');
    expect((await api.get(`/api/leads/${leadId}`)).body.lead.status).toBe('new');

    // Staff confirm they sent it from Messages.
    const marked = await api.post(`/api/messages/${opened.body.message.id}/outcome`, { outcome: 'sent', completeTaskId: task.id });
    expect(marked.body.message.status).toBe('marked_sent');
    expect((await api.post(`/api/messages/${opened.body.message.id}/outcome`, { outcome: 'not_sent' })).status).toBe(400); // already marked

    const done = (await api.get(`/api/tasks/${task.id}`)).body.task;
    expect(done.status).toBe('completed');
    const lead = (await api.get(`/api/leads/${leadId}`)).body;
    expect(lead.lead.status).toBe('waiting');
    expect(lead.messages).toHaveLength(1);
  });

  it('creates a no-response follow-up after the configured time', async () => {
    const created = await api.post('/api/leads', { name: 'Quiet Lead', phone: '619-555-7303', serviceInterest: 'Haircut' });
    await textViaMessages({ leadId: created.body.id, body: 'Hi! Would you like to book?' });
    await runRules(new Date(Date.now() + 25 * 3600_000));
    const tasks = (await api.get(`/api/tasks?leadId=${created.body.id}`)).body.tasks;
    expect(tasks.some((t: any) => t.sourceRule === 'lead_no_response')).toBe(true);
  });
});

describe('Workflow 4 — Incoming SMS → conversation → identified → AI draft → staff sends', () => {
  it('identifies an existing client', async () => {
    const client = (await api.get('/api/clients?q=Olivia')).body.clients[0];
    const inbound = await api.post('/api/demo/inbound-sms', { clientId: client.id, body: 'Hi! Can I come in next week for a gloss?' });
    expect(inbound.status).toBe(200);
    const convos = (await api.get('/api/messages/conversations?filter=unread')).body.conversations;
    const convo = convos.find((c: any) => c.id === inbound.body.conversationId);
    expect(convo.clientId).toBe(client.id);
    expect(convo.displayName).toBe('Olivia Bennett');
    expect(convo.unreadCount).toBeGreaterThan(0);
    expect(convo.insight.timeframe).toBe('Next week');

    const draft = await api.post('/api/messages/draft', { conversationId: convo.id });
    expect(draft.body.draft.length).toBeGreaterThan(10);
    // Draft is NOT sent until staff approve.
    const before = (await api.get(`/api/messages/conversations/${convo.id}`)).body.messages.length;
    expect(before).toBe((await db().one<any>('SELECT count(*)::int n FROM messages WHERE conversation_id = $1', [convo.id])).n);

    await textViaMessages({ conversationId: convo.id, body: draft.body.draft, aiGenerated: true });
    const thread = (await api.get(`/api/messages/conversations/${convo.id}`)).body;
    expect(thread.messages.at(-1).aiGenerated).toBe(true);
    expect(thread.conversation.unreadCount).toBe(0);
  });

  it('turns an unknown texter into a lead with service + timeframe detected', async () => {
    const r = await api.post('/api/demo/inbound-sms', { from: '+16195557404', body: "Hi, I'm looking to get my hair colored next week." });
    expect(r.body.insight).toMatchObject({ isPotentialLead: true, service: 'Hair Color', timeframe: 'Next week' });
    const lead = await db().one<any>("SELECT * FROM leads WHERE phone = '+16195557404'");
    expect(lead.status).toBe('new');
    expect(lead.service_interest).toBe('Hair Color');
  });

  it('honours STOP opt-outs', async () => {
    await api.post('/api/demo/inbound-sms', { from: '+16195557405', body: 'Do you have openings tomorrow?' });
    await api.post('/api/demo/inbound-sms', { from: '+16195557405', body: 'STOP' });
    const r = await api.post('/api/messages/handoff', { phone: '+16195557405', body: 'Hi there!' });
    expect(r.status).toBe(400);
    expect(r.body.error.message).toMatch(/opted out/);
  });
});

describe('Workflow 5 — Follow-up → Push to HighLevel → contact matched → task created → ID stored', () => {
  it('matches an existing HighLevel contact by phone and stores the IDs', async () => {
    const sarah = (await api.get('/api/clients?q=Sarah%20Johnson')).body.clients[0];
    const t = await api.post('/api/tasks', { type: 'follow_up', title: 'Follow up with Sarah Johnson', reason: 'Asked about balayage maintenance.', priority: 'high', dueAt: new Date().toISOString(), clientId: sarah.id });
    const push = await api.post(`/api/tasks/${t.body.id}/highlevel`);
    expect(push.body.result.status).toBe('synced');
    expect(push.body.result.contactId).toBe('demo-hlc-sarah'); // existing contact, no duplicate
    const task = push.body.task;
    expect(task.highlevel.taskId).toBeTruthy();
    const hl = await loadDemoHL();
    const hlTask = hl.tasks.find((x) => x.id === task.highlevel.taskId)!;
    expect(hlTask.title).toBe('[High] Follow up with Sarah Johnson');
    expect(hlTask.body).toMatch(/Last Square appointment/);
    expect(hlTask.body).toMatch(/follow-ups\?task=/);
    expect(hl.contacts.filter((c) => c.phone === sarah.phone)).toHaveLength(1);

    // Pushing again updates the same HighLevel task (no duplicates).
    const again = await api.post(`/api/tasks/${t.body.id}/highlevel`);
    expect(again.body.result.taskId).toBe(task.highlevel.taskId);
    expect((await loadDemoHL()).tasks.filter((x) => x.id === task.highlevel.taskId)).toHaveLength(1);

    // Completing here completes it in HighLevel.
    await api.post(`/api/tasks/${t.body.id}/complete`);
    expect((await loadDemoHL()).tasks.find((x) => x.id === task.highlevel.taskId)!.completed).toBe(true);
  });

  it('asks before creating a missing HighLevel contact', async () => {
    const lead = await api.post('/api/leads', { name: 'Fresh Contact', phone: '619-555-7506' });
    const task = (await api.get(`/api/tasks?leadId=${lead.body.id}`)).body.tasks[0];
    const first = await api.post(`/api/tasks/${task.id}/highlevel`);
    expect(first.body.result.status).toBe('needs_contact');
    const second = await api.post(`/api/tasks/${task.id}/highlevel`, { createContact: true });
    expect(second.body.result.status).toBe('synced');
  });
});

describe('Workflow 6 — HighLevel unavailable → follow-up saved → retry', () => {
  it('keeps the follow-up and retries successfully', async () => {
    await api.post('/api/demo/highlevel/outage', { on: true });
    const olivia = (await api.get('/api/clients?q=Olivia')).body.clients[0];
    const t = await api.post('/api/tasks', { type: 'call', title: 'Call Olivia', dueAt: new Date().toISOString(), clientId: olivia.id });
    const push = await api.post(`/api/tasks/${t.body.id}/highlevel`);
    expect(push.body.result.status).toBe('failed');
    expect(push.body.result.message).toBe('HighLevel task could not be created. It will be retried.');
    const saved = (await api.get(`/api/tasks/${t.body.id}`)).body.task;
    expect(saved.status).toBe('due');
    expect(saved.highlevel.status).toBe('failed');

    // Internal follow-ups keep working while HighLevel is down.
    expect((await api.post(`/api/tasks/${t.body.id}/snooze`, { until: new Date(Date.now() + 3600_000).toISOString() })).status).toBe(200);

    await api.post('/api/demo/highlevel/outage', { on: false });
    const retry = await api.post(`/api/tasks/${t.body.id}/highlevel`);
    expect(retry.body.result.status).toBe('synced');
  });

  it('background queue retries automatically', async () => {
    const { processHighLevelQueue } = await import('../src/domain/highlevelPush.js');
    await api.post('/api/demo/highlevel/outage', { on: true });
    const olivia = (await api.get('/api/clients?q=Olivia')).body.clients[0];
    const t = await api.post('/api/tasks', { type: 'text', title: 'Text Olivia', dueAt: new Date().toISOString(), clientId: olivia.id });
    await api.post(`/api/tasks/${t.body.id}/highlevel`);
    await api.post('/api/demo/highlevel/outage', { on: false });
    await db().query('UPDATE tasks SET hl_next_retry_at = now() - interval \'1 minute\' WHERE id = $1', [t.body.id]);
    await processHighLevelQueue();
    expect((await api.get(`/api/tasks/${t.body.id}`)).body.task.highlevel.status).toBe('synced');
  });
});

describe('Workflow 7 — Square history → overdue → rebooking recommendation → text or HighLevel', () => {
  it('computes cadence and only predicts with enough history', () => {
    const now = new Date('2026-10-07T12:00:00Z');
    const d = (days: number) => new Date(now.getTime() - days * 86400_000);
    const overdue = computeRebooking([d(49 + 84), d(49 + 42), d(49)], false, { minVisits: 3, graceDays: 5 }, now);
    expect(overdue).toMatchObject({ enough: true, typicalIntervalDays: 42, isOverdue: true });
    expect(overdue.message).toMatch(/every 6 weeks/);
    const notEnough = computeRebooking([d(100)], false, { minVisits: 3, graceDays: 5 }, now);
    expect(notEnough.enough).toBe(false);
    expect(notEnough.isOverdue).toBe(false);
    const booked = computeRebooking([d(49 + 84), d(49 + 42), d(49)], true, { minVisits: 3, graceDays: 5 }, now);
    expect(booked.isOverdue).toBe(false);
  });

  it('recommends rebooking overdue clients and lets staff text or push to HighLevel', async () => {
    const tasks = (await api.get('/api/tasks?type=rebook')).body.tasks;
    const victoria = tasks.find((t: any) => t.contactName === 'Victoria Lane');
    expect(victoria).toBeTruthy();
    const profile = (await api.get(`/api/clients/${victoria.clientId}`)).body;
    expect(profile.rebooking.isOverdue).toBe(true);

    const draft = await api.post('/api/messages/draft', { taskId: victoria.id });
    expect(draft.body.kind).toBe('rebooking');
    const push = await api.post(`/api/tasks/${victoria.id}/highlevel`, { createContact: true });
    expect(push.body.result.status).toBe('synced');
    await textViaMessages({ clientId: victoria.clientId, body: draft.body.draft, taskId: victoria.id }, victoria.id);
    expect((await api.get(`/api/tasks/${victoria.id}`)).body.task.status).toBe('completed');
  });
});

describe('Security', () => {
  it('rejects unauthenticated access and cross-site writes', async () => {
    const { default: request } = await import('supertest');
    const { createApp } = await import('../src/app.js');
    const anon = request(createApp());
    expect((await anon.get('/api/clients')).status).toBe(401);
    expect((await agent.post('/api/leads').send({ name: 'x', phone: '6195550000' })).status).toBe(403); // no CSRF header
  });

  it('limits stylist permissions', async () => {
    const { default: request } = await import('supertest');
    const { createApp } = await import('../src/app.js');
    const staffAgent = request.agent(createApp());
    const login = await staffAgent.post('/api/auth/login').set('X-Requested-With', 'addendum-crm').send({ email: 'jennifer@addendumsalon.com', password: 'addendum-demo' });
    expect(login.status).toBe(200);
    expect((await staffAgent.get('/api/analytics')).status).toBe(403);
    expect((await staffAgent.patch('/api/settings').set('X-Requested-With', 'addendum-crm').send({ ai: { autoSend: true } })).status).toBe(403);
    expect((await staffAgent.get('/api/leads')).status).toBe(403);
    expect((await staffAgent.get('/api/users')).status).not.toBe(200);
    expect((await staffAgent.get('/api/admin/users')).status).toBe(403);
  });

  it('verifies Square webhook signatures', () => {
    const body = '{"type":"booking.updated"}';
    const sig = crypto.createHmac('sha256', 'key').update('https://x.test/api/webhooks/square' + body).digest('base64');
    expect(verifySquareSignature(body, sig, 'key', 'https://x.test/api/webhooks/square')).toBe(true);
    expect(verifySquareSignature(body, sig, 'other', 'https://x.test/api/webhooks/square')).toBe(false);
  });

  it('has no Twilio endpoints and never sends texts automatically', async () => {
    // Unknown API paths are refused (deny by default) or not found — never handled.
    expect([403, 404]).toContain((await api.post('/api/messages/send', { phone: '+16195550101', body: 'Hi' })).status);
    expect([403, 404]).toContain((await api.post('/api/integrations/sms/test', { to: '+16195550101' })).status);
    expect([403, 404]).toContain((await api.post('/api/webhooks/twilio/sms', { From: '+16195550101', Body: 'hi' })).status);

    const s = (await api.get('/api/settings')).body.settings;
    expect(s.ai.autoSend).toBe(false);
    expect(s.reviews.autoSend).toBe(false);
    expect(s.reminders.autoSend).toBe(false);
  });
});

describe('Dashboard + analytics + search', () => {
  it('answers "who do I need to follow up with today?"', async () => {
    const r = (await api.get('/api/dashboard')).body;
    expect(r.summary.followUpsDue).toBeGreaterThan(0);
    expect(r.actions.length).toBeGreaterThan(3);
    for (const a of r.actions) expect(a.link).toMatch(/^\//);
  });
  it('analytics and search respond', async () => {
    const a = (await api.get('/api/analytics?days=90')).body;
    expect(a.appointments).toBeGreaterThan(10);
    const s = (await api.get('/api/search?q=balayage')).body;
    expect(s.appointments.length).toBeGreaterThan(0);
    const p = (await api.get('/api/search?q=555')).body;
    expect(p.clients.length).toBeGreaterThan(0);
  });
});

describe('Main domain', () => {
  it('forwards old and www addresses to APP_URL, but leaves API calls alone', async () => {
    const { default: request } = await import('supertest');
    const { createApp } = await import('../src/app.js');
    const { loadConfig } = await import('../src/config.js');
    loadConfig({ DEMO_MODE: 'true', APP_URL: 'https://addendumsalon.info', REDIRECT_HOSTS: 'www.addendumsalon.info, app.addendumsalon.com' });
    const app = request(createApp());
    const old = await app.get('/clients/123?tab=notes').set('Host', 'app.addendumsalon.com');
    expect(old.status).toBe(301);
    expect(old.headers.location).toBe('https://addendumsalon.info/clients/123?tab=notes');
    expect((await app.get('/').set('Host', 'www.addendumsalon.info')).headers.location).toBe('https://addendumsalon.info/');
    expect((await app.get('/api/health').set('Host', 'app.addendumsalon.com')).status).toBe(200);
    expect((await app.get('/api/health').set('Host', 'addendumsalon.info')).status).toBe(200);
    loadConfig({ DEMO_MODE: 'true', OWNER_EMAIL: 'owner@addendumsalon.com', OWNER_PASSWORD: 'addendum-demo', APP_URL: 'http://localhost:4000' });
  });
});
