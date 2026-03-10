. "$PSScriptRoot\build_config.ps1"

flutter build web --release `
  --no-web-resources-cdn `
  --pwa-strategy=none `
  --dart-define=AIRTRANSLATE_API_URL="$API_URL" `
  --dart-define=AIRTRANSLATE_API_KEY="$API_KEY"

if ($LASTEXITCODE -ne 0) {
  Write-Host "Web build failed!" -ForegroundColor Red
  exit 1
}

$zipPath = Join-Path $PSScriptRoot "..\airtranslate-web.zip"
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
Compress-Archive -Path "build\web\*" -DestinationPath $zipPath -Force

Write-Host ""
Write-Host "Web build done." -ForegroundColor Green
Write-Host "  config : scripts/build_config.ps1 (UseIpMode=$UseIpMode)"
Write-Host "  output : build/web/"
Write-Host "  zip    : $zipPath"
