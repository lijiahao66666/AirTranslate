# AirTranslate 灵译

AirTranslate 是一款 Flutter 多端翻译工具，支持文档翻译（如 EPUB），并配套轻量服务端用于任务/配置与存储对接（如 COS）。

## Features
- EPUB 文档翻译
- Flutter 多端（Android/iOS/Web）
- 轻量 Node.js 服务端（配置/任务状态）
- 可接入对象存储（COS）

## Quick Start
### App
```bash
cd flutter_app
flutter pub get
flutter run
```

### Server
```bash
cd server
cp .env.example .env
npm install --omit=dev
pm2 start ecosystem.config.cjs
```

## Build
- Web: `flutter_app/scripts/build_web_release.ps1`
- Android: `flutter_app/scripts/build_android_apk_arm64_release.ps1`
- iOS: `flutter_app/scripts/build_ios_ipa_release.sh`

## Deploy
- Web: 将 `flutter_app/build/web/` 上传到站点目录
- Server: 将 `server/` 上传到 `/www/airtranslate/`，并运行 `pm2 start ecosystem.config.cjs`
- Nginx: `server/nginx.translate.air-inc.top.conf`

## Project Structure (Unified)
- `server/`: Node backend, env template, config, PM2 config, Nginx config
- `scripts/`: build/release scripts
- `web/` or `build/web/`: static web build output
- `docs/`: product and deployment notes (optional)

Nginx config location:
- `server/nginx.<domain>.conf`

Env template:
- `server/.env.example`