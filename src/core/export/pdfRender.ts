/**
 * PDF 產生（在 offscreen document 執行；不在 service worker，避免壓垮 SW）。
 *
 * - 內嵌中文字型（呼叫端傳入字型 bytes），subset:true 讓輸出 PDF 只含用到的字，檔案不致過大。
 * - 換行同時支援中英：英文以「單字」為單位不切斷，中文逐字可斷（CJK 無空白）。
 * - 記憶體：字型只載一次；逐節點繪製，不保留大物件。
 *
 * 純函式，無 chrome.* 依賴，方便單元測試與重用。
 */
import { PDFDocument, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import fontkit from '@pdf-lib/fontkit';
import type { CaptureResult, ContentNode } from '../capture/ContentSource';

const MARGIN = 50;
const PAGE_W = 595.28; // A4
const PAGE_H = 841.89;

export interface PdfRenderOptions {
  /** 中文字型檔（TTF/OTF）bytes */
  fontBytes: ArrayBuffer | Uint8Array;
}

interface Ctx {
  doc: PDFDocument;
  font: PDFFont;
  page: PDFPage;
  y: number;
}

export async function renderPdf(result: CaptureResult, opts: PdfRenderOptions): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.registerFontkit(fontkit);
  const font = await doc.embedFont(opts.fontBytes as ArrayBuffer, { subset: true });

  const ctx: Ctx = { doc, font, page: doc.addPage([PAGE_W, PAGE_H]), y: PAGE_H - MARGIN };

  drawLines(ctx, wrap(ctx.font, clean(result.title), 18, contentWidth(0)), 18, 0, rgb(0, 0, 0));
  drawLines(ctx, wrap(ctx.font, result.url, 9, contentWidth(0)), 9, 0, rgb(0.25, 0.3, 0.6));
  ctx.y -= 10;

  walk(result.tree, ctx, 0);
  return doc.save();
}

function contentWidth(indent: number): number {
  return PAGE_W - MARGIN * 2 - indent * 16;
}

function walk(nodes: ContentNode[], ctx: Ctx, indent: number): void {
  for (const n of nodes) {
    switch (n.type) {
      case 'section':
        if (n.text) drawPara(ctx, n.text, headingSize(n.level), indent, true);
        walk(n.children ?? [], ctx, indent);
        break;
      case 'heading':
        drawPara(ctx, n.text ?? '', headingSize(n.level), indent, true);
        break;
      case 'paragraph':
        drawPara(ctx, n.text ?? '', 11, indent, false);
        break;
      case 'quote':
        drawPara(ctx, n.text ?? '', 11, indent + 1, false, rgb(0.35, 0.35, 0.35));
        break;
      case 'code':
        for (const line of (n.text ?? '').split('\n')) drawPara(ctx, line, 9, indent + 1, false, rgb(0.1, 0.1, 0.1));
        break;
      case 'list':
        renderList(n, ctx, indent);
        break;
      case 'table':
        for (const r of n.rows ?? []) drawPara(ctx, r.join('  |  '), 10, indent + 1, false);
        ctx.y -= 6;
        break;
      case 'image':
        if (n.alt) drawPara(ctx, `[圖] ${n.alt}`, 9, indent + 1, false, rgb(0.4, 0.4, 0.4));
        break;
      case 'divider':
        ctx.y -= 7;
        break;
      default:
        break;
    }
  }
}

function renderList(list: ContentNode, ctx: Ctx, indent: number): void {
  let i = 1;
  for (const item of list.children ?? []) {
    const marker = list.ordered ? `${i++}.` : '•';
    drawPara(ctx, `${marker} ${item.text ?? ''}`, 11, indent + 1, false);
    for (const child of item.children ?? []) if (child.type === 'list') renderList(child, ctx, indent + 1);
  }
}

function drawPara(ctx: Ctx, text: string, size: number, indent: number, bold: boolean, color = rgb(0, 0, 0)): void {
  const t = clean(text);
  if (!t) return;
  const lines = wrap(ctx.font, t, size, contentWidth(indent));
  drawLines(ctx, lines, size, indent, color, bold ? size * 0.3 : 0);
  ctx.y -= bold ? 4 : 2;
}

function drawLines(ctx: Ctx, lines: string[], size: number, indent: number, color: ReturnType<typeof rgb>, extraLead = 0): void {
  const lead = size + 3 + extraLead;
  for (const line of lines) {
    if (ctx.y - lead < MARGIN) {
      ctx.page = ctx.doc.addPage([PAGE_W, PAGE_H]);
      ctx.y = PAGE_H - MARGIN;
    }
    try {
      ctx.page.drawText(line, { x: MARGIN + indent * 16, y: ctx.y, size, font: ctx.font, color });
    } catch {
      /* 個別行繪製失敗（極端字元）略過，不中斷整份 */
    }
    ctx.y -= lead;
  }
}

/**
 * 混合中英換行：切成「片段」——英文連續非空白為一個單字、CJK 逐字、空白為片段——
 * 再貪婪塞行；行寬超過就換行。英文單字不被切斷，中文可逐字斷。
 */
function wrap(font: PDFFont, text: string, size: number, maxWidth: number): string[] {
  if (!text) return [];
  const segments = tokenize(text);
  const lines: string[] = [];
  let line = '';
  const width = (s: string) => {
    try {
      return font.widthOfTextAtSize(s, size);
    } catch {
      return s.length * size * 0.6;
    }
  };
  for (const seg of segments) {
    const tentative = line + seg;
    if (width(tentative) > maxWidth && line.trim()) {
      lines.push(line.replace(/\s+$/, ''));
      line = seg === ' ' ? '' : seg;
    } else {
      line = tentative;
    }
  }
  if (line.trim()) lines.push(line.replace(/\s+$/, ''));
  return lines.length ? lines : [text];
}

/** 切片段：CJK / 全形 逐字；其餘以空白分隔保留為單字。 */
function tokenize(text: string): string[] {
  const out: string[] = [];
  let buf = '';
  const flush = () => {
    if (buf) {
      out.push(buf);
      buf = '';
    }
  };
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0;
    const isCJK = (c >= 0x3000 && c <= 0x9fff) || (c >= 0xff00 && c <= 0xffef) || (c >= 0x3400 && c <= 0x4dbf);
    if (ch === ' ') {
      flush();
      out.push(' ');
    } else if (isCJK) {
      flush();
      out.push(ch);
    } else {
      buf += ch;
    }
  }
  flush();
  return out;
}

function headingSize(level?: number): number {
  return level === 1 ? 17 : level === 2 ? 14 : level === 3 ? 12 : 11;
}

function clean(s: string | null | undefined): string {
  return (s ?? '').replace(/\r/g, '').replace(/[\t\f\v]+/g, ' ').trim();
}
