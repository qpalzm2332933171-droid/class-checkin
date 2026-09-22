package com.classcheckin.app;

import android.util.Base64;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.EOFException;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.net.Socket;
import java.net.URI;
import java.security.SecureRandom;
import java.security.cert.X509Certificate;

import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLSocket;
import javax.net.ssl.SSLSocketFactory;
import javax.net.ssl.TrustManager;
import javax.net.ssl.X509TrustManager;

/**
 * 手写的极简 WebSocket 客户端（RFC 6455）。
 * 只用到最基础的一小部分：握手、读文本帧、回 pong、断线重连。
 * 不引 OkHttp 之类的库，是因为这个客户端是直接用 aapt2/d8 手工打包的，没有 Gradle 依赖管理。
 */
public class WsClient {

    public interface Listener {
        void onOpen();

        void onText(String text);

        void onClose(String reason);
    }

    private static final SecureRandom RANDOM = new SecureRandom();

    private final String host;
    private final int port;
    private final boolean tls;
    private final String target;
    private final Listener listener;

    private volatile boolean stopped = false;
    private volatile Socket socket = null;

    public WsClient(String url, Listener listener) {
        URI uri = URI.create(url);
        String scheme = uri.getScheme() == null ? "ws" : uri.getScheme().toLowerCase();
        this.tls = scheme.startsWith("wss") || scheme.startsWith("https");
        this.host = uri.getHost();
        this.port = uri.getPort() > 0 ? uri.getPort() : (tls ? 443 : 80);
        String path = uri.getRawPath();
        if (path == null || path.length() == 0) {
            path = "/ws";
        }
        this.target = uri.getRawQuery() == null ? path : path + "?" + uri.getRawQuery();
        this.listener = listener;
    }

    /** 阻塞式跑：连上就一直读，断了就退避重连，直到 stop()。 */
    public void run() {
        int attempt = 0;
        while (!stopped) {
            long startedAt = System.currentTimeMillis();
            try {
                connectAndRead();
            } catch (Exception error) {
                if (listener != null && !stopped) {
                    listener.onClose(String.valueOf(error.getMessage()));
                }
            }
            if (stopped) {
                break;
            }
            if (System.currentTimeMillis() - startedAt > 60000L) {
                attempt = 0;      // 稳定连过一分钟，退避重新数
            }
            attempt = Math.min(attempt + 1, 6);
            long wait = 1000L * (1L << attempt);
            if (wait > 60000L) {
                wait = 60000L;
            }
            sleep(wait);
        }
        if (listener != null) {
            listener.onClose("stopped");
        }
    }

    public void stop() {
        stopped = true;
        closeQuietly();
    }

    private void connectAndRead() throws Exception {
        Socket s = open();
        socket = s;
        s.setTcpNoDelay(true);
        s.setKeepAlive(true);
        // 服务器每 25 秒会发一个 ping，90 秒还没动静说明连接已经死了
        s.setSoTimeout(120000);
        try {
            OutputStream out = new BufferedOutputStream(s.getOutputStream());
            InputStream in = new BufferedInputStream(s.getInputStream());
            handshake(in, out);
            if (listener != null) {
                listener.onOpen();
            }
            readLoop(in, out);
        } finally {
            closeQuietly();
        }
    }

    private Socket open() throws Exception {
        if (!tls) {
            Socket s = new Socket();
            s.connect(new InetSocketAddress(host, port), 12000);
            return s;
        }
        // 服务器用的是自签证书，先按系统信任链试一次，不行再用兜底（自签 CA 的情况）
        Socket plain = new Socket();
        plain.connect(new InetSocketAddress(host, port), 12000);
        try {
            SSLSocketFactory factory = (SSLSocketFactory) SSLSocketFactory.getDefault();
            SSLSocket ssl = (SSLSocket) factory.createSocket(plain, host, port, true);
            ssl.startHandshake();
            return ssl;
        } catch (Exception first) {
            try {
                plain.close();
            } catch (Exception ignored) {
            }
        }
        Socket plain2 = new Socket();
        plain2.connect(new InetSocketAddress(host, port), 12000);
        SSLSocket ssl = (SSLSocket) trustAllFactory().createSocket(plain2, host, port, true);
        ssl.startHandshake();
        return ssl;
    }

    private static SSLSocketFactory trustAllFactory() throws Exception {
        SSLContext context = SSLContext.getInstance("TLS");
        context.init(null, new TrustManager[]{new X509TrustManager() {
            @Override
            public void checkClientTrusted(X509Certificate[] chain, String authType) {
            }

            @Override
            public void checkServerTrusted(X509Certificate[] chain, String authType) {
            }

            @Override
            public X509Certificate[] getAcceptedIssuers() {
                return new X509Certificate[0];
            }
        }}, RANDOM);
        return context.getSocketFactory();
    }

    private void handshake(InputStream in, OutputStream out) throws Exception {
        byte[] nonce = new byte[16];
        RANDOM.nextBytes(nonce);
        String key = Base64.encodeToString(nonce, Base64.NO_WRAP);
        String hostHeader = (port == 80 || port == 443) ? host : host + ":" + port;
        String request = "GET " + target + " HTTP/1.1\r\n"
                + "Host: " + hostHeader + "\r\n"
                + "Upgrade: websocket\r\n"
                + "Connection: Upgrade\r\n"
                + "Sec-WebSocket-Key: " + key + "\r\n"
                + "Sec-WebSocket-Version: 13\r\n"
                + "User-Agent: ClassCheckInApp/" + BuildConfig.APP_VERSION + "\r\n"
                + "\r\n";
        out.write(request.getBytes("UTF-8"));
        out.flush();
        String status = readLine(in);
        if (status == null || status.indexOf("101") < 0) {
            throw new IOException("websocket 握手失败: " + status);
        }
        String line;
        while ((line = readLine(in)) != null && line.length() > 0) {
            // 跳过响应头
        }
    }

    private void readLoop(InputStream in, OutputStream out) throws Exception {
        while (!stopped) {
            int first = in.read();
            if (first < 0) {
                throw new EOFException("连接已被服务器关闭");
            }
            int second = in.read();
            if (second < 0) {
                throw new EOFException("连接已被服务器关闭");
            }
            int opcode = first & 0x0F;
            boolean masked = (second & 0x80) != 0;
            long length = second & 0x7F;
            if (length == 126) {
                length = ((long) readByte(in) << 8) | readByte(in);
            } else if (length == 127) {
                length = 0;
                for (int i = 0; i < 8; i++) {
                    length = (length << 8) | readByte(in);
                }
            }
            if (length > 4L * 1024 * 1024) {
                throw new IOException("帧过大");
            }
            byte[] mask = null;
            if (masked) {
                mask = new byte[4];
                readFully(in, mask, 4);
            }
            byte[] payload = new byte[(int) length];
            if (length > 0) {
                readFully(in, payload, (int) length);
            }
            if (mask != null) {
                for (int i = 0; i < payload.length; i++) {
                    payload[i] = (byte) (payload[i] ^ mask[i % 4]);
                }
            }
            if (opcode == 0x1) {
                if (listener != null) {
                    listener.onText(new String(payload, "UTF-8"));
                }
            } else if (opcode == 0x8) {
                throw new EOFException("服务器主动断开");
            } else if (opcode == 0x9) {
                writeFrame(out, 0xA, payload);
            }
            // 0x0 续帧、0xA pong：忽略（服务器不会发分片帧）
        }
    }

    private static void writeFrame(OutputStream out, int opcode, byte[] payload) throws IOException {
        byte[] mask = new byte[4];
        RANDOM.nextBytes(mask);
        int length = payload.length;
        ByteArrayOutputStream buffer = new ByteArrayOutputStream(length + 14);
        buffer.write(0x80 | opcode);
        if (length < 126) {
            buffer.write(0x80 | length);
        } else if (length < 65536) {
            buffer.write(0x80 | 126);
            buffer.write((length >> 8) & 0xFF);
            buffer.write(length & 0xFF);
        } else {
            buffer.write(0x80 | 127);
            for (int i = 7; i >= 0; i--) {
                buffer.write((int) (((long) length >> (8 * i)) & 0xFF));
            }
        }
        buffer.write(mask, 0, 4);
        byte[] body = new byte[length];
        for (int i = 0; i < length; i++) {
            body[i] = (byte) (payload[i] ^ mask[i % 4]);
        }
        buffer.write(body, 0, length);
        out.write(buffer.toByteArray());
        out.flush();
    }

    private static int readByte(InputStream in) throws IOException {
        int value = in.read();
        if (value < 0) {
            throw new EOFException("连接已断开");
        }
        return value;
    }

    private static void readFully(InputStream in, byte[] target, int length) throws IOException {
        int offset = 0;
        while (offset < length) {
            int read = in.read(target, offset, length - offset);
            if (read < 0) {
                throw new EOFException("连接已断开");
            }
            offset += read;
        }
    }

    private static String readLine(InputStream in) throws IOException {
        ByteArrayOutputStream buffer = new ByteArrayOutputStream(96);
        int value;
        while ((value = in.read()) >= 0) {
            if (value == '\n') {
                break;
            }
            if (value != '\r') {
                buffer.write(value);
            }
        }
        if (value < 0 && buffer.size() == 0) {
            return null;
        }
        return new String(buffer.toByteArray(), "UTF-8");
    }

    private void closeQuietly() {
        Socket s = socket;
        socket = null;
        if (s != null) {
            try {
                s.close();
            } catch (Exception ignored) {
            }
        }
    }

    private static void sleep(long ms) {
        try {
            Thread.sleep(ms);
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
        }
    }
}
