-- Личный помощник: схема базы.
-- Доступ к данным идёт только через Edge Function `api` (service role).
-- RLS включён на всех таблицах и политик нет, поэтому прямой доступ
-- с публичным ключом ничего не вернёт.

create extension if not exists pgcrypto;

-- ───────── пользователи и настройки ─────────
create table public.users (
  id                   uuid primary key default gen_random_uuid(),
  tg_id                bigint not null unique,
  first_name           text,
  role                 text not null default 'user' check (role in ('user','admin')),
  timezone             text not null default 'Europe/Moscow',
  quiet_on             boolean not null default true,
  quiet_from           time not null default '23:00',
  quiet_to             time not null default '08:00',
  quiet_strict_shifts  boolean not null default false,
  week_start           smallint not null default 1 check (week_start in (0,1)),
  paused_until         timestamptz,
  bot_blocked          boolean not null default false,
  created_at           timestamptz not null default now()
);

create table public.user_settings (
  user_id              uuid primary key references public.users(id) on delete cascade,
  shift_evening_on     boolean not null default true,
  shift_evening_time   time not null default '20:00',
  shift_before_on      boolean not null default true,
  shift_before_hours   smallint not null default 2 check (shift_before_hours between 1 and 12),
  cycle_remind_days    smallint not null default 2 check (cycle_remind_days between 0 and 7),
  cycle_neutral_text   boolean not null default true,
  cycle_typical_length smallint not null default 28 check (cycle_typical_length between 20 and 45),
  cycle_typical_period smallint not null default 5  check (cycle_typical_period between 1 and 12),
  cycle_lock           boolean not null default false,
  -- партнёр видит вкладку «Цикл» только если она сама включила этот переключатель
  cycle_share_partner  boolean not null default false,
  theme                text not null default 'auto' check (theme in ('auto','light','dark','thrones','dead'))
);

-- ───────── привычки ─────────
create table public.habits (
  id            uuid primary key default gen_random_uuid(),
  user_id       uuid not null references public.users(id) on delete cascade,
  name          text not null check (char_length(name) between 1 and 80),
  kind          text not null check (kind in ('do','avoid')),
  days          smallint[] not null default '{1,2,3,4,5,6,7}',
  remind_time   time,
  shift_mode    text not null default 'normal' check (shift_mode in ('normal','evening','silent')),
  evening_time  time not null default '21:30',
  start_date    date not null default current_date,
  best_streak   integer not null default 0,
  total_done    integer not null default 0,
  archived_at   timestamptz,
  created_at    timestamptz not null default now()
);
create index habits_user_idx on public.habits(user_id) where archived_at is null;

create table public.habit_logs (
  id          bigint generated always as identity primary key,
  habit_id    uuid not null references public.habits(id) on delete cascade,
  user_id     uuid not null references public.users(id) on delete cascade,
  log_date    date not null,
  status      text not null check (status in ('done','slip')),
  created_at  timestamptz not null default now()
);
create unique index habit_logs_done_uq on public.habit_logs(habit_id, log_date) where status = 'done';
create index habit_logs_lookup_idx on public.habit_logs(user_id, log_date);

-- ───────── смены, отпуск, напоминания ─────────
create table public.shift_types (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references public.users(id) on delete cascade,
  name           text not null check (char_length(name) between 1 and 40),
  default_start  time,
  default_end    time,
  sort           smallint not null default 0
);
create index shift_types_user_idx on public.shift_types(user_id);

create table public.shifts (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references public.users(id) on delete cascade,
  shift_date       date not null,           -- локальная дата начала смены
  type_id          uuid references public.shift_types(id) on delete set null,
  type_name        text not null,           -- копия названия, чтобы старые смены не менялись
  start_at         timestamptz not null,    -- в UTC
  end_at           timestamptz not null,
  comment          text,
  evening_sent_at  timestamptz,
  before_sent_at   timestamptz,
  unique (user_id, shift_date),
  check (end_at > start_at)
);
create index shifts_start_idx on public.shifts(start_at);

create table public.absences (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.users(id) on delete cascade,
  kind        text not null check (kind in ('vacation','sick')),
  start_date  date not null,
  end_date    date not null,
  note        text,
  check (end_date >= start_date)
);
create index absences_user_idx on public.absences(user_id, start_date);

create table public.reminders (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references public.users(id) on delete cascade,
  text             text not null check (char_length(text) between 1 and 200),
  remind_at        timestamptz not null,
  advance_minutes  integer not null default 0 check (advance_minutes >= 0),
  repeat           text not null default 'none' check (repeat in ('none','daily','weekly','monthly')),
  repeat_until     date,
  done_at          timestamptz,
  sent_at          timestamptz
);
create index reminders_due_idx on public.reminders(remind_at) where done_at is null;

-- ───────── цикл ─────────
create table public.cycles (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.users(id) on delete cascade,
  start_date  date not null,
  end_date    date,                          -- пусто, пока месячные идут
  check (end_date is null or end_date >= start_date)
);
create index cycles_user_idx on public.cycles(user_id, start_date desc);

create table public.cycle_notes (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.users(id) on delete cascade,
  note_date  date not null,
  feeling    text check (feeling in ('good','ok','bad')),
  pain       text check (pain in ('none','light','strong')),
  mood       text[] not null default '{}',
  flow       text check (flow in ('light','medium','heavy')),
  body       text,
  unique (user_id, note_date)
);

-- ───────── служебное ─────────
create table public.sent_log (
  id       bigint generated always as identity primary key,
  user_id  uuid not null references public.users(id) on delete cascade,
  kind     text not null,
  ref_id   text not null,
  sent_at  timestamptz not null default now(),
  unique (kind, ref_id)
);

create table public.error_log (
  id       bigint generated always as identity primary key,
  at       timestamptz not null default now(),
  source   text not null,
  message  text not null,
  ctx      jsonb                               -- без личных данных
);

-- ───────── защита: RLS включён, политик нет ─────────
alter table public.users          enable row level security;
alter table public.user_settings  enable row level security;
alter table public.habits         enable row level security;
alter table public.habit_logs     enable row level security;
alter table public.shift_types    enable row level security;
alter table public.shifts         enable row level security;
alter table public.absences       enable row level security;
alter table public.reminders      enable row level security;
alter table public.cycles         enable row level security;
alter table public.cycle_notes    enable row level security;
alter table public.sent_log       enable row level security;
alter table public.error_log      enable row level security;

revoke all on all tables in schema public from anon, authenticated;

-- ───────── автоудаление старых данных ─────────
-- Перед удалением отметок привычек сохраняем итоги в самой привычке.
create or replace function public.cleanup_old_data() returns void
language plpgsql security definer set search_path = public as $$
begin
  update habits h
     set total_done = h.total_done + c.n
    from (select habit_id, count(*) n from habit_logs
           where status = 'done' and log_date < current_date - interval '12 months'
           group by habit_id) c
   where c.habit_id = h.id;

  delete from habit_logs  where log_date   < current_date - interval '12 months';
  delete from shifts      where shift_date < current_date - interval '12 months';
  delete from absences    where end_date   < current_date - interval '12 months';
  delete from reminders   where remind_at  < now() - interval '12 months' and repeat = 'none';
  delete from cycle_notes where note_date  < current_date - interval '12 months';
  delete from cycles      where start_date < current_date - interval '24 months';
  delete from sent_log    where sent_at    < now() - interval '30 days';
  delete from error_log   where at         < now() - interval '60 days';
end $$;

revoke all on function public.cleanup_old_data() from public, anon, authenticated;
