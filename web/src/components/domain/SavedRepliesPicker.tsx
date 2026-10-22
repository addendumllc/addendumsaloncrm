import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { MessageSquareText, Search, Settings2 } from 'lucide-react';
import { REPLY_SITUATIONS, type ReplySituation, type SuggestedReply } from '@addendum/shared';
import { api } from '../../api/client';
import { useMe } from '../../api/hooks';
import { Button, Spinner, cx } from '../ui';

export interface ReplyContext {
  clientId?: string | null;
  leadId?: string | null;
  conversationId?: string | null;
  taskId?: string | null;
}

const situationLabel = (s: ReplySituation) => REPLY_SITUATIONS.find((x) => x.value === s)?.label ?? s;

/**
 * "Saved replies" button + panel. Shows the salon's own replies, filled in for this person, with the ones
 * that fit the situation (the follow-up type or what their last text was about) at the top.
 */
export function SavedRepliesPicker({ context, onPick, placement = 'down', size = 'sm', className }: {
  context: ReplyContext;
  onPick: (text: string) => void;
  /** 'inline' shows the list in the page flow (use inside scrolling modals). */
  placement?: 'up' | 'down' | 'inline';
  size?: 'sm' | 'md';
  className?: string;
}) {
  const { data: me } = useMe();
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [data, setData] = useState<{ situation: ReplySituation; replies: SuggestedReply[] } | null>(null);
  const [q, setQ] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  const canManage = !!me && (me.permissions.includes('*') || me.permissions.includes('settings:rules'));

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    api.post<{ situation: ReplySituation; replies: SuggestedReply[] }>('/messages/replies/suggest', {
      clientId: context.clientId ?? undefined, leadId: context.leadId ?? undefined,
      conversationId: context.conversationId ?? undefined, taskId: context.taskId ?? undefined,
    }).then(setData, () => setData({ situation: 'general', replies: [] })).finally(() => setLoading(false));
  }, [open, context.clientId, context.leadId, context.conversationId, context.taskId]);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => placement !== 'inline' && !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopImmediatePropagation();
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc, true);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc, true);
    };
  }, [open]);

  const filtered = useMemo(() => {
    const all = data?.replies ?? [];
    const term = q.trim().toLowerCase();
    return term ? all.filter((r) => `${r.title} ${r.body}`.toLowerCase().includes(term)) : all;
  }, [data, q]);
  const suggested = filtered.filter((r) => r.matches);
  const others = filtered.filter((r) => !r.matches);

  const pick = (r: SuggestedReply) => {
    onPick(r.text);
    setOpen(false);
    setQ('');
  };

  return (
    <div className={cx('relative', className)} ref={ref}>
      <Button variant="secondary" size={size} className={size === 'md' ? 'h-11' : undefined} icon={<MessageSquareText className="h-4 w-4 text-plum" />} onClick={() => setOpen((o) => !o)} aria-expanded={open} title="Choose a saved reply">
        <span className={size === 'md' ? 'hidden sm:inline' : undefined}>Saved replies</span>
      </Button>
      {open && placement !== 'inline' && <div className="fixed inset-0 z-[55] bg-ink/30 sm:hidden" onClick={() => setOpen(false)} aria-hidden="true" />}
      {open && (
        <div
          role="dialog" aria-label="Saved replies"
          className={cx(
            'rounded-xl border border-line bg-white animate-rise',
            placement === 'inline' ? 'mt-2 w-full shadow-sm' : 'absolute z-50 w-[min(380px,calc(100vw-2rem))] shadow-pop',
            placement === 'up' && 'bottom-full mb-2 right-0',
            placement === 'down' && 'top-full mt-1 left-0',
            // Phones: a sheet along the bottom of the screen, so it never runs off the side.
            placement !== 'inline' && 'max-sm:fixed max-sm:inset-x-2 max-sm:bottom-[calc(env(safe-area-inset-bottom)+0.5rem)] max-sm:top-auto max-sm:left-2 max-sm:right-2 max-sm:mt-0 max-sm:mb-0 max-sm:w-auto max-sm:z-[60]',
          )}
        >
          <div className="border-b border-line p-2">
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-stone-light" />
              <input autoFocus={placement !== 'inline'} className="field h-9 py-1 pl-8 text-sm" placeholder="Search saved replies" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
          </div>
          <div className="max-h-[min(360px,50vh)] overflow-y-auto py-1">
            {loading && <div className="flex justify-center py-6"><Spinner /></div>}
            {!loading && data && filtered.length === 0 && (
              <p className="px-4 py-6 text-center text-sm text-stone">{data.replies.length === 0 ? 'No saved replies yet.' : 'No replies match that search.'}</p>
            )}
            {!loading && suggested.length > 0 && (
              <Group title={`Suggested · ${situationLabel(data!.situation)}`} replies={suggested} onPick={pick} highlight />
            )}
            {!loading && others.length > 0 && <Group title={suggested.length ? 'All other replies' : 'Saved replies'} replies={others} onPick={pick} />}
          </div>
          {canManage && (
            <div className="border-t border-line px-3 py-2">
              <Link to="/settings?tab=replies" onClick={() => setOpen(false)} className="inline-flex items-center gap-1.5 text-[13px] text-plum hover:underline"><Settings2 className="h-3.5 w-3.5" />Add or edit saved replies</Link>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Group({ title, replies, onPick, highlight }: { title: string; replies: SuggestedReply[]; onPick: (r: SuggestedReply) => void; highlight?: boolean }) {
  return (
    <div className="py-1">
      <p className={cx('px-3 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-wider', highlight ? 'text-plum' : 'text-stone')}>{title}</p>
      {replies.map((r) => (
        <button key={r.id} onClick={() => onPick(r)} className="block w-full px-3 py-2 text-left hover:bg-mist">
          <span className="block text-sm font-medium text-ink">{r.title}</span>
          <span className="mt-0.5 line-clamp-2 block text-[13px] leading-snug text-stone">{r.text}</span>
        </button>
      ))}
    </div>
  );
}
