import type { CurrentUser } from '@addendum/shared';
import { can } from '../auth/permissions.js';
import { assignedClientSql, clientScope, maskContact } from '../auth/scope.js';
import { db } from '../db/index.js';

const none = Promise.resolve([] as any[]);

/**
 * Global search across clients, leads, appointments/services, notes, tags and messages — each section only for
 * people allowed to see it, and clients limited to the person's own clients when they can't see everyone.
 */
export async function globalSearch(q: string, user: CurrentUser) {
  const term = q.trim();
  if (term.length < 2) return { clients: [], leads: [], appointments: [], messages: [], notes: [] };
  const seesClients = can(user, 'clients:read') || can(user, 'clients:read_assigned');
  const scope = clientScope(user);
  const contact = can(user, 'clients:contact');
  const apptOwn = !can(user, 'appointments:read') && can(user, 'appointments:read_own');
  const seesAppts = can(user, 'appointments:read') || apptOwn;
  const like = `%${term}%`;
  const digits = term.replace(/\D/g, '');
  const phoneLike = digits.length >= 3 ? `%${digits}%` : '__no_match__';
  const [clients, leads, appointments, messages, notes] = await Promise.all([
    !seesClients ? none : db().query(
      `SELECT DISTINCT c.id, trim(c.first_name || ' ' || c.last_name) AS name, c.phone, c.email
         FROM clients c LEFT JOIN client_tags ct ON ct.client_id = c.id LEFT JOIN tags t ON t.id = ct.tag_id
        WHERE c.archived_at IS NULL AND ((c.first_name || ' ' || c.last_name) ILIKE $1 OR t.name ILIKE $1
              ${contact ? 'OR c.email ILIKE $1 OR c.phone LIKE $2' : ''})
          ${scope ? `AND ${assignedClientSql('c', 3)}` : ''}
        LIMIT 8`,
      scope ? [like, phoneLike, scope] : [like, phoneLike],
    ).then((rows) => rows.map((r) => maskContact(user, r))),
    !can(user, 'leads:read') ? none : db().query(
      `SELECT id, name, phone, email, status, service_interest AS "serviceInterest" FROM leads
        WHERE archived_at IS NULL AND (name ILIKE $1 OR email ILIKE $1 OR phone LIKE $2 OR service_interest ILIKE $1 OR notes ILIKE $1) LIMIT 8`,
      [like, phoneLike],
    ),
    !seesAppts ? none : db().query(
      `SELECT a.id, a.start_at AS "startAt", a.client_id AS "clientId", trim(c.first_name || ' ' || c.last_name) AS "clientName",
              string_agg(x.service_name, ', ') AS services
         FROM appointments a LEFT JOIN clients c ON c.id = a.client_id LEFT JOIN appointment_services x ON x.appointment_id = a.id
        WHERE (x.service_name ILIKE $1 OR (c.first_name || ' ' || c.last_name) ILIKE $1 OR a.square_booking_id = $2)
          ${apptOwn ? 'AND a.staff_id = $3' : ''}
        GROUP BY a.id, c.first_name, c.last_name ORDER BY abs(extract(epoch FROM a.start_at - now())) LIMIT 8`,
      apptOwn ? [like, term, user.id] : [like, term],
    ),
    !can(user, 'messages:read') ? none : db().query(
      `SELECT m.id, m.body, m.created_at AS "createdAt", m.conversation_id AS "conversationId",
              COALESCE(NULLIF(trim(c.first_name || ' ' || c.last_name), ''), l.name, cv.phone) AS name
         FROM messages m JOIN conversations cv ON cv.id = m.conversation_id
         LEFT JOIN clients c ON c.id = cv.client_id LEFT JOIN leads l ON l.id = cv.lead_id
        WHERE m.body ILIKE $1 AND m.status <> 'draft' ORDER BY m.created_at DESC LIMIT 6`,
      [like],
    ),
    !can(user, 'clients:history') ? none : db().query(
      `SELECT n.id, n.body, n.client_id AS "clientId", n.lead_id AS "leadId",
              COALESCE(NULLIF(trim(c.first_name || ' ' || c.last_name), ''), l.name) AS name
         FROM notes n LEFT JOIN clients c ON c.id = n.client_id LEFT JOIN leads l ON l.id = n.lead_id
        WHERE n.body ILIKE $1
          AND ${scope ? `n.client_id IS NOT NULL AND ${assignedClientSql('c', 2)}` : `(n.client_id IS NOT NULL OR ${can(user, 'leads:read')})`}
        ORDER BY n.created_at DESC LIMIT 6`,
      scope ? [like, scope] : [like],
    ),
  ]);
  return { clients, leads, appointments, messages, notes };
}
