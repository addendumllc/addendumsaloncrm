import type { ClientSummaryDTO } from '@addendum/shared';
import { db } from '../db/index.js';
import { iso } from '../lib/time.js';

export interface ClientFilters {
  /** Only clients this staff member has served or is assigned to (people without clients:read). */
  assignedTo?: string | null;
  q?: string;
  tag?: string;
  staffId?: string;
  service?: string;
  lastBefore?: string;
  lastAfter?: string;
  nextBefore?: string;
  nextAfter?: string;
  hasNext?: 'yes' | 'no';
  archived?: boolean;
  limit?: number;
  offset?: number;
}

const CLIENT_SELECT = `
  SELECT c.*, ps.name AS preferred_staff_name,
         COALESCE((SELECT array_agg(t.name ORDER BY t.name) FROM client_tags ct JOIN tags t ON t.id = ct.tag_id WHERE ct.client_id = c.id), '{}') AS tags,
         v.last_at, v.next_at, v.visit_count,
         (SELECT string_agg(x.service_name, ', ') FROM appointment_services x WHERE x.appointment_id = v.last_id) AS last_service
    FROM clients c
    LEFT JOIN staff ps ON ps.id = c.preferred_staff_id
    LEFT JOIN LATERAL (
      SELECT max(a.start_at) FILTER (WHERE a.square_status = 'ACCEPTED' AND a.end_at < now()) AS last_at,
             min(a.start_at) FILTER (WHERE a.square_status IN ('ACCEPTED','PENDING') AND a.start_at >= now()) AS next_at,
             count(*) FILTER (WHERE a.square_status = 'ACCEPTED' AND a.end_at < now())::int AS visit_count,
             (array_agg(a.id ORDER BY a.start_at DESC) FILTER (WHERE a.square_status = 'ACCEPTED' AND a.end_at < now()))[1] AS last_id
        FROM appointments a WHERE a.client_id = c.id
    ) v ON true`;

export function toClientSummary(r: any): ClientSummaryDTO {
  return {
    id: r.id,
    name: `${r.first_name} ${r.last_name}`.trim() || 'Unnamed client',
    phone: r.phone,
    email: r.email,
    tags: r.tags ?? [],
    preferredStaffName: r.preferred_staff_name ?? null,
    lastAppointmentAt: iso(r.last_at),
    nextAppointmentAt: iso(r.next_at),
    lastService: r.last_service ?? null,
    visitCount: r.visit_count ?? 0,
    squareCustomerId: r.square_customer_id,
    archived: !!r.archived_at,
  };
}

export async function listClients(f: ClientFilters) {
  const where: string[] = [f.archived ? 'c.archived_at IS NOT NULL' : 'c.archived_at IS NULL'];
  const p: unknown[] = [];
  const add = (sql: (n: number) => string, v: unknown) => {
    p.push(v);
    where.push(sql(p.length));
  };
  if (f.q) {
    const digits = f.q.replace(/\D/g, '');
    add((n) => `((c.first_name || ' ' || c.last_name) ILIKE $${n} OR c.email ILIKE $${n}${digits.length >= 3 ? ` OR c.phone LIKE '%${digits}%'` : ''})`, `%${f.q}%`);
  }
  if (f.tag) add((n) => `EXISTS (SELECT 1 FROM client_tags ct JOIN tags t ON t.id = ct.tag_id WHERE ct.client_id = c.id AND t.name = $${n})`, f.tag);
  if (f.assignedTo) add((n) => `(c.preferred_staff_id = $${n} OR EXISTS (SELECT 1 FROM client_staff cs WHERE cs.client_id = c.id AND cs.staff_id = $${n}) OR EXISTS (SELECT 1 FROM appointments a WHERE a.client_id = c.id AND a.staff_id = $${n}))`, f.assignedTo);
  if (f.staffId) add((n) => `(c.preferred_staff_id = $${n} OR EXISTS (SELECT 1 FROM client_staff cs WHERE cs.client_id = c.id AND cs.staff_id = $${n}) OR EXISTS (SELECT 1 FROM appointments a WHERE a.client_id = c.id AND a.staff_id = $${n}))`, f.staffId);
  if (f.service) add((n) => `EXISTS (SELECT 1 FROM appointments a JOIN appointment_services x ON x.appointment_id = a.id WHERE a.client_id = c.id AND x.service_name ILIKE $${n})`, `%${f.service}%`);
  if (f.lastBefore) add((n) => `v.last_at < $${n}`, new Date(f.lastBefore));
  if (f.lastAfter) add((n) => `v.last_at >= $${n}`, new Date(f.lastAfter));
  if (f.nextBefore) add((n) => `v.next_at < $${n}`, new Date(f.nextBefore));
  if (f.nextAfter) add((n) => `v.next_at >= $${n}`, new Date(f.nextAfter));
  if (f.hasNext === 'yes') where.push('v.next_at IS NOT NULL');
  if (f.hasNext === 'no') where.push('v.next_at IS NULL');
  const limit = Math.min(f.limit ?? 100, 500);
  const rows = await db().query(
    `${CLIENT_SELECT} WHERE ${where.join(' AND ')} ORDER BY v.next_at ASC NULLS LAST, lower(c.first_name), lower(c.last_name) LIMIT ${limit} OFFSET ${f.offset ?? 0}`,
    p,
  );
  const total = await db().one<{ n: number }>(`SELECT count(*)::int AS n FROM (${CLIENT_SELECT} WHERE ${where.join(' AND ')}) x`, p);
  return { clients: rows.map(toClientSummary), total: total?.n ?? 0 };
}

export async function getClientRow(id: string) {
  return db().one(`${CLIENT_SELECT} WHERE c.id = $1`, [id]);
}

export async function setClientTags(clientId: string, names: string[]) {
  await db().query('DELETE FROM client_tags WHERE client_id = $1', [clientId]);
  for (const name of [...new Set(names.map((n) => n.trim()).filter(Boolean))]) {
    const tag = await db().one<{ id: string }>(
      'INSERT INTO tags(name) VALUES ($1) ON CONFLICT (name) DO UPDATE SET name = EXCLUDED.name RETURNING id', [name.slice(0, 40)]);
    await db().query('INSERT INTO client_tags(client_id, tag_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [clientId, tag!.id]);
  }
}
