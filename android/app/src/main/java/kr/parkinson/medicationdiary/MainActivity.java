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
        setIntent(intent);
        handleWidgetActionIntent(intent);
    }

    private void handleWidgetActionIntent(Intent intent) {
        if (intent == null) return;
        String action = intent.getStringExtra(WidgetStore.EXTRA_WIDGET_ACTION);
        if (action == null) return;
        if (BuildConfig.DEBUG) Log.d(TAG, "handleWidgetActionIntent action=" + action);
        WidgetStore.setPendingAction(this, action);
        // 같은 인텐트가 재전달(예: 화면 회전)될 때 중복 처리되지 않도록 소비 표시를 지운다.
        intent.removeExtra(WidgetStore.EXTRA_WIDGET_ACTION);
    }
}
