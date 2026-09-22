package com.classcheckin.app;

import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ServiceInfo;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;

import org.json.JSONArray;
import org.json.JSONObject;

import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * 后台值守：和服务器保持一条 WebSocket 长连接，有新签到就立刻弹通知。
 *
 * 为什么不是轮询：轮询最快也只能做到"一分钟一次"，而且费电。
 * 长连接是服务器一发布签到就推过来，延迟就是一次网络往返，和微信收到消息是一个原理。
 *
 * 为什么用前台服务：Android 8 以后普通后台服务活不过一分钟，长连接根本维持不住。
 * 前台服务必须挂一条通知（系统硬性要求），所以把它做成 IMPORTANCE_MIN 的静默通道：
 * 不出状态栏图标、不响不震、不显示角标，只折叠在通知栏最底部的静默区里，尽量"看不见"。
 *
 * 怕被清掉？三重保险：START_STICKY + onTaskRemoved 排闹钟 + JobScheduler 持久化任务。
 */
public class WatchService extends Service {

    static final String PREFS = "checkin";
    static final String KEY_TOKEN = "session_token";     // 必须与 MainActivity.KEY_TOKEN 一致
    private static final String KEY_ENABLED = "watch_enabled";
    private static final String KEY_SEEN = "watch_seen_ids";
    private static final String KEY_SEEN_READY = "watch_seen_ready";
    private static final String KEY_SEEN_TOKEN = "watch_seen_token";

    private static final long TICK_MS = 60 * 1000L;              // 心跳自检
    private static final long FALLBACK_POLL_MS = 3 * 60 * 1000L; // 长连接断了这么久就轮询兜底
    private static final int SEEN_LIMIT = 60;
    private static final long MIN_LIFE_BEFORE_RESTART = 5000L;   // 活够 5 秒才值得自拉起，防死循环

    private static volatile long lastLiveAt = 0L;
    private static final AtomicBoolean CHECKING = new AtomicBoolean(false);

    private final Handler handler = new Handler(Looper.getMainLooper());
    private volatile WsClient client;
    private Thread worker;
    private volatile boolean stopped = false;
    private long createdAt = 0L;

    private final WsClient.Listener listener = new WsClient.Listener() {
        @Override
        public void onOpen() {
            lastLiveAt = System.currentTimeMillis();
            // 断线期间漏掉的签到，一连上就补上
            checkAsync(true);
        }

        @Override
        public void onText(String text) {
            lastLiveAt = System.currentTimeMillis();
            if (text == null || text.length() == 0) {
                return;
            }
            String kind;
            try {
                kind = new JSONObject(text).optString("t", "");
            } catch (Exception error) {
                return;
            }
            // 只关心签到相关的事件，聊天/对局那些一律忽略
            if ("sign.new".equals(kind) || "sign.update".equals(kind) || "announce".equals(kind)) {
                checkAsync(true);
            }
        }

        @Override
        public void onClose(String reason) {
            // 交给 run() 里的退避重连；这里不用做什么
        }
    };

    private final Runnable tick = new Runnable() {
        @Override
        public void run() {
            if (stopped) {
                return;
            }
            if (System.currentTimeMillis() - lastLiveAt > FALLBACK_POLL_MS) {
                checkAsync(true);          // 长连接一直没连上，用轮询兜底
            }
            handler.postDelayed(this, TICK_MS);
        }
    };

    // ------------------------------------------------------------ 对外静态接口

    public static boolean start(Context ctx) {
        try {
            ctx.getSharedPreferences(PREFS, MODE_PRIVATE).edit().putBoolean(KEY_ENABLED, true).commit();
        } catch (Exception ignored) {
        }
        try {
            Intent intent = new Intent(ctx, WatchService.class);
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                ctx.startForegroundService(intent);
            } else {
                ctx.startService(intent);
            }
            KeepAlive.scheduleJob(ctx);
            return true;
        } catch (Exception error) {
            return false;
        }
    }

    public static void stop(Context ctx) {
        try {
            ctx.getSharedPreferences(PREFS, MODE_PRIVATE).edit().putBoolean(KEY_ENABLED, false).commit();
        } catch (Exception ignored) {
        }
        KeepAlive.cancelJob(ctx);
        try {
            ctx.stopService(new Intent(ctx, WatchService.class));
        } catch (Exception ignored) {
        }
    }

    /** 该不该在后台自己爬起来（用户登录过、且没有主动退出）。 */
    public static boolean shouldRun(Context ctx) {
        try {
            SharedPreferences prefs = ctx.getSharedPreferences(PREFS, MODE_PRIVATE);
            String token = prefs.getString(KEY_TOKEN, "");
            return prefs.getBoolean(KEY_ENABLED, false) && token != null && token.length() > 0;
        } catch (Exception error) {
            return false;
        }
    }

    public static boolean isConnected() {
        return System.currentTimeMillis() - lastLiveAt < FALLBACK_POLL_MS;
    }

    private void checkAsync(final boolean notify) {
        if (!CHECKING.compareAndSet(false, true)) {
            return;
        }
        final Context ctx = getApplicationContext();
        new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    checkOnce(ctx, notify);
                } finally {
                    CHECKING.set(false);
                }
            }
        }, "watch-check").start();
    }

    /**
     * 问一次 /api/sign/active，把"没见过的场次"挑出来发通知。
     * 服务器已经按班级过滤过了，所以这里拿到的就是"我该看见的"签到。
     * 「见过哪些」记在 SharedPreferences 里，换账号会重置，避免重复提醒。
     */
    static boolean checkOnce(Context ctx, boolean notify) {
        SharedPreferences prefs = ctx.getSharedPreferences(PREFS, MODE_PRIVATE);
        String token = prefs.getString(KEY_TOKEN, "");
        if (token == null || token.length() == 0) {
            return false;
        }
        String text;
        try {
            text = Net.get(BuildConfig.SERVER_BASE + "/api/sign/active", token, 10000);
        } catch (Exception error) {
            return false;
        }
        if (text == null || text.length() == 0) {
            return false;
        }
        lastLiveAt = System.currentTimeMillis();

        if (!token.equals(prefs.getString(KEY_SEEN_TOKEN, ""))) {
            prefs.edit().putString(KEY_SEEN_TOKEN, token)
                    .remove(KEY_SEEN).putBoolean(KEY_SEEN_READY, false).commit();
        }

        JSONObject root;
        try {
            root = new JSONObject(text);
        } catch (Exception error) {
            return false;
        }
        JSONArray list = root.optJSONArray("sessions");
        Set<String> seen = splitIds(prefs.getString(KEY_SEEN, ""));
        boolean ready = prefs.getBoolean(KEY_SEEN_READY, false);
        long nowSec = System.currentTimeMillis() / 1000L;
        List<JSONObject> fresh = new ArrayList<JSONObject>();
        if (list != null) {
            for (int i = 0; i < list.length(); i++) {
                JSONObject session = list.optJSONObject(i);
                if (session == null) {
                    continue;
                }
                int id = session.optInt("id", 0);
                if (id <= 0) {
                    continue;
                }
                String key = String.valueOf(id);
                if (seen.contains(key)) {
                    continue;
                }
                seen.add(key);
                long endsAt = session.optLong("ends_at", 0);
                boolean open = endsAt == 0 || endsAt > nowSec;
                if (notify && ready && open) {
                    fresh.add(session);
                }
            }
        }
        prefs.edit().putString(KEY_SEEN, joinIds(seen)).putBoolean(KEY_SEEN_READY, true).commit();

        for (int i = 0; i < fresh.size(); i++) {
            JSONObject session = fresh.get(i);
            Push.notifySign(ctx, session.optInt("id", 0), session.optString("title", ""),
                    timeText(session), session.optString("place", ""),
                    session.optInt("require_location", 0) == 1, session.optString("class_name", ""));
        }
        return true;
    }

    static String watchUrl(String token) {
        String base = BuildConfig.SERVER_BASE == null ? "" : BuildConfig.SERVER_BASE.trim();
        while (base.endsWith("/")) {
            base = base.substring(0, base.length() - 1);
        }
        if (base.length() == 0) {
            base = "http://127.0.0.1:8080";
        }
        if (base.startsWith("https://")) {
            base = "wss://" + base.substring(8);
        } else if (base.startsWith("http://")) {
            base = "ws://" + base.substring(7);
        } else if (!base.startsWith("ws://") && !base.startsWith("wss://")) {
            base = "ws://" + base;
        }
        return base + "/ws?device=android&watch=1&token=" + Uri.encode(token);
    }

    private static String timeText(JSONObject session) {
        long signAt = session.optLong("sign_at", 0);
        if (signAt <= 0) {
            return "";
        }
        long grace = session.optLong("grace_minutes", 0);
        String today = new SimpleDateFormat("yyyyMMdd", Locale.CHINA).format(new Date());
        String day = new SimpleDateFormat("yyyyMMdd", Locale.CHINA).format(new Date(signAt * 1000L));
        String pattern = day.equals(today) ? "HH:mm" : "M月d日 HH:mm";
        StringBuilder out = new StringBuilder(new SimpleDateFormat(pattern, Locale.CHINA)
                .format(new Date(signAt * 1000L)));
        if (grace > 0) {
            out.append("（").append(new SimpleDateFormat("HH:mm", Locale.CHINA)
                    .format(new Date((signAt + grace * 60L) * 1000L))).append(" 之前可以签）");
        }
        return out.toString();
    }

    private static Set<String> splitIds(String raw) {
        Set<String> out = new LinkedHashSet<String>();
        if (raw == null || raw.length() == 0) {
            return out;
        }
        String[] parts = raw.split(",");
        for (String part : parts) {
            String item = part.trim();
            if (item.length() > 0) {
                out.add(item);
            }
        }
        return out;
    }

    private static String joinIds(Set<String> ids) {
        List<String> list = new ArrayList<String>(ids);
        if (list.size() > SEEN_LIMIT) {
            list = list.subList(list.size() - SEEN_LIMIT, list.size());
        }
        StringBuilder out = new StringBuilder();
        for (String id : list) {
            if (out.length() > 0) {
                out.append(',');
            }
            out.append(id);
        }
        return out.toString();
    }

    // ------------------------------------------------------------ 生命周期

    @Override
    public void onCreate() {
        super.onCreate();
        createdAt = System.currentTimeMillis();
        Push.ensureChannels(this);
        enterForeground();
        stopped = false;
        startWorker();
        handler.removeCallbacks(tick);
        handler.postDelayed(tick, TICK_MS);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        Push.ensureChannels(this);
        enterForeground();
        stopped = false;
        startWorker();
        handler.removeCallbacks(tick);
        handler.postDelayed(tick, TICK_MS);
        return START_STICKY;
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        super.onTaskRemoved(rootIntent);
        // 从最近任务里划掉了：服务默认不会被一起杀掉（stopWithTask=false），
        // 但有些厂商 ROM 会顺手清掉，所以排一个自拉起闹钟兜底。
        if (shouldRun(this)) {
            KeepAlive.scheduleRestart(this);
        }
    }

    @Override
    public void onDestroy() {
        stopped = true;
        handler.removeCallbacks(tick);
        WsClient current = client;
        client = null;
        if (current != null) {
            current.stop();
        }
        worker = null;
        if (shouldRun(this) && System.currentTimeMillis() - createdAt > MIN_LIFE_BEFORE_RESTART) {
            KeepAlive.scheduleRestart(this);   // 被系统干掉了，排个闹钟自己回来
        }
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    // ------------------------------------------------------------ 内部

    private SharedPreferences prefs() {
        return getSharedPreferences(PREFS, MODE_PRIVATE);
    }

    private void enterForeground() {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                startForeground(Push.ID_KEEP, Push.keepAlive(this), ServiceInfo.FOREGROUND_SERVICE_TYPE_DATA_SYNC);
            } else {
                startForeground(Push.ID_KEEP, Push.keepAlive(this));
            }
        } catch (Exception ignored) {
            // 通知权限被拒时也尽量把服务留着
        }
    }

    private void startWorker() {
        Thread running = worker;
        if (running != null && running.isAlive()) {
            return;
        }
        worker = new Thread(new Runnable() {
            @Override
            public void run() {
                String token = prefs().getString(KEY_TOKEN, "");
                if (token == null || token.length() == 0) {
                    return;
                }
                try {
                    WsClient socket = new WsClient(watchUrl(token), listener);
                    client = socket;
                    socket.run();
                } catch (Exception ignored) {
                    // 参数有问题就直接退出，等下次 start() 再说
                }
            }
        }, "watch-conn");
        worker.start();
    }
}
