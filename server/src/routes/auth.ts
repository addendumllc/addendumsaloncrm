import bcrypt from 'bcryptjs';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { createSession, destroySession, requireAuth } from '../auth/session.js';
import { db } from '../db/index.js';
import { checkPasswordToken, createPasswordLink, emailPasswordLink, usePasswordToken } from '../domain/users.js';
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
  const { appearance } = await getSettings();
  res.json({ demoMode: isDemo(), accent: appearance.accent, appearance });
}));

authRouter.post('/login', loginLimiter, ah(async (req, res) => {
  const { email, password } = parse(z.object({ email: z.string().email(), password: z.string().min(1).max(200) }), req.body);
  const staff = await findStaffByEmail(email);
  const ok = staff?.password_hash && staff.active && (await bcrypt.compare(password, staff.password_hash));
  if (!ok) {
    await logAction(req, 'auth.login_failed');
    return res.status(401).json({ error: { code: 'invalid_login', message: "That email and password don't match." } });
  }
  await createSession(res, staff.id, req.get('user-agent'));
  await db().query('UPDATE staff SET last_login_at = now() WHERE id = $1', [staff.id]);
  req.user = { id: staff.id, name: staff.name, email: staff.email, role: staff.role, permissions: [] };
  await logAction(req, 'auth.login', 'staff', staff.id);
  res.json({ ok: true });
}));

authRouter.post('/logout', ah(async (req, res) => {
  await destroySession(req, res);
  res.json({ ok: true });
}));

authRouter.get('/me', requireAuth, (req, res) => res.json({ user: req.user }));

// ---------- Password recovery ----------
const tooMany = { error: { code: 'rate_limited', message: 'Too many requests. Please wait a few minutes.' } };
// Reset requests: a few per email address (so nobody's inbox can be flooded) and a ceiling per network address.
const forgotPerEmail = rateLimit({ windowMs: 15 * 60_000, limit: 3, standardHeaders: true, legacyHeaders: false, message: tooMany,
  keyGenerator: (req) => `forgot:${String(req.body?.email ?? '').trim().toLowerCase()}` });
const forgotPerIp = rateLimit({ windowMs: 15 * 60_000, limit: 30, standardHeaders: true, legacyHeaders: false, message: tooMany });
// Link checks and password sets: only failed attempts count, which stops anyone guessing links.
const resetLimiter = rateLimit({ windowMs: 15 * 60_000, limit: 10, skipSuccessfulRequests: true, standardHeaders: true, legacyHeaders: false, message: tooMany });
const strongPassword = z.string().min(10, 'must be at least 10 characters').max(200)
  .refine((p) => /[a-zA-Z]/.test(p) && /[^a-zA-Z]/.test(p), 'needs letters and at least one number or symbol');

/** Always answers the same way, so it can't be used to find out who has an account. */
authRouter.post('/forgot', forgotPerIp, forgotPerEmail, ah(async (req, res) => {
  const { email } = parse(z.object({ email: z.string().email() }), req.body);
  const staff = await findStaffByEmail(email);
  if (staff?.active) {
    const link = await createPasswordLink(staff.id, 'reset', null);
    const emailed = await emailPasswordLink(staff.id, link, 'reset');
    await audit(staff.id, 'auth.password_reset_requested', 'staff', staff.id, { emailed }, req.ip);
  }
  res.json({ ok: true, message: 'If that email has an account, a reset link is on its way. No email? Ask an administrator for a reset link.' });
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
