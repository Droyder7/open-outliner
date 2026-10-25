# Personal-first self-host validation

Reference run: 2026-10-25, managed Linux workspace, Docker Engine/Compose,
PostgreSQL 17, Node 22.23.4 app image. No supplied user installation was modified.
The isolated Compose project `outliner-pf6` created a new `pgdata` volume, separate
from the prior integration-test PostgreSQL container.

Verified locally:

- App and web images build with frozen pnpm lockfile, pinned base-image digests,
  production-only application dependencies, unprivileged app user, and build-time
  CA secret. No object-store service is present in default Compose.
- All three services start from a clean volume and pass health checks. The app
  applies all seven migrations. The web proxy accepts signup, document creation,
  a schema-v2 Yjs edit, a committed receipt, an identical retry, logout/login and
  raw-state readback. Disabled attachment APIs respond explicitly.
- `scripts/backup.sh` creates a whole-database custom-format dump, manifest and
  checksums at `/workspace/scratch/pf6-text-backup`.
- `scripts/restore-drill.sh` restores into `outliner_restore_pf6`, retaining the
  live `outliner` database. Strict Yjs decoding, boundary and generation checks
  pass: **1 document, 2 Yjs items, 1 receipt**. The exact generated outline text
  is present in both raw Yjs and projected rows.
- Existing restore targets and backup destinations are refused. The original
  deployment stays healthy after the drill. No data volume is deleted.
- All **123 server tests** pass against PostgreSQL and pinned S3rver, including
  persistence races, document isolation, receipt retry, prepared-GC lifecycle,
  compaction, replica gating and attachment object cleanup. No S3 suite is skipped.
- **44 shared, 28 CRDT and 35 client unit tests** pass; workspace type checks,
  production builds and lint pass (12 pre-existing unused-variable warnings).
- All **12 production Chromium browser checks** pass; the 10k outline p95 is
  15.8ms typing, 15.4ms navigation, 41.7ms moves, 15.5ms zoom, with at most 32 rows
  mounted. Includes offline cold boot/reload, quota/auth isolation, reconnect,
  independent-device merging, two-tab continuity and workflow recovery.

The CI workflow repeats these workloads on push/PR; its result is separate from
this local evidence. Production object-provider restore/CORS, HTTPS termination,
mobile/a11y and a real day-long offline soak are not claimed by this run.
Browser checkpoints remain device-local and are not included in a server dump.
