#!/usr/bin/env bash
set -euo pipefail

flutter clean
flutter pub get

flutter build ipa --release \
  --obfuscate \
  --split-debug-info=build/symbols/ios

echo ""
echo "IPA build done."
echo "  output: build/ios/ipa/*.ipa"
