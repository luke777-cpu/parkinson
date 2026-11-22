import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { headersFor, getHeaders } from "../bin/diary-mcp-headers.mjs";

const url = "https://yakhyo-mcp-staging.example.workers.dev/mcp";
const tok = "aaa.bbb.ccc";
const NEW = "nnn.ooo.ppp";
function setup(data: object, mode = 0o600) {
  const f = join(mkdtempSync(join(tmpdir(), "hh-")), "t.json");
  writeFileSync(f, JSON.stringify(data)); chmodSync(f, mode);
  return f;
}
const now = () => Math.floor(Date.now() / 1000);
const base = { url, supabase_url: "https://ref.supabase.co", publishable_key: "sb_publishable_x" };
const env = (f: string, u = url) => ({ DIARY_MCP_TOKEN_FILE: f, CLAUDE_CODE_MCP_SERVER_URL: u });

describe("diary-mcp-headers (검사)", () => {
  it("URL이 정확히 같고 미만료면 Authorization만 반환", () => {
    const f = setup({ url, access_token: tok, expires_at: now() + 600 });
    expect(headersFor(env(f))).toEqual({ Authorization: `Bearer ${tok}` });
  });
  it("다른 URL·URL 없음은 거부", () => {
    const f = setup({ url, access_token: tok, expires_at: now() + 600 });
    expect(() => headersFor(env(f, url + "x"))).toThrow();
    expect(() => headersFor({ DIARY_MCP_TOKEN_FILE: f })).toThrow();
  });
  it("만료 토큰·넓은 파일 권한·http 원격 주소는 거부", () => {
    expect(() => headersFor(env(setup({ url, access_token: tok, expires_at: 1 })))).toThrow(/만료/);
    expect(() => headersFor(env(setup({ url, access_token: tok, expires_at: now() + 600 }, 0o644)))).toThrow(/권한/);
    const http = "http://evil.example/mcp";
    expect(() => headersFor(env(setup({ url: http, access_token: tok, expires_at: now() + 600 }), http))).toThrow();
  });
});

describe("diary-mcp-headers (자동 갱신)", () => {
  const okRefresh = (calls: unknown[]) => (async (u: string, init: RequestInit) => {
    calls.push({ u, body: JSON.parse(String(init.body)) });
    return Response.json({ access_token: NEW, refresh_token: "r2", expires_at: now() + 3600 });
  }) as unknown as typeof fetch;

  it("충분히 남았으면 서버 호출 없이 그대로", async () => {
    const calls: unknown[] = [];
    const f = setup({ ...base, access_token: tok, refresh_token: "r1", expires_at: now() + 600 });
    expect(await getHeaders(env(f), Date.now(), okRefresh(calls))).toEqual({ Authorization: `Bearer ${tok}` });
    expect(calls).toHaveLength(0);
  });
  it("2분 안에 끝나면 갱신하고 파일도 새 토큰으로 바꿈(리프레시 토큰 회전)", async () => {
    const calls: { u: string; body: { refresh_token: string } }[] = [];
    const f = setup({ ...base, access_token: tok, refresh_token: "r1", expires_at: now() + 60 });
    expect(await getHeaders(env(f), Date.now(), okRefresh(calls))).toEqual({ Authorization: `Bearer ${NEW}` });
    expect(calls[0].u).toBe("https://ref.supabase.co/auth/v1/token?grant_type=refresh_token");
    expect(calls[0].body.refresh_token).toBe("r1");
    const saved = JSON.parse(readFileSync(f, "utf8"));
    expect(saved.access_token).toBe(NEW);
    expect(saved.refresh_token).toBe("r2");
    expect(saved.url).toBe(url);
  });
  it("갱신 거부되면 실패(닫힘), 단 다른 창이 먼저 갱신해 둔 파일이면 그걸 사용", async () => {
    const f = setup({ ...base, access_token: tok, refresh_token: "r1", expires_at: 1 });
    const reject = (async () => new Response("{}", { status: 400 })) as unknown as typeof fetch;
    await expect(getHeaders(env(f), Date.now(), reject)).rejects.toThrow(/거부/);
    const raced = (async () => {
      writeFileSync(f, JSON.stringify({ ...base, access_token: NEW, refresh_token: "r9", expires_at: now() + 3600 }));
      return new Response("{}", { status: 400 });
    }) as unknown as typeof fetch;
    expect(await getHeaders(env(f), Date.now(), raced)).toEqual({ Authorization: `Bearer ${NEW}` });
  });
  it("리프레시 토큰이 없는 예전 파일은 다시 로그인 안내", async () => {
    const f = setup({ url, access_token: tok, expires_at: 1 });
    await expect(getHeaders(env(f))).rejects.toThrow(/다시 로그인/);
  });
  it("갱신 주소가 http 원격이면 보내지 않음", async () => {
    const calls: unknown[] = [];
    const f = setup({ ...base, supabase_url: "http://evil.example", access_token: tok, refresh_token: "r1", expires_at: 1 });
    await expect(getHeaders(env(f), Date.now(), okRefresh(calls))).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });
});
