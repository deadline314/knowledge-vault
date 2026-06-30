/**
 * 型別安全的訊息收發。
 * - 每次 send 帶 timeout，不會永久 pending
 * - 回應統一封裝 WireResponse；錯誤以 SerializedError 跨 context 傳遞
 * - 廣播失敗（對象不存在，如 popup 已關）一律 swallow，不影響核心流程
 */
import { AppError, serializeError, type SerializedError } from '@/shared/errors';
import { createLogger } from '@/shared/logger';
import type {
  BackgroundRequests,
  ContentRequests,
  Envelope,
  OffscreenRequests,
  PopupBroadcasts,
  RequestMapOf,
  Target,
  WireResponse,
} from './protocol';

const log = createLogger('bus');
const DEFAULT_TIMEOUT_MS = 30_000;

type Handler<Req, Res> = (payload: Req) => Promise<Res> | Res;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new AppError('TIMEOUT', `${label} timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

/** 送訊息到 background（runtime.sendMessage） */
export function sendToBackground<K extends keyof BackgroundRequests>(
  type: K,
  payload: BackgroundRequests[K]['payload'],
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<BackgroundRequests[K]['response']> {
  const env: Envelope = { __squirl: true, target: 'background', type: String(type), payload };
  return withTimeout(
    new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(env, (res: WireResponse | undefined) => {
        const err = chrome.runtime.lastError;
        if (err) return reject(new AppError('NO_RESPONSE', err.message ?? 'no response'));
        if (!res) return reject(new AppError('NO_RESPONSE', 'empty response'));
        if (!res.ok) return reject(rebuild(res.error));
        resolve(res.data as BackgroundRequests[K]['response']);
      });
    }),
    timeoutMs,
    `background/${String(type)}`,
  );
}

/** 送訊息到指定分頁的 content script（tabs.sendMessage） */
export function sendToContent<K extends keyof ContentRequests>(
  tabId: number,
  type: K,
  payload: ContentRequests[K]['payload'],
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<ContentRequests[K]['response']> {
  const env: Envelope = { __squirl: true, target: 'content', type: String(type), payload };
  return withTimeout(
    new Promise((resolve, reject) => {
      chrome.tabs.sendMessage(tabId, env, (res: WireResponse | undefined) => {
        const err = chrome.runtime.lastError;
        if (err) return reject(new AppError('INJECT_FAILED', err.message ?? 'tab not reachable'));
        if (!res) return reject(new AppError('NO_RESPONSE', 'empty response'));
        if (!res.ok) return reject(rebuild(res.error));
        resolve(res.data as ContentRequests[K]['response']);
      });
    }),
    timeoutMs,
    `content/${String(type)}`,
  );
}

/** 送訊息到 offscreen document（runtime.sendMessage；由 background 呼叫） */
export function sendToOffscreen<K extends keyof OffscreenRequests>(
  type: K,
  payload: OffscreenRequests[K]['payload'],
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<OffscreenRequests[K]['response']> {
  const env: Envelope = { __squirl: true, target: 'offscreen', type: String(type), payload };
  return withTimeout(
    new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(env, (res: WireResponse | undefined) => {
        const err = chrome.runtime.lastError;
        if (err) return reject(new AppError('NO_RESPONSE', err.message ?? 'offscreen not reachable'));
        if (!res) return reject(new AppError('NO_RESPONSE', 'empty response'));
        if (!res.ok) return reject(rebuild(res.error));
        resolve(res.data as OffscreenRequests[K]['response']);
      });
    }),
    timeoutMs,
    `offscreen/${String(type)}`,
  );
}

/** 廣播給 popup（fire-and-forget；對象不存在直接吞掉） */
export function broadcastToPopup<K extends keyof PopupBroadcasts>(
  type: K,
  payload: PopupBroadcasts[K]['payload'],
): void {
  const env: Envelope = { __squirl: true, target: 'popup', type: String(type), payload };
  try {
    chrome.runtime.sendMessage(env, () => void chrome.runtime.lastError);
  } catch {
    /* popup 已關，忽略 */
  }
}

/**
 * 註冊某 target 的處理器集合。回傳解除註冊函式。
 * 同一 context 只需呼叫一次，傳入該 target 的所有 handler。
 */
export function registerHandlers<T extends Target>(
  target: T,
  handlers: Partial<{ [K in keyof RequestMapOf<T>]: Handler<RequestMapOf<T>[K] extends { payload: infer P } ? P : never, RequestMapOf<T>[K] extends { response: infer R } ? R : never> }>,
): () => void {
  const listener = (raw: unknown, _sender: chrome.runtime.MessageSender, sendResponse: (r: WireResponse) => void): boolean => {
    const env = raw as Envelope;
    if (!env || env.__squirl !== true || env.target !== target) return false;
    const handler = (handlers as Record<string, Handler<unknown, unknown> | undefined>)[env.type];
    if (!handler) {
      sendResponse({ ok: false, error: { code: 'NO_HANDLER', message: `no handler for ${env.type}` } });
      return false;
    }
    Promise.resolve()
      .then(() => handler(env.payload))
      .then((data) => sendResponse({ ok: true, data }))
      .catch((e) => {
        const error: SerializedError = serializeError(e);
        log.warn(`handler ${env.type} failed`, error);
        sendResponse({ ok: false, error });
      });
    return true; // async response
  };
  chrome.runtime.onMessage.addListener(listener);
  return () => chrome.runtime.onMessage.removeListener(listener);
}

function rebuild(error?: SerializedError): AppError {
  return new AppError(error?.code ?? 'UNKNOWN', error?.message ?? 'unknown error');
}
