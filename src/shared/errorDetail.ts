/**
 * 把任意 thrown 值或 SerializedError 正規化成「可顯示的詳細錯誤」。
 * 單一抽象點：UI 只要呼叫 describeError，就拿到 friendly 訊息 + 技術細節 + 行動引導。
 * 容錯：永不再 throw；未知值一律降級為 UNKNOWN。
 */
import { serializeError, type ErrCode, type SerializedError } from '@/shared/errors';
import { errorMessage, t, type DictKey } from '@/shared/i18n';

export interface ErrorDetail {
  code: ErrCode;
  /** 使用者可讀訊息（err_<CODE>） */
  message: string;
  /** 原始技術細節；與 friendly 訊息相同時留空避免重複 */
  detail: string;
  /** 行動引導（hint_<CODE>）；無對應時為空字串 */
  hint: string;
}

/** 有對應引導文案的錯誤碼（其餘不顯示 hint，避免空泛字句） */
const HINT_CODES: ReadonlySet<ErrCode> = new Set<ErrCode>([
  'RESTRICTED_PAGE',
  'INJECT_FAILED',
  'EMPTY_CONTENT',
  'YT_NO_CAPTIONS',
  'DRIVE_NOT_CONFIGURED',
  'DRIVE_AUTH_FAILED',
  'DRIVE_UPLOAD_FAILED',
  'AIDESKTOP_UNREACHABLE',
]);

function isSerialized(x: unknown): x is SerializedError {
  return (
    !!x &&
    typeof x === 'object' &&
    typeof (x as { code?: unknown }).code === 'string' &&
    typeof (x as { message?: unknown }).message === 'string'
  );
}

export function describeError(input: unknown): ErrorDetail {
  const se: SerializedError = isSerialized(input) ? input : serializeError(input);
  const message = errorMessage(se.code);
  const raw = (se.message ?? '').trim();
  const detail = raw && raw !== message ? raw : '';
  const hint = HINT_CODES.has(se.code) ? t(`hint_${se.code}` as DictKey) : '';
  return { code: se.code, message, detail, hint };
}

/** 給「複製」按鈕用的完整除錯文字 */
export function errorCopyText(d: ErrorDetail): string {
  const lines = [`[${d.code}] ${d.message}`];
  if (d.detail) lines.push(d.detail);
  if (d.hint) lines.push(d.hint);
  return lines.join('\n');
}
