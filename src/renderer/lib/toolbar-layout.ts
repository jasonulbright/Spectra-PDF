// Toolbar visibility overrides (I.6 toolbar customization — the
// `spectra-toolbar` localStorage key). Lives in the ui slice so the toolbar
// and the customize dialog render it reactively; App mirrors
// ui.toolbarOverrides → localStorage in one effect (the recent-files
// pattern), so callers only compute the next value and dispatch.
//
// The model is EXPLICIT OVERRIDES, not a materialized list: `shown` and
// `hidden` name only the commands the user changed; everything else follows
// its catalog default. That keeps the stored value forward-compatible — a new
// catalog item appears at its own default, and an id that stops existing
// simply stops matching (validated away on the next save).

const KEY = 'spectra-toolbar';

export interface ToolbarOverrides {
  shown: string[];
  hidden: string[];
}

export const NO_OVERRIDES: ToolbarOverrides = { shown: [], hidden: [] };

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === 'string');
}

/** Pure, testable core: JSON-valid-but-wrong-shape → NO_OVERRIDES, and an id
 * can never sit in both lists (hidden wins — the safer direction: a button
 * that should be there is one click away in the dialog; one that should NOT
 * be can invoke a command). */
export function parseToolbarOverrides(raw: string | null): ToolbarOverrides {
  try {
    const parsed: unknown = JSON.parse(raw || 'null');
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return NO_OVERRIDES;
    const hidden = stringList((parsed as { hidden?: unknown }).hidden);
    const hiddenSet = new Set(hidden);
    const shown = stringList((parsed as { shown?: unknown }).shown).filter((id) => !hiddenSet.has(id));
    if (shown.length === 0 && hidden.length === 0) return NO_OVERRIDES;
    return { shown, hidden };
  } catch {
    return NO_OVERRIDES;
  }
}

export function readToolbarOverrides(): ToolbarOverrides {
  try {
    return parseToolbarOverrides(localStorage.getItem(KEY));
  } catch {
    return NO_OVERRIDES;
  }
}

export function persistToolbarOverrides(overrides: ToolbarOverrides): void {
  try {
    if (overrides.shown.length === 0 && overrides.hidden.length === 0) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, JSON.stringify(overrides));
  } catch {
    // storage unavailable — the session keeps its in-memory layout
  }
}

export function isToolbarItemVisible(
  command: string,
  byDefault: boolean,
  overrides: ToolbarOverrides,
): boolean {
  if (overrides.hidden.includes(command)) return false;
  if (overrides.shown.includes(command)) return true;
  return byDefault;
}

/** The next overrides after setting one item's visibility — an override is
 * stored only when it DIFFERS from the default, so "back to default" and
 * "reset" converge on NO_OVERRIDES naturally. */
export function withToolbarVisibility(
  overrides: ToolbarOverrides,
  command: string,
  byDefault: boolean,
  visible: boolean,
): ToolbarOverrides {
  const shown = overrides.shown.filter((id) => id !== command);
  const hidden = overrides.hidden.filter((id) => id !== command);
  if (visible && !byDefault) shown.push(command);
  if (!visible && byDefault) hidden.push(command);
  return { shown, hidden };
}
