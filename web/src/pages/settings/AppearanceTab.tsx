import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { DEFAULT_ACCENT, DEFAULT_APPEARANCE, FONT_MAX_BYTES, LOGO_MAX_BYTES, logoUrl, type AppSettings, type Appearance, type FontSlot } from '@addendum/shared';
import { Check, ImageIcon, Info, Trash2, Type, Upload } from 'lucide-react';
import { api } from '../../api/client';
import { useSettings, useStaff } from '../../api/hooks';
import { ACCENT_PRESETS, applyAppearance, contrastWithWhite, isHex, readableAccent } from '../../lib/theme';
import { Avatar, Badge, Button, cx, Field, Toggle, useToast } from '../../components/ui';
import { BrandMark } from '../../components/layout/Brand';
import { Card, SaveBar, useCan, useSection } from './shared';

/** Brand and colour settings: logo and name, accent, background, sidebar, headings, and each stylist's calendar colour. */
export function AppearanceSettings() {
  return (
    <div className="space-y-6">
      <BrandCard />
      <StylistColors />
    </div>
  );
}

type Opt<T extends string> = { value: T; label: string; hint?: string; disabled?: boolean };
const BACKGROUNDS: Opt<Appearance['background']>[] = [
  { value: 'warm', label: 'Warm', hint: 'Soft off-white' }, { value: 'white', label: 'White', hint: 'Bright and clean' },
  { value: 'cool', label: 'Cool', hint: 'Light grey-blue' }, { value: 'tinted', label: 'Tinted', hint: 'A hint of your accent' },
];
const SIDEBARS: Opt<Appearance['sidebar']>[] = [{ value: 'soft', label: 'Soft grey' }, { value: 'white', label: 'White' }, { value: 'accent', label: 'Accent tint' }];

const LOGO_MODES: Opt<Appearance['logoMode']>[] = [{ value: 'logo_name', label: 'Logo and name' }, { value: 'logo', label: 'Logo only' }, { value: 'name', label: 'Name only' }];

function Choice<T extends string>({ value, options, onChange, disabled, label }: { value: T; options: Opt<T>[]; onChange: (v: T) => void; disabled?: boolean; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-2">
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value} disabled={disabled || o.disabled} onClick={() => onChange(o.value)}
          className={cx('rounded-lg border px-3 py-2 text-left text-[13px] transition-colors disabled:cursor-not-allowed', value === o.value ? 'border-plum bg-plum-tint text-ink' : 'border-line-strong bg-white text-ink-soft hover:bg-mist')}>
          <span className="block font-medium">{o.label}</span>
          {o.hint && <span className="block text-[12px] text-stone">{o.hint}</span>}
        </button>
      ))}
    </div>
  );
}

function BrandCard() {
  const a = useSection('appearance');
  const { data: settings } = useSettings();
  const can = useCan();
  const qc = useQueryClient();
  const toast = useToast();
  const locked = !can('settings:write');
  const saved = { ...DEFAULT_APPEARANCE, ...(settings?.settings.appearance ?? {}) };
  const d = { ...DEFAULT_APPEARANCE, ...(a.draft ?? {}) };
  const [hexInput, setHexInput] = useState('');
  const [uploading, setUploading] = useState(false);
  const file = useRef<HTMLInputElement>(null);

  // Live preview while choosing; put the saved look back if the page is left without saving.
  const draftKey = JSON.stringify(d);
  const savedKey = JSON.stringify(saved);
  useEffect(() => applyAppearance(d), [draftKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => applyAppearance(JSON.parse(savedKey)), [savedKey]);
  useEffect(() => setHexInput(d.accent.toUpperCase()), [d.accent]);

  if (!a.draft) return null;
  const set = <K extends keyof Appearance>(k: K, v: Appearance[K]) => a.set(k, v);
  const pick = (hex: string) => set('accent', hex.toUpperCase());
  const tooLight = contrastWithWhite(d.accent) < 4.5;

  // Uploads apply straight away; copy the server's new values into the draft so nothing shows as unsaved.
  const SERVER_FIELDS = ['logoVersion', 'headingFont', 'headingFontName', 'headingFontVersion', 'bodyFont', 'bodyFontName', 'bodyFontVersion'] as const;
  const afterUpload = (r: { settings: AppSettings }) => {
    qc.setQueryData(['settings'], { settings: r.settings });
    qc.invalidateQueries({ queryKey: ['auth-config'] });
    a.setDraft((x) => (x ? { ...x, ...Object.fromEntries(SERVER_FIELDS.map((k) => [k, r.settings.appearance[k]])) } : x));
  };
  const upload = async (f: File | undefined) => {
    if (!f) return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(f.type)) return toast('Choose a PNG, JPG or WebP image.', 'error');
    if (f.size > LOGO_MAX_BYTES) return toast(`That image is ${Math.round(f.size / 1024)} KB. Use one under ${LOGO_MAX_BYTES / 1024} KB.`, 'error');
    setUploading(true);
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result));
        r.onerror = () => reject(new Error('That file could not be read.'));
        r.readAsDataURL(f);
      });
      afterUpload(await api.put<{ settings: AppSettings }>('/settings/logo', { dataUrl }));
      toast('Logo updated for everyone');
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setUploading(false);
      if (file.current) file.current.value = '';
    }
  };
  const removeLogo = async () => {
    try {
      afterUpload(await api.del<{ settings: AppSettings }>('/settings/logo'));
      toast('Logo removed');
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  const save = async () => {
    if (await a.save()) qc.invalidateQueries({ queryKey: ['auth-config'] });
  };
  const src = logoUrl(d);

  return (
    <Card
      title="Brand & appearance"
      description="Your logo, name and colours, shown to everyone on the team and on the sign-in screen."
      footer={<SaveBar dirty={a.dirty} saving={a.saving} onSave={save} onReset={a.reset} disabled={locked} />}
    >
      <Section title="Logo">
        <div className="flex flex-wrap items-center gap-4">
          <div className="flex h-20 w-44 items-center justify-center rounded-xl border border-dashed border-line-strong bg-paper p-2">
            {src ? <img src={src} alt="Current logo" className="max-h-full max-w-full object-contain" /> : <ImageIcon className="h-7 w-7 text-stone-light" />}
          </div>
          <div className="space-y-2">
            <input ref={file} type="file" accept="image/png,image/jpeg,image/webp" className="hidden" onChange={(e) => upload(e.target.files?.[0])} />
            <div className="flex flex-wrap gap-2">
              <Button size="sm" icon={<Upload className="h-4 w-4" />} disabled={locked} loading={uploading} onClick={() => file.current?.click()}>{src ? 'Replace logo' : 'Upload logo'}</Button>
              {src && <Button size="sm" variant="ghost" icon={<Trash2 className="h-4 w-4" />} disabled={locked} onClick={removeLogo}>Remove</Button>}
            </div>
            <p className="text-[12px] text-stone">PNG, JPG or WebP, up to {LOGO_MAX_BYTES / 1024} KB. A wide logo on a transparent background looks best. Uploading takes effect straight away.</p>
          </div>
        </div>
        {src && (
          <div className="mt-4 space-y-3">
            <Choice label="Show in the header" value={d.logoMode} options={LOGO_MODES} onChange={(v) => set('logoMode', v)} disabled={locked} />
            <div className="max-w-md"><Toggle label="Use the logo as the browser tab icon" description="Also shown when the app is added to a phone's home screen." checked={d.logoAsIcon} disabled={locked} onChange={(v) => set('logoAsIcon', v)} /></div>
          </div>
        )}
      </Section>

      <Section title="Name">
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Salon name in the header"><input className="field" value={d.brandName} maxLength={40} disabled={locked} onChange={(e) => set('brandName', e.target.value)} /></Field>
          <Field label="Tagline" hint="Under the name in the sidebar. Leave empty to hide it."><input className="field" value={d.tagline} maxLength={60} disabled={locked} onChange={(e) => set('tagline', e.target.value)} /></Field>
        </div>
      </Section>

      <Section title="Accent colour" hint="Used for highlights, badges, toggles and buttons.">
        <div className="grid grid-cols-5 gap-3 sm:grid-cols-10">
          {ACCENT_PRESETS.map((p) => {
            const on = d.accent.toUpperCase() === p.hex.toUpperCase();
            return (
              <button key={p.hex} type="button" disabled={locked} onClick={() => pick(p.hex)} className="group flex flex-col items-center gap-1.5 disabled:cursor-not-allowed" aria-label={p.name} aria-pressed={on}>
                <span className={cx('flex h-10 w-10 items-center justify-center rounded-full transition-transform group-hover:scale-105', on && 'ring-2 ring-offset-2 ring-ink/70')} style={{ background: p.hex }}>
                  {on && <Check className="h-4 w-4 text-white" />}
                </span>
                <span className="text-[11px] text-stone">{p.name}</span>
              </button>
            );
          })}
        </div>
        <div className="mt-4 flex flex-wrap items-end gap-3">
          <label className="block">
            <span className="label">Custom colour</span>
            <span className="flex items-center gap-2">
              <input type="color" disabled={locked} value={d.accent} onChange={(e) => pick(e.target.value)} className="h-10 w-12 cursor-pointer rounded-lg border border-line-strong bg-white p-1" aria-label="Pick a custom colour" />
              <input
                className="field w-32 font-mono text-sm uppercase" disabled={locked} value={hexInput} maxLength={7}
                onChange={(e) => {
                  const v = e.target.value.startsWith('#') ? e.target.value : `#${e.target.value}`;
                  setHexInput(v.toUpperCase());
                  if (isHex(v)) pick(v);
                }}
                aria-label="Hex colour"
              />
            </span>
          </label>
          {d.accent.toUpperCase() !== DEFAULT_ACCENT && !locked && <Button variant="ghost" onClick={() => pick(DEFAULT_ACCENT)}>Reset to plum</Button>}
        </div>
        {tooLight && (
          <p className="mt-3 flex items-start gap-2 rounded-lg bg-amber-tint px-3 py-2 text-[13px] text-amber">
            <Info className="mt-0.5 h-4 w-4 shrink-0" />This colour is too light for white text, so the app uses a deeper shade ({readableAccent(d.accent)}) to keep buttons and badges readable.
          </p>
        )}
      </Section>

      <Section title="Background"><Choice label="Background" value={d.background} options={BACKGROUNDS} onChange={(v) => set('background', v)} disabled={locked} /></Section>
      <Section title="Sidebar"><Choice label="Sidebar" value={d.sidebar} options={SIDEBARS} onChange={(v) => set('sidebar', v)} disabled={locked} /></Section>
      <Section title="Fonts" hint="Choose a built-in font, or upload your brand font (WOFF2, WOFF, TTF or OTF). Make sure your font licence allows use on websites.">
        <p className="mb-2 mt-3 text-[13px] font-medium text-ink-soft">Headings</p>
        <Choice label="Heading font" value={d.headingFont} onChange={(v) => set('headingFont', v)} disabled={locked} options={[
          { value: 'serif', label: 'Elegant serif' }, { value: 'sans', label: 'Clean sans-serif' },
          { value: 'custom', label: d.headingFontName ?? 'Your font', hint: d.headingFontName ? 'Uploaded' : 'Upload one first', disabled: !d.headingFontName },
        ]} />
        <FontUpload slot="heading" name={d.headingFontName} locked={locked} onDone={afterUpload} />
        <p className="mb-2 mt-5 text-[13px] font-medium text-ink-soft">Body text</p>
        <Choice label="Body font" value={d.bodyFont} onChange={(v) => set('bodyFont', v)} disabled={locked} options={[
          { value: 'default', label: 'Built-in sans-serif' },
          { value: 'custom', label: d.bodyFontName ?? 'Your font', hint: d.bodyFontName ? 'Uploaded' : 'Upload one first', disabled: !d.bodyFontName },
        ]} />
        <FontUpload slot="body" name={d.bodyFontName} locked={locked} onDone={afterUpload} />
      </Section>

      <div className="mt-6 overflow-hidden rounded-xl border border-line">
        <p className="border-b border-line bg-white px-4 py-2 text-[11px] font-semibold uppercase tracking-wider text-stone">Preview</p>
        <div className="flex">
          <div className="hidden w-40 shrink-0 border-r border-line bg-sidebar p-3 sm:block">
            <BrandMark a={d} size="header" />
            {d.tagline && <p className="mt-1 text-[11px] text-stone">{d.tagline}</p>}
            <div className="mt-3 space-y-1 text-[13px]"><p className="rounded-md bg-white px-2 py-1 text-ink shadow-sm">Dashboard</p><p className="px-2 py-1 text-ink-soft">Clients</p></div>
          </div>
          <div className="flex-1 bg-paper p-4">
            <p className="h-display text-[26px] leading-none">Today’s Priorities</p>
            <p className="mt-1 text-[14px] text-ink-soft">Sarah is due for a color refresh and has a cut on Friday.</p>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <span className="num font-display text-[34px] font-medium leading-none text-plum">3</span>
              <Badge tone="plum">New client</Badge>
              <span className="rounded-full bg-plum px-1.5 text-[11px] font-semibold leading-5 text-white">2</span>
              <Button variant="primary" size="sm">Book</Button>
              <div className="w-40"><Toggle label="Example" checked onChange={() => undefined} /></div>
            </div>
          </div>
        </div>
      </div>
      {locked && <p className="mt-3 text-[13px] text-stone">Only administrators (with “Edit business settings”) can change the brand and appearance.</p>}
    </Card>
  );
}

/** Upload, replace or remove the salon's own font for headings or body text. Takes effect straight away. */
function FontUpload({ slot, name, locked, onDone }: { slot: FontSlot; name: string | null; locked: boolean; onDone: (r: { settings: AppSettings }) => void }) {
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const what = slot === 'heading' ? 'heading' : 'body text';
  const upload = async (f: File | undefined) => {
    if (!f) return;
    if (!/\.(woff2?|ttf|otf)$/i.test(f.name)) return toast('Choose a WOFF2, WOFF, TTF or OTF font file.', 'error');
    if (f.size > FONT_MAX_BYTES) return toast(`That font is ${(f.size / 1048576).toFixed(1)} MB. Use one under 1.5 MB (WOFF2 files are smallest).`, 'error');
    setBusy(true);
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result));
        r.onerror = () => reject(new Error('That file could not be read.'));
        r.readAsDataURL(f);
      });
      onDone(await api.put<{ settings: AppSettings }>(`/settings/font/${slot}`, { dataUrl, name: f.name }));
      toast(`Font for ${what} updated for everyone`);
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setBusy(false);
      if (input.current) input.current.value = '';
    }
  };
  const remove = async () => {
    try {
      onDone(await api.del<{ settings: AppSettings }>(`/settings/font/${slot}`));
      toast('Font removed');
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2">
      <input ref={input} type="file" accept=".woff2,.woff,.ttf,.otf,font/woff2,font/woff,font/ttf,font/otf" className="hidden" onChange={(e) => upload(e.target.files?.[0])} />
      <Button size="sm" variant="ghost" icon={<Type className="h-4 w-4" />} disabled={locked} loading={busy} onClick={() => input.current?.click()}>{name ? `Replace ${what} font` : `Upload ${what} font`}</Button>
      {name && <Button size="sm" variant="ghost" icon={<Trash2 className="h-4 w-4" />} disabled={locked} onClick={remove}>Remove</Button>}
    </div>
  );
}

function Section({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="border-b border-line py-5 first:pt-0 last:border-0">
      <p className="text-[14px] font-medium text-ink">{title}</p>
      {hint && <p className="mb-2 text-[13px] text-stone">{hint}</p>}
      <div className={hint ? '' : 'mt-2'}>{children}</div>
    </div>
  );
}

const STYLIST_COLORS = ['#9A6B7F', '#B5838D', '#A3716E', '#C08A5B', '#B08A5B', '#8F9E6B', '#7A8F6E', '#5F8F8A', '#6E8CA3', '#7B86B8', '#8C7BA8', '#9A8478', '#75716B'];

function StylistColors() {
  const { data: staff } = useStaff();
  const can = useCan();
  const qc = useQueryClient();
  const toast = useToast();
  const [saving, setSaving] = useState<string | null>(null);
  const editable = can('settings:read');
  const set = async (id: string, color: string) => {
    setSaving(id);
    try {
      await api.patch(`/staff/${id}`, { color });
      await qc.invalidateQueries({ queryKey: ['staff'] });
      qc.invalidateQueries({ queryKey: ['appointments'] });
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setSaving(null);
    }
  };
  const people = staff?.filter((s) => s.active) ?? [];
  return (
    <Card title="Stylist colours" description="Each stylist's colour on the appointment calendar and next to their name. Saved as soon as you pick one.">
      {people.length === 0 && <p className="text-sm text-stone">Stylists appear here once they're imported from Square.</p>}
      <ul className="divide-y divide-line">
        {people.map((s) => (
          <li key={s.id} className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between">
            <span className="flex items-center gap-2.5 text-[15px] text-ink"><Avatar name={s.name} color={s.color} size="sm" />{s.name}</span>
            <span className="flex flex-wrap items-center gap-1.5">
              {STYLIST_COLORS.map((c) => (
                <button key={c} type="button" disabled={!editable || saving === s.id} onClick={() => set(s.id, c)}
                  className={cx('h-6 w-6 rounded-full transition-transform hover:scale-110 disabled:cursor-not-allowed', s.color.toUpperCase() === c && 'ring-2 ring-ink/70 ring-offset-2')}
                  style={{ background: c }} aria-label={`${s.name}: colour ${c}`} />
              ))}
              <input type="color" disabled={!editable} value={s.color} onChange={(e) => set(s.id, e.target.value)} className="h-7 w-8 cursor-pointer rounded-md border border-line-strong bg-white p-0.5" aria-label={`Custom colour for ${s.name}`} />
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}
