# AirTranslate Windows 停止脚本
# 用法: .\scripts\stop.ps1

$ErrorActionPreference = "SilentlyContinue"

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  AirTranslate - Stopping Worker" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan

Write-Host ""
Write-Host "Stopping Python Worker..." -ForegroundColor Yellow
$workers = Get-Process -Name python* | Where-Object {
    $_.CommandLine -like "*worker.py*"
}
if ($workers) {
    $workers | Stop-Process -Force
    Write-Host "  Worker stopped." -ForegroundColor Green
} else {
    Write-Host "  No worker process found." -ForegroundColor DarkGray
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Done." -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Cyan
