/**
 * Background service worker：
 * - 建立／路由右鍵選單與快捷鍵（含「預覽後選取儲存」與影音子選單）
 * - 宿主 ClipOrchestrator（擷取→匯出→儲存→通知）
 * - 處理 popup / options / preview 的請求（Drive、AI Desktop、預覽擷取與存檔）
 * - 廣播進度給 popup、顯示系統通知
 *
 * 容錯：所有 handler 例外都被 bus 序列化回報；選單/通知/可見性更新失敗一律 swallow。
 */
import { defineBackground } from '#imports';
import { broadcastToPopup, registerHandlers } from '@/messaging/bus';
import { t, setLocale } from '@/shared/i18n';
import { createLogger, installGlobalErrorLogging } from '@/shared/logger';
import { loadSettings } from '@/shared/settings';
import type { CaptureScope } from '@/core/capture/ContentSource';
import type { ClipRequest, ClipSnapshot, LinkedFolder } from '@/messaging/protocol';
import { ClipOrchestrator, type ClipNotification } from '@/core/orchestrator/ClipOrchestrator';
import { probeYouTube, isYouTubeUrl } from '@/core/capture/youtube/captureYouTube';
import { isVideoSite } from '@/core/capture/videoSites';
import { getHistoryEntry, loadHistory } from '@/core/orchestrator/ClipJob';
import { DriveAuth, DRIVE_CLIENT_ID_SECRET } from '@/core/auth/DriveAuth';
import { clearSecret, loadSecret, saveSecret } from '@/shared/secrets';
import {
  createLinkedFolder,
  ensureHostPermission,
  fetchLinkedFolders,
  normalizeBaseUrl,
  probeHealth,
} from '@/core/aidesktop/AiDesktopClient';

const log = createLogger('bg');

const MENU = {
  default: 'squirl-clip-default',
  preview: 'squirl-preview',
  parent: 'squirl-clip-as',
  md: 'squirl-fmt-md',
  txt: 'squirl-fmt-txt',
  pdf: 'squirl-fmt-pdf',
  subtitle: 'squirl-fmt-subtitle',
  videoParent: 'squirl-video',
  videoPageSubs: 'squirl-video-page',
  videoSubsOnly: 'squirl-video-subs',
  videoPanel: 'squirl-video-panel',
} as const;

export default defineBackground(() => {
  installGlobalErrorLogging('bg');
  void loadSettings().then((s) => setLocale(s.ui.language || 'auto')).catch(() => {});

  const orchestrator = new ClipOrchestrator({
    emit: (s: ClipSnapshot) => broadcastToPopup('clip/update', s),
    notify: showNotification,
  });

  // ---- 選單建立 ----
  chrome.runtime.onInstalled.addListener(() => void rebuildMenus());
  chrome.runtime.onStartup.addListener(() => void rebuildMenus());

  // 依目前分頁網址切換「影音子選單」可見性（只在影音站顯示，避免一般頁面雜亂）
  chrome.tabs.onActivated.addListener(({ tabId }) => void refreshContextForTabId(tabId));
  chrome.tabs.onUpdated.addListener((_id, info, tab) => {
    if (info.status === 'complete' || info.url) void refreshContextForUrl(tab?.url);
  });

  chrome.contextMenus.onClicked.addListener((info, tab) => {
    if (!tab?.id) return;
    const scope: CaptureScope = info.selectionText ? 'selection' : 'page';
    switch (info.menuItemId) {
      case MENU.default:
        void orchestrator.run({ tabId: tab.id, scope });
        return;
      case MENU.md:
        void orchestrator.run({ tabId: tab.id, scope, format: 'md' });
        return;
      case MENU.txt:
        void orchestrator.run({ tabId: tab.id, scope, format: 'txt' });
        return;
      case MENU.pdf:
        void orchestrator.run({ tabId: tab.id, scope, format: 'pdf' });
        return;
      case MENU.subtitle:
        void orchestrator.run({ tabId: tab.id, scope, format: 'subtitle' });
        return;
      case MENU.videoPageSubs:
        void orchestrator.run({ tabId: tab.id, scope: 'page', subtitles: true });
        return;
      case MENU.videoSubsOnly:
        void orchestrator.run({ tabId: tab.id, scope: 'page', format: 'subtitle' });
        return;
      case MENU.preview:
        openPreview(tab.id, scope, 'web');
        return;
      case MENU.videoPanel:
        openPreview(tab.id, 'page', 'video');
        return;
      default:
        return;
    }
  });

  // ---- 快捷鍵 ----
  chrome.commands?.onCommand.addListener((command) => {
    if (command !== 'clip-page') return;
    void clipActiveTab(orchestrator);
  });

  // ---- 通知按鈕（在 Drive 開啟） ----
  chrome.notifications?.onButtonClicked.addListener((notifId) => {
    const link = pendingLinks.get(notifId);
    if (link) {
      void chrome.tabs.create({ url: link });
      pendingLinks.delete(notifId);
    }
  });

  // ---- popup 開啟偵測（presence port）----
  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== 'squirl-popup') return;
    popupOpen = true;
    port.onDisconnect.addListener(() => { popupOpen = false; void chrome.runtime.lastError; });
  });

  // ---- 訊息處理 ----
  registerHandlers('background', {
    'clip/run': async (req) => ({ id: await orchestrator.run(req) }),
    'clip/retry': async ({ id }) => {
      const entry = await getHistoryEntry(id);
      if (!entry) return { id };
      return { id: await orchestrator.run(entry.request) };
    },
    'history/list': async () => (await loadHistory()).map((e) => e.snapshot),
    'yt/probe': async ({ tabId }) => probeYouTube(tabId),
    'ui/applyLocale': async ({ lang }) => { setLocale(lang || 'auto'); await rebuildMenus(); },

    // 預覽頁：先擷取（不儲存），再以選取後結果存檔
    'preview/capture': async ({ tabId, scope }) => orchestrator.capture({ tabId, scope }),
    'preview/save': async ({ result, sourceTabId, format, tags, project, video, subtitles }) => {
      const req: ClipRequest = { tabId: sourceTabId, scope: 'page', format, tags, project, video, subtitles };
      return { id: await orchestrator.runWithResult(req, result) };
    },

    'drive/connect': async () => {
      const auth = new DriveAuth();
      await auth.getToken(true);
      return { email: await auth.getEmail() };
    },
    'drive/status': async () => {
      const auth = new DriveAuth();
      const mode = await auth.mode();
      const customId = await loadSecret(DRIVE_CLIENT_ID_SECRET);
      let connected = false;
      try {
        await auth.getToken(false);
        connected = true;
      } catch {
        connected = false;
      }
      return {
        configured: mode !== 'none',
        connected,
        email: await auth.getEmail(),
        hasCustomId: !!customId,
        customTail: customId ? customId.slice(0, 6) + '…' : null,
      };
    },
    'drive/setClientId': async ({ clientId }) => {
      if (clientId && clientId.trim()) await saveSecret(DRIVE_CLIENT_ID_SECRET, clientId.trim());
      else await clearSecret(DRIVE_CLIENT_ID_SECRET);
    },

    'aidesktop/health': async ({ baseUrl }) => {
      const url = normalizeBaseUrl(baseUrl);
      if (!url) return { ok: false, detail: t('aiBadUrl') };
      const perm = await ensureHostPermission(url);
      if (!perm.ok) return { ok: false, detail: `${t('aiNoPerm')}（${perm.reason}）` };
      const probe = await probeHealth(url);
      return probe.ok ? { ok: true, detail: url } : { ok: false, detail: `${probe.kind}: ${probe.detail}` };
    },
    'aidesktop/folders': async ({ baseUrl }) => {
      const url = normalizeBaseUrl(baseUrl);
      if (!url) throw new Error('網址格式無效');
      await ensureHostPermission(url);
      const token = await new DriveAuth().getToken(true);
      const res = await fetchLinkedFolders(url, token);
      return res as { email: string; folders: LinkedFolder[] };
    },
    'aidesktop/createFolder': async ({ baseUrl, name }) => {
      const url = normalizeBaseUrl(baseUrl);
      if (!url) throw new Error('網址格式無效');
      await ensureHostPermission(url);
      const token = await new DriveAuth().getToken(true);
      return createLinkedFolder(url, token, name);
    },
  });

  log.info('background ready');
});

const pendingLinks = new Map<string, string>();
/** popup 是否開啟：開啟時改由 popup 內 toast 顯示，背景略過系統通知（避免原生彈窗）。 */
let popupOpen = false;

function openPreview(tabId: number, scope: CaptureScope, mode: 'web' | 'video'): void {
  try {
    const url = chrome.runtime.getURL(`preview.html?tabId=${tabId}&scope=${scope}&mode=${mode}`);
    void chrome.tabs.create({ url });
  } catch (e) {
    log.warn('openPreview failed', e);
  }
}

async function rebuildMenus(): Promise<void> {
  try {
    const s = await loadSettings();
    setLocale(s.ui.language || 'auto');
    await new Promise<void>((r) => chrome.contextMenus.removeAll(() => r()));
    const contexts: chrome.contextMenus.CreateProperties['contexts'] = ['page', 'selection', 'link', 'image', 'video'];

    chrome.contextMenus.create({ id: MENU.default, title: t('menu_clipToDrive'), contexts });
    chrome.contextMenus.create({ id: MENU.preview, title: t('menu_preview'), contexts: ['page', 'selection'] });

    chrome.contextMenus.create({ id: MENU.parent, title: t('menu_clipAs'), contexts });
    chrome.contextMenus.create({ id: MENU.md, parentId: MENU.parent, title: t('menu_md'), contexts });
    chrome.contextMenus.create({ id: MENU.txt, parentId: MENU.parent, title: t('menu_txt'), contexts });
    chrome.contextMenus.create({ id: MENU.pdf, parentId: MENU.parent, title: t('menu_pdf'), contexts });
    chrome.contextMenus.create({ id: MENU.subtitle, parentId: MENU.parent, title: t('menu_subtitle'), contexts });

    // 影音子選單：預設隱藏，依目前分頁是否為影音站再切換顯示
    chrome.contextMenus.create({ id: MENU.videoParent, title: t('menu_video'), contexts, visible: false });
    chrome.contextMenus.create({ id: MENU.videoPanel, parentId: MENU.videoParent, title: t('menu_videoPanel'), contexts });
    chrome.contextMenus.create({ id: MENU.videoPageSubs, parentId: MENU.videoParent, title: t('menu_videoPageSubs'), contexts });
    chrome.contextMenus.create({ id: MENU.videoSubsOnly, parentId: MENU.videoParent, title: t('menu_videoSubsOnly'), contexts });

    // 套用目前作用中分頁的可見性
    const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
    setVideoMenuVisible(isVideoSite(active?.url) || isYouTubeUrl(active?.url ?? ''));
  } catch (e) {
    log.warn('rebuildMenus failed', e);
  }
}

function setVideoMenuVisible(visible: boolean): void {
  try {
    chrome.contextMenus.update(MENU.videoParent, { visible }, () => void chrome.runtime.lastError);
  } catch {
    /* 選單尚未建立或 API 不可用：忽略 */
  }
}

function refreshContextForUrl(url: string | undefined): void {
  setVideoMenuVisible(isVideoSite(url) || isYouTubeUrl(url ?? ''));
}

async function refreshContextForTabId(tabId: number): Promise<void> {
  try {
    const tab = await chrome.tabs.get(tabId);
    refreshContextForUrl(tab?.url);
  } catch {
    /* 分頁可能已關閉：忽略 */
  }
}

async function clipActiveTab(orchestrator: ClipOrchestrator): Promise<void> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) await orchestrator.run({ tabId: tab.id, scope: 'page' });
  } catch (e) {
    log.warn('clipActiveTab failed', e);
  }
}

function showNotification(n: ClipNotification): void {
  // popup 開啟時，相同資訊已在 popup 內以 toast/狀態列呈現 → 不再彈系統通知
  if (popupOpen) return;
  try {
    const iconUrl = chrome.runtime.getURL('icon/128.png');
    const titleMap: Record<ClipNotification['kind'], string> = {
      saving: t('notify_saving'),
      saved: t('notify_saved'),
      failed: t('notify_failed'),
      duplicate: t('notify_duplicate'),
    };
    const opts: chrome.notifications.NotificationCreateOptions = {
      type: 'basic',
      iconUrl,
      title: `${titleMap[n.kind]}：${truncate(n.title, 40)}`,
      message: n.message,
    };
    if (n.webViewLink) opts.buttons = [{ title: t('notify_openDrive') }];
    chrome.notifications.create(`squirl-${Date.now()}`, opts, (id) => {
      void chrome.runtime.lastError;
      if (id && n.webViewLink) pendingLinks.set(id, n.webViewLink);
    });
  } catch (e) {
    log.warn('notification failed', e);
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}
