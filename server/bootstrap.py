"""First-run setup: create the admin account and a demo member."""

import os

import auth
import db
from util import log, now


def create_default_users():
    admin_password = db.random_password(10)
    member_password = db.random_password(8)
    password_hash, salt = auth.hash_password(admin_password)
    db.execute(
        "INSERT INTO users(username, name, role, password_hash, salt, color, note, created_at) "
        "VALUES(?,?,?,?,?,?,?,?)",
        ("admin", "班主任", "admin", password_hash, salt, "#0A84FF", "系统管理员", now()))
    committee_password = db.random_password(8)
    password_hash, salt = auth.hash_password(committee_password)
    db.execute(
        "INSERT INTO users(username, name, role, password_hash, salt, color, note, created_at) "
        "VALUES(?,?,?,?,?,?,?,?)",
        ("committee", "学习委员", "committee", password_hash, salt, "#FF9F0A", "资委账号：可发布签到/公告", now()))
    password_hash, salt = auth.hash_password(member_password)
    db.execute(
        "INSERT INTO users(username, name, role, password_hash, salt, color, note, created_at) "
        "VALUES(?,?,?,?,?,?,?,?)",
        ("member", "演示同学", "member", password_hash, salt, "#30D158", "演示账号，可删除", now()))
    path = os.path.join(db.DATA_DIR, "初始账号.txt")
    with open(path, "w", encoding="utf-8") as fh:
        fh.write("管理员 admin / %s\n" % admin_password)
        fh.write("资委   committee / %s\n" % committee_password)
        fh.write("演示成员 member / %s\n" % member_password)
        fh.write("登录后请立即修改密码，删除本文件。\n")
    log("=" * 60)
    log("已创建初始账号  ->  %s" % path)
    log("  管理员   admin     /  %s" % admin_password)
    log("  资委     committee /  %s" % committee_password)
    log("  演示成员 member    /  %s" % member_password)
    log("=" * 60)
    return admin_password


if __name__ == "__main__":
    db.init()
    if db.query_one("SELECT COUNT(*) AS c FROM users")["c"]:
        log("已有用户，跳过初始化")
    else:
        create_default_users()
