package com.classcheckin.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;

/**
 * 后台盯着"有没有新签到"：app 退到后台也能收到通知。
 * 每 60 秒问一次 /api/sign/active，发现新的场次就发一条系统通知。
 */
public class WatchService extends Service {
    private static final String PREFS = "checkin";
    private static final String KEY_TOKEN = "session_token";   // 必须与 MainActivity.KEY_TOKEN 一致
    private static final String KEY_SEEN = "watch_seen_session";
    private static final String CH_RUN = "watch_run";
    private static final String CH_ALERT = "watch_alert";
    private static final int ID_RUN = 9001;
    private static final int ID_ALERT = 9002;
    private static final long INTERVAL = 60000L;

    private final Handler handler = new Handler(Looper.getMainLooper());
    private boolean looping = false;

    private final Runnable tick = new Runnable() {
        @Override
        public void run() {
            if (!looping) {
                return;
            }
            final Context ctx = getApplicationContext();
            new Thread(new Runnable() {
                @Override
                public void run() {
                    poll(ctx);
                }
            }).start();
            handler.postDelayed(this, INTERVAL);
        }
    };

    public static void start(Context context) {
        try {
            Intent intent = new Intent(context, WatchService.class);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(intent);
            } else {
                context.startService(intent);
            }
        } catch (Exception ignored) {
            // 后台启动被系统限制时忽略
        }
    }

    public static void stop(Context context) {
        try {
            context.stopService(new Intent(context, WatchService.class));
        } catch (Exception ignored) {
            // ignore
        }
    }

    @Override
    public void onCreate() {
        super.onCreate();
        createChannels();
        try {
            startForeground(ID_RUN, runningNotification());
        } catch (Exception ignored) {
            // ignore
        }
        looping = true;
        handler.post(tick);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (!looping) {
            looping = true;
            handler.post(tick);
        }
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        looping = false;
        handler.removeCallbacks(tick);
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    private SharedPreferences prefs() {
        return getSharedPreferences(PREFS, MODE_PRIVATE);
    }

    private void createChannels() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return;
        }
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) {
            return;
        }
        NotificationChannel run = new NotificationChannel(CH_RUN, "后台值守", NotificationManager.IMPORTANCE_MIN);
        run.setShowBadge(false);
        run.setDescription("保持接收新签到提醒");
        manager.createNotificationChannel(run);
        NotificationChannel alert = new NotificationChannel(CH_ALERT, "签到提醒", NotificationManager.IMPORTANCE_HIGH);
        alert.setShowBadge(true);
        alert.setDescription("有新的签到发布时提醒我");
        manager.createNotificationChannel(alert);
    }

    private PendingIntent openApp() {
        Intent intent = new Intent(this, MainActivity.class);
        intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
        int flag = Build.VERSION.SDK_INT >= Build.VERSION_CODES.M ? PendingIntent.FLAG_IMMUTABLE : 0;
        return PendingIntent.getActivity(this, 0, intent, flag);
    }

    private Notification runningNotification() {
        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(this, CH_RUN) : new Notification.Builder(this);
        return builder
                .setContentTitle("班级签到值守中")
                .setContentText("有新签到会第一时间提醒你")
                .setSmallIcon(android.R.drawable.ic_menu_my_calendar)
                .setContentIntent(openApp())
                .setOngoing(true)
                .build();
    }

    private void notifyNewSession(String title, String when) {
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) {
            return;
        }
        Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
                ? new Notification.Builder(this, CH_ALERT) : new Notification.Builder(this);
        Notification note = builder
                .setContentTitle("新的签到已发布")
                .setContentText(title + (when.length() > 0 ? " · " + when : ""))
                .setSmallIcon(android.R.drawable.ic_dialog_info)
                .setContentIntent(openApp())
                .setAutoCancel(true)
                .build();
        try {
            manager.notify(ID_ALERT, note);
        } catch (Exception ignored) {
            // 没有通知权限时忽略
        }
    }

    /** 取一次 /api/sign/active，发现新的场次就通知 */
    private void poll(Context context) {
        String token = prefs().getString(KEY_TOKEN, "");
        if (token == null || token.length() == 0) {
            return;
        }
        HttpURLConnection conn = null;
        try {
            URL url = new URL(BuildConfig.SERVER_BASE + "/api/sign/active");
            conn = (HttpURLConnection) url.openConnection();
            conn.setRequestMethod("GET");
            conn.setConnectTimeout(8000);
            conn.setReadTimeout(8000);
            conn.setRequestProperty("Authorization", "Bearer " + token);
            if (conn.getResponseCode() != 200) {
                return;
            }
            BufferedReader reader = new BufferedReader(new InputStreamReader(conn.getInputStream(), "UTF-8"));
            StringBuilder text = new StringBuilder();
            String line;
            while ((line = reader.readLine()) != null) {
                text.append(line);
            }
            reader.close();
            JSONObject root = new JSONObject(text.toString());
            JSONArray list = root.optJSONArray("sessions");
            int newest = 0;
            String title = "";
            String when = "";
            if (list != null && list.length() > 0) {
                JSONObject first = list.optJSONObject(0);
                if (first != null) {
                    newest = first.optInt("id", 0);
                    title = first.optString("title", "班级签到");
                    when = first.optString("sign_text", "");
                }
            }
            if (newest <= 0) {
                return;
            }
            int seen = prefs().getInt(KEY_SEEN, 0);
            if (newest != seen) {
                prefs().edit().putInt(KEY_SEEN, newest).commit();
                if (seen != 0 && !MainActivity.isForeground()) {
                    notifyNewSession(title, when);
                }
            }
        } catch (Exception ignored) {
            // 离线时静默重试
        } finally {
            if (conn != null) {
                conn.disconnect();
            }
        }
    }
}
