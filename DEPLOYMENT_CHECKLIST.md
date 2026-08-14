# 약효일지 배포 체크리스트

> 2026-08-14 갱신: 옛 문서가 폴더 구조(js/·css/ 하위분리)·버전(0.12.1)·존재하지 않는 스크립트
> (scripts/validate-project.js 등)를 기준으로 쓰여 있어 실제 저장소와 맞지 않았습니다.
> 아래는 v2.15.0 기준 실제 구조로 다시 확인한 내용입니다.

## 올릴 파일 구조 (v2.15.1, 실제 main 브랜치 기준)

```text
/
  index.html
  manifest.json
  sw.js
  privacy.html
  package.json
  drug-dictionary.json
  output-engine.css
  output-ui.bundle.js
  shared-profile.js
  phs-engine.js
  phs-report.js
  simulation-drugmodel.js
  analysis-clinical.js
  analysis-threshold.js
  analysis-coverage.js
  analysis-candidates.js
  analysis-validation.js
  icon-192.png
  icon-192-maskable.png
  icon-512.png
  icon-512-maskable.png
  .well-known/
    assetlinks.json               # Android 연결에 실제 사용
  challenge/                      # 약효 비교 테스트 하위앱(별도 index.html)
  tests/
    phs-engine.test.js
    phs-integration.test.js
```

css/·js/ 하위 폴더는 없습니다. 모든 CSS·JS 파일이 저장소 루트에 바로 있습니다.
`engines/`·`demo/`·`scripts/` 폴더도 현재 저장소엔 없습니다.

## 배포 전 반드시 할 일

- [ ] `.well-known/assetlinks.json`의 SHA-256 지문이 Play 앱 서명 인증서의 실제 값인지 확인한다.
- [ ] 공개 주소에서 `https://도메인/.well-known/assetlinks.json`이 로그인이나 리디렉션 없이 열리는지 확인한다.
- [ ] Android 패키지 이름이 `kr.parkinson.medicationdiary`인지 확인한다.
- [ ] `npm install && npm test`를 실행한다. 현재 구성:
  - `tests/phs-engine.test.js` — PHS 엔진 단위 테스트 49개, 전부 통과 확인됨(2026-08-14).
  - `tests/phs-integration.test.js` — **현재 실패 중.** `phsStartBtn` 요소를 찾다가
    `Cannot read properties of null (reading 'click')`로 중단됨. 원인 확인: index.html 코드 주석에
    "v1.2: 미래형 '관찰 시작/종료' → 이미 쌓인 기록의 날짜 구간 지정"이라고 명시되어 있어, 이 테스트가
    exercising하는 관찰 시작/종료 설문 플로우 자체가 v1.2에서 '기간 선택'(phsRangeBtn) 방식으로
    바뀌면서 없어진 것으로 보입니다. Priority B 배포 전후 커밋 양쪽에서 동일하게 실패해 이번 변경으로
    생긴 회귀는 아님을 확인했습니다. 테스트를 현재 '기간 선택' 플로우에 맞게 다시 쓰기 전까지는
    이 통합 테스트 결과를 배포 판단 근거로 쓰지 마세요.
  - `scripts/validate-project.js`, `npm run check` 등은 현재 저장소에 없는 명령입니다 — 옛 문서의 오기.
- [ ] 기존 사용자는 업데이트 전 백업 JSON을 한 번 내보낸다(설정 → 백업 내보내기).
- [ ] 업데이트 뒤 앱을 완전히 닫았다 다시 열어 화면 하단 버전이 `2.15.1`인지 확인한다.
- [ ] 한국어·영어 각각 한 번씩: 오늘 탭 기록(빠른 기록 3종), 그래프(곡선·트렌드), 시뮬레이터,
      PHS 보고서 PDF 생성, 백업 내보내기/불러오기를 실기기에서 확인한다.
      (2026-08-14 세션 판단: 이 부분은 jsdom으로 구조·언어분기까지는 확인했지만 실기기 렌더링·PDF
      결과물까지는 확인하지 못했습니다 — 실기기 확인이 꼭 필요합니다.)

## GitHub Pages 주의

Android Digital Asset Links는 저장소 하위 경로가 아니라 **도메인 루트의 `/.well-known/assetlinks.json`**을 확인한다. 주소가 `사용자명.github.io/저장소명/` 형태라면 파일이 `사용자명.github.io/.well-known/assetlinks.json`에서 제공되는지 별도로 확인해야 한다. 어렵다면 사용자/조직 루트 Pages 또는 사용자 소유 도메인을 사용하는 편이 안전하다.

## 업데이트 확인

1. 새 파일을 배포한다(GitHub Contents API 또는 웹 UI로 main 브랜치에 직접 커밋).
2. 배포 후 반드시 GitHub API로 서버 파일과 로컬 파일을 직접 대조(sha256)해 실제 반영을 확인한다.
   `raw.githubusercontent.com`은 CDN 캐시가 남을 수 있어 배포 직후 대조가 어긋날 수 있다 —
   `api.github.com/repos/.../contents/...` (Accept: application/vnd.github.raw)로 확인하는 편이 확실하다.
3. `/pages/builds/latest`로 Pages 빌드 상태가 `built`인지 확인한다.
4. 브라우저에서 `manifest.json`, 아이콘 4종, `privacy.html`, `sw.js`, `output-engine.css`,
   `output-ui.bundle.js`가 모두 200으로 열리는지 확인한다(전부 루트 경로, `css/`·`js/` 하위경로 아님).
5. 기존 설치 앱을 완전히 종료하고 다시 연다. `sw.js`의 `CACHE` 상수를 배포 때마다 새 값으로
   바꿔야 이전 캐시가 새 파일로 교체된다(빠뜨리면 사용자 화면에 옛 버전이 남을 수 있음).
6. 이전 화면이 남으면 브라우저의 사이트 데이터에서 해당 사이트 캐시만 지운 뒤 다시 설치한다.
   기록 삭제 전에는 반드시 백업 파일을 저장한다.
