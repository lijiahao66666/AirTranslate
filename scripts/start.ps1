# AirTranslate Windows 一键启动脚本
# 用法: .\scripts\start.ps1
# 模型通过 transformers 在 Worker 进程中直接加载到 GPU，无需 Docker/vLLM

$ErrorActionPreference = "Stop"
$ROOT = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  AirTranslate - Starting Worker" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan

$WORKER_DIR = Join-Path $ROOT "worker"
$MODEL_DIR = Join-Path $ROOT "models"

# ── 检查前置条件 ──
if (-not (Test-Path (Join-Path $WORKER_DIR ".env"))) {
    Write-Host "  ERROR: worker/.env not found!" -ForegroundColor Red
    Write-Host "  Copy worker/.env.example to worker/.env and fill in your COS credentials." -ForegroundColor Red
    exit 1
}

if (-not (Test-Path (Join-Path $MODEL_DIR "config.json"))) {
    Write-Host "  ERROR: models/config.json not found!" -ForegroundColor Red
    Write-Host "  Please download HY-MT1.5-7B-FP8 model into the models/ directory." -ForegroundColor Red
    exit 1
}

# ── 检查 Python ──
$python = if (Get-Command python3 -ErrorAction SilentlyContinue) { "python3" } else { "python" }

# ── 创建虚拟环境并安装依赖 (首次) ──
if (-not (Test-Path (Join-Path $WORKER_DIR ".venv"))) {
    Write-Host ""
    Write-Host "[1/2] Creating virtual environment..." -ForegroundColor Yellow
    & $python -m venv (Join-Path $WORKER_DIR ".venv")

    Write-Host "[2/2] Installing dependencies (torch + transformers, may take a few minutes)..." -ForegroundColor Yellow
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
Write-Host "Starting Worker process..." -ForegroundColor Yellow
Write-Host "  Model will be loaded into GPU on first AI translation job." -ForegroundColor DarkGray

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
Write-Host "  Model: $MODEL_DIR" -ForegroundColor White
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "To stop: .\scripts\stop.ps1" -ForegroundColor DarkGray
