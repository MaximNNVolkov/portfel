#!/bin/sh
# Восстановление БД из бэкапа, сделанного backup.sh (SPEC §31).
#
# Использование внутри контейнера backup (у него уже есть доступ к БД и к тому с бэкапами):
#   docker compose exec backup sh /restore.sh /backups/portfel-20260912-030000.sql.gz
#
# Восстанавливает поверх уже существующей БД — перед восстановлением на "боевую" базу
# стоит убедиться, что это осознанное действие (см. предупреждение в docs/DEPLOY.md).
set -eu

FILE=${1:?"Укажите путь к файлу бэкапа (.sql.gz), например: /backups/portfel-20260912-030000.sql.gz"}
PGHOST=${PGHOST:-postgres}
PGUSER=${PGUSER:-portfel}
PGDATABASE=${PGDATABASE:-portfel}

if [ ! -f "$FILE" ]; then
  echo "Файл бэкапа не найден: $FILE" >&2
  exit 1
fi

echo "Восстановление базы '$PGDATABASE' на хосте '$PGHOST' из $FILE..."
gunzip -c "$FILE" | psql -h "$PGHOST" -U "$PGUSER" -d "$PGDATABASE"
echo "Восстановление завершено."
