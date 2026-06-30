<script lang="ts">
  import { onMount } from 'svelte';
  import { fade } from 'svelte/transition';
  import { sendToBackground } from '@/messaging/bus';
  import { loadSettings, saveSettings, type AppSettings, type ExportFormat } from '@/shared/settings';
  import { t as rawT, errorMessage as rawErr, setLocale, LOCALE_OPTIONS, type DictKey } from '@/shared/i18n';
  import type { ClipSnapshot, Envelope, LinkedFolder } from '@/messaging/protocol';
  import Toast from '@/components/Toast.svelte';
  import type { ToastItem, ToastType } from '@/components/toast';
  import { describeError, errorCopyText } from '@/shared/errorDetail';
  import type { YtProbe } from '@/core/capture/youtube/captureYouTube';

  // ---- i18n（localeRev 觸發重渲染） ----
  let localeRev = $state(0);
  const t = (k: DictKey, ...a: (string | number)[]) => { void localeRev; return rawT(k, ...a); };
  const em = (c: Parameters<typeof rawErr>[0]) => { void localeRev; return rawErr(c); };

  type PageType = 'youtube' | 'webpage' | 'restricted' | 'unknown';
  let view = $state<'main' | 'settings'>('main');

  let settings = $state<AppSettings | null>(null);
  let tabId = $state<number | null>(null);
  let pageType = $state<PageType>('unknown');
  let pageTitle = $state('');

  let format = $state<ExportFormat>('md');
  let saveSubtitles = $state(true);
  let saveVideo = $state(false);
  let subtitleLang = $state(''); // 使用者在 popup 選的字幕語言（空=用設定偏好）
  let selectedItag = $state<number | null>(null);
  let probe = $state<YtProbe | null>(null);
  let probing = $state(false);
  let probeFailed = $state(false);

  let advanced = $state(false);
  let tags = $state('');
  let project = $state('');

  let current = $state<ClipSnapshot | null>(null);
  let history = $state<ClipSnapshot[]>([]);
  let busy = $state(false);
  let showHistory = $state(false);

  // ---- 設定子狀態 ----
  let driveStatus = $state<{ configured: boolean; connected: boolean; email: string | null; hasCustomId: boolean; customTail: string | null } | null>(null);
  let clientIdInput = $state('');
  let aiHealth = $state('');
  let folders = $state<LinkedFolder[]>([]);
  let newFolderName = $state('');
  let langsInput = $state('');
  let saveNote = $state('');

  // ---- Toast（彈出小 widget）----
  let toasts = $state<ToastItem[]>([]);
  let toastSeq = 0;
  let lastErrToastId = '';
  function dismissToast(id: number) { toasts = toasts.filter((x) => x.id !== id); }
  function pushToast(item: Omit<ToastItem, 'id'>) {
    const id = ++toastSeq;
    const next = [...toasts, { ...item, id }];
    toasts = next.length > 4 ? next.slice(-4) : next; // 上限 4 則，控記憶體
    if (!item.sticky) setTimeout(() => dismissToast(id), 4000);
  }
  function showError(e: unknown, title: string) {
    const d = describeError(e);
    pushToast({ type: 'error', title, message: d.message, detail: d.detail || undefined, hint: d.hint || undefined, code: d.code, copyText: errorCopyText(d), sticky: true });
  }
  function showOk(title: string) { pushToast({ type: 'success' as ToastType, title, message: '', sticky: false }); }

  const FORMATS: ExportFormat[] = ['md', 'txt', 'pdf'];
  const driveOn = $derived(!!settings && settings.drive.authEnabled && (settings.drive.uploadToDrive || settings.aiDesktop.enabled));
  const driveLabel = $derived(
    !driveStatus ? '—' : driveStatus.connected ? t('driveConnected') : driveStatus.configured ? t('driveConfigured') : t('driveNotConfigured'),
  );

  function phaseLabel(p: string): string {
    return t(`phase_${p}` as DictKey);
  }
  function fmtLabel(f: ExportFormat): string {
    return f === 'md' ? t('fmtMarkdown') : f === 'txt' ? t('fmtText') : t('fmtPdf');
  }

  onMount(async () => {
    try {
      settings = await loadSettings();
      setLocale(settings.ui.language || 'auto');
      localeRev++;
      format = settings.export.defaultFormat;
      saveSubtitles = settings.youtube.saveSubtitles;
      langsInput = settings.youtube.preferredLangs.join(', ');
    } catch { /* 用預設 */ }

    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      tabId = tab?.id ?? null;
      pageTitle = tab?.title ?? '';
      pageType = classify(tab?.url ?? '');
    } catch { pageType = 'unknown'; }

    if (pageType === 'youtube' && tabId != null) void runProbe();
    await refreshHistory();
    void refreshDrive();

    // 通知背景 popup 已開啟（背景據此抑制系統通知，改由此處 toast 顯示）
    try { chrome.runtime.connect({ name: 'squirl-popup' }); } catch { /* 忽略 */ }

    chrome.runtime.onMessage.addListener((raw: unknown) => {
      const env = raw as Envelope;
      if (env?.__squirl && env.target === 'popup' && env.type === 'clip/update') {
        const s = env.payload as ClipSnapshot;
        current = s;
        if (s.phase === 'done' || s.phase === 'error') { busy = false; void refreshHistory(); }
        if (s.phase === 'error' && s.error && lastErrToastId !== s.id) {
          lastErrToastId = s.id;
          showError(s.error, `${t('clipFailTitle')}${s.title ? ' — ' + s.title : ''}`);
        }
      }
      return false;
    });
  });

  function classify(url: string): PageType {
    if (!url || /^(chrome|edge|about|chrome-extension|view-source):/.test(url)) return 'restricted';
    try {
      const h = new URL(url).hostname.replace(/^www\.|^m\./, '');
      if (h === 'youtu.be' || (h === 'youtube.com' && /\/(watch|shorts)/.test(new URL(url).pathname))) return 'youtube';
    } catch { return 'unknown'; }
    return 'webpage';
  }

  async function runProbe() {
    if (tabId == null) return;
    probing = true; probeFailed = false;
    try {
      probe = await sendToBackground('yt/probe', { tabId });
      if (probe.title) pageTitle = probe.title;
      selectedItag = probe.variants[0]?.itag ?? null;
      subtitleLang = defaultSubLang(probe.captionLangs);
    } catch { probe = null; probeFailed = true; }
    finally { probing = false; }
  }

  // 影片可用字幕語言（去重；同語言保留先出現者＝人工優先），供下拉選單
  const captionOptions = $derived.by(() => {
    void localeRev;
    const seen = new Set<string>();
    const out: { lang: string; label: string }[] = [];
    for (const c of probe?.captionLangs ?? []) {
      if (seen.has(c.lang)) continue;
      seen.add(c.lang);
      out.push({ lang: c.lang, label: c.name + (c.auto ? ` · ${t('captionsAuto')}` : '') });
    }
    return out;
  });
  function defaultSubLang(langs: { lang: string; name: string; auto: boolean }[]): string {
    if (!langs.length) return '';
    const pref = [...(settings?.youtube.preferredLangs ?? []), (navigator.language || 'en').split('-')[0]];
    for (const p of pref) {
      if (!p) continue;
      const hit = langs.find((c) => c.lang.toLowerCase().startsWith(p.toLowerCase()));
      if (hit) return hit.lang;
    }
    return langs[0]!.lang;
  }

  async function clip(fmtOverride: ExportFormat | 'subtitle' | undefined = undefined) {
    if (tabId == null) return;
    busy = true;
    current = { id: 'pending', url: '', title: pageTitle, phase: 'queued', detail: t('loading'), progress: 0, webViewLink: null, duplicate: false, error: null, at: Date.now() };
    const video = pageType === 'youtube' && saveVideo && selectedItag != null
      ? { itag: selectedItag, label: probe?.variants.find((v) => v.itag === selectedItag)?.label ?? '' }
      : null;
    try {
      await sendToBackground('clip/run', {
        tabId, scope: 'page',
        format: fmtOverride ?? format,
        subtitles: pageType === 'youtube' ? saveSubtitles : undefined,
        subtitleLangs: pageType === 'youtube' && subtitleLang ? [subtitleLang] : undefined,
        video,
        tags: tags.split(',').map((x) => x.trim()).filter(Boolean),
        project: project.trim() || null,
      });
    } catch (e) {
      busy = false;
      current = { id: 'x', url: '', title: '', phase: 'error', detail: '', progress: 0, webViewLink: null, duplicate: false, error: { code: 'UNKNOWN', message: String(e) }, at: Date.now() };
    }
  }

  async function refreshHistory() {
    try { history = (await sendToBackground('history/list', undefined)).slice(0, 6); } catch { /* ignore */ }
  }
  async function retry(id: string) { busy = true; try { await sendToBackground('clip/retry', { id }); } catch { busy = false; } }
  function fmtBytes(n: number | undefined = undefined): string {
    if (!n) return '';
    return n >= 1e9 ? (n / 1e9).toFixed(1) + ' GB' : n >= 1e6 ? Math.round(n / 1e6) + ' MB' : Math.round(n / 1e3) + ' KB';
  }

  // ---- 設定操作 ----
  async function persist() {
    if (!settings) return;
    settings.youtube.preferredLangs = langsInput.split(',').map((x) => x.trim()).filter(Boolean);
    await saveSettings($state.snapshot(settings));
    saveNote = t('saved');
    setTimeout(() => (saveNote = ''), 1400);
  }
  async function changeLanguage() {
    if (!settings) return;
    setLocale(settings.ui.language || 'auto');
    localeRev++;
    await persist();
    void sendToBackground('ui/applyLocale', { lang: settings.ui.language || 'auto' }).catch(() => {});
  }
  async function refreshDrive() { try { driveStatus = await sendToBackground('drive/status', undefined); } catch { /* ignore */ } }
  async function saveClientId() { await sendToBackground('drive/setClientId', { clientId: clientIdInput.trim() || null }); clientIdInput = ''; await refreshDrive(); }
  async function connectDrive() { try { await sendToBackground('drive/connect', undefined); showOk(t('driveConnected')); } catch (e) { showError(e, t('actConnectFail')); } await refreshDrive(); }
  async function checkHealth() {
    if (!settings) return;
    aiHealth = t('loading');
    try { const r = await sendToBackground('aidesktop/health', { baseUrl: settings.aiDesktop.baseUrl }); aiHealth = r.ok ? t('aiOk') : '✗ ' + r.detail; }
    catch (e) { aiHealth = '✗ ' + e; }
  }
  async function loadFolders() {
    if (!settings) return;
    try { const r = await sendToBackground('aidesktop/folders', { baseUrl: settings.aiDesktop.baseUrl }); folders = r.folders; } catch (e) { showError(e, t('actLoadFail')); }
  }
  async function createFolder() {
    if (!settings || !newFolderName.trim()) return;
    try { const f = await sendToBackground('aidesktop/createFolder', { baseUrl: settings.aiDesktop.baseUrl, name: newFolderName.trim() }); folders = [...folders, f]; selectFolder(f); newFolderName = ''; }
    catch (e) { showError(e, t('actCreateFail')); }
  }
  function selectFolder(f: LinkedFolder) { if (!settings) return; settings.aiDesktop.folderId = f.folder_id; settings.aiDesktop.folderName = f.folder_name; settings.aiDesktop.kbName = f.kb_name; }
  function onFolderChange(e: Event) { const f = folders.find((x) => x.folder_id === (e.target as HTMLSelectElement).value); if (f) { selectFolder(f); void persist(); } }

  function openSettings() { view = 'settings'; void refreshDrive(); }

  const TYPE_LABEL = $derived<Record<PageType, string>>({ youtube: t('typeYouTube'), webpage: t('typeWebpage'), restricted: t('typeRestricted'), unknown: t('typeWebpage') });
  const TYPE_ICON: Record<PageType, string> = { youtube: '▶', webpage: '🗎', restricted: '🚫', unknown: '🗎' };
</script>

<main>
  <header>
    <div class="brand"><span class="logo">🐿️</span><span class="name">{view === 'settings' ? t('settingsTitle') : 'Squirl'}</span></div>
    {#if view === 'main'}
      <button class="icon-btn" onclick={openSettings} title={t('settingsTitle')} aria-label={t('settingsTitle')}>⚙</button>
    {:else}
      <button class="icon-btn" onclick={() => (view = 'main')} title={t('back')} aria-label={t('back')}>←</button>
    {/if}
  </header>

  {#if view === 'settings'}
    <!-- ===== 設定（內嵌於 popup） ===== -->
    <section class="settings" transition:fade={{ duration: 120 }}>
      {#if settings}
        <details class="card guide" open>
          <summary><b>{t('guideTitle')}</b></summary>
          <div class="body">
            <ol class="steps"><li>{t('guide1')}</li><li>{t('guide2')}</li><li>{t('guide3')}</li></ol>
            <p class="hint">{t('guideHint')}</p>
          </div>
        </details>

        <div class="card">
          <h2>{t('secLanguage')}</h2>
          <select class="wide" bind:value={settings.ui.language} onchange={changeLanguage}>
            {#each LOCALE_OPTIONS as o (o.id)}
              <option value={o.id}>{o.id === 'auto' ? t('langAuto') : o.native}</option>
            {/each}
          </select>
        </div>

        <div class="card">
          <h2>{t('secExport')}</h2>
          <label class="row-label">{t('defaultFormat')}
            <select bind:value={settings.export.defaultFormat} onchange={persist}>
              <option value="md">{t('fmtMarkdown')}</option>
              <option value="txt">{t('fmtText')}</option>
              <option value="pdf">{t('fmtPdf')}</option>
            </select>
          </label>
          <p class="hint">{t('pdfNote')}</p>
          <label class="cb"><input type="checkbox" bind:checked={settings.export.includeImages} onchange={persist} /> {t('includeImages')}</label>
          <label class="cb"><input type="checkbox" bind:checked={settings.export.writeSidecar} onchange={persist} /> {t('writeSidecar')}</label>
        </div>

        <div class="card">
          <h2>{t('secYouTube')}</h2>
          <label class="cb"><input type="checkbox" bind:checked={settings.youtube.saveSubtitles} onchange={persist} /> {t('trySaveSubs')}</label>
          <label class="row-label">{t('preferLangs')}<input bind:value={langsInput} placeholder="zh-Hant, en" onblur={persist} /></label>
          <label class="row-label">{t('subFormat')}
            <select bind:value={settings.youtube.subtitleFormat} onchange={persist}><option value="srt">SRT</option><option value="vtt">VTT</option></select>
          </label>
          <label class="cb"><input type="checkbox" bind:checked={settings.youtube.captionsIntoSidecar} onchange={persist} /> {t('capsIntoSidecar')}</label>
          <p class="hint">{t('videoNote')}</p>
        </div>

        <details class="card">
          <summary><b>{t('secDrive')}</b><span class="badge">{driveLabel}</span></summary>
          <div class="body">
            <label class="cb"><input type="checkbox" bind:checked={settings.drive.authEnabled} onchange={persist} /> {t('enableDrive')}</label>
            {#if settings.drive.authEnabled}
              <label class="cb"><input type="checkbox" bind:checked={settings.drive.uploadToDrive} onchange={persist} /> {t('uploadDrive')}</label>
              <label class="row-label">{t('subfolder')}<input bind:value={settings.drive.subfolder} onblur={persist} /></label>
              <div class="status-line">{driveLabel}{#if driveStatus?.email} · {driveStatus.email}{/if}</div>
              <div class="srow"><input placeholder={t('clientIdPh')} bind:value={clientIdInput} /></div>
              <div class="srow"><button onclick={saveClientId}>{t('saveId')}</button><button onclick={connectDrive}>{t('connect')}</button></div>
              <p class="hint">{t('driveNote')}</p>
            {/if}
          </div>
        </details>

        <details class="card">
          <summary><b>{t('secAi')}</b><span class="badge">{settings.aiDesktop.enabled ? (settings.aiDesktop.folderName || '✓') : '—'}</span></summary>
          <div class="body">
            <label class="cb"><input type="checkbox" bind:checked={settings.aiDesktop.enabled} onchange={persist} /> {t('enableAi')}</label>
            {#if settings.aiDesktop.enabled}
              <p class="hint">{t('aiHint')}</p>
              <label class="row-label">{t('backendUrl')}<input bind:value={settings.aiDesktop.baseUrl} placeholder="https://xxx.a.run.app" onblur={persist} /></label>
              <div class="srow"><button onclick={checkHealth} title={t('tip_testConn')}>{t('testConn')}</button><button onclick={loadFolders} title={t('tip_loadFolders')}>{t('loadFolders')}</button><span class="status-line">{aiHealth}</span></div>
              {#if folders.length}
                <label class="row-label">{t('archiveFolder')}
                  <select onchange={onFolderChange}>
                    <option value="">{t('choosePlaceholder')}</option>
                    {#each folders as f (f.folder_id)}<option value={f.folder_id} selected={f.folder_id === settings.aiDesktop.folderId}>{f.folder_name}（{f.kb_name}）</option>{/each}
                  </select>
                </label>
              {/if}
              <div class="srow"><input placeholder={t('newFolderPh')} bind:value={newFolderName} /><button onclick={createFolder} title={t('tip_createFolder')}>{t('create')}</button></div>
              {#if settings.aiDesktop.folderName}<div class="status-line">{t('currentFolder', settings.aiDesktop.folderName, settings.aiDesktop.kbName)}</div>{/if}
              <label class="cb"><input type="checkbox" bind:checked={settings.aiDesktop.calendarMark} onchange={persist} /> {t('calMark')}</label>
              {#if settings.aiDesktop.calendarMark}<label class="row-label">{t('calMin')}<input type="number" min="1" max="60" bind:value={settings.aiDesktop.calendarDurationMin} onblur={persist} /></label>{/if}
            {/if}
          </div>
        </details>

        <details class="card">
          <summary><b>{t('secCapture')}</b></summary>
          <div class="body">
            <label class="row-label">{t('settleQuiet')}<input type="number" min="100" max="5000" bind:value={settings.capture.settleQuietMs} onblur={persist} /></label>
            <label class="row-label">{t('settleMax')}<input type="number" min="500" max="15000" bind:value={settings.capture.settleMaxMs} onblur={persist} /></label>
            <label class="cb"><input type="checkbox" bind:checked={settings.capture.scrollToLoad} onchange={persist} /> {t('scrollLoad')}</label>
          </div>
        </details>

        {#if saveNote}<div class="save-note" transition:fade={{ duration: 120 }}>{saveNote}</div>{/if}
      {/if}
    </section>

  {:else}
    <!-- ===== 主畫面 ===== -->
    <div class="page-chip {pageType}">
      <span class="ic">{TYPE_ICON[pageType]}</span>
      <span class="meta"><b>{TYPE_LABEL[pageType]}</b><small title={pageTitle}>{pageTitle || '—'}</small></span>
    </div>

    {#if pageType === 'restricted'}
      <p class="hint warn">{t('restrictedHint')}</p>
    {:else}
      <button class="primary" onclick={() => clip()} disabled={busy || tabId == null} title={t('tip_clip')}>
        {busy ? `${current ? phaseLabel(current.phase) : t('loading')}…` : driveOn ? t('clipToDrive') : t('clipToLocal')}
      </button>

      {#if settings && !driveOn}
        <button class="setup-hint" onclick={openSettings}>{t('setupHint')}</button>
      {/if}

      <div class="field">
        <span class="label">{t('formatLabel')}</span>
        <div class="seg">
          {#each FORMATS as f (f)}
            <button class:active={format === f} onclick={() => (format = f)} disabled={busy} title={f === 'md' ? t('tip_md') : f === 'txt' ? t('tip_txt') : t('tip_pdf')}>{fmtLabel(f)}</button>
          {/each}
        </div>
        {#if format === 'pdf'}<small class="hint">{t('pdfHint')}</small>{/if}
      </div>

      {#if pageType === 'youtube'}
        <div class="yt">
          {#if probing}
            <div class="yt-status"><span class="spinner sm"></span> {t('ytReading')}</div>
          {:else if probeFailed}
            <div class="yt-status warn">{t('ytProbeFail')}<button class="mini" onclick={runProbe}>{t('retry')}</button></div>
          {/if}

          <label class="toggle" title={t('tip_subs')}><input type="checkbox" bind:checked={saveSubtitles} disabled={busy} /> {t('dlSubtitles')}
            {#if probe && !probe.captionLangs.length}<small>{t('noSubs')}</small>{/if}
          </label>
          {#if saveSubtitles && captionOptions.length}
            <label class="row-label sub-lang" title={t('subLang')}>{t('subLang')}
              <select bind:value={subtitleLang} disabled={busy}>
                {#each captionOptions as o (o.lang)}<option value={o.lang}>{o.label}</option>{/each}
              </select>
            </label>
          {/if}

          <label class="toggle" title={t('tip_video')}><input type="checkbox" bind:checked={saveVideo} disabled={busy || !(probe && probe.variants.length)} /> {t('dlVideo')}
            {#if probe && !probe.variants.length}<small>{t('noQuality')}</small>{/if}
          </label>
          {#if saveVideo && probe && probe.variants.length}
            <select class="quality" bind:value={selectedItag} disabled={busy}>
              {#each probe.variants as v (v.itag)}
                <option value={v.itag}>{v.label} · {v.ext.toUpperCase()}{v.sizeBytes ? ` · ${fmtBytes(v.sizeBytes)}` : ''}</option>
              {/each}
            </select>
            <small class="hint">{t('qualityHint')}</small>
          {/if}

          <button class="ghost-wide" onclick={() => clip('subtitle')} disabled={busy || !(probe && probe.captionLangs.length)} title={t('tip_onlySubs')}>{t('onlySubs')}</button>
        </div>
      {/if}

      <button class="disclosure" onclick={() => (advanced = !advanced)} title={t('tip_advanced')}>{advanced ? '▾' : '▸'} {t('advanced')}</button>
      {#if advanced}
        <div class="adv">
          <input placeholder={t('tagsPh')} bind:value={tags} disabled={busy} />
          <input placeholder={t('projectPh')} bind:value={project} disabled={busy} />
        </div>
      {/if}
    {/if}

    {#if current}
      <div class="status {current.phase}">
        <div class="status-row">
          {#if current.phase === 'error'}
            <span class="dot error"></span>
            <span class="msg">{current.error ? em(current.error.code) : (current.detail || t('phase_error'))}</span>
          {:else if current.phase === 'done'}
            <span class="dot done"></span>
            <span class="msg">{current.detail || (current.duplicate ? t('doneExists') : t('doneSaved'))}</span>
            {#if current.webViewLink}<a href={current.webViewLink} target="_blank" rel="noreferrer">{t('openDrive')}</a>{/if}
          {:else}
            <span class="spinner"></span>
            <span class="msg"><b>{phaseLabel(current.phase)}</b>{(current.phase === 'storing' || current.phase === 'video') && current.progress > 0 ? ` · ${Math.round(current.progress * 100)}%` : '…'}</span>
          {/if}
        </div>
        {#if (current.phase === 'storing' || current.phase === 'video') && current.progress > 0}
          <div class="bar"><i style="width:{Math.round(current.progress * 100)}%"></i></div>
        {/if}
      </div>
    {/if}

    {#if history.length}
      <button class="disclosure" onclick={() => (showHistory = !showHistory)}>{showHistory ? '▾' : '▸'} {t('recent')}（{history.length}）</button>
      {#if showHistory}
        <section class="history">
          {#each history as h (h.id)}
            <div class="h-item">
              <span class="dot {h.phase}"></span>
              <span class="h-name" title={h.title}>{h.title || h.url || '—'}</span>
              {#if h.phase === 'error'}<button class="mini" onclick={() => retry(h.id)}>{t('retry')}</button>
              {:else if h.webViewLink}<a class="mini" href={h.webViewLink} target="_blank" rel="noreferrer">{t('open')}</a>{/if}
            </div>
          {/each}
        </section>
      {/if}
    {/if}
  {/if}

  <Toast toasts={toasts} rev={localeRev} ondismiss={dismissToast} />
</main>

<style>
  :global(:root) {
    --bg: #faf8f5; --card: #ffffff; --ink: #1f2328; --muted: #6b7280; --line: #ece6df;
    --brand: #7a4f2e; --brand-ink: #f5deb3; --accent: #b9803f; --ok: #2e7d32; --err: #c62828; --hl: #fbf3e6;
  }
  @media (prefers-color-scheme: dark) {
    :global(:root) {
      --bg: #1b1714; --card: #241f1b; --ink: #efe9e2; --muted: #a99e92; --line: #342d27;
      --brand: #caa06a; --brand-ink: #20160d; --accent: #d9a866; --ok: #7bc47f; --err: #ef9a9a; --hl: #2a2118;
    }
  }
  :global(body) { margin: 0; font-family: system-ui, -apple-system, "Noto Sans TC", sans-serif; background: var(--bg); }
  main { width: 320px; padding: 14px; box-sizing: border-box; color: var(--ink); }
  header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; }
  .brand { display: flex; align-items: center; gap: 7px; }
  .logo { font-size: 18px; } .name { font-weight: 700; letter-spacing: .2px; }
  .icon-btn { background: none; border: none; color: var(--muted); font-size: 16px; cursor: pointer; padding: 4px 8px; border-radius: 6px; }
  .icon-btn:hover { background: var(--line); }

  .page-chip { display: flex; align-items: center; gap: 10px; background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 9px 11px; margin-bottom: 12px; }
  .page-chip .ic { width: 26px; height: 26px; border-radius: 7px; background: var(--brand); color: var(--brand-ink); display: grid; place-items: center; font-size: 13px; flex: none; }
  .page-chip.restricted .ic { background: var(--err); color: #fff; }
  .page-chip .meta { display: flex; flex-direction: column; overflow: hidden; }
  .page-chip b { font-size: 12px; } .page-chip small { font-size: 11px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 230px; }

  .primary { width: 100%; padding: 11px; border: none; border-radius: 10px; background: var(--brand); color: var(--brand-ink); font-weight: 700; font-size: 14px; cursor: pointer; transition: filter .15s; }
  .primary:hover:not(:disabled) { filter: brightness(1.07); }
  .primary:disabled { opacity: .55; cursor: default; }
  .setup-hint { width: 100%; margin-top: 8px; padding: 7px 9px; border: 1px dashed var(--line); border-radius: 8px; background: none; color: var(--muted); font-size: 11px; text-align: left; cursor: pointer; line-height: 1.4; }
  .setup-hint:hover { color: var(--accent); border-color: var(--accent); }

  .field { margin-top: 12px; }
  .label { font-size: 11px; color: var(--muted); display: block; margin-bottom: 5px; }
  .seg { display: flex; background: var(--card); border: 1px solid var(--line); border-radius: 9px; padding: 3px; gap: 3px; }
  .seg button { flex: 1; border: none; background: none; color: var(--ink); padding: 6px 0; border-radius: 6px; font-size: 12px; cursor: pointer; }
  .seg button.active { background: var(--brand); color: var(--brand-ink); font-weight: 600; }

  .yt { margin-top: 12px; background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 11px; display: flex; flex-direction: column; gap: 9px; }
  .toggle { display: flex; align-items: center; gap: 8px; font-size: 13px; cursor: pointer; }
  .toggle small { color: var(--muted); font-size: 11px; margin-left: auto; }
  .quality { padding: 7px; border: 1px solid var(--line); border-radius: 7px; background: var(--bg); color: var(--ink); font-size: 12px; }
  .ghost-wide { padding: 8px; border: 1px solid var(--line); border-radius: 8px; background: var(--bg); color: var(--ink); font-size: 12px; cursor: pointer; }
  .ghost-wide:disabled { opacity: .5; cursor: default; }

  .disclosure { width: 100%; text-align: left; background: none; border: none; color: var(--accent); font-size: 12px; cursor: pointer; padding: 10px 2px 4px; }
  .adv { display: flex; flex-direction: column; gap: 7px; margin-top: 4px; }
  .adv input { padding: 8px; border: 1px solid var(--line); border-radius: 7px; background: var(--card); color: var(--ink); font-size: 13px; }

  .status { margin-top: 12px; padding: 9px 11px; border-radius: 9px; font-size: 12px; background: var(--card); border: 1px solid var(--line); }
  .status-row { display: flex; align-items: center; gap: 7px; }
  .status .msg { flex: 1; line-height: 1.4; word-break: break-word; }
  .status .msg b { font-weight: 700; }
  .status.done { border-color: color-mix(in srgb, var(--ok) 45%, var(--line)); }
  .status.error { border-color: color-mix(in srgb, var(--err) 45%, var(--line)); }
  .status a { color: var(--accent); text-decoration: none; white-space: nowrap; }

  .yt-status { display: flex; align-items: center; gap: 7px; font-size: 12px; color: var(--muted); }
  .yt-status.warn { color: var(--err); }
  .spinner.sm { width: 11px; height: 11px; }
  .bar { width: 100%; height: 4px; background: var(--line); border-radius: 4px; overflow: hidden; margin-top: 4px; }
  .bar i { display: block; height: 100%; background: var(--brand); transition: width .2s; }

  .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); flex: none; }
  .dot.done { background: var(--ok); } .dot.error { background: var(--err); }
  .spinner { width: 12px; height: 12px; border: 2px solid var(--line); border-top-color: var(--brand); border-radius: 50%; animation: spin .7s linear infinite; flex: none; }
  @keyframes spin { to { transform: rotate(360deg); } }

  .history { margin-top: 4px; display: flex; flex-direction: column; gap: 2px; }
  .h-item { display: flex; align-items: center; gap: 7px; padding: 4px 2px; font-size: 12px; }
  .h-name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .mini { font-size: 11px; color: var(--accent); background: none; border: none; cursor: pointer; text-decoration: none; }

  .hint { font-size: 11px; color: var(--muted); margin: 2px 0 0; line-height: 1.45; }
  .hint.warn { color: var(--err); }

  /* 設定 */
  .settings { max-height: 460px; overflow: auto; display: flex; flex-direction: column; gap: 10px; }
  .card { background: var(--card); border: 1px solid var(--line); border-radius: 11px; padding: 12px; }
  .card h2 { font-size: 13px; margin: 0 0 9px; color: var(--accent); }
  details.card > summary { cursor: pointer; list-style: none; display: flex; align-items: center; justify-content: space-between; font-size: 13px; }
  details.card > summary::-webkit-details-marker { display: none; }
  details.card > summary::before { content: '▸'; color: var(--accent); margin-right: 7px; font-size: 10px; }
  details.card[open] > summary::before { content: '▾'; }
  details.card > summary b { flex: 1; }
  .badge { font-size: 10px; color: var(--muted); background: var(--bg); border: 1px solid var(--line); border-radius: 20px; padding: 2px 8px; max-width: 120px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .body { margin-top: 11px; }
  .settings label.row-label { display: flex; flex-direction: column; gap: 4px; font-size: 12px; margin-bottom: 9px; color: var(--muted); }
  .settings label.cb { display: flex; flex-direction: row; align-items: center; gap: 8px; font-size: 13px; margin-bottom: 9px; color: var(--ink); }
  .settings input, .settings select { padding: 7px 8px; border: 1px solid var(--line); border-radius: 7px; background: var(--bg); color: var(--ink); font-size: 13px; }
  .settings input[type="checkbox"] { padding: 0; width: 15px; height: 15px; accent-color: var(--brand); flex: none; }
  .settings select.wide { width: 100%; }
  .srow { display: flex; gap: 7px; align-items: center; margin-bottom: 9px; flex-wrap: wrap; }
  .srow input { flex: 1; min-width: 120px; }
  .settings button { padding: 7px 11px; border: 1px solid var(--brand); background: var(--brand); color: var(--brand-ink); border-radius: 7px; cursor: pointer; font-size: 12px; font-weight: 600; }
  .settings button:hover { filter: brightness(1.07); }
  .status-line { font-size: 11px; color: var(--muted); margin-bottom: 6px; word-break: break-all; }
  .save-note { position: sticky; bottom: 0; text-align: center; color: var(--ok); font-weight: 700; font-size: 12px; background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 6px; }
  .guide .steps { margin: 6px 0 4px; padding-left: 18px; }
  .guide .steps li { margin: 3px 0; color: var(--ink); }
</style>
