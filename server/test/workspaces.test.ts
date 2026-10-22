import { beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { DEFAULT_AREA_LOOKS, LOOK_PRESETS, workspacesFor } from '@addendum/shared';
import { setup } from './helpers.js';

let api: Awaited<ReturnType<typeof setup>>['api'];
let app: Awaited<ReturnType<typeof setup>>['app'];
async function signIn(email: string) {
  const agent = request.agent(app);
  expect((await agent.post('/api/auth/login').set('X-Requested-With', 'addendum-crm').send({ email, password: 'addendum-demo' })).status).toBe(200);
  return { get: (u: string) => agent.get(u), put: (u: string, b: object) => agent.put(u).set('X-Requested-With', 'addendum-crm').send(b) };
}

beforeAll(async () => {
  ({ api, app } = await setup());
});

describe('Business workspaces', () => {
  it('admins can use both businesses; a stylist only the salon until given Addendum Hair', async () => {
    const me = (await api.get('/api/auth/me')).body.user;
    expect(workspacesFor(me.permissions).map((w) => w.id)).toEqual(['salon', 'hair']);
    const stylist = await signIn('jennifer@addendumsalon.com');
    const perms = (await stylist.get('/api/auth/me')).body.user.permissions;
    expect(perms).toContain('workspace:salon');
    expect(perms).not.toContain('workspace:hair');
    // The server refuses a workspace they can't use (not just the menu).
    expect((await stylist.put('/api/look', { workspace: 'hair' })).status).toBe(403);
    expect((await stylist.put('/api/look', { workspace: 'salon' })).status).toBe(200);
  });

  it('the chosen workspace is remembered without touching the person’s accent or theme', async () => {
    await api.put('/api/look', { accent: '#5A4236', mode: 'light', theme: 'espresso' });
    await api.put('/api/look', { workspace: 'hair' });
    expect((await api.get('/api/look')).body.look).toMatchObject({ accent: '#5A4236', theme: 'espresso', workspace: 'hair' });
  });

  it('business names, sidebar tabs by business and the sign-in page are organization settings', async () => {
    const r = await api.patch('/api/settings', {
      workspaces: { businesses: { hair: { name: 'Addendum Hair Co', tagline: 'Extensions' } }, nav: { '/inventory-sync': 'hair' } },
      login: { headline: 'Addendum', message: 'Welcome back.' },
    });
    expect(r.status).toBe(200);
    expect(r.body.settings.workspaces.businesses).toMatchObject({ salon: { name: 'Addendum Salon' }, hair: { name: 'Addendum Hair Co' } });
    expect(r.body.settings.workspaces.nav).toMatchObject({ '/appointments': 'salon', '/inventory-sync': 'hair' });
    const cfg = (await request(app).get('/api/auth/config')).body;
    expect(cfg.login).toMatchObject({ headline: 'Addendum', message: 'Welcome back.' });
    expect(cfg.businesses.hair.name).toBe('Addendum Hair Co');
    expect((await api.patch('/api/settings', { workspaces: { nav: { '/inventory-sync': 'office' } } })).status).toBe(400);
  });

  it('each business has its own menu (Addendum Salon + Square by default), and admins can change it', async () => {
    const s = (await api.get('/api/settings')).body.settings.workspaces;
    expect(s.menus.salon).toEqual(['/', '/appointments', '/my-calendar', '/tasks', '/follow-ups', '/messages', '/clients', '/inventory-sync']);
    const r = await api.patch('/api/settings', { workspaces: { menus: { hair: ['/', '/clients', '/inventory-sync'] } } });
    expect(r.body.settings.workspaces.menus).toMatchObject({ hair: ['/', '/clients', '/inventory-sync'], salon: s.menus.salon });
    expect((await api.patch('/api/settings', { workspaces: { menus: { salon: ['not a path'] } } })).status).toBe(400);
  });

  it('a sign-in photo is checked by its bytes and served publicly', async () => {
    const png = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000', 'hex');
    expect((await api.put('/api/settings/login-image', { dataUrl: `data:image/png;base64,${Buffer.from('not an image').toString('base64')}` })).status).toBe(400);
    const r = await api.put('/api/settings/login-image', { dataUrl: `data:image/png;base64,${png.toString('base64')}` });
    expect(r.status).toBe(200);
    const v = r.body.settings.login.imageVersion;
    const img = await request(app).get(`/brand/login-image?v=${v}`);
    expect(img.status).toBe(200);
    expect(img.headers['content-type']).toBe('image/png');
    const stylist = await signIn('jennifer@addendumsalon.com');
    expect((await stylist.put('/api/settings/login-image', { dataUrl: 'x' })).status).toBe(403);
  });

  it('each business has ready-made looks, and its own look settings are accepted', async () => {
    expect(LOOK_PRESETS.filter((p) => p.business === 'salon').length).toBeGreaterThanOrEqual(3);
    expect(LOOK_PRESETS.filter((p) => p.business === 'hair').length).toBeGreaterThanOrEqual(3);
    const dark = LOOK_PRESETS.find((p) => p.id === 'salon-soft-black')!.look;
    const r = await api.patch('/api/settings', { appearance: { areaLooks: { main: DEFAULT_AREA_LOOKS.main, salon: dark, online: DEFAULT_AREA_LOOKS.online } } });
    expect(r.status).toBe(200);
    expect(r.body.settings.appearance.areaLooks.salon).toMatchObject({ mode: 'dark', type: { headingWeight: 300 } });
  });
});

describe('Colors and menus (one design system)', () => {
  it('one design for everyone: an organization default accent, each person’s own accent, and an option to lock it', async () => {
    expect((await api.patch('/api/settings', { appearance: { accent: '#6B5242', personalAccent: true } })).status).toBe(200);
    expect((await api.put('/api/look', { accent: '#C8DC45', mode: 'auto' })).status).toBe(200);
    expect((await api.get('/api/look')).body.look).toMatchObject({ accent: '#C8DC45', mode: 'auto' });
    // Another person is unaffected.
    const stylist = await signIn('jennifer@addendumsalon.com');
    expect((await stylist.get('/api/look')).body.look.accent).toBeNull();
    expect((await api.put('/api/look', { accent: 'lime' })).status).toBe(400);
    const r = await api.patch('/api/settings', { appearance: { personalAccent: false } });
    expect(r.body.settings.appearance.personalAccent).toBe(false);
    await api.patch('/api/settings', { appearance: { personalAccent: true } });
  });

  it('each person has a separate sidebar for each business, and nobody else’s changes', async () => {
    await api.put('/api/sidebar/layout?workspace=hair', { layout: { order: ['/', '/hair-clients'], hidden: ['/analytics'] } });
    expect((await api.get('/api/sidebar/layout?workspace=hair')).body.layout.hidden).toEqual(['/analytics']);
    expect((await api.get('/api/sidebar/layout?workspace=salon')).body.layout).toBeNull();
    const stylist = await signIn('jennifer@addendumsalon.com');
    expect((await stylist.get('/api/sidebar/layout?workspace=hair')).body.layout).toBeNull();
    expect((await api.get('/api/sidebar/layout?workspace=office')).status).toBe(400);
    // Business defaults (administrators): sections and required tabs.
    const r = await api.patch('/api/settings', { workspaces: { sections: { '/messages': 'operations' }, menuDefaults: { stylist: { order: ['/'], hidden: [], required: ['/tasks'] } } } });
    expect(r.status).toBe(200);
    expect(r.body.settings.workspaces.menuDefaults.stylist.required).toEqual(['/tasks']);
    expect((await api.patch('/api/settings', { workspaces: { sections: { '/messages': 'Not valid!' } } })).status).toBe(400);
    // Their own headings (renamed and new), tab names and sections; the owner's default carries them too.
    const mine = { order: ['/', '/tasks'], hidden: ['/settings'], sections: { '/tasks': 's-front' }, sectionList: [{ key: 's-front', label: 'Front desk' }, { key: 'daily', label: 'Every day' }], labels: { '/tasks': 'To-dos' } };
    expect((await api.put('/api/sidebar/layout', { layout: mine })).status).toBe(200);
    expect((await api.get('/api/sidebar/layout')).body.layout).toMatchObject(mine);
    expect((await api.put('/api/sidebar/layout', { layout: { ...mine, labels: { '/tasks': '' } } })).status).toBe(400);
    const def = await api.patch('/api/settings', { workspaces: { menuDefaults: { stylist: { order: ['/'], hidden: [], required: [], sectionList: mine.sectionList, labels: mine.labels, sections: mine.sections } } } });
    expect(def.body.settings.workspaces.menuDefaults.stylist.labels).toEqual({ '/tasks': 'To-dos' });
  });
});

describe('Themes (administrators publish; each person chooses)', () => {
  it('admins create themes; people pick published ones open to their role and adjust only what’s allowed', async () => {
    const { DEFAULT_THEME_SETTINGS, resolveTheme } = await import('@addendum/shared');
    const base = DEFAULT_THEME_SETTINGS.themes[0];
    const themes = [
      ...DEFAULT_THEME_SETTINGS.themes,
      { ...base, id: 'brand', name: 'Custom Brand', description: '', status: 'published', roles: ['receptionist'], colors: { ...base.colors, accent: '#B07A7E' }, buttons: { size: 'large', radius: 'rounded' } },
      { ...base, id: 'wip', name: 'Work in progress', description: '', status: 'draft', roles: [] },
    ];
    expect((await api.patch('/api/settings', { appearance: { themeSettings: { themes, defaultTheme: 'wip', allow: { colors: true, type: true, buttons: true } } } })).status).toBe(400); // default must be published
    const r = await api.patch('/api/settings', { appearance: { themeSettings: { themes, defaultTheme: 'neutral', allow: { colors: false, type: true, buttons: true } } } });
    expect(r.status).toBe(200);
    const desk = await signIn('frontdesk@addendumsalon.com');
    const stylist = await signIn('jennifer@addendumsalon.com');
    expect((await desk.put('/api/look', { themeId: 'brand' })).status).toBe(200);
    expect((await stylist.put('/api/look', { themeId: 'brand' })).status).toBe(400); // not for stylists
    expect((await stylist.put('/api/look', { themeId: 'wip' })).status).toBe(400); // draft
    expect((await stylist.put('/api/look', { themeId: 'espresso', custom: { colors: { accent: '#C8DC45' }, type: { base: 'large' }, buttons: { size: 'small' } } })).status).toBe(200);
    const ts = r.body.settings.appearance.themeSettings;
    const deskLook = (await desk.get('/api/look')).body.look;
    expect(resolveTheme(ts, deskLook, 'receptionist')).toMatchObject({ colors: { accent: '#B07A7E' }, buttons: { size: 'large', radius: 'rounded' } });
    const sty = resolveTheme(ts, (await stylist.get('/api/look')).body.look, 'stylist');
    expect(sty.theme.id).toBe('espresso');
    expect(sty.colors.accent).toBe('#35281E'); // colours locked by the organization: their accent is ignored
    expect(sty.type.base).toBe('large');
    expect(sty.buttons.size).toBe('small');
    // A retired theme falls back to the default.
    await api.patch('/api/settings', { appearance: { themeSettings: { ...ts, themes: ts.themes.map((t: any) => (t.id === 'brand' ? { ...t, status: 'retired' } : t)) } } });
    const ts2 = (await api.get('/api/settings')).body.settings.appearance.themeSettings;
    expect(resolveTheme(ts2, deskLook, 'receptionist').theme.id).toBe('neutral');
    // The admin's own look is untouched by others' choices.
    expect((await api.get('/api/look')).body.look.themeId ?? null).toBeNull();
    await api.patch('/api/settings', { appearance: { themeSettings: DEFAULT_THEME_SETTINGS } });
  });
});

describe('Sidebar opacity', () => {
  it('a theme sets how much of the sidebar colour shows; people can adjust it when colours are allowed', async () => {
    const { DEFAULT_THEME_SETTINGS, resolveTheme } = await import('@addendum/shared');
    const themes = DEFAULT_THEME_SETTINGS.themes.map((t) => (t.id === 'espresso' ? { ...t, sidebarOpacity: 20 } : t));
    expect((await api.patch('/api/settings', { appearance: { themeSettings: { ...DEFAULT_THEME_SETTINGS, themes } } })).status).toBe(200);
    expect((await api.patch('/api/settings', { appearance: { themeSettings: { ...DEFAULT_THEME_SETTINGS, themes: themes.map((t) => ({ ...t, sidebarOpacity: 150 })) } } })).status).toBe(400);
    const ts = (await api.get('/api/settings')).body.settings.appearance.themeSettings;
    expect(resolveTheme(ts, { themeId: 'espresso' }, 'admin').sidebarOpacity).toBe(20);
    expect(resolveTheme(ts, { themeId: 'espresso', custom: { sidebarOpacity: 0 } }, 'admin').sidebarOpacity).toBe(0);
    expect(resolveTheme(ts, null, 'admin').sidebarOpacity).toBe(100);
    expect((await api.put('/api/look', { custom: { sidebarOpacity: 40 } })).status).toBe(200);
    await api.patch('/api/settings', { appearance: { themeSettings: DEFAULT_THEME_SETTINGS } });
  });
});
