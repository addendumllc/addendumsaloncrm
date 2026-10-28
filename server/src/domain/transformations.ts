import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import type { CurrentUser, TransformationConsentDTO, TransformationDTO, TransformationExtensionDTO, TransformationInstagramDTO, TransformationPhotoDTO } from '@addendum/shared';
import { can } from '../auth/permissions.js';
import { config } from '../config.js';
import { db } from '../db/index.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { getKV, setKV } from '../repos/settings.js';

/**
 * Transformations Library: stylists' work. Photos are files on disk under MEDIA_DIR (a persistent docker volume in
 * production), named by their content hash so the same file selected twice is stored once and an original is never
 * overwritten. Thumbnails are made in the browser and stored next to it. The database keeps references and metadata.
 *
 * Access (all checked here, on the server):
 *  - "Own transformations": their own records (they're the stylist or created it): create, edit, photos, download.
 *  - "View all" sees everyone's; "Manage" edits/reassigns any; "Consent" verifies consent and approves publishing.
 *  - Technical and internal notes: their own records, or "See technical notes".
 *  - Downloads: their own, or "Download transformation photos"; ZIPs of more than one record need "Bulk download".
 */
type Who = Pick<CurrentUser, 'id' | 'permissions'>;

export const DEFAULT_SERVICES = [
  'Haircut', 'All-over color', 'Root touch-up', 'Partial highlight', 'Full highlight', 'Balayage / lightening', 'Gloss or toner',
  'Smoothing treatment (Hair Polish)', 'Hair extension installation', 'Extension maintenance / move-up', 'Extension removal', 'Other',
];
export const isExtensionService = (s: string) => /extension/i.test(s);
export const MAX_PHOTO_BYTES = 25 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 500 * 1024 * 1024;
export const MAX_THUMB_BYTES = 1024 * 1024;
const EXPORT_HOURS = 24;

export async function serviceList(): Promise<string[]> {
  return (await getKV<string[]>('transformations.services')) ?? DEFAULT_SERVICES;
}
export async function setServiceList(list: string[]) {
  const clean = [...new Set(list.map((s) => s.trim()).filter(Boolean))].slice(0, 100);
  if (!clean.length) throw badRequest('Keep at least one service.');
  await setKV('transformations.services', clean);
  return clean;
}

// ---------------- storage ----------------
export const mediaRoot = () => path.resolve(config().MEDIA_DIR);
const abs = (rel: string) => {
  const p = path.resolve(mediaRoot(), rel);
  if (!p.startsWith(mediaRoot() + path.sep)) throw badRequest('Bad file path.');
  return p;
};
async function writeFileOnce(rel: string, bytes: Buffer) {
  const p = abs(rel);
  await fs.promises.mkdir(path.dirname(p), { recursive: true });
  // wx: never overwrite (an existing file with the same hash is the same photo).
  await fs.promises.writeFile(p, bytes, { flag: 'wx' }).catch((e) => { if (e.code !== 'EEXIST') throw e; });
}
const removeFile = (rel: string | null) => (rel ? fs.promises.unlink(abs(rel)).catch(() => {}) : Promise.resolve());

/** The photo formats accepted, recognised from the file's own bytes (not its name). */
export function sniffImage(b: Buffer): { mime: string; ext: string } | null {
  if (b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { mime: 'image/jpeg', ext: 'jpg' };
  if (b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mime: 'image/png', ext: 'png' };
  if (b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP') return { mime: 'image/webp', ext: 'webp' };
  if (b.toString('latin1', 4, 8) === 'ftyp') {
    const brand = b.toString('latin1', 8, 12);
    if (['heic', 'heix', 'hevc', 'heim', 'heis', 'mif1', 'msf1'].includes(brand)) return { mime: 'image/heic', ext: 'heic' };
    if (brand === 'avif') return { mime: 'image/avif', ext: 'avif' };
  }
  return null;
}
/** Photos, plus the videos phones record (MP4 / MOV / WebM), from the file's own bytes. */
export function sniffMedia(b: Buffer): { mime: string; ext: string; video: boolean } | null {
  const img = sniffImage(b);
  if (img) return { ...img, video: false };
  if (b.length >= 12 && b.toString('latin1', 4, 8) === 'ftyp') {
    const brand = b.toString('latin1', 8, 12);
    if (brand === 'qt  ') return { mime: 'video/quicktime', ext: 'mov', video: true };
    if (/^(isom|iso\d|mp4\d|avc1|M4V |M4VP|M4VH|dash|3gp\d|3g2\w|MSNV|f4v |mmp4)$/.test(brand)) return { mime: 'video/mp4', ext: 'mp4', video: true };
  }
  if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return { mime: 'video/webm', ext: 'webm', video: true };
  return null;
}

/** An upload received straight to a temporary file (never whole in memory), with its size, hash and first bytes. */
export interface Upload { tmp: string; size: number; sha: string; head: Buffer }
export async function receiveUpload(stream: NodeJS.ReadableStream, maxBytes = MAX_VIDEO_BYTES): Promise<Upload> {
  const dir = path.join(mediaRoot(), 'tmp');
  await fs.promises.mkdir(dir, { recursive: true });
  const tmp = path.join(dir, crypto.randomBytes(12).toString('hex'));
  const hash = crypto.createHash('sha256');
  const out = fs.createWriteStream(tmp);
  let size = 0;
  let head = Buffer.alloc(0);
  try {
    await new Promise<void>((resolve, reject) => {
      stream.on('data', (c: Buffer) => {
        size += c.length;
        if (size > maxBytes) { reject(Object.assign(new Error('too_large'), { tooLarge: true })); (stream as any).destroy?.(); return; }
        if (head.length < 64) head = Buffer.concat([head, c.subarray(0, 64 - head.length)]);
        hash.update(c);
        if (!out.write(c)) { stream.pause(); out.once('drain', () => stream.resume()); }
      });
      stream.on('end', () => out.end(() => resolve()));
      stream.on('error', reject);
      out.on('error', reject);
    });
  } catch (e: any) {
    out.destroy();
    await fs.promises.unlink(tmp).catch(() => {});
    if (e?.tooLarge) throw badRequest(`Videos can be up to ${maxBytes / 1024 / 1024} MB, photos ${MAX_PHOTO_BYTES / 1024 / 1024} MB.`);
    throw e;
  }
  return { tmp, size, sha: hash.digest('hex'), head };
}
/** Test helper and small uploads: a buffer as an Upload. */
export async function bufferUpload(bytes: Buffer) {
  const { Readable } = await import('node:stream');
  return receiveUpload(Readable.from([bytes]));
}
const dropUpload = (up: Upload) => fs.promises.unlink(up.tmp).catch(() => {});

// ---------------- access ----------------
interface Row {
  id: string; number: number; title: string; stylist_staff_id: string | null; stylist_name: string | null; service_date: string; client_id: string | null; client_name: string | null;
  main_service: string; details: any; technical_notes: string | null; internal_notes: string | null; caption: string | null; hashtags: string | null; tags: string[];
  created_by_staff_id: string | null; created_at: string; updated_at: string;
}
// Their own work — and work whose stylist isn't known yet, so any stylist can see it and claim it.
const isOwn = (t: Pick<Row, 'stylist_staff_id' | 'created_by_staff_id'>, u: Who) => t.stylist_staff_id === u.id || t.stylist_staff_id == null;
export const access = (t: Pick<Row, 'stylist_staff_id' | 'created_by_staff_id'>, u: Who) => {
  const own = isOwn(t, u) && can(u, 'transformations:own');
  const see = own || can(u, 'transformations:view_all') || can(u, 'transformations:manage');
  return {
    see,
    edit: own || can(u, 'transformations:manage'),
    technical: see && (own || can(u, 'transformations:technical')),
    download: see && (own || can(u, 'transformations:download')),
  };
};
/** Social-post details (Instagram links, captions, hashtags, tags) are administrators' (manage the library or approve consent). */
const socialAdmin = (u: Who) => can(u, 'transformations:manage') || can(u, 'transformations:consent');
const seesAll = (u: Who) => can(u, 'transformations:view_all') || can(u, 'transformations:manage');

const BASE = `SELECT t.*, s.name AS stylist_name, NULLIF(TRIM(COALESCE(c.first_name,'') || ' ' || COALESCE(c.last_name,'')), '') AS client_name
  FROM transformations t LEFT JOIN staff s ON s.id = t.stylist_staff_id LEFT JOIN clients c ON c.id = t.client_id`;

async function rowOrThrow(id: string): Promise<Row> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound('That transformation');
  const r = await db().one<Row>(`${BASE} WHERE t.id = $1`, [id]);
  if (!r) throw notFound('That transformation');
  return r;
}
/** The record, if this person may see it (404 otherwise, so ids can't be probed). */
export async function visible(id: string, u: Who) {
  const r = await rowOrThrow(id);
  const a = access(r, u);
  if (!a.see) throw notFound('That transformation');
  return { row: r, a };
}
async function editable(id: string, u: Who) {
  const v = await visible(id, u);
  if (!v.a.edit) throw forbidden('Only the stylist who did this work, or someone who manages the library, can change it.');
  return v;
}
const touch = (id: string) => db().query('UPDATE transformations SET updated_at = now() WHERE id = $1', [id]);

// ---------------- DTOs ----------------
const day = (d: any) => (d == null ? null : typeof d === 'string' ? d.slice(0, 10) : new Date(d).toISOString().slice(0, 10));
const iso = (d: any) => (d == null ? null : new Date(d).toISOString());
export const code = (n: number) => `T-${String(n).padStart(4, '0')}`;
const today = () => new Date().toISOString().slice(0, 10);

function consentDTO(c: any): TransformationConsentDTO {
  return {
    status: c?.status ?? 'pending', clientConsent: c?.client_consent ?? 'unknown', socialPermission: !!c?.social_permission, marketingPermission: !!c?.marketing_permission,
    scope: c?.scope ?? null, consentDate: day(c?.consent_date), identifiable: c?.identifiable ?? null, restrictions: c?.restrictions ?? null, expiresOn: day(c?.expires_on),
    verifiedBy: c?.verified_by_name ?? null, verifiedAt: iso(c?.verified_at),
  };
}
export const consentExpired = (c: TransformationConsentDTO) => !!c.expiresOn && c.expiresOn < today();
/** Approved for social media: approved status, the client said yes to social media, verified, not expired. */
export const approvedForSocial = (c: TransformationConsentDTO) =>
  c.status === 'approved_social' && c.clientConsent === 'given' && c.socialPermission && !!c.verifiedAt && !consentExpired(c);

async function dtos(rows: Row[], u: Who): Promise<TransformationDTO[]> {
  if (!rows.length) return [];
  const ids = rows.map((r) => r.id);
  const [services, ext, media, ig, consent, colls] = await Promise.all([
    db().query<{ transformation_id: string; service: string }>('SELECT * FROM transformation_services WHERE transformation_id = ANY($1)', [ids]),
    db().query<any>('SELECT * FROM transformation_extensions WHERE transformation_id = ANY($1)', [ids]),
    db().query<any>('SELECT m.*, s.name AS by_name FROM transformation_media m LEFT JOIN staff s ON s.id = m.uploaded_by_staff_id WHERE transformation_id = ANY($1) ORDER BY position, uploaded_at', [ids]),
    db().query<any>('SELECT i.*, s.name AS by_name FROM transformation_instagram i LEFT JOIN staff s ON s.id = i.added_by_staff_id WHERE transformation_id = ANY($1) ORDER BY is_primary DESC, added_at', [ids]),
    db().query<any>('SELECT c.*, s.name AS verified_by_name FROM transformation_consent c LEFT JOIN staff s ON s.id = c.verified_by_staff_id WHERE transformation_id = ANY($1)', [ids]),
    db().query<any>('SELECT i.transformation_id, c.id, c.name FROM transformation_collection_items i JOIN transformation_collections c ON c.id = i.collection_id WHERE i.transformation_id = ANY($1) ORDER BY c.name', [ids]),
  ]);
  const by = <T extends { transformation_id: string }>(list: T[]) => {
    const m = new Map<string, T[]>();
    for (const x of list) m.set(x.transformation_id, [...(m.get(x.transformation_id) ?? []), x]);
    return m;
  };
  const sv = by(services), ex = by(ext), md = by(media), igs = by(ig), cs = by(consent), cl = by(colls);
  const seeClients = can(u, 'clients:read') || can(u, 'clients:read_assigned');
  return rows.map((r) => {
    const a = access(r, u);
    const e = ex.get(r.id)?.[0];
    const extension: TransformationExtensionDTO | null = e ? {
      hasExtensions: e.has_extensions, method: e.method, brand: e.brand, length: e.length, shade: e.shade, quantity: e.quantity, workType: e.work_type,
      blending: e.blending, customization: e.customization, maintenanceNotes: e.maintenance_notes, nextAppointment: e.next_appointment,
    } : null;
    const photos: TransformationPhotoDTO[] = (md.get(r.id) ?? []).map((m) => ({
      id: m.id, kind: m.kind, caption: m.caption, position: m.position, mime: m.mime, size: m.size, originalName: m.original_name,
      thumbUrl: `/api/transformations/media/${m.id}/thumb`, originalUrl: `/api/transformations/media/${m.id}/original`, uploadedBy: m.by_name ?? null, uploadedAt: iso(m.uploaded_at)!,
    }));
    const instagram: TransformationInstagramDTO[] = (igs.get(r.id) ?? []).map((i) => ({
      id: i.id, url: i.url, postType: i.post_type ?? 'other', title: i.title, author: i.author, thumbnailUrl: i.thumbnail_url, previewStatus: i.preview_status,
      isPrimary: i.is_primary, addedBy: i.by_name ?? null, addedAt: iso(i.added_at)!,
    }));
    const c = consentDTO(cs.get(r.id)?.[0]);
    const missing: string[] = [];
    if (!photos.length && !instagram.length) missing.push('Photo or Instagram link');
    if (c.status !== 'approved_social') missing.push('Approval for social media');
    else if (!approvedForSocial(c)) missing.push(consentExpired(c) ? 'Consent has expired' : 'Verified client consent');
    if (!r.caption?.trim()) missing.push('Caption');
    if (!photos.some((p) => p.kind === 'after' || p.kind === 'finished') && !instagram.length) missing.push('After / finished photo');
    return {
      id: r.id, number: r.number, code: code(r.number), title: r.title, stylistStaffId: r.stylist_staff_id, stylistName: r.stylist_name, serviceDate: day(r.service_date)!,
      clientId: a.edit || seeClients ? r.client_id : null, clientName: a.edit || seeClients ? r.client_name : null,
      mainService: r.main_service, services: (sv.get(r.id) ?? []).map((s) => s.service), details: r.details ?? {}, extension,
      technicalNotes: a.technical ? r.technical_notes : null, internalNotes: a.technical ? r.internal_notes : null, canSeeTechnical: a.technical,
      caption: r.caption, hashtags: r.hashtags, tags: r.tags ?? [], collections: (cl.get(r.id) ?? []).map((x) => ({ id: x.id, name: x.name })),
      photos, instagram, consent: c, readyForSocial: approvedForSocial(c) && (photos.length > 0 || instagram.length > 0), missing,
      canEdit: a.edit, canDownload: a.download, createdBy: r.created_by_staff_id, createdAt: iso(r.created_at)!, updatedAt: iso(r.updated_at)!,
    };
  });
}

export async function getTransformation(id: string, u: Who) {
  const { row } = await visible(id, u);
  return (await dtos([row], u))[0];
}

// ---------------- list / search ----------------
export interface ListFilter {
  q?: string; stylist?: string; from?: string; to?: string; service?: string; extensions?: 'yes' | 'no' | string; collection?: string;
  consent?: string; ready?: boolean; tag?: string; sort?: 'newest' | 'oldest' | 'stylist' | 'service' | 'updated'; limit?: number; offset?: number; ids?: string[];
}
const READY_SQL = `EXISTS (SELECT 1 FROM transformation_consent k WHERE k.transformation_id = t.id AND k.status = 'approved_social' AND k.client_consent = 'given'
  AND k.social_permission AND k.verified_at IS NOT NULL AND (k.expires_on IS NULL OR k.expires_on >= CURRENT_DATE))
  AND (EXISTS (SELECT 1 FROM transformation_media m WHERE m.transformation_id = t.id) OR EXISTS (SELECT 1 FROM transformation_instagram i WHERE i.transformation_id = t.id))`;

function where(f: ListFilter, u: Who) {
  const w: string[] = [];
  const p: unknown[] = [];
  const add = (sql: string, ...v: unknown[]) => { let s = sql; for (const x of v) { p.push(x); s = s.replace('?', `$${p.length}`); } w.push(s); };
  if (!seesAll(u)) add('(t.stylist_staff_id = ? OR t.stylist_staff_id IS NULL)', u.id);
  if (f.ids?.length) add('t.id = ANY(?)', f.ids);
  if (f.stylist) add('t.stylist_staff_id = ?', f.stylist);
  if (f.from) add('t.service_date >= ?', f.from);
  if (f.to) add('t.service_date <= ?', f.to);
  if (f.service) add('(t.main_service = ? OR EXISTS (SELECT 1 FROM transformation_services x WHERE x.transformation_id = t.id AND x.service = ?))', f.service, f.service);
  if (f.extensions === 'yes') w.push('EXISTS (SELECT 1 FROM transformation_extensions e WHERE e.transformation_id = t.id AND e.has_extensions)');
  else if (f.extensions === 'no') w.push('NOT EXISTS (SELECT 1 FROM transformation_extensions e WHERE e.transformation_id = t.id AND e.has_extensions)');
  else if (f.extensions) add('EXISTS (SELECT 1 FROM transformation_extensions e WHERE e.transformation_id = t.id AND e.has_extensions AND lower(e.method) = lower(?))', f.extensions);
  if (f.collection) add('EXISTS (SELECT 1 FROM transformation_collection_items ci WHERE ci.transformation_id = t.id AND ci.collection_id = ?)', f.collection);
  if (f.consent) add("COALESCE((SELECT k.status FROM transformation_consent k WHERE k.transformation_id = t.id), 'pending') = ?", f.consent);
  if (f.tag) add('? = ANY(t.tags)', f.tag.toLowerCase());
  if (f.ready) w.push(READY_SQL);
  if (f.q?.trim()) {
    const like = `%${f.q.trim().toLowerCase().replace(/[%_\\]/g, (m) => `\\${m}`)}%`;
    // Client names are searchable only by people who can see clients.
    const client = can(u, 'clients:read') || can(u, 'clients:read_assigned') ? " OR lower(COALESCE(c.first_name,'') || ' ' || COALESCE(c.last_name,'')) LIKE ?" : '';
    const n = /^t-?0*(\d+)$/i.exec(f.q.trim());
    add(`(lower(t.title) LIKE ? OR lower(COALESCE(s.name,'')) LIKE ? OR lower(t.main_service) LIKE ? OR lower(array_to_string(t.tags, ' ')) LIKE ?
      OR lower(COALESCE(t.caption,'')) LIKE ? OR lower(t.details::text) LIKE ?
      OR EXISTS (SELECT 1 FROM transformation_services x WHERE x.transformation_id = t.id AND lower(x.service) LIKE ?)
      OR EXISTS (SELECT 1 FROM transformation_extensions e WHERE e.transformation_id = t.id AND lower(COALESCE(e.method,'') || ' ' || COALESCE(e.shade,'') || ' ' || COALESCE(e.brand,'') || ' ' || COALESCE(e.length,'')) LIKE ?)${client}
      ${n ? `OR t.number = ${Number(n[1])}` : ''})`, ...Array(client ? 9 : 8).fill(like));
  }
  return { sql: w.length ? `WHERE ${w.join(' AND ')}` : '', params: p };
}
const ORDER: Record<string, string> = {
  newest: 't.service_date DESC, t.number DESC', oldest: 't.service_date ASC, t.number ASC', stylist: 'lower(s.name) NULLS LAST, t.service_date DESC',
  service: 'lower(t.main_service), t.service_date DESC', updated: 't.updated_at DESC',
};

export async function listTransformations(f: ListFilter, u: Who) {
  const { sql, params } = where(f, u);
  const limit = Math.min(Math.max(f.limit ?? 24, 1), 200);
  const offset = Math.max(f.offset ?? 0, 0);
  const [{ n }] = await db().query<{ n: number }>(`SELECT count(*)::int AS n FROM transformations t LEFT JOIN staff s ON s.id = t.stylist_staff_id LEFT JOIN clients c ON c.id = t.client_id ${sql}`, params);
  const rows = await db().query<Row>(`${BASE} ${sql} ORDER BY ${ORDER[f.sort ?? 'newest'] ?? ORDER.newest} LIMIT ${limit} OFFSET ${offset}`, params);
  const items = await dtos(rows, u);
  return { items, total: n, nextOffset: offset + rows.length < n ? offset + rows.length : null };
}

// ---------------- create / edit ----------------
export interface ExtensionInput { hasExtensions: boolean; method?: string | null; brand?: string | null; length?: string | null; shade?: string | null; quantity?: string | null; workType?: string | null; blending?: boolean | null; customization?: string | null; maintenanceNotes?: string | null; nextAppointment?: string | null }
export interface TransformationInput {
  title?: string; stylistStaffId?: string | null; serviceDate?: string; clientId?: string | null; mainService: string; services?: string[];
  details?: Record<string, string | null>; extension?: ExtensionInput | null; technicalNotes?: string | null; internalNotes?: string | null;
  caption?: string | null; hashtags?: string | null; tags?: string[]; consentStatus?: string; instagramUrl?: string | null;
  /** Confirming one of their finished appointments: date and client come from it. */
  appointmentId?: string | null;
}
const cleanTags = (t: string[] = []) => [...new Set(t.map((x) => x.trim().replace(/^#/, '').toLowerCase()).filter(Boolean))].slice(0, 40);

async function checkStylist(id: string | null | undefined, u: Who): Promise<string> {
  const sid = id || u.id;
  // Stylists record their own work; reassigning to someone else is for people who manage the library.
  if (sid !== u.id && !can(u, 'transformations:manage')) throw forbidden('You can add transformations for your own work. Ask a manager to reassign it.');
  if (!(await db().one('SELECT 1 FROM staff WHERE id = $1', [sid]))) throw badRequest('Choose a stylist.');
  return sid;
}
async function saveServices(q: { query: (s: string, p?: unknown[]) => Promise<unknown> }, id: string, main: string, services: string[] = []) {
  await q.query('DELETE FROM transformation_services WHERE transformation_id = $1', [id]);
  for (const s of [...new Set([main, ...services].map((x) => x.trim()).filter(Boolean))].slice(0, 30)) {
    await q.query('INSERT INTO transformation_services(transformation_id, service) VALUES ($1,$2)', [id, s]);
  }
}
async function saveExtension(q: { query: (s: string, p?: unknown[]) => Promise<unknown> }, id: string, e: ExtensionInput | null | undefined, services: string[]) {
  const needed = services.some(isExtensionService);
  if (!e || (!e.hasExtensions && !needed)) { await q.query('DELETE FROM transformation_extensions WHERE transformation_id = $1', [id]); return; }
  await q.query(`INSERT INTO transformation_extensions(transformation_id, has_extensions, method, brand, length, shade, quantity, work_type, blending, customization, maintenance_notes, next_appointment)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (transformation_id) DO UPDATE SET has_extensions = $2, method = $3, brand = $4, length = $5, shade = $6,
    quantity = $7, work_type = $8, blending = $9, customization = $10, maintenance_notes = $11, next_appointment = $12`,
  [id, e.hasExtensions || needed, e.method ?? null, e.brand ?? null, e.length ?? null, e.shade ?? null, e.quantity ?? null, e.workType ?? null, e.blending ?? null,
    e.customization ?? null, e.maintenanceNotes ?? null, e.nextAppointment ?? null]);
}

export async function createTransformation(b: TransformationInput, u: Who) {
  if (!can(u, 'transformations:own') && !can(u, 'transformations:manage')) throw forbidden('You can’t add transformations.');
  let stylist = await checkStylist(b.stylistStaffId, u);
  if (b.appointmentId) {
    const a = await db().one<{ staff_id: string | null; client_id: string | null; day: string }>(
      "SELECT staff_id, client_id, to_char(start_at, 'YYYY-MM-DD') AS day FROM appointments WHERE id = $1", [b.appointmentId]);
    if (!a || (a.staff_id && a.staff_id !== u.id && !can(u, 'transformations:manage'))) throw forbidden('That appointment isn’t yours.');
    if (await db().one('SELECT 1 FROM transformations WHERE appointment_id = $1', [b.appointmentId])) throw badRequest('This appointment already has a transformation.');
    if (a.staff_id) stylist = a.staff_id;
    b = { ...b, clientId: b.clientId ?? a.client_id, serviceDate: b.serviceDate || a.day };
  }
  // The title is optional: the service names it until someone writes one.
  const title = b.title?.trim() || b.mainService.trim();
  const serviceDate = b.serviceDate || today();
  const status = b.consentStatus ?? 'pending';
  // New work starts as Pending Consent or Internal Use Only; approval is a separate, permissioned step.
  if (status !== 'pending' && status !== 'internal' && status !== 'do_not_publish') throw badRequest('New transformations start as Pending Consent or Internal Use Only. Approve them for social media once consent is verified.');
  if (!socialAdmin(u)) b = { ...b, caption: null, hashtags: null, tags: [] };
  const services = [b.mainService, ...(b.services ?? [])];
  const id = await db().tx(async (q) => {
    const [r] = await q.query<{ id: string }>(`INSERT INTO transformations(title, stylist_staff_id, service_date, client_id, main_service, details, technical_notes, internal_notes, caption, hashtags, tags, created_by_staff_id, appointment_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING id`,
    [title, stylist, serviceDate, b.clientId ?? null, b.mainService.trim(), JSON.stringify(b.details ?? {}), b.technicalNotes ?? null, b.internalNotes ?? null,
      b.caption ?? null, b.hashtags ?? null, cleanTags(b.tags), u.id, b.appointmentId ?? null]);
    await saveServices(q, r.id, b.mainService, b.services);
    await saveExtension(q, r.id, b.extension, services);
    await q.query('INSERT INTO transformation_consent(transformation_id, status) VALUES ($1,$2)', [r.id, status]);
    return r.id;
  });
  if (b.instagramUrl && socialAdmin(u)) await addInstagram(id, b.instagramUrl, true, u);
  return getTransformation(id, u);
}

export async function updateTransformation(id: string, b: Partial<TransformationInput>, u: Who) {
  const { row, a } = await editable(id, u);
  if (b.stylistStaffId !== undefined && b.stylistStaffId !== row.stylist_staff_id) {
    const claiming = row.stylist_staff_id == null && b.stylistStaffId === u.id;
    if (!claiming && !can(u, 'transformations:manage')) throw forbidden('Reassigning a transformation to another stylist is for people who manage the library.');
    b = { ...b, stylistStaffId: claiming ? u.id : await checkStylist(b.stylistStaffId, u) };
  }
  // Technical notes can only be changed by someone who can see them.
  if ((b.technicalNotes !== undefined || b.internalNotes !== undefined) && !a.technical) throw forbidden('You can’t change technical notes on this transformation.');
  const set: string[] = [];
  const p: unknown[] = [id];
  const put = (col: string, v: unknown) => { p.push(v); set.push(`${col} = $${p.length}`); };
  if (b.title !== undefined) put('title', b.title.trim() || b.mainService?.trim() || row.main_service);
  if (b.stylistStaffId !== undefined) put('stylist_staff_id', b.stylistStaffId);
  if (b.serviceDate !== undefined) put('service_date', b.serviceDate);
  if (b.clientId !== undefined) put('client_id', b.clientId);
  if (b.mainService !== undefined) put('main_service', b.mainService.trim());
  if (b.details !== undefined) put('details', JSON.stringify(b.details ?? {}));
  if (b.technicalNotes !== undefined) put('technical_notes', b.technicalNotes);
  if (b.internalNotes !== undefined) put('internal_notes', b.internalNotes);
  if ((b.caption !== undefined || b.hashtags !== undefined || b.tags !== undefined) && !socialAdmin(u)) throw forbidden('Captions, hashtags and tags are for social posts — administrators add them.');
  if (b.caption !== undefined) put('caption', b.caption);
  if (b.hashtags !== undefined) put('hashtags', b.hashtags);
  if (b.tags !== undefined) put('tags', cleanTags(b.tags));
  await db().tx(async (q) => {
    if (set.length) await q.query(`UPDATE transformations SET ${set.join(', ')}, updated_at = now() WHERE id = $1`, p);
    const main = b.mainService ?? row.main_service;
    if (b.services !== undefined || b.mainService !== undefined) {
      const cur = b.services ?? (await q.query<{ service: string }>('SELECT service FROM transformation_services WHERE transformation_id = $1', [id])).map((s) => s.service);
      await saveServices(q, id, main, cur);
    }
    if (b.extension !== undefined) {
      const all = (await q.query<{ service: string }>('SELECT service FROM transformation_services WHERE transformation_id = $1', [id])).map((s) => s.service);
      await saveExtension(q, id, b.extension, all);
    }
  });
  return getTransformation(id, u);
}

// ---------------- to confirm (from finished appointments) ----------------
const CONFIRM_DAYS = 14;
/** A service from the appointment, as one of the library's services when it clearly is one. */
export function matchService(name: string, list: string[]) {
  const n = name.toLowerCase();
  const words = (s: string) => s.toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 3);
  return list.find((s) => s.toLowerCase() === n)
    ?? list.find((s) => words(s).some((w) => n.includes(w)) && s !== 'Other')
    ?? name;
}
/** This stylist's finished appointments in the last two weeks that don't have a transformation yet (and weren't skipped). */
export async function toConfirm(u: Who) {
  if (!can(u, 'transformations:own')) return [];
  const rows = await db().query<any>(`SELECT a.id, to_char(a.start_at, 'YYYY-MM-DD') AS day, a.start_at, a.client_id,
      NULLIF(TRIM(COALESCE(c.first_name,'') || ' ' || LEFT(COALESCE(c.last_name,''), 1)), '') AS client,
      ARRAY(SELECT service_name FROM appointment_services s WHERE s.appointment_id = a.id ORDER BY position) AS services
    FROM appointments a LEFT JOIN clients c ON c.id = a.client_id
    WHERE (a.staff_id = $1 OR a.staff_id IS NULL) AND a.square_status = 'ACCEPTED' AND a.end_at <= now() AND a.end_at > now() - interval '${CONFIRM_DAYS} days'
      AND NOT EXISTS (SELECT 1 FROM transformations t WHERE t.appointment_id = a.id)
      AND NOT EXISTS (SELECT 1 FROM transformation_skips k WHERE k.appointment_id = a.id)
    ORDER BY a.start_at DESC LIMIT 30`, [u.id]);
  const list = await serviceList();
  return rows.map((r) => {
    const services: string[] = [...new Set((r.services as string[]).map((s) => matchService(s, list)))];
    return { appointmentId: r.id as string, date: r.day as string, clientId: r.client_id as string | null, clientName: (r.client as string | null) && `${r.client}.`, services };
  });
}
export async function skipAppointment(id: string, u: Who) {
  const a = await db().one<{ staff_id: string | null }>('SELECT staff_id FROM appointments WHERE id = $1', [id]);
  if (!a || (a.staff_id && a.staff_id !== u.id && !can(u, 'transformations:manage'))) throw notFound('That appointment');
  await db().query('INSERT INTO transformation_skips(appointment_id, staff_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [id, u.id]);
}

export async function deleteTransformation(id: string, u: Who) {
  await editable(id, u);
  const files = await db().query<{ file_path: string; thumb_path: string | null }>('SELECT file_path, thumb_path FROM transformation_media WHERE transformation_id = $1', [id]);
  await db().query('DELETE FROM transformations WHERE id = $1', [id]);
  for (const f of files) { await removeIfUnused(f.file_path); await removeFile(f.thumb_path); }
}

// ---------------- consent ----------------
export interface ConsentInput {
  status?: string; clientConsent?: 'unknown' | 'requested' | 'given' | 'declined'; socialPermission?: boolean; marketingPermission?: boolean; scope?: string | null;
  consentDate?: string | null; identifiable?: boolean | null; restrictions?: string | null; expiresOn?: string | null; verified?: boolean;
}
export async function updateConsent(id: string, b: ConsentInput, u: Who) {
  const { a } = await visible(id, u);
  const approver = can(u, 'transformations:consent');
  if (!a.edit && !approver) throw forbidden('You can’t change consent on this transformation.');
  const cur = await db().one<any>('SELECT * FROM transformation_consent WHERE transformation_id = $1', [id]) ?? { status: 'pending' };
  if (b.verified !== undefined && !approver) throw forbidden('Only people allowed to approve consent can mark it as verified.');
  // Stylists can hold work back (Pending, Internal Use Only, Do Not Publish); approving it for social media is permissioned.
  if (b.status === 'approved_social' && !approver) throw forbidden('Only people allowed to approve consent can approve a transformation for social media.');
  if (cur.status === 'approved_social' && b.status && b.status !== 'approved_social' && !approver && b.status !== 'do_not_publish') throw forbidden('Ask someone who approves consent to change an approved transformation.');
  const next = {
    status: b.status ?? cur.status, client_consent: b.clientConsent ?? cur.client_consent ?? 'unknown',
    social_permission: b.socialPermission ?? cur.social_permission ?? false, marketing_permission: b.marketingPermission ?? cur.marketing_permission ?? false,
    scope: b.scope !== undefined ? b.scope : cur.scope ?? null, consent_date: b.consentDate !== undefined ? b.consentDate : day(cur.consent_date),
    identifiable: b.identifiable !== undefined ? b.identifiable : cur.identifiable ?? null, restrictions: b.restrictions !== undefined ? b.restrictions : cur.restrictions ?? null,
    expires_on: b.expiresOn !== undefined ? b.expiresOn : day(cur.expires_on),
    verified_by_staff_id: cur.verified_by_staff_id ?? null, verified_at: cur.verified_at ?? null,
  };
  const termsChanged = (['client_consent', 'social_permission', 'marketing_permission', 'scope', 'consent_date', 'expires_on', 'restrictions'] as const)
    .some((k) => String(next[k] ?? '') !== String((k === 'consent_date' || k === 'expires_on' ? day(cur[k]) : cur[k]) ?? ''));
  if (b.verified === true) { next.verified_by_staff_id = u.id; next.verified_at = new Date().toISOString(); }
  // Verification is of particular terms: changed terms (or "not verified") need verifying again.
  if (b.verified === false || (termsChanged && b.verified !== true)) { next.verified_by_staff_id = null; next.verified_at = null; }
  if (next.client_consent === 'declined' || next.client_consent === 'unknown' || next.client_consent === 'requested' || !next.social_permission) {
    if (next.status === 'approved_social') {
      if (b.status === 'approved_social') throw badRequest('Record the client’s consent (given) and permission for social media before approving it.');
      next.status = 'pending';
    }
  }
  if (next.status === 'approved_social' && !next.verified_at) {
    if (b.status === 'approved_social') throw badRequest('Mark the client’s consent as verified to approve it for social media.');
    next.status = 'pending';
  }
  if (next.client_consent === 'declined' && next.status === 'pending') next.status = 'do_not_publish';
  await db().query(`INSERT INTO transformation_consent(transformation_id, status, client_consent, social_permission, marketing_permission, scope, consent_date, identifiable, restrictions, expires_on, verified_by_staff_id, verified_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) ON CONFLICT (transformation_id) DO UPDATE SET status = $2, client_consent = $3, social_permission = $4, marketing_permission = $5,
    scope = $6, consent_date = $7, identifiable = $8, restrictions = $9, expires_on = $10, verified_by_staff_id = $11, verified_at = $12`,
  [id, next.status, next.client_consent, next.social_permission, next.marketing_permission, next.scope, next.consent_date, next.identifiable, next.restrictions, next.expires_on, next.verified_by_staff_id, next.verified_at]);
  await touch(id);
  return getTransformation(id, u);
}

// ---------------- photos ----------------
async function removeIfUnused(rel: string) {
  if (!(await db().one('SELECT 1 FROM transformation_media WHERE file_path = $1', [rel]))) await removeFile(rel);
}
/** Moves a received upload into storage, named by its content (the same file twice is stored once; never overwritten). */
async function storeOriginal(up: Upload) {
  try {
    if (!up.size) throw badRequest('The file is empty.');
    const kind = sniffMedia(up.head);
    if (!kind) throw badRequest('That file isn’t a photo or video the library accepts (JPEG, PNG, WebP, HEIC, MP4, MOV or WebM).');
    if (!kind.video && up.size > MAX_PHOTO_BYTES) throw badRequest(`Photos can be up to ${MAX_PHOTO_BYTES / 1024 / 1024} MB.`);
    const rel = `originals/${up.sha.slice(0, 2)}/${up.sha}.${kind.ext}`;
    const dest = abs(rel);
    await fs.promises.mkdir(path.dirname(dest), { recursive: true });
    if (fs.existsSync(dest)) await dropUpload(up); else await fs.promises.rename(up.tmp, dest);
    return { rel, sha: up.sha, size: up.size, ...kind };
  } catch (e) {
    await dropUpload(up);
    throw e;
  }
}
const KINDS = ['before', 'after', 'finished', 'detail', 'other'];

/** Adds a photo or video. `receive` reads the upload — only after the permission check, so nothing is stored for refusals. */
export async function addPhoto(id: string, receive: () => Promise<Upload>, meta: { kind?: string; caption?: string | null; name?: string | null }, u: Who) {
  await editable(id, u);
  const kind = KINDS.includes(meta.kind ?? '') ? meta.kind! : 'after';
  const up = await receive();
  // The same file selected twice for one transformation is kept once.
  const dupe = await db().one<{ id: string }>('SELECT id FROM transformation_media WHERE transformation_id = $1 AND sha256 = $2', [id, up.sha]);
  if (dupe) { await dropUpload(up); return { photoId: dupe.id, duplicate: true, transformation: await getTransformation(id, u) }; }
  const f = await storeOriginal(up);
  const [{ pos }] = await db().query<{ pos: number }>('SELECT COALESCE(MAX(position), -1) + 1 AS pos FROM transformation_media WHERE transformation_id = $1', [id]);
  const [r] = await db().query<{ id: string }>(`INSERT INTO transformation_media(transformation_id, kind, caption, position, file_path, mime, size, sha256, original_name, uploaded_by_staff_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`, [id, kind, meta.caption ?? null, pos, f.rel, f.mime, f.size, f.sha, meta.name?.slice(0, 200) ?? null, u.id]);
  await touch(id);
  return { photoId: r.id, duplicate: false, transformation: await getTransformation(id, u) };
}

async function photoRow(mid: string) {
  if (!/^[0-9a-f-]{36}$/i.test(mid)) throw notFound('That photo');
  const m = await db().one<any>('SELECT * FROM transformation_media WHERE id = $1', [mid]);
  if (!m) throw notFound('That photo');
  return m;
}
async function editablePhoto(mid: string, u: Who) {
  const m = await photoRow(mid);
  await editable(m.transformation_id, u);
  return m;
}

/** A browser-made thumbnail for the gallery (the original is never touched). */
export async function setThumbnail(mid: string, bytes: Buffer, u: Who) {
  const m = await editablePhoto(mid, u);
  if (bytes.length > MAX_THUMB_BYTES) throw badRequest('Thumbnail too large.');
  const k = sniffImage(bytes);
  if (!k || !['image/jpeg', 'image/webp', 'image/png'].includes(k.mime)) throw badRequest('Thumbnails must be JPEG, PNG or WebP.');
  const rel = `thumbs/${mid}-${crypto.randomBytes(4).toString('hex')}.${k.ext}`;
  await writeFileOnce(rel, bytes);
  await db().query('UPDATE transformation_media SET thumb_path = $2 WHERE id = $1', [mid, rel]);
  await removeFile(m.thumb_path);
  return { ok: true };
}

export async function replacePhoto(mid: string, receive: () => Promise<Upload>, name: string | null, u: Who) {
  const m = await editablePhoto(mid, u);
  const f = await storeOriginal(await receive());
  await db().query('UPDATE transformation_media SET file_path = $2, thumb_path = NULL, mime = $3, size = $4, sha256 = $5, original_name = $6, uploaded_by_staff_id = $7, uploaded_at = now() WHERE id = $1',
    [mid, f.rel, f.mime, f.size, f.sha, name?.slice(0, 200) ?? null, u.id]);
  if (m.file_path !== f.rel) await removeIfUnused(m.file_path);
  await removeFile(m.thumb_path);
  await touch(m.transformation_id);
  return getTransformation(m.transformation_id, u);
}

export async function updatePhoto(mid: string, b: { kind?: string; caption?: string | null }, u: Who) {
  const m = await editablePhoto(mid, u);
  if (b.kind !== undefined) {
    if (!KINDS.includes(b.kind)) throw badRequest('Unknown photo type.');
    await db().query('UPDATE transformation_media SET kind = $2 WHERE id = $1', [mid, b.kind]);
  }
  if (b.caption !== undefined) await db().query('UPDATE transformation_media SET caption = $2 WHERE id = $1', [mid, b.caption]);
  await touch(m.transformation_id);
  return getTransformation(m.transformation_id, u);
}

export async function removePhoto(mid: string, u: Who) {
  const m = await editablePhoto(mid, u);
  await db().query('DELETE FROM transformation_media WHERE id = $1', [mid]);
  await removeIfUnused(m.file_path);
  await removeFile(m.thumb_path);
  await touch(m.transformation_id);
  return getTransformation(m.transformation_id, u);
}

export async function reorderPhotos(id: string, ids: string[], u: Who) {
  await editable(id, u);
  await db().tx(async (q) => {
    for (const [i, mid] of ids.entries()) await q.query('UPDATE transformation_media SET position = $3 WHERE id = $1 AND transformation_id = $2', [mid, id, i]);
  });
  await touch(id);
  return getTransformation(id, u);
}

/** A photo file to send: thumbnails to anyone who can see the record; originals only with download access. */
export async function photoFile(mid: string, which: 'thumb' | 'original', u: Who) {
  const m = await photoRow(mid);
  const { row, a } = await visible(m.transformation_id, u);
  if (which === 'original' && !a.download) throw forbidden('You don’t have permission to download this photo.');
  // Without a thumbnail (e.g. HEIC the browser couldn't draw), the gallery gets the original — only for viewers who may download it.
  const isVideo = String(m.mime).startsWith('video/');
  const rel = which === 'thumb' && m.thumb_path ? m.thumb_path : which === 'thumb' && (!a.download || isVideo) ? null : m.file_path;
  if (!rel) return null;
  const mime = rel === m.file_path ? m.mime : rel.endsWith('.webp') ? 'image/webp' : rel.endsWith('.png') ? 'image/png' : 'image/jpeg';
  const p = abs(rel);
  if (!fs.existsSync(p)) return null;
  return { path: p, mime, name: `${photoName(row, m)}.${path.extname(m.file_path).slice(1)}` };
}
const safe = (s: string, max = 60) => (s.normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9 _-]+/g, ' ').trim().replace(/\s+/g, '_').slice(0, max) || 'Untitled');
const KIND_LABEL: Record<string, string> = { before: 'Before', after: 'After', finished: 'Finished', detail: 'Detail', other: 'Photo' };
const photoName = (t: Pick<Row, 'number' | 'title'>, m: { kind: string; position: number }) => `${code(t.number)}_${safe(t.title, 40)}_${KIND_LABEL[m.kind] ?? 'Photo'}_${String(m.position + 1).padStart(2, '0')}`;

// ---------------- Instagram ----------------
/** A post or Reel address, tidied: https://www.instagram.com/p/<code>/ or /reel/<code>/. */
export function parseInstagramUrl(raw: string) {
  let u: URL;
  try { u = new URL(raw.trim()); } catch { return null; }
  if (!/^(www\.)?instagram\.com$/i.test(u.hostname) || u.protocol !== 'https:' && u.protocol !== 'http:') return null;
  const m = /^\/(?:[A-Za-z0-9._]+\/)?(p|reel|reels|tv)\/([A-Za-z0-9_-]+)\/?/.exec(u.pathname);
  if (!m) return null;
  const kind = m[1] === 'p' ? 'p' : m[1] === 'tv' ? 'tv' : 'reel';
  return { url: `https://www.instagram.com/${kind}/${m[2]}/`, postType: (kind === 'p' ? 'post' : kind === 'reel' ? 'reel' : 'other') as 'post' | 'reel' | 'other' };
}

type OembedFetch = (url: string) => Promise<{ status: number; json: any }>;
let oembedFetch: OembedFetch = async (url) => {
  const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};
/** Tests replace the network call. */
export const setOembedFetch = (f: OembedFetch | null) => { oembedFetch = f ?? oembedFetch; };

/**
 * Meta's supported oEmbed endpoint (instagram_oembed, an app access token; the app needs "oEmbed Read"). Only the
 * returned metadata is kept — no Instagram image or video is downloaded or copied. Without the Meta app, or if the
 * post is private, deleted or unavailable, the record shows a link card instead.
 */
export async function instagramPreview(url: string): Promise<{ status: 'ok' | 'unavailable' | 'no_access'; title: string | null; author: string | null; thumbnailUrl: string | null }> {
  const c = config();
  const empty = { title: null, author: null, thumbnailUrl: null };
  if (!c.META_APP_ID || !c.META_APP_SECRET) return { status: 'no_access', ...empty };
  try {
    const q = new URLSearchParams({ url, access_token: `${c.META_APP_ID}|${c.META_APP_SECRET}`, omitscript: 'true', fields: 'thumbnail_url,author_name,title' });
    const r = await oembedFetch(`https://graph.facebook.com/v21.0/instagram_oembed?${q}`);
    if (r.status >= 400 || r.json?.error) {
      // 190/10/200: the app token or the oEmbed permission isn't set up; anything else: the post isn't available.
      const codeN = r.json?.error?.code;
      return { status: codeN === 190 || codeN === 10 || codeN === 200 ? 'no_access' : 'unavailable', ...empty };
    }
    const thumb = typeof r.json.thumbnail_url === 'string' && /^https:\/\//.test(r.json.thumbnail_url) ? r.json.thumbnail_url : null;
    return { status: 'ok', title: typeof r.json.title === 'string' ? r.json.title.slice(0, 500) : null, author: typeof r.json.author_name === 'string' ? r.json.author_name.slice(0, 100) : null, thumbnailUrl: thumb };
  } catch {
    return { status: 'unavailable', ...empty };
  }
}

export async function addInstagram(id: string, rawUrl: string, primary: boolean, u: Who) {
  if (!socialAdmin(u)) throw forbidden('Instagram links are for social posts — administrators add them.');
  await editable(id, u);
  const p = parseInstagramUrl(rawUrl);
  if (!p) throw badRequest('Paste the link to an Instagram post or Reel (instagram.com/p/… or instagram.com/reel/…).');
  if (await db().one('SELECT 1 FROM transformation_instagram WHERE transformation_id = $1 AND url = $2', [id, p.url])) throw badRequest('That Instagram link is already on this transformation.');
  const pv = await instagramPreview(p.url);
  if (primary) await db().query('UPDATE transformation_instagram SET is_primary = false WHERE transformation_id = $1', [id]);
  await db().query(`INSERT INTO transformation_instagram(transformation_id, url, post_type, title, author, thumbnail_url, preview_status, is_primary, added_by_staff_id, checked_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())`, [id, p.url, p.postType, pv.title, pv.author, pv.thumbnailUrl, pv.status, primary, u.id]);
  await touch(id);
  return getTransformation(id, u);
}
async function igRow(iid: string, u: Who) {
  if (!/^[0-9a-f-]{36}$/i.test(iid)) throw notFound('That link');
  const i = await db().one<any>('SELECT * FROM transformation_instagram WHERE id = $1', [iid]);
  if (!i) throw notFound('That link');
  await editable(i.transformation_id, u);
  if (!socialAdmin(u)) throw forbidden('Instagram links are for social posts — administrators manage them.');
  return i;
}
export async function refreshInstagram(iid: string, u: Who) {
  const i = await igRow(iid, u);
  const pv = await instagramPreview(i.url);
  await db().query('UPDATE transformation_instagram SET title = $2, author = $3, thumbnail_url = $4, preview_status = $5, checked_at = now() WHERE id = $1', [iid, pv.title, pv.author, pv.thumbnailUrl, pv.status]);
  return getTransformation(i.transformation_id, u);
}
export async function setInstagramPrimary(iid: string, primary: boolean, u: Who) {
  const i = await igRow(iid, u);
  if (primary) await db().query('UPDATE transformation_instagram SET is_primary = false WHERE transformation_id = $1', [i.transformation_id]);
  await db().query('UPDATE transformation_instagram SET is_primary = $2 WHERE id = $1', [iid, primary]);
  return getTransformation(i.transformation_id, u);
}
export async function removeInstagram(iid: string, u: Who) {
  const i = await igRow(iid, u);
  await db().query('DELETE FROM transformation_instagram WHERE id = $1', [iid]);
  await touch(i.transformation_id);
  return getTransformation(i.transformation_id, u);
}

// ---------------- collections & options ----------------
export async function collections() {
  return db().query<{ id: string; name: string; count: number }>(`SELECT c.id, c.name, count(i.transformation_id)::int AS count FROM transformation_collections c
    LEFT JOIN transformation_collection_items i ON i.collection_id = c.id GROUP BY c.id ORDER BY lower(c.name)`);
}
export async function createCollection(name: string) {
  const n = name.trim();
  if (!n) throw badRequest('Name the collection.');
  if (await db().one('SELECT 1 FROM transformation_collections WHERE lower(name) = lower($1)', [n])) throw badRequest('A collection with that name already exists.');
  await db().query('INSERT INTO transformation_collections(name) VALUES ($1)', [n]);
  return collections();
}
export async function deleteCollection(cid: string) {
  await db().query('DELETE FROM transformation_collections WHERE id = $1', [cid]);
  return collections();
}
export async function setCollectionItems(cid: string, ids: string[], remove: boolean) {
  if (!(await db().one('SELECT 1 FROM transformation_collections WHERE id = $1', [cid]))) throw notFound('That collection');
  for (const id of ids) {
    if (remove) await db().query('DELETE FROM transformation_collection_items WHERE collection_id = $1 AND transformation_id = $2', [cid, id]);
    else await db().query('INSERT INTO transformation_collection_items(collection_id, transformation_id) SELECT $1, id FROM transformations WHERE id = $2 ON CONFLICT DO NOTHING', [cid, id]);
  }
  return collections();
}

export async function options(u: Who) {
  const [services, catalog, stylists, tags, methods] = await Promise.all([
    serviceList(),
    db().query<{ name: string }>('SELECT DISTINCT name FROM services ORDER BY name LIMIT 400').catch(() => []),
    db().query<{ id: string; name: string }>(seesAll(u) || can(u, 'transformations:manage')
      ? 'SELECT id, name FROM staff WHERE active ORDER BY lower(name)' : 'SELECT id, name FROM staff WHERE id = $1', seesAll(u) || can(u, 'transformations:manage') ? [] : [u.id]),
    db().query<{ tag: string }>('SELECT DISTINCT unnest(tags) AS tag FROM transformations ORDER BY 1 LIMIT 300'),
    db().query<{ method: string }>("SELECT DISTINCT method FROM transformation_extensions WHERE method IS NOT NULL AND method <> '' ORDER BY 1"),
  ]);
  return {
    services, catalog: catalog.map((c) => c.name), stylists, tags: tags.map((t) => t.tag), methods: methods.map((m) => m.method), collections: await collections(),
    can: {
      create: can(u, 'transformations:own') || can(u, 'transformations:manage'), viewAll: seesAll(u), manage: can(u, 'transformations:manage'),
      consent: can(u, 'transformations:consent'), download: can(u, 'transformations:download'), bulk: can(u, 'transformations:bulk'), technical: can(u, 'transformations:technical'),
    },
  };
}

// ---------------- details file / manifest ----------------
const csvCell = (v: unknown) => {
  const s = v == null ? '' : String(v);
  // A leading = + - @ would run as a formula in a spreadsheet.
  const t = /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
  return /[",\n\r]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
};
const csv = (rows: unknown[][]) => rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
const MANIFEST_HEAD = ['Transformation ID', 'Title', 'Stylist', 'Service date', 'Main service', 'Services', 'Extensions', 'Extension method', 'Extension length', 'Extension shade',
  'Techniques', 'Products', 'Styling', 'Caption', 'Hashtags', 'Tags', 'Publication status', 'Client consent', 'Social media permission', 'Marketing permission', 'Consent expires',
  'Photo files', 'Instagram links'];
function manifestRow(t: TransformationDTO, files: string[], technical: boolean) {
  const e = t.extension;
  const row: unknown[] = [t.code, t.title, t.stylistName, t.serviceDate, t.mainService, t.services.join('; '), e?.hasExtensions ? 'Yes' : 'No', e?.method, e?.length, e?.shade,
    t.details.techniques, t.details.products, t.details.styling, t.caption, t.hashtags, t.tags.join(' '), t.consent.status, t.consent.clientConsent,
    t.consent.socialPermission ? 'Yes' : 'No', t.consent.marketingPermission ? 'Yes' : 'No', t.consent.expiresOn, files.join('; '), t.instagram.map((i) => i.url).join(' ')];
  // Technical notes only when asked for and allowed; client names are never included.
  if (technical) row.push(t.technicalNotes, t.internalNotes);
  return row;
}
export async function detailsCsv(id: string, u: Who, technical = false) {
  const t = await getTransformation(id, u);
  if (!t.canDownload) throw forbidden('You don’t have permission to download this transformation.');
  const tech = technical && t.canSeeTechnical;
  return { name: `${t.code}_${safe(t.title, 40)}_details.csv`, body: csv([[...MANIFEST_HEAD, ...(tech ? ['Technical notes', 'Internal notes'] : [])], manifestRow(t, t.photos.map((p) => photoName(t, p)), tech)]) };
}

// ---------------- ZIP writer (stored, no compression: photos are already compressed) ----------------
const dosTime = (d: Date) => ({
  time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
  date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
});
export class ZipWriter {
  private entries: { name: Buffer; crc: number; size: number; offset: number }[] = [];
  private offset = 0;
  private fd: fs.promises.FileHandle | null = null;
  private when = dosTime(new Date());
  constructor(private file: string) {}
  async open() { await fs.promises.mkdir(path.dirname(this.file), { recursive: true }); this.fd = await fs.promises.open(this.file, 'w'); }
  private async write(b: Buffer) { await this.fd!.write(b); this.offset += b.length; }
  /** Adds a file from disk, read twice in chunks (checksum, then copy) so large videos never sit in memory. */
  async addFile(name: string, file: string) {
    const size = (await fs.promises.stat(file)).size;
    if (this.offset + size > 0xfffffff0) throw new Error('ZIP_TOO_LARGE');
    let crc = 0;
    for await (const c of fs.createReadStream(file)) crc = zlib.crc32(c as Buffer, crc);
    const n = Buffer.from(name, 'utf8');
    await this.write(this.header(n, crc >>> 0, size));
    for await (const c of fs.createReadStream(file)) await this.write(c as Buffer);
  }
  private header(n: Buffer, crc: number, size: number) {
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt16LE(0, 8);
    h.writeUInt16LE(this.when.time, 10); h.writeUInt16LE(this.when.date, 12); h.writeUInt32LE(crc, 14); h.writeUInt32LE(size, 18); h.writeUInt32LE(size, 22);
    h.writeUInt16LE(n.length, 26); h.writeUInt16LE(0, 28);
    this.entries.push({ name: n, crc, size, offset: this.offset });
    return Buffer.concat([h, n]);
  }
  async add(name: string, data: Buffer) {
    if (this.offset + data.length > 0xfffffff0) throw new Error('ZIP_TOO_LARGE');
    const n = Buffer.from(name, 'utf8');
    const crc = zlib.crc32(data) >>> 0;
    const h = Buffer.alloc(30);
    h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt16LE(0, 8);
    h.writeUInt16LE(this.when.time, 10); h.writeUInt16LE(this.when.date, 12); h.writeUInt32LE(crc, 14); h.writeUInt32LE(data.length, 18); h.writeUInt32LE(data.length, 22);
    h.writeUInt16LE(n.length, 26); h.writeUInt16LE(0, 28);
    this.entries.push({ name: n, crc, size: data.length, offset: this.offset });
    await this.write(h); await this.write(n); await this.write(data);
  }
  async close() {
    const start = this.offset;
    for (const e of this.entries) {
      const c = Buffer.alloc(46);
      c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(0, 10);
      c.writeUInt16LE(this.when.time, 12); c.writeUInt16LE(this.when.date, 14); c.writeUInt32LE(e.crc, 16); c.writeUInt32LE(e.size, 20); c.writeUInt32LE(e.size, 24);
      c.writeUInt16LE(e.name.length, 28); c.writeUInt32LE(e.offset, 42);
      await this.write(c); await this.write(e.name);
    }
    const end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(this.entries.length, 8); end.writeUInt16LE(this.entries.length, 10);
    end.writeUInt32LE(this.offset - start, 12); end.writeUInt32LE(start, 16);
    await this.write(end);
    await this.fd!.close();
    return this.offset;
  }
  async abort() { await this.fd?.close().catch(() => {}); await fs.promises.unlink(this.file).catch(() => {}); }
}

// ---------------- export jobs ----------------
export interface ExportRequest {
  preset: 'selected' | 'filter' | 'social' | 'one';
  ids?: string[]; photoIds?: string[]; filter?: ListFilter; includeTechnical?: boolean; approvedOnly?: boolean; groupBy?: 'service' | 'collection';
}
interface ExportFailure { transformation: string; file: string; reason: string }

/** Starts a ZIP export in the background and returns its id; progress is read with exportStatus. */
export async function startExport(req: ExportRequest, u: Who) {
  const single = req.preset === 'one';
  if (single && (req.ids?.length !== 1)) throw badRequest('Choose one transformation.');
  if (!single && !can(u, 'transformations:bulk')) {
    // Without bulk download: still allowed to ZIP the photos of one transformation they can download.
    const ids = new Set([...(req.ids ?? [])]);
    if (req.preset !== 'selected' || ids.size !== 1 || req.photoIds?.length) throw forbidden('Downloading more than one transformation at once needs the “Bulk download transformations” permission.');
  }
  const running = await db().one<{ n: number }>("SELECT count(*)::int AS n FROM transformation_exports WHERE requested_by_staff_id = $1 AND status IN ('queued','running')", [u.id]);
  if ((running?.n ?? 0) >= 2) throw badRequest('Two downloads are already being prepared. Wait for them to finish.');
  const token = crypto.randomBytes(24).toString('base64url');
  const [r] = await db().query<{ id: string }>('INSERT INTO transformation_exports(requested_by_staff_id, preset, filter, token) VALUES ($1,$2,$3,$4) RETURNING id',
    [u.id, req.preset, JSON.stringify(req), token]);
  const job = runExport(r.id, req, u).catch(async (e) => {
    await db().query("UPDATE transformation_exports SET status = 'failed', error = $2, finished_at = now() WHERE id = $1", [r.id, e?.message === 'ZIP_TOO_LARGE' ? 'This download is over 4 GB. Narrow the filter (e.g. one stylist or a date range) and try again.' : String(e?.message ?? e).slice(0, 300)]);
  });
  exportJobs.set(r.id, job);
  void job.finally(() => exportJobs.delete(r.id));
  return r.id;
}
/** Running jobs (tests wait on them). */
export const exportJobs = new Map<string, Promise<unknown>>();

async function exportRecords(req: ExportRequest, u: Who) {
  const social = req.preset === 'social';
  const approvedOnly = social || !!req.approvedOnly;
  const ids = req.ids?.length ? req.ids : undefined;
  const photoIds = req.photoIds?.length ? new Set(req.photoIds) : null;
  let items: TransformationDTO[] = [];
  if (photoIds) {
    const owners = await db().query<{ transformation_id: string }>('SELECT DISTINCT transformation_id FROM transformation_media WHERE id = ANY($1)', [[...photoIds]]);
    const set = new Set([...(ids ?? []), ...owners.map((o) => o.transformation_id)]);
    items = (await listTransformations({ ids: [...set], limit: 200 }, u)).items;
  } else {
    const f: ListFilter = { ...(req.preset === 'filter' || social ? req.filter ?? {} : {}), ids: req.preset === 'selected' || req.preset === 'one' ? ids ?? ['00000000-0000-0000-0000-000000000000'] : undefined, ready: approvedOnly || undefined };
    for (let offset: number | null = 0; offset !== null && items.length < 5000;) {
      const page = await listTransformations({ ...f, limit: 200, offset }, u);
      items.push(...page.items);
      offset = page.nextOffset;
    }
  }
  const skipped: ExportFailure[] = [];
  const out = items.filter((t) => {
    if (!t.canDownload) { skipped.push({ transformation: t.code, file: '(all)', reason: 'No download permission for this transformation' }); return false; }
    if (approvedOnly && !t.readyForSocial) { skipped.push({ transformation: t.code, file: '(all)', reason: 'Not approved for social media' }); return false; }
    return true;
  });
  return { items: out, skipped, photoIds, approvedOnly };
}

async function runExport(id: string, req: ExportRequest, u: Who) {
  const { items, skipped, photoIds } = await exportRecords(req, u);
  const photos = items.flatMap((t) => t.photos.filter((p) => !photoIds || photoIds.has(p.id)).map((p) => ({ t, p })));
  await db().query("UPDATE transformation_exports SET status = 'running', total = $2, failed = $3 WHERE id = $1", [id, photos.length, JSON.stringify(skipped)]);
  const failed: ExportFailure[] = [...skipped];
  const rel = `exports/${id}.zip`;
  const zip = new ZipWriter(abs(rel));
  await zip.open();
  try {
    const root = 'Addendum_Salon_Transformations';
    const tech = !!req.includeTechnical;
    const manifest: unknown[][] = [];
    const json: unknown[] = [];
    const used = new Set<string>();
    let done = 0;
    for (const t of items) {
      const group = req.groupBy === 'collection' && t.collections.length ? t.collections[0].name : t.mainService;
      const folder = `${root}/${safe(t.stylistName ?? 'Unassigned')}/${safe(group)}/${t.code}_${safe(t.title, 40)}`;
      const files: string[] = [];
      const counts: Record<string, number> = {};
      const kinds = t.photos.reduce<Record<string, number>>((m, p) => ({ ...m, [p.kind]: (m[p.kind] ?? 0) + 1 }), {});
      for (const p of t.photos.filter((x) => !photoIds || photoIds.has(x.id))) {
        counts[p.kind] = (counts[p.kind] ?? 0) + 1;
        const label = KIND_LABEL[p.kind] ?? 'Photo';
        const m = await db().one<{ file_path: string }>('SELECT file_path FROM transformation_media WHERE id = $1', [p.id]);
        const ext = m ? path.extname(m.file_path) : '.jpg';
        // Before.jpg, After.jpg; numbered when there are several (Detail_01.jpg, Detail_02.jpg).
        let name = `${folder}/${kinds[p.kind] > 1 || p.kind === 'detail' ? `${label}_${String(counts[p.kind]).padStart(2, '0')}` : label}${ext}`;
        for (let i = 2; used.has(name); i++) name = name.replace(/(\.[a-z]+)$/, `_${i}$1`);
        try {
          if (!m) throw new Error('Photo was removed');
          if (!fs.existsSync(abs(m.file_path))) throw new Error('File is missing from storage');
          await zip.addFile(name, abs(m.file_path));
          used.add(name);
          files.push(name.slice(folder.length + 1));
        } catch (e: any) {
          if (e?.message === 'ZIP_TOO_LARGE') throw e;
          failed.push({ transformation: t.code, file: name.slice(folder.length + 1), reason: e?.message ?? 'Could not be read' });
        }
        done++;
        if (done % 5 === 0 || done === photos.length) await db().query('UPDATE transformation_exports SET done = $2, failed = $3 WHERE id = $1', [id, done, JSON.stringify(failed)]);
      }
      const allowTech = tech && t.canSeeTechnical;
      const head = [...MANIFEST_HEAD, ...(tech ? ['Technical notes', 'Internal notes'] : [])];
      const row = manifestRow(t, files, allowTech);
      if (tech && !allowTech) row.push('', '');
      await zip.add(`${folder}/transformation_details.csv`, Buffer.from(csv([head, row]), 'utf8'));
      manifest.push(row);
      json.push({
        id: t.code, title: t.title, stylist: t.stylistName, serviceDate: t.serviceDate, mainService: t.mainService, services: t.services, extension: t.extension,
        caption: t.caption, hashtags: t.hashtags, tags: t.tags, consent: { status: t.consent.status, clientConsent: t.consent.clientConsent, socialPermission: t.consent.socialPermission, marketingPermission: t.consent.marketingPermission, expiresOn: t.consent.expiresOn },
        photos: files, instagram: t.instagram.map((i) => ({ url: i.url, type: i.postType, note: 'External Instagram content (not included as a file)' })),
        ...(allowTech ? { technicalNotes: t.technicalNotes, internalNotes: t.internalNotes } : {}),
      });
    }
    await zip.add(`${root}/manifest.csv`, Buffer.from(csv([[...MANIFEST_HEAD, ...(tech ? ['Technical notes', 'Internal notes'] : [])], ...manifest]), 'utf8'));
    await zip.add(`${root}/manifest.json`, Buffer.from(JSON.stringify({ exportedAt: new Date().toISOString(), preset: req.preset, transformations: json, notIncluded: failed }, null, 2), 'utf8'));
    const size = await zip.close();
    await db().query(`UPDATE transformation_exports SET status = 'done', done = $2, failed = $3, file_path = $4, size = $5, expires_at = now() + interval '${EXPORT_HOURS} hours', finished_at = now() WHERE id = $1`,
      [id, photos.length, JSON.stringify(failed), rel, size]);
  } catch (e) {
    await zip.abort();
    throw e;
  }
}

export async function exportStatus(id: string, u: Who) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound('That download');
  const r = await db().one<any>('SELECT * FROM transformation_exports WHERE id = $1 AND requested_by_staff_id = $2', [id, u.id]);
  if (!r) throw notFound('That download');
  const expired = r.expires_at && new Date(r.expires_at) < new Date();
  return {
    id: r.id, status: expired ? 'expired' : r.status, total: r.total, done: r.done, failed: r.failed as ExportFailure[], size: r.size == null ? null : Number(r.size), error: r.error,
    expiresAt: iso(r.expires_at), downloadUrl: r.status === 'done' && !expired ? `/api/transformations/exports/${r.id}/download?token=${r.token}` : null,
  };
}
/** The finished ZIP: only for the person who asked for it, with the link's token, before it expires, while they still have access. */
export async function exportFile(id: string, token: string, u: Who) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound('That download');
  const r = await db().one<any>("SELECT * FROM transformation_exports WHERE id = $1 AND requested_by_staff_id = $2 AND status = 'done'", [id, u.id]);
  const ok = r && typeof token === 'string' && token.length === r.token.length && crypto.timingSafeEqual(Buffer.from(token), Buffer.from(r.token));
  if (!ok) throw notFound('That download');
  if (new Date(r.expires_at) < new Date()) throw badRequest('This download link has expired. Prepare the download again.');
  const req = r.filter as ExportRequest;
  if (req.preset !== 'one' && !(req.preset === 'selected' && req.ids?.length === 1) && !can(u, 'transformations:bulk')) throw forbidden('You no longer have permission for bulk downloads.');
  if (!can(u, 'transformations:download') && !can(u, 'transformations:own')) throw forbidden('You no longer have permission to download transformations.');
  const p = abs(r.file_path);
  if (!fs.existsSync(p)) throw badRequest('This download is no longer available. Prepare it again.');
  const stamp = new Date(r.created_at).toISOString().slice(0, 10);
  return { path: p, name: `Addendum_Salon_Transformations_${stamp}.zip` };
}

/** Scheduler: removes expired ZIPs, and marks downloads that were interrupted by a restart as failed. */
export async function cleanupExports() {
  const old = await db().query<{ id: string; file_path: string | null }>("SELECT id, file_path FROM transformation_exports WHERE expires_at < now() - interval '1 hour' AND file_path IS NOT NULL");
  for (const o of old) { await removeFile(o.file_path); await db().query('UPDATE transformation_exports SET file_path = NULL WHERE id = $1', [o.id]); }
  const stuck = await db().query<{ id: string }>("SELECT id FROM transformation_exports WHERE status IN ('queued','running') AND created_at < now() - interval '2 hours'");
  for (const s of stuck) if (!exportJobs.has(s.id)) await db().query("UPDATE transformation_exports SET status = 'failed', error = 'The download was interrupted. Please try again.', finished_at = now() WHERE id = $1", [s.id]);
}
