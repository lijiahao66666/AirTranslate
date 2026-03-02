#!/usr/bin/env bash
set -euo pipefail

# 与 build_config.ps1 保持一致，备案前改为 1
USE_IP_MODE=0

if [ "$USE_IP_MODE" = "1" ]; then
  # translate 站点监听 8082
  API_URL="http://122.51.10.98:8082/api"
else
  API_URL="http://translate-api.air-inc.top"
fi

flutter clean
flutter pub get

flutter build ipa --release \
  --dart-define=AIRTRANSLATE_API_URL="$API_URL" \
  --obfuscate \
  --split-debug-info=build/symbols/ios

echo ""
echo "IPA build done. (UseIpMode=$USE_IP_MODE)"
echo "  output: build/ios/ipa/*.ipa"
