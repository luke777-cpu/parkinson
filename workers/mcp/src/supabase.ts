// Supabase Data API 호출 — 항상 호출자(에이전트)의 액세스 토큰으로 호출해 RLS를 적용한다.
// service_role이나 secret key를 쓰지 않는다. 로그에 본문·토큰을 남기지 않는다.

export interface DataApiEnv { SUPABASE_URL: string; SUPABASE_PUBLISHABLE_KEY: string }

export class DataApiError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 네트워크 오류와 429만 최대 2회 재시도. Retry-After(초)가 있으면 따르되 3초로 제한. */
export async function dataApi(
  env: DataApiEnv, token: string, method: "GET" | "POST", path: string, body?: unknown,
  opts: { fetchImpl?: typeof fetch; maxRetries?: number } = {},
): Promise<unknown> {
  const f = opts.fetchImpl ?? fetch;
  const maxRetries = opts.maxRetries ?? 2;
  const url = `${env.SUPABASE_URL.replace(/\/+$/, "")}/rest/v1${path}`;
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await f(url, {
        method,
        headers: {
          apikey: env.SUPABASE_PUBLISHABLE_KEY,
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          accept: "application/json",
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(8000),
      });
    } catch {
      if (attempt < maxRetries) { await sleep(200 * 2 ** attempt); continue; }
      throw new DataApiError(503, "UPSTREAM_UNAVAILABLE", "데이터 서버에 연결할 수 없습니다");
    }
    if (res.status === 429 && attempt < maxRetries) {
      const ra = Number(res.headers.get("retry-after"));
      await sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra, 3) * 1000 : 500 * 2 ** attempt);
      continue;
    }
    const text = await res.text();
    let json: unknown = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = null; }
    if (!res.ok) {
      const msg = (json && typeof json === "object" && "message" in json) ? String((json as { message: unknown }).message) : "";
      throw new DataApiError(res.status, mapCode(res.status, msg), safeMessage(res.status, msg));
    }
    return json;
  }
}

function mapCode(status: number, msg: string): string {
  if (status === 409 || /CONFLICT/.test(msg)) return "CONFLICT";
  if (status === 401) return "UNAUTHENTICATED";
  if (status === 403) return "FORBIDDEN";
  if (status === 404) return "NOT_FOUND";
  if (status === 410) return "GONE";
  if (status === 429) return "RATE_LIMITED";
  if (status === 400 && /violates check constraint/.test(msg)) return "INVALID_INPUT";
  if (status >= 500) return "UPSTREAM_ERROR";
  return "BAD_REQUEST";
}

function safeMessage(status: number, msg: string): string {
  if (/CONFLICT/.test(msg)) return "같은 request_id로 다른 내용이 이미 요청되었습니다";
  if (status === 403) return "에이전트 연결이 없거나 폐기·만료되었습니다";
  if (status === 401) return "인증이 필요합니다";
  if (status === 429) return "요청 한도를 넘었습니다. 잠시 후 다시 시도하세요";
  if (/violates check constraint/.test(msg)) return "허용되지 않은 값이 포함되어 있습니다";
  return "데이터 요청이 실패했습니다";
}
