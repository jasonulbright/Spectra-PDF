// N12 slice B (brief 37) — the CHROME DIALOGS' strings, third typed record
// after i18n-chrome.ts (slice A chrome) and i18n-panels.ts (the dock
// panels). Same contract: the record carries the English, the en catalog is
// GENERATED from it by tests/i18n-catalog.test.ts (hand-editing
// locales/en/chrome.json stays impossible), every shipped locale's key set
// must equal en's exactly, and a dialog is either FULLY threaded or not
// started — never half-swept.
//
// Keys: `dialog.common.*` for strings shared across dialogs (the stock
// Close/Cancel/OK/Open buttons), `dialog.<slug>.*` per dialog. Plural
// messages carry i18next's `_one`/`_other` pair (used via tChromeCount);
// interpolations ride `{{var}}` placeholders — concatenated fragments are
// banned, so a composed sentence becomes ONE interpolated key.
//
// A leaf data module (no component imports), the i18n-panels.ts pattern.
export const DIALOG_STRINGS = {
  'dialog.common.close': 'Close',
  'dialog.common.cancel': 'Cancel',
  'dialog.common.open': 'Open',
  'dialog.common.ok': 'OK',
  'dialog.common.save': 'Save',

  'dialog.about.aria': 'About Spectra PDF',
  'dialog.about.version': 'Version {{version}}',
  'dialog.about.tagline': 'A modern, offline-first PDF workbench.',

  'dialog.confirm.titleUnsaved': 'Unsaved Changes',
  'dialog.confirm.titleProceed': 'Are you sure?',
  'dialog.confirm.titleNotice': 'Notice',
  'dialog.confirm.dontSave': "Don't Save",
  'dialog.confirm.continue': 'Continue',

  'dialog.password.title': 'Password Required',
  'dialog.password.body':
    '"{{name}}" is password-protected. Enter the password to open it.',
  'dialog.password.placeholder': 'Enter password',

  'dialog.certUnlock.title': 'Certificate Required',
  'dialog.certUnlock.body':
    "\"{{name}}\" is encrypted to certificate recipients. Open it with your key file (.pfx / .p12) and that file's password.",
  'dialog.certUnlock.chooseKey': 'Choose key file…',
  'dialog.certUnlock.noKey': 'No key file chosen',
  'dialog.certUnlock.keyPassword': 'Key file password',
  'dialog.certUnlock.pickFirst': 'Choose your key file (.pfx / .p12) first.',

  'dialog.dropZone.hint': 'Drop PDF files here',

  'dialog.customize.aria': 'Customize toolbar',
  'dialog.customize.title': 'Customize Toolbar',
  'dialog.customize.blurb':
    'Choose which buttons the main toolbar shows. Changes apply immediately and are remembered.',
  'dialog.customize.reset': 'Reset to default',

  'dialog.update.checking': 'Checking for updates…',
  'dialog.update.upToDate': 'You’re up to date.',
  'dialog.update.managed': 'Updates are managed by your organization.',
  'dialog.update.available': 'Update available: v{{version}}',
  'dialog.update.viewRelease': 'View release',
  'dialog.update.dismiss': 'Dismiss',
} as const;

export type DialogKey = keyof typeof DIALOG_STRINGS;
