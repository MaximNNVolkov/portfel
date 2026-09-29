#!/usr/bin/env bash
# Выкладка стенда (docs/STAND.md) на указанный коммит main. Запускается:
# 1. Автоматически из GitHub Actions (job `deploy` в .github/workflows/ci.yml) по SSH.
#    Ключ деплоя в ~/.ssh/authorized_keys привязан к этому скрипту через command="...",
#    поэтому ничего другого с этим ключом на сервере выполнить нельзя. SHA коммита,
#    прошедшего CI, приходит в $SSH_ORIGINAL_COMMAND.
# 2. Вручную на сервере: `scripts/deploy-stand.sh` (последний origin/main)
#    или `scripts/deploy-stand.sh <sha>`.
#
# Шаги: fetch → fast-forward до коммита → npm ci (только если поменялся lockfile) →
# сборка фронта → копирование статики → перезапуск systemd-юнитов (миграции backend
# применяет сам при старте) → проверка /api/health. Любая ошибка — ненулевой код выхода,
# job в Actions становится красным.
#
# Всё тело внутри main(): bash читает скрипт по мере исполнения, а git merge ниже
# может заменить этот самый файл. Функция разбирается целиком до первого шага.
set -euo pipefail

main() {
  local repo_dir=${PORTFEL_DIR:-$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)}
  local static_dir=${PORTFEL_STATIC_DIR:-/var/www/portfel}
  local health_url=${PORTFEL_HEALTH_URL:-http://127.0.0.1:3001/api/health}
  local target=${1:-${SSH_ORIGINAL_COMMAND:-}}

  if [[ -n $target && ! $target =~ ^[0-9a-f]{7,40}$ ]]; then
    echo "[deploy] ожидается SHA коммита, получено: '$target'" >&2
    exit 2
  fi

  # Одна выкладка за раз: второй запуск ждёт первый, а не собирает поверх него.
  exec 9>"${TMPDIR:-/tmp}/portfel-deploy.lock"
  flock 9

  # Неинтерактивная SSH-сессия не читает ~/.bashrc — подхватываем node из nvm, если он там.
  if ! command -v npm >/dev/null 2>&1 && [[ -s ${NVM_DIR:-$HOME/.nvm}/nvm.sh ]]; then
    # shellcheck disable=SC1091
    . "${NVM_DIR:-$HOME/.nvm}/nvm.sh" >/dev/null
  fi
  command -v npm >/dev/null || { echo "[deploy] npm не найден в PATH" >&2; exit 1; }

  cd "$repo_dir"
  echo "[deploy] $(date -u -Iseconds) каталог $repo_dir"

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
    echo "[deploy] на стенде уже более новый коммит $(git rev-parse --short HEAD), пропускаю"
    exit 0
  fi
  git merge --ff-only --quiet "$target"
  echo "[deploy] ${previous:0:7} → ${target:0:7}"

  if [[ ! -d node_modules ]] || ! git diff --quiet "$previous" "$target" -- package-lock.json; then
    echo "[deploy] npm ci"
    npm ci --no-audit --no-fund
  fi

  echo "[deploy] сборка фронта"
  npm run build

  echo "[deploy] статика → $static_dir"
  sudo -n /usr/bin/rsync -a --chown=www-data:www-data "$repo_dir/dist/" "$static_dir/"

  echo "[deploy] перезапуск сервисов"
  sudo -n /usr/bin/systemctl restart portfel-api.service portfel-scheduler.service

  # Миграции применяются при старте backend — ждём, пока он поднимется.
  local attempt
  for attempt in $(seq 1 30); do
    if curl -fsS --max-time 3 "$health_url" >/dev/null 2>&1; then
      break
    fi
    if [[ $attempt == 30 ]]; then
      echo "[deploy] backend не ответил на $health_url за 60 секунд" >&2
      systemctl --no-pager --lines=40 status portfel-api.service >&2 || true
      exit 1
    fi
    sleep 2
  done
  if ! systemctl is-active --quiet portfel-scheduler.service; then
    echo "[deploy] portfel-scheduler.service не запущен" >&2
    systemctl --no-pager --lines=40 status portfel-scheduler.service >&2 || true
    exit 1
  fi

  echo "[deploy] готово: $(git log -1 --format='%h %s')"
}

main "$@"
