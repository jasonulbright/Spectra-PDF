// App settings storage — a LEAF module (M6.4): the keymap dispatcher reads
// the single-key-accelerators flag per keystroke, and importing the
// SettingsPanel component for that dragged its module-level theme/GS side
// effects into the command layer (vitest, which has no `window`, caught it).
// The panel imports from here and re-exports `getSettings` for its existing
// consumers; nothing here may touch the DOM, Tauri, or React.

export interface Settings {
  gsPath: string;
  gsSource: 'builtin' | 'external';
  defaultOutputDir: string;
  compressionQuality: string;
  theme: string;
  minimizeToTray: boolean;
  startMinimized: boolean;
  /** Acrobat's single-key tool accelerators (H/V/U/X/D/K — § 9.2, M6.4).
   * Default OFF, Acrobat's own posture: bare letters arming tools surprise
   * anyone who doesn't know the preset exists. */
  singleKeyAccelerators: boolean;
}

export const DEFAULTS: Settings = {
  gsPath: '',
  gsSource: 'builtin',
  defaultOutputDir: '',
  compressionQuality: 'ebook',
  theme: 'system',
  minimizeToTray: false,
  startMinimized: false,
  singleKeyAccelerators: false,
};

export function loadSettings(): Settings {
  try {
    const stored = localStorage.getItem('spectra-settings');
    if (!stored) return DEFAULTS;
    const parsed = JSON.parse(stored);
    // Fix string-boolean corruption from earlier bug
    if (typeof parsed.minimizeToTray === 'string') {
      parsed.minimizeToTray = parsed.minimizeToTray === 'true';
    }
    // Default gsSource to builtin when unset.
    if (!parsed.gsSource) {
      parsed.gsSource = 'builtin';
    }
    return { ...DEFAULTS, ...parsed };
  } catch { return DEFAULTS; }
}

export function saveSettings(settings: Settings): void {
  localStorage.setItem('spectra-settings', JSON.stringify(settings));
}

export function getSettings(): Settings {
  return loadSettings();
}
