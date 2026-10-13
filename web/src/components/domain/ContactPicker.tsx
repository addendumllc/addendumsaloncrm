import { useEffect, useState } from 'react';
import { Search, X } from 'lucide-react';
import { api } from '../../api/client';
import { phone } from '../../lib/format';
import { Badge } from '../ui';

export interface PickedContact { kind: 'client' | 'lead'; id: string; name: string; phone?: string | null }

/** Search clients and leads by name, phone or email. */
export function ContactPicker({ value, onChange }: { value: PickedContact | null; onChange: (c: PickedContact | null) => void }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<PickedContact[]>([]);
  useEffect(() => {
    if (q.trim().length < 2) return setResults([]);
    const t = setTimeout(async () => {
      const r = await api.get<{ clients: any[]; leads: any[] }>(`/search?q=${encodeURIComponent(q)}`).catch(() => ({ clients: [], leads: [] }));
      setResults([
        ...r.clients.map((c) => ({ kind: 'client' as const, id: c.id, name: c.name, phone: c.phone })),
        ...r.leads.map((l) => ({ kind: 'lead' as const, id: l.id, name: l.name, phone: l.phone })),
      ]);
    }, 200);
    return () => clearTimeout(t);
  }, [q]);

  if (value) {
    return (
      <div className="flex items-center justify-between rounded-lg border border-line-strong bg-mist/50 px-3 py-2">
        <span className="text-sm"><span className="font-medium">{value.name}</span> <Badge tone={value.kind === 'lead' ? 'plum' : 'neutral'}>{value.kind === 'lead' ? 'Lead' : 'Client'}</Badge></span>
        <button onClick={() => onChange(null)} className="text-stone hover:text-ink" aria-label="Clear"><X className="h-4 w-4" /></button>
      </div>
    );
  }
  return (
    <div className="relative">
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-stone-light" />
      <input className="field pl-9" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search a client or lead" />
      {results.length > 0 && (
        <div className="absolute z-10 mt-1 max-h-64 w-full overflow-y-auto rounded-xl border border-line bg-white py-1 shadow-pop">
          {results.map((r) => (
            <button key={`${r.kind}-${r.id}`} onClick={() => { onChange(r); setQ(''); }} className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-mist">
              <span>{r.name} <span className="text-stone">{phone(r.phone)}</span></span>
              <Badge tone={r.kind === 'lead' ? 'plum' : 'neutral'}>{r.kind === 'lead' ? 'Lead' : 'Client'}</Badge>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
