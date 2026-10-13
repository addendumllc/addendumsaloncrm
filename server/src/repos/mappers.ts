import type { AppointmentDisplayStatus, AppointmentDTO, SquareBookingStatus, TaskDTO } from '@addendum/shared';
import { iso } from '../lib/time.js';

/** Square has no "completed" status: a past ACCEPTED booking is treated as completed. */
export function displayStatus(status: SquareBookingStatus, endAt: Date | string, now = new Date()): AppointmentDisplayStatus {
  switch (status) {
    case 'NO_SHOW':
      return 'no_show';
    case 'CANCELLED_BY_CUSTOMER':
    case 'CANCELLED_BY_SELLER':
    case 'DECLINED':
      return 'cancelled';
    case 'PENDING':
      return 'needs_attention';
    default:
      return new Date(endAt) < now ? 'completed' : 'confirmed';
  }
}

export const APPOINTMENT_SELECT = `
  SELECT a.*, c.first_name, c.last_name, c.phone AS client_phone, c.email AS client_email,
         s.name AS staff_name, s.color AS staff_color, l.name AS location_name,
         COALESCE((SELECT array_agg(x.service_name ORDER BY x.position) FROM appointment_services x WHERE x.appointment_id = a.id), '{}') AS service_names
    FROM appointments a
    LEFT JOIN clients c ON c.id = a.client_id
    LEFT JOIN staff s ON s.id = a.staff_id
    LEFT JOIN locations l ON l.id = a.location_id`;

export function toAppointmentDTO(r: any): AppointmentDTO {
  const name = r.client_id ? `${r.first_name ?? ''} ${r.last_name ?? ''}`.trim() : null;
  return {
    id: r.id,
    squareBookingId: r.square_booking_id,
    squareCustomerId: r.square_customer_id,
    source: r.source,
    clientId: r.client_id,
    clientName: name || (r.client_id ? 'Unnamed client' : null),
    clientPhone: r.client_phone ?? null,
    clientEmail: r.client_email ?? null,
    serviceNames: r.service_names ?? [],
    staffId: r.staff_id,
    staffName: r.staff_name ?? null,
    staffColor: r.staff_color ?? null,
    locationName: r.location_name ?? null,
    startAt: iso(r.start_at)!,
    endAt: iso(r.end_at)!,
    squareStatus: r.square_status,
    displayStatus: displayStatus(r.square_status, r.end_at),
    customerNote: r.customer_note,
    sellerNote: r.seller_note,
    clientConfirmedAt: iso(r.client_confirmed_at),
    rescheduledFrom: iso(r.rescheduled_from),
    bookedValueCents: r.booked_value_cents,
  };
}

export const TASK_SELECT = `
  SELECT t.*, s.name AS assigned_staff_name,
         COALESCE(NULLIF(trim(c.first_name || ' ' || c.last_name), ''), l.name) AS contact_name,
         COALESCE(c.phone, l.phone) AS contact_phone, sv.name AS service_name,
         to_char(t.rebook_last_visit, 'YYYY-MM-DD') AS rebook_last_visit_s, to_char(t.rebook_due_date, 'YYYY-MM-DD') AS rebook_due_date_s
    FROM tasks t
    LEFT JOIN services sv ON sv.id = t.service_id
    LEFT JOIN staff s ON s.id = t.assigned_staff_id
    LEFT JOIN clients c ON c.id = t.client_id
    LEFT JOIN leads l ON l.id = t.lead_id`;

export function toTaskDTO(r: any, now = new Date()): TaskDTO {
  return {
    id: r.id,
    kind: r.kind,
    type: r.type,
    title: r.title,
    reason: r.reason,
    notes: r.notes,
    priority: r.priority,
    status: r.status,
    dueAt: iso(r.due_at)!,
    snoozedUntil: iso(r.snoozed_until),
    completedAt: iso(r.completed_at),
    clientId: r.client_id,
    leadId: r.lead_id,
    contactName: r.contact_name ?? null,
    contactPhone: r.contact_phone ?? null,
    appointmentId: r.appointment_id,
    assignedStaffId: r.assigned_staff_id,
    assignedStaffName: r.assigned_staff_name ?? null,
    sourceRule: r.source_rule,
    highlevel: {
      status: r.hl_status,
      taskId: r.hl_task_id,
      contactId: r.hl_contact_id,
      lastAttemptAt: iso(r.hl_last_attempt_at),
      lastSyncedAt: iso(r.hl_last_synced_at),
      error: r.hl_error,
    },
    isOverdue: r.status === 'due' && new Date(r.due_at) < now,
    createdAt: iso(r.created_at)!,
    serviceId: r.service_id ?? null,
    serviceName: r.service_name ?? null,
    rebook: r.type === 'rebook' && r.service_id
      ? { lastVisitDate: r.rebook_last_visit_s ?? null, recommendedDate: r.rebook_due_date_s ?? null, intervalDays: r.rebook_interval_days ?? null, source: r.rebook_source ?? null }
      : null,
  };
}

export const fullName = (r: { first_name?: string | null; last_name?: string | null }) =>
  `${r.first_name ?? ''} ${r.last_name ?? ''}`.trim();
