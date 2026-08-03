// T20 — rich paste: clipboard HTML → the paragraph editor's own per-span
// overlay vocabulary (colour / face / size), so pasted styling rides the
// SAME span_styles machinery the toolbar writes and nothing new reaches the
// engine. The walk is pure and fully pinned (there is no DOM test
// environment — the standing rule); the five-line DOMParser shim that feeds
// it lives at the bottom and runs only in the browser.
//
// Fidelity contract (the honest subset): bold, italic, family CLASS
// (serif/sans/mono — the engine's substitution vocabulary; a pasted
// "Garamond" maps to serif, it does not embed Garamond), size in points,
// and colour. Anything else — images, tables, lists, links — flattens to
// its text; block boundaries become spaces (a paragraph is one flow, the
// editor's existing paste contract).

export interface RichTreeNode {
  /** Lower-case tag for elements; undefined for text nodes. */
  tag?: string;
  /** Parsed inline style declarations (lower-case keys). */
  style?: Record<string, string>;
  children?: RichTreeNode[];
  text?: string;
}

export interface RichSpanStyle {
  bold?: boolean;
  italic?: boolean;
  family?: 'serif' | 'sans' | 'mono';
  size?: number;
  color?: [number, number, number];
}

export interface RichPasteResult {
  text: string;
  /** Code-point ranges over `text`, only where a style differs from the
   * empty default — a plain paste yields zero spans. */
  spans: { start: number; end: number; style: RichSpanStyle }[];
}

const BLOCK_TAGS = new Set([
  'p', 'div', 'br', 'li', 'ul', 'ol', 'table', 'tr', 'h1', 'h2', 'h3',
  'h4', 'h5', 'h6', 'blockquote', 'pre', 'section', 'article',
]);

/** Map a font-family stack onto the engine's substitution classes. The
 * FIRST recognizable entry decides; an unrecognized stack keeps the
 * document's own face (undefined). */
export function classifyFamily(stack: string): 'serif' | 'sans' | 'mono' | undefined {
  for (const raw of stack.split(',')) {
    const name = raw.trim().toLowerCase().replace(/^['"]|['"]$/g, '');
    if (!name) continue;
    if (name === 'monospace' || /\b(mono|courier|consolas|menlo)\b/.test(name)) return 'mono';
    if (name === 'sans-serif' || /\b(sans|arial|helvetica|calibri|segoe|verdana|tahoma)\b/.test(name)) return 'sans';
    if (name === 'serif' || /\b(times|georgia|garamond|cambria|book|palatino|minion)\b/.test(name)) return 'serif';
  }
  return undefined;
}

/** CSS length → points. Clipboard HTML carries px (browsers) and pt
 * (Word); anything else is ignored rather than guessed. */
export function sizeToPoints(v: string): number | undefined {
  const m = /^([\d.]+)\s*(px|pt)$/.exec(v.trim());
  if (!m) return undefined;
  const n = parseFloat(m[1]);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  const pt = m[2] === 'pt' ? n : n * 0.75;
  return Math.max(1, Math.min(1638, Math.round(pt * 10) / 10));
}

/** #rgb/#rrggbb/rgb() → [r,g,b] 0–1. Anything else (named colours,
 * transparent, currentcolor) keeps the document's own. */
export function colorToRgb(v: string): [number, number, number] | undefined {
  const s = v.trim().toLowerCase();
  let m = /^#([0-9a-f]{6})$/.exec(s);
  if (m) {
    const n = parseInt(m[1], 16);
    return [((n >> 16) & 0xff) / 255, ((n >> 8) & 0xff) / 255, (n & 0xff) / 255];
  }
  m = /^#([0-9a-f]{3})$/.exec(s);
  if (m) {
    return [
      parseInt(m[1][0] + m[1][0], 16) / 255,
      parseInt(m[1][1] + m[1][1], 16) / 255,
      parseInt(m[1][2] + m[1][2], 16) / 255,
    ];
  }
  m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/.exec(s);
  if (m) {
    return [
      Math.min(255, Number(m[1])) / 255,
      Math.min(255, Number(m[2])) / 255,
      Math.min(255, Number(m[3])) / 255,
    ];
  }
  return undefined;
}

function styleOf(node: RichTreeNode, inherited: RichSpanStyle): RichSpanStyle {
  const out: RichSpanStyle = { ...inherited };
  const tag = node.tag ?? '';
  if (tag === 'b' || tag === 'strong') out.bold = true;
  if (tag === 'i' || tag === 'em') out.italic = true;
  const st = node.style ?? {};
  const fw = st['font-weight'];
  if (fw !== undefined) {
    const n = parseInt(fw, 10);
    out.bold = fw === 'bold' || fw === 'bolder' || (Number.isFinite(n) && n >= 600);
  }
  const fs = st['font-style'];
  if (fs !== undefined) out.italic = fs === 'italic' || fs === 'oblique';
  if (st['font-family']) {
    const fam = classifyFamily(st['font-family']);
    if (fam) out.family = fam;
  }
  if (st['font-size']) {
    const pt = sizeToPoints(st['font-size']);
    if (pt !== undefined) out.size = pt;
  }
  if (st.color) {
    const rgb = colorToRgb(st.color);
    if (rgb) out.color = rgb;
  }
  // A false axis normalizes to ABSENCE: the engine's bold/italic are
  // absolute substitution requests, so `bold: false` would force a
  // regular-Liberation substitution where "back to normal" means "keep the
  // document's own face".
  if (out.bold === false) delete out.bold;
  if (out.italic === false) delete out.italic;
  return out;
}

function styleKeyOf(s: RichSpanStyle): string {
  return `${s.bold ?? ''}|${s.italic ?? ''}|${s.family ?? ''}|${s.size ?? ''}|${s.color?.join(',') ?? ''}`;
}

const EMPTY_KEY = styleKeyOf({});

/** The pure walk: tree → flowed text + minimal styled ranges. */
export function treeToRich(nodes: RichTreeNode[]): RichPasteResult {
  const parts: string[] = [];
  const styles: RichSpanStyle[] = []; // one per emitted code point
  const emit = (text: string, style: RichSpanStyle): void => {
    for (const ch of Array.from(text)) {
      parts.push(ch);
      styles.push(style);
    }
  };
  const walk = (node: RichTreeNode, inherited: RichSpanStyle): void => {
    if (node.text !== undefined) {
      // Collapse the whitespace runs HTML serialization is full of.
      emit(node.text.replace(/\s+/g, ' '), inherited);
      return;
    }
    const style = styleOf(node, inherited);
    const isBlock = BLOCK_TAGS.has(node.tag ?? '');
    if (isBlock && parts.length > 0 && parts[parts.length - 1] !== ' ') {
      emit(' ', inherited);
    }
    for (const child of node.children ?? []) walk(child, style);
    if (isBlock && parts.length > 0 && parts[parts.length - 1] !== ' ') {
      emit(' ', inherited);
    }
  };
  for (const n of nodes) walk(n, {});

  // Trim + collapse interior runs the block-spacing may have doubled,
  // keeping the styles array aligned.
  const chars: string[] = [];
  const kept: RichSpanStyle[] = [];
  for (let i = 0; i < parts.length; i++) {
    const ch = parts[i];
    if (ch === ' ' && (chars.length === 0 || chars[chars.length - 1] === ' ')) continue;
    chars.push(ch);
    kept.push(styles[i]);
  }
  while (chars.length > 0 && chars[chars.length - 1] === ' ') {
    chars.pop();
    kept.pop();
  }

  const text = chars.join('');
  const spans: RichPasteResult['spans'] = [];
  let runStart = 0;
  for (let i = 1; i <= kept.length; i++) {
    if (i === kept.length || styleKeyOf(kept[i]) !== styleKeyOf(kept[runStart])) {
      const st = kept[runStart];
      if (styleKeyOf(st) !== EMPTY_KEY) {
        spans.push({ start: runStart, end: i, style: { ...st } });
      }
      runStart = i;
    }
  }
  return { text, spans };
}

/** Browser-side shim: element → the serializable tree the pure walk takes.
 * Thin by design — everything decidable lives in `treeToRich`. */
export function domToTree(root: ParentNode): RichTreeNode[] {
  const convert = (n: Node): RichTreeNode | null => {
    if (n.nodeType === 3) return { text: n.textContent ?? '' };
    if (n.nodeType !== 1) return null;
    const el = n as HTMLElement;
    const tag = el.tagName.toLowerCase();
    if (tag === 'style' || tag === 'script' || tag === 'head' || tag === 'meta') return null;
    const style: Record<string, string> = {};
    const raw = el.getAttribute('style') ?? '';
    for (const decl of raw.split(';')) {
      const ci = decl.indexOf(':');
      if (ci > 0) style[decl.slice(0, ci).trim().toLowerCase()] = decl.slice(ci + 1).trim();
    }
    // Legacy <font> attributes (Word and old mail clients emit them).
    if (tag === 'font') {
      const face = el.getAttribute('face');
      if (face && !style['font-family']) style['font-family'] = face;
      const color = el.getAttribute('color');
      if (color && !style.color) style.color = color;
    }
    const children: RichTreeNode[] = [];
    for (const c of Array.from(el.childNodes)) {
      const t = convert(c);
      if (t) children.push(t);
    }
    return { tag, style, children };
  };
  const out: RichTreeNode[] = [];
  for (const c of Array.from(root.childNodes)) {
    const t = convert(c);
    if (t) out.push(t);
  }
  return out;
}

/** The paste entry point: clipboard HTML → text + ranges, or null when the
 * payload carries no expressible styling (the caller then takes the plain
 * path — identical outcome, zero new machinery armed). */
export function parseRichHtml(html: string): RichPasteResult | null {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const result = treeToRich(domToTree(doc.body));
  if (!result.text) return null;
  return result;
}
