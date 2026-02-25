import { useQuery } from '@tanstack/react-query';
import { fetchRooms } from '@/lib/api';

export function useRoomsQuery(controlUrl: string, adminToken: string | null) {
  return useQuery({
    queryKey: ['rooms', controlUrl, adminToken],
    queryFn: () => fetchRooms(controlUrl, adminToken as string),
    enabled: Boolean(controlUrl && adminToken),
    refetchInterval: 10_000,
  });
}
