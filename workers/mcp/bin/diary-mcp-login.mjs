#!/usr/bin/env node
// 에이전트 계정으로 한 번 로그인해 액세스 토큰과 리프레시 토큰을 권한 0600 파일에 저장한다.
// 이후 diary-mcp-headers.mjs가 만료 전에 스스로 갱신한다. 그만 쓸 때는 --revoke(로그아웃+파일 삭제).
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
    let access = d.access_token;
    try {
      // 액세스 토큰이 끝났으면 리프레시 토큰으로 한 번 갱신해야 서버 세션(리프레시 토큰 포함)을 끝낼 수 있다.
      if (!(d.expires_at * 1000 > Date.now() + 30_000) && d.refresh_token) {
        const r = await fetch(`${d.supabase_url}/auth/v1/token?grant_type=refresh_token`, { method: "POST", headers: { apikey: d.publishable_key, "content-type": "application/json" }, body: JSON.stringify({ refresh_token: d.refresh_token }) });
        if (r.ok) access = (await r.json()).access_token;
      }
      const lo = await fetch(`${d.supabase_url}/auth/v1/logout?scope=global`, { method: "POST", headers: { apikey: d.publishable_key, authorization: `Bearer ${access}` } });
      process.stderr.write(lo.ok ? "서버 세션을 종료했습니다.\n" : `서버 로그아웃 응답 ${lo.status} — 연결 폐기로 차단하세요.\n`);
    } catch { process.stderr.write("서버에 연결하지 못했습니다 — 파일만 삭제합니다.\n"); }
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
writeFileSync(file, JSON.stringify({ url: mcpUrl, supabase_url: supabaseUrl, publishable_key: key, access_token: j.access_token, refresh_token: j.refresh_token, expires_at: j.expires_at }), { mode: 0o600 });
chmodSync(file, 0o600);
process.stderr.write(`로그인 정보를 저장했습니다. 이제 토큰은 자동으로 갱신됩니다(그만 쓸 때: --revoke). 파일: ${file}\n`);
