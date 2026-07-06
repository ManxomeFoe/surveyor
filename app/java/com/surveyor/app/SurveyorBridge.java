package com.surveyor.app;

import android.content.Context;
import android.webkit.JavascriptInterface;

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.io.Reader;
import java.io.Writer;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;

/**
 * JS bridge exposed to the web app as window.SurveyorNative.
 *
 * SECURITY: this WebView only ever loads our own bundled pages under
 * file:///android_asset/www/ — the WebViewClient keeps all navigation inside
 * the WebView and no remote content is ever loaded (the app is fully offline,
 * no INTERNET permission) — so the bridge is reachable only by our own code.
 * minSdk 26 (> 17), so only @JavascriptInterface-annotated methods are exposed.
 *
 * Storage layout (contract v1.1 addendum): blobs live under
 * getFilesDir()/usermaps/. Each blob key is hashed (SHA-1, hex) to a safe
 * filename, which avoids path traversal and any weird-character issues:
 *   <sha1>.bin  — the blob content (UTF-8 text: data-URL / JSON, can be MBs)
 *   <sha1>.key  — sidecar holding the ORIGINAL key (UTF-8), so listBlobs()
 *                 can return original keys without a separate index file.
 * Writes go to a .tmp file first, then rename — a crash mid-write never
 * corrupts an existing blob.
 *
 * All methods are synchronous String-in/String-out per the contract, and no
 * exception may escape a bridge method (each body is wrapped in catch-all).
 * Methods are synchronized: WebView may invoke them on a background thread.
 */
public class SurveyorBridge {

    private static final int MAX_KEY_LENGTH = 512;
    private static final int IO_BUFFER = 64 * 1024;

    private final File dir;

    public SurveyorBridge(Context context) {
        this.dir = new File(context.getFilesDir(), "usermaps");
    }

    /** @return "ok" or "err:&lt;message&gt;" */
    @JavascriptInterface
    public synchronized String saveBlob(String key, String content) {
        try {
            String err = validateKey(key);
            if (err != null) return err;
            if (content == null) return "err:content is null";
            if (!dir.isDirectory() && !dir.mkdirs()) {
                return "err:cannot create storage dir";
            }
            String hash = sha1Hex(key);
            File bin = new File(dir, hash + ".bin");
            File keyFile = new File(dir, hash + ".key");
            File tmp = new File(dir, hash + ".bin.tmp");

            writeText(tmp, content);
            if (bin.exists() && !bin.delete()) {
                tmp.delete();
                return "err:cannot replace existing blob";
            }
            if (!tmp.renameTo(bin)) {
                tmp.delete();
                return "err:cannot finalize blob file";
            }
            writeText(keyFile, key);
            return "ok";
        } catch (Throwable t) {
            return "err:" + safeMessage(t);
        }
    }

    /** @return blob content, or "" if missing (or unreadable). */
    @JavascriptInterface
    public synchronized String loadBlob(String key) {
        try {
            if (validateKey(key) != null) return "";
            File bin = new File(dir, sha1Hex(key) + ".bin");
            if (!bin.isFile()) return "";
            return readText(bin);
        } catch (Throwable t) {
            return "";
        }
    }

    /** @return "ok" (idempotent: also for an already-absent key) or "err:&lt;message&gt;" */
    @JavascriptInterface
    public synchronized String deleteBlob(String key) {
        try {
            String err = validateKey(key);
            if (err != null) return err;
            String hash = sha1Hex(key);
            File bin = new File(dir, hash + ".bin");
            File keyFile = new File(dir, hash + ".key");
            boolean ok = true;
            if (bin.exists()) ok = bin.delete();
            if (keyFile.exists()) keyFile.delete(); // best effort; orphan sidecars are re-filtered in listBlobs
            return ok ? "ok" : "err:cannot delete blob file";
        } catch (Throwable t) {
            return "err:" + safeMessage(t);
        }
    }

    /** @return JSON array of the ORIGINAL keys of all stored blobs, e.g. ["k1","k2"]. */
    @JavascriptInterface
    public synchronized String listBlobs() {
        try {
            File[] files = dir.listFiles();
            StringBuilder json = new StringBuilder("[");
            if (files != null) {
                for (File f : files) {
                    String name = f.getName();
                    if (!name.endsWith(".key")) continue;
                    // Only list keys whose blob actually exists.
                    String hash = name.substring(0, name.length() - 4);
                    if (!new File(dir, hash + ".bin").isFile()) continue;
                    String key = readText(f);
                    if (json.length() > 1) json.append(',');
                    appendJsonString(json, key);
                }
            }
            return json.append(']').toString();
        } catch (Throwable t) {
            return "[]";
        }
    }

    // ------------------------------------------------------------ internals

    /** @return null if valid, else an "err:..." string. */
    private static String validateKey(String key) {
        if (key == null || key.isEmpty()) return "err:empty key";
        if (key.length() > MAX_KEY_LENGTH) return "err:key too long (max " + MAX_KEY_LENGTH + ")";
        return null;
    }

    private static String sha1Hex(String key) throws Exception {
        byte[] digest = MessageDigest.getInstance("SHA-1")
                .digest(key.getBytes(StandardCharsets.UTF_8));
        StringBuilder hex = new StringBuilder(digest.length * 2);
        for (byte b : digest) {
            hex.append(Character.forDigit((b >> 4) & 0xF, 16));
            hex.append(Character.forDigit(b & 0xF, 16));
        }
        return hex.toString();
    }

    /** Buffered UTF-8 write (content can be several MB). */
    private static void writeText(File file, String text) throws Exception {
        Writer w = new BufferedWriter(
                new OutputStreamWriter(new FileOutputStream(file), StandardCharsets.UTF_8),
                IO_BUFFER);
        try {
            w.write(text);
            w.flush();
        } finally {
            w.close();
        }
    }

    /** Buffered UTF-8 read. */
    private static String readText(File file) throws Exception {
        StringBuilder sb = new StringBuilder(Math.max(256, (int) Math.min(file.length(), 1 << 26)));
        Reader r = new BufferedReader(
                new InputStreamReader(new FileInputStream(file), StandardCharsets.UTF_8),
                IO_BUFFER);
        try {
            char[] buf = new char[IO_BUFFER];
            int n;
            while ((n = r.read(buf)) != -1) {
                sb.append(buf, 0, n);
            }
        } finally {
            r.close();
        }
        return sb.toString();
    }

    /** Appends s as a JSON string literal (quoted, escaped). */
    private static void appendJsonString(StringBuilder out, String s) {
        out.append('"');
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"':  out.append("\\\""); break;
                case '\\': out.append("\\\\"); break;
                case '\n': out.append("\\n");  break;
                case '\r': out.append("\\r");  break;
                case '\t': out.append("\\t");  break;
                default:
                    if (c < 0x20) {
                        out.append(String.format("\\u%04x", (int) c));
                    } else {
                        out.append(c);
                    }
            }
        }
        out.append('"');
    }

    private static String safeMessage(Throwable t) {
        String m = t.getMessage();
        return t.getClass().getSimpleName() + (m == null ? "" : (": " + m));
    }
}
