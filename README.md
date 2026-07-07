# Fidalgo

Fidalgo (formerly Surveyor) is an offline Android app for door-to-door field surveys in small communities,
built around an interactive building-level street plan. Made for canvassing in
Unalakleet, Alaska — but any community map can be added from inside the app.

## Features

- **Interactive vector map** — smooth pinch-zoom and pan; the bundled
  Unalakleet plan stays crisp at any zoom, with all 376 buildings numbered.
- **Mark visited houses** — tap any building and give it a color (10 presets or
  a custom picker). The fill is translucent and the house number is redrawn on
  top, so numbers stay readable.
- **Adaptive legend** — every color in use appears automatically with an
  editable label ("Visited", "Not home", "Refused", …) and a live house count.
- **Custom markers** — drop labeled pins anywhere; rename or delete them later.
- **Search** — jump to any house number or landmark with an animated fly-to.
- **Multiple communities** — switch between maps from the top bar; each keeps
  its own colors, legend, markers, and buildings.
- **Upload your own maps** — add a photo/scan (PNG/JPG), an SVG, or a JSON map
  package. Auto-detection scans the image for building footprints and numbers
  them for you (with a preview and full manual correction: tap to
  renumber/delete, drag to draw).
- **Fully offline** — no permissions, no network. All survey data persists on
  the device.

## Project layout

```
app/                    Android project (no Gradle — see build.sh)
  AndroidManifest.xml
  java/com/surveyor/app/  MainActivity (WebView shell) + SurveyorBridge (file storage)
  res/                    adaptive icon, strings, colors
  assets/www/             the actual app: vanilla JS single-page web app
    app.js                map engine, editor, detection, search, legend, storage
    maps/unalakleet/      base.svg (vector base map) + data.js (376 buildings)
extraction/             Python pipeline that produced the Unalakleet map data
build.sh                builds dist/surveyor.apk with the raw SDK tools
CONTRACT.md             internal data-format and architecture contracts
```

## Building the APK

Requirements: JDK 17 and the Android SDK command-line tools with
`platforms;android-36` and `build-tools;36.0.0` installed. No Gradle needed.

```sh
# adjust to your machine if needed:
export JAVA_HOME=/opt/homebrew/opt/openjdk@17
export ANDROID_SDK=/opt/homebrew/share/android-commandlinetools

./build.sh          # -> dist/surveyor.apk (debug-signed, installable)
```

The pipeline is `aapt2 compile/link → javac → d8 → zip → zipalign → apksigner`.
Output targets Android 16 (API 36), minimum Android 8.0 (API 26).

## Adding a community map

Three ways, from easiest to most powerful:

1. **In the app**: menu → *Add map…* → pick an image. Accept the auto-detect
   offer, then fix any mistakes in edit mode.
2. **JSON map package**: a file matching the `MAP_DATA` schema in
   [CONTRACT.md](CONTRACT.md) with a `baseImage` data URL — imports with
   buildings already in place.
3. **Bundled like Unalakleet**: generate `base.svg` + `data.js` (see
   `extraction/` for the pipeline that decoded the Unalakleet street plan) and
   drop them under `app/assets/www/maps/<id>/`, add one line to
   `maps/index.js`, and rebuild.

## Web app development

The UI is a dependency-free single-page app that also runs in a desktop
browser — serve `app/assets/www/` with any static server:

```sh
python3 -m http.server 8642 -d app/assets/www
```

## Data attribution

The Unalakleet base map and building footprints derive from
[OpenStreetMap](https://www.openstreetmap.org/copyright) data,
© OpenStreetMap contributors, available under the
[Open Database License](https://opendatabase.org/). Building numbering
(1–376, north→south / west→east) is this project's own indexing scheme, not
official addressing.

## License

MIT — see [LICENSE](LICENSE).
