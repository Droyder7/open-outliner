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
 * Contract (ADR-0019): `connected` registers the socket synchronously (first
 * statement, before any await — the GC live-connection gate relies on this)
 * and writes a BLOCKING ledger touch (`last_synced_at` stays NULL on a
 * first-ever connect; a reconnect keeps its prior, still-gating value via the
 * monotonic upsert). Hocuspocus serves the queued initial sync just before
 * invoking `connected` unawaited, so the durable guarantee for the
 * connect→sync-complete window is the in-process registry plus the replica's
 * persisted row from previous sessions — see ADR-0019 "residual race".
 * `onStateless` persists the client's `replica.synced` acknowledgement
 * immediately. The disconnect touch either refreshes `last_synced_at` (the
 * replica completed its initial sync and received everything up to that
 * moment) or leaves it NULL (a never-synced replica may hold pre-tombstone
 * state and must keep blocking). The `replicaId` parameter is untrusted and
 * validated (UUID) — anything else is treated as a legacy client. Every
 * ledger write is best-effort: a failed write logs but never kills or
 * otherwise disrupts the connection.
 */
export interface ReplicaHooks {
  /** `connected` — register the socket (synchronously) and write a blocking ledger touch. */
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

/**
 * The client mints replica ids with `crypto.randomUUID()` (replica-id.ts), so a
 * well-formed id is always a 36-char UUID. Anything else is not a ledger key we
 * issued — a hostile or buggy client probing the ledger — and is treated as a
 * legacy client (registered, but never written to `replica_sync`): an
 * unvalidated parameter must not become an unbounded TEXT key that blocks GC or
 * bloats the ledger (ADR-0019 accepted-downside bound).
 */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isValidReplicaId(replicaId: string | undefined): replicaId is string {
  return replicaId !== undefined && replicaId.length === 36 && UUID_RE.test(replicaId);
}

export function createReplicaHooks(deps: ReplicaHooksDeps): ReplicaHooks {
  const { db, connections } = deps;
  const log = deps.log ?? (() => {});

  return {
    async connected(data) {
      const sessionId = (data.context as { sessionId?: string } | undefined)?.sessionId;
      if (!sessionId) return;
      const raw = data.requestParameters.get('replicaId') ?? undefined;
      const replicaId = isValidReplicaId(raw) ? raw : undefined;
      connections.register(
        data.socketId,
        sessionId,
        data.documentName,
        replicaId,
        data.connectionInstance,
      );
      if (replicaId) {
        // Blocking touch on connect: on a first-ever connect this inserts a
        // row with `last_synced_at` NULL (blocks GC until this replica acks);
        // on a reconnect the monotonic GREATEST upsert keeps the prior value,
        // which still gates every tombstone newer than that ack (ADR-0019).
        // Best-effort — a failed ledger write must not kill the connection.
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
