package com.galaxysms.chat;

import android.Manifest;
import android.app.Activity;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.os.Vibrator;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;

public class MainActivity extends Activity {

    private WebView webView;
    private static final String CHANNEL_ID = "galaxy_chat_notifications";
    private static final String PREF_NAME = "galaxy_chat_prefs";
    private static final AtomicInteger notifSeq = new AtomicInteger(1000);

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        createNotificationChannel();
        requestRuntimePermissions();

        webView = findViewById(R.id.webView);
        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(true);
        settings.setAllowContentAccess(true);
        settings.setLoadsImagesAutomatically(true);
        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(true);
        settings.setSupportZoom(false);
        settings.setDisplayZoomControls(false);
        settings.setMediaPlaybackRequiresUserGesture(false);

        // Security: Disable file access from file URLs
        settings.setAllowFileAccessFromFileURLs(false);
        settings.setAllowUniversalAccessFromFileURLs(false);

        webView.setBackgroundColor(Color.parseColor("#070D1F"));

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, String url) {
                if (url.startsWith("file:///android_asset/")) {
                    view.loadUrl(url);
                    return true;
                }
                return false;
            }
        });

        // WebChromeClient for dialogs
        webView.setWebChromeClient(new WebChromeClient());

        // Expose Native Android Bridge to the WebView
        webView.addJavascriptInterface(new WebAppInterface(this), "GalaxyNative");

        webView.loadUrl("file:///android_asset/index.html");
    }

    private void requestRuntimePermissions() {
        if (Build.VERSION.SDK_INT >= 33) {
            boolean needNotif = checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED;
            if (needNotif) {
                requestPermissions(new String[]{
                    Manifest.permission.POST_NOTIFICATIONS
                }, 101);
            }
        }
    }

    @Override
    public void onBackPressed() {
        // Allow JS single-page app to navigate back inside chats
        webView.evaluateJavascript("if(window.handleAppBack){window.handleAppBack()}else{false}", val -> {
            if (!"true".equals(val)) {
                super.onBackPressed();
            }
        });
    }

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            CharSequence name = "Galaxy Chat Messages";
            String description = "Incoming messages and complaint updates";
            int importance = NotificationManager.IMPORTANCE_HIGH;
            NotificationChannel channel = new NotificationChannel(CHANNEL_ID, name, importance);
            channel.setDescription(description);
            channel.enableLights(true);
            channel.setLightColor(Color.parseColor("#30ABED"));
            channel.enableVibration(true);
            channel.setVibrationPattern(new long[]{0, 180, 80, 180});

            NotificationManager notificationManager = getSystemService(NotificationManager.class);
            if (notificationManager != null) {
                notificationManager.createNotificationChannel(channel);
            }
        }
    }

    public class WebAppInterface {
        Context context;

        WebAppInterface(Context c) {
            context = c;
        }

        @JavascriptInterface
        public String getDeviceToken() {
            SharedPreferences prefs = context.getSharedPreferences(PREF_NAME, Context.MODE_PRIVATE);
            String token = prefs.getString("device_token", null);
            if (token == null) {
                token = "gxc_droid_" + UUID.randomUUID().toString();
                prefs.edit().putString("device_token", token).apply();
            }
            return token;
        }

        @JavascriptInterface
        public void savePref(String key, String value) {
            SharedPreferences prefs = context.getSharedPreferences(PREF_NAME, Context.MODE_PRIVATE);
            prefs.edit().putString(key, value).apply();
        }

        @JavascriptInterface
        public String getPref(String key) {
            SharedPreferences prefs = context.getSharedPreferences(PREF_NAME, Context.MODE_PRIVATE);
            return prefs.getString(key, "");
        }

        @JavascriptInterface
        public void vibrate(long ms) {
            try {
                Vibrator v = (Vibrator) context.getSystemService(Context.VIBRATOR_SERVICE);
                if (v != null) v.vibrate(ms);
            } catch (Exception e) {}
        }

        @JavascriptInterface
        public void toast(String msg) {
            runOnUiThread(() -> Toast.makeText(context, msg, Toast.LENGTH_SHORT).show());
        }

        @JavascriptInterface
        public void showNotification(String title, String body) {
            try {
                NotificationManager nm = (NotificationManager) context.getSystemService(Context.NOTIFICATION_SERVICE);
                if (nm == null) return;

                int notifId = notifSeq.incrementAndGet();

                Intent intent = new Intent(context, MainActivity.class);
                intent.setFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);
                PendingIntent pendingIntent = PendingIntent.getActivity(
                    context, notifId, intent,
                    PendingIntent.FLAG_UPDATE_CURRENT | (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M ? PendingIntent.FLAG_IMMUTABLE : 0)
                );

                android.app.Notification.Builder builder;
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                    builder = new android.app.Notification.Builder(context, CHANNEL_ID);
                } else {
                    builder = new android.app.Notification.Builder(context);
                }

                builder.setContentTitle(title)
                       .setContentText(body)
                       .setSmallIcon(R.drawable.ic_launcher)
                       .setContentIntent(pendingIntent)
                       .setPriority(android.app.Notification.PRIORITY_HIGH)
                       .setDefaults(android.app.Notification.DEFAULT_ALL)
                       .setAutoCancel(true);

                nm.notify(notifId, builder.build());
            } catch (Exception e) {}
        }
    }
}
