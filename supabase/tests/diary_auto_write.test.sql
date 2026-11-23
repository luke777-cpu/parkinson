-- pgTAP: AI별 바로 기록 스위치·한도·24시간 취소. 가상 계정만, 마지막에 롤백.
begin;
create extension if not exists pgtap with schema extensions;
set search_path = public, extensions;
select plan(33);

insert into auth.users (id, email, aud, role) values
  ('00000000-0000-4000-8000-00000000020a', 'aw-owner@example.test', 'authenticated', 'authenticated'),
  ('00000000-0000-4000-8000-0000000002aa', 'aw-agent@example.test', 'authenticated', 'authenticated'),
  ('00000000-0000-4000-8000-0000000002bb', 'aw-agent2@example.test', 'authenticated', 'authenticated'),
  ('00000000-0000-4000-8000-00000000020c', 'aw-other@example.test', 'authenticated', 'authenticated');
insert into public.diary_agent_links (agent_id, owner_id, expires_at) values
  ('00000000-0000-4000-8000-0000000002aa', '00000000-0000-4000-8000-00000000020a', now() + interval '1 day'),
  ('00000000-0000-4000-8000-0000000002bb', '00000000-0000-4000-8000-00000000020a', now() + interval '1 day');

create function pg_temp.act(p uuid, p_client text) returns void language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', (case when p_client is null
    then json_build_object('sub', p, 'role', 'authenticated')
    else json_build_object('sub', p, 'role', 'authenticated', 'client_id', p_client) end)::text, true);
end $$;
create function pg_temp.adm() returns void language plpgsql as $$
begin perform set_config('role', 'postgres', true); perform set_config('request.jwt.claims', '', true); end $$;
create function pg_temp.ago(m int) returns timestamptz language sql as $$ select now() - make_interval(mins => m) $$;

-- 스위치 꺼짐: 기존처럼 승인 대기
select pg_temp.act('00000000-0000-4000-8000-0000000002aa', 'client-x');
select is((select status || '/' || auto_reason from public.create_agent_event('aw-r-off01', 'med', pg_temp.ago(30), 'Asia/Seoul', '{"drug":"가상약A","dose_mg":100}')),
  'pending/AUTO_OFF', '스위치 꺼짐 → 승인 대기');

-- 스위치 켜기: 에이전트·OAuth 주인 토큰은 불가, 직접 로그인한 주인만
select throws_ok($$ select public.set_agent_auto_write('00000000-0000-4000-8000-0000000002aa', true) $$, '42501', null, '에이전트는 스위치 못 켬');
select pg_temp.act('00000000-0000-4000-8000-00000000020a', 'client-x');
select throws_ok($$ select public.set_agent_auto_write('00000000-0000-4000-8000-0000000002aa', true) $$, '42501', null, 'OAuth 주인 토큰은 스위치 못 켬');
select pg_temp.act('00000000-0000-4000-8000-00000000020c', null);
select throws_ok($$ select public.set_agent_auto_write('00000000-0000-4000-8000-0000000002aa', true) $$, 'PT404', null, '남의 연결은 못 켬');
select pg_temp.act('00000000-0000-4000-8000-00000000020a', null);
select is(public.set_agent_auto_write('00000000-0000-4000-8000-0000000002aa', true), true, '주인 직접 세션: 켬');
select is((select auto_write from public.diary_agent_links where agent_id = '00000000-0000-4000-8000-0000000002bb'), false, '다른 AI는 그대로 꺼짐');

-- 켜진 AI: 한도 통과 → 즉시 확정
select pg_temp.act('00000000-0000-4000-8000-0000000002aa', 'client-x');
create temp table r1 as select * from public.create_agent_event('aw-r-auto01', 'med', pg_temp.ago(20), 'Asia/Seoul', '{"drug":"가상약A","dose_mg":100}');
select is((select status from r1), 'approved', '바로 확정');
select ok((select auto and event_id is not null and auto_reason is null from r1), 'auto 표시와 확정 기록 ID');
select is((select source from public.diary_events where id = (select event_id from r1)), 'agent_auto', '출처 agent_auto');
select is((select event_id from public.create_agent_event('aw-r-auto01', 'med', pg_temp.ago(20), 'Asia/Seoul', '{"drug":"가상약A","dose_mg":100}')),
  (select event_id from r1), '같은 request_id 재시도 → 같은 기록(중복 없음)');
select is((select count(*)::int from public.diary_events where source = 'agent_auto'), 1, '확정 1건뿐');

-- 한도: 각각 승인 대기로
select is((select auto_reason from public.create_agent_event('aw-r-dup01', 'med', (select occurred_at from public.diary_events where id = (select event_id from r1)), 'Asia/Seoul', '{"drug":"가상약A","dose_mg":100}')),
  'DUPLICATE', '같은 내용 확정 기록 → 대기');
select is((select auto_reason from public.create_agent_event('aw-r-near01', 'med', pg_temp.ago(5), 'Asia/Seoul', '{"drug":"가상약A","dose_mg":50}')),
  'NEAR_DUPLICATE', '같은 약 30분 안 → 대기');
select is((select auto_reason || '/' || status from public.create_agent_event('aw-r-other01', 'med', pg_temp.ago(5), 'Asia/Seoul', '{"drug":"가상약B","dose_mg":50}')),
  null, '다른 약은 바로 확정(이유 없음)');
select is((select auto_reason from public.create_agent_event('aw-r-dose01', 'med', pg_temp.ago(120), 'Asia/Seoul', '{"drug":"가상약C","dose_mg":1500}')),
  'DOSE_LIMIT', '1000mg 초과 → 대기');
select is((select auto_reason from public.create_agent_event('aw-r-dose02', 'med', pg_temp.ago(180), 'Asia/Seoul', '{"drug":"가상약D"}')),
  'DOSE_MISSING', '용량 없음 → 대기');
select is((select auto_reason from public.create_agent_event('aw-r-old01', 'state', now() - interval '30 hours', 'Asia/Seoul', '{"state":"on"}')),
  'TIME_WINDOW', '24시간보다 오래됨 → 대기');
select is((select auto_reason from public.create_agent_event('aw-r-fut01', 'state', now() + interval '1 hour', 'Asia/Seoul', '{"state":"on"}')),
  'TIME_WINDOW', '미래 → 대기');
select is((select status from public.create_agent_event('aw-r-st01', 'state', pg_temp.ago(60), 'Asia/Seoul', '{"state":"on","output":70}')),
  'approved', '상태 기록 바로 확정');
select is((select auto_reason from public.create_agent_event('aw-r-st02', 'state', pg_temp.ago(55), 'Asia/Seoul', '{"state":"off","output":30}')),
  'NEAR_DUPLICATE', '상태 10분 안 → 대기');

-- 에이전트가 직접 우회 불가
select throws_ok($$ insert into public.diary_events (user_id, kind, occurred_at, source_tz, payload, source)
  values ('00000000-0000-4000-8000-00000000020a', 'state', now(), 'Asia/Seoul', '{"state":"on"}', 'agent_auto') $$, null, null, '에이전트 직접 insert 불가');
select throws_ok($$ select public.undo_auto_event((select event_id from r1)) $$, '42501', null, '에이전트는 취소 못 함');
select throws_ok($$ select public.set_agent_auto_write('00000000-0000-4000-8000-0000000002aa', false) $$, '42501', null, '에이전트는 스위치 못 끔');

-- 꺼진 다른 AI는 여전히 대기
select pg_temp.act('00000000-0000-4000-8000-0000000002bb', 'client-y');
select is((select auto_reason from public.create_agent_event('aw-r-b01', 'life', pg_temp.ago(10), 'Asia/Seoul', '{"kind":"meal","meal_type":"점심"}')),
  'AUTO_OFF', '스위치 꺼진 AI는 대기');

-- 주인: 자동 기록 목록·취소
select pg_temp.act('00000000-0000-4000-8000-00000000020a', null);
select is((select count(*)::int from public.list_my_auto_events()), 3, '자동 기록 목록 3건');
select pg_temp.act('00000000-0000-4000-8000-00000000020a', 'client-x');
select throws_ok($$ select public.undo_auto_event((select event_id from r1)) $$, '42501', null, 'OAuth 주인 토큰은 취소 못 함');
select pg_temp.act('00000000-0000-4000-8000-00000000020a', null);
select is(public.undo_auto_event((select event_id from r1)), 'undone', '직접 세션 주인: 취소');
select is((select count(*)::int from public.diary_events where id = (select event_id from r1)), 0, '확정 기록 삭제됨');
select is((select status from public.diary_pending_events where request_id = 'aw-r-auto01'), 'undone', '요청 행은 undone으로 남음');
select throws_ok($$ select public.undo_auto_event((select event_id from r1)) $$, 'PT404', null, '두 번 취소 → 없음');
select pg_temp.adm();
update public.diary_events set created_at = now() - interval '25 hours' where source = 'agent_auto';
select pg_temp.act('00000000-0000-4000-8000-00000000020a', null);
select throws_ok($$ select public.undo_auto_event((select id from public.diary_events where source = 'agent_auto' limit 1)) $$, 'PT410', null, '24시간 지나면 취소 불가');
select is((select count(*)::int from public.list_my_auto_events()), 0, '24시간 지난 기록은 목록에서 빠짐');
select is((select count(*)::int from public.diary_events where source = 'agent_request'), 0, '승인 기록과 섞이지 않음');

select * from finish();
rollback;
