import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  AppSettings, AppointmentDTO, ClientSummaryDTO, ConversationDTO, CurrentUser, DashboardSummary, IntegrationStatusDTO,
  InventoryRequestDTO, LeadDTO, MessageDTO, RebookingInsight, RecommendedAction, StaffDTO, TaskDTO,
} from '@addendum/shared';
import { api, qs } from './client';

export const keys = {
  me: ['me'] as const,
};

export function useMe() {
  return useQuery({ queryKey: ['me'], queryFn: () => api.get<{ user: CurrentUser }>('/auth/me').then((r) => r.user), retry: false, staleTime: 60_000 });
}

export function useDashboard() {
  return useQuery({
    queryKey: ['dashboard'],
    queryFn: () => api.get<{ summary: DashboardSummary; actions: RecommendedAction[]; integrations: IntegrationStatusDTO; widgets: DashboardWidgets }>('/dashboard'),
    refetchInterval: 60_000,
  });
}

/** Dashboard widgets the server allowed for this person (each needs its widget permission and the data permission). */
export interface DashboardWidgets {
  schedule: boolean; followups: boolean; clients: boolean; analytics: boolean;
  announcements: { unread: number; latest: { id: string; title: string; important: boolean; pinned: boolean; publishedAt: string | null; authorName: string | null; read: boolean }[] } | null;
  orders: { scope: 'everyone' | 'mine'; open: number; next: { id: string; number: number; status: string; neededBy: string | null; forName: string | null; units: number }[] } | null;
  myCommission: { from: string; to: string; totalCents: number } | null;
  teamCommission: { from: string; to: string; totalCents: number } | null;
}

export function useIntegrations(enabled = true) {
  return useQuery({ queryKey: ['integrations'], queryFn: () => api.get<IntegrationStatusDTO>('/integrations/status'), refetchInterval: 60_000, enabled });
}

/** Mirrors the server's permission check, for showing/hiding things. The server still enforces every request. */
export function useCanDo() {
  const { data: me } = useMe();
  return (permission: string) => !!me && me.permissions.includes(permission);
}

export function useSettings() {
  return useQuery({ queryKey: ['settings'], queryFn: () => api.get<{ settings: AppSettings; limited?: boolean }>('/settings'), staleTime: 30_000 });
}

export function useStaff(enabled = true) {
  return useQuery({ queryKey: ['staff'], queryFn: () => api.get<{ staff: StaffDTO[] }>('/staff').then((r) => r.staff), staleTime: 60_000, enabled });
}

export function useTags() {
  return useQuery({ queryKey: ['tags'], queryFn: () => api.get<{ tags: { id: string; name: string; isDefault: boolean; count: number }[] }>('/tags').then((r) => r.tags) });
}

export function useServices() {
  return useQuery({ queryKey: ['services'], queryFn: () => api.get<{ services: { id: string; name: string }[] }>('/services').then((r) => r.services), staleTime: 300_000 });
}

export function useTasks(params: Record<string, string | undefined>, enabled = true) {
  return useQuery({ queryKey: ['tasks', params], queryFn: () => api.get<{ tasks: TaskDTO[] }>(`/tasks${qs(params)}`).then((r) => r.tasks), enabled });
}

export function useAppointments(params: Record<string, string | undefined>, enabled = true) {
  return useQuery({ queryKey: ['appointments', params], queryFn: () => api.get<{ appointments: AppointmentDTO[] }>(`/appointments${qs(params)}`).then((r) => r.appointments), enabled });
}

export function useClients(params: Record<string, string | undefined>) {
  return useQuery({ queryKey: ['clients', params], queryFn: () => api.get<{ clients: ClientSummaryDTO[]; total: number }>(`/clients${qs(params)}`) });
}

export interface ClientProfile {
  client: ClientSummaryDTO & { firstName: string; lastName: string; birthday: string | null; preferredStaffId: string | null; leadSource: string | null; highlevelContactId: string | null; smsOptedOut: boolean; createdAt: string };
  services: string[];
  appointments: AppointmentDTO[];
  tasks: TaskDTO[];
  notes: { id: string; body: string; pinned: boolean; author: string | null; createdAt: string }[];
  conversationId: string | null;
  messages: MessageDTO[];
  staffAssignments: { id: string; name: string; color: string }[];
  rebooking: RebookingInsight;
  access?: { history: boolean; contact: boolean; messages: boolean; tasks: boolean };
}

export function useClient(id: string | undefined) {
  return useQuery({ queryKey: ['client', id], queryFn: () => api.get<ClientProfile>(`/clients/${id}`), enabled: !!id });
}

export function useLeads(params: Record<string, string | undefined> = {}) {
  return useQuery({ queryKey: ['leads', params], queryFn: () => api.get<{ leads: LeadDTO[] }>(`/leads${qs(params)}`).then((r) => r.leads) });
}

export function useLead(id: string | undefined) {
  return useQuery({
    queryKey: ['lead', id],
    queryFn: () => api.get<{ lead: LeadDTO; tasks: TaskDTO[]; conversationId: string | null; messages: MessageDTO[]; notes: { id: string; body: string; author: string | null; createdAt: string }[] }>(`/leads/${id}`),
    enabled: !!id,
  });
}

export function useConversations(filter: string, q: string) {
  return useQuery({
    queryKey: ['conversations', filter, q],
    queryFn: () => api.get<{ conversations: ConversationDTO[] }>(`/messages/conversations${qs({ filter, q })}`).then((r) => r.conversations),
    refetchInterval: 20_000,
  });
}

export function useConversation(id: string | undefined) {
  return useQuery({
    queryKey: ['conversation', id],
    queryFn: () => api.get<{ conversation: ConversationDTO; messages: MessageDTO[]; upcomingAppointment: { id: string; startAt: string; staffName: string | null; services: string | null } | null }>(`/messages/conversations/${id}`),
    enabled: !!id,
    refetchInterval: 15_000,
  });
}

export function useInventory(params: Record<string, string | undefined>, enabled = true) {
  return useQuery({ queryKey: ['inventory', params], enabled, queryFn: () => api.get<{ requests: InventoryRequestDTO[]; canManage: boolean; seesAll: boolean }>(`/inventory/requests${qs(params)}`) });
}

export function useInventorySuggestions() {
  return useQuery({ queryKey: ['inventory-suggestions'], queryFn: () => api.get<{ collections: string[]; sizes: string[]; colors: string[]; recent: { collection: string; size: string | null; color: string | null }[] }>('/inventory/suggestions'), staleTime: 60_000 });
}

/** Invalidate everything that a change to follow-ups/messages/leads could affect. */
export function useRefreshAll() {
  const qc = useQueryClient();
  return () => {
    for (const k of ['dashboard', 'tasks', 'leads', 'lead', 'client', 'clients', 'conversations', 'conversation', 'appointments', 'integrations', 'updates', 'inventory']) {
      qc.invalidateQueries({ queryKey: [k] });
    }
  };
}

export function useAction<TVars, TRes = unknown>(fn: (v: TVars) => Promise<TRes>) {
  const refresh = useRefreshAll();
  return useMutation({ mutationFn: fn, onSuccess: () => refresh() });
}
