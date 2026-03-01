# 停止本地 AI 服务 (frpc + vLLM)
# 用法: .\scripts\stop_local.ps1
# 说明: frpc 由 start_local.ps1 从 frp/ 目录启动，此处按进程名停止

param(
    [string]$WslDistro = "Ubuntu"
)

$ErrorActionPreference = "SilentlyContinue"

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Stopping Local AI Services" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# 停止 frpc
Write-Host "Stopping frpc..." -ForegroundColor Yellow
$frpcProcs = Get-Process -Name "frpc" -ErrorAction SilentlyContinue
if ($frpcProcs) {
    $frpcProcs | Stop-Process -Force
    Write-Host "  frpc stopped." -ForegroundColor Green
} else {
    Write-Host "  No frpc process found." -ForegroundColor DarkGray
}

# 停止 WSL 中的 vLLM
Write-Host ""
Write-Host "Stopping vLLM in WSL..." -ForegroundColor Yellow
wsl -d $WslDistro -- bash -c "pkill -f 'vllm.entrypoints' 2>/dev/null; exit 0"
Write-Host "  vLLM stop signal sent." -ForegroundColor Green

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Done." -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Cyan
