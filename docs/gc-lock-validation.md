# GC lock isolation validation — issue #4

Validated locally on 2026-10-25 with Node 24.19.0 and PostgreSQL 17 (Alpine).

## Correctness

The full server suite passes: **114 tests across 18 files**, including 15 new GC
lifecycle cases. Real PostgreSQL was used. Attachment cleanup tests used
**S3rver 3.7.1**, an S3-compatible local test server: the MinIO images on Docker Hub
and Quay rejected pulls, and the pinned public binary download returned HTTP 410.
This run therefore does not establish compatibility with a current MinIO release.

The lifecycle tests verify:

- Cold replay can pause while a separate database connection acquires the same
  advisory lock; removal holds that lock; release runs after it is available again.
- Preparation loads the document once. Removal does not replay history.
- Key deletion is durable before release, and re-projection does not restore it.
- A retained live room survives its last other direct connection disconnecting.
- Joining/unsynced clients and changed retention, leaf, or replica-ack eligibility
  prevent deletion after preparation.
- Preparation, persistence, transaction, and cleanup failures preserve the
  appropriate relational state, release handles, and log errors.
- Compaction can run during preparation without invalidating the retained room.
- Documents are processed sequentially and overlapping worker runs are skipped.

## Lock-duration comparison

Compared the previous implementation at `ab4df53` against the prepared-room path.
Each sample used a fresh cold document with **10,000 leaf items plus its root**,
one eligible tombstoned leaf, and 102 stored updates (root, 100 incremental item
batches, and deletion). Compaction was not run during measurements.

The legacy worker used its original cold-store removal helper. The new worker
used the production Hocuspocus preparation handle. Each used batch size 100 and
zero retention for the fixture. Three interleaved samples were taken per path.
These are single-environment observations, not a CI timing threshold.

Lock-body duration was measured from completion of the target document's
`pg_advisory_xact_lock` query until its transaction callback returned. It excludes
lock acquisition wait and COMMIT overhead. Total duration covers `worker.run()`,
including preparation and release, but excludes fixture creation and cleanup.

| Sample | Legacy lock body | Prepared lock body | Legacy total pass | Prepared total pass |
|---|---:|---:|---:|---:|
| 1 | 165.00 ms | 17.37 ms | 209.26 ms | 446.86 ms |
| 2 | 153.91 ms | 11.10 ms | 172.95 ms | 352.24 ms |
| 3 | 154.93 ms | 18.54 ms | 205.28 ms | 371.09 ms |
| Median | **154.93 ms** | **17.37 ms** | **205.28 ms** | **371.09 ms** |

The median measured lock body was about **89% shorter**. Total cold-pass time
increased because preparation and disconnect perform additional room lifecycle
work outside the lock. The acceptance criterion is removal of history replay
from the locked section, verified independently by the lifecycle tests.

## CI environment limitation

[CI run 40130543072](https://github.com/Droyder7/open-outliner/actions/runs/40130543072)
for the preceding fixes at `ab4df53` failed during service startup: both
Integration Tests and Self-Host Smoke Test could not pull `minio/minio:latest`.
This happens before the integration tests execute. The workflow and Compose
image dependency remain unchanged by the GC fix; MinIO-backed CI and the
self-host smoke gate remain pending restoration of that dependency.
