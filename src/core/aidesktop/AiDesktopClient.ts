/**
 * AI Desktop 後端串接 client（在 background SW 執行）。
 *
 * 設計原則（與 Capyture 一致）：
 * - 隱私優先：只有使用者在設定頁明確「連線」過的網址才會被呼叫；
 *   host permission 採 optional，按下連線時才針對該網址請求一次授權。
 * - 容錯優先：所有呼叫都有 timeout；ingest 回呼失敗**絕不**影響檔案
 *   （檔案已在 Drive，後端的資料夾同步會自動補處理）。
 * - 認證零負擔：重用既有的 Drive OAuth token（後端用 Google tokeninfo
 *   驗證），使用者不需要任何額外帳號或金鑰。
 *
 * 與 Capyture 的差異：ingest 帶 source_type（web_clip / youtube_clip）、
 * source_url（去重 / 回連）、calendar（行事曆標記指令）。欄位多帶不會壞舊後端。
 */
import { createLogger } from '@/shared/logger';
import type { LinkedFolder } from '@/messaging/protocol';

const log = createLogger('aidesktop');

const FETCH_TIMEOUT_MS = 10_000;

/** 正規化使用者輸入的網址：補 https、去尾斜線與空白。回 null = 格式無效。 */
export function normalizeBaseUrl(raw: string): string | null {
  let s = (raw || '').trim();
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = `https://${s}`;
  try {
    const u = new URL(s);
    if (!u.hostname) return null;
    return `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
  } catch {
    return null;
  }
}

export type HostPermissionResult =
  | { ok: true }
  | { ok: false; reason: 'denied' | 'gesture' | 'manifest' | 'error'; detail: string };

/** 針對該網址請求 host permission（一次性；已授權則直接回 true）。 */
export async function ensureHostPermission(baseUrl: string): Promise<HostPermissionResult> {
  const origin = `${new URL(baseUrl).origin}/*`;
  try {
    const granted = await chrome.permissions.request({ origins: [origin] });
    if (granted) return { ok: true };
    return { ok: false, reason: 'denied', detail: origin };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log.warn('host permission request failed', msg);
    try {
      if (await chrome.permissions.contains({ origins: [origin] })) return { ok: true };
    } catch {
      /* fallthrough */
    }
    if (/user gesture/i.test(msg)) return { ok: false, reason: 'gesture', detail: msg };
    if (/optional permissions|manifest/i.test(msg)) return { ok: false, reason: 'manifest', detail: msg };
    return { ok: false, reason: 'error', detail: msg };
  }
}

async function fetchJson<T>(url: string, init: RequestInit & { driveToken?: string } = {}): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(init.driveToken ? { 'X-Gdrive-Token': init.driveToken } : {}),
    };
    const res = await fetch(url, { ...init, headers, signal: controller.signal });
    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try {
        const body = (await res.json()) as { detail?: string };
        if (body?.detail) detail = body.detail;
      } catch {
        /* non-JSON error body */
      }
      throw new Error(detail);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

export type HealthProbe =
  | { ok: true }
  | { ok: false; kind: 'network' | 'notfound' | 'notai'; detail: string };

/** 健康檢查：確認網址指向 AI Desktop（不需要 token）。 */
export async function probeHealth(baseUrl: string): Promise<HealthProbe> {
  const url = `${baseUrl}/api/extension/health`;
  let res: Response;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      res = await fetch(url, { signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    log.warn('health probe network failure', detail);
    return { ok: false, kind: 'network', detail };
  }
  if (res.status === 404) return { ok: false, kind: 'notfound', detail: `404 @ ${url}` };
  try {
    const body = (await res.json()) as { ok?: boolean; service?: string };
    if (body?.ok === true && body?.service === 'ai-desktop') return { ok: true };
    return { ok: false, kind: 'notai', detail: `unexpected body @ ${url}` };
  } catch {
    return { ok: false, kind: 'notai', detail: `non-JSON response (HTTP ${res.status}) @ ${url}` };
  }
}

/** 取得「已連動 KB 的 Drive 資料夾」清單（設定頁下拉的資料來源）。 */
export async function fetchLinkedFolders(
  baseUrl: string,
  driveToken: string,
): Promise<{ email: string; folders: LinkedFolder[] }> {
  return fetchJson(`${baseUrl}/api/extension/linked-folders`, { driveToken });
}

/** 「＋新增資料夾」：請後端一步建立 Drive 資料夾＋對應 KB。 */
export async function createLinkedFolder(
  baseUrl: string,
  driveToken: string,
  name: string,
): Promise<LinkedFolder> {
  return fetchJson<LinkedFolder>(`${baseUrl}/api/extension/folders`, {
    method: 'POST',
    driveToken,
    body: JSON.stringify({ name }),
  });
}

export type ClipSourceType = 'web_clip' | 'youtube_clip';

export interface CalendarMarker {
  mark: boolean;
  durationMin: number;
  titleHint: string;
  kind: 'clip_marker';
}

/**
 * 轉錄請求（後端在伺服器端從 source_url 取音訊轉逐字稿，再併入 KB）。
 * 設計理由：YouTube 近期常鎖字幕下載；與其在擴充內塞重量級 Whisper，
 * 不如把「轉錄」交給後端——後端本就能用 source_url 取得內容，且結果可直接索引。
 * - reason='captions_blocked'：要字幕但抓不到 → 後端補轉錄。
 * - reason='user_requested'：使用者下載了影片要逐字稿。
 */
export interface TranscribeRequest {
  request: boolean;
  reason: 'captions_blocked' | 'user_requested';
  langs: string[];
}

export interface IngestParams {
  fileId: string;
  fileName: string;
  folderId: string;
  mimeType?: string;
  sourceType: ClipSourceType;
  sourceUrl: string;
  clippedAt: string; // UTC ISO
  calendar?: CalendarMarker;
  attachments?: { fileId: string; role: 'subtitle' | 'sidecar' }[];
  transcribe?: TranscribeRequest;
}

export interface IngestOutcome {
  status: 'queued' | 'duplicate';
  kb_name: string;
  event_id: string | null;
  matched?: unknown;
}

/**
 * 上傳完成回呼：請後端把檔案排入 KB，並（可選）建立行事曆標記事件。
 * 後端對「建事件」應獨立 try/catch——行事曆失敗不擋 KB。
 * 失敗回 null——檔案已安全躺在 Drive 資料夾，下次資料夾同步會自動補處理。
 */
export async function notifyIngest(
  baseUrl: string,
  driveToken: string,
  params: IngestParams,
): Promise<IngestOutcome | null> {
  try {
    const res = await fetchJson<IngestOutcome>(`${baseUrl}/api/extension/ingest`, {
      method: 'POST',
      driveToken,
      body: JSON.stringify({
        file_id: params.fileId,
        file_name: params.fileName,
        folder_id: params.folderId,
        mime_type: params.mimeType ?? null,
        source_type: params.sourceType,
        source_url: params.sourceUrl,
        clipped_at: params.clippedAt,
        calendar: params.calendar
          ? {
              mark: params.calendar.mark,
              duration_min: params.calendar.durationMin,
              title_hint: params.calendar.titleHint,
              kind: params.calendar.kind,
            }
          : null,
        transcribe: params.transcribe
          ? {
              request: params.transcribe.request,
              reason: params.transcribe.reason,
              langs: params.transcribe.langs,
            }
          : null,
        attachments: (params.attachments ?? []).map((a) => ({ file_id: a.fileId, role: a.role })),
      }),
    });
    log.info('ingest ok', res.status, params.fileName, res.event_id ?? '(no event)');
    return res;
  } catch (e) {
    log.warn('ingest failed (folder sync will pick the file up later)', e);
    return null;
  }
}
