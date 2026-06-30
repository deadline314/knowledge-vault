# Squirl — 架構設計稿

> 版本：v0.1（2026-06-22）
> 定位：**Capyture 的姊妹作**。Capyture 負責「錄會議」，Squirl 負責「剪存網頁／YouTube 內容」。
> 兩者共用同一條 AI Desktop 串接契約：**檔案先落 Drive → 通知後端排入知識庫（KB）→ 行事曆留下時間痕跡**。
> 目標瀏覽器：Chrome（Manifest V3）優先，架構保留 Firefox / Edge 擴充空間。

---

## 0. 命名與品牌

| 項目 | 內容 |
|------|------|
| 名稱 | **Squirl**（取自 squirrel，松鼠） |
| 與 Capyture 的聯繫 | 水豚是「最大的囓齒類」，松鼠是牠的小表親——**同科不同種**，有聯繫但不是另一隻 capy |
| 名稱寓意 | 松鼠會「squirrel away」：先把橡實藏起來，日後再取用＝**先剪存、之後靠 AI 檢索**，正對應 Daniel 說的「沉澱 + 檢索」 |
| 配對語句 | *Capyture records meetings, Squirl stashes the web.* |
| 吉祥物 | 抱著橡實的松鼠（橡實＝會長成知識「橡樹」的種子，呼應 Daniel「填完肉之後能再長出新東西」的飛輪） |
| 備選名 | Pika（高山囤糧的鼠兔）、Packrat（什麼都收的林鼠） |

---

## 1. 設計目標與原則

| 目標 | 對應策略 |
|------|----------|
| 成本最小化 | 零自有後端（除既有的 AI Desktop）；擷取／解析／匯出全在瀏覽器內完成 |
| 順手（Daniel 核心訴求） | **右鍵一鍵剪存**，預設無腦：選好預設格式與目的地後，按下去就好，不打斷瀏覽 |
| 記憶體平坦 | 解析以串流／分段處理，匯出用 Blob 串流交給 Drive resumable，避免整檔常駐記憶體 |
| 高容錯 | 每一步都有獨立回收路徑；**檔案先落 Drive 才是事實源**，KB / 行事曆是事後可補的附加動作 |
| 可維護 / 可擴充 | 分層架構、介面導向、typed message protocol；新增「內容來源」或「匯出格式」或「儲存目的地」都只補一個實作 |
| 與 Capyture 一致 | 沿用相同的 shared / core 分層、錯誤碼、logger、secrets、settings、Drive、AI Desktop 契約，最大化程式碼共用 |
| 動態網頁支援 | 在 **content script** 內讀 live DOM（已被 JS 渲染後的結果），不靠靜態 HTML 抓取 |

### 非目標（v1 不做）
- **YouTube 影片本體下載**（解析度／檔案大小選擇）→ 已抽象預留，列入 TODO 後期（見 §7.3、§13）。
- 站內登入牆後的內容自動破解、整站爬取、排程批次匯入。

---

## 2. 技術選型

| 項目 | 選擇 | 理由 |
|------|------|------|
| 建置框架 | **WXT** (^0.20) | 與 Capyture 一致；跨瀏覽器建置、MV3 友善、bundle 最小 |
| UI（設定／彈窗） | **Svelte 5** + TypeScript | runtime 極小、編譯期響應式 |
| 內容擷取執行環境 | **Content Script**（注入目標分頁） | 唯一能讀「JS 動態渲染後 live DOM」的環境 |
| 協調 / 權限 / 網路 | **Background Service Worker** | context menu、Drive OAuth、跨網域 fetch、通知 |
| PDF 產生 | **Offscreen document** + `pdf-lib` + 內嵌中文字型（subset） | 見 §7.4；pdf-lib 太重不能放 SW，offscreen 按需建立 |
| 雲端儲存 | Google Drive **resumable upload** + `chrome.identity` | 直接沿用 Capyture 的 `DriveClient`／`DriveAuth` |
| 機密存放 | WebCrypto AES-GCM（`shared/secrets.ts`） | 沿用 Capyture，client ID 不以明文落地 |
| 設定持久化 | `chrome.storage.local` + schema 版本化 + 預設值合併 | 沿用 Capyture `settings.ts` 模式 |

> **與 Capyture 的差異**：Capyture 重活在 *offscreen document*（長時間持有 MediaStream）；Squirl 重活在 *content script*（讀 DOM）。其餘 shared / Drive / AI Desktop 層幾乎相同。

---

## 3. 高層架構與資料流

```
        ┌───────────── 使用者在任意網頁按右鍵 ─────────────┐
        │              「Squirl：剪存到 Google Drive ▸」     │
        └───────────────────────┬──────────────────────────┘
                                 │ contextMenus.onClicked(format, options)
                                 ▼
┌──────────────────────────── Background (Service Worker) ───────────────────────────┐
│  ContextMenuController   ── 建立／路由選單                                            │
│  ClipOrchestrator        ── 串起整條流程的狀態機                                      │
│        │                                                                            │
│        │ 1. 注入並請求 content script 擷取                                            │
│        ▼                                                                            │
│   ┌────────────────── Content Script（目標分頁內）──────────────────┐                │
│   │  SourceRouter：依 URL 判斷來源                                  │                │
│   │   ├─ YouTubeExtractor  → { url, title, channel, captions[], chapters[] }        │
│   │   └─ WebpageExtractor  → 階層式 ContentTree（heading/段落/list/表格/code/圖片）  │
│   │  （讀 live DOM；可選等待動態內容穩定後再擷取）                  │                │
│   └───────────────────────────┬─────────────────────────────────┘                │
│        │ CaptureResult（結構化、未綁定格式）                                          │
│        ▼ 2. 匯出                                                                     │
│   ┌─ Exporter（可插拔）─────────────────────────────────────────┐                   │
│   │  MarkdownExporter / TextExporter / PdfExporter / SubtitleExporter│               │
│   └───────────────────────────┬─────────────────────────────────┘                  │
│        │ Blob（一或多個檔案：主檔 + sidecar .meta.json + 字幕）                       │
│        ▼ 3. 儲存                                                                     │
│   ┌─ StorageTarget（可插拔）──────────────────────────────────┐                     │
│   │  DriveTarget（resumable 直傳）  /  LocalDownloadTarget       │                   │
│   └───────────────────────────┬─────────────────────────────┘                      │
│        │ { fileId, folderId, webViewLink }                                           │
│        ▼ 4. 通知 AI Desktop（best-effort，不阻擋）                                    │
│   ┌─ AiDesktopClient ─────────────────────────────────────────┐                     │
│   │  notifyIngest()  → KB 排程轉錄/索引                          │                   │
│   │  （後端據 clippedAt 建立 ~5 分鐘行事曆標記事件）             │                    │
│   └───────────────────────────────────────────────────────────┘                    │
│        ▼ 5. 通知使用者（notifications：成功＋「在 Drive 開啟」連結／失敗原因）         │
└─────────────────────────────────────────────────────────────────────────────────┘
```

**關鍵分工**：content script 只「擷取結構化資料」；background 負責「格式化、存檔、串接、通知」。
**事實源原則**：第 3 步（檔案落地）成功＝任務成功；第 4 步（KB／行事曆）失敗只記 log、可補，不回報為失敗。

---

## 4. 模組分層與目錄結構

```
src/
├── entrypoints/                     # WXT 入口（薄殼，只做組裝）
│   ├── background.ts                # 選單註冊、訊息路由、ClipOrchestrator 宿主
│   ├── content/
│   │   └── index.ts                 # content script：SourceRouter + 擷取器組裝
│   ├── popup/                       # 點圖示的迷你面板（快速剪存 + 狀態）
│   │   ├── index.html / main.ts / App.svelte
│   └── options/                     # 設定頁（格式、Drive、AI Desktop、YouTube）
│       ├── index.html / main.ts / App.svelte
│
├── core/                            # 純邏輯，不依賴 UI，可單元測試
│   ├── capture/
│   │   ├── ContentSource.ts         # interface：擷取器抽象 + 型別 (CaptureResult, ContentNode…)
│   │   ├── SourceRouter.ts          # 依 URL 選擇擷取器（可註冊新來源）
│   │   ├── WebpageExtractor.ts      # live DOM → 階層式 ContentTree（含表格）
│   │   ├── dom/
│   │   │   ├── readability.ts       # 主內容偵測（去導覽/廣告/側欄）
│   │   │   ├── blockify.ts          # DOM → 結構化區塊（heading/list/table/code/quote/img）
│   │   │   └── settle.ts            # 等待動態內容穩定（MutationObserver + 逾時保底）
│   │   └── youtube/
│   │       ├── YouTubeExtractor.ts  # URL + metadata + 章節
│   │       ├── captions.ts          # 字幕清單擷取與下載（timedtext / player response）
│   │       └── VideoDownloader.ts   # ⚠ v2：介面 + NotImplemented stub（見 §7.3）
│   │
│   ├── export/
│   │   ├── Exporter.ts              # interface：CaptureResult → Blob[]
│   │   ├── MarkdownExporter.ts      # ContentTree → 階層式 Markdown（表格保留）
│   │   ├── TextExporter.ts          # ContentTree → 純文字（縮排表達階層）
│   │   ├── PdfExporter.ts           # 可抽換 PDF 策略（見 §7.4）
│   │   ├── SubtitleExporter.ts      # 字幕 → .srt / .vtt
│   │   └── sidecar.ts               # 產生 .meta.json（schema：squirl/clip-meta@1）
│   │
│   ├── storage/
│   │   ├── StorageTarget.ts         # interface：put(blob, name, meta) → ref
│   │   ├── DriveTarget.ts           # 包裝 DriveClient（沿用 Capyture）
│   │   ├── LocalDownloadTarget.ts   # chrome.downloads 後備
│   │   └── drive/DriveClient.ts     # ← 直接沿用 Capyture（resumable + 斷點續傳）
│   │
│   ├── auth/
│   │   ├── DriveAuth.ts             # ← 沿用 Capyture
│   │   └── ChromeIdentityAuth.ts    # ← 沿用 Capyture
│   │
│   ├── aidesktop/
│   │   └── AiDesktopClient.ts       # health / linked-folders / folders / ingest（KB + 行事曆）
│   │
│   └── orchestrator/
│       ├── ClipOrchestrator.ts      # 擷取→匯出→存檔→通知 的狀態機（容錯核心）
│       └── ClipJob.ts               # 單次剪存的不可變描述 + 進度模型
│
├── messaging/
│   ├── protocol.ts                  # 跨 context 訊息 discriminated union
│   └── bus.ts                       # 型別安全收發（帶 timeout）
│
└── shared/
    ├── settings.ts                  # 設定 schema + 預設值 + migration（沿用模式）
    ├── secrets.ts                   # ← 沿用 Capyture（AES-GCM）
    ├── errors.ts                    # 統一錯誤碼（擴充 clipper 專屬碼）
    ├── logger.ts                    # ← 沿用 Capyture
    └── i18n.ts                      # zh-TW / en
```

依賴方向（單向）：`entrypoints → core / messaging / shared`。`core` 不 import 任何 entrypoint 或 UI；瀏覽器專屬 API 只出現在實作層。

---

## 5. 核心抽象介面

新增**內容來源**、**匯出格式**、**儲存目的地**三個維度，各自獨立可插拔——這是擴充性的關鍵。

```ts
// core/capture/ContentSource.ts ── 內容來源擴充點（YouTube / 一般網頁 / 未來 PDF 線上檢視…）
export type SourceKind = 'youtube' | 'webpage';

export interface ContentNode {            // 階層式內容樹的節點
  type: 'heading' | 'paragraph' | 'list' | 'listitem' | 'table'
      | 'code' | 'quote' | 'image' | 'link' | 'divider' | 'section';
  level?: number;                          // heading 階層 (1–6)；section 巢狀深度
  text?: string;
  ordered?: boolean;                       // list
  rows?: string[][];                       // table（含表頭列）
  src?: string; alt?: string;              // image
  href?: string;                           // link
  children?: ContentNode[];                // 巢狀（section / list）
}

export interface CaptureResult {
  kind: SourceKind;
  url: string;
  title: string;
  capturedAt: string;                      // ISO，UTC
  lang?: string;
  byline?: string;                         // 作者／頻道
  excerpt?: string;
  tree: ContentNode[];                     // 階層式內容（一般網頁主體）
  youtube?: {                              // kind==='youtube' 時
    videoId: string;
    channel?: string;
    durationSec?: number;
    chapters?: { title: string; startSec: number }[];
    captions: CaptionTrack[];              // 可用字幕軌（含已下載文本）
    video?: VideoVariantInfo[];            // ⚠ v2 預留：可下載的畫質/檔案大小清單
  };
  warnings?: string[];                     // 降級提示（例如「動態內容可能未完整」）
}

export interface ContentSource {
  readonly kind: SourceKind;
  matches(url: string): boolean;
  capture(opts: CaptureOptions): Promise<CaptureResult>;
}

// core/export/Exporter.ts ── 匯出格式擴充點
export type ExportFormat = 'md' | 'txt' | 'pdf' | 'srt' | 'vtt';
export interface ExportArtifact { blob: Blob; fileName: string; mimeType: string; role: 'primary' | 'subtitle' | 'sidecar'; }
export interface Exporter {
  readonly format: ExportFormat;
  supports(result: CaptureResult): boolean;
  export(result: CaptureResult, opts: ExportOptions): Promise<ExportArtifact[]>;
}

// core/storage/StorageTarget.ts ── 儲存目的地擴充點
export interface StoredRef { id: string; folderId: string; webViewLink: string | null; }
export interface StorageTarget {
  readonly id: 'drive' | 'local';
  put(artifact: ExportArtifact, ctx: PutContext, onProgress?: (f: number) => void): Promise<StoredRef>;
}
```

> **擴充示例**：要支援 Podcast 頁面 → 補一個 `PodcastExtractor implements ContentSource`，在 `SourceRouter` 註冊即可，匯出與儲存層完全不動。要支援 Notion 匯出 → 補一個 `NotionExporter`。要支援 Dropbox → 補一個 `StorageTarget`。

---

## 6. 右鍵選單設計（順手優先）

Daniel 的原則：**第一版越無腦越好，進階藏起來**。對應到選單：

```
右鍵 ▸ Squirl：剪存到 Google Drive            ← 主動作：用「預設格式 + 預設目的地」一鍵完成
右鍵 ▸ Squirl：剪存為… ▸                       ← 次選單（進階；想換格式時才展開）
        ├ Markdown (.md)
        ├ 純文字 (.txt)
        ├ PDF (.pdf)
        └ （YouTube 頁額外出現）字幕 (.srt) ／ 含字幕打包
```

- 主動作文字與預設格式由設定頁決定（預設 Markdown）。
- 選單 `contexts: ['page', 'selection', 'video', 'link']`：
  - 一般頁：剪存整頁主內容；
  - 有反白選取：只剪存選取範圍（`info.selectionText` + 對應 DOM 範圍）；
  - YouTube 頁：自動走 YouTube 流程（URL + 字幕 + metadata）。
- 點圖示的 popup 提供：最近剪存清單、目前頁可剪存的提示、一鍵重試上次失敗項。

---

## 7. 內容處理細節

### 7.1 一般網頁：階層式正確解析
目標：輸出能忠實反映原文「結構」的內容樹，而非攤平的純文字。

1. **主內容偵測（readability）**：移除 `nav / header / footer / aside / script / style / 廣告容器`，用文字密度 + 標籤語意挑出主文容器。失敗時退回 `document.body`（容錯：寧可多抓不要全空）。
2. **區塊化（blockify）**：遞迴走訪主文容器，將 DOM 映射為 `ContentNode`：
   - `h1–h6` → `heading`（保留 level，建立章節階層）；
   - `p` / 文字節點 → `paragraph`；
   - `ul/ol` → `list`（保留 ordered、巢狀 listitem）；
   - `table` → `table`（**逐列逐格擷取，保留表頭**，合併儲存格以重複值展開）；
   - `pre/code` → `code`（保留語言 class）；`blockquote` → `quote`；
   - `img` → `image`（絕對化 src、保留 alt）；具語意的 `figure/figcaption` 一併處理。
3. **階層重建**：以 heading level 把扁平區塊組成巢狀 `section` 樹，讓 Markdown / 純文字能正確縮排呈現大綱。
4. **動態內容（settle）**：擷取前用 `MutationObserver` 觀察主文容器，連續 N ms（預設 600ms）無新增變動視為穩定；最長等待上限（預設 4s）保底，逾時就用當下狀態（容錯：不無限等待）。可選「捲動到底觸發 lazy-load」策略（進階）。

### 7.2 YouTube：URL + 字幕 + metadata（v1 範圍）
1. **基本**：videoId、標題、頻道、時長、章節（從描述或章節列）、縮圖。
2. **字幕**：
   - 來源優先序：頁面 `ytInitialPlayerResponse.captions` → `timedtext` API；
   - 列出所有語言軌（含自動產生 ASR），預設抓「使用者介面語言」與「原片語言」，可在設定選偏好語言清單；
   - 下載後轉 `.srt` / `.vtt`（`SubtitleExporter`）；同時把純文字字幕併入 sidecar 供 KB 直接索引。
3. **容錯**：無字幕／被關閉時，仍正常存 URL + metadata，`warnings` 標註「無可用字幕」。

### 7.3 YouTube 影片下載（⚠ v2 — 設計預留，v1 不實作）
- 介面 `VideoDownloader` 與型別 `VideoVariantInfo { itag, quality, container, sizeBytes?, hasAudio, hasVideo }` 先定義好，`CaptureResult.youtube.video` 欄位保留。
- v1 實作為 `NotImplementedVideoDownloader`：呼叫即丟 `AppError('NOT_IMPLEMENTED')`，UI 對應顯示「即將推出」。
- **為何延後**：YouTube 走 DASH，畫面與聲音是**分離串流**，下載需解析 `player response`、處理可能的簽章/節流參數、再用 `mux`（如 ffmpeg.wasm）把音訊與視訊合併——記憶體與複雜度高，且涉 ToS 風險。先讓 v1 用「URL + 字幕」順手上線（Daniel 節奏）。
- v2 落地時，畫質／檔案大小選單直接讀 `video[]`；合併走可選的 `ffmpeg.wasm`（lazy-load，僅在使用者要下載影片時才載入，平時零記憶體成本）。

### 7.4 PDF 匯出（offscreen + 內嵌中文字型）
PDF 由 `ContentTree` 用 `pdf-lib` 自行排版，**在 offscreen document 執行**（不在 service worker）：
- **為何放 offscreen**：pdf-lib 體積大、需要完整 document 環境；放進 service worker 會讓 SW 過大而**註冊失敗**（status 15）。offscreen 只在要產 PDF 時由 background 建立（`chrome.offscreen.createDocument`，reason `BLOBS`），用完保留以重用字型快取。
- **中文支援**：bundle 一份 `NotoSansCJK-subset.ttf`（Latin + 常用漢字 + 注音 + 全形/標點），`embedFont(bytes, { subset: true })` 只嵌入實際用到的字 → 中文正常顯示、檔案不致過大。
- **換行**：CJK 逐字可斷、英文單字不切斷（見 `core/export/pdfRender.ts` 的 `tokenize`/`wrap`）。
- **流程**：`ClipOrchestrator.#exportAll` 偵測 `format==='pdf'` → `renderPdfViaOffscreen()`（`core/export/offscreenPdf.ts` 負責 offscreen 生命週期 + base64 傳遞）→ 失敗自動退 Markdown 保底（保證「至少存得到」）。
- **不再使用 `chrome.debugger`**（Chrome 對其 optional 化有警告，且 attach 會在分頁頂端顯示提示列）。

### 7.5 Sidecar：`squirl/clip-meta@1`
每次剪存附一個 `.meta.json`，作為 AI Desktop 的結構化交接：
```jsonc
{
  "schema": "squirl/clip-meta@1",
  "kind": "webpage | youtube",
  "url": "...", "title": "...", "byline": "...",
  "capturedAt": "2026-06-22T08:00:00Z",
  "format": "md",                  // 主檔格式
  "files": { "primary": "標題.md", "subtitle": "標題.zh.srt", "sidecar": "標題.meta.json" },
  "youtube": { "videoId": "...", "channel": "...", "durationSec": 0, "captionLangs": ["zh","en"] },
  "tags": [], "project": null,     // 可由 popup 在剪存時補
  "source": "squirl", "version": "0.1.0"
}
```

---

## 8. AI Desktop 串接（KB + 行事曆）

完全沿用 Capyture 的契約與容錯哲學，只擴充 ingest 的內容型別與行事曆語意。

### 8.1 端點契約（與 Capyture 共用、向後相容）
| 端點 | 方法 | 認證 | 用途 |
|------|------|------|------|
| `/api/extension/health` | GET | — | 確認網址指向 AI Desktop（回 `{ok:true,service:"ai-desktop"}`）|
| `/api/extension/linked-folders` | GET | `X-Gdrive-Token` | 取「已連動 KB 的 Drive 資料夾」清單（設定頁下拉來源）|
| `/api/extension/folders` | POST `{name}` | `X-Gdrive-Token` | 一步建立 Drive 資料夾＋對應 KB |
| `/api/extension/ingest` | POST | `X-Gdrive-Token` | **通知排入 KB**；新增 `source_type` 與行事曆語意 |

### 8.2 ingest 請求（擴充欄位）
```jsonc
POST /api/extension/ingest
{
  "file_id": "<Drive fileId>",
  "file_name": "標題.md",
  "folder_id": "<Drive folderId>",
  "mime_type": "text/markdown",
  "source_type": "web_clip",          // 新增：web_clip | youtube_clip（Capyture 用 recording）
  "source_url": "https://...",        // 新增：原始網址（KB 可回連、去重）
  "clipped_at": "2026-06-22T08:00:00Z",
  "calendar": {                        // 新增：行事曆標記指令（可選；後端據此建小事件）
    "mark": true,
    "duration_min": 5,                 // 預設 5 分鐘的「剪存痕跡」事件
    "title_hint": "📎 Squirl 剪存：標題",
    "kind": "clip_marker"
  },
  "transcribe": {                      // 新增（可選）：請後端從 source_url 伺服器端轉錄逐字稿
    "request": true,
    "reason": "captions_blocked",      // captions_blocked（要字幕但抓不到）| user_requested（使用者下載了影片）
    "langs": ["zh-Hant", "en"]         // 偏好語言（轉錄/翻譯參考）
  },
  "attachments": [                     // 可選：字幕/sidecar 也已上傳同資料夾
    { "file_id": "...", "role": "subtitle" }
  ]
}
```
回應沿用 `IngestOutcome { status: 'queued'|'duplicate', kb_name, event_id, matched }`。

**transcribe 觸發條件**（擴充端 `ClipOrchestrator.#planTranscription`）：來源是 YouTube、使用者要內容（勾字幕或下載影片）、且擴充端**沒能取到字幕純文字**時才送。字幕已成功取得就不重複轉錄。後端用 `source_url` 取音訊轉逐字稿併入 KB；欄位缺省或舊後端忽略不影響既有流程。

### 8.3 處理流程（高容錯，明確分段）
```
[擷取成功]
   └─► 匯出 Blob ──► DriveTarget.put 主檔  ──成功──► （並行）put 字幕 + sidecar
                          │失敗                                  │（字幕/sidecar 失敗只記 log，不影響主檔）
                          ▼                                       ▼
                 退 LocalDownloadTarget                 notifyIngest()  ← best-effort，10s timeout
                 （本機留存，標記「待補上傳」）          │成功                    │失敗/逾時
                                                        ▼                        ▼
                                              後端：排入 KB + 建行事曆標記   只記 log（後端資料夾
                                                        │行事曆失敗            sync 會自動補處理）
                                                        ▼
                                              不影響 KB（兩動作各自 try）
   └─► 一律 notifications 回報結果（成功附「在 Drive 開啟」連結；失敗附原因＋重試）
```

**鐵則**（與 Capyture 一致）：
1. **檔案落 Drive ＝ 任務成功**；ingest 只是「請後端早點處理」，失敗有資料夾同步保底。
2. **行事曆是 ingest 內的子動作**，後端對「建事件」獨立 try/catch——行事曆掛了不擋 KB。
3. 所有對外 fetch 帶 timeout；token 過期 401 → 靜默刷新一次。
4. host permission 採 optional，使用者在設定頁按「連線」時才針對該網址請求一次。

### 8.4 行事曆語意
- 內容剪存不是「一段時間的會議」，而是「某個時間點發生的動作」→ 後端建立一個 **預設 5 分鐘**的小事件（`clip_marker`），標題帶來源與標題，描述放 `source_url` 與 KB 連結。
- 設定頁可關閉「行事曆標記」（只進 KB）。可選用獨立行事曆／顏色，方便 Daniel 用 filter 區分「會議／請假／剪存」。

---

## 9. 記憶體管理策略

1. 內容樹是輕量 JSON；大頁面以「主內容容器」為界，不序列化整個 DOM。
2. 匯出產生的 Blob 直接交給 `DriveClient.uploadResumable`，以 `Blob.slice()` 分段（8MB）串流上傳，不整檔讀進記憶體。
3. 字幕、sidecar 屬小檔，走 multipart 一次上傳。
4. `ffmpeg.wasm`（v2 影片合併）採 **lazy import**：只有使用者真的要下載影片時才載入，平時零成本。
5. content script 擷取後即把結構化結果回傳 background 並釋放 DOM 參照，不長期持有。
6. 嚴格 dispose：MutationObserver disconnect、debugger detach、URL.revokeObjectURL，集中於 job teardown。

---

## 10. 容錯設計（故障情境對照表）

| 情境 | 偵測 | 處理 |
|------|------|------|
| 受限頁面（chrome://、商店）| 注入 content script 失敗 | 明確提示「此頁面不支援剪存」，不留半成品 |
| 動態內容尚未載完 | settle 逾時 | 用當下 DOM 擷取，`warnings` 提示「可能未完整」，仍正常存檔 |
| 主內容偵測失敗 | 偵測結果過短／為空 | 退回 `body` 全頁擷取（寧可雜不要空）|
| 選取範圍跨多容器 | range 解析 | 退回擷取整頁，warning 提示 |
| YouTube 無字幕 | captions 空 | 存 URL + metadata，warning 提示 |
| YouTube 版面改版 | player response 解析失敗 | 退回只存 URL + 頁面可見 metadata |
| PDF 產生失敗 | offscreen `renderPdf` reject／字型載入失敗 | 自動退 Markdown（保證落地），記 log |
| Drive 未設定／未連線 | DriveAuth mode==='none' | 退本機下載，提示「去設定連線 Drive」 |
| Drive 上傳中斷 | 5xx／斷網 | resumable 查 offset 斷點續傳，指數退避 max 5；最終失敗退本機留存 |
| OAuth token 過期 | 401 | 靜默刷新一次；失敗才跳互動 |
| AI Desktop 不可達 | health／ingest timeout | 檔案已在 Drive，只記 log；後端資料夾同步補處理 |
| 行事曆建立失敗 | 後端子動作錯 | 不影響 KB ingest（後端各自 try）|
| 重複剪存同網址 | 後端以 source_url 去重 | 回 `duplicate`，UI 顯示「已存在，已略過」|
| 連點右鍵多次 | orchestrator 單一 job 鎖（per url+format）| 後到的忽略或排隊，不重複上傳 |
| service worker 被回收 | 喚醒讀 `storage.session` 快照 | 進行中的 job 標記為可重試，popup 顯示重試 |
| 訊息逾時 | bus 帶 timeout | 不永久 pending，走錯誤路徑回報 |

**救援原則**：任何失敗都「先保資料、再報錯」。能落 Drive 就落 Drive，落不了就落本機，最後才回報失敗並提供重試。

---

## 11. 權限（manifest）

```jsonc
permissions: [
  "contextMenus",     // 右鍵選單
  "scripting",        // 動態注入 content script
  "activeTab",        // 取得當前分頁授權（配合使用者點擊）
  "downloads",        // 本機後備
  "storage",          // 設定
  "identity",         // Drive OAuth
  "identity.email",   // 顯示帳號
  "notifications",    // 結果通知
  "offscreen"         // PDF 產生（pdf-lib + 內嵌中文字型，太重不能放 SW）
],
optional_host_permissions: [ "https://*/*", "http://*/*" ],  // AI Desktop 後端網址，連線時才請求
host_permissions: [ ]                            // 內容擷取走 activeTab + scripting，不需常駐全網域
```
原則：**最小權限**。Drive scope 只用 `drive.file`（僅能存取自己建立的檔案）。AI Desktop host 延後到使用者啟用時才請求。`offscreen` 為靜態權限（產 PDF 必需），但 offscreen document 僅在實際要產 PDF 時才建立。

---

## 12. 與 Capyture 的程式碼共用

| 直接沿用（幾乎不改） | 調整沿用 | 全新 |
|----------------------|----------|------|
| `shared/secrets.ts`、`shared/logger.ts` | `shared/errors.ts`（加 clipper 錯誤碼）| `core/capture/*`（網頁/YouTube 擷取）|
| `core/auth/DriveAuth.ts`、`ChromeIdentityAuth.ts` | `shared/settings.ts`（改 schema）| `core/export/*`（MD/Text/PDF/字幕）|
| `core/storage/drive/DriveClient.ts` | `core/aidesktop/AiDesktopClient.ts`（擴充 ingest）| `core/orchestrator/*`、`SourceRouter` |
| `drive.config.ts` | `messaging/protocol.ts`（改訊息）| context menu / content script |

> 共用方式：v1 以**複製＋調整**落地（避免跨 repo 相依造成建置耦合）；待兩個擴充功能穩定後，可抽出 `@bsos/web-ext-core` 私有套件統一維護。

---

## 13. 建議加入的額外功能（§6 之外）

Daniel 的飛輪是「**順手把有價值的東西一直往 KB 丟，AI 越懂公司越有價值**」。以下依此排序：

1. **選取片段剪存**（已納入 §6）：只存反白段落，最常見的「順手」場景。
2. **剪存時補 tag / project**（popup 一個輕量輸入框）：對應 Capyture 的會議 tag／project，讓 KB 可依專案檢索；預設可空，不打斷。
3. **自動去重**：以 `source_url` 為鍵，後端回 `duplicate` 時提示，避免 KB 長一堆重複。
4. **批次剪存目前視窗所有分頁**（進階）：研究時一次收一整批。
5. **PDF/線上文件頁**的辨識與處理（線上 PDF viewer → 直接存原始 PDF 到 Drive）。
6. **「稍後讀」佇列**：剪存時可標記 read-later，KB 端做成一個清單視圖。
7. **快捷鍵**（`chrome.commands`）：`Alt+Shift+S` 一鍵剪存目前頁，全鍵盤流。
8. **剪存歷史與重試中心**（popup）：列最近 N 筆、失敗可一鍵重試（呼應容錯）。
9. **語言偏好的字幕自動翻譯佔位**：v1 只存原文字幕；翻譯交給 KB 端 AI（不在 extension 做，保持輕量）。
10. **隱私白／黑名單**：某些網域（銀行、內部系統）預設不出現在選單，避免誤存敏感頁。

---

## 14. 里程碑總覽（細節見 TODO.md）

| 里程碑 | 內容 | 對應 Daniel 節奏 |
|--------|------|------------------|
| M0 | 專案骨架、shared/Drive/AI Desktop 共用層落地 | 地基 |
| M1 | 右鍵一鍵剪存「一般網頁 → Markdown → 本機」最小可用 | 先讓他用 |
| M2 | Drive 直傳 + AI Desktop ingest（KB）+ sidecar | 串起來、沉澱 |
| M3 | YouTube（URL + 字幕 + metadata）+ 字幕匯出 | 素材導入 |
| M4 | PDF / Text 匯出、選取片段、tag/project、行事曆標記 | 開始被嫌、加東西 |
| M5 | 設定頁完善、快捷鍵、歷史/重試中心、隱私名單 | 打磨 |
| M6（後期）| **YouTube 影片下載**（畫質/檔案大小、ffmpeg.wasm 合併）| 等被嫌再做 |

---

## 15. 開放問題（待後端／Daniel 確認）

1. AI Desktop ingest 是否已支援 `source_type=web_clip` 與 `calendar.kind=clip_marker`？若否，需後端補（extension 端已向後相容：欄位多帶不會壞舊後端）。
2. 行事曆標記是否要獨立行事曆／顏色（方便 filter「會議／請假／剪存」）？
3. KB 去重鍵以 `source_url` 還是 `url + capturedAt`？
4. 公司 Drive 歸檔資料夾的權限模型（沿用 Capyture 的 `drive.file` + 連動資料夾即可）。
