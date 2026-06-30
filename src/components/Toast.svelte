<script lang="ts">
  /**
   * 可重用的彈出小 widget 堆疊。Presentational：只負責顯示 + dismiss/copy，
   * 文案已在外部以當前語系解析好。chrome 標籤（詳情/複製/關閉）用 rev 觸發重渲染。
   */
  import { fly } from 'svelte/transition';
  import { t as rawT, type DictKey } from '@/shared/i18n';
  import type { ToastItem } from './toast';

  let {
    toasts = [],
    rev = 0,
    ondismiss,
  }: { toasts?: ToastItem[]; rev?: number; ondismiss: (id: number) => void } = $props();

  const tt = (k: DictKey) => {
    void rev;
    return rawT(k);
  };

  let expanded = $state<Record<number, boolean>>({});
  let copiedId = $state<number | null>(null);

  function toggle(id: number) {
    expanded = { ...expanded, [id]: !expanded[id] };
  }
  function copy(item: ToastItem) {
    const text = item.copyText ?? `${item.title}\n${item.message}`;
    try {
      void navigator.clipboard?.writeText(text).then(
        () => {
          copiedId = item.id;
          setTimeout(() => { if (copiedId === item.id) copiedId = null; }, 1500);
        },
        () => {},
      );
    } catch {
      /* clipboard 不可用：忽略 */
    }
  }
  const ICON: Record<ToastItem['type'], string> = { error: '⚠', success: '✓', info: 'ℹ' };
</script>

{#if toasts.length}
  <div class="toast-stack" role="region" aria-live="polite">
    {#each toasts as ti (ti.id)}
      <div class="toast {ti.type}" transition:fly={{ y: 10, duration: 160 }}>
        <div class="t-head">
          <span class="t-ic">{ICON[ti.type]}</span>
          <b class="t-title">{ti.title}</b>
          <button class="t-x" onclick={() => ondismiss(ti.id)} title={tt('toastClose')} aria-label={tt('toastClose')}>✕</button>
        </div>
        {#if ti.message}<div class="t-msg">{ti.message}</div>{/if}
        {#if ti.hint}<div class="t-hint">💡 {ti.hint}</div>{/if}
        {#if ti.detail}
          <button class="t-more" onclick={() => toggle(ti.id)}>{expanded[ti.id] ? '▾' : '▸'} {tt('toastDetails')}</button>
          {#if expanded[ti.id]}<pre class="t-detail">{ti.detail}</pre>{/if}
        {/if}
        {#if ti.type === 'error'}
          <div class="t-actions">
            <button class="t-copy" onclick={() => copy(ti)}>{copiedId === ti.id ? tt('toastCopied') : tt('toastCopy')}</button>
          </div>
        {/if}
      </div>
    {/each}
  </div>
{/if}

<style>
  .toast-stack {
    position: fixed;
    left: 10px;
    right: 10px;
    bottom: 10px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    z-index: 50;
    pointer-events: none;
  }
  .toast {
    pointer-events: auto;
    background: var(--card, #fff);
    border: 1px solid var(--line, #e5e5e5);
    border-left: 4px solid var(--muted, #999);
    border-radius: 10px;
    padding: 9px 11px;
    box-shadow: 0 6px 20px rgba(0, 0, 0, 0.18);
    font-size: 12.5px;
    color: var(--ink, #1f2328);
  }
  .toast.error { border-left-color: var(--err, #c62828); }
  .toast.success { border-left-color: var(--ok, #2e7d32); }
  .toast.info { border-left-color: var(--accent, #b9803f); }
  .t-head { display: flex; align-items: center; gap: 6px; }
  .t-ic { font-size: 13px; }
  .toast.error .t-ic { color: var(--err, #c62828); }
  .toast.success .t-ic { color: var(--ok, #2e7d32); }
  .t-title { flex: 1; font-size: 12.5px; line-height: 1.3; }
  .t-x {
    border: 0; background: transparent; color: var(--muted, #888);
    cursor: pointer; font-size: 12px; padding: 2px 4px; border-radius: 6px; line-height: 1;
  }
  .t-x:hover { background: var(--hl, #f0eadf); color: var(--ink, #222); }
  .t-msg { margin-top: 4px; color: var(--ink, #1f2328); line-height: 1.4; }
  .t-hint { margin-top: 5px; color: var(--muted, #6b7280); line-height: 1.4; }
  .t-more {
    margin-top: 5px; border: 0; background: transparent; color: var(--accent, #b9803f);
    cursor: pointer; font-size: 11.5px; padding: 1px 0;
  }
  .t-detail {
    margin: 4px 0 0; padding: 6px 8px; background: var(--hl, #f6f1e8);
    border-radius: 6px; font-size: 11px; line-height: 1.45; white-space: pre-wrap;
    word-break: break-word; max-height: 120px; overflow: auto; color: var(--muted, #555);
  }
  .t-actions { margin-top: 6px; display: flex; justify-content: flex-end; }
  .t-copy {
    border: 1px solid var(--line, #ddd); background: var(--card, #fff); color: var(--ink, #333);
    cursor: pointer; font-size: 11px; padding: 3px 9px; border-radius: 6px;
  }
  .t-copy:hover { background: var(--hl, #f0eadf); }
</style>
