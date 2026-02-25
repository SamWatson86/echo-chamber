import { useQuery } from '@tanstack/react-query';
import { fetchRoomStatus } from '@/lib/api';

export function useRoomStatusQuery(controlUrl: string, adminToken: string | null) {
  return useQuery({
    queryKey: ['room-status', controlUrl, adminToken],
    queryFn: () => fetchRoomStatus(controlUrl, adminToken as string),
    enabled: Boolean(controlUrl && adminToken),
    refetchInterval: 5_000,
  });
}
