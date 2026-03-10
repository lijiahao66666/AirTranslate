# Air Inc. 产品开发规范

本文档旨在统一 Air Inc. 旗下所有应用的项目结构、技术选型和部署流程，以提高开发效率和维护性。

## 1. 项目目录结构

所有新项目必须遵循以下目录结构：

```
ProjectRoot/
├── client/           # 客户端源代码 (Flutter/Web)
│   ├── android/
│   ├── ios/
│   ├── lib/
│   ├── web/
│   ├── pubspec.yaml
│   └── ...
├── server/           # 服务端源代码 (Node.js)
│   ├── app.js
│   ├── package.json
│   └── ...
├── scripts/          # 构建与部署脚本
│   ├── build_web_release.ps1
│   └── ...
├── docs/             # (可选) 项目文档
├── README.md         # 项目说明文档
└── product_rule.md   # 本规范文档 (即本文件)
```

## 2. 技术选型

### 客户端 (Client)
- **框架**: Flutter (首选) 或 Web (HTML/JS, React/Vue)。
- **语言**: Dart (Flutter), JavaScript/TypeScript (Web)。
- **常用组件 (Flutter)**:
  - 状态管理: `provider`
  - 网络请求: `http`
  - 本地存储: `shared_preferences` (轻量), `sqflite` (关系型)
  - 路由: `go_router` (推荐)
  - 动画: `flutter_animate`
  - 国际化: `intl`

### 服务端 (Server)
- **运行环境**: Node.js (LTS 版本)。
- **进程管理**: PM2。
- **Web 服务器**: Nginx (作为反向代理)。

### 云服务与 AI 能力
- **云服务商**: 腾讯云 (Tencent Cloud)。
- **推荐能力**:
  - **TTS (语音合成)**: 用于朗读功能。
  - **TMT (机器翻译)**: 用于多语言支持。
  - **Hunyuan (混元大模型)**: 用于智能对话、内容生成。
  - **COS (对象存储)**: 用于文件存储。
- **本地 AI**: MNN (端侧推理), vLLM (本地/服务器推理)。

## 3. 部署流程

### Web 端
1. 使用 `scripts/build_web_release.ps1` 进行构建。
2. 将构建产物 (通常在 `client/build/web`) 上传至云服务器。
3. 使用宝塔面板 (Baota Panel) 创建 HTML 站点，指向上传目录。
4. 域名格式: `[app_name].air-inc.top`。

### 服务端
1. 将 `server/` 目录代码上传至云服务器。
2. 运行 `npm install` 安装依赖。
3. 使用 PM2 启动服务。
4. 配置 Nginx 反向代理，将 API 请求转发至 Node.js 服务端口。

### 移动端
1. Android: 构建 APK/AAB，签名并发布。
2. iOS: 构建 IPA，通过 TestFlight 或 App Store 发布。

## 4. 文档规范
- 每个项目根目录必须包含 `README.md`。
- `README.md` 需包含：项目简介、详细结构说明、部署步骤、域名信息。
