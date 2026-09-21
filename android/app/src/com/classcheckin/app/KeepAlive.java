package com.classcheckin.app;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.app.job.JobInfo;
import android.app.job.JobScheduler;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

/**
 * 「别被系统清掉」的那一套：
 *  - AlarmManager 定时把值守服务拉回来（被划掉后台之后几秒内自动重来）
 *  - JobScheduler 持久化任务（重启手机之后依然有效，而且能在 Doze 维护窗口里跑）
 * 都不用精确闹钟权限：setAndAllowWhileIdle 是"允许在打盹时触发"的非精确闹钟，够用。
 */
public final class KeepAlive {

    public static final String ACTION_RESTART = "com.classcheckin.app.action.RESTART_WATCH";
    private static final int JOB_ID = 7711;
    private static final int RC_FAST = 7712;
    private static final int RC_SLOW = 7713;

    private KeepAlive() {}

    public static void scheduleRestart(Context ctx) {
        scheduleAt(ctx, RC_FAST, 4000L);
        scheduleAt(ctx, RC_SLOW, 180000L);
        scheduleJob(ctx);
    }

    private static void scheduleAt(Context ctx, int requestCode, long delayMs) {
        AlarmManager manager = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
        if (manager == null) {
            return;
        }
        PendingIntent pending = restartIntent(ctx, requestCode);
        long at = System.currentTimeMillis() + delayMs;
        try {
            manager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pending);
        } catch (Exception error) {
            try {
                manager.set(AlarmManager.RTC_WAKEUP, at, pending);
            } catch (Exception ignored) {
                // 厂商 ROM 拦了就靠 JobScheduler
            }
        }
    }

    private static PendingIntent restartIntent(Context ctx, int requestCode) {
        Intent intent = new Intent(ctx, BootReceiver.class);
        intent.setAction(ACTION_RESTART);
        int flag = PendingIntent.FLAG_UPDATE_CURRENT;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            flag |= PendingIntent.FLAG_IMMUTABLE;
        }
        return PendingIntent.getBroadcast(ctx, requestCode, intent, flag);
    }

    public static void scheduleJob(Context ctx) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.LOLLIPOP) {
            return;
        }
        JobScheduler scheduler = (JobScheduler) ctx.getSystemService(Context.JOB_SCHEDULER_SERVICE);
        if (scheduler == null) {
            return;
        }
        try {
            JobInfo job = new JobInfo.Builder(JOB_ID, new ComponentName(ctx, WatchJobService.class))
                    .setPersisted(true)
                    .setPeriodic(15 * 60 * 1000L)
                    .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                    .build();
            scheduler.schedule(job);
        } catch (Exception ignored) {
            // 有些 ROM 关掉了 JobScheduler
        }
    }

    public static void cancelJob(Context ctx) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.LOLLIPOP) {
            return;
        }
        JobScheduler scheduler = (JobScheduler) ctx.getSystemService(Context.JOB_SCHEDULER_SERVICE);
        if (scheduler == null) {
            return;
        }
        try {
            scheduler.cancel(JOB_ID);
        } catch (Exception ignored) {
        }
        AlarmManager manager = (AlarmManager) ctx.getSystemService(Context.ALARM_SERVICE);
        if (manager != null) {
            manager.cancel(restartIntent(ctx, RC_FAST));
            manager.cancel(restartIntent(ctx, RC_SLOW));
        }
    }
}
