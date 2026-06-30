/**
 * 背景端 YouTube 擷取。
 *
 * 取資料策略（穩定優先）：
 *  - 用「極小的單行注入函式」在頁面 MAIN world 取回 player response 字串（序列化超穩，
 *    不會像大函式那樣被打包器弄壞——這是先前「讀不到影片資訊」的根因）。
 *  - 解析在 background（playerResponse.ts，純函式）。
 *  - 字幕（含自動生成 ASR）用另一個極小注入函式在頁面同源 fetch timedtext。
 *
 * 容錯：注入失敗 / 取不到 player response → throw YT_PARSE_FAILED，由 orchestrator
 * 退回 content-script 擷取（只存網址＋可見資訊）。
 */
import { AppError } from '@/shared/errors';
import { createLogger } from '@/shared/logger';
import { type CaptureResult, type CaptionTrack, type ContentNode, type VideoVariantInfo, nowIso } from '../ContentSource';
import { type ParsedYt, parseJson3, parsePlayerResponse } from './playerResponse';

const log = createLogger('yt-capture');

export interface YtCaptureOptions {
  saveSubtitles: boolean;
  preferredLangs: string[];
}

export interface YtProbe {
  videoId: string;
  title: string;
  channel: string;
  durationSec: number;
  captionLangs: { lang: string; name: string; auto: boolean }[];
  variants: { itag: number; label: string; ext: string; sizeBytes?: number }[];
}

// ---- 極小注入函式（自包含、單一職責，序列化穩定）----

/**
 * 在頁面 MAIN world 取回 player response 的 JSON 字串。
 *
 * 來源優先序：
 *  1. movie_player.getPlayerResponse()（當前影片）或 window.ytInitialPlayerResponse —— 取 videoDetails/streamingData。
 *  2. 若上述都沒有字幕軌（YouTube 對某些影片就是不把 captions 放進頁面的 player response，
 *     即使有「自動產生」字幕），就改用 InnerTube /youtubei/v1/player API 重新要一份——
 *     這正是 yt-dlp 取得自動字幕的方式。同源、在 MAIN world 可直接 POST。
 *
 * async：因為要 fetch InnerTube。完全自包含（只用頁面全域），可安全序列化注入。
 */
async function injectGetPlayerResponse(): Promise<string | null> {
  try {
    const el = document.getElementById('movie_player') as unknown as { getPlayerResponse?: () => unknown };
    const live: any = el && typeof el.getPlayerResponse === 'function' ? el.getPlayerResponse() : null;
    const init: any = (window as any).ytInitialPlayerResponse ?? null;
    let pr: any = live && (live.videoDetails || live.streamingData) ? live : (init ?? live);
    if (!pr) return null;

    const hasTracks = (p: any) => (p?.captions?.playerCaptionsTracklistRenderer?.captionTracks?.length ?? 0) > 0;

    if (!hasTracks(pr)) {
      const videoId: string = pr?.videoDetails?.videoId || new URLSearchParams(location.search).get('v') || '';
      const cfg: any = (window as any).ytcfg;
      const apiKey: string = cfg?.get?.('INNERTUBE_API_KEY') ?? cfg?.data_?.INNERTUBE_API_KEY ?? '';
      const context = cfg?.get?.('INNERTUBE_CONTEXT') ?? cfg?.data_?.INNERTUBE_CONTEXT;
      if (videoId && apiKey && context) {
        try {
          const res = await fetch(`/youtubei/v1/player?key=${encodeURIComponent(apiKey)}&prettyPrint=false`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ context, videoId, contentCheckOk: true, racyCheckOk: true }),
          });
          if (res.ok) {
            const data: any = await res.json();
            if (data?.captions) pr = { ...pr, captions: data.captions };
            if (!pr.videoDetails && data?.videoDetails) pr = { ...pr, videoDetails: data.videoDetails };
            if (!pr.streamingData && data?.streamingData) pr = { ...pr, streamingData: data.streamingData };
          }
        } catch {
          /* InnerTube 失敗：保留頁面那份 */
        }
      }
    }
    return JSON.stringify(pr);
  } catch {
    return null;
  }
}

interface CaptionFetchTask {
  baseUrl: string;
  lang: string;
  auto: boolean;
}

/**
 * 在頁面 MAIN world 同源抓字幕，回傳「與輸入等長」的 json3 字串陣列（抓不到則為空字串）。
 *
 * 多重來源（依序 fallback，全部正規化成 timedtext json3 格式，讓背景沿用單一 parseJson3）：
 *  1. timedtext &fmt=json3 —— 最快；baseUrl 未被 POT 鎖（無 exp=xpe）時直接成功。
 *  2. InnerTube ANDROID client 重取 player —— ANDROID client 回的 captionTracks 不帶
 *     exp=xpe、不需 POT，是目前最穩定的主力方法（一次 player 請求取得全部語言軌，快取共用）。
 *  3. timedtext &fmt=srv3 / 原始 XML —— 換格式偶可繞過部分限制。
 *  4. InnerTube /youtubei/v1/get_transcript —— 最後保底（自建 protobuf params）。
 *
 * 完全自包含（只用頁面全域：fetch / DOMParser / TextEncoder / btoa / window.ytcfg），
 * 可安全序列化注入。任何一步失敗都吞掉，回退下一步；全失敗則該軌回空字串。
 */
async function injectFetchCaptions(payload: { tasks: CaptionFetchTask[]; videoId: string }): Promise<string[]> {
  const { tasks, videoId } = payload;

  const fetchText = async (url: string): Promise<string> => {
    try {
      const r = await fetch(url);
      if (!r.ok) return '';
      return await r.text();
    } catch {
      return '';
    }
  };
  const setFmt = (u: string, fmt: string): string => u.replace(/&fmt=[^&]*/g, '') + '&fmt=' + fmt;
  const hasEvents = (str: string): boolean => {
    if (!str) return false;
    try {
      const d = JSON.parse(str) as { events?: { segs?: { utf8?: string }[] }[] };
      return (
        Array.isArray(d?.events) &&
        d.events.some((e) => Array.isArray(e?.segs) && e.segs.some((g) => ((g?.utf8 ?? '').trim().length > 0)))
      );
    } catch {
      return false;
    }
  };

  // 字幕 XML（srv3 / 預設 XML：<text start dur>...</text>）→ json3 events
  const xmlToJson3 = (xml: string): string => {
    if (!xml || xml.indexOf('<text') === -1) return '';
    try {
      const doc = new DOMParser().parseFromString(xml, 'text/xml');
      const nodes = Array.from(doc.getElementsByTagName('text'));
      const events = nodes
        .map((n) => {
          const start = parseFloat(n.getAttribute('start') || '0');
          const dur = parseFloat(n.getAttribute('dur') || '0');
          const txt = (n.textContent || '')
            .replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
            .replace(/&lt;/g, '<').replace(/&gt;/g, '>');
          return { tStartMs: Math.round(start * 1000), dDurationMs: Math.round(dur * 1000), segs: [{ utf8: txt }] };
        })
        .filter((e) => (e.segs[0]?.utf8 ?? '').trim().length > 0);
      return events.length ? JSON.stringify({ events }) : '';
    } catch {
      return '';
    }
  };

  // InnerTube get_transcript → json3 events（自建 protobuf params）
  const transcriptToJson3 = async (lang: string): Promise<string> => {
    try {
      const cfg = (window as unknown as { ytcfg?: { get?: (k: string) => unknown; data_?: Record<string, unknown> } }).ytcfg;
      const ctx = cfg?.get?.('INNERTUBE_CONTEXT') ?? cfg?.data_?.['INNERTUBE_CONTEXT'];
      if (!ctx || !videoId) return '';
      const vint = (n: number): number[] => {
        const o: number[] = [];
        let x = n;
        while (x > 127) { o.push((x & 127) | 128); x = Math.floor(x / 128); }
        o.push(x);
        return o;
      };
      const sbytes = (str: string): number[] => Array.from(new TextEncoder().encode(str));
      const lenF = (field: number, b: number[]): number[] => [(field << 3) | 2, ...vint(b.length), ...b];
      const varF = (field: number, n: number): number[] => [(field << 3) | 0, ...vint(n)];
      const b64 = (b: number[]): string => btoa(String.fromCharCode.apply(null, b as unknown as number[]));
      // 內層軌道選擇器：{1:'', 2:lang, 3:''}
      const inner = [...lenF(1, []), ...lenF(2, sbytes(lang)), ...lenF(3, [])];
      const params = b64([
        ...lenF(1, sbytes(videoId)),
        ...lenF(2, sbytes(b64(inner))),
        ...varF(3, 1),
        ...lenF(5, sbytes('engagement-panel-searchable-transcript-search-panel')),
        ...varF(6, 0), ...varF(7, 1), ...varF(8, 0),
      ]);
      const res = await fetch('/youtubei/v1/get_transcript?prettyPrint=false', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ context: ctx, params }),
      });
      if (!res.ok) return '';
      const data = await res.json();
      const findSegs = (x: unknown): any[] | null => {
        if (!x) return null;
        if (Array.isArray(x)) {
          for (const it of x) { const r = findSegs(it); if (r) return r; }
          return null;
        }
        if (typeof x === 'object') {
          const o = x as Record<string, any>;
          if (o.transcriptSegmentListRenderer?.initialSegments) return o.transcriptSegmentListRenderer.initialSegments as any[];
          for (const k in o) { const r = findSegs(o[k]); if (r) return r; }
        }
        return null;
      };
      const segArr = findSegs(data);
      if (!segArr || !segArr.length) return '';
      const events: { tStartMs: number; dDurationMs: number; segs: { utf8: string }[] }[] = [];
      for (const seg of segArr) {
        const r = (seg as { transcriptSegmentRenderer?: any })?.transcriptSegmentRenderer;
        if (!r) continue;
        const txt: string = (r.snippet?.runs || []).map((x: { text?: string }) => x.text ?? '').join('');
        if (!txt.trim()) continue;
        const start = Number(r.startMs ?? 0);
        const end = Number(r.endMs ?? start);
        events.push({ tStartMs: start, dDurationMs: Math.max(0, end - start), segs: [{ utf8: txt }] });
      }
      return events.length ? JSON.stringify({ events }) : '';
    } catch {
      return '';
    }
  };

  // InnerTube ANDROID client 重取 player → 取得「不帶 exp=xpe / 不需 POT」的 captionTracks。
  // 一次請求取回全部語言軌並快取，後續各軌共用，省請求、保速度。
  // 註：client 版本會隨時間被 YouTube 淘汰，集中於此常數方便維護更新。
  const ANDROID_VERSIONS = ['20.10.38', '19.09.37'];
  let androidTracksCache: { baseUrl: string; lang: string; kind?: string }[] | null = null;
  const getAndroidTracks = async (): Promise<{ baseUrl: string; lang: string; kind?: string }[]> => {
    if (androidTracksCache) return androidTracksCache;
    androidTracksCache = [];
    try {
      const cfg = (window as unknown as { ytcfg?: { get?: (k: string) => unknown; data_?: Record<string, unknown> } }).ytcfg;
      const apiKey = (cfg?.get?.('INNERTUBE_API_KEY') ?? cfg?.data_?.['INNERTUBE_API_KEY']) as string | undefined;
      if (!apiKey || !videoId) return androidTracksCache;
      for (const ver of ANDROID_VERSIONS) {
        try {
          const res = await fetch('/youtubei/v1/player?key=' + encodeURIComponent(apiKey) + '&prettyPrint=false', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              context: { client: { clientName: 'ANDROID', clientVersion: ver, androidSdkVersion: 30, hl: 'en', gl: 'US' } },
              videoId, contentCheckOk: true, racyCheckOk: true,
            }),
          });
          if (!res.ok) continue;
          const d = await res.json();
          const raw = d?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
          if (Array.isArray(raw) && raw.length) {
            androidTracksCache = raw
              .filter((t: { baseUrl?: string; languageCode?: string }) => t?.baseUrl && t?.languageCode)
              .map((t: { baseUrl: string; languageCode: string; kind?: string }) => ({ baseUrl: t.baseUrl, lang: t.languageCode, kind: t.kind }));
            break;
          }
        } catch {
          /* 試下一個版本 */
        }
      }
    } catch {
      /* ytcfg 不可用：放棄 ANDROID 路徑 */
    }
    return androidTracksCache;
  };
  const androidJson3 = async (task: CaptionFetchTask): Promise<string> => {
    const at = await getAndroidTracks();
    if (!at.length) return '';
    const want = task.lang.toLowerCase();
    const prefix = want.split('-')[0];
    const hit =
      at.find((t) => t.lang.toLowerCase() === want && (task.auto ? t.kind === 'asr' : t.kind !== 'asr')) ||
      at.find((t) => t.lang.toLowerCase() === want) ||
      at.find((t) => t.lang.toLowerCase().split('-')[0] === prefix) ||
      at[0];
    return hit ? await fetchText(setFmt(hit.baseUrl, 'json3')) : '';
  };

  const out: string[] = [];
  for (const task of tasks) {
    let j = '';
    const locked = /[?&]exp=xpe/.test(task.baseUrl); // 已知被 POT 鎖 → 略過必失敗的直連，省時間
    // 1) timedtext json3（未被鎖時最快）
    if (!locked) {
      j = await fetchText(setFmt(task.baseUrl, 'json3'));
      if (hasEvents(j)) { out.push(j); continue; }
    }
    // 2) ANDROID client（主力：不需 POT）
    j = await androidJson3(task);
    if (hasEvents(j)) { out.push(j); continue; }
    // 3) timedtext srv3 / 原始 XML
    j = xmlToJson3(await fetchText(setFmt(task.baseUrl, 'srv3')));
    if (hasEvents(j)) { out.push(j); continue; }
    j = xmlToJson3(await fetchText(task.baseUrl.replace(/&fmt=[^&]*/g, '')));
    if (hasEvents(j)) { out.push(j); continue; }
    // 4) InnerTube 文字記錄（最後保底）
    j = await transcriptToJson3(task.lang);
    out.push(hasEvents(j) ? j : '');
  }
  return out;
}

async function getPlayerResponse(tabId: number): Promise<unknown> {
  let results: chrome.scripting.InjectionResult<string | null>[];
  try {
    results = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: injectGetPlayerResponse });
  } catch (e) {
    throw new AppError('YT_PARSE_FAILED', e instanceof Error ? e.message : String(e));
  }
  const str = results?.[0]?.result;
  if (!str) return null;
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

async function fetchCaptionTexts(tabId: number, tasks: CaptionFetchTask[], videoId: string): Promise<string[]> {
  if (!tasks.length) return [];
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: injectFetchCaptions,
      args: [{ tasks, videoId }],
    });
    return results?.[0]?.result ?? tasks.map(() => '');
  } catch (e) {
    log.warn('caption fetch injection failed', e);
    return tasks.map(() => '');
  }
}

// ---- 對外 API ----

export async function captureYouTube(tabId: number, url: string, opts: YtCaptureOptions): Promise<CaptureResult> {
  const pr = await getPlayerResponse(tabId);
  const parsed = parsePlayerResponse(pr, { saveSubtitles: opts.saveSubtitles, preferredLangs: opts.preferredLangs, uiLang: navigator.language || 'en' });
  if (!parsed.ok) throw new AppError('YT_PARSE_FAILED', parsed.error ?? 'player response unavailable');

  const warnings: string[] = [];
  const captions: CaptionTrack[] = [];
  if (opts.saveSubtitles) {
    const texts = await fetchCaptionTexts(
      tabId,
      parsed.picked.map((p) => ({ baseUrl: p.baseUrl, lang: p.lang, auto: p.auto })),
      parsed.videoId,
    );
    parsed.picked.forEach((p, i) => {
      const cues = parseJson3(texts[i] ?? '');
      const track: CaptionTrack = { lang: p.lang, name: p.name, auto: p.auto };
      if (cues.length) {
        track.cues = cues;
        track.text = cues.map((c) => c.text).join('\n');
      }
      captions.push(track);
    });
    if (!captions.length || captions.every((c) => !c.text)) {
      warnings.push(
        parsed.allCaptions.length
          ? '字幕被 YouTube 限制無法下載（此片字幕已上鎖；多數影片可正常取得，必要時可改用音訊轉錄）。'
          : '這部影片沒有字幕。',
      );
    }
  }

  const video: VideoVariantInfo[] = parsed.progressive.map((p) => ({
    itag: p.itag,
    label: p.qualityLabel,
    container: p.ext,
    ext: p.ext,
    width: p.width,
    height: p.height,
    sizeBytes: p.sizeBytes,
    hasAudio: true,
    hasVideo: true,
    url: p.url,
  }));

  return {
    kind: 'youtube',
    url: url || (parsed.videoId ? `https://www.youtube.com/watch?v=${parsed.videoId}` : ''),
    title: parsed.title || url,
    capturedAt: nowIso(),
    lang: captions[0]?.lang,
    byline: parsed.channel || undefined,
    excerpt: parsed.description.slice(0, 280) || undefined,
    tree: buildTree(parsed),
    youtube: {
      videoId: parsed.videoId,
      channel: parsed.channel || undefined,
      durationSec: parsed.durationSec || undefined,
      thumbnail: parsed.thumbnail || undefined,
      chapters: parsed.chapters.length ? parsed.chapters : undefined,
      captions,
      video: video.length ? video : undefined,
    },
    warnings: warnings.length ? warnings : undefined,
  };
}

export async function probeYouTube(tabId: number): Promise<YtProbe> {
  const pr = await getPlayerResponse(tabId);
  const parsed = parsePlayerResponse(pr, { saveSubtitles: false, preferredLangs: [], uiLang: navigator.language || 'en' });
  if (!parsed.ok) throw new AppError('YT_PARSE_FAILED', parsed.error ?? 'player response unavailable');
  return {
    videoId: parsed.videoId,
    title: parsed.title,
    channel: parsed.channel,
    durationSec: parsed.durationSec,
    captionLangs: parsed.allCaptions,
    variants: parsed.progressive.map((p) => ({ itag: p.itag, label: p.qualityLabel, ext: p.ext, sizeBytes: p.sizeBytes })),
  };
}

export function isYouTubeUrl(url: string): boolean {
  try {
    const u = new URL(url);
    const h = u.hostname.replace(/^www\.|^m\./, '');
    if (h === 'youtu.be') return true;
    return h === 'youtube.com' && (u.pathname.startsWith('/watch') || u.pathname.startsWith('/shorts/'));
  } catch {
    return false;
  }
}

function buildTree(p: ParsedYt): ContentNode[] {
  const tree: ContentNode[] = [{ type: 'heading', level: 1, text: p.title }];
  if (p.channel) tree.push({ type: 'paragraph', text: `頻道：${p.channel}` });
  if (p.chapters.length) {
    tree.push({ type: 'heading', level: 2, text: '章節' });
    tree.push({ type: 'list', ordered: true, children: p.chapters.map((c) => ({ type: 'listitem', text: `${fmtTime(c.startSec)} ${c.title}` })) });
  }
  if (p.description.trim()) {
    tree.push({ type: 'heading', level: 2, text: '說明' });
    for (const para of p.description.split(/\n{2,}/)) {
      const t = para.trim();
      if (t) tree.push({ type: 'paragraph', text: t });
    }
  }
  return tree;
}

function fmtTime(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}
