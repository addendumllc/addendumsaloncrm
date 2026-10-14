import crypto from 'node:crypto';
import { argon2id, argon2Verify } from 'hash-wasm';
import { db } from '../db/index.js';
import { badRequest, notFound } from '../lib/errors.js';
import { iso } from '../lib/time.js';

/**
 * Custom sign-in codes: the CRM's own login credential (never a Square passcode or API key), set by an Owner/Admin
 * as an alternative to a password. Signing in needs the person's email *and* their code, so a guessed code can only be
 * tried against one account — which locks after a few wrong attempts.
 *
 * Storage: Argon2id (OWASP parameters: 19 MiB memory, 2 iterations), a unique random salt per code. Codes are never
 * stored, returned (except a generated one, once, to the Owner who generated it), logged or put in the activity log.
 */
const ARGON = { parallelism: 1, iterations: 2, memorySize: 19456, hashLength: 32 } as const;
export const MAX_FAILED = 5;
const LOCK_MINUTES = [15, 60, 240, 1440]; // longer each time it locks again

export async function hashCode(code: string) {
  return argon2id({ ...ARGON, password: code, salt: crypto.randomBytes(16), outputType: 'encoded' });
}
async function verifyCode(code: string, hash: string) {
  try {
    return await argon2Verify({ password: code, hash });
  } catch {
    return false;
  }
}
// Used when the email has no code, so an answer takes the same time either way.
let decoy: Promise<string> | null = null;
const decoyHash = () => (decoy ??= hashCode(crypto.randomBytes(12).toString('hex')));

const COMMON = new Set([
  '123456', '1234567', '12345678', '123456789', '1234567890', '654321', '87654321', '000000', '00000000', '111111', '11111111',
  '121212', '12121212', '112233', '11223344', '123123', '12341234', '123321', '696969', '159753', '147258', '147258369',
  'password', 'passw0rd', 'qwerty', 'qwerty123', 'abc123', 'abcdef', 'letmein', 'welcome', 'iloveyou', 'admin', 'admin123',
  'salon', 'salon123', 'addendum', 'square', 'abcd1234', 'a1b2c3', 'a1b2c3d4', '1q2w3e', '1q2w3e4r', 'zaq12wsx',
]);

/** Refuses guessable codes. Returns a reason, or null when the code is acceptable. */
export function weakCode(code: string, person: { name?: string | null; email?: string | null } = {}): string | null {
  const c = code.trim();
  const lower = c.toLowerCase();
  if (c !== code) return 'can’t start or end with a space';
  if (c.length < 6) return 'must be at least 6 characters';
  if (c.length > 32) return 'must be 32 characters or fewer';
  if (/^\d+$/.test(c) && c.length < 8) return 'must be at least 8 digits when it’s only numbers (or mix in letters)';
  if (COMMON.has(lower)) return 'is too common';
  if (/^(.)\1+$/.test(c)) return 'can’t be one character repeated';
  if (/^(.{1,4})\1+$/.test(lower)) return 'can’t be a short pattern repeated';
  const codes = [...lower].map((ch) => ch.charCodeAt(0));
  const steps = codes.slice(1).map((v, i) => v - codes[i]);
  if (steps.every((s) => s === 1) || steps.every((s) => s === -1)) return 'can’t be a sequence like 12345678 or abcdef';
  if (new Set(c).size < 3) return 'needs at least 3 different characters';
  const parts = [person.email?.split('@')[0], ...(person.name ?? '').split(/\s+/)].map((p) => (p ?? '').toLowerCase()).filter((p) => p.length >= 3);
  if (parts.some((p) => lower.includes(p))) return 'can’t contain the person’s name or email';
  return null;
}

/** A random 8-digit code (no weak patterns). */
export function generateCode(person: { name?: string | null; email?: string | null } = {}) {
  for (;;) {
    const c = String(crypto.randomInt(10_000_000, 100_000_000));
    if (!weakCode(c, person)) return c;
  }
}

export interface LoginCodeStatus {
  set: boolean;
  enabled: boolean;
  locked: boolean;
  lockedUntil: string | null;
  failedAttempts: number;
  lastUsedAt: string | null;
  updatedAt: string | null;
  squareLocationId: string | null;
  squareLocationName: string | null;
}

export async function codeStatus(staffId: string): Promise<LoginCodeStatus> {
  const r = await db().one<any>(
    `SELECT c.*, l.name AS location_name FROM staff_login_codes c LEFT JOIN locations l ON l.square_location_id = c.square_location_id WHERE c.staff_id = $1`, [staffId]);
  return {
    set: !!r, enabled: !!r?.enabled, locked: !!r?.locked_until && new Date(r.locked_until) > new Date(),
    lockedUntil: r?.locked_until && new Date(r.locked_until) > new Date() ? iso(r.locked_until) : null,
    failedAttempts: r?.failed_attempts ?? 0, lastUsedAt: iso(r?.last_used_at), updatedAt: iso(r?.updated_at),
    squareLocationId: r?.square_location_id ?? null, squareLocationName: r?.location_name ?? null,
  };
}

async function signOutCodeSessions(staffId: string) {
  await db().query("DELETE FROM sessions WHERE staff_id = $1 AND auth_method = 'code'", [staffId]);
}

/**
 * Set or replace a person's code (a new one works immediately; the old one stops, and sessions it opened end).
 * `generate` makes a random code, returned once so the Owner can hand it over.
 */
export async function setCode(actorId: string, staffId: string, opts: { code?: string; generate?: boolean }) {
  const person = await db().one<{ name: string; email: string | null }>('SELECT name, email FROM staff WHERE id = $1', [staffId]);
  if (!person) throw notFound('That team member');
  const code = opts.generate ? generateCode(person) : opts.code ?? '';
  const weak = weakCode(code, person);
  if (weak) throw badRequest(`The code ${weak}.`);
  const hash = await hashCode(code);
  await db().query(
    `INSERT INTO staff_login_codes(staff_id, code_hash, updated_by_staff_id) VALUES ($1,$2,$3)
     ON CONFLICT (staff_id) DO UPDATE SET code_hash = $2, enabled = true, failed_attempts = 0, lockouts = 0, locked_until = NULL,
       updated_by_staff_id = $3, updated_at = now()`,
    [staffId, hash, actorId],
  );
  await signOutCodeSessions(staffId);
  return opts.generate ? code : null;
}

export async function setCodeEnabled(actorId: string, staffId: string, enabled: boolean) {
  const r = await db().query(
    `UPDATE staff_login_codes SET enabled = $2, failed_attempts = 0, locked_until = CASE WHEN $2 THEN NULL ELSE locked_until END,
       updated_by_staff_id = $3, updated_at = now() WHERE staff_id = $1 RETURNING staff_id`, [staffId, enabled, actorId]);
  if (!r.length) throw badRequest('This person doesn’t have a code yet.');
  if (!enabled) await signOutCodeSessions(staffId);
}

/** Revoke: the code is deleted and every session it opened ends now. */
export async function revokeCode(staffId: string) {
  await db().query('DELETE FROM staff_login_codes WHERE staff_id = $1', [staffId]);
  await signOutCodeSessions(staffId);
}

export async function setCodeLocation(actorId: string, staffId: string, squareLocationId: string | null) {
  if (squareLocationId && !(await db().one('SELECT 1 FROM locations WHERE square_location_id = $1', [squareLocationId]))) {
    throw badRequest('That Square location isn’t in the CRM. Sync Square first, then choose it.');
  }
  const r = await db().query('UPDATE staff_login_codes SET square_location_id = $2, updated_by_staff_id = $3, updated_at = now() WHERE staff_id = $1 RETURNING staff_id', [staffId, squareLocationId, actorId]);
  if (!r.length) throw badRequest('Create a code first.');
}

export type CodeCheck = { ok: true } | { ok: false; reason: 'invalid' | 'locked'; lockedUntil?: string; justLocked?: boolean };

/** Checks a code for one account, counting failures and locking the account's code after MAX_FAILED wrong tries. */
export async function checkCode(staffId: string | null, code: string): Promise<CodeCheck> {
  const row = staffId ? await db().one<any>('SELECT * FROM staff_login_codes WHERE staff_id = $1', [staffId]) : null;
  if (!row || !row.enabled) {
    await verifyCode(code, await decoyHash());
    return { ok: false, reason: 'invalid' };
  }
  if (row.locked_until && new Date(row.locked_until) > new Date()) return { ok: false, reason: 'locked', lockedUntil: iso(row.locked_until)! };
  if (await verifyCode(code, row.code_hash)) {
    await db().query('UPDATE staff_login_codes SET failed_attempts = 0, lockouts = 0, locked_until = NULL, last_used_at = now() WHERE staff_id = $1', [staffId]);
    return { ok: true };
  }
  const failed = row.failed_attempts + 1;
  if (failed >= MAX_FAILED) {
    const minutes = LOCK_MINUTES[Math.min(row.lockouts, LOCK_MINUTES.length - 1)];
    const until = new Date(Date.now() + minutes * 60_000);
    await db().query('UPDATE staff_login_codes SET failed_attempts = 0, lockouts = lockouts + 1, locked_until = $2 WHERE staff_id = $1', [staffId, until]);
    return { ok: false, reason: 'locked', lockedUntil: until.toISOString(), justLocked: true };
  }
  await db().query('UPDATE staff_login_codes SET failed_attempts = $2 WHERE staff_id = $1', [staffId, failed]);
  return { ok: false, reason: 'invalid' };
}
