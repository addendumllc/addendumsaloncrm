import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { setup } from './helpers.js';

let api: Awaited<ReturnType<typeof setup>>['api'];
let app: Awaited<ReturnType<typeof setup>>['app'];

beforeAll(async () => {
  ({ api, app } = await setup());
});

async function stylist() {
  const agent = request.agent(app);
  const h = (r: any) => r.set('X-Requested-With', 'addendum-crm');
  await h(agent.post('/api/auth/login')).send({ email: 'jennifer@addendumsalon.com', password: 'addendum-demo' });
  return { get: (u: string) => h(agent.get(u)), patch: (u: string, b: object) => h(agent.patch(u)).send(b) };
}

describe('Settings shared with the team (view only)', () => {
  it('a shared section reaches people without settings access; editing and sharing still need their permissions', async () => {
    const s = await stylist();
    let seen = (await s.get('/api/settings')).body;
    expect(seen.limited).toBe(true);
    expect(seen.settings.rules).toBeUndefined();
    expect(seen.settings.replies).toBeUndefined();

    expect((await api.patch('/api/settings', { sharedSettings: { rules: true, replies: true } })).status).toBe(200);
    seen = (await s.get('/api/settings')).body;
    expect(seen.settings.sharedSettings).toMatchObject({ rules: true, replies: true, reminders: false });
    expect(seen.settings.rules).toBeTruthy();
    expect(seen.settings.replies).toBeTruthy();
    expect(seen.settings.reminders).toBeUndefined(); // not shared

    // Still view only, and only admins choose what's shared.
    expect((await s.patch('/api/settings', { replies: seen.settings.replies })).status).toBe(403);
    expect((await s.patch('/api/settings', { sharedSettings: { reminders: true } })).status).toBe(403);
    await api.patch('/api/settings', { sharedSettings: { rules: false, replies: false } });
  });
});
