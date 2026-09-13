#!/usr/bin/env python3
"""
Дневной автономный цикл разработки portfel.

Правило (по указанию пользователя, session 2026-09-13):
- Смотрим ТОЛЬКО текущее 5-часовое сессионное окно лимита (недельный лимит игнорируем).
- После каждой завершённой задачи проверяем: сколько % сессии осталось и сколько
  времени до сброса окна.
- Запускаем следующую задачу, если:
    a) остаток большой (>= MIN_REMAINING_TO_RUN), ИЛИ
    b) до сброса осталось мало времени (<= NEAR_RESET_MINUTES) — можно попробовать,
       а если лимит кончится по ходу — просто подождём до сброса и продолжим.
- Иначе (остаток мал И сброс ещё далеко) — спим короткими интервалами и перепроверяем.
- Останавливаемся к END_HOUR_MSK (передаём эстафету ночному крону 22:00+).
"""
import subprocess, sys, time, json, os, datetime

sys.path.insert(0, '/home/user1/.hermes/hermes-agent')
from agent.account_usage import fetch_account_usage

MIN_REMAINING_TO_RUN = 15.0   # % остатка сессии, при котором точно стоит запускать ещё раунд
NEAR_RESET_MINUTES = 20       # если до сброса меньше — тоже можно попробовать успеть/дождаться
POLL_INTERVAL_SEC = 300       # как часто перепроверять лимит, если решили подождать
END_HOUR_MSK = 21
END_MINUTE_MSK = 50
SESSION_ID = "4be6f868-b4f8-45ba-ae4e-abdbf236a67b"
WORKDIR = "/home/user1/portfel"
PROMPT_FILE = "/tmp/claude_continue_next2.txt"
LOG = "/home/user1/portfel/.auto_dev_loop.log"

def log(msg):
    line = f"[{datetime.datetime.now().isoformat(timespec='seconds')}] {msg}"
    print(line, flush=True)
    with open(LOG, "a") as f:
        f.write(line + "\n")

def get_token():
    return json.load(open('/home/user1/.claude/.credentials.json'))['claudeAiOauth']['accessToken']

def get_session_usage():
    """Возвращает (remaining_pct, minutes_to_reset) для текущего сессионного окна.
    Возвращает (None, None), если API лимитов недоступен/вернул пусто."""
    try:
        snap = fetch_account_usage(provider='anthropic', api_key=get_token(), base_url='http://127.0.0.1:8787')
    except Exception as e:
        log(f"get_session_usage: fetch_account_usage raised {e!r}")
        return None, None
    if snap is None or not getattr(snap, 'windows', None):
        log("get_session_usage: fetch_account_usage returned None/empty")
        return None, None
    for w in snap.windows:
        if w.label == 'Current session':
            remaining = 100 - w.used_percent
            now = datetime.datetime.now(datetime.timezone.utc)
            reset_at = w.reset_at
            minutes_left = max(0, (reset_at - now).total_seconds() / 60)
            return remaining, minutes_left
    return None, None

def past_end_time():
    now = datetime.datetime.now()
    return (now.hour, now.minute) >= (END_HOUR_MSK, END_MINUTE_MSK) or now.hour < 6

def safety_commit():
    subprocess.run(["git", "-C", WORKDIR, "add", "-A"])
    r = subprocess.run(["git", "-C", WORKDIR, "diff", "--cached", "--quiet"])
    if r.returncode != 0:
        tsc = subprocess.run(["npx", "tsc", "-b"], cwd=WORKDIR)
        if tsc.returncode == 0:
            subprocess.run(["git", "-C", WORKDIR, "commit", "-m", "chore: safety commit (auto_dev_loop guard)"])
            log("safety_commit: committed pending changes")
        else:
            log("safety_commit: tsc FAILED, leaving uncommitted for manual review")

def run_claude_round():
    env = os.environ.copy()
    for k in ("http_proxy", "https_proxy", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"):
        env.pop(k, None)
    env["ANTHROPIC_BASE_URL"] = "http://127.0.0.1:8787"
    prompt = open(PROMPT_FILE).read()
    cmd = ["claude", "-p", prompt, "--resume", SESSION_ID, "--max-turns", "150", "--dangerously-skip-permissions"]
    log("run_claude_round: launching claude CLI round")
    result = subprocess.run(cmd, cwd=WORKDIR, env=env, capture_output=True, text=True)
    log(f"run_claude_round: exit_code={result.returncode}")
    if result.returncode != 0:
        log(f"stderr tail: {result.stderr[-800:]}")
    safety_commit()

def main():
    log("=== auto_dev_loop start (5h-window mode, weekly limit ignored) ===")
    while True:
        if past_end_time():
            log("Reached end-of-day cutoff (21:50 MSK) or past midnight — handing off to night cron. Stop.")
            break

        remaining, minutes_left = get_session_usage()
        if remaining is None:
            log("Could not read session usage, sleeping 5 min and retrying")
            time.sleep(POLL_INTERVAL_SEC)
            continue

        log(f"usage check: session_remaining={remaining:.1f}% minutes_to_reset={minutes_left:.0f}")

        should_run = (remaining >= MIN_REMAINING_TO_RUN) or (minutes_left <= NEAR_RESET_MINUTES)

        if should_run:
            run_claude_round()
            time.sleep(30)
        else:
            wait_s = min(POLL_INTERVAL_SEC, max(60, minutes_left * 60 - NEAR_RESET_MINUTES * 60))
            log(f"Remaining low ({remaining:.1f}%) and reset far ({minutes_left:.0f} min) — sleeping {wait_s:.0f}s")
            time.sleep(wait_s)

    log("=== auto_dev_loop end ===")

if __name__ == "__main__":
    main()
