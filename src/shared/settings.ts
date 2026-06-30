/**
 * 設定持久化（chrome.storage.local）。
 * - schema 版本化 + 預設值深度合併：新版本加欄位不會壞舊資料
 * - 讀取永不 throw：壞資料自動回退預設值
 * - 容錯：陣列上限自動截斷，避免寫入失敗
 */
import { createLogger } from './logger';

const log = createLogger('settings');

export type ExportFormat = 'md' | 'txt' | 'pdf';
export type SubtitleFormat = 'srt' | 'vtt';
export type PdfStrategy = 'auto' | 'printToPdf' | 'pdfLib';
export type ThemeId = 'system' | 'light' | 'dark';

/** 匯出相關 */
export interface ExportSettings {
  /** 主動作（右鍵第一項）使用的預設格式 */
  defaultFormat: ExportFormat;
  /** PDF 產生策略；auto = printToPdf 失敗退 pdfLib */
  pdfStrategy: PdfStrategy;
  /** 匯出時是否內嵌圖片參照（Markdown/Text 以連結；PDF 視策略） */
  includeImages: boolean;
  /** 是否同時輸出 .meta.json sidecar（AI Desktop / 自動化用） */
  writeSidecar: boolean;
}

/** Drive 直傳 */
export interface DriveSettings {
  /** Drive 連線總開關（預設關閉；開啟並設定 client ID 後才出現相關功能） */
  authEnabled: boolean;
  /** 剪存後是否直傳 Drive（關閉則走本機下載） */
  uploadToDrive: boolean;
  /** Drive 內歸檔子資料夾（AI Desktop 模式會被連動資料夾覆寫） */
  subfolder: string;
}

/** AI Desktop 串接（一次設定，之後全自動） */
export interface AiDesktopSettings {
  enabled: boolean;
  /** 後端網址（如 https://xxx.a.run.app） */
  baseUrl: string;
  /** 選定的歸檔資料夾（來自後端 linked-folders；Drive folder id） */
  folderId: string;
  folderName: string;
  kbName: string;
  /** 行事曆標記：剪存時在行事曆留一個小事件 */
  calendarMark: boolean;
  /** 標記事件長度（分鐘） */
  calendarDurationMin: number;
}

/** YouTube 處理偏好 */
export interface YouTubeSettings {
  /** 是否嘗試下載字幕 */
  saveSubtitles: boolean;
  /** 偏好語言（依序嘗試；空 = 介面語言 + 原片語言） */
  preferredLangs: string[];
  /** 字幕輸出格式 */
  subtitleFormat: SubtitleFormat;
  /** 是否把字幕純文字併入 sidecar 供 KB 索引 */
  captionsIntoSidecar: boolean;
}

/** 擷取行為 */
export interface CaptureSettings {
  /** 動態內容穩定判定：連續無變動毫秒數 */
  settleQuietMs: number;
  /** 等待動態內容的最長上限（毫秒） */
  settleMaxMs: number;
  /** 擷取前是否捲動觸發 lazy-load（進階） */
  scrollToLoad: boolean;
}

export interface UiSettings {
  theme: ThemeId;
  /** 'auto' = 跟隨瀏覽器語言 */
  language: string;
}

export interface AppSettings {
  schemaVersion: 1;
  export: ExportSettings;
  drive: DriveSettings;
  aiDesktop: AiDesktopSettings;
  youtube: YouTubeSettings;
  capture: CaptureSettings;
  ui: UiSettings;
  /** 隱私黑名單：URL 含任一字串則選單不出現（避免誤存敏感頁） */
  blocklist: string[];
}

export const MAX_BLOCKLIST = 100;
export const MAX_LANGS = 20;

export const DEFAULT_SETTINGS: AppSettings = {
  schemaVersion: 1,
  export: {
    defaultFormat: 'md',
    pdfStrategy: 'auto',
    includeImages: true,
    writeSidecar: false,
  },
  drive: {
    authEnabled: false,
    uploadToDrive: false,
    subfolder: 'Squirl',
  },
  aiDesktop: {
    enabled: false,
    baseUrl: '',
    folderId: '',
    folderName: '',
    kbName: '',
    calendarMark: true,
    calendarDurationMin: 5,
  },
  youtube: {
    saveSubtitles: true,
    preferredLangs: [],
    subtitleFormat: 'srt',
    captionsIntoSidecar: true,
  },
  capture: {
    settleQuietMs: 600,
    settleMaxMs: 4000,
    scrollToLoad: false,
  },
  ui: {
    theme: 'system',
    language: 'auto',
  },
  blocklist: [],
};

const KEY = 'app-settings';

/** 深度合併：以預設值為底，僅覆蓋已知欄位（容錯：未知/缺漏欄位自動補齊） */
function mergeWithDefaults(stored: unknown): AppSettings {
  if (typeof stored !== 'object' || stored === null) return structuredClone(DEFAULT_SETTINGS);
  const merge = <T extends object>(base: T, over: Partial<T>): T => {
    const out = { ...base };
    for (const k of Object.keys(base) as (keyof T)[]) {
      const o = over?.[k];
      if (o === undefined) continue;
      const b = base[k];
      if (typeof b === 'object' && b !== null && !Array.isArray(b)) {
        out[k] = merge(b as object, o as object) as T[keyof T];
      } else if (typeof o === typeof b || b === null || o === null) {
        out[k] = o as T[keyof T];
      }
    }
    return out;
  };
  return merge(structuredClone(DEFAULT_SETTINGS), stored as Partial<AppSettings>);
}

export async function loadSettings(): Promise<AppSettings> {
  try {
    const res = await chrome.storage.local.get(KEY);
    return mergeWithDefaults(res[KEY]);
  } catch (e) {
    log.warn('loadSettings failed, using defaults', e);
    return structuredClone(DEFAULT_SETTINGS);
  }
}

export async function saveSettings(settings: AppSettings): Promise<void> {
  try {
    settings.blocklist = settings.blocklist.slice(0, MAX_BLOCKLIST);
    settings.youtube.preferredLangs = settings.youtube.preferredLangs.slice(0, MAX_LANGS);
    await chrome.storage.local.set({ [KEY]: settings });
  } catch (e) {
    log.warn('saveSettings failed', e);
  }
}

/** 局部更新：load → patch → save，避免覆寫其他欄位 */
export async function patchSettings(patch: (s: AppSettings) => void): Promise<AppSettings> {
  const s = await loadSettings();
  try {
    patch(s);
  } catch (e) {
    log.warn('patchSettings patch fn threw', e);
  }
  await saveSettings(s);
  return s;
}
