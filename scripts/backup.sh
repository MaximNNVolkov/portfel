#!/bin/sh
# Ежедневный backup БД (SPEC §31). Два режима запуска:
# 1. Отдельный сервис в docker-compose (образ postgres:16-alpine, у которого уже есть
#    pg_dump) — бесконечный цикл по тому же паттерну, что и обновление сертификата
#    в сервисе certbot.
# 2. RUN_ONCE=1 — однократный запуск и выход, для окружений без docker-compose
#    (стенд на systemd, см. docs/STAND.md), где периодичность уже задаёт cron.
set -eu

BACKUP_DIR=${BACKUP_DIR:-/backups}
RETENTION_COUNT=${BACKUP_RETENTION_COUNT:-7}
INTERVAL_SECONDS=${BACKUP_INTERVAL_SECONDS:-86400}

mkdir -p "$BACKUP_DIR"

run_backup() {
  timestamp=$(date -u +%Y%m%d-%H%M%S)
  file="$BACKUP_DIR/portfel-$timestamp.sql.gz"
  echo "[backup] $(date -u -Iseconds) starting backup to $file"
  # --clean --if-exists: дамп содержит DROP перед CREATE, поэтому restore.sh можно
  # накатывать поверх уже заполненной базы, не только поверх пустой (см. scripts/restore.sh).
  if pg_dump -h "$PGHOST" -U "$PGUSER" -d "$PGDATABASE" --clean --if-exists | gzip > "$file.tmp"; then
    mv "$file.tmp" "$file"
    echo "[backup] $(date -u -Iseconds) backup complete: $file"
  else
    echo "[backup] $(date -u -Iseconds) backup FAILED" >&2
    rm -f "$file.tmp"
  fi
  # Хранение нескольких последних копий: оставляем только RETENTION_COUNT самых свежих файлов.
  ls -1t "$BACKUP_DIR"/portfel-*.sql.gz 2>/dev/null | tail -n +$((RETENTION_COUNT + 1)) | xargs -r rm -f
}

if [ "${RUN_ONCE:-}" = "1" ]; then
  run_backup
  exit 0
fi

trap exit TERM INT
while :; do
  run_backup
  sleep "$INTERVAL_SECONDS" &
  wait $!
done
