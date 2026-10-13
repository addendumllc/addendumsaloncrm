import { db } from '../db/index.js';

/**
 * Privacy-conscious audit log: records actor, action and record IDs only.
 * Never pass message bodies, phone numbers, emails or notes in `detail`.
 */
export async function audit(
  staffId: string | null,
  action: string,
  entityType?: string,
  entityId?: string | null,
  detail?: Record<string, unknown>,
  ip?: string,
) {
  try {
    await db().query(
      'INSERT INTO audit_logs(staff_id, action, entity_type, entity_id, detail, ip) VALUES ($1,$2,$3,$4,$5::jsonb,$6)',
      [staffId, action, entityType ?? null, entityId ?? null, detail ? JSON.stringify(detail) : null, ip ?? null],
    );
  } catch (e) {
    console.error('[audit] failed to write audit log', (e as Error).message);
  }
}

export async function listAudit(limit = 100, entityType?: string, entityId?: string) {
  const params: unknown[] = [limit];
  let where = '';
  if (entityType && entityId) {
    where = 'WHERE a.entity_type = $2 AND a.entity_id = $3';
    params.push(entityType, entityId);
  }
  return db().query(
    `SELECT a.id, a.action, a.entity_type AS "entityType", a.entity_id AS "entityId", a.detail, a.created_at AS "createdAt",
            s.name AS "staffName"
       FROM audit_logs a LEFT JOIN staff s ON s.id = a.staff_id ${where}
      ORDER BY a.created_at DESC LIMIT $1`,
    params,
  );
}
