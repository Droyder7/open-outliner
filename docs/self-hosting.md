# Self-hosting and recovery

Current personal-first contract (ADR-0026). The default installation has three
services: nginx serves the PWA and proxies `/rpc`; the Node app persists Yjs
updates, projects them, and compacts history; PostgreSQL owns the update log,
identity, receipts, projections and session state. Text, notes, search, trash and
exports do not need object storage. Automatic physical GC is off.

## Start

Docker Engine and Compose v2 are required on Linux. Backup scripts also use
Bash, Python 3, tar and sha256sum. Copy `.env.example` to `.env`, replace
`POSTGRES_PASSWORD` with a URL-safe value (for example `openssl rand -hex 24`),
then run:

```sh
docker compose build app web
docker compose up -d --wait --wait-timeout 120
```

Open `http://localhost:8080`. Capture can begin locally; sign in for server sync.
Local-only documents stay in that local library; export/import transfers them to
an account library. Save status distinguishes local storage from server commit.

Ports bind to loopback by default. For another device, terminate HTTPS at a
reverse proxy in front of web and configure `WEB_BIND` appropriately. Browsers
require HTTPS (or localhost) for the PWA, service workers and UUID APIs. Proxy
`/rpc` and `/health` through web; `/collaboration` is retained for the existing
collaboration adapter. Personal sync uses committed HTTP batches.

Images are pinned to digests in Compose/Dockerfiles. PostgreSQL uses version 17.
**Do not mount an existing PostgreSQL 16 data volume into 17.** Keep the old
installation available, export using its server, and restore into a separate 17
volume before switching. The application migrations do not upgrade PostgreSQL.

Builds behind a managed proxy use Docker's configured proxy defaults. Set
`CODEX_PROXY_CERT` to its CA file if required; the BuildKit secret is mounted only
in dependency-install steps, never copied into runtime images. Normal Linux
hosts default to their public system CA bundle. TLS verification stays enabled.
The application image runs as the unprivileged Node user with production deps.

## Optional attachments

There is no bundled MinIO service or dependency on its unavailable mutable image.
Choose and operate an S3-compatible provider separately, create the bucket, and
set `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY_ID` and
`S3_SECRET_ACCESS_KEY` in `.env`. The endpoint must be reachable from both app
and browsers using presigned URLs; configure bucket CORS for the web origin.
A partial endpoint/credentials configuration fails startup explicitly.

Attachment APIs remain optional and return "not configured" when disabled.
The current personal UI is text-first; attachment capture UI is deferred. CI uses
pinned `s3rver@3.7.1` as a development emulator for object cleanup regressions;
it is not a recommended production storage service. A selected production
provider still needs its own upload/download/CORS and operational validation.

## Scheduled backups

Run from the checkout with the same Compose project and `.env` as the deployment:

```sh
scripts/backup.sh /srv/outliner-backups/2026-10-25
```

Use a new destination each time. The script writes a custom-format whole-database
`pg_dump`, manifest and SHA-256 checksums into a private partial directory, then
renames it on success. Existing destinations are refused. Failed partials remain
for diagnosis and are never reported as complete. A PostgreSQL MVCC dump is
consistent while text editing continues. It includes all authoritative tables,
including receipts, replica ledger, tenancy and sessions, as well as projections.

Example daily cron entry (adjust checkout and destination):

```cron
15 3 * * * cd /srv/open-outliner && scripts/backup.sh /srv/outliner-backups/$(date -u +\%Y-\%m-\%d_\%H\%M\%S) >> /srv/outliner-backup.log 2>&1
```

Keep a second copy off the application host, restrict backup access like database
access, and choose retention based on your recovery needs. These scripts do not
automatically prune backups, browser checkpoints, or trash. Browser-only pending
work and device-local checkpoints require client exports too; server backups
cannot include work that has not reached the server.

With S3 enabled or uploaded attachment metadata present, the script refuses to
claim a text-only backup.
Stop app and other bucket writers, mirror the bucket with your provider's tool
into a local directory preserving object keys, then run:

```sh
docker compose stop app
# Mirror the quiesced bucket into /srv/outliner-blob-mirror first.
BLOB_BACKUP_DIR=/srv/outliner-blob-mirror scripts/backup.sh /srv/outliner-backups/with-blobs
docker compose up -d app
```

The script verifies every referenced object is in the mirror and packages it
alongside the database. Quiesce direct presigned-upload writers as well; stopping
app alone does not revoke an already-issued URL. Retain the original database
and bucket until the complete restore is validated.

## Isolated restore drill

```sh
scripts/restore-drill.sh /srv/outliner-backups/2026-10-25 outliner_restore_drill
```

This validates checksums, creates a **new** `outliner_restore_*` database, runs
`pg_restore --exit-on-error`, and starts a one-off verifier using the app image.
An existing target is refused. The verifier checks document boundaries, revision
ordering, and strict decoding of every stored Yjs document. No live database is
dropped or replaced. The isolated database remains for inspection.

The acceptance smoke script additionally creates a known outline through the web
proxy, receives a committed batch receipt, retries it, logs out and in, and reads
the content back. Supplying `RESTORE_DOCUMENT_ID` and `RESTORE_EXPECT_TEXT` to the
drill verifies that exact content in both restored raw Yjs and projected rows.
CI runs this against a clean Compose volume on every main push and PR.

For an attachment bundle, restore `blobs.tar` into a **separate** bucket and
verify downloads against restored metadata before serving attachment traffic.
Checksum validation alone is not a production object-store restore drill.

Promotion of a verified restore is an explicit maintenance operation: stop app
and web, disconnect all DB clients, preserve the current database under another
name, rename the verified database to `outliner`, restore/select the matching
bucket if enabled, then start services and verify login, content and receipts.
Do not replay only Yjs into an unrelated account database. Never delete the old
volume or bucket as part of the drill.

## Health and maintenance

`/health` checks PostgreSQL and reports projection lag, compaction lag, GC backlog
and blocked-document count. It does not probe optional object storage. Monitor
sustained projection/compaction lag and disk capacity. Projection and compaction
continue in text-only mode; GC stays off to retain recoverability. Backup and
restore failures should alert through the operator's scheduler/monitoring.
See [personal-self-host-validation.md](personal-self-host-validation.md) for the
recorded acceptance environment and limits.
