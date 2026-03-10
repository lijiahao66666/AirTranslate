# Local AI launcher (frpc + vLLM)
# Usage:
#   .\scripts\start_local.ps1
#   .\scripts\start_local.ps1 -WslDistro Ubuntu

param(
    [string]$WslDistro = "Ubuntu"
)

$ErrorActionPreference = "Stop"
$ROOT = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$FRP_DIR = Join-Path $ROOT "frp"
$FRPC_EXE = Join-Path $FRP_DIR "frpc.exe"
$FRPC_CONF = Join-Path $FRP_DIR "frpc.toml"
$LOG_DIR = Join-Path $ROOT "logs"

if (-not (Test-Path $LOG_DIR)) {
    New-Item -ItemType Directory -Path $LOG_DIR -Force | Out-Null
}

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  AirTranslate Local AI Launcher" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

# 1) Start frpc
Write-Host "[1/2] Starting frpc..." -ForegroundColor Yellow

$existingFrpc = Get-Process -Name "frpc" -ErrorAction SilentlyContinue
if ($existingFrpc) {
    Write-Host "  Found existing frpc process(es), stopping old instances first..." -ForegroundColor DarkGray
    $existingFrpc | Stop-Process -Force
    Start-Sleep -Seconds 1
}

if (-not (Test-Path $FRPC_EXE)) {
    Write-Host "  ERROR: $FRPC_EXE not found!" -ForegroundColor Red
    Write-Host "  Download frpc.exe from https://github.com/fatedier/frp/releases into frp/" -ForegroundColor Yellow
    exit 1
}
if (-not (Test-Path $FRPC_CONF)) {
    Write-Host "  ERROR: $FRPC_CONF not found!" -ForegroundColor Red
    exit 1
}

$frpcLog = Join-Path $LOG_DIR "frpc.log"
$frpcErrLog = Join-Path $LOG_DIR "frpc-error.log"
$frpcProc = Start-Process -FilePath $FRPC_EXE `
    -ArgumentList "-c", $FRPC_CONF `
    -WindowStyle Hidden `
    -RedirectStandardOutput $frpcLog `
    -RedirectStandardError $frpcErrLog `
    -PassThru

Write-Host "  frpc PID: $($frpcProc.Id)" -ForegroundColor Green
Write-Host "  frpc log: $frpcLog" -ForegroundColor DarkGray

# 2) Start vLLM in WSL
Write-Host ""
Write-Host "[2/2] Starting vLLM in WSL ($WslDistro)..." -ForegroundColor Yellow

$drive = $ROOT.Substring(0, 1).ToLower()
$rest = $ROOT.Substring(2).Replace('\', '/')
$vllmScript = "/mnt/$drive$rest/scripts/start_vllm.sh"
$vllmLog = Join-Path $LOG_DIR "vllm.log"
$vllmErrLog = Join-Path $LOG_DIR "vllm-error.log"

if (Test-Path $vllmLog) { Clear-Content $vllmLog -ErrorAction SilentlyContinue }
if (Test-Path $vllmErrLog) { Clear-Content $vllmErrLog -ErrorAction SilentlyContinue }

$vllmProc = Start-Process -FilePath "wsl.exe" `
    -ArgumentList "-d", $WslDistro, "--", "bash", $vllmScript `
    -WindowStyle Hidden `
    -RedirectStandardOutput $vllmLog `
    -RedirectStandardError $vllmErrLog `
    -PassThru

Start-Sleep -Seconds 3
if ($vllmProc.HasExited) {
    Write-Host "  ERROR: vLLM process exited immediately." -ForegroundColor Red
    if (Test-Path $vllmErrLog) {
        $errTail = Get-Content $vllmErrLog -Tail 20 -ErrorAction SilentlyContinue
        if ($errTail) {
            Write-Host "  vLLM stderr tail:" -ForegroundColor DarkGray
            $errTail | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray }
        }
    }
    exit 1
}

Write-Host "  vLLM PID: $($vllmProc.Id)" -ForegroundColor Green
Write-Host "  vLLM log: $vllmLog" -ForegroundColor DarkGray
Write-Host "  vLLM err: $vllmErrLog" -ForegroundColor DarkGray

# Health check
Write-Host ""
Write-Host "Waiting for vLLM to be ready..." -ForegroundColor Yellow

$ready = $false
for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 5
    try {
        $null = Invoke-RestMethod -Uri "http://localhost:8000/v1/models" -Method GET -TimeoutSec 3
        $ready = $true
        break
    } catch {
        Write-Host "  ... vLLM not ready yet ($([int]($i + 1) * 5)s)" -ForegroundColor DarkGray
    }
}

Write-Host ""
Write-Host "========================================" -ForegroundColor Cyan
if ($ready) {
    Write-Host "  All services started!" -ForegroundColor Green
} else {
    Write-Host "  frpc started, vLLM still loading..." -ForegroundColor Yellow
    Write-Host "  (large models may take 1-3 minutes)" -ForegroundColor DarkGray
}
Write-Host ""
Write-Host "  frpc PID : $($frpcProc.Id)" -ForegroundColor White
Write-Host "  frpc dir : $FRP_DIR" -ForegroundColor DarkGray
Write-Host "  Logs     : $LOG_DIR" -ForegroundColor DarkGray
Write-Host ""
Write-Host "  To stop: .\scripts\stop_local.ps1" -ForegroundColor DarkGray
Write-Host "========================================" -ForegroundColor Cyan
