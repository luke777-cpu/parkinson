-- AI별 "바로 기록" 스위치 (사용자 결정 2026-11-23: 복용 포함 전부 바로, 대신 한도 검사 + 24시간 취소)
--   · 연결마다 auto_write(기본 꺼짐). 사용자 본인만 켜고 끈다(직접 로그인 세션, OAuth 토큰 불가).
--   · 켜진 AI의 요청은 한도 검사를 통과하면 즉시 확정(source = 'agent_auto'), 아니면 기존처럼 승인 대기.
--     한도: 시각(최근 24시간~5분 뒤), 복용 용량(있어야 하고 1000mg 이하), 같은 내용 확정 기록,
--           가까운 시각 비슷한 기록(복용: 같은 약 30분, 상태: 10분, 생활: 같은 종류 30분), 시간당 20건.
--   · 자동 확정 기록은 24시간 안에 사용자가 취소(삭제)할 수 있다. 요청 행은 'undone'으로 남는다.
--   · 계속 SECURITY INVOKER + RLS. 자동 확정 경로는 함수가 세우는 트랜잭션 GUC(diary.auto)로만 열린다.
-- 추가 전용(테이블 삭제 없음). 기존 create_pending_event는 그대로 둔다(구 Worker 호환).

set check_function_bodies = off;

-- 1. 컬럼·제약
alter table public.diary_agent_links add column if not exists auto_write boolean not null default false;
alter table public.diary_pending_events add column if not exists auto boolean not null default false;
-- 앱에서 연결을 알아보기 위한 이름(예: ChatGPT). 관리자만 정한다(사용자 수정 권한 없음).
alter table public.diary_agent_links add column if not exists label text
  check (label is null or (char_length(label) between 1 and 40 and label !~ '[[:cntrl:]]'));

alter table public.diary_events drop constraint if exists diary_events_source_check;
alter table public.diary_events add constraint diary_events_source_check
  check (source in ('browser_upload','agent_request','agent_auto'));

alter table public.diary_pending_events drop constraint if exists diary_pending_events_status_check;
alter table public.diary_pending_events add constraint diary_pending_events_status_check
  check (status in ('pending','approved','rejected','undone'));
alter table public.diary_pending_events drop constraint if exists diary_pending_decision;
alter table public.diary_pending_events add constraint diary_pending_decision check (
  (status = 'pending'  and decided_at is null and confirmed_event_id is null) or
  (status = 'approved' and decided_at is not null and confirmed_event_id is not null) or
  (status = 'rejected' and decided_at is not null and confirmed_event_id is null) or
  (status = 'undone'   and decided_at is not null and confirmed_event_id is null and auto));

-- 2. 트리거 함수 갱신
create or replace function public.diary_events_before_insert()
returns trigger language plpgsql security invoker set search_path = '' as $$
begin
  new.input_hash := public.diary_input_hash(new.kind, new.occurred_at, new.payload);
  new.created_at := now();
  new.schema_version := 1;
  if new.source = 'agent_request' and coalesce(current_setting('diary.decision', true), '') <> 'on' then
    raise exception 'AGENT_SOURCE_REQUIRES_APPROVAL' using errcode = '42501';
  end if;
  if new.source = 'agent_auto' and coalesce(current_setting('diary.auto', true), '') <> 'on' then
    raise exception 'AGENT_AUTO_REQUIRES_FUNCTION' using errcode = '42501';
  end if;
  return new;
end $$;

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
  new.auto := false;
  new.created_at := now();
  new.expires_at := now() + interval '72 hours';
  new.decided_at := null;
  new.confirmed_event_id := null;
  return new;
end $$;

create or replace function public.diary_pending_before_update()
returns trigger language plpgsql security invoker set search_path = '' as $$
declare
  v_decision boolean := coalesce(current_setting('diary.decision', true), '') = 'on';
  v_auto     boolean := coalesce(current_setting('diary.auto', true), '') = 'on';
  v_undo     boolean := coalesce(current_setting('diary.undo', true), '') = 'on';
begin
  if (new.id, new.agent_id, new.owner_id, new.request_id, new.kind, new.occurred_at, new.source_tz, new.payload, new.input_hash, new.created_at, new.expires_at)
     is distinct from
     (old.id, old.agent_id, old.owner_id, old.request_id, old.kind, old.occurred_at, old.source_tz, old.payload, old.input_hash, old.created_at, old.expires_at) then
    raise exception 'PENDING_IMMUTABLE' using errcode = '42501';
  end if;
  if v_undo then
    if not (old.status = 'approved' and old.auto and new.status = 'undone') then
      raise exception 'PENDING_UNDO_INVALID' using errcode = '42501';
    end if;
    return new;
  end if;
  if not (v_decision or v_auto) then
    raise exception 'PENDING_UPDATE_REQUIRES_DECISION_FUNCTION' using errcode = '42501';
  end if;
  if old.status <> 'pending' then
    raise exception 'PENDING_ALREADY_DECIDED' using errcode = '42501';
  end if;
  if v_auto and not (new.status = 'approved' and new.auto) then
    raise exception 'PENDING_AUTO_INVALID' using errcode = '42501';
  end if;
  if v_decision and not v_auto and new.auto <> old.auto then
    raise exception 'PENDING_IMMUTABLE' using errcode = '42501';
  end if;
  return new;
end $$;

-- 3. 권한·정책
grant update (auto_write) on table public.diary_agent_links to authenticated;
grant update (auto) on table public.diary_pending_events to authenticated;
grant delete on table public.diary_events to authenticated;

create or replace function public.diary_auto_write_on()
returns boolean language sql stable security invoker set search_path = '' as $$
  select exists (select 1 from public.diary_agent_links l
                  where l.agent_id = (select auth.uid()) and l.auto_write
                    and l.revoked_at is null and l.expires_at > now()
                    and 'request_write' = any (l.scopes))
$$;

-- 에이전트: 자동 확정 기록 추가(함수 안 GUC + 스위치 켜짐 + 연결된 주인 앞으로만)
create policy diary_events_agent_auto_insert on public.diary_events
  for insert to authenticated
  with check (source = 'agent_auto'
              and user_id = public.diary_agent_owner('request_write')
              and public.diary_auto_write_on()
              and coalesce(current_setting('diary.auto', true), '') = 'on');
-- 사용자: 자동 확정 기록 24시간 안 취소(함수 안 GUC)
create policy diary_events_owner_undo on public.diary_events
  for delete to authenticated
  using (user_id = (select auth.uid()) and not public.diary_is_agent()
         and source = 'agent_auto' and created_at > now() - interval '24 hours'
         and coalesce(current_setting('diary.undo', true), '') = 'on');
-- 에이전트: 자기 요청을 자동 확정으로 바꾸기(함수 안 GUC)
create policy diary_pending_agent_auto on public.diary_pending_events
  for update to authenticated
  using (agent_id = (select auth.uid()) and public.diary_auto_write_on()
         and coalesce(current_setting('diary.auto', true), '') = 'on')
  with check (agent_id = (select auth.uid()));

-- OAuth 토큰 상한 조정: 에이전트의 자동 확정 경로만 추가로 허용, 삭제는 불가
alter policy diary_events_oauth_insert_cap on public.diary_events
  with check (not public.diary_via_oauth_client() or (source = 'agent_auto' and public.diary_is_agent()));
alter policy diary_pending_oauth_update_cap on public.diary_pending_events
  using (not public.diary_via_oauth_client()
         or (agent_id = (select auth.uid()) and coalesce(current_setting('diary.auto', true), '') = 'on'));
create policy diary_events_oauth_delete_cap on public.diary_events
  as restrictive for delete to authenticated
  using (not public.diary_via_oauth_client());

-- 4. RPC
-- 에이전트: 요청 생성 + (스위치 켜짐 & 한도 통과 시) 즉시 확정. 같은 request_id 재시도는 처음 결과.
create or replace function public.create_agent_event(
  p_request_id text, p_kind text, p_occurred_at timestamptz, p_source_tz text, p_payload jsonb)
returns table (pending_id uuid, status text, expires_at timestamptz, created boolean,
               event_id uuid, auto boolean, auto_reason text)
language plpgsql volatile security invoker set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  v_hash text := public.diary_input_hash(p_kind, p_occurred_at, p_payload);
  v_owner uuid;
  v_id uuid;
  v_event uuid;
  v_reason text := null;
  v_dose numeric;
  r record;
begin
  if v_uid is null then
    raise exception 'NOT_AUTHENTICATED' using errcode = '42501';
  end if;
  insert into public.diary_pending_events (request_id, kind, occurred_at, source_tz, payload)
  values (p_request_id, p_kind, p_occurred_at, p_source_tz, p_payload)
  on conflict on constraint diary_pending_agent_request_unique do nothing
  returning id into v_id;

  if v_id is null then
    select p.id, p.status, p.expires_at, p.input_hash, p.confirmed_event_id, p.auto into r
      from public.diary_pending_events p where p.agent_id = v_uid and p.request_id = p_request_id;
    if not found then
      raise exception 'AGENT_LINK_INVALID' using errcode = '42501';
    end if;
    if r.input_hash <> v_hash then
      raise exception 'CONFLICT: request_id already used with different content' using errcode = 'PT409';
    end if;
    return query select r.id,
      case when r.status = 'pending' and r.expires_at <= now() then 'expired' else r.status end,
      r.expires_at, false, r.confirmed_event_id, r.auto, null::text;
    return;
  end if;

  -- 새 요청: 자동 확정 판단
  if not public.diary_auto_write_on() then
    v_reason := 'AUTO_OFF';
  else
    v_owner := public.diary_agent_owner('request_write');
    if p_occurred_at < now() - interval '24 hours' or p_occurred_at > now() + interval '5 minutes' then
      v_reason := 'TIME_WINDOW';
    elsif p_kind = 'med' then
      if jsonb_typeof(p_payload -> 'dose_mg') is distinct from 'number' then
        v_reason := 'DOSE_MISSING';
      else
        v_dose := (p_payload ->> 'dose_mg')::numeric;
        if v_dose > 1000 then v_reason := 'DOSE_LIMIT'; end if;
      end if;
    end if;
    if v_reason is null and public.diary_agent_owner('read') is null then
      v_reason := 'NO_READ_SCOPE';  -- 중복 검사를 할 수 없으면 사람이 확인
    end if;
    if v_reason is null and exists (
         select 1 from public.diary_events e where e.user_id = v_owner and e.input_hash = v_hash) then
      v_reason := 'DUPLICATE';
    end if;
    if v_reason is null and exists (
         select 1 from public.diary_events e
          where e.user_id = v_owner and e.kind = p_kind
            and abs(extract(epoch from (e.occurred_at - p_occurred_at))) <=
                case p_kind when 'state' then 600 else 1800 end
            and case p_kind
                  when 'med'  then e.payload ->> 'drug' = p_payload ->> 'drug'
                  when 'life' then e.payload ->> 'kind' = p_payload ->> 'kind'
                  else true end) then
      v_reason := 'NEAR_DUPLICATE';
    end if;
    if v_reason is null and (
         select count(*) from public.diary_pending_events p
          where p.agent_id = v_uid and p.auto and p.decided_at > now() - interval '1 hour') >= 20 then
      v_reason := 'RATE_LIMIT';
    end if;
  end if;

  if v_reason is null then
    perform set_config('diary.auto', 'on', true);
    insert into public.diary_events (user_id, kind, occurred_at, source_tz, payload, source, legacy_id)
    values (v_owner, p_kind, p_occurred_at, p_source_tz, p_payload, 'agent_auto', null)
    returning id into v_event;
    update public.diary_pending_events
       set status = 'approved', decided_at = now(), confirmed_event_id = v_event, auto = true
     where id = v_id;
    perform set_config('diary.auto', 'off', true);
  end if;

  return query select p.id, p.status, p.expires_at, true, p.confirmed_event_id, p.auto, v_reason
    from public.diary_pending_events p where p.id = v_id;
end $$;

-- 사용자: AI별 바로 기록 켜기/끄기 (직접 로그인 세션만 — OAuth 토큰은 정책에서 차단)
create or replace function public.set_agent_auto_write(p_agent_id uuid, p_on boolean)
returns boolean
language plpgsql volatile security invoker set search_path = '' as $$
declare
  v boolean;
begin
  if (select auth.uid()) is null or public.diary_is_agent() or public.diary_via_oauth_client() then
    raise exception 'NOT_ALLOWED' using errcode = '42501';
  end if;
  update public.diary_agent_links set auto_write = coalesce(p_on, false)
   where agent_id = p_agent_id and owner_id = (select auth.uid()) and revoked_at is null
  returning auto_write into v;
  if v is null then
    raise exception 'NOT_FOUND' using errcode = 'PT404';
  end if;
  return v;
end $$;

-- 사용자: 최근 24시간 자동 확정 기록(취소 가능 목록)
create or replace function public.list_my_auto_events()
returns table (event_id uuid, agent_id uuid, kind text, occurred_at timestamptz, source_tz text,
               payload jsonb, created_at timestamptz, undo_until timestamptz)
language sql stable security invoker set search_path = '' as $$
  select e.id, p.agent_id, e.kind, e.occurred_at, e.source_tz, e.payload, e.created_at,
         e.created_at + interval '24 hours'
    from public.diary_events e
    join public.diary_pending_events p on p.confirmed_event_id = e.id
   where e.user_id = (select auth.uid()) and e.source = 'agent_auto'
     and e.created_at > now() - interval '24 hours'
     and not public.diary_is_agent()
   order by e.created_at desc
   limit 200
$$;

-- 사용자: 자동 확정 기록 취소(24시간 안). 요청 행은 'undone'으로 남기고 확정 기록은 지운다.
create or replace function public.undo_auto_event(p_event_id uuid)
returns text
language plpgsql volatile security invoker set search_path = '' as $$
declare
  r record;
begin
  if (select auth.uid()) is null or public.diary_is_agent() or public.diary_via_oauth_client() then
    raise exception 'NOT_ALLOWED' using errcode = '42501';
  end if;
  select e.id, e.created_at into r from public.diary_events e
   where e.id = p_event_id and e.user_id = (select auth.uid()) and e.source = 'agent_auto';
  -- (FOR UPDATE는 수정 권한이 필요해 쓰지 않음. 동시 취소는 delete가 직렬화하고 두 번째는 0건)
  if not found then
    raise exception 'NOT_FOUND' using errcode = 'PT404';
  end if;
  if r.created_at <= now() - interval '24 hours' then
    raise exception 'UNDO_WINDOW_PASSED' using errcode = 'PT410';
  end if;
  perform set_config('diary.undo', 'on', true);
  update public.diary_pending_events
     set status = 'undone', decided_at = now(), confirmed_event_id = null
   where confirmed_event_id = r.id;
  delete from public.diary_events where id = r.id;
  perform set_config('diary.undo', 'off', true);
  return 'undone';
end $$;

do $$
declare f record;
begin
  for f in
    select p.oid::regprocedure as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname in
       ('diary_auto_write_on','create_agent_event','set_agent_auto_write','list_my_auto_events','undo_auto_event')
  loop
    execute format('revoke all on function %s from public, anon', f.sig);
    execute format('grant execute on function %s to authenticated', f.sig);
  end loop;
end $$;
