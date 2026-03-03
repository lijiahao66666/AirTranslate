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

# 与服务端 .env 的 API_KEY 一致
API_KEY="af9a7d9ac145f539c84616012f9398b121cee1ad65005f3fc055f056aa4fd3fc"

flutter clean
flutter pub get

flutter build ipa --release \
  --dart-define=AIRTRANSLATE_API_URL="$API_URL" \
  --dart-define=AIRTRANSLATE_API_KEY="$API_KEY" \
  --obfuscate \
  --split-debug-info=build/symbols/ios

echo ""
echo "IPA build done. (UseIpMode=$USE_IP_MODE)"
echo "  output: build/ios/ipa/*.ipa"
