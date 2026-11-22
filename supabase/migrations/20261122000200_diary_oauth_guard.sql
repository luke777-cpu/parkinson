-- OAuth 2.1 토큰(외부 AI 앱이 받은 토큰, JWT에 client_id 있음)의 권한 상한
--   · 사용자(기록 주인) 권한은 직접 로그인한 세션에서만: 확정 기록 조회·추가, 요청 승인·거부,
--     가져오기, 연결 폐기는 OAuth 토큰으로 불가.
--   · 에이전트 계정의 OAuth 토큰은 기존 에이전트 권한(조회·추가 요청)만 그대로.
-- 실수로 사용자 본인 계정으로 AI 연결을 승인해도 그 AI는 기록을 읽거나 확정할 수 없다.
-- RESTRICTIVE 정책이라 기존 허용 정책과 AND로 결합된다. 추가 전용.

create or replace function public.diary_via_oauth_client()
returns boolean language sql stable security invoker set search_path = '' as $$
  select coalesce((select auth.jwt()) ->> 'client_id', '') <> ''
$$;
revoke all on function public.diary_via_oauth_client() from public, anon;
grant execute on function public.diary_via_oauth_client() to authenticated;

-- 확정 기록: OAuth 토큰은 에이전트로서의 조회만, 추가는 불가
create policy diary_events_oauth_select_cap on public.diary_events
  as restrictive for select to authenticated
  using (not public.diary_via_oauth_client() or public.diary_is_agent());
create policy diary_events_oauth_insert_cap on public.diary_events
  as restrictive for insert to authenticated
  with check (not public.diary_via_oauth_client());

-- 추가 요청: OAuth 토큰은 에이전트로서의 생성·조회만, 승인·거부(update)는 불가
create policy diary_pending_oauth_select_cap on public.diary_pending_events
  as restrictive for select to authenticated
  using (not public.diary_via_oauth_client() or public.diary_is_agent());
create policy diary_pending_oauth_update_cap on public.diary_pending_events
  as restrictive for update to authenticated
  using (not public.diary_via_oauth_client());

-- 연결: OAuth 토큰은 에이전트로서 자기 연결 조회만, 폐기(update)는 불가
-- (diary_is_agent()는 이 테이블을 읽으므로 여기서 쓰면 재귀 — 같은 뜻을 직접 쓴다)
create policy diary_agent_links_oauth_select_cap on public.diary_agent_links
  as restrictive for select to authenticated
  using (not public.diary_via_oauth_client() or agent_id = (select auth.uid()));
create policy diary_agent_links_oauth_update_cap on public.diary_agent_links
  as restrictive for update to authenticated
  using (not public.diary_via_oauth_client());

-- 가져오기 추적: OAuth 토큰은 전부 불가
create policy diary_import_requests_oauth_cap on public.diary_import_requests
  as restrictive for all to authenticated
  using (not public.diary_via_oauth_client())
  with check (not public.diary_via_oauth_client());
