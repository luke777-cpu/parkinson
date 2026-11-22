# 작업 기록·검증 보고서 — feature/mcp-bridge (B단계)

작성: 2026-11-22 (Asia/Seoul). 모든 시험은 처음부터 만든 가상 데이터만 사용했다. 실제 기록·백업은 가져오지 않았다.

## 1. 기준선

| 항목 | 확인 내용 |
|---|---|
| 기준 커밋 | `main` = `f74201b4c1e52de663ee7e76b6c18e7c13fdb2bd` (2026-09-16, "Fix P1 v1.1.1 duplicate medication…") |
| 저장소 | 공개, 기본 브랜치 `main`, `has_pages=true`, `.github/workflows` 없음 → 브랜치 게시 방식으로 추정. **Pages 원본 브랜치·경로 설정은 미확인**(작업 환경의 GitHub API 프록시가 `/pages` 경로를 막음). 기능 브랜치 푸시는 Actions가 없으므로 배포를 일으키지 않는 것으로 판단 |
| 로컬 저장 | `localStorage["yakhyo_log_v1"]` 단일 JSON. `events[]`, `meds[]`, `questions[]`, `settings{}`, `outputChecks[]`, `dayMemos{}`, `phs{}`, `primarySymptoms[]`, `medSets[]` 등 |
| 이벤트 공통 | `id`(=`uid()`: base36 시각+4자, 문자열), `type`, `ts`(epoch **밀리초**) |
| 유형별 | `med`: `drug`, `dose`(숫자 mg 또는 null; 과거 문자열 가능), `memo`, `fromSet`… / `state`: `state`(wake·off·rising·on·falling + 과거용 signal·partial·dysk·dyst·wearoff), `output`(0~100), `trend`, `gait`(0~10), `dysk`(0~10), `symptoms[]`, `customSymptom`, `memo`… / `life`: `kind`(sleep·meal·exercise·bowel·body), `phase`, `mealType`, `amount`, `extras[]`, `quality[]`, `exType`(+`exTypeCustom`), `intensity`, `durationMin`, `consistency`, `symptoms[]`(body), `memo`… / 그 외 `tempnote`, `challenge`(브리지 범위 밖) |
| 생성·삭제·가져오기 경로 | `addState`/`addMed`/`addMedSet`/`addLife`/`delEvent` → `save()`가 키 전체를 다시 씀. 기존 내보내기는 `JSON.stringify(db,null,2)`(재직렬화) → 원문 복구용으로는 부족해 별도 원문 백업 추가. 가져오기는 덮어쓰기 |
| 서비스 워커 | `sw.js` 캐시 `yakhyo-v2163-p1-isolation`, 앱 셸 사전 캐시 + 정적 자원 stale-while-revalidate. **변경 전에는 교차 출처 `cors` 응답도 캐시**하던 구조 → 원격 기록이 캐시될 위험이 있어 이번에 차단 |
| 테스트 명령 | `npm test` = phs-engine + phs-integration. 저장소에 등록된 `tests/*.test.js` 5개 전부 변경 전 통과: backup-export 18, pdf-export 36, phs-engine 49, phs-integration 61, sw-cache 27 (알려진 실패 없음. 이전 메모의 phs-integration 실패는 이미 해소돼 있었음). 루트는 잠금 파일을 커밋하지 않는 관행(`.gitignore`) → `npm install` |
| p1-lab | 같은 저장소 `p1-lab/`(서빙: `/parkinson/p1-lab/`), 자체 SW·localStorage. 백업 JSON `schema:'p1-lab', version:1, events[], forecasts[], schedule[], baseline[]`. 약효일지 키를 읽거나 쓰지 않음. C단계에서 다룸 |

## 2. 변경 요약

- **DB**: `supabase/migrations/` 2개(추가 전용), pgTAP, Data API 시험. 공개 가입 끔·비밀번호 12자 이상(`supabase/config.toml`).
- **Worker**: `workers/mcp/` — 무상태 Streamable HTTP(JSON 응답), POST만, Origin 허용 목록, 본문 16 KiB, 프로토콜 버전 검사, JWKS 기반 토큰 검증, 호출마다 연결 확인, 로그 없음(`observability` 끔).
- **Pages**: `cloud-bridge.js`/`cloud-config.js`(공개 설정 비어 있음 → 기본 꺼짐), 설정 화면에 카드 추가, `sw.js` 캐시 이름 `yakhyo-v2163-mcpbridge-b1`, 교차 출처·`/auth/v1/`·`/rest/v1/` 제외. 기존 앱 코드(`index.html` 스크립트 본문)는 바꾸지 않고 카드 자리와 스크립트 태그 2개만 추가.
- 운영 브랜치·배포 변경 없음.

## 3. 검증 결과 (`tools/local-stack/verify-all.sh`, 스택 초기화부터)

| 단계 | 결과 |
|---|---|
| pgTAP (`supabase/tests/diary_bridge.test.sql`) | 40/40 통과 |
| Data API 권한 (`supabase/tests-api/data-api.test.mjs`) | 11/11 통과 — 미인증, 타인 조회(빈 결과 + 관리자 문맥으로 행 존재 확인), 타인 소유 삽입, 소유자 변경, 에이전트 직접 확정·수정·삭제·승인·연결 변경, `owner_id` 위조, 동시 승인 2건→확정 1행, 동시 재전송 4건→대기 1건, 변경 본문 재전송 409, 거절, 폐기 직후 기존 토큰 차단, 만료 연결 차단, 중복 후보 |
| Worker 타입 검사 | 통과 (`tsc --noEmit`) |
| Worker 단위·계약 | 35/35 — 설계도 예시(복약→ON 60, 완료 ON 60, 09:00 제거 시 제외), 후속 복약, 같은 시각 복약 묶음, 120분 공백, 경계 관측 부족, 이미 ON, 상충 상태, 전환기 경유, 서울 자정 경계, 중앙값, 토큰 8종 거부, 연결 없음 403, 405/403/400/413, `tools/list`(5개, 추가 필드 금지), 허용 외 필드(메모·user_id·owner_id) 거부, 단위 추정 없음, CONFLICT, 429 재시도, 커서, 조회 상한 표시, headersHelper 조건 |
| Worker 통합 (실제 workerd `wrangler dev` + 로컬 Supabase + SDK 클라이언트) | 3/3 — **추가 요청 5건 → 거절 1건 → 승인 → 날짜 조회(3페이지 커서 일치, 인접 날짜 0건) → 주간 집계(60/60) → 연결 폐기 → 403** |
| 실제 Claude Code (2.1.330, `claude mcp add-json --scope local` + `headersHelper`) | `claude mcp list` / `claude mcp get`: **√ Connected** (initialize 성공). 연결 폐기 후: **× Failed to connect — HTTP 403 "no active agent link"**. 다른 URL로 헬퍼 호출 시 토큰 미출력(종료 코드 1). 시험 후 `--revoke`로 토큰 파일 삭제 |
| 기존 Pages 시험 | backup-export 18, pdf-export 36, phs-engine 49, phs-integration 61, sw-cache 27 — 전부 변경 전과 동일 통과 |
| 브리지 단위 (`tests/cloud-bridge.test.js`) | 56/56 — 기본 비활성·네트워크 0건, **원문 백업 → 분리된 프로필 복구 바이트 일치**, 손상 5종+형식 오류 차단 시 원본 불변, 변환 규칙, ID 중복=충돌, ID 없음→확인 후 별도 목록의 안정 ID, 원본 키 불변, 오프라인 로그인 실패 시 로컬 기록·알림 설정 정상, localStorage에 토큰 없음, SW 제외 규칙 |
| 값 목록 동기화 (`tests/bridge-schema-sync.test.js`) | 50/50 — SQL·Worker·브라우저·앱 원본 상수 일치 |
| 브라우저 통합 (`tests/cloud-bridge.integration.test.js`, 실제 로컬 Supabase) | 38/38 — 미리보기 151건, 2배치 중 2번째 네트워크 끊김 → **같은 요청 키로 재개** → 151행(중복 0), 메모 미전송, 재전송 "이미 등록", 로컬 수정분 "충돌"(원격 불변), 에이전트 요청 승인/거절·중복 후보 표시, 원격 읽기 영역 분리, 오프라인 로컬 기록, 연결 폐기 즉시 반영, 로그아웃, **전 과정 `yakhyo_log_v1` 원문 불변** |

검증 중 발견해 고친 결함: 업로드 재개 로직에서 뒤 배치 실패가 앞 배치까지 "오류"로 덮어쓰던 문제(Promise 체인의 catch 위치) — 통합 시험이 잡아 수정.

성능(노드 측정, 참고): `get_weekly_summary` 요청 처리 1,000행 약 2~5 ms(상태값만 조회하도록 축소 후). Worker 번들 gzip 261 KiB.

## 4. 미확인·남은 일

- **원격 시험 배포 미실시**: 시험용 Supabase/Cloudflare 계정·승인이 없어 `supabase db push`, `wrangler deploy`, 실제 무료 플랜 화면 확인, 사용량 기록은 하지 않았다. 따라서 수용기준 5장의 "무료 플랜 화면 확인·시험 Worker 배포 버전·원격 마이그레이션 버전"은 **미충족**.
- Claude Code에서 모델 세션으로 도구를 실제 호출하는 것과 `/mcp` 화면 확인은 이 환경(모델 인증 없음)에서 못 했다. 같은 Worker에 대해 SDK 클라이언트로 `tools/list`·`tools/call` 전 흐름을 검증했고, Claude Code로는 연결(initialize)·차단까지 확인했다.
- Pages 원본 브랜치·경로 설정(관리자 API) 미확인.
- 로컬 스택은 PostgreSQL 16(운영 Supabase는 17), Kong 대신 간이 게이트웨이. SQL·정책은 동일하지만 `supabase start`/`supabase test db`로 한 번 더 돌려볼 것.
- 개인정보 처리방침 문안은 법률 검토를 거치지 않았다(저장 지역은 서울로 기입 완료).
- 시험 단계에는 사용자가 앱에서 원격 기록을 지우는 기능이 없다(방침에 운영자 이메일 삭제 요청으로 명시).
- 기존 이벤트의 `dose`는 mg로 간주한다(앱 화면 표기 기준). 단위가 섞인 문자열은 변환 불가로 남긴다.

## 5. 게시·이전 상태

- 운영 Pages 게시: **하지 않음**
- 실제 기록 원격 이전: **하지 않음**
- 커밋 위치: `feature/mcp-bridge`만

## 6. 2차 작업 (2026-11-22) — 안내 문구·방침 반영, 실제 Chrome 확인

- 설정 화면 "안내"(한/영): "기본은 기기 안 저장, 클라우드 연동을 직접 켜고 로그인한 경우에만 고른 기록이 시험 서버(Supabase)에 저장, 메모·약 목록·알림·설정은 안 보냄"으로 변경.
- 클라우드 카드: 저장 위치(Supabase), 자동 전송 없음, 연결한 AI 에이전트가 읽고 추가 요청할 수 있음(확정은 승인 시)을 명시하고 처리방침 링크 추가.
- `privacy.html`: 기본 원칙(기기 안 저장)은 유지하고 "클라우드 연동(시험) — 선택 기능" 항목 신설 — 저장 항목, 보내지 않는 항목, 목적, 처리 위탁(Supabase·Cloudflare), 국외 이전, 접근 권한, 보관·삭제(이메일 요청), 이용 중단.
- 실제 Chrome 확인(`tools/local-stack/chrome-check.mjs`, Chrome for Testing 153, headless, 로컬 Supabase): **21/21 통과**
  - 실제 다운로드로 원문 백업 생성 → 원문·SHA-256·바이트 수 일치
  - 별도 브라우저 프로필에서 손상 백업 차단(저장소 그대로) → 정상 백업 복원 → 바이트 단위 일치 → 기록 화면 표시
  - 켜기·로그인 → 미리보기 4건 → 업로드(메모 미전송) → 에이전트 요청 2건 중 중복 후보 표시 → 1건 승인·1건 거절 → 원격 읽기 영역 → 오프라인 안내 → `yakhyo_log_v1` 원문 불변, 페이지 오류 0건
- 화면 확인 중 고친 것: 목록에 내부 코드("state · off", "life · meal")가 그대로 보이던 것을 앱 기존 이름표(상태 · OFF, 생활 · 식사 · 점심)로 바꿈. 결과 안내가 카드 아래 작은 글씨에만 나오던 것을 앱 토스트로도 표시(토스트에는 첫 문장만). 오프라인 안내 문장을 한 줄에 들어가게 줄임.
- 재검증: 기존 5종 + 브리지 단위 56 + 브라우저 통합 38 + 값 동기화 50 전부 통과. SW 캐시 `yakhyo-v2163-mcpbridge-b2`.

## 7. 원격 시험 DB (2026-11-22)

- 사용자 승인 후 Supabase 커넥터로 시험 전용 Free 프로젝트 생성: `yakhyo-mcp-staging`, ref `hvfqujnazjlofjcxbeft`, 서울 `ap-northeast-2`, PostgreSQL 17.12. 기존 `luke777-cpu's Project`(토토의 집·가족 사이트 테이블)는 건드리지 않음.
- 마이그레이션 2개 적용(`diary_bridge`, `diary_import_preview`) — 커넥터의 `apply_migration`이 원격 기록 버전을 적용 시각으로 붙이므로, 이후 CLI `supabase db push`를 쓰면 `supabase migration repair`로 로컬 파일 버전(20261122000000, 20261122000100)과 맞춰야 한다.
- 원격 점검(읽기 전용 SQL): RLS 4/4 활성, 정책 9개, SECURITY DEFINER 0, anon 테이블·함수 권한 0, authenticated의 확정 기록 UPDATE/DELETE·연결 INSERT 권한 없음. 보안 advisor 경고 0건.
- 이 작업 환경에서는 `*.supabase.co`로 나가는 연결이 프록시에서 막혀 Auth 설정(가입 차단·익명 로그인)과 JWT 서명 키 종류는 확인하지 못함 → 대시보드에서 확인 필요.
- `workers/mcp/wrangler.toml` staging에 프로젝트 URL·publishable key(공개 값) 기입. `cloud-config.js`는 비워 둠(운영 Pages 영향 없음).
- 대시보드 확인(사용자): JWT 현재 서명 키 ECC (P-256), 이전 HS256 키는 남겨 둠(미폐기).
- 계정: 사용자가 대시보드에서 사용자 1·에이전트 1 생성(이메일 확인 완료). 관리자 SQL로 에이전트→사용자 연결 생성(범위 read·request_write, 14일 만료). 역할 시뮬레이션(롤백) 결과: 에이전트는 유효 연결 1·소유자 일치, 사용자는 에이전트 아님·자기 연결 1건 조회.
- 대시보드 확인(사용자): 익명 로그인 꺼짐 확인·저장.
- 수정: workers/mcp/package-lock.json이 package.json과 어긋나 `npm ci`가 실패하던 문제(배포 묶음 점검에서 발견) — 잠금 파일 재생성, verify-all.sh에 `npm ci` 단계 추가.

## 8. 시험 Worker 배포 (2026-11-22)

- 사용자 PC(Windows)에서 배포 묶음 `deploy-staging.cmd`로 `wrangler deploy --env staging` 실행. 이 작업 환경은 Cloudflare 접속이 막혀 있어 직접 배포 불가.
  - 겪은 문제: ①`wrangler whoami`가 미로그인이어도 종료 코드 0 → 로그인 단계를 건너뜀(스크립트 수정) ②사용자 환경이 비대화식으로 판정돼 OAuth 로그인 불가 → API 토큰("Edit Cloudflare Workers" 템플릿, 7일 만료)을 창에서 숨김 입력하는 방식으로 전환 ③Cloudflare 계정 이메일 미인증 시 토큰 생성 실패 → 인증 후 해결 ④첫 배포 시 workers.dev 하위 도메인 등록(`luke777-cpu`).
- 배포 주소: `https://yakhyo-mcp-staging.luke777-cpu.workers.dev` — 사용자 PC 브라우저에서 `/healthz` → `{"ok":true}` 확인.
- 최종 검증용 묶음(로컬 앱 사본 + Claude Code 연결 스크립트) 전달. 로컬 사본은 file:// 에서 보안 문맥·crypto.subtle·클라우드 카드 설정 정상 확인.
- 수정: Windows에서 headersHelper가 아무것도 출력하지 않던 문제 — 직접 실행 판별이 `import.meta.url === file://${argv[1]}`라 Windows 경로(C:\ vs file:///C:/)에서 항상 거짓. realpath 비교로 수정하고 실패 이유를 토큰 파일 옆 helper.log에 기록(토큰 미기록). 사용자 Windows PC의 Claude Code 디버그 로그("did not return a valid value")로 발견.
- 수정: 추가 요청 결과 안내 문구가 상태와 무관하게 '승인 대기'로 고정 → 상태별(pending/approved/rejected/expired) 문구. 사용자 PC Claude Code 검증 중 발견. 다음 Worker 배포 때 반영.

## 9. 최종 검증 — 실제 Claude Code(Windows) + 시험 Worker + 시험 Supabase (2026-11-22)

사용자 PC의 Claude Code 2.1.330(Windows, 모델 세션)에서 가상 기록 1건으로 진행. 서버 상태는 Supabase에서 읽기 전용 SQL로 대조.

| 단계 | 결과 |
|---|---|
| add_medication(verify-0001, 가상약 100mg, 07:00 KST) | pending 1건 생성, 소유자=사용자 계정·요청자=에이전트 계정 |
| 같은 키·같은 내용 재전송 | 같은 pending_id, created=false, 대기 요청 1건 유지 |
| 같은 키·200mg | CONFLICT, 요청 미생성 |
| 승인 전 get_daily_log | 0건 |
| 시험 앱 사본(file://)에서 사용자 계정 로그인 → 승인 | 12:25 승인, 확정 1건(agent_request) |
| 승인 후 get_daily_log | 1건 |
| 승인 후 재전송 | status=approved, created=false, 확정 1건 유지 |
| 앱에서 연결 폐기(13:27:09) → 유효 토큰(14:14 만료)으로 조회 | "rejected the credential from its headersHelper" — 접근 차단 |

검증 중 발견·수정: Windows headersHelper 무출력 버그, 한글 경로 등록 깨짐(영문 경로로 우회), 상태와 무관한 안내 문구. 운영상 메모: 에이전트 토큰 1시간 만료로 재로그인이 잦음(C단계 전 정책 결정 필요), 앱에 에이전트 계정으로 로그인해도 막히긴 하나 안내 문구 없음.
