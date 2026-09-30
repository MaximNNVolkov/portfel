# Автодеплой стенда (pull-режим)

Эталонные копии того, что установлено на стенде. Действующая схема и диагностика описаны
в `docs/STAND.md`, раздел «Автоматическая выкладка».

| файл | куда установлено на стенде |
|---|---|
| `portfel-autodeploy.sh` | `/home/user1/.hermes/scripts/portfel_autodeploy.sh` |
| `systemd/portfel-autodeploy.service` | `/etc/systemd/system/portfel-autodeploy.service` |
| `systemd/portfel-autodeploy.timer` | `/etc/systemd/system/portfel-autodeploy.timer` |
| `portfel-autodeploy.logrotate` | `/etc/logrotate.d/portfel-autodeploy` |

## Почему pull, а не GitHub Actions по SSH

Порт 22 стенда недоступен из интернета (наружу проброшены только 80/443), поэтому job
`deploy` из `.github/workflows/ci.yml` физически не может зайти на сервер. Вместо этого
сервер сам раз в 5 минут опрашивает GitHub и выкладывает первый **зелёный по CI** коммит
`origin/main`, которого ещё нет на стенде.

## Почему живой скрипт лежит НЕ в репозитории

`portfel_autodeploy.sh` запускает `scripts/deploy-stand.sh`, который делает
`git merge --ff-only` в этой же рабочей копии. Если бы исполняемый скрипт лежал внутри
репозитория, merge мог бы подменить файл, который bash читает по ходу исполнения. Поэтому
рабочая копия скрипта живёт вне репозитория, а здесь — эталон для воспроизведения.

После правки файлов здесь обнови установленные копии:

```
sudo install -m 644 deploy/systemd/portfel-autodeploy.service /etc/systemd/system/
sudo install -m 644 deploy/systemd/portfel-autodeploy.timer   /etc/systemd/system/
sudo install -m 644 deploy/portfel-autodeploy.logrotate /etc/logrotate.d/portfel-autodeploy
install -m 755 deploy/portfel-autodeploy.sh /home/user1/.hermes/scripts/portfel_autodeploy.sh
sudo systemctl daemon-reload && sudo systemctl restart portfel-autodeploy.timer
```

## Установка с нуля

```
install -d /home/user1/.local/share/portfel-autodeploy
install -m 755 deploy/portfel-autodeploy.sh /home/user1/.hermes/scripts/portfel_autodeploy.sh
sudo install -m 644 deploy/systemd/portfel-autodeploy.{service,timer} /etc/systemd/system/
sudo install -m 644 deploy/portfel-autodeploy.logrotate /etc/logrotate.d/portfel-autodeploy
sudo systemctl daemon-reload
sudo systemctl enable --now portfel-autodeploy.timer
```

Скрипту нужны два секрета, уже присутствующие на стенде:

- `~/.git-credentials` (режим 600) — токен GitHub для `git fetch` и запроса статуса CI;
- `~/.hermes/.env`, ключ `TELEGRAM_BOT_TOKEN` — для сообщений о сбоях.

Плюс правила sudoers из `docs/STAND.md` (rsync статики и restart двух юнитов) — их использует
`scripts/deploy-stand.sh`.

## Что скрипт НЕ делает

Не трогает живой `/etc/nginx/sites-available/portfel`. Если в выкладываемом коммите менялся
`nginx/nginx.conf.template`, приходит предупреждение в Telegram — конфиг nginx синхронизируют
руками (`sudo nginx -t && sudo systemctl reload nginx`).
