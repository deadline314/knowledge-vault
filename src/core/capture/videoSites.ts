/**
 * 影音網站偵測（給右鍵選單決定是否顯示影音選項）。
 * 可擴充：要支援新站只要把網域加進 VIDEO_HOSTS。
 *
 * 註：YouTube 仍由專屬流程處理；這裡只負責「是否為影音站」的判斷，
 * 一般影音站會以「網頁」方式擷取頁面內容，影片下載僅 YouTube 已支援。
 */

/** 影音網域（不含子網域前綴；以 endsWith 比對，涵蓋 m./www. 等）。 */
export const VIDEO_HOSTS: readonly string[] = [
  'youtube.com',
  'youtu.be',
  'vimeo.com',
  'bilibili.com',
  'twitch.tv',
  'dailymotion.com',
  'nicovideo.jp',
  'ted.com',
  'odysee.com',
  'rumble.com',
];

/** 判斷網址是否為已知影音站。容錯：解析失敗回 false。 */
export function isVideoSite(url: string | undefined | null): boolean {
  if (!url) return false;
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^www\.|^m\./, '');
    return VIDEO_HOSTS.some((h) => host === h || host.endsWith('.' + h));
  } catch {
    return false;
  }
}
