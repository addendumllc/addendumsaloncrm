import fs from 'node:fs';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { type Config } from '../config.js';
import { db, migrationsDir, type Db } from '../db/index.js';
import { decrypt, decryptsWithCurrentKey, encrypt, keyFingerprint, sha256 } from '../lib/crypto.js';
import { getKV, setKV } from '../repos/settings.js';

/**
 * Keeping accounts and secrets safe across updates and restarts:
 *  - where the data lives, and whether an update could erase it (storageInfo);
 *  - a compressed copy of the embedded database before applying updates (backupBeforeMigrations);
 *  - whether ENCRYPTION_KEY changed since the last start, and re-encrypting during a key rotation (checkEncryptionKey);
 *  - one-time owner password recovery for hosts without a command line (applyOwnerRecovery).
 * Nothing here ever logs a password, key or token.
 */

export type StorageInfo = { kind: 'postgres' | 'pglite'; durable: boolean; detail: string };

/**
 * PostgreSQL (DATABASE_URL) is durable. The embedded database is durable only when PGLITE_DIR is an absolute path the
 * operator chose (e.g. a mounted disk); the default folder sits inside the app and can be replaced by a deployment.
 */
export function storageInfo(cfg: Config, d: Db): StorageInfo {
  if (d.kind === 'postgres') return { kind: 'postgres', durable: true, detail: 'PostgreSQL (DATABASE_URL)' };
  const dir = cfg.PGLITE_DIR;
  if (path.isAbsolute(dir)) return { kind: 'pglite', durable: true, detail: `Embedded database at ${dir}` };
  return { kind: 'pglite', durable: false, detail: 'Embedded database inside the app folder' };
}

/** Before applying updates to an embedded database, keep a compressed copy next to it (newest 3 kept). */
export async function backupBeforeMigrations(d: Db, cfg: Config, pending: string[]) {
  if (!pending.length || !d.dump || cfg.PGLITE_DIR === 'memory') return null;
  const dir = `${path.resolve(cfg.PGLITE_DIR)}-backups`;
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}-before-${pending[0].replace(/\.sql$/, '')}.tar.gz`);
  fs.writeFileSync(file, Buffer.from(await (await d.dump()).arrayBuffer()));
  const old = fs.readdirSync(dir).filter((f) => f.endsWith('.tar.gz')).sort().reverse().slice(3);
  for (const f of old) fs.rmSync(path.join(dir, f), { force: true });
  console.log(`[backup] saved a copy of the database before updating: ${file}`);
  return file;
}

export type KeyStatus = 'ok' | 'new' | 'rotated' | 'changed';
const KEY_CHECK = 'system.encryption-key';

/**
 * Remembers a fingerprint of ENCRYPTION_KEY. 'changed' means saved secrets can't be read: restore the old key, or
 * rotate properly (old key in ENCRYPTION_KEY_PREVIOUS). During a rotation, every saved secret is re-encrypted.
 */
export async function checkEncryptionKey(cfg: Config): Promise<{ status: KeyStatus; reencrypted: number; unreadable: number }> {
  let reencrypted = 0;
  let unreadable = 0;
  const tables = [
    { table: 'integration_credentials', col: 'encrypted_values' },
    { table: 'integrations', col: 'encrypted_credentials' },
  ];
  for (const t of tables) {
    const rows = await db().query<{ provider: string; v: string }>(`SELECT provider, ${t.col} AS v FROM ${t.table} WHERE ${t.col} IS NOT NULL`);
    for (const r of rows) {
      if (decryptsWithCurrentKey(r.v)) continue;
      try {
        const plain = decrypt(r.v); // the previous key, if one is set
        await db().query(`UPDATE ${t.table} SET ${t.col} = $2 WHERE provider = $1`, [r.provider, encrypt(plain)]);
        reencrypted++;
      } catch {
        unreadable++;
      }
    }
  }
  const fp = keyFingerprint();
  const saved = await getKV<{ fingerprint: string }>(KEY_CHECK);
  let status: KeyStatus = !saved ? 'new' : saved.fingerprint === fp ? 'ok' : reencrypted && !unreadable ? 'rotated' : 'changed';
  if (status === 'changed' && !unreadable) {
    // Different key, but nothing saved depends on it: accept it.
    status = 'rotated';
  }
  if (status !== 'changed') await setKV(KEY_CHECK, { fingerprint: fp });
  await setKV('system.encryption-key-status', { status });
  if (status === 'changed') console.error('[security] ENCRYPTION_KEY differs from the one used before, so saved integration keys can’t be read. Restore the previous key, or set it as ENCRYPTION_KEY_PREVIOUS to rotate.');
  if (reencrypted) console.log(`[security] re-encrypted ${reencrypted} saved secret${reencrypted === 1 ? '' : 's'} with the new ENCRYPTION_KEY. You can remove ENCRYPTION_KEY_PREVIOUS now.`);
  return { status, reencrypted, unreadable };
}

/**
 * OWNER_RECOVERY_PASSWORD: sets OWNER_EMAIL's password (and makes sure that account is an active, approved Admin),
 * once per new value, and signs it out everywhere. The value itself is never stored or logged — only a fingerprint,
 * so a restart with the same value doesn't apply it again.
 */
export async function applyOwnerRecovery(cfg: Config) {
  const pw = cfg.OWNER_RECOVERY_PASSWORD?.trim();
  if (!pw) return false;
  if (pw.length < 10 || !/[a-zA-Z]/.test(pw) || !/[^a-zA-Z]/.test(pw) || Buffer.byteLength(pw) > 72) {
    console.error('[recovery] OWNER_RECOVERY_PASSWORD must be 10–72 characters with letters and a number or symbol. Not applied.');
    return false;
  }
  const fp = sha256(`${keyFingerprint()}:${cfg.OWNER_EMAIL.toLowerCase()}:${pw}`);
  if ((await getKV<{ fingerprint: string }>('system.owner-recovery'))?.fingerprint === fp) return false;
  const hash = await bcrypt.hash(pw, 12);
  const email = cfg.OWNER_EMAIL.toLowerCase();
  const existing = await db().one<{ id: string }>('SELECT id FROM staff WHERE lower(email) = $1', [email]);
  const id = existing?.id ?? (await db().one<{ id: string }>(
    `INSERT INTO staff(name, email, role, password_hash, approval_status, active) VALUES ('Salon Owner', $1, 'admin', $2, 'approved', true) RETURNING id`, [email, hash]))!.id;
  await db().tx(async (q) => {
    await q.query(`UPDATE staff SET password_hash = $2, role = 'admin', active = true, approval_status = 'approved', deactivated_at = NULL, updated_at = now() WHERE id = $1`, [id, hash]);
    await q.query("DELETE FROM staff_permission_overrides WHERE staff_id = $1 AND NOT granted", [id]);
    await q.query('DELETE FROM sessions WHERE staff_id = $1', [id]);
    await q.query('UPDATE password_reset_tokens SET used_at = now() WHERE staff_id = $1 AND used_at IS NULL', [id]);
    await q.query("INSERT INTO audit_logs(staff_id, action, entity_type, entity_id) VALUES ($1::uuid, 'auth.owner_recovery', 'staff', $2)", [id, id]);
  });
  await setKV('system.owner-recovery', { fingerprint: fp, appliedAt: new Date().toISOString() });
  console.log(`[recovery] Password reset for ${email} from OWNER_RECOVERY_PASSWORD. Sign in, then remove OWNER_RECOVERY_PASSWORD from the server settings.`);
  return true;
}

/** For Owners/Admins: the state of data storage, updates and the encryption key (no secrets). */
export async function systemStatus(cfg: Config, d: Db) {
  const applied = (await d.query<{ name: string; applied_at: Date }>('SELECT name, applied_at FROM schema_migrations ORDER BY name')).map((r) => r.name);
  const files = fs.readdirSync(migrationsDir()).filter((f) => f.endsWith('.sql')).sort();
  const key = await getKV<{ status?: KeyStatus }>('system.encryption-key-status');
  return {
    storage: storageInfo(cfg, d),
    production: cfg.NODE_ENV === 'production' && !cfg.DEMO_MODE,
    migrations: { applied: applied.length, latest: applied.at(-1) ?? null, pending: files.filter((f) => !applied.includes(f)), newerThanApp: applied.filter((n) => !files.includes(n)) },
    encryptionKey: key?.status ?? 'ok',
    previousKeySet: !!cfg.ENCRYPTION_KEY_PREVIOUS,
    recoveryPasswordSet: !!cfg.OWNER_RECOVERY_PASSWORD,
  };
}
