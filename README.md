# AirTranslate — EPUB 全本翻译工具

上传 EPUB → 选择翻译引擎 → 全本翻译 → 下载双语/纯译文书籍

## 核心功能

- 📖 **EPUB 全本翻译** — 上传书籍，自动翻译全部章节
- 🧠 **AI 翻译·个人** — 本地 vLLM GPU 推理（通过 frp 内网穿透），支持术语表和上下文翻译
- 🌐 **AI 翻译·在线** — 腾讯混元翻译 API，支持术语表（References），无需本地 GPU
- 🤖 **机器翻译** — Azure Edge → MyMemory → Google 三引擎链式退避，完全免费
- 📝 **双语/纯译文** — 支持双语对照和纯译文两种输出格式
- 🌍 **33种语言** — 中英日韩法德西俄等主流语言全覆盖
- 💰 **积分系统** — AI 翻译按字数消耗积分，机器翻译免费
- 💾 **本地优先列表** — Web 存浏览器缓存，移动端存 SQLite，本地封面不上传服务器

## 项目架构

```
AirTranslate/
├── app.js              # 服务端 (所有翻译引擎内嵌, 端口 9001)
├── .env                # 服务端环境变量
├── config.json         # 运行时配置 (积分/版本/AI开关)
├── data/               # 本地数据 (积分/任务/进度)
├── flutter_app/        # Flutter 客户端 App
└── scripts/
    └── start_vllm.sh   # WSL 中启动 vLLM (个人 AI 部署)
```

### 工作流程

1. **Flutter App** → 创建任务并上传 EPUB
2. **服务端** (`app.js`) → 管理任务/积分，直接执行翻译（三引擎独立并发）
3. **Flutter App** → 轮询进度并下载结果

### 翻译引擎并发架构

三种引擎使用独立信号量，互不阻塞：

| 引擎 | 并发数 | 翻译粒度 | 说明 |
|------|--------|---------|------|
| 机器翻译 | 10 | 段落级 | Azure Edge → MyMemory → Google 链式退避 |
| AI·在线 | 3 | 章节级(分块) | 腾讯混元翻译 API，支持术语表 |
| AI·个人 | 1 | 章节级(分块) | 通过 frp 穿透访问本地 vLLM |

### 数据存储

| 数据 | 存储位置 | 说明 |
|------|---------|------|
| 积分 | 服务器本地 `data/` | JSON 文件 |
| 任务/进度 | 服务器本地 `data/` | JSON 文件 |
| EPUB 源文件 | 腾讯云 COS | presign URL 直传 |
| EPUB 结果文件 | 腾讯云 COS | presign URL 直传 |
| 术语表 | 腾讯云 COS | presign URL 直传 |
| 任务列表缓存 | 客户端本地 | Web: SharedPreferences / 移动端: SQLite |
| 书籍封面 | 客户端本地 | 仅本地存储，不上传服务端 |

## 环境要求

### 服务端 (轻量服务器)
- **规格**: 2核 2GB 即可
- **Node.js**: 16+
- **PM2**: 进程管理 (推荐)
- **系统工具**: `unzip`、`zip` 命令 (用于 EPUB 解压/打包)

### 本地 AI (可选，需 GPU 机器 + frp)
- **GPU**: NVIDIA 显卡，显存 ≥ 16GB（如 RTX 4060 Ti 16GB）
- **WSL2**: Ubuntu（用于运行 vLLM）
- **frp**: 内网穿透，将本地 vLLM API 暴露给服务端

## 服务端部署

### 1. 配置服务端 .env

```env
PORT=9001
COS_BUCKET=your-bucket
COS_REGION=ap-guangzhou
TENCENT_SECRET_ID=你的SecretId
TENCENT_SECRET_KEY=你的SecretKey
COS_PREFIX=translate/
API_KEY=你的客户端鉴权密钥

# vLLM 远程地址 (通过 frp 内网穿透暴露的本地 GPU 推理服务)
VLLM_API_URL=http://your-server:7001
VLLM_MODEL_NAME=HY-MT1.5
VLLM_MAX_MODEL_LEN=8192
VLLM_MAX_OUTPUT_TOKENS=4096

# 混元翻译 API (在线 AI 翻译)
HY_TRANSLATION_MODEL=hunyuan-translation
HY_REGION=ap-guangzhou

# 短信验证码 (腾讯云 SMS)
SMS_APP_ID=你的AppId
SMS_SIGN=你的签名
SMS_TEMPLATE_ID=你的模板Id
```

### 2. 上传到服务器

```bash
scp app.js .env root@your-server:/www/airtranslate/
ssh root@your-server
cd /www/airtranslate
pm2 start app.js --name airtranslate
pm2 save
```

### 3. 验证

```bash
curl http://your-server:9001/health
# {"status":"ok","service":"AirTranslate",...}
```

## 本地 AI 部署 (可选)

如果需要使用"AI翻译·个人"功能，需要在有 GPU 的本地机器上部署 vLLM + frp。

### 1. 下载模型

从 HuggingFace 下载 [HY-MT1.5-7B-FP8](https://huggingface.co/tencent/HY-MT1.5-7B-FP8) 到 `~/models/` 目录。

### 2. 启动 vLLM（WSL）

```bash
wsl -d Ubuntu -- bash scripts/start_vllm.sh
```

验证 vLLM 是否正常运行：

```powershell
Invoke-RestMethod -Uri "http://localhost:8000/v1/models" -Method GET
```

### 3. 配置 frp 内网穿透

在本地机器运行 frpc，将 vLLM 的 8000 端口穿透到公网服务器。

**服务端 frps.toml:**

```toml
bindPort = 7000
```

**本地 frpc.toml:**

```toml
serverAddr = "your-server-ip"
serverPort = 7000

[[proxies]]
name = "vllm"
type = "tcp"
localIP = "127.0.0.1"
localPort = 8000
remotePort = 7001
```

然后在服务端 `.env` 中配置：

```env
VLLM_API_URL=http://127.0.0.1:7001
```

服务端会每 30 秒自动检测 vLLM 是否可达，在线时客户端会显示"个人部署"选项。

## config.json 运行时配置

```json
{
  "local_ai_enabled": true,      // 是否启用个人 AI 选项
  "checkin_enabled": true,        // 每日签到开关
  "checkin_points": 5000,         // 签到赠送积分
  "initial_grant_points": 500000, // 新用户赠送积分
  "billing_unit_chars": 100,      // 计费单位 (字数)
  "billing_unit_cost": 1,         // 每单位积分
  "online_ai_billing_multiplier": 100 // 在线AI倍率
}
```

将 `local_ai_enabled` 设为 `false` 可完全关闭个人 AI 选项，客户端不会显示。

## 服务端 API

| 路由 | 说明 |
|------|------|
| `GET /health` | 健康检查 |
| `GET /config` | 获取运行时配置 (含 local_ai_available 动态状态) |
| `POST /jobs/create` | 创建翻译任务 |
| `POST /jobs/markUploaded` | 标记上传完成 |
| `POST /jobs/start` | 启动翻译 |
| `GET /jobs/progress?jobId=` | 查询任务进度 |
| `GET /jobs/download?jobId=` | 获取结果下载 URL |
| `GET /jobs/list?deviceId=` | 用户任务列表 |
| `POST /jobs/delete` | 删除/取消任务 |
| `POST /billing/init` | 初始化积分 |
| `GET /billing/balance?deviceId=` | 查询积分余额 |
| `POST /checkin` | 每日签到 |
| `POST /checkin/status` | 签到状态查询 |
| `POST /auth/sms/send` | 发送验证码 |
| `POST /auth/sms/verify` | 验证码登录 |
| `POST /auth/profile` | 用户信息 |
| `POST /auth/logout` | 退出登录 |

## 技术栈

- **服务端**: Node.js (零依赖单文件, PM2 进程管理)
- **AI 推理**: vLLM (WSL2, OpenAI-compatible API) + frp 内网穿透
- **AI 在线**: 腾讯混元翻译 API (ChatTranslations)
- **AI 模型**: HY-MT1.5-7B-FP8 (腾讯混元翻译 v1.5)
- **客户端**: Flutter (Material 3)
- **存储**: 服务器本地文件系统 + 腾讯云 COS + 客户端本地缓存
