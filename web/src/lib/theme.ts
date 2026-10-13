import { DEFAULT_ACCENT } from '@addendum/shared';

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
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', '#FAFAF8');
}

/** Curated accents that suit a salon brand and all pass contrast with white text. */
export const ACCENT_PRESETS = [
  { name: 'Plum', hex: DEFAULT_ACCENT },
  { name: 'Rosewood', hex: '#8A4B4F' },
  { name: 'Terracotta', hex: '#9A5434' },
  { name: 'Bronze', hex: '#7A5C2E' },
  { name: 'Olive', hex: '#5B6436' },
  { name: 'Sage', hex: '#47695A' },
  { name: 'Teal', hex: '#2F6670' },
  { name: 'Navy', hex: '#34486E' },
  { name: 'Espresso', hex: '#5A4236' },
  { name: 'Charcoal', hex: '#3A3835' },
];
