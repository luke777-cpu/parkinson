#!/usr/bin/env node
// Claude Code headersHelper — 단기 에이전트 액세스 토큰을 Authorization 헤더 JSON으로만 출력한다.
//  * 토큰 파일: ${DIARY_MCP_TOKEN_FILE:-$XDG_CONFIG_HOME/yakhyo-mcp/agent-token.json} (권한 0600 필수)
//  * Claude Code가 넘기는 CLAUDE_CODE_MCP_SERVER_URL이 파일에 등록된 시험 Worker URL과 정확히 같을 때만 반환
//  * 만료됐거나 조건이 맞지 않으면 아무 헤더도 내지 않고 실패(닫힌 상태). 토큰을 stderr/로그에 쓰지 않는다.
// 토큰 파일은 diary-mcp-login.mjs로 만들고, 시험 후 `diary-mcp-login.mjs --revoke`로 폐기한다.
import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export function tokenFilePath(env = process.env) {
  if (env.DIARY_MCP_TOKEN_FILE) return env.DIARY_MCP_TOKEN_FILE;
  const base = env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "yakhyo-mcp", "agent-token.json");
}

export function headersFor(env = process.env, now = Date.now()) {
  const file = tokenFilePath(env);
  let st;
  try { st = statSync(file); } catch { throw new Error("토큰 파일이 없습니다. diary-mcp-login.mjs를 먼저 실행하세요"); }
  if (process.platform !== "win32" && (st.mode & 0o077) !== 0) throw new Error("토큰 파일 권한이 너무 넓습니다(chmod 600 필요)");
  const data = JSON.parse(readFileSync(file, "utf8"));
  const serverUrl = env.CLAUDE_CODE_MCP_SERVER_URL;
  if (!serverUrl || serverUrl !== data.url) throw new Error("등록된 시험 Worker URL과 요청 URL이 다릅니다");
  if (!/^https:\/\//.test(data.url) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(data.url)) throw new Error("https 또는 로컬 주소만 허용합니다");
  if (typeof data.access_token !== "string" || !/^[\w-]+\.[\w-]+\.[\w-]+$/.test(data.access_token)) throw new Error("토큰 형식 오류");
  if (!(typeof data.expires_at === "number" && data.expires_at * 1000 > now + 30_000)) throw new Error("토큰이 만료되었습니다. diary-mcp-login.mjs로 다시 발급하세요");
  return { Authorization: `Bearer ${data.access_token}` };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    process.stdout.write(JSON.stringify(headersFor()));
  } catch (e) {
    process.stderr.write(`diary-mcp-headers: ${e.message}\n`);
    process.exit(1);
  }
}
