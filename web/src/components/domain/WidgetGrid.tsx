import { useState, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Check, Eye, EyeOff, GripVertical, LayoutGrid, RotateCcw } from 'lucide-react';
import type { DashboardLayout, DashboardWidgetSize } from '@addendum/shared';
import { api } from '../../api/client';
import { Button, SectionTitle, cx, useToast } from '../ui';

export type WidgetDef = { id: string; title: string; size: DashboardWidgetSize; node: ReactNode; heading?: ReactNode; action?: ReactNode; ownHeading?: boolean };
const SPAN: Record<DashboardWidgetSize, string> = {
  s: 'md:col-span-1 lg:col-span-2', m: 'md:col-span-1 lg:col-span-3', l: 'md:col-span-2 lg:col-span-4', full: 'md:col-span-2 lg:col-span-6',
};
const SIZES: [DashboardWidgetSize, string, string][] = [['s', 'S', 'Small (a third)'], ['m', 'M', 'Medium (half)'], ['l', 'L', 'Large (two thirds)'], ['full', 'Full', 'Full width']];

/**
 * Widgets in a grid the person arranges (Dashboard, Analytics): Customize → drag a widget by its handle (or use the
 * arrows), pick S / M / L / Full, or hide it. Saved to their account per page, so it follows them to any device.
 * Phones always stack full width.
 */
export function WidgetGrid({ defs, page }: { defs: WidgetDef[]; page: 'dashboard' | 'analytics' }) {
  const toast = useToast();
  const qc = useQueryClient();
  const { data: saved } = useQuery({ queryKey: [`${page}-layout`], queryFn: () => api.get<{ layout: DashboardLayout | null }>(`/${page}/layout`).then((r) => r.layout) });
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<DashboardLayout | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const layout = draft ?? saved ?? null;
  // Saved order first (only widgets this person has now), then any new ones in their default place.
  const byId = new Map(defs.map((d) => [d.id, d]));
  const ordered = [...(layout?.order ?? []).filter((id) => byId.has(id)).map((id) => byId.get(id)!), ...defs.filter((d) => !layout?.order.includes(d.id))];
  const sizeOf = (d: WidgetDef) => layout?.sizes[d.id] ?? d.size;
  const hidden = new Set(layout?.hidden ?? []);
  const current = (): DashboardLayout => ({ order: ordered.map((d) => d.id), sizes: Object.fromEntries(ordered.map((d) => [d.id, sizeOf(d)])), hidden: [...hidden] });
  // Hide or show a widget (saved straight away, so it's kept even without pressing Done).
  const setHidden = (id: string, hide: boolean) => {
    const next = { ...current(), hidden: hide ? [...hidden, id] : [...hidden].filter((x) => x !== id) };
    setDraft(next);
    void save(next);
  };
  const shownWidgets = ordered.filter((d) => !hidden.has(d.id));
  const hiddenWidgets = ordered.filter((d) => hidden.has(d.id));

  const save = async (l: DashboardLayout | null) => {
    try {
      const r = await api.put<{ layout: DashboardLayout | null }>(`/${page}/layout`, { layout: l });
      qc.setQueryData([`${page}-layout`], r.layout);
    } catch (e) {
      toast((e as Error).message, 'error');
    }
  };
  const move = (id: string, to: number) => {
    const order = ordered.map((d) => d.id).filter((x) => x !== id);
    order.splice(Math.max(0, Math.min(order.length, to)), 0, id);
    setDraft({ ...current(), order });
  };
  const setSize = (id: string, size: DashboardWidgetSize) => {
    const next = { ...current(), sizes: { ...current().sizes, [id]: size } };
    setDraft(next);
    void save(next);
  };
  const done = async () => {
    if (draft) await save(draft);
    setDraft(null);
    setEditing(false);
  };
  const reset = async () => {
    await save(null);
    setDraft(null);
    toast(`${page === 'dashboard' ? 'Dashboard' : 'Analytics'} back to the standard layout`);
  };

  return (
    <>
      <div className="mt-4 flex flex-wrap items-center justify-end gap-2">
        {editing ? (
          <>
            <span className="mr-auto text-[13px] text-stone">Drag widgets by <GripVertical className="inline h-4 w-4" /> to move them, choose a size, or hide the ones you don’t need. Saved to your account.</span>
            <Button size="sm" variant="ghost" icon={<RotateCcw className="h-4 w-4" />} onClick={reset}>Reset</Button>
            <Button size="sm" variant="primary" icon={<Check className="h-4 w-4" />} onClick={done}>Done</Button>
          </>
        ) : (
          <Button size="sm" variant="ghost" icon={<LayoutGrid className="h-4 w-4" />} onClick={() => setEditing(true)}>Customize</Button>
        )}
      </div>
      {/* Hidden widgets: listed while customizing, to bring back. */}
      {editing && hiddenWidgets.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-2 rounded-xl2 border border-dashed border-line-strong bg-mist/30 px-3 py-2 text-[13px]">
          <span className="text-stone">Hidden:</span>
          {hiddenWidgets.map((d) => (
            <button key={d.id} type="button" onClick={() => setHidden(d.id, false)} className="inline-flex items-center gap-1 rounded-full border border-line bg-white px-2.5 py-1 text-ink-soft hover:border-plum hover:text-plum">
              <Eye className="h-3.5 w-3.5" />{d.title}
            </button>
          ))}
        </div>
      )}
      {!editing && hiddenWidgets.length > 0 && shownWidgets.length === 0 && <p className="mt-3 text-[14px] text-stone">Every widget is hidden — use Customize to show some again.</p>}
      <div className="mt-3 grid grid-cols-1 gap-6 md:grid-cols-2 lg:grid-cols-6">
        {shownWidgets.map((d, i) => (
          <div
            key={d.id}
            className={cx('flex min-w-0 flex-col', SPAN[sizeOf(d)], editing && 'rounded-xl2 border border-dashed border-line-strong bg-mist/30 p-2', dragId === d.id && 'opacity-40')}
            draggable={editing}
            onDragStart={(e) => { setDragId(d.id); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', d.id); }}
            onDragOver={(e) => { if (!editing || !dragId) return; e.preventDefault(); if (dragId !== d.id) move(dragId, ordered.indexOf(d)); }}
            onDrop={(e) => e.preventDefault()}
            onDragEnd={() => { setDragId(null); if (draft) void save(draft); }}
          >
            {editing && (
              <div className="mb-2 flex flex-wrap items-center gap-2 rounded-lg bg-white px-2 py-1.5 shadow-sm">
                <GripVertical className="h-4 w-4 cursor-grab text-stone" aria-hidden />
                <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-ink">{d.title}</span>
                <span className="flex gap-0.5" role="group" aria-label={`Size of ${d.title}`}>
                  {SIZES.map(([v, l, title]) => (
                    <button key={v} type="button" title={title} onClick={() => setSize(d.id, v)}
                      className={cx('rounded-md px-1.5 py-0.5 text-[12px] font-medium', sizeOf(d) === v ? 'bg-plum text-white' : 'text-ink-soft hover:bg-plum-tint')}>{l}</button>
                  ))}
                </span>
                <button type="button" className="rounded-md p-1 text-stone hover:bg-mist hover:text-ink" title="Hide this widget" aria-label={`Hide ${d.title}`} onClick={() => setHidden(d.id, true)}><EyeOff className="h-4 w-4" /></button>
                <span className="flex">
                  <button type="button" className="rounded-md p-1 text-stone hover:bg-mist disabled:opacity-30" disabled={i === 0} aria-label={`Move ${d.title} earlier`} onClick={() => { move(d.id, ordered.indexOf(shownWidgets[i - 1])); }}><ArrowUp className="h-4 w-4" /></button>
                  <button type="button" className="rounded-md p-1 text-stone hover:bg-mist disabled:opacity-30" disabled={i === shownWidgets.length - 1} aria-label={`Move ${d.title} later`} onClick={() => { move(d.id, ordered.indexOf(shownWidgets[i + 1])); }}><ArrowDown className="h-4 w-4" /></button>
                </span>
              </div>
            )}
            {/* While arranging, the widget's own links and buttons are paused so a drag never opens a page. */}
            {!d.ownHeading && <SectionTitle action={!editing && d.action}>{d.heading ?? d.title}</SectionTitle>}
            {/* The body fills the row's height, so widgets side by side end level too. */}
            <div className={cx('flex flex-1 flex-col [&>*]:flex-1', editing && 'pointer-events-none select-none')}>{d.node}</div>
          </div>
        ))}
      </div>
    </>
  );
}

