#!/bin/bash
# build.sh — Surveyor Android APK build (no Gradle).
#
# Usage:   ./build.sh
# Output:  dist/surveyor.apk  (signed with a debug key, installable via
#          `adb install -r dist/surveyor.apk`)
#
# Idempotent: the intermediate dir (app/build) is wiped on every run, and the
# assets dir (app/assets/www) is re-packaged as-is each time — rerun after web
# assets change and the APK picks them up.
#
# Pipeline: aapt2 compile → aapt2 link (+assets) → javac → d8 → add dex →
#           zipalign → apksigner → verify.

set -euo pipefail

# ---------------------------------------------------------------- toolchain
export JAVA_HOME=/opt/homebrew/opt/openjdk@17
SDK=/opt/homebrew/share/android-commandlinetools
BT="$SDK/build-tools/36.0.0"
PLATFORM="$SDK/platforms/android-36/android.jar"

AAPT2="$BT/aapt2"
D8="$BT/d8"
ZIPALIGN="$BT/zipalign"
APKSIGNER="$BT/apksigner"
JAVAC="$JAVA_HOME/bin/javac"
KEYTOOL="$JAVA_HOME/bin/keytool"

MIN_SDK=26
TARGET_SDK=36

ROOT="$(cd "$(dirname "$0")" && pwd)"
APP="$ROOT/app"
BUILD="$APP/build"
DIST="$ROOT/dist"

for t in "$AAPT2" "$D8" "$ZIPALIGN" "$APKSIGNER" "$JAVAC" "$KEYTOOL"; do
    [ -x "$t" ] || { echo "ERROR: missing tool: $t" >&2; exit 1; }
done
[ -f "$PLATFORM" ] || { echo "ERROR: missing $PLATFORM" >&2; exit 1; }
[ -f "$APP/assets/www/index.html" ] || {
    echo "ERROR: app/assets/www/index.html not found — web assets not in place yet." >&2
    exit 1
}

# ---------------------------------------------------------------- workspace
rm -rf "$BUILD"
mkdir -p "$BUILD/gen" "$BUILD/classes" "$BUILD/dex" "$DIST"

# ------------------------------------------------------- 1. resources (aapt2)
echo "==> aapt2 compile"
"$AAPT2" compile --dir "$APP/res" -o "$BUILD/res.zip"

echo "==> aapt2 link"
"$AAPT2" link \
    -o "$BUILD/surveyor.unsigned.apk" \
    -I "$PLATFORM" \
    --manifest "$APP/AndroidManifest.xml" \
    -A "$APP/assets" \
    --min-sdk-version "$MIN_SDK" \
    --target-sdk-version "$TARGET_SDK" \
    --auto-add-overlay \
    --java "$BUILD/gen" \
    "$BUILD/res.zip"

# ----------------------------------------------------------- 2. java → dex
echo "==> javac"
# Note: JDK 17 javac rejects -bootclasspath for targets > 8, so android.jar
# goes on the classpath and --release 11 pins the language/bytecode level.
"$JAVAC" \
    --release 11 \
    -classpath "$PLATFORM" \
    -d "$BUILD/classes" \
    "$BUILD/gen/com/surveyor/app/R.java" \
    "$APP"/java/com/surveyor/app/*.java

echo "==> d8"
find "$BUILD/classes" -name '*.class' -print0 | xargs -0 "$D8" \
    --release \
    --min-api "$MIN_SDK" \
    --lib "$PLATFORM" \
    --output "$BUILD/dex"

# ------------------------------------------------- 3. dex into APK (at root)
echo "==> add classes.dex"
(cd "$BUILD/dex" && zip -q -j "$BUILD/surveyor.unsigned.apk" classes.dex)

# --------------------------------------------------------------- 4. zipalign
echo "==> zipalign"
"$ZIPALIGN" -f 4 "$BUILD/surveyor.unsigned.apk" "$BUILD/surveyor.aligned.apk"

# -------------------------------------------------------------- 5. sign
# Prefer the standard Android debug keystore; otherwise use (and create once)
# a project-local one in dist/.
KS="$HOME/.android/debug.keystore"
if [ ! -f "$KS" ]; then
    KS="$DIST/debug.keystore"
    if [ ! -f "$KS" ]; then
        echo "==> generating debug keystore at $KS"
        "$KEYTOOL" -genkeypair \
            -keystore "$KS" \
            -alias androiddebugkey \
            -storepass android -keypass android \
            -keyalg RSA -keysize 2048 -validity 10000 \
            -dname "C=US, O=Android, CN=Android Debug"
    fi
fi

echo "==> apksigner sign (keystore: $KS)"
"$APKSIGNER" sign \
    --ks "$KS" \
    --ks-key-alias androiddebugkey \
    --ks-pass pass:android \
    --key-pass pass:android \
    --out "$DIST/surveyor.apk" \
    "$BUILD/surveyor.aligned.apk"

echo "==> apksigner verify"
"$APKSIGNER" verify --print-certs "$DIST/surveyor.apk"

# ---------------------------------------------------------------- done
SIZE=$(du -h "$DIST/surveyor.apk" | cut -f1)
echo ""
echo "OK: $DIST/surveyor.apk ($SIZE)"
