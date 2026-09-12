#!/bin/sh
# Ежедневный backup БД (SPEC §31). Запускается как отдельный сервис в docker-compose
# (образ postgres:16-alpine, у которого уже есть pg_dump); работает бесконечным циклом
# по тому же паттерну, что и цикл обновления сертификата в сервисе certbot.
set -eu

BACKUP_DIR=${BACKUP_DIR:-/backups}
RETENTION_COUNT=${BACKUP_RETENTION_COUNT:-7}
INTERVAL_SECONDS=${BACKUP_INTERVAL_SECONDS:-86400}

mkdir -p "$BACKUP_DIR"

run_backup() {
  timestamp=$(date -u +%Y%m%d-%H%M%S)
  file="$BACKUP_DIR/portfel-$timestamp.sql.gz"
  echo "[backup] $(date -u -Iseconds) starting backup to $file"
  if pg_dump -h "$PGHOST" -U "$PGUSER" -d "$PGDATABASE" | gzip > "$file.tmp"; then
    mv "$file.tmp" "$file"
    echo "[backup] $(date -u -Iseconds) backup complete: $file"
  else
    echo "[backup] $(date -u -Iseconds) backup FAILED" >&2
    rm -f "$file.tmp"
  fi
  # Хранение нескольких последних копий: оставляем только RETENTION_COUNT самых свежих файлов.
  ls -1t "$BACKUP_DIR"/portfel-*.sql.gz 2>/dev/null | tail -n +$((RETENTION_COUNT + 1)) | xargs -r rm -f
}

trap exit TERM INT
while :; do
  run_backup
  sleep "$INTERVAL_SECONDS" &
  wait $!
done
