#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="${SCRIPT_DIR}/.."
if [ ! -f "${PROJECT_ROOT}/pubspec.yaml" ]; then
  echo "pubspec.yaml not found: ${PROJECT_ROOT}/pubspec.yaml" >&2
  exit 1
fi
cd "${PROJECT_ROOT}"

# 涓?build_config.ps1 淇濇寔涓€鑷达紝澶囨鍓嶆敼涓?1
USE_IP_MODE=0

if [ "$USE_IP_MODE" = "1" ]; then
  API_URL="http://122.51.10.98:8082/api"
else
  API_URL="https://translate.air-inc.top/api"
fi

# 涓庢湇鍔＄ .env 鐨?API_KEY 涓€鑷?
API_KEY="af9a7d9ac145f539c84616012f9398b121cee1ad65005f3fc055f056aa4fd3fc"
BUILD_NUMBER="${BUILD_NUMBER:-$(date +"%Y%m%d%H")}"

flutter clean
flutter pub get

flutter build ipa --release \
  --build-number "$BUILD_NUMBER" \
  --dart-define=AIRTRANSLATE_API_URL="$API_URL" \
  --dart-define=AIRTRANSLATE_API_KEY="$API_KEY" \
  --obfuscate \
  --split-debug-info=build/symbols/ios



echo ""
echo "IPA build done. (UseIpMode=$USE_IP_MODE)"
echo "  output: client/build/ios/ipa/*.ipa"


