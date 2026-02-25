# AirTranslate 全栈方案 v3

> **硬件**: AMD R7 5700X / 32GB RAM / RTX 4060 Ti 16GB / 500GB SSD (剩余 ~260GB)
> **操作系统**: Windows（WSL2 + Docker Desktop 跑 vLLM）
> **网络**: 无公网 IP，App 上应用市场

---

## 一、架构简化分析

### 1.1 能否去掉 SCF？

| 考虑因素 | 结论 |
|----------|------|
| 本机无公网 IP | App 用户无法直连本机，**必须有一个云端中转** |
| App 上应用市场 | COS 密钥不能暴露给客户端，**需要安全中间层** |
| SCF 免费额度 | 每月 100万次调用 + 40万 GBs，完全够用，**零成本** |
| 已有 app.js 代码 | 760行，经过设计，**改几行即可复用** |

**结论：SCF 保留，但精简 app.js；去掉 Java Worker，换成轻量 Python 脚本。**

### 1.2 精简前 vs 精简后

```
精简前 (4 组件 + 3 语言):                精简后 (3 组件 + 2 语言):
  SCF (Node.js) ─── 760行                  SCF (Node.js) ─── ~500行 (精简)
  Java Worker   ─── ~1200行 + pom.xml      Python Worker ─── ~400行 + requirements.txt
  vLLM Docker   ─── 配置                   vLLM Docker   ─── 配置 (WSL2)
  Flutter App   ─── 待开发                  Flutter App   ─── 待开发
```

**去掉的东西**:
- 整个 Java/Maven/Spring Boot 技术栈
- `BillingSettings.java`、`billing.py` —— 计费全在 SCF 层完成，Worker 不再管计费
- `scf_client.py` 的复杂度 —— Worker 直接用 COS Python SDK 操作，SCF 只做 App 网关
- 章节翻译模式 —— **第一版只做段落翻译**，章节翻译后续加

### 1.3 最终架构

```
┌──────────────────────────────────────────────┐
│               腾讯云 (免费层)                  │
│                                              │
│  ┌──────────────┐     ┌──────────────────┐   │
│  │ SCF (app.js) │◄───►│  COS             │   │
│  │ App 网关     │     │  - 书籍文件       │   │
│  │ - 创建任务   │     │  - 任务/进度      │   │
│  │ - 积分管理   │     │  - 积分数据       │   │
│  │ - presign    │     │  - 队列           │   │
│  └──────▲───────┘     └───────▲──────────┘   │
│         │                     │              │
└─────────┼─────────────────────┼──────────────┘
          │ HTTPS               │ COS SDK (直连)
          │                     │
┌─────────┴───┐   ┌────────────┴───────────────┐
│ Flutter App │   │ Windows 本机                 │
│ (用户手机)  │   │                              │
│             │   │  Python Worker (原生)        │
│             │   │    ├─ 轮询 COS 队列          │
│             │   │    ├─ 下载/处理/上传 EPUB     │
│             │   │    └─ 调翻译引擎              │
│             │   │          │                   │
│             │   │  vLLM (WSL2 Docker)          │
│             │   │    └─ HY-MT1.5-7B-FP8       │
│             │   │       :8000                  │
│             │   └──────────────────────────────┘
└─────────────┘
```

**关键简化**: Worker 不再通过 SCF 中转操作 COS，而是直接用 COS Python SDK。
SCF 只面向 App，Worker 是独立进程直连 COS。两者通过 COS 对象（队列、进度）间接通信。

---

## 二、技术栈决策

### 2.1 后端：**Python 替代 Java**

| 维度 | Java 现状 | Python 方案 |
|------|-----------|-------------|
| EPUB 处理 | Jsoup + 自写 ZipUtil (~400行) | ebooklib + BeautifulSoup (~100行) |
| HTTP 请求 | RestTemplate (~200行) | httpx (~50行) |
| 配置管理 | Spring Boot properties | 一个 .env 文件 |
| 翻译引擎 | 3个类 (~450行) | 3个函数 (~150行) |
| 部署 | JDK 21 + Maven + 400MB JAR | `pip install` + 一个 .py |
| COS 操作 | 通过 SCF HTTP 间接 | cos-python-sdk-v5 直连 |

### 2.2 推理服务：WSL2 Docker + vLLM

Windows 上 vLLM **必须通过 WSL2 Docker**（vLLM 不原生支持 Windows CUDA）。

**前置条件** (一次性):
1. Windows 启用 WSL2
2. 安装 Docker Desktop，启用 WSL2 backend + NVIDIA Container Toolkit
3. `nvidia-smi` 在 WSL2 中可用

**模型部署**:
```powershell
# 下载模型到 Windows 目录 (约 8GB)
pip install modelscope
modelscope download --model Tencent-Hunyuan/HY-MT1.5-7B-FP8 --local_dir C:\Users\28679\llmModels\HY-MT1.5-7B-FP8

# 启动 vLLM (WSL2 Docker，访问 Windows 路径需要 /mnt/c/... 或 volume mount)
docker run -d ^
  --gpus all ^
  --shm-size=8g ^
  -p 8000:8000 ^
  --name hy-mt ^
  -v C:\Users\28679\llmModels\HY-MT1.5-7B-FP8:/models/hy-mt ^
  vllm/vllm-openai:v0.10.0 ^
  --model /models/hy-mt ^
  --port 8000 ^
  --trust-remote-code ^
  --tensor-parallel-size 1 ^
  --dtype bfloat16 ^
  --kv-cache-dtype fp8 ^
  --served-model-name hunyuan ^
  --max-model-len 4096 ^
  --gpu-memory-utilization 0.85 ^
  --host 0.0.0.0
```

> **注意**: `--shm-size=8g` (不是 16g，给系统留内存)；`--gpu-memory-utilization 0.85` (留 15% 给系统)

**验证**:
```powershell
curl http://localhost:8000/v1/chat/completions -H "Content-Type: application/json" -d "{\"model\":\"hunyuan\",\"messages\":[{\"role\":\"user\",\"content\":\"Translate into Chinese: Hello world\"}],\"max_tokens\":100}"
```

### 2.3 HY-MT1.5 Prompt 模板（官方）

| 场景 | Prompt |
|------|--------|
| 中↔外 | `将以下文本翻译为{target_lang}，注意只需要输出翻译后的结果，不要额外解释： {text}` |
| 外↔外 | `Translate the following segment into {target_lang}, without additional explanation. {text}` |
| 术语干预 | `参考下面的翻译： {src_term} 翻译成 {tgt_term} 将以下文本翻译为{target_lang}...` |
| 上下文 | `{context} 参考上面的信息，把下面的文本翻译成{target_lang}...` |

**推理参数**: `top_k=20, top_p=0.6, temperature=0.7, repetition_penalty=1.05`

---

## 三、Python Worker

### 3.1 项目结构（极简）

```
worker/
  .env               # COS 密钥、vLLM URL 等配置
  requirements.txt
  worker.py           # 单文件入口：轮询 + 处理（<300行）
  translators.py      # 翻译引擎：AI翻译 + 机器翻译链式退避（<200行）
  epub_util.py        # EPUB 解压/HTML解析/回写/打包（<200行）
```

**只有 3 个 Python 文件 + 1 个配置文件**，没有框架依赖。

### 3.2 requirements.txt
```
cos-python-sdk-v5>=1.9.30    # 腾讯云 COS SDK
httpx>=0.27                   # HTTP 客户端
beautifulsoup4>=4.12          # HTML 解析
lxml>=5.0                     # BS4 解析器
python-dotenv>=1.0            # .env 配置
```

> **不用 ebooklib** —— EPUB 本质是 ZIP，Java 版的 ZipUtil 逻辑（解压 → 处理 HTML → 重打包）
> 用 Python 标准库 `zipfile` 即可，比引入 ebooklib 更可控。

### 3.3 翻译引擎设计

App 面向用户只提供两个选项：
- **机器翻译** — 免费，无需积分
- **AI翻译** — 消耗积分，支持上下文和术语表

#### 机器翻译：三引擎链式退避

```
Azure Edge Translate (免费 Edge token, 国内直连)
    ↓ 失败/限流
MyMemory (免费 public API, 无需 key, 国内直连)
    ↓ 失败/限流
Google Translate (免费 web API, ⚠️ 国内需 VPN)
```

| 优先级 | 引擎 | 接口 | 限制 | 特点 |
|--------|------|------|------|------|
| 1 | Azure Edge | `edge.microsoft.com/translate/auth` → `api-edge.cognitive.microsofttranslator.com` | Token 过期需刷新 | 批量支持好，国内可用 |
| 2 | MyMemory | `api.mymemory.translated.net/get` | 匿名 1000词/天，提供 email 可提升到 10000词/天 | 稳定兜底，国内可用 |
| 3 | Google | `translate.googleapis.com` | 频率限制，IP 封禁 | 质量最好，**国内需 VPN** |

> **排序说明**: Google 放最后，因为中国大陆无法直接访问，需要 VPN 才能使用。
> Azure Edge 和 MyMemory 在国内均可直连，优先使用。
>
> **关于 Yandex**: 调研后发现 Yandex Translate 已不再提供免费 API，需要 API key 付费使用。
> `yandexfreetranslate` 库是通过爬取网页实现，非常脆弱不稳定，不建议用于生产。

退避逻辑（translators.py 伪代码）：
```python
def translate_machine(texts: list[str], src: str, tgt: str) -> list[str]:
    """机器翻译：三引擎链式退避（国内优先）"""
    engines = [
        ("azure",    _translate_azure),
        ("mymemory", _translate_mymemory),
        ("google",   _translate_google),   # 国内需 VPN
    ]
    for name, engine_fn in engines:
        try:
            result = engine_fn(texts, src, tgt)
            log.info(f"Machine translate OK via {name}")
            return result
        except TranslateError as e:
            log.warning(f"{name} failed: {e}, trying next...")
            continue
    raise TranslateError("All machine translation engines failed")

def translate_ai(texts: list[str], src: str, tgt: str,
                 context: str = None, glossary: dict = None) -> list[str]:
    """AI翻译：调用本地 vLLM HY-MT1.5 chat/completions
       支持上下文(context)和术语表(glossary)"""
    prompt = build_prompt(texts, src, tgt, context, glossary)
    resp = httpx.post(VLLM_URL + "/v1/chat/completions", json={...})
    return parse_response(resp)
```

#### AI翻译：HY-MT1.5 + 上下文 + 术语

只有 AI翻译 支持以下高级功能（在 App 创建任务页展示）：
- **上下文翻译**: 自动将前几段已翻译内容作为 context 传入 prompt，提高连贯性
- **术语表**: 用户上传 JSON 格式术语表（`{"原文": "译文", ...}`），翻译时注入 prompt

### 3.4 Worker 主循环（worker.py）

```python
# 伪代码
while True:
    job_id = poll_cos_queue()
    if not job_id:
        sleep(10); continue

    job = cos_get_json(f"jobs/{job_id}/job.json")
    engine_type = job["engineType"]   # "MACHINE" 或 "AI"
    glossary = load_glossary(job) if engine_type == "AI" else None

    epub_path = cos_download(f"jobs/{job_id}/source/source.epub")
    work_dir = unzip_epub(epub_path)
    html_files = find_html_files(work_dir)

    context_buffer = ""  # AI翻译用，积累上下文
    for i, html_file in enumerate(html_files):
        texts = extract_texts(html_file)
        if engine_type == "AI":
            translated = translate_ai(texts, src, tgt, context_buffer, glossary)
            context_buffer = update_context(context_buffer, texts, translated)
        else:
            translated = translate_machine(texts, src, tgt)
        write_back(html_file, texts, translated, job["output"])
        update_progress(job_id, "TRANSLATING", (i+1)/len(html_files)*100)

    result_epub = zip_epub(work_dir)
    cos_upload(f"jobs/{job_id}/result/{result_name}.epub", result_epub)
    update_progress(job_id, "DONE", 100)
    cos_delete(f"jobs/_queue/pending/{job_id}")
```

### 3.5 Worker 与 SCF 的分工

| 职责 | 谁做 | 说明 |
|------|------|------|
| App API (创建/查询/下载) | SCF | 面向用户，保护 COS 密钥 |
| 积分管理 (余额/扣费/兑换) | SCF | 安全，不暴露给 Worker |
| COS 文件操作 | Worker 直连 | 不再经过 SCF 中转，减少延迟 |
| 任务队列轮询 | Worker 直连 COS | `list_objects("_queue/pending/")` |
| 进度更新 | Worker 直连 COS | `put_object("jobs/{id}/progress.json")` |
| 翻译执行 | Worker | AI翻译(vLLM) + 机器翻译(链式退避) |
| EPUB 处理 | Worker | 解压/解析/回写/打包 |

**Worker 不需要 SCF 的 worker/* API**，直接操作 COS。SCF 可以删掉所有 `/worker/*` 路由，从 760 行精简到 ~400 行。

---

## 四、SCF 网关精简

### 4.1 保留的 API
- `POST /jobs/create` — 创建任务 + 排队 + 预扣积分
- `GET  /jobs/progress` — 查询进度
- `GET  /jobs/download` — 获取结果 presign URL
- `GET  /jobs/list` — 用户任务列表 **（新增）**
- `POST /billing/redeem` — 兑换卡密
- `GET  /billing/balance` — 积分余额

### 4.2 删除的 API
- 所有 `/worker/*` 路由 — Worker 不再需要
- `POST /jobs/markUploaded` — 改为 App 直传 COS 后，由 SCF 在 create 时直接给 presign URL

### 4.3 需要改的
1. **引擎类型改为 `MACHINE` / `AI`**（不再暴露具体引擎名）
2. **`/jobs/create` 返回 presign upload URL**，App 拿到后直接 PUT 上传
3. **新增 `/jobs/list`**：`cos.listObjects({prefix: 'jobs/', delimiter: '/'})`  按 deviceId 过滤
4. **积分扣费改到 create 时**：创建任务时根据 App 传的 `charCount` 预扣（**仅 AI翻译 扣积分**，机器翻译免费）
5. **支持术语表上传**：`/jobs/create` 可附带 glossary JSON，存入 `jobs/{jobId}/glossary.json`

### 4.4 不改的
- COS 操作函数、Ed25519 验签、积分存取 — 全部复用

---

## 五、Flutter App（美观 UI + 完整功能）

### 5.1 设计风格

- **设计语言**: Material 3 + 自定义主题，偏简约现代风
- **主色调**: 渐变蓝紫 (类似翻译类产品常用色调)
- **卡片风格**: 圆角 + 轻微阴影 + 微妙渐变背景
- **动画**: 进度条动画、列表项 stagger 动画、BottomSheet 弹出动画
- **深色模式**: 支持，跟随系统

### 5.2 项目结构（极简 2 页面）

功能简单，**只需 2 个页面** + 弹窗/底部抽屉，不需要独立的详情页和钱包页：

```
lib/
  theme/
    app_theme.dart         # Material3 主题、颜色、文字样式
  models/
    job.dart               # Job / Progress 数据类
  services/
    api_service.dart       # 所有 SCF API 调用
  pages/
    home_page.dart         # 首页：任务列表 + 积分栏（点击卡片展开详情）
    create_job_page.dart   # 创建翻译任务（引擎选择、高级选项）
  widgets/
    job_card.dart          # 任务卡片（含内联进度/下载/详情）
    engine_selector.dart   # 引擎选择器（机器翻译/AI翻译 切换）
    wallet_sheet.dart      # 积分钱包 BottomSheet（购买+兑换）
  main.dart
```

**页面精简思路**:
- ~~任务详情页~~ → 进度/下载直接内联在任务卡片中，点击展开显示详细信息
- ~~积分钱包页~~ → 改为 BottomSheet 弹窗，从首页顶栏 [充值 ▸] 按钮弹出
- 只剩 **首页** 和 **创建任务页** 两个路由

### 5.3 页面设计

#### 首页 (HomePage) — 唯一主页面
```
┌──────────────────────────────────────┐
│  ┌─ 渐变蓝紫顶栏 ──────────────────┐ │
│  │  AirTranslate                    │ │
│  │       🪙 50,000 积分    [充值 ▸]  │ │
│  └──────────────────────────────────┘ │
│   ↑ 点击 [充值] 弹出积分钱包 Sheet     │
│                                       │
│  我的翻译                              │
│                                       │
│  ┌────────────────────────────────┐   │
│  │ 📖 三体                        │   │
│  │ AI翻译 · 英→中 · 双语          │   │
│  │ ▓▓▓▓▓▓▓▓▓▓▓▓▓░░░ 78%          │   │
│  │ 第 12/15 章 · 预计剩余 8 分钟    │   │
│  └────────────────────────────────┘   │
│   ↑ 点击展开查看详情（已用时/速度等）   │
│                                       │
│  ┌────────────────────────────────┐   │
│  │ 📖 Harry Potter               │   │
│  │ 机器翻译 · 英→中 · 纯译文       │   │
│  │ ✅ 翻译完成          [📥 下载]  │   │
│  └────────────────────────────────┘   │
│                                       │
│  ┌────────────────────────────────┐   │
│  │ 📖 Le Petit Prince            │   │
│  │ 机器翻译 · 法→中 · 双语        │   │
│  │ ⏳ 排队中...                    │   │
│  └────────────────────────────────┘   │
│                                       │
│          ┌──────────────────┐         │
│          │  ＋ 新建翻译任务  │         │
│          └──────────────────┘         │
└──────────────────────────────────────┘
```

#### 任务卡片展开态（点击卡片时）
```
┌────────────────────────────────┐
│ 📖 三体                        │
│ AI翻译 · 英→中 · 双语          │
│ ▓▓▓▓▓▓▓▓▓▓▓▓▓░░░ 78%          │
│ ─────────────────────────────  │
│ 📌 第 12 章 / 共 15 章         │
│ ⏱  已用时 23 分钟              │
│ ⏳ 预计剩余 约 8 分钟           │
│ 💰 已消耗 280 积分             │
└────────────────────────────────┘
```

#### 创建任务页 (CreateJobPage) — 唯一二级页
```
┌──────────────────────────────────────┐
│  ← 新建翻译任务                       │
│                                       │
│  ┌────────────────────────────────┐   │
│  │  📎 点击选择书籍文件             │   │
│  │     支持 EPUB 格式              │   │
│  └────────────────────────────────┘   │
│                                       │
│  选择文件后显示:                       │
│  📖 三体.epub  (325,000 字)           │
│                                       │
│  ── 翻译引擎 ──────────────────────   │
│                                       │
│  ┌──────────────┐ ┌──────────────┐   │
│  │  🤖 机器翻译  │ │  🧠 AI翻译   │   │
│  │  免费         │ │  消耗积分     │   │
│  │  速度快       │ │  质量更高     │   │
│  │  适合通读     │ │  支持术语/上下文│  │
│  └──────────────┘ └──────────────┘   │
│   ↑ 两个大卡片，选中高亮带边框         │
│                                       │
│  ── 语言设置 ──────────────────────   │
│  源语言: [自动检测 ▾]                  │
│  目标语言: [简体中文 ▾]               │
│                                       │
│  ── 输出格式 ──────────────────────   │
│  ○ 纯译文    ● 双语对照               │
│                                       │
│  ── AI翻译高级选项 ──── (仅AI翻译显示) │
│  ☑ 启用上下文翻译                     │
│     └ 自动将前文作为上下文，提升连贯性  │
│  ☐ 使用术语表                         │
│     └ [📎 上传术语表 JSON]            │
│       格式: {"原文": "译文", ...}     │
│                                       │
│  ── 费用预估 ──── (仅AI翻译显示) ──   │
│  📊 325,000 字 × 1积分/1000字         │
│  💰 预计消耗: 325 积分                 │
│  🪙 当前余额: 50,000 积分              │
│                                       │
│  ┌────────────────────────────────┐   │
│  │         🚀 开始翻译             │   │
│  └────────────────────────────────┘   │
└──────────────────────────────────────┘
```

#### 积分钱包 BottomSheet（从首页 [充值] 弹出）
```
┌──────────────────────────────────────┐
│  ── 拖拽条 ──                         │
│                                       │
│  🪙  50,000 积分                      │
│                                       │
│  ── 购买积分 ─────────────────────    │
│  ┌──────┐ ┌──────┐ ┌──────┐          │
│  │ 5万  │ │ 10万 │ │ 20万 │          │
│  │ ¥xx  │ │ ¥xx  │ │ ¥xx  │          │
│  └──────┘ └──────┘ └──────┘          │
│  ┌──────┐ ┌──────┐                    │
│  │ 50万 │ │100万 │                    │
│  │ ¥xx  │ │ ¥xx  │                    │
│  └──────┘ └──────┘                    │
│                                       │
│  ── 兑换卡密 ─────────────────────    │
│  ┌────────────────────────┐ ┌────┐   │
│  │ 请输入卡密...           │ │兑换│   │
│  └────────────────────────┘ └────┘   │
│                                       │
│  · AI翻译按字数消耗积分                │
│  · 机器翻译完全免费                    │
│  · 翻译失败自动退还积分               │
└──────────────────────────────────────┘
```

### 5.4 关键依赖
```yaml
dependencies:
  flutter:
    sdk: flutter
  http: ^1.2.0
  file_picker: ^8.0.0
  shared_preferences: ^2.2.0
  crypto: ^3.0.0           # SHA256 设备指纹
  url_launcher: ^6.2.0     # 打开购买链接
  intl: ^0.19.0            # 数字格式化
  google_fonts: ^6.0.0     # 美观字体
  flutter_animate: ^4.5.0  # 列表/进度动画
```

### 5.5 积分系统（完整保留）

**收费逻辑**: 只有 AI翻译 消耗积分，机器翻译免费。

```
购买: App 展示 SKU 卡片 → 打开购买链接(url_launcher) → 用户付款获得卡密
兑换: App 输入卡密 → POST /billing/redeem → SCF 验签 + 加积分 → 返回新余额
扣费: App 创建 AI翻译任务 → POST /jobs/create(含 charCount + engineType=AI)
     → SCF 按 charCount 预扣积分 → 成功后返回 jobId + presign URL
退还: 任务失败 → Worker 写 progress.json(state=FAILED)
     → App 查询进度时 SCF 自动退还积分
```

**积分 SKU（新）**: 你会提供新的 SKU 和购买链接，App 中配置即可。

**App 不做本地验签**，全部由 SCF 处理。比 AirRead 简单得多。

---

## 六、部署方案 (Windows)

### 6.1 磁盘空间预算

| 项目 | 大小 | 说明 |
|------|------|------|
| HY-MT1.5-7B-FP8 模型 | ~8 GB | 一次性下载 |
| vLLM Docker 镜像 | ~10 GB | WSL2 虚拟磁盘 |
| WSL2 虚拟磁盘开销 | ~5 GB | 系统 + 运行时 |
| Python 环境 + 依赖 | ~0.5 GB | 原生 Windows |
| 临时翻译文件 | ~1 GB | 动态，可清理 |
| **总计** | **~25 GB** | 剩余 260GB 完全够用 |

### 6.2 内存预算 (32GB)

| 组件 | 内存 |
|------|------|
| Windows 系统 | ~4 GB |
| WSL2/Docker | ~2 GB |
| vLLM 进程 (CPU 侧) | ~4 GB |
| Python Worker | ~0.5 GB |
| **总计** | **~10.5 GB** |
| 剩余可用 | ~21 GB |

> 32GB 内存非常充裕，没有压力。

### 6.3 组件清单

| 组件 | 运行环境 | 启动方式 |
|------|----------|----------|
| vLLM + HY-MT | WSL2 Docker | `docker start hy-mt` |
| Python Worker | Windows 原生 Python | `python worker.py` |
| SCF (app.js) | 腾讯云 SCF | 控制台部署 |
| COS | 腾讯云 | 已有 |

### 6.4 一键启动脚本

```powershell
# start.ps1 - 放在 AirTranslate 根目录
param([switch]$Stop)

if ($Stop) {
    Write-Host "Stopping services..."
    docker stop hy-mt 2>$null
    Get-Process -Name python -ErrorAction SilentlyContinue | Where-Object {
        $_.CommandLine -like "*worker.py*"
    } | Stop-Process
    Write-Host "Done."
    exit
}

Write-Host "[1/3] Starting vLLM Docker..."
$running = docker inspect -f '{{.State.Running}}' hy-mt 2>$null
if ($running -ne 'true') {
    docker start hy-mt 2>$null
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Container not found, creating..."
        docker run -d --gpus all --shm-size=8g -p 8000:8000 --name hy-mt `
          -v C:\Users\28679\llmModels\HY-MT1.5-7B-FP8:/models/hy-mt `
          vllm/vllm-openai:v0.10.0 `
          --model /models/hy-mt --port 8000 --trust-remote-code `
          --tensor-parallel-size 1 --dtype bfloat16 --kv-cache-dtype fp8 `
          --served-model-name hunyuan --max-model-len 4096 `
          --gpu-memory-utilization 0.85 --host 0.0.0.0
    }
}

Write-Host "[2/3] Waiting for vLLM to be ready..."
$ready = $false
for ($i = 0; $i -lt 60; $i++) {
    try {
        $r = Invoke-WebRequest -Uri http://localhost:8000/health -TimeoutSec 2 -ErrorAction Stop
        if ($r.StatusCode -eq 200) { $ready = $true; break }
    } catch {}
    Start-Sleep -Seconds 5
}
if (-not $ready) { Write-Host "ERROR: vLLM failed to start"; exit 1 }
Write-Host "vLLM is ready."

Write-Host "[3/3] Starting Python Worker..."
Start-Process python -ArgumentList "worker\worker.py" -WorkingDirectory $PSScriptRoot

Write-Host "All services started!"
```

### 6.5 开机自启（可选）

用 Windows 任务计划程序创建任务，触发器选"登录时"，操作运行 `start.ps1`。

---

## 七、开发路线

### Phase 1: 推理服务部署 + 验证（0.5天）
- [ ] 安装 WSL2 + Docker Desktop + NVIDIA Container Toolkit (如果还没有)
- [ ] 下载 HY-MT1.5-7B-FP8 模型
- [ ] Docker 启动 vLLM，curl 验证翻译接口

### Phase 2: Python Worker（2天）
- [ ] `epub_util.py`: 解压/HTML解析/文本提取/翻译回写/重打包
- [ ] `translators.py`: Hunyuan(chat API) / Azure / Google 三个翻译函数
- [ ] `worker.py`: COS 队列轮询 + 任务处理主循环
- [ ] 本地端到端测试：手动放一个 EPUB 到 COS → Worker 处理 → 检查结果

### Phase 3: SCF 精简（0.5天）
- [ ] 删除 /worker/* 路由
- [ ] 修改 /jobs/create 支持多引擎 + 返回 presign URL
- [ ] 新增 /jobs/list
- [ ] 部署到 SCF

### Phase 4: Flutter App（2-3天）
- [ ] 项目搭建 + UI
- [ ] API 对接（创建/上传/进度/下载/积分）
- [ ] 完整流程测试

### Phase 5: 收尾（0.5天）
- [ ] 启动脚本
- [ ] README
- [ ] 打包 APK 测试

**总计预估：5.5-6.5 天**

---

## 八、风险与注意事项

1. **GPU 显存**: FP8 + KV-cache-FP8 在 16GB 上可用，`max-model-len=4096` 不要超过，`gpu-memory-utilization=0.85`
2. **WSL2 Docker**: 首次配置需要启用 BIOS 虚拟化、安装 WSL2、Docker Desktop、NVIDIA Container Toolkit。之后就是 `docker start` 一行命令
3. **COS 一致性**: 积分扣费是 read-modify-write 无锁，极端并发可能超扣。对应措施：SCF 创建任务时做原子检查（余额 >= 消耗 才创建）
4. **免费 API 限流**: Azure/Google 免费接口有频率限制，Worker 需做 sleep + 重试
5. **Java 代码的逻辑迁移**: 原 Java 代码未经测试，迁移到 Python 后需要逐步验证：
   - EPUB 解压/重打包的 mimetype 处理
   - HTML 文本节点提取逻辑（跳过 script/style/code/pre）
   - 双语输出的 HTML 拼接格式
   - Azure token 获取流程
   - Google translate 接口参数
6. **磁盘**: 260GB 剩余，模型+Docker 约 25GB，充足。但注意 WSL2 虚拟磁盘默认在 C 盘，大的话可以迁移到其他盘
