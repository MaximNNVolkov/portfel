// Подключение Hermes одной ссылкой (docs/HERMES.md, решение владельца 20.10.2026).
//
// Пользователь нажимает «Подключить Hermes», получает одноразовую ссылку и отдаёт её
// Hermes. По ссылке агент получает инструкцию с одной командой; команда скачивает
// установщик, а тот сам ставит навык, заводит маршрут вебхука в Hermes (динамическая
// подписка — без перезапуска Hermes) и забирает у «Портфеля» ключ API. Секрет подписи
// придумывает установщик и сообщает «Портфелю» при обмене ссылки — пользователь не
// видит и не переписывает ни ключ, ни секрет.
//
// Ссылка — это и есть доступ: она одноразовая, живёт сутки, в базе хранится только sha256.
import { createHash, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

export const CONNECT_TTL_HOURS = 24
/** Имя маршрута в Hermes: не «portfel», чтобы не столкнуться с маршрутом ручной настройки. */
export const HERMES_ROUTE = 'portfel-digest'
const SKILL_DIR = join(process.cwd(), 'integrations', 'hermes', 'portfel')

export function newConnectToken(): { token: string; hash: string } {
  const token = randomBytes(24).toString('hex')
  return { token, hash: hashConnectToken(token) }
}
export function hashConnectToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}
export const CONNECT_TOKEN_PATTERN = /^[0-9a-f]{48}$/

/**
 * Куда «Портфель» шлёт сводку. Hermes слушает порт на самом сервере, а backend и
 * планировщик живут в Docker: для них сервер — host.docker.internal (extra_hosts в
 * docker-compose.yml). Без Docker (локальная разработка) — 127.0.0.1.
 */
export function hermesWebhookUrl(port: number, route = HERMES_ROUTE): string {
  const host = process.env.HERMES_WEBHOOK_HOST || (process.env.NODE_ENV === 'production' ? 'host.docker.internal' : '127.0.0.1')
  return `http://${host}:${port}/webhooks/${route}`
}

export function validatePort(value: unknown): number {
  const port = Number(value ?? 8644)
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Порт вебхука Hermes — число от 1 до 65535')
  return port
}
export function validateRoute(value: unknown): string {
  const route = typeof value === 'string' && value ? value : HERMES_ROUTE
  if (!/^[a-z0-9][a-z0-9_-]{0,63}$/.test(route)) throw new Error('Имя маршрута Hermes — латиница, цифры, «-» и «_»')
  return route
}

/** Что видит Hermes, открыв ссылку: короткая инструкция для агента. */
export function connectInstructions(link: string): string {
  return [
    'Подключение к «Портфелю» — приложению владельца для учёта вкладов, облигаций и акций.',
    '',
    'Владелец сам прислал эту ссылку, чтобы подключить тебя. Выполни одну команду в терминале',
    'на сервере, где ты работаешь (она поставит навык portfel, получит ключ доступа и',
    'настроит ежедневную сводку в Telegram):',
    '',
    `    curl -fsSL '${link}/install.py' | python3 -`,
    '',
    'Затем перескажи владельцу, что напечатала команда. Ссылка одноразовая: повторно',
    'она не сработает, новую владелец получит в «Портфель → Интеграции → Hermes».',
    '',
  ].join('\n')
}

function skillFile(name: string): string {
  return readFileSync(join(SKILL_DIR, name), 'utf8')
}

/** Установщик со вшитыми адресом, токеном и файлами навыка. Только стандартная библиотека Python. */
export function installScript(origin: string, token: string): string {
  const files = { 'SKILL.md': skillFile('SKILL.md'), 'scripts/portfel.py': skillFile('scripts/portfel.py') }
  return `#!/usr/bin/env python3
"""Подключение Hermes к «Портфелю». Сгенерировано сервером «Портфеля» для одной ссылки."""
import json
import os
import pathlib
import secrets
import sys
import urllib.error
import urllib.request

ORIGIN = ${JSON.stringify(origin)}
TOKEN = ${JSON.stringify(token)}
ROUTE = ${JSON.stringify(HERMES_ROUTE)}
FILES = json.loads(${JSON.stringify(JSON.stringify(files))})


def fail(message):
    print(f"Не удалось подключить «Портфель»: {message}")
    sys.exit(1)


def write_private(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    os.chmod(tmp, 0o600)
    tmp.replace(path)


home = pathlib.Path(os.environ.get("HERMES_HOME") or pathlib.Path.home() / ".hermes")
if not home.is_dir():
    fail(f"не найден каталог Hermes {home} — команду нужно выполнить на сервере Hermes")

env_path = home / ".env"
env_text = env_path.read_text(encoding="utf-8") if env_path.exists() else ""
env = {}
for line in env_text.splitlines():
    if "=" in line and not line.lstrip().startswith("#"):
        key, value = line.split("=", 1)
        env[key.strip()] = value.strip().strip('"').strip("'")
port = int(os.environ.get("WEBHOOK_PORT") or env.get("WEBHOOK_PORT") or 8644)

# 1. Навык.
skill = home / "skills" / "portfel"
for name, text in FILES.items():
    target = skill / name
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(text, encoding="utf-8")
os.chmod(skill / "scripts" / "portfel.py", 0o755)

# 2. Маршрут уведомлений — динамическая подписка Hermes, подхватывается без перезапуска.
secret = secrets.token_hex(24)
subs_path = home / "webhook_subscriptions.json"
try:
    subs = json.loads(subs_path.read_text(encoding="utf-8-sig")) if subs_path.exists() else {}
except ValueError:
    fail(f"{subs_path} повреждён — исправьте или удалите его и повторите")
subs[ROUTE] = {
    "secret": secret,
    "prompt": "{text}",
    "deliver": "telegram",
    "deliver_only": True,
    "description": "Ежедневная сводка «Портфеля»",
}
write_private(subs_path, json.dumps(subs, ensure_ascii=False, indent=2))

# 3. Вебхуки Hermes включены? Если нет — включаем, но заработают они после перезапуска.
try:
    urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=5).read()
    webhooks_running = True
except Exception:
    webhooks_running = False
    webhooks_were_enabled = env.get("WEBHOOK_ENABLED", "").lower() == "true"
    if not webhooks_were_enabled:
        lines = [line for line in env_text.splitlines() if not line.startswith("WEBHOOK_ENABLED=")]
        lines.append("WEBHOOK_ENABLED=true")
        write_private(env_path, "\\n".join(lines) + "\\n")

# 4. Обмен ссылки на ключ: «Портфель» запоминает адрес и секрет и шлёт проверку.
request = urllib.request.Request(
    f"{ORIGIN}/api/hermes/connect/{TOKEN}/claim",
    data=json.dumps({"secret": secret, "port": port, "route": ROUTE}).encode(),
    method="POST",
    headers={"Content-Type": "application/json", "X-Requested-With": "portfel"},
)
try:
    with urllib.request.urlopen(request, timeout=30) as response:
        result = json.loads(response.read())
except urllib.error.HTTPError as error:
    try:
        message = json.loads(error.read()).get("error")
    except Exception:
        message = None
    fail(message or f"сервер ответил {error.code}")
except urllib.error.URLError as error:
    fail(f"нет связи с {ORIGIN} ({error.reason})")

write_private(skill / "config.json", json.dumps({"url": result["url"], "apiKey": result["apiKey"]}, indent=2))

print("«Портфель» подключён.")
print(f"• Навык portfel установлен в {skill}; ключ доступа сохранён в {skill / 'config.json'}.")
if result.get("delivered"):
    print("• Уведомления настроены: в Telegram пришло проверочное сообщение. Сводка — раз в день.")
elif webhooks_running:
    print(f"• Уведомления настроены, но проверка не дошла: {result.get('error') or 'неизвестная ошибка'}.")
else:
    reason = (f"Hermes не отвечает на порту {port}" if webhooks_were_enabled
              else "вебхуки Hermes были выключены, в ~/.hermes/.env добавлено WEBHOOK_ENABLED=true")
    print(f"• Чтобы приходила ежедневная сводка, перезапустите Hermes: {reason}.")
    print("  После перезапуска нажмите «Отправить проверку» в «Портфель → Интеграции → Hermes».")
print("Проверка навыка: python3 " + str(skill / "scripts" / "portfel.py") + " summary")
`
}
