/**
 * Toast（彈出小 widget）的資料型別。純資料，無 UI 相依，方便跨 entrypoint 重用與測試。
 * - 由各 entrypoint 自行持有 ToastItem[] 狀態並渲染 <Toast/>，避免跨樹的全域 runes 依賴。
 * - 文案在「建立當下」就以當前語系解析好存入，元件本身保持 presentational。
 */
export type ToastType = 'error' | 'success' | 'info';

export interface ToastItem {
  /** 單調遞增序號，作為 keyed each 的穩定鍵 */
  id: number;
  type: ToastType;
  /** 一行標題（已在地化） */
  title: string;
  /** 主要訊息（已在地化；可空字串） */
  message: string;
  /** 技術細節（原始錯誤訊息等）；可收合，預設隱藏 */
  detail?: string;
  /** 行動引導（已在地化） */
  hint?: string;
  /** 錯誤碼，純供除錯/複製用 */
  code?: string;
  /** 「複製」按鈕要複製的完整文字；省略則複製 title+message */
  copyText?: string;
  /** true=常駐需手動關閉（錯誤）；false=自動消失（成功/資訊） */
  sticky: boolean;
}
