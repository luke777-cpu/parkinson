-- pgTAP: 약효일지 MCP 브리지 권한·승인 규칙 (supabase test db 또는 tools/local-stack/run-pgtap.sh)
-- 가상 사용자만 사용한다. 전체가 하나의 트랜잭션이며 마지막에 롤백한다.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select plan(40);

-- 가상 계정
insert into auth.users (id, email, aud, role) values
  ('00000000-0000-4000-8000-00000000000a', 'a@example.test', 'authenticated', 'authenticated'),
  ('00000000-0000-4000-8000-00000000000b', 'b@example.test', 'authenticated', 'authenticated'),
  ('00000000-0000-4000-8000-0000000000aa', 'agent-a@example.test', 'authenticated', 'authenticated'),
  ('00000000-0000-4000-8000-0000000000bb', 'agent-b@example.test', 'authenticated', 'authenticated');
insert into public.diary_agent_links (agent_id, owner_id, expires_at) values
  ('00000000-0000-4000-8000-0000000000aa', '00000000-0000-4000-8000-00000000000a', now() + interval '1 day'),
  ('00000000-0000-4000-8000-0000000000bb', '00000000-0000-4000-8000-00000000000b', now() + interval '1 day');

create function pg_temp.act_as(p uuid) returns void language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', p, 'role', 'authenticated')::text, true);
end $$;
create function pg_temp.act_as_anon() returns void language plpgsql as $$
begin
  perform set_config('role', 'anon', true);
  perform set_config('request.jwt.claims', '{"role":"anon"}', true);
end $$;
create function pg_temp.as_admin() returns void language plpgsql as $$
begin
  perform set_config('role', 'postgres', true);
  perform set_config('request.jwt.claims', '', true);
end $$;

-- 구조
select has_table('public', 'diary_events', 'diary_events 존재');
select has_table('public', 'diary_agent_links', 'diary_agent_links 존재');
select has_table('public', 'diary_pending_events', 'diary_pending_events 존재');
select ok((select bool_and(relrowsecurity) from pg_class where oid in
  ('public.diary_events'::regclass, 'public.diary_agent_links'::regclass, 'public.diary_pending_events'::regclass, 'public.diary_import_requests'::regclass)),
  '모든 노출 테이블 RLS 활성');
select is((select count(*)::int from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.prosecdef), 0, 'SECURITY DEFINER 함수 없음');
select ok(not has_table_privilege('anon', 'public.diary_events', 'select'), 'anon 조회 권한 없음');
select ok(not has_function_privilege('anon', 'public.approve_pending_event(uuid)', 'execute'), 'anon 승인 함수 실행 불가');

-- 미인증
select pg_temp.act_as_anon();
select throws_ok($$ select * from public.diary_events $$, '42501', null, '미인증 조회 거부');
select pg_temp.as_admin();

-- 사용자 A: 본인 기록 추가·조회
select pg_temp.act_as('00000000-0000-4000-8000-00000000000a');
select lives_ok($$ insert into public.diary_events (user_id, kind, occurred_at, source_tz, payload, source, legacy_id)
  values (auth.uid(), 'med', '2026-11-20T07:00:00+09:00', 'Asia/Seoul', '{"drug":"가상약A","dose_mg":100}', 'browser_upload', 'leg1') $$,
  'A 본인 기록 추가');
select is((select count(*)::int from public.diary_events), 1, 'A는 자기 기록 1건 조회');
select throws_ok($$ insert into public.diary_events (user_id, kind, occurred_at, source_tz, payload, source, legacy_id)
  values ('00000000-0000-4000-8000-00000000000b', 'med', now(), 'Asia/Seoul', '{"drug":"x"}', 'browser_upload', 'leg2') $$,
  '42501', null, 'A가 B 소유로 삽입 거부');
select throws_ok($$ insert into public.diary_events (user_id, kind, occurred_at, source_tz, payload, source, legacy_id)
  values (auth.uid(), 'med', now(), 'Asia/Seoul', '{"drug":"x","memo":"자유메모"}', 'browser_upload', 'leg3') $$,
  '23514', null, '허용되지 않은 payload 키(memo) 거부');
select throws_ok($$ insert into public.diary_events (user_id, kind, occurred_at, source_tz, payload, source, legacy_id)
  values (auth.uid(), 'med', now(), 'Asia/Seoul', '{"drug":"x"}', 'agent_request', null) $$,
  '42501', null, '사용자가 agent_request 출처 직접 삽입 거부');
select throws_ok($$ update public.diary_events set occurred_at = now() $$, '42501', null, '확정 기록 수정 권한 없음');
select throws_ok($$ delete from public.diary_events $$, '42501', null, '확정 기록 삭제 권한 없음');
select pg_temp.as_admin();

-- 사용자 B: A 기록이 보이지 않음 (관리자 문맥에서 원래 행 존재 확인)
select pg_temp.act_as('00000000-0000-4000-8000-00000000000b');
select is((select count(*)::int from public.diary_events), 0, 'B는 A 기록을 볼 수 없음');
select pg_temp.as_admin();
select is((select count(*)::int from public.diary_events where user_id='00000000-0000-4000-8000-00000000000a'), 1, '관리자 확인: A 행은 존재');

-- 에이전트 A: 연결된 A 기록만 조회, 직접 삽입·승인 불가
select pg_temp.act_as('00000000-0000-4000-8000-0000000000aa');
select is((select count(*)::int from public.diary_events), 1, '에이전트A는 A 기록 조회');
select throws_ok($$ insert into public.diary_events (user_id, kind, occurred_at, source_tz, payload, source, legacy_id)
  values ('00000000-0000-4000-8000-00000000000a', 'med', now(), 'Asia/Seoul', '{"drug":"x"}', 'browser_upload', 'ag1') $$,
  '42501', null, '에이전트의 확정 기록 직접 삽입 거부');
select is((select status from public.create_pending_event('req-00000001', 'state', '2026-11-20T08:00:00+09:00', 'Asia/Seoul', '{"state":"on","output":80}')),
  'pending', '에이전트A 추가 요청 생성');
select is((select created from public.create_pending_event('req-00000001', 'state', '2026-11-20T08:00:00+09:00', 'Asia/Seoul', '{"output":80,"state":"on"}')),
  false, '같은 키·같은 정규화 내용 재전송은 기존 결과');
select throws_ok($$ select * from public.create_pending_event('req-00000001', 'state', '2026-11-20T08:00:00+09:00', 'Asia/Seoul', '{"state":"off"}') $$,
  'PT409', null, '같은 키·다른 내용은 CONFLICT');
select is((select owner_id from public.diary_pending_events where request_id='req-00000001'),
  '00000000-0000-4000-8000-00000000000a'::uuid, '요청 소유자는 연결에서 결정');
select throws_ok($$ select public.approve_pending_event((select id from public.diary_pending_events where request_id='req-00000001')) $$,
  '42501', null, '에이전트 자기 요청 승인 거부');
update public.diary_pending_events set status='approved', decided_at=now() where request_id='req-00000001';
select is((select status from public.diary_pending_events where request_id='req-00000001'), 'pending', '에이전트 요청 직접 상태 변경은 반영되지 않음(RLS 0행)');
select throws_ok($$ update public.diary_agent_links set revoked_at = null, expires_at = now() + interval '9 years' $$,
  '42501', null, '에이전트 연결 변경 거부');
select pg_temp.as_admin();

-- 에이전트 B: A 요청·기록 접근 불가
select pg_temp.act_as('00000000-0000-4000-8000-0000000000bb');
select is((select count(*)::int from public.diary_events), 0, '에이전트B는 A 기록 조회 불가');
select is((select count(*)::int from public.diary_pending_events), 0, '에이전트B는 에이전트A 요청 조회 불가');
select pg_temp.as_admin();

-- 사용자 A 승인
select pg_temp.act_as('00000000-0000-4000-8000-00000000000a');
select throws_ok($$ update public.diary_pending_events set status='approved', decided_at=now() $$,
  '42501', null, '사용자도 승인 함수 밖에서 직접 상태 변경 불가');
create temp table _ev as select public.approve_pending_event((select id from public.diary_pending_events where request_id='req-00000001')) as id;
select is((select count(*)::int from public.diary_events where source='agent_request'), 1, '승인 후 확정 기록 1건');
select is(public.approve_pending_event((select id from public.diary_pending_events where request_id='req-00000001')),
  (select id from _ev), '재승인은 같은 이벤트 ID');
select is((select count(*)::int from public.diary_events where source='agent_request'), 1, '재승인 후에도 1건');
select pg_temp.as_admin();

-- B는 A의 요청을 승인할 수 없음
select pg_temp.act_as('00000000-0000-4000-8000-0000000000aa');
select is((select status from public.create_pending_event('req-00000002', 'life', '2026-11-20T12:00:00+09:00', 'Asia/Seoul', '{"kind":"meal","meal_type":"점심"}')), 'pending', '두 번째 요청');
select pg_temp.as_admin();
select pg_temp.act_as('00000000-0000-4000-8000-00000000000b');
select throws_ok($$ select public.approve_pending_event((select id from public.diary_pending_events where request_id='req-00000002' limit 1)) $$,
  'PT404', null, 'B가 A 요청 승인 불가(보이지 않음)');
select pg_temp.as_admin();

-- 만료 요청은 승인 불가, 확정 조회에 없음
select pg_temp.as_admin();
alter table public.diary_pending_events disable trigger diary_pending_before_update;
update public.diary_pending_events set expires_at = now() - interval '1 minute' where request_id='req-00000002';
alter table public.diary_pending_events enable trigger diary_pending_before_update;
select pg_temp.act_as('00000000-0000-4000-8000-00000000000a');
select throws_ok($$ select public.approve_pending_event((select id from public.diary_pending_events where request_id='req-00000002')) $$,
  'PT410', null, '만료 요청 승인 거부');
select is((select count(*)::int from public.diary_events where kind='life'), 0, '만료 요청은 확정 조회에 없음');
select pg_temp.as_admin();

-- 연결 폐기 직후 차단
select pg_temp.act_as('00000000-0000-4000-8000-00000000000a');
select isnt(public.revoke_agent_link('00000000-0000-4000-8000-0000000000aa'), null, 'A가 본인 연결 폐기');
select pg_temp.as_admin();
select pg_temp.act_as('00000000-0000-4000-8000-0000000000aa');
select is((select count(*)::int from public.diary_events), 0, '폐기 후 에이전트 조회 0건');
select throws_ok($$ select * from public.create_pending_event('req-00000003', 'state', now(), 'Asia/Seoul', '{"state":"on"}') $$,
  '42501', null, '폐기 후 추가 요청 거부');
select pg_temp.as_admin();
select pg_temp.act_as('00000000-0000-4000-8000-00000000000a');
select throws_ok($$ update public.diary_agent_links set revoked_at = null $$, '42501', null, '폐기 취소 불가');
select pg_temp.as_admin();

select * from finish();
rollback;
