# Squirl 🐿️

> **Capyture 的姊妹作。** Capyture 錄會議，Squirl 剪存網頁。
> 右鍵一鍵把任何網頁 / YouTube 內容剪存到 Google Drive，並餵進 AI Desktop 知識庫（KB），
> 同時在行事曆留下時間痕跡。

松鼠把橡實藏起來、日後再取用——Squirl 把網路上有價值的東西順手收進你的「第二大腦」，
之後靠 AI Desktop 檢索。名稱與 Capyture 同屬囓齒家族（水豚是最大的囓齒類，松鼠是牠的小表親），
有聯繫但不是另一隻 capy。

## 功能（v1）

- **右鍵剪存**：任意網頁、YouTube 頁，支援 JS 動態渲染後的內容。
- **網頁**：階層式正確解析（標題層級、段落、清單、**表格**、程式碼、引言、圖片），可匯出 **Markdown / 純文字 / PDF**。自動濾除導覽列、語言切換、navbox、分享列等雜訊與內聯 CSS。
- **預覽並選取**（右鍵「預覽並選取要儲存的內容…」）：開雙欄預覽頁，左側勾選要保留的內容區塊（章節可整段勾選）、右側即時預覽（轉場動畫、效能穩定），選格式後再儲存。
- **影音選單**：在 YouTube／影音站右鍵自動顯示「Squirl 影音…」子選單——儲存影片頁＋字幕、只存字幕、開影音預覽面板（選字幕語言與可下載畫質）。
- **YouTube**：儲存網址 + metadata（標題 / 頻道 / 時長 / 章節）+ **字幕**（多語、SRT/VTT），字幕純文字併入 sidecar 供 KB 索引；字幕被鎖時可下載影片交由 AI Desktop 轉錄。
- **Google Drive 直傳**：resumable 上傳、斷點續傳、token 過期自動刷新（沿用 Capyture）。
- **AI Desktop 串接**：上傳後通知後端排入 KB，並建立 ~5 分鐘的行事曆標記事件。
- **高容錯**：檔案先落 Drive 才算成功；Drive 失敗退本機、KB/行事曆失敗自動由後端資料夾同步補處理。

> **v2 規劃**：YouTube 影片本體下載（畫質 / 檔案大小選擇）。介面已預留，見 `ARCHITECTURE.md §7.3` 與 `TODO.md M6`。

## 文件

- 設計稿：[`ARCHITECTURE.md`](./ARCHITECTURE.md)
- 開發進度：[`TODO.md`](./TODO.md)
- Drive 設定：[`SETUP-DRIVE.md`](./SETUP-DRIVE.md)
- AI Desktop 串接：[`SETUP-AIDESKTOP.md`](./SETUP-AIDESKTOP.md)

## 開發

```bash
npm install        # 安裝相依（postinstall 會跑 wxt prepare）
npm run dev        # 開發模式（Chrome）
npm run compile    # 型別檢查（svelte-check）
npm run build      # 產出 .output/chrome-mv3
```

載入 `.output/chrome-mv3` 到 `chrome://extensions`（開發者模式）。

## 技術棧

WXT + Svelte 5 + TypeScript（與 Capyture 一致，最大化共用 Drive / AI Desktop / secrets / settings 等程式碼）。

## 設計原則

可維護、高擴充、高穩定、高容錯、好的錯誤捕捉、低記憶體、做好抽象、不破壞既有功能。
新增「內容來源 / 匯出格式 / 儲存目的地」皆為獨立可插拔的擴充點。

## 授權

見 [`LICENSE`](./LICENSE)。
