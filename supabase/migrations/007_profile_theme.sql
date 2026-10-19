-- Вкладка «Настройки»: у каждого из двоих своё оформление и профиль.
-- Данные (смены, привычки, напоминания) общие и лежат у владельца, а имя, значок и тема
-- хранятся в строке того, кто сейчас открыл приложение.
alter table public.users
  add column if not exists display_name text
    check (display_name is null or char_length(display_name) between 1 and 30),
  add column if not exists avatar text
    check (avatar is null or char_length(avatar) between 1 and 8),
  add column if not exists theme text not null default 'auto'
    check (theme in ('auto','light','dark','thrones','dead'));

-- тема, которую раньше сохраняли в общих настройках, остаётся у владельца
update public.users u
   set theme = s.theme
  from public.user_settings s
 where s.user_id = u.id;
