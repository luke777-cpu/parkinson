import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { headersFor } from "../bin/diary-mcp-headers.mjs";

const url = "https://yakhyo-mcp-staging.example.workers.dev/mcp";
const tok = "aaa.bbb.ccc";
function setup(data: object, mode = 0o600) {
  const f = join(mkdtempSync(join(tmpdir(), "hh-")), "t.json");
  writeFileSync(f, JSON.stringify(data)); chmodSync(f, mode);
  return f;
}
const future = Math.floor(Date.now() / 1000) + 600;

describe("diary-mcp-headers", () => {
  it("URL이 정확히 같고 미만료면 Authorization만 반환", () => {
    const f = setup({ url, access_token: tok, expires_at: future });
    expect(headersFor({ DIARY_MCP_TOKEN_FILE: f, CLAUDE_CODE_MCP_SERVER_URL: url })).toEqual({ Authorization: `Bearer ${tok}` });
  });
  it("다른 URL·URL 없음은 거부", () => {
    const f = setup({ url, access_token: tok, expires_at: future });
    expect(() => headersFor({ DIARY_MCP_TOKEN_FILE: f, CLAUDE_CODE_MCP_SERVER_URL: url + "x" })).toThrow();
    expect(() => headersFor({ DIARY_MCP_TOKEN_FILE: f })).toThrow();
  });
  it("만료 토큰·넓은 파일 권한·http 원격 주소는 거부", () => {
    expect(() => headersFor({ DIARY_MCP_TOKEN_FILE: setup({ url, access_token: tok, expires_at: 1 }), CLAUDE_CODE_MCP_SERVER_URL: url })).toThrow(/만료/);
    expect(() => headersFor({ DIARY_MCP_TOKEN_FILE: setup({ url, access_token: tok, expires_at: future }, 0o644), CLAUDE_CODE_MCP_SERVER_URL: url })).toThrow(/권한/);
    const http = "http://evil.example/mcp";
    expect(() => headersFor({ DIARY_MCP_TOKEN_FILE: setup({ url: http, access_token: tok, expires_at: future }), CLAUDE_CODE_MCP_SERVER_URL: http })).toThrow();
  });
});
