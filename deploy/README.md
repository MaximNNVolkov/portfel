# Автодеплой стенда (pull + вебхук-пинок)

Эталонные копии того, что установлено на стенде. Действующая схема и диагностика описаны
в `docs/STAND.md`, раздел «Автоматическая выкладка».

| файл | куда установлено на стенде |
|---|---|
| `portfel-autodeploy.sh` | `/home/user1/.hermes/scripts/portfel_autodeploy.sh` |
| `portfel-deploy-hook.py` | `/home/user1/.hermes/scripts/portfel_deploy_hook.py` |
| `systemd/portfel-autodeploy.service` | `/etc/systemd/system/portfel-autodeploy.service` |
| `systemd/portfel-autodeploy.timer` | `/etc/systemd/system/portfel-autodeploy.timer` |
| `systemd/portfel-deploy-hook.service` | `/etc/systemd/system/portfel-deploy-hook.service` |
| `portfel-autodeploy.logrotate` | `/etc/logrotate.d/portfel-autodeploy` |
| `nginx-gh-deploy.conf` | блок внутри `/etc/nginx/sites-available/portfel` (443-server) |

## Почему pull, а не GitHub Actions по SSH

Порт 22 стенда недоступен из интернета (наружу проброшены только 80/443), поэтому job
`deploy` из `.github/workflows/ci.yml` физически не может зайти на сервер. Вместо этого
сервер сам опрашивает GitHub и выкладывает первый **зелёный по CI** коммит `origin/main`,
которого ещё нет на стенде.

## Две половины схемы

**1. Таймер — надёжность.** `portfel-autodeploy.timer` тикает раз в 5 минут. Работает,
даже если вебхук не дошёл: GitHub недоступен, сеть моргнула, слушатель лежал, доставка
потерялась. Это то, на что можно положиться.

**2. Вебхук — скорость.** `portfel-deploy-hook.service` слушает `127.0.0.1:9077`, наружу
проброшен через nginx как `POST https://portfel.176.109.108.58.nip.io/gh-deploy`. Событие
GitHub — `workflow_run`, **не `push`**: на момент push'а CI ещё идёт, и тик всё равно
увидел бы «pending». Интересен момент, когда workflow завершился.

Вебхук — только «пинок»: он вызывает `systemctl start --no-block portfel-autodeploy.service`
и ничего не решает по своему payload'у. Решение принимает тик, который заново спрашивает
у GitHub API статус CI. Поэтому подделанный или устаревший payload не может выложить
красный коммит — максимум вызовет холостой тик.

Слушатель отвечает `202` сразу, не держа GitHub на времени сборки. Если тик уже идёт,
`flock` внутри `portfel_autodeploy.sh` не даст двум сборкам наложиться.

## Почему живые скрипты лежат НЕ в репозитории

`portfel_autodeploy.sh` запускает `scripts/deploy-stand.sh`, который делает
`git merge --ff-only` в этой же рабочей копии. Если бы исполняемый скрипт лежал внутри
репозитория, merge мог бы подменить файл, который bash читает по ходу исполнения. Поэтому
рабочие копии живут вне рабочего дерева, а здесь — эталон для воспроизведения.

После правки файлов здесь обнови установленные копии:

```
install -m 755 deploy/portfel-autodeploy.sh  /home/user1/.hermes/scripts/portfel_autodeploy.sh
install -m 755 deploy/portfel-deploy-hook.py /home/user1/.hermes/scripts/portfel_deploy_hook.py
sudo install -m 644 deploy/systemd/portfel-autodeploy.service  /etc/systemd/system/
sudo install -m 644 deploy/systemd/portfel-autodeploy.timer    /etc/systemd/system/
sudo install -m 644 deploy/systemd/portfel-deploy-hook.service /etc/systemd/system/
sudo install -m 644 deploy/portfel-autodeploy.logrotate /etc/logrotate.d/portfel-autodeploy
sudo systemctl daemon-reload
sudo systemctl restart portfel-autodeploy.timer portfel-deploy-hook.service
```

## Установка с нуля

```
install -d /home/user1/.local/share/portfel-autodeploy
install -d -m 700 /home/user1/.config/portfel-autodeploy
openssl rand -hex 32 > /home/user1/.config/portfel-autodeploy/webhook_secret
chmod 600 /home/user1/.config/portfel-autodeploy/webhook_secret
# затем «обнови установленные копии» выше, плюс:
sudo systemctl enable --now portfel-autodeploy.timer portfel-deploy-hook.service
```

Блок `nginx-gh-deploy.conf` вставить в 443-server `/etc/nginx/sites-available/portfel`
перед `location /` (иначе SPA-фолбэк перехватит запрос), затем
`sudo nginx -t && sudo systemctl reload nginx`.

Зарегистрировать вебхук в GitHub (Settings → Webhooks, или через API):

- Payload URL: `https://portfel.176.109.108.58.nip.io/gh-deploy`
- Content type: `application/json`
- Secret: содержимое `~/.config/portfel-autodeploy/webhook_secret`
- Events: только **Workflow runs**

## Секреты

- `~/.git-credentials` (режим 600) — токен GitHub для `git fetch` и запроса статуса CI;
- `~/.hermes/.env`, ключ `TELEGRAM_BOT_TOKEN` — для сообщений о сбоях;
- `~/.config/portfel-autodeploy/webhook_secret` (600) — HMAC-секрет вебхука.

Правила sudoers: `systemctl start portfel-autodeploy.service` для слушателя, плюс rsync
статики и restart двух юнитов для `scripts/deploy-stand.sh` (см. `docs/STAND.md`).

## Что схема НЕ делает

Не трогает живой `/etc/nginx/sites-available/portfel`. Если в выкладываемом коммите менялся
`nginx/nginx.conf.template`, приходит предупреждение в Telegram — конфиг nginx синхронизируют
руками (`sudo nginx -t && sudo systemctl reload nginx`).
