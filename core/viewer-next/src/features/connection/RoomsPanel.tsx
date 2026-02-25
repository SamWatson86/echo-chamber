import { useRoomsQuery } from './useRoomsQuery';

type Props = {
  controlUrl: string;
  adminToken: string | null;
};

export function RoomsPanel({ controlUrl, adminToken }: Props) {
  const roomsQuery = useRoomsQuery(controlUrl, adminToken);

  return (
    <section className="card space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-white">Rooms</h2>
        <button className="button-muted" onClick={() => roomsQuery.refetch()} disabled={roomsQuery.isFetching || !adminToken}>
          Refresh
        </button>
      </div>

      {!adminToken ? (
        <p className="text-sm text-slate-400">Connect first to list active rooms.</p>
      ) : null}

      {roomsQuery.isLoading ? <p className="text-sm text-slate-400">Loading rooms…</p> : null}

      {roomsQuery.error ? (
        <p className="rounded-md border border-rose-800 bg-rose-950/40 p-2 text-sm text-rose-200">
          {(roomsQuery.error as Error).message}
        </p>
      ) : null}

      {roomsQuery.data?.length ? (
        <ul className="space-y-2">
          {roomsQuery.data.map((room) => (
            <li key={room.room_id} className="rounded-md border border-slate-800 bg-slate-950/60 p-2 text-sm">
              <div className="font-medium text-slate-100">{room.room_id}</div>
              <div className="text-xs text-slate-400">Participants: {room.participant_count ?? 0}</div>
            </li>
          ))}
        </ul>
      ) : null}

      {adminToken && roomsQuery.data?.length === 0 && !roomsQuery.isLoading ? (
        <p className="text-sm text-slate-400">No active rooms reported.</p>
      ) : null}
    </section>
  );
}
