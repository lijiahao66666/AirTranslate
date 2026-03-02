#!/usr/bin/env bash
set -euo pipefail

# 备案后使用：translate-api.air-inc.top；备案前可改为 http://122.51.10.98/api
API_URL="http://translate-api.air-inc.top"

flutter clean
flutter pub get

flutter build ipa --release \
  --dart-define=AIRTRANSLATE_API_URL="$API_URL" \
  --obfuscate \
  --split-debug-info=build/symbols/ios

echo ""
echo "IPA build done."
echo "  output: build/ios/ipa/*.ipa"
