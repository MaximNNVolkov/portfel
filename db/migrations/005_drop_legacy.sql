-- Снос legacy-схемы. Таблицы public.products/transactions/payments/portfolio_snapshots/
-- broker_connections пришли из первой версии (001_init_legacy.sql) и целиком перенесены
-- в схему `portfolio` миграцией 003_new_schema.sql. С тех пор ни одна выборка приложения
-- их не читает и не пишет — они оставались архивом «на всякий случай».
--
-- Держать их дальше вредно: две параллельные схемы одних и тех же данных расходятся молча,
-- любая правка через API меняет только новую, а из старой при восстановлении из бэкапа
-- (§31) можно случайно поднять устаревшую картину портфеля. Удаляем сейчас, пока объём
-- данных мал, а сама точка отката — резервная копия базы (§31), а не мёртвая таблица.
--
-- public.users и public.sessions остаются: это действующие таблицы авторизации (§5),
-- на них ссылается вся схема `portfolio`.
DROP TABLE IF EXISTS products CASCADE;
DROP TABLE IF EXISTS transactions CASCADE;
DROP TABLE IF EXISTS payments CASCADE;
DROP TABLE IF EXISTS portfolio_snapshots CASCADE;
DROP TABLE IF EXISTS broker_connections CASCADE;
