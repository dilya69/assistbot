-- Вкладка «Цикл»: уникальное начало цикла и общий доступ по умолчанию.
-- Уже применена в проекте как cycle_tab (20261017235435); файл добавлен, чтобы репозиторий совпадал с базой.
-- cycle_share_partner = true: второй человек видит вкладку; владелец может выключить переключателем во вкладке «Цикл».
create unique index if not exists cycles_user_start_uq on public.cycles(user_id, start_date);
alter table public.user_settings alter column cycle_share_partner set default true;
update public.user_settings s
   set cycle_share_partner = true
 where s.user_id in (select data_owner_id from public.users where data_owner_id is not null);
