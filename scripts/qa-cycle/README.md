# Скрипты цикла ручного и сквозного тестирования

Используются в цикле «тестирование → план → правки» (см. `docs/TEST_PLAN.md`).
Работают против локального стенда: API на `http://localhost:3001`, фронт на
`http://localhost:5173`. Пароль тестовых пользователей — `password123`, только для
локальной базы.

- `seed.mjs <email> [empty]` — регистрирует пользователя и наполняет портфель:
  8 инструментов всех групп, операции, выплаты, 25 пополнений для пагинации.
  С `empty` — пользователь без данных.
- `walk.mjs x <full|empty>` — обходит все вкладки на 390 и 1440 px, печатает по строке
  JSON на страницу (горизонтальный скролл, NaN/undefined/Invalid Date, ошибки консоли
  и HTTP) и сохраняет скриншоты в `shots/` (создайте каталог заранее).
- `auth.mjs` — вход через API (сессия в httpOnly-cookie + заголовок X-Requested-With).

Запуск: Postgres (`service postgresql start`, база portfel/portfel), `.env` с
`DATABASE_URL`, `API_RATE_LIMIT=100000 npm run api`, `npx vite --port 5173`, затем
`node scripts/qa-cycle/seed.mjs qa@example.com`, `node scripts/qa-cycle/seed.mjs empty@example.com empty`,
`cd scripts/qa-cycle && mkdir -p shots && node walk.mjs x full && node walk.mjs x empty`.

Другой стенд — через переменные окружения: `QA_API` (адрес API для `seed.mjs`), `QA_WEB`
(адрес фронта для `walk.mjs`), `QA_PASSWORD`, `QA_EMAIL` и `QA_EMPTY_EMAIL` (пользователи
обхода). На проде заводить тестовых пользователей — только с согласия владельца.

`walk.mjs` импортирует Playwright по пути `/opt/node22/lib/node_modules/playwright/index.mjs`
(так он установлен в облачной среде); локально замените на `playwright`.
Ошибки `ERR_CERT_AUTHORITY_INVALID` (шрифты) и 403 от cbr.ru — особенности облачной среды.
