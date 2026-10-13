import { PERMISSION_KEYS, ROLE_DEFAULT_PERMISSIONS, ROLES } from '@addendum/shared';
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
  };
}

function migrationsDir() {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [path.join(here, 'migrations'), path.join(here, 'db', 'migrations'), path.join(here, '..', 'src', 'db', 'migrations')];
  const found = candidates.find((c) => fs.existsSync(c));
  if (!found) throw new Error('Migrations folder not found');
  return found;
}

export async function migrate(d: Db) {
  await d.query(`CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  const applied = new Set((await d.query<{ name: string }>('SELECT name FROM schema_migrations')).map((r) => r.name));
  const dir = migrationsDir();
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = fs.readFileSync(path.join(dir, file), 'utf8');
    await d.tx(async (q) => {
      // Run statement by statement (pg's extended protocol accepts one statement per call).
      for (const stmt of splitSql(sql)) await q.query(stmt);
      await q.query('INSERT INTO schema_migrations(name) VALUES ($1)', [file]);
    });
  }
  if (applied.has('009_permissions.sql') || files.includes('009_permissions.sql')) await syncRoleTemplates(d);
}

/**
 * Fills the role templates from the built-in defaults. A permission is added to a template only the first time the
 * template sees it (new features get their defaults); anything an administrator removed stays removed.
 */
export async function syncRoleTemplates(d: Db) {
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
