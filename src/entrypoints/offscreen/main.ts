/**
 * Offscreen document：負責「重活」——目前是 PDF 產生（pdf-lib + 內嵌中文字型）。
 *
 * 為何在這裡：pdf-lib 與字型較重，放進 service worker 會讓 SW 註冊失敗；
 * offscreen 有完整 document 環境，可載入字型、產生 PDF，且只在需要時由 background 建立。
 *
 * 字型只載一次並快取；PDF bytes 以 base64 回傳（訊息只能傳可序列化資料）。
 */
import { registerHandlers } from '@/messaging/bus';
import { renderPdf } from '@/core/export/pdfRender';
import { createLogger, installGlobalErrorLogging } from '@/shared/logger';

const log = createLogger('offscreen');

let fontCache: ArrayBuffer | null = null;
async function loadFont(): Promise<ArrayBuffer> {
  if (fontCache) return fontCache;
  const res = await fetch(chrome.runtime.getURL('fonts/NotoSansCJK-subset.ttf'));
  if (!res.ok) throw new Error(`font load failed: HTTP ${res.status}`);
  fontCache = await res.arrayBuffer();
  return fontCache;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

installGlobalErrorLogging('offscreen');

registerHandlers('offscreen', {
  'offscreen/ping': () => 'pong' as const,
  'offscreen/renderPdf': async ({ result }) => {
    const fontBytes = await loadFont();
    const pdf = await renderPdf(result, { fontBytes });
    return { base64: bytesToBase64(pdf) };
  },
});

log.debug('offscreen ready');
