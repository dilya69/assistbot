-- Бот-планировщик: раз в минуту pg_cron вызывает Edge Function `tick`,
-- она отправляет напоминания и сообщения о сменах.
-- Нужны расширения pg_cron и pg_net (Database, Extensions).
--
-- Вызов защищён секретом. Он создаётся прямо в базе (Vault), нигде не печатается
-- и не хранится в коде: cron читает его из Vault, а функция сверяет через tick_secret_ok().

create extension if not exists pg_net with schema extensions;

do $$
begin
  if not exists (select 1 from vault.secrets where name = 'tick_secret') then
    perform vault.create_secret(encode(extensions.gen_random_bytes(32), 'hex'), 'tick_secret');
  end if;
end $$;

create or replace function public.tick_secret_ok(p text) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from vault.decrypted_secrets
     where name = 'tick_secret' and decrypted_secret = p
  );
$$;

revoke all on function public.tick_secret_ok(text) from public, anon, authenticated;
grant execute on function public.tick_secret_ok(text) to service_role;

-- Повторный запуск миграции просто обновляет задачу с тем же именем.
select cron.schedule('tick-every-minute', '* * * * *', $$
  select net.http_post(
    url := 'https://rgbfbepjmyhatjfbhvkq.supabase.co/functions/v1/tick',
    headers := jsonb_build_object(
      'content-type', 'application/json',
      'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'tick_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 25000
  );
$$);
