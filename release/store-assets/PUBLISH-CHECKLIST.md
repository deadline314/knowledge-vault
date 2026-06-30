# Squirl — 上架 Chrome Web Store 檢查清單

打包檔：`release/squirl-1.0.3-chrome.zip`（每次更新跑 `npm run zip` 重新產生；記得先升版號）

## A. 一次性準備
- [ ] 到 https://chrome.google.com/webstore/devconsole 用 Google 帳號登入
- [ ] 付一次性 US$5 開發者註冊費、同意條款
- [ ] 把 `privacy-policy.html` 放到一個公開網址（例如 GitHub Pages），取得隱私政策 URL

## B. 建立項目
- [ ] 「Add new item」→ 上傳 `squirl-1.0.3-chrome.zip`

## C. Store listing（商店資訊）
- [ ] 名稱 / 簡述 / 詳細說明 → 直接用 `store-listing.md`（可另建「中文（繁體）」在地化版本）
- [ ] 分類：Productivity
- [ ] 圖示 128×128：已內含於套件
- [ ] 截圖（1280×800）：`screenshot-1-clip.png`、`screenshot-2-subtitles.png`、`screenshot-3-formats.png`
- [ ] 小宣傳磚 440×280：`promo-small-440x280.png`
- [ ] Marquee 橫幅 1400×560（選填，被精選時用）：`promo-marquee-1400x560.png`

## D. Privacy（隱私分頁）
- [ ] 單一用途、各權限理由、資料用途勾選 → 全在 `permission-justifications.md`
- [ ] 隱私政策 URL（步驟 A 那個）

## E. 送審 → 發布
- [ ] 選擇可見範圍（Public / Unlisted / Private）後送審（含 <all_urls> 通常審查較久）

## ⚠️ F. Google OAuth 驗證（跟 Web Store 分開，務必先處理）
這是最容易卡住的一關。Squirl 用 `drive.file`（敏感 scope，非受限），所以只需做
OAuth 同意畫面驗證，不必做受限 scope 的昂貴年度安全評估。
- [ ] 在 Google Cloud Console 設定 OAuth 同意畫面（App 名稱、logo、首頁、隱私政策 URL）
- [ ] 加入 `drive.file` scope 並提交驗證（可能需要一段示範影片）
- [ ] 產品決策：目前是「每位使用者自己貼 OAuth Client ID」。若要面向一般大眾，
      建議改成內建一組你驗證過的 Client ID，讓使用者免設定（我可以幫你改）。

## 檔案清單（本資料夾 release/store-assets/）
- store-listing.md ............ 名稱 / 簡述 / 詳細說明（中英）
- permission-justifications.md  權限理由 + 資料用途（英文，可直接貼）
- privacy-policy.md / .html ... 隱私政策（.html 可直接託管）
- screenshot-1/2/3 ........... 商店截圖 1280×800
- promo-small-440x280.png .... 小宣傳磚
- promo-marquee-1400x560.png . Marquee 橫幅
