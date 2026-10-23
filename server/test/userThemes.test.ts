import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { setup } from './helpers.js';

let api: Awaited<ReturnType<typeof setup>>['api'];
let app: Awaited<ReturnType<typeof setup>>['app'];
async function signIn(email: string) {
  const agent = request.agent(app);
  expect((await agent.post('/api/auth/login').set('X-Requested-With', 'addendum-crm').send({ email, password: 'addendum-demo' })).status).toBe(200);
  const h = (r: request.Test) => r.set('X-Requested-With', 'addendum-crm');
  return { get: (u: string) => agent.get(u), put: (u: string, b: object) => h(agent.put(u)).send(b), del: (u: string) => h(agent.delete(u)) };
}
const theme = (published: boolean) => ({
  name: 'Taupe Studio', description: 'Soft taupe', published,
  colors: { accent: '#6B5242', accent2: '#B08A5B', background: '#F7F5F2', sidebar: '#EFECE7', surface: '#FFFFFF', text: '#1E1B18', line: '#E5E0D8' },
  type: { font: 'inter', headingFont: 'nanum-myeongjo', base: 'default', heading: 'large', small: 'default', weight: 400 },
  buttons: { size: 'default', radius: 'soft' }, sidebarOpacity: 80,
});

beforeAll(async () => {
  ({ api, app } = await setup());
});

describe('Personal themes', () => {
  it('each person makes one theme; others see it only once published, and can then use it', async () => {
    const jen = await signIn('jennifer@addendumsalon.com');
    const desk = await signIn('frontdesk@addendumsalon.com');
    const r = await jen.put('/api/user-themes/mine', theme(false));
    expect(r.status).toBe(200);
    const mine = r.body.themes.find((t: any) => t.mine);
    expect(mine).toMatchObject({ published: false, theme: { name: 'Taupe Studio', id: expect.stringMatching(/^u-/) } });
    // Saving again replaces it (still one).
    await jen.put('/api/user-themes/mine', { ...theme(false), name: 'Taupe Studio 2' });
    expect((await jen.get('/api/user-themes')).body.themes.filter((t: any) => t.mine)).toHaveLength(1);
    // Private: nobody else sees or can pick it.
    expect((await desk.get('/api/user-themes')).body.themes).toEqual([]);
    expect((await desk.put('/api/look', { themeId: mine.theme.id })).status).toBe(400);
    // Its owner can use it.
    expect((await jen.put('/api/look', { themeId: mine.theme.id })).status).toBe(200);
    // Published: others see it (with the author) and can choose it.
    await jen.put('/api/user-themes/mine', theme(true));
    const seen = (await desk.get('/api/user-themes')).body.themes;
    expect(seen).toEqual([expect.objectContaining({ mine: false, published: true, authorName: expect.stringMatching(/Jennifer/) })]);
    expect((await desk.put('/api/look', { themeId: mine.theme.id })).status).toBe(200);
    // Only the owner (or an admin) removes it.
    expect((await desk.del(`/api/user-themes/${mine.authorId}`)).status).toBe(403);
    expect((await api.del(`/api/user-themes/${mine.authorId}`)).status).toBe(200);
    expect((await desk.get('/api/user-themes')).body.themes).toEqual([]);
  });

  it('a theme needs a name and valid colours', async () => {
    expect((await api.put('/api/user-themes/mine', { ...theme(false), name: '' })).status).toBe(400);
    expect((await api.put('/api/user-themes/mine', { ...theme(false), colors: { ...theme(false).colors, accent: 'red' } })).status).toBe(400);
  });
});

describe('Opacity for every colour, extra small sizes and button height', () => {
  it('are accepted in a person’s own adjustments and their theme, and limited to sensible values', async () => {
    const custom = { opacity: { accent: 70, background: 60, surface: 90, text: 85, line: 50, accent2: 40 }, type: { base: 'xsmall', small: 'xsmall' }, buttons: { size: 'xsmall', height: 30 } };
    const r = await api.put('/api/look', { custom });
    expect(r.status).toBe(200);
    expect(r.body.look.custom).toMatchObject(custom);
    expect((await api.put('/api/look', { custom: { buttons: { height: 90 } } })).status).toBe(400);
    expect((await api.put('/api/look', { custom: { opacity: { text: 150 } } })).status).toBe(400);
    const t = await api.put('/api/user-themes/mine', { ...theme(false), opacity: { accent: 80 }, buttons: { size: 'xsmall', radius: 'square', height: 28 }, type: { ...theme(false).type, base: 'xsmall' } });
    expect(t.status).toBe(200);
    expect(t.body.themes.find((x: any) => x.mine).theme).toMatchObject({ opacity: { accent: 80 }, buttons: { size: 'xsmall', height: 28 } });
  });
});

describe('Font styles', () => {
  it('only administrators upload fonts and make styles; everyone picks a published one', async () => {
    const jen = await signIn('jennifer@addendumsalon.com');
    const woff2 = Buffer.concat([Buffer.from('wOF2'), Buffer.alloc(60)]);
    const dataUrl = `data:font/woff2;base64,${woff2.toString('base64')}`;
    expect((await jen.put('/api/settings/font-file', { dataUrl, name: 'Brand.woff2' })).status).toBe(403);
    expect((await api.put('/api/settings/font-file', { dataUrl: `data:font/woff2;base64,${Buffer.from('nope').toString('base64')}`, name: 'x.woff2' })).status).toBe(400);
    const up = await api.put('/api/settings/font-file', { dataUrl, name: 'Brand.woff2' });
    expect(up.status).toBe(200);
    const font = up.body.font;
    expect(font).toMatchObject({ name: 'Brand' });
    expect((await request(app).get(`/brand/fontfile/${font.id}?v=${font.version}`)).headers['content-type']).toBe('font/woff2');
    const fonts = { heading: `file:${font.id}`, subheading: 'lora', body: 'inter', menu: 'inter', button: 'inter', label: 'inter', link: 'inter' };
    const r = await api.patch('/api/settings', { appearance: { fontStyles: { styles: [
      { id: 'brand', name: 'Brand', description: '', fonts, weights: { heading: 300 }, caps: { label: true }, status: 'published' },
      { id: 'draft-one', name: 'Draft', description: '', fonts, status: 'draft' },
    ], defaultStyle: 'brand' } } });
    expect(r.status).toBe(200);
    expect(r.body.settings.appearance.fontStyles.library).toEqual([expect.objectContaining({ id: font.id })]); // the library is kept
    expect((await jen.put('/api/look', { fontStyleId: 'brand' })).status).toBe(200);
    expect((await jen.put('/api/look', { fontStyleId: 'draft-one' })).status).toBe(400);
    expect((await api.patch('/api/settings', { appearance: { fontStyles: { styles: [], defaultStyle: 'brand' } } })).status).toBe(400);
  });
});
