#!/usr/bin/env bash
# Автодеплой стенда portfel, pull-режим.
#
# Почему pull, а не push из GitHub Actions: job `deploy` в .github/workflows/ci.yml ходит
# на сервер по SSH, но порт 22 этого хоста недоступен из интернета (снаружи connection
# timed out — наружу проброшены только 80/443). Поэтому опрашиваем GitHub сами.
#
# Логика тика:
#   1. git fetch origin main; если origin/main == HEAD — выходим молча.
#   2. Спрашиваем у GitHub API вывод CI для нового SHA. Деплоим только зелёный коммит;
#      если CI ещё идёт — ждём следующего тика; если CI красный — сообщаем ОДИН раз.
#   3. Запускаем scripts/deploy-stand.sh <sha> (он сам: ff-merge, npm ci при смене
#      lockfile, build, статика, restart юнитов, ожидание /api/health).
#   4. Проверяем дрейф nginx: если nginx/nginx.conf.template в коммите изменился,
#      предупреждаем — живой /etc/nginx/sites-available/portfel правится руками.
#
# Успех — молча (только лог). Сообщения в Telegram только про сбой.
# Запуск: systemd timer portfel-autodeploy.timer (каждые 5 минут).
set -uo pipefail

REPO=/home/user1/portfel
STATE_DIR=/home/user1/.local/share/portfel-autodeploy
LOG=$STATE_DIR/autodeploy.log
LAST_FAIL=$STATE_DIR/last_reported_failure
REPO_SLUG=MaximNNVolkov/portfel
TG_CHAT=175431079

mkdir -p "$STATE_DIR"

log() { printf '%s %s\n' "$(date -Iseconds)" "$*" >>"$LOG"; }

notify() {
  local text=$1
  log "NOTIFY: $text"
  local token
  token=$(sed -nE "s/^TELEGRAM_BOT_TOKEN=[\"']?([^\"']+)[\"']?[[:space:]]*$/\\1/p" /home/user1/.hermes/.env 2>/dev/null | head -1)
  [[ -n ${token:-} ]] || { log "нет TELEGRAM_BOT_TOKEN — сообщение не отправлено"; return; }
  curl -s --max-time 20 -o /dev/null \
    "https://api.telegram.org/bot${token}/sendMessage" \
    --data-urlencode "chat_id=${TG_CHAT}" \
    --data-urlencode "text=${text}" \
    --data-urlencode "disable_web_page_preview=true" || log "sendMessage не удался"
}

gh_api() {
  local path=$1 token
  token=$(sed -nE '1s#https://[^:]*:([^@]*)@.*#\1#p' /home/user1/.git-credentials 2>/dev/null)
  [[ -n ${token:-} ]] || return 3
  curl -s --max-time 25 -H "Authorization: Bearer $token" \
    -H 'Accept: application/vnd.github+json' "https://api.github.com$path"
}

# Один тик за раз: сборка занимает больше, чем интервал таймера.
exec 9>"$STATE_DIR/tick.lock"
flock -n 9 || { log "предыдущий тик ещё идёт — пропускаю"; exit 0; }

cd "$REPO" || { log "нет каталога $REPO"; exit 1; }

if ! git fetch --quiet origin main 2>>"$LOG"; then
  log "git fetch не удался (сеть) — пропускаю тик"
  exit 0
fi

head_sha=$(git rev-parse HEAD)
remote_sha=$(git rev-parse origin/main)
if [[ $head_sha == "$remote_sha" ]]; then
  exit 0
fi

# Локальные незакоммиченные правки — deploy-stand.sh всё равно откажется, скажем понятнее.
if [[ -n $(git status --porcelain --untracked-files=no) ]]; then
  if [[ $(cat "$LAST_FAIL" 2>/dev/null) != "dirty:$remote_sha" ]]; then
    notify "portfel автодеплой остановлен: в рабочей копии на стенде есть незакоммиченные правки, новый коммит ${remote_sha:0:7} не выложен."
    echo "dirty:$remote_sha" >"$LAST_FAIL"
  fi
  exit 0
fi

# Статус CI для нового коммита.
ci=$(gh_api "/repos/$REPO_SLUG/commits/$remote_sha/check-runs?per_page=100")
verdict=$(printf '%s' "$ci" | python3 -c '
import json, sys
try:
    d = json.load(sys.stdin)
except Exception:
    print("unknown"); sys.exit()
runs = d.get("check_runs")
if not isinstance(runs, list) or not runs:
    print("unknown"); sys.exit()
# Job деплоя мог быть пропущен/красным из-за отсутствия SSH-секретов — он нас не интересует.
runs = [r for r in runs if "deploy" not in (r.get("name") or "").lower()]
if not runs:
    print("unknown"); sys.exit()
if any(r.get("status") != "completed" for r in runs):
    print("pending"); sys.exit()
bad = [r["name"] for r in runs if r.get("conclusion") not in ("success", "neutral", "skipped")]
print("failed:" + ",".join(bad) if bad else "success")
' 2>/dev/null)

case "$verdict" in
  success) ;;
  pending)
    log "CI для ${remote_sha:0:7} ещё идёт — жду следующего тика"
    exit 0 ;;
  failed:*)
    if [[ $(cat "$LAST_FAIL" 2>/dev/null) != "ci:$remote_sha" ]]; then
      notify "portfel: CI на коммите ${remote_sha:0:7} красный (${verdict#failed:}) — автодеплой на стенд не выполнен."
      echo "ci:$remote_sha" >"$LAST_FAIL"
    fi
    exit 0 ;;
  *)
    log "не смог получить статус CI для ${remote_sha:0:7} — жду следующего тика"
    exit 0 ;;
esac

log "выкладываю ${head_sha:0:7} → ${remote_sha:0:7}"
nginx_changed=$(git diff --name-only "$head_sha" "$remote_sha" -- nginx/nginx.conf.template)

out=$("$REPO/scripts/deploy-stand.sh" "$remote_sha" 2>&1)
rc=$?
printf '%s\n' "$out" >>"$LOG"

if (( rc != 0 )); then
  notify "portfel автодеплой УПАЛ на коммите ${remote_sha:0:7} (код $rc). Стенд остался на прежней версии или в промежуточном состоянии.
$(printf '%s' "$out" | tail -n 12)"
  echo "deploy:$remote_sha" >"$LAST_FAIL"
  exit 1
fi

rm -f "$LAST_FAIL"
log "готово: $(git log -1 --format='%h %s')"

if [[ -n $nginx_changed ]]; then
  notify "portfel: коммит ${remote_sha:0:7} выложен, но в нём менялся nginx/nginx.conf.template — живой /etc/nginx/sites-available/portfel правится вручную, проверь дрейф."
fi
exit 0
