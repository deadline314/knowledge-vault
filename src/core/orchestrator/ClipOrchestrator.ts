/**
 * 剪存協調器（background）：擷取 → 匯出 → 儲存 → 通知 的狀態機。
 *
 * 容錯鐵則（與設計稿一致）：
 * - 「檔案落地」＝任務成功；AI Desktop ingest 與行事曆只是事後可補的附加動作。
 * - Drive 失敗退本機；ingest 失敗只記 log（後端資料夾同步補處理）。
 * - 單一 job 鎖（per url+format）避免連點重複上傳。
 * - 每階段廣播 snapshot 給 popup，並寫入歷史供重試。
 *
 * 記憶體：Blob 直接交給 StorageTarget 串流；不長期持有擷取結果。
 */
import { loadSettings, type AppSettings, type ExportFormat } from '@/shared/settings';
import { AppError, serializeError } from '@/shared/errors';
import { createLogger } from '@/shared/logger';
import { sendToContent } from '@/messaging/bus';
import type { ClipRequest, ClipSnapshot } from '@/messaging/protocol';
import type { CaptureResult, ContentNode } from '@/core/capture/ContentSource';
import { t, setLocale, errorMessage } from '@/shared/i18n';
import { captureYouTube, isYouTubeUrl } from '@/core/capture/youtube/captureYouTube';
import { ExporterRegistry } from '@/core/export/ExporterRegistry';
import { safeFileName, timestamp, type ExportArtifact } from '@/core/export/Exporter';
import { renderPdfViaOffscreen } from '@/core/export/offscreenPdf';
import { buildSidecar } from '@/core/export/sidecar';
import { DriveTarget } from '@/core/storage/DriveTarget';
import { LocalDownloadTarget } from '@/core/storage/LocalDownloadTarget';
import type { StorageTarget, StoredRef } from '@/core/storage/StorageTarget';
import { DriveAuth } from '@/core/auth/DriveAuth';
import { notifyIngest, type ClipSourceType, type TranscribeRequest } from '@/core/aidesktop/AiDesktopClient';
import {
  isTerminal,
  newSnapshot,
  patchSnapshot,
  upsertHistory,
  type HistoryEntry,
} from './ClipJob';

const log = createLogger('orchestrator');
const VERSION = '1.0.3';

export interface OrchestratorDeps {
  emit: (s: ClipSnapshot) => void;
  notify: (n: ClipNotification) => void;
}

export interface ClipNotification {
  kind: 'saving' | 'saved' | 'failed' | 'duplicate';
  title: string;
  message: string;
  webViewLink?: string | null;
}

export class ClipOrchestrator {
  #exporters = new ExporterRegistry();
  #drive = new DriveTarget();
  #local = new LocalDownloadTarget();
  #locks = new Set<string>();

  constructor(private deps: OrchestratorDeps) {}

  /** 執行一次剪存。回傳 jobId（流程非同步進行，進度走 emit）。 */
  async run(req: ClipRequest): Promise<string> {
    const id = crypto.randomUUID();
    const lockKey = `${req.tabId}:${req.format ?? 'default'}:${req.scope}`;
    if (this.#locks.has(lockKey)) {
      log.info('duplicate click ignored', lockKey);
      return id;
    }
    this.#locks.add(lockKey);
    // 不 await：背景跑完整流程
    void this.#execute(id, req).finally(() => this.#locks.delete(lockKey));
    return id;
  }

  /** 擷取目前分頁內容（給預覽頁先取得內容樹；不儲存）。 */
  async capture(req: ClipRequest): Promise<CaptureResult> {
    return this.#capture(req, await loadSettings());
  }

  /**
   * 用「已擷取（且可能已由使用者在預覽頁過濾選取）」的結果直接匯出＋儲存。
   * 不重新擷取，避免頁面已變動或重複成本；其餘流程（匯出／儲存／通知／影片）與 run() 共用。
   */
  async runWithResult(req: ClipRequest, result: CaptureResult): Promise<string> {
    const id = crypto.randomUUID();
    const lockKey = `preview:${req.tabId}:${req.format ?? 'default'}`;
    if (this.#locks.has(lockKey)) {
      log.info('duplicate preview save ignored', lockKey);
      return id;
    }
    this.#locks.add(lockKey);
    void this.#execute(id, req, async () => result).finally(() => this.#locks.delete(lockKey));
    return id;
  }

  async #execute(id: string, req: ClipRequest, provideResult?: (s: AppSettings) => Promise<CaptureResult>): Promise<void> {
    const settings = await loadSettings();
    setLocale(settings.ui.language || 'auto');
    let snap = newSnapshot(id, '', '');
    const publish = (entry: HistoryEntry) => {
      this.deps.emit(entry.snapshot);
      void upsertHistory(entry);
    };
    // 階段轉換：發給 popup + 寫入歷史
    const update = (patch: Parameters<typeof patchSnapshot>[1]) => {
      snap = patchSnapshot(snap, patch);
      publish({ snapshot: snap, request: req });
    };
    // 進度 tick：只發給 popup，不頻繁寫歷史（避免上傳/下載時大量 storage 寫入）
    const tick = (patch: Parameters<typeof patchSnapshot>[1]) => {
      snap = patchSnapshot(snap, patch);
      this.deps.emit(snap);
    };

    try {
      // 1. 擷取（預覽存檔時 provideResult 直接給現成、已選取的結果，不重新擷取）
      let result: CaptureResult;
      if (provideResult) {
        update({ phase: 'capturing', detail: '套用已選取的內容…' });
        result = await provideResult(settings);
      } else {
        const isYt = req.scope === 'page' && (await this.#isYouTube(req.tabId));
        update({ phase: 'capturing', detail: isYt ? '讀取 YouTube 播放器資料與字幕…' : '擷取頁面內容…' });
        result = await this.#capture(req, settings);
      }
      snap = patchSnapshot(snap, { title: result.title, url: result.url });

      // 2. 匯出
      update({ phase: 'exporting', detail: `產生 ${fmtName(req.format ?? settings.export.defaultFormat)}…` });
      const { primary, attachments, format } = await this.#exportAll(req, result, settings);

      // 3. 儲存（Drive 失敗自動退本機——保證「至少存得到」）
      const dest0 = await this.#pickTarget(settings);
      update({ phase: 'storing', progress: 0, detail: `上傳 ${primary.fileName} 到 ${dest0.target.id === 'drive' ? 'Drive' : '本機'}…` });
      const { target, primaryRef, attachmentRefs, fellBackToLocal } = await this.#store(
        primary,
        attachments,
        settings,
        (f) => tick({ progress: f, detail: `上傳 ${primary.fileName} ${Math.round(f * 100)}%` }),
      );
      if (attachmentRefs.length) update({ detail: `上傳附件（字幕 / sidecar）共 ${attachmentRefs.length} 個…` });

      // 4. 通知 AI Desktop（best-effort，僅真的存進 Drive 時）
      let duplicate = false;
      let transcribeRequested = false;
      if (settings.aiDesktop.enabled && target.id === 'drive') {
        const transcribe = this.#planTranscription(result, req, settings);
        transcribeRequested = !!transcribe;
        update({
          phase: 'notifying',
          detail: transcribe
            ? '通知 AI Desktop 排入知識庫並轉錄逐字稿…'
            : `通知 AI Desktop 排入知識庫「${settings.aiDesktop.kbName || '…'}」`,
        });
        duplicate = await this.#ingest(result, format, primary, primaryRef, attachmentRefs, settings, transcribe);
      }

      // 5. 影片下載（YouTube + 選了畫質）——放最後，全程顯示真實進度
      let videoFile: string | null = null;
      if (req.video && result.kind === 'youtube') {
        update({ phase: 'video', progress: 0, detail: `準備下載影片 ${req.video.label}…` });
        videoFile = await this.#downloadVideoTracked(result, req.video, (f, recv, total) =>
          tick({ progress: f, detail: `下載影片 ${req.video!.label} ${Math.round(f * 100)}%${total ? ` · ${mb(recv)} / ${mb(total)}` : ` · ${mb(recv)}`}` }),
        );
      }

      // 6. 完成
      const savedMsg = fellBackToLocal ? t('done_fellback') : target.id === 'drive' ? t('done_drive') : t('done_local');
      const transcribeNote = transcribeRequested ? ' ' + t('done_transcribe') : '';
      const detail = `${savedMsg}${videoFile ? ' ' + t('done_video', videoFile) : ''}${transcribeNote}`;
      update({ phase: 'done', webViewLink: primaryRef.webViewLink, duplicate, detail });
      this.deps.notify(
        duplicate
          ? { kind: 'duplicate', title: result.title, message: t('notify_dupMsg'), webViewLink: primaryRef.webViewLink }
          : {
              kind: 'saved',
              title: result.title,
              message: savedMsg + (videoFile ? ' ' + t('done_videoDl') : '') + transcribeNote,
              webViewLink: primaryRef.webViewLink,
            },
      );
    } catch (e) {
      const error = serializeError(e);
      log.warn('clip failed', error);
      snap = patchSnapshot(snap, { phase: 'error', error });
      publish({ snapshot: snap, request: req });
      this.deps.notify({ kind: 'failed', title: snap.title || 'Squirl', message: errorMessage(error.code) });
    }
  }

  // ---- 各階段 ----

  async #capture(req: ClipRequest, s: AppSettings): Promise<CaptureResult> {
    // YouTube：用 MAIN-world 注入取得權威播放器資料（content script 隔離世界讀不到）。
    if (req.scope === 'page') {
      const tab = await chrome.tabs.get(req.tabId).catch(() => null);
      const url = tab?.url ?? '';
      if (isYouTubeUrl(url)) {
        try {
          return await captureYouTube(req.tabId, url, {
            saveSubtitles: req.subtitles ?? s.youtube.saveSubtitles,
            preferredLangs: req.subtitleLangs && req.subtitleLangs.length ? req.subtitleLangs : s.youtube.preferredLangs,
          });
        } catch (e) {
          log.warn('YouTube MAIN-world capture failed; falling back to content script', e);
        }
      }
    }
    return this.#captureViaContent(req);
  }

  async #captureViaContent(req: ClipRequest): Promise<CaptureResult> {
    try {
      return await sendToContent(req.tabId, 'content/capture', { scope: req.scope }, 60_000);
    } catch (e) {
      // content script 可能尚未注入（安裝前已開的分頁）→ 注入後重試一次
      if (e instanceof AppError && e.code === 'INJECT_FAILED') {
        await this.#injectContentScript(req.tabId);
        return sendToContent(req.tabId, 'content/capture', { scope: req.scope }, 60_000);
      }
      throw e;
    }
  }

  async #isYouTube(tabId: number): Promise<boolean> {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    return isYouTubeUrl(tab?.url ?? '');
  }

  /**
   * progressive 影片下載（best-effort）：走 chrome.downloads 直接落本機，
   * 不經記憶體、不受 CORS 影響、Chrome 處理重導與 Range。
   * 全程輪詢 downloads.search 回報真實 byte 進度。失敗只記 log，不影響主檔。
   */
  async #downloadVideoTracked(
    result: CaptureResult,
    pick: { itag: number; label: string },
    onProgress: (fraction: number, received: number, total: number) => void,
  ): Promise<string | null> {
    const variant = result.youtube?.video?.find((v) => v.itag === pick.itag) ?? result.youtube?.video?.[0];
    if (!variant?.url) {
      log.warn('no progressive variant url to download');
      return null;
    }
    const fileName = `Squirl/videos/${safeFileName(result.title)}-${variant.label}.${variant.ext}`;
    const fallbackTotal = variant.sizeBytes ?? 0;
    try {
      const downloadId = await new Promise<number>((resolve, reject) => {
        chrome.downloads.download({ url: variant.url!, filename: fileName, conflictAction: 'uniquify', saveAs: false }, (id) => {
          const err = chrome.runtime.lastError;
          if (err || id === undefined) reject(new Error(err?.message ?? 'download failed'));
          else resolve(id);
        });
      });
      await this.#pollDownload(downloadId, fallbackTotal, onProgress);
      log.info('video download complete', fileName);
      return fileName;
    } catch (e) {
      log.warn('video download failed (non-fatal)', e);
      return null;
    }
  }

  /** 輪詢下載進度直到完成 / 中斷；逾時上限避免卡死 */
  async #pollDownload(
    downloadId: number,
    fallbackTotal: number,
    onProgress: (fraction: number, received: number, total: number) => void,
  ): Promise<void> {
    const start = Date.now();
    const MAX_MS = 30 * 60_000; // 30 分鐘保底
    for (;;) {
      const items = await new Promise<chrome.downloads.DownloadItem[]>((resolve) =>
        chrome.downloads.search({ id: downloadId }, (r) => resolve(r ?? [])),
      );
      const it = items[0];
      if (it) {
        const total = it.totalBytes && it.totalBytes > 0 ? it.totalBytes : fallbackTotal;
        const recv = it.bytesReceived ?? 0;
        onProgress(total ? Math.min(1, recv / total) : 0, recv, total);
        if (it.state === 'complete') return;
        if (it.state === 'interrupted') throw new Error(it.error ?? 'download interrupted');
      }
      if (Date.now() - start > MAX_MS) throw new Error('download timeout');
      await sleep(500);
    }
  }

  async #exportAll(
    req: ClipRequest,
    result: CaptureResult,
    s: AppSettings,
  ): Promise<{ primary: ExportArtifact; attachments: ExportArtifact[]; format: string }> {
    const baseName = `${safeFileName(result.title)}-${timestamp()}`;
    const opts = {
      includeImages: s.export.includeImages,
      baseName,
      subtitleFormat: s.youtube.subtitleFormat,
    };

    const requested: ExportFormat | 'subtitle' = req.format ?? s.export.defaultFormat;
    let format: string = requested; // 實際產出的格式（PDF 退回時會變 md）
    const attachments: ExportArtifact[] = [];

    // 影片字幕直接融入主檔（md/txt/pdf）——不另存獨立字幕檔；'subtitle' 格式才輸出字幕本身
    const exportResult = this.#embedCaptions(result, requested);

    // 主檔
    let primary: ExportArtifact;
    if (requested === 'subtitle') {
      // 直接以字幕為主檔（YouTube 專用）
      const subExp = this.#exporters.subtitle()!;
      const subs = await subExp.export(result, opts);
      if (!subs.length) throw new AppError('YT_NO_CAPTIONS', 'no captions to export');
      primary = { ...subs[0]!, role: 'primary' };
      attachments.push(...subs.slice(1));
    } else if (requested === 'pdf') {
      // PDF 在 offscreen 產生（內嵌中文字型）；失敗則退回 Markdown 保證落地
      try {
        const bytes = await renderPdfViaOffscreen(exportResult, baseName);
        primary = {
          blob: new Blob([bytes.buffer as ArrayBuffer], { type: 'application/pdf' }),
          fileName: `${baseName}.pdf`,
          mimeType: 'application/pdf',
          role: 'primary',
        };
      } catch (e) {
        log.warn('PDF 產生失敗，改用 Markdown 保底', serializeError(e));
        const exp = this.#exporters.resolvePrimary('md', exportResult);
        const arts = await exp.export(exportResult, opts);
        if (!arts.length) throw new AppError('EXPORT_FAILED', 'pdf fallback produced no output');
        primary = arts[0]!;
        attachments.push(...arts.slice(1));
        format = 'md';
      }
    } else {
      // md / txt
      const exp = this.#exporters.resolvePrimary(requested, exportResult);
      const arts = await exp.export(exportResult, opts);
      if (!arts.length) throw new AppError('EXPORT_FAILED', 'exporter produced no output');
      primary = arts[0]!;
      attachments.push(...arts.slice(1));
    }

    // 註：影片字幕已融入主檔（見 #embedCaptions），不再另存獨立字幕檔（'subtitle' 格式除外）。

    // sidecar
    if (s.export.writeSidecar) {
      try {
        const subtitleNames = attachments.filter((a) => a.role === 'subtitle').map((a) => a.fileName);
        attachments.push(
          buildSidecar(result, {
            baseName,
            primaryFileName: primary.fileName,
            subtitleFileNames: subtitleNames,
            sidecarFileName: `${baseName}.meta.json`,
            format,
            tags: req.tags ?? [],
            project: req.project ?? null,
            version: VERSION,
            captionsIntoSidecar: s.youtube.captionsIntoSidecar,
          }),
        );
      } catch (e) {
        log.warn('sidecar build failed (non-fatal)', e);
      }
    }

    return { primary, attachments, format };
  }

  /**
   * 影片字幕融入主檔：把可取得的字幕逐字稿接成內容樹的一個章節，
   * 讓 md/txt/pdf 各匯出器自然包含（單一處理點、各格式共用、好維護）。
   * 沒有字幕或為 'subtitle' 格式時原樣返回，不動到原結果。
   */
  #embedCaptions(result: CaptureResult, requested: string): CaptureResult {
    if (result.kind !== 'youtube' || requested === 'subtitle') return result;
    const caps = (result.youtube?.captions ?? []).filter((c) => !!c.text && c.text.trim().length > 0);
    if (!caps.length) return result;
    const children: ContentNode[] = [];
    for (const c of caps) {
      const title = `${c.name} (${c.lang})${c.auto ? ` · ${t('captionsAuto')}` : ''}`;
      children.push({ type: 'section', level: 3, text: title, children: [{ type: 'paragraph', text: c.text!.trim() }] });
    }
    const section: ContentNode = { type: 'section', level: 2, text: t('captionsHeading'), children };
    return { ...result, tree: [...result.tree, section] };
  }

  async #pickTarget(s: AppSettings): Promise<{ target: StorageTarget; ctx: { folderId?: string; folderPath?: string[] } }> {
    const driveConfigured = (await new DriveAuth().mode()) !== 'none';
    const wantDrive = (s.drive.uploadToDrive || s.aiDesktop.enabled) && s.drive.authEnabled && driveConfigured;
    if (wantDrive) {
      if (s.aiDesktop.enabled && s.aiDesktop.folderId) {
        return { target: this.#drive, ctx: { folderId: s.aiDesktop.folderId } };
      }
      return { target: this.#drive, ctx: { folderPath: [s.drive.subfolder] } };
    }
    return { target: this.#local, ctx: { folderPath: [s.drive.subfolder] } };
  }

  /**
   * 儲存主檔 + 附件，Drive 失敗自動退本機。
   * 保證回傳一份可用的 primaryRef（除非連本機都失敗才 throw）。
   */
  async #store(
    primary: ExportArtifact,
    attachments: ExportArtifact[],
    s: AppSettings,
    onProgress: (f: number) => void,
  ): Promise<{ target: StorageTarget; primaryRef: StoredRef; attachmentRefs: { ref: StoredRef; role: 'subtitle' | 'sidecar' }[]; fellBackToLocal: boolean }> {
    const { target, ctx } = await this.#pickTarget(s);
    try {
      const primaryRef = await target.put(primary, ctx, onProgress);
      const attachmentRefs = await this.#putAttachments(target, attachments, ctx);
      return { target, primaryRef, attachmentRefs, fellBackToLocal: false };
    } catch (e) {
      if (target.id !== 'drive') throw e; // 本機就失敗：無處可退，向上回報
      log.warn('Drive store failed — falling back to local download', serializeError(e));
      const localCtx = { folderPath: [s.drive.subfolder] };
      const primaryRef = await this.#local.put(primary, localCtx);
      const attachmentRefs = await this.#putAttachments(this.#local, attachments, localCtx);
      return { target: this.#local, primaryRef, attachmentRefs, fellBackToLocal: true };
    }
  }

  /** 附件（字幕 / sidecar）逐一上傳；失敗只記 log，不影響主檔成功 */
  async #putAttachments(
    target: StorageTarget,
    attachments: ExportArtifact[],
    ctx: { folderId?: string; folderPath?: string[] },
  ): Promise<{ ref: StoredRef; role: 'subtitle' | 'sidecar' }[]> {
    const refs: { ref: StoredRef; role: 'subtitle' | 'sidecar' }[] = [];
    await Promise.all(
      attachments.map(async (a) => {
        try {
          const ref = await target.put(a, ctx);
          if (a.role === 'subtitle' || a.role === 'sidecar') refs.push({ ref, role: a.role });
        } catch (e) {
          log.warn(`attachment upload failed: ${a.fileName}`, e);
        }
      }),
    );
    return refs;
  }

  /**
   * 決定是否請後端轉錄逐字稿。規則：YouTube 影片 + 使用者要內容（字幕或影片）
   * + 我們沒能取得字幕純文字 → 請後端從 source_url 伺服器端轉錄。
   * 字幕已成功取得時不重複轉錄；非 YouTube 不轉錄。回 undefined = 不需轉錄。
   */
  #planTranscription(result: CaptureResult, req: ClipRequest, s: AppSettings): TranscribeRequest | undefined {
    if (result.kind !== 'youtube') return undefined;
    const captionTextSaved = (result.youtube?.captions ?? []).some((c) => !!c.text && c.text.trim().length > 0);
    const wantsContent = (req.subtitles ?? s.youtube.saveSubtitles) || req.video != null;
    if (!wantsContent || captionTextSaved) return undefined;
    return {
      request: true,
      reason: req.video != null ? 'user_requested' : 'captions_blocked',
      langs: s.youtube.preferredLangs,
    };
  }

  /** 通知後端排入 KB（+ 行事曆標記 + 可選轉錄）。回傳是否為重複。 */
  async #ingest(
    result: CaptureResult,
    format: string,
    primary: ExportArtifact,
    primaryRef: StoredRef,
    attachmentRefs: { ref: StoredRef; role: 'subtitle' | 'sidecar' }[],
    s: AppSettings,
    transcribe?: TranscribeRequest,
  ): Promise<boolean> {
    let token: string;
    try {
      token = await this.#drive.getToken();
    } catch (e) {
      log.warn('cannot get drive token for ingest (file already in Drive)', e);
      return false;
    }
    const sourceType: ClipSourceType = result.kind === 'youtube' ? 'youtube_clip' : 'web_clip';
    const outcome = await notifyIngest(s.aiDesktop.baseUrl, token, {
      fileId: primaryRef.id,
      fileName: primary.fileName,
      folderId: primaryRef.folderId,
      mimeType: primary.mimeType,
      sourceType,
      sourceUrl: result.url,
      clippedAt: result.capturedAt,
      calendar: s.aiDesktop.calendarMark
        ? {
            mark: true,
            durationMin: s.aiDesktop.calendarDurationMin,
            titleHint: `📎 Squirl 剪存：${result.title}`,
            kind: 'clip_marker',
          }
        : undefined,
      transcribe,
      attachments: attachmentRefs.map((a) => ({ fileId: a.ref.id, role: a.role })),
    });
    return outcome?.status === 'duplicate';
  }

  async #injectContentScript(tabId: number): Promise<void> {
    try {
      await chrome.scripting.executeScript({ target: { tabId }, files: ['content-scripts/content.js'] });
    } catch (e) {
      throw new AppError('INJECT_FAILED', e instanceof Error ? e.message : String(e));
    }
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function fmtName(f: string): string {
  return f === 'md' ? 'Markdown' : f === 'txt' ? '純文字' : f === 'pdf' ? 'PDF' : f === 'subtitle' ? '字幕' : f;
}

function mb(n: number): string {
  if (!n) return '';
  return n >= 1e9 ? (n / 1e9).toFixed(1) + ' GB' : n >= 1e6 ? Math.round(n / 1e6) + ' MB' : Math.round(n / 1e3) + ' KB';
}

function messageOf(code: string): string {
  // 簡短對應（完整見 shared/errors ERROR_MESSAGES）
  switch (code) {
    case 'RESTRICTED_PAGE':
    case 'INJECT_FAILED':
      return '此頁面不支援剪存。';
    case 'DRIVE_UPLOAD_FAILED':
      return '上傳 Drive 失敗，已保留本機檔案。';
    case 'EMPTY_CONTENT':
      return '這個頁面沒有可擷取的內容。';
    default:
      return '剪存失敗，請重試。';
  }
}
