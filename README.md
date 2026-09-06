# Капитал

Веб-приложение для учёта и анализа инвестиционного портфеля.

## Что уже работает

- сводка портфеля, P&L и структура активов;
- продукты, операции и календарь выплат;
- регистрация и вход по email + паролю;
- backend API с валидацией и Bearer-сессиями;
- ручное добавление продуктов, операций и выплат;
- OCR-сценарий со стадией проверки результата;
- подготовленный коннектор Т-Инвестиций;
- базовая аналитика и рекомендации;
- fallback на локальные данные при недоступности API.

## Запуск разработки

```bash
npm install
npm run dev:full
```

Frontend: `http://localhost:5173`  
API: `http://localhost:3001`

Отдельный запуск:

```bash
npm run dev   # frontend
npm run api   # backend
```

## Проверки

```bash
npm run build
npm run lint
curl http://localhost:3001/api/health
```

## API

- `POST /api/auth/register`, `POST /api/auth/login`;
- `GET /api/portfolio/summary`;
- `GET/POST/DELETE /api/products`;
- `GET/POST /api/transactions`;
- `GET/POST /api/payments`;
- `POST /api/ocr/preview`;
- `GET/POST /api/brokers/tinkoff` и `POST /api/brokers/tinkoff/sync`.

Тестовые данные хранятся в `server/data.json`. Пользователи и загружаемые материалы исключены из Git. Для production необходимо заменить JSON-хранилище на PostgreSQL, подключить реальный OCR-провайдер и Tinkoff Invest API.
