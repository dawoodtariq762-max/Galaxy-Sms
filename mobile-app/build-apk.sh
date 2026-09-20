#!/usr/bin/env bash
set -e

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$DIR"

echo "• Building Galaxy Chat APK..."
mkdir -p bin/classes bin/dex

ANDROID_JAR="${ANDROID_JAR:-/opt/android-tools/android.jar}"
R8_JAR="${R8_JAR:-/opt/android-tools/r8.jar}"

if [ ! -f "$ANDROID_JAR" ]; then
  echo "Error: android.jar not found at $ANDROID_JAR"
  exit 1
fi

echo "1. Compiling resources..."
aapt package -f -m -J src -M AndroidManifest.xml -S res -I "$ANDROID_JAR"

echo "2. Compiling Java sources..."
javac -d bin/classes -cp "$ANDROID_JAR" -source 8 -target 8 src/com/galaxysms/chat/*.java

echo "3. Converting bytecode to DEX..."
java -cp "$R8_JAR" com.android.tools.r8.D8 --output bin/dex/ --lib "$ANDROID_JAR" bin/classes/com/galaxysms/chat/*.class

echo "4. Packaging APK..."
aapt package -f -M AndroidManifest.xml -S res -A assets -I "$ANDROID_JAR" -F bin/unaligned.apk
cd bin/dex && zip -u ../unaligned.apk classes.dex && cd ../..

echo "5. Aligning APK..."
zipalign -f -p 4 bin/unaligned.apk bin/aligned.apk

if [ ! -f galaxy-release.keystore ]; then
  echo "6. Generating signing keystore..."
  keytool -genkey -v -keystore galaxy-release.keystore -alias galaxy -keyalg RSA -keysize 2048 -validity 10000 \
    -storepass galaxy123 -keypass galaxy123 -dname "CN=Galaxy SMS, OU=Mobile, O=Galaxy, L=London, ST=Greater London, C=GB"
fi

echo "7. Signing APK..."
apksigner sign --ks galaxy-release.keystore --ks-pass pass:galaxy123 --out ../galaxy-chat-v1.apk bin/aligned.apk

echo "8. Verifying signature..."
apksigner verify --verbose ../galaxy-chat-v1.apk

echo "✓ Build complete: ../galaxy-chat-v1.apk ($(du -h ../galaxy-chat-v1.apk | cut -f1))"
