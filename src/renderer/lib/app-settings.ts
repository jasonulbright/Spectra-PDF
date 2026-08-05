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
  /** O8: which MRC preset the Compress panel opens on, for a user whose
   * corpus is scans. Separate from `compressionQuality` because the two are
   * independent axes — a user can default to `mrc` and still choose which of
   * the three promises it makes, and choosing `ebook` must not forget it. */
  mrcPreset: string;
  theme: string;
  minimizeToTray: boolean;
  startMinimized: boolean;
  /** Single-key tool accelerators (H/V/U/X/D/K). They default off because
   * bare letters arming tools surprise
   * anyone who doesn't know the preset exists. */
  singleKeyAccelerators: boolean;
  /** Check GitHub for a newer release shortly after launch. Default ON, and
   * safe to leave on: the check only ever shows a banner; the app never
   * downloads or installs anything itself. Turn it off for air-gapped
   * deployments, or suppress it machine-wide with the DisableAutoUpdate
   * policy, which still wins over this preference. */
  checkUpdatesOnLaunch: boolean;
  /** Write a log file for every Batch OCR run (issue #1 request 4). Default
   * ON: a batch runs unattended over folders the user cannot re-inspect
   * afterwards, and the on-screen report dies with the dialog. */
  batchLogEnabled: boolean;
  /** Days a batch log is kept before the next run sweeps it. 0 = keep
   * forever — deliberately NOT "delete everything", since 0 is what an
   * unset or corrupted value resolves to. The requester suggested 30. */
  batchLogRetentionDays: number;
  /** The user's display name for dynamic stamps' {name} token. Empty means the
   * token resolves to nothing and the
   * label collapses cleanly. */
  identityName: string;
  /** Where batch logs are written. Empty = the app's own data folder.
   *
   * Configurable for a concrete reason, not for taste: a SCHEDULED run under
   * an alternate account or a managed service account resolves the app-data
   * path inside THAT account's profile, so the audit trail for precisely the
   * runs nobody watched would land where the person who set them up cannot
   * see it. A shared, explicitly chosen folder is the fix — and once
   * scheduling exists, setting one is required for a non-interactive identity. */
  batchLogDir: string;
  /** N12: the UI language — 'system' resolves against the shipped locales
   * (falling back to en), an explicit code pins one. Stored values are
   * locale-independent keys, never display names. */
  language: string;
}

export const DEFAULTS: Settings = {
  gsPath: '',
  gsSource: 'builtin',
  defaultOutputDir: '',
  compressionQuality: 'ebook',
  mrcPreset: 'balanced',
  theme: 'system',
  minimizeToTray: false,
  startMinimized: false,
  singleKeyAccelerators: false,
  checkUpdatesOnLaunch: true,
  batchLogEnabled: true,
  batchLogRetentionDays: 30,
  batchLogDir: '',
  identityName: '',
  language: 'system',
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
