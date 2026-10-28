import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { Camera, Pencil } from 'lucide-react';
import { api } from '../../api/client';
import { useCanDo } from '../../api/hooks';
import { Button } from '../ui';

interface Due { items: { appointmentId: string }[]; needsDetails: { id: string; date: string; title: string }[] }
const fmt = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

/**
 * On a stylist's home (Dashboard or My Calendar): transformations added for them that need what was done, and finished
 * appointments to confirm with photos. Nothing shows when there's nothing to do.
 */
export function TransformationsDue({ className }: { className?: string }) {
  const can = useCanDo();
  const go = useNavigate();
  const { data } = useQuery({ queryKey: ['tf-confirm'], enabled: can('transformations:own'), queryFn: () => api.get<Due>('/transformations/to-confirm'), staleTime: 60_000 });
  const needs = data?.needsDetails ?? [];
  const toConfirm = data?.items.length ?? 0;
  if (!needs.length && !toConfirm) return null;
  return (
    <section className={`panel mb-5 p-4 ${className ?? ''}`}>
      <div className="flex flex-wrap items-center gap-2">
        <Camera className="h-5 w-5 shrink-0 text-plum" />
        <h2 className="min-w-0 flex-1 text-[16px] font-medium text-ink">
          {needs.length ? `Transformation${needs.length === 1 ? ' needs' : 's need'} your details` : `${toConfirm} appointment${toConfirm === 1 ? '' : 's'} to confirm with photos`}
        </h2>
        <Button size="sm" onClick={() => go('/transformations')}>Open Transformations</Button>
      </div>
      {needs.length > 0 && (
        <ul className="mt-3 divide-y divide-line">
          {needs.slice(0, 5).map((n) => (
            <li key={n.id} className="flex items-center gap-2 py-2">
              <span className="min-w-0 flex-1 text-[14px] text-ink">{fmt(n.date)}{n.title && n.title !== 'Transformation' ? ` · ${n.title}` : ''}</span>
              <Button size="sm" variant="ghost" onClick={() => go(`/transformations?open=${n.id}`)}>View</Button>
              <Button size="sm" variant="primary" icon={<Pencil className="h-3.5 w-3.5" />} onClick={() => go(`/transformations?edit=${n.id}`)}>Add details</Button>
            </li>
          ))}
        </ul>
      )}
      {needs.length > 0 && toConfirm > 0 && <p className="mt-2 text-[13px] text-stone">Also {toConfirm} finished appointment{toConfirm === 1 ? '' : 's'} to confirm with photos.</p>}
    </section>
  );
}
