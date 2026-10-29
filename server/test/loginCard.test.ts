import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { setup } from './helpers.js';

let api: Awaited<ReturnType<typeof setup>>['api'];
let app: any;
beforeAll(async () => { ({ api, app } = await setup()); });

describe('Sign-in page: card on phones', () => {
  it('is a setting (Solid by default) that the sign-in page reads', async () => {
    expect((await request(app).get('/api/auth/config')).body.login?.cardStyle ?? 'solid').toBe('solid');
    expect((await api.patch('/api/settings', { login: { cardStyle: 'frosted' } })).status).toBe(200);
    const cfg = (await request(app).get('/api/auth/config')).body;
    expect(cfg.login.cardStyle).toBe('frosted');
    expect(cfg.login.message).toBeTruthy(); // the rest stays
    expect((await api.patch('/api/settings', { login: { cardStyle: 'sparkly' } })).status).toBe(400);
  });
});
