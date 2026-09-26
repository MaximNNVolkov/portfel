-- Коды валют — ISO-заглавными (RUB, USD). T-Invest API отдаёт их строчными («rub»), и первая
-- синхронизация Т-Инвестиций записала так счёт, инструменты, операции и выплаты. Коннектор
-- теперь приводит код к верхнему регистру сам; без этой миграции следующая синхронизация
-- не узнала бы счёт «rub» в «RUB», завела бы второй счёт брокера и задвоила все позиции.
UPDATE portfolio.accounts SET currency = UPPER(currency) WHERE currency <> UPPER(currency);
UPDATE portfolio.instruments SET currency = UPPER(currency) WHERE currency <> UPPER(currency);
UPDATE portfolio.transactions SET currency = UPPER(currency) WHERE currency <> UPPER(currency);
UPDATE portfolio.payouts SET currency = UPPER(currency) WHERE currency <> UPPER(currency);
