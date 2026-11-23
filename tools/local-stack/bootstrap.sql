-- 로컬 시험 전용: Docker 없이 일반 PostgreSQL 위에 Supabase 호환 역할·스키마를 만든다.
-- 실제 Supabase 프로젝트에는 이미 있으므로 절대 원격에서 실행하지 않는다.
-- 비밀번호는 로컬 루프백 전용 더미값이다.
do $$ begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin noinherit bypassrls; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticator') then
    create role authenticator login noinherit password 'local-authenticator';
  end if;
  if not exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') then
    create role supabase_auth_admin login createrole noinherit password 'local-auth-admin';
  end if;
end $$;

grant anon, authenticated, service_role to authenticator;

create schema if not exists auth authorization supabase_auth_admin;
grant usage on schema auth to anon, authenticated, service_role, postgres;
alter role supabase_auth_admin set search_path = auth;

create schema if not exists extensions;
grant usage on schema public, extensions to anon, authenticated, service_role;

-- Supabase 기본값 재현: public 객체에 anon/authenticated 기본 권한이 붙는다.
-- (마이그레이션이 이를 명시적으로 회수하는지 시험하기 위해 일부러 똑같이 만든다)
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
