// 로컬 시험 스택용 최소 클라이언트 (Supabase Auth + Data API를 HTTP로 직접 호출)
import { readFileSync } from "node:fs";

export const dir = process.env.LOCAL_STACK_DIR || "/tmp/yakhyo-mcp-local";
export const cfg = JSON.parse(readFileSync(`${dir}/stack.json`, "utf8"));

export async function login(account) {
  const r = await fetch(`${cfg.url}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: cfg.publishableKey, "content-type": "application/json" },
    body: JSON.stringify({ email: account.email, password: account.password }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`login failed ${r.status}`);
  return j.access_token;
}

export async function rest(token, method, path, body, extraHeaders = {}) {
  const headers = { apikey: cfg.publishableKey, "content-type": "application/json", ...extraHeaders };
  if (token) headers.authorization = `Bearer ${token}`;
  const r = await fetch(`${cfg.url}/rest/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: r.status, json };
}

export const rpc = (token, fn, args) => rest(token, "POST", `/rpc/${fn}`, args);
