import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { suggestHairTask } from '@addendum/shared';
import { setup } from './helpers.js';

let api: Awaited<ReturnType<typeof setup>>['api'];
let app: Awaited<ReturnType<typeof setup>>['app'];

beforeAll(async () => {
  ({ api, app } = await setup());
});

describe('Addendum Hair CRM', () => {
  it('suggests a task from an email', () => {
    const s = suggestHairTask({ subject: 'Re: 22" wefts restock?', body: 'Hi!\nDo you have the 22" bundles in 60A yet?' }, '2026-10-21');
    expect(s).toMatchObject({ type: 'order', title: '22" wefts restock?', dueOn: '2026-10-23' });
    expect(suggestHairTask({ body: 'Thanks — could you send the invoice?' }, '2026-10-21')).toMatchObject({ type: 'reply', dueOn: '2026-10-22' });
  });

  it('a task from an email adds the client once, then follows up, waits and completes', async () => {
    const make = (title: string) => api.post('/api/hair/tasks', {
      client: { name: 'Bella Salon', email: 'bella@salon.test' }, title, type: 'order', source: 'email',
      sourceSubject: 'Restock', sourceFrom: 'bella@salon.test', sourceExcerpt: 'Need 3 packs', dueOn: '2026-10-23',
      description: 'Needs hair to order — not in inventory yet',
    });
    const a = await make('Order 3 packs of 60A');
    expect(a.status).toBe(201);
    expect(a.body.task).toMatchObject({ clientName: 'Bella Salon', source: 'email', status: 'open', dueOn: '2026-10-23' });
    const b = await make('Second request');
    expect(b.body.task.clientId).toBe(a.body.task.clientId); // same email, same client

    const clients = (await api.get('/api/hair/clients?q=bella')).body.clients;
    expect(clients).toEqual([expect.objectContaining({ name: 'Bella Salon', openTasks: 2 })]);

    // Waiting on the client's reply, with the next step.
    const w = await api.patch(`/api/hair/tasks/${a.body.task.id}`, { status: 'waiting', nextStep: 'Confirm colour' });
    expect(w.body.task).toMatchObject({ status: 'waiting', nextStep: 'Confirm colour' });
    expect((await api.get('/api/hair/tasks?status=waiting')).body.tasks.map((t: any) => t.id)).toEqual([a.body.task.id]);

    // Done, with a check-in scheduled.
    const d = await api.patch(`/api/hair/tasks/${a.body.task.id}`, { status: 'done', followUp: { title: 'Check the hair arrived', dueOn: '2026-11-01' } });
    expect(d.body.task.status).toBe('done');
    expect(d.body.task.completedAt).toBeTruthy();
    expect(d.body.followUp).toMatchObject({ type: 'check_in', source: 'follow_up', clientId: a.body.task.clientId, dueOn: '2026-11-01' });
    const detail = (await api.get(`/api/hair/clients/${a.body.task.clientId}`)).body;
    expect(detail.client.openTasks).toBe(2);
    expect(detail.tasks).toHaveLength(3);

    // Reopened clears the completion.
    expect((await api.patch(`/api/hair/tasks/${a.body.task.id}`, { status: 'open' })).body.task.completedAt).toBeNull();
  });

  it('is only for people with the Addendum Hair permission', async () => {
    const agent = request.agent(app);
    await agent.post('/api/auth/login').set('X-Requested-With', 'addendum-crm').send({ email: 'jennifer@addendumsalon.com', password: 'addendum-demo' });
    expect((await agent.get('/api/hair/tasks')).status).toBe(403);
  });
});

describe('Addendum Hair clients from HighLevel', () => {
  it('pulls tagged contacts, links one already on the list by email, and repeats without duplicates', async () => {
    const { MockHighLevelService, loadDemoHL, saveDemoHL } = await import('../src/integrations/highlevel/MockHighLevelService.js');
    const { setIntegrationOverride } = await import('../src/integrations/registry.js');
    await saveDemoHL({ ...(await loadDemoHL()), outage: false });
    setIntegrationOverride({ highlevel: new MockHighLevelService() });
    await api.post('/api/hair/clients', { name: 'Jade', email: 'JADE@jadehairstudio.test', notes: 'Keep me' });

    const st = (await api.get('/api/hair/highlevel')).body;
    expect(st).toMatchObject({ connected: true, source: 'main', tag: 'Addendum Hair' });
    const r = (await api.post('/api/hair/highlevel/pull')).body;
    expect(r).toMatchObject({ added: 2, updated: 1, matched: 3 }); // Bella and Rosa added; Jade linked; Sam (no tag) skipped
    const clients = (await api.get('/api/hair/clients')).body.clients;
    const jade = clients.find((c: any) => c.email?.toLowerCase() === 'jade@jadehairstudio.test');
    expect(jade).toMatchObject({ name: 'Jade Kim', company: 'Jade Hair Studio', notes: 'Keep me', fromHighLevel: true });
    expect(clients.some((c: any) => c.name === 'Sam Patel')).toBe(false);
    expect((await api.post('/api/hair/highlevel/pull')).body).toMatchObject({ added: 0, updated: 0 });

    // No tag: every contact.
    await api.put('/api/hair/highlevel', { tag: '' });
    expect((await api.post('/api/hair/highlevel/pull')).body.added).toBeGreaterThanOrEqual(1);
    expect((await api.get('/api/hair/clients?q=sam')).body.clients).toHaveLength(1);
  });
});

describe('Internal tasks for Addendum Salon or Addendum Hair', () => {
  it('are created for either business, filtered by it, and can be moved; follow-ups stay the salon’s', async () => {
    const hair = await api.post('/api/tasks', { kind: 'task', type: 'internal', title: 'Photograph new wefts', business: 'hair' });
    const salon = await api.post('/api/tasks', { kind: 'task', type: 'internal', title: 'Restock towels' });
    expect(hair.status).toBe(201);
    const list = async (b: string) => (await api.get(`/api/tasks?kind=task&business=${b}&status=any`)).body.tasks.map((t: any) => t.title);
    expect(await list('hair')).toContain('Photograph new wefts');
    expect(await list('hair')).not.toContain('Restock towels');
    expect(await list('salon')).toContain('Restock towels');
    await api.patch(`/api/tasks/${salon.body.id}`, { business: 'hair' });
    expect(await list('hair')).toContain('Restock towels');
    const t = (await api.get(`/api/tasks/${hair.body.id}`)).body.task;
    expect(t.business).toBe('hair');
  });
});

describe('Tasks: my tasks and the Done clean-up', () => {
  it('My tasks shows only the person’s own; finished internal tasks older than the chosen months are deleted', async () => {
    const { db } = await import('../src/db/index.js');
    const me = (await api.get('/api/auth/me')).body.user.id;
    const mine = await api.post('/api/tasks', { kind: 'task', type: 'internal', title: 'Mine', assignedStaffId: me });
    await api.post('/api/tasks', { kind: 'task', type: 'internal', title: 'Not mine' });
    const titles = (await api.get('/api/tasks?mine=1&kind=task')).body.tasks.map((t: any) => t.title);
    expect(titles).toContain('Mine');
    expect(titles).not.toContain('Not mine');

    await db().query("UPDATE tasks SET status = 'completed', completed_at = now() - interval '7 months' WHERE id = $1", [mine.body.id]);
    const followUp = await db().one<any>("SELECT id FROM tasks WHERE kind = 'follow_up' LIMIT 1");
    await db().query("UPDATE tasks SET status = 'completed', completed_at = now() - interval '13 months' WHERE id = $1", [followUp.id]);
    expect((await api.get('/api/tasks/retention')).body.months).toBe(12);
    const r = await api.put('/api/tasks/retention', { months: 6 });
    expect(r.body.removed).toBeGreaterThanOrEqual(1);
    expect(await db().one('SELECT 1 FROM tasks WHERE id = $1', [mine.body.id])).toBeNull();
    expect(await db().one('SELECT 1 FROM tasks WHERE id = $1', [followUp.id])).not.toBeNull(); // client follow-ups are kept
    expect((await api.put('/api/tasks/retention', { months: 3 })).status).toBe(400);
  });
});

describe('Follow-ups → Done and Inventory → To order', () => {
  it('Done shows follow-ups finished since a date; the forecast says which stores sell it and when it sells out', async () => {
    const { db } = await import('../src/db/index.js');
    const [recent, old] = await db().query<any>("SELECT id FROM tasks WHERE kind = 'follow_up' AND status IN ('due','snoozed') LIMIT 2");
    await db().query("UPDATE tasks SET status = 'completed', completed_at = now() - interval '1 month' WHERE id = $1", [recent.id]);
    await db().query("UPDATE tasks SET status = 'completed', completed_at = now() - interval '8 months' WHERE id = $1", [old.id]);
    const since = new Date(Date.now() - 182 * 86400_000).toISOString().slice(0, 10);
    const ids = (await api.get(`/api/tasks?kind=follow_up&status=completed&since=${since}`)).body.tasks.map((t: any) => t.id);
    expect(ids).toContain(recent.id);
    expect(ids).not.toContain(old.id);

    const items = (await api.get('/api/inventory-sync/stock/forecast')).body.items;
    expect(items.length).toBeGreaterThan(0);
    for (const i of items) {
      expect(i.stores).toEqual({ salon: expect.any(Boolean), online: expect.any(Boolean) });
      if (i.status === 'out') expect(i.sellOutOn).toBeTruthy();
    }
  });
});
