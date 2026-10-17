-- Бот-планировщик: pg_cron раз в минуту вызывает Edge Function `tick`.
-- Вызов защищён секретом из Vault: функция проверяет заголовок x-cron-secret через tick_secret_ok.
-- Перед запуском включи расширение pg_cron (Database, Extensions).
-- Если проект другой, поменяй адрес в url ниже.

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
