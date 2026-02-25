import { useQuery } from '@tanstack/react-query';
import { fetchOnlineUsers } from '@/lib/api';

export function useOnlineUsersQuery(controlUrl: string) {
  return useQuery({
    queryKey: ['online-users', controlUrl],
    queryFn: () => fetchOnlineUsers(controlUrl),
    enabled: Boolean(controlUrl),
    refetchInterval: 10_000,
  });
}
