/**
 * 從 background 呼叫 offscreen document 產生 PDF 的橋接層。
 *
 * 為何需要 offscreen：pdf-lib + 內嵌中文字型較重，放進 service worker 會讓 SW 註冊失敗；
 * 且 SW 無 DOM。offscreen document 有完整環境，只在需要時建立、用完保留以重用字型快取。
 *
 * 容錯：建立 offscreen 有競態（多個剪存同時觸發）→ 以單一 in-flight promise 串接；
 * 「已存在單一 offscreen」的錯誤視為成功。呼叫端應對 render 失敗有退路（退回 Markdown）。
 */
import { sendToOffscreen } from '@/messaging/bus';
import { createLogger } from '@/shared/logger';
import type { CaptureResult } from '@/core/capture/ContentSource';

const log = createLogger('offscreen-pdf');
const OFFSCREEN_URL = 'offscreen.html';

let ensuring: Promise<void> | null = null;

async function hasOffscreen(): Promise<boolean> {
  // 新版 chrome 提供 hasDocument；舊版改用 getContexts 探查。
  const api = chrome.offscreen as typeof chrome.offscreen & { hasDocument?: () => Promise<boolean> };
  if (typeof api.hasDocument === 'function') {
    try {
      return await api.hasDocument();
    } catch {
      /* 落到 getContexts */
    }
  }
  try {
    const runtime = chrome.runtime as typeof chrome.runtime & {
      getContexts?: (f: { contextTypes: string[] }) => Promise<unknown[]>;
    };
    if (typeof runtime.getContexts === 'function') {
      const ctxs = await runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
      return Array.isArray(ctxs) && ctxs.length > 0;
    }
  } catch {
    /* 探查失敗就嘗試建立，createDocument 會擋重複 */
  }
  return false;
}

/** 確保 offscreen document 存在（competing callers 共用同一 in-flight promise）。 */
function ensureOffscreen(): Promise<void> {
  if (ensuring) return ensuring;
  ensuring = (async () => {
    if (await hasOffscreen()) return;
    try {
      await chrome.offscreen.createDocument({
        url: OFFSCREEN_URL,
        reasons: [chrome.offscreen.Reason.BLOBS],
        justification: '產生內嵌中文字型的 PDF（pdf-lib 太重，不能放在 service worker）。',
      });
    } catch (e) {
      // 競態：另一個呼叫已建立 → 視為成功
      if (/single offscreen/i.test(String(e))) return;
      throw e;
    }
  })().finally(() => {
    ensuring = null;
  });
  return ensuring;
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** 透過 offscreen 產生 PDF；回傳 bytes。任何失敗都向上拋，由呼叫端決定退路。 */
export async function renderPdfViaOffscreen(result: CaptureResult, baseName: string): Promise<Uint8Array> {
  await ensureOffscreen();
  const { base64 } = await sendToOffscreen('offscreen/renderPdf', { result, baseName }, 60_000);
  const bytes = base64ToBytes(base64);
  log.debug('pdf rendered via offscreen', bytes.byteLength);
  return bytes;
}
