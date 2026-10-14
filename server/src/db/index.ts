import { PERMISSION_KEYS, PREVIOUS_ROLE_DEFAULTS, ROLE_DEFAULT_PERMISSIONS, ROLES } from '@addendum/shared';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Tiny database abstraction so the same SQL runs on:
 *  - real PostgreSQL (production) via `pg`, when DATABASE_URL is set
 *  - embedded PGlite (real Postgres compiled to WASM) for zero-setup demo/dev and tests
 */
export interface Queryable {
  query<T = any>(sql: string, params?: unknown[]): Promise<T[]>;
}

export interface Db extends Queryable {
  one<T = any>(sql: string, params?: unknown[]): Promise<T | null>;
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  kind: 'postgres' | 'pglite';
  /** Embedded database only: a compressed copy of the whole database (used for backups before updates). */
  dump?: () => Promise<Blob>;
}

let instance: Db | null = null;

export function db(): Db {
  if (!instance) throw new Error('Database not initialised');
  return instance;
}

export function setDb(d: Db) {
  instance = d;
}

export async function createDb(opts: { databaseUrl?: string; pgliteDir?: string | 'memory' }): Promise<Db> {
  if (opts.databaseUrl) {
    const pg = await import('pg');
    const pool = new pg.default.Pool({
      connectionString: opts.databaseUrl,
      max: 10,
      ssl: /sslmode=require|neon|supabase|render|railway/i.test(opts.databaseUrl)
        ? { rejectUnauthorized: false }
        : undefined,
    });
    const query = async <T>(sql: string, params: unknown[] = []) => (await pool.query(sql, params)).rows as T[];
    return {
      kind: 'postgres',
      query,
      one: async (sql, params) => (await query<any>(sql, params))[0] ?? null,
      tx: async (fn) => {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const result = await fn({ query: async (s, p = []) => (await client.query(s, p)).rows });
          await client.query('COMMIT');
          return result;
        } catch (e) {
          await client.query('ROLLBACK');
          throw e;
        } finally {
          client.release();
        }
      },
      close: () => pool.end(),
    };
  }

  const { PGlite } = await import('@electric-sql/pglite');
  let pglite: InstanceType<typeof PGlite>;
  if (!opts.pgliteDir || opts.pgliteDir === 'memory') {
    pglite = new PGlite();
  } else {
    fs.mkdirSync(opts.pgliteDir, { recursive: true });
    pglite = new PGlite(opts.pgliteDir);
  }
  await pglite.waitReady;
  const query = async <T>(sql: string, params: unknown[] = []) =>
    (await pglite.query<T>(sql, params as any[])).rows;
  // PGlite is single-connection, so serialise transactions with a simple promise chain.
  let chain: Promise<unknown> = Promise.resolve();
  return {
    kind: 'pglite',
    query,
    one: async (sql, params) => (await query<any>(sql, params))[0] ?? null,
    tx: (fn) => {
      const run = chain.then(() => pglite.transaction((t) => fn({ query: async (s, p = []) => (await t.query<any>(s, p as any[])).rows })));
      chain = run.catch(() => undefined);
      return run as any;
    },
    close: () => pglite.close(),
    dump: async () => (await pglite.dumpDataDir('gzip')) as Blob,
  };
}

export function migrationsDir() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [path.join(here, 'migrations'), path.join(here, 'db', 'migrations'), path.join(here, '..', 'src', 'db', 'migrations')];
  const found = candidates.find((c) => fs.existsSync(c));
  if (!found) throw new Error('Migrations folder not found');
  return found;
}

/** A database update that couldn't be applied. It was rolled back: nothing from it was saved, and earlier data is untouched. */
export class MigrationError extends Error {
  constructor(public file: string, cause: unknown) {
    super(`Database update ${file} failed and was rolled back. Nothing from it was applied and your existing data is unchanged. ` +
      `Keep running the previous version of the app and report this message: ${(cause as Error)?.message ?? cause}`);
  }
}

const listMigrations = (dir: string) => fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

/** Updates this database still needs (in order). */
export async function pendingMigrations(d: Db, dir = migrationsDir()) {
  await d.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  const applied = new Set((await d.query<{ name: string }>('SELECT name FROM schema_migrations')).map((r) => r.name));
  return listMigrations(dir).filter((f) => !applied.has(f));
}

/**
 * Applies the numbered schema updates in order, each in its own transaction, and records them so none ever runs twice.
 * Updates only add (tables, columns): existing rows — accounts, passwords, settings — are kept. Data is never reset.
 *  - Several servers starting together wait for each other (a lock), and skip updates another one already applied.
 *  - A failing update is rolled back completely and the start-up stops with MigrationError, so the host keeps the
 *    previous version running.
 *  - A database already updated by a newer version is left as it is (a warning only), so rolling back the app is safe.
 */
export async function migrate(d: Db, opts: { dir?: string } = {}) {
  const dir = opts.dir ?? migrationsDir();
  await d.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  const files = listMigrations(dir);
  const appliedBefore = (await d.query<{ name: string }>('SELECT name FROM schema_migrations')).map((r) => r.name);
  const unknown = appliedBefore.filter((n) => !files.includes(n));
  if (unknown.length) console.warn(`[migrate] This database was updated by a newer version of the app (${unknown.join(', ')}). It's used as it is.`);
  for (const file of files) {
    if (appliedBefore.includes(file)) continue;
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    try {
      await d.tx(async (q) => {
        // One server at a time; re-check inside the lock in case another server applied it meanwhile.
        if (d.kind === 'postgres') await q.query('SELECT pg_advisory_xact_lock(7428301)');
        if ((await q.query('SELECT 1 FROM schema_migrations WHERE name = $1', [file])).length) return;
        // Run statement by statement (pg's extended protocol accepts one statement per call).
        for (const stmt of splitSql(sql)) await q.query(stmt);
        await q.query('INSERT INTO schema_migrations(name) VALUES ($1)', [file]);
      });
    } catch (e) {
      throw new MigrationError(file, e);
    }
    console.log(`[migrate] applied ${file}`);
  }
  if (appliedBefore.includes('009_permissions.sql') || files.includes('009_permissions.sql')) await syncRoleTemplates(d);
}

/**
 * Fills the role templates from the built-in defaults. A permission is added to a template only the first time the
 * template sees it (new features get their defaults); anything an administrator removed stays removed.
 */
export async function syncRoleTemplates(d: Db) {
  // 1. A built-in template nobody edited (still exactly an earlier default) moves to the current defaults.
  for (const role of ROLES) {
    const old = PREVIOUS_ROLE_DEFAULTS[role];
    if (!old) continue;
    const row = await d.one('SELECT 1 FROM role_templates WHERE role = $1', [role]);
    if (!row) continue;
    const have = (await d.query<{ permission: string }>('SELECT permission FROM role_permissions WHERE role = $1', [role])).map((r) => r.permission).sort();
    const same = (list: string[]) => list.length === have.length && [...list].sort().every((p, i) => p === have[i]);
    if (!old.some(same)) continue;
    await d.tx(async (q) => {
      await q.query('DELETE FROM role_permissions WHERE role = $1', [role]);
      for (const p of ROLE_DEFAULT_PERMISSIONS[role]) await q.query('INSERT INTO role_permissions(role, permission) VALUES ($1,$2)', [role, p]);
      await q.query('UPDATE role_templates SET known_permissions = $2 WHERE role = $1', [role, PERMISSION_KEYS]);
    });
  }
  // 2. Permissions a template hasn't seen yet (new features) get their defaults once; anything an administrator
  //    removed stays removed.
  for (const role of ROLES) {
    const row = await d.one<{ known_permissions: string[] }>('SELECT known_permissions FROM role_templates WHERE role = $1', [role]);
    const known = new Set(row?.known_permissions ?? []);
    const fresh = PERMISSION_KEYS.filter((k) => !known.has(k));
    if (row && !fresh.length) continue;
    await d.tx(async (q) => {
      if (!row) await q.query('INSERT INTO role_templates(role) VALUES ($1)', [role]);
      for (const k of fresh) {
        if (ROLE_DEFAULT_PERMISSIONS[role].includes(k)) {
          await q.query('INSERT INTO role_permissions(role, permission) VALUES ($1,$2) ON CONFLICT DO NOTHING', [role, k]);
        }
      }
      await q.query('UPDATE role_templates SET known_permissions = $2 WHERE role = $1', [role, [...known, ...fresh]]);
    });
  }
}

function splitSql(sql: string): string[] {
  return sql
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n')
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.trim())
    .filter(Boolean);
}
