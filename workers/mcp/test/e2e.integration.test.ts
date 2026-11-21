// 통합 시험: 실제 MCP 클라이언트(SDK StreamableHTTPClientTransport) → wrangler dev(workerd) → 로컬 Supabase(Auth+PostgREST+Postgres)
// 실행 전: tools/local-stack/start.sh, `npx wrangler dev --env staging --var SUPABASE_URL:... --var SUPABASE_PUBLISHABLE_KEY:...`
// 가상 계정만 새로 만들어 쓴다.
import { beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

const DIR = process.env.LOCAL_STACK_DIR || "/tmp/yakhyo-mcp-local";
const MCP_URL = process.env.MCP_URL || "http://127.0.0.1:8787/mcp";
const cfg = JSON.parse(readFileSync(`${DIR}/stack.json`, "utf8")) as { url: string; publishableKey: string; secretKey: string; pgPort: number };

const sql = (q: string) => execFileSync("psql", ["-h", "127.0.0.1", "-p", String(cfg.pgPort), "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-tAq", "-c", q], { encoding: "utf8" }).trim();
async function createUser(email: string, password: string): Promise<string> {
  const r = await fetch(`${cfg.url}/auth/v1/admin/users`, { method: "POST", headers: { apikey: cfg.secretKey, "content-type": "application/json" }, body: JSON.stringify({ email, password, email_confirm: true }) });
  return ((await r.json()) as { id: string }).id;
}
async function login(email: string, password: string): Promise<string> {
  const r = await fetch(`${cfg.url}/auth/v1/token?grant_type=password`, { method: "POST", headers: { apikey: cfg.publishableKey, "content-type": "application/json" }, body: JSON.stringify({ email, password }) });
  return ((await r.json()) as { access_token: string }).access_token;
}
async function rpc(token: string, fn: string, args: unknown) {
  const r = await fetch(`${cfg.url}/rest/v1/rpc/${fn}`, { method: "POST", headers: { apikey: cfg.publishableKey, authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(args) });
  return { status: r.status, json: await r.json() as unknown };
}
async function connect(token: string) {
  const client = new Client({ name: "e2e", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(MCP_URL), { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
  return client;
}
const data = (r: unknown) => JSON.parse((r as { content: { text: string }[] }).content[0].text);

describe("가상 기록 추가 요청 → 승인 → 조회 → 주간 집계 → 연결 폐기 → 접근 차단", () => {
  const tag = randomBytes(3).toString("hex");
  const pw = randomUUID();
  let userId: string, agentId: string, userTok: string, agentTok: string;

  beforeAll(async () => {
    userId = await createUser(`e2e-u-${tag}@example.test`, pw);
    agentId = await createUser(`e2e-a-${tag}@example.test`, pw);
    sql(`insert into public.diary_agent_links(agent_id, owner_id, expires_at) values ('${agentId}','${userId}', now() + interval '1 day')`);
    userTok = await login(`e2e-u-${tag}@example.test`, pw);
    agentTok = await login(`e2e-a-${tag}@example.test`, pw);
  });

  it("전체 흐름", async () => {
    const client = await connect(agentTok);
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual(["add_life_event", "add_medication", "add_state", "get_daily_log", "get_weekly_summary"]);

    // 세 종류 추가 요청 + 주간 집계용 상태 요청
    const reqs = [
      ["add_medication", { request_id: `e2e-${tag}-med`, occurred_at: "2026-11-10T07:00:00+09:00", drug: "가상약", dose_mg: 100 }],
      ["add_state", { request_id: `e2e-${tag}-s1`, occurred_at: "2026-11-10T07:30:00+09:00", state: "off", output: 15 }],
      ["add_state", { request_id: `e2e-${tag}-s2`, occurred_at: "2026-11-10T08:00:00+09:00", state: "on", output: 80 }],
      ["add_state", { request_id: `e2e-${tag}-s3`, occurred_at: "2026-11-10T09:00:00+09:00", state: "off", output: 20 }],
      ["add_life_event", { request_id: `e2e-${tag}-life`, occurred_at: "2026-11-10T12:00:00+09:00", kind: "meal", meal_type: "점심" }],
    ] as const;
    const pendingIds: string[] = [];
    for (const [name, args] of reqs) {
      const r = data(await client.callTool({ name, arguments: args }));
      expect(r.status).toBe("pending");
      pendingIds.push(r.pending_id);
    }
    // 재전송: 같은 결과
    const again = data(await client.callTool({ name: "add_medication", arguments: reqs[0][1] }));
    expect(again.pending_id).toBe(pendingIds[0]);
    expect(again.created).toBe(false);

    // 승인 전: 확정 조회에 없음
    const before = data(await client.callTool({ name: "get_daily_log", arguments: { date: "2026-11-10" } }));
    expect(before.count).toBe(0);

    // 거절 1건(만료·거절은 조회에 안 나타남) — 추가로 하나 만들고 거절
    const rej = data(await client.callTool({ name: "add_state", arguments: { request_id: `e2e-${tag}-rej`, occurred_at: "2026-11-10T10:00:00+09:00", state: "on" } }));
    expect((await rpc(userTok, "reject_pending_event", { p_pending_id: rej.pending_id })).json).toBe("rejected");

    // 사용자 승인(브라우저가 호출하는 것과 같은 RPC)
    for (const id of pendingIds) expect((await rpc(userTok, "approve_pending_event", { p_pending_id: id })).status).toBe(200);

    const day = data(await client.callTool({ name: "get_daily_log", arguments: { date: "2026-11-10" } }));
    expect(day.count).toBe(5);
    expect(day.events.map((e: { kind: string }) => e.kind)).toEqual(["med", "state", "state", "state", "life"]);
    expect(day.events.filter((e: { kind: string }) => e.kind === "med")).toHaveLength(1);
    expect(day.events.filter((e: { kind: string }) => e.kind === "life")).toHaveLength(1);
    expect(day.events[0].occurred_at).toBe("2026-11-10T07:00:00+09:00");

    // 페이지 나누기
    const p1 = data(await client.callTool({ name: "get_daily_log", arguments: { date: "2026-11-10", page_size: 2 } }));
    const p2 = data(await client.callTool({ name: "get_daily_log", arguments: { date: "2026-11-10", page_size: 2, cursor: p1.next_cursor } }));
    const p3 = data(await client.callTool({ name: "get_daily_log", arguments: { date: "2026-11-10", page_size: 2, cursor: p2.next_cursor } }));
    expect([...p1.events, ...p2.events, ...p3.events].map((e: { id: string }) => e.id)).toEqual(day.events.map((e: { id: string }) => e.id));
    expect(p3.next_cursor).toBeNull();

    // 인접 날짜(자정 경계) 비어 있음
    expect(data(await client.callTool({ name: "get_daily_log", arguments: { date: "2026-11-09" } })).count).toBe(0);

    const week = data(await client.callTool({ name: "get_weekly_summary", arguments: { start_date: "2026-11-09" } }));
    expect(week.dose_to_on.values_min).toEqual([60]);
    expect(week.on_duration.values_min).toEqual([60]);
    expect(week.settings.max_observation_gap_min).toBe(120);
    await client.close();

    // 사용자 연결 폐기 → 같은 토큰으로 접근 차단
    expect((await rpc(userTok, "revoke_agent_link", { p_agent_id: agentId })).status).toBe(200);
    const res = await fetch(MCP_URL, { method: "POST", headers: { authorization: `Bearer ${agentTok}`, "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    expect(res.status).toBe(403);
  });

  it("미인증·위조 토큰은 401", async () => {
    for (const auth of [undefined, "Bearer abc.def.ghi"]) {
      const res = await fetch(MCP_URL, { method: "POST", headers: { ...(auth ? { authorization: auth } : {}), "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
      expect(res.status).toBe(401);
    }
  });

  it("에이전트가 아닌 일반 사용자 토큰은 /mcp 403", async () => {
    const res = await fetch(MCP_URL, { method: "POST", headers: { authorization: `Bearer ${userTok}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    expect(res.status).toBe(403);
  });
});
