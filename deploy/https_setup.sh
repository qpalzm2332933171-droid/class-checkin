#!/usr/bin/env bash
# 给 class-checkin 打开 HTTPS：自己签一套 CA + 服务器证书，再加一个 HTTPS 监听端口。
#
#   bash https_setup.sh <对外地址> <对外HTTPS端口> [内部HTTPS端口] [额外SAN(逗号分隔)]
# 例：bash https_setup.sh 43.227.71.8 20319 18101 ""              # 单个 IP
#     bash https_setup.sh checkin.example.com 20319 18101 "IP:43.227.71.8"
#
# 为什么要 HTTPS：浏览器只在"安全上下文"里给 navigator.geolocation，
# 纯 http 页面拿不到定位，网页端就没法定位签到。
#
# 自签证书是"没域名也能用"的方案：证书是有效的 TLS，浏览器第一次会拦一下
# （高级 -> 继续前往），之后 isSecureContext 就是 true、定位可用；
# 把 /opt/class-checkin/tls/ca.crt 装到手机上当受信任根证书就不会再拦。
set -euo pipefail

NAME="${1:-}"
EXT_PORT="${2:-20319}"
TLS_PORT="${3:-18101}"
EXTRA_SAN="${4:-}"
HTTP_PORT="${5:-20318}"
if [ -z "$NAME" ]; then
  echo "用法: bash https_setup.sh <对外地址> <对外HTTPS端口> [内部HTTPS端口] [额外SAN]" >&2
  exit 2
fi

APP_DIR=/opt/class-checkin
TLS_DIR="$APP_DIR/tls"
DROPIN_DIR=/etc/systemd/system/class-checkin.service.d
mkdir -p "$TLS_DIR" "$DROPIN_DIR"
chmod 755 "$TLS_DIR"

if printf '%s' "$NAME" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$'; then
  PRIMARY="IP:$NAME"
else
  PRIMARY="DNS:$NAME"
fi
SAN="$PRIMARY,IP:127.0.0.1,DNS:localhost"
if [ -n "$EXTRA_SAN" ]; then SAN="$SAN,$EXTRA_SAN"; fi

echo "[1/5] 自签 CA"
if [ ! -f "$TLS_DIR/ca.key" ] || [ ! -f "$TLS_DIR/ca.crt" ]; then
  openssl req -x509 -newkey rsa:2048 -nodes -days 3650 -sha256 \
    -keyout "$TLS_DIR/ca.key" -out "$TLS_DIR/ca.crt" \
    -subj "/C=CN/O=ClassCheckIn/CN=ClassCheckIn Self-signed CA" \
    -addext "basicConstraints=critical,CA:TRUE,pathlen:0" \
    -addext "keyUsage=critical,keyCertSign,cRLSign" >/dev/null 2>&1
  echo "      新建 CA: $TLS_DIR/ca.crt"
else
  echo "      复用已有 CA（装过根证书的手机不用重装）"
fi

echo "[2/5] 签发服务器证书（SAN: $SAN）"
cat > "$TLS_DIR/ext.cnf" <<EOF
subjectAltName=$SAN
extendedKeyUsage=serverAuth
basicConstraints=critical,CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
EOF
openssl req -newkey rsa:2048 -nodes -sha256 -keyout "$TLS_DIR/server.key" \
  -out "$TLS_DIR/server.csr" -subj "/C=CN/O=ClassCheckIn/CN=$NAME" >/dev/null 2>&1
openssl x509 -req -in "$TLS_DIR/server.csr" -CA "$TLS_DIR/ca.crt" -CAkey "$TLS_DIR/ca.key" \
  -CAcreateserial -days 825 -sha256 -extfile "$TLS_DIR/ext.cnf" \
  -out "$TLS_DIR/server.crt" >/dev/null 2>&1
rm -f "$TLS_DIR/server.csr"
chmod 600 "$TLS_DIR/ca.key" "$TLS_DIR/server.key"
chmod 644 "$TLS_DIR/ca.crt" "$TLS_DIR/server.crt"

echo "[3/5] 写 systemd drop-in"
cat > "$DROPIN_DIR/tls.conf" <<EOF
[Service]
Environment=CHECKIN_TLS_CERT=$TLS_DIR/server.crt
Environment=CHECKIN_TLS_KEY=$TLS_DIR/server.key
Environment=CHECKIN_TLS_CA=$TLS_DIR/ca.crt
Environment=CHECKIN_TLS_PORT=$TLS_PORT
Environment=CHECKIN_HTTPS_ORIGIN=https://$NAME:$EXT_PORT
EOF

echo "[4/5] 重启服务"
systemctl daemon-reload
systemctl restart class-checkin
sleep 3

echo "[5/5] 自检"
if systemctl is-active --quiet class-checkin; then echo "      服务在跑"; else
  echo "      !! 服务没起来，看 /opt/class-checkin/data/server.log" >&2; exit 1; fi
if ss -tlnp | grep -q ":$TLS_PORT "; then echo "      $TLS_PORT 已监听"; else
  echo "      !! $TLS_PORT 没监听，看日志" >&2; exit 1; fi
code=$(curl -s -o /dev/null -w '%{http_code}' --cacert "$TLS_DIR/ca.crt" "https://127.0.0.1:$TLS_PORT/api/config" || true)
echo "      https 本机自测 /api/config -> $code"
[ "$code" = "200" ] || { echo "      !! HTTPS 自测失败" >&2; exit 1; }

cat <<EOF

完成。
  对外地址    : https://$NAME:$EXT_PORT
  还需要你去 NAT 转发页面加一条： 外部端口 $EXT_PORT  ->  内部端口 $TLS_PORT  （协议 TCP）
  http 老地址 : http://$NAME:$HTTP_PORT （继续可用，安卓客户端仍走这个）
  手机装根证书: 手机浏览器打开 http://$NAME:$HTTP_PORT/checkin-ca.crt 下载，
                再 设置 -> 安全 -> 加密与凭据 -> 安装证书 -> CA 证书 里装上，
                之后 https 不再报警告，定位直接可用。
  根证书文件  : $TLS_DIR/ca.crt
EOF
