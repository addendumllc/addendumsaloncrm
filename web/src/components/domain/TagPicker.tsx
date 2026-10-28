import { useState } from 'react';
import { Plus } from 'lucide-react';
import { cx, chipClass } from '../ui';

/** Toggle preset tags or add a custom one. */
export function TagPicker({ value, onChange, options }: { value: string[]; onChange: (v: string[]) => void; options: string[] }) {
  const [custom, setCustom] = useState('');
  const all = [...new Set([...options, ...value])];
  const toggle = (t: string) => onChange(value.includes(t) ? value.filter((x) => x !== t) : [...value, t]);
  const add = () => {
    const t = custom.trim();
    if (t && !value.includes(t)) onChange([...value, t]);
    setCustom('');
  };
  return (
    <div>
      <div className="flex flex-wrap gap-1.5">
        {all.map((t) => (
          <button
            key={t}
            type="button"
            onClick={() => toggle(t)}
            aria-pressed={value.includes(t)}
            className={chipClass(value.includes(t))}
          >
            {t}
          </button>
        ))}
      </div>
      <div className="mt-2 flex gap-2">
        <input className="field h-9 py-1 text-sm" value={custom} onChange={(e) => setCustom(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), add())} placeholder="Custom tag" maxLength={40} />
        <button type="button" onClick={add} className="inline-flex h-9 items-center gap-1 rounded-lg border border-line-strong px-3 text-sm text-ink-soft hover:bg-mist"><Plus className="h-4 w-4" />Add</button>
      </div>
    </div>
  );
}
