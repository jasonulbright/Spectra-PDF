// N12 slice B (brief 37) — the dock panels' strings, the i18n-chrome.ts
// pattern (typed record → generated catalog → parity gate; hand-editing
// locales/en/chrome.json stays impossible). Keys: `panel.common.*` for
// strings shared across panels (the "Working on:" line, the Error prefix,
// stock buttons), `panel.<slug>.*` per panel. Grows batch by batch as the
// sweep proceeds — a panel is either fully threaded or not started, never
// half-swept (the qps leak sweep, spec 104, widens as batches land).
export const PANEL_STRINGS = {
  'panel.common.workingOn': 'Working on:',
  'panel.common.pageCount_one': '{{count}} page',
  'panel.common.pageCount_other': '{{count}} pages',
  'panel.common.error': 'Error: {{message}}',
  'panel.common.working': 'Working…',

  'panel.rotate.open': 'Open a PDF to rotate pages',
  'panel.rotate.angle': 'Angle',
  'panel.rotate.angleAria': 'Rotation angle',
  'panel.rotate.cw90': '90 CW',
  'panel.rotate.flip180': '180',
  'panel.rotate.ccw90': '90 CCW',
  'panel.rotate.pagesLabel': 'Pages (e.g. 1,3,5 or all)',
  'panel.rotate.pagesAria': 'Pages to rotate',
  'panel.rotate.rotate': 'Rotate',
  'panel.rotate.rotating': 'Rotating...',
  'panel.rotate.done': 'Rotated {{pages}} pages by {{angle}} degrees',

  'panel.compress.open': 'Open a PDF to compress',
  'panel.compress.quality': 'Quality',
  'panel.compress.presetAria': 'Compression preset',
  'panel.compress.screen': 'Screen (72 dpi, smallest)',
  'panel.compress.ebook': 'Ebook (150 dpi)',
  'panel.compress.printer': 'Printer (300 dpi)',
  'panel.compress.prepress': 'Prepress (300 dpi, highest)',
  'panel.compress.custom': 'Custom DPI',
  'panel.compress.dpiLabel': 'DPI: {{dpi}}',
  'panel.compress.dpiAria': 'Image resolution in DPI',
  'panel.compress.result': '{{from}} KB → {{to}} KB ({{ratio}}% reduction)',
  'panel.compress.compressing': 'Compressing...',
  'panel.compress.compress': 'Compress',

  'panel.decrypt.open': 'Open an encrypted PDF to decrypt',
  'panel.decrypt.password': 'Password',
  'panel.decrypt.passwordPlaceholder': 'Document password',
  'panel.decrypt.decrypting': 'Decrypting...',
  'panel.decrypt.decrypt': 'Decrypt',
  'panel.decrypt.done': 'Decrypted successfully',

  'panel.split.open': 'Open a PDF to split',
  'panel.split.enterRanges': 'Enter page ranges.',
  'panel.split.rangesLabel': 'Page ranges (e.g. 1-5,10-15)',
  'panel.split.splitting': 'Splitting...',
  'panel.split.split': 'Split',
  'panel.split.done': 'Extracted {{count}} pages',

  'panel.recover.open': 'Open a damaged PDF to recover pages',
  'panel.recover.blurb':
    'Salvage recovery for severely damaged PDFs. Extracts each page individually and assembles salvageable pages into a new clean PDF. Reports which pages were lost.',
  'panel.recover.recovering': 'Recovering pages (Tier 3: per-page salvage)...',
  'panel.recover.busy': 'Recovering...',
  'panel.recover.recover': 'Recover Pages',
  'panel.recover.doneAll': 'Recovered all {{count}} pages successfully.',
  'panel.recover.donePartial':
    'Recovered {{recovered}}/{{total}} pages. {{lost}} page(s) could not be salvaged.',
  'panel.recover.reportAria': 'Recovery report',
  'panel.recover.reportTitle': 'Recovery Report',
  'panel.recover.recoveredPages': 'Recovered: pages {{pages}}',
  'panel.recover.lostPages': 'Lost pages:',
  'panel.recover.lostLine': 'Page {{page}}: {{error}}',

  'panel.repair.open': 'Open a PDF to repair',
  'panel.repair.blurb':
    'Light repair using pikepdf/QPDF. Fixes broken xref tables, stream lengths, and page tree corruption. Preserves annotations, bookmarks, and metadata.',
  'panel.repair.validating': 'Validating PDF structure...',
  'panel.repair.valid': 'PDF structure is valid. No issues found.',
  'panel.repair.found': 'Found {{errors}} error(s), {{warnings}} warning(s).',
  'panel.repair.repairing': 'Repairing PDF (Tier 1: QPDF rewrite)...',
  'panel.repair.repaired':
    'Repaired: {{from}} KB -> {{to}} KB, {{pages}} pages. {{issues}} issue(s) addressed.',
  'panel.repair.checking': 'Checking...',
  'panel.repair.validateFirst': 'Validate First',
  'panel.repair.busy': 'Repairing...',
  'panel.repair.repair': 'Repair',
  'panel.repair.reportAria': 'Validation report',

  'panel.optimize.open': 'Open a PDF to optimize',
  'panel.optimize.linearize': 'Linearize (web-optimize)',
  'panel.optimize.linearizeHint': 'Enables progressive loading in web browsers',
  'panel.optimize.stripMeta': 'Strip metadata',
  'panel.optimize.stripMetaHint': 'Removes author, title, timestamps, and other document info',
  'panel.optimize.compressStreams': 'Compress object streams',
  'panel.optimize.compressStreamsHint': 'Reduces file size by compressing internal structures',
  'panel.optimize.optimizing': 'Optimizing...',
  'panel.optimize.optimize': 'Optimize',
  'panel.optimize.result': '{{from}} KB → {{to}} KB ({{ratio}}% reduction)',

  'panel.extractText.open': 'Open a PDF to extract text',
  'panel.extractText.pagesLabel': 'Pages (e.g. 1,3 or all)',
  'panel.extractText.pagesAria': 'Pages to extract',
  'panel.extractText.extracting': 'Extracting text...',
  'panel.extractText.extractingBtn': 'Extracting...',
  'panel.extractText.extract': 'Extract',
  'panel.extractText.copy': 'Copy',
  'panel.extractText.copied': 'Copied to clipboard',
  'panel.extractText.done': 'Extracted {{chars}} characters from {{pages}} pages',
  'panel.extractText.doneOne': 'Extracted {{chars}} characters from page {{page}}',

  'panel.grayscale.open': 'Open a PDF to convert to grayscale',
  'panel.grayscale.blurb': 'Converts all colors to grayscale. Useful for B&W printing or archival.',
  'panel.grayscale.converting': 'Converting to grayscale...',
  'panel.grayscale.convertingBtn': 'Converting...',
  'panel.grayscale.convert': 'Convert to Grayscale',
  'panel.grayscale.result': '{{from}} KB → {{to}} KB',
} as const;

export type PanelKey = keyof typeof PANEL_STRINGS;
