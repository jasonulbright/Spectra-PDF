// App settings storage — a LEAF module: the keymap dispatcher reads
// the single-key-accelerators flag per keystroke, and importing the
// SettingsPanel component for that dragged its module-level theme/GS side
// effects into the command layer (vitest, which has no `window`, caught it).
// The panel imports from here and re-exports `getSettings` for its existing
// consumers; nothing here may touch the DOM, Tauri, or React.

export interface Settings {
  /** The Ghostscript program the user chose, or '' to use whichever install
   * discovery finds. Never written without a passing probe — and never a
   * bundled path: the distribution ships no Ghostscript. */
  gsPath: string;
  defaultOutputDir: string;
  compressionQuality: string;
  /** Which MRC preset the Compress panel opens on, for a user whose
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
  /** Reopen the windows and documents that were open at the last quit.
   *
   * Default OFF, and mirrored into the Rust-readable startup config because
   * the decision is taken while the windows are being built — before any
   * renderer exists to be asked. Window POSITION is restored either way: it
   * belongs to the window, and this preference is about documents. */
  restoreWindowsOnLaunch: boolean;
  /** Write a log file for every Batch OCR run. Default
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
  /** Resolution the snapshot tool captures at, in pixels per inch.
   *
   * Fixed rather than "whatever the view is at": a region captured from a 40%
   * zoom would carry 40% of the page's detail into another document, and the
   * reader has no way to tell from the pasted picture that it happened. */
  snapshotDpi: number;
  /** The dictionary the spell checker uses, as a bundled tag ('en_GB').
   *
   * 'auto' is the default and is NOT a language: it defers to the document's
   * own /Lang, then the interface language. Document language is not
   * interface language — a Spanish speaker proofreading an English contract
   * wants the English dictionary — so this pins one when the user knows
   * better than the file does. */
  spellLanguage: string;
  /** Underline misspellings in the paragraph editor as it is typed in.
   *
   * Default ON. The marks are drawn by this app's own checker rather than the
   * webview's, so they agree with the Spelling panel about the dictionary and
   * the custom word list. */
  spellCheckAsYouType: boolean;
  /** The voice Read Out Loud speaks in, as a `voiceURI`. Empty defers to the
   * document's language, then to the platform's own default voice.
   *
   * A voiceURI rather than a name: two installed voices can share a display
   * name across languages, and the URI is what the synthesizer matches on. A
   * pin naming a voice that is no longer installed falls back rather than
   * leaving the reader silent. */
  readAloudVoice: string;
  /** Speaking rate as a multiple of the voice's own (0.5–3). */
  readAloudRate: number;
  /** The UI language — 'system' resolves against the shipped locales
   * (falling back to en), an explicit code pins one. Stored values are
   * locale-independent keys, never display names. */
  language: string;
}

export const DEFAULTS: Settings = {
  gsPath: '',
  defaultOutputDir: '',
  compressionQuality: 'ebook',
  mrcPreset: 'balanced',
  theme: 'system',
  minimizeToTray: false,
  startMinimized: false,
  singleKeyAccelerators: false,
  checkUpdatesOnLaunch: true,
  restoreWindowsOnLaunch: false,
  batchLogEnabled: true,
  batchLogRetentionDays: 30,
  batchLogDir: '',
  identityName: '',
  snapshotDpi: 150,
  spellLanguage: 'auto',
  spellCheckAsYouType: true,
  readAloudVoice: '',
  readAloudRate: 1,
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
    // An install upgraded from the bundled-Ghostscript build carries a
    // gsPath pointing into the app's own resource tree, which no longer
    // exists. Dropping it returns that install to discovery rather than
    // leaving it pinned to a path nothing answers at.
    if (typeof parsed.gsPath === 'string' && /[\\/]resources[\\/]ghostscript[\\/]/i.test(parsed.gsPath)) {
      parsed.gsPath = '';
    }
    delete parsed.gsSource;
    return { ...DEFAULTS, ...parsed };
  } catch { return DEFAULTS; }
}

export function saveSettings(settings: Settings): void {
  localStorage.setItem('spectra-settings', JSON.stringify(settings));
}

export function getSettings(): Settings {
  return loadSettings();
}
