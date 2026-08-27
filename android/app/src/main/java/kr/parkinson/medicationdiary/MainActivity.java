package kr.parkinson.medicationdiary;

import android.os.Bundle;
import android.util.Log;

import com.getcapacitor.BridgeActivity;

import kr.parkinson.medicationdiary.filesaver.FileSaverPlugin;
import kr.parkinson.medicationdiary.widget.WidgetBridgePlugin;

public class MainActivity extends BridgeActivity {
    private static final String TAG = "WIDGET_DEBUG";

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(WidgetBridgePlugin.class);
        if (BuildConfig.DEBUG) Log.d(TAG, "registerPlugin(WidgetBridgePlugin) done");
        registerPlugin(FileSaverPlugin.class);
        if (BuildConfig.DEBUG) Log.d(TAG, "registerPlugin(FileSaverPlugin) done");
        super.onCreate(savedInstanceState);
    }
}
