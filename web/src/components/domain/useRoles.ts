import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client';

/** Role templates by name, for choosing an announcement's audience. */
export function useUsersRoles() {
  const { data } = useQuery({ queryKey: ['announcement-roles'], queryFn: () => api.get<{ roles: { role: string; label: string }[] }>('/announcements/roles').then((r) => r.roles), staleTime: 300_000 });
  return data ?? [];
}
