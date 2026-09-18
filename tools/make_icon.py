"""生成站点图标与安卓启动图标（纯标准库，无 PIL）。"""
import math
import os
import struct
import zlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def render(size, ss=3):
    n = size * ss
    buf = bytearray(n * n * 4)
    r = n * 0.2266
    c1 = (76, 155, 255); c2 = (10, 108, 255); c3 = (124, 92, 255)
    pts = [(148 / 512, 266 / 512), (220 / 512, 340 / 512), (372 / 512, 174 / 512)]
    hw = 46 / 512 / 2
    for y in range(n):
        for x in range(n):
            cx = min(max(x, r), n - r); cy = min(max(y, r), n - r)
            outside = math.hypot(x - cx, y - cy)
            if outside > r:
                continue
            t = (x / n) * 0.5 + (y / n) * 0.5
            if t < 0.55:
                k = t / 0.55; col = [c1[i] + (c2[i] - c1[i]) * k for i in range(3)]
            else:
                k = (t - 0.55) / 0.45; col = [c2[i] + (c3[i] - c2[i]) * k for i in range(3)]
            gx, gy = x / n - 0.28, y / n - 0.2
            gl = max(0.0, 1.0 - math.hypot(gx, gy) / 0.75) ** 2 * 0.45
            col = [c + (255 - c) * gl for c in col]
            ink = 0.0
            px, py = x / n, y / n
            for i in range(len(pts) - 1):
                ax, ay = pts[i]; bx, by = pts[i + 1]
                vx, vy = bx - ax, by - ay
                wx, wy = px - ax, py - ay
                seg = max(0.0, min(1.0, (wx * vx + wy * vy) / (vx * vx + vy * vy)))
                d = math.hypot(px - (ax + vx * seg), py - (ay + vy * seg))
                ink = max(ink, 1.0 - d / hw)
            ink = max(0.0, min(1.0, ink))
            col = [c + (255 - c) * ink for c in col]
            alpha = 1.0 if outside <= r - ss * 0.85 else max(0.0, (r - outside) / (ss * 0.85))
            o = (y * n + x) * 4
            buf[o] = int(col[0]); buf[o + 1] = int(col[1]); buf[o + 2] = int(col[2]); buf[o + 3] = int(alpha * 255)
    out = bytearray(size * size * 4)
    for y in range(size):
        for x in range(size):
            rs = gs = bs = al = 0
            for yy in range(ss):
                for xx in range(ss):
                    o = ((y * ss + yy) * n + (x * ss + xx)) * 4
                    rs += buf[o]; gs += buf[o + 1]; bs += buf[o + 2]; al += buf[o + 3]
            k = ss * ss
            o = (y * size + x) * 4
            out[o] = rs // k; out[o + 1] = gs // k; out[o + 2] = bs // k; out[o + 3] = al // k
    return bytes(out)


def png(size, raw):
    rows = b"".join(b"\x00" + raw[y * size * 4:(y + 1) * size * 4] for y in range(size))

    def chunk(tag, data):
        payload = tag + data
        return struct.pack(">I", len(data)) + payload + struct.pack(">I", zlib.crc32(payload) & 0xFFFFFFFF)

    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(rows, 9))
            + chunk(b"IEND", b""))


def write(path, size, ss):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    data = png(size, render(size, ss))
    with open(path, "wb") as fh:
        fh.write(data)
    return len(data)


def main():
    web = os.path.join(ROOT, "web", "assets")
    print("icon-192.png", write(os.path.join(web, "icon-192.png"), 192, 3))
    print("icon-512.png", write(os.path.join(web, "icon-512.png"), 512, 2))
    densities = [("mdpi", 48, 4), ("hdpi", 72, 3), ("xhdpi", 96, 3), ("xxhdpi", 144, 2), ("xxxhdpi", 192, 2)]
    for name, size, ss in densities:
        target = os.path.join(ROOT, "android", "app", "res", "mipmap-" + name, "ic_launcher.png")
        print("mipmap-%s" % name, write(target, size, ss))


if __name__ == "__main__":
    main()
