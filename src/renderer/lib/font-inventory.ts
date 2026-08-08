// The Fonts tab's model: the engine payload plus the grouping and ordering the
// tab renders. Pure, so the ordering rules are testable without a DOM.

export interface DocumentFont {
  /** The display name — subset prefix stripped. Empty for a font that carries
   * no /BaseFont at all (a Type3 usually does not). */
  name: string;
  raw_name: string;
  type: string;
  encoding: string;
  embedded: boolean;
  subset: boolean;
  /** The face this app would substitute; null when the font is embedded or
   * when no fonts directory was available to resolve one. */
  substitute: string | null;
  pages: number[];
  page_count: number;
}

export interface FontGroup {
  /** The font type the group collects — the engine's own name for it. */
  type: string;
  fonts: DocumentFont[];
}

/** Type order: the simple fonts first (the overwhelming majority of real
 * documents), then composite, then the procedural outlier, then anything a
 * future engine reports that this list does not name. */
const TYPE_ORDER = ['Type1', 'MMType1', 'TrueType', 'Type0', 'CIDFontType0', 'CIDFontType2', 'Type3'];

function typeRank(type: string): number {
  const index = TYPE_ORDER.indexOf(type);
  return index === -1 ? TYPE_ORDER.length : index;
}

export function parseDocumentFonts(raw: unknown): DocumentFont[] {
  if (!raw || typeof raw !== 'object' || !Array.isArray((raw as { fonts?: unknown }).fonts)) {
    return [];
  }
  const list = (raw as { fonts: unknown[] }).fonts;
  const out: DocumentFont[] = [];
  for (const entry of list) {
    if (!entry || typeof entry !== 'object') continue;
    const font = entry as Record<string, unknown>;
    const pages = Array.isArray(font.pages) ? font.pages.filter((p) => typeof p === 'number') : [];
    out.push({
      name: typeof font.name === 'string' ? font.name : '',
      raw_name: typeof font.raw_name === 'string' ? font.raw_name : '',
      type: typeof font.type === 'string' && font.type ? font.type : 'Unknown',
      encoding: typeof font.encoding === 'string' && font.encoding ? font.encoding : 'Built-in',
      embedded: font.embedded === true,
      subset: font.subset === true,
      substitute: typeof font.substitute === 'string' ? font.substitute : null,
      pages: pages as number[],
      page_count:
        typeof font.page_count === 'number' ? font.page_count : (pages as number[]).length,
    });
  }
  return out;
}

/** Group by type, ordered by `TYPE_ORDER` then alphabetically; within a group,
 * by display name. A font with no name sorts last rather than first — an empty
 * string would otherwise lead every list it appears in. */
export function groupFonts(fonts: readonly DocumentFont[]): FontGroup[] {
  const groups = new Map<string, DocumentFont[]>();
  for (const font of fonts) {
    const bucket = groups.get(font.type);
    if (bucket) bucket.push(font);
    else groups.set(font.type, [font]);
  }
  return [...groups.entries()]
    .sort((a, b) => typeRank(a[0]) - typeRank(b[0]) || a[0].localeCompare(b[0]))
    .map(([type, list]) => ({
      type,
      fonts: [...list].sort((a, b) => {
        if (!a.name !== !b.name) return a.name ? -1 : 1;
        return a.name.localeCompare(b.name) || a.encoding.localeCompare(b.encoding);
      }),
    }));
}

/** How a font's program status reads, as a catalog key plus its values. Four
 * distinct states, because "embedded" and "embedded subset" are different
 * facts and so are the two ways a substitution can be unknown. */
export type FontStatus =
  | { kind: 'embedded-subset' }
  | { kind: 'embedded' }
  | { kind: 'substituted'; face: string }
  | { kind: 'not-embedded' };

export function fontStatus(font: DocumentFont): FontStatus {
  if (font.embedded) return font.subset ? { kind: 'embedded-subset' } : { kind: 'embedded' };
  if (font.substitute) return { kind: 'substituted', face: font.substitute };
  return { kind: 'not-embedded' };
}

/** A stable, language-independent DOM handle per font row. Built from the raw
 * name and type rather than the display name, so two fonts differing only by
 * subset prefix do not collide. */
export function fontTestId(font: DocumentFont): string {
  const slug = `${font.raw_name}-${font.type}-${font.encoding}`
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
  return slug || 'unnamed';
}
