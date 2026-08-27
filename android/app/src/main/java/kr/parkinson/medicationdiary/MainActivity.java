package kr.parkinson.medicationdiary;

import android.content.Intent;
import android.os.Bundle;
import android.util.Log;

import java.util.Set;

import com.getcapacitor.BridgeActivity;

import kr.parkinson.medicationdiary.filesaver.FileSaverPlugin;
import kr.parkinson.medicationdiary.widget.MedicationWidgetProvider;
import kr.parkinson.medicationdiary.widget.WidgetBridgePlugin;
import kr.parkinson.medicationdiary.widget.WidgetDiagnostics;
import kr.parkinson.medicationdiary.widget.WidgetStore;

public class MainActivity extends BridgeActivity {
    private static final String TAG = "WIDGET_DEBUG";

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(WidgetBridgePlugin.class);
        if (BuildConfig.DEBUG) Log.d(TAG, "registerPlugin(WidgetBridgePlugin) done");
        registerPlugin(FileSaverPlugin.class);
        if (BuildConfig.DEBUG) Log.d(TAG, "registerPlugin(FileSaverPlugin) done");
        if (BuildConfig.DEBUG) {
            Intent i = getIntent();
            Log.d(TAG, "onCreate (cold start) intent action extra raw="
                    + (i == null ? "null-intent" : i.getStringExtra(WidgetStore.EXTRA_WIDGET_ACTION)));
            dumpExtras("onCreate", i);
        }
        super.onCreate(savedInstanceState);
        handleWidgetActionIntent(getIntent(), true);
    }

    /* 위젯의 "증상"/"생활"/"지금 느낌 메모"/"점수 매기기" 버튼이 MainActivity를 여는
       경우, 앱이 완전히 종료돼 있었으면 onCreate()가, 이미 실행 중(launchMode
       singleTask)이었으면 onCreate() 없이 onNewIntent()만 불린다 — 둘 다 처리해야
       위젯에서 열 때마다 딥링크가 누락 없이 동작한다. */
    @Override
    public void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        if (BuildConfig.DEBUG) {
            Log.d(TAG, "onNewIntent (already running) intent action extra raw="
                    + (intent == null ? "null-intent" : intent.getStringExtra(WidgetStore.EXTRA_WIDGET_ACTION)));
            dumpExtras("onNewIntent", intent);
        }
        setIntent(intent);
        handleWidgetActionIntent(intent, false);
    }

    /** widget_action extra 값과는 별개로, Intent의 action 문자열(딥링크 4개가 각자 고유하게
        갖고 있음)만으로도 "위젯 버튼이 눌렸었다"는 사실을 알 수 있다 — extra가 유실되는
        버그 상황에서도 진단창이 "무슨 일이 있었는지"를 보여줄 수 있으려면 이 값이 필요하다.
        실제 화면 이동 로직(WidgetStore.setPendingAction 호출 여부)에는 전혀 관여하지 않는,
        순수 진단 전용 값이다. */
    private static String resolveActionFromIntentAction(String intentAction) {
        if (intentAction == null) return null;
        if (intentAction.equals(MedicationWidgetProvider.ACTION_DEEPLINK_SYMPTOM)) return WidgetStore.ACTION_SYMPTOM;
        if (intentAction.equals(MedicationWidgetProvider.ACTION_DEEPLINK_LIFE)) return WidgetStore.ACTION_LIFE;
        if (intentAction.equals(MedicationWidgetProvider.ACTION_DEEPLINK_NOTE)) return WidgetStore.ACTION_NOTE;
        if (intentAction.equals(MedicationWidgetProvider.ACTION_DEEPLINK_SCORE)) return WidgetStore.ACTION_SCORE;
        return null;
    }

    private void handleWidgetActionIntent(Intent intent, boolean coldStart) {
        if (intent == null) {
            if (BuildConfig.DEBUG) {
                Log.d(TAG, "handleWidgetActionIntent: intent null");
                WidgetDiagnostics.record(coldStart, null, null, true, null, false, null);
            }
            return;
        }
        String intentAction = intent.getAction();
        String resolvedFromAction = resolveActionFromIntentAction(intentAction);
        boolean extrasEmpty = (intent.getExtras() == null || intent.getExtras().isEmpty());
        String action = intent.getStringExtra(WidgetStore.EXTRA_WIDGET_ACTION);
        if (action == null) {
            if (BuildConfig.DEBUG) {
                Log.d(TAG, "handleWidgetActionIntent: extra 없음(일반 실행/앱 열기)");
                WidgetDiagnostics.record(coldStart, intentAction, resolvedFromAction, extrasEmpty, null, false, null);
            }
            return;
        }
        if (BuildConfig.DEBUG) Log.d(TAG, "handleWidgetActionIntent action=" + action + " -> setPendingAction()");
        WidgetStore.setPendingAction(this, action);
        if (BuildConfig.DEBUG) {
            // SharedPreferences.apply()는 비동기 디스크 반영이지만, 같은 프로세스 내에서는
            // 메모리 캐시가 즉시 갱신되므로 바로 재확인해도 유효하다 — 여기서 다르게 나오면
            // setPendingAction() 자체가 실패했다는 뜻이니 원인이 여기로 확정된다.
            String readback = WidgetStore.peekPendingAction(this);
            Log.d(TAG, "handleWidgetActionIntent readback after setPendingAction=" + readback
                    + (action.equals(readback) ? " (일치, 정상)" : " (!! action과 불일치 !!)"));
            WidgetDiagnostics.record(coldStart, intentAction, resolvedFromAction, extrasEmpty, action, action.equals(readback), readback);
        }
        // 같은 인텐트가 재전달(예: 화면 회전)될 때 중복 처리되지 않도록 소비 표시를 지운다.
        intent.removeExtra(WidgetStore.EXTRA_WIDGET_ACTION);
    }

    /** intent extras 전체를 키/값 그대로 로그로 남긴다 — widget_action 키가 아예
        다른 이름으로 오거나, extras 자체가 비어 있는지(=OS가 intent를 안 실어준 것인지)
        vs widget_action 키만 없는지(=key 문자열 불일치)를 구분하기 위함. */
    private void dumpExtras(String label, Intent intent) {
        if (intent == null) { Log.d(TAG, label + " extras: intent null"); return; }
        Bundle extras = intent.getExtras();
        if (extras == null) { Log.d(TAG, label + " extras: null(없음)"); return; }
        Set<String> keys = extras.keySet();
        if (keys.isEmpty()) { Log.d(TAG, label + " extras: 비어있음(size=0)"); return; }
        StringBuilder sb = new StringBuilder(label + " extras (size=" + keys.size() + "): ");
        for (String key : keys) {
            Object value = extras.get(key);
            sb.append("[").append(key).append("=").append(value).append("] ");
        }
        Log.d(TAG, sb.toString());
    }
}
