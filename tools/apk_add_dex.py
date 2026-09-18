"""把 classes.dex 塞进 aapt2 生成的 APK（纯标准库，替代 aapt add）。"""
import os
import shutil
import sys
import zipfile

apk, dex = sys.argv[1], sys.argv[2]
tmp = apk + ".tmp"
with zipfile.ZipFile(apk, "r") as src, zipfile.ZipFile(tmp, "w", zipfile.ZIP_DEFLATED) as dst:
    for item in src.infolist():
        dst.writestr(item, src.read(item.filename))
    dst.write(dex, "classes.dex")
shutil.move(tmp, apk)
print("added classes.dex (%.1f KB)" % (os.path.getsize(dex) / 1024.0))
