import { IntegrationError } from '../lib/errors.js';

/**
 * Flodesk (email marketing). Its API covers subscribers, segments and workflows — not email campaigns, their schedule
 * or their stats — so the CRM only reads the account's segments (to map each content account to its audiences).
 * Emails are written and scheduled in Flodesk; the CRM keeps the plan, the Flodesk link and the confirmed status.
 *   GET https://api.flodesk.com/v1/segments   (Basic auth: the API key as the user name)
 */
const BASE = 'https://api.flodesk.com/v1';
export interface FlodeskSegment { id: string; name: string; subscribers: number | null }

export class FlodeskApi {
  constructor(private apiKey: string) {}
  private async get<T>(path: string): Promise<T> {
    const res = await fetch(`${BASE}${path}`, { headers: { Authorization: `Basic ${Buffer.from(`${this.apiKey}:`).toString('base64')}`, 'User-Agent': 'Addendum CRM (content calendar)', Accept: 'application/json' } });
    const j = await res.json().catch(() => ({})) as any;
    if (!res.ok) throw new IntegrationError('flodesk', `Flodesk: ${j.message ?? `error ${res.status}`}`, res.status >= 500, res.status === 401 || res.status === 403, JSON.stringify(j).slice(0, 300));
    return j as T;
  }
  /** Every segment (paged). Names and counts only — never subscribers. */
  async segments(): Promise<FlodeskSegment[]> {
    const out: FlodeskSegment[] = [];
    for (let page = 1; page <= 20; page++) {
      const r = await this.get<{ data?: any[]; meta?: { total_pages?: number } }>(`/segments?page=${page}&per_page=100`);
      for (const s of r.data ?? []) out.push({ id: String(s.id), name: String(s.name ?? s.id), subscribers: s.total_active_subscribers ?? s.active_subscribers ?? s.subscribers_count ?? null });
      if (!r.meta?.total_pages || page >= r.meta.total_pages) break;
    }
    return out;
  }
}
