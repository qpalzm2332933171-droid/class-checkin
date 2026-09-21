package com.classcheckin.app;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.media.AudioAttributes;
import android.media.RingtoneManager;
import android.net.Uri;
import android.os.Build;

/**
 * 通知集中处理。
 *
 * 两条通道分工很明确：
 *  - CH_KEEP：后台值守的前台服务通知，IMPORTANCE_MIN + 静音 + 无角标。
 *    这是安卓对前台服务的硬性要求（不给通知系统就会把服务杀掉），
 *    所以只能做到"最安静"：不出状态栏图标、不响不震、折叠在通知栏最底部的静默区。
 *  - CH_ALERT：有新签到时的提醒，IMPORTANCE_HIGH + 系统通知音 + 震动 + 横幅，
 *    效果和微信收到消息一致。
 */
public final class Push {

    public static final String CH_KEEP = "checkin_keepalive_v3";
    public static final String CH_ALERT = "checkin_sign_v3";
    public static final int ID_KEEP = 9001;
    public static final int ID_ALERT_BASE = 9100;
    private static final String GROUP = "checkin-sign";
    private static final int COLOR = 0xFF2F7CF6;

    private Push() {}

    public static void ensureChannels(Context ctx) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            return;
        }
        NotificationManager manager = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) {
            return;
        }
        NotificationChannel keep = new NotificationChannel(CH_KEEP, "后台连接", NotificationManager.IMPORTANCE_MIN);
        keep.setShowBadge(false);
        keep.enableVibration(false);
        keep.enableLights(false);
        keep.setSound(null, null);
        keep.setDescription("保持后台连接，好第一时间收到新签到（完全静音，不会打扰你）");
        manager.createNotificationChannel(keep);

        NotificationChannel alert = new NotificationChannel(CH_ALERT, "新的签到", NotificationManager.IMPORTANCE_HIGH);
        alert.setShowBadge(true);
        alert.enableVibration(true);
        alert.setVibrationPattern(new long[]{0, 260, 180, 260});
        alert.enableLights(true);
        alert.setLightColor(COLOR);
        alert.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
        alert.setDescription("有新的签到发布时，像收到微信消息一样提醒你");
        Uri sound = RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION);
        if (sound == null) {
            sound = RingtoneManager.getValidRingtoneUri(ctx);   // 系统没配通知音时的兜底
        }
        if (sound != null) {
            AudioAttributes attrs = new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_NOTIFICATION)
                    .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                    .build();
            alert.setSound(sound, attrs);
        }
        manager.createNotificationChannel(alert);
    }

    private static Notification.Builder builder(Context ctx, String channel) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            return new Notification.Builder(ctx, channel);
        }
        Notification.Builder b = new Notification.Builder(ctx);
        b.setPriority(CH_ALERT.equals(channel) ? Notification.PRIORITY_HIGH : Notification.PRIORITY_MIN);
        return b;
    }

    public static PendingIntent openApp(Context ctx, int signId) {
        Intent intent = new Intent(ctx, MainActivity.class);
        intent.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP
                | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        if (signId > 0) {
            intent.putExtra(MainActivity.EXTRA_SIGN_ID, signId);
        }
        int flag = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            flag |= PendingIntent.FLAG_IMMUTABLE;
        }
        return PendingIntent.getActivity(ctx, signId > 0 ? signId : 1, intent, flag);
    }

    /** 值守用的前台服务通知：能多安静就多安静。 */
    public static Notification keepAlive(Context ctx) {
        Notification.Builder b = builder(ctx, CH_KEEP);
        b.setSmallIcon(R.drawable.ic_stat_checkin)
                .setContentTitle("班级签到")
                .setContentIntent(openApp(ctx, 0))
                .setOngoing(true)
                .setShowWhen(false)
                .setOnlyAlertOnce(true)
                .setColor(COLOR);
        // 通道本身就是 IMPORTANCE_MIN + 静音，这里再把老版本的声音/震动一并关掉
        b.setSound(null).setVibrate(null).setDefaults(0);
        return b.build();
    }

    /** 新签到提醒：和微信收到消息一样，有声、有震动、有横幅。 */
    public static void notifySign(Context ctx, int signId, String title, String whenText,
                                  String place, boolean needLocation, String className) {
        if (signId <= 0) {
            return;
        }
        NotificationManager manager = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager == null) {
            return;
        }
        String head = title == null || title.length() == 0 ? "班级签到" : title;
        StringBuilder big = new StringBuilder(head);
        if (whenText != null && whenText.length() > 0) {
            big.append('\n').append("签到时间：").append(whenText);
        }
        if (className != null && className.length() > 0) {
            big.append('\n').append("发布班级：").append(className);
        }
        if (needLocation) {
            big.append('\n').append("这次是定位签到");
            if (place != null && place.length() > 0) {
                big.append('（').append(place).append('）');
            }
        } else if (place != null && place.length() > 0) {
            big.append('\n').append("地点：").append(place);
        }

        Notification.Builder b = builder(ctx, CH_ALERT);
        b.setSmallIcon(R.drawable.ic_stat_checkin)
                .setContentTitle("新的签到已发布")
                .setContentText(whenText == null || whenText.length() == 0 ? head : head + " · " + whenText)
                .setStyle(new Notification.BigTextStyle().bigText(big.toString()))
                .setContentIntent(openApp(ctx, signId))
                .setAutoCancel(true)
                .setCategory(Notification.CATEGORY_MESSAGE)
                .setGroup(GROUP)
                .setWhen(System.currentTimeMillis())
                .setShowWhen(true)
                .setColor(COLOR)
                .setVisibility(Notification.VISIBILITY_PUBLIC);
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
            b.setDefaults(Notification.DEFAULT_SOUND | Notification.DEFAULT_VIBRATE | Notification.DEFAULT_LIGHTS);
        }
        try {
            manager.notify(ID_ALERT_BASE + (signId % 1000), b.build());
        } catch (Exception ignored) {
            // 用户没给通知权限时静默
        }
    }

    /** 清掉守卫通知（退出登录时用）。 */
    public static void clearAlerts(Context ctx) {
        try {
            NotificationManager manager = (NotificationManager) ctx.getSystemService(Context.NOTIFICATION_SERVICE);
            if (manager != null) {
                manager.cancelAll();
            }
        } catch (Exception ignored) {
        }
    }
}
