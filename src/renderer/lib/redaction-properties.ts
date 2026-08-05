// The redaction MARK's appearance.
//
// Every field here is a key on the `/Redact` annotation, which is why this is
// a small typed record rather than an options bag: `/IC` is the fill,
// `/OverlayText` the text drawn over it, `/Repeat` tiles that text, `/Q`
// aligns it, `/DA` carries the size and colour. `save_redaction_marks` writes
// them and `list_redact_annotations` reads them back, so a mark survives a
// round trip through another viewer.
//
// The properties are HOW YOU WORK, not a property of a file — the same
// reasoning the snap settings live in app storage under — so they persist
// here and govern BOTH producers: the band drawn on the canvas and every mark
// the Search & Redact panel makes.

export interface RedactionProperties {
  /** `/IC` — the box colour, RGB 0..1. Black is the format's own default and
   * ours. */
  fill: [number, number, number];
  /** `/OverlayText` — drawn over the box. Empty = a plain filled box. */
  overlayText: string;
  /** `setId/codeId` when the overlay text came from a code set, so the picker
   * can show what is selected. Purely a UI memory: the FILE only ever carries
   * the label, because the format has no key for a code. */
  codeRef: string;
  /** `/Repeat` — tile the overlay to fill the box. */
  repeatOverlay: boolean;
  /** `/Q` — 0 left, 1 centred, 2 right. */
  align: 0 | 1 | 2;
  /** `/DA` size in points. 0 = fit the box, which is the format's own
   * meaning for a zero size in a default-appearance string. */
  fontSize: number;
  /** `/DA` colour, or null to let the applier contrast it against the fill —
   * white on a dark box, black on a light one. A fixed default would draw
   * white on white the first time someone chooses a white fill. */
  textColor: [number, number, number] | null;
}

export const DEFAULT_REDACTION_PROPERTIES: RedactionProperties = {
  fill: [0, 0, 0],
  overlayText: '',
  codeRef: '',
  repeatOverlay: false,
  align: 0,
  fontSize: 0,
  textColor: null,
};

const KEY = 'spectra-redaction-properties';

function clamp01(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.min(Math.max(n, 0), 1);
}

function readRgb(value: unknown): [number, number, number] | null {
  if (!Array.isArray(value) || value.length !== 3) return null;
  return [clamp01(value[0]), clamp01(value[1]), clamp01(value[2])];
}

export function loadRedactionProperties(): RedactionProperties {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (!raw || typeof raw !== 'object') return DEFAULT_REDACTION_PROPERTIES;
    const stored = raw as Record<string, unknown>;
    const align = Number(stored.align);
    const size = Number(stored.fontSize);
    return {
      fill: readRgb(stored.fill) ?? DEFAULT_REDACTION_PROPERTIES.fill,
      overlayText: typeof stored.overlayText === 'string' ? stored.overlayText : '',
      codeRef: typeof stored.codeRef === 'string' ? stored.codeRef : '',
      repeatOverlay: !!stored.repeatOverlay,
      align: align === 1 || align === 2 ? align : 0,
      fontSize: Number.isFinite(size) && size >= 0 ? Math.min(size, 144) : 0,
      textColor: readRgb(stored.textColor),
    };
  } catch {
    return DEFAULT_REDACTION_PROPERTIES;
  }
}

export function saveRedactionProperties(props: RedactionProperties): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(props));
  } catch {
    /* storage unavailable — the defaults still apply */
  }
  for (const fn of [...listeners]) fn();
}

const listeners = new Set<() => void>();

export function subscribeRedactionProperties(fn: () => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** The engine payload for one region — the `redact` / `save_redaction_marks`
 * key names, which are the PDF key names one step removed.
 *
 * Fields the user left at their default are OMITTED, not sent as defaults:
 * "no overlay" and "an overlay of nothing" must stay distinguishable through
 * the file, or a round trip through another viewer turns one into the other.
 */
export function propertiesPayload(props: RedactionProperties): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const [r, g, b] = props.fill;
  if (r !== 0 || g !== 0 || b !== 0) out.fill = [r, g, b];
  if (props.overlayText) {
    out.overlay_text = props.overlayText;
    if (props.repeatOverlay) out.repeat_overlay = true;
    if (props.align !== 0) out.align = props.align;
    if (props.fontSize > 0) out.font_size = props.fontSize;
    if (props.textColor) out.text_color = props.textColor;
  }
  return out;
}

/** The inverse: what `list_redact_annotations` reported for a stored mark,
 * back into the panel's record. Unknown/absent keys keep their defaults —
 * the reader never invents a value the file did not state. */
export function propertiesFromPayload(payload: Record<string, unknown> | undefined): RedactionProperties {
  if (!payload) return DEFAULT_REDACTION_PROPERTIES;
  const align = Number(payload.align);
  const size = Number(payload.font_size);
  return {
    fill: readRgb(payload.fill) ?? DEFAULT_REDACTION_PROPERTIES.fill,
    overlayText: typeof payload.overlay_text === 'string' ? payload.overlay_text : '',
    codeRef: '',
    repeatOverlay: !!payload.repeat_overlay,
    align: align === 1 || align === 2 ? align : 0,
    fontSize: Number.isFinite(size) && size > 0 ? size : 0,
    textColor: readRgb(payload.text_color),
  };
}

/** `#rrggbb` ⇄ RGB 0..1, for the colour inputs (which speak hex). */
export function rgbToHex(rgb: readonly number[]): string {
  const part = (v: number): string =>
    Math.round(Math.min(Math.max(v, 0), 1) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${part(rgb[0])}${part(rgb[1])}${part(rgb[2])}`;
}

export function hexToRgb(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
