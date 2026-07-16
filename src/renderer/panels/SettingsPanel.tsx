import React, { useState, useEffect, useCallback } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { app, type GsInfo } from '../lib/tauri-bridge';
import { deriveAccentVars } from '../lib/accent';
import { StatusBar } from '../components/StatusBar';
import { loadSettings, saveSettings, type Settings } from '../lib/app-settings';
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
}
resolveGsPath();





/** Apply the theme to the document root and window title bar. */
export function applyTheme(theme?: string): void {
  const resolved = theme ?? loadSettings().theme;
  if (resolved === 'system') {
    // Reset window theme to OS default, then read actual system preference after WebView2 updates
    getCurrentWindow().setTheme(null).then(() => {
      const effective = getSystemTheme();
      document.documentElement.setAttribute('data-theme', effective);
    }).catch(() => {
      document.documentElement.setAttribute('data-theme', getSystemTheme());
    });
    applyAccentColor();
  } else {
    document.documentElement.setAttribute('data-theme', resolved);
    getCurrentWindow().setTheme(resolved === 'light' ? 'light' : 'dark').catch(() => {});
    clearAccentColor();
  }
}

/** Apply Windows accent color as CSS custom properties. */
function applyAccentColor(): void {
  app.getSystemAccentColor().then((hex) => {
    if (!hex) return;
    const vars = deriveAccentVars(hex);
    if (!vars) return;
    const root = document.documentElement;
    root.style.setProperty('--accent', vars.accent);
    root.style.setProperty('--accent-hover', vars.hover);
    root.style.setProperty('--accent-muted', vars.muted);
    root.style.setProperty('--accent-subtle', vars.subtle);
    root.style.setProperty('--accent-fg', vars.fg);
  }).catch(() => {});
}

function clearAccentColor(): void {
  const root = document.documentElement;
  root.style.removeProperty('--accent');
  root.style.removeProperty('--accent-hover');
  root.style.removeProperty('--accent-muted');
  root.style.removeProperty('--accent-subtle');
  root.style.removeProperty('--accent-fg');
}

// Apply theme immediately on module load
applyTheme();

// Re-apply when system theme changes (only matters when theme === 'system')
window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
  if (loadSettings().theme === 'system') applyTheme('system');
});

// Re-read accent color when app regains focus (user may have changed it in Windows Settings)
getCurrentWindow().onFocusChanged(({ payload: focused }) => {
  if (focused && loadSettings().theme === 'system') applyAccentColor();
});

function GsInfoDisplay({ info, label }: { info: GsInfo | null; label: string }): React.ReactElement | null {
  if (!info) return null;
  return (
    <div className="px-3 py-2 bg-neutral-800 border border-neutral-700 rounded text-sm">
      <div className="font-medium text-neutral-200">{label}</div>
      <div className="flex flex-col gap-0.5 mt-1 text-xs text-neutral-400">
        <span>{info.product}</span>
        <span>Version {info.version}</span>
        <span>Vendor: {info.vendor}</span>
      </div>
    </div>
  );
}

/**
 * Preferences categories (§ 7). Data, like every other list in the workbench:
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

export const PREF_CATEGORY_LABELS: Record<PrefCategory, string> = {
  general: 'General',
  appearance: 'Appearance',
  engine: 'Engine',
  tray: 'Tray & Startup',
  licenses: 'Updates & Licenses',
};

export interface SettingsPanelProps {
  /** Which category to open on. Help ▸ Third-party Licenses lands on its own. */
  initialCategory?: PrefCategory;
}

export function SettingsPanel({ initialCategory = 'general' }: SettingsPanelProps = {}): React.ReactElement {
  const [category, setCategory] = useState<PrefCategory>(initialCategory);
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [status, setStatus] = useState('');
  const [bundledGs, setBundledGs] = useState<GsInfo | null>(cachedBundledGs);
  const [externalGs, setExternalGs] = useState<GsInfo | null>(cachedExternalGs);
  const [startWithWindows, setStartWithWindows] = useState(false);

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

  const update = useCallback((key: keyof Settings, value: string | boolean) => {
    setSettings((prev) => {
      const next = { ...prev, [key]: value };
      saveSettings(next);
      return next;
    });
    if (key === 'theme') applyTheme(value as string);
    setStatus('Settings saved');
  }, []);

  const handleGsSourceChange = useCallback((source: 'builtin' | 'external') => {
    const gsPath = source === 'external' && externalGs ? externalGs.path : (bundledGs?.path ?? '');
    setSettings((prev) => {
      const next = { ...prev, gsSource: source, gsPath };
      saveSettings(next);
      return next;
    });
    setStatus('Settings saved');
  }, [bundledGs, externalGs]);

  const activeGs = settings.gsSource === 'external' && externalGs ? externalGs : bundledGs;

  return (
    <div className="prefs">
      <nav className="prefs-nav" aria-label="Preferences categories">
        {PREF_CATEGORIES.map((c) => (
          <button
            key={c}
            type="button"
            data-testid={`prefs-cat-${c}`}
            aria-pressed={category === c}
            className={'prefs-cat' + (category === c ? ' active' : '')}
            onClick={() => setCategory(c)}
          >
            {PREF_CATEGORY_LABELS[c]}
          </button>
        ))}
      </nav>
      <div className="prefs-body flex flex-col gap-6" data-testid={`prefs-body-${category}`}>
      {category === 'engine' && (
      <div>
        <label className="block text-sm text-neutral-400 mb-2">Ghostscript Engine</label>
        <GsInfoDisplay info={activeGs} label={settings.gsSource === 'external' ? 'External (System)' : 'Built-in (Bundled)'} />
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
              Built-in
            </button>
            <button
              onClick={() => handleGsSourceChange('external')}
              className={`px-3 py-1.5 rounded text-xs font-medium transition-colors ${
                settings.gsSource === 'external'
                  ? 'bg-blue-600 text-white'
                  : 'bg-neutral-700 hover:bg-neutral-600 text-neutral-300'
              }`}
            >
              External
            </button>
          </div>
        )}
        <p className="text-xs text-neutral-500 mt-1">Used for Compress and PDF/A conversion</p>
      </div>
      )}

      {category === 'general' && (
      <>
      <div>
        <label className="block text-sm text-neutral-400 mb-1">Default Compression Quality</label>
        <select
          value={settings.compressionQuality}
          onChange={(e) => update('compressionQuality', e.target.value)}
          className="px-3 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-sm"
        >
          <option value="screen">Screen (72 dpi, smallest)</option>
          <option value="ebook">Ebook (150 dpi)</option>
          <option value="printer">Printer (300 dpi)</option>
          <option value="prepress">Prepress (300 dpi, highest)</option>
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
          Use single-key accelerators to access tools
        </span>
      </label>
      <p className="text-xs text-neutral-500 -mt-3">
        H Hand · V Select · U Highlight · X Text · D Draw · K Stamp — off by
        default, like Acrobat
      </p>
      </>
      )}

      {category === 'appearance' && (
      <div>
        <label className="block text-sm text-neutral-400 mb-1">Theme</label>
        <select
          value={settings.theme}
          onChange={(e) => update('theme', e.target.value)}
          className="px-3 py-1.5 bg-neutral-800 border border-neutral-700 rounded text-sm"
        >
          <option value="system">System</option>
          <option value="dark">Dark</option>
          <option value="light">Light</option>
        </select>
      </div>
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
        <span className="text-sm text-neutral-400">Minimize to system tray on close</span>
      </label>

      {settings.minimizeToTray && (
        <label className="flex items-center gap-2 cursor-pointer ml-4">
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
          <span className="text-sm text-neutral-400">Start minimized to tray</span>
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
            setStatus('Settings saved');
          }}
          className="rounded bg-neutral-800 border-neutral-700"
        />
        <span className="text-sm text-neutral-400">Start with Windows</span>
      </label>
      </>
      )}

      {category === 'licenses' && (
      <div data-testid="licenses-note">
        <label className="block text-sm text-neutral-400 mb-2">Third-party components</label>
        <div className="text-xs text-neutral-500 space-y-1.5">
          <p>
            <span className="text-neutral-400">Ghostscript</span> (AGPL-3.0) is bundled unmodified
            and invoked strictly as a separate program — it is never linked into this application.
            Source: ghostscript.com. Used for Compress, Grayscale, PDF/A, and Rebuild.
          </p>
          <p>
            Also bundled or embedded: <span className="text-neutral-400">Python</span> (PSF license)
            with <span className="text-neutral-400">pikepdf</span> (MPL-2.0) and{' '}
            <span className="text-neutral-400">pdfminer.six</span> (MIT);{' '}
            <span className="text-neutral-400">pdf.js</span> (Apache-2.0);{' '}
            <span className="text-neutral-400">pdf-lib</span> (MIT);{' '}
            <span className="text-neutral-400">Tauri</span> (MIT/Apache-2.0).
          </p>
        </div>
      </div>
      )}

      <StatusBar message={status} />
      </div>
    </div>
  );
}
