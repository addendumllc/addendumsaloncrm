import type { StaffDTO } from '@addendum/shared';
import { db } from '../db/index.js';

const SELECT = `
  SELECT s.*,
    (SELECT count(*)::int FROM tasks t WHERE t.assigned_staff_id = s.id AND t.status IN ('due','snoozed')) AS open_follow_ups,
    (SELECT count(*)::int FROM leads l WHERE l.assigned_staff_id = s.id AND l.status NOT IN ('won','lost') AND l.archived_at IS NULL) AS assigned_leads
  FROM staff s`;

/** A stylist: bookable online in Square; before that's known, anyone linked to a Square team member (as before). */
export const isStylistRow = (r: { square_bookable?: boolean | null; square_team_member_id?: string | null }) => r.square_bookable ?? !!r.square_team_member_id;

export function toStaffDTO(r: any): StaffDTO {
  return {
    id: r.id,
    name: r.name,
    email: r.email,
    role: r.role,
    active: r.active,
    canLogin: !!r.password_hash,
    color: r.color,
    squareTeamMemberId: r.square_team_member_id,
    stylist: isStylistRow(r),
    mobilePhone: r.mobile_phone ?? null,
    highlevelUserId: r.highlevel_user_id,
    openFollowUps: r.open_follow_ups,
    assignedLeads: r.assigned_leads,
  };
}

export async function listStaff(includeInactive = true): Promise<StaffDTO[]> {
  const rows = await db().query(`${SELECT} ${includeInactive ? '' : 'WHERE s.active'} ORDER BY s.active DESC, s.name`);
  return rows.map(toStaffDTO);
}

export async function getStaffRow(id: string) {
  return db().one('SELECT * FROM staff WHERE id = $1', [id]);
}

export async function findStaffByEmail(email: string) {
  return db().one('SELECT * FROM staff WHERE lower(email) = lower($1)', [email]);
}
