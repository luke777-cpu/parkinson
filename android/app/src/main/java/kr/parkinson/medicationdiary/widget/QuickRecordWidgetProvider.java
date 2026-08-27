package kr.parkinson.medicationdiary.widget;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.Context;
import android.content.Intent;
import android.util.Log;
import android.widget.RemoteViews;

import kr.parkinson.medicationdiary.BuildConfig;
import kr.parkinson.medicationdiary.MainActivity;
import kr.parkinson.medicationdiary.R;

/**
 * "빠른 기록" 전용 소형(4x2) 위젯.
 *
 * 원래는 기록 위젯(MedicationWidgetProvider) 하단에 이 버튼들을 붙였으나,
 * 위젯 하나가 세로 5~7칸까지 커지면서 삼성 One UI가 배치 자체를 거부하는
 * 문제("위젯을 추가할 수 없습니다")가 실기기에서 확인됐다. 그래서 실기기에서
 * 배치가 검증된 크기(기록 위젯 4x4)로 되돌리고, 빠른 기록 버튼들은 이
 * 독립 위젯으로 분리했다 — 사용자는 둘 중 원하는 것만 선택적으로 배치한다.
 *
 * 데이터는 기록 위젯과 동일한 WidgetStore(SharedPreferences)를 공유하므로
 * 여기서 남긴 임시기록도 같은 pending_records 큐로 들어가 앱이 열릴 때
 * ingestWidgetEvents()가 그대로 편입한다.
 */
public class QuickRecordWidgetProvider extends AppWidgetProvider {

    private static final String TAG = "WIDGET_DEBUG";

    /** 임시기록: 출력값 없이 현재 방향(trend)만 즉시 저장 — 앱을 열 필요가 없어
        MainActivity 딥링크가 아니라 이 Provider로의 브로드캐스트로 처리한다.
        (explicit Intent라 문자열이 겹쳐도 무방하지만, 로그에서 어느 위젯이
        보냈는지 구분되도록 고유 문자열을 준다.) */
    public static final String ACTION_QUICK_TEMPNOTE = "kr.parkinson.medicationdiary.widget.QUICKW_TEMPNOTE";

    @Override
    public void onUpdate(Context context, AppWidgetManager appWidgetManager, int[] appWidgetIds) {
        if (BuildConfig.DEBUG) Log.d(TAG, "quickw onUpdate ids=" + appWidgetIds.length);
        updateWidgets(context, appWidgetManager, appWidgetIds);
    }

    @Override
    public void onReceive(Context context, Intent intent) {
        super.onReceive(context, intent);
        String action = intent.getAction();
        if (BuildConfig.DEBUG) Log.d(TAG, "quickw onReceive action=" + action);
        if (ACTION_QUICK_TEMPNOTE.equals(action)) {
            long ts = System.currentTimeMillis();
            if (BuildConfig.DEBUG) Log.d(TAG, "quickw tempnote clicked trend=" + WidgetStore.getTrend(context) + " ts=" + ts);
            WidgetStore.commitTempNote(context, ts);
            if (BuildConfig.DEBUG) {
                int pendingCount = WidgetStore.peekPendingRecords(context).length();
                Log.d(TAG, "quickw pending saved count=" + pendingCount);
            }
            WidgetStore.requestWidgetRefresh(context);
        }
    }

    static void updateWidgets(Context context, AppWidgetManager appWidgetManager, int[] appWidgetIds) {
        RemoteViews views = buildViews(context);
        for (int appWidgetId : appWidgetIds) {
            appWidgetManager.updateAppWidget(appWidgetId, views);
        }
    }

    private static RemoteViews buildViews(Context context) {
        RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.widget_quick_record);

        Intent tempnote = new Intent(context, QuickRecordWidgetProvider.class);
        tempnote.setAction(ACTION_QUICK_TEMPNOTE);
        views.setOnClickPendingIntent(R.id.quickw_btn_tempnote,
                PendingIntent.getBroadcast(context, 20, tempnote,
                        PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE));

        views.setOnClickPendingIntent(R.id.quickw_btn_symptom,
                deepLinkPendingIntent(context, WidgetStore.ACTION_SYMPTOM, 21, MedicationWidgetProvider.ACTION_DEEPLINK_SYMPTOM));
        views.setOnClickPendingIntent(R.id.quickw_btn_life,
                deepLinkPendingIntent(context, WidgetStore.ACTION_LIFE, 22, MedicationWidgetProvider.ACTION_DEEPLINK_LIFE));
        views.setOnClickPendingIntent(R.id.quickw_btn_note,
                deepLinkPendingIntent(context, WidgetStore.ACTION_NOTE, 23, MedicationWidgetProvider.ACTION_DEEPLINK_NOTE));
        views.setOnClickPendingIntent(R.id.quickw_btn_score,
                deepLinkPendingIntent(context, WidgetStore.ACTION_SCORE, 24, MedicationWidgetProvider.ACTION_DEEPLINK_SCORE));

        return views;
    }

    /** 증상/생활/느낌메모/점수매기기 — 앱을 열되 어느 화면으로 가야 하는지 extra로
        전달한다. Intent action 문자열을 버튼마다 고유하게 주는 이유는
        MedicationWidgetProvider.ACTION_DEEPLINK_* 상수의 주석 참조(삼성 One UI에서
        requestCode만 다른 동일 Intent들의 extra가 유실되는 실기기 사례 대응).
        MainActivity.resolveActionFromIntentAction()이 이 action 문자열들을 그대로
        해석하므로 상수를 재사용해야 한다 — 새 문자열을 만들면 안 된다. */
    private static PendingIntent deepLinkPendingIntent(Context context, String widgetAction, int requestCode, String intentAction) {
        Intent intent = new Intent(context, MainActivity.class);
        intent.setAction(intentAction);
        intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        intent.putExtra(WidgetStore.EXTRA_WIDGET_ACTION, widgetAction);
        if (BuildConfig.DEBUG) {
            Log.d(TAG, "quickw deepLinkPendingIntent built action=" + widgetAction + " requestCode=" + requestCode
                    + " intentAction=" + intentAction);
        }
        return PendingIntent.getActivity(context, requestCode, intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }
}
