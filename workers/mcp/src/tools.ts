// MCP 도구 정의. 추가 도구는 "승인 대기 요청"만 만든다(확정은 브라우저에서 사용자가).
// 수정·삭제·임의 SQL 도구는 제공하지 않는다.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import {
  AGENT_STATE_VALUES, BODY_SYMPTOMS, BOWEL_CONSISTENCY, EXERCISE_INTENSITY, EXERCISE_TYPES, LIFE_EXTRAS, LIFE_KINDS,
  LIFE_PHASES, MEAL_AMOUNTS, MEAL_TYPES, PAGE_SIZE_DEFAULT, PAGE_SIZE_MAX, SLEEP_QUALITY, SYMPTOM_VALUES, TREND_VALUES,
  WEEKLY_ROW_LIMIT, TIMEZONE,
} from "./schema.js";
import { DAY_MS, parseRfc3339, seoulDayStart, toSeoulIso } from "./time.js";
import { dataApi, DataApiError, type DataApiEnv } from "./supabase.js";
import { weeklySummary, type AnalysisEvent } from "./analysis.js";

export interface ToolContext { env: DataApiEnv; token: string; ownerId: string; scopes: string[]; fetchImpl?: typeof fetch }

const requestId = z.string().regex(/^[A-Za-z0-9_.:-]{8,100}$/)
  .describe("재시도 시 같은 값을 다시 보내는 요청 키(8~100자, 영숫자 _ . : -). 같은 키로 다른 내용을 보내면 CONFLICT");
const occurredAt = z.string()
  .refine((s) => parseRfc3339(s) !== null, "오프셋이 포함된 RFC 3339 시각이어야 합니다(예: 2026-11-20T07:00:00+09:00)")
  .refine((s) => { const t = parseRfc3339(s)!; return t <= Date.now() + 10 * 60_000 && t >= Date.UTC(2000, 0, 1); }, "미래이거나 너무 오래된 시각입니다")
  .describe("사용자가 명시한 발생 시각. 오프셋 포함 RFC 3339. 시각을 모르면 사용자에게 묻고 추정하지 마세요");
const sourceTz = z.string().regex(/^[A-Za-z0-9_+/-]{1,64}$/).optional().describe(`기록 시간대(IANA). 기본 ${TIMEZONE}`);
const dateStr = z.string().refine((s) => seoulDayStart(s) !== null, "YYYY-MM-DD 형식의 실제 날짜여야 합니다");

const ok = (data: unknown): CallToolResult => ({
  content: [{ type: "text", text: JSON.stringify(data) }],
  structuredContent: data as Record<string, unknown>,
});
const fail = (code: string, message: string): CallToolResult => ({
  isError: true,
  content: [{ type: "text", text: JSON.stringify({ error: { code, message } }) }],
});

async function guard(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try { return await fn(); } catch (e) {
    if (e instanceof DataApiError) return fail(e.code, e.message);
    return fail("INTERNAL", "요청을 처리하지 못했습니다");
  }
}

function needScope(ctx: ToolContext, s: string): CallToolResult | null {
  return ctx.scopes.includes(s) ? null : fail("FORBIDDEN", `이 연결에는 ${s} 권한이 없습니다`);
}

/** undefined는 빼고(값을 채워 넣지 않는다) payload를 만든다. */
function compact(o: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined));
}

async function createPending(ctx: ToolContext, kind: "med" | "state" | "life", a: { request_id: string; occurred_at: string; source_tz?: string }, payload: Record<string, unknown>) {
  const need = needScope(ctx, "request_write"); if (need) return need;
  return guard(async () => {
    const rows = await dataApi(ctx.env, ctx.token, "POST", "/rpc/create_pending_event", {
      p_request_id: a.request_id, p_kind: kind, p_occurred_at: a.occurred_at,
      p_source_tz: a.source_tz ?? TIMEZONE, p_payload: compact(payload),
    }, { fetchImpl: ctx.fetchImpl }) as { pending_id: string; status: string; expires_at: string; created: boolean }[];
    const r = rows[0];
    return ok({
      pending_id: r.pending_id, status: r.status, expires_at: r.expires_at, created: r.created,
      message: "승인 대기 중입니다. 사용자가 약효일지 브라우저 화면에서 확인·승인해야 기록이 확정됩니다.",
    });
  });
}

interface EventRow { id: string; kind: "med" | "state" | "life"; occurred_at: string; payload: Record<string, unknown>; source: string }

const encodeCursor = (t: string, id: string) => btoa(JSON.stringify([t, id])).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
function decodeCursor(c: string): [string, string] | null {
  try {
    const v = JSON.parse(atob(c.replace(/-/g, "+").replace(/_/g, "/")));
    if (Array.isArray(v) && v.length === 2 && typeof v[0] === "string" && typeof v[1] === "string"
      && parseRfc3339(v[0]) !== null && /^[0-9a-f-]{36}$/i.test(v[1])) return [v[0], v[1]];
  } catch { /* fallthrough */ }
  return null;
}

export function buildServer(ctx: ToolContext): McpServer {
  const server = new McpServer({ name: "yakhyo-diary", version: "0.1.0" }, {
    instructions: "약효일지(파킨슨 복약·상태·생활 기록) 브리지입니다. 추가 도구는 승인 대기 요청만 만들며, 사용자가 브라우저에서 승인해야 확정됩니다. 용량·단위·상태·시각을 추정해 채우지 말고 모르면 사용자에게 물으세요. 요약은 관측된 시간 관계일 뿐 약효나 용량 변경을 판단하지 않습니다.",
  });

  server.registerTool("add_medication", {
    title: "복약 기록 추가 요청",
    description: "복약 기록 추가를 요청합니다(승인 대기). 사용자가 말한 약 이름·용량·시각만 넣으세요.",
    inputSchema: z.strictObject({
      request_id: requestId, occurred_at: occurredAt, source_tz: sourceTz,
      drug: z.string().min(1).max(80).regex(/^[^\p{Cc}]+$/u).refine((s) => s.trim() === s, "앞뒤 공백 없이").describe("사용자가 말한 약 이름 그대로"),
      dose_mg: z.number().gt(0).max(5000).optional().describe("mg 단위 숫자. 단위가 mg가 아니거나 모르면 생략(환산·추정 금지)"),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (a) => createPending(ctx, "med", a, { drug: a.drug, dose_mg: a.dose_mg }));

  server.registerTool("add_state", {
    title: "상태 기록 추가 요청",
    description: "ON/OFF 등 상태 관측 기록 추가를 요청합니다(승인 대기).",
    inputSchema: z.strictObject({
      request_id: requestId, occurred_at: occurredAt, source_tz: sourceTz,
      state: z.enum(AGENT_STATE_VALUES).describe("wake=기상, off=OFF, rising=상승 전환기, on=ON, falling=하강 전환기"),
      output: z.number().int().min(0).max(100).optional().describe("사용자가 말한 0~100 자가평가 출력. 모르면 생략"),
      trend: z.enum(TREND_VALUES).optional(),
      gait: z.number().int().min(0).max(10).optional(),
      dysk: z.number().int().min(0).max(10).optional().describe("이상운동 강도 0~10"),
      symptoms: z.array(z.enum(SYMPTOM_VALUES)).max(8).optional(),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (a) => {
    if (a.symptoms && new Set(a.symptoms).size !== a.symptoms.length) return fail("INVALID_INPUT", "증상이 중복되었습니다");
    return createPending(ctx, "state", a, { state: a.state, output: a.output, trend: a.trend, gait: a.gait, dysk: a.dysk, symptoms: a.symptoms });
  });

  server.registerTool("add_life_event", {
    title: "생활 기록 추가 요청",
    description: "수면·식사·운동·배변·몸 상태 기록 추가를 요청합니다(승인 대기). 자유 메모는 받지 않습니다.",
    inputSchema: z.strictObject({
      request_id: requestId, occurred_at: occurredAt, source_tz: sourceTz,
      kind: z.enum(LIFE_KINDS),
      phase: z.enum(LIFE_PHASES).optional().describe("수면·운동: start/end, 낮잠: nap"),
      meal_type: z.enum(MEAL_TYPES).optional(),
      amount: z.enum(MEAL_AMOUNTS).optional(),
      extras: z.array(z.enum(LIFE_EXTRAS)).max(4).optional(),
      quality: z.array(z.enum(SLEEP_QUALITY)).max(4).optional(),
      ex_type: z.enum(EXERCISE_TYPES).optional(),
      intensity: z.enum(EXERCISE_INTENSITY).optional(),
      duration_min: z.number().int().min(0).max(1440).optional(),
      consistency: z.enum(BOWEL_CONSISTENCY).optional(),
      body_symptoms: z.array(z.enum(BODY_SYMPTOMS)).max(12).optional(),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (a) => {
    for (const arr of [a.extras, a.quality, a.body_symptoms]) {
      if (arr && new Set(arr).size !== arr.length) return fail("INVALID_INPUT", "목록 값이 중복되었습니다");
    }
    const { request_id: _r, occurred_at: _o, source_tz: _s, ...payload } = a; // eslint-disable-line @typescript-eslint/no-unused-vars
    return createPending(ctx, "life", a, payload);
  });

  server.registerTool("get_daily_log", {
    title: "날짜별 확정 기록 조회",
    description: "서울 기준 하루(자정~다음 자정 전)의 확정 기록을 (시각, id) 순으로 조회합니다. 승인 대기 요청은 포함하지 않습니다.",
    inputSchema: z.strictObject({
      date: dateStr.describe("YYYY-MM-DD (Asia/Seoul)"),
      cursor: z.string().max(200).optional(),
      page_size: z.number().int().min(1).max(PAGE_SIZE_MAX).optional().describe(`기본 ${PAGE_SIZE_DEFAULT}, 최대 ${PAGE_SIZE_MAX}`),
    }),
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async (a) => {
    const need = needScope(ctx, "read"); if (need) return need;
    const start = seoulDayStart(a.date)!;
    const size = a.page_size ?? PAGE_SIZE_DEFAULT;
    let keyset = "";
    if (a.cursor) {
      const c = decodeCursor(a.cursor);
      if (!c) return fail("INVALID_INPUT", "cursor가 올바르지 않습니다");
      keyset = `&or=(occurred_at.gt.${encodeURIComponent(c[0])},and(occurred_at.eq.${encodeURIComponent(c[0])},id.gt.${c[1]}))`;
    }
    return guard(async () => {
      const rows = await dataApi(ctx.env, ctx.token, "GET",
        `/diary_events?select=id,kind,occurred_at,payload,source&user_id=eq.${ctx.ownerId}` +
        `&occurred_at=gte.${encodeURIComponent(new Date(start).toISOString())}&occurred_at=lt.${encodeURIComponent(new Date(start + DAY_MS).toISOString())}` +
        `${keyset}&order=occurred_at.asc,id.asc&limit=${size + 1}`, undefined, { fetchImpl: ctx.fetchImpl }) as EventRow[];
      const page = rows.slice(0, size);
      const last = page[page.length - 1];
      return ok({
        date: a.date, timezone: TIMEZONE, count: page.length,
        events: page.map((r) => ({ id: r.id, kind: r.kind, occurred_at: toSeoulIso(Date.parse(r.occurred_at)), payload: r.payload, source: r.source })),
        next_cursor: rows.length > size && last ? encodeCursor(new Date(Date.parse(last.occurred_at)).toISOString(), last.id) : null,
      });
    });
  });

  server.registerTool("get_weekly_summary", {
    title: "주간 관찰 요약",
    description: "시작일부터 7개 날짜(서울 기준)의 확정 기록으로 상태별 관찰 시간, 분석 가능한 구간 수, 미관찰 시간, 복약→ON 및 관찰된 ON 지속시간의 표본 수·중앙값을 집계합니다. 관측된 시간 관계일 뿐 약효·용량을 판단하지 않습니다.",
    inputSchema: z.strictObject({ start_date: dateStr.describe("YYYY-MM-DD (Asia/Seoul)") }),
    annotations: { readOnlyHint: true, openWorldHint: false },
  }, async (a) => {
    const need = needScope(ctx, "read"); if (need) return need;
    const start = seoulDayStart(a.start_date)!;
    const end = start + 7 * DAY_MS;
    return guard(async () => {
      // 집계에는 상태값만 필요하다 — 전송·파싱량을 줄여 Workers Free CPU(10 ms) 안에 둔다.
      const rows = await dataApi(ctx.env, ctx.token, "GET",
        `/diary_events?select=id,kind,occurred_at,state:payload->>state&user_id=eq.${ctx.ownerId}&kind=in.(med,state)` +
        `&occurred_at=gte.${encodeURIComponent(new Date(start).toISOString())}&occurred_at=lt.${encodeURIComponent(new Date(end).toISOString())}` +
        `&order=occurred_at.asc,id.asc&limit=${WEEKLY_ROW_LIMIT + 1}`, undefined, { fetchImpl: ctx.fetchImpl }) as { id: string; kind: "med" | "state"; occurred_at: string; state: string | null }[];
      const truncated = rows.length > WEEKLY_ROW_LIMIT;
      if (truncated) rows.length = WEEKLY_ROW_LIMIT;
      const events: AnalysisEvent[] = rows.map((r) => ({ id: r.id, kind: r.kind, t: Date.parse(r.occurred_at), payload: r.kind === "state" ? { state: r.state } : {} }));
      const endDate = new Date(end + 9 * 3600_000).toISOString().slice(0, 10);
      return ok(weeklySummary(events, { windowStart: start, windowEnd: end, startLabel: a.start_date, endLabel: endDate, truncated, rowLimit: WEEKLY_ROW_LIMIT }));
    });
  });

  return server;
}
