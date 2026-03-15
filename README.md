# AirTranslate（灵译）

## 应用信息

**应用名称**：AirTranslate（灵译）

**应用分类**：电子书翻译

**精简标题**：EPUB 翻译工具

**应用简介**：支持 EPUB 导入与解析、翻译任务管理、机器翻译（Azure Edge/MyMemory/Google，10 并发）、AI 在线翻译（腾讯混元，3 并发）、AI 个人部署翻译（vLLM 内网穿透，1 并发）、术语表管理、双语对照与纯译文输出模式、积分计费、任务进度追踪的电子书翻译工具。

## 功能概览

- **EPUB 处理**：导入 EPUB 文件、解析章节结构、提取段落文本
- **翻译引擎**：
  - 机器翻译：Azure Edge → MyMemory → Google 级联，段落级，10 并发
  - AI 在线翻译：腾讯混元翻译 API，章节级逐段，支持术语库，3 并发
  - AI 个人部署：通过 frp 内网穿透访问本地 vLLM，章节级分块，1 并发
- **术语表**：上传/下载术语表（COS 存储）、翻译时应用术语库
- **输出模式**：双语对照输出、纯译文输出
- **任务管理**：创建翻译任务、查看进度、暂停/继续、历史记录
- **积分系统**：按字符计费、积分查询、签到赠送

## 技术架构

**客户端**：Flutter（支持 Android/iOS/Web）
- EPUB 解析：`epubx` 库
- 状态管理：Provider
- 本地存储：SharedPreferences + SQLite

**服务端**：Node.js + PM2
- 端口：9001
- 三引擎独立并发控制（信号量）
- 本地 JSON 存储任务、积分数据
- COS 存储术语表（presign URL）

## 部署说明

### 一、服务器部署（腾讯云 + 宝塔面板）

#### 1. Web 端部署

**步骤 1：构建 Web 产物**

在本地项目根目录执行：
```powershell
cd scripts
./build_web_release.ps1
```

构建产物位于 `client/build/web/` 目录。

**步骤 2：上传 Web 产物**

将 `client/build/web/` 目录下的所有文件上传到服务器：
```
/www/wwwroot/translate.air-inc.top/
```

**步骤 3：宝塔面板配置**

1. 登录宝塔面板
2. 点击【网站】→【添加站点】
3. 选择【HTML站点】，填写：
   - 域名：`translate.air-inc.top`
   - 根目录：`/www/wwwroot/translate.air-inc.top`
4. 点击【提交】创建站点

**步骤 4：配置 Nginx**

1. 在宝塔面板点击站点名称 →【设置】→【配置文件】
2. 将 `server/nginx.translate.air-inc.top.conf` 的内容复制进去
3. 关键配置说明：
   - `root /www/wwwroot/translate.air-inc.top;` - Web 根目录
   - `/api` 代理到 `http://127.0.0.1:9001` - 服务端端口
4. 点击【保存】

**步骤 5：申请 SSL 证书（可选）**

在宝塔面板点击【SSL】→【Let's Encrypt】→ 申请免费证书

#### 2. 服务端部署

**步骤 1：上传服务端代码**

将 `server/` 目录上传到服务器：
```
/www/airtranslate/
```

**步骤 2：安装依赖**

SSH 登录服务器后执行：
```bash
cd /www/airtranslate
npm install
```

**步骤 3：配置环境变量**

创建 `.env` 文件：
```bash
cp .env.example .env
nano .env
```

填写以下配置：
```bash
TENCENT_SECRET_ID=你的腾讯云SecretId
TENCENT_SECRET_KEY=你的腾讯云SecretKey
API_KEY=你的API密钥（可选）
PORT=9001

# COS 配置（术语表存储）
COS_SECRET_ID=你的COS SecretId
COS_SECRET_KEY=你的COS SecretKey
COS_BUCKET=你的存储桶名称
COS_REGION=ap-guangzhou

# AI 个人部署（可选）
AI_LOCAL_BASE_URL=http://127.0.0.1:8000
```

**步骤 4：使用 PM2 启动服务**

```bash
cd /www/airtranslate
pm2 start ecosystem.config.cjs --env production
```

或直接启动：
```bash
pm2 start app.js --name airtranslate
```

**步骤 5：设置开机自启**

```bash
pm2 save
pm2 startup
```

**步骤 6：验证服务**

```bash
pm2 status
curl http://127.0.0.1:9001/health
```

### 二、本地部署

#### 1. Web 端部署

**步骤 1：构建 Web 产物**

```powershell
cd scripts
./build_web_release.ps1
```

**步骤 2：启动本地静态服务器**

方法一：使用 http-server
```bash
npm install -g http-server
http-server client/build/web -p 8080
```

方法二：使用 Python
```bash
cd client/build/web
python -m http.server 8080
```

**步骤 3：访问应用**

浏览器打开 `http://localhost:8080`

#### 2. 服务端部署

**步骤 1：安装依赖**

```bash
cd server
npm install
```

**步骤 2：配置环境变量**

创建 `.env` 文件（同服务器部署）

**步骤 3：启动服务**

```bash
node app.js
```

或使用 PM2：
```bash
pm2 start app.js --name airtranslate-local
```

服务运行在 `http://localhost:9001`

**步骤 4：配置 Web 端 API 地址**

如果 Web 端和服务端不在同一端口，需要修改构建配置：
```powershell
# 编辑 scripts/build_config.ps1
$apiBaseUrl = "http://localhost:9001"
```

然后重新构建 Web 产物。

## 目录结构

```
AirTranslate/
├── client/                    # Flutter 客户端
│   ├── android/               # Android 原生代码
│   ├── ios/                   # iOS 原生代码
│   ├── lib/                   # Dart 源代码
│   ├── web/                   # Web 资源
│   └── scripts/               # 客户端构建脚本
├── server/                    # Node.js 服务端
│   ├── app.js                 # 主服务入口
│   ├── ecosystem.config.cjs   # PM2 配置
│   ├── nginx.*.conf           # Nginx 配置示例
│   └── data/                  # 数据目录
│       ├── points/            # 积分数据
│       ├── jobs/              # 翻译任务
│       └── jobs_archive/      # 任务归档
├── frp/                       # FRP 内网穿透工具
│   ├── frpc.exe               # FRP 客户端
│   └── frpc.toml              # FRP 配置文件
├── scripts/                   # 本地 AI 启动脚本
│   ├── start_local.ps1        # 启动 frpc + vLLM
│   ├── start_vllm.sh          # WSL 中启动 vLLM
│   └── stop_local.ps1         # 停止本地服务
├── test/                      # 测试文件
└── README.md
```

## 本地 AI 部署（vLLM + FRP 内网穿透）

如果需要使用本地部署的 AI 模型进行翻译，需要配置 vLLM 和 FRP 内网穿透。

### 1. FRP 配置

FRP 用于将本地 vLLM 服务暴露到公网，使服务器能够访问本地 AI 模型。

编辑 `frp/frpc.toml`：
```toml
serverAddr = "你的FRP服务器IP"
serverPort = 7000

[[proxies]]
name = "vllm"
type = "tcp"
localIP = "127.0.0.1"
localPort = 8000
remotePort = 7001
```

### 2. vLLM 配置

编辑 `scripts/start_vllm.sh`，修改模型路径：
```bash
MODEL_PATH="$HOME/models"  # 你的模型路径
```

确保 WSL 中已安装 vLLM 环境：
```bash
# 创建虚拟环境
python3 -m venv ~/vllm-env
source ~/vllm-env/bin/activate

# 安装 vLLM
pip install vllm
```

### 3. 启动本地 AI 服务

在项目根目录执行：
```powershell
.\scripts\start_local.ps1
```

该脚本会：
1. 启动 frpc 客户端，建立内网穿透
2. 在 WSL 中启动 vLLM 服务

### 4. 配置服务端连接

在服务端 `.env` 中配置：
```bash
AI_LOCAL_BASE_URL=http://你的FRP服务器IP:7001
```

### 5. 停止服务

```powershell
.\scripts\stop_local.ps1
```

## 常用命令

```bash
# 查看 PM2 服务状态
pm2 status

# 查看日志
pm2 logs airtranslate

# 重启服务
pm2 restart airtranslate

# 停止服务
pm2 stop airtranslate

# 重新部署 Web
cd scripts && ./build_web_release.ps1
# 然后上传 client/build/web/ 到服务器
```

## 注意事项

- 首次部署前需申请腾讯云 API 密钥（SecretId/SecretKey）
- 术语表存储需开通腾讯云 COS 服务
- AI 个人部署翻译需要配置 frp 内网穿透或公网访问
- 生产环境建议配置 `API_KEY` 进行接口鉴权
- 移动端打包需配置签名证书
- 本地部署时注意跨域问题

## 参考

项目规范请查看 `product_rule.md`。
