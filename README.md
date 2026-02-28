# AirTranslate — EPUB 全本翻译工具

上传 EPUB → 选择翻译引擎 → 全本翻译 → 下载双语/纯译文书籍

## 核心功能

- 📖 **EPUB 全本翻译** — 上传书籍，自动翻译全部章节
- 🧠 **AI 翻译** — HY-MT1.5-7B-FP8 + vLLM（OpenAI 兼容 API），支持术语表和上下文翻译
- 🤖 **机器翻译** — Azure Edge → MyMemory → Google 三引擎链式退避，完全免费
- 📝 **双语/纯译文** — 支持双语对照和纯译文两种输出格式
- 🌍 **33种语言** — 中英日韩法德西俄等主流语言全覆盖
- 💰 **积分系统** — AI 翻译按字数消耗积分，机器翻译免费
- 💾 **本地优先列表** — Web 存浏览器缓存，移动端存 SQLite，本地封面不上传服务器

## 项目架构

```
AirTranslate/
├── app.js              # 服务端 (轻量服务器, 端口 9001)
├── data/               # 本地数据 (积分/任务/进度/队列)
├── worker/             # Python 翻译 Worker + vLLM 启动脚本
│   ├── worker.py       # 通过服务端 API 获取队列/更新进度
│   ├── translators.py  # 翻译引擎 (vLLM API + 机器翻译)
│   ├── epub_util.py    # EPUB 解析/打包
│   └── start_vllm.sh   # WSL 中启动 vLLM
├── flutter_app/        # Flutter 客户端 App
├── models/             # HY-MT1.5-7B-FP8 模型文件
└── scripts/            # 启动/停止脚本
```

### 工作流程

1. **Flutter App** → 创建任务并上传 EPUB，标记为待启动
2. **服务端** (`app.js`) → 管理任务/积分/队列（本地文件），生成 COS presign URL
3. **Python Worker** → 通过服务端 API 获取任务，通过 vLLM API 执行 AI 翻译
4. **Flutter App** → 在列表点击“启动”进入队列，轮询进度并下载结果

### 数据存储

| 数据 | 存储位置 | 说明 |
|------|---------|------|
| 积分 | 服务器本地 `data/` | JSON 文件，和 AirRead 架构一致 |
| 任务/进度/队列 | 服务器本地 `data/` | JSON 文件 |
| EPUB 源文件 | 腾讯云 COS | presign URL 直传 |
| EPUB 结果文件 | 腾讯云 COS | presign URL 直传 |
| 术语表 | 腾讯云 COS | presign URL 直传 |
| 任务列表缓存 | 客户端本地 | Web: SharedPreferences / 移动端: SQLite |
| 书籍封面 | 客户端本地 | 仅本地存储，不上传服务端 |

## 环境要求

### 服务端 (轻量服务器)
- **规格**: 2核 2GB 即可
- **Node.js**: 16+
- **PM2**: 进程管理

### Worker + vLLM (本地 GPU 机器)
- **GPU**: NVIDIA 显卡，显存 ≥ 16GB（如 RTX 4060 Ti 16GB）
- **系统**: Windows 10/11
- **Python**: 3.11+
- **WSL2**: Ubuntu（用于运行 vLLM，推荐）

> 当前 AI 推理默认走 vLLM API（`http://localhost:8000`）。

## 服务端部署

### 1. 配置服务端 .env

```bash
cp .env.example .env
```

```env
PORT=9001
COS_BUCKET=translate-1256643821
COS_REGION=ap-guangzhou
TENCENT_SECRET_ID=你的SecretId
TENCENT_SECRET_KEY=你的SecretKey
COS_PREFIX=translate/
WORKER_API_KEY=你的Worker密钥(可选)
```

### 2. 上传到服务器

```bash
# 上传 app.js 和 .env
scp app.js root@air-inc.top:/www/airtranslate/app.js
scp .env root@air-inc.top:/www/airtranslate/.env

# SSH 到服务器启动
ssh root@air-inc.top
cd /www/airtranslate
pm2 start app.js --name airtranslate
pm2 save
```

### 3. 宝塔反向代理

`translate-api.air-inc.top` → `http://127.0.0.1:9001`

### 4. 验证

```bash
curl http://air-inc.top:9001/health
# {"status":"ok","service":"AirTranslate",...}
```

## Worker / vLLM 配置

### 1. 下载模型

从 HuggingFace 下载 [HY-MT1.5-7B-FP8](https://huggingface.co/tencent/HY-MT1.5-7B-FP8) 到 `models/` 目录。

### 2. 配置 Worker .env

```powershell
cp worker\.env.example worker\.env
```

```env
SERVER_URL=https://translate-api.air-inc.top
WORKER_API_KEY=和服务端一致
VLLM_API_URL=http://localhost:8000
VLLM_MODEL_NAME=HY-MT1.5
VLLM_MIN_OUTPUT_TOKENS=1024
VLLM_MAX_OUTPUT_TOKENS=4096
POLL_INTERVAL_SEC=10
```

### 3. 启动 vLLM（WSL）

```bash
# Windows PowerShell
wsl -d Ubuntu -- bash /mnt/c/Users/<你的用户名>/traeProjects/AirTranslate/worker/start_vllm.sh
```

可先检查：

```powershell
Invoke-RestMethod -Uri "http://localhost:8000/v1/models" -Method GET
```

### 4. 启动 Worker（可选同时启动 vLLM）

```powershell
.\scripts\start.ps1
# 或：同时在 WSL 启动 vLLM
.\scripts\start.ps1 -StartVllm
```

### 5. 停止 Worker

```powershell
.\scripts\stop.ps1
```

## 翻译引擎

| 引擎 | 类型 | 费用 | 说明 |
|------|------|------|------|
| HY-MT1.5-7B-FP8 | AI | 积分 | 腾讯混元翻译大模型，支持术语表/上下文，质量最高 |
| Azure Edge | 机器 | 免费 | 微软翻译，国内可直接访问 |
| MyMemory | 机器 | 免费 | 开源翻译记忆库，国内可直接访问 |
| Google Translate | 机器 | 免费 | ⚠️ 国内需 VPN，作为最后退避选项 |

## 客户端使用方式

1. 打开首页，点击 **新建翻译**。
2. 选择 EPUB，系统会自动统计字数并在本地提取封面。
3. 选择翻译引擎、目标语言、输出格式。
4. 若选择 AI，可按需开启“上下文翻译”或上传术语表（默认关闭上下文）。
5. 提交任务后回到列表页，点击“启动”后任务进入队列；列表优先显示本地缓存，再后台刷新远程状态。
6. 翻译完成后点击下载，文件名为“原书名_译本.epub”。

## 服务端 API

### App 接口

| 路由 | 说明 |
|------|------|
| `GET /health` | 健康检查 |
| `POST /jobs/create` | 创建翻译任务 |
| `POST /jobs/markUploaded` | 标记上传完成（进入待启动） |
| `POST /jobs/start` | 手动启动任务（加入队列） |
| `GET /jobs/progress?jobId=` | 查询任务进度 |
| `GET /jobs/download?jobId=` | 获取结果下载 URL |
| `GET /jobs/list?deviceId=` | 用户任务列表 |
| `GET /billing/balance?deviceId=` | 查询积分余额 |

### Worker 内部接口 (X-Worker-Key 认证)

| 路由 | 说明 |
|------|------|
| `GET /worker/poll` | 获取下一个待处理任务 + COS presign URLs |
| `POST /worker/progress` | 更新任务进度 |
| `POST /worker/complete` | 标记任务完成 |
| `POST /worker/fail` | 标记任务失败（自动退积分） |

## 技术栈

- **服务端**: Node.js (轻量服务器, PM2)
- **Worker**: Python 3.11 + httpx + BeautifulSoup
- **AI 推理**: vLLM (WSL2, OpenAI-compatible API)
- **AI 模型**: HY-MT1.5-7B-FP8 (腾讯混元翻译 v1.5)
- **客户端**: Flutter (Material 3)
- **存储**: 服务器本地文件系统 + 腾讯云 COS + 客户端本地缓存（Web/SQLite）
