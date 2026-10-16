-- Запускать после включения расширения pg_cron
-- (Supabase: Database, Extensions, pg_cron).
-- Каждую ночь в 03:00 по UTC чистит данные старше срока хранения.
select cron.schedule('cleanup-old-data', '0 3 * * *', $$ select public.cleanup_old_data(); $$);
