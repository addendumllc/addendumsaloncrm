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
    networks: z.array(z.object({ name: z.string().trim().min(1, 'give each network a name').max(40), ip: z.string().trim().max(64) })).max(10),
    restrictMobile: z.boolean().default(false),
    password: z.string().min(1, 'enter your password to confirm').max(200),
  }), req.body);
  const me = await db().one<{ password_hash: string | null }>('SELECT password_hash FROM staff WHERE id = $1', [req.user!.id]);
  if (!me?.password_hash || !(await bcrypt.compare(b.password, me.password_hash))) throw badRequest('That password isn’t right.');
  const networks = b.networks.map((n) => ({ name: n.name, ip: normalizeIp(n.ip) }));
  const bad = networks.filter((n) => !net.isIP(n.ip));
  if (bad.length) throw badRequest(`Not an IP address: ${bad.map((n) => n.ip || n.name).join(', ')}`);
  const dup = networks.find((n, i) => networks.findIndex((m) => m.ip === n.ip) !== i);
  if (dup) throw badRequest(`${dup.ip} is listed twice.`);
  // Saving replaces any unnamed IPs from earlier versions with the named list.
  const settings = await updateSettings({ access: { allowAnywhere: b.allowAnywhere, networks, salonIps: [], restrictMobile: b.restrictMobile } });
  await logAction(req, 'access.update', 'settings', null, { allowAnywhere: b.allowAnywhere, networks: networks.map((n) => n.name), restrictMobile: b.restrictMobile });
  res.json({ access: settings.access, status: await accessStatus(req) });
}));
