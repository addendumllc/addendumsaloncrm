import { DEFAULT_ACCENT, DEFAULT_APPEARANCE, DEFAULT_FONT_STYLES, FONT_CHOICES, FONT_SCALES, fontFileUrl, fontUrl, logoUrl, resolveFontStyle, resolveTheme, withUserThemes, type Appearance, type CrmTheme, type FontLibraryEntry, type FontRole, type ColorTheme, type FontScale, type FontSlot, type PersonalLook } from '@addendum/shared';

/** Accent colour theming (Settings → Appearance). Derives the tint/soft/dark shades from one colour. */
type RGB = [number, number, number];

const hexToRgb = (hex: string): RGB => {
  const h = hex.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as RGB;
};
export const rgbToHex = (c: RGB) => `#${c.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('')}`.toUpperCase();
const mix = (a: RGB, b: RGB, t: number): RGB => [0, 1, 2].map((i) => a[i] + (b[i] - a[i]) * t) as RGB;
const WHITE: RGB = [255, 255, 255];
const BLACK: RGB = [0, 0, 0];

function luminance([r, g, b]: RGB) {
  const f = (v: number) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
/** WCAG contrast ratio between two colours (#RRGGBB). */
export const contrastRatio = (a: string, b: string) => {
  if (!isHex(a) || !isHex(b)) return 21;
  const [x, y] = [luminance(hexToRgb(a)), luminance(hexToRgb(b))].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
};
/** WCAG contrast ratio between a colour and white. */
export const contrastWithWhite = (hex: string) => 1.05 / (luminance(hexToRgb(hex)) + 0.05);
export const isHex = (v: string) => /^#[0-9a-fA-F]{6}$/.test(v);

/** White text sits on the accent (buttons, badges), so deepen colours that are too light to read. */
export function readableAccent(hex: string): string {
  if (!isHex(hex)) return DEFAULT_ACCENT;
  let c = hexToRgb(hex);
  for (let i = 0; i < 20 && 1.05 / (luminance(c) + 0.05) < 4.5; i++) c = mix(c, BLACK, 0.08);
  return rgbToHex(c);
}

export function deriveAccent(hex: string) {
  const base = hexToRgb(readableAccent(hex));
  return { accent: base, dark: mix(base, BLACK, 0.18), tint: mix(base, WHITE, 0.9), soft: mix(base, WHITE, 0.75) };
}

let current = DEFAULT_ACCENT;
export const getAccentHex = () => readableAccent(current);

export function applyAccent(hex: string | undefined | null) {
  current = hex && isHex(hex) ? hex : DEFAULT_ACCENT;
  const d = deriveAccent(current);
  const root = document.documentElement.style;
  const ch = (c: RGB) => c.map((v) => Math.round(v)).join(' ');
  root.setProperty('--accent', ch(d.accent));
  root.setProperty('--accent-dark', ch(d.dark));
  root.setProperty('--accent-tint', ch(d.tint));
  root.setProperty('--accent-soft', ch(d.soft));
}

const SERIF = '"Cormorant Garamond", Georgia, serif';
const SANS = '"Instrument Sans", system-ui, -apple-system, "Segoe UI", sans-serif';
const FAMILY: Record<FontSlot, string> = { heading: 'Salon Heading', body: 'Salon Body', link: 'Salon Link', button: 'Salon Button', nav: 'Salon Menu' };
/** Corner sizes (Tailwind's rounded-md/lg/xl/xl2 read these): rounded, soft, or square for a sharper, modern look. */
const CORNERS = {
  rounded: { md: '0.375rem', lg: '0.5rem', xl: '0.75rem', xl2: '1.125rem' },
  soft: { md: '0.25rem', lg: '0.375rem', xl: '0.5rem', xl2: '0.75rem' },
  // Square: sharp buttons, fields and tabs (rounded-md/lg), with a barely-there edge on cards and panels.
  square: { md: '0px', lg: '0px', xl: '2px', xl2: '2px' },
};
/** Which part of the CRM is showing (kept for callers; the look is the same everywhere now). */
let currentArea: 'salon' | 'online' = 'salon';
export function setArea(area: 'salon' | 'online') {
  if (area === currentArea) return;
  currentArea = area;
  if (lastSalon) applyAppearance(lastSalon, lastPersonal);
}

/** Registers an uploaded font with the browser (once per version). Text uses the fallback until it has loaded. */
const loaded = new Map<FontSlot, string>();
function loadCustomFont(slot: FontSlot, url: string | null) {
  if (!url || loaded.get(slot) === url || typeof FontFace === 'undefined') return;
  loaded.set(slot, url);
  const face = new FontFace(FAMILY[slot], `url(${url})`, { display: 'swap' });
  face.load().then((f) => {
    // A replaced upload: drop the previous file so only the new one is used.
    document.fonts.forEach((x) => { if (x.family.replace(/"/g, '') === FAMILY[slot] && x !== f) document.fonts.delete(x); });
    document.fonts.add(f);
  }).catch(() => loaded.delete(slot));
}

/** Fonts uploaded to the font library: registered once each (family "AH Font <id>"), loaded when text uses them. */
const libraryLoaded = new Set<string>();
export function loadLibraryFont(e: FontLibraryEntry) {
  const url = fontFileUrl(e);
  if (libraryLoaded.has(url) || typeof FontFace === 'undefined') return;
  libraryLoaded.add(url);
  new FontFace(`AH Font ${e.id}`, `url(${url})`, { display: 'swap' }).load().then((f) => document.fonts.add(f)).catch(() => libraryLoaded.delete(url));
}
/** The CSS font stack for a font style's choice: a built-in font, or an uploaded one from the library. */
export function fontStackFor(choice: string, library: FontLibraryEntry[], fallback: string) {
  if (choice.startsWith('file:')) {
    const e = library.find((x) => x.id === choice.slice(5));
    if (!e) return fallback;
    loadLibraryFont(e);
    return `"AH Font ${e.id}", ${fallback}`;
  }
  return FONT_CHOICES.find((f) => f.id === choice)?.stack ?? fallback;
}

/** Dark palette (fixed, tuned for contrast): page, fills, borders, cards, text and status colours. */
const DARK = {
  paper: [24, 23, 22] as RGB, mist: [38, 37, 35] as RGB, line: [52, 50, 47] as RGB, strong: [72, 69, 65] as RGB, sidebar: [30, 29, 28] as RGB,
  surface: [33, 32, 30] as RGB, ink: [236, 233, 228] as RGB, inkSoft: [208, 204, 198] as RGB, stone: [160, 155, 148] as RGB, stoneLight: [118, 114, 108] as RGB,
  sage: [134, 176, 152] as RGB, sageTint: [33, 48, 40] as RGB, rose: [222, 136, 128] as RGB, roseTint: [62, 35, 33] as RGB, amber: [214, 170, 98] as RGB, amberTint: [58, 47, 29] as RGB,
};
const LIGHT_TEXT = { ink: [29, 28, 26] as RGB, inkSoft: [58, 56, 53] as RGB, stone: [117, 113, 107] as RGB, stoneLight: [162, 158, 151] as RGB };
const LIGHT_STATUS = { sage: [85, 117, 99] as RGB, sageTint: [234, 241, 236] as RGB, rose: [168, 84, 78] as RGB, roseTint: [247, 233, 231] as RGB, amber: [168, 122, 47] as RGB, amberTint: [246, 238, 221] as RGB };

let lastSalon: Partial<Appearance> | null = null;
let lastPersonal: Partial<PersonalLook> | null = null;
let autoListener: ((e: MediaQueryListEvent) => void) | null = null;
const prefersDark = () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-color-scheme: dark)').matches;

/** Darkens or lightens a colour until it reads on `bg` at the given contrast (text and indicators). */
/** Light text reads better on this colour than dark text (picks whichever gives more contrast). */
const lightOn = (bg: RGB) => contrastRatio(rgbToHex(bg), '#FFFFFF') > contrastRatio(rgbToHex(bg), '#000000');
function readableOn(c: RGB, bg: RGB, min: number): RGB {
  const toward = lightOn(bg) ? WHITE : BLACK;
  let x = c;
  for (let i = 0; i < 20 && contrastRatio(rgbToHex(x), rgbToHex(bg)) < min; i++) x = mix(x, toward, 0.1);
  return x;
}

/** The signed-in person's role (themes can be limited to roles). */
/** Personal themes this person can use (their own, and others' published): chosen like any other theme. */
let userThemes: CrmTheme[] = [];
export function setUserThemes(list: CrmTheme[]) {
  if (JSON.stringify(list) === JSON.stringify(userThemes)) return;
  userThemes = list;
  if (lastSalon) applyAppearance(lastSalon, lastPersonal);
}
let currentRole: string | null = null;
export function setThemeRole(role: string | null | undefined) {
  if ((role ?? null) === currentRole) return;
  currentRole = role ?? null;
  if (lastSalon) applyAppearance(lastSalon, lastPersonal);
}
const BUTTON_RADIUS = { square: '0px', soft: '4px', rounded: '8px' } as const;
const scale = (v: FontScale) => FONT_SCALES.find((x) => x.value === v)?.factor ?? 1;

/**
 * Applies the look: one layout and component system for everyone and both businesses. The person's theme (or the
 * organization's default) sets colours, fonts, text sizes and buttons; their own allowed adjustments go on top; light,
 * dark or system is theirs. Text on the accent is black or white, whichever reads; accent-coloured text stays readable.
 */
export function applyAppearance(input: Partial<Appearance> | undefined | null, personal: Partial<PersonalLook> | null | undefined = lastPersonal) {
  lastSalon = input ?? lastSalon;
  lastPersonal = personal ?? null;
  const org = { ...DEFAULT_APPEARANCE, ...(lastSalon ?? {}) };
  const t = resolveTheme(withUserThemes(org.themeSettings, userThemes), lastPersonal, currentRole);
  const c = t.colors;
  const html = document.documentElement;
  const root = html.style;
  const ch = (x: RGB) => x.map((v) => Math.round(v)).join(' ');
  const hex = (h: string, fb: RGB) => (isHex(h) ? hexToRgb(h) : fb);
  current = isHex(c.accent) ? c.accent : DEFAULT_ACCENT;

  const mode = lastPersonal?.mode ?? 'light';
  const mq = typeof window !== 'undefined' ? window.matchMedia?.('(prefers-color-scheme: dark)') : null;
  if (autoListener && mq) { mq.removeEventListener?.('change', autoListener); autoListener = null; }
  if (mode === 'auto' && mq) { autoListener = () => applyAppearance(lastSalon, lastPersonal); mq.addEventListener?.('change', autoListener); }
  const dark = mode === 'dark' || (mode === 'auto' && prefersDark());

  let pal;
  let cardTones: { ink: RGB; inkSoft: RGB; stone: RGB; stoneLight: RGB } | null = null;
  if (dark) {
    pal = { paper: DARK.paper, sidebar: DARK.sidebar, surface: DARK.surface, mist: DARK.mist, line: DARK.line, strong: DARK.strong, ink: DARK.ink, inkSoft: DARK.inkSoft, stone: readableOn(DARK.stone, DARK.surface, 4.5), stoneLight: readableOn(DARK.stoneLight, DARK.surface, 4.5), sage: DARK.sage, sageTint: DARK.sageTint, rose: DARK.rose, roseTint: DARK.roseTint, amber: DARK.amber, amberTint: DARK.amberTint };
  } else {
    // Each colour at its opacity: the page background over white; cards and borders over the page.
    const op = (k: keyof NonNullable<typeof t.opacity>) => Math.max(0, Math.min(100, t.opacity?.[k] ?? 100)) / 100;
    const paper = mix(WHITE, hex(c.background, [247, 245, 242]), op('background'));
    const surface = mix(paper, hex(c.surface, WHITE), op('surface'));
    const line = mix(surface, hex(c.line, [229, 224, 216]), op('line'));
    // Text as chosen, kept readable on everything it sits on (page, cards and fills), whatever the colours — light or
    // dark. Softer tones keep the hierarchy but never drop below readable contrast.
    const mist = mix(paper, lightOn(paper) ? WHITE : BLACK, 0.035);
    // Page text: readable on the page background (and its light fills).
    const onAll = (x: RGB, min: number) => [paper, mist].reduce((acc, g) => readableOn(acc, g, min), x);
    // If the chosen text can't reach contrast on this page (e.g. dark text on a dark page), start from light or dark.
    // Text at its opacity over the page (still kept readable below).
    const chosen = mix(paper, hex(c.text, LIGHT_TEXT.ink), op('text'));
    const ink = onAll(contrastRatio(rgbToHex(chosen), rgbToHex(paper)) >= 4.5 ? chosen : lightOn(paper) ? WHITE : LIGHT_TEXT.ink, 7);
    // Text on cards, panels and dialogs: worked out for the card colour itself (a dark page can have light cards).
    const cardInk = readableOn(contrastRatio(rgbToHex(chosen), rgbToHex(surface)) >= 4.5 ? chosen : lightOn(surface) ? WHITE : LIGHT_TEXT.ink, surface, 7);
    const base = lightOn(surface) ? WHITE : cardInk;
    cardTones = { ink: cardInk, inkSoft: readableOn(mix(base, surface, 0.18), surface, 7), stone: readableOn(mix(base, surface, 0.45), surface, 4.5), stoneLight: readableOn(mix(base, surface, 0.6), surface, 4.5) };
    // The sidebar colour over the main background at the chosen opacity (0 = same as the background).
    const sideOp = Math.max(0, Math.min(100, t.sidebarOpacity ?? 100)) / 100;
    pal = { paper, sidebar: mix(paper, hex(c.sidebar, [239, 236, 231]), sideOp), surface, mist, line, strong: mix(line, luminance(line) < 0.3 ? WHITE : BLACK, 0.08),
      ink, inkSoft: onAll(mix(ink, paper, 0.18), 7), stone: onAll(mix(ink, paper, 0.45), 4.5), stoneLight: onAll(mix(ink, paper, 0.62), 4.5), ...LIGHT_STATUS };
  }
  for (const [k, v] of Object.entries({
    paper: pal.paper, sidebar: pal.sidebar, surface: pal.surface, mist: pal.mist, line: pal.line, 'line-strong': pal.strong,
    ink: pal.ink, 'ink-soft': pal.inkSoft, stone: pal.stone, 'stone-light': pal.stoneLight, heading: pal.ink,
    sage: pal.sage, 'sage-tint': pal.sageTint, rose: pal.rose, 'rose-tint': pal.roseTint, amber: pal.amber, 'amber-tint': pal.amberTint,
  })) root.setProperty(`--${k}`, ch(v));
  // Menu text tones worked out for the sidebar itself (any colour, any opacity), so the menu is always readable.
  html.removeAttribute('data-sidebar-tone');
  const sideBase = lightOn(pal.sidebar) ? WHITE : pal.ink;
  root.setProperty('--side-ink', ch(readableOn(lightOn(pal.sidebar) ? mix(WHITE, pal.sidebar, 0.08) : pal.ink, pal.sidebar, 7)));
  root.setProperty('--side-ink-soft', ch(readableOn(mix(sideBase, pal.sidebar, 0.15), pal.sidebar, 7)));
  root.setProperty('--side-stone', ch(readableOn(mix(sideBase, pal.sidebar, 0.4), pal.sidebar, 4.5)));
  root.setProperty('--side-stone-light', ch(readableOn(mix(sideBase, pal.sidebar, 0.55), pal.sidebar, 4.5)));
  root.setProperty('--side-line', ch(mix(pal.sidebar, luminance(pal.sidebar) < 0.3 ? WHITE : BLACK, 0.12)));
  root.setProperty('--page-ink', ch(pal.ink));
  root.setProperty('--page-stone', ch(pal.stone));
  const ct = cardTones ?? { ink: pal.ink, inkSoft: pal.inkSoft, stone: pal.stone, stoneLight: pal.stoneLight };
  root.setProperty('--card-ink', ch(ct.ink));
  root.setProperty('--card-ink-soft', ch(ct.inkSoft));
  root.setProperty('--card-stone', ch(ct.stone));
  root.setProperty('--card-stone-light', ch(ct.stoneLight));
  // Light fills inside cards (tabs, chips) come from the card colour, not the page's.
  root.setProperty('--card-mist', ch(dark ? pal.mist : mix(pal.surface, luminance(pal.surface) < 0.3 ? WHITE : BLACK, 0.045)));

  // Accent (primary): fills buttons, toggles and selected states as chosen; secondary: the active menu marker.
  // Accents at their opacity (over cards, and over the sidebar for the menu marker); light/dark mode keeps them solid.
  const opk = (k: 'accent' | 'accent2') => (dark ? 1 : Math.max(0, Math.min(100, t.opacity?.[k] ?? 100)) / 100);
  const fill = mix(pal.surface, hex(c.accent, hexToRgb(DEFAULT_ACCENT)), opk('accent'));
  const onAccent = contrastRatio(rgbToHex(fill), '#FFFFFF') >= contrastRatio(rgbToHex(fill), '#111111') ? WHITE : [17, 17, 17] as RGB;
  root.setProperty('--accent', ch(fill));
  root.setProperty('--accent-dark', ch(mix(fill, luminance(fill) < 0.2 ? WHITE : BLACK, 0.15)));
  root.setProperty('--accent-tint', ch(mix(fill, pal.surface, dark ? 0.82 : 0.88)));
  root.setProperty('--accent-soft', ch(mix(fill, pal.surface, dark ? 0.62 : 0.7)));
  root.setProperty('--on-accent', ch(onAccent));
  root.setProperty('--accent-ink', ch(readableOn(fill, pal.surface, 4.5)));
  root.setProperty('--accent2', ch(readableOn(mix(pal.sidebar, hex(c.accent2, fill), opk('accent2')), pal.sidebar, 3)));
  root.setProperty('color-scheme', dark ? 'dark' : 'light');
  html.dataset.mode = dark ? 'dark' : 'light';
  for (const k of ['badges', 'badgeCase', 'headingCase']) delete html.dataset[k];

  // Type: the theme's fonts and sizes (base text, headings, small text and labels) and text weight.
  const ty = t.type;
  root.setProperty('--area-scale', String(scale(ty.base)));
  root.setProperty('--size-nav', String(scale(ty.base)));
  root.setProperty('--size-heading', String(scale(ty.heading)));
  root.setProperty('--size-small', String(scale(ty.small)));
  root.setProperty('--size-button', '1');
  root.setProperty('--body-weight', String(ty.weight));
  root.setProperty('--heading-weight', '400');
  root.setProperty('--heading-tracking', '-0.005em');
  root.setProperty('--body-leading', '1.5');
  const stack = (id: string, slot: 'heading' | 'body', fallback: string) => {
    if (id === 'custom') {
      const url = fontUrl(org, slot);
      loadCustomFont(slot, url);
      return url ? `"${FAMILY[slot]}", ${fallback}` : fallback;
    }
    return FONT_CHOICES.find((f) => f.id === id)?.stack ?? fallback;
  };
  root.setProperty('--font-display', stack(ty.headingFont, 'heading', SERIF));
  root.setProperty('--font-body', stack(ty.font, 'body', SANS));
  for (const k of ['--font-link', '--font-button', '--font-nav', '--font-label']) root.setProperty(k, 'var(--font-body)');
  root.setProperty('--font-subheading', 'var(--font-display)');
  // A font style (chosen by the person, or the organization's default) sets each kind of text: font, weight, capitals.
  const fsSettings = { ...DEFAULT_FONT_STYLES, ...(org.fontStyles ?? {}) };
  const style = resolveFontStyle(fsSettings, lastPersonal);
  const ROLE_VAR: Record<FontRole, string> = { heading: '--font-display', subheading: '--font-subheading', body: '--font-body', menu: '--font-nav', button: '--font-button', label: '--font-label', link: '--font-link' };
  // Each kind of text's zoom: the theme's size (headings, small text, menu) times the font style's own size.
  const pct = (role: FontRole) => (style?.sizes?.[role] ?? 100) / 100;
  const ZOOM: Record<string, number> = {
    heading: scale(ty.heading) * pct('heading'), subheading: scale(ty.heading) * pct('subheading'), body: pct('body'), 'body-small': scale(ty.small) * pct('body'),
    menu: scale(ty.base) * pct('menu'), button: pct('button'), label: scale(ty.small) * pct('label'), link: pct('link'),
  };
  for (const [k, v] of Object.entries(ZOOM)) root.setProperty(`--z-${k}`, String(Math.round(v * 1000) / 1000));
  for (const role of Object.keys(ROLE_VAR) as FontRole[]) {
    root.removeProperty(`--w-${role}`);
    delete html.dataset[`caps${role[0].toUpperCase()}${role.slice(1)}`];
  }
  if (style) {
    for (const role of Object.keys(ROLE_VAR) as FontRole[]) {
      root.setProperty(ROLE_VAR[role], fontStackFor(style.fonts[role], fsSettings.library ?? [], role === 'heading' || role === 'subheading' ? SERIF : SANS));
      const w = style.weights?.[role];
      if (w) root.setProperty(`--w-${role}`, String(w));
      if (style.caps?.[role]) html.dataset[`caps${role[0].toUpperCase()}${role.slice(1)}`] = '';
    }
  }

  // Buttons: one size and corner style for every button (the theme's, or theirs).
  const b = t.buttons;
  if (b.size === 'default') html.removeAttribute('data-buttons'); else html.setAttribute('data-buttons', b.size === 'small' ? 'compact' : b.size === 'xsmall' ? 'xsmall' : 'large');
  // An exact height for every button (small buttons 8px less), on top of the size's padding and text.
  if (b.height) { html.setAttribute('data-btn-height', ''); root.setProperty('--btn-h', `${b.height}px`); } else html.removeAttribute('data-btn-height');
  root.setProperty('--radius-button', BUTTON_RADIUS[b.radius] ?? '0px');
  for (const [k, v] of Object.entries(CORNERS.square)) root.setProperty(`--radius-${k}`, v);
  html.dataset.corners = 'square';

  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', rgbToHex(pal.paper));
  const icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]');
  const logo = org.logoAsIcon ? logoUrl(org) : null;
  if (icon) {
    icon.href = logo ?? '/favicon.svg';
    if (logo) icon.removeAttribute('type'); else icon.type = 'image/svg+xml';
  }
}

/** The Appearance settings a theme stands for (also used to apply one as the salon's look). */
export function themeAppearance(t: ColorTheme): Partial<Appearance> {
  return { accent: t.accent, mode: t.mode, background: 'custom', backgroundColor: t.background, sidebar: 'custom', sidebarColor: t.sidebar, textColor: null, headingColor: null };
}

/** This person's own look changed (My look): re-apply over the salon's. */
export const applyPersonalLook = (look: Partial<PersonalLook> | null) => applyAppearance(lastSalon, look);

/** Curated accents for a premium salon and hair brand; any other colour via the picker or a hex code. */
export const ACCENT_PRESETS = [
  { name: 'Warm Brown', hex: '#6B5242' },
  { name: 'Espresso', hex: '#3A2A20' },
  { name: 'Muted Taupe', hex: '#8C7B6B' },
  { name: 'Dusty Rose', hex: '#B07A7E' },
  { name: 'Terracotta', hex: '#B0603F' },
  { name: 'Olive', hex: '#6B7445' },
  { name: 'Lime', hex: '#C8DC45' },
  { name: 'Sage', hex: '#6F8A76' },
  { name: 'Slate Blue', hex: '#5A6E8C' },
  { name: 'Charcoal', hex: '#2E2D2B' },
];

/** Each person's colour (calendar and next to their name): muted ones first, then brighter; any other via a picker. */
export const USER_COLORS = [
  '#9A6B7F', '#B5838D', '#A3716E', '#C08A5B', '#B08A5B', '#8F9E6B', '#7A8F6E', '#5F8F8A', '#6E8CA3', '#7B86B8', '#8C7BA8', '#9A8478', '#75716B',
  '#C0504D', '#D9773B', '#C9A227', '#6A9A3A', '#2E8B6F', '#2C8BA6', '#3D6FB6', '#6250B0', '#9C4FA8', '#C2477F', '#4A4A4A',
];
