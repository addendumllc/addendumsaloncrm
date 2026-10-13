import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { DEFAULT_ACCENT } from '@addendum/shared';
import { Check, Info } from 'lucide-react';
import { api } from '../../api/client';
import { useSettings, useStaff } from '../../api/hooks';
import { ACCENT_PRESETS, applyAccent, contrastWithWhite, isHex, readableAccent } from '../../lib/theme';
import { Avatar, Badge, Button, cx, Toggle, useToast } from '../../components/ui';
import { Card, SaveBar, useCan, useSection } from './shared';

/** Colour settings: the app's accent colour and each stylist's calendar colour. */
export function AppearanceSettings() {
  return (
    <div className="space-y-6">
      <AccentCard />
      <StylistColors />
    </div>
  );
}

function AccentCard() {
  const a = useSection('appearance');
  const { data: settings } = useSettings();
  const can = useCan();
  const locked = !can('*');
  const saved = settings?.settings.appearance?.accent ?? DEFAULT_ACCENT;
  const [hexInput, setHexInput] = useState('');
  const accent = a.draft?.accent ?? saved;

  // Live preview while choosing; put the saved colour back if the owner leaves without saving.
  useEffect(() => applyAccent(accent), [accent]);
  useEffect(() => () => applyAccent(saved), [saved]);
  useEffect(() => setHexInput(accent.toUpperCase()), [accent]);

  if (!a.draft) return null;
  const pick = (hex: string) => a.set('accent', hex.toUpperCase());
  const tooLight = contrastWithWhite(accent) < 4.5;

  return (
    <Card
      title="Accent colour"
      description="Used for highlights, badges, toggles and the Demo banner across the app — for everyone on the team."
      footer={<SaveBar dirty={a.dirty} saving={a.saving} onSave={() => a.save()} onReset={a.reset} disabled={locked} />}
    >
      <div className="grid grid-cols-5 gap-3 sm:grid-cols-10">
        {ACCENT_PRESETS.map((p) => {
          const on = accent.toUpperCase() === p.hex.toUpperCase();
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

      <div className="mt-5 flex flex-wrap items-end gap-3 border-t border-line pt-4">
        <label className="block">
          <span className="label">Custom colour</span>
          <span className="flex items-center gap-2">
            <input type="color" disabled={locked} value={accent} onChange={(e) => pick(e.target.value)} className="h-10 w-12 cursor-pointer rounded-lg border border-line-strong bg-white p-1" aria-label="Pick a custom colour" />
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
        {accent.toUpperCase() !== DEFAULT_ACCENT && !locked && <Button variant="ghost" onClick={() => pick(DEFAULT_ACCENT)}>Reset to plum</Button>}
      </div>
      {tooLight && (
        <p className="mt-3 flex items-start gap-2 rounded-lg bg-amber-tint px-3 py-2 text-[13px] text-amber">
          <Info className="mt-0.5 h-4 w-4 shrink-0" />This colour is too light for white text, so the app uses a deeper shade ({readableAccent(accent)}) to keep buttons and badges readable.
        </p>
      )}

      <div className="mt-5 rounded-xl border border-line bg-paper p-4">
        <p className="mb-3 text-[11px] font-semibold uppercase tracking-wider text-stone">Preview</p>
        <div className="flex flex-wrap items-center gap-3">
          <span className="num font-display text-[34px] font-medium leading-none text-plum">3</span>
          <Badge tone="plum">New lead</Badge>
          <span className="rounded-full bg-plum px-1.5 text-[11px] font-semibold leading-5 text-white">2</span>
          <Button variant="quiet" size="sm">Draft it for me</Button>
          <span className="rounded-md bg-plum px-3 py-1 text-[13px] text-white">Demo Mode</span>
          <div className="w-44"><Toggle label="Example switch" checked onChange={() => undefined} /></div>
        </div>
      </div>
      {locked && <p className="mt-3 text-[13px] text-stone">Only the owner can change the accent colour.</p>}
    </Card>
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
