# AirTranslate Windows 一键启动脚本
# 用法:
#   .\scripts\start.ps1
#   .\scripts\start.ps1 -StartVllm
#   .\scripts\start.ps1 -StartVllm -WslDistro Ubuntu
# Worker 通过服务端 API 获取任务，AI 推理由 vLLM API 提供

param(
    [switch]$StartVllm,
    [string]$WslDistro = "Ubuntu"
)

$ErrorActionPreference = "Stop"
$ROOT = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  AirTranslate - Starting Worker" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan

$WORKER_DIR = Join-Path $ROOT "worker"

# ── 检查前置条件 ──
if (-not (Test-Path (Join-Path $WORKER_DIR ".env"))) {
    Write-Host "  ERROR: worker/.env not found!" -ForegroundColor Red
    Write-Host "  Copy worker/.env.example to worker/.env and fill in SERVER_URL." -ForegroundColor Red
    exit 1
}

# ── 检查 Python ──
$python = if (Get-Command python3 -ErrorAction SilentlyContinue) { "python3" } else { "python" }

# ── 创建虚拟环境并安装依赖 (首次) ──
if (-not (Test-Path (Join-Path $WORKER_DIR ".venv"))) {
    Write-Host ""
    Write-Host "[1/2] Creating virtual environment..." -ForegroundColor Yellow
    & $python -m venv (Join-Path $WORKER_DIR ".venv")

    Write-Host "[2/2] Installing dependencies (httpx/bs4/lxml)..." -ForegroundColor Yellow
    & (Join-Path $WORKER_DIR ".venv\Scripts\pip.exe") install -r (Join-Path $WORKER_DIR "requirements.txt")

    if ($LASTEXITCODE -ne 0) {
        Write-Host "  ERROR: pip install failed!" -ForegroundColor Red
        exit 1
    }
    Write-Host "  Dependencies installed." -ForegroundColor Green
} else {
    Write-Host "  Virtual environment found." -ForegroundColor Green
}

# ── 启动 Worker ──
Write-Host ""
if ($StartVllm) {
    Write-Host "Starting vLLM process in WSL..." -ForegroundColor Yellow
    try {
        $drive = $ROOT.Substring(0, 1).ToLower()
        $rest = $ROOT.Substring(2).Replace('\\', '/')
        $vllmScript = "/mnt/$drive$rest/worker/start_vllm.sh"
        $vllmProcess = Start-Process -FilePath "wsl.exe" `
            -ArgumentList "-d", $WslDistro, "--", "bash", $vllmScript `
            -PassThru
        Write-Host "  vLLM launcher PID: $($vllmProcess.Id)" -ForegroundColor Green
        Start-Sleep -Seconds 3
    } catch {
        Write-Host "  WARNING: failed to launch vLLM in WSL: $($_.Exception.Message)" -ForegroundColor Yellow
    }
    Write-Host ""
}

Write-Host "Starting Worker process..." -ForegroundColor Yellow
Write-Host "  AI backend: vLLM (default http://localhost:8000)" -ForegroundColor DarkGray

try {
    Invoke-RestMethod -Uri "http://localhost:8000/health" -Method GET -TimeoutSec 3 | Out-Null
    Write-Host "  vLLM health check: OK" -ForegroundColor Green
} catch {
    Write-Host "  WARNING: vLLM is not reachable at http://localhost:8000" -ForegroundColor Yellow
    if (-not $StartVllm) {
        Write-Host "           Use -StartVllm or start manually in WSL:" -ForegroundColor Yellow
        Write-Host "           bash worker/start_vllm.sh" -ForegroundColor Yellow
    }
}

$workerProcess = Start-Process -FilePath (Join-Path $WORKER_DIR ".venv\Scripts\python.exe") `
    -ArgumentList (Join-Path $WORKER_DIR "worker.py") `
    -WorkingDirectory $WORKER_DIR `
    -PassThru `
    -NoNewWindow

Write-Host "  Worker PID: $($workerProcess.Id)" -ForegroundColor Green

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Worker started!" -ForegroundColor Green
Write-Host "  PID: $($workerProcess.Id)" -ForegroundColor White
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "To stop: .\scripts\stop.ps1" -ForegroundColor DarkGray
