#!/usr/bin/env python3
"""Мгновенный триггер автодеплоя стенда portfel по вебхуку GitHub.

Зачем: таймер portfel-autodeploy.timer тикает раз в 5 минут, и до выкладки проходит
до пяти минут после того, как CI позеленел. Этот слушатель сокращает задержку до секунд.

Слушаем событие workflow_run, а НЕ push: на момент push'а CI ещё идёт, тик всё равно
увидел бы «pending» и ушёл ждать. Интересен момент, когда workflow завершился успешно.

Вебхук здесь — только «пинок». Никаких решений на основе его payload не принимается:
тик (portfel_autodeploy.sh) сам заново спрашивает у GitHub API статус CI и сам решает,
что выкладывать. Поэтому подделанный или устаревший payload не может выложить красный
коммит — максимум вызовет лишний холостой тик.

Слушает только 127.0.0.1, наружу проброшен через nginx (location /gh-deploy).
"""
import hashlib
import hmac
import json
import os
import subprocess
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

SECRET_FILE = "/home/user1/.config/portfel-autodeploy/webhook_secret"
PORT = int(os.environ.get("PORTFEL_HOOK_PORT", "9077"))
PATH = "/gh-deploy"
MAX_BODY = 1 << 20  # payload'ы GitHub заметно меньше; отсекаем мусор


def log(msg: str) -> None:
    print(msg, flush=True)  # journald подхватывает stdout юнита


try:
    with open(SECRET_FILE, encoding="utf-8") as fh:
        SECRET = fh.read().strip().encode()
except OSError as exc:
    sys.exit(f"не читается файл секрета {SECRET_FILE}: {exc}")
if not SECRET:
    sys.exit(f"файл секрета {SECRET_FILE} пуст")


class Handler(BaseHTTPRequestHandler):
    server_version = "portfel-deploy-hook"
    sys_version = ""

    def log_message(self, fmt, *args):  # noqa: A003 - подпись из BaseHTTPRequestHandler
        log("%s %s" % (self.address_string(), fmt % args))

    def reply(self, code: int, text: str) -> None:
        body = text.encode()
        self.send_response(code)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        # Живость для проверки руками; сам деплой только по POST.
        self.reply(405, "only POST\n")

    def do_POST(self):
        if self.path.rstrip("/") != PATH:
            self.reply(404, "not found\n")
            return

        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self.reply(400, "bad length\n")
            return
        if length <= 0 or length > MAX_BODY:
            self.reply(400, "bad length\n")
            return
        raw = self.rfile.read(length)

        sig = self.headers.get("X-Hub-Signature-256", "")
        expected = "sha256=" + hmac.new(SECRET, raw, hashlib.sha256).hexdigest()
        if not hmac.compare_digest(sig, expected):
            log("отклонено: неверная подпись")
            self.reply(401, "bad signature\n")
            return

        event = self.headers.get("X-GitHub-Event", "")
        if event == "ping":
            self.reply(200, "pong\n")
            return
        if event != "workflow_run":
            self.reply(202, "ignored: event %s\n" % event)
            return

        try:
            payload = json.loads(raw)
        except ValueError:
            self.reply(400, "bad json\n")
            return

        run = payload.get("workflow_run") or {}
        action = payload.get("action")
        branch = run.get("head_branch")
        conclusion = run.get("conclusion")
        if action != "completed" or branch != "main" or conclusion != "success":
            self.reply(202, "ignored: %s/%s/%s\n" % (action, branch, conclusion))
            return

        sha = (run.get("head_sha") or "")[:7]
        log("CI позеленел на %s — запускаю тик автодеплоя" % sha)
        # --no-block: отвечаем GitHub сразу, не держа его на сборке.
        # Если тик уже идёт, systemd поставит запуск в очередь, а flock внутри скрипта
        # не даст двум сборкам наложиться.
        rc = subprocess.run(
            ["sudo", "-n", "/usr/bin/systemctl", "start", "--no-block",
             "portfel-autodeploy.service"],
            capture_output=True, text=True,
        )
        if rc.returncode != 0:
            log("systemctl start не удался: %s" % (rc.stderr or "").strip())
            self.reply(500, "trigger failed\n")
            return
        self.reply(202, "deploy triggered for %s\n" % sha)


if __name__ == "__main__":
    log("слушаю 127.0.0.1:%d%s" % (PORT, PATH))
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
