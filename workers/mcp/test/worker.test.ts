// Worker 계약 시험: 실제 Supabase 대신 가짜 Data API(fetch 대체)와 로컬 JWKS를 쓴다.
import { beforeAll, describe, expect, it } from "vitest";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair, type JWTVerifyGetKey } from "jose";
import { handle, type Env } from "../src/index.js";

const env: Env = { SUPABASE_URL: "https://staging.example.test", SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test", ALLOWED_ORIGINS: "https://luke777-cpu.github.io" };
const AGENT = "11111111-1111-4111-8111-111111111111";
const OWNER = "22222222-2222-4222-8222-222222222222";
let jwks: JWTVerifyGetKey;
let priv: CryptoKey;
let otherPriv: CryptoKey;

beforeAll(async () => {
  const kp = await generateKeyPair("ES256", { extractable: true });
  priv = kp.privateKey;
  const pub = { ...(await exportJWK(kp.publicKey)), kid: "k1", alg: "ES256" };
  jwks = createLocalJWKSet({ keys: [pub] });
  otherPriv = (await generateKeyPair("ES256")).privateKey;
});

async function token(o: { sub?: string; iss?: string; aud?: string; role?: string; exp?: number; key?: CryptoKey } = {}) {
  return new SignJWT({ role: o.role ?? "authenticated" })
    .setProtectedHeader({ alg: "ES256", kid: "k1" })
    .setSubject(o.sub ?? AGENT).setIssuer(o.iss ?? `${env.SUPABASE_URL}/auth/v1`).setAudience(o.aud ?? "authenticated")
    .setIssuedAt().setExpirationTime(o.exp ?? Math.floor(Date.now() / 1000) + 600)
    .sign(o.key ?? priv);
}

interface Call { path: string; body: unknown }
function fakeSupabase(opts: { link?: boolean; pendingConflict?: boolean; events?: unknown[]; status429?: number } = {}) {
  const calls: Call[] = [];
  let left429 = opts.status429 ?? 0;
  const pending = new Map<string, { id: string; hash: string }>();
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input));
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ path: u.pathname + u.search, body });
    expect(new Headers(init?.headers).get("authorization")).toMatch(/^Bearer /);
    expect(new Headers(init?.headers).get("apikey")).toBe(env.SUPABASE_PUBLISHABLE_KEY);
    if (left429-- > 0) return new Response("{}", { status: 429, headers: { "retry-after": "0" } });
    if (u.pathname.endsWith("/rpc/my_agent_link")) {
      return Response.json(opts.link === false ? [] : [{ owner_id: OWNER, scopes: ["read", "request_write"], expires_at: "2099-01-01T00:00:00Z" }]);
    }
    if (u.pathname.endsWith("/rpc/create_pending_event")) {
      const key = body.p_request_id; const hash = JSON.stringify([body.p_kind, body.p_occurred_at, body.p_payload]);
      const prev = pending.get(key);
      if (prev && prev.hash !== hash) return Response.json({ code: "PT409", message: "CONFLICT: request_id already used with different content" }, { status: 409 });
      if (!prev) pending.set(key, { id: crypto.randomUUID(), hash });
      return Response.json([{ pending_id: pending.get(key)!.id, status: "pending", expires_at: "2026-11-25T00:00:00Z", created: !prev }]);
    }
    if (u.pathname.endsWith("/diary_events")) return Response.json((opts.events ?? []).map((e) => ({ ...(e as object), state: (e as { payload?: { state?: string } }).payload?.state ?? null })));
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  return { f, calls };
}

const rpc = (method: string, params: unknown = {}, id = 1) => ({ jsonrpc: "2.0", id, method, params });
async function post(body: unknown, o: { tok?: string | null; headers?: Record<string, string>; fake?: ReturnType<typeof fakeSupabase> } = {}) {
  const fake = o.fake ?? fakeSupabase();
  const tok = o.tok === undefined ? await token() : o.tok;
  const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream", ...o.headers };
  if (tok) headers.authorization = `Bearer ${tok}`;
  const res = await handle(new Request("https://w.example.test/mcp", { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) }), env, { fetchImpl: fake.f, jwks });
  const text = await res.text();
  return { res, json: text ? JSON.parse(text) : null, fake };
}
const toolCall = (name: string, args: unknown) => rpc("tools/call", { name, arguments: args });
const parseResult = (j: { result: { content: { text: string }[]; isError?: boolean } }) => ({ isError: !!j.result.isError, data: JSON.parse(j.result.content[0].text) });

describe("HTTP 계층", () => {
  it("/healthz는 설정·계정을 노출하지 않는다", async () => {
    const r = await handle(new Request("https://w/healthz"), env);
    expect(await r.text()).toBe('{"ok":true}');
  });
  it("GET/DELETE /mcp는 405 (무상태)", async () => {
    for (const method of ["GET", "DELETE"]) {
      const r = await handle(new Request("https://w/mcp", { method }), env, { jwks });
      expect(r.status).toBe(405);
      expect(r.headers.get("allow")).toBe("POST");
    }
  });
  it("허용되지 않은 Origin은 403, 허용 Origin은 통과", async () => {
    expect((await post(rpc("tools/list"), { headers: { origin: "https://evil.example" } })).res.status).toBe(403);
    expect((await post(rpc("tools/list"), { headers: { origin: "https://luke777-cpu.github.io" } })).res.status).toBe(200);
  });
  it("미지원 MCP-Protocol-Version은 400", async () => {
    expect((await post(rpc("tools/list"), { headers: { "mcp-protocol-version": "1999-01-01" } })).res.status).toBe(400);
  });
  it("본문 16 KiB 초과는 413", async () => {
    const big = JSON.stringify(rpc("tools/list", { pad: "x".repeat(17 * 1024) }));
    expect((await post(big)).res.status).toBe(413);
  });
});

describe("인증·연결", () => {
  it("토큰 없음/형식 오류/다른 키 서명/발급자 불일치/대상 불일치/만료/anon 역할은 401", async () => {
    const now = Math.floor(Date.now() / 1000);
    const bad = [null, "garbage", await token({ key: otherPriv }), await token({ iss: "https://other.supabase.co/auth/v1" }),
      await token({ aud: "other" }), await token({ exp: now - 60 }), await token({ role: "anon" }), await token({ sub: "not-a-uuid" })];
    for (const tok of bad) {
      const { res, fake } = await post(rpc("tools/list"), { tok });
      expect(res.status).toBe(401);
      expect(res.headers.get("www-authenticate")).toMatch(/Bearer/);
      expect(fake.calls).toHaveLength(0); // Data API 호출 전 차단
    }
  });
  it("연결 없는(폐기·만료) 계정은 403", async () => {
    const { res } = await post(rpc("tools/list"), { fake: fakeSupabase({ link: false }) });
    expect(res.status).toBe(403);
  });
});

describe("MCP 프로토콜", () => {
  it("initialize → 서버 정보와 도구 기능", async () => {
    const { res, json } = await post(rpc("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "t", version: "0" } }));
    expect(res.status).toBe(200);
    expect(json.result.serverInfo.name).toBe("yakhyo-diary");
    expect(json.result.capabilities.tools).toBeDefined();
    expect(res.headers.get("mcp-session-id")).toBeNull();
  });
  it("tools/list → 5개 도구, 수정·삭제 도구 없음", async () => {
    const { json } = await post(rpc("tools/list"));
    const names = json.result.tools.map((t: { name: string }) => t.name).sort();
    expect(names).toEqual(["add_life_event", "add_medication", "add_state", "get_daily_log", "get_weekly_summary"]);
    const med = json.result.tools.find((t: { name: string }) => t.name === "add_medication");
    expect(med.inputSchema.additionalProperties).toBe(false);
  });
});

describe("추가 요청 도구", () => {
  const base = { request_id: "req-test-0001", occurred_at: "2026-11-20T07:00:00+09:00" };
  it("add_medication → pending, user_id/owner는 보내지 않음", async () => {
    const { json, fake } = await post(toolCall("add_medication", { ...base, drug: "가상약", dose_mg: 100 }));
    const r = parseResult(json);
    expect(r.isError).toBe(false);
    expect(r.data.status).toBe("pending");
    const call = fake.calls.find((c) => c.path.includes("create_pending_event"))!;
    expect(call.body).toEqual({ p_request_id: "req-test-0001", p_kind: "med", p_occurred_at: base.occurred_at, p_source_tz: "Asia/Seoul", p_payload: { drug: "가상약", dose_mg: 100 } });
  });
  it("용량을 모르면 비워 둔다(추정해 채우지 않음)", async () => {
    const { fake } = await post(toolCall("add_medication", { ...base, drug: "가상약" }));
    expect((fake.calls.find((c) => c.path.includes("create_pending_event"))!.body as { p_payload: unknown }).p_payload).toEqual({ drug: "가상약" });
  });
  it("자유 메모·user_id 같은 허용 외 필드는 거부", async () => {
    for (const extra of [{ memo: "자유 텍스트" }, { user_id: "x" }, { owner_id: "x" }]) {
      const { json, fake } = await post(toolCall("add_state", { ...base, state: "on", ...extra }));
      expect(json.result?.isError ?? !!json.error).toBe(true);
      expect(fake.calls.some((c) => c.path.includes("create_pending_event"))).toBe(false);
    }
  });
  it("오프셋 없는 시각·잘못된 상태·범위 밖 출력은 거부", async () => {
    for (const args of [{ ...base, occurred_at: "2026-11-20T07:00:00", state: "on" }, { ...base, state: "maybe" }, { ...base, state: "on", output: 150 }]) {
      const { json } = await post(toolCall("add_state", args));
      expect(json.result?.isError ?? !!json.error).toBe(true);
    }
  });
  it("같은 키·같은 내용 재전송은 같은 pending_id, 다른 내용은 CONFLICT", async () => {
    const fake = fakeSupabase();
    const a = parseResult((await post(toolCall("add_life_event", { ...base, kind: "meal", meal_type: "점심" }), { fake })).json);
    const b = parseResult((await post(toolCall("add_life_event", { ...base, kind: "meal", meal_type: "점심" }), { fake })).json);
    const c = parseResult((await post(toolCall("add_life_event", { ...base, kind: "meal", meal_type: "저녁" }), { fake })).json);
    expect(b.data.pending_id).toBe(a.data.pending_id);
    expect(b.data.created).toBe(false);
    expect(c.isError).toBe(true);
    expect(c.data.error.code).toBe("CONFLICT");
  });
  it("429는 Retry-After를 따라 제한적으로 재시도", async () => {
    const fake = fakeSupabase({ status429: 1 });
    const r = await post(toolCall("add_medication", { ...base, drug: "가상약" }), { fake });
    expect(r.res.status).toBe(200);
  });
});

describe("조회 도구", () => {
  it("get_daily_log: 서울 자정 범위·순서·커서", async () => {
    const events = Array.from({ length: 3 }, (_, i) => ({ id: `00000000-0000-4000-8000-00000000000${i}`, kind: "state", occurred_at: `2026-11-19T2${i}:00:00+00:00`, payload: { state: "on" }, source: "browser_upload" }));
    const { json, fake } = await post(toolCall("get_daily_log", { date: "2026-11-20", page_size: 2 }), { fake: fakeSupabase({ events }) });
    const r = parseResult(json);
    const q = decodeURIComponent(fake.calls.find((c) => c.path.includes("diary_events"))!.path);
    expect(q).toContain("occurred_at=gte.2026-11-19T15:00:00.000Z");
    expect(q).toContain("occurred_at=lt.2026-11-20T15:00:00.000Z");
    expect(q).toContain("order=occurred_at.asc,id.asc");
    expect(q).toContain("limit=3");
    expect(q).toContain(`user_id=eq.${OWNER}`);
    expect(r.data.count).toBe(2);
    expect(r.data.events[0].occurred_at).toBe("2026-11-20T05:00:00+09:00");
    expect(r.data.next_cursor).toBeTruthy();
    const next = await post(toolCall("get_daily_log", { date: "2026-11-20", cursor: r.data.next_cursor }), { fake: fakeSupabase({ events: [] }) });
    const q2 = decodeURIComponent(next.fake.calls.find((c) => c.path.includes("diary_events"))!.path);
    expect(q2).toContain("or=(occurred_at.gt.2026-11-19T21:00:00.000Z,and(occurred_at.eq.2026-11-19T21:00:00.000Z,id.gt.00000000-0000-4000-8000-000000000001))");
  });
  it("get_daily_log: page_size 상한 100, 잘못된 커서 거부", async () => {
    expect((await post(toolCall("get_daily_log", { date: "2026-11-20", page_size: 101 }))).json.result.isError).toBe(true);
    expect(parseResult((await post(toolCall("get_daily_log", { date: "2026-11-20", cursor: "abc" }))).json).data.error.code).toBe("INVALID_INPUT");
  });
  it("get_weekly_summary: 7일 창으로 집계", async () => {
    const events = [
      { id: "00000000-0000-4000-8000-000000000001", kind: "med", occurred_at: "2026-11-15T22:00:00Z", payload: { drug: "가상약" }, source: "x" },
      { id: "00000000-0000-4000-8000-000000000002", kind: "state", occurred_at: "2026-11-15T22:30:00Z", payload: { state: "off" }, source: "x" },
      { id: "00000000-0000-4000-8000-000000000003", kind: "state", occurred_at: "2026-11-15T23:00:00Z", payload: { state: "on" }, source: "x" },
      { id: "00000000-0000-4000-8000-000000000004", kind: "state", occurred_at: "2026-11-16T00:00:00Z", payload: { state: "off" }, source: "x" },
    ];
    const { json, fake } = await post(toolCall("get_weekly_summary", { start_date: "2026-11-16" }), { fake: fakeSupabase({ events }) });
    const r = parseResult(json);
    expect(r.data.dose_to_on.values_min).toEqual([60]);
    expect(r.data.on_duration.values_min).toEqual([60]);
    expect(r.data.window).toEqual({ start: "2026-11-16", end_exclusive: "2026-11-23", timezone: "Asia/Seoul" });
    const q = decodeURIComponent(fake.calls.find((c) => c.path.includes("diary_events"))!.path);
    expect(q).toContain("occurred_at=lt.2026-11-22T15:00:00.000Z");
    expect(q).toContain("limit=1001");
    expect(r.data.data.truncated).toBe(false);
  });
  it("get_weekly_summary: 조회 상한 초과는 truncated로 명시", async () => {
    const events = Array.from({ length: 1001 }, (_, i) => ({ id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, kind: "state", occurred_at: new Date(Date.parse("2026-11-16T00:00:00Z") + i * 60000).toISOString(), payload: { state: "on" }, source: "x" }));
    const r = parseResult((await post(toolCall("get_weekly_summary", { start_date: "2026-11-16" }), { fake: fakeSupabase({ events }) })).json);
    expect(r.data.data.truncated).toBe(true);
    expect(r.data.data.state_observations).toBe(1000);
    expect(r.data.notes.join(" ")).toMatch(/조회 상한/);
  });
});
