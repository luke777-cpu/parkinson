-- 업로드 미리보기: 쓰지 않고 항목별 분류만 반환한다(new / already / conflict / invalid).
-- 브라우저가 jsonb 정규화·해시 규칙을 흉내 내지 않도록 서버가 같은 함수로 판정한다.
create or replace function public.preview_import_diary_events(p_items jsonb)
returns jsonb
language plpgsql stable security invoker set search_path = '' as $$
declare
  v_uid uuid := (select auth.uid());
  it jsonb;
  v_at timestamptz;
  v_hash text;
  v_existing text;
  v_results jsonb := '[]'::jsonb;
begin
  if v_uid is null or public.diary_is_agent() then
    raise exception 'NOT_ALLOWED' using errcode = '42501';
  end if;
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) not between 1 and 500 then
    raise exception 'ITEMS_OUT_OF_RANGE' using errcode = '22023';
  end if;
  for it in select * from jsonb_array_elements(p_items) loop
    begin
      v_at := (it ->> 'occurred_at')::timestamptz;
    exception when others then
      v_at := null;
    end;
    if (it ->> 'legacy_id') is null or (it ->> 'legacy_id') !~ '^[A-Za-z0-9_.:-]{1,64}$' or v_at is null
       or not public.diary_valid_tz(it ->> 'source_tz')
       or not coalesce(public.diary_payload_valid(it ->> 'kind', it -> 'payload'), false) then
      v_results := v_results || jsonb_build_object('legacy_id', it ->> 'legacy_id', 'result', 'invalid');
      continue;
    end if;
    v_hash := public.diary_input_hash(it ->> 'kind', v_at, it -> 'payload');
    select e.input_hash into v_existing from public.diary_events e
     where e.user_id = v_uid and e.legacy_id = it ->> 'legacy_id';
    v_results := v_results || jsonb_build_object('legacy_id', it ->> 'legacy_id',
      'result', case when v_existing is null then 'new' when v_existing = v_hash then 'already' else 'conflict' end);
    v_existing := null;
  end loop;
  return v_results;
end $$;

revoke all on function public.preview_import_diary_events(jsonb) from public, anon;
grant execute on function public.preview_import_diary_events(jsonb) to authenticated;
