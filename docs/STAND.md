# Стенд внутреннего тестирования

**Адрес: https://portfel.176.109.108.58.nip.io**

Поднят 13.09.2026 на сервере `176.109.108.58` (тот же, где живут остальные сервисы
владельца: `bonds.*`, `expedition.*` и т. д.). Размещение в РФ — требование §28,
выполняется.

Инструкция для тестировщика (что открыть, что проверять, чего в приложении
намеренно нет) — `docs/TESTER_README.md`, её можно отдавать людям как есть.

## Как войти

Регистрация закрыта кодом приглашения (§28, пункт P0-4 плана выкладки): без него
`POST /api/auth/register` отвечает 403. Код лежит в `.env` на сервере в переменной
`REGISTRATION_INVITE_CODE` и выдаётся тестировщикам лично; в репозиторий он не
попадает. На форме регистрации появляется поле «Код приглашения» — при входе
существующим аккаунтом код не нужен.

Сменить код: поправить `REGISTRATION_INVITE_CODE` в `/home/user1/portfel/.env`
и перезапустить backend (см. ниже). Уже заведённые аккаунты это не затрагивает.

## Восстановление пароля

Ссылка «Забыли пароль?» на экране входа ведёт на `/forgot-password`, а письмо со ссылкой
сброса — на `/reset-password?token=...` (§28, `server/password-reset.ts`/`server/mailer.ts`).
Ссылка живёт 1 час и работает один раз; после смены пароля все сессии этого пользователя
на всех устройствах становятся недействительными.

На стенде SMTP не настроен (`SMTP_HOST` пуст в `.env`) — это осознанный выбор для
внутреннего тестирования, а не пропущенный шаг. Вместо реальной отправки ссылка
восстановления пишется в лог backend-процесса с меткой `[password-reset]`:

```
journalctl -u portfel-api -n 200 | grep password-reset
```

Владелец стенда достаёт ссылку оттуда вручную. Чтобы включить реальную отправку почты,
достаточно задать `SMTP_HOST`/`SMTP_PORT`/`SMTP_SECURE`/`SMTP_USER`/`SMTP_PASS`/`MAIL_FROM`
в `/home/user1/portfel/.env` (см. `.env.example`) и перезапустить `portfel-api.service` —
код ничего не хардкодит про способ доставки. `APP_URL` уже указывает на публичный адрес
стенда, поэтому ссылка в письме (и в логе-заглушке) корректна без дополнительной правки.

## Как устроено

- **Статика** — production-сборка фронта (`npm run build`), скопированная в
  `/var/www/portfel`. Nginx отдаёт её напрямую, dev-сервер Vite на стенде не участвует.
- **Backend** — `server/index.ts` на `127.0.0.1:3001`, наружу не опубликован,
  проксируется nginx по `/api/`. Отдельного проксирования `/uploads/` больше нет —
  OCR (§34, асинхронная обработка) удаляет файл сразу после распознавания, отдавать
  оттуда нечего (снято вместе с P0-5, см. «Ограничения» ниже).
- **Планировщик** — `server/scheduler.ts`: суточные задачи (снимки, синхронизация
  брокера, котировки) и очередь OCR с тактом в 2 секунды.
- **База** — нативный `postgresql.service` (не докер-контейнер), порт 5432 только на
  localhost. Отдельно на машине висит неиспользуемый контейнер `portfel-postgres`
  (без опубликованных портов, вне какого-либо compose-проекта) — не относится к
  работе стенда, не трогаем.
- **Nginx** — `/etc/nginx/sites-available/portfel`, TLS от Let's Encrypt
  (`certbot --nginx`), HTTP редиректит на HTTPS. Продление автоматическое,
  тем же механизмом, что и у остальных вхостов машины.

Сервисы стенда работают отдельно от `docker-compose.yml`: compose-стек — это будущий
production-деплой на выделенный VPS (`docs/DEPLOY.md`), а стенд собран на уже
работающем nginx машины, чтобы не занимать её порты 80/443 вторым веб-сервером.

## Эксплуатация

Backend и планировщик работают как systemd-юниты (`portfel-api.service`,
`portfel-scheduler.service`, файлы — `/etc/systemd/system/portfel-*.service`), а не как
голые фоновые процессы. Оба — `Restart=always` и `enabled` (стартуют автоматически при
загрузке сервера).

Перезапуск после обновления кода:

```
sudo systemctl restart portfel-api.service portfel-scheduler.service
```

Статус и логи:

```
sudo systemctl status portfel-api.service portfel-scheduler.service
tail -f /var/log/portfel/api.log /var/log/portfel/scheduler.log
```

Ручной запуск голыми командами (как раньше) больше не нужен и не должен использоваться —
он создаёт процесс, не управляемый systemd, который придётся отдельно останавливать перед
следующим `systemctl start`, иначе оба будут слушать порт 3001 одновременно.

Выложить новую версию фронта:

```
npm run build && sudo cp -r dist/. /var/www/portfel/ && sudo chown -R www-data:www-data /var/www/portfel
```

Всё это целиком (обновить код, собрать, выложить статику, перезапустить, проверить
`/api/health`) делает `scripts/deploy-stand.sh` — его можно запускать и руками
на сервере из `/home/user1/portfel`.

## Автоматическая выкладка

Стенд обновляется сам: **pull-режим** — сервер раз в 5 минут опрашивает GitHub. Push-путь
из GitHub Actions (job `deploy`) сохранён в workflow, но на этом хосте он неработоспособен:
порт 22 недоступен из интернета (наружу проброшены только 80/443), поэтому Actions не может
зайти по SSH. Секреты `STAND_SSH_*` не заведены, и job завершается зелёным с пометкой
«пропущено» — это ожидаемое состояние, а не сбой.

### Как работает pull-автодеплой (действующая схема)

- systemd-таймер `portfel-autodeploy.timer` (`OnUnitInactiveSec=5min`) запускает
  `portfel-autodeploy.service` → `/home/user1/.hermes/scripts/portfel_autodeploy.sh`.
- Тик: `git fetch origin main`; если `origin/main` совпадает с `HEAD` — выход молча.
- Иначе спрашивает у GitHub API check-runs нового коммита. Выкладывается **только зелёный**
  CI: `pending` → ждём следующего тика, `failed` → сообщение в Telegram один раз на коммит
  (дедуп через `last_reported_failure`).
- Зелёный коммит → `scripts/deploy-stand.sh <sha>` (та же логика, что и в push-режиме).
- Если в коммите менялся `nginx/nginx.conf.template` — приходит предупреждение: живой
  `/etc/nginx/sites-available/portfel` этот скрипт НЕ трогает, его правят вручную.
- Успех — тихо, только в лог `/home/user1/.local/share/portfel-autodeploy/autodeploy.log`
  (logrotate, weekly, 4 копии). Сообщения только про сбой.
- Блокировки две: `flock` на тик (не запускать два тика разом) и `flock` внутри
  `deploy-stand.sh` (ручной и автоматический запуск не соберут стенд одновременно).
- Токен GitHub берётся из `~/.git-credentials` (600), токен Telegram — из `~/.hermes/.env`.

Диагностика:

```
systemctl list-timers portfel-autodeploy
journalctl -u portfel-autodeploy.service -n 50
tail -40 /home/user1/.local/share/portfel-autodeploy/autodeploy.log
```

Задержка от зелёного CI до живого стенда — до 5 минут (таймер) + ~25 секунд (сборка).

Ручной путь работает всегда: `cd /home/user1/portfel && scripts/deploy-stand.sh`.

### Push-режим (если порт 22 когда-нибудь откроют наружу)

Каждый push в `main`, прошедший CI (`checks` и `backend-image`), выкладывался бы на стенд
job'ом `deploy` из `.github/workflows/ci.yml`: он заходит по SSH и запускает
`scripts/deploy-stand.sh <sha>`. Скрипт делает fast-forward рабочей копии до этого коммита,
`npm ci` (только если поменялся `package-lock.json`), `npm run build`, копирует статику
в `/var/www/portfel`, перезапускает `portfel-api` и `portfel-scheduler` (миграции backend
применяет сам при старте) и ждёт ответа `/api/health`. Если что-то не так — job красный,
лог выкладки виден в Actions. После этого job ещё раз проверяет стенд по публичному адресу.

Отдельного пользователя под деплой нет: ключ деплоя кладётся к `user1` (владельцу рабочей
копии и сервисов) с `command="..."` в `authorized_keys`, поэтому по этому ключу можно
выполнить только `deploy-stand.sh` и ничего больше. Права `sudo` у скрипта — две точные
команды из sudoers ниже.

### Разовая настройка push-режима

1. На своём компьютере создать ключ деплоя (без пароля):
   ```
   ssh-keygen -t ed25519 -N '' -C portfel-deploy -f portfel-deploy
   ```
2. На сервере под `user1` дописать в `~/.ssh/authorized_keys` одну строку — содержимое
   `portfel-deploy.pub` с префиксом:
   ```
   command="/home/user1/portfel/scripts/deploy-stand.sh",no-port-forwarding,no-X11-forwarding,no-agent-forwarding,no-pty ssh-ed25519 AAAA... portfel-deploy
   ```
3. На сервере разрешить скрипту две команды без пароля
   (`sudo visudo -f /etc/sudoers.d/portfel-deploy`):
   ```
   user1 ALL=(root) NOPASSWD: /usr/bin/systemctl restart portfel-api.service portfel-scheduler.service
   user1 ALL=(root) NOPASSWD: /usr/bin/rsync -a --chown=www-data\:www-data /home/user1/portfel/dist/ /var/www/portfel/
   ```
   Если `rsync` не установлен — `sudo apt install rsync`.
4. Проверить на сервере, что всё сходится, один ручной прогон:
   ```
   cd /home/user1/portfel && git checkout main && scripts/deploy-stand.sh
   ```
   (`git fetch` должен проходить без ввода пароля; рабочая копия — без незакоммиченных
   правок, иначе скрипт остановится и перечислит их.)
5. В GitHub: Settings → Secrets and variables → Actions → New repository secret:
   - `STAND_SSH_HOST` — `176.109.108.58`
   - `STAND_SSH_USER` — `user1`
   - `STAND_SSH_KEY` — содержимое приватного файла `portfel-deploy` целиком
   - `STAND_SSH_KNOWN_HOSTS` — вывод `ssh-keyscan -t ed25519 176.109.108.58`

   После этого приватный ключ с компьютера можно удалить.

Ручной путь (`scripts/deploy-stand.sh` на сервере или команды выше) продолжает работать —
скрипт берёт блокировку, так что ручной запуск и автоматический не соберут стенд
одновременно.

## Ограничения этого стенда

1. ~~Не переживает перезагрузку сервера~~ — **закрыто**. Backend и планировщик установлены
   как systemd-юниты (`portfel-api.service`, `portfel-scheduler.service`, `enabled`,
   `Restart=always`) — переживают и падение процесса, и перезагрузку сервера без ручного
   вмешательства. Проверено: `kill -9` на главном процессе `portfel-api` → автоматический
   респавн за секунды, API снова отвечает; оба юнита в состоянии `enabled` (стартуют
   на boot). Полный `reboot` общего VPS не выполнялся намеренно — на машине есть другие,
   не относящиеся к этому проекту сервисы (`bonds.*`, `expedition.*`), и настоящая
   перезагрузка сервера — риск для них, требующий отдельного согласия владельца; проверка
   через respawn после kill -9 покрывает то же самое свойство (systemd поднимает процесс
   заново без ручных действий), не трогая остальные сервисы машины.
2. **Блокеры из `docs/RELEASE_PLAN.md` — все закрыты (P0-1..P0-7).** Восстановление
   из бэкапа исправлено (P0-1), языковые данные OCR упакованы в образ (P0-2, на стенде
   не мешает и без этого — они лежат в корне репозитория), rate limiting за прокси
   (P0-3) и код приглашения (P0-4) потребовал сам факт публикации, заголовки
   безопасности и заглушки меню на месте (P0-5, P0-6), smoke-тесты написаны (P0-7).
   Обновление стенда на текущий код и живая проверка nginx-заголовков, фронта и
   backend/scheduler выполнены 14.09.2026 (см. историю работ) — код и живой стенд
   синхронизированы.
3. **Бэкапов у стенда нет.** Сервис `backup` из compose здесь не запущен —
   база стенда не резервируется, данные тестов считать одноразовыми.
4. **Т-Инвестиции в режиме sandbox** (`TINKOFF_API_MODE=sandbox`). Боевой токен
   подключать только после того, как sandbox-сценарий пройден.
5. **Токен сессии хранится в `localStorage`** — решение отложено до итогов теста.
