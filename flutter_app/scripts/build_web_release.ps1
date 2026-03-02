# 备案后使用：API 通过 translate-api.air-inc.top 独立站点
$API_URL = "http://translate-api.air-inc.top"

flutter build web --release `
  --dart-define=AIRTRANSLATE_API_URL="$API_URL"

if ($LASTEXITCODE -ne 0) {
  Write-Host "Web build failed!" -ForegroundColor Red
  exit 1
}

$zipPath = Join-Path $PSScriptRoot "..\airtranslate-web.zip"
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
Compress-Archive -Path "build\web\*" -DestinationPath $zipPath -Force

Write-Host ""
Write-Host "Web build done." -ForegroundColor Green
Write-Host "  build output : build/web/"
Write-Host "  zip package  : $zipPath"
