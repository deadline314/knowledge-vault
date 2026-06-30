/**
 * 預覽選取的純邏輯（無 DOM、無 chrome.*，好測、可重用）。
 *
 * 設計：
 * - 用「位置路徑」當每個節點的穩定 id（如 "2.0.1"），擷取結果不變時 id 就不變。
 * - flatten() 把內容樹攤平成可勾選清單（章節為群組，list/table 等視為單一原子項）。
 * - filterTree() 依選取集合重建一棵「只含選取內容」的樹，給匯出用。
 * - 章節（section）只要本身被選或有任一子孫被選就保留，維持階層完整。
 *
 * 抽象：UI 只依賴 id 與這些純函式；之後要換選取策略（例如頁面點選）只要再產生一組 id 即可。
 */
import type { ContentNode } from '@/core/capture/ContentSource';

export interface FlatNode {
  /** 位置路徑 id，例如 "2.0.1" */
  id: string;
  node: ContentNode;
  /** 縮排層級（章節巢狀深度） */
  depth: number;
  /** 是否為章節（群組型，可級聯選取子孫） */
  isSection: boolean;
  /** 選取清單上顯示的精簡標籤 */
  label: string;
  /** 類型中文名（標題／段落／表格…） */
  kind: string;
}

const KIND_LABEL: Record<ContentNode['type'], string> = {
  section: '章節',
  heading: '標題',
  paragraph: '段落',
  list: '清單',
  listitem: '項目',
  table: '表格',
  code: '程式碼',
  quote: '引言',
  image: '圖片',
  divider: '分隔線',
};

function snippet(s: string | undefined, n = 60): string {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

function labelOf(node: ContentNode): string {
  switch (node.type) {
    case 'section':
    case 'heading':
      return snippet(node.text) || '（無標題章節）';
    case 'paragraph':
    case 'quote':
      return snippet(node.text) || '（空白）';
    case 'list':
      return `清單（${node.children?.length ?? 0} 項）`;
    case 'table': {
      const rows = node.rows?.length ?? 0;
      const cols = node.rows?.[0]?.length ?? 0;
      return `表格（${rows}×${cols}）`;
    }
    case 'code':
      return `程式碼${node.lang ? `（${node.lang}）` : ''}：${snippet(node.text, 40)}`;
    case 'image':
      return `圖片${node.alt ? `：${snippet(node.alt, 40)}` : ''}`;
    case 'divider':
      return '分隔線';
    default:
      return snippet((node as ContentNode).text);
  }
}

/** 攤平成可勾選清單；只遞迴章節，list/table 等當原子項。 */
export function flatten(tree: ContentNode[]): FlatNode[] {
  const out: FlatNode[] = [];
  const walk = (nodes: ContentNode[], path: string, depth: number): void => {
    nodes.forEach((node, i) => {
      const id = path ? `${path}.${i}` : `${i}`;
      const isSection = node.type === 'section';
      out.push({ id, node, depth, isSection, label: labelOf(node), kind: KIND_LABEL[node.type] ?? '內容' });
      if (isSection && node.children?.length) walk(node.children, id, depth + 1);
    });
  };
  walk(tree, '', 0);
  return out;
}

/** 全部 id（預設全選用）。 */
export function allIds(flat: FlatNode[]): string[] {
  return flat.map((f) => f.id);
}

/** 某章節含其所有子孫的 id（級聯勾選用）。 */
export function subtreeIds(flat: FlatNode[], sectionId: string): string[] {
  const prefix = sectionId + '.';
  return flat.filter((f) => f.id === sectionId || f.id.startsWith(prefix)).map((f) => f.id);
}

/**
 * 依選取集合重建樹（只含選取項）。
 * 章節：本身被選或有任一子孫被選 → 保留，並只帶入被選的子節點。
 */
export function filterTree(tree: ContentNode[], selected: ReadonlySet<string>): ContentNode[] {
  const rebuild = (nodes: ContentNode[], path: string): ContentNode[] => {
    const out: ContentNode[] = [];
    nodes.forEach((node, i) => {
      const id = path ? `${path}.${i}` : `${i}`;
      if (node.type === 'section') {
        const kids = node.children?.length ? rebuild(node.children, id) : [];
        if (selected.has(id) || kids.length) out.push({ ...node, children: kids });
      } else if (selected.has(id)) {
        out.push(node);
      }
    });
    return out;
  };
  return rebuild(tree, '');
}

/** 概略統計選取了多少實質內容（給 UI 顯示）。 */
export function countSelectable(flat: FlatNode[]): number {
  return flat.filter((f) => !f.isSection).length;
}
