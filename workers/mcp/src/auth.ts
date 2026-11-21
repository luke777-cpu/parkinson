// Supabase Auth 액세스 토큰 검증 — 발급 프로젝트(iss)·서명(JWKS)·만료·대상(aud)·사용자(sub).
// 비대칭 서명 키(JWKS)를 쓰는 프로젝트만 지원한다(공유 HS256 비밀은 Worker에 두지 않는다).
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

export interface AuthEnv { SUPABASE_URL: string; SUPABASE_JWT_ISSUER?: string; SUPABASE_JWKS_URL?: string }

export interface VerifiedUser { sub: string; token: string; exp: number }

const jwksCache = new Map<string, JWTVerifyGetKey>();

export function issuerOf(env: AuthEnv): string {
  return env.SUPABASE_JWT_ISSUER || `${env.SUPABASE_URL.replace(/\/+$/, "")}/auth/v1`;
}

function jwksFor(env: AuthEnv): JWTVerifyGetKey {
  const url = env.SUPABASE_JWKS_URL || `${env.SUPABASE_URL.replace(/\/+$/, "")}/auth/v1/.well-known/jwks.json`;
  let k = jwksCache.get(url);
  if (!k) {
    k = createRemoteJWKSet(new URL(url), { cooldownDuration: 30_000, cacheMaxAge: 600_000, timeoutDuration: 5000 });
    jwksCache.set(url, k);
  }
  return k;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 실패하면 null(닫힌 상태). 이유는 호출자에게 노출하지 않는다. */
export async function verifyAccessToken(authorization: string | null, env: AuthEnv, keyOverride?: JWTVerifyGetKey): Promise<VerifiedUser | null> {
  if (!authorization) return null;
  const m = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(authorization.trim());
  if (!m) return null;
  try {
    const { payload } = await jwtVerify(m[1], keyOverride ?? jwksFor(env), {
      issuer: issuerOf(env),
      audience: "authenticated",
      algorithms: ["ES256", "RS256", "EdDSA"],
      requiredClaims: ["exp", "sub"],
      clockTolerance: 5,
    });
    if (payload.role !== "authenticated") return null;
    if (typeof payload.sub !== "string" || !UUID_RE.test(payload.sub)) return null;
    if (payload.is_anonymous === true) return null;
    return { sub: payload.sub, token: m[1], exp: payload.exp as number };
  } catch {
    return null;
  }
}
