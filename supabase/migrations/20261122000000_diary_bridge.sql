-- 약효일지 MCP 브리지 (B단계) — 확정 기록, 에이전트 연결, 추가 요청(승인 대기), 가져오기 추적
-- 원칙
--   * 모든 노출 테이블에 RLS. 기본 권한은 회수하고 필요한 작업만 열 단위로 다시 준다.
--   * 사용자 식별자는 auth.uid()와 diary_agent_links에서만 결정한다(payload·요청 인자 user_id 불신).
--   * 에이전트는 연결된 사용자 1명의 확정 기록 조회 + 자기 추가 요청 생성만 가능하다.
--   * 확정 기록은 사용자 본인의 승인 함수(SECURITY INVOKER)에서만 agent_request 출처로 생긴다.
--   * SECURITY DEFINER 함수 없음. service_role 불필요.
-- 이 파일은 추가 전용이다. 이후 변경은 새 마이그레이션으로 한다(테이블 삭제 금지).

set check_function_bodies = off;

-- ─────────────────────────────────────────────────────────────
-- 1. 값 검증 (브라우저 cloud-bridge.js, workers/mcp/src/schema.ts와 같은 목록 — tests/bridge-schema-sync.test.js가 대조)
-- ─────────────────────────────────────────────────────────────
create or replace function public.diary_is_plain_text(p jsonb, p_max int)
returns boolean language sql immutable parallel safe set search_path = '' as $$
  select jsonb_typeof(p) = 'string'
     and char_length(p #>> '{}') between 1 and p_max
     and (p #>> '{}') !~ '[[:cntrl:]]'
     and btrim(p #>> '{}') = (p #>> '{}')
$$;

create or replace function public.diary_is_num_between(p jsonb, p_min numeric, p_max numeric)
returns boolean language sql immutable parallel safe set search_path = '' as $$
  select p is null or jsonb_typeof(p) = 'null'
      or (jsonb_typeof(p) = 'number' and (p #>> '{}')::numeric between p_min and p_max)
$$;

create or replace function public.diary_is_enum(p jsonb, p_allowed text[])
returns boolean language sql immutable parallel safe set search_path = '' as $$
  select p is null or jsonb_typeof(p) = 'null'
      or (jsonb_typeof(p) = 'string' and (p #>> '{}') = any (p_allowed))
$$;

create or replace function public.diary_is_enum_array(p jsonb, p_allowed text[], p_max int)
returns boolean language sql immutable parallel safe set search_path = '' as $$
  select p is null or jsonb_typeof(p) = 'null'
      or (jsonb_typeof(p) = 'array'
          and jsonb_array_length(p) <= p_max
          and not exists (
            select 1 from jsonb_array_elements(p) e
             where jsonb_typeof(e) <> 'string' or (e #>> '{}') <> all (p_allowed))
          and (select count(distinct e #>> '{}') from jsonb_array_elements(p) e) = jsonb_array_length(p))
$$;

create or replace function public.diary_payload_valid(p_kind text, p jsonb)
returns boolean language plpgsql immutable parallel safe set search_path = '' as $$
declare
  k text;
  allowed text[];
begin
  if p is null or jsonb_typeof(p) <> 'object' then return false; end if;
  if p_kind = 'med' then
    allowed := array['drug','dose_mg'];
  elsif p_kind = 'state' then
    allowed := array['state','output','trend','gait','dysk','symptoms'];
  elsif p_kind = 'life' then
    allowed := array['kind','phase','meal_type','amount','extras','quality','ex_type','intensity','duration_min','consistency','body_symptoms'];
  else
    return false;
  end if;
  for k in select jsonb_object_keys(p) loop
    if not (k = any (allowed)) then return false; end if;
  end loop;

  if p_kind = 'med' then
    return public.diary_is_plain_text(p -> 'drug', 80)
       and public.diary_is_num_between(p -> 'dose_mg', 0.001, 5000);
  elsif p_kind = 'state' then
    return (p ? 'state')
       and public.diary_is_enum(p -> 'state', array['wake','off','rising','on','falling','signal','partial','dysk','dyst','wearoff'])
       and jsonb_typeof(p -> 'state') = 'string'
       and public.diary_is_num_between(p -> 'output', 0, 100)
       and public.diary_is_enum(p -> 'trend', array['rising','stable','falling'])
       and public.diary_is_num_between(p -> 'gait', 0, 10)
       and public.diary_is_num_between(p -> 'dysk', 0, 10)
       and public.diary_is_enum_array(p -> 'symptoms', array['dysk','dyst','tremor','freeze','rigid','pain','toecurl','gait_unstable'], 8);
  else
    return (p ? 'kind') and jsonb_typeof(p -> 'kind') = 'string'
       and public.diary_is_enum(p -> 'kind', array['sleep','meal','exercise','bowel','body'])
       and public.diary_is_enum(p -> 'phase', array['start','end','nap'])
       and public.diary_is_enum(p -> 'meal_type', array['아침','점심','저녁','간식'])
       and public.diary_is_enum(p -> 'amount', array['소량','보통','과식'])
       and public.diary_is_enum_array(p -> 'extras', array['단백질 많음','기름진 식사','힘들었음','잔변감'], 4)
       and public.diary_is_enum_array(p -> 'quality', array['숙면','자주 깸','잠들기 어려움','REM 행동 의심'], 4)
       and public.diary_is_enum(p -> 'ex_type', array['걷기','실내자전거','근력','탁구','등산'])
       and public.diary_is_enum(p -> 'intensity', array['가벼움','보통','강함'])
       and public.diary_is_num_between(p -> 'duration_min', 0, 1440)
       and public.diary_is_enum(p -> 'consistency', array['딱딱함','보통','묽음'])
       and public.diary_is_enum_array(p -> 'body_symptoms', array['이상 없음','어지럼','기립 시 어지럼','소변 급박','빈뇨','땀 증가','침 흘림','메스꺼움','극심한 피로','불안','졸림','통증'], 12);
  end if;
end $$;

-- 정규화 입력 해시: kind + epoch ms + jsonb 정규 텍스트(jsonb는 키 순서를 정규화한다)
create or replace function public.diary_input_hash(p_kind text, p_occurred_at timestamptz, p_payload jsonb)
returns text language sql immutable parallel safe set search_path = '' as $$
  select encode(sha256(convert_to(
    p_kind || '|' || ((extract(epoch from p_occurred_at) * 1000)::bigint)::text || '|' || p_payload::text,
    'UTF8')), 'hex')
$$;

create or replace function public.diary_valid_tz(p text)
returns boolean language sql immutable parallel safe set search_path = '' as $$
  select p is not null and char_length(p) between 1 and 64 and p ~ '^[A-Za-z0-9_+/-]+$'
$$;

-- ─────────────────────────────────────────────────────────────
-- 2. 테이블
-- ─────────────────────────────────────────────────────────────
create table if not exists public.diary_agent_links (
  agent_id    uuid primary key references auth.users (id) on delete cascade,
  owner_id    uuid not null references auth.users (id) on delete cascade,
  scopes      text[] not null default array['read','request_write'],
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null,
  revoked_at  timestamptz,
  constraint diary_agent_links_distinct check (agent_id <> owner_id),
  constraint diary_agent_links_scopes check (cardinality(scopes) > 0 and scopes <@ array['read','request_write'])
);
create index if not exists diary_agent_links_owner_idx on public.diary_agent_links (owner_id);

create table if not exists public.diary_events (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references auth.users (id) on delete cascade,
  kind           text not null check (kind in ('med','state','life')),
  occurred_at    timestamptz not null,
  source_tz      text not null check (public.diary_valid_tz(source_tz)),
  schema_version smallint not null default 1 check (schema_version = 1),
  payload        jsonb not null,
  source         text not null check (source in ('browser_upload','agent_request')),
  legacy_id      text check (legacy_id is null or legacy_id ~ '^[A-Za-z0-9_.:-]{1,64}$'),
  input_hash     text not null,
  created_at     timestamptz not null default now(),
  constraint diary_events_payload_valid check (public.diary_payload_valid(kind, payload)),
  constraint diary_events_legacy_source check ((source = 'browser_upload') = (legacy_id is not null)),
  constraint diary_events_user_legacy_unique unique (user_id, legacy_id)
);
create index if not exists diary_events_user_time_idx on public.diary_events (user_id, occurred_at, id);
create index if not exists diary_events_user_hash_idx on public.diary_events (user_id, input_hash);

create table if not exists public.diary_pending_events (
  id                 uuid primary key default gen_random_uuid(),
  agent_id           uuid not null references auth.users (id) on delete cascade,
  owner_id           uuid not null references auth.users (id) on delete cascade,
  request_id         text not null check (request_id ~ '^[A-Za-z0-9_.:-]{8,100}$'),
  kind               text not null check (kind in ('med','state','life')),
  occurred_at        timestamptz not null,
  source_tz          text not null check (public.diary_valid_tz(source_tz)),
  payload            jsonb not null,
  input_hash         text not null,
  status             text not null default 'pending' check (status in ('pending','approved','rejected')),
  created_at         timestamptz not null default now(),
  expires_at         timestamptz not null default (now() + interval '72 hours'),
  decided_at         timestamptz,
  confirmed_event_id uuid references public.diary_events (id),
  constraint diary_pending_payload_valid check (public.diary_payload_valid(kind, payload)),
  constraint diary_pending_agent_request_unique unique (agent_id, request_id),
  constraint diary_pending_decision check (
    (status = 'pending'  and decided_at is null and confirmed_event_id is null) or
    (status = 'approved' and decided_at is not null and confirmed_event_id is not null) or
    (status = 'rejected' and decided_at is not null and confirmed_event_id is null))
);
create index if not exists diary_pending_owner_idx on public.diary_pending_events (owner_id, status, created_at);
create unique index if not exists diary_pending_confirmed_unique on public.diary_pending_events (confirmed_event_id) where confirmed_event_id is not null;

create table if not exists public.diary_import_requests (
  user_id     uuid not null references auth.users (id) on delete cascade,
  request_key text not null check (request_key ~ '^[A-Za-z0-9_.:-]{8,100}$'),
  items_hash  text not null,
  item_count  int not null check (item_count between 1 and 200),
  created_at  timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  primary key (user_id, request_key)
);

-- ─────────────────────────────────────────────────────────────
-- 3. 인증 문맥 도우미 (SECURITY INVOKER — 호출자 RLS 아래에서 자기 연결 행만 보인다)
-- ─────────────────────────────────────────────────────────────
create or replace function public.diary_is_agent()
returns boolean language sql stable security invoker set search_path = '' as $$
  select exists (select 1 from public.diary_agent_links l where l.agent_id = (select auth.uid()))
$$;

create or replace function public.diary_agent_owner(p_scope text)
returns uuid language sql stable security invoker set search_path = '' as $$
  select l.owner_id from public.diary_agent_links l
   where l.agent_id = (select auth.uid())
     and l.revoked_at is null
     and l.expires_at > now()
     and p_scope = any (l.scopes)
$$;

-- ─────────────────────────────────────────────────────────────
-- 4. 트리거
-- ─────────────────────────────────────────────────────────────
-- 연결: 관리자만 생성(INSERT 권한 없음). 사용자는 revoked_at을 한 번만 설정할 수 있다.
create or replace function public.diary_agent_links_guard()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if tg_op = 'INSERT' then
    if exists (select 1 from public.diary_agent_links l where l.agent_id = new.owner_id)
       or exists (select 1 from public.diary_agent_links l where l.owner_id = new.agent_id)
       or exists (select 1 from public.diary_events e where e.user_id = new.agent_id) then
      raise exception 'AGENT_ACCOUNT_ROLE_CONFLICT' using errcode = '23514';
    end if;
    return new;
  end if;
  if new.agent_id <> old.agent_id or new.owner_id <> old.owner_id or new.scopes <> old.scopes
     or new.created_at <> old.created_at or new.expires_at <> old.expires_at then
    raise exception 'LINK_IMMUTABLE' using errcode = '42501';
  end if;
  if old.revoked_at is not null and new.revoked_at is distinct from old.revoked_at then
    raise exception 'LINK_ALREADY_REVOKED' using errcode = '42501';
  end if;
  if new.revoked_at is not null and new.revoked_at > now() + interval '1 minute' then
    raise exception 'LINK_REVOKE_FUTURE' using errcode = '22023';
  end if;
  return new;
end $$;

drop trigger if exists diary_agent_links_guard on public.diary_agent_links;
create trigger diary_agent_links_guard before insert or update on public.diary_agent_links
  for each row execute function public.diary_agent_links_guard();

-- 확정 기록: 해시는 서버가 계산. agent_request 출처는 승인 함수 안에서만.
create or replace function public.diary_events_before_insert()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  new.input_hash := public.diary_input_hash(new.kind, new.occurred_at, new.payload);
  new.created_at := now();
  new.schema_version := 1;
  if new.source = 'agent_request' and coalesce(current_setting('diary.decision', true), '') <> 'on' then
    raise exception 'AGENT_SOURCE_REQUIRES_APPROVAL' using errcode = '42501';
  end if;
  return new;
end $$;

drop trigger if exists diary_events_before_insert on public.diary_events;
create trigger diary_events_before_insert before insert on public.diary_events
  for each row execute function public.diary_events_before_insert();

-- 추가 요청: 소유자·에이전트·상태는 인증 문맥에서 결정한다.
create or replace function public.diary_pending_before_insert()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare
  v_owner uuid;
begin
  v_owner := public.diary_agent_owner('request_write');
  if v_owner is null then
    raise exception 'AGENT_LINK_INVALID' using errcode = '42501';
  end if;
  new.agent_id := (select auth.uid());
  new.owner_id := v_owner;
  new.input_hash := public.diary_input_hash(new.kind, new.occurred_at, new.payload);
  new.status := 'pending';
  new.created_at := now();
  new.expires_at := now() + interval '72 hours';
  new.decided_at := null;
  new.confirmed_event_id := null;
  return new;
end $$;

drop trigger if exists diary_pending_before_insert on public.diary_pending_events;
create trigger diary_pending_before_insert before insert on public.diary_pending_events
  for each row execute function public.diary_pending_before_insert();

create or replace function public.diary_pending_before_update()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  if coalesce(current_setting('diary.decision', true), '') <> 'on' then
    raise exception 'PENDING_UPDATE_REQUIRES_DECISION_FUNCTION' using errcode = '42501';
  end if;
  if old.status <> 'pending' then
    raise exception 'PENDING_ALREADY_DECIDED' using errcode = '42501';
  end if;
  if (new.id, new.agent_id, new.owner_id, new.request_id, new.kind, new.occurred_at, new.source_tz, new.payload, new.input_hash, new.created_at, new.expires_at)
     is distinct from
     (old.id, old.agent_id, old.owner_id, old.request_id, old.kind, old.occurred_at, old.source_tz, old.payload, old.input_hash, old.created_at, old.expires_at) then
    raise exception 'PENDING_IMMUTABLE' using errcode = '42501';
  end if;
  return new;
end $$;

drop trigger if exists diary_pending_before_update on public.diary_pending_events;
create trigger diary_pending_before_update before update on public.diary_pending_events
  for each row execute function public.diary_pending_before_update();

-- ─────────────────────────────────────────────────────────────
-- 5. RLS와 권한
-- ─────────────────────────────────────────────────────────────
alter table public.diary_agent_links     enable row level security;
alter table public.diary_events          enable row level security;
alter table public.diary_pending_events  enable row level security;
alter table public.diary_import_requests enable row level security;

revoke all on table public.diary_agent_links, public.diary_events, public.diary_pending_events, public.diary_import_requests
  from public, anon, authenticated;

-- 연결
grant select on table public.diary_agent_links to authenticated;
grant update (revoked_at) on table public.diary_agent_links to authenticated;
create policy diary_agent_links_select on public.diary_agent_links
  for select to authenticated
  using (owner_id = (select auth.uid()) or agent_id = (select auth.uid()));
create policy diary_agent_links_owner_revoke on public.diary_agent_links
  for update to authenticated
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));

-- 확정 기록: 사용자 본인 조회·추가, 연결된 에이전트는 read 범위 조회만
grant select, insert (kind, occurred_at, source_tz, payload, source, legacy_id, user_id) on table public.diary_events to authenticated;
create policy diary_events_owner_select on public.diary_events
  for select to authenticated
  using (user_id = (select auth.uid()) and not public.diary_is_agent());
create policy diary_events_agent_select on public.diary_events
  for select to authenticated
  using (user_id = public.diary_agent_owner('read'));
create policy diary_events_owner_insert on public.diary_events
  for insert to authenticated
  with check (user_id = (select auth.uid()) and not public.diary_is_agent());

-- 추가 요청: 에이전트는 자기 요청 생성·조회, 사용자는 자기 앞으로 온 요청 조회·결정
grant select, insert (request_id, kind, occurred_at, source_tz, payload) on table public.diary_pending_events to authenticated;
grant update (status, decided_at, confirmed_event_id) on table public.diary_pending_events to authenticated;
create policy diary_pending_select on public.diary_pending_events
  for select to authenticated
  using (owner_id = (select auth.uid()) or agent_id = (select auth.uid()));
create policy diary_pending_agent_insert on public.diary_pending_events
  for insert to authenticated
  with check (agent_id = (select auth.uid()) and owner_id = public.diary_agent_owner('request_write'));
create policy diary_pending_owner_decide on public.diary_pending_events
  for update to authenticated
  using (owner_id = (select auth.uid()) and not public.diary_is_agent())
  with check (owner_id = (select auth.uid()));

-- 가져오기 요청 추적: 본인만
grant select, insert (user_id, request_key, items_hash, item_count) on table public.diary_import_requests to authenticated;
grant update (last_seen_at) on table public.diary_import_requests to authenticated;
create policy diary_import_requests_owner on public.diary_import_requests
  for all to authenticated
  using (user_id = (select auth.uid()) and not public.diary_is_agent())
  with check (user_id = (select auth.uid()) and not public.diary_is_agent());

-- ─────────────────────────────────────────────────────────────
-- 6. RPC (전부 SECURITY INVOKER)
-- ─────────────────────────────────────────────────────────────
-- 에이전트: 현재 유효한 연결
create or replace function public.my_agent_link()
returns table (owner_id uuid, scopes text[], expires_at timestamptz)
language sql stable security invoker set search_path = '' as $$
  select l.owner_id, l.scopes, l.expires_at from public.diary_agent_links l
   where l.agent_id = (select auth.uid()) and l.revoked_at is null and l.expires_at > now()
$$;

-- 에이전트: 추가 요청 생성(멱등). 같은 request_id+같은 내용 → 기존 결과, 다른 내용 → CONFLICT
create or replace function public.create_pending_event(
  p_request_id text, p_kind text, p_occurred_at timestamptz, p_source_tz text, p_payload jsonb)
returns table (pending_id uuid, status text, expires_at timestamptz, created boolean)
language plpgsql volatile security invoker set search_path = '' as $$
declare
  v_hash text := public.diary_input_hash(p_kind, p_occurred_at, p_payload);
  v_id uuid;
  r record;
begin
  if (select auth.uid()) is null then
    raise exception 'NOT_AUTHENTICATED' using errcode = '42501';
  end if;
  insert into public.diary_pending_events (request_id, kind, occurred_at, source_tz, payload)
  values (p_request_id, p_kind, p_occurred_at, p_source_tz, p_payload)
  on conflict on constraint diary_pending_agent_request_unique do nothing
  returning id into v_id;

  select p.id, p.status, p.expires_at, p.input_hash into r
    from public.diary_pending_events p
   where p.agent_id = (select auth.uid()) and p.request_id = p_request_id;
  if not found then
    raise exception 'AGENT_LINK_INVALID' using errcode = '42501';
  end if;
  if v_id is null and r.input_hash <> v_hash then
    raise exception 'CONFLICT: request_id already used with different content' using errcode = 'PT409';
  end if;
  return query select r.id,
    case when r.status = 'pending' and r.expires_at <= now() then 'expired' else r.status end,
    r.expires_at, v_id is not null;
end $$;

-- 사용자: 승인(한 트랜잭션, 재승인 시 같은 이벤트 ID)
create or replace function public.approve_pending_event(p_pending_id uuid)
returns uuid
language plpgsql volatile security invoker set search_path = '' as $$
declare
  r record;
  v_event uuid;
begin
  if (select auth.uid()) is null or public.diary_is_agent() then
    raise exception 'NOT_ALLOWED' using errcode = '42501';
  end if;
  select * into r from public.diary_pending_events p
   where p.id = p_pending_id and p.owner_id = (select auth.uid())
   for update;
  if not found then
    raise exception 'NOT_FOUND' using errcode = 'PT404';
  end if;
  if r.status = 'approved' then
    return r.confirmed_event_id;
  elsif r.status = 'rejected' then
    raise exception 'ALREADY_REJECTED' using errcode = 'PT410';
  elsif r.expires_at <= now() then
    raise exception 'EXPIRED' using errcode = 'PT410';
  end if;

  perform set_config('diary.decision', 'on', true);
  insert into public.diary_events (user_id, kind, occurred_at, source_tz, payload, source, legacy_id)
  values ((select auth.uid()), r.kind, r.occurred_at, r.source_tz, r.payload, 'agent_request', null)
  returning id into v_event;
  update public.diary_pending_events
     set status = 'approved', decided_at = now(), confirmed_event_id = v_event
   where id = r.id;
  perform set_config('diary.decision', 'off', true);
  return v_event;
end $$;

-- 사용자: 거절
create or replace function public.reject_pending_event(p_pending_id uuid)
returns text
language plpgsql volatile security invoker set search_path = '' as $$
declare
  r record;
begin
  if (select auth.uid()) is null or public.diary_is_agent() then
    raise exception 'NOT_ALLOWED' using errcode = '42501';
  end if;
  select * into r from public.diary_pending_events p
   where p.id = p_pending_id and p.owner_id = (select auth.uid())
   for update;
  if not found then
    raise exception 'NOT_FOUND' using errcode = 'PT404';
  end if;
  if r.status = 'rejected' then return 'rejected'; end if;
  if r.status = 'approved' then
    raise exception 'ALREADY_APPROVED' using errcode = 'PT410';
  end if;
  perform set_config('diary.decision', 'on', true);
  update public.diary_pending_events set status = 'rejected', decided_at = now() where id = r.id;
  perform set_config('diary.decision', 'off', true);
  return 'rejected';
end $$;

-- 사용자: 승인 대기 목록 + 중복 후보(같은 정규화 내용의 확정 기록/다른 대기 요청)
create or replace function public.list_my_pending_events()
returns table (
  id uuid, agent_id uuid, request_id text, kind text, occurred_at timestamptz, source_tz text,
  payload jsonb, status text, created_at timestamptz, expires_at timestamptz,
  duplicate_event_id uuid, duplicate_pending_count int)
language sql stable security invoker set search_path = '' as $$
  select p.id, p.agent_id, p.request_id, p.kind, p.occurred_at, p.source_tz, p.payload,
         case when p.status = 'pending' and p.expires_at <= now() then 'expired' else p.status end,
         p.created_at, p.expires_at,
         (select e.id from public.diary_events e
           where e.user_id = p.owner_id and e.input_hash = p.input_hash
           order by e.created_at limit 1),
         (select count(*)::int from public.diary_pending_events q
           where q.owner_id = p.owner_id and q.input_hash = p.input_hash and q.id <> p.id and q.status = 'pending')
    from public.diary_pending_events p
   where p.owner_id = (select auth.uid()) and p.status = 'pending'
   order by p.occurred_at, p.id
   limit 200
$$;

-- 사용자: 브라우저 가져오기(멱등). 항목마다 inserted / already / conflict / invalid
create or replace function public.import_diary_events(p_request_key text, p_items jsonb)
returns jsonb
language plpgsql volatile security invoker set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_items_hash text;
  v_existing record;
  it jsonb;
  v_kind text; v_at timestamptz; v_tz text; v_payload jsonb; v_legacy text; v_hash text;
  v_id uuid;
  v_results jsonb := '[]'::jsonb;
begin
  if v_uid is null or public.diary_is_agent() then
    raise exception 'NOT_ALLOWED' using errcode = '42501';
  end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) not between 1 and 200 then
    raise exception 'ITEMS_OUT_OF_RANGE' using errcode = '22023';
  end if;
  v_items_hash := encode(sha256(convert_to(p_items::text, 'UTF8')), 'hex');

  insert into public.diary_import_requests (user_id, request_key, items_hash, item_count)
  values (v_uid, p_request_key, v_items_hash, jsonb_array_length(p_items))
  on conflict (user_id, request_key) do nothing;
  select * into v_existing from public.diary_import_requests r where r.user_id = v_uid and r.request_key = p_request_key;
  if v_existing.items_hash <> v_items_hash then
    raise exception 'CONFLICT: request_key already used with different items' using errcode = 'PT409';
  end if;
  update public.diary_import_requests set last_seen_at = now() where user_id = v_uid and request_key = p_request_key;

  for it in select * from jsonb_array_elements(p_items) loop
    v_legacy := it ->> 'legacy_id';
    v_kind := it ->> 'kind';
    v_tz := it ->> 'source_tz';
    v_payload := it -> 'payload';
    begin
      v_at := (it ->> 'occurred_at')::timestamptz;
    exception when others then
      v_at := null;
    end;
    if v_legacy is null or v_legacy !~ '^[A-Za-z0-9_.:-]{1,64}$' or v_at is null
       or v_kind is null or not public.diary_valid_tz(v_tz)
       or not public.diary_payload_valid(v_kind, v_payload) then
      v_results := v_results || jsonb_build_object('legacy_id', v_legacy, 'result', 'invalid');
      continue;
    end if;
    v_hash := public.diary_input_hash(v_kind, v_at, v_payload);

    v_id := null;
    insert into public.diary_events (user_id, kind, occurred_at, source_tz, payload, source, legacy_id)
    values (v_uid, v_kind, v_at, v_tz, v_payload, 'browser_upload', v_legacy)
    on conflict on constraint diary_events_user_legacy_unique do nothing
    returning id into v_id;

    if v_id is not null then
      v_results := v_results || jsonb_build_object('legacy_id', v_legacy, 'result', 'inserted', 'id', v_id);
    else
      select e.id, e.input_hash into v_existing from public.diary_events e
       where e.user_id = v_uid and e.legacy_id = v_legacy;
      v_results := v_results || jsonb_build_object('legacy_id', v_legacy,
        'result', case when v_existing.input_hash = v_hash then 'already' else 'conflict' end,
        'id', v_existing.id);
    end if;
  end loop;
  return v_results;
end $$;

-- 사용자: 본인 연결 폐기
create or replace function public.revoke_agent_link(p_agent_id uuid)
returns timestamptz
language plpgsql volatile security invoker set search_path = '' as $$
declare
  v_at timestamptz;
begin
  update public.diary_agent_links set revoked_at = now()
   where agent_id = p_agent_id and owner_id = (select auth.uid()) and revoked_at is null
  returning revoked_at into v_at;
  if v_at is null then
    select revoked_at into v_at from public.diary_agent_links
     where agent_id = p_agent_id and owner_id = (select auth.uid());
    if v_at is null then
      raise exception 'NOT_FOUND' using errcode = 'PT404';
    end if;
  end if;
  return v_at;
end $$;

-- 함수 실행 권한: 기본(PUBLIC) 회수 → authenticated에만
do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname like any (array['diary\_%','my\_agent\_link','create\_pending\_event',
       'approve\_pending\_event','reject\_pending\_event','list\_my\_pending\_events','import\_diary\_events','revoke\_agent\_link'])
  loop
    execute format('revoke all on function %s from public, anon', f.sig);
    execute format('grant execute on function %s to authenticated', f.sig);
  end loop;
end $$;
