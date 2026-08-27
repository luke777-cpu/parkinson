package kr.parkinson.medicationdiary.widget;

import android.appwidget.AppWidgetManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.SharedPreferences;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import kr.parkinson.medicationdiary.BuildConfig;

/**
 * 위젯 전용 캐시. 기존 앱의 localStorage(yakhyo_log_v1)는 여기서 직접 건드리지 않는다.
 * 위젯의 +10/-10/기록은 이 SharedPreferences만 갱신하고, 실제 기록 큐(pending_records)는
 * 앱이 다음에 열릴 때 www/index.html의 ingestWidgetEvents()가 읽어가 기존 형식 그대로
 * db.events에 편입한다 (본체가 이미 쓰는 SHARED 챌린지 편입 패턴과 동일한 구조).
 */
public final class WidgetStore {
    private static final String TAG = "WIDGET_DEBUG";
    private static final String PREFS_NAME = "widget_prefs";
    private static final String KEY_CURRENT_OUTPUT = "current_output";
    private static final String KEY_PENDING_OUTPUT = "pending_output";
    private static final String KEY_LAST_TS = "last_ts";
    private static final String KEY_PENDING_RECORDS = "pending_records";
    private static final String KEY_TREND = "trend";
    private static final String KEY_PENDING_ACTION = "pending_action";
    private static final int NO_VALUE = -1;
    private static final int DEFAULT_OUTPUT = 50;
    private static final int MAX_PENDING_RECORDS = 50;
    /** 앱 본체가 이미 쓰는 trend 값과 완전히 동일하다(stateFromTrend()/trendLabel() 등,
        www/index.html) — 위젯에서 "상승 중"으로 기록하면 앱에서 직접 상승 중을 골라 기록한
        것과 데이터상 구별이 안 되어야 하므로 새 값을 만들지 않고 그대로 재사용한다. */
    private static final String TREND_RISING = "rising";
    private static final String TREND_STABLE = "stable";
    private static final String TREND_FALLING = "falling";
    private static final String DEFAULT_TREND = TREND_STABLE;

    /** 앱의 TEMPNOTE_DIRS(www/index.html)와 동일한 값 — 위젯의 단순 3분류(trend)를
        그중 가장 가까운 것으로만 매핑한다. signal/peak처럼 더 세밀한 의미는 위젯
        버튼 3개로는 구분할 수 없어 만들지 않는다. */
    private static final String DIR_UP = "up";
    private static final String DIR_SAME = "same";
    private static final String DIR_DOWN = "down";

    /** MainActivity 인텐트로 "빠른 기록" 딥링크를 전달할 때 쓰는 extra 키. */
    public static final String EXTRA_WIDGET_ACTION = "widget_action";
    /** consumePendingAction()이 돌려주는 값 — www/index.html의 기존 진입점과 1:1 대응.
        note=openTempNoteQuick(), score=openTempNoteReview(),
        symptom/life=quickRecordCard의 해당 data-panel 탭 활성화. */
    public static final String ACTION_NOTE = "note";
    public static final String ACTION_SCORE = "score";
    public static final String ACTION_SYMPTOM = "symptom";
    public static final String ACTION_LIFE = "life";

    private WidgetStore() {}

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);
    }

    public static int getCurrentOutput(Context context) {
        int v = prefs(context).getInt(KEY_CURRENT_OUTPUT, NO_VALUE);
        return v == NO_VALUE ? DEFAULT_OUTPUT : v;
    }

    public static Integer getPendingOutput(Context context) {
        int v = prefs(context).getInt(KEY_PENDING_OUTPUT, NO_VALUE);
        return v == NO_VALUE ? null : v;
    }

    public static int getDisplayOutput(Context context) {
        Integer pending = getPendingOutput(context);
        return pending != null ? pending : getCurrentOutput(context);
    }

    public static long getLastTs(Context context) {
        return prefs(context).getLong(KEY_LAST_TS, 0L);
    }

    /** 위젯의 "지금 느낌" 선택. +10/-10과 독립적으로 유지되며, 기본값은 stable —
        상승으로 잘못 기본값이 잡히면 앱의 "상승 종료 결과 확인" 흐름이 위젯만으로도
        의도치 않게 트리거될 수 있어 가장 안전한 쪽(유지)을 기본으로 둔다. */
    public static String getTrend(Context context) {
        String v = prefs(context).getString(KEY_TREND, DEFAULT_TREND);
        if (!TREND_RISING.equals(v) && !TREND_STABLE.equals(v) && !TREND_FALLING.equals(v)) {
            return DEFAULT_TREND;
        }
        return v;
    }

    public static void setTrend(Context context, String trend) {
        if (!TREND_RISING.equals(trend) && !TREND_STABLE.equals(trend) && !TREND_FALLING.equals(trend)) {
            if (BuildConfig.DEBUG) Log.e(TAG, "setTrend() ignored invalid value=" + trend);
            return;
        }
        if (BuildConfig.DEBUG) Log.d(TAG, "setTrend() -> " + trend);
        prefs(context).edit().putString(KEY_TREND, trend).apply();
    }

    /** 위젯 +10 / -10: 화면에 보이는 예상값만 바꾼다. 실제 기록은 아직 생성하지 않는다. */
    public static void adjustPending(Context context, int delta) {
        int base = getDisplayOutput(context);
        int next = Math.max(0, Math.min(100, base + delta));
        prefs(context).edit().putInt(KEY_PENDING_OUTPUT, next).apply();
    }

    /** 위젯 "기록": 현재 표시값을 확정하고, 앱이 열릴 때 편입할 대기열에 넣는다.
        kind:"state"로 표시하지만, 이 키가 아예 없는 구버전 pending record도 앱(JS) 쪽에서
        "state"와 동일하게 처리하도록 만들어뒀다(하위 호환). */
    public static void commitRecord(Context context, long ts) {
        int value = getDisplayOutput(context);
        String trend = getTrend(context);
        if (BuildConfig.DEBUG) Log.d(TAG, "commitRecord() value=" + value + " trend=" + trend + " ts=" + ts);
        SharedPreferences.Editor editor = prefs(context).edit();
        editor.putInt(KEY_CURRENT_OUTPUT, value);
        editor.putLong(KEY_LAST_TS, ts);
        editor.remove(KEY_PENDING_OUTPUT);
        editor.apply();
        try {
            JSONObject rec = new JSONObject();
            rec.put("kind", "state");
            rec.put("output", value);
            rec.put("ts", ts);
            rec.put("trend", trend);
            appendPendingRecord(context, rec);
        } catch (Exception e) {
            if (BuildConfig.DEBUG) Log.e(TAG, "commitRecord build FAILED", e);
        }
    }

    /** 위젯 "임시기록": 출력값 없이 현재 방향만 즉시 기록한다 — 앱의 addTempNote()와
        동일한 의미(type:"tempnote", dir). trend(rising/stable/falling)를 앱의 dir
        어휘(TEMPNOTE_DIRS) 중 가장 가까운 것으로 매핑한다. */
    public static void commitTempNote(Context context, long ts) {
        String trend = getTrend(context);
        String dir = TREND_RISING.equals(trend) ? DIR_UP : TREND_FALLING.equals(trend) ? DIR_DOWN : DIR_SAME;
        if (BuildConfig.DEBUG) Log.d(TAG, "commitTempNote() trend=" + trend + " dir=" + dir + " ts=" + ts);
        try {
            JSONObject rec = new JSONObject();
            rec.put("kind", "tempnote");
            rec.put("dir", dir);
            rec.put("ts", ts);
            appendPendingRecord(context, rec);
        } catch (Exception e) {
            if (BuildConfig.DEBUG) Log.e(TAG, "commitTempNote build FAILED", e);
        }
    }

    private static synchronized void appendPendingRecord(Context context, JSONObject rec) {
        try {
            JSONArray arr = readPendingRecordsLocked(context);
            arr.put(rec);
            while (arr.length() > MAX_PENDING_RECORDS) {
                arr.remove(0);
            }
            String serialized = arr.toString();
            prefs(context).edit().putString(KEY_PENDING_RECORDS, serialized).apply();
            if (BuildConfig.DEBUG) {
                Log.d(TAG, "appendPendingRecord rec=" + rec + " newCount=" + arr.length());
                // 실제로 디스크/메모리에 반영됐는지 같은 프로세스에서 바로 재확인
                int recheck = readPendingRecordsLocked(context).length();
                Log.d(TAG, "appendPendingRecord recheck count=" + recheck);
            }
        } catch (Exception e) {
            if (BuildConfig.DEBUG) Log.e(TAG, "appendPendingRecord FAILED", e);
        }
    }

    private static JSONArray readPendingRecordsLocked(Context context) {
        String raw = prefs(context).getString(KEY_PENDING_RECORDS, "[]");
        try {
            return new JSONArray(raw);
        } catch (Exception e) {
            return new JSONArray();
        }
    }

    /** 큐를 지우지 않고 그대로 읽기만 한다 — 실제 편입(db.events 저장) 확인 전에는
        절대 지우지 않기 위해, "읽기"와 "확인 후 제거"를 별도 메서드로 분리했다. */
    public static synchronized JSONArray peekPendingRecords(Context context) {
        JSONArray arr = readPendingRecordsLocked(context);
        if (BuildConfig.DEBUG) Log.d(TAG, "peekPendingRecords() -> count=" + arr.length());
        return arr;
    }

    /** ts가 일치하는 항목만 큐에서 제거한다. 편입에 실패한 레코드나, peek 이후 위젯에서
        새로 추가된 레코드는 절대 건드리지 않고 큐에 그대로 남긴다. */
    public static synchronized void ackPendingRecords(Context context, java.util.Set<Long> timestamps) {
        if (BuildConfig.DEBUG) Log.d(TAG, "ackPendingRecords() called with ts=" + timestamps);
        if (timestamps == null || timestamps.isEmpty()) return;
        JSONArray arr = readPendingRecordsLocked(context);
        JSONArray remaining = new JSONArray();
        int removed = 0;
        for (int i = 0; i < arr.length(); i++) {
            try {
                JSONObject rec = arr.getJSONObject(i);
                if (!timestamps.contains(rec.getLong("ts"))) {
                    remaining.put(rec);
                } else {
                    removed++;
                }
            } catch (Exception e) {
                if (BuildConfig.DEBUG) Log.e(TAG, "ackPendingRecords record parse failed", e);
            }
        }
        prefs(context).edit().putString(KEY_PENDING_RECORDS, remaining.toString()).apply();
        if (BuildConfig.DEBUG) Log.d(TAG, "ackPendingRecords removed=" + removed + " remaining=" + remaining.length());
    }

    /** "증상"/"생활"/"지금 느낌 메모"/"점수 매기기" 위젯 버튼 — 데이터를 만들지 않고
        앱을 열면서 어느 화면으로 이동해야 하는지만 남긴다.
        v2.16.10: 처음엔 "읽으면서 즉시 삭제"였는데, 그러면 JS 쪽에서 화면을 여는 단계가
        어떤 이유로든 실패(예외/DOM 준비 전)해도 이미 지워진 뒤라 재시도할 방법이 없어
        조용히 사라진 것처럼 보인다 — pending_records의 peek()/ack() 안전장치와 똑같은
        이유로, 여기도 "읽기"와 "성공 확인 후 삭제"를 분리한다. */
    public static void setPendingAction(Context context, String action) {
        if (BuildConfig.DEBUG) Log.d(TAG, "setPendingAction() -> " + action);
        prefs(context).edit().putString(KEY_PENDING_ACTION, action).apply();
    }

    /** 지우지 않고 그대로 읽기만 한다. */
    public static String peekPendingAction(Context context) {
        String action = prefs(context).getString(KEY_PENDING_ACTION, null);
        if (BuildConfig.DEBUG) Log.d(TAG, "peekPendingAction() -> " + action);
        return action;
    }

    /** 해당 화면을 실제로 여는 데 성공했을 때만 호출해서 지운다. */
    public static void clearPendingAction(Context context) {
        if (BuildConfig.DEBUG) Log.d(TAG, "clearPendingAction() called");
        prefs(context).edit().remove(KEY_PENDING_ACTION).apply();
    }

    /** 앱(WebView)이 실제로 저장한 값으로 위젯 캐시를 맞춘다. 미기록 조정값(pending)은 폐기한다. */
    public static void syncFromApp(Context context, Integer output, Long lastTs) {
        SharedPreferences.Editor editor = prefs(context).edit();
        if (output != null) {
            editor.putInt(KEY_CURRENT_OUTPUT, Math.max(0, Math.min(100, output)));
        }
        if (lastTs != null) {
            editor.putLong(KEY_LAST_TS, lastTs);
        }
        editor.remove(KEY_PENDING_OUTPUT);
        editor.apply();
    }

    public static void requestWidgetRefresh(Context context) {
        AppWidgetManager mgr = AppWidgetManager.getInstance(context);
        ComponentName provider = new ComponentName(context, MedicationWidgetProvider.class);
        int[] ids = mgr.getAppWidgetIds(provider);
        if (ids.length > 0) {
            MedicationWidgetProvider.updateWidgets(context, mgr, ids);
        }
        // 빠른 기록 위젯도 함께 갱신 — 지금은 정적 버튼뿐이라 시각적 변화는 없지만,
        // 앞으로 표시 요소가 생겨도 갱신 경로를 따로 만들 필요가 없도록 같은 관문을 쓴다.
        ComponentName quick = new ComponentName(context, QuickRecordWidgetProvider.class);
        int[] quickIds = mgr.getAppWidgetIds(quick);
        if (quickIds.length > 0) {
            QuickRecordWidgetProvider.updateWidgets(context, mgr, quickIds);
        }
    }
}
