$env:GRADLE_USER_HOME = "$pwd\android\.gradle-cache"

flutter build apk --release `
  --target-platform android-arm64

if ($LASTEXITCODE -ne 0) {
  Write-Host "APK build failed!" -ForegroundColor Red
  exit 1
}

Write-Host ""
Write-Host "APK build done." -ForegroundColor Green
Write-Host "  output: build\app\outputs\flutter-apk\app-release.apk"
