package kr.parkinson.medicationdiary.widget;

import android.appwidget.AppWidgetManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.SharedPreferences;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * 위젯 전용 캐시. 기존 앱의 localStorage(yakhyo_log_v1)는 여기서 직접 건드리지 않는다.
 * 위젯의 +10/-10/기록은 이 SharedPreferences만 갱신하고, 실제 기록 큐(pending_records)는
 * 앱이 다음에 열릴 때 www/index.html의 ingestWidgetEvents()가 읽어가 기존 형식 그대로
 * db.events에 편입한다 (본체가 이미 쓰는 SHARED 챌린지 편입 패턴과 동일한 구조).
 */
public final class WidgetStore {
    private static final String PREFS_NAME = "widget_prefs";
    private static final String KEY_CURRENT_OUTPUT = "current_output";
    private static final String KEY_PENDING_OUTPUT = "pending_output";
    private static final String KEY_LAST_TS = "last_ts";
    private static final String KEY_PENDING_RECORDS = "pending_records";
    private static final int NO_VALUE = -1;
    private static final int DEFAULT_OUTPUT = 50;
    private static final int MAX_PENDING_RECORDS = 50;

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

    /** 위젯 +10 / -10: 화면에 보이는 예상값만 바꾼다. 실제 기록은 아직 생성하지 않는다. */
    public static void adjustPending(Context context, int delta) {
        int base = getDisplayOutput(context);
        int next = Math.max(0, Math.min(100, base + delta));
        prefs(context).edit().putInt(KEY_PENDING_OUTPUT, next).apply();
    }

    /** 위젯 "기록": 현재 표시값을 확정하고, 앱이 열릴 때 편입할 대기열에 넣는다. */
    public static void commitRecord(Context context, long ts) {
        int value = getDisplayOutput(context);
        SharedPreferences.Editor editor = prefs(context).edit();
        editor.putInt(KEY_CURRENT_OUTPUT, value);
        editor.putLong(KEY_LAST_TS, ts);
        editor.remove(KEY_PENDING_OUTPUT);
        editor.apply();
        appendPendingRecord(context, value, ts);
    }

    private static synchronized void appendPendingRecord(Context context, int output, long ts) {
        try {
            JSONArray arr = readPendingRecordsLocked(context);
            JSONObject rec = new JSONObject();
            rec.put("output", output);
            rec.put("ts", ts);
            arr.put(rec);
            while (arr.length() > MAX_PENDING_RECORDS) {
                arr.remove(0);
            }
            prefs(context).edit().putString(KEY_PENDING_RECORDS, arr.toString()).apply();
        } catch (Exception ignored) {}
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
        return readPendingRecordsLocked(context);
    }

    /** ts가 일치하는 항목만 큐에서 제거한다. 편입에 실패한 레코드나, peek 이후 위젯에서
        새로 추가된 레코드는 절대 건드리지 않고 큐에 그대로 남긴다. */
    public static synchronized void ackPendingRecords(Context context, java.util.Set<Long> timestamps) {
        if (timestamps == null || timestamps.isEmpty()) return;
        JSONArray arr = readPendingRecordsLocked(context);
        JSONArray remaining = new JSONArray();
        for (int i = 0; i < arr.length(); i++) {
            try {
                JSONObject rec = arr.getJSONObject(i);
                if (!timestamps.contains(rec.getLong("ts"))) {
                    remaining.put(rec);
                }
            } catch (Exception ignored) {}
        }
        prefs(context).edit().putString(KEY_PENDING_RECORDS, remaining.toString()).apply();
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
    }
}
