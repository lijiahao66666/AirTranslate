. "$PSScriptRoot\build_config.ps1"

$projectRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$pubspecPath = Join-Path $projectRoot "pubspec.yaml"
if (-not (Test-Path $pubspecPath)) {
  Write-Host "pubspec.yaml not found: $pubspecPath" -ForegroundColor Red
  exit 1
}

Push-Location $projectRoot
try {
  $env:GRADLE_USER_HOME = "$projectRoot\android\.gradle-cache"

  flutter build appbundle --release 
    --build-number $BUILD_NUMBER 
    --dart-define=AIRTRANSLATE_API_URL=$API_URL `
    --dart-define=AIRTRANSLATE_API_KEY=$API_KEY

  if ($LASTEXITCODE -ne 0) {
    Write-Host "AAB build failed!" -ForegroundColor Red
    exit 1
  }
} finally {
  Pop-Location
}

Write-Host ""
Write-Host "AAB build done." -ForegroundColor Green
Write-Host "  config: scripts/build_config.ps1 (UseIpMode=$UseIpMode)"
Write-Host "  output: client/build/app/outputs/bundle/release/app-release.aab"

