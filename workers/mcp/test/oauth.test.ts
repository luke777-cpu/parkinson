// OAuth 보호 리소스 계약 시험: 발견 문서·401 챌린지·동의 화면 보안 헤더
import { describe, expect, it } from "vitest";
import { handle, type Env } from "../src/index.js";
import { KNOWN_APPS } from "../src/oauth.js";

const env: Env = { SUPABASE_URL: "https://ref.supabase.co", SUPABASE_PUBLISHABLE_KEY: "sb_publishable_test", ALLOWED_ORIGINS: "https://claude.ai", RESOURCE_NAME: "약효일지 (시험)" };
const O = "https://w.example.test";

describe("보호 리소스 메타데이터 (RFC 9728)", () => {
  for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp"]) {
    it(`${path}: resource와 Supabase 인가 서버를 알린다`, async () => {
      const r = await handle(new Request(O + path), env);
      expect(r.status).toBe(200);
      expect(r.headers.get("access-control-allow-origin")).toBe("*");
      const j = await r.json();
      expect(j).toEqual({ resource: `${O}/mcp`, authorization_servers: ["https://ref.supabase.co/auth/v1"], bearer_methods_supported: ["header"], resource_name: "약효일지 (시험)" });
    });
  }
  it("POST는 405, OPTIONS는 CORS 204", async () => {
    expect((await handle(new Request(O + "/.well-known/oauth-protected-resource", { method: "POST" }), env)).status).toBe(405);
    const p = await handle(new Request(O + "/.well-known/oauth-protected-resource/mcp", { method: "OPTIONS" }), env);
    expect(p.status).toBe(204);
  });
});

describe("인가 서버 메타데이터 전달", () => {
  it("Supabase의 경로 삽입형 발견 주소를 그대로 전달", async () => {
    const seen: string[] = [];
    const f = (async (u: RequestInfo | URL) => { seen.push(String(u)); return Response.json({ issuer: "https://ref.supabase.co/auth/v1", registration_endpoint: "x" }); }) as typeof fetch;
    const r = await handle(new Request(O + "/.well-known/oauth-authorization-server"), env, { fetchImpl: f });
    expect(seen).toEqual(["https://ref.supabase.co/.well-known/oauth-authorization-server/auth/v1"]);
    expect(((await r.json()) as { issuer: string }).issuer).toBe("https://ref.supabase.co/auth/v1");
  });
  it("상류 실패는 503", async () => {
    const f = (async () => new Response("x", { status: 404 })) as unknown as typeof fetch;
    expect((await handle(new Request(O + "/.well-known/oauth-authorization-server"), env, { fetchImpl: f })).status).toBe(503);
    const g = (async () => { throw new TypeError("net"); }) as unknown as typeof fetch;
    expect((await handle(new Request(O + "/.well-known/oauth-authorization-server"), env, { fetchImpl: g })).status).toBe(503);
  });
});

describe("401 챌린지", () => {
  const call = (auth?: string) => handle(new Request(O + "/mcp", { method: "POST", headers: { "content-type": "application/json", ...(auth ? { authorization: auth } : {}) }, body: "{}" }), env);
  it("토큰 없음: resource_metadata를 알리고 error는 붙이지 않는다", async () => {
    const r = await call();
    expect(r.status).toBe(401);
    const h = r.headers.get("www-authenticate")!;
    expect(h).toContain(`resource_metadata="${O}/.well-known/oauth-protected-resource/mcp"`);
    expect(h).not.toContain("error=");
  });
  it("잘못된 토큰: invalid_token", async () => {
    const r = await call("Bearer a.b.c");
    expect(r.headers.get("www-authenticate")).toContain('error="invalid_token"');
  });
  it("허용 목록 Origin(claude.ai)은 통과해 401까지 진행, 그 외 Origin은 403", async () => {
    const ok = await handle(new Request(O + "/mcp", { method: "POST", headers: { origin: "https://claude.ai", "content-type": "application/json" }, body: "{}" }), env);
    expect(ok.status).toBe(401);
    const bad = await handle(new Request(O + "/mcp", { method: "POST", headers: { origin: "https://evil.example", "content-type": "application/json" }, body: "{}" }), env);
    expect(bad.status).toBe(403);
  });
});

describe("동의 화면", () => {
  it("보안 헤더: CSP(nonce·연결 대상 제한·프레임 금지), no-store, nosniff, no-referrer", async () => {
    const r = await handle(new Request(O + "/oauth/consent?authorization_id=abc12345"), env);
    expect(r.status).toBe(200);
    const csp = r.headers.get("content-security-policy")!;
    const n = /script-src 'nonce-([A-Za-z0-9]+)'/.exec(csp)?.[1];
    expect(n).toBeTruthy();
    expect(csp).toContain("connect-src https://ref.supabase.co");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("unsafe-inline");
    expect(r.headers.get("x-frame-options")).toBe("DENY");
    expect(r.headers.get("cache-control")).toBe("no-store");
    expect(r.headers.get("referrer-policy")).toBe("no-referrer");
    const html = await r.text();
    expect(html).toContain(`<script nonce="${n}">`);
    expect(html).not.toContain("__NONCE__");
    expect(html).not.toContain("__CFG__");
    expect(html).toContain('"key":"sb_publishable_test"');
  });
  it("요청마다 nonce가 다르다", async () => {
    const a = (await handle(new Request(O + "/oauth/consent"), env)).headers.get("content-security-policy");
    const b = (await handle(new Request(O + "/oauth/consent"), env)).headers.get("content-security-policy");
    expect(a).not.toBe(b);
  });
  it("설정값의 </script> 같은 문자열은 이스케이프된다", async () => {
    const r = await handle(new Request(O + "/oauth/consent"), { ...env, RESOURCE_NAME: "</script><b>" });
    const html = await r.text();
    expect(html).not.toContain("</script><b>");
    expect(html).toContain("\\u003c/script\\u003e");
  });
  it("POST는 405", async () => {
    expect((await handle(new Request(O + "/oauth/consent", { method: "POST" }), env)).status).toBe(405);
  });
  it("알려진 앱 판정 규칙(표시용)", () => {
    const name = (h: string) => KNOWN_APPS.find(([re]) => re.test(h))?.[1];
    expect(name("chatgpt.com")).toBe("ChatGPT");
    expect(name("claude.ai")).toBe("Claude");
    expect(name("claude.ai.evil.com")).toBeUndefined();
    expect(name("evilchatgpt.com")).toBeUndefined();
  });
});
