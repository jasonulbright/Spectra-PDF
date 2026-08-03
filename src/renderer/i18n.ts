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

export const SHIPPED_LOCALES: readonly string[] = ['en'];

function detectLanguage(): string {
  if (import.meta.env.VITE_E2E) return 'en';
  const nav = (navigator.language || 'en').toLowerCase();
  const exact = SHIPPED_LOCALES.find((l) => l.toLowerCase() === nav);
  if (exact) return exact;
  const base = nav.split('-')[0];
  return SHIPPED_LOCALES.find((l) => l.toLowerCase() === base) ?? 'en';
}

void i18next.use(initReactI18next).init({
  lng: detectLanguage(),
  fallbackLng: 'en',
  defaultNS: 'chrome',
  ns: ['chrome'],
  resources: {
    en: { chrome: enChrome },
  },
  interpolation: { escapeValue: false }, // React escapes; double-escaping corrupts
  returnEmptyString: false,
});

export default i18next;

/**
 * Translate a COMMAND's menu/palette title by its stable id, falling back
 * to the registry's own English. The fallback is a safety net for a key
 * missing at runtime, never a shipped state — the parity gate keeps the
 * catalogs complete.
 */
export function tCommandTitle(commandId: string, englishTitle: string): string {
  return i18next.t(`cmd.${commandId}`, { defaultValue: englishTitle });
}

/** Translate a top-level menu or submenu label by its stable id. */
export function tMenuLabel(menuId: string, englishLabel: string): string {
  return i18next.t(`menu.${menuId}`, { defaultValue: englishLabel });
}
