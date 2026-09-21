package com.classcheckin.app;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * 开机 / 应用更新 / 自拉起闹钟 → 把后台值守重新启动。
 *
 * 这几种广播是 Android 官方明确豁免"后台不许起前台服务"限制的，
 * 所以微信那种"关机重启之后照样能收到消息"在这儿能对上。
 */
public class BootReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context context, Intent intent) {
        String action = (intent == null || intent.getAction() == null) ? "" : intent.getAction();
        boolean wake = Intent.ACTION_BOOT_COMPLETED.equals(action)
                || "android.intent.action.QUICKBOOT_POWERON".equals(action)
                || "com.htc.intent.action.QUICKBOOT_POWERON".equals(action)
                || Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)
                || KeepAlive.ACTION_RESTART.equals(action);
        if (!wake) {
            return;
        }
        if (!WatchService.shouldRun(context)) {
            return;                   // 用户没登录 / 明确退出了，别自作多情
        }
        if (!WatchService.start(context)) {
            // 起不来就交给 JobScheduler：它至少能在后台窗口里补一次检查并弹通知
            KeepAlive.scheduleJob(context);
        }
    }
}
