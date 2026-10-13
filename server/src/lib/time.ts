export const HOUR = 3600_000;
export const DAY = 24 * HOUR;
export const addHours = (d: Date, h: number) => new Date(d.getTime() + h * HOUR);
export const addDays = (d: Date, n: number) => new Date(d.getTime() + n * DAY);
export const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);

/** Start/end of the local day in the salon's timezone, returned as UTC Dates. */
export function dayBounds(date: Date, timeZone: string): { start: Date; end: Date } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(date)
    .reduce<Record<string, string>>((a, p) => ((a[p.type] = p.value), a), {});
  const start = zonedToUtc(Number(parts.year), Number(parts.month), Number(parts.day), 0, 0, timeZone);
  return { start, end: addDays(start, 1) };
}

/** Convert a wall-clock time in `timeZone` to a UTC Date. */
export function zonedToUtc(y: number, m: number, d: number, hh: number, mm: number, timeZone: string): Date {
  const guess = new Date(Date.UTC(y, m - 1, d, hh, mm));
  const offset = tzOffsetMs(guess, timeZone);
  const result = new Date(guess.getTime() - offset);
  // Correct for DST transitions.
  const offset2 = tzOffsetMs(result, timeZone);
  return offset2 === offset ? result : new Date(guess.getTime() - offset2);
}

function tzOffsetMs(date: Date, timeZone: string): number {
  const p = new Intl.DateTimeFormat('en-US', {
    timeZone, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  })
    .formatToParts(date)
    .reduce<Record<string, string>>((a, x) => ((a[x.type] = x.value), a), {});
  const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return asUtc - date.getTime();
}

export function localHourMinute(date: Date, timeZone: string): { h: number; m: number } {
  const p = new Intl.DateTimeFormat('en-US', { timeZone, hour12: false, hour: '2-digit', minute: '2-digit' })
    .formatToParts(date)
    .reduce<Record<string, string>>((a, x) => ((a[x.type] = x.value), a), {});
  return { h: +p.hour % 24, m: +p.minute };
}

export function formatDateShort(date: Date | string, timeZone: string) {
  return new Intl.DateTimeFormat('en-US', { timeZone, month: 'long', day: 'numeric' }).format(new Date(date));
}

export function formatTime(date: Date | string, timeZone: string) {
  return new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: '2-digit' }).format(new Date(date));
}
