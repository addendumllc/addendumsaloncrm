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
  receptionist: 'Front desk: calendar, clients, texting and follow-ups.',
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
  'Dashboard widgets',
  'Team announcements',
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
  'Team payroll',
  'Employee management',
  'User management and roles',
  'API keys, secrets and integrations',
  'CRM settings',
  'Data exports',
  'Audit logs',
  'Location and access',
  'Time clock',
] as const;

export const PERMISSIONS_CATALOG: PermissionDef[] = [
  { key: 'dashboard:view', category: 'Dashboard and analytics', action: 'view', label: 'Dashboard', description: 'Today’s work: follow-ups, appointments, messages. No revenue figures.' },
  // What the Dashboard shows. A widget also needs the permission for its data (e.g. Team commission needs
  // "View team commission"), so these can only narrow what someone sees, never widen it.
  { key: 'dashboard:schedule', category: 'Dashboard widgets', action: 'view', label: 'Schedule', description: 'Today’s appointments and the day’s booking counts.' },
  { key: 'dashboard:priorities', category: 'Dashboard widgets', action: 'view', label: 'Today’s Priorities', description: 'The “Today’s Priorities” heading and the follow-ups due, overdue follow-ups and ready to rebook counts (also needs “Follow-ups and tasks”).' },
  { key: 'dashboard:followups', category: 'Dashboard widgets', action: 'view', label: 'Follow-ups and tasks', description: 'Recommended actions and follow-up counts.' },
  { key: 'dashboard:clients', category: 'Dashboard widgets', action: 'view', label: 'Clients and activity', description: 'New client inquiries and unread messages.' },
  { key: 'dashboard:announcements', category: 'Dashboard widgets', action: 'view', label: 'Team announcements', description: 'The latest announcements for them.' },
  { key: 'dashboard:orders', category: 'Dashboard widgets', action: 'view', label: 'Order Hair', description: 'Open hair orders (their own, or everyone’s with “View all hair orders”).' },
  { key: 'dashboard:my_commission', category: 'Dashboard widgets', action: 'view', label: 'My earnings', description: 'Their own commission this week.' },
  { key: 'dashboard:team_commission', category: 'Dashboard widgets', action: 'view', label: 'Team payroll', description: 'Everyone’s commission this week.', sensitive: true },
  { key: 'dashboard:projections', category: 'Dashboard widgets', action: 'view', label: 'Projected service revenue', description: 'This week’s, this month’s and future projected service revenue.', sensitive: true },
  { key: 'dashboard:analytics', category: 'Dashboard widgets', action: 'view', label: 'Analytics', description: 'New clients and rebooking performance.', sensitive: true },

  { key: 'announcements:read', category: 'Team announcements', action: 'view', label: 'View announcements', description: 'Announcements published for everyone or their role.' },
  { key: 'announcements:publish', category: 'Team announcements', action: 'create', label: 'Create and publish announcements', description: 'Write, publish, edit and delete their own announcements.' },
  { key: 'announcements:manage', category: 'Team announcements', action: 'edit', label: 'Manage all announcements', description: 'Edit, pin, unpublish or delete anyone’s announcements.' },

  { key: 'revenue:projections', category: 'Dashboard and analytics', action: 'view', label: 'Projected service revenue', description: 'Expected revenue from booked salon services: weekly, monthly and future forecasts, averages and appointment details.', sensitive: true },
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
  { key: 'messages:delete', category: 'New Clients and messages', action: 'delete', label: 'Delete messages', description: 'Delete single messages or whole conversations from the CRM (not from anyone’s phone).', sensitive: true },

  { key: 'appointments:read', category: 'Appointments and calendar', action: 'view', label: 'Can view team calendars', description: 'Other team members’ appointments: everyone’s, or only the people chosen on their account. Viewing never allows changes.' },
  { key: 'appointments:read_own', category: 'Appointments and calendar', action: 'view', label: 'View their own calendar', description: 'Only appointments where they are the provider.' },
  { key: 'square:sync', category: 'Appointments and calendar', action: 'edit', label: 'Refresh from Square', description: 'Pull the latest bookings from Square now.' },

  { key: 'services:read', category: 'Services and pricing', action: 'view', label: 'View services and prices', description: 'The service menu with durations and prices.' },

  { key: 'tasks:read_own', category: 'Follow-ups and rebooking', action: 'view', label: 'View their own follow-ups', description: 'Follow-ups assigned to them or unassigned.' },
  { key: 'tasks:read_all', category: 'Follow-ups and rebooking', action: 'view', label: 'View everyone’s follow-ups', description: 'All follow-ups and tasks.' },
  { key: 'tasks:write', category: 'Follow-ups and rebooking', action: 'edit', label: 'Work follow-ups', description: 'Create, complete, snooze and close follow-ups they can see.' },
  { key: 'tasks:assign', category: 'Follow-ups and rebooking', action: 'edit', label: 'Assign follow-ups', description: 'Assign follow-ups to other team members.' },
  { key: 'tasks:delete', category: 'Follow-ups and rebooking', action: 'delete', label: 'Delete follow-ups and tasks', description: 'Delete follow-ups and tasks, and clear out finished ones.', sensitive: true },
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
  // Which businesses (workspaces) a person can switch to. What they see inside still follows their other permissions.
  { key: 'workspace:salon', category: 'Businesses', action: 'view', label: 'Addendum Salon workspace', description: 'Can switch to the Addendum Salon workspace (its look, menu and defaults).' },
  { key: 'workspace:hair', category: 'Businesses', action: 'view', label: 'Addendum Hair workspace', description: 'Can switch to the Addendum Hair workspace. Data in it (Hair clients, Shopify inventory…) still needs its own permission.' },
  { key: 'hair:manage', category: 'Addendum Hair', action: 'edit', label: 'Manage Addendum Hair clients and tasks', description: 'Addendum Hair’s own client list, tasks and follow-ups (separate from salon clients).' },
  { key: 'suppliers:details', category: 'Square and Shopify sync', action: 'view', label: 'See supplier company names and contacts', description: 'Each supplier’s real company name, email, phone, website and notes. Without it, people with inventory access see only the name a supplier is shown as (e.g. Addendum Hair).', sensitive: true },

  { key: 'transactions:read', category: 'Transactions', action: 'view', label: 'View sales transactions', description: 'Square sales, refunds and tips synced into the CRM.', sensitive: true },

  { key: 'commission:own', category: 'Personal commission', action: 'view', label: 'View their own commission', description: 'Earnings & Goals: their own earnings by date.' },

  { key: 'commission:team', category: 'Team payroll', action: 'view', label: 'View team commission', description: 'Everyone’s commission and earnings.', sensitive: true },
  { key: 'commission:manage', category: 'Team payroll', action: 'edit', label: 'Edit commission plans', description: 'Commission rates, rules and effective dates.', sensitive: true },
  { key: 'commission:approve', category: 'Team payroll', action: 'approve', label: 'Finalize and adjust commission', description: 'Finalize pay periods, add adjustments and resolve reviews.', sensitive: true },
  { key: 'commission:export', category: 'Team payroll', action: 'export', label: 'Export commission reports', description: 'Download commission reports for payroll.', sensitive: true },

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
  // Location & Access exceptions for one person or role (only matter while "Allow Access Anywhere" is off).
  { key: 'timeclock:use', category: 'Time clock', action: 'edit', label: 'Use the time clock', description: 'Clock in and out, and take lunch and breaks, on the Time Clock page. Hours go to Payroll and Square.' },
  { key: 'timeclock:anywhere', category: 'Time clock', action: 'edit', label: 'Clock in from anywhere', description: 'Clock in and out away from the salon’s approved network (otherwise the time clock only works at the salon).' },
  { key: 'location:anywhere', category: 'Location and access', action: 'view', label: 'Use the app from anywhere', description: 'The whole app works away from the approved networks (salon, office).', sensitive: true },
  // One per section that can be opened away from the approved networks; nothing else works there.
  { key: 'location:dashboard_away', category: 'Location and access', action: 'view', label: 'Away from the salon: Dashboard', description: 'The Dashboard (with its tasks and announcements) works away from the approved networks.' },
  { key: 'location:calendar_away', category: 'Location and access', action: 'view', label: 'Away from the salon: Appointments', description: 'Appointments (or their own calendar) works away from the approved networks.' },
  { key: 'location:tasks_away', category: 'Location and access', action: 'view', label: 'Away from the salon: Internal Tasks', description: 'Internal tasks and announcements work away from the approved networks. Client follow-ups stay at the salon.' },
  { key: 'location:clients_away', category: 'Location and access', action: 'view', label: 'Away from the salon: Clients', description: 'Clients and new-client inquiries work away from the approved networks.', sensitive: true },
  { key: 'location:messages_away', category: 'Location and access', action: 'view', label: 'Away from the salon: Messages', description: 'Messages work away from the approved networks.', sensitive: true },
  { key: 'location:orders_away', category: 'Location and access', action: 'view', label: 'Away from the salon: Order Hair', description: 'Order Hair works away from the approved networks.' },
  { key: 'location:commission_away', category: 'Location and access', action: 'view', label: 'Away from the salon: Earnings & Goals', description: 'Their own commission works away from the approved networks.' },
];

/** Sections that can be opened away from the approved networks, each with its own "Away from the salon" permission. */
export type AwaySection = 'dashboard' | 'calendar' | 'tasks' | 'clients' | 'messages' | 'orders' | 'commission';
export const AWAY_SECTIONS: { key: AwaySection; permission: string; label: string; paths: string[]; needsAnyOf: string[] }[] = [
  { key: 'dashboard', permission: 'location:dashboard_away', label: 'Dashboard', paths: ['/'], needsAnyOf: ['dashboard:view'] },
  { key: 'calendar', permission: 'location:calendar_away', label: 'Appointments', paths: ['/appointments', '/my-calendar'], needsAnyOf: ['appointments:read', 'appointments:read_own'] },
  { key: 'tasks', permission: 'location:tasks_away', label: 'Internal Tasks', paths: ['/tasks', '/announcements'], needsAnyOf: ['tasks:read_all', 'tasks:read_own', 'announcements:read', 'hair:manage'] },
  { key: 'clients', permission: 'location:clients_away', label: 'Clients', paths: ['/clients', '/leads'], needsAnyOf: ['clients:read', 'clients:read_assigned', 'leads:read'] },
  { key: 'messages', permission: 'location:messages_away', label: 'Messages', paths: ['/messages'], needsAnyOf: ['messages:read'] },
  { key: 'orders', permission: 'location:orders_away', label: 'Order Hair', paths: ['/inventory'], needsAnyOf: ['inventory:order', 'inventory:read_all', 'inventory:view', 'inventory:manage'] },
  { key: 'commission', permission: 'location:commission_away', label: 'Earnings & Goals', paths: ['/my-commission'], needsAnyOf: ['commission:own'] },
];

/** The app path (e.g. "/clients/123") is part of one of these away sections. */
export const pathInAwaySections = (path: string, sections: AwaySection[]) =>
  AWAY_SECTIONS.some((s) => sections.includes(s.key) && s.paths.some((p) => (p === '/' ? path === '/' : path === p || path.startsWith(`${p}/`))));

export const PERMISSION_KEYS = PERMISSIONS_CATALOG.map((p) => p.key);
export const SENSITIVE_PERMISSIONS = PERMISSIONS_CATALOG.filter((p) => p.sensitive).map((p) => p.key);

/**
 * Role template defaults (starting points; administrators can edit the templates and each person).
 * Reception and Stylist match what those roles could do before per-person permissions existed, plus "own commission".
 */
export const ROLE_DEFAULT_PERMISSIONS: Record<BuiltinRole, string[]> = {
  // Away-from-the-salon exceptions are granted per person or role, never by default.
  admin: PERMISSION_KEYS.filter((k) => !k.startsWith('location:') && !k.startsWith('timeclock:')),
  receptionist: [
    'workspace:salon', 'dashboard:view', 'clients:read', 'clients:write', 'clients:contact', 'clients:history', 'clients:notes',
    'leads:read', 'leads:write', 'appointments:read', 'messages:read', 'messages:send', 'services:read',
    'tasks:read_own', 'tasks:read_all', 'tasks:write', 'tasks:assign', 'rebooking:client',
    'staff:read', 'highlevel:push', 'square:sync',
    'inventory:view', 'inventory:order', 'inventory:read_all', 'inventory:order_for_others', 'commission:own',
    'announcements:read', 'announcements:publish',
    'dashboard:schedule', 'dashboard:priorities', 'dashboard:followups', 'dashboard:clients', 'dashboard:announcements', 'dashboard:orders', 'dashboard:my_commission',
  ],
  // Their own appointments, their own clients (contact, history, notes), their own follow-ups, hair orders, commission.
  stylist: [
    'workspace:salon', 'appointments:read_own', 'clients:read_assigned', 'clients:contact', 'clients:history', 'clients:notes', 'services:read',
    'tasks:read_own', 'tasks:write', 'inventory:view', 'inventory:order', 'commission:own', 'announcements:read',
    // Used if an administrator gives stylists the Dashboard.
    'dashboard:schedule', 'dashboard:priorities', 'dashboard:followups', 'dashboard:announcements', 'dashboard:orders', 'dashboard:my_commission',
  ],
  // Their own calendar (team calendars when an Owner/Admin allows it), assigned follow-ups, needed client details.
  assistant: [
    'workspace:salon', 'dashboard:view', 'appointments:read_own', 'clients:read', 'clients:contact', 'clients:history', 'services:read',
    'tasks:read_own', 'tasks:write', 'rebooking:client', 'inventory:view', 'staff:read', 'commission:own', 'announcements:read',
    'dashboard:schedule', 'dashboard:priorities', 'dashboard:followups', 'dashboard:announcements', 'dashboard:my_commission',
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

/** A Square team member, for linking a CRM account to it (Settings → Users & Permissions). */
export interface SquareTeamMemberOptionDTO {
  id: string;
  name: string;
  email: string | null;
  /** Their phone in Square (E.164), if any. */
  phone: string | null;
  active: boolean;
  /** The CRM record linked to it now. One that can't sign in is a placeholder from the Square sync; the link moves. */
  linkedTo: { id: string; name: string; signsIn: boolean } | null;
}

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
  /** Their own mobile (E.164), for texting them internal tasks. */
  mobilePhone: string | null;
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
  new_lead: 'New Client',
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
  /** Their own mobile (E.164), for texting them internal tasks. */
  mobilePhone: string | null;
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

/** lapsed: their last visit was longer ago than "Stop after" (Settings → Follow-up rules), so no follow-ups. */
/** not_needed: the service is marked "No follow-up needed" (an add-on), unless a client's own setting turns it on. */
export type RebookingStatus = 'booked' | 'upcoming' | 'due_soon' | 'overdue' | 'off' | 'not_needed' | 'lapsed' | 'no_interval' | 'no_visit';
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

export type TaskBusiness = 'salon' | 'hair';
export const TASK_BUSINESS_LABELS: Record<TaskBusiness, string> = { salon: 'Addendum Salon', hair: 'Addendum Hair' };

export interface TaskDTO {
  id: string;
  kind: TaskKind;
  /** Internal tasks: for Addendum Salon or Addendum Hair. Client follow-ups are always 'salon'. */
  business: TaskBusiness;
  type: TaskType;
  title: string;
  reason: string | null;
  notes: string | null;
  priority: Priority;
  status: TaskStatus;
  /** null: no due date (internal tasks can have just a priority). */
  dueAt: string | null;
  snoozedUntil: string | null;
  /** Last time the team reached out and is waiting for a reply ("Reached out"), and how many times. */
  reachedOutAt: string | null;
  reachOutCount: number;
  completedAt: string | null;
  clientId: string | null;
  leadId: string | null;
  contactName: string | null;
  contactPhone: string | null;
  appointmentId: string | null;
  assignedStaffId: string | null;
  assignedStaffName: string | null;
  /** Who added it (null for automatic follow-ups). */
  createdById: string | null;
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
  /** No rebooking follow-ups once the last visit is longer ago than this (days; 0 = never stop). */
  rebookingStopAfterDays: number;
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
  /**
   * When Square doesn't record who checked out (a shared or signed-out POS), who gets product credit instead, in this
   * order: the client's preferred stylist (client on the ticket), whoever was on the clock then (the front desk first),
   * then a backup person. On hold until accepted when `hold` is on.
   */
  unrecordedCheckout: { clientStylist: boolean; onTheClock: boolean; fallbackStaffId: string | null; hold: boolean };
  /** Each stylist's rates when no commission rule covers a sale (their own rules still come first): 40% services, 10% products. */
  defaultServiceBps: number;
  defaultRetailBps: number;
  /** Tips are shown separately from commission, or left out of these reports. */
  tips: 'separate' | 'exclude';
  tipAttribution: 'service_share' | 'payment_team_member';
  /** Shown to everyone at the top of My Commission (e.g. "these are estimates"). Empty hides it. */
  disclaimer: string;
  /** Salon-wide rates for payroll tax ESTIMATES, in basis points. Social Security and Medicare apply to employee and employer alike. */
  payrollTaxes: {
    socialSecurityBps: number; medicareBps: number; futaBps: number; sutaBps: number;
    /** California State Disability Insurance (SDI), withheld from W-2 employees working in California. */
    sdiBps: number;
    /** CA state income tax for people without their own state rate (an estimate; theirs wins when set). */
    stateIncomeBps: number;
    /** Where the work is done (decides state/local taxes). */ workAddress: string;
  };
  /** When pay periods run and when they're paid (My Commission and Team Commission default to the current one). */
  paySchedule: PaySchedule;
}

/**
 * Pay periods. Weekly and every-2-weeks periods repeat from `anchorStart` (the first day of any one period);
 * twice-monthly is the 1st–15th and 16th–end; monthly is the calendar month. Payday is `payDayOffsetDays` after a period ends.
 */
export interface PaySchedule {
  frequency: 'weekly' | 'biweekly' | 'semimonthly' | 'monthly';
  anchorStart: string;
  payDayOffsetDays: number;
}

const dayMs = 86400_000;
const keyToUtc = (k: string) => Date.UTC(+k.slice(0, 4), +k.slice(5, 7) - 1, +k.slice(8, 10));
const utcToKey = (t: number) => new Date(t).toISOString().slice(0, 10);
const plusDays = (k: string, n: number) => utcToKey(keyToUtc(k) + n * dayMs);

/** The pay period containing `date` (YYYY-MM-DD), `offset` periods later (-1 = the one before), and its payday. */
export function payPeriodFor(date: string, s: PaySchedule, offset = 0): { from: string; to: string; payDate: string } {
  let from: string;
  let to: string;
  if (s.frequency === 'weekly' || s.frequency === 'biweekly') {
    const len = s.frequency === 'weekly' ? 7 : 14;
    const i = Math.floor((keyToUtc(date) - keyToUtc(s.anchorStart)) / dayMs / len) + offset;
    from = plusDays(s.anchorStart, i * len);
    to = plusDays(from, len - 1);
  } else if (s.frequency === 'semimonthly') {
    // Halves of the month: 0 = 1st–15th, 1 = 16th–end.
    let y = +date.slice(0, 4);
    let m = +date.slice(5, 7) - 1;
    let half = +date.slice(8, 10) <= 15 ? 0 : 1;
    let n = m * 2 + half + offset;
    y += Math.floor(n / 24);
    n = ((n % 24) + 24) % 24;
    m = Math.floor(n / 2);
    half = n % 2;
    const first = utcToKey(Date.UTC(y, m, 1));
    from = half ? plusDays(first, 15) : first;
    to = half ? utcToKey(Date.UTC(y, m + 1, 0)) : plusDays(first, 14);
  } else {
    const d = new Date(Date.UTC(+date.slice(0, 4), +date.slice(5, 7) - 1 + offset, 1));
    from = utcToKey(d.getTime());
    to = utcToKey(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
  }
  return { from, to, payDate: plusDays(to, s.payDayOffsetDays) };
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
  /** Used for finalized commission: can't be changed in place, only replaced from a date. */
  locked: boolean;
}

/** Someone who likely made a sale Square didn't credit, and why (shown as one-click choices in Needs review). */
export interface CommissionSuggestion { staffId: string; name: string; why: string }

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
  calc: { steps: string[]; rule?: string | null; basis?: string | null; suggestions?: CommissionSuggestion[] };
  attribution: string | null;
  needsReview: boolean;
  reviewReason: string | null;
  /** Credited but not counted in pay until confirmed in Needs review (several stylists split evenly; a product-only sale). */
  onHold: boolean;
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
  /** The part of refundsCents on services / on retail items (the rest is on lines with no category). */
  serviceRefundsCents: number;
  retailRefundsCents: number;
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

/** How someone is paid besides commission (Users & Permissions → Wages & tips). */
export type PayType = 'none' | 'hourly' | 'salary';
export type SalaryPeriod = 'week' | 'biweekly' | 'semimonthly' | 'month' | 'year';
export interface StaffPayDTO {
  staffId: string;
  payType: PayType;
  hourlyRateCents: number | null;
  /** Salary per salaryPeriod. */
  salaryCents: number | null;
  salaryPeriod: SalaryPeriod;
  /** Not eligible: tips on their work go to Needs review instead of to them. */
  tipEligible: boolean;
  taxes: StaffTaxDTO;
  /** Wage history, newest first: each applies from its start date until the next one starts. */
  rates: PayRateDTO[];
}

export interface PayRateDTO {
  id: string;
  /** null = from the beginning (all earlier dates). */
  effectiveFrom: string | null;
  /** The day before the next rate starts; null = still in effect. */
  effectiveTo: string | null;
  payType: PayType;
  hourlyRateCents: number | null;
  salaryCents: number | null;
  salaryPeriod: SalaryPeriod;
  createdByName: string | null;
}

/** Tax details for payroll ESTIMATES (the payroll provider does the real withholding). No SSNs or bank details. */
export interface StaffTaxDTO {
  workerType: 'w2' | '1099';
  /** Withholding percentages in basis points (e.g. 1200 = 12%). */
  federalBps: number | null;
  stateBps: number | null;
  localBps: number | null;
  w4: {
    filingStatus: 'single' | 'married_jointly' | 'head_of_household' | null;
    multipleJobs: boolean;
    dependentsCents: number | null;
    otherIncomeCents: number | null;
    deductionsCents: number | null;
    /** Step 4(c): extra withholding per paycheck. */
    extraWithholdingCents: number | null;
  };
  /** Whether they see the tax-by-tax breakdown on My Commission → Year (set per person). */
  showBreakdown: boolean;
  /** California DE 4. Exempt = no California withholding. */
  de4: {
    exempt: boolean;
    filingStatus: 'single_or_married_two_incomes' | 'married_one_income' | 'head_of_household' | null;
    regularAllowances: number;
    additionalAllowances: number;
    /** Additional withholding per paycheck. */
    additionalWithholdingCents: number;
  };
}

/** Dashboard layout, saved per person: widget order and each widget's width (S ⅓, M ½, L ⅔, Full). */
export type DashboardWidgetSize = 's' | 'm' | 'l' | 'full';
export interface DashboardLayout {
  order: string[];
  sizes: Record<string, DashboardWidgetSize>;
  /** Widgets this person has hidden (Customize → Hide); shown again from the list of hidden widgets. */
  hidden?: string[];
}

/** Time clock (for people with "Use the time clock"). */
export interface ClockBreakDTO { id: string; kind: 'lunch' | 'rest'; paid: boolean; plannedMinutes: number; startedAt: string; endedAt: string | null }
export interface ClockShiftDTO {
  id: string; staffId: string; staffName?: string; clockInAt: string; clockOutAt: string | null;
  /** Worked minutes so far (unpaid lunch taken off). */
  paidMinutes: number;
  breaks: ClockBreakDTO[];
  squareSent: boolean; squareError: string | null;
  /** Its timecards were deleted in Square since (found missing on a sync). */
  squareRemoved: boolean;
  /** Clocked in on Square right now (a live timecard is open there). */
  squareLive: boolean;
  /** Square already had timecards for that day, so its hours are used (this shift isn't added on top). */
  usesSquareHours: boolean;
}
/** A scheduled working day. `start`/`end` are null when the hours vary (e.g. booked by appointment): they work that day, no set times. */
export interface ScheduleDayDTO { weekday: number; start: string | null; end: string | null; lunchMinutes: number; breakMinutes: number }
export interface TimeClockStatusDTO {
  shift: ClockShiftDTO | null;
  today: ScheduleDayDTO | null;
  schedule: ScheduleDayDTO[];
  recent: ClockShiftDTO[];
  /** Must be on the salon's approved network to clock in or out (and whether this connection is). */
  needsSalonNetwork: boolean;
  onSalonNetwork: boolean;
}

/** Year tab: one row per pay period paid in the year (estimates). */
export interface PayPeriodRowDTO {
  from: string;
  to: string;
  payDate: string;
  minutes: number;
  commissionCents: number;
  tipsCents: number;
  wagesCents: number;
  grossCents: number;
  withheldCents: number;
  netCents: number;
  /** The estimated withholding, by tax (adds up to withheldCents). */
  federalCents: number;
  socialSecurityCents: number;
  medicareCents: number;
  stateCents: number;
  sdiCents: number;
  localCents: number;
}

/** Estimated taxes on someone's pay for a date range. */
export interface TaxEstimateDTO {
  workerType: 'w2' | '1099';
  /** Commission + tips + wages. */
  grossCents: number;
  federalCents: number;
  stateCents: number;
  localCents: number;
  /** Employee share of Social Security + Medicare. */
  ficaCents: number;
  socialSecurityCents: number;
  medicareCents: number;
  /** California SDI (disability insurance). */
  sdiCents: number;
  withheldCents: number;
  netCents: number;
  /** Employer Social Security, Medicare, FUTA and state unemployment. */
  employerCents: number;
}

/** A block of hours worked: a closed Square timecard, or entered by hand. */
export interface StaffHoursDTO {
  id: string;
  staffId: string;
  date: string;
  minutes: number;
  /** timesheet = set on Payroll hours: that day's hours for pay, in place of Square and other hand entries. */
  source: 'square' | 'manual' | 'timesheet';
  note: string | null;
  createdByName: string | null;
}

/** Payroll → timesheet: one row per person, hours per day (Square timecards and entered by hand apart). */
export interface TimesheetRowDTO {
  staffId: string;
  name: string;
  payType: PayType;
  hourlyRateCents: number | null;
  /** date → minutes */
  square: Record<string, number>;
  manual: Record<string, number>;
  /** Days set on the timesheet: these replace Square and hand entries for the day. */
  timesheet: Record<string, number>;
  /** 'week': their hours are entered as one weekly total. */
  mode: 'day' | 'week';
  /** The weekly total entered for this range (minutes), if any. */
  weekTotal: number | null;
  pay: PaySummaryDTO;
}

/** Wages for a date range: hourly = hours × rate; salary = prorated by days in the range. */
export interface PaySummaryDTO {
  payType: PayType;
  minutes: number;
  squareMinutes: number;
  manualMinutes: number;
  wagesCents: number;
  /** How wagesCents was worked out, in plain words. */
  basis: string;
}

export interface CommissionTeamRowDTO extends CommissionSummaryDTO {
  staffName: string;
  squareLinked: boolean;
  pay: PaySummaryDTO;
  tipEligible: boolean;
  /** Estimated taxes on gross pay (commission + tips + wages). */
  taxes: TaxEstimateDTO;
}

export interface CommissionStatusDTO {
  enabled: boolean;
  squareConnected: boolean;
  lastSuccessfulSyncAt: string | null;
  lastRun: { id: string; status: string; startedAt: string; finishedAt: string | null; message: string | null; ordersSeen: number; created: number; updated: number; needsReview: number } | null;
  needsReview: number;
  unlinkedTeamMembers: string[];
  missing: string[];
  /** The salon's note shown on My Commission (Settings → Commission). */
  disclaimer: string;
  /** Why the last Square timecards (hours) read failed, if it did — e.g. TIMECARDS_READ not approved. */
  hoursSyncError: string | null;
  paySchedule: PaySchedule;
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

/** Which settings sections everyone on the team can see (Settings → each section → Share with the team). */
export interface SharedSettings { rules: boolean; rebooking: boolean; reminders: boolean; replies: boolean }
export const SHARED_SECTIONS: { key: keyof SharedSettings; label: string }[] = [
  { key: 'rules', label: 'Follow-Up Rules' }, { key: 'rebooking', label: 'Rebooking by Service' },
  { key: 'reminders', label: 'Reminders & Reviews' }, { key: 'replies', label: 'Saved Replies' },
];

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
    /** Order emails come from this form sender — not a staff or info@ mailbox. */
    orderFromName: string;
    /** The sending address for order emails (must be allowed by the email service); empty = the general sender. */
    orderFromAddress: string;
    /** Send each order as the person who placed it (their name and, where allowed, their email address). */
    sendAsSubmitter: boolean;
    /** Email domains the email service may send from (e.g. addendumsalon.com). The sending address's domain counts too. */
    senderDomains: string[];
    /** What Order Hair offers (Settings → Order Hair): only chosen products if set, in this order; collections in this order. */
    orderHair?: OrderHairLayout;
  };
  appearance: Appearance;
  /** Where the CRM can be used from (Settings → Location & Access). Changed only through PUT /api/access. */
  access: AccessSettings;
  /** Sign-in screen: let people ask for an account. Requests always wait for an Admin's approval. */
  accounts: { allowAccessRequests: boolean };
  /** Businesses (workspaces): names, taglines and which sidebar tabs belong to which (Settings → Businesses). */
  workspaces?: WorkspaceSettings;
  /** The sign-in screen (Settings → Businesses). */
  login?: LoginSettings;
  onboardingComplete: boolean;
  /**
   * Settings sections shown to the whole team (view only) — by default only people who can view settings see them.
   * Editing still needs its own permission (e.g. "Edit follow-up rules").
   */
  sharedSettings?: SharedSettings;
}

/** The default accent for anyone who hasn't chosen their own (administrators can change it). */
export const DEFAULT_ACCENT = '#6B5242';

/** Order Hair's product list: everything, or only the chosen SKUs (in their order); collections shown in this order. */
export interface OrderHairLayout { onlyListed: boolean; listed: string[]; collections: string[] }
export const DEFAULT_ORDER_HAIR: OrderHairLayout = { onlyListed: false, listed: [], collections: [] };
/**
 * A Shopify hair listing's parts, for choosing by collection → length → colour:
 * "Black Magic - Clip-Ins - 18 inch - 120g" → collection Clip-Ins, length 18 inch, colour Black Magic, detail 120g;
 * "Hand-Tied Weft – 20\" / #60 Platinum" → collection Hand-Tied Weft, length 20", colour #60 Platinum. Single items
 * (tools, beads) are "Tools & accessories".
 */
export function hairParts(label: string): { collection: string; length: string; color: string; detail: string } {
  const parts = label.split(/\s+[-–]\s+/).map((x) => x.trim()).filter((x) => x && x.toLowerCase() !== 'default title');
  if (parts.length >= 3) return { color: parts[0], collection: parts[1], length: parts[2], detail: parts.slice(3).join(' · ') };
  if (parts.length === 2) {
    const v = parts[1].split(/\s+\/\s+/);
    const len = v.find((x) => /^\d+(\.\d+)?\s*("|”|in\b|inch)/i.test(x)) ?? '';
    return { collection: parts[0], length: len, color: v.filter((x) => x !== len).join(' / ') || parts[1], detail: '' };
  }
  return { collection: 'Tools & accessories', length: '', color: parts[0] ?? label, detail: '' };
}
/** Order Hair's list after the admin's choices: only listed (if set), listed ones in their order, the rest by name. */
export function arrangeOrderHair<T extends { sku: string; label: string }>(items: T[], layout: Partial<OrderHairLayout> | undefined): T[] {
  const l = { ...DEFAULT_ORDER_HAIR, ...(layout ?? {}) };
  const pos = new Map(l.listed.map((s, i) => [s.toLowerCase(), i]));
  const shown = l.onlyListed ? items.filter((x) => pos.has(x.sku.toLowerCase())) : items;
  return [...shown].sort((a, b) => (pos.get(a.sku.toLowerCase()) ?? 1e9) - (pos.get(b.sku.toLowerCase()) ?? 1e9) || a.label.localeCompare(b.label));
}

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
  /** Away from the approved networks with some "Away from the salon" sections: only those work. */
  limited: AwaySection[] | null;
  /** This person may use the app anywhere ("Use the app from anywhere"). */
  personalAnywhere: boolean;
  canManage: boolean;
  networks?: ApprovedNetwork[];
  restrictMobile?: boolean;
}

/** Settings → Appearance: brand, logo and colours, applied for everyone (and on the sign-in screen). */
export interface Appearance {
  /** Accent colour used for highlights, toggles and badges (hex). */
  accent: string;
  /** Page background: warm off-white (default), plain white, cool grey, a faint tint of the accent, or any colour. */
  background: 'warm' | 'white' | 'cool' | 'tinted' | 'custom';
  backgroundColor: string | null;
  /** Sidebar: soft grey (default), white, a tint of the accent, or any colour (its text turns light on dark colours). */
  sidebar: 'soft' | 'white' | 'accent' | 'custom';
  sidebarColor: string | null;
  /** Main text and heading colours (hex); null = the defaults. Light mode only. */
  textColor: string | null;
  headingColor: string | null;
  /** Light, dark, or follow the device. Each person can choose their own (My look). */
  mode: ColorMode;
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
  /**
   * The font for each kind of text: a FONT_CHOICES id, 'custom' (the salon's uploaded font for that slot), or 'same'
   * (links, buttons and menus: follow the body text). Unset slots use headingFont / bodyFont above.
   */
  fonts?: Partial<Record<FontSlot, string>>;
  /** Uploaded fonts for every slot (set by the server; the version changes with every upload). */
  fontFiles?: Partial<Record<FontSlot, { name: string; version: string } | null>>;
  /** Corners on buttons, cards and fields: rounded (default), soft, or square (a sharper, modern look). */
  corners?: 'rounded' | 'soft' | 'square';
  /**
   * Colours by area: the online (Shopify) parts of the CRM in one theme, everything else (the salon) in another — e.g.
   * Addendum Hair and Addendum Salon. A person's own theme or accent still wins.
   */
  areaColors?: { enabled: boolean; salonTheme: string; onlineTheme: string };
  /**
   * The looks, fully custom: `main` is the default (everyone, when looks by area are off); `salon` and `online` (Shopify)
   * are used while areaColors is on.
   */
  areaLooks?: { main?: AreaLook; salon: AreaLook; online: AreaLook };
  /** Each business's official colours (no longer used: one design for everyone; kept so saved settings still load). */
  brandThemes?: Partial<Record<BusinessId, ColorChoice>>;
  /** Older: team members may choose their own accent colour. */
  personalAccent?: boolean;
  /** Themes: the approved looks, the default, and what each person may change (Settings → Theme Management). */
  themeSettings?: ThemeSettings;
  /** Font styles (administrators): a font for each kind of text; each person picks one. */
  fontStyles?: FontStyleSettings;
}

/** One area's look: colours, fonts, heading style, corners, badges and text size. */
export interface AreaLook {
  accent: string;
  background: string;
  sidebar: string;
  text: string;
  heading: string;
  /** Font per kind of text (FONT_CHOICES ids, or 'same' for links, buttons and menu). */
  fonts: Partial<Record<FontSlot, string>>;
  /** Headings as written, or in capitals (like addendumhair.com). */
  headingCase: 'normal' | 'uppercase';
  corners: 'rounded' | 'soft' | 'square';
  /** Highlight badges (e.g. "New", "Best seller"): their colours, and capitals or not. */
  badge: { background: string; text: string; uppercase: boolean };
  /** Text size for the area (paragraphs and everything else), as a percentage. */
  textScale: number;
  /** Sizes for headings, buttons and the menu, as percentages (100 = standard). */
  sizes?: { heading: number; button: number; nav: number };
  /** Light or dark (a dark look uses the readable dark palette, tinted by its own background). Default light. */
  mode?: 'light' | 'dark';
  /** Cards and panels, and borders / dividers (light looks). Default: white cards, borders from the background. */
  surface?: string;
  line?: string;
  /** Type details: heading weight (300–700), heading letter spacing (thousandths of an em), text line height (×100). */
  type?: { headingWeight: number; headingTracking: number; lineHeight: number };
}
// ---------------- Businesses (workspaces) ----------------
/** The businesses under the Addendum umbrella. A third one is added here (plus its look and permission). */
export type BusinessId = 'salon' | 'hair';
export interface BusinessDef { id: BusinessId; name: string; tagline: string; /** Which look it uses (Settings → Look). */ area: 'salon' | 'online'; permission: string }
export const BUSINESSES: BusinessDef[] = [
  { id: 'salon', name: 'Addendum Salon', tagline: 'Moody · Warm · Elevated', area: 'salon', permission: 'workspace:salon' },
  { id: 'hair', name: 'Addendum Hair', tagline: 'Modern · Minimal · Editorial', area: 'online', permission: 'workspace:hair' },
];
/** The businesses a person can switch to (always at least the salon, so nobody is locked out of the app). */
export function workspacesFor(permissions: string[]): BusinessDef[] {
  const list = BUSINESSES.filter((b) => permissions.includes('*') || permissions.includes(b.permission));
  return list.length ? list : [BUSINESSES[0]];
}
/** Organization settings (Settings → Businesses): each business's name and tagline, and which sidebar tabs belong to which. */
export interface WorkspaceSettings {
  businesses: Record<BusinessId, { name: string; tagline: string }>;
  /** A sidebar tab (its path) → the business it belongs to; tabs not listed are shared by both. (Older; menus below win.) */
  nav: Record<string, BusinessId | 'shared'>;
  /** Older per-business menu lists (no longer used; groups + menuDefaults below replace them). */
  menus?: Partial<Record<BusinessId, string[]>>;
  /** Which business each sidebar tab belongs to (shown in Customize menu; 'shared' = both). */
  groups?: Record<string, MenuGroup>;
  /** Which sidebar section each tab is in (Daily work, Operations…). */
  sections?: Record<string, MenuSection>;
  /** Each role's default sidebar (order, hidden, required) for people who haven't customized theirs. */
  menuDefaults?: Partial<Record<BuiltinRole, SidebarDefaults>>;
}
export type MenuGroup = 'shared' | BusinessId;
/** A sidebar layout: tab order and hidden tabs (personal), plus tabs nobody can hide (role defaults only). */
export interface SidebarDefaults {
  order: string[]; hidden: string[]; required: string[];
  /** Tabs moved to another section. */ sections?: Record<string, MenuSection>;
  /** The sections in order, with their headings (renamed, or their own new ones). */ sectionList?: { key: string; label: string }[];
  /** Tabs renamed. */ labels?: Record<string, string>;
}
/** Which business each tab belongs to. "/appointments" and "/my-calendar" are one tab (all calendars, or their own). */
export const DEFAULT_MENU_GROUPS: Record<string, MenuGroup> = {
  '/': 'shared', '/tasks': 'shared', '/follow-ups': 'shared', '/inventory-sync': 'shared', '/commission': 'shared', '/analytics': 'shared',
  '/announcements': 'shared', '/settings': 'shared',
  // Clients: one tab for both businesses (Addendum Salon / Addendum Hair at the top of the page, like Tasks).
  '/clients': 'shared',
  '/time-clock': 'salon', '/messages': 'salon', '/inventory': 'salon', '/appointments': 'salon', '/my-calendar': 'salon', '/my-commission': 'salon',
};
/**
 * The sidebar, top to bottom: daily work first, then operations, Addendum Hair's own tools, business management, and
 * administration last. No business switcher: both businesses' tools are listed for people allowed to use them.
 */
/** A sidebar section: the built-in ones below, or one a person (or the owner) added ("s-…"). */
export type MenuSection = string;
export const MENU_SECTIONS: { key: string; label: string }[] = [
  { key: 'daily', label: 'Daily work' }, { key: 'operations', label: 'Operations' },
  { key: 'business', label: 'Business' }, { key: 'admin', label: 'Administration' },
];
export const DEFAULT_MENU_SECTIONS: Record<string, MenuSection> = {
  '/': 'daily', '/tasks': 'daily', '/follow-ups': 'daily', '/messages': 'daily', '/clients': 'daily', '/appointments': 'daily', '/my-calendar': 'daily', '/announcements': 'daily',
  '/inventory-sync': 'operations', '/inventory': 'operations', '/time-clock': 'operations',
  '/analytics': 'business', '/commission': 'business', '/my-commission': 'business',
  '/settings': 'admin',
};
/** The built-in order (within each section). */
export const DEFAULT_MENU_ORDER = [
  '/', '/tasks', '/follow-ups', '/messages', '/clients', '/appointments', '/my-calendar', '/announcements',
  '/inventory-sync', '/inventory', '/time-clock',
  '/analytics', '/commission', '/my-commission',
  '/settings',
];
/** Tabs nobody can hide (none: Settings can be hidden too — their name at the bottom still opens their settings). */
export const ALWAYS_SHOWN: string[] = [];

// ---------------- Themes (Settings → Theme Management; each person's Appearance) ----------------
/**
 * One layout and component system for everyone. A theme sets the approved colours, fonts and sizes, and button size
 * and corners. Administrators create and publish themes; each person picks one (or the default) and, if allowed,
 * adjusts colours, fonts or buttons for themselves only.
 */
export type FontScale = 'xsmall' | 'small' | 'default' | 'large' | 'xlarge';
export const FONT_SCALES: { value: FontScale; label: string; factor: number }[] = [
  { value: 'xsmall', label: 'Extra small', factor: 0.85 }, { value: 'small', label: 'Small', factor: 0.92 }, { value: 'default', label: 'Default', factor: 1 }, { value: 'large', label: 'Large', factor: 1.1 }, { value: 'xlarge', label: 'Extra large', factor: 1.2 },
];
export interface ThemeColors { accent: string; accent2: string; background: string; sidebar: string; surface: string; text: string; line: string }
export interface ThemeType { font: string; headingFont: string; base: FontScale; heading: FontScale; small: FontScale; weight: 400 | 500 }
/** Button size and corners; `height` (px) sets one exact height for every button (smaller buttons 8px less). */
export interface ThemeButtons { size: 'xsmall' | 'small' | 'default' | 'large'; radius: 'square' | 'soft' | 'rounded'; height?: number | null }
/** How much of each colour shows (100 = as chosen; lower blends it into what it sits on). The sidebar uses sidebarOpacity. */
export type ThemeOpacity = Partial<Record<Exclude<keyof ThemeColors, 'sidebar'>, number>>;
export interface CrmTheme {
  id: string; name: string; description: string;
  colors: ThemeColors; type: ThemeType; buttons: ThemeButtons;
  /** How much of the sidebar colour shows over the main background (0 = same as the background, 100 = the full colour). */
  sidebarOpacity?: number;
  /** Opacity of the other colours (see ThemeOpacity). */
  opacity?: ThemeOpacity;
  /** Draft (admins only), published (team can choose it) or retired (no longer offered; anyone using it moves to the default). */
  status: 'draft' | 'published' | 'retired';
  /** Who can choose it (roles); empty = everyone. */
  roles: BuiltinRole[];
}
export interface ThemeSettings {
  themes: CrmTheme[];
  /** The organization's default theme (everyone who hasn't chosen one). */
  defaultTheme: string;
  /** What team members may change for themselves on top of their theme. */
  allow: { colors: boolean; type: boolean; buttons: boolean };
}
const TYPE_STD: ThemeType = { font: 'inter', headingFont: 'nanum-myeongjo', base: 'default', heading: 'default', small: 'default', weight: 400 };
const BTN_STD: ThemeButtons = { size: 'default', radius: 'square' };
export const DEFAULT_THEME_SETTINGS: ThemeSettings = {
  themes: [
    { id: 'neutral', name: 'Addendum Neutral', description: 'Warm neutrals with a brown accent.', status: 'published', roles: [], type: TYPE_STD, buttons: BTN_STD,
      colors: { accent: '#6B5242', accent2: '#6B5242', background: '#F7F5F2', sidebar: '#EFECE7', surface: '#FFFFFF', text: '#1E1B18', line: '#E5E0D8' } },
    { id: 'espresso', name: 'Addendum Espresso', description: 'Ivory pages and an espresso menu.', status: 'published', roles: [], type: TYPE_STD, buttons: BTN_STD,
      colors: { accent: '#35281E', accent2: '#B08A5B', background: '#F3EEE7', sidebar: '#2A2019', surface: '#FCFAF6', text: '#1C1612', line: '#E1D8CC' } },
    { id: 'lime', name: 'Addendum Lime', description: 'Crisp white with a lime accent.', status: 'published', roles: [], type: TYPE_STD, buttons: BTN_STD,
      colors: { accent: '#C8DC45', accent2: '#111111', background: '#FFFFFF', sidebar: '#F5F3EE', surface: '#FFFFFF', text: '#111111', line: '#E7E4DE' } },
    { id: 'modern', name: 'Addendum Modern', description: 'Cool greys, sans-serif headings, soft corners.', status: 'published', roles: [],
      type: { ...TYPE_STD, headingFont: 'inter', weight: 400 }, buttons: { size: 'default', radius: 'soft' },
      colors: { accent: '#2E2D2B', accent2: '#2E2D2B', background: '#F4F4F2', sidebar: '#FFFFFF', surface: '#FFFFFF', text: '#18181B', line: '#E4E4E7' } },
  ],
  defaultTheme: 'neutral',
  allow: { colors: true, type: true, buttons: true },
};
/**
 * A person's own theme (one each): made from scratch in their Appearance. Only they see it unless they publish it, then
 * everyone can choose it too. Its id is "u-" + their account id.
 */
export interface UserThemeDTO { theme: CrmTheme; published: boolean; authorId: string; authorName: string; mine: boolean }
export const userThemeId = (staffId: string) => `u-${staffId}`;
/** The organization's themes plus personal ones (their own, and others' published) — what a person can choose from. */
export const withUserThemes = (t: Partial<ThemeSettings> | undefined, extra: CrmTheme[]): Partial<ThemeSettings> =>
  ({ ...(t ?? {}), themes: [...(t?.themes ?? DEFAULT_THEME_SETTINGS.themes), ...extra] });

// ---------------- Font styles (Settings → Theme Management → Font styles; each person's Appearance) ----------------
/** The kinds of text a font style sets. */
export type FontRole = 'heading' | 'subheading' | 'body' | 'menu' | 'button' | 'label' | 'link';
export const FONT_ROLES: { key: FontRole; label: string; hint: string }[] = [
  { key: 'heading', label: 'Headings', hint: 'Page titles' },
  { key: 'subheading', label: 'Subheadings', hint: 'Section titles and card headings' },
  { key: 'body', label: 'Paragraphs', hint: 'Body text, forms and tables' },
  { key: 'menu', label: 'Menu', hint: 'The sidebar' },
  { key: 'button', label: 'Buttons', hint: 'Every button and tab' },
  { key: 'label', label: 'Labels', hint: 'Field labels and table headings' },
  { key: 'link', label: 'Links', hint: 'Text links' },
];
export type FontWeight = 300 | 400 | 500 | 600 | 700;
/**
 * A font style: a font for each kind of text — a built-in one (FONT_CHOICES id) or an uploaded one ("file:<id>") —
 * with its weight and capitals. Administrators make and publish them; each person picks one in their Appearance.
 */
export interface FontStyle {
  id: string; name: string; description: string;
  fonts: Record<FontRole, string>;
  weights?: Partial<Record<FontRole, FontWeight>>;
  caps?: Partial<Record<FontRole, boolean>>;
  status: 'draft' | 'published';
}
/** An uploaded font file (administrators): usable in any font style. */
export interface FontLibraryEntry { id: string; name: string; version: string }
export interface FontStyleSettings {
  styles: FontStyle[];
  /** What everyone gets until they choose (null = the theme's own fonts). */
  defaultStyle: string | null;
  library: FontLibraryEntry[];
}
export const DEFAULT_FONT_STYLES: FontStyleSettings = {
  styles: [
    { id: 'editorial', name: 'Editorial', description: 'Serif headings, clean sans-serif everything else.', status: 'published',
      fonts: { heading: 'nanum-myeongjo', subheading: 'nanum-myeongjo', body: 'inter', menu: 'inter', button: 'inter', label: 'inter', link: 'inter' } },
    { id: 'modern', name: 'Modern', description: 'One crisp sans-serif, capital labels.', status: 'published', caps: { label: true },
      fonts: { heading: 'inter', subheading: 'inter', body: 'inter', menu: 'inter', button: 'inter', label: 'inter', link: 'inter' }, weights: { heading: 500, subheading: 500 } },
    { id: 'classic', name: 'Classic', description: 'Cormorant headings with Lora subheadings.', status: 'published',
      fonts: { heading: 'cormorant-garamond', subheading: 'lora', body: 'instrument-sans', menu: 'instrument-sans', button: 'instrument-sans', label: 'instrument-sans', link: 'instrument-sans' } },
  ],
  defaultStyle: null,
  library: [],
};
/** The font style that applies: their choice (if published), else the default (null = the theme's own fonts). */
export function resolveFontStyle(fs: Partial<FontStyleSettings> | undefined, personal: Partial<PersonalLook> | null | undefined): FontStyle | null {
  const s = { ...DEFAULT_FONT_STYLES, ...(fs ?? {}) };
  const published = s.styles.filter((x) => x.status === 'published');
  return published.find((x) => x.id === personal?.fontStyleId) ?? published.find((x) => x.id === s.defaultStyle) ?? null;
}
export const fontFileUrl = (e: FontLibraryEntry) => `/brand/fontfile/${e.id}?v=${encodeURIComponent(e.version)}`;

/** A person's own adjustments over their theme (only the parts their organization allows). */
export interface ThemeCustom { colors?: Partial<ThemeColors>; type?: Partial<ThemeType>; buttons?: Partial<ThemeButtons>; sidebarOpacity?: number; opacity?: ThemeOpacity }
/** Themes a person may choose: published, and open to their role. */
export const themesFor = (t: ThemeSettings, role: string | null | undefined) =>
  t.themes.filter((x) => x.status === 'published' && (!x.roles.length || (role ? x.roles.includes(role as BuiltinRole) : false)));
/** What applies: their chosen theme (if still offered to them), else the default; then their own allowed adjustments. */
export function resolveTheme(settings: Partial<ThemeSettings> | undefined, personal: Partial<PersonalLook> | null | undefined, role: string | null | undefined) {
  const t: ThemeSettings = { ...DEFAULT_THEME_SETTINGS, ...(settings ?? {}), allow: { ...DEFAULT_THEME_SETTINGS.allow, ...(settings?.allow ?? {}) } };
  const offered = themesFor(t, role);
  const base = offered.find((x) => x.id === personal?.themeId) ?? t.themes.find((x) => x.id === t.defaultTheme) ?? t.themes[0] ?? DEFAULT_THEME_SETTINGS.themes[0];
  const c = personal?.custom ?? {};
  // An accent chosen before themes existed still counts as their own accent.
  const ownAccent = c.colors?.accent ?? personal?.accent ?? undefined;
  return {
    theme: base,
    colors: { ...base.colors, ...(t.allow.colors ? { ...c.colors, ...(ownAccent ? { accent: ownAccent } : {}) } : {}) } as ThemeColors,
    type: { ...base.type, ...(t.allow.type ? c.type : {}) } as ThemeType,
    buttons: { ...base.buttons, ...(t.allow.buttons ? c.buttons : {}) } as ThemeButtons,
    sidebarOpacity: (t.allow.colors ? c.sidebarOpacity : undefined) ?? base.sidebarOpacity ?? 100,
    opacity: { ...(base.opacity ?? {}), ...(t.allow.colors ? c.opacity : {}) } as ThemeOpacity,
    allow: t.allow,
  };
}
export const DEFAULT_WORKSPACES: WorkspaceSettings = {
  businesses: { salon: { name: 'Addendum Salon', tagline: 'Salon' }, hair: { name: 'Addendum Hair', tagline: 'Hair extensions' } },
  nav: { '/appointments': 'salon', '/my-calendar': 'salon', '/inventory': 'salon', '/my-commission': 'salon', '/commission': 'salon' },
  menus: {
    // Addendum Salon + Square. "/appointments" and "/my-calendar" are the same tab (all calendars, or just their own).
    salon: ['/', '/appointments', '/my-calendar', '/tasks', '/follow-ups', '/messages', '/clients', '/inventory-sync'],
    hair: ['/', '/tasks', '/follow-ups', '/messages', '/clients', '/inventory-sync', '/analytics'],
  },
};
/** The sign-in screen (Settings → Businesses): umbrella-branded, with an optional editorial photo. */
export interface LoginSettings { headline: string; message: string; imageVersion: string | null }
export const DEFAULT_LOGIN: LoginSettings = { headline: 'Addendum', message: 'Salon & Hair — sign in to your workspace.', imageVersion: null };
/** The 16:10-ish photo beside the sign-in form: JPEG, PNG or WebP up to this size. */
export const LOGIN_IMAGE_MAX_BYTES = 1536 * 1024;

/** Ready-made looks for each business (Settings → Look → Themes). Choosing one fills the editor; everything stays editable. */
export interface LookPreset { id: string; business: BusinessId; name: string; note: string; look: AreaLook }
const SIZES_STD = { heading: 100, button: 100, nav: 100 };
export const LOOK_PRESETS: LookPreset[] = [
  // Addendum Salon — moody, warm, elevated: espresso, deep brown, soft black, warm ivory; an elegant display face with a clean sans.
  { id: 'salon-espresso-serif', business: 'salon', name: 'Espresso Serif', note: 'Warm ivory pages, espresso menu, serif headings', look: {
    accent: '#35281E', background: '#F3EEE7', sidebar: '#2A2019', surface: '#FCFAF6', line: '#E1D8CC', text: '#1C1612', heading: '#1C1612',
    fonts: { heading: 'nanum-myeongjo', body: 'helvetica', link: 'same', button: 'same', nav: 'same' },
    headingCase: 'normal', corners: 'square', badge: { background: '#35281E', text: '#F3EEE7', uppercase: true }, textScale: 95, sizes: SIZES_STD,
    mode: 'light', type: { headingWeight: 400, headingTracking: -5, lineHeight: 150 },
  } },
  { id: 'salon-signature', business: 'salon', name: 'Signature', note: 'Ivory and espresso, airy capitals like the salon’s site', look: {
    accent: '#35281E', background: '#EFEAE3', sidebar: '#35281E', surface: '#FBF8F3', line: '#DCD3C7', text: '#1A1512', heading: '#1A1512',
    fonts: { heading: 'work-sans', body: 'helvetica', link: 'same', button: 'same', nav: 'same' },
    headingCase: 'uppercase', corners: 'square', badge: { background: '#35281E', text: '#EFEAE3', uppercase: true }, textScale: 95, sizes: SIZES_STD,
    mode: 'light', type: { headingWeight: 300, headingTracking: 20, lineHeight: 150 },
  } },
  { id: 'salon-soft-black', business: 'salon', name: 'Soft Black', note: 'Dark and atmospheric, ivory text', look: {
    accent: '#B89A7A', background: '#0B0908', sidebar: '#050404', text: '#EFEAE3', heading: '#EFEAE3',
    fonts: { heading: 'work-sans', body: 'helvetica', link: 'same', button: 'same', nav: 'same' },
    headingCase: 'uppercase', corners: 'square', badge: { background: '#B89A7A', text: '#0B0908', uppercase: true }, textScale: 95, sizes: SIZES_STD,
    mode: 'dark', type: { headingWeight: 300, headingTracking: 20, lineHeight: 150 },
  } },
  { id: 'salon-deep-brown', business: 'salon', name: 'Deep Brown', note: 'Espresso throughout, warm and intimate', look: {
    accent: '#C2A27F', background: '#1D1611', sidebar: '#120D0A', text: '#F1EBE3', heading: '#F1EBE3',
    fonts: { heading: 'nanum-myeongjo', body: 'helvetica', link: 'same', button: 'same', nav: 'same' },
    headingCase: 'normal', corners: 'square', badge: { background: '#C2A27F', text: '#1D1611', uppercase: true }, textScale: 95, sizes: SIZES_STD,
    mode: 'dark', type: { headingWeight: 400, headingTracking: -5, lineHeight: 150 },
  } },
  // Addendum Hair — modern, minimal, editorial: crisp ivory, stone, charcoal, restrained accents, clean grids.
  { id: 'hair-editorial', business: 'hair', name: 'Editorial White', note: 'Crisp white, black capitals, lime badges', look: {
    accent: '#111111', background: '#FFFFFF', sidebar: '#F5F3EE', surface: '#FFFFFF', line: '#E7E4DE', text: '#111111', heading: '#111111',
    fonts: { heading: 'helvetica', body: 'helvetica', link: 'same', button: 'same', nav: 'same' },
    headingCase: 'uppercase', corners: 'square', badge: { background: '#E4F24B', text: '#111111', uppercase: true }, textScale: 100, sizes: SIZES_STD,
    mode: 'light', type: { headingWeight: 500, headingTracking: -10, lineHeight: 150 },
  } },
  { id: 'hair-ivory', business: 'hair', name: 'Crisp Ivory', note: 'Ivory pages, white cards, charcoal type', look: {
    accent: '#1F1F1F', background: '#F5F3EE', sidebar: '#FFFFFF', surface: '#FFFFFF', line: '#E4E0D8', text: '#1F1F1F', heading: '#1F1F1F',
    fonts: { heading: 'inter', body: 'inter', link: 'same', button: 'same', nav: 'same' },
    headingCase: 'uppercase', corners: 'square', badge: { background: '#E4F24B', text: '#111111', uppercase: true }, textScale: 100, sizes: SIZES_STD,
    mode: 'light', type: { headingWeight: 500, headingTracking: 0, lineHeight: 150 },
  } },
  { id: 'hair-stone', business: 'hair', name: 'Stone', note: 'Soft stone and charcoal, quiet and architectural', look: {
    accent: '#2E2C29', background: '#ECE8E1', sidebar: '#DED8CE', surface: '#F8F6F2', line: '#D6CFC4', text: '#232120', heading: '#232120',
    fonts: { heading: 'inter', body: 'inter', link: 'same', button: 'same', nav: 'same' },
    headingCase: 'uppercase', corners: 'square', badge: { background: '#2E2C29', text: '#F8F6F2', uppercase: true }, textScale: 100, sizes: SIZES_STD,
    mode: 'light', type: { headingWeight: 500, headingTracking: 10, lineHeight: 150 },
  } },
  { id: 'hair-charcoal', business: 'hair', name: 'Charcoal', note: 'Dark charcoal with ivory type', look: {
    accent: '#D8D2C8', background: '#141414', sidebar: '#0C0C0C', text: '#F5F3EE', heading: '#F5F3EE',
    fonts: { heading: 'helvetica', body: 'helvetica', link: 'same', button: 'same', nav: 'same' },
    headingCase: 'uppercase', corners: 'square', badge: { background: '#E4F24B', text: '#111111', uppercase: true }, textScale: 100, sizes: SIZES_STD,
    mode: 'dark', type: { headingWeight: 500, headingTracking: 0, lineHeight: 150 },
  } },
];
const preset = (id: string) => LOOK_PRESETS.find((p) => p.id === id)!.look;
/** Matched to the brands' own websites: addendumsalon.com and addendumhair.com. */
export const DEFAULT_AREA_LOOKS: { main: AreaLook; salon: AreaLook; online: AreaLook } = {
  main: preset('salon-espresso-serif'),
  salon: preset('salon-espresso-serif'),
  online: preset('hair-editorial'),
};

export type ColorMode = 'light' | 'dark' | 'auto';

/** A person's own look, over the salon's (saved to their account): accent and light/dark. null = the salon's. */
export interface PersonalLook {
  accent: string | null;
  mode: ColorMode | null;
  /** A ready-made theme (see THEMES); its own accent/mode still apply over it. null = the salon's look. */
  theme?: string | null;
  /** The business workspace they last chose (opens there next time). null = the first they can use. */
  workspace?: BusinessId | null;
  /** The font style they chose (Appearance); null = the organization's default. */
  fontStyleId?: string | null;
  /** Their own secondary accent (active menu indicator) and highlight (badges). null = the theme's. */
  accent2?: string | null;
  highlight?: string | null;
  /** Their theme (Settings → Theme Management publishes them) and their own adjustments over it. */
  themeId?: string | null;
  custom?: ThemeCustom;
  /** Older: different colours in each business workspace. */
  perWorkspace?: boolean;
  byWorkspace?: Partial<Record<BusinessId, ColorChoice>>;
}

/** Older colour-theme choices (no longer applied: one design for everyone, only the accent is personal). */
export interface ColorChoice { theme: string | null; accent: string | null; accent2: string | null; highlight: string | null }
export const EMPTY_CHOICE: ColorChoice = { theme: null, accent: null, accent2: null, highlight: null };

/** Ready-made colour themes: background, sidebar, accent, light or dark. */
export interface ColorTheme { id: string; name: string; mode: 'light' | 'dark'; accent: string; background: string; sidebar: string }
export const THEMES: ColorTheme[] = [
  { id: 'classic', name: 'Classic', mode: 'light', accent: '#6B3F55', background: '#FAFAF8', sidebar: '#F4F4F1' },
  // From the brands' own sites: addendumsalon.com (espresso on soft off-white and cream) and addendumhair.com (taupe on white).
  { id: 'addendum-salon', name: 'Addendum Salon', mode: 'light', accent: '#37271B', background: '#F5F5F3', sidebar: '#F1EBE4' },
  { id: 'addendum-hair', name: 'Addendum Hair', mode: 'light', accent: '#85745C', background: '#FFFFFF', sidebar: '#F7F6F3' },
  // Brand palettes (also as business looks): espresso and ivory for the salon, stone and charcoal for Addendum Hair.
  { id: 'espresso', name: 'Espresso', mode: 'light', accent: '#35281E', background: '#F3EEE7', sidebar: '#2A2019' },
  { id: 'ivory', name: 'Ivory', mode: 'light', accent: '#1F1F1F', background: '#F5F3EE', sidebar: '#FFFFFF' },
  { id: 'stone', name: 'Stone', mode: 'light', accent: '#2E2C29', background: '#ECE8E1', sidebar: '#DED8CE' },
  { id: 'softblack', name: 'Soft Black', mode: 'dark', accent: '#B89A7A', background: '#0B0908', sidebar: '#050404' },
  { id: 'charcoal', name: 'Charcoal', mode: 'dark', accent: '#D8D2C8', background: '#141414', sidebar: '#0C0C0C' },
  { id: 'light', name: 'Light', mode: 'light', accent: '#3A3835', background: '#FFFFFF', sidebar: '#F6F6F6' },
  { id: 'blue', name: 'Ocean Blue', mode: 'light', accent: '#34486E', background: '#F5F8FC', sidebar: '#E8EEF7' },
  { id: 'green', name: 'Sage Green', mode: 'light', accent: '#47695A', background: '#F6F8F5', sidebar: '#E7EFE9' },
  { id: 'blush', name: 'Blush', mode: 'light', accent: '#8A4B4F', background: '#FCF7F6', sidebar: '#F5E8E7' },
  { id: 'lavender', name: 'Lavender', mode: 'light', accent: '#5E4F96', background: '#F8F7FC', sidebar: '#ECE9F6' },
  { id: 'sand', name: 'Sand', mode: 'light', accent: '#7A5C2E', background: '#FBF8F2', sidebar: '#F1EADC' },
  { id: 'teal', name: 'Teal', mode: 'light', accent: '#2F6670', background: '#F4F9F9', sidebar: '#E3EFF0' },
  { id: 'dark', name: 'Dark', mode: 'dark', accent: '#6B3F55', background: '#181716', sidebar: '#1E1D1C' },
  { id: 'midnight', name: 'Midnight', mode: 'dark', accent: '#34486E', background: '#161A21', sidebar: '#1B2029' },
  { id: 'forest', name: 'Forest', mode: 'dark', accent: '#47695A', background: '#151A17', sidebar: '#1A201C' },
];

export const DEFAULT_APPEARANCE: Appearance = {
  accent: DEFAULT_ACCENT, background: 'warm', sidebar: 'soft', headingFont: 'serif', bodyFont: 'default',
  backgroundColor: null, sidebarColor: null, textColor: null, headingColor: null, mode: 'light',
  headingFontName: null, headingFontVersion: null, bodyFontName: null, bodyFontVersion: null,
  brandName: 'Addendum', tagline: 'Salon command center', logoMode: 'logo_name', logoAsIcon: false, logoVersion: null,
  // Looks by area on by default: the CRM matches addendumsalon.com and addendumhair.com out of the box.
  fonts: { heading: 'nanum-myeongjo', body: 'inter', link: 'same', button: 'same', nav: 'same' }, fontFiles: {}, corners: 'square', areaColors: { enabled: true, salonTheme: 'addendum-salon', onlineTheme: 'addendum-hair' },
  areaLooks: DEFAULT_AREA_LOOKS,
  themeSettings: DEFAULT_THEME_SETTINGS,
};

/** Logo files: PNG, JPEG or WebP up to this size (SVG isn't accepted: it can carry scripts). */
export const LOGO_MAX_BYTES = 400 * 1024;
/** Font files: WOFF2 (best), WOFF, TTF or OTF up to this size. */
export const FONT_MAX_BYTES = 1536 * 1024;
/** Kinds of text that can each have their own font. */
export type FontSlot = 'heading' | 'body' | 'link' | 'button' | 'nav';
export const FONT_SLOTS: { slot: FontSlot; label: string; hint: string }[] = [
  { slot: 'heading', label: 'Headings', hint: 'Page titles and section headings' },
  { slot: 'body', label: 'Paragraphs & text', hint: 'Everything else, unless set below' },
  { slot: 'link', label: 'Links', hint: 'Text links' },
  { slot: 'button', label: 'Buttons', hint: 'Buttons and tabs' },
  { slot: 'nav', label: 'Menu', hint: 'The sidebar and section menus' },
];
/** Built-in fonts (bundled with the app — nothing loads from other sites). `stack` is the CSS font-family. */
export const FONT_CHOICES: { id: string; label: string; kind: 'serif' | 'sans'; stack: string; note?: string }[] = [
  { id: 'cormorant-garamond', label: 'Cormorant Garamond', kind: 'serif', stack: '"Cormorant Garamond", Georgia, serif', note: 'Classic' },
  { id: 'cormorant', label: 'Cormorant', kind: 'serif', stack: 'Cormorant, Georgia, serif', note: 'addendumhair.com headings' },
  { id: 'nanum-myeongjo', label: 'Nanum Myeongjo', kind: 'serif', stack: '"Nanum Myeongjo", Georgia, serif', note: 'addendumsalon.com headings' },
  { id: 'playfair-display', label: 'Playfair Display', kind: 'serif', stack: '"Playfair Display", Georgia, serif' },
  { id: 'lora', label: 'Lora', kind: 'serif', stack: 'Lora, Georgia, serif' },
  { id: 'georgia', label: 'Georgia', kind: 'serif', stack: 'Georgia, "Times New Roman", serif', note: 'System' },
  { id: 'instrument-sans', label: 'Instrument Sans', kind: 'sans', stack: '"Instrument Sans", system-ui, -apple-system, "Segoe UI", sans-serif', note: 'Classic' },
  { id: 'inter', label: 'Inter', kind: 'sans', stack: 'Inter, system-ui, -apple-system, "Segoe UI", sans-serif', note: 'addendumhair.com text' },
  { id: 'work-sans', label: 'Work Sans', kind: 'sans', stack: '"Work Sans", system-ui, -apple-system, "Segoe UI", sans-serif', note: 'addendumsalon.com text' },
  { id: 'helvetica', label: 'Helvetica', kind: 'sans', stack: '"Helvetica Neue", Helvetica, Arial, sans-serif', note: 'addendumsalon.com style' },
  { id: 'dm-sans', label: 'DM Sans', kind: 'sans', stack: '"DM Sans", system-ui, -apple-system, sans-serif' },
  { id: 'montserrat', label: 'Montserrat', kind: 'sans', stack: 'Montserrat, system-ui, -apple-system, sans-serif' },
  { id: 'jost', label: 'Jost', kind: 'sans', stack: 'Jost, system-ui, -apple-system, sans-serif' },
  { id: 'system', label: 'Device default', kind: 'sans', stack: 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif', note: 'System' },
];
/** The font chosen for a slot: its own choice, else the older heading/body settings, else (links, buttons, menu) the body's. */
export function fontChoice(a: Appearance, slot: FontSlot): string {
  const own = a.fonts?.[slot];
  if (own) return own;
  if (slot === 'heading') return a.headingFont === 'custom' ? 'custom' : a.headingFont === 'sans' ? 'instrument-sans' : 'cormorant-garamond';
  if (slot === 'body') return a.bodyFont === 'custom' ? 'custom' : 'instrument-sans';
  return 'same';
}
export const fontFile = (a: Appearance, slot: FontSlot) =>
  a.fontFiles?.[slot] ?? (slot === 'heading' && a.headingFontVersion ? { name: a.headingFontName ?? 'Your font', version: a.headingFontVersion }
    : slot === 'body' && a.bodyFontVersion ? { name: a.bodyFontName ?? 'Your font', version: a.bodyFontVersion } : null);
export const fontUrl = (a: Appearance, slot: FontSlot) => {
  const f = fontFile(a, slot);
  return f ? `/brand/font/${slot}?v=${encodeURIComponent(f.version)}` : null;
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
  new_lead: 'New client',
  lead_no_response: "New client hasn't responded",
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
  /** Picked from Shopify inventory: its SKU and the variant name as Shopify has it (null when typed by hand). */
  sku: string | null;
  shopifyLabel: string | null;
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
  /** What this product is (null: not chosen yet and not paired with Shopify). */
  kind: ProductKind | null;
  /** Marked Discontinued (or Not tracked): left out of syncing and inventory lists. */
  discontinued: boolean;
  /** The listing's photo (Square's), when it has one. */
  imageUrl: string | null;
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
  /** Optional: the customer the hair is for (free text). */
  customerName: string | null;
  forStaffId: string | null;
  forStaffName: string | null;
  requestedById: string | null;
  requestedByName: string | null;
  items: InventoryItemDTO[];
  totalUnits: number;
  /** none: nothing taken from inventory · reserving: Shopify not confirmed yet (submit again to finish) · reserved: done. */
  inventoryStatus: 'none' | 'reserving' | 'reserved';
  /** The stylist's email, for the team to get in touch. */
  forStaffEmail: string | null;
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
  { value: 'new_lead', label: 'New client' },
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
  shopifyInventoryItemId: string;
  shopifySyncEnabled: boolean;
}

/** A product kept in one store only: never paired or synced. */
export interface InventorySeparateDTO { store: 'square' | 'shopify'; itemId: string; label: string; sku: string | null; markedAt: string; markedBy: string | null }

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
  /** The optional second Shopify store sharing the same stock; `name` is how it's shown. */
  shopify2: { name: string; connected: boolean; status: string; message: string | null; lastSuccessAt: string | null };
  lastRun: InventorySyncRunDTO | null;
  lastSuccessfulSyncAt: string | null;
  running: boolean;
  counts: { linked: number; inSync: number; attention: number; errors: number; pending: number; syncOff: number };
  /** `id` is the Square variation ID / Shopify inventory item ID (missing in lists saved before it was added). */
  unmatched: { squareOnly: { id?: string; label: string; sku: string | null }[]; shopifyOnly: { id?: string; label: string; sku: string }[]; duplicates: { sku: string; where: string; count: number }[]; noSku: number };
  separate: InventorySeparateDTO[];
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

// ---------------- Inventory tools (from Addendum-Stockline) ----------------
export type StockProductStatus = 'active' | 'discontinued' | 'not_tracked';

// ---------------- Product search ----------------
const unquote = (v: string) => v.toLowerCase().replace(/[“”″]|''|’’/g, '"').replace(/[‘’′]/g, "'");
// 22", 22 in, 22 inch, 22-inch, 22in → "22in", so a size matches however it was typed.
const sizes = (v: string) => v.replace(/(\d+)\s*(?:"|-?\s*inch(?:es)?\b|\s?in\b)/g, '$1in');

/**
 * Searchable text for a product (name, colour, size, SKU, collection…): as written, with sizes in one form, and with
 * dashes and dots as spaces — so "18-APRW" finds the SKU and "aperol 18" finds "18” Redefined Weft - Aperol Spritz".
 */
export function productSearchText(...parts: (string | null | undefined)[]): string {
  const raw = unquote(parts.filter(Boolean).join(' '));
  const sized = sizes(raw);
  return `${raw} ${sized} ${sized.replace(/[-_·•/|,()]+/g, ' ')}`;
}
/** The words of a product search, sizes in the same form as productSearchText (each must appear somewhere). */
export const productSearchWords = (q: string): string[] => sizes(unquote(q.trim())).split(/\s+/).filter(Boolean);

/** What a Square product is: shared stock with Shopify, its own salon-floor stock, salon only, or an add-on service. */
export type ProductKind = 'shared' | 'separate' | 'salon_only' | 'service';
export const PRODUCT_KINDS: { value: ProductKind; label: string; help: string }[] = [
  { value: 'shared', label: 'Same stock online', help: 'One shared count, kept in sync with Shopify.' },
  { value: 'separate', label: 'Separate stock', help: 'Also sold online, but the salon floor is counted on its own. Never synced.' },
  { value: 'salon_only', label: 'Salon only', help: 'Sold in the salon, not online.' },
  { value: 'service', label: 'Add-on service', help: 'No stock. Left out of inventory lists.' },
];

/** One product as both stores have it: SKU and stock in Square and Shopify, plus ordering details kept in the CRM. */
export interface StockProductDTO {
  /** Square variation id, or "shopify:<inventory item id>" for a product only in Shopify. */
  key: string;
  label: string;
  sku: string | null;
  squareSku: string | null;
  shopifySku: string | null;
  squareVariationId: string | null;
  shopifyInventoryItemId: string | null;
  linkId: string | null;
  /** null = not in that store, or its stock isn't tracked there. */
  squareQty: number | null;
  shopifyQty: number | null;
  /** The second Shopify store's listings with this SKU (it may list one SKU more than once, at different prices). */
  store2: { inventoryItemId: string; label: string; qty: number | null }[];
  /** Other listings in the main Shopify store with the same SKU (e.g. a PRO listing): one stock, kept the same. */
  siblings?: { inventoryItemId: string; label: string; qty: number | null }[];
  priceCents: number | null;
  supplier: string | null;
  costCents: number | null;
  leadTimeDays: number | null;
  safetyDays: number | null;
  moq: number | null;
  caseSize: number | null;
  status: StockProductStatus;
  /** What the Square product is (null for Shopify-only products, or not chosen yet). */
  kind: ProductKind | null;
  /** Collections and categories (Shopify collections and product type, Square categories), for search. */
  collections: string[];
  /** The listing's photo: Square's, else Shopify's (null when neither has one). */
  imageUrl: string | null;
}

/** A change to one product: a new SKU, a new count, or an amount to add (+) or remove (−). */
/** `onlineQuantity`: for separate-stock products, the online count (AH-PRO and the second store); `quantity` is then the salon's. */
export interface StockChangeInput { key: string; sku?: string; quantity?: number; delta?: number; onlineQuantity?: number }

export interface StockApplyResultDTO {
  changed: number;
  results: { key: string; label: string; ok: boolean; note: string }[];
}

export type StockTxnKind = 'count' | 'adjust' | 'import' | 'receive' | 'sku' | 'sync';
export interface StockTxnDTO {
  id: string;
  productKey: string;
  label: string;
  sku: string | null;
  kind: StockTxnKind;
  reason: string | null;
  note: string | null;
  squareBefore: number | null;
  squareAfter: number | null;
  shopifyBefore: number | null;
  shopifyAfter: number | null;
  oldSku: string | null;
  newSku: string | null;
  staffName: string | null;
  reference: string | null;
  createdAt: string;
}

export const STOCK_REASONS = ['Stock count', 'Received', 'Damaged', 'Lost', 'Customer return', 'Found', 'Sample', 'Salon use', 'Correction'] as const;

export type StockForecastStatus = 'out' | 'order_now' | 'soon' | 'watch' | 'healthy' | 'no_sales' | 'discontinued';
export interface StockForecastDTO {
  key: string;
  label: string;
  sku: string | null;
  supplier: string | null;
  /** Shopify collections / product type and Square categories (To order can be grouped by them). */
  collections: string[];
  /** Its supplier's lead time isn't tracked (Suppliers): timed on safety stock alone, and left out of Analytics → Forecast. */
  leadUntracked: boolean;
  /** The supplier's shipping days (included in leadTimeDays). */
  shippingDays: number;
  /** Stock-out risk: at this rate it runs out before an order placed today would arrive. */
  stockoutRisk: boolean;
  stock: number;
  /** On open purchase orders (ordered or shipped), not yet received. */
  incoming: number;
  /** Units a day used for the forecast (a blend of the 7, 30 and 90-day rates). */
  ratePerDay: number;
  units7: number;
  units30: number;
  units90: number;
  leadTimeDays: number;
  safetyDays: number;
  daysOfStock: number | null;
  /** The last day to order so it arrives before stock falls below the safety level. */
  orderBy: string | null;
  status: StockForecastStatus;
  suggestedQty: number;
  moq: number | null;
  caseSize: number | null;
  costCents: number | null;
  /** MOQ timing: what the minimum order costs, when it would arrive if ordered today, and how long it lasts. */
  moqCostCents: number | null;
  moqArrivesOn: string | null;
  moqLastsDays: number | null;
  /** The minimum order takes longer than the "slow to use" days to sell (ties up cash). */
  slowToUse: boolean;
  why: string[];
  /** Sold in the salon (Square) and/or online (Shopify). */
  stores: { salon: boolean; online: boolean };
  /** The day it sells out at the current rate (today when it's out); null with no sales. */
  sellOutOn: string | null;
  /** Pre-orders: units customers ordered online that aren't in stock yet (Shopify below zero). */
  preorders: number;
}
/** `soonDays` / `watchDays`: Reorder soon and Watch windows — days until the order-by date, worked out from how fast each product sells. */
/** `defaultMoq`: minimum order for products with none of their own or from their supplier (0 = none). */
export interface StockForecastSettings { leadTimeDays: number; safetyDays: number; coverageDays: number; slowToUseDays: number; soonDays: number; watchDays: number; defaultMoq: number }
export interface StockForecastResponse {
  items: StockForecastDTO[];
  settings: StockForecastSettings;
  salesFrom: { square: boolean; shopify: boolean; shopifyNote: string | null; shopifyUpdatedAt: string | null };
}

export type PurchaseOrderStatus = 'draft' | 'ordered' | 'shipped' | 'received' | 'cancelled';
/** `leadTimeDays`: this item's own lead time; `expectedOn`: when it should arrive (set when the order is placed). */
export interface PurchaseOrderLineDTO { id: string; productKey: string; label: string; sku: string | null; quantity: number; received: number; costCents: number | null; leadTimeDays: number | null; expectedOn: string | null; lotNote: string | null }
export interface PurchaseOrderDTO {
  id: string;
  number: number;
  /** Its own name (shown in place of "PO #12"); null = just the number. */
  name: string | null;
  /** Which store it's for: the salon (Square) or online (Shopify). Receiving adds stock there. */
  store: 'salon' | 'shopify';
  supplier: string | null;
  status: PurchaseOrderStatus;
  expectedOn: string | null;
  note: string | null;
  createdAt: string;
  orderedAt: string | null;
  receivedAt: string | null;
  createdByName: string | null;
  lines: PurchaseOrderLineDTO[];
  totalCents: number;
}

/** Analytics → Product sales: retail units and sales from Square and Shopify, top sellers, monthly usage and stock value. */
export interface ProductAnalyticsDTO {
  from: string;
  to: string;
  /** Which store's sales: Square, the main Shopify store, the second Shopify store, both Shopify stores (online), or all. */
  store: 'all' | 'square' | 'shopify' | 'shopify2' | 'online';
  /** The second Shopify store's name (null when there isn't one). */
  store2Name: string | null;
  totals: { units: number; salesCents: number; products: number; square: { units: number; salesCents: number }; shopify: { units: number; salesCents: number }; shopify2: { units: number; salesCents: number } };
  /** The same length of time just before, for comparison. */
  previous: { units: number; salesCents: number };
  bucket: 'day' | 'week' | 'month';
  trend: { start: string; square: number; shopify: number; shopify2: number; salesCents: number }[];
  /** Every product bought in the period, best sellers first. */
  /** `alsoSkus`: other SKUs (an old SKU, a replaced listing) whose sales are combined into this row by name. */
  top: { key: string; label: string; sku: string | null; alsoSkus: string[]; units: number; salesCents: number; squareUnits: number; shopifyUnits: number; shopify2Units: number }[];
  monthly: { months: string[]; rows: { key: string; label: string; sku: string | null; units: number[]; total: number; avgPerMonth: number }[] };
  stock: { unitsOnHand: number; atCostCents: number; atRetailCents: number; missingCost: number };
  salesFrom: { square: boolean; shopify: boolean; shopifyNote: string | null };
}

/** Suppliers: from products' supplier and purchase orders, with the lead time they quote vs what they actually take. */
export interface SupplierDTO {
  /** The name shown around the CRM (products, purchase orders, reorder). */
  name: string;
  /** The real company behind it — null for people without "See supplier company names and contacts" (as are the contacts). */
  companyName: string | null;
  products: number;
  /** Average lead time set on their products. */
  statedLeadDays: number | null;
  /** Average days from ordered to received, over their received purchase orders. */
  actualLeadDays: number | null;
  receivedOrders: number;
  openOrders: number;
  spentCents: number;
  /** Contact details and usual lead time (Suppliers → Add supplier / Edit). */
  email: string | null;
  phone: string | null;
  website: string | null;
  notes: string | null;
  leadTimeDays: number | null;
  /** Lead time not tracked: reorder timing leaves it out for this supplier's products, and orders get no expected date. */
  leadUntracked: boolean;
  /** Days in transit, added to the lead time for its products. */
  shippingDays: number | null;
  /** Minimum order for its products that don't have their own. */
  defaultMoq: number | null;
  /** Used for products and orders that don't name a supplier. */
  isDefault: boolean;
}
export interface SupplierInput { name: string; companyName?: string | null; email?: string | null; phone?: string | null; website?: string | null; notes?: string | null; leadTimeDays?: number | null; leadUntracked?: boolean; shippingDays?: number | null; defaultMoq?: number | null }
/** Which products to give a supplier: chosen products, or every product in a store. */
export type SupplierAssign = { supplier: string; keys: string[] } | { supplier: string; store: 'square' | 'shopify' | 'shopify2' | 'all'; onlyWithout: boolean };

// ---------------- Addendum Hair CRM (separate from the salon's clients and follow-ups) ----------------
export interface HairClientDTO { id: string; name: string; email: string | null; phone: string | null; company: string | null; notes: string | null; openTasks: number; fromHighLevel: boolean; createdAt: string }
export interface HairHighLevelDTO {
  connected: boolean;
  /** Addendum Hair's own HighLevel sub-account, or the main connection. */
  source: 'own' | 'main' | null;
  tag: string | null;
  auto: boolean;
  lastPullAt: string | null;
  lastResult: { added: number; updated: number; matched: number; scanned: number } | null;
  lastError: string | null;
}
export type HairTaskType = 'reply' | 'order' | 'check_in' | 'other';
export type HairTaskStatus = 'open' | 'waiting' | 'done';
export const HAIR_TASK_TYPES: { value: HairTaskType; label: string }[] = [
  { value: 'reply', label: 'Reply needed' }, { value: 'order', label: 'Order hair' }, { value: 'check_in', label: 'Check in' }, { value: 'other', label: 'Other' },
];
export interface HairTaskDTO {
  id: string;
  clientId: string | null;
  clientName: string | null;
  title: string;
  description: string | null;
  type: HairTaskType;
  source: 'email' | 'follow_up' | 'manual';
  sourceSubject: string | null;
  sourceFrom: string | null;
  sourceExcerpt: string | null;
  status: HairTaskStatus;
  nextStep: string | null;
  dueOn: string | null;
  assignedName: string | null;
  completedAt: string | null;
  createdAt: string;
}

/**
 * Suggests a task from a pasted email: the type (an order, a question to answer, a check-in), a short title and a due date.
 * Only a starting point — everything can be changed before saving.
 */
export function suggestHairTask(email: { subject?: string; body?: string }, today: string): { type: HairTaskType; title: string; dueOn: string; excerpt: string } {
  const subject = (email.subject ?? '').trim();
  const body = (email.body ?? '').replace(/\r/g, '').trim();
  const text = `${subject}\n${body}`.toLowerCase();
  const plus = (days: number) => { const d = new Date(`${today}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };
  const order = /\b(order|re-?stock|restock|back in stock|in stock|out of stock|sold out|available|availability|bundles?|wefts?|k-?tips?|tape-?ins?|clip-?ins?|inventory|reserve|pre-?order|backorder)\b/.test(text);
  const question = /\?/.test(body) || /\b(can you|could you|please|let me know|when will|do you have|how much|is it possible)\b/.test(text);
  const later = /\b(next week|next month|follow up|check in|circle back|touch base|remind)\b/.test(text);
  const type: HairTaskType = order ? 'order' : question ? 'reply' : later ? 'check_in' : 'other';
  const firstLine = body.split(/\n+/).map((l) => l.trim()).find((l) => l && !/^(hi|hey|hello|dear)\b/i.test(l)) ?? '';
  const title = (subject || firstLine || 'Email from a client').replace(/^(re|fwd?):\s*/i, '').slice(0, 120);
  const dueOn = type === 'reply' ? plus(1) : type === 'order' ? plus(2) : type === 'check_in' ? plus(7) : plus(3);
  return { type, title, dueOn, excerpt: body.slice(0, 600) };
}
