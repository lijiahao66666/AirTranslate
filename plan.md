# AirTranslate 重构方案（Flutter App + COS/SCF + 本地 GPU 推理）

## 1. 目标与约束

- 业务：离线书籍（EPUB）上传 → 后端翻译 → 下载译文/双语对照版本
- 前端：Flutter（Android / iOS / H5）
- 后端引擎：
  - 微软翻译：仅支持段落翻译
  - 谷歌翻译：仅支持段落翻译
  - HY-MT1.5-7B：支持段落/章节翻译，支持上下文与用户术语表
- 输出形式：
  - 仅译文 EPUB（translated.epub）
  - 双语对照 EPUB（bilingual.epub），作为排版层能力，所有引擎均可生成
- 基础设施：围绕腾讯 COS + SCF 做对象存储与进度管理；推理运行在自有 4060Ti 16G 主机（Ubuntu 24.04 LTS）
- 部署目标：方式 A（CI 构建镜像 → 服务器仅拉镜像运行），服务器不安装开发工具，只安装运行所需软件

## 2. 总体架构（最稳）

- Flutter App
  - 直传 EPUB 到 COS（STS 临时凭证或预签名 URL）
  - 轮询任务进度（从 SCF API 获取）
  - 完成后获取下载链接（预签名 URL）并下载
- SCF（控制面 / API）
  - 创建任务、签名上传、查询进度、生成下载链接、取消任务
  - 不做推理、不做 EPUB 解析
- 服务器（Ubuntu 24.04，含 4060Ti）
  - Java Control API（可选：也可把 API 放到 SCF；本方案保留 Java 以复用现有能力/逻辑）
  - Python GPU Worker（仅负责 HY 推理与任务执行，常驻服务）
- COS（状态与文件）
  - 保存 source.epub、结果 epub、任务元数据与进度文件

核心原则：把 CUDA/推理依赖隔离到 Worker；控制面保持轻、稳定、发布频率低。

## 3. COS 目录结构与状态机（对象即状态）

每个任务一个 jobId（UUID），COS Key 建议如下：

- jobs/{jobId}/source/source.epub
- jobs/{jobId}/job.json（创建参数，不可变）
- jobs/{jobId}/progress.json（覆盖写进度）
- jobs/{jobId}/events.jsonl（可选：追加写事件，排障用）
- jobs/{jobId}/result/translated.epub
- jobs/{jobId}/result/bilingual.epub
- jobs/{jobId}/tmp/（可选：中间产物，建议配生命周期自动清理）

状态机（progress.json.state）建议：

- CREATED → UPLOADED → PARSING → TRANSLATING → PACKAGING → UPLOADING_RESULT → DONE
- 任意阶段可到 FAILED / CANCELED

进度计算：以“章节（对应 spine 里的 xhtml/html 文件）”为最小 checkpoint；每完成一个章节更新一次 progress。v1 不做 unit 级断点续跑，失败后从章节重新开始即可。

## 4. 翻译模式与输出

### 4.1 段落模式（所有引擎）

- EPUB 解析出 XHTML DOM，仅抽取 text node 翻译，再写回 DOM
- 将 DOM 结构（标签/链接/脚注引用）视为不可改动区域，确保不会被模型破坏
- unit：标题、段落、列表项、表格单元等；超长 unit 做安全切分

### 4.2 章节模式（仅 HY，最稳定义）

章节模式不是“整章一次性翻译”，而是：

- 同一章节共享 context pack（章节标题、风格约束、用户术语表命中子集）
- 每次翻译仍按 unit 进行，但附带滚动窗口（最近 K 个已译 unit 的译文）
- 对章节过长自动裁剪/回退，保证不会因上下文过长导致失败

### 4.3 双语对照（排版层能力）

- 在每个 unit 位置保留原文段落
- 追加一个同级译文段落（标记 class），用 CSS 控制样式
- 兼容大部分 EPUB 阅读器，避免复杂分栏导致的兼容问题

## 5. 公平调度策略（多书并行）

GPU Worker 采用“轮转 + 配额”：

- activeJobs 队列（TRANSLATING 状态的任务）
- 每轮每个 job 处理 quotaUnits 个 unit（例如 1～3 个）
- 处理完放队尾，保证多书同时推进
- 可演进为 quotaTokens（按 token 估算更公平），但 v1 先用 quotaUnits 最稳

微软/谷歌翻译走独立队列与全局限流，不与 GPU 互相影响。

## 6. Ubuntu 24.04 服务器运行环境（仅运行时）

服务器只装运行必需项：

- OpenSSH Server（远程登录与运维）
- NVIDIA 驱动（建议用“附加驱动”安装推荐版本）
- Docker + Docker Compose
- NVIDIA Container Toolkit（让容器访问 GPU）

建议设置：

- 关闭休眠/睡眠
- 开启 UFW 防火墙，仅放行 SSH 与对外 API 端口
- 使用专用用户运行服务（避免 root 直接跑业务）

## 7. 办公机远程到服务器（SSH 最佳实践）

### 7.1 服务器侧准备

- 创建普通用户（例如 deploy）并加入 docker 组（仅需运行容器时）
- 开启 SSH key 登录，尽量禁用密码登录（减少被爆破风险）
- UFW 放行 SSH（默认 22 端口或自定义端口）

### 7.2 办公机侧连接方式

- 生成 SSH 密钥（ed25519 优先）
- 将公钥写入服务器用户的 authorized_keys
- 在办公机的 SSH 配置中写 Host 别名，之后可一条命令连接：
  - ssh server-gpu

建议：

- 为服务器固定内网 IP；公网访问建议走 VPN/堡垒机或至少改 SSH 端口并配合 Fail2ban
- 将部署命令限制在 deploy 用户下执行，不在办公机保存服务器 root 密码

## 8. 方式 A：GitHub Actions 构建镜像并发布（推荐）

本方案使用 GitHub Container Registry（GHCR）作为镜像仓库：

- Java Control API 镜像：ghcr.io/{owner}/{repo}-control-api:{tag}
- Python GPU Worker 镜像：ghcr.io/{owner}/{repo}-gpu-worker:{tag}

### 8.1 GitHub 仓库设置

- 仓库开启 Packages（GHCR）
- Actions 权限：
  - 允许工作流写 packages（需要 packages: write 权限）
- 建议的发布策略：
  - 每次发布用 Git tag（例如 v0.1.0）
  - 镜像同时推送：
    - :v0.1.0（固定可回滚）
    - :latest（可选，仅用于快速试验，不建议线上永远跟随）

### 8.2 构建方式建议

- control-api：
  - 使用多阶段 Dockerfile，构建阶段编译 jar，运行阶段仅包含 JRE 与 jar
- gpu-worker：
  - 基于 nvidia/cuda 运行时镜像（runtime），安装 Python 依赖
  - 模型文件建议在首次启动时下载到挂载卷缓存，避免每次构建把模型打进镜像

### 8.3 GitHub Actions 发布流程（高层步骤）

当推送 tag（例如 v0.1.0）时触发：

- checkout 代码
- 登录 GHCR（使用 GitHub Actions 的 GITHUB_TOKEN 或 PAT）
- 构建并 push 两个镜像（control-api / gpu-worker），tag 为 v0.1.0
- 可选：同时更新 latest tag

## 9. 服务器部署（仅拉镜像运行）

服务器只保留一份运行目录（例如 /opt/airtranslate），包含：

- docker-compose.yml
- .env（运行配置：COS bucket/region、密钥获取方式、任务路径前缀、并发配额等）
- volumes/（挂载卷：模型缓存、临时目录、日志）

部署升级命令（手动执行，最稳）：

- docker compose pull
- docker compose up -d

回滚方式：

- 将 docker-compose.yml 或 .env 中的镜像 tag 从新版本改回旧版本
- docker compose pull && docker compose up -d

可选自动化（后续再做）：

- GitHub Actions 在发布成功后 SSH 到服务器执行 pull + up -d
- 建议先手动发布，跑稳后再上自动化，减少初期不确定性

## 10. 里程碑计划（交付物与验收）

### M0：环境与最小闭环

- 服务器：Ubuntu 24.04 + NVIDIA 驱动 + Docker + NVIDIA Container Toolkit 跑通 GPU 容器
- COS/SCF：能创建任务、写 progress、生成下载链接
- HY：能跑通“纯文本翻译请求”闭环

### M1：任务协议与状态机定稿

- job.json / progress.json 字段与错误码定稿
- 取消/重试/断点续跑规则定稿

### M2：EPUB 译文版（段落模式，全引擎）

- EPUB 解析→unit 划分→翻译→回写 DOM→打包→上传 translated.epub
- 微软/谷歌/HY 三引擎跑通

### M3：Flutter MVP

- 书库/任务列表、新建翻译向导、上传、任务详情、下载/打开

### M4：双语对照输出

- bilingual.epub 生成与样式稳定

### M5：HY 章节模式 + 上下文 + 术语表

- 章节 context pack + 滚动窗口
- 用户术语表按命中子集下发
- 超长章节自动回退保证稳定

### M6：公平调度与上线加固

- GPU 轮转调度（quotaUnits）
- 自启、日志、清理策略、故障恢复完善
