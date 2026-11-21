// 원격 공유 범위의 허용 값 목록.
// supabase/migrations/*_diary_bridge.sql, cloud-bridge.js와 같은 목록이어야 한다
// (tests/bridge-schema-sync.test.js가 세 곳을 대조한다).
// 자유 메모·사용자 정의 텍스트는 원격 공유와 MCP 범위에서 제외한다.

export const STATE_VALUES = ["wake", "off", "rising", "on", "falling", "signal", "partial", "dysk", "dyst", "wearoff"] as const;
/** 에이전트가 새로 요청할 수 있는 상태(앱의 현재 기본 버튼과 같다). 나머지는 과거 기록 표시용. */
export const AGENT_STATE_VALUES = ["wake", "off", "rising", "on", "falling"] as const;
export const TREND_VALUES = ["rising", "stable", "falling"] as const;
export const SYMPTOM_VALUES = ["dysk", "dyst", "tremor", "freeze", "rigid", "pain", "toecurl", "gait_unstable"] as const;

export const LIFE_KINDS = ["sleep", "meal", "exercise", "bowel", "body"] as const;
export const LIFE_PHASES = ["start", "end", "nap"] as const;
export const MEAL_TYPES = ["아침", "점심", "저녁", "간식"] as const;
export const MEAL_AMOUNTS = ["소량", "보통", "과식"] as const;
export const LIFE_EXTRAS = ["단백질 많음", "기름진 식사", "힘들었음", "잔변감"] as const;
export const SLEEP_QUALITY = ["숙면", "자주 깸", "잠들기 어려움", "REM 행동 의심"] as const;
export const EXERCISE_TYPES = ["걷기", "실내자전거", "근력", "탁구", "등산"] as const;
export const EXERCISE_INTENSITY = ["가벼움", "보통", "강함"] as const;
export const BOWEL_CONSISTENCY = ["딱딱함", "보통", "묽음"] as const;
export const BODY_SYMPTOMS = ["이상 없음", "어지럼", "기립 시 어지럼", "소변 급박", "빈뇨", "땀 증가", "침 흘림", "메스꺼움", "극심한 피로", "불안", "졸림", "통증"] as const;

export const PAYLOAD_KEYS = {
  med: ["drug", "dose_mg"],
  state: ["state", "output", "trend", "gait", "dysk", "symptoms"],
  life: ["kind", "phase", "meal_type", "amount", "extras", "quality", "ex_type", "intensity", "duration_min", "consistency", "body_symptoms"],
} as const;

export const TIMEZONE = "Asia/Seoul";
/** Asia/Seoul은 1988년 이후 일광절약시간이 없어 고정 +09:00이다. */
export const TZ_OFFSET_MIN = 9 * 60;
export const MAX_BODY_BYTES = 16 * 1024;
export const MAX_OBSERVATION_GAP_MIN = 120;
export const WEEKLY_ROW_LIMIT = 1000;
export const PAGE_SIZE_DEFAULT = 50;
export const PAGE_SIZE_MAX = 100;
