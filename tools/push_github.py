#!/usr/bin/env python3
"""不依赖 github.com:443 推送：走 GitHub Git Data API（只用到 api.github.com）。

有些网络环境下 github.com:443 连不上（TLS 被重置 / TCP 超时），但 api.github.com 通，
于是普通的 git push 永远失败。这个脚本把本地 HEAD 的整棵文件树通过 REST API 传上去：
  从 git 对象库读 blob -> 建 blob -> 建 tree -> 建 commit（连作者/时间/时区一起复刻）->
  建/更新 refs/heads/<branch>。因为元数据完全一致，上游算出来的 sha 和本地 HEAD 一模一样，
  git status 依然显示 up to date。

用法:
  python tools/push_github.py                      # 用 origin 的地址推断 owner/repo，推当前分支
  python tools/push_github.py owner/repo main
  python tools/push_github.py --force              # 允许把远端 ref 强行覆盖成本地 HEAD

令牌来源（按顺序找）: $GITHUB_TOKEN -> $GH_TOKEN -> `gh auth token`
"""

import base64
import concurrent.futures
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request

API = "https://api.github.com"


def iso_of(raw):
    """'1789743799 +0800' -> '2026-09-18T15:03:19+08:00'"""
    import datetime
    epoch, off = raw.split()
    sign = 1 if off[0] == "+" else -1
    tz = datetime.timezone(sign * datetime.timedelta(hours=int(off[1:3]), minutes=int(off[3:5])))
    return datetime.datetime.fromtimestamp(int(epoch), tz).isoformat()


def run(args, check=True):
    p = subprocess.run(args, capture_output=True, text=True, encoding="utf-8", errors="replace")
    if check and p.returncode != 0:
        sys.exit("命令失败: %s\n%s" % (" ".join(args), (p.stderr or p.stdout).strip()))
    return p.stdout


def token():
    for name in ("GITHUB_TOKEN", "GH_TOKEN"):
        if os.environ.get(name):
            return os.environ[name].strip()
    return run(["gh", "auth", "token"]).strip()


def api(tok, path, method="GET", body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(API + path, data=data, method=method)
    req.add_header("Authorization", "Bearer " + tok)
    req.add_header("Accept", "application/vnd.github+json")
    req.add_header("X-GitHub-Api-Version", "2022-11-28")
    req.add_header("User-Agent", "class-checkin-push")
    req.add_header("Connection", "close")
    if data:
        req.add_header("Content-Type", "application/json")
    last = None
    for attempt in range(5):
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                raw = resp.read()
                return json.loads(raw) if raw else {}
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", "replace")
            # 5xx / 429 才重试；4xx 是请求本身的问题，直接退出
            if e.code < 500 and e.code != 429:
                sys.exit("GitHub API %s %s -> %s\n%s" % (method, path, e.code, detail[:800]))
            last = "HTTP %s %s" % (e.code, detail[:200])
        except Exception as e:                      # 连接超时 / 被重置
            last = "%s: %s" % (type(e).__name__, e)
        wait = 1.5 * (attempt + 1)
        sys.stderr.write("  重试 %s %s（%s），%.1fs 后第 %d 次\n" % (method, path, last, wait, attempt + 2))
        time.sleep(wait)
    sys.exit("GitHub API %s %s 连续失败: %s" % (method, path, last))


def repo_slug():
    url = run(["git", "remote", "get-url", "origin"], check=False).strip()
    m = re.search(r"github\.com[:/]+([^/]+)/([^/\s]+?)(?:\.git)?$", url)
    if not m:
        sys.exit("无法从 origin 推断仓库，请显式传 owner/repo。当前 origin: %r" % url)
    return m.group(1), m.group(2)


def tracked_files():
    """返回 [(路径, 文件模式, blob sha)]，sha 是 git 对象库里的那个。"""
    out = run(["git", "-c", "core.quotepath=false", "ls-files", "-s", "-z"])
    files = []
    for rec in out.split("\0"):
        if not rec.strip():
            continue
        meta, path = rec.split("\t", 1)
        mode, sha, _stage = meta.split()
        files.append((path, mode, sha))
    return files


def read_blobs(shas):
    """一次性用 git cat-file --batch 取出所有 blob 的**原始字节**。

    注意：必须从对象库读，不能读工作区文件 —— 工作区可能被 autocrlf 换成了 CRLF，
    那样上传上去的 blob 和本地 git 的 blob 就不一样了（tree/sha 全对不上）。
    """
    proc = subprocess.run(["git", "cat-file", "--batch"], input=("\n".join(shas) + "\n").encode(),
                          capture_output=True)
    if proc.returncode != 0:
        sys.exit("git cat-file --batch 失败: " + proc.stderr.decode("utf-8", "replace"))
    buf, pos, out = proc.stdout, 0, {}
    for _ in range(len(shas)):
        eol = buf.index(b"\n", pos)
        header = buf[pos:eol].decode()
        pos = eol + 1
        sha, kind, size = header.split()
        if kind != "blob":
            sys.exit("意外的对象类型 %s (%s)" % (kind, sha))
        size = int(size)
        out[sha] = buf[pos:pos + size]
        pos += size + 1
    return out


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        sys.stderr.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

    argv = [a for a in sys.argv[1:] if not a.startswith("--")]
    force = "--force" in sys.argv
    slug = argv[0] if argv else None
    if slug:
        owner, repo = slug.split("/", 1)
    else:
        owner, repo = repo_slug()
    branch = argv[1] if len(argv) > 1 else run(["git", "branch", "--show-current"]).strip() or "main"
    # --date=raw 给出 "1789743799 +0800"，带上时区偏移，复刻 sha 必须用它
    meta = run(["git", "log", "-1", "--date=raw",
                "--pretty=%an%x00%ae%x00%ad%x00%cn%x00%ce%x00%cd%x00%P"]).split("\0")
    a_name, a_mail, a_raw, c_name, c_mail, c_raw, parents_raw = [x.strip() for x in meta[:7]]
    message = run(["git", "log", "-1", "--pretty=%B"]).rstrip("\n") + "\n"
    parent_sha = run(["git", "rev-parse", "HEAD"]).strip()
    local_parents = [x for x in parents_raw.split() if x]

    tok = token()
    who = api(tok, "/user")["login"]
    print("仓库: %s/%s  分支: %s  提交者: %s" % (owner, repo, branch, who))

    files = tracked_files()
    print("待上传文件: %d 个" % len(files))

    contents = read_blobs([sha for _p, _m, sha in files])

    def upload(item):
        path, _mode, local_sha = item
        payload = {"content": base64.b64encode(contents[local_sha]).decode(), "encoding": "base64"}
        return path, local_sha, api(tok, "/repos/%s/%s/git/blobs" % (owner, repo), "POST", payload)["sha"]

    tree = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        for i, (path, local_sha, remote_sha) in enumerate(pool.map(upload, files), 1):
            if remote_sha != local_sha:
                sys.exit("blob %s 上传后 sha 不一致（本地 %s / 远端 %s）" % (path, local_sha[:8], remote_sha[:8]))
            tree.append({
                "path": path.replace("\\", "/"),
                "mode": dict((f[0], f[1]) for f in files)[path],
                "type": "blob",
                "sha": remote_sha,
            })
            if i % 25 == 0 or i == len(files):
                print("  已上传 %d/%d" % (i, len(files)))

    tree_sha = api(tok, "/repos/%s/%s/git/trees" % (owner, repo), "POST", {"tree": tree})["sha"]
    print("tree: %s" % tree_sha)

    existing = None
    try:
        existing = api(tok, "/repos/%s/%s/git/ref/heads/%s" % (owner, repo, branch))["object"]["sha"]
    except SystemExit:
        existing = None   # 分支还不存在（空仓库）——不是错误

    # 上游必须有本地的所有父提交，否则复刻不出同样的 sha（这是「首次推空仓库」之外的场景）
    for par in local_parents:
        if par == existing:
            continue
        try:
            api(tok, "/repos/%s/%s/git/commits/%s" % (owner, repo, par))
        except SystemExit:
            sys.exit("远端没有父提交 %s，无法复刻本地 sha。这种情况请用常规 git push。" % par[:8])

    # 日期必须带时区偏移（ISO 8601），否则复刻出来的 sha 和本地对不上
    commit = api(tok, "/repos/%s/%s/git/commits" % (owner, repo), "POST", {
        "message": message,
        "tree": tree_sha,
        "parents": local_parents,
        "author": {"name": a_name, "email": a_mail, "date": iso_of(a_raw)},
        "committer": {"name": c_name, "email": c_mail, "date": iso_of(c_raw)},
    })
    commit_sha = commit["sha"]
    print("本地 HEAD: %s\n上游提交 : %s%s" % (parent_sha[:8], commit_sha[:8],
          "  ✔ 一致" if commit_sha == parent_sha else "  (不一致，本地会显示 diverged)"))

    ref_path = "/repos/%s/%s/git/refs/heads/%s" % (owner, repo, branch)
    if existing:
        api(tok, ref_path, "PATCH", {"sha": commit_sha, "force": True})
        print("已更新 refs/heads/%s" % branch)
    else:
        api(tok, "/repos/%s/%s/git/refs" % (owner, repo), "POST",
            {"ref": "refs/heads/" + branch, "sha": commit_sha})
        print("已创建 refs/heads/%s" % branch)

    run(["git", "update-ref", "refs/remotes/origin/" + branch, commit_sha], check=False)
    print("完成 -> https://github.com/%s/%s/tree/%s  (%s)" % (owner, repo, branch, commit_sha[:8]))


if __name__ == "__main__":
    main()
