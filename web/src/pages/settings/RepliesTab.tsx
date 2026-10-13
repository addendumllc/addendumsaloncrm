import { useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react';
import { REPLY_PLACEHOLDERS, REPLY_SITUATIONS, type ReplySituation, type SavedReply } from '@addendum/shared';
import { Button, Field, cx } from '../../components/ui';
import { Card, SaveBar, useCan, useSection } from './shared';

const SAMPLE = Object.fromEntries(REPLY_PLACEHOLDERS.map((p) => [p.key, p.sample]));
const preview = (body: string) => body.replace(/\{(\w+)\}/g, (_m, k: string) => SAMPLE[k] ?? '').replace(/[ \t]{2,}/g, ' ').trim();
const newId = () => `reply-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

/** Settings → Saved replies: the salon's own texts, tagged with the situations they're for. */
export function RepliesSettings() {
  const r = useSection('replies');
  const can = useCan();
  const locked = !can('settings:rules');
  const [filter, setFilter] = useState<ReplySituation | ''>('');
  if (!r.draft) return null;
  const items = r.draft.items;
  const setItems = (next: SavedReply[]) => r.set('items', next);
  const update = (id: string, patch: Partial<SavedReply>) => setItems(items.map((x) => (x.id === id ? { ...x, ...patch } : x)));
  const move = (idx: number, dir: -1 | 1) => {
    const next = [...items];
    const [it] = next.splice(idx, 1);
    next.splice(idx + dir, 0, it);
    setItems(next);
  };
  const add = () => {
    setFilter('');
    setItems([{ id: newId(), title: 'New reply', body: 'Hi {firstName}! ', situations: filter ? [filter] : ['general'] }, ...items]);
  };
  const shown = items.map((x, idx) => ({ x, idx })).filter(({ x }) => !filter || x.situations.includes(filter));
  const invalid = items.some((x) => !x.title.trim() || !x.body.trim());

  return (
    <div className="space-y-6">
      <Card
        title="Saved replies"
        description="Your own ready-to-send texts. Tag each one with the situations it's for: when someone texts or a follow-up is due, the matching replies are suggested first in the Saved replies button. Placeholders like {firstName} are filled in for each person."
        footer={<SaveBar dirty={r.dirty} saving={r.saving} onSave={() => r.save()} onReset={r.reset} disabled={locked || invalid} />}
      >
        <div className="flex flex-wrap items-center gap-2">
          {!locked && <Button variant="primary" size="sm" icon={<Plus className="h-4 w-4" />} onClick={add}>Add a reply</Button>}
          <select className="field h-8 w-auto py-0 text-[13px]" value={filter} onChange={(e) => setFilter(e.target.value as ReplySituation | '')} aria-label="Show replies for">
            <option value="">All situations ({items.length})</option>
            {REPLY_SITUATIONS.map((s) => <option key={s.value} value={s.value}>{s.label} ({items.filter((x) => x.situations.includes(s.value)).length})</option>)}
          </select>
          {invalid && <span className="text-[13px] text-rose">Every reply needs a name and a message.</span>}
        </div>
        {locked && <p className="mt-3 text-[13px] text-stone">Only an administrator can change saved replies.</p>}
        <ul className="mt-4 space-y-3">
          {shown.length === 0 && <li className="rounded-xl border border-dashed border-line px-4 py-6 text-center text-sm text-stone">No replies for this situation yet.</li>}
          {shown.map(({ x, idx }) => (
            <ReplyEditor
              key={x.id} reply={x} locked={locked}
              onChange={(p) => update(x.id, p)}
              onDelete={() => setItems(items.filter((y) => y.id !== x.id))}
              onUp={idx > 0 && !filter ? () => move(idx, -1) : undefined}
              onDown={idx < items.length - 1 && !filter ? () => move(idx, 1) : undefined}
            />
          ))}
        </ul>
      </Card>
    </div>
  );
}

function ReplyEditor({ reply, locked, onChange, onDelete, onUp, onDown }: {
  reply: SavedReply; locked: boolean; onChange: (p: Partial<SavedReply>) => void; onDelete: () => void; onUp?: () => void; onDown?: () => void;
}) {
  const ta = useRef<HTMLTextAreaElement>(null);
  const toggle = (s: ReplySituation) => onChange({ situations: reply.situations.includes(s) ? reply.situations.filter((x) => x !== s) : [...reply.situations, s] });
  const insert = (key: string) => {
    const el = ta.current;
    const token = `{${key}}`;
    if (!el) return onChange({ body: `${reply.body}${token}` });
    const start = el.selectionStart ?? reply.body.length;
    const end = el.selectionEnd ?? reply.body.length;
    onChange({ body: reply.body.slice(0, start) + token + reply.body.slice(end) });
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(start + token.length, start + token.length);
    });
  };
  return (
    <li className="rounded-xl border border-line bg-white p-4">
      <div className="flex items-start gap-2">
        <Field label="Name" className="flex-1">
          <input className="field" value={reply.title} maxLength={80} disabled={locked} onChange={(e) => onChange({ title: e.target.value })} placeholder="e.g. Pricing question" />
        </Field>
        {!locked && (
          <div className="mt-6 flex shrink-0 gap-0.5">
            <button className="rounded-lg p-2 text-stone hover:bg-mist disabled:opacity-30" disabled={!onUp} onClick={onUp} aria-label="Move up"><ArrowUp className="h-4 w-4" /></button>
            <button className="rounded-lg p-2 text-stone hover:bg-mist disabled:opacity-30" disabled={!onDown} onClick={onDown} aria-label="Move down"><ArrowDown className="h-4 w-4" /></button>
            <button className="rounded-lg p-2 text-stone hover:bg-mist hover:text-rose" onClick={onDelete} aria-label={`Delete ${reply.title}`}><Trash2 className="h-4 w-4" /></button>
          </div>
        )}
      </div>

      <span className="label mt-3">Use for</span>
      <div className="flex flex-wrap gap-1.5">
        {REPLY_SITUATIONS.map((s) => {
          const on = reply.situations.includes(s.value);
          return (
            <button key={s.value} type="button" disabled={locked} onClick={() => toggle(s.value)} aria-pressed={on}
              className={cx('rounded-full border px-2.5 py-1 text-xs transition-colors disabled:cursor-not-allowed', on ? 'border-plum bg-plum text-white' : 'border-line bg-white text-ink-soft hover:border-plum/40')}>
              {s.label}
            </button>
          );
        })}
      </div>

      <Field label="Message" className="mt-3">
        <textarea ref={ta} className="field min-h-[96px] leading-relaxed" value={reply.body} maxLength={1000} disabled={locked} onChange={(e) => onChange({ body: e.target.value })} />
      </Field>
      {!locked && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1">
          <span className="mr-1 text-xs text-stone">Insert:</span>
          {REPLY_PLACEHOLDERS.map((p) => (
            <button key={p.key} type="button" onClick={() => insert(p.key)} className="rounded-md bg-mist px-2 py-0.5 text-xs text-ink-soft hover:bg-plum-tint hover:text-plum">{p.label}</button>
          ))}
        </div>
      )}
      <p className="mt-3 rounded-lg bg-paper px-3 py-2 text-[13px] leading-relaxed text-ink-soft"><span className="text-stone">Preview: </span>{preview(reply.body) || '—'}</p>
    </li>
  );
}
