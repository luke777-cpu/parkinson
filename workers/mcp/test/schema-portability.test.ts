// 도구 입력 스키마 이식성: ChatGPT(파이썬 백엔드)는 \p{..} 같은 JS 전용 정규식을 처리하지 못해
// "앱을 업데이트할 수 없습니다"로 도구 목록 갱신이 실패했다(2026-11-22). 패턴은 공통 문법만 쓴다.
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { buildServer } from "../src/tools.js";

async function tools() {
  const s = buildServer({ env: { SUPABASE_URL: "https://x.test", SUPABASE_PUBLISHABLE_KEY: "k" }, token: "t", ownerId: "o", scopes: ["read", "request_write"] } as never);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await s.connect(a);
  const c = new Client({ name: "t", version: "1" });
  await c.connect(b);
  return (await c.listTools()).tools;
}
function patterns(o: unknown, out: string[] = []): string[] {
  if (Array.isArray(o)) o.forEach((v) => patterns(v, out));
  else if (o && typeof o === "object") for (const [k, v] of Object.entries(o)) { if (k === "pattern" && typeof v === "string") out.push(v); else patterns(v, out); }
  return out;
}
describe("스키마 이식성", () => {
  it("정규식 패턴에 JS 전용 문법(\\p{}, \\u{}, (?<名>), 후방탐색)이 없다", async () => {
    const ps = patterns(await tools());
    expect(ps.length).toBeGreaterThan(0);
    for (const p of ps) {
      expect(p).not.toMatch(/\\[pP]\{|\\u\{|\(\?<[A-Za-z]|\(\?<[=!]/);
      expect(() => new RegExp(p)).not.toThrow(); // u 플래그 없이도 유효
    }
  });
  it("약 이름 패턴은 제어문자를 막고 한글·공백은 허용", async () => {
    const t = (await tools()).find((x) => x.name === "add_medication")!;
    const p = new RegExp((t.inputSchema.properties as Record<string, { pattern: string }>).drug.pattern);
    expect(p.test("퍼킨 25/100")).toBe(true);
    expect(p.test("a\nb")).toBe(false);
    expect(p.test("a\u0085b")).toBe(false);
  });
});
