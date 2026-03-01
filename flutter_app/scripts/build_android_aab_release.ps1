$env:GRADLE_USER_HOME = "$pwd\android\.gradle-cache"

flutter build appbundle --release

if ($LASTEXITCODE -ne 0) {
  Write-Host "AAB build failed!" -ForegroundColor Red
  exit 1
}

Write-Host ""
Write-Host "AAB build done." -ForegroundColor Green
Write-Host "  output: build\app\outputs\bundle\release\app-release.aab"
