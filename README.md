# 多语言阅读与 EPUB 双语制作工具

支持在线 AI 翻译与离线制作双语 EPUB 书籍

## 核心功能
- 🌐 调用本地AI翻译模型在线翻译（测试优于传统翻译引擎，且同等模型参数也优于通用文本生成类型模型）
- ⚡ 离线制作双语 EPUB 书籍
- 🌐 已经添加微软翻译，谷歌翻译，陆续接入其他翻译...
## 应用介绍
1. 这个是Java后端（前端代码还没完成）
2. 集成本地部署的 Seed-X AI 模型作为翻译引擎，提升翻译质量
3. 支持上传 EPUB 书籍并离线生成双语版本

---

## Seed-X 本地部署指南

### 我的测试环境
- 显卡：RTX4060 16GB
- 系统：Windows（使用 Docker）
- 模型：[Seed-X-PPO-7B-GPTQ-Int8 量化版](https://www.modelscope.cn/models/ByteDance-Seed/Seed-X-PPO-7B-GPTQ-Int8)

### 部署步骤
1. 从 ModelScope 下载模型文件至本地目录
2. Windows 系统需安装 Docker
3. 通过 Docker 部署 vLLM 推理框架
4. 启动命令
```bash
docker run -d \
  --gpus all \
  --shm-size=16g \
  -p 8000:8000 \
  --name Seed-X \
  -v "C:\Users\28679\llmModels\Seed-X:/app/models/Seed-X" \
  vllm/vllm-openai:v0.9.2 \
  --model /app/models/Seed-X \
  --port 8000 \
  --max-model-len 4096 \
  --served-model-name Seed-X \
  --gpu-memory-utilization 0.9 \
  --max-num-seqs 25 \
  --host 0.0.0.0
