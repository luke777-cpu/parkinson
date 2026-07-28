# 약효 비교 테스트 (독립 프로토타입)

처방 변경 전후의 약효와 부작용을 같은 방식으로 기록하여 비교하는 단독 실행 도구.
WORK_ORDER_MEDICATION_RESPONSE_CHALLENGE_v1 기반. **약효일지 본체와 완전 분리**되어 있다.

- 실행: `https://luke777-cpu.github.io/parkinson/challenge/`
- 저장: localStorage `medicationChallengeDbV1` (본체 키와 다름 — 데이터가 섞이지 않음)
- 캐시: 서비스워커 `medication-challenge-v1` (본체 yakhyo-* 캐시와 분리)
- 파일: index.html(화면) · challenge-engine.js(계산) · challenge-report.js(문장·인쇄 텍스트) · challenge.css · manifest.json · sw.js · tests/

## 흐름
시작 → 테스트 종류·약·주증상(1~3) 입력 → 복용 전 기록 → "지금 복용했어요" → 30·60·90·120분 기록(건너뛰기 가능, 실제 시각 병행 저장) → 최종 평가 → 결과·그래프 → 두 시험 비교.

## 안전 원칙
증량·감량·추가 권고 없음 / 진단·레보도파 반응 판정·치료 성패 판정 없음 / 모든 주요 화면·결과에 면책 문구 / 심한 부작용 선택 시 중단 안내.
자동 분석은 평균·차이·최솟값 등 단순 계산만 수행하며, 엔진에 금지 표현 자체 점검(CHG.checkSafety)이 포함되어 있다.

## 제외 (첫 버전)
LEDD 계산 · 혈중농도 시뮬레이션 · AI 해석 · 의약품 자동 검색 · 본체 자동 연동 · 클라우드/계정.

## 테스트
저장소 루트에서: `node challenge/tests/challenge.test.js` (엔진 단위 + jsdom 통합 37건)
