-- Новая тема оформления «newyear»: разрешаем значение в проверках
alter table public.users drop constraint if exists users_theme_check;
alter table public.users add constraint users_theme_check
  check (theme in ('auto','light','dark','thrones','dead','newyear'));

alter table public.user_settings drop constraint if exists user_settings_theme_check;
alter table public.user_settings add constraint user_settings_theme_check
  check (theme in ('auto','light','dark','thrones','dead','newyear'));
