import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import request from 'supertest';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.js';
import { config, loadConfig } from '../src/config.js';
import { createDb, migrate, MigrationError, migrationsDir, pendingMigrations, setDb, type Db } from '../src/db/index.js';
import { saveCredentials, loadSavedCredentials } from '../src/integrations/credentials.js';
import { clearSettingsCache } from '../src/repos/settings.js';
import { seedDemo } from '../src/seed/demo.js';
import { applyOwnerRecovery, backupBeforeMigrations, checkEncryptionKey, storageInfo } from '../src/system/health.js';
import { setCode } from '../src/domain/loginCodes.js';

/**
 * Accounts and secrets survive updates and restarts: a real embedded database in a temporary folder is created by an
 * older version, closed, reopened and updated — the way a deployment does it.
 */
const KEY_A = 'test-key-A-0123456789-abcdefghijklmnopqrstuvwxyz';
const KEY_B = 'test-key-B-0123456789-abcdefghijklmnopqrstuvwxyz';
const KEY_C = 'test-key-C-0123456789-abcdefghijklmnopqrstuvwxyz';
const PASSWORD = 'Salon-Owner-2026!';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'addendum-persist-'));
let dbDir: string;
let d: Db | null = null;

const cfg = (extra: Record<string, string> = {}) => loadConfig({ DEMO_MODE: 'false', APP_URL: 'http://localhost:4000', ENCRYPTION_KEY: KEY_A, PGLITE_DIR: dbDir, OWNER_EMAIL: 'owner@salon.test', OWNER_PASSWORD: PASSWORD, ...extra });
async function open(migrations?: string) {
  d = await createDb({ pgliteDir: dbDir });
  setDb(d);
  clearSettingsCache();
  if (migrations !== 'none') await migrate(d, migrations ? { dir: migrations } : {});
  return d;
}
async function close() {
  await d?.close();
  d = null;
}
/** A migrations folder with only the first `n` updates, as an older release had. */
function olderRelease(n: number) {
  const dir = fs.mkdtempSync(path.join(tmp, 'mig-'));
  for (const f of fs.readdirSync(migrationsDir()).filter((x) => x.endsWith('.sql')).sort().slice(0, n)) fs.copyFileSync(path.join(migrationsDir(), f), path.join(dir, f));
  return dir;
}
async function login(email: string, password: string) {
  const agent = request.agent(createApp());
  const r = await agent.post('/api/auth/login').set('X-Requested-With', 'addendum-crm').send({ email, password });
  return { status: r.status, agent, cookie: r.headers['set-cookie'] };
}

beforeEach(() => {
  dbDir = fs.mkdtempSync(path.join(tmp, 'db-'));
  cfg();
});
afterEach(close);
afterAll(() => fs.rmSync(tmp, { recursive: true, force: true }));

describe('Accounts survive app updates', () => {
  it('a database made by an older version is updated in place; everyone still signs in with their own password', async () => {
    // An early release (3 updates, old role names): an owner and a stylist set their passwords.
    await open(olderRelease(3));
    const hash = await bcrypt.hash(PASSWORD, 12);
    await d!.query(`INSERT INTO staff(name, email, role, password_hash) VALUES ('Owner', 'owner@salon.test', 'owner', $1)`, [hash]);
    await d!.query(`INSERT INTO staff(name, email, role, password_hash) VALUES ('Sam Stylist', 'sam@salon.test', 'staff', $1)`, [await bcrypt.hash('Stylist-pass-1', 12)]);
    await d!.query(`INSERT INTO clients(first_name, last_name) VALUES ('Kept', 'Client')`);
    await close();

    // The new release starts on the same database.
    await open('none');
    expect((await pendingMigrations(d!)).length).toBeGreaterThan(0);
    await migrate(d!);
    expect(await pendingMigrations(d!)).toEqual([]);
    const owner = await d!.one<any>("SELECT role, approval_status, active, password_hash FROM staff WHERE email = 'owner@salon.test'");
    expect(owner).toMatchObject({ role: 'admin', approval_status: 'approved', active: true, password_hash: hash });
    expect((await d!.one<any>("SELECT count(*)::int n FROM clients WHERE first_name = 'Kept'")).n).toBe(1);
    expect((await login('owner@salon.test', PASSWORD)).status).toBe(200);
    expect((await login('sam@salon.test', 'Stylist-pass-1')).status).toBe(200);
    const me = await (await login('owner@salon.test', PASSWORD)).agent.get('/api/auth/me');
    expect(me.body.user.permissions).toContain('users:permissions');
  });

  it('accounts, sessions and data survive a restart; updating twice changes nothing', async () => {
    await open();
    await d!.query(`INSERT INTO staff(name, email, role, password_hash) VALUES ('Owner', 'owner@salon.test', 'admin', $1)`, [await bcrypt.hash(PASSWORD, 12)]);
    const first = await login('owner@salon.test', PASSWORD);
    expect(first.status).toBe(200);
    const applied = (await d!.one<any>('SELECT count(*)::int n FROM schema_migrations')).n;
    await close();

    await open(); // restart: migrations run again
    expect((await d!.one<any>('SELECT count(*)::int n FROM schema_migrations')).n).toBe(applied);
    const again = request(createApp());
    // The session from before the restart is still valid.
    const me = await again.get('/api/auth/me').set('Cookie', first.cookie);
    expect(me.status).toBe(200);
    expect((await login('owner@salon.test', PASSWORD)).status).toBe(200);
  });

  it('a failed update is rolled back completely and stops start-up; existing data is untouched', async () => {
    await open();
    await d!.query(`INSERT INTO staff(name, email, role, password_hash) VALUES ('Owner', 'owner@salon.test', 'admin', 'x')`);
    const dir = olderRelease(999);
    fs.writeFileSync(path.join(dir, '999_broken.sql'), 'CREATE TABLE half_done (id INT);\nALTER TABLE staff ADD COLUMN broken_col NOT_A_TYPE;\n');
    await expect(migrate(d!, { dir })).rejects.toBeInstanceOf(MigrationError);
    expect(await d!.one("SELECT to_regclass('half_done') AS t")).toEqual({ t: null });
    expect(await d!.one("SELECT 1 FROM schema_migrations WHERE name = '999_broken.sql'")).toBeNull();
    expect((await d!.one<any>("SELECT count(*)::int n FROM staff WHERE email = 'owner@salon.test'")).n).toBe(1);
  });

  it('keeps a copy of the embedded database before updating it', async () => {
    await open(olderRelease(8));
    await close();
    await open('none');
    const file = await backupBeforeMigrations(d!, config(), await pendingMigrations(d!));
    expect(file && fs.statSync(file).size).toBeGreaterThan(1000);
  });

  it('says when storage could be erased by a deployment', async () => {
    await open();
    expect(storageInfo(cfg({ PGLITE_DIR: './data/pglite' }), d!).durable).toBe(false);
    expect(storageInfo(cfg({ PGLITE_DIR: dbDir }), d!).durable).toBe(true);
  });
});

describe('Sign-in codes survive restarts and updates', () => {
  it('a code assigned before a restart still signs in afterwards', async () => {
    await open();
    const owner = await d!.one<any>(`INSERT INTO staff(name, email, role, password_hash) VALUES ('Owner', 'owner@salon.test', 'admin', $1) RETURNING id`, [await bcrypt.hash(PASSWORD, 12)]);
    await setCode(owner.id, owner.id, { code: 'Colour-Bar-4821' });
    await close();
    await open(); // restart + migrations again
    const r = await request(createApp()).post('/api/auth/login-code').set('X-Requested-With', 'addendum-crm').send({ email: 'owner@salon.test', code: 'Colour-Bar-4821' });
    expect(r.status).toBe(200);
  });
});

describe('Encryption key: changes are detected, rotation keeps secrets', () => {
  it('re-encrypts saved secrets with a new key when the old one is given, and flags a lost key', async () => {
    await open();
    expect((await checkEncryptionKey(config())).status).toBe('new');
    await saveCredentials('highlevel', { HIGHLEVEL_PRIVATE_TOKEN: 'pit-test-not-real-0001', HIGHLEVEL_LOCATION_ID: 'loc-test' }, null as any);

    cfg({ ENCRYPTION_KEY: KEY_B, ENCRYPTION_KEY_PREVIOUS: KEY_A });
    const rotated = await checkEncryptionKey(config());
    expect(rotated).toMatchObject({ status: 'rotated', reencrypted: 1, unreadable: 0 });
    cfg({ ENCRYPTION_KEY: KEY_B }); // previous key removed afterwards
    await loadSavedCredentials();
    expect(config().HIGHLEVEL_PRIVATE_TOKEN).toBe('pit-test-not-real-0001');
    expect((await checkEncryptionKey(config())).status).toBe('ok');

    cfg({ ENCRYPTION_KEY: KEY_C }); // key replaced without the old one
    expect(await checkEncryptionKey(config())).toMatchObject({ status: 'changed', unreadable: 1 });
  });
});

describe('Sign-in, passwords and recovery', () => {
  it('stores only salted bcrypt hashes, upgrades weak ones on sign-in, and never logs a password', async () => {
    await open();
    const logs: string[] = [];
    const spies = (['log', 'warn', 'error', 'info'] as const).map((m) => vi.spyOn(console, m).mockImplementation((...a) => { logs.push(a.map(String).join(' ')); }));
    await d!.query(`INSERT INTO staff(name, email, role, password_hash) VALUES ('Owner', 'owner@salon.test', 'admin', $1)`, [await bcrypt.hash(PASSWORD, 10)]);
    const app = request(createApp());
    const h = (r: any) => r.set('X-Requested-With', 'addendum-crm');
    expect((await h(app.post('/api/auth/login')).send({ email: 'owner@salon.test', password: 'Wrong-pass-123' })).status).toBe(401);
    expect((await h(app.post('/api/auth/login')).send({ email: 'owner@salon.test', password: PASSWORD })).status).toBe(200);
    const row = await d!.one<any>("SELECT password_hash FROM staff WHERE email = 'owner@salon.test'");
    expect(bcrypt.getRounds(row.password_hash)).toBe(12);
    expect(await bcrypt.compare(PASSWORD, row.password_hash)).toBe(true);
    await h(app.post('/api/auth/request-access')).send({ name: 'New Person', email: 'new@salon.test', password: 'Brand-new-pass-9' });
    // Too long for bcrypt: refused rather than silently cut short.
    expect((await h(app.post('/api/auth/request-access')).send({ name: 'Long One', email: 'long@salon.test', password: `A1${'x'.repeat(80)}` })).status).toBe(400);
    spies.forEach((s) => s.mockRestore());

    const everything = JSON.stringify([await d!.query('SELECT * FROM staff'), await d!.query('SELECT * FROM audit_logs'), await d!.query('SELECT * FROM settings')]);
    for (const secret of [PASSWORD, 'Wrong-pass-123', 'Brand-new-pass-9']) {
      expect(everything).not.toContain(secret);
      expect(logs.join('\n')).not.toContain(secret);
    }
  });

  it('sessions slide while in use', async () => {
    await open();
    await d!.query(`INSERT INTO staff(name, email, role, password_hash) VALUES ('Owner', 'owner@salon.test', 'admin', $1)`, [await bcrypt.hash(PASSWORD, 12)]);
    const s = await login('owner@salon.test', PASSWORD);
    await d!.query("UPDATE sessions SET expires_at = now() + interval '2 days'");
    const r = await s.agent.get('/api/auth/me');
    expect(r.headers['set-cookie']?.[0]).toMatch(/addendum_session=/);
    const left = (await d!.one<any>('SELECT expires_at FROM sessions')).expires_at;
    expect(new Date(left).getTime() - Date.now()).toBeGreaterThan((config().SESSION_DAYS - 1) * 86400_000);
  });

  it('OWNER_RECOVERY_PASSWORD restores the owner once, and signs the old sessions out', async () => {
    await open();
    await d!.query(`INSERT INTO staff(name, email, role, password_hash, active) VALUES ('Owner', 'owner@salon.test', 'stylist', $1, false)`, [await bcrypt.hash('Forgotten-1234', 12)]);
    cfg({ OWNER_RECOVERY_PASSWORD: 'Recovered-2026!' });
    expect(await applyOwnerRecovery(config())).toBe(true);
    expect(await applyOwnerRecovery(config())).toBe(false); // same value on the next restart: not applied again
    expect((await login('owner@salon.test', 'Recovered-2026!')).status).toBe(200);
    expect((await login('owner@salon.test', 'Forgotten-1234')).status).toBe(401);
    expect(await d!.one<any>("SELECT role, active FROM staff WHERE email = 'owner@salon.test'")).toEqual({ role: 'admin', active: true });
  });

  it('demo data never replaces a database with real accounts', async () => {
    await open();
    await d!.query(`INSERT INTO staff(name, email, role, password_hash) VALUES ('Owner', 'owner@salon.test', 'admin', 'x')`);
    await expect(seedDemo()).rejects.toThrow(/real accounts/);
    expect((await d!.one<any>('SELECT count(*)::int n FROM staff')).n).toBe(1);
  });
});
