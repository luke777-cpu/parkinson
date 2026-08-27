package kr.parkinson.medicationdiary.widget;

import com.getcapacitor.JSObject;

import kr.parkinson.medicationdiary.BuildConfig;

/**
 * 위젯 딥링크(증상/생활/느낌메모/점수매기기) 문제를 실기기에서 Logcat 없이 진단하기 위한
 * 메모리 전용 스냅샷. pending_action/pending_records 등 실제 사용자 데이터와는 완전히
 * 분리되어 있고 SharedPreferences에도 저장하지 않는다 — 앱 프로세스가 켜져 있는 동안만
 * 유지되는 "가장 최근 위젯 인텐트 처리 결과" 한 장이다.
 *
 * record()는 MainActivity.handleWidgetActionIntent()가 BuildConfig.DEBUG일 때만 호출하므로
 * release 빌드에서는 아래 필드가 항상 기본값(false/null)에 머문다. 그와 별개로
 * WidgetBridgePlugin.peekWidgetDiagnostics()가 내려주는 debug 필드 자체가 release에서는
 * false이므로, JS는 그 필드 하나만 보고 진단창 표시 여부를 결정한다.
 */
public final class WidgetDiagnostics {
    private WidgetDiagnostics() {}

    private static boolean coldStart;
    private static String intentAction;
    private static String intentActionResolvedAction;
    private static boolean extrasEmpty;
    private static String rawExtra;
    private static boolean pendingSaved;
    private static String pendingReadback;

    public static void record(boolean coldStartVal, String intentActionVal, String intentActionResolvedActionVal,
                               boolean extrasEmptyVal, String rawExtraVal,
                               boolean pendingSavedVal, String pendingReadbackVal) {
        coldStart = coldStartVal;
        intentAction = intentActionVal;
        intentActionResolvedAction = intentActionResolvedActionVal;
        extrasEmpty = extrasEmptyVal;
        rawExtra = rawExtraVal;
        pendingSaved = pendingSavedVal;
        pendingReadback = pendingReadbackVal;
    }

    public static JSObject toJson() {
        JSObject o = new JSObject();
        o.put("debug", BuildConfig.DEBUG);
        o.put("coldStart", coldStart);
        o.put("intentAction", intentAction);
        o.put("intentActionResolvedAction", intentActionResolvedAction);
        o.put("extrasEmpty", extrasEmpty);
        o.put("rawExtra", rawExtra);
        o.put("pendingSaved", pendingSaved);
        o.put("pendingReadback", pendingReadback);
        return o;
    }
}
