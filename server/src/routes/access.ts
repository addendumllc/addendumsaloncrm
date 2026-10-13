import net from 'node:net';
import bcrypt from 'bcryptjs';
import { Router } from 'express';
import { z } from 'zod';
import { accessStatus, canManageAccess, normalizeIp } from '../auth/access.js';
import { db } from '../db/index.js';
import { badRequest, forbidden } from '../lib/errors.js';
import { updateSettings } from '../repos/settings.js';
import { ah, logAction, parse } from './util.js';

/** Settings → Location & Access. Changes need an Owner/Admin and their password, and apply on the next request. */
export const accessRouter = Router();

accessRouter.get('/status', ah(async (req, res) => res.json({ status: await accessStatus(req) })));

accessRouter.put('/', ah(async (req, res) => {
  if (!canManageAccess(req.user)) throw forbidden('Only an Owner or Admin can change where the CRM can be used.');
  const b = parse(z.object({
    allowAnywhere: z.boolean(),
    salonIps: z.array(z.string().trim().max(64)).max(10),
    restrictMobile: z.boolean().default(false),
    password: z.string().min(1, 'enter your password to confirm').max(200),
  }), req.body);
  const me = await db().one<{ password_hash: string | null }>('SELECT password_hash FROM staff WHERE id = $1', [req.user!.id]);
  if (!me?.password_hash || !(await bcrypt.compare(b.password, me.password_hash))) throw badRequest('That password isn’t right.');
  const ips = [...new Set(b.salonIps.map(normalizeIp).filter(Boolean))];
  const bad = ips.filter((ip) => !net.isIP(ip));
  if (bad.length) throw badRequest(`Not an IP address: ${bad.join(', ')}`);
  const settings = await updateSettings({ access: { allowAnywhere: b.allowAnywhere, salonIps: ips, restrictMobile: b.restrictMobile } });
  await logAction(req, 'access.update', 'settings', null, { allowAnywhere: b.allowAnywhere, salonIps: ips.length, restrictMobile: b.restrictMobile });
  res.json({ access: settings.access, status: await accessStatus(req) });
}));
