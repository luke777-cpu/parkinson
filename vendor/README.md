# vendor/ — 저장소 내부 고정 버전 라이브러리

PDF 직접 생성(3단계, 2026-08-26)에 필요한 두 라이브러리를 CDN 대신 여기 고정 버전으로 보관한다.
과거(v1.3.2, 커밋 `16fee2b`)에는 CDN에서 그때그때 불러왔는데, 그 방식은 오프라인에서 PDF 생성이
아예 안 되고 CDN이 예고 없이 버전을 바꿀 위험이 있어 이번에 저장소 내부 포함으로 바꿨다.

| 파일 | 버전 | 출처 | SHA-256 | 라이선스 |
|---|---|---|---|---|
| `html2canvas.min.js` | 1.4.1 | `npm pack html2canvas@1.4.1` → `dist/html2canvas.min.js` | `e87e550794322e574a1fda0c1549a3c70dae5a93d9113417a429016838eab8cb` | MIT (`html2canvas.LICENSE.txt`) |
| `jspdf.umd.min.js` | 2.5.1 | `npm pack jspdf@2.5.1` → `dist/jspdf.umd.min.js` | `98ccf17aa10c20bb1301762618fcc9b6ab3a4e7f26b6071d64d0b41154df3875` | MIT (`jspdf.LICENSE.txt`) |

둘 다 브라우저 안에서만 실행되며 네트워크 요청을 만들지 않는다 — 기록이나 화면을 외부로 전송하지
않는다(기존 `privacy.html`의 "서버 전송 없음" 원칙과 동일).

버전을 올릴 때는 `npm pack <package>@<version>`으로 받은 `dist/` 산출물을 그대로 덮어쓰고, 이
표의 버전·SHA-256·라이선스 파일을 함께 갱신한다. CDN 링크는 어디에도 추가하지 않는다.
