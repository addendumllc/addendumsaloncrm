import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { DEFAULT_APPEARANCE, DEFAULT_THEME_SETTINGS, fontFile, resolveTheme, themesFor, type ColorMode, type PersonalLook, type ThemeColors, type ThemeCustom } from '@addendum/shared';
import { api } from '../../api/client';
import { useLook, useMe, useSettings } from '../../api/hooks';
import { USER_COLORS, applyPersonalLook } from '../../lib/theme';
import { ButtonFields, COLOR_FIELDS, ColorField, LivePreview, ThemeCard, TypeFields, suggestColors, SidebarOpacityField } from '../../components/domain/ThemeFields';
import { Button, Segmented, cx, useToast } from '../../components/ui';

/** A section of the Appearance page. */
function Part({ title, hint, children, locked }: { title: string; hint: string; children: React.ReactNode; locked?: string }) {
  return (
    <section className="border-t border-line pt-6 first:border-0 first:pt-0">
      <h3 className="h-display text-[20px]">{title}</h3>
      <p className="mb-4 mt-1 text-[13px] text-stone">{locked ?? hint}</p>
      {!locked && children}
    </section>
  );
}

/**
 * Your appearance (only you, saved to your account): a theme published by an administrator (or the default), then —
 * where your organization allows — your own colours, fonts and text sizes, and button size and corners; plus light,
 * dark or system. The layout and components are the same for everyone. Changes preview live; nothing is kept until Save.
 */
export function MyAppearance() {
  const { data: saved } = useLook();
  const { data: settings } = useSettings();
  const { data: me } = useMe();
  const qc = useQueryClient();
  const toast = useToast();
  const org = { ...DEFAULT_APPEARANCE, ...(settings?.settings.appearance ?? {}) };
  const ts = { ...DEFAULT_THEME_SETTINGS, ...(org.themeSettings ?? {}) };
  const offered = themesFor(ts, me?.role);
  const base: PersonalLook = saved ?? { accent: null, mode: null, theme: null };
  // An accent chosen before themes existed becomes their own accent here.
  const start: PersonalLook = { ...base, custom: base.custom ?? (base.accent ? { colors: { accent: base.accent } } : {}), accent: null };
  const [draft, setDraft] = useState<PersonalLook | null>(null);
  const d = draft ?? start;
  const [saving, setSaving] = useState(false);
  const dirty = !!draft && JSON.stringify(draft) !== JSON.stringify(start);
  const r = resolveTheme(ts, d, me?.role);
  const theme = resolveTheme(ts, { themeId: d.themeId }, me?.role); // the theme alone (the "theme's" values)
  const custom: ThemeCustom = d.custom ?? {};
  const setCustom = (c: ThemeCustom) => setDraft({ ...d, custom: c });
  const setColor = (k: keyof ThemeColors, v: string | undefined) => { const colors = { ...(custom.colors ?? {}) }; if (v) colors[k] = v; else delete colors[k]; setCustom({ ...custom, colors }); };
  const [more, setMore] = useState(() => !!Object.keys(start.custom?.colors ?? {}).some((k) => k !== 'accent' && k !== 'accent2'));
  // Their calendar colour (Calendar color, below): offered as an accent.
  const { data: profile } = useQuery({ queryKey: ['my-profile'], queryFn: () => api.get<{ profile: { color: string | null } }>('/my-profile').then((r) => r.profile) });

  // Live preview across the whole app; the saved look comes back when leaving without saving.
  const key = JSON.stringify(d);
  useEffect(() => { if (draft) applyPersonalLook(draft); }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const savedKey = JSON.stringify(base);
  useEffect(() => () => applyPersonalLook(JSON.parse(savedKey)), [savedKey]);

  const save = async () => {
    setSaving(true);
    try {
      const res = await api.put<{ look: PersonalLook }>('/look', { themeId: d.themeId ?? null, custom: d.custom ?? {}, mode: d.mode ?? null, accent: null });
      qc.setQueryData(['look'], res.look);
      setDraft(null);
      toast('Appearance saved');
    } catch (e) {
      toast((e as Error).message, 'error');
    } finally {
      setSaving(false);
    }
  };
  const cancel = () => { setDraft(null); applyPersonalLook(base); };
  const reset = () => setDraft({ ...d, themeId: null, custom: {} });
  const def = ts.themes.find((x) => x.id === ts.defaultTheme);
  const locked = 'Your organization uses the theme’s settings for this.';

  return (
    <div className="border border-line bg-white">
      <div className="space-y-6 p-5">
        <Part title="Theme" hint="Themes published by your administrator. Pick one, then adjust it below if you like.">
          <div className="-mx-1.5 flex flex-wrap gap-1">
            {def && <ThemeCard t={def} badge="Default" on={!d.themeId} onPick={() => setDraft({ ...d, themeId: null })} />}
            {offered.filter((x) => x.id !== ts.defaultTheme).map((t) => <ThemeCard key={t.id} t={t} on={d.themeId === t.id} onPick={() => setDraft({ ...d, themeId: t.id })} />)}
          </div>
        </Part>
        <Part title="Colors" hint="Your own accent colours over the theme — from the calendar colours, your own calendar colour, or any colour. The layout never changes." locked={ts.allow.colors ? undefined : locked}>
          {/* Accents first: the calendar colours, your own calendar colour, or any colour. */}
          <div className="border border-line px-4 py-1">
            {COLOR_FIELDS.filter((f) => f.key === 'accent' || f.key === 'accent2').map((f) => (
              <ColorField key={f.key} field={f.key} label={f.label} hint={f.hint} value={custom.colors?.[f.key]} fallback={theme.colors[f.key]} swatches={USER_COLORS}
                suggestions={suggestColors(f.key, r.colors)}
                action={profile?.color ? { label: 'Use my calendar color', color: profile.color } : undefined}
                onChange={(v) => setColor(f.key, v)} />
            ))}
          </div>
          <button type="button" onClick={() => setMore((v) => !v)} aria-expanded={more} className="mt-3 text-[13px] font-medium text-plum hover:underline">
            {more ? 'Hide' : 'Show'} background, sidebar (and its opacity), cards, text and borders
          </button>
          {more && (
            <div className="mt-2 border border-line px-4 py-1">
              {COLOR_FIELDS.filter((f) => f.key !== 'accent' && f.key !== 'accent2').map((f) => (
                <ColorField key={f.key} field={f.key} label={f.label} hint={f.hint} value={custom.colors?.[f.key]} fallback={theme.colors[f.key]} suggestions={suggestColors(f.key, r.colors)} onChange={(v) => setColor(f.key, v)}>
                  {f.key === 'sidebar' && (
                    <SidebarOpacityField value={r.sidebarOpacity} fromTheme={theme.sidebarOpacity}
                      onChange={(v) => { const next = { ...custom }; if (v == null) delete next.sidebarOpacity; else next.sidebarOpacity = v; setCustom(next); }} />
                  )}
                </ColorField>
              ))}
            </div>
          )}
        </Part>
        <Part title="Fonts & text size" hint="The interface font and sizes for text, headings and small labels — applied evenly across the CRM." locked={ts.allow.type ? undefined : locked}>
          <TypeFields value={r.type} onChange={(p) => setCustom({ ...custom, type: { ...(custom.type ?? {}), ...p } })}
            customFonts={{ heading: fontFile(org, 'heading')?.name, body: fontFile(org, 'body')?.name }} />
        </Part>
        <Part title="Buttons" hint="One size and corner style for every button." locked={ts.allow.buttons ? undefined : locked}>
          <ButtonFields value={r.buttons} onChange={(p) => setCustom({ ...custom, buttons: { ...(custom.buttons ?? {}), ...p } })} />
        </Part>
        <section className="border-t border-line pt-6">
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.08em] text-stone">Preview</p>
          <LivePreview />
        </section>
        <Part title="Display" hint="Light, dark or following your device. The layout and sizes stay the same.">
          <Segmented value={(d.mode ?? 'light') as ColorMode} onChange={(m) => setDraft({ ...d, mode: m })} options={[{ value: 'light', label: 'Light' }, { value: 'dark', label: 'Dark' }, { value: 'auto', label: 'System' }]} />
        </Part>
      </div>
      <div className={cx('sticky bottom-0 flex flex-wrap items-center gap-2 border-t border-line bg-white px-5 py-3')}>
        {dirty ? <span className="text-[13px] text-amber">Unsaved changes — previewing now</span> : <span className="text-[13px] text-stone">Saved to your account</span>}
        <Button variant="ghost" className="ml-auto" onClick={reset}>Reset to default</Button>
        <Button variant="ghost" disabled={!dirty} onClick={cancel}>Cancel</Button>
        <Button variant="primary" disabled={!dirty} loading={saving} onClick={save}>Save changes</Button>
      </div>
    </div>
  );
}
