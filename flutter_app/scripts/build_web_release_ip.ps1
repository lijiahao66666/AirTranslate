# 备案前使用：API 通过 HTML 站点的 /api 代理，同源无 CORS
# 需先在 HTML 站点 nginx 配置中增加 /api 反向代理（见 docs/nginx_html_site_with_api.conf）
$API_URL = "http://122.51.10.98/api"   # 备案完成后可改为 http://translate.air-inc.top/api

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
Write-Host "Web build done (同站模式)." -ForegroundColor Green
Write-Host "  API URL     : $API_URL"
Write-Host "  build output: build/web/"
Write-Host "  zip package: $zipPath"
