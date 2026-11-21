// 실제 Data API(PostgREST) + Supabase Auth 토큰으로 권한 수용기준 검증.
// 실행: tools/local-stack/start.sh 후 `node --test supabase/tests-api/`
// 가상 사용자 A·B와 각자의 에이전트 계정만 사용한다.
import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { login, rest, rpc } from "../../tools/local-stack/client.mjs";
import { seed, adminCreateUser, sql } from "../../tools/local-stack/seed.mjs";

const run = randomUUID().slice(0, 8);
let S, tA, tB, tAgA, tAgB;

test.before(async () => {
  S = await seed();
  [tA, tB, tAgA, tAgB] = await Promise.all([login(S.userA), login(S.userB), login(S.agentA), login(S.agentB)]);
});

const ev = (legacy, at, payload = { state: "on", output: 70 }, kind = "state") =>
  ({ legacy_id: legacy, kind, occurred_at: at, source_tz: "Asia/Seoul", payload });

test("미인증 요청 거부", async () => {
  const r = await rest(null, "GET", "/diary_events?select=id");
  assert.equal(r.status, 401);
  const r2 = await rpc(null, "approve_pending_event", { p_pending_id: randomUUID() });
  assert.ok([401, 403].includes(r2.status), `status ${r2.status}`);
  const bad = await rest("not-a-jwt", "GET", "/diary_events?select=id");
  assert.equal(bad.status, 401);
});

test("사용자 본인 추가·조회, 타인 조회 빈 결과(독립 계정으로 행 존재 확인)", async () => {
  const r = await rpc(tA, "import_diary_events", { p_request_key: `imp-${run}-1`, p_items: [ev(`a-${run}-1`, "2026-11-20T07:30:00+09:00")] });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json[0].result, "inserted");
  const mine = await rest(tA, "GET", `/diary_events?legacy_id=eq.a-${run}-1&select=id,user_id`);
  assert.equal(mine.json.length, 1);
  assert.equal(mine.json[0].user_id, S.userA.id);
  const other = await rest(tB, "GET", `/diary_events?legacy_id=eq.a-${run}-1&select=id`);
  assert.deepEqual(other.json, []);
  // 독립된 관리자 문맥에서 원래 행이 실제로 존재함을 확인
  assert.equal(sql(`select count(*) from public.diary_events where legacy_id='a-${run}-1'`), "1");
});

test("다른 사용자 소유 삽입·소유자 변경 거부", async () => {
  const ins = await rest(tA, "POST", "/diary_events", {
    user_id: S.userB.id, kind: "med", occurred_at: "2026-11-20T07:00:00+09:00", source_tz: "Asia/Seoul",
    payload: { drug: "가상약", dose_mg: 50 }, source: "browser_upload", legacy_id: `x-${run}` });
  assert.equal(ins.status, 403);
  const upd = await rest(tA, "PATCH", `/diary_events?legacy_id=eq.a-${run}-1`, { user_id: S.userB.id });
  assert.ok([401, 403].includes(upd.status), `status ${upd.status}`);
  assert.equal(sql(`select user_id from public.diary_events where legacy_id='a-${run}-1'`), S.userA.id);
});

test("가져오기 멱등성: 같은 요청 키 재시도, 기존 ID 다른 내용은 conflict", async () => {
  const items = [ev(`a-${run}-2`, "2026-11-20T08:00:00+09:00")];
  const r1 = await rpc(tA, "import_diary_events", { p_request_key: `imp-${run}-2`, p_items: items });
  const r2 = await rpc(tA, "import_diary_events", { p_request_key: `imp-${run}-2`, p_items: items });
  assert.equal(r1.json[0].result, "inserted");
  assert.equal(r2.json[0].result, "already");
  assert.equal(r2.json[0].id, r1.json[0].id);
  const r3 = await rpc(tA, "import_diary_events", { p_request_key: `imp-${run}-3`, p_items: [ev(`a-${run}-2`, "2026-11-20T08:00:00+09:00", { state: "off" })] });
  assert.equal(r3.json[0].result, "conflict");
  const r4 = await rpc(tA, "import_diary_events", { p_request_key: `imp-${run}-2`, p_items: [ev(`a-${run}-9`, "2026-11-20T09:00:00+09:00")] });
  assert.equal(r4.status, 409);
  assert.match(JSON.stringify(r4.json), /CONFLICT/);
});

test("에이전트: 직접 확정·수정·삭제·승인 거부, 연결 사용자 기록만 조회", async () => {
  const ins = await rest(tAgA, "POST", "/diary_events", {
    user_id: S.userA.id, kind: "state", occurred_at: "2026-11-20T07:00:00+09:00", source_tz: "Asia/Seoul",
    payload: { state: "on" }, source: "browser_upload", legacy_id: `ag-${run}` });
  assert.equal(ins.status, 403);
  const imp = await rpc(tAgA, "import_diary_events", { p_request_key: `ag-imp-${run}`, p_items: [ev(`ag-${run}`, "2026-11-20T07:00:00+09:00")] });
  assert.ok([401, 403].includes(imp.status));
  const upd = await rest(tAgA, "PATCH", `/diary_events?legacy_id=eq.a-${run}-1`, { occurred_at: "2026-11-21T00:00:00Z" });
  assert.ok([401, 403].includes(upd.status));
  const del = await rest(tAgA, "DELETE", `/diary_events?legacy_id=eq.a-${run}-1`);
  assert.ok([401, 403].includes(del.status));
  const read = await rest(tAgA, "GET", `/diary_events?legacy_id=eq.a-${run}-1&select=id`);
  assert.equal(read.json.length, 1);
  const readB = await rest(tAgB, "GET", `/diary_events?legacy_id=eq.a-${run}-1&select=id`);
  assert.deepEqual(readB.json, []);

  const p = await rpc(tAgA, "create_pending_event", { p_request_id: `req-${run}-self`, p_kind: "state", p_occurred_at: "2026-11-20T10:00:00+09:00", p_source_tz: "Asia/Seoul", p_payload: { state: "on" } });
  assert.equal(p.status, 200, JSON.stringify(p.json));
  const ap = await rpc(tAgA, "approve_pending_event", { p_pending_id: p.json[0].pending_id });
  assert.equal(ap.status, 403);
  const direct = await rest(tAgA, "PATCH", `/diary_pending_events?id=eq.${p.json[0].pending_id}`, { status: "approved" });
  assert.ok(direct.status === 204 || direct.status === 200 || direct.status === 403);
  assert.equal(sql(`select status from public.diary_pending_events where id='${p.json[0].pending_id}'`), "pending");
  const link = await rest(tAgA, "PATCH", `/diary_agent_links?agent_id=eq.${S.agentA.id}`, { expires_at: "2099-01-01T00:00:00Z" });
  assert.ok([401, 403].includes(link.status));
  const linkIns = await rest(tAgA, "POST", "/diary_agent_links", { agent_id: S.agentA.id, owner_id: S.userB.id, expires_at: "2099-01-01T00:00:00Z" });
  assert.ok([401, 403].includes(linkIns.status));
  // user_id·owner_id를 인자로 넣어도 무시됨(권한은 인증 문맥에서만)
  const spoof = await rest(tAgA, "POST", "/diary_pending_events", { request_id: `req-${run}-spoof`, kind: "state", occurred_at: "2026-11-20T10:00:00Z", source_tz: "UTC", payload: { state: "on" }, owner_id: S.userB.id });
  assert.ok([401, 403].includes(spoof.status));
  // 사용자 B는 A 앞으로 온 요청을 승인할 수 없음
  const bApprove = await rpc(tB, "approve_pending_event", { p_pending_id: p.json[0].pending_id });
  assert.equal(bApprove.status, 404);
});

test("동시 승인 두 건 → 확정 행 1건, 같은 이벤트 ID", async () => {
  const p = await rpc(tAgA, "create_pending_event", { p_request_id: `req-${run}-race`, p_kind: "med", p_occurred_at: "2026-11-20T07:00:00+09:00", p_source_tz: "Asia/Seoul", p_payload: { drug: "가상약B", dose_mg: 100 } });
  const id = p.json[0].pending_id;
  const [r1, r2] = await Promise.all([
    rpc(tA, "approve_pending_event", { p_pending_id: id }),
    rpc(tA, "approve_pending_event", { p_pending_id: id }),
  ]);
  assert.equal(r1.status, 200); assert.equal(r2.status, 200);
  assert.equal(r1.json, r2.json);
  assert.equal(sql(`select count(*) from public.diary_events e join public.diary_pending_events p on p.confirmed_event_id=e.id where p.id='${id}'`), "1");
  assert.equal(sql(`select count(*) from public.diary_events where id='${r1.json}'`), "1");
});

test("동시 재전송(같은 request_id) → 대기 요청 1건", async () => {
  const args = { p_request_id: `req-${run}-dup`, p_kind: "life", p_occurred_at: "2026-11-20T12:00:00+09:00", p_source_tz: "Asia/Seoul", p_payload: { kind: "meal", meal_type: "점심" } };
  const rs = await Promise.all([1, 2, 3, 4].map(() => rpc(tAgA, "create_pending_event", args)));
  rs.forEach((r) => assert.equal(r.status, 200, JSON.stringify(r.json)));
  assert.equal(new Set(rs.map((r) => r.json[0].pending_id)).size, 1);
  assert.equal(rs.filter((r) => r.json[0].created).length, 1);
  const changed = await rpc(tAgA, "create_pending_event", { ...args, p_payload: { kind: "meal", meal_type: "저녁" } });
  assert.equal(changed.status, 409);
  assert.match(JSON.stringify(changed.json), /CONFLICT/);
});

test("거절된 요청은 확정 조회에 없음", async () => {
  const p = await rpc(tAgA, "create_pending_event", { p_request_id: `req-${run}-rej`, p_kind: "state", p_occurred_at: "2026-11-20T15:00:00+09:00", p_source_tz: "Asia/Seoul", p_payload: { state: "off", output: 10 } });
  const r = await rpc(tA, "reject_pending_event", { p_pending_id: p.json[0].pending_id });
  assert.equal(r.json, "rejected");
  const ap = await rpc(tA, "approve_pending_event", { p_pending_id: p.json[0].pending_id });
  assert.equal(ap.status, 410);
  const evs = await rest(tA, "GET", `/diary_events?occurred_at=eq.2026-11-20T06:00:00Z&select=id`);
  assert.deepEqual(evs.json, []);
});

test("연결 폐기 직후 기존 에이전트 토큰 차단 (별도 가상 계정)", async () => {
  // 이 테스트만 쓰는 새 사용자·에이전트(다른 테스트에 영향 없음)
  const pw = randomUUID();
  const u = await adminCreateUser(`rv-u-${run}@example.test`, pw);
  const a = await adminCreateUser(`rv-a-${run}@example.test`, pw);
  sql(`insert into public.diary_agent_links(agent_id, owner_id, expires_at) values ('${a}','${u}', now() + interval '1 day')`);
  const tu = await login({ email: `rv-u-${run}@example.test`, password: pw });
  const ta = await login({ email: `rv-a-${run}@example.test`, password: pw });
  await rpc(tu, "import_diary_events", { p_request_key: `rv-${run}-imp`, p_items: [ev(`rv-${run}`, "2026-11-20T07:00:00+09:00")] });
  const before = await rest(ta, "GET", "/diary_events?select=id");
  assert.equal(before.json.length, 1);
  const link = await rpc(ta, "my_agent_link", {});
  assert.equal(link.json.length, 1);
  const rv = await rpc(tu, "revoke_agent_link", { p_agent_id: a });
  assert.equal(rv.status, 200);
  const after = await rest(ta, "GET", "/diary_events?select=id");
  assert.deepEqual(after.json, []);
  const link2 = await rpc(ta, "my_agent_link", {});
  assert.deepEqual(link2.json, []);
  const req = await rpc(ta, "create_pending_event", { p_request_id: `req-${run}-rv`, p_kind: "state", p_occurred_at: "2026-11-20T10:00:00+09:00", p_source_tz: "Asia/Seoul", p_payload: { state: "on" } });
  assert.equal(req.status, 403);
});

test("만료된 연결의 에이전트 토큰 차단", async () => {
  const pw = randomUUID();
  const u = await adminCreateUser(`ex-u-${run}@example.test`, pw);
  const a = await adminCreateUser(`ex-a-${run}@example.test`, pw);
  sql(`insert into public.diary_agent_links(agent_id, owner_id, expires_at) values ('${a}','${u}', now() + interval '1 day')`);
  const ta = await login({ email: `ex-a-${run}@example.test`, password: pw });
  assert.equal((await rpc(ta, "my_agent_link", {})).json.length, 1);
  sql(`alter table public.diary_agent_links disable trigger diary_agent_links_guard;
       update public.diary_agent_links set expires_at = now() - interval '1 second' where agent_id='${a}';
       alter table public.diary_agent_links enable trigger diary_agent_links_guard;`);
  assert.deepEqual((await rpc(ta, "my_agent_link", {})).json, []);
  const req = await rpc(ta, "create_pending_event", { p_request_id: `req-${run}-ex`, p_kind: "state", p_occurred_at: "2026-11-20T10:00:00+09:00", p_source_tz: "Asia/Seoul", p_payload: { state: "on" } });
  assert.equal(req.status, 403);
});

test("미승인·만료 요청은 확정 조회에 없음, 목록에 중복 후보 표시", async () => {
  const payload = { state: "on", output: 70 };
  // A의 확정 기록(가져오기)과 같은 정규화 내용의 요청 → duplicate_event_id 표시
  const p = await rpc(tAgA, "create_pending_event", { p_request_id: `req-${run}-dupcand`, p_kind: "state", p_occurred_at: "2026-11-20T07:30:00+09:00", p_source_tz: "Asia/Seoul", p_payload: payload });
  const list = await rpc(tA, "list_my_pending_events", {});
  const row = list.json.find((x) => x.id === p.json[0].pending_id);
  assert.ok(row, "pending row listed");
  assert.ok(row.duplicate_event_id, "duplicate candidate flagged");
  const evs = await rest(tAgA, "GET", `/diary_events?occurred_at=eq.2026-11-19T22:30:00Z&source=eq.agent_request&select=id`);
  assert.deepEqual(evs.json, []);
});
