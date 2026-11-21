// 로컬 시험 전용: 가상 사용자 A·B와 각자의 에이전트 계정을 관리자 API로 만들고 연결한다.
// 실제 환자정보 없음. 비밀번호는 무작위이며 LOCAL_STACK_DIR/seed.json(0600)에만 저장한다.
import { readFileSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";

const dir = process.env.LOCAL_STACK_DIR || "/tmp/yakhyo-mcp-local";
const cfg = JSON.parse(readFileSync(`${dir}/stack.json`, "utf8"));

export async function adminCreateUser(email, password) {
  const r = await fetch(`${cfg.url}/auth/v1/admin/users`, {
    method: "POST",
    headers: { apikey: cfg.secretKey, "content-type": "application/json" },
    body: JSON.stringify({ email, password, email_confirm: true }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(`admin create ${email}: ${r.status} ${j.msg || j.message || ""}`);
  return j.id;
}

export function sql(q) {
  return execFileSync("psql", ["-h", "127.0.0.1", "-p", String(cfg.pgPort), "-U", "postgres", "-d", "postgres",
    "-v", "ON_ERROR_STOP=1", "-tAq", "-c", q], { encoding: "utf8" }).trim();
}

export async function seed() {
  if (existsSync(`${dir}/seed.json`)) return JSON.parse(readFileSync(`${dir}/seed.json`, "utf8"));
  const tag = randomBytes(3).toString("hex");
  const out = {};
  for (const name of ["userA", "userB", "agentA", "agentB"]) {
    const email = `${name.toLowerCase()}.${tag}@example.test`;
    const password = randomBytes(18).toString("base64url");
    out[name] = { email, password, id: await adminCreateUser(email, password) };
  }
  sql(`insert into public.diary_agent_links(agent_id, owner_id, expires_at) values
    ('${out.agentA.id}','${out.userA.id}', now() + interval '30 days'),
    ('${out.agentB.id}','${out.userB.id}', now() + interval '30 days')`);
  writeFileSync(`${dir}/seed.json`, JSON.stringify(out, null, 2));
  chmodSync(`${dir}/seed.json`, 0o600);
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const s = await seed();
  console.log(`seeded: ${Object.keys(s).join(", ")} (credentials in ${dir}/seed.json)`);
}
