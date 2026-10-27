import { useQuery } from '@tanstack/react-query';
import { CONTENT_FORMATS, CONTENT_PLATFORMS, CONTENT_STATUSES, type ContentAccount, type ContentAccountId, type ContentCampaignDTO, type ContentSettings, type ContentStatus } from '@addendum/shared';
import { api } from '../../api/client';
import { useCanDo, useStaff } from '../../api/hooks';

export const STATUS_TONE: Record<ContentStatus, 'neutral' | 'amber' | 'plum' | 'sage' | 'rose'> = {
  idea: 'neutral', draft: 'neutral', in_review: 'amber', changes_requested: 'rose', approved: 'sage', scheduled: 'plum', publishing: 'plum', published: 'sage', failed: 'rose',
};
export const statusLabel = (s: ContentStatus) => CONTENT_STATUSES.find((x) => x.value === s)?.label ?? s;
export const formatLabel = (f: string) => CONTENT_FORMATS.find((x) => x.value === f)?.label ?? f;
export const platformLabel = (p: string) => CONTENT_PLATFORMS.find((x) => x.value === p)?.label ?? p;
export const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
/** datetime-local value ↔ ISO. */
export const toLocal = (iso: string | null) => (iso ? (() => { const d = new Date(iso); return `${ymd(d)}T${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; })() : '');
export const fromLocal = (v: string) => (v ? new Date(v).toISOString() : null);
export const timeOf = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

/** Accounts (and the ones this person works on), campaigns, staff, settings and what they may do. */
export function useContentBasics() {
  const canDo = useCanDo();
  const can = (p: string) => canDo(p) || canDo('*');
  const accounts = useQuery({ queryKey: ['content-accounts'], queryFn: () => api.get<{ accounts: ContentAccount[]; mine: ContentAccountId[] }>('/content/accounts') });
  const campaigns = useQuery({ queryKey: ['content-campaigns'], queryFn: () => api.get<{ campaigns: ContentCampaignDTO[] }>('/content/campaigns').then((r) => r.campaigns) });
  const settings = useQuery({ queryKey: ['content-settings'], queryFn: () => api.get<{ settings: ContentSettings }>('/content/settings').then((r) => r.settings) });
  const { data: staff } = useStaff();
  const all = accounts.data?.accounts ?? [];
  const mine = all.filter((a) => accounts.data?.mine.includes(a.id));
  return {
    accounts: all, mine, accountOf: (id: string) => all.find((a) => a.id === id), campaigns: campaigns.data ?? [], settings: settings.data,
    staff: (staff ?? []).filter((s) => s.active), loading: accounts.isLoading,
    canApprove: can('content:approve'), canPublish: can('content:publish'), isAdmin: can('settings:write'),
  };
}
export type Basics = ReturnType<typeof useContentBasics>;

/** An account's label: its colour dot and name. */
export function AccountTag({ a, small }: { a?: ContentAccount; small?: boolean }) {
  if (!a) return null;
  return <span className={`inline-flex items-center gap-1.5 ${small ? 'text-[11px]' : 'text-[13px]'} text-ink-soft`}><span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: a.color }} />{a.name}</span>;
}
