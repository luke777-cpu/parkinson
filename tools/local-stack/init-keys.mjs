// 로컬 시험 전용 키·설정 생성 (이미 있으면 유지). 출력 파일은 LOCAL_STACK_DIR(/tmp)에만 쓴다.
import { existsSync, writeFileSync, readFileSync, chmodSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { generateSigningJwk, publicJwk } from "./jwt.mjs";

const [dir, pgPort, gwPort, pgrstPort, gotruePort] = process.argv.slice(2);
const w = (name, data) => { writeFileSync(`${dir}/${name}`, data); chmodSync(`${dir}/${name}`, 0o600); };

if (!existsSync(`${dir}/signing-key.json`)) {
  const priv = generateSigningJwk();
  w("signing-key.json", JSON.stringify(priv));
  w("signing-keys.json", JSON.stringify([priv]));
  w("jwks.json", JSON.stringify({ keys: [publicJwk(priv)] }));
  w("legacy-hs-secret", randomBytes(32).toString("hex"));
}
const prev = existsSync(`${dir}/stack.json`) ? JSON.parse(readFileSync(`${dir}/stack.json`, "utf8")) : {};
const cfg = {
  pgPort: +pgPort, gatewayPort: +gwPort, postgrestPort: +pgrstPort, gotruePort: +gotruePort,
  url: `http://127.0.0.1:${gwPort}`,
  issuer: `http://127.0.0.1:${gwPort}/auth/v1`,
  publishableKey: prev.publishableKey || `sb_publishable_local_${randomBytes(12).toString("hex")}`,
  secretKey: prev.secretKey || `sb_secret_local_${randomBytes(16).toString("hex")}`,
};
w("stack.json", JSON.stringify(cfg, null, 2));
