import { defineConfig } from 'wxt';
import { DRIVE_CLIENT_ID, DRIVE_SCOPES } from './drive.config';

// Squirl — 右鍵剪存網頁/YouTube 到 Google Drive + AI Desktop 知識庫。
export default defineConfig({
  modules: ['@wxt-dev/module-svelte'],
  srcDir: 'src',
  publicDir: 'src/public',
  manifest: {
    name: '__MSG_extName__',
    description: '__MSG_extDesc__',
    default_locale: 'en',
    permissions: [
      'contextMenus', // 右鍵選單
      'scripting', // 動態注入 content script
      'activeTab', // 配合使用者點擊取得當前分頁授權
      'downloads', // 本機後備
      'storage', // 設定
      'identity', // Drive OAuth
      'identity.email', // 顯示帳號
      'notifications', // 結果通知
      'offscreen', // PDF 產生（pdf-lib + 內嵌中文字型，太重不能放 SW）
    ],
    // 註：'debugger' 無法作為 optional permission（Chrome 會忽略並警告），故不宣告 optional_permissions。
    // AI Desktop 後端網址由使用者在設定頁填入，build 時不可知——
    // 採 optional host permission，按「連線」時才針對該網址請求一次。
    // http 放行以支援 localhost／區網 IP 開發測試。
    optional_host_permissions: ['https://*/*', 'http://*/*'],
    ...(DRIVE_CLIENT_ID.startsWith('REPLACE')
      ? {}
      : { oauth2: { client_id: DRIVE_CLIENT_ID, scopes: [...DRIVE_SCOPES] } }),
    icons: {
      16: 'icon/16.png',
      32: 'icon/32.png',
      48: 'icon/48.png',
      128: 'icon/128.png',
    },
    commands: {
      'clip-page': {
        suggested_key: { default: 'Alt+Shift+S' },
        description: '__MSG_cmdClip__',
      },
    },
  },
});
