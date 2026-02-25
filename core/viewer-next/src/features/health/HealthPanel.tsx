import { StatusPill } from '@/components/StatusPill';
import { useHealthQuery } from './useHealthQuery';

type Props = {
  controlUrl: string;
};

export function HealthPanel({ controlUrl }: Props) {
  const health = useHealthQuery(controlUrl);

  const tone = health.isError ? 'error' : health.data?.ok === false ? 'warn' : health.data ? 'ok' : 'neutral';
  const label = health.isFetching ? 'checking' : health.isError ? 'unreachable' : health.data?.status ?? 'unknown';

  return (
    <section className="card space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-white">Control Plane Health</h2>
        <StatusPill label={label} tone={tone} />
      </div>

      <p className="text-sm text-slate-300">
        Uses TanStack Query polling to keep control-plane health visible while you work.
      </p>

      {health.error ? (
        <p className="rounded-md border border-rose-800 bg-rose-950/40 p-2 text-sm text-rose-200">
          {(health.error as Error).message}
        </p>
      ) : null}

      <button className="button-muted" onClick={() => health.refetch()}>
        Refresh now
      </button>
    </section>
  );
}
