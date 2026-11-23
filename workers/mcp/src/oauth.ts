// OAuth 2.1 연동 — 인가 서버는 Supabase Auth(OAuth 2.1 Server). Worker는 보호 리소스 역할만 한다.
//   GET /.well-known/oauth-protected-resource[/mcp]  — RFC 9728 보호 리소스 메타데이터
//   GET /.well-known/oauth-authorization-server       — 구 사양 클라이언트용: Supabase 발견 문서 전달
//   GET /oauth/consent                                 — 동의 화면(Supabase가 authorization_id와 함께 보냄)
// 동의 화면은 "연결된 에이전트 계정"으로 로그인한 경우에만 승인을 허용한다(사용자 본인 계정 거부).
// 토큰·비밀번호는 페이지 메모리에만 두고 저장하지 않는다. 승인/거부 후 임시 세션은 로그아웃한다.
import { issuerOf } from "./auth.js";

export interface OAuthEnv { SUPABASE_URL: string; SUPABASE_PUBLISHABLE_KEY: string; SUPABASE_JWT_ISSUER?: string; RESOURCE_NAME?: string }

const PUBLIC_JSON = {
  "content-type": "application/json",
  "cache-control": "public, max-age=300",
  "access-control-allow-origin": "*",
};

export function resourceMetadataUrl(origin: string): string {
  return `${origin}/.well-known/oauth-protected-resource/mcp`;
}

export function protectedResourceMetadata(origin: string, env: OAuthEnv): Response {
  return new Response(JSON.stringify({
    resource: `${origin}/mcp`,
    authorization_servers: [issuerOf(env)],
    bearer_methods_supported: ["header"],
    resource_name: env.RESOURCE_NAME || "약효일지",
  }), { headers: PUBLIC_JSON });
}

/** Supabase의 RFC 8414 발견 문서를 그대로 전달(구 사양 클라이언트는 MCP 서버 원점에서 찾는다). */
export async function authorizationServerMetadata(env: OAuthEnv, fetchImpl: typeof fetch = fetch): Promise<Response> {
  const base = env.SUPABASE_URL.replace(/\/+$/, "");
  try {
    const r = await fetchImpl(`${base}/.well-known/oauth-authorization-server/auth/v1`, { headers: { accept: "application/json" } });
    if (!r.ok) return new Response('{"error":"unavailable"}', { status: 503, headers: PUBLIC_JSON });
    return new Response(await r.text(), { headers: PUBLIC_JSON });
  } catch {
    return new Response('{"error":"unavailable"}', { status: 503, headers: PUBLIC_JSON });
  }
}

export function corsPreflight(): Response {
  return new Response(null, { status: 204, headers: {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, OPTIONS",
    "access-control-allow-headers": "content-type, mcp-protocol-version",
    "access-control-max-age": "600",
  } });
}

function nonce(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/[+/=]/g, "");
}

function jsonForHtml(v: unknown): string {
  return JSON.stringify(v).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026");
}

export function consentPage(env: OAuthEnv): Response {
  const n = nonce();
  const supa = env.SUPABASE_URL.replace(/\/+$/, "");
  const cfg = jsonForHtml({ url: supa, key: env.SUPABASE_PUBLISHABLE_KEY, name: env.RESOURCE_NAME || "약효일지" });
  const csp = [
    "default-src 'none'",
    `script-src 'nonce-${n}'`,
    `style-src 'nonce-${n}'`,
    `connect-src ${supa}`,
    "img-src 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "base-uri 'none'",
  ].join("; ");
  return new Response(CONSENT_HTML.replaceAll("__NONCE__", n).replace("__CFG__", cfg), {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "content-security-policy": csp,
      "x-frame-options": "DENY",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    },
  });
}

// 알려진 AI 앱의 돌아갈 주소(사용자 확인용 표시. 판정은 사용자가 한다).
// 브라우저에서 실행되는 스크립트와 같은 규칙을 시험하기 위해 내보낸다.
export const KNOWN_APPS: Array<[RegExp, string]> = [
  [/^(chatgpt\.com|chat\.openai\.com|platform\.openai\.com)$/, "ChatGPT"],
  [/^(claude\.ai|claude\.com)$/, "Claude"],
  [/^(127\.0\.0\.1|localhost|\[::1\])$/, "이 컴퓨터의 프로그램(예: Claude Code)"],
];

const CONSENT_HTML = `<!doctype html>
<html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>AI 연결 승인</title>
<style nonce="__NONCE__">
body{font-family:system-ui,-apple-system,"Apple SD Gothic Neo","Malgun Gothic",sans-serif;margin:0;background:#f4f6f8;color:#1d2733}
main{max-width:440px;margin:32px auto;padding:24px;background:#fff;border-radius:14px;box-shadow:0 2px 12px rgba(0,0,0,.08)}
h1{font-size:1.25rem;margin:0 0 12px}
p,li{line-height:1.55}
label{display:block;margin:12px 0 4px;font-weight:600}
input{width:100%;box-sizing:border-box;padding:10px;font-size:1rem;border:1px solid #c5ced8;border-radius:8px}
button{font-size:1rem;padding:12px 16px;border-radius:8px;border:0;cursor:pointer;margin-top:16px}
.primary{background:#2563eb;color:#fff;width:100%}
.row{display:flex;gap:10px}.row button{flex:1}
.ok{background:#16a34a;color:#fff}.no{background:#e5e7eb;color:#111}
.box{background:#f1f5f9;border-radius:10px;padding:12px;margin:12px 0}
.warn{background:#fff7ed;border:1px solid #fdba74;border-radius:10px;padding:12px;margin:12px 0}
.err{color:#b91c1c;margin-top:12px;white-space:pre-wrap}
.muted{color:#5b6775;font-size:.9rem}
.host{font-family:ui-monospace,Menlo,Consolas,monospace;word-break:break-all}
[hidden]{display:none!important}
</style></head>
<body><main>
<h1 id="title">AI 연결 승인</h1>
<section id="s-login">
  <p>AI 앱이 기록에 연결하려고 합니다. 이 AI에 배정한 <b>AI 전용 계정</b>으로 로그인하세요.<br><span class="muted">본인(기록 주인) 계정으로는 승인할 수 없습니다.</span></p>
  <form id="f-login" novalidate>
    <label for="email">AI 전용 계정 이메일</label>
    <input id="email" type="email" autocomplete="username" required>
    <label for="pw">비밀번호</label>
    <input id="pw" type="password" autocomplete="current-password" required>
    <button class="primary" type="submit" id="b-login">로그인</button>
  </form>
</section>
<section id="s-consent" hidden>
  <div class="box">
    <div><b id="c-app"></b> 이(가) 연결을 요청합니다.</div>
    <div class="muted">앱 이름(자체 신고): <span id="c-client"></span></div>
    <div class="muted">돌아갈 주소: <span class="host" id="c-host"></span></div>
    <div class="muted">로그인한 계정: <span id="c-user"></span></div>
  </div>
  <div class="warn" id="c-unknown" hidden>알 수 없는 주소입니다. 지금 직접 연결을 시작한 것이 아니라면 <b>거부</b>하세요.</div>
  <p>승인하면 이 AI는</p>
  <ul>
    <li>오늘 기록과 주간 요약을 <b>조회</b>할 수 있습니다.</li>
    <li>복용·상태·생활 기록을 <b>추가 요청</b>할 수 있습니다. 요청은 약효일지 앱에서 직접 승인해야 확정됩니다.</li>
    <li>기록을 수정하거나 지울 수 없습니다.</li>
  </ul>
  <p class="muted">연결은 앱의 클라우드 설정에서 언제든 폐기할 수 있습니다.</p>
  <div class="row"><button class="no" id="b-deny" type="button">거부</button><button class="ok" id="b-approve" type="button">승인</button></div>
</section>
<section id="s-blocked" hidden>
  <div class="warn" id="blocked-msg"></div>
  <button class="no" id="b-deny2" type="button">이 요청 거부</button>
</section>
<section id="s-done" hidden><p id="done-msg"></p></section>
<div class="err" id="err" role="alert"></div>
</main>
<script nonce="__NONCE__">
(() => {
  "use strict";
  const CFG = __CFG__;
  const KNOWN = [
    [/^(chatgpt\\.com|chat\\.openai\\.com|platform\\.openai\\.com)$/, "ChatGPT"],
    [/^(claude\\.ai|claude\\.com)$/, "Claude"],
    [/^(127\\.0\\.0\\.1|localhost|\\[::1\\])$/, "이 컴퓨터의 프로그램(예: Claude Code)"],
  ];
  const $ = (id) => document.getElementById(id);
  const show = (id) => { for (const s of ["s-login", "s-consent", "s-blocked", "s-done"]) $(s).hidden = s !== id; };
  const err = (m) => { $("err").textContent = m || ""; };
  const aid = new URLSearchParams(location.search).get("authorization_id");
  let token = null;

  if (!aid || !/^[A-Za-z0-9_-]{8,128}$/.test(aid)) { show("s-done"); $("done-msg").textContent = "잘못된 연결 요청입니다. AI 앱에서 연결을 다시 시작하세요."; return; }

  async function api(path, opts = {}) {
    const headers = { apikey: CFG.key, ...(opts.body ? { "content-type": "application/json" } : {}) };
    if (token) headers.authorization = "Bearer " + token;
    const r = await fetch(CFG.url + path, { method: opts.method || "GET", headers, body: opts.body ? JSON.stringify(opts.body) : undefined, cache: "no-store", credentials: "omit" });
    let j = null; try { j = await r.json(); } catch {}
    if (!r.ok) { const e = new Error((j && (j.msg || j.message || j.error_description || j.error)) || ("HTTP " + r.status)); e.status = r.status; throw e; }
    return j;
  }
  function safeRedirect(u) {
    let x; try { x = new URL(u); } catch { return false; }
    const loop = /^(127\\.0\\.0\\.1|localhost|\\[::1\\])$/.test(x.hostname);
    if (x.protocol !== "https:" && !(x.protocol === "http:" && loop)) return false;
    location.assign(x.href); return true;
  }
  async function logout() { if (!token) return; try { await api("/auth/v1/logout?scope=local", { method: "POST" }); } catch {} token = null; }
  async function decide(action) {
    err(); for (const b of ["b-approve", "b-deny", "b-deny2"]) $(b).disabled = true;
    try {
      const j = await api("/auth/v1/oauth/authorizations/" + encodeURIComponent(aid) + "/consent", { method: "POST", body: { action } });
      await logout();
      show("s-done"); $("done-msg").textContent = action === "approve" ? "승인했습니다. AI 앱으로 돌아갑니다…" : "거부했습니다. AI 앱으로 돌아갑니다…";
      if (!j || !j.redirect_url || !safeRedirect(j.redirect_url)) $("done-msg").textContent += "\\n(자동으로 돌아가지 않으면 이 창을 닫으세요.)";
    } catch (e) {
      err("처리하지 못했습니다: " + e.message + "\\nAI 앱에서 연결을 다시 시작하세요.");
      for (const b of ["b-approve", "b-deny", "b-deny2"]) $(b).disabled = false;
    }
  }

  $("f-login").addEventListener("submit", async (ev) => {
    ev.preventDefault(); err();
    const email = $("email").value.trim(), password = $("pw").value;
    if (!email || !password) { err("이메일과 비밀번호를 입력하세요."); return; }
    $("b-login").disabled = true;
    try {
      const s = await api("/auth/v1/token?grant_type=password", { method: "POST", body: { email, password } });
      token = s.access_token; $("pw").value = "";
      // 연결된 에이전트 계정인지 확인(사용자 본인 계정이면 승인 차단)
      const link = await api("/rest/v1/rpc/my_agent_link", { method: "POST", body: {} });
      if (!Array.isArray(link) || link.length === 0) {
        show("s-blocked");
        $("blocked-msg").textContent = "이 계정은 연결된 AI 전용 계정이 아닙니다(본인 계정이거나 연결이 폐기·만료됨). 이 계정으로는 승인할 수 없습니다.";
        return;
      }
      const d = await api("/auth/v1/oauth/authorizations/" + encodeURIComponent(aid));
      if (d && d.redirect_url && !d.authorization_id) { await logout(); show("s-done"); $("done-msg").textContent = "이미 승인된 연결입니다. AI 앱으로 돌아갑니다…"; safeRedirect(d.redirect_url); return; }
      let host = "(알 수 없음)"; try { host = new URL(d.redirect_uri).host; } catch {}
      const hn = host.replace(/:\\d+$/, "");
      const known = KNOWN.find(([re]) => re.test(hn));
      $("c-app").textContent = known ? known[1] : "알 수 없는 앱";
      $("c-client").textContent = (d.client && d.client.client_name) || "(이름 없음)";
      $("c-host").textContent = host;
      $("c-user").textContent = (d.user && d.user.email) || email;
      $("c-unknown").hidden = !!known;
      show("s-consent");
    } catch (e) {
      token = null;
      err(e.status === 400 || e.status === 401 ? "로그인하지 못했습니다. 이메일·비밀번호를 확인하세요." : "오류: " + e.message + "\\n요청이 만료됐을 수 있습니다(10분). AI 앱에서 다시 시작하세요.");
    } finally { $("b-login").disabled = false; }
  });
  $("b-approve").addEventListener("click", () => decide("approve"));
  $("b-deny").addEventListener("click", () => decide("deny"));
  $("b-deny2").addEventListener("click", async () => {
    // 승인 자격 없는 계정이라도 거부는 허용(요청을 즉시 닫음). Supabase는 요청 조회(사용자 연결) 후에만 결정을 받는다.
    try { await api("/auth/v1/oauth/authorizations/" + encodeURIComponent(aid)); } catch {}
    await decide("deny");
  });
})();
</script>
</body></html>`;
