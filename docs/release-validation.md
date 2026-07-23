# 15 — Release Validation & Rollback

**Status:** Accepted · **Last updated:** 2026-07-23

How releases are validated before shipping, and what to do when something goes wrong.

## Release flow

### Versioning

The project uses semantic versioning (semver) with a pre-release tag for the V1 series:

- `0.1.0` — first V1 pre-release (alpha/beta as needed)
- `1.0.0` — V1 GA

Tags are lightweight git tags (`git tag v0.1.0`), not annotated — the commit message is the release note.

### Pre-merge validation (PR checks)

Every PR targeting `main` runs the full CI pipeline (`.github/workflows/ci.yml`):

| Job | What it proves |
|-----|----------------|
| Lint + Typecheck + Unit Tests | Code compiles, passes ESLint, 77 unit tests pass |
| Integration Tests | DB migrations apply, RPC round-trips work, WS auth enforces tenancy |
| Client Build | Vite production build succeeds (PWA manifest + service worker generated) |
| Container Build | Both `Dockerfile.app` and `Dockerfile.web` build successfully |
| Self-Host Smoke | `docker compose up` → health endpoint returns ok |

All jobs must pass before merge. No merge with a red CI.

### Post-merge validation (main branch)

After merge to `main`, the same CI pipeline runs. Additionally:

1. **Container images are tagged** with the short commit SHA and pushed to the container registry:
   ```
   open-outliner/app:<sha>
   open-outliner/web:<sha>
   ```
2. **`docker compose` smoke test** runs against the freshly-built images on a clean environment.

### Release promotion

When a release is ready:

1. **Tag the commit**: `git tag v<version>` on `main`
2. **Build and push release images**:
   ```
   docker build -t open-outliner/app:<version> -f Dockerfile.app .
   docker build -t open-outliner/web:<version> -f Dockerfile.web .
   docker push open-outliner/app:<version>
   docker push open-outliner/web:<version>
   ```
3. **Update `docker-compose.yml`** to reference the release tag (not `latest`).
4. **Write release notes** in the GitHub Release.

## Rollback procedure

Rollback is **downgrade the image tag + restore the database backup**. The system is designed so this is safe:

### Step 1: Stop the new version

```bash
docker compose down
```

### Step 2: Restore database from backup

The restore order matters (tenancy → Yjs/attachments → S3 → projection rebuild):

```bash
# 1. Restore tenancy/membership tables
pg_restore -d outliner --data-only --table=workspaces --table=documents --table=workspace_members --table=users backup.sql

# 2. Restore yjs_updates + attachments metadata
pg_restore -d outliner --data-only --table=yjs_updates --table=attachments backup.sql

# 3. Restore S3/MinIO objects
mc mirror backup-bucket/ open-outliner/

# 4. Reset projection (let the sweep rebuild from yjs)
psql -d outliner -c "UPDATE document_projection SET projected_rev = 0"
```

### Step 3: Start the previous version

```bash
# Edit docker-compose.yml to pin the previous image tag, then:
docker compose up -d
```

The materializer's catch-up sweep (`projected_rev = 0`) will re-project all documents from `yjs_updates` on startup, so the `items` table is rebuilt automatically.

### Step 4: Verify

```bash
curl http://localhost:8787/health
```

Expected: `{"status":"ok","metrics":{"projectionLag":...,"compactionLag":0,"gcBacklog":0}}`

Projection lag should drop to 0 within a few seconds as the sweep runs.

## Database migration rollback

Migrations are **forward-only** (no down migrations). If a migration causes a problem:

1. Stop the app.
2. Restore the database from the backup taken before the migration ran.
3. Start the previous app version (which expects the old schema).
4. Investigate the migration offline before re-deploying.

The migration runner (`packages/server/src/db/migrate.ts`) tracks applied migrations in the `schema_migrations` table, so it won't re-apply a migration that already ran.

## Safety properties

- **No data loss on rollback**: `yjs_updates` is append-only; a restore brings back the exact CRDT state. The projection rebuilds from it.
- **No FK violations on rollback**: the RESTRICT FKs on `items.parent_id` and `attachments.item_id` mean the materializer's topological upsert order is always valid.
- **S3 objects survive rollback**: blobs are referenced by `attachments.s3_key`, which is restored from `pg_dump`. The same presigned URLs continue to work.
- **Sessions survive rollback**: the `sessions` table is restored from `pg_dump`; existing cookies remain valid against the old session rows.
