#!/usr/bin/env bash
# Build the ordinary, non-privileged companion; release signing never falls back.
set -euo pipefail
cd "$(dirname "$0")/../.."
variant=${1:-debug}
output=${2:-dist/FoxyTail-companion.apk}
case "$variant" in debug|release) ;; *) echo 'usage: build-android.sh debug|release [output.apk]' >&2; exit 1 ;; esac
sdk=${ANDROID_HOME:-${ANDROID_SDK_ROOT:-}}
[ -n "$sdk" ] || { echo 'ANDROID_HOME is required' >&2; exit 1; }
build_tools="$sdk/build-tools/36.0.0"
for command in "$build_tools/apksigner" "$build_tools/aapt"; do
  [ -x "$command" ] || { echo "missing Android build tool: $command" >&2; exit 1; }
done
if [ "$variant" = release ]; then
  : "${FOXYTAIL_KEYSTORE_PATH:?release signing keystore is required}"
  : "${FOXYTAIL_KEYSTORE_PASSWORD:?release signing password is required}"
  : "${FOXYTAIL_KEY_ALIAS:?release signing alias is required}"
  : "${FOXYTAIL_KEY_PASSWORD:?release signing key password is required}"
  tasks=(:app:assembleRelease)
else
  tasks=(:app:assembleDebug)
fi
android/gradlew --no-daemon -p android "${tasks[@]}"
apk="android/app/build/outputs/apk/$variant/app-$variant.apk"
"$build_tools/apksigner" verify --verbose "$apk"
metadata=$("$build_tools/aapt" dump badging "$apk")
version=$(sed -n 's/^version=v//p' module.prop)
code=$(sed -n 's/^versionCode=//p' module.prop)
printf '%s\n' "$metadata" | python3 -c '
import re,sys
line=sys.stdin.readline()
values=dict(re.findall(r"(\w+)=\x27([^\x27]*)\x27",line))
assert values.get("name")=="dev.foxderin.tail", values
assert values.get("versionName")==sys.argv[1] and values.get("versionCode")==sys.argv[2], values
' "$version" "$code"
if [ "$variant" = release ]; then
  if printf '%s\n' "$metadata" | grep -q '^application-debuggable'; then
    echo 'release companion must not be debuggable' >&2; exit 1
  fi
fi
mkdir -p "$(dirname "$output")"
cp "$apk" "$output"
echo "Android companion built: $output ($variant, dev.foxderin.tail, $version)"
