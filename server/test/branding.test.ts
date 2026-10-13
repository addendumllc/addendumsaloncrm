import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { setup } from './helpers.js';

let app: Awaited<ReturnType<typeof setup>>['app'];
let admin: Awaited<ReturnType<typeof setup>>['api'];
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

beforeAll(async () => {
  ({ app, api: admin } = await setup());
});

async function stylist() {
  const agent = request.agent(app);
  await agent.post('/api/auth/login').set('X-Requested-With', 'addendum-crm').send({ email: 'jennifer@addendumsalon.com', password: 'addendum-demo' });
  return {
    patch: (url: string, body: object) => agent.patch(url).set('X-Requested-With', 'addendum-crm').send(body),
    put: (url: string, body: object) => agent.put(url).set('X-Requested-With', 'addendum-crm').send(body),
  };
}

describe('Salon details and appearance are editable in the app', () => {
  it('administrators update salon details; stylists can’t', async () => {
    const r = await admin.patch('/api/settings', { business: { name: 'Addendum Salon & Extensions', phone: '(619) 555-0100', hours: 'Tue–Sat 9–7' } });
    expect(r.status).toBe(200);
    expect(r.body.settings.business).toMatchObject({ name: 'Addendum Salon & Extensions', phone: '(619) 555-0100' });
    expect((await (await stylist()).patch('/api/settings', { business: { name: 'Nope' } })).status).toBe(403);
  });

  it('saves the look, validates it, and shares it with the sign-in screen', async () => {
    const r = await admin.patch('/api/settings', { appearance: { background: 'tinted', sidebar: 'accent', headingFont: 'sans', brandName: 'Addendum Hair', tagline: '' } });
    expect(r.status).toBe(200);
    expect(r.body.settings.appearance).toMatchObject({ background: 'tinted', sidebar: 'accent', headingFont: 'sans', brandName: 'Addendum Hair', tagline: '', accent: expect.any(String) });
    expect((await admin.patch('/api/settings', { appearance: { background: 'neon' } })).status).toBe(400);
    expect((await admin.patch('/api/settings', { appearance: { brandName: ' ' } })).status).toBe(400);
    expect((await admin.patch('/api/settings', { appearance: { logoVersion: 'forged' } })).body.settings.appearance.logoVersion).toBeNull();
    const pub = (await request(app).get('/api/auth/config')).body; // not signed in
    expect(pub.appearance).toMatchObject({ brandName: 'Addendum Hair', headingFont: 'sans' });
  });
});

describe('Custom logo', () => {
  it('uploads a logo, serves it publicly with long caching, and removes it', async () => {
    const r = await admin.put('/api/settings/logo', { dataUrl: `data:image/png;base64,${PNG}` });
    expect(r.status).toBe(200);
    const v = r.body.settings.appearance.logoVersion;
    expect(v).toBeTruthy();
    const img = await request(app).get(`/brand/logo?v=${v}`);
    expect(img.status).toBe(200);
    expect(img.headers['content-type']).toBe('image/png');
    expect(img.headers['cache-control']).toContain('immutable');
    expect(Buffer.compare(img.body, Buffer.from(PNG, 'base64'))).toBe(0);
    expect((await request(app).get('/api/auth/config')).body.appearance.logoVersion).toBe(v);

    const del = await admin.del('/api/settings/logo');
    expect(del.body.settings.appearance.logoVersion).toBeNull();
    expect((await request(app).get('/brand/logo')).status).toBe(404);
  });

  it('accepts only real PNG, JPG or WebP images within the size limit', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>').toString('base64');
    expect((await admin.put('/api/settings/logo', { dataUrl: `data:image/svg+xml;base64,${svg}` })).status).toBe(400);
    expect((await admin.put('/api/settings/logo', { dataUrl: `data:image/png;base64,${svg}` })).status).toBe(400); // claims PNG, isn't
    const big = Buffer.concat([Buffer.from(PNG, 'base64'), Buffer.alloc(420 * 1024)]).toString('base64');
    expect((await admin.put('/api/settings/logo', { dataUrl: `data:image/png;base64,${big}` })).status).toBe(400);
    expect((await (await stylist()).put('/api/settings/logo', { dataUrl: `data:image/png;base64,${PNG}` })).status).toBe(403);
  });
});

describe('Custom fonts', () => {
  // Minimal font headers: the server checks the file's signature, not its name.
  const woff2 = Buffer.concat([Buffer.from('wOF2'), Buffer.alloc(200, 1)]).toString('base64');
  const ttf = Buffer.concat([Buffer.from([0, 1, 0, 0]), Buffer.alloc(200, 1)]).toString('base64');

  it('uploads heading and body fonts, switches them on, serves them, and removes them', async () => {
    const h = await admin.put('/api/settings/font/heading', { dataUrl: `data:font/woff2;base64,${woff2}`, name: 'Brand Display.woff2' });
    expect(h.status).toBe(200);
    expect(h.body.settings.appearance).toMatchObject({ headingFont: 'custom', headingFontName: 'Brand Display' });
    const b = await admin.put('/api/settings/font/body', { dataUrl: `data:application/octet-stream;base64,${ttf}`, name: 'Brand Text.ttf' });
    expect(b.body.settings.appearance).toMatchObject({ bodyFont: 'custom', bodyFontName: 'Brand Text' });

    const v = b.body.settings.appearance.bodyFontVersion;
    const file = await request(app).get(`/brand/font/body?v=${v}`); // public: the sign-in screen uses it
    expect(file.status).toBe(200);
    expect(file.headers['content-type']).toBe('font/ttf');
    expect(file.headers['cache-control']).toContain('immutable');

    // Switching back to a built-in font keeps the upload for later.
    expect((await admin.patch('/api/settings', { appearance: { headingFont: 'sans' } })).body.settings.appearance).toMatchObject({ headingFont: 'sans', headingFontName: 'Brand Display' });

    const del = await admin.del('/api/settings/font/body');
    expect(del.body.settings.appearance).toMatchObject({ bodyFont: 'default', bodyFontName: null, bodyFontVersion: null });
    expect((await request(app).get('/brand/font/body')).status).toBe(404);
    expect((await request(app).get('/brand/font/other')).status).toBe(404);
  });

  it('accepts only real font files within the size limit, from administrators', async () => {
    const notFont = Buffer.from('<html>hello</html>').toString('base64');
    expect((await admin.put('/api/settings/font/heading', { dataUrl: `data:font/woff2;base64,${notFont}`, name: 'x.woff2' })).status).toBe(400);
    const big = Buffer.concat([Buffer.from('wOF2'), Buffer.alloc(1600 * 1024)]).toString('base64');
    expect((await admin.put('/api/settings/font/heading', { dataUrl: `data:font/woff2;base64,${big}`, name: 'big.woff2' })).status).toBe(400);
    expect((await admin.put('/api/settings/font/logo', { dataUrl: `data:font/woff2;base64,${woff2}`, name: 'x.woff2' })).status).toBe(403); // not a font slot: closed by the gate
    expect((await (await stylist()).put('/api/settings/font/heading', { dataUrl: `data:font/woff2;base64,${woff2}`, name: 'x.woff2' })).status).toBe(403);
  });
});
