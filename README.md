# AirTranslate（灵译）

AirTranslate 是一款专注于 EPUB 电子书的全本翻译工具。它利用先进的 AI 模型，提供高质量、保留格式的文档翻译服务。

## 项目结构

本项目采用统一的结构设计：

- **client/**: Flutter 客户端源代码。
- **server/**: Node.js 后端服务。
- **scripts/**: 构建和部署脚本。
- **frp/**: 内网穿透配置 (用于将本地 GPU 服务器的 LLM 能力暴露给公网)。
- **test/**: 自动化测试脚本 (Python)，用于测试翻译引擎和 EPUB 处理。

## 技术栈

- **客户端**: Flutter
  - 动画: `flutter_animate`
  - 文件处理: `archive`, `file_picker`
- **服务端**: Node.js, Python
- **AI**: 本地部署的大语言模型 (vLLM) 或远程 API。

## 部署指南

### Web 端部署

1. 运行构建脚本：
   ```powershell
   ./scripts/build_web_release.ps1
   ```
2. 将构建产物上传至云服务器宝塔面板的 HTML 站点目录。
3. 访问域名：[translate.air-inc.top](https://translate.air-inc.top)

### 服务端部署

1. 将 `server/` 目录上传至服务器。
2. 安装依赖并启动服务。
3. 若使用本地 LLM，需确保 FRP 服务正常运行，以便服务端能连接到推理引擎。
