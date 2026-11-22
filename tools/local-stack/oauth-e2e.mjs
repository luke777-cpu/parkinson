// OAuth 2.1 전체 흐름 E2E (로컬 시험 전용, 가상 데이터)
//   실제 MCP SDK 클라이언트(ChatGPT·Claude 앱과 같은 절차: 401 → 보호 리소스 발견 → 동적 등록 → PKCE 인가)
//   + 실제 Chrome(headless)으로 Worker 동의 화면 조작.
// 필요: start.sh 실행, Worker 로컬 실행(wrangler dev, 127.0.0.1:8787, SUPABASE_URL=로컬 스택), puppeteer-core
//   NODE_PATH=/tmp/pp/node_modules node tools/local-stack/oauth-e2e.mjs
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

const require = createRequire(import.meta.url);
const puppeteer = require("puppeteer-core");
const SDK = new URL("../../workers/mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/", import.meta.url).href;
const { Client } = await import(SDK + "client/index.js");
const { StreamableHTTPClientTransport } = await import(SDK + "client/streamableHttp.js");
const { UnauthorizedError } = await import(SDK + "client/auth.js");
const { adminCreateUser, sql } = await import("./seed.mjs");
const { login, rpc, rest, dir } = await import("./client.mjs");

const MCP = process.env.MCP_URL || "http://127.0.0.1:8787/mcp";
const OUT = join(dir, "oauth-e2e"); mkdirSync(OUT, { recursive: true });
let pass = 0, fail = 0;
const ok = (c, n) => { c ? pass++ : fail++; console.log((c ? "  ✔ " : "  ✘ FAIL: ") + n); };

// 가상 계정: 사용자 1, 그 사용자의 AI 전용 계정 1
const tag = randomUUID().slice(0, 8), pw = randomUUID();
const user = { email: `oa-u-${tag}@example.test`, password: pw };
const agent = { email: `oa-a-${tag}@example.test`, password: pw };
const uid = await adminCreateUser(user.email, pw);
const aid = await adminCreateUser(agent.email, pw);
sql(`insert into public.diary_agent_links(agent_id, owner_id, expires_at) values ('${aid}','${uid}', now() + interval '1 day')`);

const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--lang=ko-KR"] });

/** 메모리 OAuth 클라이언트(외부 AI 앱 역할). redirectToAuthorization에서 Chrome으로 동의 화면을 조작한다. */
function makeProvider(redirectUrl, account, opts = {}) {
  const st = { codeCapture: null };
  const p = {
    st,
    get redirectUrl() { return redirectUrl; },
    get clientMetadata() { return { client_name: opts.clientName || "E2E AI", redirect_uris: [redirectUrl], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" }; },
    clientInformation: () => st.client,
    saveClientInformation: (c) => { st.client = c; },
    tokens: () => st.tokens,
    saveTokens: (t) => { st.tokens = t; },
    saveCodeVerifier: (v) => { st.verifier = v; },
    codeVerifier: () => st.verifier,
    state: () => (st.state = randomUUID()),
    async redirectToAuthorization(url) {
      st.authUrl = url.href;
      const ctx = await browser.createBrowserContext();
      const page = await ctx.newPage();
      await page.setViewport({ width: 420, height: 900 });
      st.pageErrors = [];
      page.on("pageerror", (e) => st.pageErrors.push(String(e)));
      page.on("console", (m) => { if (m.type() === "error") st.pageErrors.push(m.text()); });
      await page.setRequestInterception(true);
      page.on("request", (r) => {
        if (r.url().startsWith(redirectUrl)) { st.codeCapture = new URL(r.url()); return r.respond({ status: 200, contentType: "text/plain", body: "callback" }); }
        r.continue();
      });
      await page.goto(url.href, { waitUntil: "networkidle0" });
      st.consentUrl = page.url();
      await page.type("#email", account.email);
      await page.type("#pw", account.password);
      await page.click("#b-login");
      await page.waitForFunction(() => !document.getElementById("s-consent").hidden || !document.getElementById("s-blocked").hidden || document.getElementById("err").textContent, { timeout: 10000 });
      st.view = await page.evaluate(() => ({
        consent: !document.getElementById("s-consent").hidden,
        blocked: !document.getElementById("s-blocked").hidden,
        app: document.getElementById("c-app").textContent,
        host: document.getElementById("c-host").textContent,
        unknownWarn: !document.getElementById("c-unknown").hidden,
        blockedMsg: document.getElementById("blocked-msg").textContent,
        err: document.getElementById("err").textContent,
      }));
      await page.screenshot({ path: join(OUT, `${opts.shot || "consent"}.png`) });
      const action = opts.action || "approve";
      if (st.view.consent) await page.click(action === "approve" ? "#b-approve" : "#b-deny");
      else if (st.view.blocked) await page.click("#b-deny2");
      for (let i = 0; i < 50 && !st.codeCapture; i++) await new Promise((r) => setTimeout(r, 100));
      await ctx.close();
    },
  };
  return p;
}

async function connectWithOAuth(provider) {
  const mk = () => new StreamableHTTPClientTransport(new URL(MCP), { authProvider: provider });
  const client = new Client({ name: "oauth-e2e", version: "1.0.0" });
  let t = mk();
  try { await client.connect(t); return { client, authorized: true }; }
  catch (e) {
    if (!(e instanceof UnauthorizedError)) throw e;
    const code = provider.st.codeCapture?.searchParams.get("code");
    if (!code) return { client: null, authorized: false };
    await t.finishAuth(code);
    const c2 = new Client({ name: "oauth-e2e", version: "1.0.0" });
    await c2.connect(mk());
    return { client: c2, authorized: true };
  }
}
const call = async (c, name, args) => { const r = await c.callTool({ name, arguments: args }); return { isError: !!r.isError, data: JSON.parse(r.content[0].text) }; };

try {
  console.log("1) 보호 리소스 발견");
  const unauth = await fetch(MCP, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
  const wa = unauth.headers.get("www-authenticate") || "";
  ok(unauth.status === 401 && /resource_metadata="[^"]+\/\.well-known\/oauth-protected-resource\/mcp"/.test(wa), "토큰 없이 401 + resource_metadata 안내");

  console.log("2) AI 전용 계정으로 동의 → 연결 (ChatGPT 주소 흉내)");
  const pA = makeProvider("https://chatgpt.com/connector_platform_oauth_redirect", agent, { clientName: "ChatGPT", shot: "consent-agent" });
  const A = await connectWithOAuth(pA);
  ok(pA.st.client?.client_id && pA.st.client.client_id.length > 10, "동적 클라이언트 등록");
  ok(new URL(pA.st.authUrl).searchParams.get("code_challenge_method") === "S256", "PKCE S256");
  ok(new URL(pA.st.consentUrl).pathname === "/oauth/consent", "Supabase가 Worker 동의 화면으로 보냄");
  ok(pA.st.view.consent && pA.st.view.app === "ChatGPT" && !pA.st.view.unknownWarn, "동의 화면: ChatGPT로 표시, 경고 없음");
  ok(pA.st.pageErrors.length === 0, `동의 화면 스크립트·CSP 오류 없음 ${pA.st.pageErrors.join(" | ")}`);
  ok(pA.st.codeCapture?.searchParams.get("code") && pA.st.codeCapture.searchParams.get("state") === pA.st.state, "인가 코드와 같은 state로 돌아감");
  ok(A.authorized, "토큰 교환 후 MCP 연결");
  const claims = JSON.parse(Buffer.from(pA.st.tokens.access_token.split(".")[1], "base64url"));
  ok(claims.sub === aid && claims.client_id === pA.st.client.client_id, "토큰 = AI 전용 계정 + client_id");
  const tools = (await A.client.listTools()).tools.map((t) => t.name).sort();
  ok(tools.join(",") === "add_life_event,add_medication,add_state,get_daily_log,get_weekly_summary", "도구 5개");

  console.log("3) 추가 요청 → 승인 전 0건 → 앱 승인 → 1건 → 재시도 후에도 1건");
  const req = { request_id: randomUUID(), occurred_at: "2026-11-21T08:00:00+09:00", source_tz: "Asia/Seoul", drug: "가상약 OAuth", dose_mg: 100 };
  const r1 = await call(A.client, "add_medication", req);
  ok(!r1.isError && r1.data.status === "pending", "추가 요청 = 승인 대기");
  ok((await call(A.client, "get_daily_log", { date: "2026-11-21" })).data.count === 0, "승인 전 0건");
  const userTok = await login(user);
  ok((await rpc(userTok, "approve_pending_event", { p_pending_id: r1.data.pending_id })).status === 200, "사용자 직접 세션으로 승인");
  ok((await call(A.client, "get_daily_log", { date: "2026-11-21" })).data.count === 1, "승인 후 1건");
  const r2 = await call(A.client, "add_medication", req);
  ok(!r2.isError && r2.data.pending_id === r1.data.pending_id, "같은 request_id 재시도 = 같은 요청");
  ok((await call(A.client, "get_daily_log", { date: "2026-11-21" })).data.count === 1, "재시도 후에도 1건");

  console.log("4) OAuth 토큰으로 사용자 권한 우회 불가");
  const at = pA.st.tokens.access_token;
  ok((await rpc(at, "approve_pending_event", { p_pending_id: r1.data.pending_id })).status >= 400, "AI 토큰으로 승인 RPC 거부");
  ok((await rpc(at, "revoke_agent_link", { p_agent_id: aid })).status >= 400, "AI 토큰으로 연결 폐기 거부");

  console.log("5) 토큰 갱신");
  const rt = await fetch(new URL(pA.st.authUrl).origin + "/auth/v1/oauth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: pA.st.tokens.refresh_token, client_id: pA.st.client.client_id }) });
  const rtj = await rt.json();
  ok(rt.status === 200 && rtj.access_token && rtj.refresh_token !== pA.st.tokens.refresh_token, "refresh_token 갱신·회전");

  console.log("6) 사용자 본인 계정으로 동의 시도 → 차단");
  const pU = makeProvider("https://claude.ai/api/mcp/auth_callback", user, { clientName: "Claude", shot: "consent-owner-blocked" });
  const U = await connectWithOAuth(pU);
  ok(pU.st.view.blocked && !pU.st.view.consent, "본인 계정: 승인 버튼 없이 차단 안내");
  ok(!U.authorized && pU.st.codeCapture?.searchParams.get("error") === "access_denied", `거부로 돌아가 토큰 없음 ${pU.st.codeCapture} ${pU.st.view.err}`);

  console.log("7) 알 수 없는 앱 경고");
  const pX = makeProvider("https://unknown-app.example/cb", agent, { clientName: "ChatGPT", shot: "consent-unknown", action: "deny" });
  const X = await connectWithOAuth(pX);
  ok(pX.st.view.consent && pX.st.view.unknownWarn && pX.st.view.app === "알 수 없는 앱", "이름을 ChatGPT라 해도 주소로 판정·경고");
  ok(!X.authorized, "거부 시 연결 안 됨");

  console.log("8) 앱에서 연결 폐기 → 즉시 차단");
  ok((await rpc(userTok, "revoke_agent_link", { p_agent_id: aid })).status === 200, "사용자 연결 폐기");
  let blocked = false;
  try { await A.client.callTool({ name: "get_daily_log", arguments: { date: "2026-11-21" } }); } catch (e) { blocked = /403|Forbidden/.test(String(e?.message || e)); }
  ok(blocked, "폐기 후 같은 토큰으로 MCP 호출 403");
  const after = await rest(rtj.access_token, "GET", `/diary_events?select=id&user_id=eq.${uid}`);
  ok(after.status === 200 && Array.isArray(after.json) && after.json.length === 0, "폐기 후 Data API 직접 조회도 0건");

  console.log("9) 폐기된 AI 계정으로 재동의 → 차단");
  const pR = makeProvider("https://chatgpt.com/connector_platform_oauth_redirect", agent, { clientName: "ChatGPT", shot: "consent-revoked" });
  const R = await connectWithOAuth(pR);
  ok(pR.st.view.blocked && !R.authorized, "폐기된 계정은 승인 불가");
} catch (e) {
  fail++; console.log("  ✘ 예외:", e?.stack || e);
} finally {
  await browser.close();
}
console.log(`\nOAuth E2E: ${pass} passed, ${fail} failed  (스크린샷: ${OUT})`);
process.exit(fail ? 1 : 0);
