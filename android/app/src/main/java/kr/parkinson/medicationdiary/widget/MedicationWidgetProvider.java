package kr.parkinson.medicationdiary.widget;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.Context;
import android.content.Intent;
import android.widget.RemoteViews;

import java.text.SimpleDateFormat;
import java.util.Locale;

import kr.parkinson.medicationdiary.MainActivity;
import kr.parkinson.medicationdiary.R;

public class MedicationWidgetProvider extends AppWidgetProvider {

    public static final String ACTION_PLUS = "kr.parkinson.medicationdiary.widget.ACTION_PLUS";
    public static final String ACTION_MINUS = "kr.parkinson.medicationdiary.widget.ACTION_MINUS";
    public static final String ACTION_RECORD = "kr.parkinson.medicationdiary.widget.ACTION_RECORD";

    @Override
    public void onUpdate(Context context, AppWidgetManager appWidgetManager, int[] appWidgetIds) {
        updateWidgets(context, appWidgetManager, appWidgetIds);
    }

    @Override
    public void onReceive(Context context, Intent intent) {
        super.onReceive(context, intent);
        String action = intent.getAction();
        if (action == null) return;

        if (ACTION_PLUS.equals(action)) {
            WidgetStore.adjustPending(context, 10);
            WidgetStore.requestWidgetRefresh(context);
        } else if (ACTION_MINUS.equals(action)) {
            WidgetStore.adjustPending(context, -10);
            WidgetStore.requestWidgetRefresh(context);
        } else if (ACTION_RECORD.equals(action)) {
            WidgetStore.commitRecord(context, System.currentTimeMillis());
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
