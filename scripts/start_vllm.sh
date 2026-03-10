#!/bin/bash
# 启动 vLLM 服务器 (在 WSL 中运行)
# 用法: 由 start_local.ps1 通过 WSL 调用，也可手动运行:
#   wsl -d Ubuntu -- bash /path/to/AirTranslate/scripts/start_vllm.sh

source ~/vllm-env/bin/activate

MODEL_PATH="$HOME/models"

echo "Starting vLLM server with model: $MODEL_PATH"
echo "GPU: $(nvidia-smi --query-gpu=name,memory.total --format=csv,noheader 2>/dev/null || echo 'unknown')"

python3 -m vllm.entrypoints.openai.api_server \
    --model "$MODEL_PATH" \
    --served-model-name "HY-MT1.5" \
    --host 0.0.0.0 \
    --port 8000 \
    --dtype auto \
    --max-model-len 8192 \
    --gpu-memory-utilization 0.9 \
    --enforce-eager \
    --trust-remote-code
