$env:GRADLE_USER_HOME = "$pwd\android\.gradle-cache"

# 备案后使用：translate-api.air-inc.top；备案前可改为 http://122.51.10.98/api
$apiUrl = "http://translate-api.air-inc.top"

flutter build appbundle --release `
  --dart-define=AIRTRANSLATE_API_URL=$apiUrl

if ($LASTEXITCODE -ne 0) {
  Write-Host "AAB build failed!" -ForegroundColor Red
  exit 1
}

Write-Host ""
Write-Host "AAB build done." -ForegroundColor Green
Write-Host "  output: build\app\outputs\bundle\release\app-release.aab"
