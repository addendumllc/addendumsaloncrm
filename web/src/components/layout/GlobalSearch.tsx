import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Search } from 'lucide-react';
import { api } from '../../api/client';
import { dateShort, phone } from '../../lib/format';
import { cx } from '../ui';

interface Results {
  clients: { id: string; name: string; phone: string | null; email: string | null }[];
  leads: { id: string; name: string; phone: string | null; serviceInterest: string | null }[];
  appointments: { id: string; startAt: string; clientId: string | null; clientName: string | null; services: string | null }[];
  messages: { id: string; body: string; conversationId: string; name: string }[];
  notes: { id: string; body: string; clientId: string | null; leadId: string | null; name: string | null }[];
}

/** One search box for clients, leads, phone numbers, emails, appointments, services, notes, tags and texts. Press "/" to focus. */
export function GlobalSearch() {
  const nav = useNavigate();
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [res, setRes] = useState<Results | null>(null);
  const [active, setActive] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === '/' && !['INPUT', 'TEXTAREA', 'SELECT'].includes((e.target as HTMLElement).tagName)) {
        e.preventDefault();
        input.current?.focus();
      }
    };
    const onClick = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onClick);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onClick);
    };
  }, []);

  useEffect(() => {
    if (q.trim().length < 2) return setRes(null);
    const t = setTimeout(() => api.get<Results>(`/search?q=${encodeURIComponent(q)}`).then((r) => { setRes(r); setActive(0); }).catch(() => undefined), 160);
    return () => clearTimeout(t);
  }, [q]);

  const rows: { key: string; group: string; title: string; sub: string; go: () => void }[] = res
    ? [
        ...res.clients.map((c) => ({ key: `c${c.id}`, group: 'Clients', title: c.name, sub: [phone(c.phone), c.email].filter(Boolean).join('  '), go: () => nav(`/clients/${c.id}`) })),
        ...res.leads.map((l) => ({ key: `l${l.id}`, group: 'New Clients', title: l.name, sub: [phone(l.phone), l.serviceInterest].filter(Boolean).join('  '), go: () => nav(`/leads?open=${l.id}`) })),
        ...res.appointments.map((a) => ({ key: `a${a.id}`, group: 'Appointments', title: `${a.clientName ?? 'Client'} — ${a.services ?? 'Appointment'}`, sub: dateShort(a.startAt), go: () => nav(a.clientId ? `/clients/${a.clientId}` : '/appointments') })),
        ...res.messages.map((m) => ({ key: `m${m.id}`, group: 'Messages', title: m.name, sub: m.body, go: () => nav(`/messages/${m.conversationId}`) })),
        ...res.notes.map((n) => ({ key: `n${n.id}`, group: 'Notes', title: n.name ?? 'Note', sub: n.body, go: () => nav(n.clientId ? `/clients/${n.clientId}` : `/leads?open=${n.leadId}`) })),
      ]
    : [];

  const pick = (i: number) => {
    rows[i]?.go();
    setOpen(false);
    setQ('');
  };

  return (
    <div ref={box} className="relative min-w-0 flex-1">
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-stone-light" />
      <input
        ref={input}
        value={q}
        onChange={(e) => { setQ(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, rows.length - 1)); }
          if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
          if (e.key === 'Enter') pick(active);
          if (e.key === 'Escape') setOpen(false);
        }}
        placeholder="Search clients, phone numbers, services, texts…"
        aria-label="Search"
        className="h-10 w-full max-w-xl rounded-lg border border-line bg-white pl-9 pr-3 text-[14.5px] placeholder:text-stone-light focus:border-plum focus:outline-none focus:ring-2 focus:ring-plum/15"
      />
      {open && q.trim().length >= 2 && res && (
        <div className="absolute left-0 z-40 mt-1 max-h-[70vh] w-full max-w-xl overflow-y-auto rounded-xl border border-line bg-white py-2 shadow-pop">
          {rows.length === 0 && <p className="px-4 py-3 text-sm text-stone">Nothing matches “{q}”.</p>}
          {rows.map((r, i) => (
            <div key={r.key}>
              {(i === 0 || rows[i - 1].group !== r.group) && <p className="px-4 pb-1 pt-2 text-xs font-medium text-stone">{r.group}</p>}
              <button onMouseEnter={() => setActive(i)} onClick={() => pick(i)} className={cx('block w-full px-4 py-2 text-left', i === active && 'bg-mist')}>
                <span className="block truncate text-sm text-ink">{r.title}</span>
                {r.sub && <span className="block truncate text-xs text-stone">{r.sub}</span>}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
