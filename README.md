# AirTranslate（灵译）

AirTranslate 是一款 EPUB 全本翻译工具，提供机器翻译与 AI 翻译两种模式，支持术语表、双语/纯译文输出与任务进度管理。服务端内置翻译任务队列、积分计费与本地 vLLM 接入能力。

## 功能概览

- EPUB 解析与字数统计：上传后解析 EPUB 文本并统计字符数。
- 翻译任务管理：任务创建、启动、进度追踪、结果下载。
- 输出模式：双语对照或纯译文。
- 术语表支持：支持 JSON 或文本术语表上传，AI 模式下生效。
- 引擎选择：机器翻译、AI 在线翻译、AI 个人部署三种模式。

## 客户端功能细节

- 引擎类型：
  - MACHINE：机器翻译（免费）。
  - AI_ONLINE：在线 AI 翻译（积分计费）。
  - AI：个人部署（本地 vLLM，通过 FRP）。
- 语言选择：支持自动识别与多语种目标语言。
- 术语表：可上传或手动输入，支持 key=value 或 JSON 格式。

## 服务端功能

- EPUB 解析：使用 `cheerio` 解析 EPUB 内部 XHTML。
- 翻译引擎：
  - 机器翻译：Azure Edge → MyMemory → Google 的多级兜底策略。
  - AI 在线：腾讯混元翻译 API，支持术语表 Glossary。
  - AI 个人：通过 FRP 访问本地 vLLM（HY-MT1.5-7B）。
- 积分系统与任务队列：本地文件系统保存任务、积分、统计。
- 远程配置接口 `/config`，控制计费与功能开关。

## 目录结构

- client/：Flutter 客户端
- server/：Node.js 翻译服务
- frp/：内网穿透工具
- models/：本地模型缓存
- logs/：服务日志
- README.md：项目说明

## 本地运行

客户端：
```
cd client
flutter pub get
flutter run
```

服务端：
```
cd server
npm install
node app.js
```

## Deployment

- Web build: run `client/scripts/build_web_release.ps1`.
- Output: `client/build/web/` and `client/airtranslate-web.zip`.
- Web deploy: upload the zip or `client/build/web/` to your static HTML site.
- Server deploy: upload `server/`, run `npm install`, then `pm2 start app.js --name airtranslate`.
- Config: edit `client/scripts/build_config.ps1` before building.

## 参考

项目规范请查看 `product_rule.md`。
