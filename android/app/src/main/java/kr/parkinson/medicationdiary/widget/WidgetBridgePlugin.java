package kr.parkinson.medicationdiary.widget;

import android.util.Log;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.HashSet;
import java.util.Set;

import kr.parkinson.medicationdiary.BuildConfig;

/**
 * 웹앱(JS) <-> 위젯(SharedPreferences) 최소 브리지.
 * 기존 앱 데이터(yakhyo_log_v1)는 이 플러그인이 아니라 항상 www/index.html 쪽 JS가
 * 그대로 다룬다 — 여기서는 위젯 표시값 캐시와 "위젯에서 만든 기록 대기열"만 다룬다.
 */
@CapacitorPlugin(name = "WidgetBridge")
public class WidgetBridgePlugin extends Plugin {

    private static final String TAG = "WIDGET_DEBUG";

    /** 앱이 실제로 저장을 마쳤을 때 호출: 위젯에 보여줄 현재 출력·마지막 기록 시각을 갱신한다. */
    @PluginMethod
    public void syncFromApp(PluginCall call) {
        if (BuildConfig.DEBUG) Log.d(TAG, "[plugin] syncFromApp() entered");
        try {
            Integer output = call.getInt("output");
            Long lastTs = null;
            Object tsRaw = call.getData().opt("lastTs");
            if (tsRaw instanceof Number) {
                lastTs = ((Number) tsRaw).longValue();
            }
            if (BuildConfig.DEBUG) Log.d(TAG, "[plugin] syncFromApp output=" + output + " lastTs=" + lastTs);
            WidgetStore.syncFromApp(getContext(), output, lastTs);
            WidgetStore.requestWidgetRefresh(getContext());
            call.resolve();
        } catch (Exception e) {
            Log.e(TAG, "[plugin] syncFromApp FAILED", e);
            call.reject("syncFromApp failed: " + e.getMessage(), e);
        }
    }

    /** 앱 시작/재개 시 호출: 위젯에서 쌓인 미편입 기록을 큐에서 지우지 않고 그대로 읽는다.
        실제로 db.events에 편입해 저장까지 확인한 뒤에만 ackPendingRecords()로 지운다 —
        편입에 실패하면 큐에 남아 다음 기회에 다시 시도된다(기록 유실 방지). */
    @PluginMethod
    public void peekPendingRecords(PluginCall call) {
        if (BuildConfig.DEBUG) Log.d(TAG, "[plugin] peekPendingRecords() entered");
        try {
            JSONArray raw = WidgetStore.peekPendingRecords(getContext());
            JSArray records = new JSArray();
            for (int i = 0; i < raw.length(); i++) {
                try {
                    JSONObject o = raw.getJSONObject(i);
                    JSObject rec = new JSObject();
                    rec.put("ts", o.getLong("ts"));
                    /* kind가 없는 레코드는 이번 기능 이전(v2.16.7 이전)에 쌓인 구버전
                       출력 기록이다 — JS 쪽이 kind 부재를 "state"와 동일하게 처리하므로
                       여기서는 그냥 생략한다. output/trend/dir도 각각 있을 때만 채운다:
                       output은 state(기록) 레코드에만, dir은 tempnote(임시기록) 레코드에만
                       있다 — 없는 필드를 강제로 읽으면 이 레코드 전체가 파싱 실패로
                       빠지므로(catch에 걸려 통째로 드롭됨) 절대 무조건 읽지 않는다. */
                    if (o.has("kind") && !o.isNull("kind")) {
                        rec.put("kind", o.getString("kind"));
                    }
                    if (o.has("output") && !o.isNull("output")) {
                        rec.put("output", o.getInt("output"));
                    }
                    if (o.has("trend") && !o.isNull("trend")) {
                        rec.put("trend", o.getString("trend"));
                    }
                    if (o.has("dir") && !o.isNull("dir")) {
                        rec.put("dir", o.getString("dir"));
                    }
                    records.put(rec);
                } catch (Exception e) {
                    Log.e(TAG, "[plugin] peekPendingRecords item " + i + " parse FAILED (raw=" + raw + ")", e);
                }
            }
            if (BuildConfig.DEBUG) Log.d(TAG, "[plugin] peekPendingRecords returning to JS count=" + records.length());
            JSObject result = new JSObject();
            result.put("records", records);
            call.resolve(result);
        } catch (Exception e) {
            Log.e(TAG, "[plugin] peekPendingRecords FAILED", e);
            call.reject("peekPendingRecords failed: " + e.getMessage(), e);
        }
    }

    /** 편입 성공이 확인된 레코드의 ts만 큐에서 제거한다. */
    @PluginMethod
    public void ackPendingRecords(PluginCall call) {
        if (BuildConfig.DEBUG) Log.d(TAG, "[plugin] ackPendingRecords() entered");
        try {
            JSArray tsArray = call.getArray("ts");
            Set<Long> timestamps = new HashSet<>();
            if (tsArray != null) {
                for (int i = 0; i < tsArray.length(); i++) {
                    try {
                        timestamps.add(tsArray.getLong(i));
                    } catch (Exception e) {
                        Log.e(TAG, "[plugin] ackPendingRecords ts item " + i + " parse FAILED", e);
                    }
                }
            }
            if (BuildConfig.DEBUG) Log.d(TAG, "[plugin] ackPendingRecords ts=" + timestamps);
            WidgetStore.ackPendingRecords(getContext(), timestamps);
            call.resolve();
        } catch (Exception e) {
            Log.e(TAG, "[plugin] ackPendingRecords FAILED", e);
            call.reject("ackPendingRecords failed: " + e.getMessage(), e);
        }
    }

    /** 위젯의 "증상"/"생활"/"지금 느낌 메모"/"점수 매기기" 버튼이 남긴 화면 이동
        힌트를 지우지 않고 그대로 읽는다. 값이 없으면 action:null을 돌려준다. 실제로
        해당 화면을 여는 데 성공했을 때만 clearPendingAction()을 호출해서 지워야 한다 —
        열기에 실패하면 힌트가 남아 다음 기회에 다시 시도된다. */
    @PluginMethod
    public void peekPendingAction(PluginCall call) {
        if (BuildConfig.DEBUG) Log.d(TAG, "[plugin] peekPendingAction() entered");
        try {
            String action = WidgetStore.peekPendingAction(getContext());
            JSObject result = new JSObject();
            result.put("action", action);
            if (BuildConfig.DEBUG) Log.d(TAG, "[plugin] peekPendingAction returning to JS action=" + action);
            call.resolve(result);
        } catch (Exception e) {
            Log.e(TAG, "[plugin] peekPendingAction FAILED", e);
            call.reject("peekPendingAction failed: " + e.getMessage(), e);
        }
    }

    /** 실기기 딥링크 진단창(DEBUG 전용) 데이터 소스. release에서는 debug:false만 유의미하고
        나머지 필드는 JS가 절대 사용하지 않는다 — 콜 자체는 release에서도 항상 성공해야
        JS의 consumeWidgetAction() 흐름이 깨지지 않는다. */
    @PluginMethod
    public void peekWidgetDiagnostics(PluginCall call) {
        if (BuildConfig.DEBUG) Log.d(TAG, "[plugin] peekWidgetDiagnostics() entered");
        try {
            call.resolve(WidgetDiagnostics.toJson());
        } catch (Exception e) {
            Log.e(TAG, "[plugin] peekWidgetDiagnostics FAILED", e);
            call.reject("peekWidgetDiagnostics failed: " + e.getMessage(), e);
        }
    }

    /** 화면을 실제로 여는 데 성공했다고 JS가 확인한 뒤에만 호출된다. */
    @PluginMethod
    public void clearPendingAction(PluginCall call) {
        if (BuildConfig.DEBUG) Log.d(TAG, "[plugin] clearPendingAction() entered");
        try {
            WidgetStore.clearPendingAction(getContext());
            call.resolve();
        } catch (Exception e) {
            Log.e(TAG, "[plugin] clearPendingAction FAILED", e);
            call.reject("clearPendingAction failed: " + e.getMessage(), e);
        }
    }
}
