/**
 * 多語系核心（仿 Capyture）。
 * - 語言自動跟隨瀏覽器 UI 語言（chrome.i18n.getUILanguage → navigator.language），可由設定覆寫。
 * - en 為基準字典（DictKey 單一事實來源），其他語系缺 key 時自動 fallback 到 en。
 * - t(key, ...args)：{0}/{1} 參數替換。errorMessage(code) = t('err_<CODE>')。
 * - 純 JS 字典（非 _locales messages）：型別安全、popup/SW/offscreen/匯出器通用。
 *
 * Svelte 反應式：元件持有 `let localeRev = $state(0)`，包一層讀取 localeRev 的 t()，
 * setLocale 後 localeRev++ 即可整頁重渲染（見 popup/preview）。
 */
import type { ErrCode } from './errors';
import { en } from './locales/en';
import { zhTW } from './locales/zh_TW';
import { zhCN } from './locales/zh_CN';
import { ja } from './locales/ja';
import { ko } from './locales/ko';
import { es } from './locales/es';
import { ru } from './locales/ru';
import { ptBR } from './locales/pt_BR';

export type DictKey = keyof typeof en;

const LOCALES: Record<string, Partial<Record<DictKey, string>>> = {
  en,
  'zh-TW': zhTW,
  'zh-CN': zhCN,
  ja,
  ko,
  es,
  ru,
  'pt-BR': ptBR,
};

function resolveLang(): string {
  let lang = '';
  try {
    lang = chrome.i18n?.getUILanguage?.() ?? '';
  } catch {
    /* SW / 測試環境容錯 */
  }
  if (!lang && typeof navigator !== 'undefined') lang = navigator.language;
  const l = (lang || 'en').toLowerCase();
  if (l.startsWith('zh')) {
    return l.includes('tw') || l.includes('hk') || l.includes('mo') || l.includes('hant') ? 'zh-TW' : 'zh-CN';
  }
  if (l.startsWith('pt')) return 'pt-BR';
  const base = l.split('-')[0] ?? 'en';
  return base in LOCALES ? base : 'en';
}

/** 語言選單用：id + 原生語言名稱（原生名稱不需要翻譯） */
export const LOCALE_OPTIONS: { id: string; native: string }[] = [
  { id: 'auto', native: 'Auto' },
  { id: 'en', native: 'English' },
  { id: 'zh-TW', native: '繁體中文' },
  { id: 'zh-CN', native: '简体中文' },
  { id: 'ja', native: '日本語' },
  { id: 'ko', native: '한국어' },
  { id: 'es', native: 'Español' },
  { id: 'ru', native: 'Русский' },
  { id: 'pt-BR', native: 'Português (BR)' },
];

let active: Partial<Record<DictKey, string>> = LOCALES[resolveLang()] ?? en;

/** 切換語言；'auto' 或空 = 跟隨瀏覽器。呼叫端負責觸發重渲染（localeRev++）。 */
export function setLocale(pref: string): void {
  const lang = !pref || pref === 'auto' ? resolveLang() : pref;
  active = LOCALES[lang] ?? LOCALES[resolveLang()] ?? en;
}

/** 取字串並替換 {0}/{1}… 參數；缺譯自動回退英文，再缺回 key 本身（永不 throw） */
export function t(key: DictKey, ...args: (string | number)[]): string {
  let s: string = active[key] ?? en[key] ?? String(key);
  for (let i = 0; i < args.length; i++) {
    s = s.replaceAll(`{${i}}`, String(args[i]));
  }
  return s;
}

/** 錯誤碼 → 使用者可讀的在地化訊息 */
export function errorMessage(code: ErrCode): string {
  return t(`err_${code}` as DictKey);
}
