#!/usr/bin/env bash
# Выкладка production (docker-compose на VPS, docs/DEPLOY.md) на указанный коммит main.
# Запускается:
# 1. Автоматически из GitHub Actions (job `deploy-prod` в .github/workflows/ci.yml) по SSH.
#    Ключ деплоя в ~/.ssh/authorized_keys привязан к этому скрипту через command="...",
#    поэтому ничего другого с этим ключом на сервере выполнить нельзя. SHA коммита,
#    прошедшего CI, приходит в $SSH_ORIGINAL_COMMAND.
# 2. Вручную на сервере: `scripts/deploy-prod.sh` (последний origin/main)
#    или `scripts/deploy-prod.sh <sha>`.
#
# Шаги: fetch → бэкап базы (если сервис backup уже работает) → fast-forward до коммита →
# docker compose build → up -d (миграции backend применяет сам при старте) → ждём healthy
# у backend. Не поднялся — откат рабочей копии на предыдущий коммит, пересборка, up -d
# и ненулевой код выхода: job в Actions красный, прод остаётся на прошлой версии.
# Схему БД откат не возвращает (миграции только вперёд) — для этого бэкап перед выкладкой,
# восстановление — scripts/restore.sh, см. docs/DEPLOY.md.
#
# Всё тело внутри main(): bash читает скрипт по мере исполнения, а git merge ниже
# может заменить этот самый файл. Функция разбирается целиком до первого шага.
set -euo pipefail

main() {
  local repo_dir=${PORTFEL_DIR:-$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)}
  local health_timeout=${PORTFEL_HEALTH_TIMEOUT:-180}
  local target=${1:-${SSH_ORIGINAL_COMMAND:-}}

  if [[ -n $target && ! $target =~ ^[0-9a-f]{7,40}$ ]]; then
    echo "[deploy] ожидается SHA коммита, получено: '$target'" >&2
    exit 2
  fi

  exec 9>"${TMPDIR:-/tmp}/portfel-deploy-prod.lock"
  flock 9

  cd "$repo_dir"
  echo "[deploy] $(date -u -Iseconds) каталог $repo_dir"
  [[ -f .env ]] || { echo "[deploy] нет .env в $repo_dir (docs/DEPLOY.md, «Первый запуск»)" >&2; exit 1; }

  if [[ -n $(git status --porcelain --untracked-files=no) ]]; then
    echo "[deploy] в рабочей копии есть незакоммиченные правки — выкладка остановлена:" >&2
    git status --short --untracked-files=no >&2
    exit 1
  fi

  git fetch --quiet origin main
  [[ -n $target ]] || target=$(git rev-parse origin/main)
  target=$(git rev-parse --verify "$target^{commit}")
  if ! git merge-base --is-ancestor "$target" origin/main; then
    echo "[deploy] коммит $target не входит в origin/main" >&2
    exit 1
  fi

  if [[ $(git rev-parse --abbrev-ref HEAD) != main ]]; then
    git checkout --quiet main
  fi
  local previous
  previous=$(git rev-parse HEAD)
  if git merge-base --is-ancestor "$target" HEAD && [[ $target != "$previous" ]]; then
    echo "[deploy] на проде уже более новый коммит ${previous:0:7}, пропускаю"
    exit 0
  fi

  # Миграции необратимы — снимаем дамп до них. На самом первом запуске сервиса backup ещё нет.
  if docker compose ps --status running --services 2>/dev/null | grep -qx backup; then
    echo "[deploy] бэкап базы перед выкладкой"
    docker compose exec -T -e RUN_ONCE=1 backup sh /backup.sh
  else
    echo "[deploy] сервис backup не запущен — бэкап перед выкладкой пропущен"
  fi

  git merge --ff-only --quiet "$target"
  echo "[deploy] ${previous:0:7} → ${target:0:7}"

  if release && wait_healthy "$health_timeout"; then
    docker image prune -f >/dev/null || true
    echo "[deploy] готово: $(git log -1 --format='%h %s')"
    exit 0
  fi

  echo "[deploy] выкладка ${target:0:7} не поднялась" >&2
  docker compose logs --no-color --tail=80 backend >&2 || true
  if [[ $previous == "$target" ]]; then
    exit 1
  fi
  echo "[deploy] откат на ${previous:0:7}" >&2
  git reset --quiet --hard "$previous"
  if release && wait_healthy "$health_timeout"; then
    echo "[deploy] откат выполнен, прод на ${previous:0:7}" >&2
  else
    echo "[deploy] откат тоже не поднялся — нужна ручная проверка сервера" >&2
  fi
  exit 1
}

release() {
  docker compose build --pull backend scheduler nginx && docker compose up -d --remove-orphans
}

# Ждём, пока healthcheck backend из docker-compose.yml станет healthy.
wait_healthy() {
  local timeout=$1 waited=0 status container
  container=$(docker compose ps -q backend)
  [[ -n $container ]] || return 1
  while (( waited < timeout )); do
    status=$(docker inspect -f '{{.State.Health.Status}}' "$container" 2>/dev/null || echo missing)
    case $status in
      healthy) echo "[deploy] backend healthy"; return 0 ;;
      unhealthy|missing) echo "[deploy] backend $status" >&2; return 1 ;;
    esac
    sleep 5
    waited=$(( waited + 5 ))
  done
  echo "[deploy] backend не стал healthy за ${timeout} с" >&2
  return 1
}

main "$@"
