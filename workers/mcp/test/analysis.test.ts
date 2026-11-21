import { describe, expect, it } from "vitest";
import { weeklySummary, type AnalysisEvent } from "../src/analysis.js";
import { seoulDayStart, DAY_MS } from "../src/time.js";

const D0 = seoulDayStart("2026-11-16")!; // 월요일 서울 자정
const at = (day: number, hhmm: string) => D0 + day * DAY_MS + (+hhmm.slice(0, 2) * 60 + +hhmm.slice(3)) * 60_000;
let n = 0;
const st = (t: number, state: string): AnalysisEvent => ({ id: `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`, kind: "state", t, payload: { state } });
const med = (t: number): AnalysisEvent => ({ id: `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`, kind: "med", t, payload: { drug: "가상약", dose_mg: 100 } });
const run = (events: AnalysisEvent[]) => weeklySummary(events, {
  windowStart: D0, windowEnd: D0 + 7 * DAY_MS, startLabel: "2026-11-16", endLabel: "2026-11-23", truncated: false, rowLimit: 2000,
});

describe("주간 요약 — 설계도 예시", () => {
  const base = [med(at(0, "07:00")), st(at(0, "07:30"), "off"), st(at(0, "08:00"), "on"), st(at(0, "09:00"), "off")];

  it("07:00 복약, 07:30 OFF, 08:00 ON, 09:00 OFF → 복약→ON 60분, 완료 ON 60분", () => {
    const s = run(base);
    expect(s.dose_to_on.values_min).toEqual([60]);
    expect(s.dose_to_on.median_min).toBe(60);
    expect(s.on_duration.values_min).toEqual([60]);
    expect(s.on_duration.label).toBe("관찰된 ON 지속시간");
    expect(s.minutes_by_state).toMatchObject({ off: 30, on: 60 });
    expect(s.observed_minutes).toBe(90);
    expect(s.unobserved_minutes).toBe(7 * 1440 - 90);
    expect(s.analyzable_segments).toBe(1);
    expect(s.settings.max_observation_gap_min).toBe(120);
  });

  it("09:00 관측을 제거하면 완료 ON 표본에서 제외(미완결), 복약→ON은 유지", () => {
    const s = run(base.slice(0, 3));
    expect(s.on_duration.samples).toBe(0);
    expect(s.on_duration.incomplete).toBe(1);
    expect(s.dose_to_on.values_min).toEqual([60]);
  });
});

describe("경계·예외", () => {
  it("다음 복약이 ON 전환 전에 있으면 복약→ON 미완결", () => {
    const s = run([med(at(1, "07:00")), st(at(1, "07:30"), "off"), med(at(1, "07:50")), st(at(1, "08:00"), "on"), st(at(1, "09:00"), "off")]);
    expect(s.dose_to_on.values_min).toEqual([10]); // 두 번째 복약(07:50) 기준만 완결
    expect(s.dose_to_on.incomplete_reasons.next_dose_before_on).toBe(1);
  });

  it("같은 시각 복약은 한 번으로 묶는다", () => {
    const t = at(2, "07:00");
    const s = run([med(t), med(t), st(at(2, "07:20"), "off"), st(at(2, "08:00"), "on")]);
    expect(s.data.med_doses).toBe(1);
    expect(s.dose_to_on.values_min).toEqual([60]);
  });

  it("관측 공백(>120분)은 미관찰이며 전환·구간을 끊는다", () => {
    const s = run([med(at(3, "06:00")), st(at(3, "06:10"), "off"), st(at(3, "08:30"), "on"), st(at(3, "09:00"), "off")]);
    expect(s.minutes_by_state.off).toBe(0);
    expect(s.minutes_by_state.on).toBe(30);
    expect(s.on_duration.samples).toBe(0); // OFF→ON 전환 자체가 공백으로 끊김
    expect(s.dose_to_on.samples).toBe(0);
    expect(s.dose_to_on.incomplete_reasons.no_transition).toBe(1);
  });

  it("복약 직후 관측이 120분 넘게 없으면 경계 관측 부족", () => {
    const s = run([med(at(3, "12:00")), st(at(3, "14:30"), "off"), st(at(3, "15:00"), "on")]);
    expect(s.dose_to_on.incomplete_reasons.insufficient_observation).toBe(1);
  });

  it("복약 시점에 이미 ON이면 복약→ON 표본 아님", () => {
    const s = run([st(at(4, "06:50"), "on"), med(at(4, "07:00")), st(at(4, "07:40"), "off"), st(at(4, "08:20"), "on")]);
    expect(s.dose_to_on.incomplete_reasons.already_on).toBe(1);
    expect(s.dose_to_on.samples).toBe(0);
  });

  it("같은 시각의 상충 상태는 분석에서 제외하고 표시", () => {
    const t = at(5, "08:00");
    const s = run([st(at(5, "07:30"), "off"), st(t, "on"), st(t, "off"), st(at(5, "09:00"), "off")]);
    expect(s.data.conflicting_timestamps).toHaveLength(1);
    expect(s.data.conflicting_timestamps[0].states).toEqual(["off", "on"]);
    expect(s.data.state_observations).toBe(2);
    expect(s.on_duration.samples).toBe(0);
    expect(s.notes.join(" ")).toMatch(/상충/);
  });

  it("상승·하강 전환기를 거친 OFF→ON→OFF도 완료 표본", () => {
    const s = run([st(at(6, "10:00"), "off"), st(at(6, "10:30"), "rising"), st(at(6, "11:00"), "on"), st(at(6, "12:00"), "falling"), st(at(6, "12:30"), "off")]);
    expect(s.on_duration.values_min).toEqual([90]);
    expect(s.minutes_by_state).toMatchObject({ off: 30, rising: 30, on: 60, falling: 30 });
  });

  it("창 경계: 시작 자정은 포함, 7일 뒤 자정은 제외(서울 기준)", () => {
    const inside = st(D0, "off");
    const lastMinute = st(D0 + 7 * DAY_MS - 60_000, "on");
    const outside = st(D0 + 7 * DAY_MS, "off");
    const before = st(D0 - 60_000, "off");
    const s = run([before, inside, lastMinute, outside]);
    expect(s.data.state_observations).toBe(2);
  });

  it("자료가 없으면 자료 부족 표시", () => {
    const s = run([]);
    expect(s.insufficient_data).toBe(true);
    expect(s.dose_to_on.median_min).toBeNull();
    expect(s.unobserved_minutes).toBe(7 * 1440);
  });

  it("중앙값: 짝수 표본은 가운데 두 값의 평균", () => {
    const ev: AnalysisEvent[] = [];
    [30, 60, 90, 120].forEach((d, i) => {
      ev.push(med(at(i, "06:00")), st(at(i, "06:10"), "off"), st(at(i, "06:00") + d * 60_000, "on"));
    });
    const s = run(ev);
    expect(s.dose_to_on.values_min).toEqual([30, 60, 90, 120]);
    expect(s.dose_to_on.median_min).toBe(75);
    expect(s.dose_to_on.insufficient).toBe(false);
  });
});

describe("서울 날짜 경계", () => {
  it("seoulDayStart는 UTC 전날 15:00", () => {
    expect(new Date(seoulDayStart("2026-11-20")!).toISOString()).toBe("2026-11-19T15:00:00.000Z");
    expect(seoulDayStart("2026-02-30")).toBeNull();
    expect(seoulDayStart("2026-1-1")).toBeNull();
  });
});
