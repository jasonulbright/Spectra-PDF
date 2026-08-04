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

  // The operation queue's own chrome.
  'dialog.opqueue.heading': 'Operations ({{count}})',
  'dialog.opqueue.headingCollapsed': 'Operations ({{count}}) ...',
  'dialog.opqueue.clear': 'Clear',
  'dialog.opqueue.aria': 'Recent operations',
  'dialog.opqueue.complete': 'Complete',
  'dialog.opqueue.elapsed': '{{seconds}}s',

  // The queue LABEL's composition shapes. Each is a whole self-contained
  // message — a queue line is never assembled by concatenating fragments,
  // because the order of "operation / target / file" differs per language.
  // The op NAME itself comes from `opqueue.op.<method>` (generated from the
  // FRIENDLY_NAMES table); these interpolate it as {{op}}.
  'dialog.opqueue.allPages': 'all',
  'dialog.opqueue.pageList': 'p{{pages}}',
  'dialog.opqueue.cw': 'CW',
  'dialog.opqueue.ccw': 'CCW',
  'dialog.opqueue.degrees': '{{angle}}°',
  'dialog.opqueue.plain': '{{op}}',
  'dialog.opqueue.file': '{{op}} — {{file}}',
  'dialog.opqueue.rotate': '{{op}} {{dir}} {{pages}} — {{file}}',
  'dialog.opqueue.pages': '{{op}} {{pages}} — {{file}}',
  'dialog.opqueue.ranges': '{{op}} {{ranges}} — {{file}}',
  'dialog.opqueue.printCopies': '{{op}} {{pages}} ×{{copies}} — {{file}}',
  'dialog.opqueue.detail': '{{op}} ({{detail}}) — {{file}}',
  'dialog.opqueue.level': '{{op}} {{level}} — {{file}}',
  'dialog.opqueue.mergeFiles_one': '{{op}} ({{count}} file)',
  'dialog.opqueue.mergeFiles_other': '{{op}} ({{count}} files)',
  'dialog.opqueue.redactRegions_one': '{{op}} {{count}} region — {{file}}',
  'dialog.opqueue.redactRegions_other': '{{op}} {{count}} regions — {{file}}',
  'dialog.opqueue.compare': '{{op}}: {{a}} ↔ {{b}}',
  'dialog.opqueue.format': '{{op}} {{fmt}} — {{file}}',
  'dialog.opqueue.formatDpi': '{{op}} {{fmt}} {{dpi}}dpi — {{file}}',

  'dialog.props.title': 'Document Properties',
  'dialog.props.tabsAria': 'Properties tabs',
  'dialog.props.tab.description': 'Description',
  'dialog.props.tab.security': 'Security',
  'dialog.props.tab.advanced': 'Advanced',
  'dialog.props.noFile': 'No document is open.',
  'dialog.props.field.title': 'Title',
  'dialog.props.field.author': 'Author',
  'dialog.props.field.subject': 'Subject',
  'dialog.props.field.keywords': 'Keywords',
  'dialog.props.saveAs': 'Save As…',
  'dialog.props.removeAll': 'Remove all metadata…',
  'dialog.props.gateFailed': 'Could not apply pending edits: {{message}}',
  'dialog.props.savingMetadata': 'Saving metadata...',
  'dialog.props.updated': 'Updated: {{fields}}',
  'dialog.props.strippingMetadata': 'Stripping metadata...',
  'dialog.props.stripped': 'All metadata removed',
  'dialog.props.passwordProtection': 'Password protection',
  'dialog.props.needsPassword': 'This file requires a password to open',
  'dialog.props.noProtection': 'None',
  'dialog.props.openProtect': 'Open the Protect tool…',
  'dialog.props.pdfVersion': 'PDF version',
  'dialog.props.versionValue': 'PDF {{version}}',
  'dialog.props.pageCount': 'Pages',
  'dialog.props.size': 'Size',
  'dialog.props.location': 'Location',
  'dialog.props.unknown': 'Unknown',
  'dialog.props.bytes_one': '{{count}} byte',
  'dialog.props.bytes_other': '{{count}} bytes',
  'dialog.props.kilobytes': '{{size}} KB',
  'dialog.props.megabytes': '{{size}} MB',

  'dialog.signer.label': 'Signer',
  'dialog.signer.modePfx': '.pfx file',
  'dialog.signer.modePem': 'PEM key + cert',
  'dialog.signer.modeToken': 'Token (PKCS#11)',
  'dialog.signer.createTitle': 'Create a new self-signed signing identity (.pfx)',
  'dialog.signer.create': 'Create new…',
  'dialog.signer.choose': 'Choose…',
  'dialog.signer.noneChosen': 'none chosen',
  'dialog.signer.module': 'Module',
  'dialog.signer.token': 'Token',
  'dialog.signer.tokenPlaceholder': 'Token label',
  'dialog.signer.certLabel': 'Cert label',
  'dialog.signer.certPlaceholder': 'Certificate label on the token',
  'dialog.signer.keyLabel': 'Key label',
  'dialog.signer.keyPlaceholder': 'Blank = same as certificate label',
  'dialog.signer.tokenNote':
    "The password field is the token PIN. The module is your device vendor's PKCS#11 .dll.",
  'dialog.signer.keyFile': 'Key file',
  'dialog.signer.certificate': 'Certificate',
  'dialog.signer.pemNote': 'The certificate file may be a fullchain (signer first).',
  'dialog.signer.newTitle': 'New self-signed signer',
  'dialog.signer.newNote':
    'Proves possession of this new key — it does not prove your identity to third parties.',
  'dialog.signer.name': 'Name',
  'dialog.signer.organization': 'Organization',
  'dialog.signer.optional': 'optional',
  'dialog.signer.password': 'Password',
  'dialog.signer.generating': 'Generating…',
  'dialog.signer.generate': 'Generate & Save…',
  'dialog.signer.created':
    'Created {{name}} (valid until {{date}}) and selected it. Enter its password to sign.',
  'dialog.signer.needPfx': 'Choose a signer (.pfx) file first.',
  'dialog.signer.needModule': 'Choose the PKCS#11 module (.dll) first.',
  'dialog.signer.needToken': 'Enter the token label.',
  'dialog.signer.needCertLabel': 'Enter the certificate label on the token.',
  'dialog.signer.needPem': 'Choose both the PEM key file and the certificate file.',
  'dialog.signer.needName': 'Enter a signer name.',
  'dialog.signer.needPassword': 'Choose a password — the file will contain a private key.',

  'dialog.common.choose': 'Choose…',
  'dialog.common.clear': 'Clear',
  'dialog.common.delete': 'Delete',
  'dialog.common.deleteIt': 'Delete it?',
  'dialog.common.keep': 'Keep',
  'dialog.common.loading': 'Loading…',
  'dialog.common.notSet': 'Not set',
  'dialog.common.saving': 'Saving…',
  'dialog.common.route': '{{source}} → {{dest}}',
  'dialog.common.chooseAction': 'Choose an action…',
  'dialog.common.actionOption': '{{name}} — {{steps}}',
  'dialog.common.pickDest': 'Choose the destination folder',
  'dialog.common.pickProcessed': 'Choose where processed originals go',

  // Why a saved action cannot run with nobody at the keyboard — shared by the
  // scheduler and the folder watcher (lib/guided-actions raises it).
  'dialog.unattended.secret':
    'Step {{index}} ({{step}}) needs a password when it runs, and passwords are never stored in an action — it cannot run unattended.',
  'dialog.unattended.asks':
    'Step {{index}} ({{step}}) asks for values when it runs ({{params}}) — a scheduled run has nobody to ask. Store the values in the action first.',

  'dialog.createPdf.title': 'Create PDF from PostScript',
  'dialog.createPdf.pick': 'Choose PostScript File…',
  'dialog.createPdf.noFile': 'No file chosen (.ps or .eps)',
  'dialog.createPdf.quality': 'Quality',
  'dialog.createPdf.preset.screen': 'Smallest Size (72 dpi)',
  'dialog.createPdf.preset.ebook': 'eBook (150 dpi)',
  'dialog.createPdf.preset.printer': 'Print Quality (300 dpi)',
  'dialog.createPdf.preset.prepress': 'Press Quality',
  'dialog.createPdf.preset.default': 'Standard (Ghostscript defaults)',
  'dialog.createPdf.done_one': 'Created {{count}} page → {{path}}',
  'dialog.createPdf.done_other': 'Created {{count}} pages → {{path}}',
  'dialog.createPdf.converting': 'Converting…',
  'dialog.createPdf.convert': 'Convert…',

  'dialog.exportImages.title': 'Export Pages as Images',
  'dialog.exportImages.aria': 'Export pages as images',
  'dialog.exportImages.format': 'Format',
  'dialog.exportImages.fmt.png': 'PNG — one image per page',
  'dialog.exportImages.fmt.jpeg': 'JPEG — one image per page',
  'dialog.exportImages.fmt.tiff': 'TIFF — single multi-page file',
  'dialog.exportImages.resolution': 'Resolution',
  'dialog.exportImages.dpiOption': '{{dpi}} dpi',
  'dialog.exportImages.pages': 'Pages (e.g. 1-3,5)',
  'dialog.exportImages.pagesPlaceholder': 'All',
  'dialog.exportImages.grayscale': 'Grayscale',
  'dialog.exportImages.done_one': 'Exported {{count}} page → {{target}}',
  'dialog.exportImages.done_other': 'Exported {{count}} pages → {{target}}',
  'dialog.exportImages.fileCount_one': '{{count}} file',
  'dialog.exportImages.fileCount_other': '{{count}} files',
  'dialog.exportImages.exporting': 'Exporting…',
  'dialog.exportImages.export': 'Export…',

  'dialog.watchers.title': 'Watched Folders',
  'dialog.watchers.blurb':
    'A watched folder runs a saved guided action on every PDF dropped into it: processed copies land in the destination, the originals file into the processed folder. Watching runs while Spectra PDF is open (including minimized to the tray); runs are logged with the batch logs.',
  'dialog.watchers.empty': 'No watched folders yet.',
  'dialog.watchers.watching': 'Watching',
  'dialog.watchers.paused': 'Paused',
  'dialog.watchers.pause': 'Pause',
  'dialog.watchers.resume': 'Resume',
  'dialog.watchers.new': 'New watched folder',
  'dialog.watchers.nameLabel': "Name (blank = the action's name)",
  'dialog.watchers.actionLabel': 'Guided action to run on arrivals',
  'dialog.watchers.actionNote':
    "The watcher keeps its own copy of the action. Actions that ask for values when they run can't watch a folder — arrivals are processed with nobody at the keyboard.",
  'dialog.watchers.sourceLabel': 'Watched folder (the intake)',
  'dialog.watchers.destLabel': 'Destination (processed copies)',
  'dialog.watchers.doneLabel': 'Processed originals move to',
  'dialog.watchers.pickSource': 'Choose the folder to watch',
  'dialog.watchers.needAction': 'Choose which guided action runs on arrivals.',
  'dialog.watchers.start': 'Start watching',

  // Recognition-language SUMMARY. The language NAMES themselves are never
  // authored into the catalog — they come from Intl.DisplayNames, which every
  // locale already knows (see tOcrLanguage).
  'dialog.ocr.langCount_one': '{{count}} language',
  'dialog.ocr.langCount_other': '{{count}} languages',
  'dialog.ocr.langPair': '{{a}} + {{b}}',

  'dialog.schedule.title': 'Scheduled Batch Runs',
  'dialog.schedule.blurb':
    'Scheduled runs happen through Windows Task Scheduler, so they run even when Spectra PDF is closed. Everything here is managed from this window — you never need to open Task Scheduler.',
  'dialog.schedule.empty': 'No scheduled runs yet.',
  'dialog.schedule.timing': 'Next: {{next}} · Last: {{last}}',
  'dialog.schedule.timingResult': 'Next: {{next}} · Last: {{last}} ({{result}})',
  'dialog.schedule.never': 'never',
  'dialog.schedule.none': '—',
  'dialog.schedule.guidedAction': 'Guided action: {{name}}',
  'dialog.schedule.guidedActionSteps': 'Guided action: {{name}} — {{steps}}',
  'dialog.schedule.unnamedAction': '(unnamed)',
  'dialog.schedule.actionMissing':
    'Its action file is missing — the run will fail until the schedule is recreated.',
  'dialog.schedule.foreign':
    'Edited outside this app — its settings cannot be shown here, but it will still run.',
  'dialog.schedule.runNow': 'Run now',
  'dialog.schedule.enable': 'Enable',
  'dialog.schedule.disable': 'Disable',
  'dialog.schedule.edit': 'Edit',
  'dialog.schedule.new': 'New scheduled run',
  'dialog.schedule.starting': 'Starting…',
  'dialog.schedule.updating': 'Updating…',
  'dialog.schedule.deleting': 'Deleting…',
  'dialog.schedule.creating': 'Creating the schedule…',
  'dialog.schedule.saved': 'Schedule saved',
  'dialog.schedule.needAction': 'Choose which guided action to run.',
  'dialog.schedule.name': 'Name',
  'dialog.schedule.whatRuns': 'What runs',
  'dialog.schedule.runTypeOcr': 'Batch OCR (make searchable)',
  'dialog.schedule.runTypeAction': 'Guided action',
  'dialog.schedule.actionLabel': 'Guided action',
  'dialog.schedule.keepAction': '(keep the current action)',
  'dialog.schedule.actionNote':
    'The schedule keeps its own copy of the action; edit the schedule to pick up later changes. Actions that ask for values when they run can’t be scheduled.',
  'dialog.schedule.sourceLabel': 'Source folder',
  'dialog.schedule.destLabel': 'Destination folder',
  'dialog.schedule.pickSource': 'Choose the folder to process',
  'dialog.schedule.languages': 'Recognition languages — {{summary}}',
  'dialog.schedule.runs': 'Runs',
  'dialog.schedule.daily': 'Every day',
  'dialog.schedule.weekly': 'Weekly',
  'dialog.schedule.at': 'At',
  'dialog.schedule.days': 'Days',
  // Whole headers, suffix included: the two-tone "Account" + dim " — optional"
  // was a concatenation, and where the qualifier sits in the phrase differs per
  // language (the Settings-panel precedent for dropping inline emphasis spans).
  'dialog.schedule.accountSection': 'Account — optional',
  'dialog.schedule.filingSection': 'Filing and account — optional',
  'dialog.schedule.movedLabel': 'Move processed originals to',
  'dialog.schedule.errorsLabel': 'Move failed originals to',
  'dialog.schedule.pickErrors': 'Choose where failed originals go',
  'dialog.schedule.repair': 'Try to repair damaged files',
  'dialog.schedule.accountLabel': 'Run as (blank = you)',
  'dialog.schedule.passwordLabel': 'Password (leave blank for a managed service account)',
  'dialog.schedule.passwordNote':
    'Windows stores this, not Spectra PDF. The account also needs the “Log on as a batch job” right on this machine, or the schedule is created but never runs.',
  'dialog.schedule.logDirLabel': 'Log folder (required when running as another account)',
  'dialog.schedule.pickLogDir': 'Choose where run logs are written',
  'dialog.schedule.logDirNote':
    'The default log location belongs to whichever account runs the batch, so a run under another account would write its log where you cannot see it.',
  'dialog.schedule.save': 'Save schedule',
  'dialog.schedule.openLogs': 'Open log folder',
} as const;

export type DialogKey = keyof typeof DIALOG_STRINGS;
