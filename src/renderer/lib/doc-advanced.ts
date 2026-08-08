// The Advanced tab's model: the engine payload, the page-size summary's
// display shape, and the change set a save sends. Pure — the paper-name
// matching in particular is a rule that deserves a test rather than a
// component.

export type TrappedValue = 'true' | 'false' | 'unknown';

export const TRAPPED_VALUES: readonly TrappedValue[] = ['true', 'false', 'unknown'];

export interface PageSizeGroup {
  /** Points. */
  width: number;
  height: number;
  count: number;
}

export interface AdvancedProperties {
  version: string;
  linearized: boolean;
  tagged: boolean;
  pages: number;
  page_sizes: PageSizeGroup[];
  bytes: number;
  trapped: TrappedValue;
  base_url: string;
  has_open_action: boolean;
  /** The .pdx index a producer recorded, or null when none is recorded. */
  search_index: string | null;
}

export const DEFAULT_ADVANCED: AdvancedProperties = {
  version: '',
  linearized: false,
  tagged: false,
  pages: 0,
  page_sizes: [],
  bytes: 0,
  trapped: 'unknown',
  base_url: '',
  has_open_action: false,
  search_index: null,
};

export function parseAdvanced(raw: Record<string, unknown>): AdvancedProperties {
  const sizes: PageSizeGroup[] = [];
  if (Array.isArray(raw.page_sizes)) {
    for (const entry of raw.page_sizes) {
      if (!entry || typeof entry !== 'object') continue;
      const group = entry as Record<string, unknown>;
      if (
        typeof group.width === 'number' &&
        typeof group.height === 'number' &&
        typeof group.count === 'number'
      ) {
        sizes.push({ width: group.width, height: group.height, count: group.count });
      }
    }
  }
  const trapped = raw.trapped;
  return {
    version: typeof raw.version === 'string' ? raw.version : '',
    linearized: raw.linearized === true,
    tagged: raw.tagged === true,
    pages: typeof raw.pages === 'number' ? raw.pages : 0,
    page_sizes: sizes,
    bytes: typeof raw.bytes === 'number' ? raw.bytes : 0,
    trapped:
      typeof trapped === 'string' && (TRAPPED_VALUES as readonly string[]).includes(trapped)
        ? (trapped as TrappedValue)
        : 'unknown',
    base_url: typeof raw.base_url === 'string' ? raw.base_url : '',
    has_open_action: raw.has_open_action === true,
    search_index: typeof raw.search_index === 'string' && raw.search_index ? raw.search_index : null,
  };
}

/** The `set_advanced_properties` parameters carrying `next` from `base`, or
 * null when nothing changed. */
export function advancedChanges(
  base: AdvancedProperties,
  next: AdvancedProperties,
): Record<string, unknown> | null {
  const params: Record<string, unknown> = {};
  if (next.trapped !== base.trapped) params.trapped = next.trapped;
  if (next.base_url !== base.base_url) params.base_url = next.base_url;
  return Object.keys(params).length > 0 ? params : null;
}

// The standard papers a size is named by, in points, with the tolerance a
// producer's rounding needs. 0.5pt: A4's 841.89pt height is written as 841.89,
// 841.9 or 842 by different producers, and all three are A4.
const PAPER_TOLERANCE = 0.5;
const PAPERS: readonly { name: string; width: number; height: number }[] = [
  { name: 'Letter', width: 612, height: 792 },
  { name: 'Legal', width: 612, height: 1008 },
  { name: 'Tabloid', width: 792, height: 1224 },
  { name: 'Executive', width: 522, height: 756 },
  { name: 'A3', width: 841.89, height: 1190.55 },
  { name: 'A4', width: 595.28, height: 841.89 },
  { name: 'A5', width: 419.53, height: 595.28 },
  { name: 'A6', width: 297.64, height: 419.53 },
  { name: 'B4', width: 708.66, height: 1000.63 },
  { name: 'B5', width: 498.9, height: 708.66 },
];

/** The standard paper a size is, or null. Matches in either orientation — a
 * landscape A4 is still A4, and saying so is more useful than two numbers. */
export function paperNameOf(width: number, height: number): string | null {
  for (const paper of PAPERS) {
    const upright =
      Math.abs(width - paper.width) <= PAPER_TOLERANCE &&
      Math.abs(height - paper.height) <= PAPER_TOLERANCE;
    const landscape =
      Math.abs(height - paper.width) <= PAPER_TOLERANCE &&
      Math.abs(width - paper.height) <= PAPER_TOLERANCE;
    if (upright || landscape) return paper.name;
  }
  return null;
}

/** Points → inches and millimetres, rounded for display. 72pt = 1in exactly. */
export function pageSizeMeasures(width: number, height: number): {
  inches: { w: number; h: number };
  millimetres: { w: number; h: number };
} {
  const round2 = (v: number): number => Math.round(v * 100) / 100;
  const round1 = (v: number): number => Math.round(v * 10) / 10;
  return {
    inches: { w: round2(width / 72), h: round2(height / 72) },
    millimetres: { w: round1((width / 72) * 25.4), h: round1((height / 72) * 25.4) },
  };
}
