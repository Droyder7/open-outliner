#!/usr/bin/env bash
# A consistent complete database dump. Optional blob mirrors require stopped writes.
set -euo pipefail
umask 077
output=${1:?Usage: scripts/backup.sh NEW_BACKUP_DIRECTORY}
if [[ -e "$output" ]]; then echo 'Backup destination already exists' >&2; exit 1; fi
partial="${output}.partial"
if [[ -e "$partial" ]]; then echo 'Partial backup destination already exists' >&2; exit 1; fi
blobs=$(docker compose exec -T postgres psql -U outliner -d outliner -Atc \
  'SELECT count(*) FROM attachments WHERE s3_key IS NOT NULL')
mode=text
s3_enabled=$(docker compose config --format json | python3 -c 'import json,sys; c=json.load(sys.stdin); print("yes" if c["services"]["app"].get("environment",{}).get("S3_ENDPOINT") else "no")')
if [[ "$blobs" != 0 || "$s3_enabled" = yes || -n "${BLOB_BACKUP_DIR:-}" ]]; then
  : "${BLOB_BACKUP_DIR:?Uploaded attachments require a fresh bucket mirror in BLOB_BACKUP_DIR}"
  if [[ ! -d "$BLOB_BACKUP_DIR" ]]; then echo 'Blob mirror directory is missing' >&2; exit 1; fi
  if [[ -n "$(docker compose ps --status running -q app)" ]]; then
    echo 'Stop app and quiesce direct bucket writers before mirroring attachment blobs' >&2; exit 1
  fi
  mode=database-and-blob-mirror
fi
mkdir -p "$(dirname "$partial")"
mkdir "$partial"
if [[ "$mode" != text ]]; then
  docker compose exec -T postgres psql -U outliner -d outliner -Atc \
    'SELECT s3_key FROM attachments WHERE s3_key IS NOT NULL ORDER BY s3_key' > "$partial/blob-keys.txt"
  while IFS= read -r key; do
    if [[ "$key" = /* || "$key" = *..* || ! -f "$BLOB_BACKUP_DIR/$key" ]]; then
      echo 'The bucket mirror is missing a referenced object or contains an unsafe key' >&2; exit 1
    fi
  done < "$partial/blob-keys.txt"
fi
docker compose exec -T postgres pg_dump -U outliner -d outliner -Fc > "$partial/database.dump"
if [[ "$mode" != text ]]; then tar -C "$BLOB_BACKUP_DIR" -cf "$partial/blobs.tar" .; fi
printf '{"format":1,"mode":"%s","createdAt":"%s","database":"outliner"}\n' \
  "$mode" "$(date -u +%FT%TZ)" > "$partial/manifest.json"
(
  cd "$partial"
  if [[ -f blobs.tar ]]; then sha256sum database.dump manifest.json blobs.tar blob-keys.txt > SHA256SUMS
  else sha256sum database.dump manifest.json > SHA256SUMS; fi
)
mv -T "$partial" "$output"
printf 'Backup complete: %s\n' "$output"
