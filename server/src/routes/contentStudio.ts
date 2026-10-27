import { Router } from 'express';
import { z } from 'zod';
import { can } from '../auth/permissions.js';
import { db } from '../db/index.js';
import { attachToTask, deleteStudio, generateStudio, importStudio, studioPrompt, listStudio, regenerateBlock, resultSchema, saveStudio, STUDIO_FORMATS, STUDIO_GOALS } from '../domain/contentStudio.js';
import { forbidden } from '../lib/errors.js';
import { ah, logAction, parse } from './util.js';

/** Content Studio — "Content calendar" or "Content Studio" (permissions.ts). The AI is called here, never from the browser. */
export const contentStudioRouter = Router();
const input = z.object({
  format: z.enum(STUDIO_FORMATS), service: z.string().trim().min(1).max(120), goal: z.enum(Object.keys(STUDIO_GOALS) as [keyof typeof STUDIO_GOALS]), length: z.string().max(20).nullable().default(null),
  notes: z.object({ offer: z.string().max(1000).nullable().optional(), eventDate: z.string().max(100).nullable().optional(), stylist: z.string().max(100).nullable().optional(), stylistHandle: z.string().max(100).nullable().optional(),
    clientFirstName: z.string().max(60).nullable().optional(), other: z.string().max(2000).nullable().optional() }).default({}),
});
contentStudioRouter.post('/generate', ah(async (req, res) => {
  const b = parse(input, req.body);
  const out = await generateStudio(b);
  await logAction(req, 'content.studio_generate', undefined, undefined, { format: b.format, service: b.service, warnings: out.warnings.length });
  res.json(out);
}));
// Copy & paste with Claude.ai: the prompt to paste there, and its answer pasted back (checked like a generated one).
contentStudioRouter.post('/prompt', ah(async (req, res) => res.json({ prompt: studioPrompt(parse(input, req.body)) })));
contentStudioRouter.post('/import', ah(async (req, res) => {
  const b = parse(z.object({ input, text: z.string().min(2).max(60_000) }), req.body);
  res.json(importStudio(b.input, b.text));
}));
contentStudioRouter.post('/regenerate', ah(async (req, res) => {
  const b = parse(z.object({ input, result: resultSchema, index: z.union([z.number().int().min(0).max(30), z.literal('caption')]) }), req.body);
  res.json({ result: await regenerateBlock(b.input, b.result, b.index) });
}));
contentStudioRouter.get('/saved', ah(async (_req, res) => res.json({ items: await listStudio() })));
contentStudioRouter.post('/saved', ah(async (req, res) => {
  const b = parse(z.object({ input, result: resultSchema, title: z.string().trim().min(1).max(200) }), req.body);
  const id = await saveStudio(req.user!.id, b.input, b.result, b.title);
  res.status(201).json({ id, items: await listStudio() });
}));
contentStudioRouter.delete('/saved/:id', ah(async (req, res) => { await deleteStudio(req.params.id); res.json({ items: await listStudio() }); }));
// Attach a saved SMS or email to a follow-up the person can see (theirs, or all with "see all tasks").
contentStudioRouter.post('/saved/:id/attach', ah(async (req, res) => {
  const { taskId } = parse(z.object({ taskId: z.string().uuid() }), req.body);
  const t = await db().one<{ assigned_staff_id: string | null }>('SELECT assigned_staff_id FROM tasks WHERE id = $1', [taskId]);
  if (t && t.assigned_staff_id !== req.user!.id && !can(req.user, 'tasks:read_all') && !can(req.user, '*')) throw forbidden('You can only add it to your own follow-ups.');
  await attachToTask(req.params.id, taskId);
  await logAction(req, 'content.studio_attach', 'task', taskId);
  res.json({ ok: true });
}));
