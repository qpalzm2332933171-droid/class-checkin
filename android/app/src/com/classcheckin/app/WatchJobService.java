package com.classcheckin.app;

import android.app.job.JobParameters;
import android.app.job.JobService;

/**
 * JobScheduler 兜底：手机重启 / 应用被清理之后，
 * 至少把值守服务拉回来，并立刻补一次"有没有新签到"的检查。
 */
public class WatchJobService extends JobService {

    @Override
    public boolean onStartJob(final JobParameters params) {
        new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    if (WatchService.shouldRun(WatchJobService.this)) {
                        WatchService.start(WatchJobService.this);
                        WatchService.checkOnce(WatchJobService.this, true);
                    }
                } catch (Exception ignored) {
                    // 离线等情况直接跳过
                } finally {
                    jobFinished(params, false);
                }
            }
        }, "watch-job").start();
        return true;
    }

    @Override
    public boolean onStopJob(JobParameters params) {
        return true;
    }
}
