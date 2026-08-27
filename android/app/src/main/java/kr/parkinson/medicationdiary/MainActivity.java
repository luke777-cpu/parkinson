package kr.parkinson.medicationdiary;

import android.content.Intent;
import android.os.Bundle;
import android.util.Log;

import com.getcapacitor.BridgeActivity;

import kr.parkinson.medicationdiary.filesaver.FileSaverPlugin;
import kr.parkinson.medicationdiary.widget.WidgetBridgePlugin;
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
        }
        super.onCreate(savedInstanceState);
        handleWidgetActionIntent(getIntent());
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
        }
        setIntent(intent);
        handleWidgetActionIntent(intent);
    }

    private void handleWidgetActionIntent(Intent intent) {
        if (intent == null) { if (BuildConfig.DEBUG) Log.d(TAG, "handleWidgetActionIntent: intent null"); return; }
        String action = intent.getStringExtra(WidgetStore.EXTRA_WIDGET_ACTION);
        if (action == null) { if (BuildConfig.DEBUG) Log.d(TAG, "handleWidgetActionIntent: extra 없음(일반 실행/앱 열기)"); return; }
        if (BuildConfig.DEBUG) Log.d(TAG, "handleWidgetActionIntent action=" + action + " -> setPendingAction()");
        WidgetStore.setPendingAction(this, action);
        if (BuildConfig.DEBUG) {
            // SharedPreferences.apply()는 비동기 디스크 반영이지만, 같은 프로세스 내에서는
            // 메모리 캐시가 즉시 갱신되므로 바로 재확인해도 유효하다 — 여기서 다르게 나오면
            // setPendingAction() 자체가 실패했다는 뜻이니 원인이 여기로 확정된다.
            String readback = WidgetStore.peekPendingAction(this);
            Log.d(TAG, "handleWidgetActionIntent readback after setPendingAction=" + readback
                    + (action.equals(readback) ? " (일치, 정상)" : " (!! action과 불일치 !!)"));
        }
        // 같은 인텐트가 재전달(예: 화면 회전)될 때 중복 처리되지 않도록 소비 표시를 지운다.
        intent.removeExtra(WidgetStore.EXTRA_WIDGET_ACTION);
    }
}
