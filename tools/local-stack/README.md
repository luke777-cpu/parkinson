# 로컬 시험 스택 (Docker 없이)

컨테이너 레지스트리에 접근할 수 없는 환경에서 Supabase와 같은 구성으로 DB·권한을 실제 시험하기 위한 도구.
**로컬 전용**이며 원격 프로젝트에 절대 쓰지 않는다. Docker가 되면 `supabase start`를 쓴다.

| 구성 | 포트 | 비고 |
|---|---|---|
| PostgreSQL 16 + pgTAP | 54322 | `bootstrap.sql`이 anon/authenticated/service_role/authenticator/supabase_auth_admin 역할과 Supabase 기본 권한을 재현 |
| Supabase Auth (GoTrue v2.182.1 바이너리) | 54331 | ES256 비대칭 서명 키, 공개 가입·익명 로그인 끔 |
| PostgREST v12.2.3 | 54330 | JWKS로 토큰 검증, `db-schemas=public` |
| 게이트웨이 `gateway.mjs` | 54321 | `/auth/v1`, `/rest/v1`, apikey 검사 흉내, 127.0.0.1 바인딩 |

```bash
tools/local-stack/start.sh [--reset]    # 시작(마이그레이션 적용 포함)
node tools/local-stack/seed.mjs         # 가상 사용자 A·B + 에이전트 A·B, 연결 생성
tools/local-stack/run-pgtap.sh          # pgTAP
tools/local-stack/verify-all.sh         # 전체 검증
tools/local-stack/stop.sh
```
키·비밀번호·데이터는 `LOCAL_STACK_DIR`(기본 `/tmp/yakhyo-mcp-local`, 권한 700)에만 있다.
차이점: Supabase 운영은 PostgreSQL 17이고 Kong 게이트웨이를 쓴다. 정책·함수는 둘 다에서 같은 SQL이다.
