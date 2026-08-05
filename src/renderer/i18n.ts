// N12 (brief 37) — the i18next core. Catalogs are BUNDLED (no runtime
// fetch); keys are STABLE SEMANTIC IDS derived from the data tables that
// already name every surface (command ids, menu ids), so English copy can
// change without orphaning translations. `en` is the source catalog,
// GENERATED from the registry/menu tables by `scripts/gen-i18n-en.mjs` —
// a hand-edited en catalog would drift from the tables it mirrors; the
// vitest parity gate diffs the generated output against the checked-in
// file, and every other locale's key set must equal en's exactly.
//
// Under VITE_E2E the language is FORCED to 'en': the e2e suite asserts
// English text in places, and locale coverage is its own spec driving the
// Settings control (slice E).
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import enChrome from './locales/en/chrome.json';
import esChrome from './locales/es/chrome.json';
import frChrome from './locales/fr/chrome.json';
import deChrome from './locales/de/chrome.json';
import { CHROME_STRINGS, type ChromeKey, type ChromePluralKey } from './i18n-chrome';
import { PANEL_STRINGS, type PanelKey } from './i18n-panels';
import { DIALOG_STRINGS, type DialogKey } from './i18n-dialogs';
import { WORKBENCH_STRINGS, type WorkbenchKey } from './i18n-workbench';
import { CANVAS_STRINGS, type CanvasKey } from './i18n-canvas';
import { REFUSAL_STRINGS, type RefusalKey } from './i18n-refusals';
import { loadSettings } from './lib/app-settings';
import { OCR_LANGUAGES } from './ocr/languages';

export const SHIPPED_LOCALES: readonly string[] = ['en', 'es', 'fr', 'de'];

/** Each locale's display name in ITS OWN language (the language-picker
 * convention — a reader hunting for their language finds it by its native
 * name, so these are proper names, never translated). */
export const LOCALE_NATIVE_NAMES: Record<string, string> = {
  en: 'English',
  es: 'Español',
  fr: 'Français',
  de: 'Deutsch',
};

/** Resolve a stored language preference ('system' | code) to a shipped
 * locale. Exported for the Settings panel and for tests. */
export function resolveLanguage(pref: string): string {
  const want = pref === 'system'
    ? (typeof navigator === 'undefined' ? 'en' : navigator.language || 'en')
    : pref;
  const w = want.toLowerCase();
  const exact = SHIPPED_LOCALES.find((l) => l.toLowerCase() === w);
  if (exact) return exact;
  const base = w.split('-')[0];
  return SHIPPED_LOCALES.find((l) => l.toLowerCase() === base) ?? 'en';
}

function detectLanguage(): string {
  // The e2e suite asserts English text; locale coverage is its own spec,
  // which switches EXPLICITLY via setAppLanguage.
  if (import.meta.env.VITE_E2E) return 'en';
  // Node test env (vitest imports data modules that reach this file) has no
  // navigator/localStorage; every reader below degrades to 'en'.
  return resolveLanguage(loadSettings().language ?? 'system');
}

/** qps — the DEV/e2e pseudo-locale (brief 37): every en string bracketed
 * and vowel-stretched, so a covered surface shows [Ẽẽxãã...] and a bare
 * English leak stands out. Generated from en at init — never authored,
 * never shipped (not in SHIPPED_LOCALES, absent from the Settings list). */
function pseudo(catalog: Record<string, string>): Record<string, string> {
  const stretch = (s: string): string =>
    s.replace(/\{\{[^}]*\}\}/g, (m) => `\u0000${m}\u0000`)
      .split('\u0000')
      .map((part) =>
        part.startsWith('{{')
          ? part
          : part.replace(/[aeiouAEIOU]/g, (v) => v + v.normalize()),
      )
      .join('');
  return Object.fromEntries(
    Object.entries(catalog).map(([k, v]) => [k, `[${stretch(v)}]`]),
  );
}

void i18next.use(initReactI18next).init({
  lng: detectLanguage(),
  fallbackLng: 'en',
  defaultNS: 'chrome',
  ns: ['chrome'],
  resources: {
    en: { chrome: enChrome },
    es: { chrome: esChrome },
    fr: { chrome: frChrome },
    de: { chrome: deChrome },
    ...(import.meta.env.DEV || import.meta.env.VITE_E2E
      ? { qps: { chrome: pseudo(enChrome as Record<string, string>) } }
      : {}),
  },
  interpolation: { escapeValue: false }, // React escapes; double-escaping corrupts
  returnEmptyString: false,
});

/**
 * Keep `<html lang>` in step with the UI language.
 *
 * `index.html` ships `lang="en"` and nothing updated it, so a Spanish UI
 * still announced itself as English: a screen reader picked English
 * pronunciation rules for Spanish text, and the platform's own hyphenation
 * and spell-check heuristics keyed off the wrong language. Found by the
 * slice-E RTL spot-check — the attribute is also where a future RTL locale
 * would carry `dir`, but nothing sets `dir` today and nothing should until a
 * mirrored layout exists (see the punchlist's RTL row: half-mirroring is
 * worse than not mirroring).
 */
function syncDocumentLanguage(lng: string): void {
  if (typeof document === 'undefined') return;
  // qps is a DEV pseudo-locale with no BCP-47 identity; leave the document
  // marked as its English source rather than claiming a language that is not
  // one.
  document.documentElement.lang = lng === 'qps' ? 'en' : lng;
}
syncDocumentLanguage(i18next.language ?? 'en');
i18next.on('languageChanged', syncDocumentLanguage);

/** Switch the live UI language (the Settings panel persists the pref and
 * calls this; react-i18next re-renders every hooked component). */
export function setAppLanguage(pref: string): void {
  void i18next.changeLanguage(
    pref === 'qps' ? 'qps' : resolveLanguage(pref),
  );
}

export default i18next;

/**
 * Translate a COMMAND's menu/palette title by its stable id, falling back
 * to the registry's own English. The fallback is a safety net for a key
 * missing at runtime, never a shipped state — the parity gate keeps the
 * catalogs complete.
 */
export function tCommandTitle(commandId: string, englishTitle: string, lng?: string): string {
  return i18next.t(`cmd.${commandId}`, {
    defaultValue: englishTitle,
    ...(lng ? { lng } : {}),
  });
}

/** Translate a top-level menu or submenu label by its stable id. */
export function tMenuLabel(menuId: string, englishLabel: string): string {
  return i18next.t(`menu.${menuId}`, { defaultValue: englishLabel });
}

/**
 * A TOOL's name, and an OPERATION's name, in the UI language.
 *
 * Both read the COMMAND key rather than a second key of their own: every tool
 * is `tools.open.<id>` and every operation is `tools.panel.<op>` in the
 * registry, whose titles ARE these strings and are already generated into
 * `cmd.*`. Minting `tool.title.*` would let the Tools menu and the dock
 * header disagree about a tool's name in one language — which is precisely
 * the drift `commands/tools.ts` was written to end in English.
 *
 * `lng` pins a language — the omnisearch passes the live one so its ranking
 * memo genuinely DEPENDS on it (a memo that reads the ambient language would
 * keep the previous language's hits after a switch).
 */
export function tToolTitle(toolId: string, englishTitle: string, lng?: string): string {
  return tCommandTitle(`tools.open.${toolId}`, englishTitle, lng);
}
export function tOperationTitle(op: string, englishTitle: string, lng?: string): string {
  return tCommandTitle(`tools.panel.${op}`, englishTitle, lng);
}

/** A NAV PANEL's title (icon-strip tooltip + panel header). NAV_PANEL_TITLES
 * is a data table, so the catalog gate derives `navpanel.*` from it. */
export function tNavPanelTitle(panelId: string, englishTitle: string): string {
  return i18next.t(`navpanel.${panelId}`, { defaultValue: englishTitle });
}

/** A tool's one-line blurb (the tile tooltip). No command carries it, so the
 * catalog gate derives `tool.desc.*` from TOOL_DEFS like the other tables. */
export function tToolDescription(
  toolId: string,
  englishDescription: string,
  lng?: string,
): string {
  return i18next.t(`tool.desc.${toolId}`, {
    defaultValue: englishDescription,
    ...(lng ? { lng } : {}),
  });
}

/**
 * A RECOGNITION LANGUAGE's name in the current UI language.
 *
 * Language names are the one class of UI string that must NOT be authored
 * into the catalogs: every locale's ICU data already spells all 47 of them,
 * and hand-translating that table per shipped locale is 47 chances to be
 * wrong. `Intl.DisplayNames` reads them from the platform instead — which is
 * why `OcrLanguage` carries an explicit BCP-47 tag beside Tesseract's own
 * code. The English label is the fallback if the platform has no name.
 *
 * Consequence to know: these names are NOT pseudo-localized under `qps`
 * (they never pass through the catalog), so the leak sweep must not read a
 * bare language name as an untranslated string.
 */
export function tOcrLanguage(code: string): string {
  const entry = OCR_LANGUAGES.find((l) => l.code === code);
  if (!entry) return code;
  try {
    return (
      new Intl.DisplayNames([i18next.language], { type: 'language' }).of(entry.bcp47) ??
      entry.label
    );
  } catch {
    return entry.label;
  }
}

/** Locale-aware number formatting (brief 37: `Intl.NumberFormat`, never a
 * hand-rolled decimal — the separator and grouping are locale properties). */
export function tNumber(value: number, opts?: Intl.NumberFormatOptions): string {
  return new Intl.NumberFormat(i18next.language, opts).format(value);
}

/** Locale-aware DATE formatting for an ISO timestamp. An unparseable value
 * passes through verbatim rather than rendering "Invalid Date". */
export function tDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat(i18next.language, { dateStyle: 'medium' }).format(d);
}

/** Translate an OPERATION QUEUE op name by its engine method id (the
 * FRIENDLY_NAMES table — a data table, so its keys are generated from it
 * like the command titles). `lng` pins a language: the operation LOG is
 * written in English (a diagnostic sink, the slice-D boundary) while the
 * queue itself renders in the user's locale. */
export function tQueueOp(method: string, englishName: string, lng?: string): string {
  return i18next.t(`opqueue.op.${method}`, {
    defaultValue: englishName,
    ...(lng ? { lng } : {}),
  });
}

/** Translate a TOOLBAR CATALOG group's label by its stable id — the
 * Customize Toolbar dialog's section heads. The catalog is a data table, so
 * its keys are generated from it exactly like the command titles. */
export function tToolbarGroup(groupId: string, englishLabel: string): string {
  return i18next.t(`toolbar.group.${groupId}`, { defaultValue: englishLabel });
}

// The typed UI records, merged: chrome (slice A) + panels, dialogs and the
// workbench chrome (slice B) + the canvas and its overlays (slice C) + the
// renderer's own refusal messages (slice E). One helper set serves all six —
// a key is compile-time-checked against the union.
const UI_STRINGS: Record<string, string> = {
  ...CHROME_STRINGS,
  ...PANEL_STRINGS,
  ...DIALOG_STRINGS,
  ...WORKBENCH_STRINGS,
  ...CANVAS_STRINGS,
  ...REFUSAL_STRINGS,
};
export type UiKey =
  | ChromeKey
  | PanelKey
  | DialogKey
  | WorkbenchKey
  | CanvasKey
  | RefusalKey;
type UiPluralKey =
  | ChromePluralKey
  | { [K in PanelKey]: K extends `${infer B}_one` ? B : never }[PanelKey]
  | { [K in DialogKey]: K extends `${infer B}_one` ? B : never }[DialogKey]
  | { [K in WorkbenchKey]: K extends `${infer B}_one` ? B : never }[WorkbenchKey]
  | { [K in CanvasKey]: K extends `${infer B}_one` ? B : never }[CanvasKey];

/**
 * Translate a JSX/dynamic UI string by its typed key (the CHROME_STRINGS /
 * PANEL_STRINGS records carry the English). `vars` interpolates `{{name}}`
 * placeholders.
 */
export function tChrome(
  key: UiKey,
  vars?: Record<string, string | number>,
  lng?: string,
): string {
  return i18next.t(key, {
    defaultValue: UI_STRINGS[key],
    ...vars,
    ...(lng ? { lng } : {}),
  });
}

/**
 * Translate a PLURAL UI message by its base id — i18next resolves the
 * `_one`/`_other` catalog pair from `count` per the locale's plural rules.
 */
/**
 * N12 slice B — the guided-actions STEP CATALOG's display strings. The
 * catalog is serialized DATA (saved actions carry op ids, never titles),
 * so titles/labels localize at render through keys DERIVED from the
 * table (`gaction.*`), generated into the en catalog by the i18n-catalog
 * gate exactly like the command titles. The OCR language options are
 * excluded (they await the Intl.DisplayNames switch in the dialogs pass)
 * and render their English labels meanwhile.
 */
export const tStepTitle = (op: string, english: string): string =>
  i18next.t(`gaction.step.${op}`, { defaultValue: english });
export const tStepParam = (op: string, key: string, english: string): string =>
  i18next.t(`gaction.param.${op}.${key}`, { defaultValue: english });
export const tStepOption = (op: string, key: string, value: string, english: string): string =>
  op === 'ocr_file' && key === 'language'
    ? english
    : i18next.t(`gaction.opt.${op}.${key}.${value}`, { defaultValue: english });
export const tStepHint = (op: string, key: string, english: string): string =>
  i18next.t(`gaction.hint.${op}.${key}`, { defaultValue: english });

/**
 * Does this status line say "something failed"? The panels format every
 * failure through ONE key (`panel.common.error`), and this asks that same
 * key what its literal prefix is in the CURRENT locale — so the status
 * bar's error tone is exact in every language.
 *
 * The landmine this exists to kill (the RepairPanel class, N12 slice B):
 * chrome that discriminates by sniffing its own ENGLISH text — here
 * `message.startsWith('Error')` — goes silently wrong the moment the text
 * is translated. Prefer a state discriminant; where the only signal IS the
 * formatted string, derive the comparison from the catalog, never from a
 * hardcoded English literal.
 */
export function isPanelErrorText(text: string): boolean {
  const prefix = i18next
    .t('panel.common.error', {
      message: '',
      defaultValue: UI_STRINGS['panel.common.error'],
    })
    .trim();
  return prefix.length > 0 && text.startsWith(prefix);
}

export function tChromeCount(
  key: UiPluralKey,
  count: number,
  vars?: Record<string, string | number>,
  lng?: string,
): string {
  const suffix = count === 1 ? '_one' : '_other';
  return i18next.t(key, {
    count,
    defaultValue: UI_STRINGS[`${key}${suffix}`],
    ...vars,
    ...(lng ? { lng } : {}),
  });
}
