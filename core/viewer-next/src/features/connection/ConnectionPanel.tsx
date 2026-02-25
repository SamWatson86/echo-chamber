import type { ActorRefFrom, SnapshotFrom } from 'xstate';
import { useMemo } from 'react';
import { StatusPill } from '@/components/StatusPill';
import { connectionMachine } from './connectionMachine';
import { useViewerPrefsStore } from '@/stores/viewerPrefsStore';

type Props = {
  snapshot: SnapshotFrom<typeof connectionMachine>;
  actorRef: ActorRefFrom<typeof connectionMachine>;
};

export function ConnectionPanel({ snapshot, actorRef }: Props) {
  const {
    controlUrl,
    sfuUrl,
    room,
    name,
    identity,
    adminPassword,
    setField,
  } = useViewerPrefsStore();

  const status = useMemo(() => {
    if (snapshot.matches('connected')) {
      return { label: 'connected', tone: 'ok' as const };
    }
    if (snapshot.matches('provisioning')) {
      return { label: 'connecting', tone: 'warn' as const };
    }
    if (snapshot.matches('failed')) {
      return { label: 'failed', tone: 'error' as const };
    }
    return { label: 'idle', tone: 'neutral' as const };
  }, [snapshot]);

  const onConnect = () => {
    actorRef.send({
      type: 'CONNECT',
      request: {
        controlUrl: controlUrl.trim(),
        sfuUrl: sfuUrl.trim(),
        room: room.trim() || 'main',
        name: name.trim() || 'Viewer',
        identity: identity.trim(),
        adminPassword,
      },
    });
  };

  return (
    <section className="card space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-white">Connection</h2>
        <StatusPill label={status.label} tone={status.tone} />
      </div>

      <div className="grid gap-3 md:grid-cols-2">
        <label>
          <span className="label">Control URL</span>
          <input className="input" value={controlUrl} onChange={(e) => setField('controlUrl', e.target.value)} />
        </label>

        <label>
          <span className="label">SFU URL</span>
          <input className="input" value={sfuUrl} onChange={(e) => setField('sfuUrl', e.target.value)} />
        </label>

        <label>
          <span className="label">Room</span>
          <input className="input" value={room} onChange={(e) => setField('room', e.target.value)} />
        </label>

        <label>
          <span className="label">Name</span>
          <input className="input" value={name} onChange={(e) => setField('name', e.target.value)} />
        </label>

        <label>
          <span className="label">Identity (optional)</span>
          <input className="input" value={identity} onChange={(e) => setField('identity', e.target.value)} />
        </label>

        <label>
          <span className="label">Admin Password</span>
          <input
            className="input"
            type="password"
            value={adminPassword}
            onChange={(e) => setField('adminPassword', e.target.value)}
          />
        </label>
      </div>

      {snapshot.context.lastError ? (
        <p className="rounded-md border border-rose-800 bg-rose-950/40 p-2 text-sm text-rose-200">{snapshot.context.lastError}</p>
      ) : null}

      <div className="flex gap-2">
        <button className="button-primary" onClick={onConnect} disabled={snapshot.matches('provisioning')}>
          {snapshot.matches('connected') ? 'Reconnect' : 'Connect'}
        </button>
        <button
          className="button-muted"
          onClick={() => actorRef.send({ type: 'DISCONNECT' })}
          disabled={!snapshot.matches('connected') && !snapshot.matches('provisioning')}
        >
          Disconnect
        </button>
        {snapshot.matches('failed') ? (
          <button className="button-muted" onClick={() => actorRef.send({ type: 'RETRY' })}>
            Retry
          </button>
        ) : null}
      </div>

      {snapshot.context.session ? (
        <div className="rounded-md border border-slate-800 bg-slate-950/50 p-3 text-xs text-slate-300">
          <div>Identity: {snapshot.context.session.identity}</div>
          <div>Connected at: {new Date(snapshot.context.session.connectedAt).toLocaleString()}</div>
        </div>
      ) : null}
    </section>
  );
}
