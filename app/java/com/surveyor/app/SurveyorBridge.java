package com.surveyor.app;

import android.Manifest;
import android.app.Activity;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.hardware.GeomagneticField;
import android.hardware.Sensor;
import android.hardware.SensorEvent;
import android.hardware.SensorEventListener;
import android.hardware.SensorManager;
import android.location.Location;
import android.location.LocationListener;
import android.location.LocationManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.Surface;
import android.webkit.JavascriptInterface;
import android.webkit.WebView;

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.io.OutputStream;
import java.io.OutputStreamWriter;
import java.io.Reader;
import java.io.Writer;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.concurrent.atomic.AtomicBoolean;

import javax.net.ssl.HttpsURLConnection;

/**
 * JS bridge exposed to the web app as window.SurveyorNative.
 *
 * SECURITY: this WebView only ever loads our own bundled pages under
 * file:///android_asset/www/ — the WebViewClient keeps all navigation inside
 * the WebView and no remote content is ever rendered in it (INTERNET is held
 * since v1.3 solely for the self-update download; nothing remote is loaded
 * into the WebView) — so the bridge is reachable only by our own code.
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

    // ---- self-update (v1.3 addendum) ----
    private static final String UPDATE_URL_PREFIX = "https://github.com/ManxomeFoe/surveyor/";
    private static final int CONNECT_TIMEOUT_MS = 10_000;
    private static final int READ_TIMEOUT_MS = 30_000;
    private static final int MAX_REDIRECTS = 5;
    /** Progress events throttled to at most ~10/sec. */
    private static final long PROGRESS_INTERVAL_MS = 100;

    // ---- live location (v1.6 addendum) ----
    /** Request code for the location runtime permission (file chooser uses 1001). */
    static final int REQUEST_LOCATION_PERMISSION = 1002;
    private static final long LOCATION_INTERVAL_MS = 2000;
    private static final float LOCATION_MIN_DISTANCE_M = 1f;

    // ---- compass heading (v1.7 addendum) ----
    /** Heading events: at most every 100 ms AND only on a >= 1 degree change. */
    private static final long HEADING_INTERVAL_MS = 100;
    private static final double HEADING_MIN_DELTA_DEG = 1.0;
    /** Declination cache invalidation: fix moved > 1 km or > 1 h passed. */
    private static final float DECLINATION_MAX_DISTANCE_M = 1000f;
    private static final long DECLINATION_MAX_AGE_MS = 3_600_000L;

    private final File dir;
    private final Activity activity;
    private final WebView webView;
    private final File updateApk;
    private final File updateTmp;
    private final AtomicBoolean downloadInFlight = new AtomicBoolean(false);

    /** JS-desired location state; set from the JS bridge thread, read on UI thread. */
    private volatile boolean locationDesired = false;
    // The fields below are touched ONLY on the UI thread.
    private boolean locationListening = false;
    private boolean locationPermissionPending = false;
    private LocationManager locationManager;

    // ---- compass state (v1.7) ----
    /** JS-desired compass state; set from the JS bridge thread, read on UI thread. */
    private volatile boolean compassDesired = false;
    /** Latest location fix seen by the bridge (declination source). Main looper writes. */
    private volatile Location lastFix;
    // The fields below are touched ONLY on the UI thread (sensor callbacks
    // are delivered on the main looper via an explicit Handler).
    private boolean compassListening = false;
    private boolean compassUnavailableSent = false;
    private SensorManager sensorManager;
    private final float[] rotationMatrix = new float[9];
    private final float[] remappedMatrix = new float[9];
    private final float[] orientationAngles = new float[3];
    private final float[] lastAccel = new float[3];
    private final float[] lastMag = new float[3];
    private boolean haveAccel = false;
    private boolean haveMag = false;
    private long lastHeadingEmitMs = 0;
    private double lastHeadingDeg = Double.NaN;
    private float cachedDeclinationDeg = 0f;
    private Location declinationFix;
    private long declinationComputedMs = 0;

    /** Single listener for both providers. Callbacks arrive on the main looper. */
    private final LocationListener locationListener = new LocationListener() {
        @Override
        public void onLocationChanged(Location loc) {
            try {
                if (loc == null) return;
                lastFix = loc; // v1.7: newest fix doubles as the declination source
                emitLocationEvent("{\"phase\":\"fix\",\"lat\":" + loc.getLatitude()
                        + ",\"lon\":" + loc.getLongitude()
                        + ",\"accuracy\":" + (double) loc.getAccuracy()
                        + ",\"ts\":" + loc.getTime() + "}");
            } catch (Throwable ignored) {
                // never let a callback crash the app
            }
        }

        // Legacy interface methods (default since API 30, abstract before —
        // explicit no-op overrides keep every API level safe).
        @Override public void onStatusChanged(String provider, int status, Bundle extras) { }
        @Override public void onProviderEnabled(String provider) { }
        @Override public void onProviderDisabled(String provider) { }
    };

    public SurveyorBridge(Activity activity, WebView webView) {
        this.activity = activity;
        this.webView = webView;
        this.dir = new File(activity.getFilesDir(), "usermaps");
        this.updateApk = new File(activity.getFilesDir(), ApkProvider.APK_NAME);
        this.updateTmp = new File(activity.getFilesDir(), ApkProvider.APK_NAME + ".tmp");
        // A leftover update.apk from a previous (installed or abandoned) update
        // is stale by definition on a fresh app start — delete it.
        if (updateApk.exists()) updateApk.delete();
        if (updateTmp.exists()) updateTmp.delete();
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

    // ------------------------------------------------- self-update (v1.3)

    /**
     * @return JSON like {"versionName":"1.3","versionCode":4} from PackageInfo.
     * Best-effort on failure — never throws.
     */
    @JavascriptInterface
    public String getAppVersion() {
        String versionName = "unknown";
        long versionCode = 0;
        try {
            PackageInfo pi = activity.getPackageManager()
                    .getPackageInfo(activity.getPackageName(), 0);
            if (pi.versionName != null) versionName = pi.versionName;
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                versionCode = pi.getLongVersionCode();
            } else {
                @SuppressWarnings("deprecation")
                long legacy = pi.versionCode;
                versionCode = legacy;
            }
        } catch (Throwable ignored) {
            // keep best-effort defaults
        }
        StringBuilder json = new StringBuilder("{\"versionName\":");
        appendJsonString(json, versionName);
        json.append(",\"versionCode\":").append(versionCode).append('}');
        return json.toString();
    }

    /**
     * Validates the URL and kicks off a background download of the release
     * APK; progress/done/error are reported asynchronously to
     * window.__updateEvent via evaluateJavascript on the UI thread.
     *
     * @return "ok" if the download was started, "err:busy" if one is already
     *         in flight, or "err:&lt;message&gt;" for invalid input. Never throws.
     */
    @JavascriptInterface
    public String startUpdateDownload(String url) {
        try {
            if (url == null || !url.startsWith(UPDATE_URL_PREFIX)) {
                return "err:invalid url (must start with " + UPDATE_URL_PREFIX + ")";
            }
            if (!downloadInFlight.compareAndSet(false, true)) {
                return "err:busy";
            }
            final String downloadUrl = url;
            Thread t = new Thread(new Runnable() {
                @Override
                public void run() {
                    runDownload(downloadUrl);
                }
            }, "surveyor-update-download");
            t.setDaemon(true);
            t.start();
            return "ok";
        } catch (Throwable t) {
            downloadInFlight.set(false);
            return "err:" + safeMessage(t);
        }
    }

    /** Background worker: fetch, stream to .tmp, rename, fire installer. */
    private void runDownload(String url) {
        HttpURLConnection conn = null;
        InputStream in = null;
        OutputStream out = null;
        try {
            // Follow redirects manually so we can insist every hop is https
            // (GitHub 302s releases to objects.githubusercontent.com).
            String current = url;
            for (int hop = 0; ; hop++) {
                URL u = new URL(current);
                if (!"https".equals(u.getProtocol())) {
                    throw new IllegalStateException("non-https redirect target");
                }
                conn = (HttpsURLConnection) u.openConnection();
                conn.setConnectTimeout(CONNECT_TIMEOUT_MS);
                conn.setReadTimeout(READ_TIMEOUT_MS);
                conn.setInstanceFollowRedirects(false);
                int code = conn.getResponseCode();
                if (code == 301 || code == 302 || code == 303 || code == 307 || code == 308) {
                    String loc = conn.getHeaderField("Location");
                    conn.disconnect();
                    conn = null;
                    if (loc == null || hop >= MAX_REDIRECTS) {
                        throw new IllegalStateException("bad redirect (HTTP " + code + ")");
                    }
                    current = new URL(u, loc).toString();
                    continue;
                }
                if (code != HttpURLConnection.HTTP_OK) {
                    throw new IllegalStateException("HTTP " + code);
                }
                break;
            }

            long total = conn.getContentLengthLong(); // may be -1
            in = conn.getInputStream();
            out = new FileOutputStream(updateTmp);
            byte[] buf = new byte[IO_BUFFER];
            long received = 0;
            long lastEvent = 0;
            int lastPct = -1;
            int n;
            while ((n = in.read(buf)) != -1) {
                out.write(buf, 0, n);
                received += n;
                long now = System.currentTimeMillis();
                if (now - lastEvent >= PROGRESS_INTERVAL_MS) {
                    lastEvent = now;
                    int pct = total > 0 ? (int) (received * 100 / total) : -1;
                    if (pct != lastPct) {
                        lastPct = pct;
                        emitUpdateEvent("{\"phase\":\"progress\",\"pct\":" + pct + "}");
                    }
                }
            }
            out.flush();
            out.close();
            out = null;

            if (updateApk.exists() && !updateApk.delete()) {
                throw new IllegalStateException("cannot replace previous update.apk");
            }
            if (!updateTmp.renameTo(updateApk)) {
                throw new IllegalStateException("cannot finalize update.apk");
            }

            emitUpdateEvent("{\"phase\":\"progress\",\"pct\":100}");
            emitUpdateEvent("{\"phase\":\"done\"}");
            launchInstaller();
        } catch (Throwable t) {
            updateTmp.delete();
            StringBuilder ev = new StringBuilder("{\"phase\":\"error\",\"message\":");
            appendJsonString(ev, safeMessage(t));
            ev.append('}');
            emitUpdateEvent(ev.toString());
        } finally {
            if (out != null) try { out.close(); } catch (Throwable ignored) { }
            if (in != null) try { in.close(); } catch (Throwable ignored) { }
            if (conn != null) try { conn.disconnect(); } catch (Throwable ignored) { }
            downloadInFlight.set(false);
        }
    }

    /**
     * Posts window.__updateEvent(<json>) into the page. evaluateJavascript
     * must run on the UI thread; the download thread hands it off via
     * runOnUiThread, and the UI-thread body re-checks Activity/WebView state
     * so a teardown race can never crash the app.
     */
    private void emitUpdateEvent(final String json) {
        try {
            activity.runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    try {
                        if (activity.isFinishing() || activity.isDestroyed()) return;
                        webView.evaluateJavascript(
                                "window.__updateEvent&&window.__updateEvent(" + json + ");",
                                null);
                    } catch (Throwable ignored) {
                        // WebView torn down mid-flight; drop the event.
                    }
                }
            });
        } catch (Throwable ignored) {
            // Activity gone; drop the event.
        }
    }

    /** ACTION_VIEW of our content:// URI so the system installer takes over. */
    private void launchInstaller() {
        try {
            activity.runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    try {
                        if (activity.isFinishing() || activity.isDestroyed()) return;
                        Intent intent = new Intent(Intent.ACTION_VIEW);
                        intent.setDataAndType(ApkProvider.CONTENT_URI,
                                "application/vnd.android.package-archive");
                        intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION
                                | Intent.FLAG_ACTIVITY_NEW_TASK);
                        activity.startActivity(intent);
                    } catch (Throwable t) {
                        StringBuilder ev = new StringBuilder("{\"phase\":\"error\",\"message\":");
                        appendJsonString(ev, "installer: " + safeMessage(t));
                        ev.append('}');
                        emitUpdateEvent(ev.toString());
                    }
                }
            });
        } catch (Throwable ignored) {
            // Activity gone.
        }
    }

    // ------------------------------------------------- live location (v1.6)

    /**
     * Starts (or resumes) the live-location stream. Asynchronous: permission
     * prompting and provider attachment happen on the UI thread; results are
     * reported to window.__locationEvent as
     * {phase:'started'|'fix'|'denied'|'unavailable'|'stopped'}.
     *
     * @return "ok" once the flow is initiated (even if permission is still
     *         pending), or "err:&lt;reason&gt;". Never throws.
     */
    @JavascriptInterface
    public String startLocation() {
        try {
            locationDesired = true;
            activity.runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    beginLocationFlow();
                }
            });
            return "ok";
        } catch (Throwable t) {
            locationDesired = false;
            return "err:" + safeMessage(t);
        }
    }

    /** Stops the stream and clears the desired flag. @return "ok" (never throws). */
    @JavascriptInterface
    public String stopLocation() {
        try {
            locationDesired = false;
            activity.runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    detachLocationUpdates();
                    emitLocationEvent("{\"phase\":\"stopped\"}");
                }
            });
            return "ok";
        } catch (Throwable t) {
            return "ok"; // stop is best-effort by contract; desired flag is already false
        }
    }

    /** MainActivity.onPause hook: silently detach (JS is paused too). */
    void onActivityPause() {
        try {
            detachLocationUpdates();
        } catch (Throwable ignored) { }
        try {
            detachCompass();
        } catch (Throwable ignored) { }
    }

    /** MainActivity.onResume hook: re-attach if JS still wants the streams. */
    void onActivityResume() {
        try {
            if (locationDesired) {
                beginLocationFlow();
            }
        } catch (Throwable ignored) { }
        try {
            if (compassDesired) {
                attachCompass();
            }
        } catch (Throwable ignored) { }
    }

    /**
     * MainActivity routes Activity.onRequestPermissionsResult here.
     * Proceeds if EITHER permission was granted (coarse-only just means worse
     * accuracy); emits {phase:'denied'} and clears the desired flag otherwise
     * (a later startLocation() may re-request; the system auto-suppresses the
     * dialog after "don't ask again" and we land back here with a denial).
     */
    void onLocationPermissionResult(int[] grantResults) {
        try {
            locationPermissionPending = false;
            boolean granted = false;
            if (grantResults != null) {
                for (int r : grantResults) {
                    if (r == PackageManager.PERMISSION_GRANTED) {
                        granted = true;
                        break;
                    }
                }
            }
            if (!granted) {
                locationDesired = false;
                emitLocationEvent("{\"phase\":\"denied\"}");
                return;
            }
            if (locationDesired) {
                attachLocationUpdates();
            }
        } catch (Throwable ignored) { }
    }

    /** UI thread. Checks permission, requesting it on first use, then attaches. */
    private void beginLocationFlow() {
        try {
            if (!locationDesired) return;
            if (hasLocationPermission()) {
                attachLocationUpdates();
                return;
            }
            if (locationPermissionPending) return; // dialog already up
            locationPermissionPending = true;
            activity.requestPermissions(new String[] {
                    Manifest.permission.ACCESS_FINE_LOCATION,
                    Manifest.permission.ACCESS_COARSE_LOCATION
            }, REQUEST_LOCATION_PERMISSION);
        } catch (Throwable t) {
            locationPermissionPending = false;
            emitLocationEvent("{\"phase\":\"unavailable\"}");
        }
    }

    private boolean hasLocationPermission() {
        return activity.checkSelfPermission(Manifest.permission.ACCESS_FINE_LOCATION)
                        == PackageManager.PERMISSION_GRANTED
                || activity.checkSelfPermission(Manifest.permission.ACCESS_COARSE_LOCATION)
                        == PackageManager.PERMISSION_GRANTED;
    }

    /**
     * UI thread. Subscribes the single listener to every enabled provider
     * (GPS + network, 2000 ms / 1 m) on the main looper. SecurityException or
     * any other failure degrades to {phase:'unavailable'} — never a crash.
     */
    private void attachLocationUpdates() {
        if (locationListening) return;
        try {
            if (locationManager == null) {
                locationManager = (LocationManager)
                        activity.getSystemService(Activity.LOCATION_SERVICE);
            }
            if (locationManager == null) {
                emitLocationEvent("{\"phase\":\"unavailable\"}");
                return;
            }
            int attached = 0;
            for (String provider : new String[] {
                    LocationManager.GPS_PROVIDER, LocationManager.NETWORK_PROVIDER }) {
                try {
                    if (locationManager.isProviderEnabled(provider)) {
                        locationManager.requestLocationUpdates(provider,
                                LOCATION_INTERVAL_MS, LOCATION_MIN_DISTANCE_M,
                                locationListener, Looper.getMainLooper());
                        attached++;
                    }
                } catch (Throwable ignored) {
                    // unknown/disabled provider or SecurityException on this
                    // provider — try the other one
                }
            }
            if (attached == 0) {
                // No enabled provider right now. Keep locationDesired: if the
                // user enables GPS and returns to the app, onResume re-tries.
                emitLocationEvent("{\"phase\":\"unavailable\"}");
                return;
            }
            locationListening = true;
            emitLocationEvent("{\"phase\":\"started\"}");
        } catch (Throwable t) {
            emitLocationEvent("{\"phase\":\"unavailable\"}");
        }
    }

    /** UI thread. Removes the listener; safe to call when not listening. */
    private void detachLocationUpdates() {
        if (!locationListening) return;
        locationListening = false;
        try {
            if (locationManager != null) {
                locationManager.removeUpdates(locationListener);
            }
        } catch (Throwable ignored) { }
    }

    /** Same hardened runOnUiThread + evaluateJavascript path as update events. */
    private void emitLocationEvent(final String json) {
        try {
            activity.runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    try {
                        if (activity.isFinishing() || activity.isDestroyed()) return;
                        webView.evaluateJavascript(
                                "window.__locationEvent&&window.__locationEvent(" + json + ");",
                                null);
                    } catch (Throwable ignored) {
                        // WebView torn down; drop the event.
                    }
                }
            });
        } catch (Throwable ignored) {
            // Activity gone; drop the event.
        }
    }

    // ----------------------------------------------- compass heading (v1.7)

    /** Sensor callbacks arrive on the main looper (explicit Handler below). */
    private final SensorEventListener compassListener = new SensorEventListener() {
        @Override
        public void onSensorChanged(SensorEvent event) {
            try {
                boolean haveMatrix = false;
                switch (event.sensor.getType()) {
                    case Sensor.TYPE_ROTATION_VECTOR: {
                        // Some devices report >4 values, which older
                        // getRotationMatrixFromVector implementations reject.
                        float[] v = event.values;
                        if (v.length > 4) {
                            float[] four = new float[4];
                            System.arraycopy(v, 0, four, 0, 4);
                            v = four;
                        }
                        SensorManager.getRotationMatrixFromVector(rotationMatrix, v);
                        haveMatrix = true;
                        break;
                    }
                    case Sensor.TYPE_ACCELEROMETER:
                        System.arraycopy(event.values, 0, lastAccel, 0, 3);
                        haveAccel = true;
                        break;
                    case Sensor.TYPE_MAGNETIC_FIELD:
                        System.arraycopy(event.values, 0, lastMag, 0, 3);
                        haveMag = true;
                        break;
                    default:
                        return;
                }
                if (!haveMatrix) {
                    if (!haveAccel || !haveMag) return;
                    if (!SensorManager.getRotationMatrix(
                            rotationMatrix, null, lastAccel, lastMag)) {
                        return; // degenerate reading (free fall etc.)
                    }
                }
                handleRotationMatrix();
            } catch (Throwable ignored) {
                // never let a sensor callback crash the app
            }
        }

        @Override
        public void onAccuracyChanged(Sensor sensor, int accuracy) { }
    };

    /**
     * Starts the compass stream. Headings are posted to
     * window.__headingEvent({deg}) — degrees clockwise from TRUE north —
     * throttled to >= 100 ms apart and >= 1 degree change;
     * {phase:'unavailable'} is emitted once if no usable sensor exists.
     *
     * @return "ok" once the flow is initiated, or "err:&lt;reason&gt;". Never throws.
     */
    @JavascriptInterface
    public String startCompass() {
        try {
            compassDesired = true;
            activity.runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    compassUnavailableSent = false; // fresh start may re-report
                    attachCompass();
                }
            });
            return "ok";
        } catch (Throwable t) {
            compassDesired = false;
            return "err:" + safeMessage(t);
        }
    }

    /** Stops the compass stream. @return "ok" (never throws). */
    @JavascriptInterface
    public String stopCompass() {
        try {
            compassDesired = false;
            activity.runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    detachCompass();
                }
            });
            return "ok";
        } catch (Throwable t) {
            return "ok"; // desired flag already cleared; stop is best-effort
        }
    }

    /**
     * UI thread. Registers the rotation-vector sensor (preferred) or the
     * accelerometer+magnetometer pair (fallback) at SENSOR_DELAY_UI on a
     * main-looper Handler. No usable sensor -> {phase:'unavailable'} once.
     */
    private void attachCompass() {
        if (compassListening || !compassDesired) return;
        try {
            if (sensorManager == null) {
                sensorManager = (SensorManager)
                        activity.getSystemService(Activity.SENSOR_SERVICE);
            }
            if (sensorManager == null) {
                emitCompassUnavailableOnce();
                return;
            }
            Handler mainHandler = new Handler(Looper.getMainLooper());
            boolean registered = false;

            Sensor rotation = sensorManager.getDefaultSensor(Sensor.TYPE_ROTATION_VECTOR);
            if (rotation != null) {
                registered = sensorManager.registerListener(compassListener, rotation,
                        SensorManager.SENSOR_DELAY_UI, mainHandler);
            }
            if (!registered) {
                Sensor accel = sensorManager.getDefaultSensor(Sensor.TYPE_ACCELEROMETER);
                Sensor mag = sensorManager.getDefaultSensor(Sensor.TYPE_MAGNETIC_FIELD);
                if (accel != null && mag != null) {
                    haveAccel = false;
                    haveMag = false;
                    boolean okAccel = sensorManager.registerListener(compassListener, accel,
                            SensorManager.SENSOR_DELAY_UI, mainHandler);
                    boolean okMag = sensorManager.registerListener(compassListener, mag,
                            SensorManager.SENSOR_DELAY_UI, mainHandler);
                    registered = okAccel && okMag;
                    if (!registered) {
                        sensorManager.unregisterListener(compassListener);
                    }
                }
            }
            if (!registered) {
                emitCompassUnavailableOnce();
                return;
            }
            compassListening = true;
            lastHeadingDeg = Double.NaN; // always emit the first fresh heading
            lastHeadingEmitMs = 0;
        } catch (Throwable t) {
            emitCompassUnavailableOnce();
        }
    }

    /** UI thread. Unregisters the sensor listener; safe when not listening. */
    private void detachCompass() {
        if (!compassListening) return;
        compassListening = false;
        try {
            if (sensorManager != null) {
                sensorManager.unregisterListener(compassListener);
            }
        } catch (Throwable ignored) { }
    }

    /** UI thread. Rotation matrix -> display-remapped true-north azimuth -> JS. */
    private void handleRotationMatrix() {
        // Remap for the current display rotation so azimuth stays correct in
        // landscape/reverse orientations.
        int axisX = SensorManager.AXIS_X;
        int axisY = SensorManager.AXIS_Y;
        try {
            int rotation = activity.getWindowManager().getDefaultDisplay().getRotation();
            switch (rotation) {
                case Surface.ROTATION_90:
                    axisX = SensorManager.AXIS_Y;
                    axisY = SensorManager.AXIS_MINUS_X;
                    break;
                case Surface.ROTATION_180:
                    axisX = SensorManager.AXIS_MINUS_X;
                    axisY = SensorManager.AXIS_MINUS_Y;
                    break;
                case Surface.ROTATION_270:
                    axisX = SensorManager.AXIS_MINUS_Y;
                    axisY = SensorManager.AXIS_X;
                    break;
                default:
                    break; // ROTATION_0: identity
            }
        } catch (Throwable ignored) {
            // display unavailable — use identity remap
        }
        SensorManager.remapCoordinateSystem(rotationMatrix, axisX, axisY, remappedMatrix);
        SensorManager.getOrientation(remappedMatrix, orientationAngles);

        double deg = Math.toDegrees(orientationAngles[0]) + currentDeclinationDeg();
        deg = ((deg % 360.0) + 360.0) % 360.0; // normalize to [0, 360)

        long now = System.currentTimeMillis();
        if (now - lastHeadingEmitMs < HEADING_INTERVAL_MS) return;
        if (!Double.isNaN(lastHeadingDeg)) {
            double delta = Math.abs(deg - lastHeadingDeg);
            if (delta > 180.0) delta = 360.0 - delta; // shortest angular distance
            if (delta < HEADING_MIN_DELTA_DEG) return;
        }
        lastHeadingEmitMs = now;
        lastHeadingDeg = deg;
        double rounded = Math.round(deg * 10.0) / 10.0;
        emitHeadingEvent("{\"deg\":" + rounded + "}");
    }

    /**
     * UI thread. Magnetic declination at the latest fix, cached and only
     * recomputed when the fix moved > 1 km or the value is > 1 h old.
     * 0 until a location fix exists.
     */
    private float currentDeclinationDeg() {
        try {
            Location fix = lastFix;
            if (fix == null) return cachedDeclinationDeg; // 0 until first fix
            long now = System.currentTimeMillis();
            if (declinationFix != null
                    && declinationFix.distanceTo(fix) <= DECLINATION_MAX_DISTANCE_M
                    && now - declinationComputedMs <= DECLINATION_MAX_AGE_MS) {
                return cachedDeclinationDeg;
            }
            GeomagneticField field = new GeomagneticField(
                    (float) fix.getLatitude(), (float) fix.getLongitude(),
                    (float) fix.getAltitude(), now);
            cachedDeclinationDeg = field.getDeclination();
            declinationFix = fix;
            declinationComputedMs = now;
            return cachedDeclinationDeg;
        } catch (Throwable ignored) {
            return cachedDeclinationDeg;
        }
    }

    /** Emits {phase:'unavailable'} at most once per startCompass() cycle. */
    private void emitCompassUnavailableOnce() {
        if (compassUnavailableSent) return;
        compassUnavailableSent = true;
        emitHeadingEvent("{\"phase\":\"unavailable\"}");
    }

    /** Same hardened runOnUiThread + evaluateJavascript path as the others. */
    private void emitHeadingEvent(final String json) {
        try {
            activity.runOnUiThread(new Runnable() {
                @Override
                public void run() {
                    try {
                        if (activity.isFinishing() || activity.isDestroyed()) return;
                        webView.evaluateJavascript(
                                "window.__headingEvent&&window.__headingEvent(" + json + ");",
                                null);
                    } catch (Throwable ignored) {
                        // WebView torn down; drop the event.
                    }
                }
            });
        } catch (Throwable ignored) {
            // Activity gone; drop the event.
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
