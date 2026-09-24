"""把 web/ 打包成 H5 热更新包并发布到服务器。

用法:
  python tools/publish_h5.py <服务器地址> <管理员密码> [更新说明] [管理员用户名]
"""
import io
import json
import os
import sys
import urllib.request
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WEB = os.path.join(ROOT, "web")


def call(base, path, method="GET", body=None, token=None, raw=None, query=""):
    url = base + path + query
    data = raw if raw is not None else (json.dumps(body).encode() if body is not None else None)
    req = urllib.request.Request(url, data=data, method=method)
    if raw is not None:
        req.add_header("Content-Type", "application/octet-stream")
    elif data:
        req.add_header("Content-Type", "application/json")
    if token:
        req.add_header("Authorization", "Bearer " + token)
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read().decode())


# 只在服务器上提供、不打进热更新包的目录（相对 web/ 的 posix 前缀）。
#
# 为什么：web/games/danmaku/ 是 iframe 插件式接入的游戏本体，宿主里是
#   gameSrc = mediaUrl("/games/danmaku/index.html")
# 而 mediaUrl() = serverBase() + path —— 无论 H5 还是安卓壳（宿主页走 file://），
# iframe 一律指向服务器，包内那份从不加载。Phaser 版三件套一共 17.6 MB
#（index.html 9.9 MB 内嵌 BGM + phaser.min.js 1.2 MB + bgm.mp3 7.4 MB），
# 打进包里只会让 25 个人白白多下载 18 MB。APK 的 android/build.ps1 同样跳过它。
PACKAGE_EXCLUDE = ("games/danmaku/",)


def _packaged(rel):
    """相对 web/ 的 posix 路径是否需要进包。"""
    return not any(rel.startswith(prefix) for prefix in PACKAGE_EXCLUDE)


def build_zip():
    """zip 根目录直接放 index.html（安卓壳解包后要求 <dir>/index.html）。"""
    buffer = io.BytesIO()
    count = 0
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for folder, _dirs, files in os.walk(WEB):
            for name in files:
                full = os.path.join(folder, name)
                rel = os.path.relpath(full, WEB).replace("\\", "/")
                if not _packaged(rel):
                    continue
                zf.write(full, rel)
                count += 1
    return buffer.getvalue(), count


def main():
    base = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("CHECKIN_SERVER", "http://127.0.0.1:8081")
    password = sys.argv[2] if len(sys.argv) > 2 else ""
    notes = sys.argv[3] if len(sys.argv) > 3 else "班级签到 H5 更新"
    user = sys.argv[4] if len(sys.argv) > 4 else "admin"
    if not password:
        print("用法: python tools/publish_h5.py <服务器> <管理员密码> [更新说明] [管理员用户名] [版本号]")
        return 1
    login = call(base, "/api/login", "POST", {"username": user, "password": password})
    token = login["token"]
    current = call(base, "/api/app/version?platform=h5&code=0").get("version_code", 0)
    # 版本号默认取 current+1，但允许显式指定：更新日志的版本号和 H5 的 version_code
    # 是两条线（中途可能只发过 APK，H5 这边就跳号了），硬编码 +1 会让两边对不上。
    code = int(sys.argv[5]) if len(sys.argv) > 5 else current + 1
    payload, count = build_zip()
    result = call(base, "/api/admin/upload", "POST", token=token, raw=payload,
                  query="?name=h5.zip&kind=h5&version_code=%d&version_name=%s&notes=%s"
                        % (code, urllib.parse.quote("v%d" % code), urllib.parse.quote(notes)))
    print("打包 %d 个文件, %.1f KB" % (count, len(payload) / 1024.0))
    print("已发布 H5 热更新包: v%s -> v%s" % (current, code))
    return 0


if __name__ == "__main__":
    import urllib.parse  # noqa: E402
    sys.exit(main())
