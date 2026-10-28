import express, { Router } from 'express';
import { z } from 'zod';
import {
  addFromTransformation, addUpload, addSharedLink, planSalonPost, postFromTransformation, salonPosts, teamIdeas, removeSharedLink, salonDownload, salonDownloads, salonIdeas, stylistLinks, createPost, deletePost, FORMATS, getHandle, getPost, listPosts, mediaFile, myTransformationPhotos, removeMedia, setHandle, setThumb, STATUSES, updatePost,
} from '../domain/myContent.js';
import { receiveUpload } from '../domain/transformations.js';
import { can } from '../auth/permissions.js';
import { forbidden } from '../lib/errors.js';
import { ah, parse, uuid } from './util.js';

/** My Content — each stylist's private Instagram plan (permissions.ts: "My Content"); every query is their own. */
export const myContentRouter = Router();
const ID = '([0-9a-fA-F-]{36})';
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const text = (max: number) => z.string().max(max).nullable().optional();
const post = z.object({
  date: date.nullable().optional(), time: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional().or(z.literal('').transform(() => null)),
  format: z.enum(FORMATS).optional(), status: z.enum(STATUSES).optional(), title: z.string().max(200).optional(),
  caption: text(2200), hashtags: text(1000), notes: text(4000), sharedWithTeam: z.boolean().optional(),
});

myContentRouter.get('/', ah(async (req, res) => {
  const q = parse(z.object({ from: date, to: date }), req.query);
  res.json({ posts: await listPosts(req.user!, q.from, q.to), instagram: await getHandle(req.user!) });
}));
myContentRouter.put('/instagram', ah(async (req, res) => res.json({ instagram: await setHandle(req.user!, parse(z.object({ handle: z.string().max(100).nullable() }), req.body).handle) })));
myContentRouter.get('/team-ideas', ah(async (req, res) => res.json({ ideas: await teamIdeas(req.user!) })));
myContentRouter.get('/ideas', ah(async (_req, res) => res.json({ ideas: await salonIdeas() })));
// Links the salon shares (Canva…): everyone with My Content sees them; adding or removing is for Content Calendar managers.
myContentRouter.get('/links', ah(async (_req, res) => res.json({ links: await stylistLinks() })));
myContentRouter.post('/links', ah(async (req, res) => {
  if (!can(req.user, 'content:manage')) throw forbidden('Adding links for stylists is for people who manage the Content Calendar.');
  const b = parse(z.object({ title: z.string().max(120), url: z.string().max(1000), kind: z.enum(['post', 'story', 'both']).default('both') }), req.body);
  res.status(201).json({ links: await addSharedLink(b) });
}));
myContentRouter.delete(`/links/:lid${ID}`, ah(async (req, res) => {
  if (!can(req.user, 'content:manage')) throw forbidden('Removing links for stylists is for people who manage the Content Calendar.');
  res.json({ links: await removeSharedLink(req.params.lid) });
}));
myContentRouter.get('/downloads', ah(async (_req, res) => res.json({ downloads: await salonDownloads() })));
// A shared group (e.g. a carousel) as a ZIP, in the salon's order — only what's shared with stylists.
myContentRouter.get('/salon-posts', ah(async (_req, res) => res.json({ posts: await salonPosts() })));
myContentRouter.post('/salon-posts/plan', ah(async (req, res) => res.status(201).json({ post: await planSalonPost(parse(z.object({ name: z.string().min(1).max(80) }), req.body).name, req.user!) })));
myContentRouter.get('/downloads/group', ah(async (req, res) => {
  const { assetGroupZip } = await import('../domain/content.js');
  const z1 = await assetGroupZip(String(req.query.group ?? '').slice(0, 80), true);
  res.setHeader('Cache-Control', 'no-store');
  res.attachment(z1.name);
  res.sendFile(z1.file, () => void z1.remove());
}));
myContentRouter.get(`/downloads/:did${ID}`, ah(async (req, res) => {
  const m = await salonDownload(req.params.did);
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.type(m.mime);
  if ('download' in req.query) res.attachment(m.name || `${(m.title || 'addendum').replace(/[^A-Za-z0-9 _-]+/g, '').trim() || 'addendum'}.${m.mime.split('/')[1]?.replace('jpeg', 'jpg').replace('quicktime', 'mov') ?? 'jpg'}`);
  res.send(m.bytes);
}));
myContentRouter.get('/transformation-photos', ah(async (req, res) => res.json({ photos: await myTransformationPhotos(req.user!) })));
myContentRouter.get(`/media/:mid${ID}/:which(thumb|original)`, ah(async (req, res) => {
  const f = await mediaFile(req.params.mid, req.params.which as 'thumb' | 'original', req.user!);
  if (!f) return res.status(404).end();
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.type(f.mime);
  if ('download' in req.query) res.attachment(f.name);
  res.sendFile(f.path);
}));
myContentRouter.put(`/media/:mid${ID}/thumb`, express.raw({ type: () => true, limit: '1100kb' }), ah(async (req, res) => {
  await setThumb(req.params.mid, Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0), req.user!);
  res.json({ ok: true });
}));
myContentRouter.delete(`/media/:mid${ID}`, ah(async (req, res) => res.json({ post: await removeMedia(req.params.mid, req.user!) })));
myContentRouter.post('/from-transformation', ah(async (req, res) => res.status(201).json({ post: await postFromTransformation(parse(z.object({ transformationId: uuid }), req.body).transformationId, req.user!) })));
myContentRouter.post('/', ah(async (req, res) => res.status(201).json({ post: await createPost(parse(post, req.body), req.user!) })));
myContentRouter.get(`/:id${ID}`, ah(async (req, res) => res.json({ post: await getPost(req.params.id, req.user!) })));
myContentRouter.patch(`/:id${ID}`, ah(async (req, res) => res.json({ post: await updatePost(req.params.id, parse(post, req.body), req.user!) })));
myContentRouter.delete(`/:id${ID}`, ah(async (req, res) => { await deletePost(req.params.id, req.user!); res.json({ ok: true }); }));
// Photos and videos are streamed to disk as they arrive (like Transformations).
myContentRouter.post(`/:id${ID}/media`, ah(async (req, res) => res.status(201).json(await addUpload(req.params.id, () => receiveUpload(req), req.user!))));
myContentRouter.post(`/:id${ID}/media/transformation`, ah(async (req, res) => res.json({ post: await addFromTransformation(req.params.id, parse(z.object({ mediaId: uuid }), req.body).mediaId, req.user!) })));
