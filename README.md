# AirTranslate 鈥?EPUB 鍏ㄦ湰缈昏瘧宸ュ叿

涓婁紶 EPUB 鈫?閫夋嫨缈昏瘧寮曟搸 鈫?鍏ㄦ湰缈昏瘧 鈫?涓嬭浇鍙岃/绾瘧鏂囦功绫?

## 鏍稿績鍔熻兘

- 馃摉 **EPUB 鍏ㄦ湰缈昏瘧** 鈥?涓婁紶涔︾睄锛岃嚜鍔ㄧ炕璇戝叏閮ㄧ珷鑺?
- 馃 **AI 缈昏瘧路涓汉** 鈥?鏈湴 vLLM GPU 鎺ㄧ悊锛堥€氳繃 frp 鍐呯綉绌块€忥級锛屾敮鎸佹湳璇〃鍜屼笂涓嬫枃缈昏瘧
- 馃寪 **AI 缈昏瘧路鍦ㄧ嚎** 鈥?鑵捐娣峰厓缈昏瘧 API锛屾敮鎸佹湳璇簱锛圙lossaryIDs锛夛紝鏃犻渶鏈湴 GPU
- 馃 **鏈哄櫒缈昏瘧** 鈥?Azure Edge 鈫?MyMemory 鈫?Google 涓夊紩鎿庨摼寮忛€€閬匡紝瀹屽叏鍏嶈垂
- 馃摑 **鍙岃/绾瘧鏂?* 鈥?鏀寔鍙岃瀵圭収鍜岀函璇戞枃涓ょ杈撳嚭鏍煎紡
- 馃實 **33绉嶈瑷€** 鈥?涓嫳鏃ラ煩娉曞痉瑗夸縿绛変富娴佽瑷€鍏ㄨ鐩?
- 馃挵 **绉垎绯荤粺** 鈥?AI 缈昏瘧鎸夊瓧鏁版秷鑰楃Н鍒嗭紝鏈哄櫒缈昏瘧鍏嶈垂
- 馃捑 **鏈湴浼樺厛鍒楄〃** 鈥?Web 瀛樻祻瑙堝櫒缂撳瓨锛岀Щ鍔ㄧ瀛?SQLite锛屾湰鍦板皝闈笉涓婁紶鏈嶅姟鍣?

## 椤圭洰鏋舵瀯

```
AirTranslate/
鈹溾攢鈹€ app.js              # 鏈嶅姟绔?(鎵€鏈夌炕璇戝紩鎿庡唴宓? 绔彛 9001)
鈹溾攢鈹€ .env                # 鏈嶅姟绔幆澧冨彉閲?
鈹溾攢鈹€ config.json         # 杩愯鏃堕厤缃?(绉垎/鐗堟湰/AI寮€鍏?
鈹溾攢鈹€ data/               # 鏈湴鏁版嵁 (绉垎/浠诲姟/杩涘害)
鈹溾攢鈹€ flutter_app/        # Flutter 瀹㈡埛绔?App
鈹?  鈹斺攢鈹€ scripts/
鈹?      鈹溾攢鈹€ build_config.ps1    # 缁熶竴鏋勫缓閰嶇疆 (澶囨鍓?鍚庡垏鎹?
鈹?      鈹溾攢鈹€ build_web_release.ps1
鈹?      鈹溾攢鈹€ build_android_aab_release.ps1
鈹?      鈹溾攢鈹€ build_android_apk_arm64_release.ps1
鈹?      鈹斺攢鈹€ build_ios_ipa_release.sh
鈹溾攢鈹€ frp/                # frp 鍐呯綉绌块€?(frpc.exe + frpc.toml)
鈹斺攢鈹€ scripts/
    鈹溾攢鈹€ start_local.ps1  # 涓€閿惎鍔ㄦ湰鍦?AI (frpc + vLLM)
    鈹溾攢鈹€ stop_local.ps1   # 涓€閿仠姝㈡湰鍦?AI
    鈹斺攢鈹€ start_vllm.sh    # WSL 涓惎鍔?vLLM (鐢?start_local.ps1 璋冪敤)
```

### 宸ヤ綔娴佺▼

1. **Flutter App** 鈫?鍒涘缓浠诲姟骞朵笂浼?EPUB
2. **鏈嶅姟绔?* (`app.js`) 鈫?绠＄悊浠诲姟/绉垎锛岀洿鎺ユ墽琛岀炕璇戯紙涓夊紩鎿庣嫭绔嬪苟鍙戯級
3. **Flutter App** 鈫?杞杩涘害骞朵笅杞界粨鏋?

### 缈昏瘧寮曟搸骞跺彂鏋舵瀯

涓夌寮曟搸浣跨敤鐙珛淇″彿閲忥紝浜掍笉闃诲锛?

| 寮曟搸 | 骞跺彂鏁?| 缈昏瘧绮掑害 | 璇存槑 |
|------|--------|---------|------|
| 鏈哄櫒缈昏瘧 | 10 | 娈佃惤绾?| Azure Edge 鈫?MyMemory 鈫?Google 閾惧紡閫€閬?|
| AI路鍦ㄧ嚎 | 3 | 绔犺妭绾?鍒嗗潡) | 鑵捐娣峰厓缈昏瘧 API锛屾敮鎸佹湳璇〃 |
| AI路涓汉 | 1 | 绔犺妭绾?鍒嗗潡) | 閫氳繃 frp 绌块€忚闂湰鍦?vLLM |

### 鏁版嵁瀛樺偍

| 鏁版嵁 | 瀛樺偍浣嶇疆 | 璇存槑 |
|------|---------|------|
| 绉垎 | 鏈嶅姟鍣ㄦ湰鍦?`data/` | JSON 鏂囦欢 |
| 浠诲姟/杩涘害 | 鏈嶅姟鍣ㄦ湰鍦?`data/` | JSON 鏂囦欢 |
| EPUB 婧愭枃浠?| 鑵捐浜?COS | presign URL 鐩翠紶 |
| EPUB 缁撴灉鏂囦欢 | 鑵捐浜?COS | presign URL 鐩翠紶 |
| 鏈琛?| 鑵捐浜?COS | presign URL 鐩翠紶 |
| 浠诲姟鍒楄〃缂撳瓨 | 瀹㈡埛绔湰鍦?| Web: SharedPreferences / 绉诲姩绔? SQLite |
| 涔︾睄灏侀潰 | 瀹㈡埛绔湰鍦?| 浠呮湰鍦板瓨鍌紝涓嶄笂浼犳湇鍔＄ |

## 鐜瑕佹眰

### 鏈嶅姟绔?(杞婚噺鏈嶅姟鍣?
- **瑙勬牸**: 2鏍?2GB 鍗冲彲
- **Node.js**: 18+ (鎺ㄨ崘 20+锛涜嫢鐢?Node 18 浼氫娇鐢?cheerio 1.0.0-rc.12 浠ュ吋瀹?
- **PM2**: 杩涚▼绠＄悊 (鎺ㄨ崘)
- **绯荤粺宸ュ叿**: `unzip`銆乣zip` 鍛戒护 (鐢ㄤ簬 EPUB 瑙ｅ帇/鎵撳寘)

### 鏈湴 AI (鍙€夛紝闇€ GPU 鏈哄櫒 + frp)
- **GPU**: NVIDIA 鏄惧崱锛屾樉瀛?鈮?16GB锛堝 RTX 4060 Ti 16GB锛?
- **WSL2**: Ubuntu锛堢敤浜庤繍琛?vLLM锛?
- **frp**: 鍐呯綉绌块€忥紝灏嗘湰鍦?vLLM API 鏆撮湶缁欐湇鍔＄

## 鏈嶅姟绔儴缃?

### 1. 閰嶇疆鏈嶅姟绔?.env

```env
PORT=9001
COS_BUCKET=your-bucket
COS_REGION=ap-guangzhou
TENCENT_SECRET_ID=浣犵殑SecretId
TENCENT_SECRET_KEY=浣犵殑SecretKey
COS_PREFIX=translate/
API_KEY=浣犵殑瀹㈡埛绔壌鏉冨瘑閽?

# vLLM 杩滅▼鍦板潃 (閫氳繃 frp 鍐呯綉绌块€忔毚闇茬殑鏈湴 GPU 鎺ㄧ悊鏈嶅姟)
VLLM_API_URL=http://your-server:7001
VLLM_MODEL_NAME=HY-MT1.5
VLLM_MAX_MODEL_LEN=8192
VLLM_MAX_OUTPUT_TOKENS=4096

# 娣峰厓缈昏瘧 API (鍦ㄧ嚎 AI 缈昏瘧)
HY_TRANSLATION_MODEL=hunyuan-translation
HY_REGION=ap-guangzhou

# 鐭俊楠岃瘉鐮?(鑵捐浜?SMS)
SMS_APP_ID=浣犵殑AppId
SMS_SIGN=浣犵殑绛惧悕
SMS_TEMPLATE_ID=浣犵殑妯℃澘Id
```

### 2. 涓婁紶鍒版湇鍔″櫒

```bash
scp -r server root@your-server:/www/airtranslate/
ssh root@your-server
cd /www/airtranslate/server
npm install --omit=dev
pm2 start ecosystem.config.cjs
pm2 save
```

### 3. 楠岃瘉

```bash
curl http://your-server:9001/health
# {"status":"ok","service":"AirTranslate",...}
```

## 鏈湴 AI 閮ㄧ讲 (鍙€?

濡傛灉闇€瑕佷娇鐢?AI缈昏瘧路涓汉"鍔熻兘锛岄渶瑕佸湪鏈?GPU 鐨勬湰鍦版満鍣ㄤ笂閮ㄧ讲 vLLM + frp銆?

### 1. 涓嬭浇妯″瀷

浠?HuggingFace 涓嬭浇 [HY-MT1.5-7B-FP8](https://huggingface.co/tencent/HY-MT1.5-7B-FP8) 鍒?WSL 鐨?`~/models/` 鐩綍銆?

### 2. 閰嶇疆 frp 鐩綍

鍦ㄩ」鐩牴鐩綍涓嬫柊寤?`frp/` 鐩綍锛屼粠 [frp Releases](https://github.com/fatedier/frp/releases) 涓嬭浇 Windows 鐗堬紝灏?`frpc.exe` 鏀惧叆 `frp/` 涓€?

### 3. 鏈嶅姟绔厤缃?frps

鍦ㄥ叕缃戞湇鍔″櫒涓婂畨瑁呭苟杩愯 frps锛?

```toml
# /etc/frp/frps.toml
bindPort = 7000
```

```bash
# 鐢?systemd 绠＄悊
sudo systemctl start frps
```

鐒跺悗鍦ㄦ湇鍔＄ `.env` 涓厤缃┛閫忓悗鐨勫湴鍧€锛?

```env
VLLM_API_URL=http://127.0.0.1:7001
```

### 4. 鏈湴閰嶇疆 frpc

缂栬緫 `frp/frpc.toml`锛屽～鍏ユ湇鍔″櫒 IP锛?

```toml
serverAddr = "浣犵殑鏈嶅姟鍣↖P"
serverPort = 7000

[[proxies]]
name = "vllm"
type = "tcp"
localIP = "127.0.0.1"
localPort = 8000
remotePort = 7001
```

### 5. 涓€閿惎鍔?

```powershell
.\scripts\start_local.ps1
```

鑴氭湰浼氫粠 `frp/` 鐩綍鍚姩 `frpc.exe` 骞惰鍙?`frpc.toml`锛屽悓鏃跺湪 WSL 涓悗鍙板惎鍔?vLLM锛屾棩蹇楄緭鍑哄埌 `logs/` 鐩綍銆?

### 6. 鍋滄

```powershell
.\scripts\stop_local.ps1
```

### 宸ヤ綔鍘熺悊

```
鏈湴鏈哄櫒                          鍏綉鏈嶅姟鍣?
鈹屸攢鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹?   frp tunnel     鈹屸攢鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹?
鈹?vLLM    鈹傗梽鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹?app.js   鈹?
鈹?:8000   鈹? (localPort:8000  鈹?璋冪敤     鈹?
鈹?(WSL)   鈹?  remotePort:7001)鈹?:7001    鈹?
鈹斺攢鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹?                  鈹斺攢鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹?
     鈹?                             鈹?
  frpc.exe 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈻?frps :7000
```

鏈嶅姟绔瘡 30 绉掕嚜鍔ㄦ娴?vLLM 鏄惁鍙揪锛屽湪绾挎椂瀹㈡埛绔細鏄剧ず"涓汉閮ㄧ讲"閫夐」锛岀绾挎椂鑷姩闅愯棌銆?

## config.json 杩愯鏃堕厤缃?

```json
{
  "local_ai_enabled": true,      // 鏄惁鍚敤涓汉 AI 閫夐」
  "checkin_enabled": true,        // 姣忔棩绛惧埌寮€鍏?
  "checkin_points": 5000,         // 绛惧埌璧犻€佺Н鍒?
  "initial_grant_points": 500000, // 鏂扮敤鎴疯禒閫佺Н鍒?
  "billing_unit_chars": 100,      // 涓汉AI: 1绉垎/100瀛?
  "billing_unit_cost": 1,         // 姣忓崟浣嶇Н鍒?
  "online_ai_billing_multiplier": 100  // 鍦ㄧ嚎AI: 1绉垎/瀛?(100绉垎/100瀛?
}
```

灏?`local_ai_enabled` 璁句负 `false` 鍙畬鍏ㄥ叧闂釜浜?AI 閫夐」锛屽鎴风涓嶄細鏄剧ず銆?

## 鏈嶅姟绔?API

| 璺敱 | 璇存槑 |
|------|------|
| `GET /health` | 鍋ュ悍妫€鏌?|
| `GET /config` | 鑾峰彇杩愯鏃堕厤缃?(鍚?local_ai_available 鍔ㄦ€佺姸鎬? |
| `POST /jobs/create` | 鍒涘缓缈昏瘧浠诲姟 |
| `POST /jobs/markUploaded` | 鏍囪涓婁紶瀹屾垚 |
| `POST /jobs/start` | 鍚姩缈昏瘧 |
| `GET /jobs/progress?jobId=` | 鏌ヨ浠诲姟杩涘害 |
| `GET /jobs/download?jobId=` | 鑾峰彇缁撴灉涓嬭浇 URL |
| `GET /jobs/list?deviceId=` | 鐢ㄦ埛浠诲姟鍒楄〃 |
| `POST /jobs/delete` | 鍒犻櫎/鍙栨秷浠诲姟 |
| `POST /billing/init` | 鍒濆鍖栫Н鍒?|
| `GET /billing/balance?deviceId=` | 鏌ヨ绉垎浣欓 |
| `POST /checkin` | 姣忔棩绛惧埌 |
| `POST /checkin/status` | 绛惧埌鐘舵€佹煡璇?|
| `POST /auth/sms/send` | 鍙戦€侀獙璇佺爜 |
| `POST /auth/sms/verify` | 楠岃瘉鐮佺櫥褰?|
| `POST /auth/profile` | 鐢ㄦ埛淇℃伅 |
| `POST /auth/logout` | 閫€鍑虹櫥褰?|

## Flutter 瀹㈡埛绔墦鍖?

鍦?`flutter_app/` 鐩綍涓嬫墽琛屻€俉eb / Android / iOS 鍏辩敤 `scripts/build_config.ps1`锛?
- **澶囨鍚?*锛歚$UseIpMode = $false`锛堥粯璁わ級锛孉PI 浣跨敤 `translate.air-inc.top/api`
- **澶囨鍓?*锛歚$UseIpMode = $true`锛孉PI 浣跨敤 `122.51.10.98:8082/api`
- iOS 闇€鍚屾淇敼 `build_ios_ipa_release.sh` 涓殑 `USE_IP_MODE`

```powershell
cd flutter_app
.\scripts\build_web_release.ps1              # Web
.\scripts\build_android_aab_release.ps1      # Android AAB
.\scripts\build_android_apk_arm64_release.ps1 # Android APK
```

```bash
./scripts/build_ios_ipa_release.sh            # iOS
```

## 鎶€鏈爤

- **鏈嶅姟绔?*: Node.js (cheerio EPUB 瑙ｆ瀽, PM2 杩涚▼绠＄悊)
- **AI 鎺ㄧ悊**: vLLM (WSL2, OpenAI-compatible API) + frp 鍐呯綉绌块€?
- **AI 鍦ㄧ嚎**: 鑵捐娣峰厓缈昏瘧 API (ChatTranslations)
- **AI 妯″瀷**: HY-MT1.5-7B-FP8 (鑵捐娣峰厓缈昏瘧 v1.5)
- **瀹㈡埛绔?*: Flutter (Material 3)
- **瀛樺偍**: 鏈嶅姟鍣ㄦ湰鍦版枃浠剁郴缁?+ 鑵捐浜?COS + 瀹㈡埛绔湰鍦扮紦瀛?

## 服务端目录统一（2026-03）

AirTranslate 的 Node 服务现在统一放在 `server/` 目录下，推荐服务器路径为 `/www/airtranslate/server`。

首次部署：

```bash
scp -r server root@your-server:/www/airtranslate/
ssh root@your-server "cd /www/airtranslate/server && npm install --omit=dev"
ssh root@your-server "cd /www/airtranslate/server && pm2 start ecosystem.config.cjs"
ssh root@your-server "pm2 save"
```

日常更新：

```bash
ssh root@your-server "cd /www/airtranslate/server && pm2 restart airtranslate"
```

`server/package-lock.json` 继续保留，不删除。它用于锁定 `cheerio` 及其子依赖版本，避免服务器重新安装依赖时出现版本漂移。