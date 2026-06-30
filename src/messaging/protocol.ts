/**
 * 跨 context 訊息協定（discriminated union）。
 * 路由規則：每則訊息帶 target；background 走 runtime.sendMessage，
 * content script 走 tabs.sendMessage(tabId)。
 */
import type { CaptureResult, CaptureScope } from '@/core/capture/ContentSource';
import type { YtProbe } from '@/core/capture/youtube/captureYouTube';
import type { ExportFormat } from '@/shared/settings';
import type { SerializedError } from '@/shared/errors';

export type Target = 'background' | 'content' | 'popup' | 'offscreen';

/** 後端連動資料夾（AI Desktop linked-folders 的單項） */
export interface LinkedFolder {
  kb_id: string;
  kb_name: string;
  folder_id: string;
  folder_name: string;
}

/** 一次剪存的對外請求（popup / 選單 → background） */
export interface ClipRequest {
  tabId: number;
  scope: CaptureScope;
  /** 指定格式；省略 = 用設定的預設格式 */
  format?: ExportFormat | 'subtitle';
  /** 使用者在 popup 補的中繼資料 */
  tags?: string[];
  project?: string | null;
  /** YouTube：要一併下載的影片畫質（progressive itag）；省略 = 不下載影片 */
  video?: { itag: number; label: string } | null;
  /** YouTube：是否下載字幕（覆寫設定預設；省略 = 用設定值） */
  subtitles?: boolean;
  /** YouTube：指定要下載的字幕語言（依使用者在 popup 選的；省略 = 用設定偏好語言） */
  subtitleLangs?: string[];
}

export type ClipPhase =
  | 'queued'
  | 'capturing'
  | 'exporting'
  | 'storing'
  | 'notifying'
  | 'video'
  | 'done'
  | 'error';

export interface ClipSnapshot {
  id: string;
  url: string;
  title: string;
  phase: ClipPhase;
  /** 人類可讀的即時細節，如「下載字幕 zh-Hant」「上傳 標題.md 32%」 */
  detail: string;
  /** 0~1，storing / video 階段才有意義 */
  progress: number;
  webViewLink: string | null;
  duplicate: boolean;
  error: SerializedError | null;
  at: number;
}

/** ---- background 收的訊息 ---- */
export interface BackgroundRequests {
  /** popup / 快捷鍵：執行一次剪存（非同步，進度走 popup 廣播） */
  'clip/run': { payload: ClipRequest; response: { id: string } };
  'clip/retry': { payload: { id: string }; response: { id: string } };
  'history/list': { payload: void; response: ClipSnapshot[] };
  /** YouTube：給 popup 預先顯示畫質/字幕選項（不下載字幕） */
  'yt/probe': { payload: { tabId: number }; response: YtProbe };

  /** 設定切換語言：背景套用語系並重建右鍵選單 */
  'ui/applyLocale': { payload: { lang: string }; response: void };

  /** Drive OAuth */
  'drive/connect': { payload: void; response: { email: string | null } };
  'drive/status': {
    payload: void;
    response: {
      configured: boolean;
      connected: boolean;
      email: string | null;
      hasCustomId: boolean;
      customTail: string | null;
    };
  };
  'drive/setClientId': { payload: { clientId: string | null }; response: void };

  /** AI Desktop */
  'aidesktop/health': { payload: { baseUrl: string }; response: { ok: boolean; detail: string } };
  'aidesktop/folders': {
    payload: { baseUrl: string };
    response: { email: string; folders: LinkedFolder[] };
  };
  'aidesktop/createFolder': {
    payload: { baseUrl: string; name: string };
    response: LinkedFolder;
  };

  /** 預覽頁：先擷取來源分頁內容（不儲存），給使用者勾選 */
  'preview/capture': {
    payload: { tabId: number; scope: CaptureScope };
    response: CaptureResult;
  };
  /** 預覽頁：以使用者選取後（已過濾）的結果直接匯出＋儲存 */
  'preview/save': {
    payload: {
      result: CaptureResult;
      sourceTabId: number;
      format: ExportFormat | 'subtitle';
      tags?: string[];
      project?: string | null;
      video?: { itag: number; label: string } | null;
      subtitles?: boolean;
      subtitleLangs?: string[];
    };
    response: { id: string };
  };
}

/** ---- content script 收的訊息 ---- */
export interface ContentRequests {
  'content/capture': {
    payload: { scope: CaptureScope };
    response: CaptureResult;
  };
  'content/ping': { payload: void; response: 'pong' };
}

/** ---- offscreen document 收的訊息（重活：PDF 產生） ---- */
export interface OffscreenRequests {
  'offscreen/renderPdf': {
    payload: { result: CaptureResult; baseName: string };
    response: { base64: string };
  };
  'offscreen/ping': { payload: void; response: 'pong' };
}

/** ---- popup 收的廣播（fire-and-forget） ---- */
export interface PopupBroadcasts {
  'clip/update': { payload: ClipSnapshot; response: void };
}

export type RequestMapOf<T extends Target> = T extends 'background'
  ? BackgroundRequests
  : T extends 'content'
    ? ContentRequests
    : T extends 'offscreen'
      ? OffscreenRequests
      : PopupBroadcasts;

/** 線上傳輸封包 */
export interface Envelope {
  __squirl: true;
  target: Target;
  type: string;
  payload: unknown;
}

export interface WireResponse {
  ok: boolean;
  data?: unknown;
  error?: SerializedError;
}
