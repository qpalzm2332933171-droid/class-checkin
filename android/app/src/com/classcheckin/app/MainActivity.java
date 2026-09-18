package com.classcheckin.app;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowInsetsController;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;

import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.zip.ZipEntry;
import java.util.zip.ZipInputStream;

/**
 * 班级签到安卓壳：
 *  - 优先加载「本地热更新包」(filesDir/h5)，没有就用安装包里内置的 assets/h5
 *  - 启动时静默检查服务器上的新版本，有就后台下载、原子替换、自动刷新
 *  - 通过 window.ClassCheckIn 暴露给网页：版本号 / 手动更新 / 原生提示
 */
public class MainActivity extends Activity {

    private static final String PREFS = "checkin";
    private static final String KEY_H5 = "h5_version";
    private static final String KEY_STAMP = "apk_stamp";
    private static final String KEY_TOKEN = "session_token";

    private static final int REQ_LOCATION = 101;
    private static final int REQ_NOTIFY = 103;

    private WebView webView;
    private final AtomicBoolean updating = new AtomicBoolean(false);
    private String pendingLocationCallback = null;
    private volatile String lastNotes = "";
    private static volatile boolean foreground = false;
    private android.webkit.ValueCallback<Uri[]> fileCallback = null;
    private static final int REQ_FILE = 102;

    public static boolean isForeground() {
        return foreground;
    }

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        FrameLayout root = new FrameLayout(this);
        root.setLayoutParams(new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT));
        root.setBackgroundColor(getResources().getColor(R.color.boot_bg));

        webView = new WebView(this);
        webView.setLayoutParams(new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT,
                ViewGroup.LayoutParams.MATCH_PARENT));
        webView.setBackgroundColor(Color.TRANSPARENT);
        root.addView(webView);
        setContentView(root);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setAllowFileAccess(true);
        settings.setAllowContentAccess(true);
        settings.setAllowFileAccessFromFileURLs(true);
        settings.setAllowUniversalAccessFromFileURLs(true);
        settings.setLoadsImagesAutomatically(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        settings.setTextZoom(100);
        settings.setUserAgentString(settings.getUserAgentString() + " ClassCheckInApp/" + BuildConfig.APP_VERSION);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            settings.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        }
        // 打开 WebView 调试：电脑上用 Chrome 的 chrome://inspect 就能看到这个页面
        WebView.setWebContentsDebuggingEnabled(true);

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView view, String url) {
                injectServer();
            }
        });
        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, android.webkit.ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                if (fileCallback != null) {
                    fileCallback.onReceiveValue(null);
                }
                fileCallback = callback;
                try {
                    Intent intent = params.createIntent();
                    intent.addCategory(Intent.CATEGORY_OPENABLE);
                    startActivityForResult(intent, REQ_FILE);
                } catch (Exception error) {
                    try {
                        Intent pick = new Intent(Intent.ACTION_GET_CONTENT);
                        pick.addCategory(Intent.CATEGORY_OPENABLE);
                        pick.setType(params.getAcceptTypes() != null && params.getAcceptTypes().length > 0
                                ? params.getAcceptTypes()[0] : "image/*");
                        startActivityForResult(Intent.createChooser(pick, "选择图片"), REQ_FILE);
                    } catch (Exception fallback) {
                        fileCallback = null;
                        toastOnUi("这台设备没有可用的图片选择器");
                        return false;
                    }
                }
                return true;
            }

            @Override
            public void onPermissionRequest(final android.webkit.PermissionRequest request) {
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        try { request.grant(request.getResources()); } catch (Exception ignored) { }
                    }
                });
            }
        });
        webView.addJavascriptInterface(new Bridge(), "ClassCheckIn");
        applySystemBars();

        ensureBundle();
        webView.loadUrl(activeUrl());
        checkForUpdate(false);
        WatchService.start(this);
        if (Build.VERSION.SDK_INT >= 33 && !notificationGranted()) {
            try {
                requestPermissions(new String[]{"android.permission.POST_NOTIFICATIONS"}, REQ_NOTIFY);
            } catch (Exception ignored) { }
        }
    }

    private void applySystemBars() {
        try {
        Window window = getWindow();
        boolean dark = (getResources().getConfiguration().uiMode
                & android.content.res.Configuration.UI_MODE_NIGHT_MASK)
                == android.content.res.Configuration.UI_MODE_NIGHT_YES;
        window.setStatusBarColor(getResources().getColor(R.color.boot_bg));
        window.setNavigationBarColor(getResources().getColor(R.color.boot_bg));
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            WindowInsetsController controller = window.getInsetsController();
            if (controller != null) {
                int mask = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS
                        | WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
                controller.setSystemBarsAppearance(dark ? 0 : mask, mask);
            }
        } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            int flags = window.getDecorView().getSystemUiVisibility();
            if (dark) {
                flags &= ~View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
            } else {
                flags |= View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR;
            }
            window.getDecorView().setSystemUiVisibility(flags);
        }
        } catch (Throwable ignored) {
            // 状态栏配色失败不影响使用
        }
    }

    private void injectServer() {
        String js = "window.__CHECKIN_SERVER__ = " + JSONObject.quote(BuildConfig.SERVER_BASE) + ";"
                + "window.__CHECKIN_VERSION__ = " + h5Version() + ";";
        webView.evaluateJavascript(js, null);
    }

    // ------------------------------------------------------------- 热更新

    /** 每个版本一个目录：URL 变了，WebView 的 JS 代码缓存才会失效，否则会出现"版本号更新了但代码没换" */
    private File bundleDir(int code) {
        return new File(getFilesDir(), "h5-" + code);
    }

    private File localBundle() {
        return bundleDir(h5Version());
    }

    private void copyAssetsTo(File target) throws Exception {
        deleteTree(target);
        if (!target.mkdirs() && !target.isDirectory()) {
            throw new Exception("无法创建目录 " + target.getName());
        }
        copyAssetDir("h5", target);
    }

    private void copyAssetDir(String path, File target) throws Exception {
        String[] children = getAssets().list(path);
        if (children == null || children.length == 0) {
            File file = new File(target, new File(path).getName());
            InputStream in = getAssets().open(path);
            try {
                OutputStream out = new FileOutputStream(file);
                try {
                    byte[] buffer = new byte[8192];
                    int read;
                    while ((read = in.read(buffer)) > 0) {
                        out.write(buffer, 0, read);
                    }
                } finally {
                    out.close();
                }
            } finally {
                in.close();
            }
            return;
        }
        if (!target.isDirectory() && !target.mkdirs()) {
            throw new Exception("无法创建目录");
        }
        for (String child : children) {
            File next = new File(target, child);
            String childPath = path + "/" + child;
            String[] grand = getAssets().list(childPath);
            if (grand != null && grand.length > 0) {
                copyAssetDir(childPath, next);
            } else if (grand != null && grand.length == 0) {
                copyAssetFile(childPath, next);
            }
        }
    }

    private void copyAssetFile(String assetPath, File target) throws Exception {
        InputStream in = getAssets().open(assetPath);
        try {
            OutputStream out = new FileOutputStream(target);
            try {
                byte[] buffer = new byte[8192];
                int read;
                while ((read = in.read(buffer)) > 0) {
                    out.write(buffer, 0, read);
                }
            } finally {
                out.close();
            }
        } finally {
            in.close();
        }
    }

    /** 内置 H5 释放：版本取"内置 / 热更新"里较大的那个，换 APK 且内置更新时覆盖释放 */
    private void ensureBundle() {
        int installed = prefs().getInt(KEY_H5, 0);
        int builtin = BuildConfig.H5_VERSION;
        long stamp = apkStamp();
        File dir = bundleDir(h5Version());
        boolean hasBundle = new File(dir, "index.html").isFile();
        boolean freshInstall = installed <= 0;
        boolean apkChanged = prefs().getLong(KEY_STAMP, 0L) != stamp;
        if (!freshInstall && builtin < installed) {
            return;                                   // 热更新版本更高，保留用户已下载的版本
        }
        if (!freshInstall && hasBundle && !apkChanged) {
            return;                                   // 同一个 APK 重复启动，不重复释放
        }
        try {
            copyAssetsTo(dir);
            prefs().edit().putLong(KEY_STAMP, stamp).putInt(KEY_H5, builtin).commit();
        } catch (Exception error) {
            toastOnUi("内置页面释放失败：" + error.getMessage());
        }
    }

    private long apkStamp() {
        try {
            return getPackageManager().getPackageInfo(getPackageName(), 0).lastUpdateTime;
        } catch (Exception error) {
            return 0L;
        }
    }

    private void pruneBundles(int keep) {
        File[] files = getFilesDir().listFiles();
        if (files == null) {
            return;
        }
        for (File item : files) {
            if (!item.isDirectory()) {
                continue;
            }
            String name = item.getName();
            if (name.equals("h5") || name.startsWith("h5-")) {
                if (!name.equals("h5-" + keep)) {
                    deleteTree(item);
                }
            }
        }
    }

    private String activeUrl() {
        File index = new File(localBundle(), "index.html");
        if (index.isFile()) {
            return "file://" + index.getAbsolutePath();
        }
        return "file:///android_asset/h5/index.html";
    }

    private SharedPreferences prefs() {
        return getSharedPreferences(PREFS, MODE_PRIVATE);
    }

    private int h5Version() {
        return Math.max(prefs().getInt(KEY_H5, 0), BuildConfig.H5_VERSION);
    }

    /** 每次进入 app 都检查一次；有新版本弹窗询问，版本一致就什么都不提示。 */
    private void checkForUpdate(final boolean manual) {
        new Thread(new Runnable() {
            @Override
            public void run() {
                try {
                    String api = BuildConfig.SERVER_BASE + "/api/app/version?platform=h5&code=" + h5Version();
                    final JSONObject info = new JSONObject(httpGet(api));
                    final int latest = info.optInt("version_code");
                    final int current = h5Version();
                    if (!info.optBoolean("has_update") || latest <= current) {
                        if (manual) {
                            toastOnUi("已是最新版本 v" + current);
                        }
                        return;
                    }
                    lastNotes = info.optString("notes");
                    final String url = info.optString("url");
                    final String name = info.optString("version_name");
                    final int size = info.optInt("size");
                    runOnUiThread(new Runnable() {
                        @Override
                        public void run() {
                            askUpdate(current, latest, size, url, name);
                        }
                    });
                } catch (Exception error) {
                    if (manual) toastOnUi("检查更新失败：" + error.getMessage());
                }
            }
        }, "h5-update-check").start();
    }

    /** 发现新版本：弹窗让用户决定，确认后才下载并自动重启界面。 */
    private void askUpdate(final int current, final int latest, int size, final String url, final String name) {
        if (isFinishing()) {
            return;
        }
        if (updating.get()) {
            toastOnUi("正在更新中…");
            return;
        }
        String tip = "当前版本 v" + current + " → 新版本 v" + latest;
        if (size > 0) {
            tip += "（" + Math.max(1, size / 1024) + " KB）";
        }
        final String notes = lastNotes;
        if (notes != null && notes.length() > 0) {
            tip += "\n\n更新内容：" + (notes.length() > 120 ? notes.substring(0, 120) + "…" : notes);
        }
        try {
            new android.app.AlertDialog.Builder(this)
                    .setTitle("发现新版本")
                    .setMessage(tip)
                    .setCancelable(false)
                    .setPositiveButton("立即更新", new android.content.DialogInterface.OnClickListener() {
                        @Override
                        public void onClick(android.content.DialogInterface dialog, int which) {
                            new Thread(new Runnable() {
                                @Override
                                public void run() {
                                    try {
                                        install(url, latest, name, true);
                                    } catch (Exception error) {
                                        toastOnUi("更新失败：" + error.getMessage());
                                    }
                                }
                            }, "h5-update-install").start();
                        }
                    })
                    .setNegativeButton("稍后再说", null)
                    .show();
        } catch (Throwable error) {
            toastOnUi("发现新版本 v" + latest + "，请到「我的」里手动更新");
        }
    }

    private void install(String url, int code, String name, boolean reloadAfter) throws Exception {
        if (url == null || url.length() == 0) {
            throw new Exception("更新地址为空");
        }
        if (!updating.compareAndSet(false, true)) {
            return;
        }
        File zip = new File(getCacheDir(), "h5.zip");
        File staging = new File(getFilesDir(), "h5-new");
        File target = bundleDir(code);
        try {
            progress(0, "downloading");
            download(url, zip);
            progress(70, "unpacking");
            deleteTree(staging);
            unzip(zip, staging);
            if (!new File(staging, "index.html").isFile()) {
                throw new Exception("更新包内容不完整");
            }
            progress(92, "installing");
            deleteTree(target);
            if (!staging.renameTo(target)) {
                deleteTree(staging);
                throw new Exception("更新包安装失败");
            }
            zip.delete();
            prefs().edit().putInt(KEY_H5, code).apply();
            pruneBundles(code);
            progress(100, "done");
            if (reloadAfter) {
                runOnUiThread(new Runnable() {
                    @Override
                    public void run() {
                        webView.clearCache(true);
                        webView.loadUrl("about:blank");
                        webView.loadUrl(activeUrl());
                        Toast.makeText(MainActivity.this, "已更新到新版本", Toast.LENGTH_SHORT).show();
                    }
                });
            }
        } catch (Exception error) {
            progress(0, "error:" + error.getMessage());
            throw error;
        } finally {
            updating.set(false);
        }
    }

    private void progress(int percent, String state) {
        final String js = "window.__onBundle && window.__onBundle("
                + "{\"percent\":" + percent + ",\"state\":" + JSONObject.quote(state) + "});";
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                if (webView != null) {
                    webView.evaluateJavascript(js, null);
                }
            }
        });
    }

    private void toastOnUi(final String message) {
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                Toast.makeText(MainActivity.this, message, Toast.LENGTH_SHORT).show();
            }
        });
    }

    private static String httpGet(String address) throws Exception {
        HttpURLConnection conn = (HttpURLConnection) new URL(address).openConnection();
        conn.setConnectTimeout(8000);
        conn.setReadTimeout(10000);
        conn.setRequestProperty("Accept", "application/json");
        try {
            InputStream in = new BufferedInputStream(conn.getInputStream());
            java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
            byte[] buffer = new byte[8192];
            int read;
            while ((read = in.read(buffer)) != -1) {
                out.write(buffer, 0, read);
            }
            in.close();
            return new String(out.toByteArray(), "UTF-8");
        } finally {
            conn.disconnect();
        }
    }

    private static void download(String address, File target) throws Exception {
        HttpURLConnection conn = (HttpURLConnection) new URL(address).openConnection();
        conn.setConnectTimeout(8000);
        conn.setReadTimeout(30000);
        conn.setInstanceFollowRedirects(true);
        try {
            InputStream in = new BufferedInputStream(conn.getInputStream());
            OutputStream out = new FileOutputStream(target);
            byte[] buffer = new byte[16384];
            int read;
            while ((read = in.read(buffer)) != -1) {
                out.write(buffer, 0, read);
            }
            out.flush();
            out.close();
            in.close();
        } finally {
            conn.disconnect();
        }
    }

    private static void unzip(File zip, File target) throws Exception {
        if (!target.exists() && !target.mkdirs()) {
            throw new Exception("无法创建目录 " + target);
        }
        ZipInputStream zin = new ZipInputStream(new BufferedInputStream(new FileInputStream(zip)));
        try {
            ZipEntry entry;
            byte[] buffer = new byte[16384];
            while ((entry = zin.getNextEntry()) != null) {
                String name = entry.getName();
                if (name.startsWith("__MACOSX") || name.contains("..")) {
                    continue;
                }
                File out = new File(target, name);
                if (entry.isDirectory()) {
                    out.mkdirs();
                    continue;
                }
                File parent = out.getParentFile();
                if (parent != null && !parent.exists()) {
                    parent.mkdirs();
                }
                FileOutputStream fos = new FileOutputStream(out);
                int read;
                while ((read = zin.read(buffer)) != -1) {
                    fos.write(buffer, 0, read);
                }
                fos.close();
                zin.closeEntry();
            }
        } finally {
            zin.close();
        }
    }

    private static void deleteTree(File file) {
        if (file == null || !file.exists()) {
            return;
        }
        if (file.isDirectory()) {
            File[] children = file.listFiles();
            if (children != null) {
                for (File child : children) {
                    deleteTree(child);
                }
            }
        }
        file.delete();
    }

    // -------------------------------------------------------------- 桥接

    // -------------------------------------------------------------- 原生定位

    private class LocationOnce implements LocationListener {
        private final LocationManager manager;
        private final String callbackId;
        private final AtomicBoolean done = new AtomicBoolean(false);

        LocationOnce(LocationManager manager, String callbackId) {
            this.manager = manager;
            this.callbackId = callbackId;
        }

        void finish(Location location, String error) {
            if (!done.compareAndSet(false, true)) {
                return;
            }
            try {
                manager.removeUpdates(this);
            } catch (Exception ignored) {
                // ignore
            }
            if (location != null) {
                deliverLocation(callbackId, location.getLatitude(), location.getLongitude(), null);
            } else {
                deliverLocation(callbackId, 0, 0, error == null ? "定位失败，请重试" : error);
            }
        }

        void timeout() {
            finish(null, "定位超时，请到信号好一点的地方再试");
        }

        @Override
        public void onLocationChanged(Location location) {
            finish(location, null);
        }

        @Override
        public void onStatusChanged(String provider, int status, Bundle extras) {
        }

        @Override
        public void onProviderEnabled(String provider) {
        }

        @Override
        public void onProviderDisabled(String provider) {
        }
    }

    private boolean locationGranted() {
        return checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION) == PackageManager.PERMISSION_GRANTED
                || checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION) == PackageManager.PERMISSION_GRANTED;
    }

    private Location lastKnown(LocationManager manager) {
        Location best = null;
        for (String provider : new String[]{LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER,
                LocationManager.PASSIVE_PROVIDER}) {
            try {
                if (!manager.isProviderEnabled(provider)) {
                    continue;
                }
                Location last = manager.getLastKnownLocation(provider);
                if (last != null && (best == null || last.getTime() > best.getTime())) {
                    best = last;
                }
            } catch (Exception ignored) {
                // 某些机型缺少 provider，直接忽略
            }
        }
        return best;
    }

    private boolean locationServiceOn(LocationManager manager) {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                return manager.isLocationEnabled();
            }
            return manager.isProviderEnabled(LocationManager.GPS_PROVIDER)
                    || manager.isProviderEnabled(LocationManager.NETWORK_PROVIDER);
        } catch (Exception error) {
            return true;
        }
    }

    private void openLocationSettings() {
        try {
            startActivity(new android.content.Intent(android.provider.Settings.ACTION_LOCATION_SOURCE_SETTINGS));
        } catch (Exception ignored) {
            // ignore
        }
    }

    private void startLocation(final String callbackId) {
        if (callbackId == null || callbackId.length() == 0) {
            return;
        }
        if (!locationGranted()) {
            pendingLocationCallback = callbackId;
            requestPermissions(new String[]{Manifest.permission.ACCESS_FINE_LOCATION,
                    Manifest.permission.ACCESS_COARSE_LOCATION}, REQ_LOCATION);
            return;
        }
        LocationManager manager = (LocationManager) getSystemService(Context.LOCATION_SERVICE);
        if (manager == null) {
            deliverLocation(callbackId, 0, 0, "这台设备不支持定位");
            return;
        }
        if (!locationServiceOn(manager)) {
            openLocationSettings();
            deliverLocation(callbackId, 0, 0, "系统定位开关是关闭的，请打开定位后重试");
            return;
        }
        final LocationOnce once = new LocationOnce(manager, callbackId);
        // Android 11+ 优先用 getCurrentLocation：一次调用就能拿到当前点，比监听回调稳
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            final String[] providers = new String[]{LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER};
            // 每个 provider 必须用独立的 CancellationSignal：共用一个会把先发出的请求取消掉，
            // 在没有 GMS 的国产机上网络定位拿不到点，就彻底定位失败了。
            final android.os.CancellationSignal signalGps = new android.os.CancellationSignal();
            final android.os.CancellationSignal signalNet = new android.os.CancellationSignal();
            try {
                manager.getCurrentLocation(providers[0], signalGps, getMainExecutor(),
                        new java.util.function.Consumer<Location>() {
                            @Override
                            public void accept(Location location) {
                                if (location != null) {
                                    once.finish(location, null);
                                } else {
                                    once.finish(null, null);
                                }
                            }
                        });
                manager.getCurrentLocation(providers[1], signalNet, getMainExecutor(),
                        new java.util.function.Consumer<Location>() {
                            @Override
                            public void accept(Location location) {
                                if (location != null) {
                                    once.finish(location, null);
                                }
                            }
                        });
                new Handler(Looper.getMainLooper()).postDelayed(new Runnable() {
                    @Override
                    public void run() {
                        signalGps.cancel();
                        signalNet.cancel();
                        Location cached = lastKnown(manager);
                        if (cached != null) {
                            once.finish(cached, null);
                        } else {
                            once.timeout();
                        }
                    }
                }, 12000L);
                return;
            } catch (Exception ignored) {
                // 个别定制系统不支持，退回监听方式
            }
        }
        boolean requested = false;
        for (String provider : new String[]{LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER}) {
            try {
                if (!manager.isProviderEnabled(provider)) {
                    continue;
                }
                manager.requestLocationUpdates(provider, 0L, 0f, once, Looper.getMainLooper());
                requested = true;
            } catch (Exception ignored) {
                // ignore
            }
        }
        if (!requested) {
            Location cached = lastKnown(manager);
            if (cached != null) {
                deliverLocation(callbackId, cached.getLatitude(), cached.getLongitude(), null);
            } else {
                deliverLocation(callbackId, 0, 0, "系统定位不可用，请打开定位后重试");
            }
            return;
        }
        new Handler(Looper.getMainLooper()).postDelayed(new Runnable() {
            @Override
            public void run() {
                Location cached = lastKnown(manager);
                if (cached != null) {
                    once.finish(cached, null);
                } else {
                    once.timeout();
                }
            }
        }, 14000L);
    }

    private void deliverLocation(final String callbackId, final double lat, final double lng, final String error) {
        final String js = "window.__onNativeLocation && window.__onNativeLocation("
                + JSONObject.quote(callbackId) + ", " + lat + ", " + lng + ", "
                + (error == null ? "null" : JSONObject.quote(error)) + ");";
        runOnUiThread(new Runnable() {
            @Override
            public void run() {
                try {
                    webView.evaluateJavascript(js, null);
                } catch (Exception ignored) {
                    // ignore
                }
            }
        });
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQ_FILE) {
            if (fileCallback != null) {
                Uri[] result = null;
                try {
                    result = WebChromeClient.FileChooserParams.parseResult(resultCode, data);
                } catch (Exception ignored) { }
                fileCallback.onReceiveValue(result);
                fileCallback = null;
            }
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    private boolean notificationGranted() {
        try {
            return checkSelfPermission("android.permission.POST_NOTIFICATIONS") == PackageManager.PERMISSION_GRANTED;
        } catch (Exception error) {
            return true;
        }
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode != REQ_LOCATION) {
            return;
        }
        final String callbackId = pendingLocationCallback;
        pendingLocationCallback = null;
        if (callbackId == null) {
            return;
        }
        boolean granted = false;
        for (int result : grantResults) {
            if (result == PackageManager.PERMISSION_GRANTED) {
                granted = true;
            }
        }
        if (granted) {
            startLocation(callbackId);
        } else {
            deliverLocation(callbackId, 0, 0, "定位权限被拒绝，请在系统设置里允许后重试");
        }
    }

    // -------------------------------------------------------------- 桥接

    public class Bridge {
        @JavascriptInterface
        public int versionCode() {
            return h5Version();
        }

        @JavascriptInterface
        public String appVersion() {
            return BuildConfig.APP_VERSION;
        }

        @JavascriptInterface
        public String server() {
            return BuildConfig.SERVER_BASE;
        }

        @JavascriptInterface
        public void updateH5(final String url, final String code, final String name) {
            new Thread(new Runnable() {
                @Override
                public void run() {
                    try {
                        install(url, parseInt(code, h5Version() + 1), name, true);
                    } catch (Exception error) {
                        toastOnUi("更新失败：" + error.getMessage());
                    }
                }
            }, "h5-update-manual").start();
        }

        @JavascriptInterface
        public void checkUpdate() {
            checkForUpdate(true);
        }

        @JavascriptInterface
        public void saveSession(String token) {
            prefs().edit().putString(KEY_TOKEN, token == null ? "" : token).commit();
            if (token != null && token.length() > 0) WatchService.start(MainActivity.this);
        }

        @JavascriptInterface
        public String getSession() {
            return prefs().getString(KEY_TOKEN, "");
        }

        @JavascriptInterface
        public void clearSession() {
            prefs().edit().remove(KEY_TOKEN).commit();
            WatchService.stop(MainActivity.this);
        }

        @JavascriptInterface
        public boolean hasLocation() {
            return getPackageManager().hasSystemFeature(PackageManager.FEATURE_LOCATION);
        }

        @JavascriptInterface
        public void requestLocation(final String callbackId) {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    startLocation(callbackId);
                }
            });
        }

        @JavascriptInterface
        public void toast(String message) {
            toastOnUi(message);
        }

        @JavascriptInterface
        public void reload() {
            runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    webView.loadUrl(activeUrl());
                }
            });
        }
    }

    private static int parseInt(String value, int fallback) {
        try {
            return Integer.parseInt(value);
        } catch (Exception error) {
            return fallback;
        }
    }

    // ------------------------------------------------------------ 生命周期

    @Override
    public void onBackPressed() {
        if (webView == null) {
            super.onBackPressed();
            return;
        }
        webView.evaluateJavascript(
                "(function(){ try { return window.__androidBack ? window.__androidBack() : false; } catch (e) { return false; } })()",
                value -> {
                    if (!"true".equals(value)) {
                        finish();
                    }
                });
    }

    @Override
    protected void onResume() {
        super.onResume();
        foreground = true;
        if (webView != null) {
            webView.onResume();
        }
    }

    @Override
    protected void onPause() {
        foreground = false;
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
