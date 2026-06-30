# AI Desktop 串接設定

Squirl 用**重用 Drive OAuth token** 的方式串接 AI Desktop——不需要任何額外帳號或金鑰。
一次設定，之後每次剪存都自動歸檔、排入知識庫、並在行事曆留痕跡。

## 前置：先完成 Drive 連線

見 [`SETUP-DRIVE.md`](./SETUP-DRIVE.md)。AI Desktop 串接需要 Drive 直傳作為檔案落地點。

## 設定步驟

1. 擴充功能 → ⚙ 設定 → **AI Desktop（知識庫 + 行事曆）** → 開啟「啟用 AI Desktop 串接」。
2. 填入**後端網址**（如 `https://xxx.a.run.app`）→ 按「測試連線」。
   - 第一次會請求該網址的存取權限（optional host permission，僅此網址）。
3. 按「載入資料夾」→ 從下拉選單選一個**已連動 KB 的 Drive 資料夾**；
   或在「＋ 新增資料夾名稱」輸入名稱按「建立」，後端會一步建立 Drive 資料夾 + 對應 KB。
4. （可選）開啟「在行事曆標記剪存時間點」，設定標記事件長度（預設 5 分鐘）。

完成後，每次剪存：**上傳所選資料夾 → 通知後端排入 KB → 行事曆建立標記事件**，全程不需再輸入。

## 後端契約（與 Capyture 共用）

| 端點 | 方法 | 認證 | 用途 |
|------|------|------|------|
| `/api/extension/health` | GET | — | 回 `{ ok: true, service: "ai-desktop" }` |
| `/api/extension/linked-folders` | GET | `X-Gdrive-Token` | 回 `{ email, folders: [{ kb_id, kb_name, folder_id, folder_name }] }` |
| `/api/extension/folders` | POST `{ name }` | `X-Gdrive-Token` | 建立 Drive 資料夾 + KB，回單一 folder |
| `/api/extension/ingest` | POST | `X-Gdrive-Token` | 排入 KB（+ 行事曆標記） |

### ingest 請求（Squirl 擴充欄位，向後相容）

```jsonc
{
  "file_id": "...", "file_name": "標題.md", "folder_id": "...",
  "mime_type": "text/markdown",
  "source_type": "web_clip",          // web_clip | youtube_clip（Capyture 用 recording）
  "source_url": "https://...",        // 去重 / 回連
  "clipped_at": "2026-06-22T08:00:00Z",
  "calendar": { "mark": true, "duration_min": 5, "title_hint": "📎 Squirl 剪存：標題", "kind": "clip_marker" },
  "transcribe": { "request": true, "reason": "captions_blocked", "langs": ["zh-Hant", "en"] },
  "attachments": [ { "file_id": "...", "role": "subtitle" }, { "file_id": "...", "role": "sidecar" } ]
}
```

回應：`{ "status": "queued" | "duplicate", "kb_name": "...", "event_id": "..." | null }`

### 後端待辦（若尚未支援）

- 讀取 `source_type` / `source_url`（去重以 `source_url` 為鍵）。
- `calendar.kind === "clip_marker"` 時建立一個 `duration_min` 分鐘的小事件（建議獨立行事曆 / 顏色，方便 filter「會議 / 請假 / 剪存」）。**建事件需獨立 try/catch——失敗不可影響 KB ingest。**
- `transcribe.request === true` 時，從 `source_url` 伺服器端取音訊轉逐字稿併入 KB（`reason` 區分「字幕被鎖」或「使用者要逐字稿」，`langs` 為偏好語言）。**轉錄需獨立非同步處理——失敗或耗時不可阻擋 KB ingest。** 欄位缺省／舊後端忽略即可。
- ingest 失敗時，資料夾同步（folder sync）需能自動補處理已落在 Drive 的檔案。

## 容錯保證（extension 端）

- 檔案先落 Drive 才算剪存成功；ingest 與行事曆是事後可補的附加動作。
- 所有對外呼叫帶 10 秒 timeout；Drive token 過期自動刷新。
- AI Desktop 不可達時只記 log 並照常通知「已存到 Drive」，不打斷使用者。
