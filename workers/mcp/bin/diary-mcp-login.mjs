#!/usr/bin/env node
// 시험용 에이전트 계정으로 로그인해 "단기 액세스 토큰"만 권한 0600 파일에 저장한다(리프레시 토큰은 저장하지 않음).
//   node diary-mcp-login.mjs --mcp-url <시험 Worker /mcp 전체 URL> --supabase-url <URL> --publishable-key <sb_publishable_...>
//   node diary-mcp-login.mjs --revoke      # 세션 로그아웃 + 토큰 파일 삭제
// 이메일·비밀번호는 터미널에서 입력받고 화면·셸 이력·명령줄 인자에 남기지 않는다.
// 환경 변수 DIARY_AGENT_EMAIL / DIARY_AGENT_PASSWORD_FILE(권한 0600 파일)로 비대화식 실행도 가능.
import { mkdirSync, writeFileSync, readFileSync, rmSync, statSync, existsSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { createInterface } from "node:readline";
import { tokenFilePath } from "./diary-mcp-headers.mjs";

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, arr) => {
  if (a.startsWith("--")) acc.push([a.slice(2), arr[i + 1] && !arr[i + 1].startsWith("--") ? arr[i + 1] : true]);
  return acc;
}, []));
const file = tokenFilePath();

function ask(q, hidden) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
    if (hidden) rl._writeToOutput = (s) => { if (s.includes(q)) process.stderr.write(q); };
    rl.question(q, (ans) => { rl.close(); if (hidden) process.stderr.write("\n"); resolve(ans.trim()); });
  });
}

if (args.revoke) {
  if (existsSync(file)) {
    const d = JSON.parse(readFileSync(file, "utf8"));
    try {
      await fetch(`${d.supabase_url}/auth/v1/logout?scope=global`, { method: "POST", headers: { apikey: d.publishable_key, authorization: `Bearer ${d.access_token}` } });
    } catch { /* 네트워크 실패해도 파일은 지운다 */ }
    rmSync(file);
  }
  process.stderr.write("토큰 파일을 삭제했습니다. 필요하면 관리자에게 에이전트 연결 폐기도 요청하세요.\n");
  process.exit(0);
}

const mcpUrl = args["mcp-url"], supabaseUrl = String(args["supabase-url"] || "").replace(/\/+$/, ""), key = args["publishable-key"];
if (!mcpUrl || !supabaseUrl || !key) { process.stderr.write("필수: --mcp-url --supabase-url --publishable-key\n"); process.exit(2); }
if (!/^sb_publishable_/.test(key)) { process.stderr.write("publishable key만 사용합니다(secret/service_role 금지)\n"); process.exit(2); }

const email = process.env.DIARY_AGENT_EMAIL || await ask("에이전트 계정 이메일: ");
let password;
if (process.env.DIARY_AGENT_PASSWORD_FILE) {
  const st = statSync(process.env.DIARY_AGENT_PASSWORD_FILE);
  if ((st.mode & 0o077) !== 0) { process.stderr.write("비밀번호 파일 권한은 600이어야 합니다\n"); process.exit(2); }
  password = readFileSync(process.env.DIARY_AGENT_PASSWORD_FILE, "utf8").trim();
} else password = await ask("비밀번호(표시되지 않음): ", true);

const r = await fetch(`${supabaseUrl}/auth/v1/token?grant_type=password`, {
  method: "POST", headers: { apikey: key, "content-type": "application/json" }, body: JSON.stringify({ email, password }),
});
if (!r.ok) { process.stderr.write(`로그인 실패(${r.status})\n`); process.exit(1); }
const j = await r.json();
mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
writeFileSync(file, JSON.stringify({ url: mcpUrl, supabase_url: supabaseUrl, publishable_key: key, access_token: j.access_token, expires_at: j.expires_at }), { mode: 0o600 });
chmodSync(file, 0o600);
process.stderr.write(`단기 토큰을 저장했습니다(만료: ${new Date(j.expires_at * 1000).toISOString()}). 파일: ${file}\n`);
