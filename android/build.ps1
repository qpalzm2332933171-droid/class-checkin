<#
  构建班级签到安卓客户端（不依赖 Gradle，直接用 SDK 的 aapt2 / d8 / apksigner）
  用法：
    .\build.ps1                       # 用默认服务器地址打包
    .\build.ps1 -Server http://1.2.3.4:8080
    .\build.ps1 -SkipUpdateCheck      # 不联网探测 H5 版本号
#>
param(
  [string]$Server = "",
  [string]$Version = "1.0.0",
  [int]$VersionCode = 1,
  [int]$MinSdk = 24,
  [int]$TargetSdk = 34,
  [switch]$SkipUpdateCheck
)

$ErrorActionPreference = "Stop"
$Root      = $PSScriptRoot
$Project   = Split-Path -Parent $Root
$Sdk       = if ($env:ANDROID_SDK_ROOT) { $env:ANDROID_SDK_ROOT } else { "D:\Android\AndroidSDK" }
# 自动挑最新的 build-tools（老版本 d8 处理匿名内部类会崩，必须用新的）
$BuildTool = $null
foreach ($candidate in (Get-ChildItem (Join-Path $Sdk "build-tools") -Directory |
        Sort-Object { [version]($_.Name -replace '[^0-9.]', '') } -Descending)) {
  if ((Test-Path (Join-Path $candidate.FullName "aapt2.exe")) -and (Test-Path (Join-Path $candidate.FullName "d8.bat"))) {
    $BuildTool = $candidate.FullName; break
  }
}
if (-not $BuildTool) { throw "在 $Sdk\build-tools 下找不到可用的 aapt2/d8" }
$Platform  = Join-Path $Sdk "platforms\android-$TargetSdk"
$JavaHome  = if ($env:JAVA_HOME) { $env:JAVA_HOME } else { "D:\Android\AndroidStudio\jbr" }
$JavaBin   = Join-Path $JavaHome "bin"
$Out       = Join-Path $Root "build"
$Dist      = Join-Path $Root "dist"

Write-Host "== 环境 ==" -ForegroundColor Cyan
Write-Host "  SDK        $Sdk"
Write-Host "  build-tools $BuildTool"
Write-Host "  java       $JavaBin"
foreach ($need in @($BuildTool, $Platform, (Join-Path $Platform "android.jar"), (Join-Path $JavaBin "javac.exe"))) {
  if (-not (Test-Path $need)) { throw "缺少必要组件: $need" }
}

# 1) 探测服务器上的 H5 版本号，作为内置版本
$H5Version = 1
if (-not $SkipUpdateCheck) {
  try {
    $info = Invoke-RestMethod -Uri "$Server/api/app/version?platform=h5&code=0" -TimeoutSec 8
    if ($info.version_code) { $H5Version = [int]$info.version_code }
    Write-Host "  服务器 H5 版本: $H5Version" -ForegroundColor Green
  } catch {
    Write-Host "  探测服务器失败($($_.Exception.Message))，内置版本号用 1" -ForegroundColor Yellow
  }
}

# 2) 准备目录
foreach ($dir in @($Out, $Dist)) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }
foreach ($sub in @("gen", "classes", "dex", "res")) {
  $p = Join-Path $Out $sub
  if (Test-Path $p) { Remove-Item -Recurse -Force $p }
  New-Item -ItemType Directory -Force -Path $p | Out-Null
}
Get-ChildItem $Out -File | Remove-Item -Force -ErrorAction SilentlyContinue

# 3) 把 web/ 复制成 app/assets/h5
$assets = Join-Path $Root "app\assets\h5"
if (Test-Path $assets) { Remove-Item -Recurse -Force $assets }
New-Item -ItemType Directory -Force -Path $assets | Out-Null
Copy-Item (Join-Path $Project "web\*") $assets -Recurse -Force

# 3b) 剔除「只从服务器加载」的游戏本体，别塞进 APK。
#     web/games/danmaku/ 是 iframe 插件式接入的（宿主 gameSrc = mediaUrl("/games/danmaku/index.html")，
#     mediaUrl() = serverBase() + path），无论 H5 还是安卓壳，iframe 一律指向服务器，包内那份从不加载。
#     Phaser 版三件套 17.6 MB，内嵌进来只会让 APK 白胖 18 MB。与 tools/publish_h5.py 的 PACKAGE_EXCLUDE 保持一致。
$assetsGames = Join-Path $assets "games\danmaku"
if (Test-Path $assetsGames) { Remove-Item -Recurse -Force $assetsGames; Write-Host "== 已剔除 games\danmaku（改由服务器提供） ==" -ForegroundColor DarkGray }
Write-Host "== 已内嵌 H5 资源: $((Get-ChildItem $assets -Recurse -File).Count) 个文件 ==" -ForegroundColor Cyan

# 4) 生成 BuildConfig.java
$pkgDir = Join-Path $Out "gen\com\classcheckin\app"
New-Item -ItemType Directory -Force -Path $pkgDir | Out-Null
@"
package com.classcheckin.app;

public final class BuildConfig {
    public static final boolean DEBUG = false;
    public static final String APP_VERSION = "$Version";
    public static final String SERVER_BASE = "$Server";
    public static final int H5_VERSION = $H5Version;
    private BuildConfig() {}
}
"@ | Set-Content -Path (Join-Path $pkgDir "BuildConfig.java") -Encoding utf8

# 5) 资源编译 + 链接
Write-Host "== aapt2 compile ==" -ForegroundColor Cyan
& (Join-Path $BuildTool "aapt2.exe") compile --dir (Join-Path $Root "app\res") -o (Join-Path $Out "res.zip")
if ($LASTEXITCODE -ne 0) { throw "aapt2 compile 失败" }

Write-Host "== aapt2 link ==" -ForegroundColor Cyan
& (Join-Path $BuildTool "aapt2.exe") link `
  -o (Join-Path $Out "base.apk") `
  -I (Join-Path $Platform "android.jar") `
  --manifest (Join-Path $Root "app\AndroidManifest.xml") `
  -A (Join-Path $Root "app\assets") `
  --java (Join-Path $Out "gen") `
  --min-sdk-version $MinSdk `
  --target-sdk-version $TargetSdk `
  --version-code $VersionCode `
  --version-name $Version `
  --no-version-vectors `
  (Join-Path $Out "res.zip")
if ($LASTEXITCODE -ne 0) { throw "aapt2 link 失败" }

# 6) 编译 Java
Write-Host "== javac ==" -ForegroundColor Cyan
$sources = @()
$sources += Get-ChildItem (Join-Path $Root "app\src") -Recurse -Filter *.java | ForEach-Object { $_.FullName }
$sources += Get-ChildItem (Join-Path $Out "gen") -Recurse -Filter *.java | ForEach-Object { $_.FullName }
& (Join-Path $JavaBin "javac.exe") -encoding UTF-8 --release 8 -nowarn -g:source,lines,vars `
  -cp (Join-Path $Platform "android.jar") -d (Join-Path $Out "classes") $sources
if ($LASTEXITCODE -ne 0) { throw "javac 失败" }

# 7) d8 -> classes.dex
Write-Host "== d8 ==" -ForegroundColor Cyan
$classes = Get-ChildItem (Join-Path $Out "classes") -Recurse -Filter *.class | ForEach-Object { $_.FullName }
& (Join-Path $BuildTool "d8.bat") --release --min-api $MinSdk --lib (Join-Path $Platform "android.jar") `
  --output (Join-Path $Out "dex") $classes
if ($LASTEXITCODE -ne 0) { throw "d8 失败" }

# 8) 合并 dex 到 apk
& python (Join-Path $Project "tools\apk_add_dex.py") (Join-Path $Out "base.apk") (Join-Path $Out "dex\classes.dex")
if ($LASTEXITCODE -ne 0) { throw "合并 classes.dex 失败" }

# 9) 签名
$ks = Join-Path $Root "checkin.jks"
if (-not (Test-Path $ks)) {
  Write-Host "== 生成签名密钥 ==" -ForegroundColor Cyan
  & (Join-Path $JavaBin "keytool.exe") -genkeypair -keystore $ks -alias checkin -keyalg RSA -keysize 2048 `
    -validity 10950 -storepass checkin2026 -keypass checkin2026 `
    -dname "CN=Class CheckIn, OU=Class, O=Class, L=City, ST=State, C=CN" | Out-Null
}

$aligned = Join-Path $Out "aligned.apk"
$apk = Join-Path $Dist "class-checkin-$Version.apk"
& (Join-Path $BuildTool "zipalign.exe") -f -p 4 (Join-Path $Out "base.apk") $aligned
if ($LASTEXITCODE -ne 0) { throw "zipalign 失败" }
& (Join-Path $BuildTool "apksigner.bat") sign --ks $ks --ks-key-alias checkin `
  --ks-pass pass:checkin2026 --key-pass pass:checkin2026 --out $apk $aligned
if ($LASTEXITCODE -ne 0) { throw "apksigner 失败" }
& (Join-Path $BuildTool "apksigner.bat") verify --print-certs $apk | Select-Object -First 3

Write-Host ""
Write-Host "打包完成 -> $apk" -ForegroundColor Green
Write-Host ("  内置 H5 版本 {0} / 服务器 {1}" -f $H5Version, $Server)
