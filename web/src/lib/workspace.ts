import { useQueryClient } from '@tanstack/react-query';
import { DEFAULT_MENU_GROUPS, DEFAULT_WORKSPACES, workspacesFor, type BusinessDef, type BusinessId, type PersonalLook } from '@addendum/shared';
import { api } from '../api/client';
import { useLook, useMe, useSettings } from '../api/hooks';

const LOCAL_KEY = 'addendum-workspace';
const readLocal = (): BusinessId | null => { try { const v = localStorage.getItem(LOCAL_KEY); return v === 'salon' || v === 'hair' ? v : null; } catch { return null; } };

export type Workspace = BusinessDef & { name: string; tagline: string };

/**
 * The business workspace this person is in (Addendum Salon or Addendum Hair): its name, look and defaults. It's a lens,
 * not a lock — what they can open still follows their permissions, and the server checks every request. Remembered on
 * their account (and this device), so it opens where they left off.
 */
export function useWorkspace() {
  const { data: me } = useMe();
  const { data: look } = useLook();
  const { data: settings } = useSettings();
  const qc = useQueryClient();
  const names = { ...DEFAULT_WORKSPACES.businesses, ...(settings?.settings.workspaces?.businesses ?? {}) };
  const decorate = (b: BusinessDef): Workspace => ({ ...b, name: names[b.id]?.name || b.name, tagline: names[b.id]?.tagline ?? b.tagline });
  const available = workspacesFor(me?.permissions ?? []).map(decorate);
  const wanted = look?.workspace ?? readLocal();
  const current = available.find((b) => b.id === wanted) ?? available[0];
  const switchTo = async (id: BusinessId) => {
    try { localStorage.setItem(LOCAL_KEY, id); } catch { /* private window */ }
    qc.setQueryData<PersonalLook>(['look'], (old) => ({ ...(old ?? { accent: null, mode: null, theme: null }), workspace: id }));
    await api.put('/look', { workspace: id }).catch(() => undefined);
  };
  /** Which section a sidebar tab is in (Settings → Businesses → Menu); 'shared' = both. */
  const navScope = (path: string): BusinessId | 'shared' => ({ ...DEFAULT_MENU_GROUPS, ...(settings?.settings.workspaces?.groups ?? {}) })[path] ?? 'shared';
  return { current, available, switchTo, navScope, names };
}

/** A page's own business choice (?for= / ?business=), else the workspace's. */
export function pageBusiness(params: URLSearchParams, key: 'for' | 'business', workspace: BusinessId): BusinessId {
  const v = params.get(key);
  return v === 'hair' || v === 'salon' ? v : workspace;
}

