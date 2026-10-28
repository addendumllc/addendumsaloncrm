import express, { Router, type Response } from 'express';
import { z } from 'zod';
import { CONSENT_STATUSES } from '@addendum/shared';
import { can } from '../auth/permissions.js';
import {
  addInstagram, addPhoto, createCollection, createTransformation, deleteCollection, deleteTransformation, detailsCsv, exportFile, exportStatus, getTransformation,
  listTransformations, MAX_PHOTO_BYTES, options, photoFile, refreshInstagram, removeInstagram, removePhoto, reorderPhotos, replacePhoto, setCollectionItems,
  setInstagramPrimary, setServiceList, setThumbnail, startExport, updateConsent, updatePhoto, updateTransformation,
} from '../domain/transformations.js';
import { forbidden } from '../lib/errors.js';
import { ah, isoDate, logAction, parse, uuid } from './util.js';

/** Transformations Library (permissions.ts: any transformations permission opens it; each route checks the record). */
export const transformationsRouter = Router();
const ID = '([0-9a-fA-F-]{36})';
const raw = express.raw({ type: () => true, limit: MAX_PHOTO_BYTES + 1024 });
const rawThumb = express.raw({ type: () => true, limit: '1100kb' });
const body = (b: unknown) => (Buffer.isBuffer(b) ? b : Buffer.alloc(0));
const text = (max: number) => z.string().trim().max(max).nullable().optional().transform((v) => (v === undefined ? undefined : v || null));
const sendFile = (res: Response, f: { path: string; mime?: string; name: string }, download: boolean) => {
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (f.mime) res.type(f.mime);
  if (download) res.attachment(f.name);
  res.sendFile(f.path);
};

const extension = z.object({
  hasExtensions: z.boolean(), method: text(60), brand: text(120), length: text(40), shade: text(120), quantity: text(120), workType: text(60), blending: z.boolean().nullable().optional(),
  customization: text(2000), maintenanceNotes: text(2000), nextAppointment: text(200),
}).nullable();
const details = z.object({
  startingCondition: text(2000), desiredResult: text(2000), techniques: text(2000), products: text(2000), lengthTexture: text(500), styling: text(1000), aftercare: text(2000),
}).partial();
const fields = {
  title: z.string().trim().min(1, 'add a title').max(200), stylistStaffId: uuid.nullable().optional(), serviceDate: isoDate, clientId: uuid.nullable().optional(),
  mainService: z.string().trim().min(1, 'choose the main service').max(120), services: z.array(z.string().trim().min(1).max(120)).max(30).optional(),
  details: details.optional(), extension: extension.optional(), technicalNotes: text(5000), internalNotes: text(5000), caption: text(2200), hashtags: text(1000),
  tags: z.array(z.string().max(60)).max(40).optional(),
};
const createSchema = z.object({ ...fields, consentStatus: z.enum(CONSENT_STATUSES.map((s) => s.value) as [string, ...string[]]).optional(), instagramUrl: text(500) });
const listSchema = z.object({
  q: z.string().max(200).optional(), stylist: uuid.optional(), from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  service: z.string().max(120).optional(), extensions: z.string().max(60).optional(), collection: uuid.optional(), consent: z.string().max(30).optional(), tag: z.string().max(60).optional(),
  ready: z.union([z.boolean(), z.enum(['true', 'false', '1', '0'])]).optional().transform((v) => v === true || v === 'true' || v === '1'),
  sort: z.enum(['newest', 'oldest', 'stylist', 'service', 'updated']).optional(), limit: z.coerce.number().int().min(1).max(200).optional(), offset: z.coerce.number().int().min(0).optional(),
});
const blank = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== '' && v != null));

transformationsRouter.get('/', ah(async (req, res) => res.json(await listTransformations(parse(listSchema, blank(req.query as any)), req.user!))));
transformationsRouter.get('/options', ah(async (req, res) => res.json(await options(req.user!))));
transformationsRouter.put('/options/services', ah(async (req, res) => {
  if (!can(req.user, 'transformations:manage')) throw forbidden('Managing the services list is for people who manage the library.');
  const { services } = parse(z.object({ services: z.array(z.string().max(120)).max(100) }), req.body);
  const list = await setServiceList(services);
  await logAction(req, 'transformations.services', undefined, undefined, { count: list.length });
  res.json({ services: list });
}));

// Collections (managing them needs "Manage the transformations library").
const manager = (req: express.Request) => { if (!can(req.user, 'transformations:manage')) throw forbidden('Managing collections is for people who manage the library.'); };
transformationsRouter.post('/collections', ah(async (req, res) => { manager(req); res.json({ collections: await createCollection(parse(z.object({ name: z.string().max(80) }), req.body).name) }); }));
transformationsRouter.delete(`/collections/:cid${ID}`, ah(async (req, res) => { manager(req); res.json({ collections: await deleteCollection(req.params.cid) }); }));
transformationsRouter.post(`/collections/:cid${ID}/items`, ah(async (req, res) => {
  manager(req);
  const b = parse(z.object({ ids: z.array(uuid).min(1).max(500), remove: z.boolean().optional() }), req.body);
  res.json({ collections: await setCollectionItems(req.params.cid, b.ids, !!b.remove) });
}));

// Photo files: thumbnails for anyone who can see the record, originals only with download access.
transformationsRouter.get(`/media/:mid${ID}/:which(thumb|original)`, ah(async (req, res) => {
  const which = req.params.which as 'thumb' | 'original';
  const f = await photoFile(req.params.mid, which, req.user!);
  if (!f) return res.status(404).end();
  const download = which === 'original' && 'download' in req.query;
  if (download) await logAction(req, 'transformations.download_photo', 'transformation_media', req.params.mid);
  sendFile(res, f, download);
}));

// Download ZIPs: prepared in the background (progress), then a time-limited link for the person who asked.
const exportSchema = z.object({
  preset: z.enum(['selected', 'filter', 'social', 'one']), ids: z.array(uuid).max(2000).optional(), photoIds: z.array(uuid).max(5000).optional(),
  filter: listSchema.omit({ limit: true, offset: true }).optional(), includeTechnical: z.boolean().optional(), approvedOnly: z.boolean().optional(), groupBy: z.enum(['service', 'collection']).optional(),
});
transformationsRouter.post('/exports', ah(async (req, res) => {
  const b = parse(exportSchema, req.body);
  const id = await startExport(b, req.user!);
  await logAction(req, 'transformations.export', 'transformation_export', id, { preset: b.preset, records: b.ids?.length, photos: b.photoIds?.length, technical: !!b.includeTechnical });
  res.status(202).json(await exportStatus(id, req.user!));
}));
transformationsRouter.get(`/exports/:eid${ID}`, ah(async (req, res) => res.json(await exportStatus(req.params.eid, req.user!))));
transformationsRouter.get(`/exports/:eid${ID}/download`, ah(async (req, res) => {
  const f = await exportFile(req.params.eid, String(req.query.token ?? ''), req.user!);
  await logAction(req, 'transformations.export_download', 'transformation_export', req.params.eid);
  res.setHeader('Cache-Control', 'no-store');
  res.attachment(f.name);
  res.sendFile(f.path);
}));

// Photos.
transformationsRouter.patch(`/photos/:mid${ID}`, ah(async (req, res) => {
  const b = parse(z.object({ kind: z.enum(['before', 'after', 'finished', 'detail', 'other']).optional(), caption: text(500) }), req.body);
  res.json({ transformation: await updatePhoto(req.params.mid, b, req.user!) });
}));
transformationsRouter.put(`/photos/:mid${ID}/thumb`, rawThumb, ah(async (req, res) => res.json(await setThumbnail(req.params.mid, body(req.body), req.user!))));
transformationsRouter.post(`/photos/:mid${ID}/replace`, raw, ah(async (req, res) => {
  const t = await replacePhoto(req.params.mid, body(req.body), String(req.query.name ?? '') || null, req.user!);
  await logAction(req, 'transformations.photo_replace', 'transformation', t.id, { photo: req.params.mid });
  res.json({ transformation: t });
}));
transformationsRouter.delete(`/photos/:mid${ID}`, ah(async (req, res) => {
  const t = await removePhoto(req.params.mid, req.user!);
  await logAction(req, 'transformations.photo_remove', 'transformation', t.id, { photo: req.params.mid });
  res.json({ transformation: t });
}));

// Instagram references (links and preview metadata only).
transformationsRouter.post(`/instagram/:iid${ID}/refresh`, ah(async (req, res) => res.json({ transformation: await refreshInstagram(req.params.iid, req.user!) })));
transformationsRouter.patch(`/instagram/:iid${ID}`, ah(async (req, res) => res.json({ transformation: await setInstagramPrimary(req.params.iid, parse(z.object({ isPrimary: z.boolean() }), req.body).isPrimary, req.user!) })));
transformationsRouter.delete(`/instagram/:iid${ID}`, ah(async (req, res) => res.json({ transformation: await removeInstagram(req.params.iid, req.user!) })));

// Records.
transformationsRouter.post('/', ah(async (req, res) => {
  const t = await createTransformation(parse(createSchema, req.body), req.user!);
  await logAction(req, 'transformations.create', 'transformation', t.id, { code: t.code });
  res.status(201).json({ transformation: t });
}));
transformationsRouter.get(`/:id${ID}`, ah(async (req, res) => res.json({ transformation: await getTransformation(req.params.id, req.user!) })));
transformationsRouter.patch(`/:id${ID}`, ah(async (req, res) => {
  const b = parse(z.object(fields).partial(), req.body);
  const t = await updateTransformation(req.params.id, b, req.user!);
  await logAction(req, 'transformations.update', 'transformation', t.id, { fields: Object.keys(b) });
  res.json({ transformation: t });
}));
transformationsRouter.delete(`/:id${ID}`, ah(async (req, res) => {
  await deleteTransformation(req.params.id, req.user!);
  await logAction(req, 'transformations.delete', 'transformation', req.params.id);
  res.json({ ok: true });
}));
transformationsRouter.patch(`/:id${ID}/consent`, ah(async (req, res) => {
  const b = parse(z.object({
    status: z.enum(CONSENT_STATUSES.map((s) => s.value) as [string, ...string[]]).optional(), clientConsent: z.enum(['unknown', 'requested', 'given', 'declined']).optional(),
    socialPermission: z.boolean().optional(), marketingPermission: z.boolean().optional(), scope: text(500), consentDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    identifiable: z.boolean().nullable().optional(), restrictions: text(1000), expiresOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(), verified: z.boolean().optional(),
  }), req.body);
  const t = await updateConsent(req.params.id, b, req.user!);
  await logAction(req, 'transformations.consent', 'transformation', t.id, { status: t.consent.status, clientConsent: t.consent.clientConsent, verified: b.verified });
  res.json({ transformation: t });
}));
transformationsRouter.post(`/:id${ID}/photos`, raw, ah(async (req, res) => {
  const out = await addPhoto(req.params.id, body(req.body), { kind: String(req.query.kind ?? ''), caption: String(req.query.caption ?? '') || null, name: String(req.query.name ?? '') || null }, req.user!);
  if (!out.duplicate) await logAction(req, 'transformations.photo_add', 'transformation', req.params.id, { photo: out.photoId });
  res.status(out.duplicate ? 200 : 201).json(out);
}));
transformationsRouter.post(`/:id${ID}/photos/order`, ah(async (req, res) => res.json({ transformation: await reorderPhotos(req.params.id, parse(z.object({ ids: z.array(uuid).max(200) }), req.body).ids, req.user!) })));
transformationsRouter.post(`/:id${ID}/instagram`, ah(async (req, res) => {
  const b = parse(z.object({ url: z.string().max(500), isPrimary: z.boolean().optional() }), req.body);
  const t = await addInstagram(req.params.id, b.url, !!b.isPrimary, req.user!);
  await logAction(req, 'transformations.instagram_add', 'transformation', t.id);
  res.json({ transformation: t });
}));
transformationsRouter.get(`/:id${ID}/details.csv`, ah(async (req, res) => {
  const f = await detailsCsv(req.params.id, req.user!, req.query.technical === '1');
  res.setHeader('Cache-Control', 'no-store');
  res.attachment(f.name).type('text/csv').send(f.body);
}));
