import { useEffect, useState } from 'react';

/**
 * Text size for this device (each person picks what's comfortable), as a percentage: 80%–150% in 5% steps. The app's
 * type uses fixed pixel sizes, so the page content and dialogs scale together with CSS zoom (`.app-content`) — text
 * and spacing grow in step, nothing clips.
 */
export const TEXT_MIN = 70;
export const TEXT_MAX = 150;
export const TEXT_STEP = 5;
export const TEXT_PRESETS: { value: number; label: string }[] = [
  { value: 80, label: 'Compact' }, { value: 90, label: 'Smaller' }, { value: 100, label: 'Default' }, { value: 110, label: 'Larger' }, { value: 125, label: 'Largest' },
];
const KEY = 'addendum.textSize';
const EVENT = 'addendum:text-size';
/** Sizes saved before the slider existed. */
const LEGACY: Record<string, number> = { small: 92, default: 100, large: 110, xlarge: 122 };
const clamp = (n: number) => Math.min(TEXT_MAX, Math.max(TEXT_MIN, Math.round(n)));

export function getTextSize(): number {
  try {
    const v = localStorage.getItem(KEY);
    if (!v) return 100;
    if (v in LEGACY) return LEGACY[v];
    const n = Number(v);
    return Number.isFinite(n) ? clamp(n) : 100;
  } catch {
    return 100;
  }
}

export function applyTextSize(percent: number = getTextSize()) {
  document.documentElement.style.setProperty('--content-zoom', String(clamp(percent) / 100));
}

export function setTextSize(percent: number) {
  const p = clamp(percent);
  try {
    localStorage.setItem(KEY, String(p));
  } catch {
    /* private mode: still applies for this visit */
  }
  applyTextSize(p);
  window.dispatchEvent(new CustomEvent(EVENT));
}

export function useTextSize() {
  const [size, setSize] = useState<number>(getTextSize);
  useEffect(() => {
    const on = () => setSize(getTextSize());
    window.addEventListener(EVENT, on);
    return () => window.removeEventListener(EVENT, on);
  }, []);
  return [size, setTextSize] as const;
}

/**
 * Button size for this device: compact (smaller buttons, more on screen), standard, or large (easier to tap). Applied
 * with a data attribute the button styles read (index.css), separate from the text size.
 */
export type ButtonSize = 'compact' | 'standard' | 'large';
export const BUTTON_SIZES: { value: ButtonSize; label: string }[] = [{ value: 'compact', label: 'Compact' }, { value: 'standard', label: 'Standard' }, { value: 'large', label: 'Large' }];
const BTN_KEY = 'addendum.buttonSize';
export function getButtonSize(): ButtonSize {
  try { const v = localStorage.getItem(BTN_KEY); return v === 'compact' || v === 'large' ? v : 'standard'; } catch { return 'standard'; }
}
export function applyButtonSize(size: ButtonSize = getButtonSize()) {
  // Button size comes from the theme now (Settings → Appearance); an older per-device choice is ignored.
  void size;
}
export function setButtonSize(size: ButtonSize) {
  try { localStorage.setItem(BTN_KEY, size); } catch { /* private mode: still applies for this visit */ }
  applyButtonSize(size);
  window.dispatchEvent(new CustomEvent(EVENT));
}
export function useButtonSize() {
  const [size, setSize] = useState<ButtonSize>(getButtonSize);
  useEffect(() => {
    const on = () => setSize(getButtonSize());
    window.addEventListener(EVENT, on);
    return () => window.removeEventListener(EVENT, on);
  }, []);
  return [size, setButtonSize] as const;
}
