package org.surge.notes;

import android.graphics.Point;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.WindowInsets;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    private int lastVisibleHeight = -1;

    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (bridge != null && bridge.getWebView() != null) {
            bridge.getWebView().getSettings().setSupportZoom(false);
            bridge.getWebView().getSettings().setBuiltInZoomControls(false);
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            View decor = getWindow().getDecorView();
            decor.getViewTreeObserver().addOnGlobalLayoutListener(() -> {
                WindowInsets insets = decor.getRootWindowInsets();
                if (insets == null || bridge == null || bridge.getWebView() == null) return;
                Point screen = new Point();
                getWindowManager().getDefaultDisplay().getRealSize(screen);
                int visibleHeight = Math.max(0, screen.y - insets.getInsets(WindowInsets.Type.ime()).bottom);
                if (Math.abs(visibleHeight - lastVisibleHeight) < 2) return;
                lastVisibleHeight = visibleHeight;
                float cssHeight = visibleHeight / getResources().getDisplayMetrics().density;
                bridge.getWebView().evaluateJavascript(
                    "window.surgeSetVisibleHeight && window.surgeSetVisibleHeight(" + cssHeight + ")", null
                );
            });
        }
    }

    @Override
    public void onBackPressed() {
        if (bridge == null || bridge.getWebView() == null) {
            super.onBackPressed();
            return;
        }
        bridge.getWebView().evaluateJavascript(
            "Boolean(window.surgeHandleBack && window.surgeHandleBack())",
            result -> {
                if (!"true".equals(result)) MainActivity.super.onBackPressed();
            }
        );
    }
}
