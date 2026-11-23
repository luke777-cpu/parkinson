// 약효일지 MCP 브리지 Worker
//   POST /mcp   — MCP Streamable HTTP, 무상태(JSON 응답). 연결된 에이전트 계정만.
//   GET  /healthz — {"ok":true}만 반환(기록·계정·설정 비공개)
//   OAuth 2.1(인가 서버 = Supabase Auth): /.well-known/oauth-protected-resource[/mcp],
//     /.well-known/oauth-authorization-server(전달), /oauth/consent(동의 화면)
// 로그: 요청 본문·응답 전문·토큰·사용자 식별자·기록 내용을 남기지 않는다.
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { SUPPORTED_PROTOCOL_VERSIONS } from "@modelcontextprotocol/sdk/types.js";
import type { JWTVerifyGetKey } from "jose";
import { verifyAccessToken } from "./auth.js";
import { dataApi, DataApiError } from "./supabase.js";
import { buildServer } from "./tools.js";
import { MAX_BODY_BYTES } from "./schema.js";
import { authorizationServerMetadata, consentPage, corsPreflight, protectedResourceMetadata, resourceMetadataUrl } from "./oauth.js";

export interface Env {
  SUPABASE_URL: string;
  SUPABASE_PUBLISHABLE_KEY: string;
  /** 쉼표 구분 Origin 허용 목록. Origin 헤더가 있는 요청만 검사한다. */
  ALLOWED_ORIGINS?: string;
  SUPABASE_JWT_ISSUER?: string;
  SUPABASE_JWKS_URL?: string;
  RESOURCE_NAME?: string;
}

export interface Deps { fetchImpl?: typeof fetch; jwks?: JWTVerifyGetKey }

const JSON_HDR = { "content-type": "application/json", "cache-control": "no-store" };

function jsonRpcError(status: number, code: number, message: string, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code, message }, id: null }), { status, headers: { ...JSON_HDR, ...extra } });
}

async function readBodyCapped(req: Request, cap: number): Promise<string | null> {
  const declared = Number(req.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > cap) return null;
  if (!req.body) return "";
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) { await reader.cancel(); return null; }
    chunks.push(value);
  }
  const buf = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { buf.set(c, o); o += c.byteLength; }
  return new TextDecoder().decode(buf);
}

export async function handle(req: Request, env: Env, deps: Deps = {}): Promise<Response> {
  const url = new URL(req.url);
  if (url.pathname === "/healthz") {
    return req.method === "GET" ? new Response('{"ok":true}', { headers: JSON_HDR }) : new Response(null, { status: 405, headers: { allow: "GET" } });
  }
  if (url.pathname === "/.well-known/oauth-protected-resource" || url.pathname === "/.well-known/oauth-protected-resource/mcp") {
    if (req.method === "OPTIONS") return corsPreflight();
    return req.method === "GET" ? protectedResourceMetadata(url.origin, env) : new Response(null, { status: 405, headers: { allow: "GET" } });
  }
  if (url.pathname === "/.well-known/oauth-authorization-server" || url.pathname === "/.well-known/oauth-authorization-server/mcp") {
    if (req.method === "OPTIONS") return corsPreflight();
    return req.method === "GET" ? authorizationServerMetadata(env, deps.fetchImpl) : new Response(null, { status: 405, headers: { allow: "GET" } });
  }
  if (url.pathname === "/oauth/consent") {
    return req.method === "GET" ? consentPage(env) : new Response(null, { status: 405, headers: { allow: "GET" } });
  }
  if (url.pathname !== "/mcp") return new Response('{"error":"not_found"}', { status: 404, headers: JSON_HDR });

  const origin = req.headers.get("origin");
  if (origin) {
    const allowed = (env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
    if (!allowed.includes(origin)) return jsonRpcError(403, -32000, "Origin not allowed");
  }
  if (req.method !== "POST") {
    // 무상태 서버: GET(SSE 스트림)·DELETE(세션 종료)는 지원하지 않는다.
    return jsonRpcError(405, -32000, "Method not allowed (stateless server: POST only)", { allow: "POST" });
  }
  const pv = req.headers.get("mcp-protocol-version");
  if (pv && !SUPPORTED_PROTOCOL_VERSIONS.includes(pv)) {
    return jsonRpcError(400, -32000, `Unsupported MCP-Protocol-Version (supported: ${SUPPORTED_PROTOCOL_VERSIONS.join(", ")})`);
  }
  const ctype = (req.headers.get("content-type") || "").toLowerCase();
  if (!ctype.startsWith("application/json")) return jsonRpcError(415, -32000, "Content-Type must be application/json");

  const challenge = (withError: boolean) => ({
    "www-authenticate": `Bearer realm="yakhyo-mcp", resource_metadata="${resourceMetadataUrl(url.origin)}"${withError ? ', error="invalid_token"' : ""}`,
  });
  const authz = req.headers.get("authorization");
  const user = await verifyAccessToken(authz, env, deps.jwks);
  if (!user) return jsonRpcError(401, -32001, "Unauthorized", challenge(!!authz));

  const raw = await readBodyCapped(req, MAX_BODY_BYTES);
  if (raw === null) return jsonRpcError(413, -32000, `Request body too large (max ${MAX_BODY_BYTES} bytes)`);
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return jsonRpcError(400, -32700, "Parse error"); }

  // 호출마다 연결 유효성 확인(폐기·만료 즉시 반영). 실패하면 닫힌 상태.
  let link: { owner_id: string; scopes: string[]; expires_at: string } | undefined;
  try {
    const rows = await dataApi(env, user.token, "POST", "/rpc/my_agent_link", {}, { fetchImpl: deps.fetchImpl }) as typeof link[];
    link = rows?.[0];
  } catch (e) {
    if (e instanceof DataApiError && (e.status === 401 || e.status === 403)) return jsonRpcError(401, -32001, "Unauthorized", challenge(true));
    return jsonRpcError(503, -32000, "Upstream unavailable");
  }
  if (!link) return jsonRpcError(403, -32003, "Forbidden: no active agent link for this account");

  const server = buildServer({ env, token: user.token, ownerId: link.owner_id, scopes: link.scopes, fetchImpl: deps.fetchImpl });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  await server.connect(transport);
  try {
    const res = await transport.handleRequest(req, { parsedBody: parsed });
    const headers = new Headers(res.headers);
    headers.set("cache-control", "no-store");
    return new Response(res.body, { status: res.status, headers });
  } finally {
    // JSON 응답 모드에서는 handleRequest가 응답 완료 후 반환된다.
    void server.close();
  }
}

export default {
  fetch(req: Request, env: Env): Promise<Response> {
    return handle(req, env).catch(() => jsonRpcError(500, -32603, "Internal error"));
  },
};
