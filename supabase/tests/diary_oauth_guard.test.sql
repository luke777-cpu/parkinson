-- pgTAP: OAuth 토큰(client_id 있음)의 권한 상한. 가상 계정만, 마지막에 롤백.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select plan(17);

insert into auth.users (id, email, aud, role) values
  ('00000000-0000-4000-8000-00000000010a', 'oa@example.test', 'authenticated', 'authenticated'),
  ('00000000-0000-4000-8000-0000000001aa', 'oagent@example.test', 'authenticated', 'authenticated');
insert into public.diary_agent_links (agent_id, owner_id, expires_at) values
  ('00000000-0000-4000-8000-0000000001aa', '00000000-0000-4000-8000-00000000010a', now() + interval '1 day');
insert into public.diary_events (user_id, kind, occurred_at, source_tz, payload, source, legacy_id)
  values ('00000000-0000-4000-8000-00000000010a', 'med', '2026-11-20T07:00:00+09:00', 'Asia/Seoul', '{"drug":"가상약A","dose_mg":100}', 'browser_upload', 'oleg1');

create function pg_temp.act(p uuid, p_client text) returns void language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', (case when p_client is null
    then json_build_object('sub', p, 'role', 'authenticated')
    else json_build_object('sub', p, 'role', 'authenticated', 'client_id', p_client) end)::text, true);
end $$;
create function pg_temp.as_admin() returns void language plpgsql as $$
begin perform set_config('role', 'postgres', true); perform set_config('request.jwt.claims', '', true); end $$;

-- 에이전트 계정 + OAuth 토큰: 기존 에이전트 권한 그대로
select pg_temp.act('00000000-0000-4000-8000-0000000001aa', 'client-chatgpt');
select ok(public.diary_via_oauth_client(), 'client_id 있으면 OAuth 토큰으로 판정');
select is((select count(*)::int from public.my_agent_link()), 1, 'OAuth 에이전트: 자기 연결 조회');
select is((select count(*)::int from public.diary_events), 1, 'OAuth 에이전트: 주인 기록 조회(read)');
select lives_ok($$ select * from public.create_pending_event('00000000-0000-4000-8000-00000000f001', 'med', '2026-11-21T08:00:00+09:00', 'Asia/Seoul', '{"drug":"가상약A","dose_mg":100}') $$,
  'OAuth 에이전트: 추가 요청 생성');
select is((select count(*)::int from public.diary_pending_events), 1, 'OAuth 에이전트: 자기 요청 조회');
select throws_ok($$ select public.revoke_agent_link('00000000-0000-4000-8000-0000000001aa') $$, null, null, 'OAuth 에이전트: 연결 폐기 불가');

-- 주인 계정 + OAuth 토큰(실수로 본인 계정으로 승인한 경우): 아무것도 못 봄·못 함
select pg_temp.act('00000000-0000-4000-8000-00000000010a', 'client-chatgpt');
select is((select count(*)::int from public.diary_events), 0, 'OAuth 주인 토큰: 확정 기록 조회 불가');
select is((select count(*)::int from public.diary_pending_events), 0, 'OAuth 주인 토큰: 요청 조회 불가');
select is((select count(*)::int from public.diary_agent_links), 0, 'OAuth 주인 토큰: 연결 조회 불가');
select throws_ok($$ insert into public.diary_events (user_id, kind, occurred_at, source_tz, payload, source, legacy_id)
  values (auth.uid(), 'med', now(), 'Asia/Seoul', '{"drug":"x"}', 'browser_upload', 'oleg2') $$, '42501', null, 'OAuth 주인 토큰: 기록 추가 불가');
select throws_ok($$ select public.approve_pending_event((select id from public.diary_pending_events limit 1)) $$, null, null, 'OAuth 주인 토큰: 승인 불가');
select throws_ok($$ select public.import_diary_events('k1', '[{"kind":"med","occurred_at":"2026-11-19T07:00:00+09:00","source_tz":"Asia/Seoul","payload":{"drug":"x"},"legacy_id":"z1"}]'::jsonb) $$,
  null, null, 'OAuth 주인 토큰: 가져오기 불가');
select is((select count(*)::int from public.diary_agent_links where revoked_at is not null), 0, 'OAuth 주인 토큰: 폐기 대상조차 안 보임');
select pg_temp.as_admin();
select is((select count(*)::int from public.diary_agent_links where revoked_at is null and agent_id = '00000000-0000-4000-8000-0000000001aa'), 1, '연결은 그대로 유지');

-- 주인 직접 로그인(client_id 없음): 기존대로 승인 가능
select pg_temp.act('00000000-0000-4000-8000-00000000010a', null);
select ok(not public.diary_via_oauth_client(), '직접 세션은 OAuth 아님');
select lives_ok($$ select public.approve_pending_event((select id from public.diary_pending_events limit 1)) $$, '직접 세션 주인: 승인 가능');
select is((select count(*)::int from public.diary_events), 2, '승인 후 확정 2건');

select * from finish();
rollback;
