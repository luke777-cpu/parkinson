# 약효일지 어댑터 계약 · 시험 가이드

기존 앱 연결은 없습니다. 이 문서는 **우리 쪽의 시험 계약**입니다. 기존 앱의 DB 테이블, API 주소나 필드 이름으로 오해하면 안 됩니다.

## 실제 연결에 필요한 자료

앱 이름·버전, 개인정보를 지운 샘플 내보내기 파일 또는 DB/API 명세, 식별자 재사용 여부, 생성/수정/삭제 의미, 시간대, 용량 단위, 증상 척도의 의미가 필요합니다. 해당 앱에 되쓰기할 권한과 방법도 별도로 확인해야 합니다.

| 원본 의미 | PLM 대응 | 변환 원칙 |
|---|---|---|
| 원본 복용 ID | medication entity UUID / 별도 대응표 | 시간·약명만으로 동일 복용이라고 추정하지 않음 |
| 약·세트 ID | set_id, medicine_id, set_revision_id | 원본과 PLM 식별자 대응표 보존 |
| 예정/실제 복용 | scheduled_at / actual_at / planned_dose / dose | 실제 시간이 없으면 null, 예정 값으로 대입 금지 |
| 기록 없음/미복용 | 이벤트 없음 / 명시적 not_taken | 원본 미완료가 미복용인지 확인 전 변환 금지 |
| 약효 | output.value | 원본 척도가 0~100과 다르면 규칙 합의 전 자동 환산 금지 |
| ON/OFF | motor_state.state | 명시적으로 기록된 값만, Output으로 산출 금지 |
| 각 증상 | dyskinesia/dystonia/freezing | 증상을 합치지 않고 원본 척도 의미 확인 |
| 수정/삭제 | 새 revision / deleted 버전 | 이전 내용을 보존하고 원본 시간·버전 추적 |

## plm-1.1 구조

schema_version, exported_at, events, heads, merge_parents가 필요합니다. schema 파일은 sync-schema.json, 시험 예시는 example-trial.json입니다. 이벤트 공통 구조는 기존 버전과 같고, heads는 entity UUID→현재 revision UUID 대응표입니다. merge_parents는 충돌 해결 revision과 명시적으로 합친 다른 분기 revision의 쌍입니다. 부모/병합 그래프는 같은 엔티티 안에서 순환이 없어야 합니다. 버전은 주 부모 버전+1이며 병합 부모의 숫자 버전이 더 높을 수도 있습니다. 최종 판정은 그래프 조상 관계로 합니다.

## 오프라인 파일 어댑터

앱을 종료한 상태에서 별도 시험 DB로 시작하세요. 아래 명령은 외부 API에 접근하지 않습니다.

```text
runtime\python.exe exchange.py --db "시험폴더\life.db" preview "받은.json"
runtime\python.exe exchange.py --db "시험폴더\life.db" import "받은.json"
runtime\python.exe exchange.py --db "시험폴더\life.db" export "보낼.json"
runtime\python.exe exchange.py --db "시험폴더\life.db" exchange "받은.json" "보낼.json"
```

exchange는 받은 파일을 바꾸지 않고, 가져오기 검사를 통과하면 안전 백업 후 저장하고 현재 이력을 보내는 파일로 원자적으로 내보냅니다. 두 파일 경로는 달라야 합니다. 가져오기 후 출력 파일 저장이 실패하면 가져오기는 이미 저장되었다고 알립니다. 같은 입력을 재시도해도 같은 revision을 추가하지 않습니다. 가져오기 preview는 원본 기록을 바꾸지 않습니다. 파일은 20MB 이하로 사용하세요.

시험은 A→B 최초 전달, B 수정→A 전달, 같은 파일 반복, 양쪽 동시 수정, 충돌 선택 후 A↔B 재교환, 삭제·복구, null 실제 시간, 자정 경계·오프셋, 변조/부모 누락/순환을 포함합니다. 단위 테스트에서 자체 형식끼리 양방향 교환·중복·충돌 수렴을 확인했습니다. 이 결과가 미확인 외부 앱과의 연동 성공을 뜻하지는 않습니다.


## v1.1 일정 이벤트

schedule(반복 원본), schedule_override(개별 예외), schedule_result(준비·실행 확인), task, routine, routine_application을 추가했습니다. 임상 이벤트와 구분하며 일정 완료에서 실제 복용·운동 값을 생성하지 않습니다. 일정 결과에는 당시 일정 사본과 명시적으로 연결한 실제 이벤트 UUID를 보존합니다. 반복 occurrence는 원본 UUID와 원래 날짜에서 결정적으로 생성합니다. 기존 앱이 일정 종류를 이해하지 못하면 필드를 임의로 임상 기록으로 변환하지 말고 별도 보존하거나 가져오기를 거부해야 합니다. 정확한 필드는 sync-schema.json과 scheduler.py 검증기를 따릅니다.
