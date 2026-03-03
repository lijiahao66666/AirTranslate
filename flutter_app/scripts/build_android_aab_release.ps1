. "$PSScriptRoot\build_config.ps1"

$env:GRADLE_USER_HOME = "$pwd\android\.gradle-cache"

flutter build appbundle --release `
  --dart-define=AIRTRANSLATE_API_URL=$API_URL `
  --dart-define=AIRTRANSLATE_API_KEY=$API_KEY

if ($LASTEXITCODE -ne 0) {
  Write-Host "AAB build failed!" -ForegroundColor Red
  exit 1
}

Write-Host ""
Write-Host "AAB build done." -ForegroundColor Green
Write-Host "  config: scripts/build_config.ps1 (UseIpMode=$UseIpMode)"
Write-Host "  output: build\app\outputs\bundle\release\app-release.aab"
