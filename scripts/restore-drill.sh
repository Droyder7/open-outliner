#!/usr/bin/env bash
# Always restore into a new isolated database; never overwrite the running one.
set -euo pipefail
source_dir=${1:?Usage: scripts/restore-drill.sh BACKUP_DIRECTORY [outliner_restore_SUFFIX]}
target=${2:-outliner_restore_$(date -u +%Y%m%d_%H%M%S)_${RANDOM}}
if [[ ! "$target" =~ ^outliner_restore_[a-z0-9_]+$ ]]; then
  echo 'Drill database must start with outliner_restore_ and contain only lowercase letters, digits and underscores' >&2
  exit 1
fi
(cd "$source_dir" && sha256sum -c SHA256SUMS)
docker compose exec -T postgres createdb -U outliner "$target"
docker compose exec -T postgres pg_restore -U outliner --exit-on-error --no-owner --no-acl \
  -d "$target" < "$source_dir/database.dump"
docker compose run --rm --no-deps -T -e RESTORE_DATABASE="$target" \
  -e RESTORE_DOCUMENT_ID -e RESTORE_EXPECT_TEXT app node scripts/verify-restored.mjs
printf 'Restore verified in isolated database: %s\n' "$target"
if [[ -f "$source_dir/blobs.tar" ]]; then
  echo 'Blob mirror checksums verified; restore it to an isolated bucket before enabling attachment access.'
fi
