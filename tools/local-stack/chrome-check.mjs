// 실제 Chrome(headless)으로 원문 백업·복원과 승인 화면을 확인한다(로컬 시험 전용, 가상 데이터).
// 필요: tools/local-stack/start.sh, `npm i puppeteer-core`(이 스크립트 옆 또는 NODE_PATH), CHROME_PATH
//   NODE_PATH=/tmp/pp/node_modules CHROME_PATH=/usr/bin/google-chrome node tools/local-stack/chrome-check.mjs
// 결과 스크린샷: $LOCAL_STACK_DIR/chrome/*.png
import http from "node:http";
import { readFileSync, existsSync, mkdirSync, readdirSync, writeFileSync, rmSync } from "node:fs";
import { join, extname } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const puppeteer = require("puppeteer-core");
const ROOT = new URL("../..", import.meta.url).pathname;
const DIR = process.env.LOCAL_STACK_DIR || "/tmp/yakhyo-mcp-local";
const OUT = join(DIR, "chrome"); rmSync(OUT, { recursive: true, force: true }); mkdirSync(OUT, { recursive: true });
const DL = join(OUT, "downloads"); mkdirSync(DL);
const stack = JSON.parse(readFileSync(join(DIR, "stack.json"), "utf8"));
const { adminCreateUser, sql } = await import("./seed.mjs");
const { login, rpc } = await import("./client.mjs");

let pass = 0, fail = 0;
const ok = (c, n) => { c ? pass++ : fail++; console.log((c ? "  ✔ " : "  ✘ FAIL: ") + n); };
const sha = (s) => createHash("sha256").update(s, "utf8").digest("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 시험용 정적 서버: cloud-config.js만 로컬 스택 값으로 바꿔 낸다(저장소 파일은 그대로)
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".json": "application/json", ".png": "image/png", ".css": "text/css" };
const server = http.createServer((req, res) => {
  let p = decodeURIComponent(req.url.split("?")[0]); if (p === "/") p = "/index.html";
  if (p === "/cloud-config.js") {
    res.writeHead(200, { "content-type": TYPES[".js"] });
    return res.end(`window.YAKHYO_CLOUD_CONFIG={supabaseUrl:${JSON.stringify(stack.url)},publishableKey:${JSON.stringify(stack.publishableKey)}};`);
  }
  const f = join(ROOT, p);
  if (!f.startsWith(ROOT) || !existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { "content-type": TYPES[extname(f)] || "application/octet-stream" });
  res.end(readFileSync(f));
}).listen(8080, "127.0.0.1");
const APP = "http://127.0.0.1:8080/";

const tag = randomUUID().slice(0, 8), pw = randomUUID();
const uid = await adminCreateUser(`ch-u-${tag}@example.test`, pw);
const aid = await adminCreateUser(`ch-a-${tag}@example.test`, pw);
sql(`insert into public.diary_agent_links(agent_id, owner_id, expires_at) values ('${aid}','${uid}', now() + interval '1 day')`);
const agentTok = await login({ email: `ch-a-${tag}@example.test`, password: pw });

const base = Date.parse("2026-11-20T07:00:00+09:00");
const RAW = JSON.stringify({ events: [
  { id: "c1", type: "med", drug: "가상약 HBS", dose: 125, ts: base, memo: "보내지 않을 메모 😀" },
  { id: "c2", type: "state", state: "off", ts: base + 30 * 60e3, output: 15, trend: "stable", symptoms: [] },
  { id: "c3", type: "state", state: "on", ts: base + 60 * 60e3, output: 80, trend: "rising", symptoms: [] },
  { id: "c4", type: "life", kind: "meal", mealType: "점심", amount: "보통", ts: base + 300 * 60e3, extras: [], quality: [], symptoms: [] },
], meds: [{ name: "가상약 HBS", dose: 125, sched: ["07:00"] }], questions: [], settings: { theme: "light", notify: true, lang: "ko", seen: true }, outputChecks: [], dayMemos: {} }, null, 1);

const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || "/usr/bin/google-chrome", headless: true, args: ["--no-sandbox", "--lang=ko-KR"], downloadBehavior: { policy: "allow", downloadPath: DL } });
async function openApp(ctx) {
  const page = await ctx.newPage();
  await page.evaluateOnNewDocument(() => { window.CLOUD_BRIDGE_NO_AUTOSYNC = true; }); // 승인·가져오기 단계를 따로 확인하려고 자동 받아오기는 끔(통합 시험에서 따로 확인)
  await page.setViewport({ width: 420, height: 900, deviceScaleFactor: 1 });
  page.on("dialog", (d) => d.accept());
  page._errors = [];
  page.on("pageerror", (e) => page._errors.push(String(e)));
  await page.goto(APP, { waitUntil: "load" });
  return page;
}
async function toSettings(page) {
  await sleep(900); // 첫 실행 안내·"오늘 아침 기준점" 시트가 뜨면 사용자처럼 닫는다(앱 기존 동작)
  await page.evaluate(() => { try { closeSheet(); } catch (e) {} });
  await page.evaluate(() => switchTab("set"));
  await page.waitForSelector("#cloudBridgeCard .li");
  await page.$eval("#cloudBridgeCard", (el) => el.scrollIntoView({ block: "start" }));
  await sleep(200);
}
// 사람이 누르는 것처럼: 화면 가운데로 스크롤한 뒤 좌표 클릭(가려져 있으면 실패)
async function tap(page, sel) {
  await page.$eval(sel, (e) => e.scrollIntoView({ block: "center" }));
  await sleep(100);
  await page.click(sel);
}
const shot = (page, name) => page.screenshot({ path: join(OUT, name) });
const text = (page, sel) => page.$eval(sel, (e) => e.textContent);

try {
  console.log("== 프로필 A: 가상 기록, 기본 꺼짐 상태 ==");
  const ctxA = browser.defaultBrowserContext(); // 다운로드 동작은 기본 프로필에 설정
  const A = await openApp(ctxA);
  await A.evaluate((raw) => { localStorage.setItem("yakhyo_log_v1", raw); }, RAW);
  await A.reload({ waitUntil: "load" });
  await toSettings(A);
  ok((await text(A, "#cloudBridgeCard")).includes("켜고 로그인하면"), "카드에 저장 위치·범위 안내 표시");
  ok(!!(await A.$('#cloudBridgeCard a[href="privacy.html"]')), "카드에서 개인정보 처리방침 링크");
  ok((await text(A, '[data-i18n-html="guideText"]')).includes("기본적으로 이 기기 안에만"), "설정 '안내' 문구 갱신");
  ok(!(await A.evaluate(() => localStorage.getItem("yakhyo_cloud_enabled_v1"))), "기본 꺼짐");
  await shot(A, "01-settings-default-off.png");

  console.log("== 원문 백업 내보내기 → 프로필 B에서 복원 ==");
  await tap(A, "#cbRawExport");
  let file = null;
  for (let i = 0; i < 50 && !file; i++) { await sleep(100); file = readdirSync(DL).find((f) => f.endsWith(".json")); }
  ok(!!file, "Chrome 다운로드로 백업 파일 생성: " + file);
  const backupText = readFileSync(join(DL, file), "utf8");
  const b = JSON.parse(backupText);
  ok(b.raw === RAW && b.sha256 === sha(RAW) && b.byte_length === Buffer.byteLength(RAW), "백업 = 원문·SHA-256·바이트 수 일치");

  const ctxB = await browser.createBrowserContext(); // 별도 프로필(저장소 분리)
  const B = await openApp(ctxB);
  ok(!(await B.evaluate(() => localStorage.getItem("yakhyo_log_v1"))), "프로필 B는 비어 있음(분리 확인)");
  await B.evaluate(() => { try { closeSheet(); } catch (e) {} });
  await sleep(300);
  await toSettings(B);
  const corrupt = join(OUT, "corrupt.json");
  writeFileSync(corrupt, JSON.stringify({ ...b, raw: b.raw.replace("가상약", "변조약") }));
  const inputB = await B.$("#cbRawFile");
  await inputB.uploadFile(corrupt);
  await B.waitForFunction(() => document.getElementById("cbMsg").textContent.includes("(SHA256)"), { timeout: 5000 });
  ok(!(await B.evaluate(() => localStorage.getItem("yakhyo_log_v1"))), "손상 백업은 쓰기 전 차단(저장소 그대로)");
  await shot(B, "02-restore-corrupt-blocked.png");
  await (await B.$("#cbRawFile")).uploadFile(join(DL, file));
  await B.waitForNavigation({ waitUntil: "load", timeout: 8000 });
  const restored = await B.evaluate(() => localStorage.getItem("yakhyo_log_v1"));
  ok(Buffer.from(restored, "utf8").equals(Buffer.from(RAW, "utf8")), "복원 결과가 원본과 바이트 단위 일치");
  await B.evaluate(() => switchTab("log")); await sleep(300);
  ok((await text(B, "body")).includes("가상약 HBS"), "복원 후 기록 화면에 기록 표시");
  await shot(B, "03-restored-log.png");
  ok(B._errors.length === 0, "프로필 B 페이지 오류 0건 " + JSON.stringify(B._errors));

  console.log("== 클라우드 켜기·로그인·업로드 ==");
  await toSettings(A);
  await tap(A, "#cbToggle"); await A.waitForSelector("#cbEmail");
  await A.type("#cbEmail", `ch-u-${tag}@example.test`); await A.type("#cbPw", pw);
  await tap(A, "#cbLogin"); await A.waitForSelector("#cbPreview", { timeout: 8000 });
  ok((await A.evaluate(() => Object.keys(localStorage).filter((k) => /session|token/i.test(k)))).length === 0, "localStorage에 세션·토큰 없음");
  await A.$eval("#cbFrom", (e) => { e.value = "2026-11-20"; }); await A.$eval("#cbTo", (e) => { e.value = "2026-11-20"; });
  await tap(A, "#cbPreview"); await A.waitForSelector("#cbCntAdd", { timeout: 8000 });
  ok((await text(A, "#cbCntAdd")) === "4", "미리보기: 추가 가능 4");
  await A.$eval("#cbPreviewBox", (el) => el.scrollIntoView({ block: "start" })); await shot(A, "04-upload-preview.png");
  await tap(A, "#cbUpload");
  await A.waitForFunction(() => document.getElementById("cbMsg").textContent.includes("완료"), { timeout: 8000 });
  ok(sql(`select count(*) from public.diary_events where user_id='${uid}'`) === "4", "원격 4건 저장");
  ok(sql(`select count(*) from public.diary_events where user_id='${uid}' and payload::text like '%메모%'`) === "0", "메모 미전송");

  console.log("== 승인 화면 ==");
  const r1 = await rpc(agentTok, "create_pending_event", { p_request_id: `ch-${tag}-1`, p_kind: "state", p_occurred_at: "2026-11-20T09:00:00+09:00", p_source_tz: "Asia/Seoul", p_payload: { state: "off", output: 20 } });
  const r2 = await rpc(agentTok, "create_pending_event", { p_request_id: `ch-${tag}-2`, p_kind: "state", p_occurred_at: "2026-11-20T07:30:00+09:00", p_source_tz: "Asia/Seoul", p_payload: { state: "off", output: 15, trend: "stable" } });
  ok(r1.status === 200 && r2.status === 200, "에이전트 추가 요청 2건");
  await tap(A, "#cbPending");
  await A.waitForFunction(() => document.querySelectorAll(".cbApprove").length === 2, { timeout: 8000 });
  ok((await text(A, "#cbPendingBox")).includes("중복 후보"), "기존 기록과 같은 요청에 중복 후보 표시");
  await A.$eval("#cbPendingBox", (el) => el.scrollIntoView({ block: "start" })); await shot(A, "05-pending-approvals.png");
  const before = sql(`select count(*) from public.diary_events where user_id='${uid}'`);
  await A.evaluate(() => [...document.querySelectorAll("#cbPendingBox .li")].find((li) => li.textContent.includes("출력 20")).querySelector(".cbApprove").click());
  await A.waitForFunction(() => document.querySelectorAll(".cbApprove").length === 1, { timeout: 8000 });
  await tap(A, ".cbReject");
  await A.waitForFunction(() => document.getElementById("cbPendingBox").textContent.includes("대기 중인 요청이 없어요"), { timeout: 8000 });
  ok(sql(`select count(*) from public.diary_events where user_id='${uid}'`) === String(+before + 1), "승인 1건만 확정(거절분 제외)");
  await A.waitForFunction(() => JSON.parse(localStorage.getItem("yakhyo_log_v1")).events.some((e) => e.cloudId), { timeout: 8000 });
  const auto = await A.evaluate(() => JSON.parse(localStorage.getItem("yakhyo_log_v1")).events.filter((e) => e.cloudId));
  ok(auto.length === 1 && auto[0].output === 20, "승인하면 이 기기 기록에 바로 추가");
  await A.evaluate(() => CloudBridge.undoImport()); await A.reload({ waitUntil: "load" }); await toSettings(A);
  ok((await A.evaluate(() => localStorage.getItem("yakhyo_log_v1"))) === RAW, "승인 후 자동 추가도 되돌리기 가능");
  await A.$eval("#cbDay", (e) => { e.value = "2026-11-20"; }); await tap(A, "#cbRemote");
  await A.waitForFunction(() => document.getElementById("cbRemoteBox").textContent.includes("에이전트 요청 승인"), { timeout: 8000 });
  await A.$eval("#cbRemoteBox", (el) => el.scrollIntoView({ block: "start" })); await shot(A, "06-remote-read.png");

  console.log("== 서버 기록 가져오기 ==");
  await A.$eval("#cbImpFrom", (e) => { e.value = "2026-11-20"; }); await A.$eval("#cbImpTo", (e) => { e.value = "2026-11-20"; });
  await tap(A, "#cbImpPreview"); await A.waitForSelector("#cbImpCntAdd", { timeout: 8000 });
  ok((await text(A, "#cbImpCntAdd")) === "1" && (await text(A, "#cbImpCntAlready")) === "4", "가져오기 미리보기: 새로 1(승인분)·이미 있음 4(이 기기에서 올림)");
  await A.$eval("#cbImpBox", (el) => el.scrollIntoView({ block: "start" })); await shot(A, "08-import-preview.png");
  await tap(A, "#cbImpRun");
  await A.waitForFunction(() => JSON.parse(localStorage.getItem("yakhyo_log_v1")).events.some((e) => e.cloudId), { timeout: 8000 });
  const imp = await A.evaluate(() => JSON.parse(localStorage.getItem("yakhyo_log_v1")).events.filter((e) => e.cloudId));
  ok(imp.length === 1 && imp[0].state === "off" && imp[0].output === 20, "승인된 기록 1건이 기기 기록에 추가");
  await A.evaluate(() => switchTab("log")); await sleep(300);
  ok((await text(A, "body")).includes("09:00"), "기록 화면에 09:00 기록 표시");
  await shot(A, "09-imported-in-log.png");
  await A.evaluate(() => CloudBridge.undoImport()); await A.reload({ waitUntil: "load" }); await toSettings(A);
  ok((await A.evaluate(() => localStorage.getItem("yakhyo_log_v1"))) === RAW, "되돌리기 후 원문 복원");

  console.log("== 오프라인 ==");
  await A.setOfflineMode(true);
  await tap(A, "#cbRemote");
  await A.waitForFunction(() => document.getElementById("cbMsg").textContent.includes("연결할 수 없어요"), { timeout: 15000 });
  ok(true, "오프라인 안내 표시");
  await A.$eval("#cbMsg", (el) => el.scrollIntoView({ block: "center" })); await shot(A, "07-offline.png");
  await A.setOfflineMode(false);
  ok((await A.evaluate(() => localStorage.getItem("yakhyo_log_v1"))) === RAW, "전 과정에서 yakhyo_log_v1 원문 불변");
  ok(A._errors.length === 0, "프로필 A 페이지 오류 0건 " + JSON.stringify(A._errors));
} catch (e) {
  fail++; console.error("CHECK ERROR:", e.message);
} finally {
  await browser.close(); server.close();
}
console.log(`\nRESULT: ${pass} passed, ${fail} failed  (screenshots: ${OUT})`);
process.exit(fail ? 1 : 0);
