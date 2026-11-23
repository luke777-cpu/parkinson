import { TZ_OFFSET_MIN } from "./schema.js";

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
/** 오프셋이 반드시 포함된 RFC 3339 (초·소수 초 선택). */
export const RFC3339_OFFSET_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/;

/** YYYY-MM-DD(서울 달력 날짜)의 서울 자정을 UTC epoch ms로. 잘못된 날짜면 null. */
export function seoulDayStart(date: string): number | null {
  const m = DATE_RE.exec(date);
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  const utc = Date.UTC(y, mo - 1, d);
  const check = new Date(utc);
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return null;
  if (y < 2000 || y > 2100) return null;
  return utc - TZ_OFFSET_MIN * 60_000;
}

export const DAY_MS = 86_400_000;

/** UTC epoch ms → 서울 기준 ISO 문자열(+09:00). */
export function toSeoulIso(ms: number): string {
  const d = new Date(ms + TZ_OFFSET_MIN * 60_000);
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}+09:00`;
}

export function parseRfc3339(s: string): number | null {
  if (!RFC3339_OFFSET_RE.test(s)) return null;
  const ms = Date.parse(s);
  return Number.isFinite(ms) ? ms : null;
}
