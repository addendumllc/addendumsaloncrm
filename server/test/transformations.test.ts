import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import request from 'supertest';
import { db } from '../src/db/index.js';
import { exportJobs, setOembedFetch } from '../src/domain/transformations.js';
import { setup } from './helpers.js';

const MEDIA = fs.mkdtempSync(path.join(os.tmpdir(), 'tf-media-'));
process.env.MEDIA_DIR = MEDIA;
let api: Awaited<ReturnType<typeof setup>>['api'];
let app: Awaited<ReturnType<typeof setup>>['app'];
const H = { 'X-Requested-With': 'addendum-crm' };
const jpeg = (seed: string) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(`photo-${seed}-`.repeat(40)), Buffer.from([0xff, 0xd9])]);
const binary = (res: any, cb: any) => { const parts: Buffer[] = []; res.on('data', (c: Buffer) => parts.push(c)); res.on('end', () => cb(null, Buffer.concat(parts))); };

async function as(email: string) {
  const agent = request.agent(app);
  await agent.post('/api/auth/login').set(H).send({ email, password: 'addendum-demo' });
  return {
    get: (u: string) => agent.get(u),
    file: (u: string) => agent.get(u).buffer(true).parse(binary),
    post: (u: string, b: object = {}) => agent.post(u).set(H).send(b),
    patch: (u: string, b: object = {}) => agent.patch(u).set(H).send(b),
    del: (u: string) => agent.delete(u).set(H),
    upload: (u: string, bytes: Buffer) => agent.post(u).set(H).set('Content-Type', 'image/jpeg').send(bytes),
    put: (u: string, bytes: Buffer) => agent.put(u).set(H).set('Content-Type', 'image/jpeg').send(bytes),
    putJson: (u: string, b: object) => agent.put(u).set(H).send(b),
  };
}
type Agent = Awaited<ReturnType<typeof as>>;
let jen: Agent, mike: Agent, desk: Agent, owner: Agent;
const staffId = async (email: string) => (await db().one<{ id: string }>('SELECT id FROM staff WHERE email = $1', [email]))!.id;
async function waitExport(a: Agent, id: string) {
  await exportJobs.get(id);
  return (await a.get(`/api/transformations/exports/${id}`)).body;
}
const grant = async (email: string, permission: string) => db().query('INSERT INTO staff_permission_overrides(staff_id, permission, granted) VALUES ($1,$2,true) ON CONFLICT (staff_id, permission) DO UPDATE SET granted = true', [await staffId(email), permission]);

beforeAll(async () => {
  ({ api, app } = await setup());
  jen = await as('jennifer@addendumsalon.com');
  mike = await as('michael@addendumsalon.com');
  desk = await as('frontdesk@addendumsalon.com');
  owner = await as('owner@addendumsalon.com');
});
afterAll(() => { setOembedFetch(null); fs.rmSync(MEDIA, { recursive: true, force: true }); });

let tid = '';
let photoA = '';
describe('Transformations Library', () => {
  it('1. a stylist can create, upload photos to and edit their own transformation (originals kept, duplicates once)', async () => {
    const r = await jen.post('/api/transformations', { title: 'Copper balayage refresh', serviceDate: '2026-10-20', mainService: 'Balayage / lightening', services: ['Gloss or toner'],
      details: { techniques: 'Hand-painted', products: 'Milbon' }, technicalNotes: 'Formula 7N + 20 vol', caption: 'Warm copper for fall', tags: ['#Copper', 'fall'] });
    expect(r.status).toBe(201);
    const t = r.body.transformation;
    tid = t.id;
    expect(t.code).toMatch(/^T-\d{4}$/);
    expect(t.stylistName).toBe('Jennifer');
    expect(t.consent.status).toBe('pending'); // never approved by default
    // Captions, hashtags and tags are for social posts: a stylist's are left out; administrators add them.
    expect([t.tags, t.caption]).toEqual([[], null]);
    const adm = await owner.patch(`/api/transformations/${tid}`, { caption: 'Warm copper for fall', tags: ['#Copper', 'fall'] });
    expect(adm.body.transformation.tags).toEqual(['copper', 'fall']);
    expect(t.missing).toContain('Photo or Instagram link');

    const up = await jen.upload(`/api/transformations/${tid}/photos?kind=before&name=IMG_1.jpg`, jpeg('a'));
    expect(up.status).toBe(201);
    photoA = up.body.photoId;
    const again = await jen.upload(`/api/transformations/${tid}/photos?kind=before`, jpeg('a'));
    expect([again.status, again.body.duplicate, again.body.photoId]).toEqual([200, true, photoA]);
    const up2 = await jen.upload(`/api/transformations/${tid}/photos?kind=after`, jpeg('b'));
    expect(up2.body.transformation.photos.map((p: any) => p.kind)).toEqual(['before', 'after']);
    // Not a photo: refused by its bytes.
    expect((await jen.upload(`/api/transformations/${tid}/photos`, Buffer.from('not an image at all, really'))).status).toBe(400);

    // Thumbnail made in the browser: stored separately, the original stays byte-for-byte.
    expect((await jen.put(`/api/transformations/photos/${photoA}/thumb`, jpeg('thumb'))).status).toBe(200);
    expect((await jen.file(`/api/transformations/media/${photoA}/thumb`)).body.equals(jpeg('thumb'))).toBe(true);
    expect((await jen.file(`/api/transformations/media/${photoA}/original`)).body.equals(jpeg('a'))).toBe(true);
    expect(fs.readdirSync(path.join(MEDIA, 'originals'), { recursive: true }).filter((f) => String(f).includes('.')).length).toBe(2);

    expect((await jen.patch(`/api/transformations/${tid}`, { caption: 'Copper, softly' })).status).toBe(403);
    await owner.patch(`/api/transformations/${tid}`, { caption: 'Copper, softly' });
    const e = await jen.patch(`/api/transformations/${tid}`, { title: 'Copper balayage' });
    expect([e.status, e.body.transformation.title]).toEqual([200, 'Copper balayage']);
    const order = await jen.post(`/api/transformations/${tid}/photos/order`, { ids: [up2.body.photoId, photoA] });
    expect(order.body.transformation.photos[0].kind).toBe('after');
    expect((await jen.patch(`/api/transformations/photos/${photoA}`, { caption: 'Day one' })).body.transformation.photos[1].caption).toBe('Day one');
    // Another stylist can't see it at all, or change it; they can't reassign their own to someone else either.
    expect((await mike.get(`/api/transformations/${tid}`)).status).toBe(404);
    expect((await mike.patch(`/api/transformations/${tid}`, { title: 'x' })).status).toBe(404);
    expect((await mike.get('/api/transformations')).body.items.find((x: any) => x.id === tid)).toBeUndefined();
    expect((await mike.post('/api/transformations', { title: 'x', serviceDate: '2026-10-20', mainService: 'Haircut', stylistStaffId: await staffId('jennifer@addendumsalon.com') })).status).toBe(403);
    // Nor can a stylist approve their own work for social media.
    expect((await jen.post('/api/transformations', { title: 'x', serviceDate: '2026-10-20', mainService: 'Haircut', consentStatus: 'approved_social' })).status).toBe(400);
  });

  it('2. extension details are kept only when extensions are involved', async () => {
    const plain = await jen.patch(`/api/transformations/${tid}`, { extension: { hasExtensions: false, method: 'K-tip' } });
    expect(plain.body.transformation.extension).toBeNull();
    const ext = await jen.patch(`/api/transformations/${tid}`, { services: ['Gloss or toner', 'Hair extension installation'], extension: { hasExtensions: false, method: 'K-tip', length: '22"', shade: 'Copper 30' } });
    expect(ext.body.transformation.extension).toMatchObject({ hasExtensions: true, method: 'K-tip', shade: 'Copper 30' });
    expect((await jen.get('/api/transformations?extensions=K-tip')).body.items.map((x: any) => x.id)).toContain(tid);
    expect((await jen.get('/api/transformations?q=copper 30')).body.items.map((x: any) => x.id)).toContain(tid);
    expect((await jen.get('/api/transformations?extensions=no')).body.items.map((x: any) => x.id)).not.toContain(tid);
  });

  it('3. Instagram links: a preview from oEmbed when available, otherwise a link card (nothing downloaded)', async () => {
    // Social-post details: administrators only.
    expect((await jen.post(`/api/transformations/${tid}/instagram`, { url: 'https://www.instagram.com/p/AbC123/' })).status).toBe(403);
    const bad = await owner.post(`/api/transformations/${tid}/instagram`, { url: 'https://example.com/p/abc' });
    expect(bad.status).toBe(400);
    // Without the Meta app: kept as a link card.
    const r = await owner.post(`/api/transformations/${tid}/instagram`, { url: 'https://instagram.com/reel/Cx12_ab/?igsh=xyz' });
    const ig = r.body.transformation.instagram[0];
    expect(ig).toMatchObject({ url: 'https://www.instagram.com/reel/Cx12_ab/', postType: 'reel', previewStatus: 'no_access', thumbnailUrl: null, addedBy: 'Lisa Ha' });
    // With the Meta app: metadata only.
    await api.put('/api/admin/credentials/instagram', { values: { META_APP_ID: '123', META_APP_SECRET: 'sec' } }).catch(() => null);
    const { loadConfig, config } = await import('../src/config.js');
    if (!config().META_APP_ID) loadConfig({ ...(process.env as any), DEMO_MODE: 'true', OWNER_EMAIL: 'owner@addendumsalon.com', OWNER_PASSWORD: 'addendum-demo', APP_URL: 'http://localhost:4000', META_APP_ID: '123', META_APP_SECRET: 'sec' });
    const calls: string[] = [];
    setOembedFetch(async (u) => { calls.push(u); return u.includes('DELETED') ? { status: 400, json: { error: { code: 24, message: 'not found' } } } : { status: 200, json: { thumbnail_url: 'https://scontent.cdninstagram.com/x.jpg', author_name: 'addendum.salon', title: 'Copper' } }; });
    const ok = await owner.post(`/api/transformations/${tid}/instagram`, { url: 'https://www.instagram.com/p/AbC123/', isPrimary: true });
    const p = ok.body.transformation.instagram.find((i: any) => i.isPrimary);
    expect(p).toMatchObject({ postType: 'post', previewStatus: 'ok', author: 'addendum.salon', thumbnailUrl: 'https://scontent.cdninstagram.com/x.jpg' });
    expect(calls[0]).toContain('instagram_oembed');
    const gone = await owner.post(`/api/transformations/${tid}/instagram`, { url: 'https://www.instagram.com/p/DELETED/' });
    expect(gone.body.transformation.instagram.find((i: any) => i.url.includes('DELETED')).previewStatus).toBe('unavailable');
    expect((await owner.post(`/api/transformations/${tid}/instagram`, { url: 'https://www.instagram.com/p/AbC123/' })).status).toBe(400); // already there
    // An Instagram link is not consent.
    expect(ok.body.transformation.consent.status).toBe('pending');
  });

  let approved = '';
  it('9. consent and publication approval are permissioned and checked', async () => {
    // Stylist records what the client said, but can't verify or approve.
    expect((await jen.patch(`/api/transformations/${tid}/consent`, { clientConsent: 'given', socialPermission: true, consentDate: '2026-10-20' })).status).toBe(200);
    expect((await jen.patch(`/api/transformations/${tid}/consent`, { verified: true })).status).toBe(403);
    expect((await jen.patch(`/api/transformations/${tid}/consent`, { status: 'approved_social' })).status).toBe(403);
    // The owner (consent permission) approves only once consent is verified.
    expect((await owner.patch(`/api/transformations/${tid}/consent`, { status: 'approved_social' })).status).toBe(400);
    const ok = await owner.patch(`/api/transformations/${tid}/consent`, { status: 'approved_social', verified: true });
    expect(ok.status).toBe(200);
    expect(ok.body.transformation.consent).toMatchObject({ status: 'approved_social', verifiedBy: 'Lisa Ha' });
    expect(ok.body.transformation.readyForSocial).toBe(true);
    // Changing the terms afterwards needs verifying again (back to pending).
    const changed = await jen.patch(`/api/transformations/${tid}/consent`, { socialPermission: false });
    expect(changed.body.transformation.consent).toMatchObject({ status: 'pending', verifiedAt: null });
    expect(changed.body.transformation.readyForSocial).toBe(false);
    await jen.patch(`/api/transformations/${tid}/consent`, { socialPermission: true });
    await owner.patch(`/api/transformations/${tid}/consent`, { status: 'approved_social', verified: true });
    // Expired consent is not ready.
    const second = (await jen.post('/api/transformations', { title: 'Blonde K-tips', serviceDate: '2026-09-01', mainService: 'Hair extension installation', extension: { hasExtensions: true, method: 'K-tip' } })).body.transformation;
    await jen.upload(`/api/transformations/${second.id}/photos?kind=after`, jpeg('c'));
    await jen.patch(`/api/transformations/${second.id}/consent`, { clientConsent: 'given', socialPermission: true, expiresOn: '2020-01-01' });
    const exp = await owner.patch(`/api/transformations/${second.id}/consent`, { status: 'approved_social', verified: true });
    expect(exp.body.transformation.readyForSocial).toBe(false);
    expect(exp.body.transformation.missing).toContain('Consent has expired');
    // Declined consent → Do Not Publish.
    const third = (await jen.post('/api/transformations', { title: 'Private cut', serviceDate: '2026-10-01', mainService: 'Haircut' })).body.transformation;
    await jen.upload(`/api/transformations/${third.id}/photos?kind=after`, jpeg('d'));
    expect((await jen.patch(`/api/transformations/${third.id}/consent`, { clientConsent: 'declined' })).body.transformation.consent.status).toBe('do_not_publish');
    approved = tid;
    const ready = (await owner.get('/api/transformations?ready=true')).body.items.map((x: any) => x.id);
    expect(ready).toEqual([approved]);
  });

  it('technical notes are hidden from people without access, and front desk sees only what they’re given', async () => {
    expect((await desk.get('/api/transformations')).status).toBe(403); // not granted by default
    await grant('frontdesk@addendumsalon.com', 'transformations:view_all');
    const d = await as('frontdesk@addendumsalon.com');
    const t = (await d.get(`/api/transformations/${tid}`)).body.transformation;
    expect(t.technicalNotes).toBeNull();
    expect(t.canSeeTechnical).toBe(false);
    expect(t.canEdit).toBe(false);
    expect((await d.patch(`/api/transformations/${tid}`, { title: 'x' })).status).toBe(403);
    expect((await jen.get(`/api/transformations/${tid}`)).body.transformation.technicalNotes).toBe('Formula 7N + 20 vol'); // their own
    // Admins don't get colour formulas by default either.
    expect((await owner.get(`/api/transformations/${tid}`)).body.transformation.technicalNotes).toBeNull();
  });

  it('5. a permitted user can download one photo and all photos for a transformation', async () => {
    const one = await jen.file(`/api/transformations/media/${photoA}/original?download`);
    expect(one.status).toBe(200);
    expect(one.headers['content-disposition']).toMatch(/attachment; filename=".*T-\d{4}_Copper_balayage_Before_02\.jpg"/);
    const job = await jen.post('/api/transformations/exports', { preset: 'one', ids: [tid] });
    expect(job.status).toBe(202);
    const st = await waitExport(jen, job.body.id);
    expect(st).toMatchObject({ status: 'done', total: 2, done: 2, failed: [] });
    const zip = await jen.file(st.downloadUrl);
    expect(zip.status).toBe(200);
    const names = zip.body.toString('latin1');
    expect(names).toMatch(/Addendum_Salon_Transformations\/Jennifer\/Balayage_lightening\/T-\d{4}_Copper_balayage\/Before\.jpg/);
    expect(names).toContain('/After.jpg');
    expect(names).toContain('transformation_details.csv');
    expect(names).toContain('https://www.instagram.com/p/AbC123/'); // links in the manifest
    expect(names).not.toContain('Formula 7N'); // technical notes stay out unless asked for and allowed
    expect(zip.body.subarray(0, 4).readUInt32LE(0)).toBe(0x04034b50);
    if (process.env.KEEP_ZIP) fs.writeFileSync(process.env.KEEP_ZIP, zip.body);
    const csv = await jen.get(`/api/transformations/${tid}/details.csv`);
    expect(csv.text).toContain('Copper balayage');
  });

  it('7. without download permission, direct URLs and API calls are refused', async () => {
    const d = await as('frontdesk@addendumsalon.com'); // can view all, can't download
    expect((await d.get(`/api/transformations/media/${photoA}/original`)).status).toBe(403);
    expect((await d.get(`/api/transformations/media/${photoA}/thumb`)).status).toBe(200); // browsing is fine
    expect((await d.get(`/api/transformations/${tid}/details.csv`)).status).toBe(403);
    expect((await d.post('/api/transformations/exports', { preset: 'social' })).status).toBe(403);
    const one = await d.post('/api/transformations/exports', { preset: 'one', ids: [tid] });
    const st = await waitExport(d, one.body.id);
    expect(st.total).toBe(0);
    expect(st.failed[0].reason).toMatch(/permission/);
    // Another stylist can't fetch Jennifer's photos, even with the id.
    expect((await mike.get(`/api/transformations/media/${photoA}/original`)).status).toBe(404);
    expect((await mike.get(`/api/transformations/media/${photoA}/thumb`)).status).toBe(404);
    // Someone else's export link doesn't work for them, and a wrong token doesn't either.
    const mine = await jen.post('/api/transformations/exports', { preset: 'one', ids: [tid] });
    const s2 = await waitExport(jen, mine.body.id);
    expect((await mike.get(s2.downloadUrl)).status).toBe(404);
    expect((await jen.get(`/api/transformations/exports/${mine.body.id}/download?token=nope`)).status).toBe(404);
    // Not signed in.
    expect((await request(app).get(`/api/transformations/media/${photoA}/original`)).status).toBe(401);
    // Stylists can't bulk download.
    expect((await jen.post('/api/transformations/exports', { preset: 'filter', filter: {} })).status).toBe(403);
  });

  it('4 + 6. bulk downloads: selected records and the approved collection; unapproved work is left out of social exports', async () => {
    await grant('owner@addendumsalon.com', 'transformations:bulk');
    const o = await as('owner@addendumsalon.com');
    const social = await o.post('/api/transformations/exports', { preset: 'social', filter: {} });
    const st = await waitExport(o, social.body.id);
    expect(st.status).toBe('done');
    const zip = (await o.file(st.downloadUrl)).body.toString('latin1');
    expect(zip).toContain('Copper_balayage');
    expect(zip).not.toContain('Blonde_K-tips'); // expired consent
    expect(zip).not.toContain('Private_cut'); // do not publish
    expect(zip).toContain('manifest.csv');
    expect(zip).toContain('manifest.json');
    // Selected records (any approval) for an authorised user.
    const ids = (await o.get('/api/transformations')).body.items.map((x: any) => x.id);
    const sel = await waitExport(o, (await o.post('/api/transformations/exports', { preset: 'selected', ids })).body.id);
    expect(sel.status).toBe('done');
    expect(sel.total).toBe(4);
    const all = (await o.file(sel.downloadUrl)).body.toString('latin1');
    expect(all).toContain('Private_cut');
    // ...unless they ask for approved only.
    const appr = await waitExport(o, (await o.post('/api/transformations/exports', { preset: 'selected', ids, approvedOnly: true })).body.id);
    expect(appr.total).toBe(2);
    // Photos picked across transformations.
    const pick = await waitExport(o, (await o.post('/api/transformations/exports', { preset: 'selected', photoIds: [photoA] })).body.id);
    expect(pick.total).toBe(1);
  });

  it('8. large exports report progress and say which files could not be included', async () => {
    const o = await as('owner@addendumsalon.com');
    const m = await db().one<{ file_path: string }>('SELECT file_path FROM transformation_media WHERE id = $1', [photoA]);
    fs.renameSync(path.join(MEDIA, m!.file_path), path.join(MEDIA, `${m!.file_path}.gone`));
    const st = await waitExport(o, (await o.post('/api/transformations/exports', { preset: 'one', ids: [tid] })).body.id);
    expect(st).toMatchObject({ status: 'done', total: 2, done: 2 });
    expect(st.failed).toEqual([expect.objectContaining({ file: 'Before.jpg', reason: 'File is missing from storage' })]);
    expect((await o.file(st.downloadUrl)).body.toString('latin1')).toContain('After.jpg');
    fs.renameSync(path.join(MEDIA, `${m!.file_path}.gone`), path.join(MEDIA, m!.file_path));
  });

  it('removing photos and records cleans up files that nothing else uses', async () => {
    const t = (await jen.post('/api/transformations', { title: 'Temp', serviceDate: '2026-10-02', mainService: 'Haircut' })).body.transformation;
    const p = (await jen.upload(`/api/transformations/${t.id}/photos`, jpeg('a'))).body.photoId; // same bytes as another record's photo
    expect((await jen.del(`/api/transformations/photos/${p}`)).status).toBe(200);
    expect((await jen.file(`/api/transformations/media/${photoA}/original`)).body.equals(jpeg('a'))).toBe(true); // still there for the other record
    expect((await jen.del(`/api/transformations/${t.id}`)).status).toBe(200);
    expect((await jen.get(`/api/transformations/${t.id}`)).status).toBe(404);
  });

  it('collections and the services list are for library managers', async () => {
    expect((await jen.post('/api/transformations/collections', { name: 'Fall 2026' })).status).toBe(403);
    const c = (await owner.post('/api/transformations/collections', { name: 'Fall 2026' })).body.collections[0];
    await owner.post(`/api/transformations/collections/${c.id}/items`, { ids: [tid] });
    expect((await owner.get(`/api/transformations?collection=${c.id}`)).body.items.map((x: any) => x.id)).toEqual([tid]);
    expect((await jen.putJson('/api/transformations/options/services', { services: ['Haircut'] })).status).toBe(403);
    const opts = (await jen.get('/api/transformations/options')).body;
    expect(opts.services).toContain('Hair extension installation');
    expect(opts.can).toMatchObject({ create: true, viewAll: false, bulk: false, consent: false });
    expect(opts.stylists.map((s: any) => s.name)).toEqual(['Jennifer']);
  });

  it('stylists confirm their finished appointments with photos and a note (or mark no photos)', async () => {
    const jenId = await staffId('jennifer@addendumsalon.com');
    const client = (await db().one<{ id: string }>('SELECT id FROM clients LIMIT 1'))!.id;
    const mk = async (ref: string, svc: string, daysAgo: number, staff = jenId) => {
      const [a] = await db().query<{ id: string }>(`INSERT INTO appointments(square_booking_id, source, client_id, staff_id, start_at, end_at, square_status)
        VALUES ($1,'demo',$2,$3, now() - make_interval(days => $4) - interval '2 hours', now() - make_interval(days => $4), 'ACCEPTED') RETURNING id`, [ref, client, staff, daysAgo]);
      await db().query('INSERT INTO appointment_services(appointment_id, position, service_name) VALUES ($1,0,$2)', [a.id, svc]);
      return a.id;
    };
    const a1 = await mk('tf-confirm-1', 'Balayage + Toner', 2);
    const a2 = await mk('tf-confirm-2', 'Haircut & Style', 3);
    await mk('tf-confirm-old', 'Haircut', 30); // too long ago
    await mk('tf-confirm-mike', 'Haircut', 1, await staffId('michael@addendumsalon.com')); // someone else's
    const mine = (items: any[]) => items.filter((x: any) => [a1, a2].includes(x.appointmentId) || x.services.includes('Haircut') && x.date < '2026-10-01');
    const all = (await jen.get('/api/transformations/to-confirm')).body.items;
    const list = mine(all);
    expect(list.map((x: any) => x.appointmentId)).toEqual([a1, a2]);
    expect(all.map((x: any) => x.appointmentId)).not.toContain(undefined);
    expect(list[0].services).toEqual(['Balayage / lightening']); // matched to the library's service
    // Confirm: just photos, the service and a note — title, date, client and stylist come from the appointment.
    const r = await jen.post('/api/transformations', { appointmentId: a1, mainService: list[0].services[0], technicalNotes: '7N + gloss 9V' });
    expect(r.status).toBe(201);
    expect(r.body.transformation).toMatchObject({ title: 'Balayage / lightening', stylistName: 'Jennifer', clientId: client, technicalNotes: '7N + gloss 9V' });
    expect(r.body.transformation.serviceDate).toBe(list[0].date);
    expect((await jen.post('/api/transformations', { appointmentId: a1, mainService: 'Haircut' })).status).toBe(400); // only once
    expect((await mike.post('/api/transformations', { appointmentId: a2, mainService: 'Haircut' })).status).toBe(403); // not theirs
    expect((await mike.post(`/api/transformations/to-confirm/${a2}/skip`)).status).toBe(404);
    expect((await jen.post(`/api/transformations/to-confirm/${a2}/skip`)).status).toBe(200);
    expect(mine((await jen.get('/api/transformations/to-confirm')).body.items)).toEqual([]);
  });

  it('videos too (MP4 / MOV), stored once and played from the original; photos still checked by their bytes', async () => {
    const t = (await jen.post('/api/transformations', { mainService: 'Haircut', technicalNotes: 'note' })).body.transformation;
    expect(t.title).toBe('Haircut'); // no title needed
    const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypisom'), Buffer.alloc(200_000, 7)]);
    const mov = Buffer.concat([Buffer.from([0, 0, 0, 0x14]), Buffer.from('ftypqt  '), Buffer.alloc(1000, 3)]);
    const v1 = await jen.upload(`/api/transformations/${t.id}/photos?kind=after&name=clip.mp4`, mp4);
    expect(v1.status).toBe(201);
    const v2 = await jen.upload(`/api/transformations/${t.id}/photos?kind=finished&name=clip.mov`, mov);
    expect(v2.body.transformation.photos.map((p: any) => p.mime)).toEqual(['video/mp4', 'video/quicktime']);
    expect((await jen.upload(`/api/transformations/${t.id}/photos`, mp4)).body.duplicate).toBe(true);
    const got = await jen.file(`/api/transformations/media/${v1.body.photoId}/original`);
    expect(got.body.equals(mp4)).toBe(true);
    expect((await jen.get(`/api/transformations/media/${v1.body.photoId}/thumb`)).status).toBe(404); // no poster yet: never the video
    // In the ZIP, streamed from disk.
    const st = await waitExport(jen, (await jen.post('/api/transformations/exports', { preset: 'one', ids: [t.id] })).body.id);
    expect(st).toMatchObject({ status: 'done', total: 2, failed: [] });
    expect((await jen.file(st.downloadUrl)).body.toString('latin1')).toContain('/Finished.mov');
  });

  it('stylists see only their own work, plus work whose stylist is unknown (which they can claim)', async () => {
    const own = (await mike.post('/api/transformations', { mainService: 'Haircut' })).body.transformation;
    const orphan = (await owner.post('/api/transformations', { mainService: 'Gloss or toner', stylistStaffId: await staffId('michael@addendumsalon.com') })).body.transformation;
    await db().query('UPDATE transformations SET stylist_staff_id = NULL WHERE id = $1', [orphan.id]); // e.g. the stylist left
    const ids = (await jen.get('/api/transformations')).body.items.map((x: any) => x.id);
    expect(ids).toContain(orphan.id);
    expect(ids).not.toContain(own.id);
    expect((await jen.get(`/api/transformations/${own.id}`)).status).toBe(404);
    // Claim it.
    const claimed = await jen.patch(`/api/transformations/${orphan.id}`, { stylistStaffId: await staffId('jennifer@addendumsalon.com') });
    expect([claimed.status, claimed.body.transformation.stylistName]).toEqual([200, 'Jennifer']);
    expect((await mike.get(`/api/transformations/${orphan.id}`)).status).toBe(404); // now Jennifer's
  });
});
