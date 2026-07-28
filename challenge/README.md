# 약효 비교 테스트 v2 (Medication Challenge v2)

약효일지 본체와 완전히 분리된 독립형 약효 비교 도구.
내 복용약을 등록하고, 기준 시험과 처방 변경 후 시험을 같은 방식으로 기록해
예상 약효곡선과 실제 증상 변화를 비교한다.

## 파일 구성
- `index.html` — 전체 화면(약 관리 / 시험 마법사 / 시점 기록 / 결과 / 비교 / 백업)
- `challenge-engine.js` — 데이터 구조·분석·비교·안전검사·v1 마이그레이션 (순수 계산)
- `challenge-sim.js` — 예상곡선 모듈 (본체 SIM 로직의 독립 사본, 본체 무수정)
- `challenge-timer.js` — 30·60·90·120분 타이머·알림 (네이티브 교체 가능하도록 분리)
- `challenge-report.js` — 허용 해석 문장·보고서 텍스트
- `challenge.css`, `manifest.json`, `sw.js`, `icon-192.png`, `icon-512.png` — PWA (캐시 `medication-challenge-v2`)
- `tests/challenge.test.js` — 자동 테스트 79건

## 저장 키 (본체와 완전 분리)
- `medicationChallengeDbV2` — 시험 기록
- `medicationChallengeMedicationListV2` — 내 복용약 목록
- `medicationChallengeDbV1` — v1 원본 (마이그레이션 후에도 보존)
- `medicationChallengeDbV1Backup` — 마이그레이션 시 자동 백업 사본

## v1 → v2 마이그레이션
첫 실행 시 v1 데이터를 감지하면 백업 사본을 만든 뒤 자동 변환한다.
v1 증상은 운동 증상으로 분류되고, 부작용 심각도(가벼움/중간/심함)는 1/2/4점으로,
체감(모르겠다/조금/분명함)은 0/1/3점으로 옮겨진다. 원본 v1 키는 삭제하지 않는다.

## 테스트
```bash
cd challenge
npm install
npm test
```

## 안전 원칙
- 약물 변경 권고·진단·레보도파 반응 판정·ON/OFF 확정을 하지 않는다 (`checkSafety()`로 자동 검사).
- 예상곡선은 상대적 작용시간 모델이며 혈중농도·개인 반응 예측이 아니다.
- 실제 약 변경 시험은 의료진과 상의한 처방만 기록하도록 안내한다.
