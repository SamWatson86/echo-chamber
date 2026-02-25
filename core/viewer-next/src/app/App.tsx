import { useActorRef, useSelector } from '@xstate/react';
import { connectionMachine } from '@/features/connection/connectionMachine';
import { ConnectionPanel } from '@/features/connection/ConnectionPanel';
import { HealthPanel } from '@/features/health/HealthPanel';
import { RoomsPanel } from '@/features/connection/RoomsPanel';
import { useViewerPrefsStore } from '@/stores/viewerPrefsStore';

export function App() {
  const actorRef = useActorRef(connectionMachine);
  const snapshot = useSelector(actorRef, (state) => state);

  const controlUrl = useViewerPrefsStore((s) => s.controlUrl);
  const adminToken = snapshot.context.session?.adminToken ?? null;

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-6xl flex-col gap-4 p-4 md:p-6">
      <header className="card space-y-2">
        <p className="text-xs uppercase tracking-[0.2em] text-indigo-300">Viewer Next (React + TS)</p>
        <h1 className="text-2xl font-bold text-white">Echo Chamber Frontend Refactor</h1>
        <p className="text-sm text-slate-300">
          Foundation migration: React + Tailwind + XState + Zustand + TanStack Query, with Vitest and Playwright ready.
        </p>
      </header>

      <section className="grid gap-4 lg:grid-cols-2">
        <ConnectionPanel snapshot={snapshot} actorRef={actorRef} />
        <HealthPanel controlUrl={controlUrl} />
      </section>

      <section>
        <RoomsPanel controlUrl={controlUrl} adminToken={adminToken} />
      </section>
    </main>
  );
}
