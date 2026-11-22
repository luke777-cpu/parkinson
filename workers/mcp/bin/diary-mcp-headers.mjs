#!/usr/bin/env node
// Claude Code headersHelper — 에이전트 액세스 토큰을 Authorization 헤더 JSON으로만 출력한다.
//  * 토큰 파일: ${DIARY_MCP_TOKEN_FILE:-$XDG_CONFIG_HOME/yakhyo-mcp/agent-token.json} (Windows 외 권한 0600 필수)
//  * Claude Code가 넘기는 CLAUDE_CODE_MCP_SERVER_URL이 파일에 등록된 Worker URL과 정확히 같을 때만 반환
//  * 액세스 토큰(1시간)이 2분 안에 끝나면 저장된 리프레시 토큰으로 스스로 갱신한다(로그인은 처음 한 번).
//    연결 폐기는 Worker·DB가 호출마다 확인하므로 갱신해도 즉시 차단된다.
//  * 조건이 맞지 않거나 갱신이 실패하면 아무 헤더도 내지 않고 실패(닫힌 상태). 토큰을 출력 외 어디에도 쓰지 않는다.
// 토큰 파일은 diary-mcp-login.mjs로 만들고, 그만 쓸 때 `diary-mcp-login.mjs --revoke`로 폐기한다.
import { readFileSync, writeFileSync, renameSync, statSync, appendFileSync, mkdirSync, realpathSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const REFRESH_MARGIN_MS = 120_000;

export function tokenFilePath(env = process.env) {
  if (env.DIARY_MCP_TOKEN_FILE) return env.DIARY_MCP_TOKEN_FILE;
  const base = env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "yakhyo-mcp", "agent-token.json");
}

const JWT_RE = /^[\w-]+\.[\w-]+\.[\w-]+$/;
const isAllowedUrl = (u) => typeof u === "string" && (/^https:\/\//.test(u) || /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(u));

/** 파일을 읽고 위치·권한·URL을 검사한다(만료 검사는 하지 않음). */
export function readToken(env = process.env) {
  const file = tokenFilePath(env);
  let st;
  try { st = statSync(file); } catch { throw new Error("토큰 파일이 없습니다. diary-mcp-login.mjs를 먼저 실행하세요"); }
  if (process.platform !== "win32" && (st.mode & 0o077) !== 0) throw new Error("토큰 파일 권한이 너무 넓습니다(chmod 600 필요)");
  const data = JSON.parse(readFileSync(file, "utf8"));
  const serverUrl = env.CLAUDE_CODE_MCP_SERVER_URL;
  if (!serverUrl || serverUrl !== data.url) throw new Error("등록된 Worker URL과 요청 URL이 다릅니다");
  if (!isAllowedUrl(data.url)) throw new Error("https 또는 로컬 주소만 허용합니다");
  if (typeof data.access_token !== "string" || !JWT_RE.test(data.access_token)) throw new Error("토큰 형식 오류");
  return { file, data };
}

const fresh = (data, now) => typeof data.expires_at === "number" && data.expires_at * 1000 > now + REFRESH_MARGIN_MS;
const header = (data) => ({ Authorization: `Bearer ${data.access_token}` });

/** 갱신 없이 검사만(이전 동작). */
export function headersFor(env = process.env, now = Date.now()) {
  const { data } = readToken(env);
  if (!(typeof data.expires_at === "number" && data.expires_at * 1000 > now + 30_000)) throw new Error("토큰이 만료되었습니다. diary-mcp-login.mjs로 다시 발급하세요");
  return header(data);
}

function writeTokenFile(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data), { mode: 0o600 });
  try { chmodSync(tmp, 0o600); } catch { /* Windows */ }
  renameSync(tmp, file);
}

/** 필요하면 갱신까지 해서 헤더를 돌려준다. */
export async function getHeaders(env = process.env, now = Date.now(), fetchImpl = fetch) {
  const { file, data } = readToken(env);
  if (fresh(data, now)) return header(data);
  if (typeof data.refresh_token !== "string" || !data.refresh_token) throw new Error("토큰이 만료되었습니다(자동 갱신 정보 없음). diary-mcp-login.mjs로 다시 로그인하세요");
  if (!isAllowedUrl(`${data.supabase_url}/`) || !/^sb_publishable_/.test(data.publishable_key || "")) throw new Error("갱신 설정이 올바르지 않습니다. 다시 로그인하세요");

  let res;
  try {
    res = await fetchImpl(`${data.supabase_url}/auth/v1/token?grant_type=refresh_token`, {
      method: "POST",
      headers: { apikey: data.publishable_key, "content-type": "application/json" },
      body: JSON.stringify({ refresh_token: data.refresh_token }),
      signal: AbortSignal.timeout(8000),
    });
  } catch {
    throw new Error("토큰 갱신 중 서버에 연결할 수 없습니다");
  }
  if (!res.ok) {
    // 다른 Claude Code 창이 방금 갱신했을 수 있다 — 파일을 다시 읽어 본다.
    try { const again = readToken(env).data; if (fresh(again, Date.now())) return header(again); } catch { /* fallthrough */ }
    throw new Error(`토큰 갱신이 거부되었습니다(${res.status}). diary-mcp-login.mjs로 다시 로그인하세요`);
  }
  const j = await res.json();
  if (typeof j.access_token !== "string" || !JWT_RE.test(j.access_token) || typeof j.refresh_token !== "string") throw new Error("토큰 갱신 응답 형식 오류");
  const next = { ...data, access_token: j.access_token, refresh_token: j.refresh_token, expires_at: j.expires_at, refreshed_at: new Date().toISOString() };
  writeTokenFile(file, next);
  return header(next);
}

/** 실패 이유만 토큰 파일 옆 helper.log에 남긴다(토큰·헤더 값은 절대 기록하지 않음). */
function logDiag(line) {
  try {
    const dir = dirname(tokenFilePath());
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "helper.log"), `${new Date().toISOString()} ${line}\n`);
  } catch { /* 진단 실패는 무시 */ }
}

// Windows에서는 import.meta.url(file:///C:/...)과 argv[1](C:\...)의 모양이 달라 단순 비교가 실패한다.
const isMain = (() => {
  try { return process.argv[1] && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]); }
  catch { return false; }
})();

if (isMain) {
  const envUrl = process.env.CLAUDE_CODE_MCP_SERVER_URL;
  getHeaders().then((h) => {
    process.stdout.write(JSON.stringify(h));
    logDiag(`ok server=${envUrl ?? "(unset)"}`);
  }, (e) => {
    logDiag(`fail reason="${e.message}" server=${envUrl === undefined ? "(unset)" : JSON.stringify(envUrl)}`);
    process.stderr.write(`diary-mcp-headers: ${e.message}\n`);
    process.exit(1);
  });
}
