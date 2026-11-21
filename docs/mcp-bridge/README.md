# 약효일지 MCP 브리지 (B단계)

에이전트(첫 대상: Claude Code)가 약효일지 기록의 **추가를 요청**하고, 사용자에게 공유된 **확정 기록을 조회**하며,
**주간 ON/OFF 관찰 요약**을 받을 수 있게 하는 시험 기능이다. 추가 요청은 사용자가 브라우저에서 승인할 때만 확정된다.

```
Claude Code ──(Bearer: 에이전트 단기 토큰, headersHelper)──▶ Cloudflare Worker /mcp ──(같은 토큰, RLS)──▶ Supabase Data API
                                                                                                              ▲
약효일지 Pages(브라우저) ── 로그인·업로드 미리보기·승인·원격 읽기 ─────────────────────────────────────────────┘
        └ 로컬 원본 yakhyo_log_v1 (그대로, 읽기 전용 — 원문 백업 복구만 예외)
```

## 구성 요소

| 경로 | 내용 |
|---|---|
| `supabase/migrations/20261122000000_diary_bridge.sql` | 테이블 4개(`diary_events`, `diary_agent_links`, `diary_pending_events`, `diary_import_requests`), RLS, 트리거, RPC. SECURITY DEFINER 없음 |
| `supabase/migrations/20261122000100_diary_import_preview.sql` | 업로드 미리보기 RPC(쓰기 없음) |
| `supabase/tests/diary_bridge.test.sql` | pgTAP 40건 (`supabase test db`) |
| `supabase/tests-api/data-api.test.mjs` | 실제 Auth 토큰 + Data API로 권한 수용기준 11건 |
| `workers/mcp/` | MCP Worker. SDK `@modelcontextprotocol/sdk@1.32.2` 고정, 잠금 파일 커밋 |
| `workers/mcp/bin/diary-mcp-login.mjs`, `diary-mcp-headers.mjs` | 단기 토큰 발급·저장(0600) / Claude Code `headersHelper` |
| `cloud-bridge.js`, `cloud-config.js` | Pages 연동(기본 비활성). 공개 설정에는 URL과 publishable key만 |
| `tools/local-stack/` | Docker 없이 PostgreSQL+pgTAP+Supabase Auth(GoTrue)+PostgREST로 돌리는 로컬 시험 스택 |

## 권한 모델

- 사용자: 본인 확정 기록 조회·추가(가져오기 RPC), 본인 앞으로 온 요청 승인·거절, 본인 에이전트 연결 폐기.
- 에이전트: 연결된 사용자 **1명**의 확정 기록 조회(`read`), 자기 추가 요청 생성(`request_write`). 확정 기록 직접 삽입·수정·삭제, 요청 승인, 연결 변경 불가.
- 사용자 식별자는 `auth.uid()`와 `diary_agent_links`에서만 결정. payload·요청 인자의 `user_id`/`owner_id`는 무시되거나 거부된다.
- 연결 생성은 관리자(SQL 편집기)만. 연결 폐기·만료는 RLS가 호출마다 확인하므로 기존 토큰도 즉시 차단된다.
- 승인 함수는 `SELECT … FOR UPDATE`로 잠그고 이벤트 삽입과 상태 변경을 한 트랜잭션에서 한다. 재승인은 같은 이벤트 ID.

## MCP 도구

| 도구 | 입력 | 결과 |
|---|---|---|
| `add_medication` | `request_id`, `occurred_at`(오프셋 포함 RFC 3339), `drug`, `dose_mg?` | `pending_id`, `status:"pending"` |
| `add_state` | `request_id`, `occurred_at`, `state`(wake/off/rising/on/falling), `output?`, `trend?`, `gait?`, `dysk?`, `symptoms?` | 〃 |
| `add_life_event` | `request_id`, `occurred_at`, `kind`, 유형별 목록 값 | 〃 |
| `get_daily_log` | `date`, `cursor?`, `page_size?`(기본 50, 최대 100) | `(occurred_at, id)` 순 확정 기록 + `next_cursor` |
| `get_weekly_summary` | `start_date` | 7일(서울 자정 기준) 집계 |

허용 외 필드(자유 메모 포함)는 거부한다(`additionalProperties:false`). 같은 `request_id`+같은 정규화 내용 재전송은 기존 결과,
다른 내용은 `CONFLICT`. 수정·삭제·SQL 도구는 없다.

### 주간 집계 규칙
- 연속 상태 관측 사이만 상태 구간. 간격 > 120분(결과 `settings.max_observation_gap_min`에 명시)이거나 마지막 관측 이후는 미관찰.
- 같은 시각에 다른 범주의 상태가 있으면 그 시각을 제외하고 `conflicting_timestamps`에 표시.
- 완료 ON 표본: `OFF →(상승 전환기)→ ON →(ON/하강 전환기)→ OFF`가 끊김 없이 관측된 경우만. 라벨 **관찰된 ON 지속시간**.
- 복약→ON: 같은 시각 복약은 1회로 묶고, 다음 복약 전에 OFF→ON 전환이 확인될 때만. 미완결 사유를 집계.
- 예: 07:00 복약, 07:30 OFF, 08:00 ON, 09:00 OFF → 복약→ON 60분, 완료 ON 60분. 09:00을 지우면 ON 표본 제외.
- 조회 상한 1,000행(`truncated`로 명시). 약효·용량을 판단하지 않는다.

## 로컬 검증

```bash
npm install                                   # 루트(jsdom)
npm --prefix workers/mcp ci
tools/local-stack/verify-all.sh               # 스택 초기화부터 전체 시험까지
```
Docker가 되는 환경이면 `supabase start && supabase db reset --local && supabase test db`도 같은 마이그레이션·테스트를 쓴다.
로컬 스택 비밀번호·키는 `/tmp/yakhyo-mcp-local`에만 생기고 저장소에 쓰지 않는다.

실제 Chrome 화면 확인(원문 백업·복원, 승인 화면, 오프라인; 스크린샷 저장):
```bash
npm i --prefix /tmp/pp puppeteer-core
NODE_PATH=/tmp/pp/node_modules CHROME_PATH=/usr/bin/google-chrome node tools/local-stack/chrome-check.mjs
```

## 시험 배포 (저장소 소유자 승인 후에만)

1. **Supabase**: 시험 전용 Free 프로젝트. Auth 설정에서 공개 가입·익명 로그인 끄기, JWT **비대칭 서명 키(ECC/RSA)** 사용(Worker는 JWKS로 검증하며 공유 HS256 비밀을 받지 않는다).
   ```bash
   supabase login
   supabase link --project-ref "$SUPABASE_STAGING_REF"   # 시험 ref인지 다시 확인
   supabase db push --dry-run && supabase db push
   ```
   계정은 대시보드에서 관리자가 만든다(사용자 1, 에이전트 1 — 자격증명 공유 금지). 연결 생성(SQL 편집기):
   ```sql
   insert into public.diary_agent_links (agent_id, owner_id, expires_at)
   values ('<agent uuid>', '<user uuid>', now() + interval '14 days');
   ```
2. **Worker**: `workers/mcp/wrangler.toml`의 `[env.staging.vars]`에 시험 URL·publishable key·허용 Origin을 넣는다(비밀 아님).
   ```bash
   cd workers/mcp
   npx wrangler whoami
   npx wrangler deploy --env staging --dry-run && npx wrangler deploy --env staging
   npx wrangler deployments list --env staging
   ```
3. **Claude Code** (저장소 루트):
   ```bash
   node workers/mcp/bin/diary-mcp-login.mjs --mcp-url "$MCP_STAGING_URL" --supabase-url "$SUPABASE_URL" --publishable-key "$SUPABASE_PUBLISHABLE_KEY"
   claude mcp add-json --scope local diary-staging \
     "{\"type\":\"http\",\"url\":\"${MCP_STAGING_URL}\",\"headersHelper\":\"node $(pwd)/workers/mcp/bin/diary-mcp-headers.mjs\"}"
   claude mcp list
   ```
   `headersHelper`는 `CLAUDE_CODE_MCP_SERVER_URL`이 저장된 URL과 같고 토큰이 미만료일 때만 `Authorization`을 낸다.
   토큰은 셸 이력·명령줄 인자에 남지 않는다. 시험 후 `node workers/mcp/bin/diary-mcp-login.mjs --revoke`.
4. **Pages 시험 화면**: `cloud-config.js`에 시험 URL·publishable key를 넣은 빌드는 **운영 Pages가 아닌 곳**에서만 연다(운영 게시는 별도 승인).
   Supabase Auth의 Site URL/CORS 허용 출처에 시험 화면 출처를 등록한다.

### 비용 가드 (월 0원 목표)
Supabase Free(DB 500 MB, 비캐시·캐시 전송 각 5 GB, 비활성 시 일시중지), Workers Free(일 100,000 요청, 요청당 CPU 10 ms),
GitHub Pages(사이트 1 GB, 월 100 GB 소프트 한도). Worker 본문 16 KiB 상한, 주간 집계는 상태값만 1,000행까지 조회
(로컬 측정: 1,000행 처리 약 2~5 ms). 70% 도달 시 시험 호출을 줄인다. 유료 플랜·SMTP·유료 AI API 비활성.

## 장애 대응·복구
- 브라우저: 설정 → 클라우드 연동 **끄기**(로컬 기능은 영향 없음). 연결 화면에서 **연결 폐기**.
- Worker: `npx wrangler deployments list --env staging`으로 직전 정상 버전 확인 → `npx wrangler rollback <VERSION_ID> --env staging`.
- DB: 테이블 삭제 대신 호환 가능한 후속 마이그레이션. 백업 복원은 별도 시험 프로젝트에서 먼저.
- 로컬 원본: 설정 → **원문 백업(복구용)**. 복구는 바이트 수·SHA-256 검증을 통과해야만 쓴다.
