import { assign, fromPromise, setup } from 'xstate';
import { buildIdentity } from '@/lib/identity';
import { ensureRoomExists, fetchAdminToken, fetchRoomToken } from '@/lib/api';

export type ConnectionRequest = {
  controlUrl: string;
  sfuUrl: string;
  room: string;
  name: string;
  identity?: string;
  adminPassword: string;
};

export type ConnectionSession = {
  adminToken: string;
  roomToken: string;
  identity: string;
  connectedAt: string;
  request: ConnectionRequest;
};

type Context = {
  lastRequest: ConnectionRequest | null;
  session: ConnectionSession | null;
  lastError: string | null;
};

type ConnectEvent = { type: 'CONNECT'; request: ConnectionRequest };
type DisconnectEvent = { type: 'DISCONNECT' };
type RetryEvent = { type: 'RETRY' };

type Events = ConnectEvent | DisconnectEvent | RetryEvent;

const machine = setup({
  types: {
    context: {} as Context,
    events: {} as Events,
  },
  actors: {
    provisionSession: fromPromise(async ({ input }: { input: ConnectionRequest }): Promise<ConnectionSession> => {
      const identity = input.identity?.trim() || buildIdentity(input.name);
      const adminToken = await fetchAdminToken(input.controlUrl, input.adminPassword);
      await ensureRoomExists(input.controlUrl, adminToken, input.room);
      const roomToken = await fetchRoomToken({
        baseUrl: input.controlUrl,
        adminToken,
        room: input.room,
        identity,
        name: input.name,
      });

      return {
        adminToken,
        roomToken,
        identity,
        connectedAt: new Date().toISOString(),
        request: {
          ...input,
          identity,
        },
      };
    }),
  },
}).createMachine({
  id: 'viewerConnection',
  initial: 'idle',
  context: {
    lastRequest: null,
    session: null,
    lastError: null,
  },
  states: {
    idle: {
      on: {
        CONNECT: {
          target: 'provisioning',
          actions: assign({
            lastRequest: ({ event }) => event.request,
            lastError: () => null,
          }),
        },
      },
    },
    provisioning: {
      invoke: {
        id: 'provisionSession',
        src: 'provisionSession',
        input: ({ context }) => {
          if (!context.lastRequest) {
            throw new Error('No connection request provided');
          }
          return context.lastRequest;
        },
        onDone: {
          target: 'connected',
          actions: assign({
            session: ({ event }) => event.output,
            lastError: () => null,
          }),
        },
        onError: {
          target: 'failed',
          actions: assign({
            session: () => null,
            lastError: ({ event }) => String(event.error),
          }),
        },
      },
      on: {
        CONNECT: {
          target: 'provisioning',
          reenter: true,
          actions: assign({
            lastRequest: ({ event }) => event.request,
            lastError: () => null,
          }),
        },
        DISCONNECT: {
          target: 'idle',
          actions: assign({ session: () => null }),
        },
      },
    },
    connected: {
      on: {
        DISCONNECT: {
          target: 'idle',
          actions: assign({ session: () => null }),
        },
        CONNECT: {
          target: 'provisioning',
          actions: assign({
            lastRequest: ({ event }) => event.request,
            lastError: () => null,
          }),
        },
      },
    },
    failed: {
      on: {
        RETRY: {
          guard: ({ context }) => Boolean(context.lastRequest),
          target: 'provisioning',
        },
        CONNECT: {
          target: 'provisioning',
          actions: assign({
            lastRequest: ({ event }) => event.request,
            lastError: () => null,
          }),
        },
      },
    },
  },
});

export const connectionMachine = machine;
