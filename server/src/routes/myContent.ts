import express, { Router } from 'express';
import { z } from 'zod';
import {
  addFromTransformation, addUpload, createPost, deletePost, FORMATS, getHandle, getPost, listPosts, mediaFile, myTransformationPhotos, removeMedia, setHandle, setThumb, STATUSES, updatePost,
} from '../domain/myContent.js';
import { receiveUpload } from '../domain/transformations.js';
import { ah, parse, uuid } from './util.js';

/** My Content — each stylist's private Instagram plan (permissions.ts: "My Content"); every query is their own. */
export const myContentRouter = Router();
const ID = '([0-9a-fA-F-]{36})';
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const text = (max: number) => z.string().max(max).nullable().optional();
const post = z.object({
  date: date.nullable().optional(), time: z.string().regex(/^\d{2}:\d{2}$/).nullable().optional().or(z.literal('').transform(() => null)),
  format: z.enum(FORMATS).optional(), status: z.enum(STATUSES).optional(), title: z.string().max(200).optional(),
  caption: text(2200), hashtags: text(1000), notes: text(4000),
});

myContentRouter.get('/', ah(async (req, res) => {
  const q = parse(z.object({ from: date, to: date }), req.query);
  res.json({ posts: await listPosts(req.user!, q.from, q.to), instagram: await getHandle(req.user!) });
}));
myContentRouter.put('/instagram', ah(async (req, res) => res.json({ instagram: await setHandle(req.user!, parse(z.object({ handle: z.string().max(100).nullable() }), req.body).handle) })));
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
myContentRouter.post('/', ah(async (req, res) => res.status(201).json({ post: await createPost(parse(post, req.body), req.user!) })));
myContentRouter.get(`/:id${ID}`, ah(async (req, res) => res.json({ post: await getPost(req.params.id, req.user!) })));
myContentRouter.patch(`/:id${ID}`, ah(async (req, res) => res.json({ post: await updatePost(req.params.id, parse(post, req.body), req.user!) })));
myContentRouter.delete(`/:id${ID}`, ah(async (req, res) => { await deletePost(req.params.id, req.user!); res.json({ ok: true }); }));
// Photos and videos are streamed to disk as they arrive (like Transformations).
myContentRouter.post(`/:id${ID}/media`, ah(async (req, res) => res.status(201).json(await addUpload(req.params.id, () => receiveUpload(req), req.user!))));
myContentRouter.post(`/:id${ID}/media/transformation`, ah(async (req, res) => res.json({ post: await addFromTransformation(req.params.id, parse(z.object({ mediaId: uuid }), req.body).mediaId, req.user!) })));
