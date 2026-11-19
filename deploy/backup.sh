#!/usr/bin/env bash
# Nightly backup: a database dump and the uploaded files, kept for 14 days. See docs/deploy.md.
# Usage (from anywhere):  /home/lumen/lumen-platform/deploy/backup.sh
set -euo pipefail

cd "$(dirname "$0")/.."
BACKUP_DIR="${BACKUP_DIR:-/var/backups/lumen}"
KEEP_DAYS="${KEEP_DAYS:-14}"
STAMP="$(date +%F-%H%M)"
compose=(docker compose -f deploy/docker-compose.prod.yml --env-file deploy/.env.production)

mkdir -p "$BACKUP_DIR"

# Database: a plain SQL dump, restorable with psql.
"${compose[@]}" exec -T postgres pg_dump -U lumen --no-owner lumen | gzip > "$BACKUP_DIR/db-$STAMP.sql.gz.part"
mv "$BACKUP_DIR/db-$STAMP.sql.gz.part" "$BACKUP_DIR/db-$STAMP.sql.gz"

# Uploaded documents (the originals; everything else can be rebuilt from them and the database).
# Streamed out of the container, so the file is written by this script's user (no shared permissions needed).
"${compose[@]}" run --rm --no-deps -T --entrypoint tar api -czf - -C /data/uploads . \
  > "$BACKUP_DIR/uploads-$STAMP.tar.gz.part"
mv "$BACKUP_DIR/uploads-$STAMP.tar.gz.part" "$BACKUP_DIR/uploads-$STAMP.tar.gz"

find "$BACKUP_DIR" -name '*.gz' -mtime +"$KEEP_DAYS" -delete
echo "Backup written to $BACKUP_DIR: db-$STAMP.sql.gz, uploads-$STAMP.tar.gz"
