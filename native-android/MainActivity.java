package studio.seedream.agent;

import android.os.Bundle;
import android.webkit.WebView;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(GallerySavePlugin.class);
        registerPlugin(KeepAlivePlugin.class);
        super.onCreate(savedInstanceState);
    }

    @Override
    public void onPause() {
        super.onPause();
        if (KeepAlivePlugin.isActive()) {
            resumeGenerationWebView();
        }
    }

    @Override
    public void onStop() {
        super.onStop();
        if (KeepAlivePlugin.isActive()) {
            resumeGenerationWebView();
        }
    }

    private void resumeGenerationWebView() {
        if (getBridge() == null) return;
        WebView webView = getBridge().getWebView();
        if (webView == null) return;
        webView.onResume();
        webView.resumeTimers();
    }
}
