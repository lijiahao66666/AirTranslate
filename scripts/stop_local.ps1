# 停止本地 AI 服务 (frpc + vLLM)
# 用法: .\scripts\stop_local.ps1
# 说明: 彻底停止 frpc 和 WSL 中的 vLLM 服务

param(
    [string]$WslDistro = "Ubuntu",
    [switch]$ShutdownWsl
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

# 停止 WSL 中的 vLLM 和 Python 进程
Write-Host ""
Write-Host "Stopping vLLM in WSL..." -ForegroundColor Yellow

# 先尝试优雅停止 vLLM
wsl -d $WslDistro -- bash -c "pkill -f 'vllm.entrypoints' 2>/dev/null; pkill -f 'vllm' 2>/dev/null; exit 0"
Start-Sleep -Seconds 2

# 强制杀掉所有 Python 进程（确保彻底清理）
wsl -d $WslDistro -- bash -c "pkill -9 -f 'python.*vllm' 2>/dev/null; pkill -9 -f 'python3.*vllm' 2>/dev/null; exit 0"
Start-Sleep -Seconds 1

# 检查端口 8000 是否已释放
Write-Host ""
Write-Host "Checking port 8000..." -ForegroundColor Yellow
$portCheck = wsl -d $WslDistro -- bash -c "ss -tlnp 2>/dev/null | grep ':8000' || netstat -tlnp 2>/dev/null | grep ':8000' || echo 'port_free'"
if ($portCheck -match 'port_free') {
    Write-Host "  Port 8000 is free." -ForegroundColor Green
} else {
    Write-Host "  Port 8000 still in use, forcing cleanup..." -ForegroundColor DarkYellow
    wsl -d $WslDistro -- bash -c "fuser -k 8000/tcp 2>/dev/null; exit 0"
    Start-Sleep -Seconds 2
}

# 可选：完全关闭 WSL
if ($ShutdownWsl) {
    Write-Host ""
    Write-Host "Shutting down WSL..." -ForegroundColor Yellow
    wsl --shutdown
    Write-Host "  WSL shutdown complete." -ForegroundColor Green
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Done." -ForegroundColor Green
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "  Tip: Use -ShutdownWsl to fully shutdown WSL" -ForegroundColor DarkGray
