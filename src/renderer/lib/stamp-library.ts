// Custom and dynamic stamp library.
// A LEAF module: localStorage + pure helpers only, so the token resolver and
// the shape validation are unit-testable (no DOM test environment — the
// breakable part must be the testable part).
//
// Two stamp species share one shape:
// - TEXT stamps: `label` (may carry {date}/{time}/{name} tokens) + `color`,
//   drawn by the existing bordered-label appearance. Tokens resolve AT
//   PLACEMENT — a stamp records when it was placed; committing later must
//   not re-date it.
// - IMAGE stamps: `imageData` (a data URL, downscaled at import) + `aspect`
//   (height/width); `label` is the display name. Committed as a real /Stamp
//   whose appearance draws the embedded image.

export interface CustomStamp {
  id: string;
  label: string;
  color: string;
  imageData?: string;
  aspect?: number;
}

const STORE_KEY = 'custom-stamps';

export function loadCustomStamps(): CustomStamp[] {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isCustomStamp);
  } catch {
    return [];
  }
}

export function saveCustomStamps(stamps: CustomStamp[]): void {
  localStorage.setItem(STORE_KEY, JSON.stringify(stamps));
}

export function isCustomStamp(v: unknown): v is CustomStamp {
  if (typeof v !== 'object' || v === null) return false;
  const s = v as Record<string, unknown>;
  if (typeof s.id !== 'string' || typeof s.label !== 'string' || typeof s.color !== 'string') {
    return false;
  }
  if (s.imageData !== undefined) {
    if (typeof s.imageData !== 'string' || !s.imageData.startsWith('data:image/')) return false;
    if (typeof s.aspect !== 'number' || !(s.aspect > 0) || !Number.isFinite(s.aspect)) return false;
  }
  return true;
}

/**
 * Resolve the dynamic tokens in a text stamp's label — {date}, {time},
 * {name} — against the placement moment and the user's identity preference.
 * An empty name collapses cleanly ("SIGNED {name} {date}" without a name
 * must read "SIGNED 7/30/2026", not "SIGNED  7/30/2026").
 *
 * N12 slice C: `locale` is the APP's language, not the machine's. A stamp is
 * authored in the language the user is working in, and the placement writes
 * the resolved text into the document — so a Spanish UI on an English
 * Windows must stamp a Spanish date. Omitting it keeps the platform default
 * (the pure tests call it that way).
 */
export function resolveStampTokens(
  label: string,
  now: Date,
  identityName: string,
  locale?: string,
): string {
  return label
    .replace(/\{date\}/gi, now.toLocaleDateString(locale))
    .replace(/\{time\}/gi, now.toLocaleTimeString(locale))
    .replace(/\{name\}/gi, identityName.trim())
    .replace(/ {2,}/g, ' ')
    .trim();
}

/** True when the label carries a dynamic token (shown in the library UI so a
 * dynamic stamp is recognizable before placing it). */
export function hasStampTokens(label: string): boolean {
  return /\{(date|time|name)\}/i.test(label);
}
