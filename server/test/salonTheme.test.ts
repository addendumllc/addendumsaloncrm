import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_THEME_SETTINGS, FONT_CHOICES } from '@addendum/shared';
import { db } from '../src/db/index.js';
import { setup } from './helpers.js';

// The Addendum Salon theme (addendumsalon.com): built in, and added to theme lists already saved before it existed.
describe('Addendum Salon theme', () => {
  it('is built in, with the site’s colours and EB Garamond headings', () => {
    const t = DEFAULT_THEME_SETTINGS.themes.find((x) => x.id === 'salon')!;
    expect(t).toMatchObject({ status: 'published', colors: { accent: '#5A2C1A', background: '#F8F6F1', text: '#14110E' }, type: { headingFont: 'eb-garamond', font: 'helvetica' } });
    expect(FONT_CHOICES.some((f) => f.id === 'eb-garamond')).toBe(true);
  });

  it('is added once to a saved theme list that doesn’t have it', async () => {
    await setup();
    const sql = fs.readFileSync(new URL('../src/db/migrations/093_salon_theme.sql', import.meta.url), 'utf8');
    const saved = { themeSettings: { themes: [{ id: 'mine', name: 'Mine' }], defaultTheme: 'mine' } };
    await db().query("INSERT INTO settings(key, value) VALUES ('app', $1::jsonb) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value", [JSON.stringify(saved)]);
    await db().query(sql);
    await db().query(sql); // twice: still once
    const row = await db().one<{ value: any }>("SELECT value FROM settings WHERE key = 'app'");
    expect(row!.value.themeSettings.themes.map((t: any) => t.id)).toEqual(['mine', 'salon']);
    expect(row!.value.themeSettings.themes[1]).toEqual(JSON.parse(JSON.stringify(DEFAULT_THEME_SETTINGS.themes.find((x) => x.id === 'salon'))));
    expect(row!.value.themeSettings.defaultTheme).toBe('mine'); // the default isn't changed
  });
});
