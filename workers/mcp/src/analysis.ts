// 주간 관찰 요약 — 관측된 시간 관계만 집계한다. 약효·용량을 판단하지 않는다.
//
// 규칙(설계도 4장)
//  * 연속된 상태 관측 사이만 상태 구간으로 센다. 간격이 maxGap(기본 120분)을 넘거나
//    마지막 관측 이후는 "미관찰". 구간의 상태는 앞 관측의 상태로 본다.
//  * 같은 시각에 서로 다른 상태 범주가 기록되면 그 시각의 상태 관측을 모두 분석에서 제외하고 표시한다.
//  * 완료 ON 표본: 명시적 OFF 관측 → (상승 전환기 관측 0개 이상) → ON 관측으로 전환이 확인되고,
//    이어서 ON(하강 전환기 포함) 관측들 → OFF 관측이 확인된 경우만. 지속시간 = 그 OFF 시각 − 첫 ON 시각.
//    모든 연속 관측 간격은 maxGap 이하여야 한다. 경계 관측이 없으면 미완결.
//  * 복약→ON: 같은 시각 복약은 한 번의 복약으로 묶는다. 복약 뒤 첫 OFF→ON 전환의 ON 시각까지.
//    다음 복약 전에 전환이 확인돼야 하고, 복약 직후 관측이 maxGap 안에 있어야 하며,
//    그 사이 관측이 끊기지 않아야 한다. 복약 시점에 이미 ON이었으면 미완결.

import { MAX_OBSERVATION_GAP_MIN } from "./schema.js";

export type StateCategory = "on" | "off" | "rising" | "falling" | "other";

/** 앱 상태값 → 분석 범주. 과거 기록용 상태도 명시적으로 매핑한다. */
export const STATE_CATEGORY: Record<string, StateCategory> = {
  on: "on", dysk: "on",
  off: "off",
  rising: "rising", signal: "rising",
  falling: "falling", wearoff: "falling",
  wake: "other", partial: "other", dyst: "other",
};

export interface AnalysisEvent {
  id: string;
  kind: "med" | "state" | "life";
  t: number; // UTC epoch ms
  payload: Record<string, unknown>;
}

interface Obs { t: number; cat: StateCategory }

export interface WeeklySummary {
  window: { start: string; end_exclusive: string; timezone: string };
  settings: { max_observation_gap_min: number; state_mapping: Record<string, StateCategory> };
  data: {
    events_considered: number; state_observations: number; med_doses: number;
    conflicting_timestamps: { at: number; states: string[] }[];
    truncated: boolean; row_limit: number;
  };
  minutes_by_state: Record<StateCategory, number>;
  observed_minutes: number;
  unobserved_minutes: number;
  analyzable_segments: number;
  dose_to_on: Metric & { incomplete_reasons: Record<string, number> };
  on_duration: Metric;
  insufficient_data: boolean;
  notes: string[];
}

interface Metric { label: string; samples: number; median_min: number | null; incomplete: number; insufficient: boolean; values_min: number[] }

const MIN = 60_000;

export function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  const v = s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  return Math.round(v * 10) / 10;
}

export function buildObservations(events: AnalysisEvent[]) {
  const byT = new Map<number, Set<string>>();
  for (const e of events) {
    if (e.kind !== "state") continue;
    const st = String(e.payload.state ?? "");
    if (!(st in STATE_CATEGORY)) continue;
    if (!byT.has(e.t)) byT.set(e.t, new Set());
    byT.get(e.t)!.add(st);
  }
  const obs: Obs[] = [];
  const conflicts: { at: number; states: string[] }[] = [];
  for (const t of [...byT.keys()].sort((a, b) => a - b)) {
    const states = [...byT.get(t)!].sort();
    const cats = new Set(states.map((s) => STATE_CATEGORY[s]));
    if (cats.size > 1) conflicts.push({ at: t, states });
    else obs.push({ t, cat: [...cats][0] });
  }
  return { obs, conflicts };
}

interface Transition { offIdx: number; onIdx: number }

function findTransitions(obs: Obs[], gap: number): Transition[] {
  const out: Transition[] = [];
  let lastOff: number | null = null;
  for (let i = 0; i < obs.length; i++) {
    if (i > 0 && obs[i].t - obs[i - 1].t > gap) lastOff = null; // 관측 끊김
    const c = obs[i].cat;
    if (c === "off") lastOff = i;
    else if (c === "rising") { /* 전환 중 — 유지 */ }
    else if (c === "on") { if (lastOff !== null) out.push({ offIdx: lastOff, onIdx: i }); lastOff = null; }
    else lastOff = null;
  }
  return out;
}

/** ON 시작 관측에서 앞으로 OFF까지 이어지면 지속시간(ms), 아니면 null. */
function completeOnDuration(obs: Obs[], onIdx: number, gap: number): number | null {
  for (let j = onIdx + 1; j < obs.length; j++) {
    if (obs[j].t - obs[j - 1].t > gap) return null;
    const c = obs[j].cat;
    if (c === "off") return obs[j].t - obs[onIdx].t;
    if (c === "on" || c === "falling") continue;
    return null; // rising/other → 경계 불명확
  }
  return null; // 마지막 관측 이후 미관찰
}

export function weeklySummary(
  events: AnalysisEvent[],
  opts: { windowStart: number; windowEnd: number; startLabel: string; endLabel: string; truncated: boolean; rowLimit: number; maxGapMin?: number },
): WeeklySummary {
  const gapMin = opts.maxGapMin ?? MAX_OBSERVATION_GAP_MIN;
  const gap = gapMin * MIN;
  const inWin = events
    .filter((e) => e.t >= opts.windowStart && e.t < opts.windowEnd)
    .sort((a, b) => a.t - b.t || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const { obs, conflicts } = buildObservations(inWin);

  // 상태별 관찰 시간
  const minutes: Record<StateCategory, number> = { on: 0, off: 0, rising: 0, falling: 0, other: 0 };
  let observed = 0;
  let segments = 0;
  let inRun = false;
  for (let i = 0; i + 1 < obs.length; i++) {
    const d = obs[i + 1].t - obs[i].t;
    if (d <= gap) {
      minutes[obs[i].cat] += d / MIN;
      observed += d / MIN;
      if (!inRun) { segments++; inRun = true; }
    } else inRun = false;
  }
  const total = (opts.windowEnd - opts.windowStart) / MIN;
  for (const k of Object.keys(minutes) as StateCategory[]) minutes[k] = Math.round(minutes[k]);

  const transitions = findTransitions(obs, gap);

  // 완료 ON 구간
  const onValues: number[] = [];
  let onIncomplete = 0;
  for (const tr of transitions) {
    const d = completeOnDuration(obs, tr.onIdx, gap);
    if (d === null) onIncomplete++;
    else onValues.push(d / MIN);
  }

  // 복약 → ON
  const doseTimes = [...new Set(inWin.filter((e) => e.kind === "med").map((e) => e.t))].sort((a, b) => a - b);
  const doseValues: number[] = [];
  const reasons: Record<string, number> = { next_dose_before_on: 0, insufficient_observation: 0, already_on: 0, no_transition: 0 };
  doseTimes.forEach((m, k) => {
    const next = k + 1 < doseTimes.length ? doseTimes[k + 1] : Infinity;
    const prev = [...obs].reverse().find((o) => o.t <= m);
    if (prev && m - prev.t <= gap && prev.cat === "on") { reasons.already_on++; return; }
    const firstAfterIdx = obs.findIndex((o) => o.t > m);
    if (firstAfterIdx < 0 || obs[firstAfterIdx].t - m > gap) {
      // 복약 직후 관측이 없거나 너무 늦다 → 경계 관측 부족
      reasons.insufficient_observation++; return;
    }
    const tr = transitions.find((x) => obs[x.onIdx].t > m);
    if (!tr) { reasons.no_transition++; return; }
    const tOn = obs[tr.onIdx].t;
    if (tOn >= next) { reasons.next_dose_before_on++; return; }
    for (let j = firstAfterIdx; j < tr.onIdx; j++) {
      if (obs[j].cat === "on") { reasons.already_on++; return; }
    }
    for (let j = firstAfterIdx + 1; j <= tr.onIdx; j++) {
      if (obs[j].t - obs[j - 1].t > gap) { reasons.insufficient_observation++; return; }
    }
    doseValues.push((tOn - m) / MIN);
  });

  const metric = (label: string, values: number[], incomplete: number): Metric => ({
    label, samples: values.length, median_min: median(values), incomplete,
    insufficient: values.length < 3, values_min: values.map((v) => Math.round(v * 10) / 10),
  });
  const doseIncomplete = Object.values(reasons).reduce((a, b) => a + b, 0);
  const dose = { ...metric("복약 후 관찰된 OFF→ON 전환까지 시간", doseValues, doseIncomplete), incomplete_reasons: reasons };
  const on = metric("관찰된 ON 지속시간", onValues, onIncomplete);

  const notes = [
    "관측 기록 사이의 시간 관계만 집계했습니다. 약물의 효과나 용량 변경을 판단하지 않습니다.",
    `연속 관측 간격이 ${gapMin}분을 넘거나 마지막 관측 이후는 미관찰로 처리했습니다.`,
  ];
  if (conflicts.length) notes.push(`같은 시각에 상충하는 상태 기록 ${conflicts.length}건은 분석에서 제외했습니다.`);
  if (opts.truncated) notes.push(`조회 상한(${opts.rowLimit}건)에 도달해 일부 기록이 집계에서 빠졌을 수 있습니다.`);
  if (dose.insufficient || on.insufficient) notes.push("표본이 3건 미만인 지표는 자료 부족으로 표시했습니다.");

  return {
    window: { start: opts.startLabel, end_exclusive: opts.endLabel, timezone: "Asia/Seoul" },
    settings: { max_observation_gap_min: gapMin, state_mapping: STATE_CATEGORY },
    data: {
      events_considered: inWin.length, state_observations: obs.length, med_doses: doseTimes.length,
      conflicting_timestamps: conflicts, truncated: opts.truncated, row_limit: opts.rowLimit,
    },
    minutes_by_state: minutes,
    observed_minutes: Math.round(observed),
    unobserved_minutes: Math.round(total - observed),
    analyzable_segments: segments,
    dose_to_on: dose,
    on_duration: on,
    insufficient_data: obs.length < 2 || (dose.insufficient && on.insufficient),
    notes,
  };
}
