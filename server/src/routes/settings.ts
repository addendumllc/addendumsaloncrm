import { Router, type Request, type Response } from 'express';
import { DEFAULT_FONT_STYLES, FONT_MAX_BYTES, LOGIN_IMAGE_MAX_BYTES, LOGO_MAX_BYTES, type FontSlot } from '@addendum/shared';
import { z } from 'zod';
import { can } from '../auth/permissions.js';
import { requireAnyPermission, requirePermission } from '../auth/session.js';
import { db } from '../db/index.js';
import { badRequest, forbidden } from '../lib/errors.js';
import { listAudit } from '../repos/audit.js';
import { getKV, getSettings, setKV, updateSettings } from '../repos/settings.js';
import { listStaff } from '../repos/staff.js';
import { runRules } from '../domain/rulesEngine.js';
import { ah, logAction, parse } from './util.js';

export const settingsRouter = Router();

/** Everyone gets the business basics (salon name, booking link); full settings need settings:read. */
settingsRouter.get('/settings', ah(async (req, res) => {
  const s = await getSettings();
  if (!can(req.user, 'settings:read')) {
    // Sections shared with the team (view only) come along too, so those screens can show them.
    const sh = s.sharedSettings ?? { rules: false, rebooking: false, reminders: false, replies: false };
    return res.json({ settings: {
      business: s.business, ai: { enabled: s.ai.enabled }, appearance: s.appearance, inventory: s.inventory, sharedSettings: sh,
      // The menu setup (sections, role defaults) and business names: everyone's sidebar uses them.
      workspaces: s.workspaces,
      ...(sh.rules ? { rules: s.rules } : {}), ...(sh.reminders ? { reminders: s.reminders, reviews: s.reviews } : {}), ...(sh.replies ? { replies: s.replies } : {}),
    }, limited: true });
  }
  res.json({ settings: s });
}));

const RULES_SECTIONS = ['rules', 'reminders', 'reviews', 'notifications', 'ai', 'replies'];
const num = (min: number, max: number) => z.coerce.number().min(min).max(max);
const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'must be a colour like #6B3F55');
/** One area's custom look (Settings → Appearance → Looks by area). */
const areaLook = z.object({
  accent: hexColor, background: hexColor, sidebar: hexColor, text: hexColor, heading: hexColor,
  fonts: z.record(z.enum(['heading', 'body', 'link', 'button', 'nav']), z.string().regex(/^[a-z0-9-]{1,40}$/)),
  headingCase: z.enum(['normal', 'uppercase']), corners: z.enum(['rounded', 'soft', 'square']),
  badge: z.object({ background: hexColor, text: hexColor, uppercase: z.boolean() }),
  textScale: z.number().int().min(80).max(130),
  sizes: z.object({ heading: z.number().int().min(70).max(150), button: z.number().int().min(70).max(150), nav: z.number().int().min(70).max(150) }).optional(),
  mode: z.enum(['light', 'dark']).optional(),
  surface: hexColor.optional(),
  line: hexColor.optional(),
  type: z.object({ headingWeight: z.number().int().min(300).max(700), headingTracking: z.number().int().min(-50).max(150), lineHeight: z.number().int().min(120).max(190) }).optional(),
});
const navPath = z.string().regex(/^\/[a-z-]*$/);
const menuSection = z.string().regex(/^[a-z0-9-]{1,30}$/);
const menuExtras = { sectionList: z.array(z.object({ key: menuSection, label: z.string().trim().min(1).max(30) })).max(15).optional(), labels: z.record(navPath, z.string().trim().min(1).max(30)).optional() };
const sidebarDefaults = z.object({ order: z.array(navPath).max(40), hidden: z.array(navPath).max(40), required: z.array(navPath).max(40), sections: z.record(navPath, menuSection).optional(), ...menuExtras });
const colorChoice = z.object({ theme: z.string().regex(/^[a-z]{1,20}$/).nullable(), accent: hexColor.nullable(), accent2: hexColor.nullable(), highlight: hexColor.nullable() });
const fontScale = z.enum(['xsmall', 'small', 'default', 'large', 'xlarge']);
const fontId = z.string().regex(/^[a-z0-9-]{1,40}$/);
const themeColors = z.object({ accent: hexColor, accent2: hexColor, background: hexColor, sidebar: hexColor, surface: hexColor, text: hexColor, line: hexColor });
const themeType = z.object({ font: fontId, headingFont: fontId, base: fontScale, heading: fontScale, small: fontScale, weight: z.union([z.literal(400), z.literal(500)]) });
const themeButtons = z.object({ size: z.enum(['xsmall', 'small', 'default', 'large']), radius: z.enum(['square', 'soft', 'rounded']), height: z.number().int().min(24).max(64).nullable().optional() });
const crmTheme = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,40}$/), name: z.string().trim().min(1, 'give the theme a name').max(40), description: z.string().trim().max(160),
  colors: themeColors, type: themeType, buttons: themeButtons, sidebarOpacity: z.number().int().min(0).max(100).optional(), opacity: z.object({ accent: z.number().int().min(0).max(100), accent2: z.number().int().min(0).max(100), background: z.number().int().min(0).max(100), surface: z.number().int().min(0).max(100), text: z.number().int().min(0).max(100), line: z.number().int().min(0).max(100) }).partial().optional(), status: z.enum(['draft', 'published', 'retired']),
  roles: z.array(z.enum(['admin', 'receptionist', 'stylist', 'assistant'])).max(4),
});
const business = z.object({ name: z.string().trim().min(1, 'enter a name').max(40), tagline: z.string().trim().max(60) });
const settingsPatch = z.object({
  business: z.object({
    name: z.string().max(100), address: z.string().max(300), phone: z.string().max(40), website: z.string().max(300),
    bookingUrl: z.string().max(300), reviewUrl: z.string().max(300), timezone: z.string().max(60), hours: z.string().max(300),
  }).partial().optional(),
  rules: z.object({
    newLeadHours: num(0, 168), leadNoResponseHours: num(1, 720), leadSecondNoResponseHours: num(1, 1440),
    cancellationEnabled: z.boolean(), cancellationDelayHours: num(0, 720), noShowEnabled: z.boolean(), noShowDelayHours: num(0, 720),
    reviewRequestEnabled: z.boolean(), reviewDelayHours: num(0, 720), rebookingEnabled: z.boolean(), rebookingGraceDays: num(0, 120), rebookingStopAfterDays: num(0, 3650),
    rebookingMinVisits: num(2, 20), unreadMessageMinutes: num(1, 1440),
  }).partial().optional(),
  reminders: z.object({ enabled: z.boolean(), offsetsHours: z.array(num(1, 336)).max(5), template: z.string().max(500) }).partial().optional(),
  reviews: z.object({ message: z.string().max(500) }).partial().optional(),
  ai: z.object({ enabled: z.boolean(), tone: z.string().max(300) }).partial().optional(),
  inventorySync: z.object({
    enabled: z.boolean(), intervalMinutes: num(5, 1440), firstSyncSource: z.enum(['square', 'shopify']), holdChangesOver: num(0, 100000),
  }).partial().optional(),
  replies: z.object({
    items: z.array(z.object({
      id: z.string().trim().min(1).max(64),
      title: z.string().trim().min(1, 'needs a name').max(80),
      body: z.string().trim().min(1, 'needs a message').max(1000),
      situations: z.array(z.enum(['new_lead', 'no_reply', 'booking', 'pricing', 'consultation', 'rebooking', 'cancellation', 'no_show', 'reschedule', 'reminder', 'confirmed', 'review', 'thanks', 'general'])).max(14),
    })).max(200),
  }).optional(),
  messaging: z.object({ autoCreateLeadFromUnknown: z.boolean(), quietHoursStart: z.string().regex(/^\d{2}:\d{2}$/), quietHoursEnd: z.string().regex(/^\d{2}:\d{2}$/), signature: z.string().max(80) }).partial().optional(),
  notifications: z.object({ email: z.boolean(), sms: z.boolean(), browser: z.boolean(), notifyEmail: z.string().max(200) }).partial().optional(),
  highlevel: z.object({
    defaultAssigneeUserId: z.string().max(100).nullable(), autoCreateContacts: z.boolean(),
    automations: z.record(z.boolean()),
  }).partial().optional(),
  inventory: z.object({
    orderEmail: z.string().trim().email('must be an email address').max(200),
    ccRequester: z.boolean(),
    catalog: z.array(z.string().trim().min(1).max(120)).max(300),
    orderFromName: z.string().trim().min(1, 'enter a sender name').max(80).refine((v) => !/[<>"\r\n]/.test(v), 'can’t contain < > " or line breaks'),
    orderFromAddress: z.union([z.literal(''), z.string().trim().email('must be an email address').max(200)]),
    sendAsSubmitter: z.boolean(),
    senderDomains: z.array(z.string().trim().toLowerCase().regex(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/, 'must be a domain like addendumsalon.com')).max(20),
  }).partial().optional(),
  appearance: z.object({
    accent: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'must be a colour like #6B3F55'),
    background: z.enum(['warm', 'white', 'cool', 'tinted', 'custom']),
    backgroundColor: hexColor.nullable(),
    sidebar: z.enum(['soft', 'white', 'accent', 'custom']),
    sidebarColor: hexColor.nullable(),
    textColor: hexColor.nullable(),
    headingColor: hexColor.nullable(),
    mode: z.enum(['light', 'dark', 'auto']),
    headingFont: z.enum(['serif', 'sans', 'custom']),
    bodyFont: z.enum(['default', 'custom']),
    brandName: z.string().trim().min(1, 'enter a name to show').max(40),
    tagline: z.string().trim().max(60),
    logoMode: z.enum(['name', 'logo', 'logo_name']),
    logoAsIcon: z.boolean(),
    fonts: z.record(z.enum(['heading', 'body', 'link', 'button', 'nav']), z.string().regex(/^[a-z0-9-]{1,40}$/)),
    corners: z.enum(['rounded', 'soft', 'square']),
    areaColors: z.object({ enabled: z.boolean(), salonTheme: z.string().max(40), onlineTheme: z.string().max(40) }),
    areaLooks: z.object({ main: areaLook.optional(), salon: areaLook, online: areaLook }),
    brandThemes: z.object({ salon: colorChoice, hair: colorChoice }).partial(),
    personalAccent: z.boolean(),
    themeSettings: z.object({
      themes: z.array(crmTheme).min(1).max(40),
      defaultTheme: z.string().regex(/^[a-z0-9-]{1,40}$/),
      allow: z.object({ colors: z.boolean(), type: z.boolean(), buttons: z.boolean() }),
    }).refine((t) => t.themes.some((x) => x.id === t.defaultTheme && x.status === 'published'), 'the default theme must be a published theme'),
    // Font styles (the uploaded font library is changed only by uploading or removing a file).
    fontStyles: z.object({
      styles: z.array(z.object({
        id: z.string().regex(/^[a-z0-9-]{1,40}$/), name: z.string().trim().min(1, 'give the font style a name').max(40), description: z.string().trim().max(160),
        fonts: z.object(Object.fromEntries(['heading', 'subheading', 'body', 'menu', 'button', 'label', 'link'].map((k) => [k, z.string().regex(/^(file:)?[a-z0-9-]{1,40}$/)])) as Record<string, z.ZodString>),
        weights: z.record(z.enum(['heading', 'subheading', 'body', 'menu', 'button', 'label', 'link']), z.union([z.literal(300), z.literal(400), z.literal(500), z.literal(600), z.literal(700)])).optional(),
        caps: z.record(z.enum(['heading', 'subheading', 'body', 'menu', 'button', 'label', 'link']), z.boolean()).optional(),
        status: z.enum(['draft', 'published']),
      })).max(30),
      defaultStyle: z.string().regex(/^[a-z0-9-]{1,40}$/).nullable(),
    }).refine((f) => f.defaultStyle == null || f.styles.some((x) => x.id === f.defaultStyle && x.status === 'published'), 'the default font style must be a published one'),
  }).partial().optional(),
  accounts: z.object({ allowAccessRequests: z.boolean() }).partial().optional(),
  // Businesses: names and taglines, and which sidebar tabs belong to which business ('shared' = both).
  workspaces: z.object({
    businesses: z.object({ salon: business, hair: business }).partial(),
    nav: z.record(z.string().regex(/^\/[a-z-]*$/), z.enum(['shared', 'salon', 'hair'])),
    menus: z.object({ salon: z.array(z.string().regex(/^\/[a-z-]*$/)).max(30), hair: z.array(z.string().regex(/^\/[a-z-]*$/)).max(30) }).partial(),
    groups: z.record(navPath, z.enum(['shared', 'salon', 'hair'])),
    sections: z.record(navPath, menuSection),
    menuDefaults: z.object({ admin: sidebarDefaults, receptionist: sidebarDefaults, stylist: sidebarDefaults, assistant: sidebarDefaults }).partial(),
  }).partial().optional(),
  login: z.object({ headline: z.string().trim().max(40), message: z.string().trim().max(160) }).partial().optional(),
  sharedSettings: z.object({ rules: z.boolean(), rebooking: z.boolean(), reminders: z.boolean(), replies: z.boolean() }).partial().optional(),
  onboardingComplete: z.boolean().optional(),
});

/** Which permission opens each settings section (any one of them). */
function sectionPermissions(key: string): string[] {
  if (RULES_SECTIONS.includes(key)) return ['settings:rules'];
  if (key === 'highlevel') return ['integrations:manage'];
  if (key === 'inventorySync') return ['inventory:sync', 'settings:write'];
  if (key === 'accounts') return ['users:manage'];
  return ['settings:write'];
}

settingsRouter.patch('/settings', ah(async (req, res) => {
  const patch = parse(settingsPatch, req.body);
  for (const key of Object.keys(patch)) if (!sectionPermissions(key).some((p) => can(req.user, p))) throw forbidden();
  const settings = await updateSettings(patch);
  await logAction(req, 'settings.update', 'settings', null, { sections: Object.keys(patch) });
  if (patch.rules || patch.reminders) await runRules();
  res.json({ settings });
}));

// ---------- Font library (Settings → Theme Management → Font styles) ----------
/** Upload a font file for font styles (administrators). Checked from its bytes; added to the library. */
settingsRouter.put('/settings/font-file', requirePermission('settings:write'), ah(async (req, res) => {
  const b = parse(z.object({
    dataUrl: z.string().max(Math.ceil(FONT_MAX_BYTES * 1.4) + 200, 'the font file must be 1.5 MB or smaller'),
    name: z.string().trim().min(1).max(80),
  }), req.body);
  const m = /^data:[\w./+-]*;base64,([A-Za-z0-9+/=]+)$/.exec(b.dataUrl);
  if (!m) throw badRequest('Upload a WOFF2, WOFF, TTF or OTF font file.');
  const bytes = Buffer.from(m[1], 'base64');
  if (bytes.length > FONT_MAX_BYTES) throw badRequest('The font file must be 1.5 MB or smaller.');
  const mime = sniffFont(bytes);
  if (!mime) throw badRequest('That file isn’t a WOFF2, WOFF, TTF or OTF font.');
  const id = Math.random().toString(36).slice(2, 10);
  await setKV(`branding.fontfile.${id}`, { mime, data: bytes.toString('base64') });
  const current = (await getSettings()).appearance.fontStyles ?? DEFAULT_FONT_STYLES;
  const entry = { id, name: b.name.replace(/\.(woff2?|ttf|otf)$/i, ''), version: Date.now().toString(36) };
  const settings = await updateSettings({ appearance: { fontStyles: { ...current, library: [...(current.library ?? []), entry] } } as any });
  await logAction(req, 'settings.font_file', 'settings', null, { id, bytes: bytes.length, mime });
  res.json({ settings, font: entry });
}));
/** Remove a font file: font styles using it fall back to the built-in fonts for that text. */
settingsRouter.delete('/settings/font-file/:id', requirePermission('settings:write'), ah(async (req, res) => {
  const id = parse(z.string().regex(/^[a-z0-9]{1,20}$/), req.params.id);
  const current = (await getSettings()).appearance.fontStyles ?? DEFAULT_FONT_STYLES;
  await db().query('DELETE FROM settings WHERE key = $1', [`branding.fontfile.${id}`]);
  const settings = await updateSettings({ appearance: { fontStyles: { ...current, library: (current.library ?? []).filter((f) => f.id !== id) } } as any });
  await logAction(req, 'settings.font_file_removed', 'settings', null, { id });
  res.json({ settings });
}));
/** Public (fonts load before and after sign-in). Versioned URLs are cached for good. */
export async function serveFontFile(req: Request, res: Response) {
  const id = /^[a-z0-9]{1,20}$/.test(req.params.id) ? req.params.id : null;
  const font = id ? await getKV<{ mime: string; data: string }>(`branding.fontfile.${id}`) : null;
  if (!font) return res.status(404).end();
  res.setHeader('Content-Type', font.mime);
  res.setHeader('Cache-Control', req.query.v ? 'public, max-age=31536000, immutable' : 'no-cache');
  res.send(Buffer.from(font.data, 'base64'));
}

// ---------- Sign-in photo (Settings → Businesses) ----------
const LOGIN_IMAGE_KEY = 'branding.login-image';
settingsRouter.put('/settings/login-image', requirePermission('settings:write'), ah(async (req, res) => {
  const { dataUrl } = parse(z.object({ dataUrl: z.string().max(Math.ceil(LOGIN_IMAGE_MAX_BYTES * 1.4) + 100, 'the photo must be 1.5 MB or smaller') }), req.body);
  const m = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!m) throw badRequest('Upload a JPG, PNG or WebP photo.');
  const bytes = Buffer.from(m[2], 'base64');
  if (bytes.length > LOGIN_IMAGE_MAX_BYTES) throw badRequest('The photo must be 1.5 MB or smaller.');
  const mime = sniff(bytes);
  if (!mime) throw badRequest('That file isn’t a JPG, PNG or WebP photo.');
  await setKV(LOGIN_IMAGE_KEY, { mime, data: bytes.toString('base64') });
  const settings = await updateSettings({ login: { imageVersion: Date.now().toString(36) } });
  await logAction(req, 'settings.login_image', 'settings', null, { bytes: bytes.length, mime });
  res.json({ settings });
}));
settingsRouter.delete('/settings/login-image', requirePermission('settings:write'), ah(async (req, res) => {
  await db().query('DELETE FROM settings WHERE key = $1', [LOGIN_IMAGE_KEY]);
  const settings = await updateSettings({ login: { imageVersion: null } });
  await logAction(req, 'settings.login_image_removed', 'settings', null);
  res.json({ settings });
}));
/** Public (the sign-in screen shows it before anyone signs in). Versioned URLs are cached for good. */
export async function serveLoginImage(req: Request, res: Response) {
  const img = await getKV<{ mime: string; data: string }>(LOGIN_IMAGE_KEY);
  if (!img) return res.status(404).end();
  res.setHeader('Content-Type', img.mime);
  res.setHeader('Cache-Control', req.query.v ? 'public, max-age=31536000, immutable' : 'no-cache');
  res.setHeader('Content-Security-Policy', "default-src 'none'");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.send(Buffer.from(img.data, 'base64'));
}

// ---------- Logo (Settings → Appearance) ----------
const LOGO_KEY = 'branding.logo';
const sniff = (b: Buffer) =>
  b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) ? 'image/png'
    : b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff ? 'image/jpeg'
      : b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' ? 'image/webp' : null;

/** Upload a logo as a data URL. The file's real type is checked from its bytes, not just its name. */
settingsRouter.put('/settings/logo', requirePermission('settings:write'), ah(async (req, res) => {
  const { dataUrl } = parse(z.object({ dataUrl: z.string().max(Math.ceil(LOGO_MAX_BYTES * 1.4) + 100, 'the logo must be 400 KB or smaller') }), req.body);
  const m = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!m) throw badRequest('Upload a PNG, JPG or WebP image.');
  const bytes = Buffer.from(m[2], 'base64');
  if (bytes.length > LOGO_MAX_BYTES) throw badRequest('The logo must be 400 KB or smaller.');
  const mime = sniff(bytes);
  if (!mime) throw badRequest('That file isn’t a PNG, JPG or WebP image.');
  await setKV(LOGO_KEY, { mime, data: bytes.toString('base64') });
  const settings = await updateSettings({ appearance: { logoVersion: Date.now().toString(36) } });
  await logAction(req, 'settings.logo', 'settings', null, { bytes: bytes.length, mime });
  res.json({ settings });
}));

settingsRouter.delete('/settings/logo', requirePermission('settings:write'), ah(async (req, res) => {
  await db().query('DELETE FROM settings WHERE key = $1', [LOGO_KEY]);
  const settings = await updateSettings({ appearance: { logoVersion: null } });
  await logAction(req, 'settings.logo_removed', 'settings', null);
  res.json({ settings });
}));

/** Public (the sign-in screen and browser tab use it). Versioned URLs are cached for good. */
export async function serveLogo(req: Request, res: Response) {
  const logo = await getKV<{ mime: string; data: string }>(LOGO_KEY);
  if (!logo) return res.status(404).end();
  res.setHeader('Content-Type', logo.mime);
  res.setHeader('Cache-Control', req.query.v ? 'public, max-age=31536000, immutable' : 'no-cache');
  res.setHeader('Content-Security-Policy', "default-src 'none'");
  res.send(Buffer.from(logo.data, 'base64'));
}

// ---------- Custom fonts (Settings → Appearance) ----------
const FONT_KEY = (slot: FontSlot) => `branding.font.${slot}`;
const fontSlot = z.enum(['heading', 'body', 'link', 'button', 'nav']);
const sniffFont = (b: Buffer) => {
  const tag = b.subarray(0, 4).toString('latin1');
  if (tag === 'wOF2') return 'font/woff2';
  if (tag === 'wOFF') return 'font/woff';
  if (tag === 'OTTO') return 'font/otf';
  if (tag === 'true' || b.subarray(0, 4).equals(Buffer.from([0, 1, 0, 0]))) return 'font/ttf';
  return null;
};
// Headings and body text also keep their original fields (older screens and saved settings read them).
const LEGACY_FONT_FIELDS = {
  heading: { name: 'headingFontName', version: 'headingFontVersion', use: 'headingFont', on: 'custom', off: 'serif' },
  body: { name: 'bodyFontName', version: 'bodyFontVersion', use: 'bodyFont', on: 'custom', off: 'default' },
} as const;
/** The appearance changes for a font uploaded to (or removed from) a slot: switched on for that slot, or back to its default. */
function fontPatch(slot: FontSlot, file: { name: string; version: string } | null): Record<string, unknown> {
  const legacy = slot === 'heading' || slot === 'body' ? LEGACY_FONT_FIELDS[slot] : null;
  const fallback = slot === 'heading' ? 'cormorant-garamond' : slot === 'body' ? 'instrument-sans' : 'same';
  return {
    fontFiles: { [slot]: file },
    fonts: { [slot]: file ? 'custom' : fallback },
    ...(legacy ? { [legacy.name]: file?.name ?? null, [legacy.version]: file?.version ?? null, [legacy.use]: file ? legacy.on : legacy.off } : {}),
  };
}

/** Upload a font (data URL). Checked from its bytes; it's switched on for that slot straight away. */
settingsRouter.put('/settings/font/:slot', requirePermission('settings:write'), ah(async (req, res) => {
  const slot = parse(fontSlot, req.params.slot);
  const b = parse(z.object({
    dataUrl: z.string().max(Math.ceil(FONT_MAX_BYTES * 1.4) + 200, 'the font file must be 1.5 MB or smaller'),
    name: z.string().trim().min(1).max(80),
  }), req.body);
  const m = /^data:[\w./+-]*;base64,([A-Za-z0-9+/=]+)$/.exec(b.dataUrl);
  if (!m) throw badRequest('Upload a WOFF2, WOFF, TTF or OTF font file.');
  const bytes = Buffer.from(m[1], 'base64');
  if (bytes.length > FONT_MAX_BYTES) throw badRequest('The font file must be 1.5 MB or smaller.');
  const mime = sniffFont(bytes);
  if (!mime) throw badRequest('That file isn’t a WOFF2, WOFF, TTF or OTF font.');
  await setKV(FONT_KEY(slot), { mime, data: bytes.toString('base64') });
  const name = b.name.replace(/\.(woff2?|ttf|otf)$/i, '');
  const settings = await updateSettings({ appearance: fontPatch(slot, { name, version: Date.now().toString(36) }) as any });
  await logAction(req, 'settings.font', 'settings', null, { slot, bytes: bytes.length, mime });
  res.json({ settings });
}));

settingsRouter.delete('/settings/font/:slot', requirePermission('settings:write'), ah(async (req, res) => {
  const slot = parse(fontSlot, req.params.slot);
  await db().query('DELETE FROM settings WHERE key = $1', [FONT_KEY(slot)]);
  const settings = await updateSettings({ appearance: fontPatch(slot, null) as any });
  await logAction(req, 'settings.font_removed', 'settings', null, { slot });
  res.json({ settings });
}));

export async function serveFont(req: Request, res: Response) {
  const slot = fontSlot.safeParse(req.params.slot);
  const font = slot.success ? await getKV<{ mime: string; data: string }>(FONT_KEY(slot.data)) : null;
  if (!font) return res.status(404).end();
  res.setHeader('Content-Type', font.mime);
  res.setHeader('Cache-Control', req.query.v ? 'public, max-age=31536000, immutable' : 'no-cache');
  res.send(Buffer.from(font.data, 'base64'));
}

// ---------- Staff ----------
// Same list as the API gate allows: also used to choose who an assignment or a hair order is for.
settingsRouter.get('/staff', requireAnyPermission('staff:read', 'users:manage', 'tasks:assign', 'inventory:order_for_others', 'commission:team'), ah(async (_req, res) => res.json({ staff: await listStaff() })));

/**
 * Team members and logins are managed manually (see docs/SETUP.md → "Team members & logins"),
 * so the API only allows the two display settings: calendar colour and HighLevel user mapping.
 */
const staffDisplayPatch = z.object({
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/, 'must be a colour like #9A6B7F').optional(),
  highlevelUserId: z.string().max(100).optional().nullable(),
}).strict();

settingsRouter.patch('/staff/:id', requirePermission('users:manage'), ah(async (req, res) => {
  const b = parse(staffDisplayPatch, req.body);
  await db().query(
    `UPDATE staff SET color = COALESCE($2, color),
       highlevel_user_id = CASE WHEN $3::boolean THEN $4 ELSE highlevel_user_id END, updated_at = now() WHERE id = $1`,
    [req.params.id, b.color ?? null, b.highlevelUserId !== undefined, b.highlevelUserId ?? null],
  );
  await logAction(req, 'staff.update', 'staff', req.params.id, { fields: Object.keys(b) });
  res.json({ ok: true });
}));

// ---------- Tags ----------
settingsRouter.get('/tags', ah(async (_req, res) => {
  res.json({ tags: await db().query(`SELECT t.id, t.name, t.is_default AS "isDefault", count(ct.client_id)::int AS count FROM tags t LEFT JOIN client_tags ct ON ct.tag_id = t.id GROUP BY t.id ORDER BY t.is_default DESC, t.name`) });
}));
settingsRouter.post('/tags', requirePermission('clients:write'), ah(async (req, res) => {
  const { name } = parse(z.object({ name: z.string().trim().min(1).max(40) }), req.body);
  await db().query('INSERT INTO tags(name) VALUES ($1) ON CONFLICT (name) DO NOTHING', [name]);
  res.status(201).json({ ok: true });
}));
settingsRouter.delete('/tags/:id', requirePermission('settings:rules'), ah(async (req, res) => {
  await db().query('DELETE FROM tags WHERE id = $1', [req.params.id]);
  res.json({ ok: true });
}));

// ---------- Audit + privacy ----------
settingsRouter.get('/audit', requirePermission('audit:read'), ah(async (req, res) => {
  res.json({ entries: await listAudit(Math.min(Number(req.query.limit) || 100, 500), req.query.entityType as string, req.query.entityId as string) });
}));

/** Activity log as CSV (for people with audit:export). Details hold names and IDs only — never secrets. */
settingsRouter.get('/audit/export', requirePermission('audit:export'), ah(async (req, res) => {
  const rows = await listAudit(5000);
  const esc = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const csv = ['When,Who,Action,Record type,Record,Details',
    ...rows.map((r: any) => [r.createdAt, r.staffName, r.action, r.entityType, r.entityId, r.detail ? JSON.stringify(r.detail) : ''].map(esc).join(','))].join('\n');
  await logAction(req, 'audit.export', 'audit', null, { rows: rows.length });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="activity-log.csv"');
  res.send(csv);
}));

/** Full data export (owner). Excludes secrets, password hashes and session data. */
settingsRouter.get('/privacy/export', requirePermission('privacy:export_all'), ah(async (req, res) => {
  const tables = ['clients', 'leads', 'appointments', 'appointment_services', 'tasks', 'notes', 'tags', 'client_tags', 'conversations', 'messages', 'services', 'locations'];
  const out: Record<string, unknown> = { exportedAt: new Date().toISOString() };
  for (const t of tables) out[t] = await db().query(`SELECT * FROM ${t}`);
  out.staff = await db().query('SELECT id, name, email, role, active, square_team_member_id, highlevel_user_id, created_at FROM staff');
  await logAction(req, 'privacy.export_all');
  res.setHeader('Content-Disposition', 'attachment; filename="addendum-salon-export.json"');
  res.json(out);
}));
