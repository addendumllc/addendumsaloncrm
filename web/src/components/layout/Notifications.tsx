import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Bell } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import { useSettings } from '../../api/hooks';
import { relative } from '../../lib/format';
import { cx } from '../ui';

interface Updates { now: string; unreadMessages: number; unreadNotifications: number; newNotifications: { id: string; title: string; body: string | null; link: string | null }[] }

/** Polls for new texts/Square changes; shows browser notifications if the salon enabled them. */
export function useUpdates() {
  const since = useRef(new Date().toISOString());
  const qc = useQueryClient();
  const { data: settings } = useSettings();
  const { data } = useQuery({
    queryKey: ['updates'],
    queryFn: async () => {
      const r = await api.get<Updates>(`/updates?since=${encodeURIComponent(since.current)}`);
      since.current = r.now;
      return r;
    },
    refetchInterval: 20_000,
  });
  useEffect(() => {
    if (!data?.newNotifications.length) return;
    for (const k of ['conversations', 'dashboard', 'tasks', 'appointments']) qc.invalidateQueries({ queryKey: [k] });
    const browser = settings?.settings.notifications?.browser !== false;
    if (browser && 'Notification' in window && Notification.permission === 'granted' && document.hidden) {
      for (const n of data.newNotifications.slice(0, 3)) new Notification(n.title, { body: n.body ?? undefined, tag: n.id });
    }
  }, [data, qc, settings]);
  return data;
}

export function Notifications({ count }: { count: number }) {
  const [open, setOpen] = useState(false);
  const nav = useNavigate();
  const qc = useQueryClient();
  const ref = useRef<HTMLDivElement>(null);
  const { data } = useQuery({
    queryKey: ['notifications', open],
    queryFn: () => api.get<{ notifications: { id: string; title: string; body: string | null; link: string | null; read: boolean; createdAt: string }[] }>('/notifications').then((r) => r.notifications),
    enabled: open,
  });
  useEffect(() => {
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);
  const toggle = async () => {
    const next = !open;
    setOpen(next);
    if (next && 'Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => undefined);
    if (!next && count > 0) {
      await api.post('/notifications/read-all').catch(() => undefined);
      qc.invalidateQueries({ queryKey: ['updates'] });
    }
  };
  return (
    <div className="relative" ref={ref}>
      <button onClick={toggle} className="relative rounded-lg p-2 text-ink-soft hover:bg-mist" aria-label={`Notifications${count ? ` (${count} new)` : ''}`}>
        <Bell className="h-5 w-5" />
        {count > 0 && <span className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-plum" />}
      </button>
      {open && (
        <div className="absolute right-0 z-40 mt-1 w-[min(360px,90vw)] rounded-xl border border-line bg-white py-2 shadow-pop animate-rise">
          <p className="px-4 pb-2 font-display text-lg">Activity</p>
          <div className="max-h-[60vh] overflow-y-auto">
            {data?.length === 0 && <p className="px-4 py-6 text-center text-sm text-stone">You're all caught up.</p>}
            {data?.map((n) => (
              <button key={n.id} onClick={() => { setOpen(false); if (n.link) nav(n.link); }} className={cx('block w-full px-4 py-2.5 text-left hover:bg-mist', !n.read && 'bg-plum-tint/50')}>
                <span className="block text-sm text-ink">{n.title}</span>
                {n.body && <span className="block truncate text-xs text-stone">{n.body}</span>}
                <span className="text-[11px] text-stone-light">{relative(n.createdAt)}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
