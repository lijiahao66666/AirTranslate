# AirTranslate Windows 停止脚本
# 用法: .\scripts\stop.ps1

$ErrorActionPreference = "SilentlyContinue"

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  AirTranslate - Stopping Services" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan

# 停止 Python Worker
Write-Host ""
Write-Host "[1/2] Stopping Python Worker..." -ForegroundColor Yellow
$workers = Get-Process -Name python* | Where-Object {
    $_.CommandLine -like "*worker.py*"
}
if ($workers) {
    $workers | Stop-Process -Force
    Write-Host "  Worker stopped." -ForegroundColor Green
} else {
    Write-Host "  No worker process found." -ForegroundColor DarkGray
}

# 停止 vLLM Docker
Write-Host ""
Write-Host "[2/2] Stopping vLLM Docker..." -ForegroundColor Yellow
$CONTAINER_NAME = "airtranslate-vllm"
$running = docker ps --filter "name=$CONTAINER_NAME" --format "{{.Names}}" 2>$null
if ($running -eq $CONTAINER_NAME) {
    docker stop $CONTAINER_NAME | Out-Null
    docker rm $CONTAINER_NAME | Out-Null
    Write-Host "  vLLM container stopped and removed." -ForegroundColor Green
} else {
    Write-Host "  No vLLM container running." -ForegroundColor DarkGray
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  All services stopped." -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Cyan
