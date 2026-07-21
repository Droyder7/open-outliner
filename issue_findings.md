## Critical Findings

1. **The Yjs schema cannot guarantee atomic moves.**  
   `parentId` and `rank` are described as separate fields, but a move must resolve atomically. Nested Yjs fields could merge the parent from one move with the rank from another; a plain object would overwrite unrelated fields. Yjs also does not automatically provide the documented `(timestamp, replicaId)` semantics.  
   References: `docs/yjs-projection.md:39-44`, `docs/sync-and-conflict-resolution.md:14-17`, `docs/fractional-indexing.md:59-60`

2. **Cycle handling is not a convergent algorithm.**  
   Concurrent valid moves can merge into a cycle. The projector can detect that cycle, but rejecting its SQL projection does not repair authoritative Yjs state. “Normalize or drop” does not specify which edge loses, where the item goes, or who emits the repair.  
   References: `docs/sync-and-conflict-resolution.md:30-45`, `docs/api-and-write-path.md:44-48`, `docs/yjs-projection.md:68-70`

3. **Deletion, undo, and GC are internally inconsistent.**  
   The Yjs schema has no explicit deletion state, while the projector interprets a missing key as deletion and the ADR says undo clears `deleted_at`. A missing key cannot retain the timestamp, content, or subtree needed to rebuild tombstones or perform authoritative undo. Replica acknowledgement required for safe GC is also undefined.  
   References: `docs/yjs-projection.md:39-57`, `docs/sync-and-conflict-resolution.md:72-85`, `docs/adr/0006-soft-delete-and-tombstone-gc.md:20-36`

4. **Durable Yjs persistence is not specified at the catastrophic-loss boundary.**  
   Missing details include update ordering, acknowledgement-before/after-persistence behavior, deduplication, snapshots, compaction, state vectors, corruption detection, and replay. A server could acknowledge an update and lose it during a crash, or unbounded updates could eventually make room loading impractical.  
   References: `docs/architecture-overview.md:37-40`, `docs/yjs-projection.md:46-50`, `docs/yjs-projection.md:74-90`

5. **The materializer can regress or permanently miss projection state.**  
   An older delayed callback can acquire the advisory lock after a newer callback and overwrite rows with stale state. A crash after persisting a Yjs update but before the debounced callback may leave the projection stale indefinitely. The design needs persistent source and projected revisions plus catch-up reconciliation.  
   References: `docs/yjs-projection.md:51-63`, `docs/yjs-projection.md:84-90`

6. **Tenant and viewer boundaries are not enforceable from the documented model.**  
   A single-column `parent_id` foreign key permits cross-document parents, and attachment document/item IDs can disagree. Authorizing a viewer to connect to a Yjs room also does not prevent that viewer from sending updates.  
   References: `docs/data-model.md:61-63`, `docs/attachments.md:24-35`, `docs/security-and-multitenancy.md:16-30`, `docs/security-and-multitenancy.md:34-40`

7. **Field ownership makes projection rebuild unsafe.**  
   Metadata may be API-owned while living in rows the materializer overwrites or rebuilds. Dropping and rebuilding `items` can also null attachment relationships, delete references, or conflict with `documents.root_item_id`. Every field and table needs an explicit canonical owner and rebuild policy.  
   References: `docs/api-and-write-path.md:24-36`, `docs/yjs-projection.md:61-62`, `docs/data-model.md:82-100`

## High Findings

1. **The database does not enforce its stated root and document invariants.**  
   The partial unique index enforces at most one live root, not exactly one. It does not prevent root movement/deletion, and the parent FK does not require parent and child to belong to the same document.  
   References: `docs/data-model.md:24-28`, `docs/data-model.md:61-74`, `docs/data-model.md:110-116`

2. **Two incompatible V1 ordering models are documented.**  
   Some documents specify a CRDT list, while ADR-0005 specifies fractional-rank LWW and defers a full list CRDT to V2. `openSpace` is also undefined and appears to require reranking existing siblings, contradicting the “only one item changes” guarantee.  
   References: `docs/sync-and-conflict-resolution.md:36-40`, `docs/fractional-indexing.md:11-18`, `docs/fractional-indexing.md:57-64`, `docs/roadmap.md:39-40`

3. **Canonical SQL is delegated to a historical artifact.**  
   `docs/README.md` says decided documentation wins, while `data-model.md` calls the research report’s SQL authoritative. The decided documentation should contain the complete current schema.  
   References: `docs/README.md:3-9`, `docs/data-model.md:5-10`, `docs/data-model.md:53-55`

4. **Attachment identity and upload security are contradictory.**  
   Items supposedly retain a stable attachment ID, but the upload flow changes the reference to `s3_key`. Upload finalization also appears to trust client-provided key, MIME, size, and checksum rather than verifying the stored object server-side.  
   References: `docs/attachments.md:13-20`, `docs/attachments.md:38-50`, `docs/attachments.md:59-64`

5. **Authentication and offline revocation behavior are absent.**  
   “Sessions or JWT” is not enough to implement identity, invitation, membership, revocation, CSRF, credential expiry, or WebSocket authentication. There is also no behavior for cached content and queued edits after a user loses access while offline.  
   References: `docs/security-and-multitenancy.md:34-46`, `docs/security-and-multitenancy.md:63-68`, `docs/offline-and-pwa.md:29-40`

6. **The core outliner interaction model is under-specified.**  
   Enter, Backspace, Tab, split/merge, multi-selection, copy/paste, collapse, zoom navigation, drag targets, cross-document moves, focus restoration, and invalid-operation behavior are not defined. These are core product semantics, not implementation details.  
   References: `docs/product-overview.md:44-53`, `docs/roadmap.md:23-27`

7. **Collaboration is a headline feature without a complete user journey.**  
   Invitations, member removal, ownership transfer, viewer capabilities, presence payloads, stale presence, conflict notifications, and sharing privacy are unspecified.  
   References: `docs/product-overview.md:18-20`, `docs/product-overview.md:32-34`, `docs/security-and-multitenancy.md:34-46`

8. **Export is promised but has no contract.**  
   There is no required format, hierarchy/rich-text fidelity, attachment policy, deleted-content policy, offline behavior, deterministic ordering, versioning, or round-trip acceptance test. This weakens the “own your data” principle.  
   References: `docs/product-overview.md:39-40`, `docs/product-overview.md:53`, `docs/roadmap.md:26`

9. **Recovery guidance ignores canonical data outside Yjs.**  
   Restoring Yjs alone would not restore users, memberships, workspace/document metadata, API-owned fields, attachment metadata, or S3 objects. Coordinated backup and restore ordering is required.  
   References: `docs/architecture-overview.md:61-69`, `docs/yjs-projection.md:74-82`, `docs/security-and-multitenancy.md:48-55`

10. **Offline durability assumes browser storage always succeeds.**  
    Quota exhaustion, eviction, private browsing, failed IndexedDB transactions, Background Sync absence, local corruption, and service-worker upgrades are not covered. The current unconditional “every write MUST succeed” promise is not implementable without failure behavior.  
    References: `docs/offline-and-pwa.md:5-6`, `docs/offline-and-pwa.md:24-49`

11. **Accessibility and mobile interaction requirements are missing.**  
    There is no WCAG target, semantic tree pattern, screen-reader behavior, touch alternative to drag, mobile keyboard handling, focus model, or target browser/device matrix.  
    References: `docs/product-overview.md:37-38`, `docs/product-overview.md:46-48`, `docs/roadmap.md:23-27`

12. **V1 acceptance criteria are not measurable.**  
    “Sync cleanly,” “without corruption,” and “responsive” lack workloads, network conditions, browser/device profiles, latency thresholds, and expected conflict outcomes. Important V1 areas such as editor behavior, accessibility, export, sharing, deletion, and recovery have no release gates.  
    References: `docs/product-overview.md:68-73`, `docs/status.md:70-80`

## Status Artifact Issue

`WEB` and `OFF` are currently marked `Ready`, but both still have blocking product and durability decisions. The performance and self-hosting acceptance gates are also `Ready` while their next steps explicitly say the criteria still need definition. Under the file’s own stage definition, these should be `Needs decision`.  
References: `docs/status.md:18-23`, `docs/status.md:54-56`, `docs/status.md:79-80`

## Recommended Resolution Order

1. Supersede or complete the CRDT decisions: item schema, atomic moves, clocks, cycle normalization, deletion, and ordering.
2. Define canonical ownership and persistence: Yjs storage, projection checkpoints, relational schema, rebuild boundaries.
3. Complete security boundaries: auth model, membership schema, viewer enforcement, tenant-qualified constraints.
4. Resolve attachment identity and server-owned upload finalization.
5. Specify core outliner, collaboration, offline-failure, export, accessibility, and mobile behavior.
6. Turn V1 success criteria into measurable release gates.
7. Define coordinated backup, restore, upgrades, observability, and self-hosting operations.

The design direction is viable, but implementation should not begin on structural sync, deletion, materialization, or authorization until the critical items above are resolved.



