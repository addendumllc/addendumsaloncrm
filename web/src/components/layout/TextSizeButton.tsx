import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import type { ColorMode, PersonalLook } from '@addendum/shared';
import { api } from '../../api/client';
import { useLook } from '../../api/hooks';
import { TEXT_MAX, TEXT_MIN, TEXT_PRESETS, TEXT_STEP, useTextSize } from '../../lib/textSize';
import { applyPersonalLook } from '../../lib/theme';
import { cx, useToast } from '../ui';

/** This person's own look (saved to their account): saves only the parts given. */
export function useMyLook() {
  const { data } = useLook();
  const qc = useQueryClient();
  const toast = useToast();
  const look: PersonalLook = data ?? { accent: null, mode: null, theme: null };
  const save = async (patch: Partial<PersonalLook>) => {
    const next = { ...look, ...patch };
    applyPersonalLook(next);
    qc.setQueryData(['look'], next);
    try {
      await api.put('/look', patch);
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  return { look, save };
}

const MODES: [ColorMode | null, string][] = [['light', 'Light'], ['dark', 'Dark'], ['auto', 'System']];

/**
 * Display (this device's text size; light, dark or system on their account). Colours are in Settings → Appearance &
 * Display, so there's one place to choose them.
 */
export function DisplayChoices({ compact }: { compact?: boolean }) {
  const [size, setSize] = useTextSize();
  const { look, save } = useMyLook();
  const head = 'px-2 pt-2 pb-1 text-[11px] uppercase tracking-wide text-stone';
  const item = (on: boolean) => cx('flex w-full items-center justify-between px-2 py-1.5 text-left text-[14px]', on ? 'bg-mist font-medium text-ink' : 'text-ink-soft hover:bg-mist/60');
  return (
    <div className="space-y-4">
      <div>
        <p className={head}>Text size (this device)</p>
        <div className="px-2">
          <div className="flex items-center gap-2">
            <button type="button" className="h-8 w-8 border border-line-strong text-[13px] text-ink-soft hover:bg-mist disabled:opacity-40" disabled={size <= TEXT_MIN} onClick={() => setSize(size - TEXT_STEP)} aria-label="Smaller text">A−</button>
            <input type="range" min={TEXT_MIN} max={TEXT_MAX} step={TEXT_STEP} value={size} onChange={(e) => setSize(Number(e.target.value))} className="min-w-0 flex-1 accent-plum" aria-label="Text size" />
            <button type="button" className="h-8 w-8 border border-line-strong text-[15px] text-ink-soft hover:bg-mist disabled:opacity-40" disabled={size >= TEXT_MAX} onClick={() => setSize(size + TEXT_STEP)} aria-label="Larger text">A+</button>
            <span className="num w-12 text-right text-[13px] text-ink">{size}%</span>
          </div>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {TEXT_PRESETS.map((p) => (
              <button key={p.value} type="button" onClick={() => setSize(p.value)} aria-pressed={size === p.value}
                className={cx('px-2.5 py-1 text-[12px]', size === p.value ? 'bg-plum text-white' : 'bg-mist text-ink-soft hover:bg-line')}>{p.label}</button>
            ))}
          </div>
          {!compact && <p className="mt-2 text-[12px] text-stone">For reading comfort on this phone or computer; it scales the whole page evenly.</p>}
        </div>
      </div>
      {compact && (
        <div>
          <p className={head}>Light or dark</p>
          {MODES.map(([v, l]) => (
            <button key={l} type="button" role="menuitemradio" aria-checked={(look.mode ?? 'light') === v} onClick={() => save({ mode: v })} className={item((look.mode ?? 'light') === v)}>{l}</button>
          ))}
          <Link to="/settings?tab=display" className="block px-2 py-1.5 text-[13px] text-plum hover:underline">Colors…</Link>
        </div>
      )}
    </div>
  );
}

/** "Aa": this person's display — text size (this device), light/dark and accent (their account). */
export function TextSizeButton({ up = true }: { up?: boolean }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <button type="button" onClick={() => setOpen(!open)} className="rounded p-2 font-display text-[16px] leading-none text-stone hover:text-ink lg:p-1" title="Display" aria-label="Display: text size and colours" aria-expanded={open}>Aa</button>
      {open && (
        <div className={cx('absolute z-50 max-h-[70vh] w-56 overflow-y-auto rounded-xl border border-line bg-white p-1 shadow-pop', up ? 'bottom-full left-0 mb-2' : 'right-0 top-full mt-2')} role="menu">
          <DisplayChoices compact />
        </div>
      )}
    </div>
  );
}
