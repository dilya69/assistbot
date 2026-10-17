-- Общее пространство на двоих.
-- У второго человека в data_owner_id стоит id владельца данных: он работает с её записями
-- (смены, привычки, напоминания) в том же интерфейсе, без режима просмотра.
-- Напоминания бота приходят владельцу, потому что данные принадлежат ей.
alter table public.users
  add column if not exists data_owner_id uuid references public.users(id) on delete set null;

-- владелец данных: «соньчк»; второй человек («♡») работает с её данными
update public.users
set data_owner_id = 'ca9389fc-fd6b-4266-bd04-19eb617d309f'
where id = 'd9c734b4-1d5b-45ac-8b0a-963810f3f3f3';
