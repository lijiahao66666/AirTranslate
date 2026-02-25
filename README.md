# AirTranslate — EPUB 全本翻译工具

上传 EPUB → 选择翻译引擎 → 全本翻译 → 下载双语/纯译文书籍

## 核心功能

- 📖 **EPUB 全本翻译** — 上传书籍，自动翻译全部章节
- 🧠 **AI 翻译** — 本地 HY-MT1.5-7B-FP8 大模型，支持术语表和上下文翻译
- 🤖 **机器翻译** — Azure Edge → MyMemory → Google 三引擎链式退避，完全免费
- 📝 **双语/纯译文** — 支持双语对照和纯译文两种输出格式
- 🌍 **33种语言** — 中英日韩法德西俄等主流语言全覆盖
- 💰 **积分系统** — AI 翻译按字数消耗积分，机器翻译免费

## 项目架构

```
AirTranslate/
├── app.js              # SCF 网关 (腾讯云 Serverless)
├── worker/             # Python 翻译 Worker (本地运行)
│   ├── worker.py       # COS 队列轮询 + 任务处理
│   ├── translators.py  # 翻译引擎 (AI + 机器翻译)
│   └── epub_util.py    # EPUB 解析/打包
├── flutter_app/        # Flutter 客户端 App
├── models/             # HY-MT1.5-7B-FP8 模型文件
└── scripts/            # 部署脚本
```

### 工作流程

1. **Flutter App** → 调用 SCF 网关创建翻译任务，上传 EPUB 到 COS
2. **SCF 网关** (`app.js`) → 管理任务、积分计费、COS presign URL
3. **Python Worker** → 轮询 COS 队列，下载 EPUB，翻译，上传结果
4. **Flutter App** → 轮询进度，翻译完成后下载

## 环境要求

- **GPU**: NVIDIA 显卡，显存 ≥ 16GB（如 RTX 4060 Ti 16GB）
- **系统**: Windows 10/11
- **Python**: 3.11+
- **NVIDIA 驱动**: 最新版本

> 不需要 Docker、WSL2 或 vLLM。模型通过 transformers 直接在 Windows 原生 Python 中加载到 GPU。

## 快速开始

### 1. 下载模型

从 HuggingFace 下载 [HY-MT1.5-7B-FP8](https://huggingface.co/tencent/HY-MT1.5-7B-FP8) 到 `models/` 目录。

### 2. 配置环境变量

```powershell
cp worker\.env.example worker\.env
```

编辑 `worker\.env`，填入腾讯云 COS 密钥：

```env
COS_SECRET_ID=your_secret_id
COS_SECRET_KEY=your_secret_key
COS_BUCKET=your-bucket-1256643821
COS_REGION=ap-guangzhou
MODEL_PATH=../models
```

### 3. 启动 Worker

```powershell
.\scripts\start.ps1
```

首次运行会自动创建虚拟环境并安装依赖（torch + transformers，需要几分钟）。

### 4. 停止 Worker

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

## SCF 网关 API

| 路由 | 说明 |
|------|------|
| `POST /jobs/create` | 创建翻译任务 |
| `POST /jobs/markUploaded` | 标记 EPUB 上传完成 |
| `GET /jobs/progress` | 查询任务进度 |
| `GET /jobs/download` | 获取结果下载 URL |
| `GET /jobs/list` | 获取用户任务列表 |
| `POST /billing/redeem` | 兑换积分卡密 |
| `GET /billing/balance` | 查询积分余额 |

## 技术栈

- **SCF 网关**: Node.js + 腾讯云 SCF + COS
- **Worker**: Python 3.11 + transformers + PyTorch + BeautifulSoup
- **AI 模型**: HY-MT1.5-7B-FP8 (腾讯混元翻译 v1.5)
- **客户端**: Flutter (Material 3)
- **存储**: 腾讯云 COS（任务数据、EPUB、积分）
