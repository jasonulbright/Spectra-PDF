import React, { useState, useEffect, useCallback } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { app, batch, dialog, virtualPrinter, type GsInfo, type VirtualPrinterStatus } from '../lib/tauri-bridge';
import { deriveAccentVars, type ThemeName } from '../lib/accent';
import { StatusBar } from '../components/StatusBar';
import { loadSettings, saveSettings, type Settings } from '../lib/app-settings';
import { clampSnapshotDpi, MAX_SNAPSHOT_DPI, MIN_SNAPSHOT_DPI } from '../lib/snapshot-image';
import { useTranslation } from 'react-i18next';
import { tChrome, setAppLanguage, SHIPPED_LOCALES, LOCALE_NATIVE_NAMES } from '../i18n';
import type { PanelKey } from '../i18n-panels';
// Re-exported for the ~6 existing panel consumers; the implementation is the
// leaf module (the keymap reads it too — see lib/app-settings.ts).
export { getSettings } from '../lib/app-settings';


function getSystemTheme(): string {
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}


// Cached GS info for display
let cachedBundledGs: GsInfo | null = null;
let cachedExternalGs: GsInfo | null = null;

// Initialize GS path from main process (bundled)
let gsPathResolved = false;
async function resolveGsPath(): Promise<void> {
  if (gsPathResolved) return;
  gsPathResolved = true;
  try {
    try {
      cachedBundledGs = await app.getBundledGsInfo();
    } catch {
      // Fall back to direct path resolution.
      const bundledPath = await app.getGsPath();
      cachedBundledGs = { path: bundledPath, version: '', product: 'GPL Ghostscript', vendor: 'Artifex Software' };
    }
    try {
      cachedExternalGs = await app.detectExternalGs();
    } catch {
      cachedExternalGs = null;
    }
    // Ensure gsPath is set for operations; auto-heal if external GS disappeared
    const current = loadSettings();
    if (!current.gsPath || current.gsSource === 'builtin' ||
        (current.gsSource === 'external' && !cachedExternalGs)) {
      saveSettings({ ...current, gsPath: cachedBundledGs.path, gsSource: 'builtin' });
    }
  } catch {
    // BOTH resolution calls failed (one early IPC hiccup). Un-pin the
    // attempt: a resolver that rejects once must not stay a permanently
    // rejected promise that kills every gs feature for the whole session
    // (regression) — ensureGsPath retries a failed attempt.
    gsPathResolved = false;
  }
}
let gsPathReady = resolveGsPath();

/**
 * The gs path, guaranteed resolved.
 * `getSettings().gsPath` is '' for the first IPC round-trip after a fresh
 * launch (the resolver persists asynchronously), and a gs job started in
 * that window failed with a raw spawn error. Every gs caller awaits this
 * instead of reading the setting cold. A failed resolution attempt retries
 * on the next call rather than being cached forever.
 */
export async function ensureGsPath(): Promise<string> {
  await gsPathReady;
  if (!gsPathResolved) {
    gsPathReady = resolveGsPath();
    await gsPathReady;
  }
  return loadSettings().gsPath || cachedBundledGs?.path || '';
}





/**
 * Theme application is a GENERATION, not a sequence of independent writes.
 *
 * Three asynchronous things used to race here: the window `setTheme` IPC (the
 * System branch stamped `data-theme` only inside its `.then()`, frames after
 * the user asked), the accent read, and the focus-change re-read — none of
 * them carrying which theme they were issued for. Whichever callback landed
 * last won, so a live swap could leave the shell stamped for one theme and
 * the accent derived for another, intermittently and only on some
 * transitions. Every apply now takes a token; a callback that arrives after
 * a newer apply is DROPPED rather than allowed to write stale state.
 */
let themeGeneration = 0;

/** The last accent the OS gave us. Kept so a re-derivation on theme change
 * needs no IPC (the shell must never lag the attribute), and so a read that
 * fails or returns nothing leaves the previous palette intact instead of a
 * half-set one — a partial set is how surfaces end up on different blues. */
let lastAccentHex: string | null = null;

/** The shell a stored setting resolves to. 'system' follows the OS; the three
 * explicit themes are themselves. */
function effectiveTheme(setting: string): ThemeName {
  if (setting === 'light' || setting === 'dark' || setting === 'high-contrast') return setting;
  return getSystemTheme() === 'light' ? 'light' : 'dark';
}

/** The shell currently stamped — the attribute IS the mechanism, so it is
 * also the authority on which theme a derivation must target. */
function stampedTheme(): ThemeName {
  const attr = document.documentElement.getAttribute('data-theme');
  return attr === 'light' || attr === 'high-contrast' ? attr : 'dark';
}

/** Apply the theme to the document root and window title bar. */
export function applyTheme(theme?: string): void {
  const setting = theme ?? loadSettings().theme;
  const generation = ++themeGeneration;
  const effective = effectiveTheme(setting);

  // Stamp SYNCHRONOUSLY, in every branch. The attribute is what the shell CSS
  // keys on; making it wait on an IPC round-trip showed the outgoing theme
  // until the round-trip finished.
  stampTheme(effective, generation);

  // The window/title-bar theme follows; System resets it to the OS default and
  // re-reads matchMedia afterwards, because WebView2 can report the old value
  // until tao's set_theme has landed.
  getCurrentWindow()
    .setTheme(setting === 'system' ? null : effective === 'light' ? 'light' : 'dark')
    .then(() => {
      if (setting === 'system') stampTheme(effectiveTheme('system'), generation);
    })
    .catch(() => {});

  applyAccentColor(generation);
}

/** Stamp the shell and re-derive the accent for it, in that order — the
 * variables are a function of the theme, so they can never be applied for a
 * theme that is not the one on screen. No-op once superseded. */
function stampTheme(effective: ThemeName, generation: number): void {
  if (generation !== themeGeneration) return;
  document.documentElement.setAttribute('data-theme', effective);
  if (lastAccentHex) applyAccentVars(lastAccentHex, effective);
}

/**
 * Read the Windows accent and apply it for whatever theme is stamped.
 *
 * The product uses one accent in every theme. What is
 * theme-dependent is the DERIVATION, not the source: see lib/accent.ts. The
 * CSS tables carry the Windows-default blue when the read fails, so nothing
 * ever needs clearing.
 */
function applyAccentColor(generation: number): void {
  app.getSystemAccentColor().then((hex) => {
    if (generation !== themeGeneration) return; // a newer theme owns the shell
    if (!hex) return; // keep the last good palette rather than a partial one
    lastAccentHex = hex;
    applyAccentVars(hex, stampedTheme());
  }).catch(() => {});
}

/** The theme the variables currently on :root were derived for. */
let derivedForTheme: ThemeName | null = null;

/** The ONE writer of the accent custom properties. */
function applyAccentVars(hex: string, theme: ThemeName): void {
  const vars = deriveAccentVars(hex, theme);
  if (!vars) return;
  const root = document.documentElement;
  root.style.setProperty('--accent', vars.accent);
  root.style.setProperty('--accent-hover', vars.hover);
  root.style.setProperty('--accent-muted', vars.muted);
  root.style.setProperty('--accent-subtle', vars.subtle);
  root.style.setProperty('--accent-fg', vars.fg);
  root.style.setProperty('--accent-text', vars.text);
  derivedForTheme = theme;
}

// Apply theme immediately on module load
applyTheme();

/**
 * `data-theme` IS the mechanism — so anything that writes it gets a matching
 * accent, not just applyTheme. theme-boot stamps it before this module loads,
 * and the e2e surface walk stamps it directly on purpose; without this, both
 * would render a shell whose accent was derived for a different one. Keying
 * the derivation off the attribute rather than off the call site is what makes
 * "the variables are a function of the stamped theme" an invariant instead of
 * a convention. Writing style properties never re-triggers this.
 */
new MutationObserver(() => {
  const theme = stampedTheme();
  if (theme === derivedForTheme || !lastAccentHex) return;
  applyAccentVars(lastAccentHex, theme);
}).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });

// Re-apply when system theme changes (only matters when theme === 'system')
window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
  if (loadSettings().theme === 'system') applyTheme('system');
});

// Re-read accent color when app regains focus (user may have changed it in
// Windows Settings). Every theme consumes it — the one-accent rule. It rides
// the CURRENT generation, so a read still in flight when the theme changes is
// dropped by the newer apply instead of landing on the wrong shell.
getCurrentWindow().onFocusChanged(({ payload: focused }) => {
  if (focused) applyAccentColor(themeGeneration);
});

/**
 * Whether the OS is forcing its own palette on the window.
 *
 * The theme setting keeps its stored value while this is true — a transient OS
 * state must not overwrite a standing preference, and switching would change
 * nothing on screen because every colour in either theme is being replaced
 * anyway. What changes is that the picker says so.
 */
function useForcedColors(): boolean {
  const [forced, setForced] = useState(
    () => window.matchMedia('(forced-colors: active)').matches,
  );
  useEffect(() => {
    const mq = window.matchMedia('(forced-colors: active)');
    const onChange = () => setForced(mq.matches);
    mq.addEventListener('change', onChange);
    onChange();
    return () => mq.removeEventListener('change', onChange);
  }, []);
  return forced;
}

function GsInfoDisplay({ info, label }: { info: GsInfo | null; label: string }): React.ReactElement | null {
  if (!info) return null;
  return (
    <div className="px-3 py-2 bg-neutral-800 border border-neutral-700 rounded text-sm">
      <div className="font-medium text-neutral-200">{label}</div>
      <div className="flex flex-col gap-0.5 mt-1 text-xs text-neutral-400">
        <span>{info.product}</span>
        <span>{tChrome('panel.settings.version', { version: info.version })}</span>
        <span>{tChrome('panel.settings.vendor', { vendor: info.vendor })}</span>
      </div>
    </div>
  );
}

/**
 * Preferences categories. Data, like every other list in the workbench:
 * the nav renders from it, so a category cannot exist in one and be missing
 * from the other. `Record<PrefCategory, …>` keeps the labels total.
 *
 * The flat scroll this replaces put Ghostscript, compression, theme, tray and
 * the licence notice in one column — fine at six settings, illegible at twenty,
 * and it gave Help ▸ Third-party Licenses nowhere to land except "the top of
 * the modal, scroll down".
 */
export const PREF_CATEGORIES = ['general', 'appearance', 'engine', 'tray', 'licenses'] as const;
export type PrefCategory = (typeof PREF_CATEGORIES)[number];

// Values are catalog KEYS; the nav renders tChrome(label).
export const PREF_CATEGORY_LABELS: Record<PrefCategory, PanelKey> = {
  general: 'panel.settings.catGeneral',
  appearance: 'panel.settings.catAppearance',
  engine: 'panel.settings.catEngine',
  tray: 'panel.settings.catTray',
  licenses: 'panel.settings.catLicenses',
};

export interface SettingsPanelProps {
  /** Which category to open on. Help ▸ Third-party Licenses lands on its own. */
  initialCategory?: PrefCategory;
}

export function SettingsPanel({ initialCategory = 'general' }: SettingsPanelProps = {}): React.ReactElement {
  // Re-render on language change (the Language select switches live).
  useTranslation();
  const [category, setCategory] = useState<PrefCategory>(initialCategory);
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [status, setStatus] = useState('');
  const [bundledGs, setBundledGs] = useState<GsInfo | null>(cachedBundledGs);
  const [externalGs, setExternalGs] = useState<GsInfo | null>(cachedExternalGs);
  const [startWithWindows, setStartWithWindows] = useState(false);
  const forcedColors = useForcedColors();

  useEffect(() => {
    // Refresh GS info when panel opens (cached values may not be ready yet)
    app.getBundledGsInfo().then((info) => {
      cachedBundledGs = info;
      setBundledGs(info);
    }).catch(() => {});
    app.detectExternalGs().then((info) => {
      cachedExternalGs = info;
      setExternalGs(info);
      // Auto-heal: if external was selected but is now gone, reset to built-in
      if (!info && loadSettings().gsSource === 'external' && cachedBundledGs) {
        const healed = { ...loadSettings(), gsSource: 'builtin' as const, gsPath: cachedBundledGs.path };
        saveSettings(healed);
        setSettings(healed);
      }
    }).catch(() => {});
    // Load startup state from registry (Start with Windows toggle)
    app.getStartupEnabled().then(([enabled]) => {
      setStartWithWindows(enabled);
    }).catch(() => {});
  }, []);

  const update = useCallback((key: keyof Settings, value: string | boolean | number) => {
    setSettings((prev) => {
      const next = { ...prev, [key]: value };
      saveSettings(next);
      return next;
    });
    if (key === 'theme') applyTheme(value as string);
    setStatus(tChrome('panel.settings.saved'));
  }, []);

  const handleGsSourceChange = useCallback((source: 'builtin' | 'external') => {
    const gsPath = source === 'external' && externalGs ? externalGs.path : (bundledGs?.path ?? '');
    setSettings((prev) => {
      const next = { ...prev, gsSource: source, gsPath };
      saveSettings(next);
      return next;
    });
    setStatus(tChrome('panel.settings.saved'));
  }, [bundledGs, externalGs]);

  const activeGs = settings.gsSource === 'external' && externalGs ? externalGs : bundledGs;

  return (
    <div className="prefs">
      <nav className="prefs-nav" aria-label={tChrome('panel.settings.categoriesAria')}>
        {PREF_CATEGORIES.map((c) => (
          <button
            key={c}
            type="button"
            data-testid={`prefs-cat-${c}`}
            aria-pressed={category === c}
            className={'prefs-cat' + (category === c ? ' active' : '')}
            onClick={() => setCategory(c)}
          >
            {tChrome(PREF_CATEGORY_LABELS[c])}
          </button>
        ))}
      </nav>
      <div className="prefs-body flex flex-col gap-6" data-testid={`prefs-body-${category}`}>
      {category === 'engine' && (
      <div>
        <label className="block text-sm text-neutral-400 mb-2">{tChrome('panel.settings.gsEngine')}</label>
        <GsInfoDisplay info={activeGs} label={settings.gsSource === 'external' ? tChrome('panel.settings.gsExternal') : tChrome('panel.settings.gsBuiltin')} />
        {externalGs && (
          <div className="flex gap-2 mt-2">
            <button
              onClick={() => handleGsSourceChange('builtin')}
              className={`px-3 py-1.5 rounded text-xs font-medium transition-colors ${
                settings.gsSource === 'builtin'
                  ? 'bg-blue-600 text-white'
                  : 'bg-neutral-700 hover:bg-neutral-600 text-neutral-300'
              }`}
            >
              {tChrome('panel.settings.builtin')}
            </button>
            <button
              onClick={() => handleGsSourceChange('external')}
              className={`px-3 py-1.5 rounded text-xs font-medium transition-colors ${
                settings.gsSource === 'external'
                  ? 'bg-blue-600 text-white'
                  : 'bg-neutral-700 hover:bg-neutral-600 text-neutral-300'
              }`}
            >
              {tChrome('panel.settings.external')}
            </button>
          </div>
        )}
        <p className="text-xs text-neutral-500 mt-1">{tChrome('panel.settings.gsUsedFor')}</p>
      </div>
      )}

      {category === 'general' && (
      <>
      <div>
        <label className="block text-sm text-neutral-400 mb-1">{tChrome('panel.settings.identityName')}</label>
        <input
          type="text"
          data-testid="pref-identity-name"
          value={settings.identityName}
          onChange={(e) => update('identityName', e.target.value)}
          placeholder={tChrome('panel.settings.identityPlaceholder')}
          className="px-3 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-sm w-72"
        />
        <p className="text-xs text-neutral-500 mt-1">
          {tChrome('panel.settings.identityHint')}
        </p>
      </div>
      <div>
        <label className="block text-sm text-neutral-400 mb-1" htmlFor="pref-snapshot-dpi">
          {tChrome('panel.settings.snapshotDpi')}
        </label>
        <input
          id="pref-snapshot-dpi"
          type="number"
          data-testid="pref-snapshot-dpi"
          min={MIN_SNAPSHOT_DPI}
          max={MAX_SNAPSHOT_DPI}
          value={settings.snapshotDpi}
          onChange={(e) => update('snapshotDpi', clampSnapshotDpi(e.target.value))}
          className="px-3 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-sm w-28"
        />
        <p className="text-xs text-neutral-500 mt-1">
          {tChrome('panel.settings.snapshotDpiHint', { min: MIN_SNAPSHOT_DPI, max: MAX_SNAPSHOT_DPI })}
        </p>
      </div>
      <div>
        <label className="flex items-center gap-2 text-sm text-neutral-400">
          <input
            type="checkbox"
            data-testid="pref-spellcheck-as-you-type"
            checked={settings.spellCheckAsYouType}
            onChange={(e) => update('spellCheckAsYouType', e.target.checked)}
          />
          {tChrome('panel.settings.spellCheckAsYouType')}
        </label>
        <p className="text-xs text-neutral-500 mt-1">
          {tChrome('panel.settings.spellCheckAsYouTypeHint')}
        </p>
      </div>
      <div>
        <label className="block text-sm text-neutral-400 mb-1">{tChrome('panel.settings.compressionQuality')}</label>
        <select
          aria-label={tChrome('panel.settings.compressionQuality')}
          value={settings.compressionQuality}
          onChange={(e) => update('compressionQuality', e.target.value)}
          className="px-3 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-sm"
        >
          <option value="screen">{tChrome('panel.compress.screen')}</option>
          <option value="ebook">{tChrome('panel.compress.ebook')}</option>
          <option value="printer">{tChrome('panel.compress.printer')}</option>
          <option value="prepress">{tChrome('panel.compress.prepress')}</option>
          {/* A user whose corpus is scans can make MRC the default. It is
              a quality of the same compress op, so it belongs in this list
              rather than in a setting of its own. */}
          <option value="mrc">{tChrome('panel.compress.mrc')}</option>
        </select>
      </div>
      <div>
        <label className="block text-sm text-neutral-400 mb-1">{tChrome('panel.settings.mrcPreset')}</label>
        <select
          aria-label={tChrome('panel.settings.mrcPreset')}
          value={settings.mrcPreset}
          onChange={(e) => update('mrcPreset', e.target.value)}
          className="px-3 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-sm"
        >
          <option value="archival">{tChrome('panel.compress.mrcPresetArchival')}</option>
          <option value="balanced">{tChrome('panel.compress.mrcPresetBalanced')}</option>
          <option value="smallest">{tChrome('panel.compress.mrcPresetSmallest')}</option>
        </select>
      </div>
      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          data-testid="pref-single-key"
          checked={settings.singleKeyAccelerators}
          onChange={() => update('singleKeyAccelerators', !settings.singleKeyAccelerators)}
        />
        <span className="text-sm text-neutral-300">
          {tChrome('panel.settings.singleKey')}
        </span>
      </label>
      <p className="text-xs text-neutral-500 -mt-3">
        {tChrome('panel.settings.singleKeyHint')}
      </p>
      <div data-testid="batch-log-pref">
        <label className="block text-sm text-neutral-400 mb-2">{tChrome('panel.settings.batchLogs')}</label>
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            data-testid="pref-batch-log"
            checked={settings.batchLogEnabled}
            onChange={() => update('batchLogEnabled', !settings.batchLogEnabled)}
            className="rounded bg-neutral-800 border-neutral-700"
          />
          <span className="text-sm text-neutral-300">{tChrome('panel.settings.batchLogWrite')}</span>
        </label>
        <div className="flex items-center gap-2 mt-2">
          <span className="text-sm text-neutral-400">{tChrome('panel.settings.keepLogsFor')}</span>
          <select
            aria-label={tChrome('panel.settings.keepLogsAria')}
            data-testid="pref-batch-log-retention"
            value={String(settings.batchLogRetentionDays)}
            disabled={!settings.batchLogEnabled}
            onChange={(e) => update('batchLogRetentionDays', Number(e.target.value))}
            className="px-3 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-sm disabled:opacity-50"
          >
            <option value="7">{tChrome('panel.settings.days7')}</option>
            <option value="30">{tChrome('panel.settings.days30')}</option>
            <option value="90">{tChrome('panel.settings.days90')}</option>
            <option value="365">{tChrome('panel.settings.year1')}</option>
            <option value="0">{tChrome('panel.settings.keepForever')}</option>
          </select>
          <button
            type="button"
            data-testid="pref-batch-log-open"
            onClick={() => void batch.openLogFolder(settings.batchLogDir).catch(() => {})}
            className="px-3 py-1.5 text-xs bg-neutral-800 text-neutral-300 border border-neutral-700 hover:bg-neutral-700 rounded font-medium"
          >
            {tChrome('panel.settings.openLogFolder')}
          </button>
        </div>
        <div className="flex items-center gap-2 mt-2">
          <span className="text-sm text-neutral-400 shrink-0">{tChrome('panel.settings.location')}</span>
          <button
            type="button"
            data-testid="pref-batch-log-dir-pick"
            disabled={!settings.batchLogEnabled}
            onClick={() => {
              void dialog
                .pickFolder(tChrome('panel.settings.chooseLogFolder'))
                .then((path) => {
                  if (path) update('batchLogDir', path);
                })
                .catch(() => {});
            }}
            className="px-3 py-1.5 text-xs bg-neutral-800 text-neutral-300 border border-neutral-700 hover:bg-neutral-700 disabled:opacity-50 rounded font-medium shrink-0"
          >
            {tChrome('panel.settings.choose')}
          </button>
          <span
            data-testid="pref-batch-log-dir"
            className={`text-sm text-neutral-300 truncate${
              settings.batchLogDir ? ' ltr-notation' : ''
            }`}
            title={settings.batchLogDir || undefined}
          >
            {settings.batchLogDir || tChrome('panel.settings.defaultLogDir')}
          </span>
          {settings.batchLogDir !== '' && (
            <button
              type="button"
              data-testid="pref-batch-log-dir-reset"
              onClick={() => update('batchLogDir', '')}
              className="px-2 py-1 text-xs text-neutral-500 hover:text-neutral-300 shrink-0"
            >
              {tChrome('panel.settings.useDefault')}
            </button>
          )}
        </div>
        <p className="text-xs text-neutral-500 mt-1.5">
          {tChrome('panel.settings.batchLogHint')}
        </p>
        <p className="text-xs text-neutral-500 mt-1">
          {tChrome('panel.settings.batchLogSharedHint')}
        </p>
      </div>
      <VirtualPrinterBlock />
      </>
      )}

      {category === 'appearance' && (
      <>
      <div>
        <label className="block text-sm text-neutral-400 mb-1">{tChrome('panel.settings.theme')}</label>
        <select
          data-testid="prefs-theme"
          aria-label={tChrome('panel.settings.theme')}
          value={settings.theme}
          onChange={(e) => update('theme', e.target.value)}
          className="px-3 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-sm"
        >
          <option value="system">{tChrome('panel.settings.themeSystem')}</option>
          <option value="dark">{tChrome('panel.settings.themeDark')}</option>
          <option value="light">{tChrome('panel.settings.themeLight')}</option>
          <option value="high-contrast">{tChrome('panel.settings.themeHighContrast')}</option>
        </select>
        {forcedColors && (
          <p
            data-testid="prefs-theme-forced-note"
            className="mt-1.5 text-xs text-neutral-400 max-w-prose"
          >
            {tChrome('panel.settings.themeForcedColors')}
          </p>
        )}
      </div>
      <div>
        {/* The UI language. Options show each locale's NATIVE name (the
            picker convention); 'system' re-resolves against the OS locale.
            The switch is LIVE — react-i18next re-renders hooked chrome. */}
        <label className="block text-sm text-neutral-400 mb-1">
          {tChrome('chrome.prefs.language')}
        </label>
        <select
          data-testid="prefs-language"
          aria-label={tChrome('chrome.prefs.language')}
          value={settings.language}
          onChange={(e) => {
            update('language', e.target.value);
            setAppLanguage(e.target.value);
          }}
          className="px-3 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-sm"
        >
          <option value="system">{tChrome('chrome.prefs.languageSystem')}</option>
          {SHIPPED_LOCALES.map((l) => (
            <option key={l} value={l}>
              {LOCALE_NATIVE_NAMES[l] ?? l}
            </option>
          ))}
        </select>
      </div>
      </>
      )}

      {category === 'tray' && (
      <>
      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={settings.minimizeToTray}
          onChange={() => {
            const next = !settings.minimizeToTray;
            update('minimizeToTray', next);
            // If disabling tray, also disable start-minimized and update startup entry
            if (!next && settings.startMinimized) {
              update('startMinimized', false);
              app.setStartMinimized(false).catch(() => {});
              if (startWithWindows) {
                app.setStartupEnabled(true, false).catch(() => {});
              }
            }
          }}
          className="rounded bg-neutral-800 border-neutral-700"
        />
        <span className="text-sm text-neutral-400">{tChrome('panel.settings.minimizeToTray')}</span>
      </label>

      {settings.minimizeToTray && (
        <label className="flex items-center gap-2 cursor-pointer ms-4">
          <input
            type="checkbox"
            checked={settings.startMinimized}
            onChange={() => {
              const next = !settings.startMinimized;
              update('startMinimized', next);
              // Write to Rust-readable config file (no window flash on startup)
              app.setStartMinimized(next).catch(() => {});
              // Update startup registry entry if Start with Windows is enabled
              if (startWithWindows) {
                app.setStartupEnabled(true, next).catch(() => {});
              }
            }}
            className="rounded bg-neutral-800 border-neutral-700"
          />
          <span className="text-sm text-neutral-400">{tChrome('panel.settings.startMinimized')}</span>
        </label>
      )}

      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={startWithWindows}
          onChange={() => {
            const next = !startWithWindows;
            setStartWithWindows(next);
            app.setStartupEnabled(next, next ? settings.startMinimized : false).catch(() => {});
            setStatus(tChrome('panel.settings.saved'));
          }}
          className="rounded bg-neutral-800 border-neutral-700"
        />
        <span className="text-sm text-neutral-400">{tChrome('panel.settings.startWithWindows')}</span>
      </label>

      <div data-testid="restore-windows-pref">
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            data-testid="pref-restore-windows"
            checked={settings.restoreWindowsOnLaunch}
            onChange={() => {
              const next = !settings.restoreWindowsOnLaunch;
              update('restoreWindowsOnLaunch', next);
              // Mirrored to the Rust-readable config: the windows are rebuilt
              // during startup, before a renderer exists to be asked.
              app.setRestoreWindowsOnLaunch(next).catch(() => {});
            }}
            className="rounded bg-neutral-800 border-neutral-700"
          />
          <span className="text-sm text-neutral-400">{tChrome('panel.settings.restoreWindows')}</span>
        </label>
        <p className="text-xs text-neutral-500 mt-1.5">
          {tChrome('panel.settings.restoreWindowsHint')}
        </p>
      </div>
      </>
      )}

      {category === 'licenses' && (
      <>
      <div data-testid="updates-pref" className="mb-4">
        <label className="block text-sm text-neutral-400 mb-2">{tChrome('panel.settings.updates')}</label>
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            data-testid="pref-check-updates"
            checked={settings.checkUpdatesOnLaunch}
            onChange={() => update('checkUpdatesOnLaunch', !settings.checkUpdatesOnLaunch)}
            className="rounded bg-neutral-800 border-neutral-700"
          />
          <span className="text-sm text-neutral-400">{tChrome('panel.settings.checkOnLaunch')}</span>
        </label>
        <p className="text-xs text-neutral-500 mt-1.5">
          {tChrome('panel.settings.updatesHint')}
        </p>
      </div>
      <div data-testid="licenses-note">
        <label className="block text-sm text-neutral-400 mb-2">{tChrome('panel.settings.thirdParty')}</label>
        <div className="text-xs text-neutral-500 space-y-1.5">
          <p>{tChrome('panel.settings.licensesP1')}</p>
          <p>{tChrome('panel.settings.licensesP2')}</p>
          <p>{tChrome('panel.settings.licensesP3')}</p>
        </div>
        <div className="flex gap-2 mt-3">
          <button
            data-testid="licenses-open-aggregate"
            className="text-xs px-2 py-1 rounded border border-neutral-700 text-neutral-300 hover:bg-neutral-800"
            onClick={() => {
              app.openThirdPartyLicenses('THIRD-PARTY-LICENSES.md')
                .then(() => setStatus(tChrome('panel.settings.openedLicenses')))
                .catch(() => setStatus(tChrome('panel.settings.openLicensesFailed')));
            }}
          >
            {tChrome('panel.settings.openLicenses')}
          </button>
          <button
            data-testid="licenses-open-rust"
            className="text-xs px-2 py-1 rounded border border-neutral-700 text-neutral-300 hover:bg-neutral-800"
            onClick={() => {
              app.openThirdPartyLicenses('THIRD-PARTY-LICENSES-RUST.html')
                .then(() => setStatus(tChrome('panel.settings.openedRust')))
                .catch(() => setStatus(tChrome('panel.settings.openLicensesFailed')));
            }}
          >
            {tChrome('panel.settings.rustNotices')}
          </button>
        </div>
      </div>
      </>
      )}

      <StatusBar message={status} />
      </div>
    </div>
  );
}

// Virtual printer: "Spectra PDF" in every app's print dialog. The
// loopback listener + install/remove orchestration live in Rust
// (print_to_pdf.rs); this block is the whole GUI surface. Install/Remove is
// ONE visible UAC elevation (printer ports are machine objects) — never
// silent; the listener status and the last failed job are shown verbatim so
// a taken port or a bad job is a named condition, not a mystery.
function VirtualPrinterBlock(): React.JSX.Element {
  const [vpStatus, setVpStatus] = useState<VirtualPrinterStatus | null>(null);
  const [vpBusy, setVpBusy] = useState(false);
  const [vpError, setVpError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setVpStatus(await virtualPrinter.status());
    } catch {
      setVpStatus(null);
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);

  const run = async (fn: () => Promise<void>): Promise<void> => {
    setVpBusy(true);
    setVpError(null);
    try {
      await fn();
    } catch (e: unknown) {
      setVpError(e instanceof Error ? e.message : String(e));
    } finally {
      setVpBusy(false);
      void refresh();
    }
  };

  return (
    <div data-testid="virtual-printer-pref">
      <label className="block text-sm text-neutral-400 mb-2">{tChrome('panel.settings.printTo')}</label>
      <p className="text-xs text-neutral-500 mb-2">
        {tChrome('panel.settings.printerBlurb')}
      </p>
      {vpStatus === null ? (
        <p className="text-sm text-neutral-500">Checking…</p>
      ) : (
        <>
          <p className="text-sm text-neutral-300" data-testid="virtual-printer-status">
            {vpStatus.installed
              ? tChrome('panel.settings.printerInstalled')
              : tChrome('panel.settings.printerNotInstalled')}
            {' · '}
            {vpStatus.listener === 'listening'
              ? tChrome('panel.settings.printerReady')
              : tChrome('panel.settings.printerDown', { status: vpStatus.listener })}
          </p>
          {vpStatus.lastJobError !== '' && (
            <p className="text-xs text-amber-400 mt-1" data-testid="virtual-printer-job-error">
              {tChrome('panel.settings.lastJobFailed', { error: vpStatus.lastJobError })}
            </p>
          )}
          <div className="flex items-center gap-2 mt-2">
            {vpStatus.installed ? (
              <button
                type="button"
                data-testid="virtual-printer-remove"
                disabled={vpBusy}
                onClick={() => void run(() => virtualPrinter.uninstall())}
                className="px-2.5 py-1 text-xs bg-neutral-800 text-neutral-300 border border-neutral-700 hover:bg-neutral-700 disabled:opacity-50 rounded font-medium"
              >
                {tChrome('panel.settings.removePrinter')}
              </button>
            ) : (
              <button
                type="button"
                data-testid="virtual-printer-install"
                disabled={vpBusy}
                onClick={() => void run(() => virtualPrinter.install())}
                className="px-2.5 py-1 text-xs text-white bg-blue-600 hover:bg-blue-500 disabled:opacity-50 rounded font-medium"
              >
                {tChrome('panel.settings.installPrinter')}
              </button>
            )}
            <span className="text-xs text-neutral-500">
              {tChrome('panel.settings.uacNote')}
            </span>
          </div>
          {vpError && (
            <p className="text-xs text-red-400 mt-1" data-testid="virtual-printer-error">
              {vpError}
            </p>
          )}
        </>
      )}
    </div>
  );
}
