import bcrypt from 'bcryptjs';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { createSession, destroySession, requireAuth } from '../auth/session.js';
import { extendPayUnlock, lockPay, markReauthenticated, PAY_SESSION_HOURS, payUnlockState, REAUTH_MINUTES } from '../auth/reauth.js';
import { db } from '../db/index.js';
import { sha256 } from '../lib/crypto.js';
import { checkPasswordToken, createPasswordLink, emailPasswordLink, requestAccess, usePasswordToken } from '../domain/users.js';
import { checkCode } from '../domain/loginCodes.js';
import { audit } from '../repos/audit.js';
import { findStaffByEmail } from '../repos/staff.js';
import { isDemo } from '../integrations/registry.js';
import { getSettings } from '../repos/settings.js';
import { ah, logAction, parse } from './util.js';

export const authRouter = Router();

const loginLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 10, skipSuccessfulRequests: true, standardHeaders: true, legacyHeaders: false,
  message: { error: { code: 'rate_limited', message: 'Too many sign-in attempts. Please wait a few minutes.' } } });

/** Public, non-sensitive: lets the sign-in screen show demo hints only in Demo Mode. */
authRouter.get('/config', ah(async (_req, res) => {
  const { appearance, accounts, login, workspaces } = await getSettings();
  // The sign-in screen: umbrella-branded (headline, photo, the businesses' names). The workspace's own look applies once signed in.
  res.json({ demoMode: isDemo(), accent: appearance.accent, appearance, allowAccessRequests: accounts.allowAccessRequests, login, businesses: workspaces?.businesses });
}));

authRouter.post('/login', loginLimiter, ah(async (req, res) => {
  const { email, password } = parse(z.object({ email: z.string().email(), password: z.string().min(1).max(200) }), req.body);
  const staff = await findStaffByEmail(email);
  const passwordOk = !!staff?.password_hash && (await bcrypt.compare(password, staff.password_hash));
  // Only someone who knows the password learns that their account is waiting or was turned down.
  if (passwordOk && staff.approval_status === 'pending') {
    await logAction(req, 'auth.login_pending', 'staff', staff.id);
    return res.status(403).json({ error: { code: 'pending_approval', message: 'Your account is waiting for an administrator to approve it. You’ll be able to sign in once it’s approved.' } });
  }
  if (passwordOk && staff.approval_status === 'rejected') {
    await logAction(req, 'auth.login_rejected', 'staff', staff.id);
    return res.status(403).json({ error: { code: 'access_rejected', message: 'Your access request wasn’t approved. Contact the salon if you think this is a mistake.' } });
  }
  if (!passwordOk || !staff.active) {
    await logAction(req, 'auth.login_failed');
    return res.status(401).json({ error: { code: 'invalid_login', message: "That email and password don't match." } });
  }
  await createSession(res, staff.id, req.get('user-agent'));
  await db().query('UPDATE staff SET last_login_at = now() WHERE id = $1', [staff.id]);
  // Passwords hashed with a lower cost by an older version are upgraded now (the password is only in memory here).
  if (!isDemo() && bcrypt.getRounds(staff.password_hash) < 12) {
    await db().query('UPDATE staff SET password_hash = $2 WHERE id = $1', [staff.id, await bcrypt.hash(password, 12)]);
  }
  req.user = { id: staff.id, name: staff.name, email: staff.email, role: staff.role, permissions: [] };
  await logAction(req, 'auth.login', 'staff', staff.id);
  res.json({ ok: true });
}));

/**
 * Sign in with email + custom code (set by an Owner). The email ties every guess to one account, which locks after a
 * few wrong codes; a network limit and Admin alerts sit on top. The code is never logged or recorded.
 */
const codeLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 20, skipSuccessfulRequests: true, standardHeaders: true, legacyHeaders: false,
  message: { error: { code: 'rate_limited', message: 'Too many sign-in attempts. Please wait a few minutes.' } } });
authRouter.post('/login-code', codeLimiter, ah(async (req, res) => {
  const { email, code } = parse(z.object({ email: z.string().email(), code: z.string().min(1).max(64) }), req.body);
  const staff = await findStaffByEmail(email);
  const r = await checkCode(staff?.id ?? null, code);
  if (!r.ok && r.reason === 'locked') {
    if (r.justLocked) {
      await logAction(req, 'auth.code_locked', 'staff', staff!.id);
      await alertAdminsLocked(staff!.id, staff!.name);
    }
    const until = new Date(r.lockedUntil!).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: (await getSettings()).business.timezone });
    return res.status(429).json({ error: { code: 'code_locked', message: `Too many wrong codes, so code sign-in is locked until ${until}. Sign in with your password, or ask an Owner to reset your code.` } });
  }
  if (!r.ok) {
    await logAction(req, 'auth.code_failed', staff ? 'staff' : undefined, staff?.id ?? null);
    return res.status(401).json({ error: { code: 'invalid_login', message: "That email and code don't match." } });
  }
  // Same rules as a password: a correct code doesn't get round approval or deactivation.
  if (staff.approval_status === 'pending') return res.status(403).json({ error: { code: 'pending_approval', message: 'Your account is waiting for an administrator to approve it.' } });
  if (staff.approval_status === 'rejected') return res.status(403).json({ error: { code: 'access_rejected', message: 'Your access request wasn’t approved.' } });
  if (!staff.active) return res.status(401).json({ error: { code: 'invalid_login', message: "That email and code don't match." } });
  await createSession(res, staff.id, req.get('user-agent'), 'code');
  await db().query('UPDATE staff SET last_login_at = now() WHERE id = $1', [staff.id]);
  req.user = { id: staff.id, name: staff.name, email: staff.email, role: staff.role, permissions: [] };
  await logAction(req, 'auth.login_code', 'staff', staff.id);
  res.json({ ok: true });
}));

/** Someone's code just locked after repeated wrong tries: tell the Admins (in the app). */
async function alertAdminsLocked(staffId: string, name: string) {
  const admins = await db().query<{ id: string }>("SELECT id FROM staff WHERE role = 'admin' AND active AND approval_status = 'approved'");
  for (const a of admins) {
    await db().query('INSERT INTO notifications(staff_id, kind, title, body, link) VALUES ($1,$2,$3,$4,$5)',
      [a.id, 'code_locked', `Code sign-in locked for ${name}`, 'Several wrong codes were tried for this account. If it wasn’t them, reset or revoke their code.', `/settings?tab=users&open=${staffId}`]);
  }
}

authRouter.post('/logout', ah(async (req, res) => {
  await destroySession(req, res);
  res.json({ ok: true });
}));

authRouter.get('/me', requireAuth, (req, res) => res.json({ user: req.user }));

/** Re-enter your password before sensitive changes (integration credentials). Covers the next few minutes. */
/** Has this device confirmed the password in the last few minutes? (Pay pages are locked until it has.) */
authRouter.get('/reauth-status', requireAuth, ah(async (req, res) => {
  const st = await payUnlockState(req);
  res.json({ unlocked: st.unlocked, minutes: REAUTH_MINUTES, until: st.until, canKeepUnlocked: req.user!.role === 'admin', sessionHours: PAY_SESSION_HOURS });
}));

/** Lock pay again on this device now. */
authRouter.post('/lock-pay', requireAuth, ah(async (req, res) => {
  await lockPay(req);
  await logAction(req, 'auth.pay_locked', 'staff', req.user!.id);
  res.json({ ok: true });
}));

authRouter.post('/confirm-password', requireAuth, loginLimiter, ah(async (req, res) => {
  // keepPayUnlocked: Admins can keep pay open on this device for a working session.
  const { password, keepPayUnlocked } = parse(z.object({ password: z.string().min(1).max(200), keepPayUnlocked: z.boolean().optional() }), req.body);
  const row = await db().one<{ password_hash: string | null }>('SELECT password_hash FROM staff WHERE id = $1', [req.user!.id]);
  // Their password — or, for people who sign in with a code, that code (same lock-out rules as code sign-in).
  const ok = (!!row?.password_hash && (await bcrypt.compare(password, row.password_hash))) || (await checkCode(req.user!.id, password)).ok;
  if (!ok) {
    await logAction(req, 'auth.reauth_failed', 'staff', req.user!.id);
    return res.status(400).json({ error: { code: 'invalid_password', message: 'That password isn’t right.' } });
  }
  await markReauthenticated(req);
  if (keepPayUnlocked && req.user!.role === 'admin') await extendPayUnlock(req);
  await logAction(req, 'auth.reauth', 'staff', req.user!.id, keepPayUnlocked && req.user!.role === 'admin' ? { payUnlockedHours: PAY_SESSION_HOURS } : undefined);
  res.json({ ok: true, minutes: REAUTH_MINUTES });
}));

// ---------- Password recovery ----------
const tooMany = { error: { code: 'rate_limited', message: 'Too many requests. Please wait a few minutes.' } };
// Reset requests: a few per email address (so nobody's inbox can be flooded) and a ceiling per network address.
const forgotPerEmail = rateLimit({ windowMs: 15 * 60_000, limit: 3, standardHeaders: true, legacyHeaders: false, message: tooMany,
  keyGenerator: (req) => `forgot:${String(req.body?.email ?? '').trim().toLowerCase()}` });
const forgotPerIp = rateLimit({ windowMs: 15 * 60_000, limit: 30, standardHeaders: true, legacyHeaders: false, message: tooMany });
// Link checks and password sets: only failed attempts count, which stops anyone guessing links.
const resetLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 10, skipSuccessfulRequests: true, standardHeaders: true, legacyHeaders: false, message: tooMany });
// bcrypt only uses the first 72 bytes, so longer passwords are refused rather than silently shortened.
const strongPassword = z.string().min(10, 'must be at least 10 characters').max(200)
  .refine((p) => Buffer.byteLength(p, 'utf8') <= 72, 'must be 72 characters or fewer (fewer with emoji or accents)')
  .refine((p) => /[a-zA-Z]/.test(p) && /[^a-zA-Z]/.test(p), 'needs letters and at least one number or symbol');

/** Always answers the same way, so it can't be used to find out who has an account. */
authRouter.post('/forgot', forgotPerIp, forgotPerEmail, ah(async (req, res) => {
  const { email } = parse(z.object({ email: z.string().email() }), req.body);
  const staff = await findStaffByEmail(email);
  if (staff?.active || staff?.approval_status === 'pending') {
    const link = await createPasswordLink(staff.id, 'reset', null);
    const emailed = await emailPasswordLink(staff.id, link, 'reset');
    await audit(staff.id, 'auth.password_reset_requested', 'staff', staff.id, { emailed }, req.ip);
  }
  res.json({ ok: true, message: 'If that email has an account, a reset link is on its way. No email? Ask an administrator for a reset link.' });
}));

/**
 * "Request access" on the sign-in screen: creates a pending login (no access) and alerts the Admins.
 * Same answer either way, so it can't reveal whether an email already has an account.
 */
const requestLimiter = rateLimit({ windowMs: 60 * 60_000, limit: 5, standardHeaders: true, legacyHeaders: false, message: tooMany });
authRouter.post('/request-access', requestLimiter, ah(async (req, res) => {
  const b = parse(z.object({
    name: z.string().trim().min(2, 'enter your full name').max(100),
    email: z.string().trim().email('must be an email address').max(200),
    password: strongPassword,
  }), req.body);
  const r = await requestAccess(b);
  if (r.created) await audit(r.id!, 'auth.access_requested', 'staff', r.id!, undefined, req.ip);
  res.json({ ok: true, message: 'Request sent. An administrator needs to approve it before you can sign in. You can try signing in later with the password you just chose.' });
}));

/** Change your own password (current one required). Signs you out on every other device. */
authRouter.post('/change-password', requireAuth, loginLimiter, ah(async (req, res) => {
  const b = parse(z.object({ current: z.string().min(1).max(200), password: strongPassword }), req.body);
  const row = await db().one<{ password_hash: string | null }>('SELECT password_hash FROM staff WHERE id = $1', [req.user!.id]);
  if (!row?.password_hash || !(await bcrypt.compare(b.current, row.password_hash))) {
    await logAction(req, 'auth.password_change_failed', 'staff', req.user!.id);
    return res.status(400).json({ error: { code: 'invalid_password', message: 'Your current password isn’t right.' } });
  }
  const token = req.cookies?.addendum_session as string | undefined;
  await db().tx(async (q) => {
    await q.query('UPDATE staff SET password_hash = $2, updated_at = now() WHERE id = $1', [req.user!.id, await bcrypt.hash(b.password, 12)]);
    await q.query('DELETE FROM sessions WHERE staff_id = $1 AND id <> $2', [req.user!.id, token ? sha256(token) : '']);
    await q.query('UPDATE password_reset_tokens SET used_at = now() WHERE staff_id = $1 AND used_at IS NULL', [req.user!.id]);
  });
  await logAction(req, 'auth.password_changed', 'staff', req.user!.id);
  res.json({ ok: true });
}));

authRouter.get('/reset/:token', resetLimiter, ah(async (req, res) => {
  const t = await checkPasswordToken(req.params.token);
  if (!t) return res.status(404).json({ valid: false, error: { code: 'invalid_link', message: 'This link has expired or was already used.' } });
  res.json({ valid: true, name: String(t.name).split(' ')[0], purpose: t.purpose });
}));

authRouter.post('/reset', resetLimiter, ah(async (req, res) => {
  const b = parse(z.object({ token: z.string().min(20).max(200), password: strongPassword }), req.body);
  const staffId = await usePasswordToken(b.token, b.password);
  await audit(staffId, 'auth.password_set', 'staff', staffId, undefined, req.ip);
  res.json({ ok: true });
}));
