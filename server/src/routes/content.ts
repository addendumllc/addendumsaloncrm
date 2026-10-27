import express, { Router } from 'express';
import { z } from 'zod';
import { createPost, contentAccounts, deletePost, getPost, linkOptions, listPosts, MEDIA_LIMITS, publishDueContent, readMedia, saveContentAccounts, saveMedia, updatePost } from '../domain/content.js';
import { notFound } from '../lib/errors.js';
import { ah, logAction, parse } from './util.js';

/** Content calendar (Instagram) — everything needs "Content calendar" (permissions.ts). */
export const contentRouter = Router();

const slot = z.enum(['a1', 'a2', 'a3']);
contentRouter.get('/accounts', ah(async (_req, res) => res.json({ accounts: await contentAccounts() })));
contentRouter.put('/accounts', ah(async (req, res) => {
  const b = parse(z.object({ accounts: z.array(z.object({ id: slot, name: z.string().trim().min(1).max(60), handle: z.string().trim().max(60), color: z.string().regex(/^#[0-9a-fA-F]{6}$/) })).max(3) }), req.body);
  res.json({ accounts: await saveContentAccounts(b.accounts) });
}));

const postBody = z.object({
  account: slot, type: z.enum(['feed', 'reel', 'story', 'carousel']), scheduledAt: z.string().datetime({ offset: true }).nullable(),
  caption: z.string().max(2200).default(''), status: z.enum(['idea', 'draft', 'ready', 'scheduled', 'posted', 'failed']), autoPost: z.boolean().default(false),
  mediaIds: z.array(z.string().uuid()).max(10).default([]),
  link: z.object({ kind: z.enum(['product', 'service']), ref: z.string().min(1).max(200), label: z.string().max(200) }).nullable().default(null),
  assignedStaffId: z.string().uuid().nullable().default(null), notes: z.string().max(2000).nullable().default(null),
});
contentRouter.get('/posts', ah(async (req, res) => {
  const q = parse(z.object({ from: z.string().datetime({ offset: true }), to: z.string().datetime({ offset: true }) }), req.query);
  res.json({ posts: await listPosts(q.from, q.to) });
}));
contentRouter.get('/posts/:id', ah(async (req, res) => res.json({ post: await getPost(req.params.id) })));
contentRouter.post('/posts', ah(async (req, res) => {
  const post = await createPost(parse(postBody, req.body), req.user!.id);
  await logAction(req, 'content.create', 'content_post', post.id, { account: post.account, type: post.type });
  res.status(201).json({ post });
}));
contentRouter.put('/posts/:id', ah(async (req, res) => {
  const post = await updatePost(req.params.id, parse(postBody, req.body));
  await logAction(req, 'content.update', 'content_post', post.id, { status: post.status });
  res.json({ post });
}));
contentRouter.delete('/posts/:id', ah(async (req, res) => {
  await deletePost(req.params.id);
  await logAction(req, 'content.delete', 'content_post', req.params.id);
  res.json({ ok: true });
}));
contentRouter.get('/links', ah(async (req, res) => res.json({ options: await linkOptions(String(req.query.q ?? '')) })));

// Uploads: the file itself as the body (photos up to 15 MB, videos up to 100 MB).
contentRouter.post('/media', express.raw({ type: () => true, limit: MEDIA_LIMITS.video + 1024 }), ah(async (req, res) => {
  const name = req.get('x-file-name') ? decodeURIComponent(req.get('x-file-name')!) : null;
  const media = await saveMedia(Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0), req.get('content-type') ?? '', name, req.user!.id);
  res.status(201).json({ media });
}));
contentRouter.get('/media/:id', ah(async (req, res) => {
  const m = await readMedia(req.params.id);
  if (!m) throw notFound('File not found');
  res.setHeader('Content-Type', m.mime);
  res.setHeader('Cache-Control', 'private, max-age=86400');
  res.send(m.bytes);
}));
// Post now (auto-posting accounts): runs the posting check straight away.
contentRouter.post('/publish-due', ah(async (_req, res) => res.json({ posted: await publishDueContent() })));
