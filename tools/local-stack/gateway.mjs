// 로컬 시험 전용 API 게이트웨이: Supabase의 /auth/v1, /rest/v1 경로와 apikey 검사를 흉내 낸다.
// 루프백(127.0.0.1)에만 바인딩한다. 로그에 요청 본문·토큰을 남기지 않는다.
import http from "node:http";
import { readFileSync } from "node:fs";
import { signJwt } from "./jwt.mjs";

const dir = process.env.LOCAL_STACK_DIR;
const cfg = JSON.parse(readFileSync(`${dir}/stack.json`, "utf8"));
const priv = JSON.parse(readFileSync(`${dir}/signing-key.json`, "utf8"));
const UPSTREAM = { "/auth/v1": cfg.gotruePort, "/rest/v1": cfg.postgrestPort };

function serviceRoleJwt() {
  const now = Math.floor(Date.now() / 1000);
  return signJwt(priv, { iss: cfg.issuer, role: "service_role", iat: now, exp: now + 300 });
}

function cors(req, res) {
  const origin = req.headers.origin;
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Headers", "authorization, apikey, content-type, prefer, x-client-info, accept-profile, content-profile, range");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Expose-Headers", "content-range");
}

// OAuth 2.1 서버 공개 엔드포인트(클라이언트가 apikey 없이 호출) — 호스팅 Supabase와 같게 apikey 검사 제외
const OAUTH_PUBLIC = [/^\/\.well-known\//, /^\/oauth\/authorize(\?|$)/, /^\/oauth\/token(\?|$)/, /^\/oauth\/clients\/register(\?|$)/];

http.createServer((req, res) => {
  cors(req, res);
  // RFC 8414 경로 삽입형 발견 주소: /.well-known/oauth-authorization-server/auth/v1
  if (req.url.startsWith("/.well-known/oauth-authorization-server/auth/v1") || req.url.startsWith("/.well-known/openid-configuration/auth/v1")) {
    req.url = "/auth/v1/.well-known/" + req.url.split("/")[2];
  }
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }
  const prefix = Object.keys(UPSTREAM).find((p) => req.url.startsWith(p + "/") || req.url === p);
  if (!prefix) { res.writeHead(404, { "content-type": "application/json" }); return res.end('{"message":"no route"}'); }
  const path = req.url.slice(prefix.length) || "/";
  const isJwks = prefix === "/auth/v1" && OAUTH_PUBLIC.some((re) => re.test(path));
  const apikey = req.headers.apikey;
  const isSecret = apikey === cfg.secretKey;
  if (!isJwks && apikey !== cfg.publishableKey && !isSecret) {
    res.writeHead(401, { "content-type": "application/json" });
    return res.end('{"message":"Invalid API key"}');
  }
  const headers = { ...req.headers, host: `127.0.0.1:${UPSTREAM[prefix]}` };
  delete headers.apikey;
  if (isSecret && !headers.authorization) headers.authorization = `Bearer ${serviceRoleJwt()}`;
  const up = http.request({ host: "127.0.0.1", port: UPSTREAM[prefix], method: req.method, path, headers }, (ur) => {
    const h = { ...ur.headers };
    res.writeHead(ur.statusCode, h);
    ur.pipe(res);
  });
  up.on("error", () => { if (!res.headersSent) res.writeHead(502); res.end(); });
  req.pipe(up);
}).listen(cfg.gatewayPort, "127.0.0.1", () => {
  console.log(`gateway listening on 127.0.0.1:${cfg.gatewayPort}`);
});
