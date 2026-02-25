# AirTranslate Windows 一键启动脚本
# 用法: .\scripts\start.ps1

$ErrorActionPreference = "Stop"
$ROOT = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  AirTranslate - Starting Services" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan

# ── 1. 启动 vLLM Docker (WSL2) ──
Write-Host ""
Write-Host "[1/2] Starting vLLM Docker container..." -ForegroundColor Yellow

$MODEL_PATH = if ($env:VLLM_MODEL_PATH) { $env:VLLM_MODEL_PATH } else { "$HOME/.cache/modelscope/hub/models/Tencent/HunyuanTranslate-7B-FP8" }
$CONTAINER_NAME = "airtranslate-vllm"

# 检查容器是否已在运行
$running = docker ps --filter "name=$CONTAINER_NAME" --format "{{.Names}}" 2>$null
if ($running -eq $CONTAINER_NAME) {
    Write-Host "  vLLM container already running." -ForegroundColor Green
} else {
    # 清理旧容器
    docker rm -f $CONTAINER_NAME 2>$null | Out-Null

    Write-Host "  Model path: $MODEL_PATH"
    Write-Host "  Starting vLLM v0.10.0+ with HY-MT1.5-7B-FP8..."

    docker run -d `
        --name $CONTAINER_NAME `
        --gpus all `
        --shm-size=8g `
        -p 8000:8000 `
        -v "${MODEL_PATH}:/model" `
        vllm/vllm-openai:latest `
        --model /model `
        --served-model-name hy-mt `
        --gpu-memory-utilization 0.85 `
        --max-model-len 4096 `
        --dtype auto

    if ($LASTEXITCODE -ne 0) {
        Write-Host "  ERROR: Failed to start vLLM container!" -ForegroundColor Red
        Write-Host "  Make sure Docker Desktop + WSL2 is running and GPU passthrough is configured." -ForegroundColor Red
        exit 1
    }

    Write-Host "  vLLM container started. Waiting for model to load..." -ForegroundColor Green
    Write-Host "  (This may take 1-3 minutes for first startup)" -ForegroundColor DarkGray

    # 等待 vLLM 就绪
    $ready = $false
    for ($i = 0; $i -lt 60; $i++) {
        Start-Sleep -Seconds 5
        try {
            $resp = Invoke-WebRequest -Uri "http://localhost:8000/health" -UseBasicParsing -TimeoutSec 3 2>$null
            if ($resp.StatusCode -eq 200) {
                $ready = $true
                break
            }
        } catch {}
        Write-Host "  Waiting... ($($i * 5)s)" -ForegroundColor DarkGray
    }
    if (-not $ready) {
        Write-Host "  WARNING: vLLM did not become ready within 5 minutes." -ForegroundColor Red
        Write-Host "  Check logs: docker logs $CONTAINER_NAME" -ForegroundColor Red
    } else {
        Write-Host "  vLLM is ready!" -ForegroundColor Green
    }
}

# ── 2. 启动 Python Worker ──
Write-Host ""
Write-Host "[2/2] Starting Python Worker..." -ForegroundColor Yellow

$WORKER_DIR = Join-Path $ROOT "worker"

if (-not (Test-Path (Join-Path $WORKER_DIR ".env"))) {
    Write-Host "  ERROR: worker/.env not found!" -ForegroundColor Red
    Write-Host "  Copy worker/.env.example to worker/.env and fill in your COS credentials." -ForegroundColor Red
    exit 1
}

# 检查 Python
$python = if (Get-Command python3 -ErrorAction SilentlyContinue) { "python3" } else { "python" }

# 安装依赖 (首次)
if (-not (Test-Path (Join-Path $WORKER_DIR ".venv"))) {
    Write-Host "  Creating virtual environment..."
    & $python -m venv (Join-Path $WORKER_DIR ".venv")
    & (Join-Path $WORKER_DIR ".venv\Scripts\pip.exe") install -r (Join-Path $WORKER_DIR "requirements.txt") -q
}

Write-Host "  Starting worker process..."
$workerProcess = Start-Process -FilePath (Join-Path $WORKER_DIR ".venv\Scripts\python.exe") `
    -ArgumentList (Join-Path $WORKER_DIR "worker.py") `
    -WorkingDirectory $WORKER_DIR `
    -PassThru `
    -NoNewWindow

Write-Host "  Worker PID: $($workerProcess.Id)" -ForegroundColor Green

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  All services started!" -ForegroundColor Green
Write-Host "  vLLM:   http://localhost:8000" -ForegroundColor White
Write-Host "  Worker:  PID $($workerProcess.Id)" -ForegroundColor White
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "To stop: .\scripts\stop.ps1" -ForegroundColor DarkGray
