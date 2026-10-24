# Open-Outliner architecture review

Review date: 2026-10-25. Code baseline: main at 5b2c69c.

## Product alignment

The owner clarified that personal knowledge management and outlining come first;
live collaboration can wait. The repo currently treats individuals, small teams,
offline editing, and live collaboration as simultaneous first-release requirements.
Those priorities no longer match the owner's stated starting point.

Proposed product definition: a dependable personal outliner that opens existing
notes offline, makes editing and retrieval fast, preserves work through browser
and server failures, and supports trustworthy export, backup, and optional device
sync. Team sharing and presence are later capabilities. The owner rejected choosing between automatic multi-device merge and one-active-
device operation as an inadequate framing. The recommendation is therefore
product-led: device continuity should be background infrastructure, with local
editing, safe reconciliation, and recoverable history, independent of whether
team collaboration ships. This is a proposal, not an accepted product decision.

For this use case, search, document navigation, editing ergonomics, recovery, and
simple operation deserve priority over replica ledgers and automatic hard deletion.
Plain text may be a reasonable deliberate first release. Rich text should be a
product choice rather than being permanently ruled out by an early schema.

## Revised candidate use case

An outline-first personal thinking workspace: capture quickly, develop ideas by
nesting and rearranging blocks, find relevant material, resume across devices,
and recover earlier work. Keep four jobs central: capture, develop, retrieve,
and trust. A generic workspace/platform or maximal Workflowy feature parity is
not the first-release objective.

A concrete daily journey is capturing a fragment on a phone, developing it into
an outline on a laptop, finding it by text or title later, and recovering an
accidentally removed section. The person does not select a sync mode or track
which device last edited. Offline changes remain local until synchronization is
possible. Conflicting placement intentions cannot both occupy one tree position;
choose a documented outcome while retaining recoverable history. Background sync
and backup are distinct promises.

Use stable block identity, a tree as the primary view, document navigation, and
local search. Links/backlinks can extend retrieval later; mirrors, graph views,
boards, arbitrary databases, and AI workflows are not prerequisites. Do not
change the whole data model to a graph before a concrete workflow requires it.

## What is built

- React/Vite client, direct contenteditable-to-Y.Text binding.
- One Y.Doc per document, cached with y-indexeddb.
- Hocuspocus WebSocket rooms and cookie/session authentication.
- PostgreSQL storage for Yjs state and a derived items projection.
- SQL/RPC for identities, workspaces, metadata, queries, export, attachments.
- Snapshot compaction, tombstone GC, replica liveness/ack ledger, cycle repair.
- S3-compatible attachment storage and a separate HTTP-mutation outbox.

A useful coarse architecture is present: local working state, optional sync,
server persistence, and a derived read model. The implementation is a modular
application with several background jobs, not a reason to introduce microservices.
PostgreSQL itself is not an architectural mistake. React and TypeScript are also
reasonable choices; changing them would not solve the substantive problems.

## Confirmed findings

### 1. Compaction can discard committed data — release blocker

`packages/server/src/jobs/compaction.ts` reads updates, constructs a snapshot,
then deletes every update row for that document. `storeUpdate` in
`crdt/yjs-store.ts` does not acquire the advisory lock held by compaction.

A deterministic interleaving inserted and committed a new child update after
compaction's SELECT and before its DELETE. Reloading after compaction lacked the
child. The test used a disposable local PostgreSQL database; it did not edit a
real user's data.

Required invariant: truncation may delete only updates represented by the
committed snapshot, while preserving every concurrent append. Bound truncation
by an explicit high-water mark or serialize writers consistently. Snapshot
publication must also keep source/projection revision semantics correct.

### 2. Projection can falsely declare an old snapshot current — release blocker

`crdt/projector.ts` loads a document outside its lock, then reads the latest
source revision inside the lock and assigns that revision to the loaded state.
The state has no associated revision token.

A deterministic probe appended a child after the snapshot load. The child was
in durable Yjs state but absent from items, with source_rev == projected_rev.
A subsequent sweep did not repair that document because the revision guard
considered it up to date.

Required invariant: a projection can advance only to the revision represented
by its input snapshot. Read state plus its token consistently, then validate or
retry against that token under the lock.

### 3. Document identity is not enforced by the projection upsert — release blocker

The batch upsert in `db/items-repo.ts` conflicts on globally unique item id and
updates fields without restricting the existing row to the incoming document.
Room membership checks do not make client-controlled item ids trustworthy.

A probe created documents belonging to different fixture owners, placed the
other document's root item id in the source Y.Doc, and projected it. The target
row's content changed while its original document_id remained unchanged.

This demonstrates a document-isolation defect in the persistence path, rather
than merely a potential random UUID collision. Require explicit ownership
validation and safe conflict handling; add adversarial cross-document tests.

### 4. The connected app cannot reliably cold-start offline

`auth/AuthGate.tsx` requires WhoAmI and treats network errors as unauthenticated.
`App.tsx` then requires ListDocuments before opening a synced editing session.
Cached Yjs state therefore does not by itself make the connected product usable
on an offline reload. Local-only mode is a separate deployment configuration.

Open cached documents through a local catalog before connecting. Distinguish
network unavailability from explicit session rejection. Specify account-scoped
cache behavior, logout, and eventual access-revocation handling.

### 5. Stored HLC values do not arbitrate concurrent moves

`crdt/yjs-node.ts` replaces a move value in an ordinary Y.Map. The HLC is payload;
there is no merge-time HLC comparison on this path. The same distinction applies
to the deletion register.

A two-replica probe gave replica A a move HLC of wallMs=1000 and replica B a move
HLC of wallMs=10. Both merged to B's move with fixed Yjs client ids 10 and 20.
Convergence occurred, but the documented higher-HLC-wins rule did not.

Choose native Yjs conflict semantics and document their user-visible result, or
implement and prove a register/tree algorithm that actually enforces the chosen
rule. Tree validity and deterministic repair require their own proof; convergence
of the underlying CRDT alone is insufficient. Cycle repair currently lives in
the server projection path, not in the offline client tree traversal.

### 6. Durable server acknowledgement is not established by the chosen hook

Installed Hocuspocus 2.15.3 invokes the document-update callback and broadcasts
updates without awaiting its async persistence path. Persistence uses debounced
onStoreDocument hooks (defaults 2s, maximum debounce 10s). The Database extension
encodes full document state for its store callback.

Therefore comments describing ordinary edit handling as persist-before-peer-ack
are stronger than the implementation establishes. This is source/dependency
inspection, not a completed server-crash experiment. Clients may retain and
recover edits locally, but seeing an edit on another client or reaching initial
sync must not be presented as proof of a durable server commit.

Define separate local-durable, connected, synchronized, and server-durable states.
Use explicit persistence acknowledgements if the product promises the latter.

### 7. Notes have conflicting authorities

Yjs schema docs assign note to Y.Text, while UpdateItem can write SQL note
through updateItemMetadata. The materializer subsequently writes note from Yjs.
A probe wrote an API note and then projected a later CRDT edit; SQL note became
NULL. Keep every editable field in one authoritative write path. SQL remains
authoritative for identities/permissions/bookkeeping, not a competing copy of
editable outline data.

### 8. The client hot path scales poorly

getChildren scans all nodes and rebuilds a map on every call. flattenVisible
calls getChildren recursively, including for leaves. Outliner listens to all
transactions and recomputes visible order during keyboard handling.

A shallow-tree Node model probe measured approximately 341ms for 1,000 leaves
and 1,364ms for 2,000 leaves. These are illustrative single-run measurements,
not browser benchmarks; they show why the 10k server projection gate does not
establish responsive typing/navigation.

Maintain an incrementally updated parent-to-children index and visible-row model,
minimize transaction-wide rerenders, and virtualize large visible lists. Define
browser typing, caret, zoom, scroll, and cold-start budgets independently of SQL.

## Recommended direction

Keep the current useful components while changing priorities and simplifying
boundaries. A local-first personal client should own the document catalog,
outline data, local search, and recovery. Authentication and networking should
not gate opening already-authorized cached personal documents. One consistent
sync mechanism should carry document-owned fields. Keep server persistence and
backups behind a small optional backend. Treat the SQL item projection as a
rebuildable read model, not a prerequisite for every personal workflow.

Do not remove PostgreSQL immediately: it also holds accounts, permissions,
metadata, and other authoritative rows. First clarify field ownership and fix
durability. Likewise, replacing IndexedDB with browser SQLite is not a sufficient
fix for offline boot, ordering semantics, projection races, or data-loss bugs.

For now retain tombstones conservatively. Automatic physical GC is a storage
optimization with offline-replica consequences, not a prerequisite for a good
personal outliner. Do not disable compaction without a bounded replacement:
update-log growth and logical tombstone cleanup are different concerns. Any
future purge must specify how old device replicas rebootstrap safely.

Make S3 optional for a text-first release. Keep invitations, presence, fine-grained
sharing, mirrors, boards/tables, and multi-server operation out of the first
personal release unless explicitly reprioritized.

## Alternatives

1. Local-first client plus Yjs device sync: recommended if concurrent offline
   changes on personal devices must merge automatically. Reuse the existing work,
   but repair semantics, durability, indexing, and app bootstrap.
2. Local-first client plus versioned snapshot/file sync: viable if one active
   editing device is acceptable. Use conditional writes, retain history and
   conflicting copies, and offer recovery; never silently overwrite a conflict.
3. Server-authoritative application with an offline cache: appropriate only if
   always-available offline editing is no longer a core promise.

No particular replacement framework is endorsed by this review. A migration to
another local-first engine would require a bounded prototype proving the actual
outline operations and offline/recovery behavior, plus explicit migration costs.

## Order of work and acceptance

1. Agree on personal-first product scope and cross-device conflict expectations.
2. Fix compaction data loss, document isolation, and projection revision binding;
   add deterministic interleaving and cross-document regression tests.
3. Prove connected-product offline boot/reload using real browser tests; include
   network loss, session expiry, quota exhaustion, account switching, and restart.
4. Decide and test actual tree-move/delete/undo semantics, including offline cycles.
5. Improve the client tree index and rendering; measure real 10k-item browser use.
6. Ship navigation, local search, export/import, version recovery, and backups.
7. Restore a supported self-host storage dependency and test backup/restore before
   a reliability claim. Then reassess whether further collaboration work is needed.

Current passing tests are useful but not proof of these stronger properties:
most integration tests call the store directly, the performance gate measures
server move/projection rather than browser interaction, and selected interleavings
are not covered. The recent GC and heartbeat fixes address narrower issues and
do not establish that the surrounding persistence architecture is correct.

## Scope and evidence

No tracked source files or remote repositories were modified during this review.
Scratch probes and fixtures ran against a temporary local database. Reproduction
sources are saved alongside this review in architecture-probes.mts and
architecture-extra-probes.mts. Findings distinguish executed probes, direct code
inspection, and untested broader reliability concerns.
