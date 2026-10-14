import { Router } from 'express';
import { z } from 'zod';
import { requireAnyPermission, requirePermission } from '../auth/session.js';
import {
  createAnnouncement, deleteAnnouncement, getAnnouncement, listAnnouncements, markAllRead, markRead, setPublished, unreadAnnouncements, updateAnnouncement,
} from '../domain/announcements.js';
import { roleTemplates } from '../domain/users.js';
import { ah, logAction, parse } from './util.js';

/** Team announcements (separate from tasks). Every rule is checked here and in domain/announcements.ts. */
export const announcementsRouter = Router();

const body = z.object({
  title: z.string().trim().min(1, 'is required').max(140),
  body: z.string().trim().max(5000).optional(),
  linkUrl: z.string().trim().max(500).optional().nullable(),
  linkLabel: z.string().trim().max(80).optional().nullable(),
  important: z.boolean().optional(),
  pinned: z.boolean().optional(),
  audienceRoles: z.array(z.string().trim().min(1).max(60)).max(20).optional().nullable(),
});

const reader = requireAnyPermission('announcements:read', 'announcements:publish', 'announcements:manage');
const writer = requireAnyPermission('announcements:publish', 'announcements:manage');

announcementsRouter.get('/', reader, ah(async (req, res) => {
  res.json({ announcements: await listAnnouncements(req.user!), unread: await unreadAnnouncements(req.user!) });
}));
/** Role names, to choose who an announcement is for (names only — no permissions). */
announcementsRouter.get('/roles', writer, ah(async (_req, res) => {
  res.json({ roles: (await roleTemplates()).map((r) => ({ role: r.role, label: r.label })) });
}));

announcementsRouter.get('/:id', reader, ah(async (req, res) => res.json({ announcement: await getAnnouncement(req.user!, req.params.id) })));

announcementsRouter.post('/', writer, ah(async (req, res) => {
  const b = parse(body.extend({ publish: z.boolean().default(true) }), req.body);
  const a = await createAnnouncement(req.user!, b, b.publish);
  await logAction(req, b.publish ? 'announcement.publish' : 'announcement.draft', 'announcement', a.id, { audience: b.audienceRoles?.length ? b.audienceRoles : 'everyone' });
  res.status(201).json({ announcement: a });
}));

announcementsRouter.put('/:id', writer, ah(async (req, res) => {
  const a = await updateAnnouncement(req.user!, req.params.id, parse(body, req.body));
  await logAction(req, 'announcement.update', 'announcement', a.id);
  res.json({ announcement: a });
}));

announcementsRouter.post('/:id/:state(publish|unpublish)', writer, ah(async (req, res) => {
  const on = req.params.state === 'publish';
  const a = await setPublished(req.user!, req.params.id, on);
  await logAction(req, on ? 'announcement.publish' : 'announcement.unpublish', 'announcement', a.id);
  res.json({ announcement: a });
}));

announcementsRouter.delete('/:id', writer, ah(async (req, res) => {
  await deleteAnnouncement(req.user!, req.params.id);
  await logAction(req, 'announcement.delete', 'announcement', req.params.id);
  res.json({ ok: true });
}));

announcementsRouter.post('/read-all', requirePermission('announcements:read'), ah(async (req, res) => {
  await markAllRead(req.user!);
  res.json({ unread: 0 });
}));
announcementsRouter.post('/:id/read', reader, ah(async (req, res) => {
  await markRead(req.user!, req.params.id);
  res.json({ unread: await unreadAnnouncements(req.user!) });
}));
