import { useQuery } from '@tanstack/react-query';
import { fetchHealth } from '@/lib/api';

export function useHealthQuery(controlUrl: string) {
  return useQuery({
    queryKey: ['health', controlUrl],
    queryFn: () => fetchHealth(controlUrl),
    enabled: Boolean(controlUrl),
    refetchInterval: 20_000,
  });
}
