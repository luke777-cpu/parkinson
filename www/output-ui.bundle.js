(() => {
  // js/output-engine.js
  var OUTPUT_EVENT_SCHEMA_VERSION = 2;
  var OUTPUT_REANCHOR_THRESHOLD_MINUTES = 120;
  var OUTPUT_RETROSPECTIVE_MAX_DAYS = 7;
  var OUTPUT_MIN = 0;
  var OUTPUT_MAX = 100;
  var OUTPUT_STEP = 10;
  var EVENT_TYPES = /* @__PURE__ */ new Set(["anchor", "delta", "manual_correction", "retrospective_output"]);
  var EVENT_TYPE_ALIASES = Object.freeze({
    baseline_anchor: "anchor",
    output_delta: "delta",
    backdated_anchor: "retrospective_output"
  });
  var INPUT_METHODS = /* @__PURE__ */ new Set([
    "initial_anchor",
    "quick_plus",
    "quick_minus",
    "manual_anchor",
    "manual_correction",
    "backdated_manual"
  ]);
  function clamp(value, min = OUTPUT_MIN, max = OUTPUT_MAX) {
    return Math.min(max, Math.max(min, value));
  }
  function validateOutput(value) {
    return Number.isInteger(value) && value >= OUTPUT_MIN && value <= OUTPUT_MAX && value % OUTPUT_STEP === 0;
  }
  function assertOutput(value) {
    const output = Number(value);
    if (!validateOutput(output)) {
      throw new RangeError("출력은 0~100 사이의 10점 단위여야 합니다.");
    }
    return output;
  }
  function getOutputStage(output) {
    const value = assertOutput(output);
    if (value <= 20) return 1;
    if (value <= 40) return 2;
    if (value <= 60) return 3;
    if (value <= 80) return 4;
    return 5;
  }
  function localDateFromTimestamp(timestamp) {
    const date = new Date(timestamp);
    if (Number.isNaN(date.getTime())) throw new TypeError("올바른 시간이 아닙니다.");
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }
  function createOutputId() {
    var _a;
    if ((_a = globalThis.crypto) == null ? void 0 : _a.randomUUID) return `output-${globalThis.crypto.randomUUID()}`;
    return `output-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
  function validTimestamp(timestamp) {
    const ms = Date.parse(timestamp);
    if (!Number.isFinite(ms)) throw new TypeError("올바른 시간이 아닙니다.");
    return new Date(ms).toISOString();
  }
  function normalizeNote(note) {
    return String(note != null ? note : "").trim().slice(0, 500);
  }
  function localDateOrdinal(timestamp) {
    const date = new Date(timestamp);
    return Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 864e5;
  }
  function assertRetrospectiveTimestamp(timestamp, currentTimestamp = (/* @__PURE__ */ new Date()).toISOString(), maxDays = OUTPUT_RETROSPECTIVE_MAX_DAYS) {
    const iso = validTimestamp(timestamp);
    const now = validTimestamp(currentTimestamp);
    if (Date.parse(iso) > Date.parse(now)) {
      const error = new RangeError("미래 시각은 소급 기록할 수 없습니다.");
      error.code = "FUTURE_TIMESTAMP";
      throw error;
    }
    const elapsedCalendarDays = localDateOrdinal(now) - localDateOrdinal(iso);
    if (elapsedCalendarDays >= maxDays) {
      const error = new RangeError(`소급 기록은 최근 ${maxDays}일 이내만 입력할 수 있습니다.`);
      error.code = "RETROSPECTIVE_TOO_OLD";
      throw error;
    }
    return iso;
  }
  function compareEvents(a, b) {
    var _a, _b;
    const timeDiff = Date.parse(a.timestamp) - Date.parse(b.timestamp);
    if (timeDiff !== 0) return timeDiff;
    const typeDiff = (a.eventType === "delta" ? 1 : 0) - (b.eventType === "delta" ? 1 : 0);
    if (typeDiff !== 0) return typeDiff;
    const createdDiff = Date.parse(a.createdAt || a.timestamp) - Date.parse(b.createdAt || b.timestamp);
    if (createdDiff !== 0) return createdDiff;
    const idDiff = String(a.id || "").localeCompare(String(b.id || ""));
    if (idDiff !== 0) return idDiff;
    return ((_a = a.__order) != null ? _a : 0) - ((_b = b.__order) != null ? _b : 0);
  }
  function normalizeOutputEvent(raw, order = 0) {
    if (!raw || typeof raw !== "object") throw new TypeError("출력 기록 형식이 올바르지 않습니다.");
    const aliasedType = EVENT_TYPE_ALIASES[raw.eventType] || raw.eventType;
    const eventType = EVENT_TYPES.has(aliasedType) ? aliasedType : null;
    if (!eventType) throw new TypeError("지원하지 않는 출력 기록 종류입니다.");
    const inputMethod = INPUT_METHODS.has(raw.inputMethod) ? raw.inputMethod : eventType === "retrospective_output" ? "backdated_manual" : eventType === "delta" ? Number(raw.delta) === 10 ? "quick_plus" : "quick_minus" : "manual_correction";
    const timestamp = validTimestamp(raw.timestamp);
    const localDate2 = /^\d{4}-\d{2}-\d{2}$/.test(String(raw.localDate || "")) ? String(raw.localDate) : localDateFromTimestamp(timestamp);
    const delta = eventType === "delta" && (Number(raw.delta) === 10 || Number(raw.delta) === -10) ? Number(raw.delta) : null;
    if (eventType === "delta" && delta === null) throw new RangeError("변화 기록은 +10 또는 -10이어야 합니다.");
    const createdAt = raw.createdAt ? validTimestamp(raw.createdAt) : timestamp;
    const updatedAt = raw.updatedAt ? validTimestamp(raw.updatedAt) : null;
    return {
      id: String(raw.id || createOutputId()),
      timestamp,
      localDate: localDate2,
      eventType,
      previousOutput: raw.previousOutput == null ? null : assertOutput(Number(raw.previousOutput)),
      delta,
      newOutput: assertOutput(Number(raw.newOutput)),
      inputMethod,
      confidence: raw.confidence === "low" ? "low" : "high",
      retrospective: eventType === "retrospective_output" || raw.retrospective === true,
      note: normalizeNote(raw.note),
      createdAt,
      updatedAt,
      __order: order
    };
  }
  function stripInternal(event) {
    const { __order, ...clean } = event;
    return clean;
  }
  function recalculateOutputEvents(events) {
    const normalized = (Array.isArray(events) ? events : []).map((event, index) => normalizeOutputEvent(event, index)).sort((a, b) => a.localDate.localeCompare(b.localDate) || compareEvents(a, b));
    let activeDate = null;
    let currentOutput = null;
    const recalculated = [];
    normalized.forEach((event) => {
      if (event.localDate !== activeDate) {
        activeDate = event.localDate;
        currentOutput = null;
      }
      if (event.eventType === "delta") {
        if (currentOutput === null) {
          if (event.previousOutput != null) currentOutput = assertOutput(Number(event.previousOutput));
          else {
            const error = new Error("하루 첫 기록은 기준 출력이어야 합니다.");
            error.code = "ANCHOR_REQUIRED";
            throw error;
          }
        }
        event.previousOutput = currentOutput;
        event.newOutput = clamp(currentOutput + event.delta);
        currentOutput = event.newOutput;
      } else {
        event.previousOutput = event.eventType === "anchor" ? null : currentOutput;
        event.delta = null;
        currentOutput = event.newOutput;
      }
      recalculated.push(stripInternal(event));
    });
    return recalculated;
  }
  function getOutputEventsByDate(events, localDate2) {
    return recalculateOutputEvents(events).filter((event) => event.localDate === localDate2).sort(compareEvents);
  }
  function findOutputEventsAtMinute(events, timestamp, excludeId = null) {
    const minute = Math.floor(Date.parse(validTimestamp(timestamp)) / 6e4);
    return recalculateOutputEvents(events).filter((event) => event.id !== excludeId && Math.floor(Date.parse(event.timestamp) / 6e4) === minute);
  }
  function getCurrentOutput(events, localDate2) {
    const rows = getOutputEventsByDate(events, localDate2);
    return rows.length ? rows[rows.length - 1].newOutput : null;
  }
  function setOutputAnchor(output, timestamp = (/* @__PURE__ */ new Date()).toISOString(), options = {}) {
    const iso = validTimestamp(timestamp);
    const now = (/* @__PURE__ */ new Date()).toISOString();
    return {
      id: options.id || createOutputId(),
      timestamp: iso,
      localDate: options.localDate || localDateFromTimestamp(iso),
      eventType: "anchor",
      previousOutput: null,
      delta: null,
      newOutput: assertOutput(Number(output)),
      inputMethod: options.initial === false ? "manual_anchor" : "initial_anchor",
      confidence: "high",
      retrospective: false,
      note: "",
      createdAt: options.createdAt || now,
      updatedAt: null
    };
  }
  function setRetrospectiveOutput(output, timestamp, options = {}) {
    const createdAt = validTimestamp(options.createdAt || (/* @__PURE__ */ new Date()).toISOString());
    const iso = assertRetrospectiveTimestamp(timestamp, options.currentTimestamp || createdAt);
    return {
      id: options.id || createOutputId(),
      timestamp: iso,
      localDate: localDateFromTimestamp(iso),
      eventType: "retrospective_output",
      previousOutput: null,
      delta: null,
      newOutput: assertOutput(Number(output)),
      inputMethod: "backdated_manual",
      confidence: "high",
      retrospective: true,
      note: normalizeNote(options.note),
      createdAt,
      updatedAt: null
    };
  }
  function applyOutputDelta(events, delta, timestamp = (/* @__PURE__ */ new Date()).toISOString(), options = {}) {
    const change = Number(delta);
    if (change !== OUTPUT_STEP && change !== -OUTPUT_STEP) {
      throw new RangeError("출력 변화는 +10 또는 -10이어야 합니다.");
    }
    const iso = validTimestamp(timestamp);
    const localDate2 = localDateFromTimestamp(iso);
    const current = getCurrentOutput(events, localDate2);
    if (current === null) {
      const error = new Error("오늘의 기준 출력을 먼저 입력하세요.");
      error.code = "ANCHOR_REQUIRED";
      throw error;
    }
    if (current === OUTPUT_MAX && change > 0 || current === OUTPUT_MIN && change < 0) {
      return { event: null, reason: change > 0 ? "MAX_REACHED" : "MIN_REACHED" };
    }
    const now = (/* @__PURE__ */ new Date()).toISOString();
    return {
      event: {
        id: options.id || createOutputId(),
        timestamp: iso,
        localDate: localDate2,
        eventType: "delta",
        previousOutput: current,
        delta: change,
        newOutput: clamp(current + change),
        inputMethod: change > 0 ? "quick_plus" : "quick_minus",
        confidence: options.confidence === "low" ? "low" : "high",
        retrospective: false,
        note: "",
        createdAt: options.createdAt || now,
        updatedAt: null
      },
      reason: null
    };
  }
  function shouldRequestReanchor(lastTimestamp, currentTimestamp = (/* @__PURE__ */ new Date()).toISOString(), thresholdMinutes = OUTPUT_REANCHOR_THRESHOLD_MINUTES) {
    if (!lastTimestamp) return true;
    const elapsed = Date.parse(currentTimestamp) - Date.parse(lastTimestamp);
    if (!Number.isFinite(elapsed)) throw new TypeError("기록 시간을 확인할 수 없습니다.");
    return elapsed > thresholdMinutes * 60 * 1e3;
  }
  function updateOutputEvent(events, id, changes = {}) {
    const now = (/* @__PURE__ */ new Date()).toISOString();
    let found = false;
    const updated = recalculateOutputEvents(events).map((event) => {
      if (event.id !== id) return event;
      found = true;
      const next = { ...event };
      if (changes.timestamp) {
        next.timestamp = validTimestamp(changes.timestamp);
        next.localDate = localDateFromTimestamp(next.timestamp);
        if (event.eventType === "retrospective_output") {
          assertRetrospectiveTimestamp(next.timestamp, changes.currentTimestamp || now);
        }
      }
      if (changes.newOutput != null && Number(changes.newOutput) !== event.newOutput) {
        next.newOutput = assertOutput(Number(changes.newOutput));
        if (event.eventType === "delta") {
          next.eventType = "manual_correction";
          next.inputMethod = "manual_correction";
          next.delta = null;
        }
      }
      if (changes.note !== void 0 && event.eventType === "retrospective_output") {
        next.note = normalizeNote(changes.note);
      }
      next.updatedAt = now;
      return next;
    });
    if (!found) throw new Error("수정할 출력 기록을 찾지 못했습니다.");
    return recalculateOutputEvents(updated);
  }
  function replaceOutputEventWithRetrospective(events, id, output, timestamp, options = {}) {
    const createdAt = validTimestamp(options.createdAt || (/* @__PURE__ */ new Date()).toISOString());
    const iso = assertRetrospectiveTimestamp(timestamp, options.currentTimestamp || createdAt);
    let found = false;
    const replaced = recalculateOutputEvents(events).map((event) => {
      if (event.id !== id) return event;
      found = true;
      return {
        ...event,
        timestamp: iso,
        localDate: localDateFromTimestamp(iso),
        eventType: "retrospective_output",
        delta: null,
        newOutput: assertOutput(Number(output)),
        inputMethod: "backdated_manual",
        confidence: "high",
        retrospective: true,
        note: normalizeNote(options.note),
        createdAt,
        updatedAt: createdAt
      };
    });
    if (!found) throw new Error("수정할 기존 출력 기록을 찾지 못했습니다.");
    return recalculateOutputEvents(replaced);
  }
  function deleteOutputEvent(events, id) {
    const current = recalculateOutputEvents(events);
    const target = current.find((event) => event.id === id);
    if (!target) throw new Error("삭제할 출력 기록을 찾지 못했습니다.");
    if (target.eventType === "anchor") {
      const laterSameDay = current.some((event) => event.localDate === target.localDate && event.id !== target.id && Date.parse(event.timestamp) >= Date.parse(target.timestamp));
      if (laterSameDay) {
        const error = new Error("뒤 기록을 보호하기 위해 기준점은 삭제할 수 없습니다. 기준값을 수정해 주세요.");
        error.code = "ANCHOR_IN_USE";
        throw error;
      }
    }
    return recalculateOutputEvents(current.filter((event) => event.id !== id));
  }

  // js/output-storage.js
  var OUTPUT_STORAGE_KEY = "medicationDiary.outputEvents.v1";
  function csvCell(value) {
    const text = value == null ? "" : String(value);
    return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  }
  function outputEventsToCsv(events) {
    const columns = [
      "id",
      "timestamp",
      "localDate",
      "eventType",
      "previousOutput",
      "delta",
      "newOutput",
      "inputMethod",
      "confidence",
      "retrospective",
      "note",
      "createdAt",
      "updatedAt"
    ];
    const rows = recalculateOutputEvents(events).map((event) => columns.map((column) => csvCell(event[column])).join(","));
    return `\uFEFF${columns.join(",")}\r
${rows.join("\r\n")}`;
  }
  function buildOutputJsonExport(events, localDate2 = null) {
    const rows = localDate2 ? getOutputEventsByDate(events, localDate2) : recalculateOutputEvents(events);
    return {
      kind: "medicationDiary.outputEvents",
      schemaVersion: OUTPUT_EVENT_SCHEMA_VERSION,
      exportedAt: (/* @__PURE__ */ new Date()).toISOString(),
      localDate: localDate2,
      eventCount: rows.length,
      events: rows
    };
  }
  function createOutputStore(storage = globalThis.localStorage) {
    if (!storage) throw new Error("브라우저 저장소를 사용할 수 없습니다.");
    function load() {
      try {
        const raw = storage.getItem(OUTPUT_STORAGE_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        const events = Array.isArray(parsed) ? parsed : parsed.events;
        return recalculateOutputEvents(Array.isArray(events) ? events : []);
      } catch (error) {
        console.warn("Output event storage could not be read.", error);
        return [];
      }
    }
    function save(events) {
      const normalized = recalculateOutputEvents(events);
      const payload = {
        schemaVersion: OUTPUT_EVENT_SCHEMA_VERSION,
        updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
        events: normalized
      };
      storage.setItem(OUTPUT_STORAGE_KEY, JSON.stringify(payload));
      return normalized;
    }
    function append(event) {
      return save([...load(), event]);
    }
    return {
      key: OUTPUT_STORAGE_KEY,
      getAll: load,
      getByDate(localDate2) {
        return getOutputEventsByDate(load(), localDate2);
      },
      getAtMinute(timestamp, excludeId = null) {
        return findOutputEventsAtMinute(load(), timestamp, excludeId);
      },
      addAnchor(output, timestamp = (/* @__PURE__ */ new Date()).toISOString(), options = {}) {
        const event = setOutputAnchor(output, timestamp, options);
        append(event);
        return event;
      },
      addDelta(delta, timestamp = (/* @__PURE__ */ new Date()).toISOString(), options = {}) {
        const current = load();
        const result = applyOutputDelta(current, delta, timestamp, options);
        if (result.event) append(result.event);
        return result;
      },
      addRetrospective(output, timestamp, options = {}) {
        const event = setRetrospectiveOutput(output, timestamp, options);
        append(event);
        return getOutputEventsByDate(load(), event.localDate).find((row) => row.id === event.id);
      },
      replaceWithRetrospective(id, output, timestamp, options = {}) {
        const rows = save(replaceOutputEventWithRetrospective(load(), id, output, timestamp, options));
        return rows.find((row) => row.id === id);
      },
      update(id, changes) {
        return save(updateOutputEvent(load(), id, changes));
      },
      delete(id) {
        return save(deleteOutputEvent(load(), id));
      },
      replaceAll(events) {
        return save(events);
      },
      exportJson(localDate2 = null) {
        return JSON.stringify(buildOutputJsonExport(load(), localDate2), null, 2);
      },
      exportCsv(localDate2 = null) {
        const events = localDate2 ? getOutputEventsByDate(load(), localDate2) : load();
        return outputEventsToCsv(events);
      }
    };
  }

  // js/output-chart.js
  function splitSeriesByLongGap(events, thresholdMinutes = OUTPUT_REANCHOR_THRESHOLD_MINUTES) {
    const sorted = [...events].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
    const segments = [];
    let current = [];
    sorted.forEach((event) => {
      const previous = current[current.length - 1];
      const gapMinutes = previous ? (Date.parse(event.timestamp) - Date.parse(previous.timestamp)) / 6e4 : 0;
      if (current.length && (gapMinutes > thresholdMinutes || event.eventType === "anchor")) {
        segments.push(current);
        current = [];
      }
      current.push(event);
    });
    if (current.length) segments.push(current);
    return segments;
  }
  function minutesOfDay(timestamp) {
    const date = new Date(timestamp);
    return date.getHours() * 60 + date.getMinutes() + date.getSeconds() / 60;
  }
  function timeLabel(timestamp) {
    return new Date(timestamp).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false });
  }
  function eventLabel(event) {
    if (event.eventType === "anchor") return "기준점";
    if (event.eventType === "retrospective_output") return "나중에 소급 입력";
    if (event.eventType === "manual_correction") return "수정점";
    return event.delta > 0 ? "+10" : "-10";
  }
  function escapeText(value) {
    return String(value != null ? value : "").replace(/[&<>"']/g, (character) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    })[character]);
  }
  function overlayTimestamp(event) {
    return event.startTimestamp || event.timestamp;
  }
  function overlayLabel(event) {
    return {
      medication: "약 복용",
      dyskinesia: "이상운동증",
      dystonia: "근긴장이상",
      freezing: "동결",
      near_fall: "넘어질 뻔",
      delayed_on: "Delayed ON",
      incomplete_on: "불완전 ON",
      on_failure: "ON Failure"
    }[event.eventType] || "사건";
  }
  function renderOutputChart(container, events, overlayEvents = []) {
    if (!container) return;
    if (!events.length && !overlayEvents.length) {
      container.innerHTML = '<div class="omvp-empty">선택한 날짜의 출력 기록이 없습니다.</div>';
      return;
    }
    const sortedEvents = [...events].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
    const width = 760;
    const height = 270;
    const pad = { left: 42, right: 14, top: 18, bottom: 34 };
    const plotWidth = width - pad.left - pad.right;
    const plotHeight = height - pad.top - pad.bottom;
    const x = (timestamp) => pad.left + minutesOfDay(timestamp) / (24 * 60) * plotWidth;
    const y = (output) => pad.top + plotHeight - output / 100 * plotHeight;
    let grid = "";
    for (let output = 0; output <= 100; output += 20) {
      const py = y(output);
      grid += `<line x1="${pad.left}" y1="${py}" x2="${width - pad.right}" y2="${py}" class="omvp-grid-line"/>`;
      grid += `<text x="${pad.left - 8}" y="${py + 4}" text-anchor="end" class="omvp-axis-text">${output}</text>`;
    }
    for (let hour = 0; hour <= 24; hour += 4) {
      const px = pad.left + hour / 24 * plotWidth;
      grid += `<line x1="${px}" y1="${pad.top}" x2="${px}" y2="${pad.top + plotHeight}" class="omvp-grid-line omvp-grid-vertical"/>`;
      grid += `<text x="${px}" y="${height - 10}" text-anchor="middle" class="omvp-axis-text">${String(hour).padStart(2, "0")}</text>`;
    }
    const segments = splitSeriesByLongGap(sortedEvents);
    const lines = segments.map((segment) => {
      if (segment.length < 2) return "";
      const points2 = segment.map((event) => `${x(event.timestamp)},${y(event.newOutput)}`).join(" ");
      return `<polyline points="${points2}" class="omvp-output-line"/>`;
    }).join("");
    const points = sortedEvents.map((event) => {
      if (event.eventType === "retrospective_output") {
        const px = x(event.timestamp);
        const py = y(event.newOutput);
        const size = 7;
        const title2 = `${timeLabel(event.timestamp)} · 출력 ${event.newOutput} · 나중에 소급 입력`;
        return `<rect x="${px - size}" y="${py - size}" width="${size * 2}" height="${size * 2}" rx="2" transform="rotate(45 ${px} ${py})" class="omvp-retrospective-point"><title>${title2}</title></rect>`;
      }
      const anchorClass = event.eventType === "anchor" ? " omvp-anchor-point" : "";
      const lowClass = event.confidence === "low" ? " omvp-low-point" : "";
      const title = `${timeLabel(event.timestamp)} · ${eventLabel(event)} · 출력 ${event.newOutput}${event.confidence === "low" ? " · 낮은 신뢰도" : ""}`;
      return `<circle cx="${x(event.timestamp)}" cy="${y(event.newOutput)}" r="${event.eventType === "anchor" ? 6 : 5}" class="omvp-output-point${anchorClass}${lowClass}"><title>${title}</title></circle>`;
    }).join("");
    const overlays = [...overlayEvents].sort((a, b) => Date.parse(overlayTimestamp(a)) - Date.parse(overlayTimestamp(b))).map((event) => {
      var _a, _b, _c, _d;
      const timestamp = overlayTimestamp(event);
      if (!timestamp) return "";
      const px = x(timestamp);
      const label = overlayLabel(event);
      if (["delayed_on", "incomplete_on", "on_failure"].includes(event.eventType)) {
        const output = Number.isFinite(Number(event.outputAtEvent)) ? Number(event.outputAtEvent) : 50;
        const py2 = y(output);
        const symbol = event.eventType === "delayed_on" ? "D" : event.eventType === "incomplete_on" ? "I" : "F";
        const title2 = `${label} · ${timeLabel(timestamp)} · 당시 출력 ${(_a = event.outputAtEvent) != null ? _a : "없음"} · 출력곡선 해석 메모`;
        return `<g class="omvp-clinical-marker ${event.eventType}"><title>${escapeText(title2)}</title><circle cx="${px}" cy="${py2}" r="8"/><text x="${px}" y="${py2 + 3.5}" text-anchor="middle">${symbol}</text></g>`;
      }
      if (event.eventType === "dyskinesia" || event.eventType === "dystonia") {
        const end = event.endTimestamp || (/* @__PURE__ */ new Date()).toISOString();
        const endX = Math.max(px + 4, x(end));
        const py2 = event.eventType === "dyskinesia" ? y(94) : y(84);
        const title2 = `${label} · ${timeLabel(timestamp)} 시작 · ${event.endTimestamp ? `${timeLabel(event.endTimestamp)} 종료` : "진행 중"} · 시작 출력 ${(_b = event.startOutput) != null ? _b : "없음"}`;
        return `<g class="omvp-duration-overlay ${event.eventType}"><title>${escapeText(title2)}</title><line x1="${px}" y1="${py2}" x2="${endX}" y2="${py2}"/><circle cx="${px}" cy="${py2}" r="4"/>${event.endTimestamp ? `<circle cx="${endX}" cy="${py2}" r="4"/>` : ""}</g>`;
      }
      if (event.eventType === "medication") {
        const py2 = y(100) + 8;
        const title2 = `${label} · ${timeLabel(timestamp)} · ${event.medicationName || "약"}${event.dose ? ` ${event.dose}` : ""} · 당시 출력 ${(_c = event.outputAtEvent) != null ? _c : "없음"}`;
        return `<path d="M ${px} ${py2 - 7} L ${px - 7} ${py2 + 6} L ${px + 7} ${py2 + 6} Z" class="omvp-medication-marker"><title>${escapeText(title2)}</title></path>`;
      }
      const py = event.eventType === "near_fall" ? y(8) : y(18);
      const title = `${label} · ${timeLabel(timestamp)} · 당시 출력 ${(_d = event.outputAtEvent) != null ? _d : "없음"}`;
      if (event.eventType === "near_fall") {
        return `<path d="M ${px} ${py - 8} L ${px - 8} ${py + 7} L ${px + 8} ${py + 7} Z" class="omvp-near-fall-marker"><title>${escapeText(title)}</title></path>`;
      }
      return `<rect x="${px - 6}" y="${py - 6}" width="12" height="12" transform="rotate(45 ${px} ${py})" class="omvp-freezing-marker"><title>${escapeText(title)}</title></rect>`;
    }).join("");
    container.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" role="img" aria-label="시간에 따른 출력 0에서 100 그래프">
      ${grid}${lines}${points}${overlays}
    </svg>
    <div class="omvp-chart-legend">
      <span><i class="omvp-legend-dot"></i>변화점</span>
      <span><i class="omvp-legend-dot anchor"></i>기준점</span>
      <span><i class="omvp-legend-dot retrospective"></i>소급 입력</span>
      <span><i class="omvp-legend-dot low"></i>2시간 공백 후 계속 기록</span>
      <span><i class="omvp-legend-dot medication"></i>약 복용</span>
      <span><i class="omvp-legend-dot symptom"></i>증상 사건</span>
      <span><i class="omvp-legend-dot clinical"></i>곡선 해석</span>
    </div>`;
  }

  // js/clinical-event-adapter.js
  var CLINICAL_EVENT_TYPES = Object.freeze({
    delayed: "delayed_on",
    partial: "incomplete_on",
    failed: "on_failure"
  });
  function validTimestamp2(value) {
    const timestamp = typeof value === "number" ? value : Date.parse(value);
    return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
  }
  function validOutput(value) {
    if (value == null || value === "") return null;
    const output = Number(value);
    return Number.isFinite(output) && output >= 0 && output <= 100 ? output : null;
  }
  function clinicalEventName(eventType) {
    return {
      delayed_on: "Delayed ON",
      incomplete_on: "불완전 ON",
      on_failure: "ON Failure"
    }[eventType] || "임상 사건";
  }
  function extractClinicalEvents(events) {
    return (Array.isArray(events) ? events : []).filter((event) => (event == null ? void 0 : event.type) === "state" && CLINICAL_EVENT_TYPES[event.riseResult]).map((event) => {
      var _a;
      const timestamp = validTimestamp2(event.ts);
      if (!timestamp) return null;
      const outputAtEvent = validOutput((_a = event.outputAtEvent) != null ? _a : event.output);
      return {
        id: String(event.id || ""),
        eventType: CLINICAL_EVENT_TYPES[event.riseResult],
        riseResult: event.riseResult,
        timestamp,
        createdAt: validTimestamp2(event.createdAt) || timestamp,
        outputAtEvent,
        inputMethod: "legacy_curve_interpretation",
        retrospective: false,
        memo: String(event.memo || "").slice(0, 500),
        legacy: true
      };
    }).filter(Boolean).sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp) || a.id.localeCompare(b.id));
  }

  // js/quick-event-engine.js
  var QUICK_EVENT_SCHEMA_VERSION = 1;
  var QUICK_EVENT_DUPLICATE_WINDOW_MS = 1e3;
  var QUICK_EVENT_TYPES = Object.freeze({
    FREEZING: "freezing",
    NEAR_FALL: "near_fall",
    DYSKINESIA: "dyskinesia",
    DYSTONIA: "dystonia"
  });
  var MOMENT_TYPES = /* @__PURE__ */ new Set([QUICK_EVENT_TYPES.FREEZING, QUICK_EVENT_TYPES.NEAR_FALL]);
  var DURATION_TYPES = /* @__PURE__ */ new Set([QUICK_EVENT_TYPES.DYSKINESIA, QUICK_EVENT_TYPES.DYSTONIA]);
  function createQuickEventId() {
    var _a;
    if ((_a = globalThis.crypto) == null ? void 0 : _a.randomUUID) return `quick-${globalThis.crypto.randomUUID()}`;
    return `quick-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  }
  function validTimestamp3(value, label = "시간") {
    const ms = Date.parse(value);
    if (!Number.isFinite(ms)) throw new TypeError(`${label}이 올바르지 않습니다.`);
    return new Date(ms).toISOString();
  }
  function optionalOutput(value) {
    if (value == null || value === "") return null;
    const output = Number(value);
    if (!Number.isInteger(output) || output < 0 || output > 100 || output % 10 !== 0) {
      throw new RangeError("사건 당시 출력은 0~100 사이의 10점 단위여야 합니다.");
    }
    return output;
  }
  function memo(value) {
    return String(value != null ? value : "").trim().slice(0, 500);
  }
  function isMomentEventType(eventType) {
    return MOMENT_TYPES.has(eventType);
  }
  function isDurationEventType(eventType) {
    return DURATION_TYPES.has(eventType);
  }
  function quickEventTimestamp(event) {
    return (event == null ? void 0 : event.startTimestamp) || (event == null ? void 0 : event.timestamp) || "";
  }
  function normalizeQuickEvent(raw) {
    if (!raw || typeof raw !== "object") throw new TypeError("빠른 사건 기록 형식이 올바르지 않습니다.");
    const eventType = String(raw.eventType || "");
    if (!isMomentEventType(eventType) && !isDurationEventType(eventType)) {
      throw new TypeError("지원하지 않는 빠른 사건 종류입니다.");
    }
    const createdAt = validTimestamp3(raw.createdAt || quickEventTimestamp(raw) || (/* @__PURE__ */ new Date()).toISOString(), "입력 시간");
    const common = {
      id: String(raw.id || createQuickEventId()),
      eventType,
      createdAt,
      inputMethod: "quick_event",
      retrospective: false,
      severity: raw.severity == null ? null : String(raw.severity).slice(0, 40),
      memo: memo(raw.memo)
    };
    if (isMomentEventType(eventType)) {
      return {
        ...common,
        timestamp: validTimestamp3(raw.timestamp, "사건 시간"),
        outputAtEvent: optionalOutput(raw.outputAtEvent),
        updatedAt: raw.updatedAt ? validTimestamp3(raw.updatedAt, "수정 시간") : null
      };
    }
    const startTimestamp = validTimestamp3(raw.startTimestamp, "시작 시간");
    const endTimestamp = raw.endTimestamp ? validTimestamp3(raw.endTimestamp, "종료 시간") : null;
    if (endTimestamp && Date.parse(endTimestamp) < Date.parse(startTimestamp)) {
      throw new RangeError("종료 시간은 시작 시간보다 빠를 수 없습니다.");
    }
    return {
      ...common,
      startTimestamp,
      endTimestamp,
      startOutput: optionalOutput(raw.startOutput),
      endOutput: endTimestamp ? optionalOutput(raw.endOutput) : null,
      updatedAt: raw.updatedAt ? validTimestamp3(raw.updatedAt, "수정 시간") : null,
      status: endTimestamp ? "closed" : "open"
    };
  }
  function sortQuickEvents(events) {
    return (Array.isArray(events) ? events : []).map(normalizeQuickEvent).sort((a, b) => {
      const timeDiff = Date.parse(quickEventTimestamp(a)) - Date.parse(quickEventTimestamp(b));
      if (timeDiff !== 0) return timeDiff;
      const createdDiff = Date.parse(a.createdAt) - Date.parse(b.createdAt);
      return createdDiff || a.id.localeCompare(b.id);
    });
  }
  function createMomentEvent(eventType, timestamp, outputAtEvent, options = {}) {
    if (!isMomentEventType(eventType)) throw new TypeError("순간 사건 종류가 올바르지 않습니다.");
    const now = options.createdAt || (/* @__PURE__ */ new Date()).toISOString();
    return normalizeQuickEvent({
      id: options.id,
      eventType,
      timestamp,
      createdAt: now,
      outputAtEvent,
      severity: options.severity,
      memo: options.memo
    });
  }
  function createDurationEvent(eventType, startTimestamp, startOutput, options = {}) {
    if (!isDurationEventType(eventType)) throw new TypeError("지속 사건 종류가 올바르지 않습니다.");
    const now = options.createdAt || (/* @__PURE__ */ new Date()).toISOString();
    return normalizeQuickEvent({
      id: options.id,
      eventType,
      startTimestamp,
      createdAt: now,
      startOutput,
      severity: options.severity,
      memo: options.memo
    });
  }
  function closeDurationEvent(events, id, endTimestamp, endOutput, options = {}) {
    const now = options.updatedAt || (/* @__PURE__ */ new Date()).toISOString();
    let found = false;
    const next = sortQuickEvents(events).map((event) => {
      if (event.id !== id) return event;
      if (!isDurationEventType(event.eventType)) throw new TypeError("지속 사건만 종료할 수 있습니다.");
      found = true;
      return normalizeQuickEvent({ ...event, endTimestamp, endOutput, updatedAt: now });
    });
    if (!found) throw new Error("종료할 사건 기록을 찾지 못했습니다.");
    return sortQuickEvents(next);
  }
  function updateQuickEvent(events, id, changes = {}) {
    const now = (/* @__PURE__ */ new Date()).toISOString();
    let found = false;
    const next = sortQuickEvents(events).map((event) => {
      var _a, _b, _c, _d, _e, _f, _g, _h;
      if (event.id !== id) return event;
      found = true;
      if (isMomentEventType(event.eventType)) {
        return normalizeQuickEvent({
          ...event,
          timestamp: changes.timestamp || event.timestamp,
          outputAtEvent: (_a = changes.outputAtEvent) != null ? _a : event.outputAtEvent,
          memo: (_b = changes.memo) != null ? _b : event.memo,
          severity: (_c = changes.severity) != null ? _c : event.severity,
          updatedAt: now
        });
      }
      return normalizeQuickEvent({
        ...event,
        startTimestamp: changes.startTimestamp || event.startTimestamp,
        endTimestamp: changes.endTimestamp === "" ? null : (_d = changes.endTimestamp) != null ? _d : event.endTimestamp,
        startOutput: (_e = changes.startOutput) != null ? _e : event.startOutput,
        endOutput: changes.endTimestamp === "" ? null : (_f = changes.endOutput) != null ? _f : event.endOutput,
        memo: (_g = changes.memo) != null ? _g : event.memo,
        severity: (_h = changes.severity) != null ? _h : event.severity,
        updatedAt: now
      });
    });
    if (!found) throw new Error("수정할 사건 기록을 찾지 못했습니다.");
    return sortQuickEvents(next);
  }
  function deleteQuickEvent(events, id) {
    const current = sortQuickEvents(events);
    if (!current.some((event) => event.id === id)) throw new Error("삭제할 사건 기록을 찾지 못했습니다.");
    return current.filter((event) => event.id !== id);
  }
  function findOpenDurationEvent(events, eventType) {
    return [...sortQuickEvents(events)].reverse().find((event) => event.eventType === eventType && isDurationEventType(event.eventType) && event.status === "open") || null;
  }
  function hasRecentMomentDuplicate(events, eventType, timestamp, windowMs = QUICK_EVENT_DUPLICATE_WINDOW_MS) {
    if (!isMomentEventType(eventType)) return false;
    const target = Date.parse(validTimestamp3(timestamp));
    return sortQuickEvents(events).some((event) => event.eventType === eventType && isMomentEventType(event.eventType) && Math.abs(target - Date.parse(event.timestamp)) < windowMs);
  }

  // js/quick-event-storage.js
  var QUICK_EVENT_STORAGE_KEY = "medicationDiary.quickEvents.v1";
  function createQuickEventStore(storage = globalThis.localStorage) {
    if (!storage) throw new Error("브라우저 저장소를 사용할 수 없습니다.");
    function load() {
      try {
        const raw = storage.getItem(QUICK_EVENT_STORAGE_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        return sortQuickEvents(Array.isArray(parsed) ? parsed : parsed.events);
      } catch (error) {
        console.warn("Quick event storage could not be read.", error);
        return [];
      }
    }
    function save(events) {
      const normalized = sortQuickEvents(events);
      storage.setItem(QUICK_EVENT_STORAGE_KEY, JSON.stringify({
        schemaVersion: QUICK_EVENT_SCHEMA_VERSION,
        updatedAt: (/* @__PURE__ */ new Date()).toISOString(),
        events: normalized
      }));
      return normalized;
    }
    return {
      key: QUICK_EVENT_STORAGE_KEY,
      getAll: load,
      addMoment(eventType, timestamp = (/* @__PURE__ */ new Date()).toISOString(), outputAtEvent = null, options = {}) {
        const current = load();
        if (hasRecentMomentDuplicate(current, eventType, timestamp)) {
          return { event: null, reason: "DUPLICATE_CLICK" };
        }
        const event = createMomentEvent(eventType, timestamp, outputAtEvent, options);
        save([...current, event]);
        return { event, reason: null };
      },
      toggleDuration(eventType, timestamp = (/* @__PURE__ */ new Date()).toISOString(), outputAtEvent = null, options = {}) {
        const current = load();
        const open = findOpenDurationEvent(current, eventType);
        if (open) {
          const rows = save(closeDurationEvent(current, open.id, timestamp, outputAtEvent, options));
          return { action: "closed", event: rows.find((event2) => event2.id === open.id) };
        }
        const event = createDurationEvent(eventType, timestamp, outputAtEvent, options);
        save([...current, event]);
        return { action: "started", event };
      },
      update(id, changes) {
        return save(updateQuickEvent(load(), id, changes));
      },
      delete(id) {
        return save(deleteQuickEvent(load(), id));
      },
      replaceAll(events) {
        return save(events);
      }
    };
  }

  // js/output-ui.js
  var root = document.getElementById("outputMvpMount");
  var storageState = resolveStorage();
  var store = createOutputStore(storageState.storage);
  var quickStore = createQuickEventStore(storageState.storage);
  var selectedDate = localDate(/* @__PURE__ */ new Date());
  var pendingDelta = null;
  var pendingRetrospective = null;
  var editingId = null;
  var editingEventType = null;
  var editingQuickId = null;
  var toastTimer = null;
  function resolveStorage() {
    try {
      const storage = window.localStorage;
      const probe = "medicationDiary.outputEvents.storageProbe";
      storage.setItem(probe, "1");
      storage.removeItem(probe);
      return { storage, persistent: true };
    } catch (error) {
      console.warn("Persistent output storage is unavailable; using temporary memory storage.", error);
      const memory = /* @__PURE__ */ new Map();
      return {
        persistent: false,
        storage: {
          getItem: (key) => memory.has(String(key)) ? memory.get(String(key)) : null,
          setItem: (key, value) => memory.set(String(key), String(value)),
          removeItem: (key) => memory.delete(String(key))
        }
      };
    }
  }
  function localDate(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  }
  function formatTime(timestamp) {
    return new Date(timestamp).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit", hour12: false });
  }
  function toDatetimeLocal(timestamp) {
    const date = new Date(timestamp);
    const pad = (value) => String(value).padStart(2, "0");
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }
  function eventName(event) {
    if (event.eventType === "anchor") return "기준 출력";
    if (event.eventType === "retrospective_output") return "지난 시간 출력";
    if (event.eventType === "manual_correction") return "직접 수정";
    return event.delta > 0 ? "+10 변화" : "-10 변화";
  }
  function quickEventName(eventType) {
    return {
      freezing: "동결",
      near_fall: "넘어질 뻔",
      dyskinesia: "이상운동증",
      dystonia: "근긴장이상",
      medication: "약 복용"
    }[eventType] || "사건";
  }
  function outputAtTimestamp(timestamp) {
    const target = Date.parse(timestamp);
    const rows = store.getByDate(localDate(new Date(timestamp))).filter((event) => Date.parse(event.timestamp) <= target);
    return rows.length ? rows[rows.length - 1].newOutput : null;
  }
  function quickEventsForDate(dateValue) {
    return quickStore.getAll().filter((event) => {
      const startDate = localDate(new Date(quickEventTimestamp(event)));
      const endDate = event.endTimestamp ? localDate(new Date(event.endTimestamp)) : startDate;
      return dateValue >= startDate && dateValue <= endDate;
    });
  }
  function readLegacyMedicationEvents(dateValue) {
    try {
      const raw = storageState.storage.getItem("yakhyo_log_v1");
      const parsed = raw ? JSON.parse(raw) : null;
      const events = Array.isArray(parsed == null ? void 0 : parsed.events) ? parsed.events : [];
      return events.filter((event) => (event == null ? void 0 : event.type) === "med" && localDate(new Date(Number(event.ts))) === dateValue).map((event) => ({
        id: String(event.id),
        eventType: "medication",
        timestamp: new Date(Number(event.ts)).toISOString(),
        createdAt: event.createdAt || new Date(Number(event.ts)).toISOString(),
        outputAtEvent: event.outputAtEvent == null ? outputAtTimestamp(new Date(Number(event.ts)).toISOString()) : Number(event.outputAtEvent),
        medicationName: String(event.drug || "약"),
        dose: String(event.dose || ""),
        inputMethod: event.inputMethod || "legacy_medication",
        memo: String(event.memo || ""),
        legacy: true
      })).sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
    } catch (error) {
      console.warn("Medication events could not be read for the output graph.", error);
      return [];
    }
  }
  function readLegacyClinicalEvents(dateValue) {
    try {
      const raw = storageState.storage.getItem("yakhyo_log_v1");
      const parsed = raw ? JSON.parse(raw) : null;
      return extractClinicalEvents(parsed == null ? void 0 : parsed.events).filter((event) => localDate(new Date(event.timestamp)) === dateValue).map((event) => {
        var _a;
        return {
          ...event,
          outputAtEvent: (_a = event.outputAtEvent) != null ? _a : outputAtTimestamp(event.timestamp)
        };
      });
    } catch (error) {
      console.warn("Clinical events could not be read for the output graph.", error);
      return [];
    }
  }
  function dateOffset(days) {
    const date = /* @__PURE__ */ new Date();
    date.setHours(0, 0, 0, 0);
    date.setDate(date.getDate() + days);
    return localDate(date);
  }
  function timeInputValue(date = /* @__PURE__ */ new Date()) {
    const pad = (value) => String(value).padStart(2, "0");
    return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  }
  function retrospectiveTimestamp(dateValue, timeValue) {
    const date = /* @__PURE__ */ new Date(`${dateValue}T${timeValue}:00`);
    if (Number.isNaN(date.getTime())) throw new TypeError("날짜와 시간을 확인해 주세요.");
    return date.toISOString();
  }
  function downloadText(filename, content, type) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
  function showToast(message, undoId = null) {
    const toast = document.getElementById("omvp-toast");
    const text = document.getElementById("omvp-toast-text");
    const undo = document.getElementById("omvp-undo");
    if (!toast || !text || !undo) return;
    clearTimeout(toastTimer);
    text.textContent = message;
    undo.hidden = !undoId;
    undo.onclick = undoId ? () => {
      try {
        store.delete(undoId);
        toast.hidden = true;
        render();
      } catch (error) {
        window.alert(error.message);
      }
    } : null;
    toast.hidden = false;
    toastTimer = setTimeout(() => {
      toast.hidden = true;
    }, 6e3);
  }
  function closeModal(id) {
    const modal = document.getElementById(id);
    if (modal) modal.hidden = true;
  }
  function openAnchorSelector(initial = false) {
    const modal = document.getElementById("omvp-anchor-modal");
    const title = document.getElementById("omvp-anchor-title");
    title.textContent = initial ? "오늘의 첫 기준 출력" : "현재 출력 다시 설정";
    modal.dataset.initial = initial ? "true" : "false";
    modal.hidden = false;
  }
  function openGapDialog(delta) {
    pendingDelta = delta;
    document.getElementById("omvp-gap-modal").hidden = false;
  }
  function openRetrospectiveDialog() {
    var _a, _b;
    const today = localDate(/* @__PURE__ */ new Date());
    const earliest = dateOffset(-(OUTPUT_RETROSPECTIVE_MAX_DAYS - 1));
    const dateInput = document.getElementById("omvp-retrospective-date");
    dateInput.min = earliest;
    dateInput.max = today;
    dateInput.value = selectedDate >= earliest && selectedDate <= today ? selectedDate : today;
    document.getElementById("omvp-retrospective-time").value = timeInputValue();
    const selectedRows = store.getByDate(dateInput.value);
    document.getElementById("omvp-retrospective-output").value = String((_b = (_a = selectedRows[selectedRows.length - 1]) == null ? void 0 : _a.newOutput) != null ? _b : 50);
    document.getElementById("omvp-retrospective-note").value = "";
    pendingRetrospective = null;
    document.getElementById("omvp-retrospective-modal").hidden = false;
  }
  function readRetrospectiveDraft() {
    const date = document.getElementById("omvp-retrospective-date").value;
    const time = document.getElementById("omvp-retrospective-time").value;
    if (!date || !time) throw new TypeError("날짜와 시간을 모두 입력해 주세요.");
    return {
      timestamp: retrospectiveTimestamp(date, time),
      output: Number(document.getElementById("omvp-retrospective-output").value),
      note: document.getElementById("omvp-retrospective-note").value
    };
  }
  function commitRetrospective(draft, existingId = null) {
    const createdAt = (/* @__PURE__ */ new Date()).toISOString();
    const options = { note: draft.note, createdAt, currentTimestamp: createdAt };
    const event = existingId ? store.replaceWithRetrospective(existingId, draft.output, draft.timestamp, options) : store.addRetrospective(draft.output, draft.timestamp, options);
    selectedDate = event.localDate;
    pendingRetrospective = null;
    closeModal("omvp-retrospective-conflict-modal");
    closeModal("omvp-retrospective-modal");
    render();
    showToast(
      existingId ? "기존 기록을 소급 출력으로 수정하고 이후 출력을 다시 계산했습니다." : "지난 시간 출력을 기록하고 이후 출력을 다시 계산했습니다.",
      existingId ? null : event.id
    );
  }
  function handleRetrospectiveSubmit() {
    try {
      const draft = readRetrospectiveDraft();
      const conflicts = store.getAtMinute(draft.timestamp);
      if (!conflicts.length) return commitRetrospective(draft);
      const latestConflict = conflicts[conflicts.length - 1];
      pendingRetrospective = { ...draft, timestamp: latestConflict.timestamp, existingId: latestConflict.id };
      const summary = conflicts.map((event) => `${formatTime(event.timestamp)} ${eventName(event)} ${event.newOutput}`).join(", ");
      document.getElementById("omvp-retrospective-conflict-text").textContent = `같은 시각에 ${summary} 기록이 있습니다.`;
      document.getElementById("omvp-retrospective-conflict-modal").hidden = false;
    } catch (error) {
      window.alert(error.message);
    }
  }
  function openEditDialog(event) {
    editingId = event.id;
    editingEventType = event.eventType;
    document.getElementById("omvp-edit-time").value = toDatetimeLocal(event.timestamp);
    document.getElementById("omvp-edit-output").value = String(event.newOutput);
    const noteField = document.getElementById("omvp-edit-note-field");
    noteField.hidden = event.eventType !== "retrospective_output";
    document.getElementById("omvp-edit-note").value = event.note || "";
    const timeInput = document.getElementById("omvp-edit-time");
    timeInput.max = event.eventType === "retrospective_output" ? toDatetimeLocal((/* @__PURE__ */ new Date()).toISOString()) : "";
    timeInput.min = event.eventType === "retrospective_output" ? `${dateOffset(-(OUTPUT_RETROSPECTIVE_MAX_DAYS - 1))}T00:00` : "";
    document.getElementById("omvp-edit-modal").hidden = false;
  }
  function openQuickEditDialog(event) {
    editingQuickId = event.id;
    document.getElementById("omvp-quick-edit-title").textContent = `${quickEventName(event.eventType)} 기록 수정`;
    document.getElementById("omvp-quick-edit-start").value = toDatetimeLocal(quickEventTimestamp(event));
    const endField = document.getElementById("omvp-quick-edit-end-field");
    endField.hidden = !isDurationEventType(event.eventType);
    document.getElementById("omvp-quick-edit-end").value = event.endTimestamp ? toDatetimeLocal(event.endTimestamp) : "";
    document.getElementById("omvp-quick-edit-memo").value = event.memo || "";
    document.getElementById("omvp-quick-edit-modal").hidden = false;
  }
  function removeQuickEvent(event) {
    if (!window.confirm(`${quickEventName(event.eventType)} 기록을 삭제할까요?`)) return;
    try {
      quickStore.delete(event.id);
      render();
      showToast("사건 기록을 삭제했습니다.");
    } catch (error) {
      window.alert(error.message);
    }
  }
  function renderRecent(outputEvents, quickEvents, medicationEvents, clinicalEvents) {
    const container = document.getElementById("omvp-recent-list");
    const rows = [
      ...outputEvents.map((event) => ({ kind: "output", timestamp: event.timestamp, event })),
      ...quickEvents.map((event) => ({ kind: "quick", timestamp: quickEventTimestamp(event), event })),
      ...medicationEvents.map((event) => ({ kind: "medication", timestamp: event.timestamp, event })),
      ...clinicalEvents.map((event) => ({ kind: "clinical", timestamp: event.timestamp, event }))
    ].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
    if (!rows.length) {
      container.innerHTML = '<div class="omvp-empty">기록이 없습니다.</div>';
      return;
    }
    container.innerHTML = "";
    rows.reverse().slice(0, 20).forEach((item) => {
      var _a, _b, _c;
      const { event } = item;
      const row = document.createElement("div");
      row.className = `omvp-event ${item.kind}${event.retrospective ? " retrospective" : ""}`;
      const time = document.createElement("div");
      time.className = "omvp-event-time";
      time.textContent = formatTime(item.timestamp);
      const main = document.createElement("div");
      main.className = "omvp-event-main";
      const name = document.createElement("strong");
      const meta = document.createElement("div");
      meta.className = "omvp-event-meta";
      if (item.kind === "output") {
        name.textContent = `${eventName(event)} · ${event.newOutput}`;
        const previous = event.previousOutput == null ? "" : `${event.previousOutput} → `;
        meta.textContent = `${previous}${event.newOutput}${event.confidence === "low" ? " · 낮은 신뢰도" : ""}${event.retrospective ? " · 나중에 소급 입력" : ""}${event.note ? ` · ${event.note}` : ""}`;
      } else if (item.kind === "medication") {
        name.textContent = `💊 ${event.medicationName}${event.dose ? ` ${event.dose}` : ""}`;
        meta.textContent = `${event.outputAtEvent == null ? "출력 기준 없음" : `당시 출력 ${event.outputAtEvent}`}${event.memo ? ` · ${event.memo}` : ""}`;
      } else if (item.kind === "clinical") {
        name.textContent = `곡선 해석 · ${clinicalEventName(event.eventType)}`;
        meta.textContent = `${event.outputAtEvent == null ? "출력 기준 없음" : `당시 출력 ${event.outputAtEvent}`}${event.memo ? ` · ${event.memo}` : ""}`;
      } else {
        const duration = isDurationEventType(event.eventType);
        name.textContent = `${quickEventName(event.eventType)}${duration && event.status === "open" ? " · 진행 중" : ""}`;
        const outputText = duration ? `시작 출력 ${(_a = event.startOutput) != null ? _a : "—"}${event.endTimestamp ? ` · 종료 ${formatTime(event.endTimestamp)} · 출력 ${(_b = event.endOutput) != null ? _b : "—"}` : ""}` : `당시 출력 ${(_c = event.outputAtEvent) != null ? _c : "—"}`;
        meta.textContent = `${outputText}${event.memo ? ` · ${event.memo}` : ""}`;
      }
      main.append(name, meta);
      const actions = document.createElement("div");
      actions.className = "omvp-event-actions";
      const edit = document.createElement("button");
      edit.className = "omvp-icon-btn";
      edit.type = "button";
      edit.setAttribute("aria-label", `${formatTime(item.timestamp)} 기록 수정`);
      edit.textContent = "✎";
      edit.addEventListener("click", () => {
        var _a2, _b2;
        if (item.kind === "output") openEditDialog(event);
        else if (item.kind === "quick") openQuickEditDialog(event);
        else (_b2 = (_a2 = window.yakhyoLegacyBridge) == null ? void 0 : _a2.editEvent) == null ? void 0 : _b2.call(_a2, event.id);
      });
      const remove = document.createElement("button");
      remove.className = "omvp-icon-btn";
      remove.type = "button";
      remove.setAttribute("aria-label", `${formatTime(item.timestamp)} 기록 삭제`);
      remove.textContent = "×";
      remove.addEventListener("click", () => {
        var _a2, _b2;
        if (item.kind === "quick") return removeQuickEvent(event);
        if (item.kind === "medication" || item.kind === "clinical") {
          (_b2 = (_a2 = window.yakhyoLegacyBridge) == null ? void 0 : _a2.deleteEvent) == null ? void 0 : _b2.call(_a2, event.id);
          return;
        }
        if (!window.confirm(`${formatTime(item.timestamp)} 기록을 삭제할까요?`)) return;
        try {
          store.delete(event.id);
          render();
          showToast("기록을 삭제했습니다.");
        } catch (error) {
          window.alert(error.message);
        }
      });
      actions.append(edit, remove);
      row.append(time, main, actions);
      container.appendChild(row);
    });
  }
  function recordMomentEvent(eventType) {
    const now = (/* @__PURE__ */ new Date()).toISOString();
    const result = quickStore.addMoment(eventType, now, outputAtTimestamp(now));
    if (!result.event) {
      showToast("중복 입력을 막기 위해 잠시 뒤 다시 눌러 주세요.");
      return;
    }
    selectedDate = localDate(/* @__PURE__ */ new Date());
    render();
    showToast(`${quickEventName(eventType)}을 기록했습니다.`);
  }
  function toggleDurationEvent(eventType) {
    const now = (/* @__PURE__ */ new Date()).toISOString();
    try {
      const result = quickStore.toggleDuration(eventType, now, outputAtTimestamp(now));
      selectedDate = localDate(/* @__PURE__ */ new Date());
      render();
      showToast(`${quickEventName(eventType)} ${result.action === "started" ? "시작" : "종료"}을 기록했습니다.`);
    } catch (error) {
      window.alert(error.message);
    }
  }
  function render() {
    const today = localDate(/* @__PURE__ */ new Date());
    const todayEvents = store.getByDate(today);
    const current = todayEvents.length ? todayEvents[todayEvents.length - 1].newOutput : null;
    const value = document.getElementById("omvp-current-value");
    const stage = document.getElementById("omvp-current-stage");
    const last = document.getElementById("omvp-last");
    const controls = document.getElementById("omvp-delta-controls");
    const anchorPanel = document.getElementById("omvp-anchor-panel");
    if (current === null) {
      value.textContent = "—";
      stage.textContent = "오늘의 기준 출력이 필요합니다";
      last.textContent = "첫 입력은 0~100 중 현재 상태를 선택합니다.";
      controls.hidden = true;
      anchorPanel.hidden = false;
    } else {
      const recent = todayEvents[todayEvents.length - 1];
      value.textContent = String(current);
      stage.textContent = `체감 ${getOutputStage(current)}단계`;
      last.textContent = `마지막 기록 ${formatTime(recent.timestamp)} · ${eventName(recent)}`;
      controls.hidden = false;
      anchorPanel.hidden = true;
    }
    const dateInput = document.getElementById("omvp-date");
    dateInput.value = selectedDate;
    const selectedEvents = store.getByDate(selectedDate);
    const selectedQuickEvents = quickEventsForDate(selectedDate);
    const selectedMedicationEvents = readLegacyMedicationEvents(selectedDate);
    const selectedClinicalEvents = readLegacyClinicalEvents(selectedDate);
    renderOutputChart(document.getElementById("omvp-chart"), selectedEvents, [...selectedQuickEvents, ...selectedMedicationEvents, ...selectedClinicalEvents]);
    renderRecent(selectedEvents, selectedQuickEvents, selectedMedicationEvents, selectedClinicalEvents);
    [QUICK_EVENT_TYPES.DYSKINESIA, QUICK_EVENT_TYPES.DYSTONIA].forEach((eventType) => {
      const button = document.querySelector(`[data-duration-event="${eventType}"]`);
      if (!button) return;
      const open = findOpenDurationEvent(quickStore.getAll(), eventType);
      button.classList.toggle("active", Boolean(open));
      button.setAttribute("aria-pressed", open ? "true" : "false");
      const hint = button.querySelector("small");
      if (hint) hint.textContent = open ? `진행 중 · 다시 누르면 종료 (${formatTime(open.startTimestamp)})` : "누르면 시작";
    });
  }
  function recordDelta(delta, confidence = "high") {
    selectedDate = localDate(/* @__PURE__ */ new Date());
    try {
      const result = store.addDelta(delta, (/* @__PURE__ */ new Date()).toISOString(), { confidence });
      if (!result.event) {
        showToast(result.reason === "MAX_REACHED" ? "현재 출력이 이미 최대 100입니다." : "현재 출력이 이미 최소 0입니다.");
        return;
      }
      render();
      showToast(`출력 ${result.event.previousOutput} → ${result.event.newOutput}으로 기록했습니다.`, result.event.id);
    } catch (error) {
      window.alert(`출력 기록을 저장하지 못했습니다. ${error.message}`);
    }
  }
  function handleDelta(delta) {
    const today = localDate(/* @__PURE__ */ new Date());
    const rows = store.getByDate(today);
    if (!rows.length) {
      openAnchorSelector(true);
      return;
    }
    const last = rows[rows.length - 1];
    const now = (/* @__PURE__ */ new Date()).toISOString();
    if (shouldRequestReanchor(last.timestamp, now, OUTPUT_REANCHOR_THRESHOLD_MINUTES)) {
      openGapDialog(delta);
      return;
    }
    recordDelta(delta);
  }
  function buildShell() {
    if (!root) return;
    const anchorButtons = Array.from({ length: 11 }, (_, index) => index * 10).map((value) => `<button type="button" class="omvp-anchor-option" data-output="${value}">${value}</button>`).join("");
    const inlineAnchorButtons = Array.from({ length: 11 }, (_, index) => index * 10).map((value) => `<button type="button" class="omvp-inline-anchor-option" data-output="${value}">${value}</button>`).join("");
    const outputOptions = Array.from({ length: 11 }, (_, index) => index * 10).map((value) => `<option value="${value}">${value}</option>`).join("");
    root.innerHTML = `
    <article class="omvp-card" aria-labelledby="omvp-current-label">
      ${storageState.persistent ? "" : '<div class="omvp-storage-warning" role="alert">브라우저 저장소를 사용할 수 없어 이 화면을 닫으면 출력 기록이 사라집니다. 사이트 저장 권한을 허용한 뒤 다시 열어 주세요.</div>'}
      <div class="omvp-current" aria-live="polite">
        <div class="omvp-current-label" id="omvp-current-label">현재 출력</div>
        <div class="omvp-current-value" id="omvp-current-value">—</div>
        <div class="omvp-current-stage" id="omvp-current-stage"></div>
        <div class="omvp-last" id="omvp-last"></div>
      </div>
      <div class="omvp-anchor-panel" id="omvp-anchor-panel">
        <strong>오늘의 첫 출력을 선택하세요</strong>
        <p>현재 몸 상태를 0~100 중 10점 단위로 한 번 선택합니다.</p>
        <div class="omvp-inline-anchor-grid">${inlineAnchorButtons}</div>
      </div>
      <div class="omvp-delta-row" id="omvp-delta-controls" hidden>
        <button type="button" class="omvp-delta-btn minus" id="omvp-minus" aria-label="출력 10점 낮아짐">−10</button>
        <button type="button" class="omvp-delta-btn plus" id="omvp-plus" aria-label="출력 10점 좋아짐">+10</button>
      </div>
      <section class="omvp-chart-section">
        <div class="omvp-chart-toolbar">
          <strong>출력 그래프</strong>
          <input type="date" class="omvp-date" id="omvp-date" aria-label="출력 그래프 날짜">
        </div>
        <div class="omvp-chart" id="omvp-chart"></div>
        <p class="omvp-chart-note">선은 기록점을 보기 위한 연결선입니다. 기록되지 않은 시간의 실제 출력을 확정하지 않으며, 2시간이 넘는 공백과 새 기준점에서는 선을 끊습니다.</p>
      </section>
      <section class="omvp-quick-section" aria-labelledby="omvp-quick-title">
        <div class="omvp-section-heading">
          <strong id="omvp-quick-title">빠른 사건 기록</strong>
          <span>출력값은 바뀌지 않습니다</span>
        </div>
        <div class="omvp-quick-grid">
          <button type="button" class="omvp-quick-btn medication" id="omvp-quick-medication"><b>💊 약 복용</b><small>기존 약 선택창 열기</small></button>
          <button type="button" class="omvp-quick-btn duration" data-duration-event="dyskinesia"><b>이상운동증</b><small>누르면 시작</small></button>
          <button type="button" class="omvp-quick-btn duration" data-duration-event="dystonia"><b>근긴장이상</b><small>누르면 시작</small></button>
          <button type="button" class="omvp-quick-btn" data-moment-event="freezing"><b>동결</b><small>지금 발생</small></button>
          <button type="button" class="omvp-quick-btn warning" data-moment-event="near_fall"><b>넘어질 뻔</b><small>지금 발생</small></button>
        </div>
        <button type="button" class="omvp-backdated-main" id="omvp-retrospective-main">지난 시간 출력 기록</button>
      </section>
      <details class="omvp-management">
        <summary>출력 기록 관리</summary>
        <div class="omvp-management-content">
          <div class="omvp-actions">
            <button type="button" class="omvp-small-btn retrospective" id="omvp-retrospective-open">지난 시간 출력 기록</button>
            <button type="button" class="omvp-small-btn" id="omvp-reanchor">기준 다시 설정</button>
            <button type="button" class="omvp-small-btn" id="omvp-export-json">JSON 내보내기</button>
            <button type="button" class="omvp-small-btn" id="omvp-export-csv">CSV 내보내기</button>
          </div>
          <p class="omvp-separate-note">출력 변화와 사건은 서로 독립적으로 저장합니다. ON/OFF는 자동 생성하지 않으며 기존 상세 입력 기능만 아래 <b>상세 기록</b>에 유지합니다.</p>
          <section class="omvp-recent">
            <h3>최근 출력·사건 기록</h3>
            <div id="omvp-recent-list"></div>
          </section>
        </div>
      </details>
    </article>

    <div class="omvp-modal" id="omvp-anchor-modal" hidden>
      <div class="omvp-dialog" role="dialog" aria-modal="true" aria-labelledby="omvp-anchor-title">
        <h3 id="omvp-anchor-title">현재 출력 설정</h3>
        <p>지금 느끼는 출력을 선택하세요. 이 값부터 ±10 변화가 쌓입니다.</p>
        <div class="omvp-anchor-grid">${anchorButtons}</div>
        <button type="button" class="omvp-small-btn" id="omvp-anchor-cancel">취소</button>
      </div>
    </div>

    <div class="omvp-modal" id="omvp-retrospective-modal" hidden>
      <div class="omvp-dialog" role="dialog" aria-modal="true" aria-labelledby="omvp-retrospective-title">
        <h3 id="omvp-retrospective-title">지난 시간 출력 기록</h3>
        <p>최근 7일 안에서 기억나는 시각과 당시 출력을 직접 입력합니다. 이후의 ±10 기록은 이 값을 기준으로 다시 계산됩니다.</p>
        <div class="omvp-retrospective-date-time">
          <div class="omvp-edit-field"><label for="omvp-retrospective-date">날짜</label><input type="date" id="omvp-retrospective-date"></div>
          <div class="omvp-edit-field"><label for="omvp-retrospective-time">시간</label><input type="time" id="omvp-retrospective-time"></div>
        </div>
        <div class="omvp-edit-field"><label for="omvp-retrospective-output">당시 출력</label><select id="omvp-retrospective-output">${outputOptions}</select></div>
        <div class="omvp-edit-field"><label for="omvp-retrospective-note">메모 (선택)</label><textarea id="omvp-retrospective-note" maxlength="500" placeholder="예: 아침 식사 전, 보행이 느렸음"></textarea></div>
        <div class="omvp-dialog-actions">
          <button type="button" class="omvp-small-btn" id="omvp-retrospective-cancel">취소</button>
          <button type="button" class="omvp-small-btn primary" id="omvp-retrospective-save">저장</button>
        </div>
      </div>
    </div>

    <div class="omvp-modal" id="omvp-retrospective-conflict-modal" hidden>
      <div class="omvp-dialog" role="dialog" aria-modal="true" aria-labelledby="omvp-retrospective-conflict-title">
        <h3 id="omvp-retrospective-conflict-title">같은 시각의 기록이 있습니다</h3>
        <p id="omvp-retrospective-conflict-text"></p>
        <div class="omvp-conflict-actions">
          <button type="button" class="omvp-small-btn" id="omvp-conflict-update">기존 기록 수정</button>
          <button type="button" class="omvp-small-btn primary" id="omvp-conflict-add">새 기록 추가</button>
          <button type="button" class="omvp-small-btn" id="omvp-conflict-cancel">취소</button>
        </div>
      </div>
    </div>

    <div class="omvp-modal" id="omvp-gap-modal" hidden>
      <div class="omvp-dialog" role="dialog" aria-modal="true" aria-labelledby="omvp-gap-title">
        <h3 id="omvp-gap-title">2시간 이상 기록이 없었습니다</h3>
        <p>현재 출력을 다시 설정하는 것이 더 정확합니다. 그대로 기록하면 낮은 신뢰도로 저장되고 그래프 선은 끊깁니다.</p>
        <div class="omvp-dialog-actions">
          <button type="button" class="omvp-small-btn primary" id="omvp-gap-anchor">현재 출력 다시 설정</button>
          <button type="button" class="omvp-small-btn continue" id="omvp-gap-continue">그대로 기록</button>
        </div>
        <button type="button" class="omvp-small-btn" id="omvp-gap-cancel" style="margin-top:10px;width:100%">취소</button>
      </div>
    </div>

    <div class="omvp-modal" id="omvp-edit-modal" hidden>
      <div class="omvp-dialog" role="dialog" aria-modal="true" aria-labelledby="omvp-edit-title">
        <h3 id="omvp-edit-title">출력 기록 수정</h3>
        <p>값을 바꾸면 이후의 ±10 기록이 시간순으로 다시 계산됩니다.</p>
        <div class="omvp-edit-field"><label for="omvp-edit-time">기록 시각</label><input type="datetime-local" id="omvp-edit-time"></div>
        <div class="omvp-edit-field"><label for="omvp-edit-output">이 시점의 출력</label><select id="omvp-edit-output">${outputOptions}</select></div>
        <div class="omvp-edit-field" id="omvp-edit-note-field" hidden><label for="omvp-edit-note">메모 (선택)</label><textarea id="omvp-edit-note" maxlength="500"></textarea></div>
        <div class="omvp-dialog-actions">
          <button type="button" class="omvp-small-btn" id="omvp-edit-cancel">취소</button>
          <button type="button" class="omvp-small-btn primary" id="omvp-edit-save">저장</button>
        </div>
      </div>
    </div>

    <div class="omvp-modal" id="omvp-quick-edit-modal" hidden>
      <div class="omvp-dialog" role="dialog" aria-modal="true" aria-labelledby="omvp-quick-edit-title">
        <h3 id="omvp-quick-edit-title">사건 기록 수정</h3>
        <p>사건 시각과 메모를 수정할 수 있습니다. 출력곡선은 바뀌지 않습니다.</p>
        <div class="omvp-edit-field"><label for="omvp-quick-edit-start">발생 또는 시작 시각</label><input type="datetime-local" id="omvp-quick-edit-start"></div>
        <div class="omvp-edit-field" id="omvp-quick-edit-end-field"><label for="omvp-quick-edit-end">종료 시각 (비우면 진행 중)</label><input type="datetime-local" id="omvp-quick-edit-end"></div>
        <div class="omvp-edit-field"><label for="omvp-quick-edit-memo">메모 (선택)</label><textarea id="omvp-quick-edit-memo" maxlength="500"></textarea></div>
        <div class="omvp-dialog-actions">
          <button type="button" class="omvp-small-btn" id="omvp-quick-edit-cancel">취소</button>
          <button type="button" class="omvp-small-btn primary" id="omvp-quick-edit-save">저장</button>
        </div>
      </div>
    </div>

    <div class="omvp-toast" id="omvp-toast" role="status" hidden>
      <span id="omvp-toast-text"></span><button type="button" id="omvp-undo">취소</button>
    </div>`;
    document.getElementById("omvp-reanchor").addEventListener("click", () => {
      const hasTodayEvent = store.getByDate(localDate(/* @__PURE__ */ new Date())).length > 0;
      openAnchorSelector(!hasTodayEvent);
    });
    document.getElementById("omvp-retrospective-open").addEventListener("click", openRetrospectiveDialog);
    document.getElementById("omvp-retrospective-main").addEventListener("click", openRetrospectiveDialog);
    document.getElementById("omvp-retrospective-cancel").addEventListener("click", () => closeModal("omvp-retrospective-modal"));
    document.getElementById("omvp-retrospective-save").addEventListener("click", handleRetrospectiveSubmit);
    document.getElementById("omvp-conflict-update").addEventListener("click", () => {
      if (!pendingRetrospective) return;
      try {
        commitRetrospective(pendingRetrospective, pendingRetrospective.existingId);
      } catch (error) {
        window.alert(error.message);
      }
    });
    document.getElementById("omvp-conflict-add").addEventListener("click", () => {
      if (!pendingRetrospective) return;
      try {
        commitRetrospective(pendingRetrospective);
      } catch (error) {
        window.alert(error.message);
      }
    });
    document.getElementById("omvp-conflict-cancel").addEventListener("click", () => {
      pendingRetrospective = null;
      closeModal("omvp-retrospective-conflict-modal");
    });
    document.getElementById("omvp-plus").addEventListener("click", () => handleDelta(10));
    document.getElementById("omvp-minus").addEventListener("click", () => handleDelta(-10));
    document.getElementById("omvp-quick-medication").addEventListener("click", () => {
      if (typeof window.openMedSheet === "function") window.openMedSheet({ quickOutputEvent: true });
      else window.alert("약 복용 입력창을 열 수 없습니다. 페이지를 새로고침해 주세요.");
    });
    document.querySelectorAll("[data-moment-event]").forEach((button) => {
      button.addEventListener("click", () => recordMomentEvent(button.dataset.momentEvent));
    });
    document.querySelectorAll("[data-duration-event]").forEach((button) => {
      button.addEventListener("click", () => toggleDurationEvent(button.dataset.durationEvent));
    });
    document.getElementById("omvp-date").addEventListener("change", (event) => {
      selectedDate = event.target.value || localDate(/* @__PURE__ */ new Date());
      render();
    });
    document.querySelectorAll(".omvp-inline-anchor-option").forEach((button) => {
      button.addEventListener("click", () => {
        try {
          const output = Number(button.dataset.output);
          const event = store.addAnchor(output, (/* @__PURE__ */ new Date()).toISOString(), { initial: true });
          selectedDate = event.localDate;
          render();
          showToast(`오늘의 기준 출력을 ${output}으로 기록했습니다.`, event.id);
        } catch (error) {
          window.alert(`기준 출력을 저장하지 못했습니다. ${error.message}`);
        }
      });
    });
    document.querySelectorAll(".omvp-anchor-option").forEach((button) => {
      button.addEventListener("click", () => {
        try {
          const initial = document.getElementById("omvp-anchor-modal").dataset.initial === "true";
          const output = Number(button.dataset.output);
          const event = store.addAnchor(output, (/* @__PURE__ */ new Date()).toISOString(), { initial });
          selectedDate = event.localDate;
          closeModal("omvp-anchor-modal");
          render();
          showToast(`기준 출력을 ${output}으로 기록했습니다.`, event.id);
        } catch (error) {
          window.alert(`기준 출력을 저장하지 못했습니다. ${error.message}`);
        }
      });
    });
    document.getElementById("omvp-anchor-cancel").addEventListener("click", () => closeModal("omvp-anchor-modal"));
    document.getElementById("omvp-gap-cancel").addEventListener("click", () => {
      pendingDelta = null;
      closeModal("omvp-gap-modal");
    });
    document.getElementById("omvp-gap-anchor").addEventListener("click", () => {
      pendingDelta = null;
      closeModal("omvp-gap-modal");
      openAnchorSelector(false);
    });
    document.getElementById("omvp-gap-continue").addEventListener("click", () => {
      const delta = pendingDelta;
      pendingDelta = null;
      closeModal("omvp-gap-modal");
      if (delta) recordDelta(delta, "low");
    });
    document.getElementById("omvp-edit-cancel").addEventListener("click", () => closeModal("omvp-edit-modal"));
    document.getElementById("omvp-edit-save").addEventListener("click", () => {
      const value = document.getElementById("omvp-edit-time").value;
      const output = Number(document.getElementById("omvp-edit-output").value);
      if (!value) return window.alert("기록 시각을 입력해 주세요.");
      try {
        const changes = { timestamp: new Date(value).toISOString(), newOutput: output };
        if (editingEventType === "retrospective_output") {
          changes.note = document.getElementById("omvp-edit-note").value;
          changes.currentTimestamp = (/* @__PURE__ */ new Date()).toISOString();
        }
        store.update(editingId, changes);
        closeModal("omvp-edit-modal");
        render();
        showToast("기록을 수정하고 이후 출력을 다시 계산했습니다.");
      } catch (error) {
        window.alert(error.message);
      }
    });
    document.getElementById("omvp-quick-edit-cancel").addEventListener("click", () => closeModal("omvp-quick-edit-modal"));
    document.getElementById("omvp-quick-edit-save").addEventListener("click", () => {
      const event = quickStore.getAll().find((row) => row.id === editingQuickId);
      const startValue = document.getElementById("omvp-quick-edit-start").value;
      const endValue = document.getElementById("omvp-quick-edit-end").value;
      if (!event || !startValue) return window.alert("사건 시각을 확인해 주세요.");
      try {
        const startTimestamp = new Date(startValue).toISOString();
        const changes = { memo: document.getElementById("omvp-quick-edit-memo").value };
        if (isDurationEventType(event.eventType)) {
          changes.startTimestamp = startTimestamp;
          changes.startOutput = outputAtTimestamp(startTimestamp);
          changes.endTimestamp = endValue ? new Date(endValue).toISOString() : "";
          changes.endOutput = endValue ? outputAtTimestamp(changes.endTimestamp) : null;
        } else {
          changes.timestamp = startTimestamp;
          changes.outputAtEvent = outputAtTimestamp(startTimestamp);
        }
        quickStore.update(event.id, changes);
        editingQuickId = null;
        closeModal("omvp-quick-edit-modal");
        render();
        showToast("사건 기록을 수정했습니다.");
      } catch (error) {
        window.alert(error.message);
      }
    });
    document.getElementById("omvp-export-json").addEventListener("click", () => {
      const events = store.getByDate(selectedDate);
      if (!events.length) return showToast("선택한 날짜에 내보낼 기록이 없습니다.");
      downloadText(`약효일지_출력_${selectedDate}.json`, store.exportJson(selectedDate), "application/json;charset=utf-8");
    });
    document.getElementById("omvp-export-csv").addEventListener("click", () => {
      const events = store.getByDate(selectedDate);
      if (!events.length) return showToast("선택한 날짜에 내보낼 기록이 없습니다.");
      downloadText(`약효일지_출력_${selectedDate}.csv`, store.exportCsv(selectedDate), "text/csv;charset=utf-8");
    });
  }
  if (root) {
    buildShell();
    render();
    window.yakhyoOutputBridge = Object.freeze({
      getCurrentOutput: () => outputAtTimestamp((/* @__PURE__ */ new Date()).toISOString()),
      getOutputAtTimestamp: (timestamp) => outputAtTimestamp(timestamp),
      refresh: () => render()
    });
    window.addEventListener("storage", (event) => {
      if ([store.key, quickStore.key, "yakhyo_log_v1"].includes(event.key)) render();
    });
    window.addEventListener("yakhyo:legacy-events-changed", render);
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) render();
    });
  }
})();
