// Structure-tree helpers for the Tags + Reading Order panels.
//
// The engine's get_struct_tree returns the logical structure tree with PATH
// addressing and each node's DIRECT content references ({page, mcid} /
// {page, kind:'objr'}). Everything here is PURE over that shape (plus pdf.js
// text-content item arrays) so it is testable without a DOM: the panels own
// only fetching and rendering.
//
// Content preview is renderer-side by design: the tree names MCIDs, and
// pdf.js getTextContent({ includeMarkedContent: true }) interleaves text
// items with begin/end marked-content markers whose id encodes the MCID —
// joining the two here avoids a second engine text-extraction arm.

import type { PDFDocumentProxy } from 'pdfjs-dist';

export interface StructContentRef {
  page: number | null;
  mcid?: number;
  kind?: 'objr';
}

export interface StructNode {
  path: number[];
  type: string;
  title: string;
  alt: string;
  actual_text: string;
  lang: string;
  content: StructContentRef[];
  children: StructNode[];
}

export interface StructTree {
  tagged: boolean;
  count: number;
  root: StructNode[];
  role_map: Record<string, string>;
}

/** The standard structure types (ISO 32000 §14.8.4), for the retag picker.
 * Free entry stays allowed — role-mapped custom types are legal PDF. */
export const STANDARD_STRUCT_TYPES: readonly string[] = [
  'Document', 'Part', 'Art', 'Sect', 'Div', 'BlockQuote', 'Caption', 'TOC',
  'TOCI', 'Index', 'NonStruct', 'Private', 'P', 'H', 'H1', 'H2', 'H3', 'H4',
  'H5', 'H6', 'L', 'LI', 'Lbl', 'LBody', 'Table', 'TR', 'TH', 'TD', 'THead',
  'TBody', 'TFoot', 'Span', 'Quote', 'Note', 'Reference', 'BibEntry', 'Code',
  'Link', 'Annot', 'Ruby', 'RB', 'RT', 'RP', 'Warichu', 'WT', 'WP', 'Figure',
  'Formula', 'Form',
];

export const pathKey = (path: number[]): string => path.join('.');

/** Do two paths name siblings (same parent)? */
export function sameParent(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length - 1; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** One reading-order entry: a node with direct content on the page. */
export interface OrderEntry {
  node: StructNode;
  mcids: number[];
  hasObjr: boolean;
}

/**
 * The page's reading order: nodes with DIRECT content on `page`, in tree
 * (depth-first) order — the order assistive technology reads them in.
 */
export function flattenReadingOrder(root: StructNode[], page: number): OrderEntry[] {
  const out: OrderEntry[] = [];
  const visit = (n: StructNode): void => {
    const mcids: number[] = [];
    let hasObjr = false;
    for (const c of n.content) {
      if (c.page !== page) continue;
      if (typeof c.mcid === 'number') mcids.push(c.mcid);
      else if (c.kind === 'objr') hasObjr = true;
    }
    if (mcids.length > 0 || hasObjr) out.push({ node: n, mcids, hasObjr });
    n.children.forEach(visit);
  };
  root.forEach(visit);
  return out;
}

/** The sorted unique pages a node's SUBTREE touches (for tree-row badges). */
export function subtreePages(node: StructNode): number[] {
  const pages = new Set<number>();
  const visit = (n: StructNode): void => {
    for (const c of n.content) if (typeof c.page === 'number') pages.add(c.page);
    n.children.forEach(visit);
  };
  visit(node);
  return [...pages].sort((a, b) => a - b);
}

// pdf.js text-content items, narrowed to the fields this module reads. With
// includeMarkedContent, marker items carry type + id ("<pageObjId>_mc<MCID>");
// text items carry str/hasEOL.
export interface MarkedTextItem {
  type?: string;
  id?: string | null;
  str?: string;
  hasEOL?: boolean;
}

/**
 * Per-MCID text of one page, from pdf.js text-content items (fetched with
 * includeMarkedContent: true). Markers nest; a text item belongs to the
 * nearest enclosing marker that carries an MCID.
 */
export function mcidTextFromItems(items: readonly MarkedTextItem[]): Map<number, string> {
  const texts = new Map<number, string>();
  const stack: Array<number | null> = [];
  for (const it of items) {
    if (it.type === 'beginMarkedContentProps' || it.type === 'beginMarkedContent') {
      const m = typeof it.id === 'string' ? /_mc(\d+)$/.exec(it.id) : null;
      stack.push(m ? Number(m[1]) : null);
    } else if (it.type === 'endMarkedContent') {
      stack.pop();
    } else if (typeof it.str === 'string' && it.str.length > 0) {
      for (let i = stack.length - 1; i >= 0; i--) {
        const mcid = stack[i];
        if (mcid !== null) {
          const prev = texts.get(mcid) ?? '';
          texts.set(mcid, prev + it.str + (it.hasEOL ? ' ' : ''));
          break;
        }
      }
    }
  }
  return texts;
}

/** Fetch one page's per-MCID text through pdf.js. */
export async function pageMcidText(
  proxy: PDFDocumentProxy,
  pageNo: number,
): Promise<Map<number, string>> {
  const page = await proxy.getPage(pageNo);
  const content = await page.getTextContent({ includeMarkedContent: true });
  return mcidTextFromItems(content.items as unknown as MarkedTextItem[]);
}

/** A short preview of a node's DIRECT content from per-page MCID text maps
 * (page → mcid → text), for tree rows and order entries. */
export function nodePreview(
  node: StructNode,
  texts: ReadonlyMap<number, ReadonlyMap<number, string>>,
  maxLength = 80,
): string {
  const parts: string[] = [];
  for (const c of node.content) {
    if (typeof c.page !== 'number') continue;
    if (typeof c.mcid === 'number') {
      const t = texts.get(c.page)?.get(c.mcid);
      if (t) parts.push(t.trim());
    } else if (c.kind === 'objr') {
      parts.push('[annotation]');
    }
  }
  const joined = parts.join(' ').replace(/\s+/g, ' ').trim();
  return joined.length > maxLength ? `${joined.slice(0, maxLength - 1)}…` : joined;
}
