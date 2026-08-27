package kr.parkinson.medicationdiary.widget;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.Context;
import android.content.Intent;
import android.util.Log;
import android.widget.RemoteViews;

import java.text.SimpleDateFormat;
import java.util.Locale;

import kr.parkinson.medicationdiary.BuildConfig;
import kr.parkinson.medicationdiary.MainActivity;
import kr.parkinson.medicationdiary.R;

public class MedicationWidgetProvider extends AppWidgetProvider {

    private static final String TAG = "WIDGET_DEBUG";

    public static final String ACTION_PLUS = "kr.parkinson.medicationdiary.widget.ACTION_PLUS";
    public static final String ACTION_MINUS = "kr.parkinson.medicationdiary.widget.ACTION_MINUS";
    public static final String ACTION_RECORD = "kr.parkinson.medicationdiary.widget.ACTION_RECORD";
    public static final String ACTION_TREND_RISING = "kr.parkinson.medicationdiary.widget.ACTION_TREND_RISING";
    public static final String ACTION_TREND_STABLE = "kr.parkinson.medicationdiary.widget.ACTION_TREND_STABLE";
    public static final String ACTION_TREND_FALLING = "kr.parkinson.medicationdiary.widget.ACTION_TREND_FALLING";

    /** 증상/생활/느낌메모/점수매기기 딥링크 전용 Intent action. requestCode만 다르고
        나머지(컴포넌트/action/data/category)가 전부 같은 Intent 4개를 만들면, 일부
        기기(삼성 One UI 등)의 위젯 클릭 처리 경로에서 requestCode 구분을 무시하고
        extra가 유실/뒤섞이는 사례가 실기기 로그로 확인됐다(onCreate extras: empty).
        각 버튼마다 action 문자열 자체를 다르게 줘서 4개가 어떤 기준으로도 절대
        같은 Intent로 간주되지 않게 한다.
        해당 버튼들은 QuickRecordWidgetProvider(빠른 기록 위젯)로 분리됐지만,
        MainActivity.resolveActionFromIntentAction()이 이 상수들을 참조하므로
        정의는 여기 그대로 둔다. */
    public static final String ACTION_DEEPLINK_SYMPTOM = "kr.parkinson.medicationdiary.widget.DEEPLINK_SYMPTOM";
    public static final String ACTION_DEEPLINK_LIFE = "kr.parkinson.medicationdiary.widget.DEEPLINK_LIFE";
    public static final String ACTION_DEEPLINK_NOTE = "kr.parkinson.medicationdiary.widget.DEEPLINK_NOTE";
    public static final String ACTION_DEEPLINK_SCORE = "kr.parkinson.medicationdiary.widget.DEEPLINK_SCORE";

    @Override
    public void onUpdate(Context context, AppWidgetManager appWidgetManager, int[] appWidgetIds) {
        if (BuildConfig.DEBUG) Log.d(TAG, "onUpdate ids=" + appWidgetIds.length);
        updateWidgets(context, appWidgetManager, appWidgetIds);
    }

    @Override
    public void onReceive(Context context, Intent intent) {
        super.onReceive(context, intent);
        String action = intent.getAction();
        if (BuildConfig.DEBUG) Log.d(TAG, "onReceive action=" + action);
        if (action == null) return;

        if (ACTION_PLUS.equals(action)) {
            int before = WidgetStore.getDisplayOutput(context);
            WidgetStore.adjustPending(context, 10);
            if (BuildConfig.DEBUG) Log.d(TAG, "plus clicked before=" + before + " after=" + WidgetStore.getDisplayOutput(context));
            WidgetStore.requestWidgetRefresh(context);
        } else if (ACTION_MINUS.equals(action)) {
            int before = WidgetStore.getDisplayOutput(context);
            WidgetStore.adjustPending(context, -10);
            if (BuildConfig.DEBUG) Log.d(TAG, "minus clicked before=" + before + " after=" + WidgetStore.getDisplayOutput(context));
            WidgetStore.requestWidgetRefresh(context);
        } else if (ACTION_RECORD.equals(action)) {
            int value = WidgetStore.getDisplayOutput(context);
            long ts = System.currentTimeMillis();
            if (BuildConfig.DEBUG) Log.d(TAG, "record clicked value=" + value + " trend=" + WidgetStore.getTrend(context) + " ts=" + ts);
            WidgetStore.commitRecord(context, ts);
            if (BuildConfig.DEBUG) {
                int pendingCount = WidgetStore.peekPendingRecords(context).length();
                Log.d(TAG, "pending saved count=" + pendingCount);
            }
            WidgetStore.requestWidgetRefresh(context);
        } else if (ACTION_TREND_RISING.equals(action)) {
            WidgetStore.setTrend(context, "rising");
            WidgetStore.requestWidgetRefresh(context);
        } else if (ACTION_TREND_STABLE.equals(action)) {
            WidgetStore.setTrend(context, "stable");
            WidgetStore.requestWidgetRefresh(context);
        } else if (ACTION_TREND_FALLING.equals(action)) {
            WidgetStore.setTrend(context, "falling");
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
        RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.widget_medication);

        int output = WidgetStore.getDisplayOutput(context);
        long lastTs = WidgetStore.getLastTs(context);

        views.setTextViewText(R.id.widget_output_value, String.valueOf(output));

        if (lastTs > 0) {
            String time = new SimpleDateFormat("HH:mm", Locale.getDefault()).format(lastTs);
            views.setTextViewText(R.id.widget_last_ts,
                    context.getString(R.string.widget_last_record_prefix) + " " + time);
        } else {
            views.setTextViewText(R.id.widget_last_ts, context.getString(R.string.widget_no_record));
        }

        views.setOnClickPendingIntent(R.id.widget_btn_plus, actionPendingIntent(context, ACTION_PLUS, 1));
        views.setOnClickPendingIntent(R.id.widget_btn_minus, actionPendingIntent(context, ACTION_MINUS, 2));
        views.setOnClickPendingIntent(R.id.widget_btn_record, actionPendingIntent(context, ACTION_RECORD, 3));
        views.setOnClickPendingIntent(R.id.widget_btn_open, openAppPendingIntent(context));

        String trend = WidgetStore.getTrend(context);
        views.setInt(R.id.widget_btn_trend_rising, "setBackgroundResource",
                "rising".equals(trend) ? R.drawable.widget_trend_rising_selected : R.drawable.widget_button_secondary);
        views.setInt(R.id.widget_btn_trend_stable, "setBackgroundResource",
                "stable".equals(trend) ? R.drawable.widget_trend_stable_selected : R.drawable.widget_button_secondary);
        views.setInt(R.id.widget_btn_trend_falling, "setBackgroundResource",
                "falling".equals(trend) ? R.drawable.widget_trend_falling_selected : R.drawable.widget_button_secondary);
        views.setOnClickPendingIntent(R.id.widget_btn_trend_rising, actionPendingIntent(context, ACTION_TREND_RISING, 5));
        views.setOnClickPendingIntent(R.id.widget_btn_trend_stable, actionPendingIntent(context, ACTION_TREND_STABLE, 6));
        views.setOnClickPendingIntent(R.id.widget_btn_trend_falling, actionPendingIntent(context, ACTION_TREND_FALLING, 7));

        return views;
    }

    private static PendingIntent actionPendingIntent(Context context, String action, int requestCode) {
        Intent intent = new Intent(context, MedicationWidgetProvider.class);
        intent.setAction(action);
        return PendingIntent.getBroadcast(context, requestCode, intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    private static PendingIntent openAppPendingIntent(Context context) {
        Intent intent = new Intent(context, MainActivity.class);
        intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        return PendingIntent.getActivity(context, 4, intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }
}
