-- Серверная функция работает через роль service_role. Права выдаём только ей:
-- anon и authenticated по-прежнему ничего не видят.
-- Нужно, если в проекте выключена опция «Automatically expose new tables».
grant usage on schema public to service_role;
grant select, insert, update, delete on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to service_role;
alter default privileges in schema public grant select, insert, update, delete on tables to service_role;
alter default privileges in schema public grant usage, select on sequences to service_role;
