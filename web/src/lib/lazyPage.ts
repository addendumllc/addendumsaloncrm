import { lazy, type ComponentType } from 'react';

/**
 * A page loaded when it's first opened. After an update the old file names are gone, so a tab that was open from
 * before gets "Failed to fetch dynamically imported module" — reload once to pick up the new version instead.
 */
const RELOADED = 'addendum:reloaded-for-update';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function lazyPage<T extends ComponentType<any>>(load: () => Promise<{ default: T }>) {
  return lazy(() => load().then((m) => {
    try { sessionStorage.removeItem(RELOADED); } catch { /* private window */ }
    return m;
  }).catch((e) => {
    let tried = true;
    try { tried = !!sessionStorage.getItem(RELOADED); if (!tried) sessionStorage.setItem(RELOADED, '1'); } catch { /* private window */ }
    if (!tried) { window.location.reload(); return new Promise<never>(() => {}); }
    throw e;
  }));
}
