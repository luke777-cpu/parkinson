package kr.parkinson.medicationdiary.widget;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * 웹앱(JS) <-> 위젯(SharedPreferences) 최소 브리지.
 * 기존 앱 데이터(yakhyo_log_v1)는 이 플러그인이 아니라 항상 www/index.html 쪽 JS가
 * 그대로 다룬다 — 여기서는 위젯 표시값 캐시와 "위젯에서 만든 기록 대기열"만 다룬다.
 */
@CapacitorPlugin(name = "WidgetBridge")
public class WidgetBridgePlugin extends Plugin {

    /** 앱이 실제로 저장을 마쳤을 때 호출: 위젯에 보여줄 현재 출력·마지막 기록 시각을 갱신한다. */
    @PluginMethod
    public void syncFromApp(PluginCall call) {
        Integer output = call.getInt("output");
        Long lastTs = null;
        Object tsRaw = call.getData().opt("lastTs");
        if (tsRaw instanceof Number) {
            lastTs = ((Number) tsRaw).longValue();
        }
        WidgetStore.syncFromApp(getContext(), output, lastTs);
        WidgetStore.requestWidgetRefresh(getContext());
        call.resolve();
    }

    /** 앱 시작/재개 시 호출: 위젯에서 쌓인 미편입 기록을 가져오고 대기열을 비운다. */
    @PluginMethod
    public void drainPendingRecords(PluginCall call) {
        JSONArray raw = WidgetStore.drainPendingRecords(getContext());
        JSArray records = new JSArray();
        for (int i = 0; i < raw.length(); i++) {
            try {
                JSONObject o = raw.getJSONObject(i);
                JSObject rec = new JSObject();
                rec.put("output", o.getInt("output"));
                rec.put("ts", o.getLong("ts"));
                records.put(rec);
            } catch (Exception ignored) {}
        }
        JSObject result = new JSObject();
        result.put("records", records);
        call.resolve(result);
    }
}
