import type {
  connectedPayload,
  onStatelessPayload,
  onDisconnectPayload,
} from '@hocuspocus/server';
import { REPLICA_SYNCED_PAYLOAD } from '@open-outliner/shared';
import type { Db } from '../db/db.js';
import { touchReplica } from '../db/replica-sync-repo.js';
import type { ConnectionRegistry } from './connections.js';

/**
 * The ADR-0019 replica-sync-ack ledger side of the Hocuspocus lifecycle hooks,
 * extracted from `server.ts` so the wiring is unit-testable without a live
 * Hocuspocus server or a database (replica-hooks.test.ts drives them with a
 * fake `Db` and the real connection registry).
 *
 * Contract (ADR-0019): `connected` registers the socket and writes a BLOCKING
 * ledger row (`last_synced_at` stays NULL) before the first sync is served, so
 * GC is gated for the whole connect→sync-complete window. `onStateless`
 * persists the client's `replica.synced` acknowledgement immediately. The
 * disconnect touch either refreshes `last_synced_at` (the replica completed
 * its initial sync and received everything up to that moment) or leaves it
 * NULL (a never-synced replica may hold pre-tombstone state and must keep
 * blocking). Every ledger write is best-effort: a failed write logs but never
 * kills or otherwise disrupts the connection.
 */
export interface ReplicaHooks {
  /** `connected` — register the socket and write a blocking row before any sync is served. */
  connected(data: connectedPayload): Promise<void>;
  /** `onStateless` — persist the client's `replica.synced` ack immediately. */
  onStateless(data: onStatelessPayload): Promise<void>;
  /** `onDisconnect` — refresh-or-block the ledger row for the departing replica. */
  onDisconnect(data: onDisconnectPayload): Promise<void>;
}

export interface ReplicaHooksDeps {
  db: Db;
  connections: ConnectionRegistry;
  log?: (msg: string) => void;
}

export function createReplicaHooks(deps: ReplicaHooksDeps): ReplicaHooks {
  const { db, connections } = deps;
  const log = deps.log ?? (() => {});

  return {
    async connected(data) {
      const sessionId = (data.context as { sessionId?: string } | undefined)?.sessionId;
      if (!sessionId) return;
      const replicaId = data.requestParameters.get('replicaId') ?? undefined;
      connections.register(
        data.socketId,
        sessionId,
        data.documentName,
        replicaId,
        data.connectionInstance,
      );
      if (replicaId) {
        // Write the ledger row BEFORE the first sync is served: `last_synced_at`
        // stays NULL until this replica acks, which blocks GC for the whole
        // connect→sync-complete window (ADR-0019). Best-effort — a failed
        // ledger write must not kill the connection.
        try {
          await touchReplica(
            db,
            { documentId: data.documentName, replicaId, synced: false },
            new Date(),
          );
        } catch (err) {
          log(
            `replica ledger write failed on connect for ${data.documentName}/${replicaId}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
    },

    async onStateless(data) {
      // ADR-0019 stateless ack: the client completed its initial sync, so it has
      // received every tombstone broadcast up to this point. Persist it
      // immediately rather than waiting for the next heartbeat tick.
      if (data.payload !== REPLICA_SYNCED_PAYLOAD) return;
      const entry = connections.markSynced(data.connection.socketId);
      if (entry?.replicaId) {
        try {
          await touchReplica(
            db,
            { documentId: entry.documentName, replicaId: entry.replicaId, synced: true },
            new Date(),
          );
        } catch (err) {
          log(
            `replica ack persist failed for ${entry.documentName}/${entry.replicaId}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
    },

    async onDisconnect(data) {
      const entry = connections.unregister(data.socketId);
      if (entry?.replicaId) {
        // Disconnect refresh: a connection that had completed its initial sync
        // received everything up to now, so record that before it goes away. A
        // never-synced disconnect deliberately leaves `last_synced_at` NULL — it
        // may hold pre-tombstone state and must keep blocking GC (ADR-0019).
        try {
          await touchReplica(
            db,
            {
              documentId: entry.documentName,
              replicaId: entry.replicaId,
              synced: entry.synced,
            },
            new Date(),
          );
        } catch (err) {
          log(
            `replica ledger write failed on disconnect for ${entry.documentName}/${entry.replicaId}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
    },
  };
}
