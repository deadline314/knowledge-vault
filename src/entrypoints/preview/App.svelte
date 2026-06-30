<script lang="ts">
  import { onMount } from 'svelte';
  import { fade } from 'svelte/transition';
  import { sendToBackground } from '@/messaging/bus';
  import { loadSettings, type ExportFormat } from '@/shared/settings';
  import { t as rawT, errorMessage as rawErr, setLocale, type DictKey } from '@/shared/i18n';
  import type { CaptureResult, ContentNode } from '@/core/capture/ContentSource';
  import type { YtProbe } from '@/core/capture/youtube/captureYouTube';
  import { flatten, filterTree, subtreeIds, type FlatNode } from '@/core/preview/selection';
  import type { ClipSnapshot, Envelope } from '@/messaging/protocol';

  const params = new URLSearchParams(location.search);
  const tabId = Number(params.get('tabId'));
  const scope = (params.get('scope') === 'selection' ? 'selection' : 'page') as 'page' | 'selection';
  const mode = (params.get('mode') === 'video' ? 'video' : 'web') as 'web' | 'video';

  type Phase = 'loading' | 'ready' | 'video' | 'empty' | 'error';
  let phase = $state<Phase>('loading');
  let errMsg = $state('');
  let mounted = $state(false);
  let localeRev = $state(0);
  const t = (k: DictKey, ...a: (string | number)[]) => { void localeRev; return rawT(k, ...a); };
  const em = (c: Parameters<typeof rawErr>[0]) => { void localeRev; return rawErr(c); };

  // ---- 網頁模式 ----
  let result = $state<CaptureResult | null>(null);
  let flat = $state<FlatNode[]>([]);
  let selected = $state<Set<string>>(new Set());
  let collapsed = $state<Set<string>>(new Set());
  let subtreeMap = new Map<string, string[]>();
  let format = $state<ExportFormat>('md');
  let tags = $state('');
  let project = $state('');
  let advanced = $state(false);

  // ---- 影音模式 ----
  let probe = $state<YtProbe | null>(null);
  let saveSubtitles = $state(true);
  let saveVideo = $state(false);
  let selectedItag = $state<number | null>(null);

  // ---- 儲存狀態 ----
  let saving = $state(false);
  let statusText = $state('');
  let statusKind = $state<'idle' | 'busy' | 'done' | 'error'>('idle');
  let savedLink = $state<string | null>(null);

  const FORMATS: ExportFormat[] = ['md', 'txt', 'pdf'];
  const FMT_LABEL: Record<string, string> = { md: 'Markdown', txt: 'Text', pdf: 'PDF' };

  const selectableTotal = $derived(flat.filter((f) => !f.isSection).length);
  const selectedTotal = $derived(flat.filter((f) => !f.isSection && selected.has(f.id)).length);
  const previewNodes = $derived(buildPreview(flat, selected));

  function buildPreview(fs: FlatNode[], sel: Set<string>): { id: string; node: ContentNode }[] {
    const out: { id: string; node: ContentNode }[] = [];
    for (const f of fs) {
      if (sel.has(f.id)) {
        out.push({ id: f.id, node: f.node });
        if (out.length >= 1500) break; // 容錯：極大頁面限制預覽渲染量，保護效能與記憶體
      }
    }
    return out;
  }

  onMount(async () => {
    try {
      const s = await loadSettings();
      setLocale(s.ui.language || 'auto');
      localeRev++;
      format = s.export.defaultFormat;
      saveSubtitles = s.youtube.saveSubtitles;
    } catch { /* 用預設 */ }

    chrome.runtime.onMessage.addListener((raw: unknown) => {
      const env = raw as Envelope;
      if (env?.__squirl && env.target === 'popup' && env.type === 'clip/update') {
        applySnapshot(env.payload as ClipSnapshot);
      }
      return false;
    });

    if (Number.isNaN(tabId)) { phase = 'error'; errMsg = t('pvError'); return; }
    if (mode === 'video') await loadVideo();
    else await loadWeb();
    requestAnimationFrame(() => (mounted = true));
  });

  async function loadWeb() {
    phase = 'loading';
    try {
      const r = await sendToBackground('preview/capture', { tabId, scope }, 60_000);
      if (r.kind === 'youtube' && (!r.tree || r.tree.length === 0)) { await loadVideo(); return; }
      result = r;
      flat = flatten(r.tree);
      selected = new Set(flat.map((f) => f.id));
      subtreeMap = new Map(flat.filter((f) => f.isSection).map((f) => [f.id, subtreeIds(flat, f.id)]));
      phase = flat.length ? 'ready' : 'empty';
    } catch (e) {
      phase = 'error';
      errMsg = errText(e);
    }
  }

  async function loadVideo() {
    phase = 'loading';
    try {
      probe = await sendToBackground('yt/probe', { tabId }, 30_000);
      selectedItag = probe.variants[0]?.itag ?? null;
      phase = 'video';
    } catch {
      phase = 'error';
      errMsg = t('ytProbeFail');
    }
  }

  function errText(e: unknown): string {
    const x = e as { code?: string; message?: string };
    return x?.code ? em(x.code as Parameters<typeof rawErr>[0]) : x?.message || rawT('err_CAPTURE_FAILED');
  }

  // ---- 選取操作 ----
  function toggle(id: string) {
    const n = new Set(selected);
    n.has(id) ? n.delete(id) : n.add(id);
    selected = n;
  }
  function toggleSection(id: string) {
    const ids = subtreeMap.get(id) ?? [id];
    const allOn = ids.every((i) => selected.has(i));
    const n = new Set(selected);
    for (const i of ids) allOn ? n.delete(i) : n.add(i);
    selected = n;
  }
  function sectionPartial(id: string): boolean {
    const ids = subtreeMap.get(id) ?? [id];
    let on = 0;
    for (const i of ids) if (selected.has(i)) on++;
    return on > 0 && on < ids.length;
  }
  function sectionAll(id: string): boolean {
    const ids = subtreeMap.get(id) ?? [id];
    return ids.every((i) => selected.has(i));
  }
  function selectAll() { selected = new Set(flat.map((f) => f.id)); }
  function selectNone() { selected = new Set(); }
  function toggleCollapse(id: string) {
    const n = new Set(collapsed);
    n.has(id) ? n.delete(id) : n.add(id);
    collapsed = n;
  }
  function isHidden(f: FlatNode): boolean {
    for (const c of collapsed) if (f.id !== c && f.id.startsWith(c + '.')) return true;
    return false;
  }
  function indet(node: HTMLInputElement, val: boolean) {
    node.indeterminate = val;
    return { update(v: boolean) { node.indeterminate = v; } };
  }

  // ---- 儲存 ----
  function applySnapshot(s: ClipSnapshot) {
    if (s.phase === 'done') { saving = false; statusKind = 'done'; statusText = s.detail || t('doneSaved'); savedLink = s.webViewLink; }
    else if (s.phase === 'error') { saving = false; statusKind = 'error'; statusText = s.error ? em(s.error.code) : (s.detail || t('phase_error')); }
    else { statusKind = 'busy'; statusText = t(`phase_${s.phase}` as DictKey) + ((s.phase === 'storing' || s.phase === 'video') && s.progress > 0 ? ` · ${Math.round(s.progress * 100)}%` : '…'); }
  }

  function tagList() { return tags.split(',').map((x) => x.trim()).filter(Boolean); }

  async function saveWeb() {
    if (!result || saving) return;
    saving = true; statusKind = 'busy'; statusText = t('loading'); savedLink = null;
    try {
      const filtered: CaptureResult = { ...result, tree: filterTree(result.tree, selected) };
      await sendToBackground('preview/save', {
        result: filtered, sourceTabId: tabId, format, tags: tagList(), project: project.trim() || null,
      });
    } catch (e) {
      saving = false; statusKind = 'error'; statusText = errText(e);
    }
  }

  async function saveVideoClip(onlySubs = false) {
    if (saving) return;
    saving = true; statusKind = 'busy'; statusText = t('loading'); savedLink = null;
    const video = !onlySubs && saveVideo && selectedItag != null && probe
      ? { itag: selectedItag, label: probe.variants.find((v) => v.itag === selectedItag)?.label ?? '' }
      : null;
    try {
      await sendToBackground('clip/run', {
        tabId, scope: 'page',
        format: onlySubs ? 'subtitle' : format,
        subtitles: onlySubs ? true : saveSubtitles,
        video, tags: tagList(), project: project.trim() || null,
      });
    } catch (e) {
      saving = false; statusKind = 'error'; statusText = errText(e);
    }
  }

  function fmtBytes(n: number | undefined): string {
    if (!n) return '';
    return n >= 1e9 ? (n / 1e9).toFixed(1) + ' GB' : n >= 1e6 ? Math.round(n / 1e6) + ' MB' : Math.round(n / 1e3) + ' KB';
  }
  function fmtDur(sec: number): string {
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    const p = (n: number) => String(n).padStart(2, '0');
    return h ? `${h}:${p(m)}:${p(s)}` : `${m}:${p(s)}`;
  }
</script>

{#snippet nodeView(node: ContentNode)}
  {#if node.type === 'section' || node.type === 'heading'}
    {#if node.text}
      <svelte:element this={`h${Math.min(6, node.level || 2)}`} class="pv-h">{node.text}</svelte:element>
    {/if}
  {:else if node.type === 'paragraph'}
    <p class="pv-p">{node.text}</p>
  {:else if node.type === 'quote'}
    <blockquote class="pv-q">{node.text}</blockquote>
  {:else if node.type === 'code'}
    <pre class="pv-code"><code>{node.text}</code></pre>
  {:else if node.type === 'list'}
    {@render listView(node)}
  {:else if node.type === 'table'}
    {@render tableView(node)}
  {:else if node.type === 'image'}
    <figure class="pv-img">
      {#if node.src}<img src={node.src} alt={node.alt || ''} loading="lazy" />{/if}
      {#if node.alt}<figcaption>{node.alt}</figcaption>{/if}
    </figure>
  {:else if node.type === 'divider'}
    <hr class="pv-hr" />
  {/if}
{/snippet}

{#snippet listView(node: ContentNode)}
  <svelte:element this={node.ordered ? 'ol' : 'ul'} class="pv-list">
    {#each node.children ?? [] as item}
      <li>
        {item.text}
        {#each item.children ?? [] as ch}{#if ch.type === 'list'}{@render listView(ch)}{/if}{/each}
      </li>
    {/each}
  </svelte:element>
{/snippet}

{#snippet tableView(node: ContentNode)}
  <div class="pv-table-wrap">
    <table class="pv-table">
      <tbody>
        {#each node.rows ?? [] as row, ri}
          <tr>
            {#each row as cell}
              {#if ri === 0}<th>{cell}</th>{:else}<td>{cell}</td>{/if}
            {/each}
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{/snippet}

<main>
  <header class="bar">
    <div class="brand"><span class="logo">🐿️</span><span class="name">{t('pvTitle')}</span></div>
    <div class="src" title={result?.url || probe?.title || ''}>{result?.title || probe?.title || t('pvSourceLoading')}</div>
  </header>

  {#if phase === 'loading'}
    <div class="center"><span class="spinner big"></span><p>{t('pvLoading')}</p></div>
  {:else if phase === 'error'}
    <div class="center"><div class="emoji">😕</div><p class="err">{errMsg}</p></div>
  {:else if phase === 'empty'}
    <div class="center"><div class="emoji">📭</div><p>{t('pvEmpty')}</p></div>

  {:else if phase === 'video'}
    <!-- ===== 影音模式 ===== -->
    <section class="video">
      <div class="guide">{t('pvVideoGuide')}</div>
      {#if probe}
        <div class="vinfo">
          <div class="vmeta">
            <h2>{probe.title}</h2>
            <p class="muted">{probe.channel}{probe.durationSec ? ` · ${fmtDur(probe.durationSec)}` : ''}</p>
          </div>
        </div>

        <div class="opts">
          <label class="opt"><input type="checkbox" bind:checked={saveSubtitles} disabled={saving} />
            <span>{t('dlSubtitles')}</span>
            <small class="muted">{probe.captionLangs.length ? probe.captionLangs.map((c) => c.lang).slice(0, 6).join(', ') : t('noSubs')}</small>
          </label>

          <label class="opt"><input type="checkbox" bind:checked={saveVideo} disabled={saving || !probe.variants.length} />
            <span>{t('dlVideo')}</span>
            {#if !probe.variants.length}<small class="muted">{t('noQuality')}</small>{/if}
          </label>
          {#if saveVideo && probe.variants.length}
            <select class="quality" bind:value={selectedItag} disabled={saving} transition:fade={{ duration: 120 }}>
              {#each probe.variants as v (v.itag)}
                <option value={v.itag}>{v.label} · {v.ext.toUpperCase()}{v.sizeBytes ? ` · ${fmtBytes(v.sizeBytes)}` : ''}</option>
              {/each}
            </select>
          {/if}

          <div class="fmt-row">
            <span class="muted">{t('formatLabel')}</span>
            <div class="seg">
              {#each FORMATS as f (f)}
                <button class:active={format === f} onclick={() => (format = f)} disabled={saving}>{FMT_LABEL[f]}</button>
              {/each}
            </div>
          </div>
        </div>

        <div class="actions">
          <button class="primary" onclick={() => saveVideoClip(false)} disabled={saving}>{saving ? t('loading') : t('pvVideoSave')}</button>
          <button class="ghost" onclick={() => saveVideoClip(true)} disabled={saving || !probe.captionLangs.length}>{t('onlySubs')}</button>
        </div>
      {/if}
    </section>

  {:else}
    <!-- ===== 網頁模式：左選取 / 右預覽 ===== -->
    <div class="guide">{t('pvGuide')}</div>
    <div class="cols">
      <aside class="picker">
        <div class="picker-head">
          <strong>{t('pvBlocks')}</strong>
          <span class="count">{t('pvSelectedCount', selectedTotal, selectableTotal)}</span>
        </div>
        <div class="picker-tools">
          <button onclick={selectAll} disabled={saving}>{t('selectAll')}</button>
          <button onclick={selectNone} disabled={saving}>{t('selectNone')}</button>
        </div>
        <div class="picker-list">
          {#each flat as f (f.id)}
            {#if !isHidden(f)}
              <div class="row {f.isSection ? 'is-section' : ''}" style="padding-left:{f.depth * 14 + 6}px">
                {#if f.isSection}
                  <button class="caret" onclick={() => toggleCollapse(f.id)} aria-label="展開/收合">{collapsed.has(f.id) ? '▸' : '▾'}</button>
                {:else}
                  <span class="caret-gap"></span>
                {/if}
                <input type="checkbox"
                  checked={f.isSection ? sectionAll(f.id) : selected.has(f.id)}
                  use:indet={f.isSection ? sectionPartial(f.id) : false}
                  onchange={() => (f.isSection ? toggleSection(f.id) : toggle(f.id))}
                  disabled={saving} />
                <span class="kind">{f.kind}</span>
                <span class="label" title={f.label}>{f.label}</span>
              </div>
            {/if}
          {/each}
        </div>
      </aside>

      <section class="preview">
        <div class="preview-head">
          <strong>{t('pvLive')}</strong>
          <div class="seg sm">
            {#each FORMATS as f (f)}
              <button class:active={format === f} onclick={() => (format = f)} disabled={saving}>{FMT_LABEL[f]}</button>
            {/each}
          </div>
        </div>
        <div class="preview-body">
          {#if previewNodes.length}
            {#each previewNodes as p (p.id)}
              <div class="pv-item" transition:fade={{ duration: mounted ? 130 : 0 }}>{@render nodeView(p.node)}</div>
            {/each}
            {#if selectedTotal > 1500}<p class="muted note">{t('pvTrunc')}</p>{/if}
          {:else}
            <div class="pv-placeholder">{t('pvPlaceholder')}</div>
          {/if}
        </div>
      </section>
    </div>

    <footer class="foot">
      <button class="disclosure" onclick={() => (advanced = !advanced)}>{advanced ? '▾' : '▸'} {t('advanced')}</button>
      {#if advanced}
        <div class="adv" transition:fade={{ duration: 120 }}>
          <input placeholder={t('tagsPh')} bind:value={tags} disabled={saving} />
          <input placeholder={t('projectPh')} bind:value={project} disabled={saving} />
        </div>
      {/if}
      <button class="primary save" onclick={saveWeb} disabled={saving || selectedTotal === 0}>
        {saving ? t('loading') : t('pvSaveSel', selectedTotal)}
      </button>
    </footer>
  {/if}

  {#if statusKind !== 'idle'}
    <div class="status {statusKind}" transition:fade={{ duration: 140 }}>
      {#if statusKind === 'busy'}<span class="spinner"></span>{/if}
      <span class="msg">{statusText}</span>
      {#if savedLink}<a href={savedLink} target="_blank" rel="noreferrer">{t('openDrive')}</a>{/if}
    </div>
  {/if}
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
  :global(body) { margin: 0; background: var(--bg); color: var(--ink); font-family: system-ui, -apple-system, "Noto Sans TC", sans-serif; }
  main { height: 100vh; display: flex; flex-direction: column; box-sizing: border-box; }

  .bar { display: flex; align-items: center; gap: 14px; padding: 10px 16px; border-bottom: 1px solid var(--line); background: var(--card); }
  .brand { display: flex; align-items: center; gap: 7px; flex: none; }
  .logo { font-size: 18px; } .name { font-weight: 700; }
  .src { font-size: 13px; color: var(--muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

  .guide { background: var(--hl); border-bottom: 1px solid var(--line); color: var(--accent); font-size: 12.5px; padding: 8px 16px; line-height: 1.5; }

  .center { flex: 1; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 12px; text-align: center; color: var(--muted); padding: 24px; box-sizing: border-box; }
  .center .emoji { font-size: 34px; } .center .err { color: var(--err); max-width: 460px; }

  .cols { flex: 1; display: grid; grid-template-columns: minmax(280px, 38%) 1fr; min-height: 0; }
  .picker { border-right: 1px solid var(--line); display: flex; flex-direction: column; min-height: 0; background: var(--card); }
  .picker-head { display: flex; justify-content: space-between; align-items: center; padding: 10px 12px 6px; }
  .picker-head .count { font-size: 12px; color: var(--muted); }
  .picker-tools { display: flex; gap: 6px; padding: 0 12px 8px; border-bottom: 1px solid var(--line); }
  .picker-tools button { font-size: 12px; padding: 4px 10px; border: 1px solid var(--line); background: var(--bg); color: var(--ink); border-radius: 6px; cursor: pointer; }
  .picker-list { overflow: auto; flex: 1; padding: 4px 0; }
  .row { display: flex; align-items: center; gap: 7px; padding: 3px 12px 3px 6px; font-size: 12.5px; cursor: default; border-radius: 5px; }
  .row:hover { background: var(--hl); }
  .row.is-section { font-weight: 600; }
  .caret { border: none; background: none; color: var(--accent); cursor: pointer; font-size: 10px; width: 14px; padding: 0; flex: none; }
  .caret-gap { width: 14px; flex: none; }
  .row input[type="checkbox"] { accent-color: var(--brand); flex: none; }
  .row .kind { font-size: 10px; color: var(--brand-ink); background: var(--brand); border-radius: 4px; padding: 1px 5px; flex: none; }
  .row.is-section .kind { background: var(--accent); }
  .row .label { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--ink); }

  .preview { display: flex; flex-direction: column; min-height: 0; }
  .preview-head { display: flex; justify-content: space-between; align-items: center; padding: 10px 16px 8px; border-bottom: 1px solid var(--line); }
  .preview-body { overflow: auto; flex: 1; padding: 14px 20px; }
  .pv-placeholder { color: var(--muted); text-align: center; margin-top: 40px; }
  .note { font-size: 11px; margin-top: 10px; }

  .seg { display: inline-flex; background: var(--bg); border: 1px solid var(--line); border-radius: 8px; padding: 2px; gap: 2px; }
  .seg.sm button { font-size: 11px; padding: 4px 8px; }
  .seg button { border: none; background: none; color: var(--ink); padding: 5px 12px; border-radius: 6px; font-size: 12px; cursor: pointer; }
  .seg button.active { background: var(--brand); color: var(--brand-ink); font-weight: 600; }

  .foot { border-top: 1px solid var(--line); background: var(--card); padding: 10px 16px; display: flex; align-items: center; gap: 12px; flex-wrap: wrap; }
  .disclosure { background: none; border: none; color: var(--accent); font-size: 12px; cursor: pointer; }
  .adv { display: flex; gap: 8px; flex: 1; }
  .adv input { padding: 7px 9px; border: 1px solid var(--line); border-radius: 7px; background: var(--bg); color: var(--ink); font-size: 13px; flex: 1; min-width: 120px; }
  .save { margin-left: auto; }

  .primary { padding: 9px 18px; border: none; border-radius: 9px; background: var(--brand); color: var(--brand-ink); font-weight: 700; font-size: 13px; cursor: pointer; transition: filter .15s; }
  .primary:hover:not(:disabled) { filter: brightness(1.08); }
  .primary:disabled { opacity: .55; cursor: default; }
  .ghost { padding: 9px 16px; border: 1px solid var(--line); border-radius: 9px; background: var(--bg); color: var(--ink); font-size: 13px; cursor: pointer; }
  .ghost:disabled { opacity: .5; cursor: default; }

  /* 影音模式 */
  .video { max-width: 620px; margin: 0 auto; padding: 0 16px 16px; width: 100%; box-sizing: border-box; }
  .vinfo { padding: 16px 0 8px; }
  .vmeta h2 { font-size: 17px; margin: 0 0 4px; }
  .opts { display: flex; flex-direction: column; gap: 12px; background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 16px; }
  .opt { display: flex; align-items: center; gap: 9px; font-size: 14px; cursor: pointer; }
  .opt small { margin-left: auto; }
  .opt input { accent-color: var(--brand); }
  .quality { padding: 8px; border: 1px solid var(--line); border-radius: 8px; background: var(--bg); color: var(--ink); font-size: 13px; }
  .fmt-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding-top: 6px; border-top: 1px dashed var(--line); }
  .actions { display: flex; gap: 10px; margin-top: 16px; }

  /* 預覽內容樣式 */
  .pv-item :global(.pv-h) { line-height: 1.3; margin: 14px 0 6px; }
  .pv-item :global(h1.pv-h) { font-size: 22px; } .pv-item :global(h2.pv-h) { font-size: 18px; }
  .pv-item :global(h3.pv-h) { font-size: 16px; } .pv-item :global(h4.pv-h), .pv-item :global(h5.pv-h), .pv-item :global(h6.pv-h) { font-size: 14px; }
  .pv-item :global(.pv-p) { line-height: 1.65; margin: 8px 0; }
  .pv-item :global(.pv-q) { border-left: 3px solid var(--accent); margin: 8px 0; padding: 2px 12px; color: var(--muted); }
  .pv-item :global(.pv-code) { background: var(--hl); border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; overflow: auto; font-size: 12.5px; }
  .pv-item :global(.pv-list) { margin: 8px 0; padding-left: 22px; line-height: 1.6; }
  .pv-item :global(.pv-table-wrap) { overflow: auto; margin: 10px 0; }
  .pv-item :global(.pv-table) { border-collapse: collapse; font-size: 12.5px; }
  .pv-item :global(.pv-table th), .pv-item :global(.pv-table td) { border: 1px solid var(--line); padding: 5px 9px; text-align: left; }
  .pv-item :global(.pv-table th) { background: var(--hl); }
  .pv-item :global(.pv-img) { margin: 10px 0; }
  .pv-item :global(.pv-img img) { max-width: 100%; height: auto; border-radius: 8px; border: 1px solid var(--line); }
  .pv-item :global(.pv-img figcaption) { font-size: 12px; color: var(--muted); margin-top: 4px; }
  .pv-item :global(.pv-hr) { border: none; border-top: 1px solid var(--line); margin: 14px 0; }

  .status { position: fixed; bottom: 16px; left: 50%; transform: translateX(-50%); display: flex; align-items: center; gap: 9px; background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: 9px 14px; font-size: 13px; box-shadow: 0 4px 16px rgba(0,0,0,.12); max-width: 90vw; }
  .status.done { border-color: color-mix(in srgb, var(--ok) 45%, var(--line)); }
  .status.error { border-color: color-mix(in srgb, var(--err) 45%, var(--line)); }
  .status .msg { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .status a { color: var(--accent); text-decoration: none; white-space: nowrap; }
  .muted { color: var(--muted); }

  .spinner { width: 13px; height: 13px; border: 2px solid var(--line); border-top-color: var(--brand); border-radius: 50%; animation: spin .7s linear infinite; flex: none; }
  .spinner.big { width: 26px; height: 26px; border-width: 3px; }
  @keyframes spin { to { transform: rotate(360deg); } }
</style>
