# 약효일지 배포 체크리스트

## 올릴 파일 구조

```text
/
  index.html
  manifest.json
  sw.js
  privacy.html
  icon-192.png
  icon-192-maskable.png
  icon-512.png
  icon-512-maskable.png
  assetlinks.json                 # 보관용 원본
  .well-known/
    assetlinks.json               # Android 연결에 실제 사용
  engines/
  demo/
  tests/
  scripts/
  css/
    output-engine.css
  js/
    output-engine.js
    output-storage.js
    output-chart.js
    clinical-event-adapter.js
    quick-event-engine.js
    quick-event-storage.js
    output-ui.js
    output-ui.bundle.js             # 브라우저가 실제 실행하는 단일 번들
```

## 배포 전 반드시 할 일

- [ ] `assetlinks.json` 두 곳의 `REPLACE_WITH_PLAY_APP_SIGNING_SHA256_FINGERPRINT`를 Play 앱 서명 인증서의 실제 SHA-256 지문으로 교체한다.
- [ ] 공개 주소에서 `https://도메인/.well-known/assetlinks.json`이 로그인이나 리디렉션 없이 열리는지 확인한다.
- [ ] Android 패키지 이름이 `kr.parkinson.medicationdiary`인지 확인한다.
- [ ] `node scripts/validate-project.js`가 오류 없이 끝나는지 확인한다.
- [ ] `npm run check`에서 자동 테스트 42개와 정적 프로젝트 검증이 모두 통과하는지 확인한다.
- [ ] 기존 사용자는 업데이트 전 백업 JSON을 한 번 내보낸다.
- [ ] 업데이트 뒤 앱을 완전히 닫았다 다시 열어 화면 하단 버전이 `0.12.1`인지 확인한다.
- [ ] 오늘 화면 첫 번째 카드가 `현재 출력`과 큰 `-10/+10` 버튼인지 확인한다.
- [ ] 낮은 출력·상승·높은 출력 안정·하강 구간 메모가 기본적으로 닫힌 `상세 기록` 안에 있는지 확인한다.
- [ ] 오늘 첫 기준 출력 입력 후 `+10`, `-10`을 눌러 현재 출력과 그래프가 즉시 바뀌는지 확인한다.
- [ ] 앱을 완전히 닫았다 다시 열어 출력 기록이 `medicationDiary.outputEvents.v1`에서 복원되는지 확인한다.
- [ ] 최근 출력 기록의 수정·삭제·취소와 날짜별 JSON·CSV 내보내기를 확인한다.
- [ ] `출력 기록 관리 → 지난 시간 출력 기록`에서 최근 7일의 날짜·시간·출력·메모를 저장한다.
- [ ] 중간 소급 기록 뒤의 `+10/-10` 출력이 다시 계산되고 보라색 소급 마커가 그래프에 표시되는지 확인한다.
- [ ] 같은 시각의 기록에서 `기존 기록 수정`, `새 기록 추가`, `취소`가 각각 동작하는지 확인한다.
- [ ] 미래 시각과 7일 범위 밖의 날짜가 차단되는지 확인한다.
- [ ] 2시간 이상 지난 기록에서 기준 출력 재설정 안내와 `그대로 기록` 선택 시 낮은 신뢰도 표시를 확인한다.
- [ ] 동결과 넘어질 뻔을 눌러도 현재 출력이 바뀌지 않고, 1초 안의 중복 입력이 차단되는지 확인한다.
- [ ] 이상운동증·근긴장이상 버튼을 한 번 누르면 진행 중, 다시 누르면 종료가 되고 새로고침 뒤에도 상태가 유지되는지 확인한다.
- [ ] 메인 `약 복용` 버튼이 기존 약 선택창을 열고 복약 당시 출력값을 함께 저장하는지 확인한다.
- [ ] 출력 그래프와 최근 목록에 복약·증상 사건이 시간순으로 표시되고 수정·삭제되는지 확인한다.
- [ ] Delayed ON·불완전 ON·ON Failure를 생성·수정·삭제하고 출력 그래프의 D/I/F 마커와 보고서 횟수가 갱신되는지 확인한다.
- [ ] 낮은 출력·상승·높은 출력 안정·하강 구간 메모를 남겨도 현재 출력값이 바뀌지 않는지 확인한다.

## GitHub Pages 주의

Android Digital Asset Links는 저장소 하위 경로가 아니라 **도메인 루트의 `/.well-known/assetlinks.json`**을 확인한다. 주소가 `사용자명.github.io/저장소명/` 형태라면 파일이 `사용자명.github.io/.well-known/assetlinks.json`에서 제공되는지 별도로 확인해야 한다. 어렵다면 사용자/조직 루트 Pages 또는 사용자 소유 도메인을 사용하는 편이 안전하다.

## 업데이트 확인

1. 새 파일을 배포한다.
2. 브라우저에서 `manifest.json`, 네 아이콘, `privacy.html`, `sw.js`, `css/output-engine.css`, `js/output-ui.bundle.js`가 모두 200으로 열리는지 확인한다.
3. 기존 설치 앱을 완전히 종료하고 다시 연다.
4. 이전 화면이 남으면 브라우저의 사이트 데이터에서 해당 사이트 캐시만 지운 뒤 다시 설치한다. 기록 삭제 전에는 반드시 백업 파일을 저장한다.

`index.html`을 파일 탐색기에서 직접 열어도 0.12.1의 일반 스크립트 번들이 실행된다. 웹 서버에 올릴 때는 폴더 구조를 유지해야 하며, `js/output-ui.bundle.js`가 누락되면 출력·사건 기록 기능을 사용할 수 없다.
