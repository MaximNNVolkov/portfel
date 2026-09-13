#!/usr/bin/env python3
"""
Дневной автономный цикл разработки portfel.
Работает до END_TIME, останавливаясь на 10%-ном буфере лимита (сессия и неделя).
Не пересекается с ночным кроном (22:00+) — тот берёт управление сам.
"""
import subprocess, sys, time, json, os, datetime

sys.path.insert(0, '/home/user1/.hermes/hermes-agent')
from agent.account_usage import fetch_account_usage

BUFFER_PCT = 10.0          # оставляем минимум 10% и по сессии, и по неделе
END_HOUR_MSK = 21          # не работать после 21:50, чтобы не пересечься с ночным кроном (22:00+)
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

def get_usage():
    snap = fetch_account_usage(provider='anthropic', api_key=get_token(), base_url='http://127.0.0.1:8787')
    session_remaining = None
    week_remaining = None
    for w in snap.windows:
        if w.label == 'Current session':
            session_remaining = 100 - w.used_percent
        elif w.label == 'Current week':
            week_remaining = 100 - w.used_percent
    return session_remaining, week_remaining

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
    log("=== auto_dev_loop start ===")
    while True:
        if past_end_time():
            log("Reached end-of-day cutoff (21:50 MSK) or past midnight — handing off to night cron. Stop.")
            break
        session_remaining, week_remaining = get_usage()
        log(f"usage check: session_remaining={session_remaining}% week_remaining={week_remaining}%")
        if week_remaining is not None and week_remaining <= BUFFER_PCT:
            log(f"Weekly buffer reached ({week_remaining}% <= {BUFFER_PCT}%). Stopping for today.")
            break
        if session_remaining is None:
            log("Could not read session usage, sleeping 5 min and retrying")
            time.sleep(300)
            continue
        if session_remaining <= BUFFER_PCT:
            log(f"Session buffer reached ({session_remaining}% <= {BUFFER_PCT}%). Sleeping until next reset (~15 min checks).")
            time.sleep(900)
            continue
        run_claude_round()
        time.sleep(30)
    log("=== auto_dev_loop end ===")

if __name__ == "__main__":
    main()
