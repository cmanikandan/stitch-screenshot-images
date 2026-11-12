#!/usr/bin/env bash
set -euo pipefail

# Deploy StitchScreenshot to a physical iPhone connected to this Mac
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
PROJECT_PATH="$REPO_ROOT/ios-app/StitchScreenshot/StitchScreenshot.xcodeproj"
SCHEME="StitchScreenshot"
DERIVED_DATA="$REPO_ROOT/DerivedData"

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "Error: iOS device deployment requires macOS with Xcode installed."
  exit 1
fi

echo "==> Detecting connected iOS devices..."
DEVICE_JSON="/tmp/pagestitch_devices_$$.json"
trap 'rm -f "$DEVICE_JSON"' EXIT

xcrun devicectl list devices --json-output "$DEVICE_JSON" >/dev/null 2>&1 || true

# Parse first connected physical iPhone UDID and Name
DEVICE_INFO=$(python3 -c '
import json, sys, os
path = sys.argv[1]
if not os.path.exists(path):
    sys.exit(0)
with open(path) as f:
    data = json.load(f)
devices = data.get("result", {}).get("devices", [])
for d in devices:
    props = d.get("deviceProperties", {})
    hw = d.get("hardwareProperties", {})
    conn = d.get("connectionProperties", {})
    platform = hw.get("platform", "")
    pairing = conn.get("pairingState", "")
    udid = hw.get("udid") or d.get("identifier")
    name = props.get("name", "iPhone")
    if platform == "iOS" and pairing == "paired" and udid:
        print(f"{udid}|{name}")
        break
' "$DEVICE_JSON")

if [[ -z "$DEVICE_INFO" ]]; then
  # Fallback to xctrace
  DEVICE_LINE=$(xcrun xctrace list devices 2>/dev/null | awk '/^== Devices ==/{flag=1;next}/^==/{flag=0}flag' | grep -iE "iPhone|iPad" | grep -v "Simulator" | head -n 1 || true)
  if [[ -n "$DEVICE_LINE" ]]; then
    UDID=$(echo "$DEVICE_LINE" | sed -E 's/.*\(([0-9A-Fa-f-]+)\)$/\1/')
    NAME=$(echo "$DEVICE_LINE" | sed -E 's/ \([0-9]+\.[0-9]+.*//')
    DEVICE_INFO="${UDID}|${NAME}"
  fi
fi

if [[ -z "$DEVICE_INFO" ]]; then
  echo "Error: No connected and paired iPhone detected."
  echo "Please unlock your iPhone, connect it via USB/Wi-Fi, and tap 'Trust This Computer'."
  exit 1
fi

DEVICE_UDID="${DEVICE_INFO%%|*}"
DEVICE_NAME="${DEVICE_INFO#*|}"
echo "==> Found iPhone: $DEVICE_NAME (UDID: $DEVICE_UDID)"

# Auto-detect Apple Development Team ID from macOS Keychain certificates or Xcode preferences
TEAM_ID="${DEVELOPMENT_TEAM:-}"
if [[ -z "$TEAM_ID" ]]; then
  TEAM_ID=$(security find-certificate -a -c "Apple Development" -p 2>/dev/null \
    | openssl x509 -noout -subject 2>/dev/null \
    | sed -n 's/.*OU *= *\([A-Z0-9]\{10\}\).*/\1/p' \
    | head -n 1 || true)
fi

if [[ -z "$TEAM_ID" ]]; then
  echo "Enter your 10-character Apple Developer Team ID (or press Enter if already set in Xcode):"
  read -r TEAM_ID
fi

TEAM_ARGS=()
if [[ -n "$TEAM_ID" ]]; then
  echo "==> Using Apple Development Team: $TEAM_ID"
  TEAM_ARGS=("DEVELOPMENT_TEAM=$TEAM_ID")
fi

# Customize bundle ID suffix if needed to avoid conflicts on personal teams
BUNDLE_PREFIX="${BUNDLE_ID_PREFIX:-}"
BUNDLE_ARGS=()
if [[ -n "$BUNDLE_PREFIX" ]]; then
  echo "==> Using custom Bundle ID prefix: $BUNDLE_PREFIX"
fi

echo "==> Building $SCHEME for $DEVICE_NAME..."
xcodebuild \
  -project "$PROJECT_PATH" \
  -scheme "$SCHEME" \
  -destination "platform=iOS,id=$DEVICE_UDID" \
  -derivedDataPath "$DERIVED_DATA" \
  -allowProvisioningUpdates \
  "${TEAM_ARGS[@]}" \
  build

APP_BUNDLE=$(find "$DERIVED_DATA/Build/Products/Debug-iphoneos" -maxdepth 1 -name "StitchScreenshot.app" | head -n 1)

if [[ -z "$APP_BUNDLE" || ! -d "$APP_BUNDLE" ]]; then
  echo "Error: Built StitchScreenshot.app bundle not found."
  exit 1
fi

echo "==> Installing $APP_BUNDLE onto $DEVICE_NAME..."
xcrun devicectl device install app --device "$DEVICE_UDID" "$APP_BUNDLE"

echo "==> Launching StitchScreenshot on $DEVICE_NAME..."
BUNDLE_ID=$(defaults read "$APP_BUNDLE/Info.plist" CFBundleIdentifier)
xcrun devicectl device process launch --device "$DEVICE_UDID" "$BUNDLE_ID" || true

echo "==> Successfully deployed and launched StitchScreenshot on $DEVICE_NAME!"
