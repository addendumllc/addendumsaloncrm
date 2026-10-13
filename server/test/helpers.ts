import request from 'supertest';
import { createApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { createDb, migrate, setDb } from '../src/db/index.js';
import { clearSettingsCache } from '../src/repos/settings.js';
import { seedDemo } from '../src/seed/demo.js';

export async function setup() {
  loadConfig({ DEMO_MODE: 'true', OWNER_EMAIL: 'owner@addendumsalon.com', OWNER_PASSWORD: 'addendum-demo', APP_URL: 'http://localhost:4000' });
  const db = await createDb({ pgliteDir: 'memory' });
  setDb(db);
  await migrate(db);
  clearSettingsCache();
  await seedDemo();
  const app = createApp();
  const agent = request.agent(app);
  const res = await agent.post('/api/auth/login').set('X-Requested-With', 'addendum-crm').send({ email: 'owner@addendumsalon.com', password: 'addendum-demo' });
  if (res.status !== 200) throw new Error(`login failed ${res.status} ${JSON.stringify(res.body)}`);
  const api = {
    get: (url: string) => agent.get(url),
    post: (url: string, body: object = {}) => agent.post(url).set('X-Requested-With', 'addendum-crm').send(body),
    patch: (url: string, body: object = {}) => agent.patch(url).set('X-Requested-With', 'addendum-crm').send(body),
    put: (url: string, body: object = {}) => agent.put(url).set('X-Requested-With', 'addendum-crm').send(body),
    del: (url: string) => agent.delete(url).set('X-Requested-With', 'addendum-crm'),
  };
  return { app, agent, api, db };
}
