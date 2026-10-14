// Shared types and constants used by both the server API and the web app.
// Keep this file free of runtime dependencies so it can be imported anywhere.

/** The four built-in role templates. Administrators can add their own templates too (see RoleTemplateDTO). */
export type BuiltinRole = 'admin' | 'receptionist' | 'stylist' | 'assistant';
/** A role template key: one of the built-in ones, or a custom template's key. */
export type Role = BuiltinRole | (string & {});

export const ROLES: BuiltinRole[] = ['admin', 'receptionist', 'stylist', 'assistant'];
export const isBuiltinRole = (r: string): r is BuiltinRole => (ROLES as string[]).includes(r);

/** New employee accounts start as Assistant (least access) unless an administrator chooses otherwise. */
export const DEFAULT_ROLE: BuiltinRole = 'assistant';

export const ROLE_LABELS: Record<BuiltinRole, string> = {
  admin: 'Admin',
  receptionist: 'Reception',
  stylist: 'Stylist',
  assistant: 'Assistant',
};

export const ROLE_DESCRIPTIONS: Record<BuiltinRole, string> = {
  admin: 'Business administrators: settings, team, integrations, reports.',
  receptionist: 'Front desk: calendar, clients, leads, texting and follow-ups.',
  stylist: 'Service providers: their own calendar, hair orders and commission.',
  assistant: 'Default for new accounts: limited, day-to-day help with clients and follow-ups.',
};

// ---------------- Permissions ----------------
// One catalog used by the server (enforcement) and the web app (Users & Permissions screen).
// A person's effective permissions = their role template + individual grants − individual denials.

export type PermissionAction = 'view' | 'create' | 'edit' | 'delete' | 'approve' | 'export';

export interface PermissionDef {
  key: string;
  category: string;
  action: PermissionAction;
  label: string;
  description: string;
  /** High-risk: needs explicit confirmation to grant, and is never in a non-admin template by default. */
  sensitive?: boolean;
}

export const PERMISSION_CATEGORIES = [
  'Dashboard and analytics',
  'Customers',
  'Customer contact information',
  'Service history and private notes',
  'New Clients and messages',
  'Appointments and calendar',
  'Services and pricing',
  'Follow-ups and rebooking',
  'Products and inventory',
  'Square and Shopify sync',
  'Transactions',
  'Personal commission',
  'Team commission',
  'Employee management',
  'User management and roles',
  'API keys, secrets and integrations',
  'CRM settings',
  'Data exports',
  'Audit logs',
] as const;

export const PERMISSIONS_CATALOG: PermissionDef[] = [
  { key: 'dashboard:view', category: 'Dashboard and analytics', action: 'view', label: 'Dashboard', description: 'Today’s work: follow-ups, appointments, messages. No revenue figures.' },
  { key: 'analytics:read', category: 'Dashboard and analytics', action: 'view', label: 'Business analytics', description: 'Analytics page: bookings, conversion and business performance.', sensitive: true },

  { key: 'clients:read', category: 'Customers', action: 'view', label: 'View all customers', description: 'Customer list, search and profiles.' },
  { key: 'clients:read_assigned', category: 'Customers', action: 'view', label: 'View their own customers', description: 'Only customers they have served or are assigned to.' },
  { key: 'clients:write', category: 'Customers', action: 'edit', label: 'Create and edit customers', description: 'Add customers and update their details and tags.' },
  { key: 'clients:archive', category: 'Customers', action: 'edit', label: 'Archive and restore customers', description: 'Hide customers from lists without deleting them.' },
  { key: 'clients:delete', category: 'Customers', action: 'delete', label: 'Delete customers', description: 'Permanently delete a customer and their CRM history.', sensitive: true },

  { key: 'clients:contact', category: 'Customer contact information', action: 'view', label: 'See phone numbers and emails', description: 'Without this, contact details are hidden everywhere.' },

  { key: 'clients:history', category: 'Service history and private notes', action: 'view', label: 'See service history and notes', description: 'Past appointments and private customer notes.' },
  { key: 'clients:notes', category: 'Service history and private notes', action: 'create', label: 'Add and edit notes', description: 'Record service notes on customers they can see.' },

  { key: 'leads:read', category: 'New Clients and messages', action: 'view', label: 'View New Clients', description: 'The New Clients tab: inquiries and their details.' },
  { key: 'leads:write', category: 'New Clients and messages', action: 'edit', label: 'Create and edit in New Clients', description: 'Add, update, convert and close entries in New Clients.' },
  { key: 'messages:read', category: 'New Clients and messages', action: 'view', label: 'Read messages', description: 'Text message inbox.' },
  { key: 'messages:send', category: 'New Clients and messages', action: 'create', label: 'Send messages', description: 'Draft and send texts to customers.' },

  { key: 'appointments:read', category: 'Appointments and calendar', action: 'view', label: 'Can view team calendars', description: 'Other team members’ appointments: everyone’s, or only the people chosen on their account. Viewing never allows changes.' },
  { key: 'appointments:read_own', category: 'Appointments and calendar', action: 'view', label: 'View their own calendar', description: 'Only appointments where they are the provider.' },
  { key: 'square:sync', category: 'Appointments and calendar', action: 'edit', label: 'Refresh from Square', description: 'Pull the latest bookings from Square now.' },

  { key: 'services:read', category: 'Services and pricing', action: 'view', label: 'View services and prices', description: 'The service menu with durations and prices.' },

  { key: 'tasks:read_own', category: 'Follow-ups and rebooking', action: 'view', label: 'View their own follow-ups', description: 'Follow-ups assigned to them or unassigned.' },
  { key: 'tasks:read_all', category: 'Follow-ups and rebooking', action: 'view', label: 'View everyone’s follow-ups', description: 'All follow-ups and tasks.' },
  { key: 'tasks:write', category: 'Follow-ups and rebooking', action: 'edit', label: 'Work follow-ups', description: 'Create, complete, snooze and close follow-ups they can see.' },
  { key: 'tasks:assign', category: 'Follow-ups and rebooking', action: 'edit', label: 'Assign follow-ups', description: 'Assign follow-ups to other team members.' },
  { key: 'highlevel:push', category: 'Follow-ups and rebooking', action: 'create', label: 'Send to HighLevel', description: 'Push follow-ups to HighLevel.' },
  { key: 'rebooking:client', category: 'Follow-ups and rebooking', action: 'edit', label: 'Customize a customer’s rebooking', description: 'Per-customer intervals, preferred dates and reminders.' },
  { key: 'rebooking:defaults', category: 'Follow-ups and rebooking', action: 'edit', label: 'Edit service rebooking defaults', description: 'Default intervals and reminders for each service.' },
  { key: 'settings:rules', category: 'Follow-ups and rebooking', action: 'edit', label: 'Edit follow-up rules', description: 'Follow-up rules, saved replies and tags.' },

  { key: 'inventory:view', category: 'Products and inventory', action: 'view', label: 'View products and stock', description: 'Product list with Square stock levels.' },
  { key: 'inventory:order', category: 'Products and inventory', action: 'create', label: 'Order hair for themselves', description: 'Send hair orders to Addendum Hair.' },
  { key: 'inventory:order_for_others', category: 'Products and inventory', action: 'create', label: 'Order hair for others', description: 'Place orders on behalf of stylists.' },
  { key: 'inventory:read_all', category: 'Products and inventory', action: 'view', label: 'View all hair orders', description: 'Everyone’s order requests.' },
  { key: 'inventory:manage', category: 'Products and inventory', action: 'edit', label: 'Manage orders and stock', description: 'Update order status and edit stock quantities in Square.' },
  { key: 'shopify:push', category: 'Products and inventory', action: 'edit', label: 'Update Shopify stock', description: 'Push stock levels to Shopify manually.' },

  { key: 'inventory:sync', category: 'Square and Shopify sync', action: 'approve', label: 'Run inventory sync', description: 'Run the Square ↔ Shopify sync, resolve conflicts and link products.' },

  { key: 'transactions:read', category: 'Transactions', action: 'view', label: 'View sales transactions', description: 'Square sales, refunds and tips synced into the CRM.', sensitive: true },

  { key: 'commission:own', category: 'Personal commission', action: 'view', label: 'View their own commission', description: 'My Commission: their own earnings by date.' },

  { key: 'commission:team', category: 'Team commission', action: 'view', label: 'View team commission', description: 'Everyone’s commission and earnings.', sensitive: true },
  { key: 'commission:manage', category: 'Team commission', action: 'edit', label: 'Edit commission plans', description: 'Commission rates, rules and effective dates.', sensitive: true },
  { key: 'commission:approve', category: 'Team commission', action: 'approve', label: 'Finalize and adjust commission', description: 'Finalize pay periods, add adjustments and resolve reviews.', sensitive: true },
  { key: 'commission:export', category: 'Team commission', action: 'export', label: 'Export commission reports', description: 'Download commission reports for payroll.', sensitive: true },

  { key: 'staff:read', category: 'Employee management', action: 'view', label: 'View the team', description: 'Team member names and colours (no permissions).' },
  { key: 'users:manage', category: 'Employee management', action: 'edit', label: 'Manage employee accounts', description: 'Create, edit, deactivate and reactivate accounts; send password resets.', sensitive: true },

  { key: 'users:permissions', category: 'User management and roles', action: 'edit', label: 'Assign roles and permissions', description: 'Change roles, grant or remove permissions, including Admin.', sensitive: true },

  { key: 'integrations:manage', category: 'API keys, secrets and integrations', action: 'edit', label: 'Manage integrations and API keys', description: 'Square, Shopify, HighLevel, email and AI connections and credentials.', sensitive: true },

  { key: 'settings:read', category: 'CRM settings', action: 'view', label: 'View settings', description: 'Open the Settings area.' },
  { key: 'settings:write', category: 'CRM settings', action: 'edit', label: 'Edit business settings', description: 'Business details, appearance, inventory sync and other admin settings.', sensitive: true },

  { key: 'clients:export', category: 'Data exports', action: 'export', label: 'Export a customer’s data', description: 'Download one customer’s full record.', sensitive: true },
  { key: 'privacy:export_all', category: 'Data exports', action: 'export', label: 'Export all data', description: 'Download the full CRM data export.', sensitive: true },

  { key: 'audit:read', category: 'Audit logs', action: 'view', label: 'View the activity log', description: 'Who did what, and when.', sensitive: true },
  { key: 'audit:export', category: 'Audit logs', action: 'export', label: 'Export the activity log', description: 'Download the activity log.', sensitive: true },
];

export const PERMISSION_KEYS = PERMISSIONS_CATALOG.map((p) => p.key);
export const SENSITIVE_PERMISSIONS = PERMISSIONS_CATALOG.filter((p) => p.sensitive).map((p) => p.key);

/**
 * Role template defaults (starting points; administrators can edit the templates and each person).
 * Reception and Stylist match what those roles could do before per-person permissions existed, plus "own commission".
 */
export const ROLE_DEFAULT_PERMISSIONS: Record<BuiltinRole, string[]> = {
  admin: PERMISSION_KEYS,
  receptionist: [
    'dashboard:view', 'clients:read', 'clients:write', 'clients:contact', 'clients:history', 'clients:notes',
    'leads:read', 'leads:write', 'appointments:read', 'messages:read', 'messages:send', 'services:read',
    'tasks:read_own', 'tasks:read_all', 'tasks:write', 'tasks:assign', 'rebooking:client',
    'staff:read', 'highlevel:push', 'square:sync',
    'inventory:view', 'inventory:order', 'inventory:read_all', 'inventory:order_for_others', 'commission:own',
  ],
  // Their own appointments, their own clients (contact, history, notes), their own follow-ups, hair orders, commission.
  stylist: [
    'appointments:read_own', 'clients:read_assigned', 'clients:contact', 'clients:history', 'clients:notes', 'services:read',
    'tasks:read_own', 'tasks:write', 'inventory:view', 'inventory:order', 'commission:own',
  ],
  // Their own calendar (team calendars when an Owner/Admin allows it), assigned follow-ups, needed client details.
  assistant: [
    'dashboard:view', 'appointments:read_own', 'clients:read', 'clients:contact', 'clients:history', 'services:read',
    'tasks:read_own', 'tasks:write', 'rebooking:client', 'inventory:view', 'staff:read', 'commission:own',
  ],
};

/**
 * Earlier built-in defaults. A template that still matches one of these exactly (nobody edited it) is moved to the
 * current defaults on start-up; a template an administrator changed is left alone.
 */
export const PREVIOUS_ROLE_DEFAULTS: Partial<Record<BuiltinRole, string[][]>> = {
  stylist: [['appointments:read_own', 'inventory:view', 'inventory:order', 'commission:own']],
  assistant: [[
    'dashboard:view', 'appointments:read', 'clients:read', 'clients:contact', 'clients:history', 'services:read',
    'tasks:read_own', 'tasks:read_all', 'tasks:write', 'rebooking:client', 'inventory:view', 'staff:read', 'commission:own',
  ], [
    'dashboard:view', 'appointments:read', 'clients:read', 'clients:contact', 'clients:history', 'services:read',
    'tasks:read_own', 'tasks:write', 'rebooking:client', 'inventory:view', 'staff:read', 'commission:own',
  ]],
};

export type PermissionSource = 'role' | 'granted' | 'denied' | 'none';

export interface EffectivePermissionDTO {
  key: string;
  effective: boolean;
  fromRole: boolean;
  override: boolean | null; // true = granted to this person, false = removed for this person
  source: PermissionSource;
}

/**
 * pending: has a login but is waiting for an Admin to approve it (can't use the CRM). active: approved and working.
 * rejected: the request was turned down. disabled: approved before, deactivated since.
 */
export type AccountStatus = 'pending' | 'active' | 'rejected' | 'disabled';
export const ACCOUNT_STATUS_LABEL: Record<AccountStatus, string> = { pending: 'Pending approval', active: 'Active', rejected: 'Rejected', disabled: 'Deactivated' };

export interface StaffAccountDTO {
  id: string;
  name: string;
  email: string | null;
  role: Role;
  roleLabel: string;
  status: AccountStatus;
  /** Asked for access from the sign-in screen (rather than being added by an administrator). */
  selfRequested: boolean;
  requestedAt: string | null;
  approvedAt: string | null;
  approvedByName: string | null;
  /** Team calendars they may view (null = everyone, when they have "Can view team calendars"). */
  calendarStaffIds: string[] | null;
  active: boolean;
  color: string;
  canSignIn: boolean;
  squareTeamMemberId: string | null;
  lastLoginAt: string | null;
  createdAt: string;
  overrideCount: number;
  effectiveCount: number;
  sensitiveCount: number;
}

export interface StaffAccountDetailDTO extends StaffAccountDTO {
  permissions: EffectivePermissionDTO[];
}

export interface RoleTemplateDTO {
  role: Role;
  label: string;
  description: string;
  permissions: string[];
  /** Built-in defaults (empty for custom templates). */
  defaults: string[];
  /** Built-in templates can't be renamed or deleted; custom ones can. */
  builtin: boolean;
  /** Active people using it. */
  members: number;
  /** Everyone using it, including pending and deactivated accounts (a template in use can't be deleted). */
  totalMembers: number;
}

export interface PermissionPreviewDTO {
  added: string[];
  removed: string[];
  sensitiveAdded: string[];
  droppedOverrides: string[];
  effective: string[];
}

/** Square booking statuses exactly as Square returns them (verified against Square API 2026-09-16). */
export type SquareBookingStatus =
  | 'PENDING'
  | 'ACCEPTED'
  | 'CANCELLED_BY_CUSTOMER'
  | 'CANCELLED_BY_SELLER'
  | 'DECLINED'
  | 'NO_SHOW';

/**
 * Display status derived from the Square status. Square has no "completed" status,
 * so a past ACCEPTED booking is shown as completed.
 */
export type AppointmentDisplayStatus =
  | 'confirmed'
  | 'needs_attention'
  | 'completed'
  | 'cancelled'
  | 'no_show';

export const APPOINTMENT_STATUS_LABELS: Record<AppointmentDisplayStatus, string> = {
  confirmed: 'Confirmed',
  needs_attention: 'Needs attention',
  completed: 'Completed',
  cancelled: 'Cancelled',
  no_show: 'No-show',
};

export type LeadStatus =
  | 'new'
  | 'contacted'
  | 'waiting'
  | 'interested'
  | 'consultation_scheduled'
  | 'booked'
  | 'follow_up_needed'
  | 'won'
  | 'lost';

export const LEAD_STATUSES: { value: LeadStatus; label: string }[] = [
  { value: 'new', label: 'New' },
  { value: 'contacted', label: 'Contacted' },
  { value: 'waiting', label: 'Waiting for Response' },
  { value: 'interested', label: 'Interested' },
  { value: 'consultation_scheduled', label: 'Consultation Scheduled' },
  { value: 'booked', label: 'Appointment Booked' },
  { value: 'follow_up_needed', label: 'Follow-Up Needed' },
  { value: 'won', label: 'Won' },
  { value: 'lost', label: 'Lost' },
];

export const LEAD_SOURCES = [
  'Instagram',
  'Website',
  'Text message',
  'Referral',
  'Walk-in',
  'Google',
  'Phone call',
  'Event',
  'Other',
] as const;

export type TaskKind = 'follow_up' | 'task';

export type TaskType =
  | 'follow_up'
  | 'call'
  | 'text'
  | 'rebook'
  | 'appointment_reminder'
  | 'consultation'
  | 'no_show'
  | 'cancellation'
  | 'review_request'
  | 'new_lead'
  | 'reply'
  | 'internal';

export const TASK_TYPE_LABELS: Record<TaskType, string> = {
  follow_up: 'Follow Up',
  call: 'Call',
  text: 'Text',
  rebook: 'Rebook',
  appointment_reminder: 'Appointment Reminder',
  consultation: 'Consultation',
  no_show: 'No-Show Follow-Up',
  cancellation: 'Cancellation Follow-Up',
  review_request: 'Review Request',
  new_lead: 'New Lead',
  reply: 'Reply to Message',
  internal: 'Internal Task',
};

export type TaskStatus = 'due' | 'completed' | 'snoozed' | 'cancelled';
export type Priority = 'high' | 'medium' | 'low';

export type HighLevelSyncStatus =
  | 'not_pushed'
  | 'pending'
  | 'synced'
  | 'failed'
  | 'needs_contact';

export const DEFAULT_TAGS = [
  'New Client',
  'VIP',
  'Hair Color',
  'Haircut',
  'Extensions',
  'Bridal',
  'Consultation',
  'Returning',
  'Needs Follow-Up',
  'At Risk',
  'Referral',
];

export type MessageDirection = 'inbound' | 'outbound';
export type MessageStatus =
  | 'draft'
  | 'queued'
  | 'sent'
  | 'delivered'
  | 'failed'
  | 'received'
  | 'undelivered'
  /** Apple Messages hand-off: opened in Messages; the CRM can't see whether it was sent. */
  | 'opened_in_messages'
  /** A staff member confirmed they sent it from Messages (not a delivery receipt). */
  | 'marked_sent'
  /** Staff said it wasn't sent after all. */
  | 'not_sent';

export type DraftKind =
  | 'lead_reply'
  | 'general_reply'
  | 'appointment_follow_up'
  | 'rebooking'
  | 'no_show'
  | 'cancellation'
  | 'review_request'
  | 'appointment_reminder';

export interface StaffDTO {
  id: string;
  name: string;
  email: string | null;
  role: Role;
  active: boolean;
  canLogin: boolean;
  color: string;
  squareTeamMemberId: string | null;
  highlevelUserId: string | null;
  openFollowUps?: number;
  assignedLeads?: number;
}

export interface ClientSummaryDTO {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  tags: string[];
  preferredStaffName: string | null;
  lastAppointmentAt: string | null;
  nextAppointmentAt: string | null;
  lastService: string | null;
  visitCount: number;
  squareCustomerId: string | null;
  archived: boolean;
}

export interface RebookingInsight {
  enough: boolean;
  visits: number;
  typicalIntervalDays: number | null;
  daysSinceLast: number | null;
  overdueByDays: number | null;
  isOverdue: boolean;
  hasFutureAppointment: boolean;
  message: string;
}

export type RebookingStatus = 'booked' | 'upcoming' | 'due_soon' | 'overdue' | 'off' | 'no_interval' | 'no_visit';
export type RebookingSource = 'client' | 'service' | 'history' | 'preferred';

/** A service's default rebooking schedule (Settings → Rebooking). */
export interface ServiceRebookingRuleDTO {
  serviceId: string;
  serviceName: string;
  minDays: number | null;
  maxDays: number | null;
  targetDays: number;
  remindBeforeDays: number;
  autoFollowUp: boolean;
  updatedAt: string | null;
}

/** One client's custom settings for one service. null fields mean "use the service default". */
export interface ClientRebookingOverrideDTO {
  serviceId: string;
  intervalDays: number | null;
  preferredNextDate: string | null; // YYYY-MM-DD
  lastVisitDate: string | null; // YYYY-MM-DD, a visit not recorded in Square
  remindBeforeDays: number | null;
  followUpsEnabled: boolean | null;
  note: string | null;
  updatedAt: string | null;
}

/** The worked-out schedule for one client + service, with where each value came from. Dates are YYYY-MM-DD. */
export interface ClientServiceScheduleDTO {
  serviceId: string;
  serviceName: string;
  visits: number;
  lastVisitDate: string | null;
  lastVisitSource: 'square' | 'manual' | null;
  intervalDays: number | null;
  intervalSource: 'client' | 'service' | 'history' | null;
  historyIntervalDays: number | null;
  serviceDefault: { minDays: number | null; maxDays: number | null; targetDays: number; remindBeforeDays: number; autoFollowUp: boolean } | null;
  suggestedNextDate: string | null;
  nextDate: string | null;
  nextDateSource: 'preferred' | 'calculated' | null;
  windowStart: string | null;
  windowEnd: string | null;
  remindBeforeDays: number;
  remindSource: 'client' | 'service' | 'default';
  reminderDate: string | null;
  followUpsEnabled: boolean;
  followUpsSource: 'client' | 'service' | 'default';
  status: RebookingStatus;
  daysUntilNext: number | null;
  nextBookedDate: string | null;
  otherBookingDate: string | null;
  override: ClientRebookingOverrideDTO | null;
  openTaskId: string | null;
}

export interface RebookingScheduleRowDTO extends ClientServiceScheduleDTO {
  clientId: string;
  clientName: string;
  clientPhone: string | null;
}

export interface AppointmentDTO {
  id: string;
  squareBookingId: string | null;
  squareCustomerId: string | null;
  source: 'square' | 'demo';
  clientId: string | null;
  clientName: string | null;
  clientPhone: string | null;
  clientEmail: string | null;
  serviceNames: string[];
  staffId: string | null;
  staffName: string | null;
  staffColor: string | null;
  locationName: string | null;
  startAt: string;
  endAt: string;
  squareStatus: SquareBookingStatus;
  displayStatus: AppointmentDisplayStatus;
  customerNote: string | null;
  sellerNote: string | null;
  clientConfirmedAt: string | null;
  rescheduledFrom: string | null;
  bookedValueCents: number | null;
}

export interface MessageDTO {
  id: string;
  conversationId: string;
  direction: MessageDirection;
  body: string;
  status: MessageStatus;
  aiGenerated: boolean;
  sentByName: string | null;
  createdAt: string;
  errorMessage: string | null;
}

export interface MessageInsight {
  intent: string;
  isPotentialLead: boolean;
  service: string | null;
  timeframe: string | null;
  summary: string;
}

export interface ConversationDTO {
  id: string;
  phone: string;
  displayName: string;
  clientId: string | null;
  leadId: string | null;
  unreadCount: number;
  lastMessageAt: string | null;
  lastMessagePreview: string | null;
  optedOut: boolean;
  insight: MessageInsight | null;
}

export interface TaskDTO {
  id: string;
  kind: TaskKind;
  type: TaskType;
  title: string;
  reason: string | null;
  notes: string | null;
  priority: Priority;
  status: TaskStatus;
  dueAt: string;
  snoozedUntil: string | null;
  completedAt: string | null;
  clientId: string | null;
  leadId: string | null;
  contactName: string | null;
  contactPhone: string | null;
  appointmentId: string | null;
  assignedStaffId: string | null;
  assignedStaffName: string | null;
  sourceRule: string | null;
  highlevel: {
    status: HighLevelSyncStatus;
    taskId: string | null;
    contactId: string | null;
    lastAttemptAt: string | null;
    lastSyncedAt: string | null;
    error: string | null;
  };
  isOverdue: boolean;
  createdAt: string;
  /** Rebooking follow-ups: which service and cycle they're for. */
  serviceId: string | null;
  serviceName: string | null;
  rebook: { lastVisitDate: string | null; recommendedDate: string | null; intervalDays: number | null; source: RebookingSource | null } | null;
}

export interface LeadDTO {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  source: string | null;
  serviceInterest: string | null;
  status: LeadStatus;
  assignedStaffId: string | null;
  assignedStaffName: string | null;
  lastContactAt: string | null;
  nextFollowUpAt: string | null;
  notes: string | null;
  clientId: string | null;
  createdAt: string;
  unreadCount: number;
}

export interface IntegrationStatusDTO {
  demoMode: boolean;
  square: {
    connected: boolean;
    mode: 'demo' | 'oauth' | 'access_token' | 'disconnected';
    environment: 'production' | 'sandbox' | 'demo';
    merchantName: string | null;
    lastSyncAt: string | null;
    lastSyncStatus: 'ok' | 'failed' | 'never';
    lastSyncMessage: string | null;
    webhooksConfigured: boolean;
    needsReconnect: boolean;
  };
  /** Texts are sent by staff from Apple Messages on their own device; there's no SMS provider to connect. */
  sms: {
    connected: boolean;
    provider: 'apple_messages';
    phoneNumber: null;
  };
  highlevel: {
    connected: boolean;
    mode: 'demo' | 'private_token' | 'disconnected';
    locationId: string | null;
    pendingRetries: number;
    simulateOutage?: boolean;
  };
  ai: { enabled: boolean; provider: 'anthropic' | 'built_in' };
  email: { connected: boolean; provider: 'smtp' | 'demo' | 'none' };
  shopify: { connected: boolean; mode: 'live' | 'demo' | 'disconnected'; store: string | null };
}

export interface FollowUpRules {
  newLeadHours: number;
  leadNoResponseHours: number;
  leadSecondNoResponseHours: number;
  cancellationEnabled: boolean;
  cancellationDelayHours: number;
  noShowEnabled: boolean;
  noShowDelayHours: number;
  reviewRequestEnabled: boolean;
  reviewDelayHours: number;
  rebookingEnabled: boolean;
  rebookingGraceDays: number;
  rebookingMinVisits: number;
  rebookingNoHistoryOnly: boolean;
  unreadMessageMinutes: number;
}

// ---------------- Commission ----------------
export interface CommissionSettings {
  /** Turns on Square sales sync and My Commission for the team. */
  enabled: boolean;
  /** Sync from Square on a schedule. */
  autoSync: boolean;
  syncIntervalMinutes: number;
  /** First date to bring sales in from (YYYY-MM-DD). */
  syncStartDate: string | null;
  /** Commission is worked out on the price before or after discounts. */
  basis: 'after_discounts' | 'before_discounts';
  /** Refunds take back the commission that was paid on them (at the original rate), or are ignored. */
  refunds: 'reverse' | 'ignore';
  /** Services paid for with a package, comp or 100% discount. */
  zeroPriced: 'no_commission' | 'regular_price' | 'review';
  /** A service line two or more providers worked on. */
  multiProvider: 'split_evenly' | 'review';
  /** Who gets credit for retail sold during a visit. */
  productAttribution: 'appointment_provider' | 'payment_team_member';
  /** Tips are shown separately from commission, or left out of these reports. */
  tips: 'separate' | 'exclude';
  tipAttribution: 'service_share' | 'payment_team_member';
}

export type CommissionKind = 'sale' | 'refund' | 'tip' | 'adjustment';
export type CommissionCategory = 'service' | 'retail' | 'tip' | 'other';
export type CommissionStatus = 'estimated' | 'finalized' | 'void';

export interface CommissionTier {
  upToCents: number | null;
  rateBps: number;
}

export interface CommissionRuleDTO {
  id: string;
  staffId: string | null;
  staffName: string | null;
  category: 'service' | 'retail';
  targetType: 'all' | 'service' | 'product';
  targetId: string | null;
  targetName: string | null;
  method: 'percent' | 'flat' | 'tiered';
  rateBps: number | null;
  flatCents: number | null;
  tiers: CommissionTier[] | null;
  tierPeriod: 'month' | 'week';
  effectiveFrom: string;
  effectiveTo: string | null;
  note: string | null;
  createdByName: string | null;
  createdAt: string;
  active: boolean;
  label: string;
  usedCount: number;
}

export interface CommissionEntryDTO {
  id: string;
  staffId: string | null;
  staffName: string | null;
  kind: CommissionKind;
  category: CommissionCategory;
  status: CommissionStatus;
  squareOrderId: string | null;
  squareLineItemUid: string | null;
  squarePaymentIds: string[];
  sourceOrderId: string | null;
  appointmentId: string | null;
  itemName: string;
  quantity: number;
  share: number;
  transactionAt: string;
  transactionDate: string;
  serviceDate: string | null;
  postedDate: string;
  grossCents: number;
  discountCents: number;
  eligibleCents: number;
  netSalesCents: number;
  tipCents: number;
  method: string | null;
  rateBps: number | null;
  flatCents: number | null;
  commissionCents: number;
  calc: { steps: string[]; rule?: string | null; basis?: string | null };
  attribution: string | null;
  needsReview: boolean;
  reviewReason: string | null;
  note: string | null;
  finalizedAt: string | null;
}

export interface CommissionSummaryDTO {
  from: string;
  to: string;
  staffId: string | null;
  totalCommissionCents: number;
  serviceCommissionCents: number;
  retailCommissionCents: number;
  refundsCents: number; // commission taken back by refunds (negative)
  adjustmentsCents: number;
  tipsCents: number;
  estimatedCents: number;
  finalizedCents: number;
  totalSalesCents: number;
  serviceSalesCents: number;
  retailSalesCents: number;
  entries: number;
  needsReview: number;
}

export interface CommissionTeamRowDTO extends CommissionSummaryDTO {
  staffName: string;
  squareLinked: boolean;
}

export interface CommissionStatusDTO {
  enabled: boolean;
  squareConnected: boolean;
  lastSuccessfulSyncAt: string | null;
  lastRun: { id: string; status: string; startedAt: string; finishedAt: string | null; message: string | null; ordersSeen: number; created: number; updated: number; needsReview: number } | null;
  needsReview: number;
  unlinkedTeamMembers: string[];
  missing: string[];
}

export interface CommissionPeriodDTO {
  id: string;
  startDate: string;
  endDate: string;
  finalizedAt: string;
  finalizedByName: string | null;
  note: string | null;
  totals: Record<string, { name: string; commissionCents: number; tipsCents: number; salesCents: number }>;
}

export interface AppSettings {
  business: {
    name: string;
    address: string;
    phone: string;
    website: string;
    bookingUrl: string;
    reviewUrl: string;
    timezone: string;
    hours: string;
  };
  rules: FollowUpRules;
  reminders: {
    enabled: boolean;
    offsetsHours: number[];
    autoSend: boolean;
    template: string;
  };
  reviews: {
    message: string;
    autoSend: boolean;
  };
  ai: {
    enabled: boolean;
    autoSend: boolean;
    tone: string;
  };
  commission: CommissionSettings;
  inventorySync: {
    /** Sync automatically on a schedule (and when Square reports a stock change). */
    enabled: boolean;
    intervalMinutes: number;
    /** The first time a product is paired and the two counts differ, which system's count is kept. */
    firstSyncSource: 'square' | 'shopify';
    /** Hold any single change larger than this many units for review (0 = no limit). */
    holdChangesOver: number;
  };
  replies: {
    /** The salon's own saved text replies (Settings → Saved replies). */
    items: SavedReply[];
  };
  messaging: {
    autoCreateLeadFromUnknown: boolean;
    quietHoursStart: string;
    quietHoursEnd: string;
    signature: string;
  };
  notifications: {
    email: boolean;
    sms: boolean;
    browser: boolean;
    notifyEmail: string;
  };
  highlevel: {
    defaultAssigneeUserId: string | null;
    autoCreateContacts: boolean;
    automations: Record<HighLevelAutomationKey, boolean>;
  };
  inventory: {
    /** Where order requests are emailed. */
    orderEmail: string;
    /** Copy the person who submitted it (if they have an email). */
    ccRequester: boolean;
    /** Products offered as quick picks when building a request (one per line in Settings). */
    catalog: string[];
  };
  appearance: Appearance;
  /** Where the CRM can be used from (Settings → Location & Access). Changed only through PUT /api/access. */
  access: AccessSettings;
  /** Sign-in screen: let people ask for an account. Requests always wait for an Admin's approval. */
  accounts: { allowAccessRequests: boolean };
  onboardingComplete: boolean;
}

export const DEFAULT_ACCENT = '#6B3F55';

/**
 * Location & Access. With "Allow Access Anywhere" off and at least one salon IP registered, desktop browsers can only
 * use the CRM from the salon's internet connection. Phones and tablets follow their existing rules unless
 * restrictMobile is on. It never changes anyone's permissions.
 */
export interface AccessSettings {
  allowAnywhere: boolean;
  /** Approved networks — the salon, an office… — each with its public IP address (IPv4 or IPv6). */
  networks: ApprovedNetwork[];
  restrictMobile: boolean;
  /** Earlier versions stored unnamed IPs here; they're read as networks named "Salon". */
  salonIps?: string[];
}
export interface ApprovedNetwork { name: string; ip: string }

/** The approved networks, including ones saved by earlier versions (unnamed IPs → "Salon"). */
export const approvedNetworks = (a: Pick<AccessSettings, 'networks' | 'salonIps'>): ApprovedNetwork[] =>
  a.networks?.length ? a.networks : (a.salonIps ?? []).map((ip) => ({ name: 'Salon', ip }));

export interface AccessStatusDTO {
  /** This connection's public IP, as the server sees it. */
  ip: string;
  mobile: boolean;
  /** On one of the approved networks (salon, office…). */
  onSalonNetwork: boolean;
  /** Which approved network this connection is on, if any. */
  networkName: string | null;
  allowAnywhere: boolean;
  /** An approved network is registered (until then nothing is restricted). */
  configured: boolean;
  /** The server's recovery switch (ACCESS_ALLOW_ANYWHERE) is on. */
  overridden: boolean;
  /** This request would be refused. */
  restricted: boolean;
  canManage: boolean;
  networks?: ApprovedNetwork[];
  restrictMobile?: boolean;
}

/** Settings → Appearance: brand, logo and colours, applied for everyone (and on the sign-in screen). */
export interface Appearance {
  /** Accent colour used for highlights, toggles and badges (hex). */
  accent: string;
  /** Page background: warm off-white (default), plain white, cool grey, or a faint tint of the accent. */
  background: 'warm' | 'white' | 'cool' | 'tinted';
  /** Sidebar: soft grey (default), white, or a tint of the accent. */
  sidebar: 'soft' | 'white' | 'accent';
  /** Headings: elegant serif (default), clean sans-serif, or the salon's own uploaded font. */
  headingFont: 'serif' | 'sans' | 'custom';
  /** Body text: the built-in sans-serif (default) or the salon's own uploaded font. */
  bodyFont: 'default' | 'custom';
  /** Uploaded fonts, set by the server (name shown in Settings; version changes with every upload). Null = none. */
  headingFontName: string | null;
  headingFontVersion: string | null;
  bodyFontName: string | null;
  bodyFontVersion: string | null;
  /** Name shown in the sidebar, phone header and sign-in screen. */
  brandName: string;
  tagline: string;
  /** What the header shows when a logo is uploaded. */
  logoMode: 'name' | 'logo' | 'logo_name';
  /** Also use the logo as the browser tab / home-screen icon. */
  logoAsIcon: boolean;
  /** Set by the server when a logo is uploaded (changes with every upload); null = no logo. */
  logoVersion: string | null;
}

export const DEFAULT_APPEARANCE: Appearance = {
  accent: DEFAULT_ACCENT, background: 'warm', sidebar: 'soft', headingFont: 'serif', bodyFont: 'default',
  headingFontName: null, headingFontVersion: null, bodyFontName: null, bodyFontVersion: null,
  brandName: 'Addendum', tagline: 'Salon command center', logoMode: 'logo_name', logoAsIcon: false, logoVersion: null,
};

/** Logo files: PNG, JPEG or WebP up to this size (SVG isn't accepted: it can carry scripts). */
export const LOGO_MAX_BYTES = 400 * 1024;
/** Font files: WOFF2 (best), WOFF, TTF or OTF up to this size. */
export const FONT_MAX_BYTES = 1536 * 1024;
export type FontSlot = 'heading' | 'body';
export const fontUrl = (a: Appearance, slot: FontSlot) => {
  const v = slot === 'heading' ? a.headingFontVersion : a.bodyFontVersion;
  return v ? `/brand/font/${slot}?v=${encodeURIComponent(v)}` : null;
};
export const logoUrl = (a: Pick<Appearance, 'logoVersion'>) => (a.logoVersion ? `/brand/logo?v=${encodeURIComponent(a.logoVersion)}` : null);

export type HighLevelAutomationKey =
  | 'new_lead'
  | 'lead_no_response'
  | 'cancelled'
  | 'no_show'
  | 'overdue_rebook'
  | 'consultation_completed'
  | 'follow_up_overdue';

export const HIGHLEVEL_AUTOMATION_LABELS: Record<HighLevelAutomationKey, string> = {
  new_lead: 'New lead',
  lead_no_response: "Lead hasn't responded",
  cancelled: 'Square appointment cancelled',
  no_show: 'Square no-show',
  overdue_rebook: 'Client overdue for rebooking',
  consultation_completed: 'Consultation completed',
  follow_up_overdue: 'Follow-up overdue',
};

export interface DashboardSummary {
  appointmentsToday: number;
  newLeads: number;
  followUpsDue: number;
  overdueFollowUps: number;
  unreadMessages: number;
  readyToRebook: number;
  cancellations: number;
  noShows: number;
  pendingConfirmations: number;
}

export interface RecommendedAction {
  key: string;
  count: number;
  title: string;
  description: string;
  priority: Priority;
  actionLabel: string;
  link: string;
  icon: string;
}

export interface CurrentUser {
  id: string;
  name: string;
  email: string;
  role: Role;
  permissions: string[];
  /** With "Can view team calendars": null = everyone's calendar, a list = only these team members (plus their own). */
  calendarStaffIds?: string[] | null;
}

// ---------------- Inventory order requests ----------------
export type InventoryStatus = 'submitted' | 'ordered' | 'received' | 'cancelled';
export type InventoryEmailStatus = 'pending' | 'sent' | 'failed' | 'not_configured';

export const INVENTORY_STATUS_LABELS: Record<InventoryStatus, string> = {
  submitted: 'Requested', ordered: 'Ordered', received: 'Received', cancelled: 'Cancelled',
};

export interface InventoryItemDTO {
  id: string;
  size: string | null;
  color: string | null;
  collection: string;
  quantity: number;
  neededBy: string | null;
  /** Free-text details from before items had Size/Color fields. */
  legacyDetails: string | null;
  clientId: string | null;
  clientName: string | null;
  note: string | null;
}

// ---------------- Square inventory (search) + admin push to Shopify ----------------
export interface SquareInventoryDTO {
  variationId: string;
  itemName: string;
  variationName: string | null;
  sku: string | null;
  upc: string | null;
  priceCents: number | null;
  trackInventory: boolean;
  /** Total in stock across Square locations; null when Square isn't tracking it. */
  quantity: number | null;
  /** Last manual push to Shopify (admins only see this). */
  shopify: { pushedAt: string | null; pushedQuantity: number | null; error: string | null };
  /** Per-product "Sync to Shopify" and whether the product is paired with a Shopify product. */
  shopifySync: { enabled: boolean; linked: boolean; linkStatus: InventorySyncLinkStatus | null };
}

export interface SquareInventorySyncStatus {
  lastSyncAt: string | null;
  status: 'ok' | 'partial' | 'failed' | 'never';
  message: string | null;
  products: number;
}

export interface ShopifyPushResult {
  pushed: { variationId: string; label: string; quantity: number }[];
  skipped: { variationId: string; label: string; reason: string }[];
  failed: { variationId: string; label: string; error: string }[];
}

export interface InventoryRequestDTO {
  id: string;
  number: number;
  status: InventoryStatus;
  /** Earliest needed-by date across the items. */
  neededBy: string | null;
  note: string | null;
  forStaffId: string | null;
  forStaffName: string | null;
  requestedById: string | null;
  requestedByName: string | null;
  items: InventoryItemDTO[];
  totalUnits: number;
  email: {
    to: string;
    /** Who the email was copied to, as sent (empty until it has been sent). */
    cc: string[];
    status: InventoryEmailStatus;
    attempts: number;
    sentAt: string | null;
    error: string | null;
    subject: string | null;
    text: string | null;
  };
  statusChangedAt: string | null;
  createdAt: string;
}

// ---------------- Saved replies ----------------
/** The situation a text is answering. Each saved reply is tagged with the situations it fits. */
export type ReplySituation =
  | 'new_lead' | 'no_reply' | 'booking' | 'pricing' | 'consultation' | 'rebooking' | 'cancellation'
  | 'no_show' | 'reschedule' | 'reminder' | 'confirmed' | 'review' | 'thanks' | 'general';

export const REPLY_SITUATIONS: { value: ReplySituation; label: string }[] = [
  { value: 'new_lead', label: 'New lead' },
  { value: 'no_reply', label: "Hasn't replied" },
  { value: 'booking', label: 'Wants to book' },
  { value: 'pricing', label: 'Asking about price' },
  { value: 'consultation', label: 'Consultation' },
  { value: 'rebooking', label: 'Time to rebook' },
  { value: 'cancellation', label: 'Cancelled' },
  { value: 'no_show', label: 'No-show' },
  { value: 'reschedule', label: 'Wants to reschedule' },
  { value: 'reminder', label: 'Appointment reminder' },
  { value: 'confirmed', label: 'Confirmed appointment' },
  { value: 'review', label: 'Review request' },
  { value: 'thanks', label: 'Thank-you / compliment' },
  { value: 'general', label: 'General' },
];

export interface SavedReply {
  id: string;
  title: string;
  body: string;
  situations: ReplySituation[];
}

/** Placeholders a saved reply can use; filled in for the person being texted. */
export const REPLY_PLACEHOLDERS: { key: string; label: string; sample: string }[] = [
  { key: 'firstName', label: 'First name', sample: 'Sarah' },
  { key: 'stylist', label: 'Stylist', sample: 'Jennifer' },
  { key: 'service', label: 'Service', sample: 'Balayage' },
  { key: 'date', label: 'Appointment date', sample: 'Oct 14' },
  { key: 'time', label: 'Appointment time', sample: '2:00 PM' },
  { key: 'bookingUrl', label: 'Booking link', sample: 'addendumsalon.square.site' },
  { key: 'reviewUrl', label: 'Review link', sample: 'g.page/r/addendum' },
  { key: 'salon', label: 'Salon name', sample: 'Addendum Salon' },
  { key: 'signature', label: 'Signature', sample: '— Addendum Salon' },
];

export interface SuggestedReply extends SavedReply {
  /** The reply with placeholders filled in for this person. */
  text: string;
  /** Tagged with the situation detected for this conversation / follow-up. */
  matches: boolean;
}

// ---------------- Square ↔ Shopify inventory sync ----------------
export type InventorySyncLinkStatus = 'pending' | 'in_sync' | 'needs_attention' | 'error';

export interface InventorySyncLinkDTO {
  id: string;
  label: string;
  sku: string | null;
  matchMethod: 'sku' | 'manual';
  status: InventorySyncLinkStatus;
  issue: string | null;
  baselineQuantity: number | null;
  squareQuantity: number | null;
  shopifyQuantity: number | null;
  lastSyncedAt: string | null;
  lastChange: string | null;
  squareVariationId: string;
  shopifySyncEnabled: boolean;
}

export interface InventorySyncRunDTO {
  id: string;
  trigger: 'manual' | 'auto' | 'retry' | 'webhook' | 'resolve';
  status: 'running' | 'ok' | 'partial' | 'failed';
  startedAt: string;
  finishedAt: string | null;
  startedBy: string | null;
  stage: string | null;
  total: number;
  processed: number;
  updatedSquare: number;
  updatedShopify: number;
  unchanged: number;
  failed: number;
  attention: number;
  message: string | null;
  details: { label: string; sku: string | null; result: 'updated_square' | 'updated_shopify' | 'updated_both' | 'unchanged' | 'failed' | 'attention' | 'retry'; note: string }[];
}

export interface InventorySyncOverviewDTO {
  square: { connected: boolean; status: string; message: string | null; lastSuccessAt: string | null };
  shopify: { connected: boolean; status: string; message: string | null; lastSuccessAt: string | null };
  lastRun: InventorySyncRunDTO | null;
  lastSuccessfulSyncAt: string | null;
  running: boolean;
  counts: { linked: number; inSync: number; attention: number; errors: number; pending: number; syncOff: number };
  unmatched: { squareOnly: { label: string; sku: string | null }[]; shopifyOnly: { label: string; sku: string }[]; duplicates: { sku: string; where: string; count: number }[]; noSku: number };
  rule: string;
  settings: AppSettings['inventorySync'];
  demoMode: boolean;
}

// ---------- New clients & rebooking ----------

/**
 * future: has a confirmed (ACCEPTED) appointment after their first visit that hasn't happened yet.
 * returned: came back for a later appointment, nothing booked ahead. not_rebooked: no later appointment.
 */
export type RebookStatus = 'future' | 'returned' | 'not_rebooked';
export const REBOOK_STATUS_LABEL: Record<RebookStatus, string> = { future: 'Booked ahead', returned: 'Came back', not_rebooked: 'Not rebooked' };

export interface NewClientApptDTO {
  id: string;
  startAt: string;
  staffId: string | null;
  staffName: string | null;
  serviceNames: string[];
}

export interface NewClientRowDTO {
  clientId: string;
  clientName: string;
  /** The client's first-ever recorded appointment. */
  first: NewClientApptDTO & { state: 'upcoming' | 'completed' | 'no_show' };
  rebookStatus: RebookStatus;
  /** Confirmed appointments after the first one: already happened / still ahead. */
  laterVisits: number;
  futureAppointments: number;
  firstRebookAt: string | null;
  /** The next confirmed appointment after the first visit, if one is booked. */
  next: NewClientApptDTO | null;
}

export interface NewClientStatsDTO {
  from: string;
  to: string;
  staffId: string | null;
  summary: {
    newClients: number;
    rebooked: number;
    rebookedAppointments: number;
    withFuture: number;
    futureAppointments: number;
    /** Existing clients (first visit before these dates) who had an appointment in these dates. */
    returningClients: number;
    returningAppointments: number;
  };
  byStylist: { staffId: string | null; staffName: string; newClients: number; rebooked: number; withFuture: number }[];
  clients: NewClientRowDTO[];
  /** Earliest appointment in the CRM: clients can only be recognised as new from here on. */
  historyStart: string | null;
}
