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
- 실제 브라우저(크롬) 화면 렌더링은 jsdom으로만 확인. 시험 화면 공개 전에 눈으로 확인 필요.
- 설정 화면 "안내" 문구("모든 기록은 이 기기 안에만 저장되며…")와 개인정보처리방침은 클라우드 기능을 켜면 사실과 달라진다. 기능은 기본 꺼짐이고 카드에 전송 범위를 명시했지만, **운영 게시 전 문구·방침 갱신 필요**.
- 기존 이벤트의 `dose`는 mg로 간주한다(앱 화면 표기 기준). 단위가 섞인 문자열은 변환 불가로 남긴다.

## 5. 게시·이전 상태

- 운영 Pages 게시: **하지 않음**
- 실제 기록 원격 이전: **하지 않음**
- 커밋 위치: `feature/mcp-bridge`만
