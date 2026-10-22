import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { db } from '../src/db/index.js';
import { clearSettingsCache, getSettings } from '../src/repos/settings.js';
import { setup } from './helpers.js';

describe('Google review link', () => {
  it('fills in an empty review link, and keeps one already entered', async () => {
    await setup();
    const sql = readFileSync(new URL('../src/db/migrations/049_google_review_link.sql', import.meta.url), 'utf8');
    await db().query("UPDATE settings SET value = jsonb_set(value, '{business,reviewUrl}', '\"\"') WHERE key = 'app'");
    await db().query(sql);
    clearSettingsCache();
    expect((await getSettings()).business.reviewUrl).toMatch(/^https:\/\/www\.google\.com\/search\?q=Addendum\+Salon.*#lrd=0x80dc0ecd7fb6aaab:0x3e215c50708febbd,3/);
    await db().query("UPDATE settings SET value = jsonb_set(value, '{business,reviewUrl}', '\"https://g.page/r/mine\"') WHERE key = 'app'");
    await db().query(sql);
    clearSettingsCache();
    expect((await getSettings()).business.reviewUrl).toBe('https://g.page/r/mine');
  });
});
