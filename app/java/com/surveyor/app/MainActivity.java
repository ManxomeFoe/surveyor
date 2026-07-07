package com.surveyor.app;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Insets;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.View;
import android.view.WindowInsets;
import android.view.WindowManager;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

/**
 * Surveyor: a full-screen WebView shell around the offline web app at
 * file:///android_asset/www/index.html. No androidx, no external deps.
 */
public class MainActivity extends Activity {

    /** Near-black matching the web app's top bar, shown under the system bars. */
    private static final int BG_COLOR = 0xFF1C1E26;

    private static final String START_URL = "file:///android_asset/www/index.html";

    private static final int REQUEST_FILE_CHOOSER = 1001;

    private WebView webView;
    private SurveyorBridge bridge;

    /** Pending <input type=file> callback; non-null while a chooser is open. */
    private ValueCallback<Uri[]> filePathCallback;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // Field-survey tool: keep the screen on while in the foreground.
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        getWindow().getDecorView().setBackgroundColor(BG_COLOR);

        webView = new WebView(this);
        webView.setBackgroundColor(BG_COLOR);

        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setAllowFileAccess(true);
        s.setAllowFileAccessFromFileURLs(true);
        s.setAllowUniversalAccessFromFileURLs(true);
        // The web app implements its own pinch-zoom; keep WebView zoom off.
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setDisplayZoomControls(false);
        // Ignore the system font scale so it can't break the layout.
        s.setTextZoom(100);

        // Keep all navigation inside the WebView.
        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                return false;
            }

            @SuppressWarnings("deprecation")
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                return false;
            }
        });

        // <input type=file> support: without onShowFileChooser the picker
        // silently never opens inside a WebView.
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view,
                                             ValueCallback<Uri[]> callback,
                                             FileChooserParams fileChooserParams) {
                return MainActivity.this.showFileChooser(callback, fileChooserParams);
            }
        });

        // v1.1+: native blob storage for user-uploaded maps and (v1.3) the
        // self-update download (window.SurveyorNative). Safe to expose: this
        // WebView only ever loads our own bundled file:///android_asset/www/
        // pages — the WebViewClient keeps navigation internal and no remote
        // content is ever rendered — so nothing untrusted can reach the bridge.
        bridge = new SurveyorBridge(this, webView);
        webView.addJavascriptInterface(bridge, "SurveyorNative");

        // targetSdk 36 forces edge-to-edge on Android 15/16. A WebView ignores
        // its own View padding when laying out web content, so insets must be
        // applied to a wrapping container instead: the FrameLayout's padding
        // shrinks the WebView's bounds and the padded strips show BG_COLOR
        // behind the status/navigation bars. IME insets are included so the
        // on-screen keyboard pushes content up instead of covering it.
        final FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(BG_COLOR);
        root.addView(webView, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        root.setOnApplyWindowInsetsListener(new View.OnApplyWindowInsetsListener() {
            @Override
            public WindowInsets onApplyWindowInsets(View v, WindowInsets insets) {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                    Insets bars = insets.getInsets(
                            WindowInsets.Type.systemBars()
                            | WindowInsets.Type.displayCutout()
                            | WindowInsets.Type.ime());
                    v.setPadding(bars.left, bars.top, bars.right, bars.bottom);
                    return WindowInsets.CONSUMED;
                } else {
                    @SuppressWarnings("deprecation")
                    int left = insets.getSystemWindowInsetLeft();
                    @SuppressWarnings("deprecation")
                    int top = insets.getSystemWindowInsetTop();
                    @SuppressWarnings("deprecation")
                    int right = insets.getSystemWindowInsetRight();
                    @SuppressWarnings("deprecation")
                    int bottom = insets.getSystemWindowInsetBottom();
                    v.setPadding(left, top, right, bottom);
                    @SuppressWarnings("deprecation")
                    WindowInsets consumed = insets.consumeSystemWindowInsets();
                    return consumed;
                }
            }
        });

        setContentView(root);
        webView.loadUrl(START_URL);
    }

    /**
     * Opens the system document picker for an <input type=file> request.
     * Classic startActivityForResult flow (plain Activity, no androidx).
     */
    private boolean showFileChooser(ValueCallback<Uri[]> callback,
                                    WebChromeClient.FileChooserParams params) {
        if (filePathCallback != null) {
            // A chooser is already pending; cancel the NEW request rather than
            // leaking the old callback (a leaked callback breaks all future
            // choosers in this WebView).
            callback.onReceiveValue(null);
            return true;
        }
        filePathCallback = callback;

        Intent intent = null;
        try {
            intent = params.createIntent();
        } catch (Throwable ignored) {
            // fall through to the generic intent below
        }
        if (intent == null) {
            intent = buildFallbackChooserIntent();
        }

        try {
            startActivityForResult(intent, REQUEST_FILE_CHOOSER);
        } catch (Throwable first) {
            // e.g. ActivityNotFoundException for an exotic createIntent();
            // retry once with the generic ACTION_GET_CONTENT intent.
            try {
                startActivityForResult(buildFallbackChooserIntent(), REQUEST_FILE_CHOOSER);
            } catch (Throwable second) {
                filePathCallback.onReceiveValue(null);
                filePathCallback = null;
            }
        }
        return true;
    }

    private static Intent buildFallbackChooserIntent() {
        Intent intent = new Intent(Intent.ACTION_GET_CONTENT);
        intent.addCategory(Intent.CATEGORY_OPENABLE);
        intent.setType("*/*");
        return intent;
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQUEST_FILE_CHOOSER) {
            if (filePathCallback != null) {
                // parseResult returns null on cancel — exactly what the
                // callback expects; always deliver and clear so the WebView
                // never waits on a stale callback.
                Uri[] result = WebChromeClient.FileChooserParams.parseResult(resultCode, data);
                filePathCallback.onReceiveValue(result);
                filePathCallback = null;
            }
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    /** Routes the v1.6 location permission result back to the bridge. */
    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions,
                                           int[] grantResults) {
        if (requestCode == SurveyorBridge.REQUEST_LOCATION_PERMISSION) {
            if (bridge != null) {
                bridge.onLocationPermissionResult(grantResults);
            }
            return;
        }
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
    }

    /**
     * Classic back handling (manifest sets enableOnBackInvokedCallback="false"
     * so this keeps working on Android 13+): walk WebView history first.
     */
    @Override
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (webView != null) {
            webView.onResume();
        }
        if (bridge != null) {
            bridge.onActivityResume(); // re-attach location updates if JS wants them
        }
    }

    @Override
    protected void onPause() {
        if (bridge != null) {
            bridge.onActivityPause(); // release the location listener while backgrounded
        }
        if (webView != null) {
            webView.onPause();
        }
        super.onPause();
    }

    @Override
    protected void onDestroy() {
        if (webView != null) {
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}
