// 로컬 시험 전용 ES256 JWK 생성·서명 도우미 (Node 내장 crypto만 사용)
import { generateKeyPairSync, createPrivateKey, sign, randomUUID } from "node:crypto";

export function generateSigningJwk() {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = privateKey.export({ format: "jwk" });
  return { ...jwk, kid: randomUUID(), alg: "ES256", use: "sig", key_ops: ["sign", "verify"] };
}

export function publicJwk(priv) {
  const { d, key_ops, ...pub } = priv; // eslint-disable-line no-unused-vars
  return { ...pub, key_ops: ["verify"] };
}

const b64u = (buf) => Buffer.from(buf).toString("base64url");

export function signJwt(privJwk, claims) {
  const header = { alg: "ES256", typ: "JWT", kid: privJwk.kid };
  const input = `${b64u(JSON.stringify(header))}.${b64u(JSON.stringify(claims))}`;
  const key = createPrivateKey({ key: privJwk, format: "jwk" });
  const sig = sign("sha256", Buffer.from(input), { key, dsaEncoding: "ieee-p1363" });
  return `${input}.${b64u(sig)}`;
}
