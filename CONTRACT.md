# Surveyor — Shared Build Contract

Android survey app for door-to-door canvassing in Unalakleet, AK.
Source map: /Users/cashrarrington/Downloads/unalakleet_street_plan.pdf
(vector street plan, 2415.2 x 3145.8 pt, 376 numbered buildings, legend panel on right side ~x>1840pt).

## Directory layout

```
Surveyor/
├── CONTRACT.md              (this file — do not edit)
├── extraction/              (Agent A: python extraction scripts + QA renders)
├── app/                     (Agent C: Android project)
│   ├── AndroidManifest.xml
│   ├── java/com/surveyor/app/MainActivity.java
│   ├── res/...
│   └── assets/www/          (Agent B: web app)
│       ├── index.html
│       ├── app.js / style.css (naming up to Agent B)
│       └── maps/
│           ├── index.js               (Agent B)
│           └── unalakleet/
│               ├── base.svg           (Agent A)
│               └── data.js            (Agent A)
├── build.sh                 (Agent C — builds dist/surveyor.apk)
└── dist/                    (build output)
```

## Data contract (Agent A produces, Agent B consumes)

`app/assets/www/maps/index.js`  (Agent B owns):
```js
window.COMMUNITIES = [
  { id: "unalakleet", name: "Unalakleet", dir: "maps/unalakleet" }
];
```

`app/assets/www/maps/unalakleet/data.js`  (Agent A owns):
```js
window.MAP_DATA = window.MAP_DATA || {};
window.MAP_DATA["unalakleet"] = {
  name: "Unalakleet",
  // viewBox of base.svg, in SVG user units == PDF points, cropped to map area (legend panel excluded)
  viewBox: [x0, y0, width, height],
  baseSvg: "maps/unalakleet/base.svg",
  // 376 entries, n = printed house number, pts = polygon in same coordinate space
  buildings: [
    { n: 1, cx: 123.4, cy: 567.8, pts: [[x,y],[x,y],...] },
    ...
  ],
  landmarks: [
    { label: "NSHC Medical Clinic", x: ..., y: ... },
    { label: "Alaska Commercial Company", x: ..., y: ... }
  ]
};
```

- `base.svg` root element MUST carry the exact same viewBox as `viewBox` above so an
  overlay `<svg>` with that viewBox aligns perfectly when stacked on an `<img>` of base.svg.
- All data files load via `<script>` tags (NO fetch/XHR — app runs under file:// in a WebView).

## Runtime environment
- Android WebView, file:///android_asset/www/index.html
- JS enabled, DOM storage enabled, file access from file URLs enabled.
- No network at runtime. No CDN. Vanilla JS only. localStorage for persistence.

## User-uploaded maps (v1.1 addendum)

Users can add their own community maps at runtime with full feature parity
(zoom, markers, house coloring + legend, search, switcher).

### Accepted uploads
- Raster images (png/jpg/webp) — downscaled client-side via canvas to max 3000px
  long edge, stored as JPEG data URL (q0.85, white background).
- SVG files — stored as text data URL, viewBox from intrinsic size.
- JSON "map package" — an object matching the MAP_DATA schema with an extra
  `baseImage` field (data URL) in place of `baseSvg`; lets pipeline-generated maps
  (like Unalakleet) be imported wholesale.

### Buildings on uploaded maps
Uploaded images have no building data → in-app **building editor** (only for user
maps, never for built-ins): a mode where tap places a numbered building
(auto-increment, editable number) and drag draws a rectangle building. Buildings
stored per community in localStorage `surveyor:<id>:buildings`, same shape as
MAP_DATA buildings entries. They are colorable/searchable/labeled identically to
built-in buildings. Tap in edit mode → renumber/delete.

### Storage layers (web side must try in this order)
1. `window.SurveyorNative` (Android JS bridge, see below) — authoritative in the APK
2. IndexedDB — browser dev/testing
3. localStorage — last resort
Registry of user maps in localStorage: `surveyor:userMaps` =
`[{id, name, blobKey, viewBox, created}]` (id like `user_<ts>`). Blob store holds
the base image data URL under blobKey. User maps appear in the community dropdown
below built-ins, with rename/delete (confirm) in the ⋮ menu when active.

### Android JS bridge (Agent C)
`addJavascriptInterface(obj, "SurveyorNative")`, all methods synchronous Strings,
files under `getFilesDir()/usermaps/<sha1-sanitized key>`:
- `saveBlob(String key, String content)` → `"ok"` or `"err:<message>"`
- `loadBlob(String key)` → content, or `""` if missing
- `deleteBlob(String key)` → `"ok"` / `"err:<message>"`
- `listBlobs()` → JSON array of keys, e.g. `["k1","k2"]`
Plus `onShowFileChooser` support in a WebChromeClient (ACTION_GET_CONTENT via
fileChooserParams.createIntent(), classic onActivityResult) so `<input type=file>`
works inside the WebView.

## Auto-detect buildings on uploaded maps (v1.2 addendum)

Client-side, vanilla JS, no network. On user maps only. Detects building-like
blobs in the base image and creates buildings from them; the user confirms a
preview first and corrects afterwards with the existing editor.

Algorithm (canvas + typed arrays, no recursion):
1. Draw base image to an offscreen canvas capped at ~1400px long edge (detection
   resolution), getImageData.
2. Estimate background from border-pixel histogram (4 bits/channel quantization).
3. Candidate color groups = dominant non-background quantized bins (merge nearby
   bins). For each of the top groups, build a binary mask and run connected
   components (two-pass or stack-based flood fill on Uint8/Int32 arrays).
4. A component is building-like when: min side >= 4px at detection res, max side
   <= ~8% of image long edge, bboxFillRatio >= ~0.5, aspect <= ~6.
5. Score each color group by its count of building-like components; take the best
   group plus any group scoring >= ~40% of it (plans may use two building shades).
6. Map component bboxes back to map coords as 4-pt rects; drop detections whose
   center falls inside an existing building (or IoU > 0.3 with one).
7. Number in rows north->south, west->east (row clustering by median blob height),
   continuing from max existing number + 1 (or 1).

UX: after a raster/SVG upload finishes, offer "Detect buildings automatically?";
also a detect button while in edit mode. Detection runs under the busy overlay,
then shows dashed preview outlines + "Add N buildings / Cancel". Cap: if > 1500
detections, abort with a friendly message. All tunables in one const block.

## Self-update from GitHub (v1.3 addendum)

Repo: https://github.com/ManxomeFoe/surveyor — releases carry `surveyor.apk`;
`releases/latest/download/surveyor.apk` is the stable download URL. A GitHub
Action builds + signs + publishes on every `v*` tag push, using the SAME debug
keystore (repo secret) so in-place updates keep working.

Web side checks https://api.github.com/repos/ManxomeFoe/surveyor/releases/latest
(on boot, >=24h apart, silent on failure; plus a manual menu item), compares
tag_name against the installed version, prompts, then triggers the native
download+install.

### Bridge additions (Agent C, MainActivity/SurveyorBridge)
- `getAppVersion()` -> `{"versionName":"1.3","versionCode":4}` (JSON string,
  from PackageInfo; `{"versionName":"dev","versionCode":0}` never — errors
  return best-effort values, no exceptions).
- `startUpdateDownload(url)` -> `"ok"` or `"err:<message>"` (validation only —
  URL must start with `https://github.com/ManxomeFoe/surveyor/`). Download runs
  on a background thread (HttpsURLConnection, follows redirects — GitHub
  redirects to objects.githubusercontent.com), writes `filesDir/update.apk`,
  reports via `webView.evaluateJavascript` on the UI thread calling
  `window.__updateEvent({phase:'progress',pct})`, `{phase:'done'}`, or
  `{phase:'error',message}`. On done, fire the installer:
  ACTION_VIEW of a `content://` URI served by an own plain
  android.content.ContentProvider (NO androidx FileProvider) exported=false,
  grantUriPermissions=true + FLAG_GRANT_READ_URI_PERMISSION.
- Manifest: add INTERNET + REQUEST_INSTALL_PACKAGES permissions, provider
  entry, versionCode 4 / versionName 1.3.

## Live location (v1.6 addendum)

Blue-dot live location like Google Maps. GPS lat/lon must be mapped into each
community's map coordinate space.

### Georeference format (shared)
```js
georef: {
  type: 'affine',
  // [a,b,c,d,e,f]:  x = a*lon + b*lat + c ;  y = d*lon + e*lat + f
  toMap: [a, b, c, d, e, f],
  unitsPerMeter: <map units per ground meter>   // for the accuracy circle
}
```
- Built-in Unalakleet: `georef` lives in MAP_DATA (Agent A computes it by
  matching extracted buildings to OSM footprints; RMS residual must be < 3 map
  units and reported).
- User maps: stored at `surveyor:<id>:georef` (from in-app calibration, owner:
  orchestrator/web). JSON map packages may include a `georef` field.

### Bridge additions (Agent C)
- `startLocation()` -> "ok" | "err:<reason>". Requests the runtime permission
  (classic requestPermissions/onRequestPermissionsResult, no androidx) on
  first use, then streams fixes from LocationManager (GPS + network provider,
  ~2 s / 1 m) as `window.__locationEvent({phase:'fix', lat, lon, accuracy, ts})`
  plus lifecycle events `{phase:'started'|'denied'|'unavailable'|'stopped'}`.
  All posts via runOnUiThread + evaluateJavascript, same hardening as existing
  bridge methods.
- `stopLocation()` -> "ok". Native must also stop updates in onPause and
  restart in onResume while JS-desired state is on (track a desired flag).
- Manifest: ACCESS_FINE_LOCATION + ACCESS_COARSE_LOCATION (no background
  location).

## Toolchain (Agent C)
- JAVA_HOME=/opt/homebrew/opt/openjdk@17
- ANDROID_SDK=/opt/homebrew/share/android-commandlinetools
  (platforms/android-36, build-tools/36.0.0, platform-tools installed; NO gradle — build
  manually: aapt2 compile/link → javac → d8 → zip assets+dex → zipalign → apksigner debug key)
- minSdk 26, targetSdk 36
