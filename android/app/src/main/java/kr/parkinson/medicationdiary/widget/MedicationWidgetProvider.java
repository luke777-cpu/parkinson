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
    /** "임시기록"만 출력값 없이 방향만 즉시 저장하므로 +10/-10/기록과 같은 네이티브
        브로드캐스트 방식. 증상/생활/느낌메모/점수매기기는 세부 선택이 여럿이라
        RemoteViews로 대신 골라줄 수 없어 앱을 열어 기존 화면으로 보낸다(딥링크). */
    public static final String ACTION_QUICK_TEMPNOTE = "kr.parkinson.medicationdiary.widget.ACTION_QUICK_TEMPNOTE";

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
        } else if (ACTION_QUICK_TEMPNOTE.equals(action)) {
            long ts = System.currentTimeMillis();
            if (BuildConfig.DEBUG) Log.d(TAG, "quick action clicked type=tempnote trend=" + WidgetStore.getTrend(context) + " ts=" + ts);
            WidgetStore.commitTempNote(context, ts);
            if (BuildConfig.DEBUG) {
                int pendingCount = WidgetStore.peekPendingRecords(context).length();
                Log.d(TAG, "pending saved count=" + pendingCount);
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

        views.setOnClickPendingIntent(R.id.widget_btn_quick_tempnote, actionPendingIntent(context, ACTION_QUICK_TEMPNOTE, 8));
        views.setOnClickPendingIntent(R.id.widget_btn_quick_symptom, deepLinkPendingIntent(context, WidgetStore.ACTION_SYMPTOM, 9));
        views.setOnClickPendingIntent(R.id.widget_btn_quick_life, deepLinkPendingIntent(context, WidgetStore.ACTION_LIFE, 10));
        views.setOnClickPendingIntent(R.id.widget_btn_quick_note, deepLinkPendingIntent(context, WidgetStore.ACTION_NOTE, 11));
        views.setOnClickPendingIntent(R.id.widget_btn_quick_score, deepLinkPendingIntent(context, WidgetStore.ACTION_SCORE, 12));

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

    /** "증상"/"생활"/"지금 느낌 메모"/"점수 매기기" — 앱을 열되 어느 화면으로 가야
        하는지 extra로 실어 보낸다. requestCode를 버튼마다 다르게 줘야 한다 —
        FLAG_UPDATE_CURRENT로 같은 requestCode를 재사용하면 먼저 만든 PendingIntent의
        extra가 나중 것으로 덮여써져서(예: "앱 열기"용 4번을 같이 쓰면) 서로 다른
        딥링크 버튼이 전부 마지막에 만든 것과 같은 동작을 하게 되는 사고로 이어진다. */
    private static PendingIntent deepLinkPendingIntent(Context context, String widgetAction, int requestCode) {
        /* 주의: 이 로그는 위젯이 "그려질 때"(buildViews) 한 번 찍히는 것이지, 버튼을
           "누를 때" 찍히는 게 아니다 — PendingIntent.getActivity()로 만든 딥링크는
           탭하면 Android가 직접 MainActivity를 여는 것이라 이 앱의 코드(onReceive 등)를
           거치지 않는다. 그래서 "버튼을 눌렀을 때"의 로그는 여기가 아니라 항상
           MainActivity.onCreate()/onNewIntent()에서부터 시작된다. */
        if (BuildConfig.DEBUG) Log.d(TAG, "deepLinkPendingIntent built action=" + widgetAction + " requestCode=" + requestCode);
        Intent intent = new Intent(context, MainActivity.class);
        intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        intent.putExtra(WidgetStore.EXTRA_WIDGET_ACTION, widgetAction);
        return PendingIntent.getActivity(context, requestCode, intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }
}
