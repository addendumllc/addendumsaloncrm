/** Formatting helpers. Times display in the salon's timezone (set once from settings). */
let TZ = 'America/Los_Angeles';
export const setTimezone = (tz: string) => {
  if (tz) TZ = tz;
};
export const getTimezone = () => TZ;

const fmt = (opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-US', { timeZone: TZ, ...opts });

export const time = (d: string | Date) => fmt({ hour: 'numeric', minute: '2-digit' }).format(new Date(d));
export const dateShort = (d: string | Date) => fmt({ month: 'short', day: 'numeric' }).format(new Date(d));
export const dateLong = (d: string | Date) => fmt({ month: 'long', day: 'numeric' }).format(new Date(d));
export const weekdayDate = (d: string | Date) => fmt({ weekday: 'long', month: 'long', day: 'numeric' }).format(new Date(d));
export const weekdayShort = (d: string | Date) => fmt({ weekday: 'short' }).format(new Date(d));
export const dateTime = (d: string | Date) => `${dateShort(d)}, ${time(d)}`;

/** YYYY-MM-DD of a date in the salon timezone. */
export const dayKey = (d: string | Date) => {
  const p = fmt({ year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(d)).reduce<Record<string, string>>((a, x) => ((a[x.type] = x.value), a), {});
  return `${p.year}-${p.month}-${p.day}`;
};

export function relative(d: string | Date | null | undefined, now = Date.now()): string {
  if (!d) return '—';
  const diff = new Date(d).getTime() - now;
  const abs = Math.abs(diff);
  const m = Math.round(abs / 60000);
  const h = Math.round(abs / 3600000);
  const days = Math.round(abs / 86400000);
  const past = diff < 0;
  let s: string;
  if (m < 1) return 'just now';
  if (m < 60) s = `${m} min`;
  else if (h < 24) s = `${h} hr${h === 1 ? '' : 's'}`;
  else if (days < 14) s = `${days} day${days === 1 ? '' : 's'}`;
  else if (days < 60) s = `${Math.round(days / 7)} weeks`;
  else s = `${Math.round(days / 30)} months`;
  return past ? `${s} ago` : `in ${s}`;
}

export function dueLabel(dueAt: string, now = Date.now()) {
  const due = new Date(dueAt);
  if (dayKey(due) === dayKey(new Date(now))) return due.getTime() < now ? `Due ${time(due)} · overdue` : `Due today ${time(due)}`;
  if (due.getTime() < now) return `Overdue · was due ${dateShort(due)}`;
  return `Due ${dateShort(due)} ${time(due)}`;
}

export function phone(e164: string | null | undefined) {
  if (!e164) return '';
  const m = e164.match(/^\+1(\d{3})(\d{3})(\d{4})$/);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164;
}

export const money = (cents: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(cents / 100);
export const pct = (v: number | null) => (v == null ? '—' : `${Math.round(v * 100)}%`);
export const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((s) => s[0]?.toUpperCase()).join('') || '?';
export const firstName = (name: string | null | undefined) => (name ?? '').split(' ')[0];

/** Local datetime-input value (YYYY-MM-DDTHH:mm) in the browser's own timezone. */
export function toInputValue(d: Date) {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Hours since local midnight (salon timezone), e.g. 14.5 for 2:30 PM. */
export function hourOfDay(d: string | Date) {
  const p = fmt({ hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date(d)).reduce<Record<string, string>>((a, x) => ((a[x.type] = x.value), a), {});
  return (Number(p.hour) % 24) + Number(p.minute) / 60;
}

/** UTC instant for midnight of a YYYY-MM-DD day in the salon timezone. */
export function startOfDayKey(key: string): Date {
  const [y, m, d] = key.split('-').map(Number);
  const guess = Date.UTC(y, m - 1, d);
  const offset = (t: number) => {
    const p = fmt({ year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
      .formatToParts(new Date(t)).reduce<Record<string, string>>((a, x) => ((a[x.type] = x.value), a), {});
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) - t;
  };
  const o1 = offset(guess);
  const r = guess - o1;
  const o2 = offset(r);
  return new Date(o1 === o2 ? r : guess - o2);
}

/** Add days to a YYYY-MM-DD key. */
export function addDaysKey(key: string, n: number) {
  const [y, m, d] = key.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return t.toISOString().slice(0, 10);
}

/** 0 = Sunday for a YYYY-MM-DD key. */
export const weekdayOfKey = (key: string) => new Date(`${key}T12:00:00Z`).getUTCDay();
export const labelOfKey = (key: string, opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', ...opts }).format(new Date(`${key}T12:00:00Z`));
