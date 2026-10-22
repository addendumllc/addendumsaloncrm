import { useState } from 'react';
import { Check } from 'lucide-react';
import { FONT_CHOICES, FONT_SCALES, type CrmTheme, type FontScale, type ThemeButtons, type ThemeColors, type ThemeType } from '@addendum/shared';
import { contrastRatio, isHex } from '../../lib/theme';
import { Badge, Button, Field, Segmented, Toggle, cx } from '../ui';

/** Curated swatches for each colour (premium salon and hair palette); any other via the picker or a hex code. */
const SWATCHES: Record<keyof ThemeColors, string[]> = {
  accent: ['#6B5242', '#35281E', '#8C7B6B', '#B07A7E', '#B0603F', '#6B7445', '#C8DC45', '#6F8A76', '#5A6E8C', '#2E2D2B'],
  accent2: ['#6B5242', '#B08A5B', '#8C7B6B', '#B07A7E', '#6B7445', '#111111', '#5A6E8C'],
  background: ['#F7F5F2', '#F3EEE7', '#FFFFFF', '#F4F4F2', '#ECE8E1', '#FAF7F7'],
  sidebar: ['#EFECE7', '#2A2019', '#F5F3EE', '#FFFFFF', '#DED8CE', '#1E1D1C'],
  surface: ['#FFFFFF', '#FCFAF6', '#F8F6F2'],
  text: ['#1E1B18', '#1C1612', '#111111', '#18181B', '#2E2C29'],
  line: ['#E5E0D8', '#E1D8CC', '#E7E4DE', '#E4E4E7', '#D6CFC4'],
};
export const COLOR_FIELDS: { key: keyof ThemeColors; label: string; hint: string }[] = [
  { key: 'accent', label: 'Primary accent', hint: 'Buttons, links, selected tabs and controls' },
  { key: 'accent2', label: 'Secondary accent', hint: 'The active menu marker' },
  { key: 'background', label: 'Main background', hint: 'Behind every page' },
  { key: 'sidebar', label: 'Sidebar', hint: 'The menu on the left' },
  { key: 'surface', label: 'Cards', hint: 'Cards, tables and panels' },
  { key: 'text', label: 'Text', hint: 'Main text (kept readable automatically)' },
  { key: 'line', label: 'Borders', hint: 'Dividers and outlines' },
];

// ---- colour suggestions (harmonious with the rest of the theme)
const toHsl = (hex: string): [number, number, number] => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min, s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
};
const fromHsl = (h: number, s: number, l: number) => {
  h = ((h % 360) + 360) % 360; s = Math.max(0, Math.min(1, s)); l = Math.max(0, Math.min(1, l));
  const k = (n: number) => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
  const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return `#${[0, 8, 4].map((n) => Math.round(f(n) * 255).toString(16).padStart(2, '0')).join('')}`.toUpperCase();
};
/**
 * Suggestions for an accent, from the theme's other colours: for the secondary accent, shades and neighbours of the
 * primary; for the primary, colours that go with the secondary accent and stand out on the background.
 */
export function suggestColors(field: keyof ThemeColors, c: ThemeColors): string[] {
  const valid = (x: string) => isHex(x);
  let out: string[] = [];
  if (field === 'accent' || field === 'accent2') {
    const from = field === 'accent2' ? c.accent : c.accent2;
    if (!valid(from)) return [];
    const [h, s, l] = toHsl(from);
    out = field === 'accent2'
      ? [fromHsl(h, s, Math.min(0.8, l + 0.18)), fromHsl(h, s, Math.max(0.15, l - 0.15)), fromHsl(h + 30, s, l), fromHsl(h - 30, s, l), fromHsl(h + 180, Math.min(s, 0.35), Math.max(0.3, Math.min(0.55, l))), fromHsl(h, s * 0.35, l)]
      : [fromHsl(h, Math.min(1, s + 0.1), Math.max(0.2, l - 0.2)), fromHsl(h + 180, Math.max(s, 0.3), 0.4), fromHsl(h + 150, Math.max(s, 0.3), 0.38), fromHsl(h + 210, Math.max(s, 0.3), 0.38), fromHsl(h, s * 0.4, 0.25), fromHsl(h + 30, s, Math.max(0.25, l - 0.1))];
    return [...new Set(out)].filter((x) => x !== c[field].toUpperCase() && (field === 'accent2' || contrastRatio(x, valid(c.background) ? c.background : '#FFFFFF') >= 2));
  }
  // Background, sidebar and cards: light tints and deep tones of the two accents (soft, low-saturation).
  const tones = (hex: string) => {
    if (!valid(hex)) return { light: [] as string[], dark: [] as string[] };
    const [h, s] = toHsl(hex);
    const soft = Math.min(s, 0.3);
    return { light: [fromHsl(h, soft, 0.97), fromHsl(h, soft, 0.93), fromHsl(h, soft, 0.88)], dark: [fromHsl(h, soft, 0.14), fromHsl(h, soft, 0.2)] };
  };
  const a1 = tones(c.accent), a2 = tones(c.accent2);
  if (field === 'background') out = [a1.light[0], a1.light[1], a2.light[0], a2.light[1], a1.dark[0], a2.dark[0]];
  else if (field === 'sidebar') out = [a1.light[1], a1.light[2], a2.light[1], a2.light[2], a1.dark[0], a1.dark[1], a2.dark[1]];
  else if (field === 'surface') out = [ '#FFFFFF', a1.light[0], a2.light[0], a1.dark[1], a2.dark[1]];
  else return [];
  return [...new Set(out.map((x) => x.toUpperCase()))].filter((x) => x !== c[field].toUpperCase());
}

function Swatch({ hex, on, label, disabled, onPick }: { hex: string; on: boolean; label: string; disabled?: boolean; onPick: () => void }) {
  return (
    <button type="button" disabled={disabled} onClick={onPick} aria-label={`${label}: ${hex}`} aria-pressed={on} title={hex}
      className={cx('flex h-7 w-7 items-center justify-center border disabled:opacity-60', on ? 'border-ink ring-2 ring-ink ring-offset-2 ring-offset-white' : 'border-black/15 hover:border-black/40')} style={{ background: hex }}>
      {on && <Check className="h-3.5 w-3.5" style={{ color: contrastRatio(hex, '#FFFFFF') >= contrastRatio(hex, '#111111') ? '#FFFFFF' : '#111111' }} />}
    </button>
  );
}

/** One colour: the chosen colour (large), swatches, suggestions, a picker and a hex box; "Use the theme's" for overrides. */
export function ColorField({ label, hint, field, value, fallback, onChange, disabled, swatches, action, suggestions, children }: {
  label: string; hint: string; field: keyof ThemeColors; value: string | undefined; fallback: string; onChange: (v: string | undefined) => void; disabled?: boolean;
  /** Other swatches (e.g. the calendar colours) and a quick action (e.g. "Use my calendar color"). */
  swatches?: string[]; action?: { label: string; color: string };
  /** Colours that go with the rest of the theme. */
  suggestions?: string[];
  /** Related settings shown with this colour (e.g. the sidebar's opacity). */
  children?: React.ReactNode;
}) {
  const shown = (value ?? fallback).toUpperCase();
  const [text, setText] = useState<string | null>(null);
  return (
    <div className="border-t border-line py-3 first:border-0">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-[14px] font-medium text-ink">{label} <span className="font-normal text-stone">— {hint}</span></p>
        <span className="flex gap-3">
          {action && !disabled && <button type="button" className="inline-flex items-center gap-1 text-[12px] text-plum hover:underline" onClick={() => onChange(action.color.toUpperCase())}><span className="h-3 w-3 border border-black/15" style={{ background: action.color }} />{action.label}</button>}
          {value && value.toUpperCase() !== fallback.toUpperCase() && !disabled && <button type="button" className="text-[12px] text-plum hover:underline" onClick={() => onChange(undefined)}>Use the theme’s</button>}
        </span>
      </div>
      <div className="mt-2 flex items-start gap-3">
        {/* The chosen colour, large, so it's always clear what's selected. */}
        <span className="flex w-16 shrink-0 flex-col items-center gap-1" aria-hidden>
          <span className="h-12 w-16 border border-black/15" style={{ background: shown }} />
          <span className="font-mono text-[10px] text-stone">{shown}</span>
        </span>
        <div className="min-w-0 flex-1 space-y-2">
          <div className="flex flex-wrap items-center gap-1.5">
            {(swatches ?? SWATCHES[field]).map((hex) => <Swatch key={hex} hex={hex} on={shown === hex.toUpperCase()} label={label} disabled={disabled} onPick={() => onChange(hex)} />)}
            <input type="color" disabled={disabled} value={shown} onChange={(e) => onChange(e.target.value.toUpperCase())} className="h-7 w-9 cursor-pointer border border-line-strong bg-white p-0.5" aria-label={`${label}: any colour`} />
            <input className="field h-8 w-28 py-0 font-mono text-[13px] uppercase" disabled={disabled} value={text ?? shown} maxLength={7} aria-label={`${label} hex value`}
              onChange={(e) => { const v = e.target.value.trim(); setText(v); if (isHex(v)) onChange(v.toUpperCase()); }} onBlur={() => setText(null)} />
          </div>
          {!!suggestions?.length && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="mr-1 text-[12px] text-stone">Suggested</span>
              {suggestions.map((hex) => <Swatch key={hex} hex={hex} on={shown === hex} label={`${label} (suggested)`} disabled={disabled} onPick={() => onChange(hex)} />)}
            </div>
          )}
          {children}
        </div>
      </div>
    </div>
  );
}

/** Sidebar opacity, shown inside the Sidebar colour: how much of it shows over the main background. */
export function SidebarOpacityField({ value, onChange, disabled, fromTheme }: { value: number; background?: string; sidebar?: string; onChange: (v: number | undefined) => void; disabled?: boolean; fromTheme?: number }) {
  return (
    <div className="flex flex-wrap items-center gap-2 pt-1">
      <span className="text-[12px] text-ink-soft">Opacity</span>
      <input type="range" min={0} max={100} step={5} value={value} disabled={disabled} onChange={(e) => onChange(Number(e.target.value))} className="w-40 accent-plum" aria-label="Sidebar opacity" />
      <span className="num w-10 text-[13px] text-ink">{value}%</span>
      {[0, 35, 70, 100].map((v) => <button key={v} type="button" disabled={disabled} onClick={() => onChange(v)} aria-pressed={value === v}
        className={cx('border px-2 py-0.5 text-[12px]', value === v ? 'border-plum bg-plum text-white' : 'border-line-strong bg-white text-ink hover:border-ink/40')}>{v === 0 ? 'Match background' : `${v}%`}</button>)}
      {fromTheme != null && value !== fromTheme && !disabled && <button type="button" className="text-[12px] text-plum hover:underline" onClick={() => onChange(undefined)}>Use the theme’s</button>}
    </div>
  );
}

const scaleOptions = FONT_SCALES.map((s) => ({ value: s.value, label: s.label }));

/** Fonts and sizes: interface font, heading font, base text, headings, small text and labels, weight. */
export function TypeFields({ value, onChange, disabled, customFonts }: { value: ThemeType; onChange: (patch: Partial<ThemeType>) => void; disabled?: boolean; customFonts?: { heading?: string | null; body?: string | null } }) {
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Interface font" hint="Text, buttons, menus and forms">
          <select className="field" disabled={disabled} value={value.font} onChange={(e) => onChange({ font: e.target.value })}>
            {customFonts?.body && <option value="custom">{customFonts.body} (brand font)</option>}
            {FONT_CHOICES.filter((f) => f.kind === 'sans').map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
          </select>
        </Field>
        <Field label="Heading font">
          <select className="field" disabled={disabled} value={value.headingFont} onChange={(e) => onChange({ headingFont: e.target.value })}>
            {customFonts?.heading && <option value="custom">{customFonts.heading} (brand font)</option>}
            <optgroup label="Serif">{FONT_CHOICES.filter((f) => f.kind === 'serif').map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}</optgroup>
            <optgroup label="Sans-serif">{FONT_CHOICES.filter((f) => f.kind === 'sans').map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}</optgroup>
          </select>
        </Field>
      </div>
      {([['base', 'Base text size'], ['heading', 'Heading size'], ['small', 'Small text & labels']] as const).map(([k, label]) => (
        <div key={k} className={disabled ? 'pointer-events-none opacity-60' : ''}>
          <span className="label">{label}</span>
          <Segmented value={value[k]} onChange={(v) => onChange({ [k]: v as FontScale })} options={scaleOptions} />
        </div>
      ))}
      <div className={disabled ? 'pointer-events-none opacity-60' : ''}>
        <span className="label">Text weight</span>
        <Segmented value={String(value.weight) as '400' | '500'} onChange={(v) => onChange({ weight: Number(v) as 400 | 500 })} options={[{ value: '400', label: 'Regular' }, { value: '500', label: 'Medium' }]} />
      </div>
    </div>
  );
}

/** Buttons: one size and corner style for every button. */
export function ButtonFields({ value, onChange, disabled }: { value: ThemeButtons; onChange: (patch: Partial<ThemeButtons>) => void; disabled?: boolean }) {
  return (
    <div className={cx('space-y-4', disabled && 'pointer-events-none opacity-60')}>
      <div>
        <span className="label">Button size</span>
        <Segmented value={value.size} onChange={(size) => onChange({ size })} options={[{ value: 'small', label: 'Small' }, { value: 'default', label: 'Default' }, { value: 'large', label: 'Large' }]} />
      </div>
      <div>
        <span className="label">Button corners</span>
        <Segmented value={value.radius} onChange={(radius) => onChange({ radius })} options={[{ value: 'square', label: 'Square' }, { value: 'soft', label: 'Soft' }, { value: 'rounded', label: 'Rounded' }]} />
      </div>
    </div>
  );
}

/** The app itself, live: headings, text, a menu item, labels, a field, buttons, a link, a tab, a toggle and a badge. */
export function LivePreview() {
  const [on, setOn] = useState(true);
  const [tab, setTab] = useState<'a' | 'b'>('a');
  return (
    <div className="flex overflow-hidden border border-line" aria-label="Preview">
      <div className="hidden w-40 shrink-0 bg-sidebar p-2 sm:block">
        <nav className="font-nav space-y-0.5 text-[14.5px]">
          <a className="block bg-white px-3 py-1.5 font-medium text-ink shadow-sm">Dashboard</a>
          <span className="block px-3 py-1.5 text-ink-soft">Tasks</span>
          <span className="block px-3 py-1.5 text-ink-soft">Clients</span>
        </nav>
      </div>
      <div className="flex-1 space-y-3 bg-paper p-4">
        <p className="h-display text-[26px] leading-tight">Today’s priorities</p>
        <p className="text-[15px] text-ink-soft">Sarah is due for a color refresh and has a cut on Friday.</p>
        <div className="max-w-xs"><span className="label">Client name</span><input className="field" defaultValue="Sarah Lee" /></div>
        <Segmented value={tab} onChange={setTab} options={[{ value: 'a', label: 'To do' }, { value: 'b', label: 'Done' }]} />
        <div className="flex flex-wrap items-center gap-2">
          <Button variant="primary">Book appointment</Button>
          <Button>Secondary</Button>
          <Button size="sm" variant="ghost">Small</Button>
          <a className="cursor-pointer text-[14px] text-plum underline">View all</a>
          <Badge tone="plum">New client</Badge>
        </div>
        <div className="w-48"><Toggle label="Reminders" checked={on} onChange={setOn} /></div>
        <p className="text-[12px] text-stone">Small text and labels look like this.</p>
      </div>
    </div>
  );
}

/** A large picture of a theme in its own colours and fonts: menu (at its opacity), heading, text, card, field and buttons. */
export function ThemePreviewLarge({ t }: { t: Pick<CrmTheme, 'name' | 'colors' | 'type' | 'buttons' | 'sidebarOpacity'> }) {
  const c = t.colors;
  const op = (t.sidebarOpacity ?? 100) / 100;
  const mixHex = (a: string, b: string, k: number) => `#${[1, 3, 5].map((i) => Math.round(parseInt(a.slice(i, i + 2), 16) * (1 - k) + parseInt(b.slice(i, i + 2), 16) * k).toString(16).padStart(2, '0')).join('')}`;
  const side = isHex(c.background) && isHex(c.sidebar) ? mixHex(c.background, c.sidebar, op) : c.sidebar;
  const menuText = contrastRatio(side, '#000000') < 5 ? '#EFEAE3' : c.text;
  const onAccent = contrastRatio(c.accent, '#FFFFFF') >= contrastRatio(c.accent, '#111111') ? '#FFFFFF' : '#111111';
  const link = contrastRatio(c.accent, c.surface) >= 4.5 ? c.accent : c.text;
  const font = (id: string, fb: string) => FONT_CHOICES.find((f) => f.id === id)?.stack ?? fb;
  const body = font(t.type.font, 'Inter, sans-serif');
  const radius = t.buttons.radius === 'rounded' ? 8 : t.buttons.radius === 'soft' ? 4 : 0;
  const btnH = t.buttons.size === 'small' ? 28 : t.buttons.size === 'large' ? 40 : 34;
  return (
    <div className="flex h-[210px] w-full overflow-hidden border border-black/10" style={{ background: c.background, fontFamily: body, color: c.text, fontWeight: t.type.weight }} aria-label={`Preview of ${t.name}`}>
      <div className="flex w-[150px] shrink-0 flex-col gap-1 p-3 text-[13px]" style={{ background: side, color: menuText }}>
        <span className="mb-2 text-[17px]" style={{ fontFamily: font(t.type.headingFont, 'Georgia, serif') }}>Addendum</span>
        <span className="px-2 py-1.5 font-medium" style={{ background: c.surface, color: c.text, boxShadow: `inset 3px 0 0 ${c.accent2}` }}>Dashboard</span>
        <span className="px-2 py-1.5 opacity-80">Tasks</span>
        <span className="px-2 py-1.5 opacity-80">Clients</span>
        <span className="px-2 py-1.5 opacity-80">Inventory</span>
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-2.5 p-4">
        <span className="text-[24px] leading-tight" style={{ fontFamily: font(t.type.headingFont, 'Georgia, serif') }}>Today’s priorities</span>
        <span className="text-[13px] opacity-75">Sarah is due for a color refresh and has a cut on Friday.</span>
        <div className="flex items-center gap-2 border px-3 py-2 text-[13px]" style={{ background: c.surface, borderColor: c.line }}>
          Order 3 packs of 22” 60A · due Fri
          <span className="ml-auto px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide" style={{ background: c.accent, color: onAccent }}>New</span>
        </div>
        <div className="mt-auto flex flex-wrap items-center gap-2 text-[13px]">
          <span className="flex items-center border px-2 text-[12px] opacity-80" style={{ height: btnH, borderColor: c.line, background: c.surface, minWidth: 120 }}>Client name</span>
          <span className="flex items-center px-3 font-medium" style={{ height: btnH, background: c.accent, color: onAccent, borderRadius: radius }}>Book appointment</span>
          <span className="flex items-center border px-3 font-medium" style={{ height: btnH, borderColor: c.accent, color: link, background: c.surface, borderRadius: radius }}>Secondary</span>
          <span className="underline" style={{ color: link }}>View all</span>
        </div>
      </div>
    </div>
  );
}

/** A small card picture of a theme (its own colours, whatever is applied now). */
export function ThemeCard({ t, on, onPick, badge }: { t: Pick<CrmTheme, 'name' | 'description' | 'colors' | 'sidebarOpacity'>; on: boolean; onPick: () => void; badge?: string }) {
  const c = t.colors;
  const menuText = contrastRatio(c.sidebar, '#000000') < 5 ? '#EFEAE3' : c.text;
  const btnText = contrastRatio(c.accent, '#FFFFFF') >= contrastRatio(c.accent, '#111111') ? '#FFFFFF' : '#111111';
  return (
    <button type="button" onClick={onPick} aria-pressed={on} className={cx('flex w-[170px] shrink-0 flex-col gap-1.5 p-1.5 text-left', on ? 'bg-white ring-2 ring-plum' : 'hover:bg-white/70')}>
      <span className="flex h-20 overflow-hidden border border-black/10" style={{ background: c.background }} aria-hidden>
        <span className="relative flex w-10 flex-col gap-1 p-1.5">
          <span className="absolute inset-0" style={{ background: c.sidebar, opacity: (t.sidebarOpacity ?? 100) / 100 }} />
          <span className="relative h-1.5 w-full" style={{ background: c.accent2 }} />
          <span className="relative h-1.5 w-5 opacity-50" style={{ background: menuText }} />
        </span>
        <span className="flex flex-1 flex-col justify-between p-1.5">
          <span className="h-5 border" style={{ background: c.surface, borderColor: c.line }} />
          <span className="flex items-center px-1.5 text-[9px] font-medium" style={{ background: c.accent, color: btnText, width: 'fit-content' }}>Book</span>
        </span>
      </span>
      <span className="flex items-center gap-1 text-[13px] font-medium text-ink">{on && <Check className="h-3.5 w-3.5 text-plum" />}{t.name}{badge && <span className="ml-auto text-[10px] font-normal uppercase tracking-wide text-stone">{badge}</span>}</span>
      {t.description && <span className="text-[11px] leading-snug text-stone">{t.description}</span>}
    </button>
  );
}
