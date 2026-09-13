#!/bin/sh
# Восстановление БД из бэкапа, сделанного backup.sh (SPEC §31).
#
# Использование внутри контейнера backup (у него уже есть доступ к БД и к тому с бэкапами),
# интерактивно — нужен флаг -it, иначе запрос подтверждения не сможет прочитать ответ:
#   docker compose exec -it backup sh /restore.sh /backups/portfel-20260912-030000.sql.gz
#
# Для неинтерактивного запуска (например, из скрипта проверки) подтверждение можно дать
# заранее: CONFIRM=yes docker compose exec backup sh /restore.sh /backups/<файл>.sql.gz
#
# Дамп сделан с --clean --if-exists (см. backup.sh), поэтому безопасно накатывается поверх
# уже заполненной базы — существующие объекты удаляются и создаются заново, а не дают
# ошибку "relation already exists". ON_ERROR_STOP останавливает восстановление на первой же
# ошибке psql, а не молча пропускает часть команд, оставляя базу в смешанном состоянии.
set -eu

FILE=${1:?"Укажите путь к файлу бэкапа (.sql.gz), например: /backups/portfel-20260912-030000.sql.gz"}
PGHOST=${PGHOST:-postgres}
PGUSER=${PGUSER:-portfel}
PGDATABASE=${PGDATABASE:-portfel}

if [ ! -f "$FILE" ]; then
  echo "Файл бэкапа не найден: $FILE" >&2
  exit 1
fi

if [ "${CONFIRM:-}" != "yes" ]; then
  echo "Внимание: это действие ПЕРЕЗАПИШЕТ текущие данные в базе '$PGDATABASE' на хосте '$PGHOST' поверх дампа $FILE."
  printf "Введите 'yes' для подтверждения: "
  read -r answer
  if [ "$answer" != "yes" ]; then
    echo "Восстановление отменено."
    exit 1
  fi
fi

echo "Восстановление базы '$PGDATABASE' на хосте '$PGHOST' из $FILE..."
gunzip -c "$FILE" | psql -h "$PGHOST" -U "$PGUSER" -d "$PGDATABASE" -v ON_ERROR_STOP=1
echo "Восстановление завершено."
