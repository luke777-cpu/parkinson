package kr.parkinson.medicationdiary;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

import kr.parkinson.medicationdiary.widget.WidgetBridgePlugin;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(WidgetBridgePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
