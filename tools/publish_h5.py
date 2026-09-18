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


def build_zip():
    """zip 根目录直接放 index.html（安卓壳解包后要求 <dir>/index.html）。"""
    buffer = io.BytesIO()
    count = 0
    with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED, compresslevel=9) as zf:
        for folder, _dirs, files in os.walk(WEB):
            for name in files:
                full = os.path.join(folder, name)
                rel = os.path.relpath(full, WEB).replace("\\", "/")
                zf.write(full, rel)
                count += 1
    return buffer.getvalue(), count


def main():
    base = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("CHECKIN_SERVER", "http://127.0.0.1:8081")
    password = sys.argv[2] if len(sys.argv) > 2 else ""
    notes = sys.argv[3] if len(sys.argv) > 3 else "班级签到 H5 更新"
    user = sys.argv[4] if len(sys.argv) > 4 else "admin"
    if not password:
        print("用法: python tools/publish_h5.py <服务器> <管理员密码> [更新说明]")
        return 1
    login = call(base, "/api/login", "POST", {"username": user, "password": password})
    token = login["token"]
    current = call(base, "/api/app/version?platform=h5&code=0").get("version_code", 0)
    payload, count = build_zip()
    result = call(base, "/api/admin/upload", "POST", token=token, raw=payload,
                  query="?name=h5.zip&kind=h5&version_code=%d&version_name=%s&notes=%s"
                        % (current + 1, base.split("//")[1].split(":")[0], urllib.parse.quote(notes)))
    print("打包 %d 个文件, %.1f KB" % (count, len(payload) / 1024.0))
    print("已发布 H5 热更新包: v%s -> v%s" % (current, result["version_code"]))
    return 0


if __name__ == "__main__":
    import urllib.parse  # noqa: E402
    sys.exit(main())
