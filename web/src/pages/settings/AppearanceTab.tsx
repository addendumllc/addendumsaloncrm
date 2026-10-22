import { useEffect, useRef, useState } from 'react';
import { tc } from '../../lib/titleCase';
import { useQueryClient } from '@tanstack/react-query';
import { DEFAULT_APPEARANCE, FONT_CHOICES, FONT_SLOTS, FONT_MAX_BYTES, LOGO_MAX_BYTES, fontFile, logoUrl, type AppSettings, type Appearance, type FontSlot } from '@addendum/shared';
import { ImageIcon, Trash2, Type, Upload } from 'lucide-react';
import { api } from '../../api/client';
import { useSettings, useStaff } from '../../api/hooks';
import { USER_COLORS, applyAppearance, isHex } from '../../lib/theme';
import { Avatar, Button, cx, Field, Segmented, Toggle, useToast } from '../../components/ui';
import { Card, SaveBar, useCan, useSection } from './shared';
import { useStoreNames } from '../../lib/storeNames';

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
  const names = useStoreNames();
  const locked = !can('settings:write');
  const saved = { ...DEFAULT_APPEARANCE, ...(settings?.settings.appearance ?? {}) };
  const d = { ...DEFAULT_APPEARANCE, ...(a.draft ?? {}) };
  const [uploading, setUploading] = useState(false);
  const file = useRef<HTMLInputElement>(null);

  // Live preview while choosing; put the saved look back if the page is left without saving.
  const draftKey = JSON.stringify(d);
  const savedKey = JSON.stringify(saved);
  useEffect(() => { applyAppearance(d); }, [draftKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => applyAppearance(JSON.parse(savedKey)), [savedKey]);

  if (!a.draft) return null;
  const set = <K extends keyof Appearance>(k: K, v: Appearance[K]) => a.set(k, v);

  // Uploads apply straight away; copy the server's new values into the draft so nothing shows as unsaved.
  const SERVER_FIELDS = ['logoVersion', 'headingFont', 'headingFontName', 'headingFontVersion', 'bodyFont', 'bodyFontName', 'bodyFontVersion', 'fonts', 'fontFiles'] as const;
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
      title="Logo, name & brand fonts"
      description="Shown to everyone on the team and on the sign-in screen."
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


      <Section title="Brand fonts" hint="Upload your brand fonts (WOFF2, WOFF, TTF or OTF; check the licence allows web use). They then appear as choices in Theme Management and in each person’s font settings.">
        <div className="space-y-2">
          {FONT_SLOTS.filter(({ slot }) => slot === 'heading' || slot === 'body').map(({ slot, label }) => {
            const file = fontFile(d, slot);
            return (
              <div key={slot} className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-white px-3 py-2">
                <span className="min-w-[8rem] flex-1 text-[13px] text-ink">{label}{file && <span className="ml-2 text-stone">— {file.name}</span>}</span>
                <FontUpload slot={slot} name={file?.name ?? null} locked={locked} onDone={afterUpload} />
              </div>
            );
          })}
        </div>
      </Section>


      {locked && <p className="mt-3 text-[13px] text-stone">Only administrators (with “Edit business settings”) can change the brand and appearance.</p>}
    </Card>
  );
}

/** Upload, replace or remove the salon's own font for headings or body text. Takes effect straight away. */
function FontUpload({ slot, name, locked, onDone }: { slot: FontSlot; name: string | null; locked: boolean; onDone: (r: { settings: AppSettings }) => void }) {
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const what = FONT_SLOTS.find((x) => x.slot === slot)?.label.toLowerCase() ?? 'text';
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
      <p className="text-[14px] font-medium text-ink">{tc(title)}</p>
      {hint && <p className="mb-2 text-[13px] text-stone">{hint}</p>}
      <div className={hint ? '' : 'mt-2'}>{children}</div>
    </div>
  );
}

const STYLIST_COLORS = USER_COLORS;

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
    <Card title="User Colors" description="Each person's colour on the appointment calendar and next to their name. Saved as soon as you pick one.">
      {people.length === 0 && <p className="text-sm text-stone">Stylists appear here once they're imported from Square.</p>}
      <ul className="divide-y divide-line">
        {people.map((s) => (
          <li key={s.id} className="grid gap-3 py-3 sm:grid-cols-[180px_minmax(0,1fr)] sm:items-center">
            {/* Fixed name column and a fixed swatch grid, so every row's colours line up. */}
            <span className="flex min-w-0 items-center gap-2.5 text-[15px] text-ink"><Avatar name={s.name} color={s.color} size="sm" /><span className="truncate">{s.name}</span></span>
            <span className="flex flex-col gap-2">
              <span className="grid w-max grid-cols-[repeat(8,1.5rem)] gap-2 md:grid-cols-[repeat(12,1.5rem)]">
                {STYLIST_COLORS.map((c) => (
                  <button key={c} type="button" disabled={!editable || saving === s.id} onClick={() => set(s.id, c)}
                    className={cx('h-6 w-6 rounded-full transition-transform hover:scale-110 disabled:cursor-not-allowed', s.color.toUpperCase() === c && 'ring-2 ring-ink/70 ring-offset-2')}
                    style={{ background: c }} aria-label={`${s.name}: colour ${c}`} />
                ))}
              </span>
              <label className="flex items-center gap-1.5 text-[12px] text-stone" title="Any colour">
                <input type="color" disabled={!editable} value={s.color} onChange={(e) => set(s.id, e.target.value)} className="h-7 w-8 cursor-pointer rounded-md border border-line-strong bg-white p-0.5" aria-label={`Custom colour for ${s.name}`} />Custom colour
              </label>
            </span>
          </li>
        ))}
      </ul>
    </Card>
  );
}
