// The dock panels' strings, the i18n-chrome.ts
// pattern (typed record → generated catalog → parity gate; hand-editing
// locales/en/chrome.json stays impossible). Keys: `panel.common.*` for
// strings shared across panels (the "Working on:" line, the Error prefix,
// stock buttons), `panel.<slug>.*` per panel. Grows batch by batch as the
// sweep proceeds — a panel is either fully threaded or not started, never
// half-swept (the qps leak sweep, spec 104, widens as batches land).
//
// CASING, product-wide. Two registers, and which one a string takes is decided
// by what the string IS, never by the panel it happens to live in:
//   - A NAME — an operation, a tool, a panel, a menu entry — is Title Case.
//     `commands/operations.ts` and `TOOL_TITLES` are that family, and it is
//     already consistent.
//   - Everything a person READS — button labels, hints, statuses, headings
//     inside a panel — is Sentence case.
// The audit found "Apply Watermark" beside "Apply", "Enhance the scans" and
// "Detect fields" on adjacent surfaces: three registers for one kind of label,
// so casing had stopped carrying the name/not-a-name distinction at all. When
// a button's job IS to run a named operation, its label spells that operation
// the same way the operation is named ("Detect form fields"), in the button's
// own register.
// Ellipses are the character …, never three periods.
export const PANEL_STRINGS = {
  'panel.common.workingOn': 'Working on:',
  'panel.common.pageCount_one': '{{count}} page',
  'panel.common.pageCount_other': '{{count}} pages',
  'panel.common.error': 'Error: {{message}}',
  'panel.common.working': 'Working…',
  // The outcome line an operation carries when the user consented to losing
  // the document's protection. ONE interpolated sentence, never the result
  // line with a second one glued to it.
  'panel.common.resultUnprotected':
    '{{result}} The copy is unprotected: the original document’s password and permission restrictions are not in it.',
  'panel.common.folderRouteHint':
    'This works on the open document. To run the same steps over every document in a folder, build an action.',
  'panel.common.folderRouteOpen': 'Open Guided Actions',
  // The ONE explanation every Ghostscript-gated surface renders, plus the
  // three states a configured-but-unusable install can be in. Ghostscript is
  // a user-supplied prerequisite; nothing in the product ships it.
  'panel.common.gsRequired':
    'This needs Ghostscript, which Spectra PDF does not include. Install it, then point Spectra PDF at it in Settings ▸ Engine.',
  'panel.common.gsNotExecutable':
    'The Ghostscript set in Settings ▸ Engine is not there any more. Choose the program again.',
  'panel.common.gsProbeFailed':
    'The Ghostscript set in Settings ▸ Engine did not run. Check the install, then try again in Settings ▸ Engine.',
  'panel.common.gsTooOld':
    'The Ghostscript set in Settings ▸ Engine is older than this version needs. Install a newer one.',
  'panel.common.gsSetUp': 'Set up Ghostscript',
  // The ONE explanation every bundled-colour-profile surface renders while the
  // profiles' separate licence is unaccepted. Three surfaces depend on them:
  // the destination of a CMYK conversion, a PDF/X output intent's embedded
  // profile, and the press an output preview proofs against. Everything else
  // in the product is unaffected, which is what the second sentence says.
  'panel.common.iccLicenceRequired':
    'The colour profiles that ship with Spectra PDF are licensed separately, and that licence has not been accepted on this computer. Colour conversion, output intents and output preview stay off until it is; nothing else is affected.',
  'panel.common.iccLicenceReview': 'Review the colour-profile licence',
  'panel.common.useSelection': 'Use selection',
  'panel.common.useSelectionTitle': 'Fill this field with the pages selected in the page list',

  'panel.rotate.open': 'Open a PDF to rotate pages',
  'panel.rotate.angle': 'Angle',
  'panel.rotate.angleAria': 'Rotation angle',
  'panel.rotate.cw90': '90 CW',
  'panel.rotate.flip180': '180',
  'panel.rotate.ccw90': '90 CCW',
  'panel.rotate.pagesLabel': 'Pages (e.g. 1,3,5-9 or all)',
  'panel.rotate.pagesAria': 'Pages to rotate',
  'panel.rotate.badPages': 'Error: pages must be e.g. 1,3,5-9 or all',
  'panel.rotate.rotate': 'Rotate',
  'panel.rotate.rotating': 'Rotating…',
  'panel.rotate.done': 'Rotated {{pages}} pages by {{angle}} degrees',

  'panel.compress.open': 'Open a PDF to compress',
  'panel.compress.quality': 'Quality',
  'panel.compress.presetAria': 'Compression preset',
  'panel.compress.screen': 'Screen (72 dpi, smallest)',
  'panel.compress.ebook': 'Ebook (150 dpi)',
  'panel.compress.printer': 'Printer (300 dpi)',
  'panel.compress.prepress': 'Prepress (300 dpi, highest)',
  'panel.compress.mrc': 'Scanned document (MRC)',
  'panel.compress.mrcHint':
    'Separates a scan into a text stencil, an ink colour and a paper background. The text stays at the scan’s own resolution while the background compresses hard.',
  'panel.compress.mrcSuggest':
    'Most of this document’s pages read as scans. The scanned-document setting usually makes those far smaller than a resolution change does.',
  'panel.compress.mrcSuggestApply': 'Use it',
  'panel.compress.mrcPreset': 'Scan preset',
  'panel.compress.mrcPresetArchival': 'Archival',
  'panel.compress.mrcPresetBalanced': 'Balanced',
  'panel.compress.mrcPresetSmallest': 'Smallest',
  'panel.compress.mrcPresetHintArchival':
    'No character may be substituted for another. The largest of the three.',
  'panel.compress.mrcPresetHintBalanced': 'The everyday choice for scanned paper.',
  'panel.compress.mrcPresetHintSmallest': 'The smallest file. Glyph shapes may be altered.',
  'panel.compress.mrcPdfaSafe': 'Use only PDF/A-1 compatible filters',
  'panel.compress.mrcVerify': 'Verify the text after compressing',
  'panel.compress.mrcVerifyHint':
    'Reads the page before and after and keeps the original scan for any page whose words did not survive. Slower, because every page is recognised twice.',
  'panel.compress.mrcVerifyLanguages': 'Language of the scan ({{summary}})',
  'panel.compress.mrcResult': '{{pages}} scanned page(s) layered, {{untouched}} left as they were.',
  'panel.compress.mrcFallbackNotice':
    'The JBIG2 encoder was not available, so the stencil uses CCITT G4 and the file is larger than the preset promises.',
  'panel.compress.mrcMixedCodecNotice_one':
    '{{pages}} page held too little type for the shared stencil dictionary and was compressed on its own.',
  'panel.compress.mrcMixedCodecNotice_other':
    '{{pages}} pages held too little type for the shared stencil dictionary and were compressed on their own.',
  'panel.compress.mrcVerifyResult': 'Text verified: {{similarity}}% of the words survived on the worst page.',
  'panel.compress.mrcVerifyBelowThreshold':
    '{{pages}} page(s) kept their original scan because the text did not survive.',
  'panel.compress.custom': 'Custom DPI',
  'panel.compress.dpiLabel': 'DPI: {{dpi}}',
  'panel.compress.dpiAria': 'Image resolution in DPI',
  'panel.compress.result': '{{from}} KB → {{to}} KB ({{ratio}}% reduction)',
  'panel.compress.compressing': 'Compressing…',
  'panel.compress.compress': 'Compress',
  'panel.compress.thenOptimize': 'Then optimize the result',
  'panel.compress.thenOptimizeHint':
    'Runs the Optimize pass over the compressed file — linearized for fast web view, with its objects packed into streams. It runs as a second operation, with its own entry in the queue.',
  'panel.compress.optimizing': 'Optimizing…',
  'panel.compress.optimizeResult':
    '{{result}} Then optimized to {{to}} KB ({{ratio}}% total reduction).',
  'panel.compress.optimizeFailed':
    '{{result}} Optimizing the compressed file failed: {{message}}',

  'panel.decrypt.open': 'Open an encrypted PDF to decrypt',
  'panel.decrypt.password': 'Password',
  'panel.decrypt.passwordPlaceholder': 'Document password',
  'panel.decrypt.decrypting': 'Decrypting…',
  'panel.decrypt.decrypt': 'Decrypt',
  'panel.decrypt.done': 'Decrypted successfully',

  'panel.split.open': 'Open a PDF to split',
  'panel.split.enterRanges': 'Enter page ranges.',
  'panel.split.rangesLabel': 'Page ranges (e.g. 1-5,10-15)',
  'panel.split.splitting': 'Splitting…',
  'panel.split.split': 'Split',
  'panel.split.done': 'Extracted {{count}} pages',
  'panel.split.modeLabel': 'Split by',
  'panel.split.mode.ranges': 'Page ranges',
  'panel.split.mode.every_n': 'Number of pages',
  'panel.split.mode.size': 'File size',
  'panel.split.mode.bookmarks': 'Top-level bookmarks',
  'panel.split.everyNLabel': 'Pages per file',
  'panel.split.maxMbLabel': 'Maximum size per file (MB)',
  'panel.split.maxMbHint':
    'A page larger than this on its own is written to a file of its own, and reported.',
  'panel.split.badEveryN': 'Enter at least 1 page per file.',
  'panel.split.badSize': 'Enter a maximum size greater than 0.',
  'panel.split.pickFolder': 'Choose a folder for the split files',
  'panel.split.bookmarkCounting': 'Reading bookmarks…',
  'panel.split.bookmarkNone': 'This document has no top-level bookmarks to split at.',
  'panel.split.bookmarkCount_one': '{{count}} top-level bookmark to split at.',
  'panel.split.bookmarkCount_other': '{{count}} top-level bookmarks to split at.',
  'panel.split.doneParts_one': 'Wrote {{count}} file, {{pages}} pages in all',
  'panel.split.doneParts_other': 'Wrote {{count}} files, {{pages}} pages in all',
  'panel.split.oversize_one': '{{count}} file is larger than the maximum.',
  'panel.split.oversize_other': '{{count}} files are larger than the maximum.',

  'panel.recover.open': 'Open a damaged PDF to recover pages',
  'panel.recover.blurb':
    'Salvage recovery for severely damaged PDFs. Extracts each page individually and assembles salvageable pages into a new clean PDF. Reports which pages were lost.',
  'panel.recover.recovering': 'Recovering pages (Tier 3: per-page salvage)…',
  'panel.recover.busy': 'Recovering…',
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
  'panel.repair.validating': 'Validating PDF structure…',
  'panel.repair.valid': 'PDF structure is valid. No issues found.',
  'panel.repair.found': 'Found {{errors}} error(s), {{warnings}} warning(s).',
  'panel.repair.repairing': 'Repairing PDF (Tier 1: QPDF rewrite)…',
  'panel.repair.repaired':
    'Repaired: {{from}} KB -> {{to}} KB, {{pages}} pages. {{issues}} issue(s) addressed.',
  'panel.repair.checking': 'Checking…',
  'panel.repair.validateFirst': 'Validate First',
  'panel.repair.busy': 'Repairing…',
  'panel.repair.repair': 'Repair',
  'panel.repair.reportAria': 'Validation report',

  'panel.optimize.open': 'Open a PDF to optimize',
  'panel.optimize.linearize': 'Linearize (web-optimize)',
  'panel.optimize.linearizeHint': 'Enables progressive loading in web browsers',
  'panel.optimize.stripMeta': 'Strip metadata',
  'panel.optimize.stripMetaHint': 'Removes author, title, timestamps, and other document info',
  'panel.optimize.compressStreams': 'Compress object streams',
  'panel.optimize.compressStreamsHint': 'Reduces file size by compressing internal structures',
  'panel.optimize.optimizing': 'Optimizing…',
  'panel.optimize.optimize': 'Optimize',
  'panel.optimize.result': '{{from}} KB → {{to}} KB ({{ratio}}% reduction)',

  'panel.optimize.audit.title': 'Where the space goes',
  'panel.optimize.audit.blurb':
    'Every byte of this document, attributed to one category. The rows add up to the file size, so the largest one is the setting worth changing.',
  'panel.optimize.audit.rerun': 'Audit again',
  'panel.optimize.audit.running': 'Auditing…',
  'panel.optimize.audit.headerCategory': 'Category',
  'panel.optimize.audit.headerBytes': 'Size',
  'panel.optimize.audit.headerShare': 'Share',
  'panel.optimize.audit.total': 'Whole document',
  'panel.optimize.audit.details': 'Details',
  'panel.optimize.audit.moreRows': 'Only the largest are listed.',
  'panel.optimize.audit.objects_one': '{{count}} object',
  'panel.optimize.audit.objects_other': '{{count}} objects',
  'panel.optimize.audit.detailPage': 'Page {{page}}',
  'panel.optimize.audit.detailDocument': 'Document-wide',
  'panel.optimize.audit.revisions_one':
    '{{count}} revision — nothing earlier is left in the file.',
  'panel.optimize.audit.revisions_other':
    '{{count}} revisions — everything but the newest is dead weight a full rewrite reclaims.',
  'panel.optimize.audit.unmeasured_one':
    '{{count}} object could not be located in the file; its bytes are counted under overhead.',
  'panel.optimize.audit.unmeasured_other':
    '{{count}} objects could not be located in the file; their bytes are counted under overhead.',
  'panel.optimize.audit.inconsistent':
    'The categories do not add up to the file size, so the breakdown is not shown.',
  'panel.optimize.audit.category.images': 'Images',
  'panel.optimize.audit.category.fonts': 'Fonts',
  'panel.optimize.audit.category.content_streams': 'Page content',
  'panel.optimize.audit.category.annotations': 'Comments and markup',
  'panel.optimize.audit.category.forms': 'Form fields',
  'panel.optimize.audit.category.embedded_files': 'Attached files',
  'panel.optimize.audit.category.bookmarks': 'Bookmarks',
  'panel.optimize.audit.category.named_destinations': 'Named destinations',
  'panel.optimize.audit.category.tagged_structure': 'Accessibility tags',
  'panel.optimize.audit.category.document_structure': 'Document structure',
  'panel.optimize.audit.category.metadata': 'Metadata and thumbnails',
  'panel.optimize.audit.category.javascript': 'JavaScript and actions',
  'panel.optimize.audit.category.other_objects': 'Unclassified objects',
  'panel.optimize.audit.category.overhead': 'Cross-reference and free space',
  'panel.optimize.audit.knob.compress': 'Compress ▸ resolution',
  // Every knob line answers one question — WHERE the setting is. The peers
  // say it as a path (`Surface ▸ control`); ', below' was a sentence fragment
  // hanging off a noun phrase in a column of paths, and it did not parse.
  'panel.optimize.audit.knob.compress_streams': 'This panel ▸ Compress object streams',
  'panel.optimize.audit.knob.strip_metadata': 'This panel ▸ Strip metadata',
  'panel.optimize.audit.knob.sanitize_comments': 'Remove Hidden Information ▸ comments',
  'panel.optimize.audit.knob.sanitize_forms': 'Remove Hidden Information ▸ form fields',
  'panel.optimize.audit.knob.sanitize_embedded_files':
    'Remove Hidden Information ▸ embedded files',
  'panel.optimize.audit.knob.sanitize_bookmarks': 'Remove Hidden Information ▸ bookmarks',
  'panel.optimize.audit.knob.sanitize_javascript': 'Remove Hidden Information ▸ JavaScript',
  'panel.optimize.audit.knob.sanitize_structure':
    'Remove Hidden Information ▸ document structure (costs accessibility)',
  'panel.optimize.audit.knob.rewrite': 'This panel ▸ Optimize — a rewrite reclaims it',
  'panel.optimize.audit.knob.none': 'No setting changes this',
  'panel.optimize.audit.part.cross_reference': 'Cross-reference tables',
  'panel.optimize.audit.part.superseded': 'Superseded revisions',
  'panel.optimize.audit.part.unreferenced': 'Unreachable objects',
  'panel.optimize.audit.part.structural': 'Headers, trailers and padding',

  'panel.extractText.open': 'Open a PDF to extract text',
  'panel.extractText.pagesLabel': 'Pages (e.g. 1,3 or all)',
  'panel.extractText.pagesAria': 'Pages to extract',
  'panel.extractText.extracting': 'Extracting text…',
  'panel.extractText.extractingBtn': 'Extracting…',
  'panel.extractText.extract': 'Extract',
  'panel.extractText.copy': 'Copy',
  'panel.extractText.copied': 'Copied to clipboard',
  'panel.extractText.save': 'Save as .txt',
  'panel.extractText.saving': 'Saving text…',
  'panel.extractText.saved': 'Saved {{chars}} characters to {{path}}',
  'panel.extractText.done': 'Extracted {{chars}} characters from {{pages}} pages',
  'panel.extractText.doneOne': 'Extracted {{chars}} characters from page {{page}}',

  'panel.grayscale.open': 'Open a PDF to convert to grayscale',
  'panel.grayscale.blurb': 'Converts all colors to grayscale. Useful for B&W printing or archival.',
  'panel.grayscale.converting': 'Converting to grayscale…',
  'panel.grayscale.convertingBtn': 'Converting…',
  'panel.grayscale.convert': 'Convert to Grayscale',
  'panel.grayscale.result': '{{from}} KB → {{to}} KB',

  'panel.pdfVersion.open': 'Open a PDF to change its version',
  'panel.pdfVersion.current': 'Current version: PDF {{version}}',
  'panel.pdfVersion.currentLabel': 'Current version:',
  'panel.pdfVersion.target': 'Target Version',
  'panel.pdfVersion.versionAria': 'PDF version',
  'panel.pdfVersion.setting': 'Setting PDF version…',
  'panel.pdfVersion.settingBtn': 'Setting version…',
  'panel.pdfVersion.set': 'Set Version',
  'panel.pdfVersion.done': 'PDF {{from}} → PDF {{to}}',

  'panel.pdfa.open': 'Open a PDF to convert to PDF/A',
  'panel.pdfa.level': 'Conformance Level',
  'panel.pdfa.levelAria': 'PDF/A conformance level',
  'panel.pdfa.converting': 'Converting to PDF/A…',
  'panel.pdfa.convertingBtn': 'Converting…',
  'panel.pdfa.convert': 'Convert to PDF/A',
  // What the app can state and no more: the output declares the level, which
  // is read back out of the file's own metadata. No validator ran, so
  // "converted to PDF/A-2b" is a claim nothing here verified.
  'panel.pdfa.done': 'Saved. The file declares {{level}} ({{size}} KB).',
  'panel.pdfa.claimNote':
    'The conversion writes the conformance claim and this app reads it back, refusing the result if it says anything else. Whether the file meets the standard is not checked here — no validator runs.',

  // The alteration report both standards panels show. Row labels are keyed by
  // the engine's own alteration kinds; an UNDETERMINED row's kind is the fact
  // name the check could not read, so both vocabularies carry a label.
  'panel.standards.heading': 'What this conversion removed or replaced',
  'panel.standards.clean': 'Nothing was removed — every check ran and found the document intact.',
  'panel.standards.undetermined': 'Could not be determined.',
  'panel.standards.notices': 'Notes from the conversion tool, in its own words',
  'panel.standards.detailTruncated': 'Only the first {{count}} are listed.',
  'panel.standards.noticesTruncated': 'Only the first {{count}} notes are listed.',
  'panel.standards.row.pages_removed': 'Pages removed',
  'panel.standards.row.annotations_removed': 'Annotations removed',
  'panel.standards.row.form_fields_removed': 'Form fields removed',
  'panel.standards.row.attachments_removed': 'Attached files removed',
  'panel.standards.row.document_scripts_removed': 'Document scripts removed',
  'panel.standards.row.optional_content_removed': 'Optional content (layers) removed',
  'panel.standards.row.tagged_structure_removed': 'Tag structure removed',
  'panel.standards.row.outline_removed': 'Bookmarks removed',
  'panel.standards.row.encryption_removed': 'Encryption removed',
  'panel.standards.row.page_content_rasterized': 'Page content replaced by an image',
  'panel.standards.row.colorants_removed': 'Printing plates the conversion did not carry',
  'panel.standards.row.colorant_shadings_rasterized': 'Gradients converted to process colour',
  'panel.standards.row.images_removed': 'Images removed',
  'panel.standards.row.standard_identifiers_removed':
    'Conformance with another standard is no longer declared',
  'panel.standards.row.fonts_substituted': 'Fonts replaced with metric-compatible substitutes',
  'panel.standards.row.producer_removed_feature': 'Content the standard does not permit, removed',
  'panel.standards.row.conformance_abandoned': 'The standard was abandoned during conversion',
  'panel.standards.row.embedded_file_unvalidated': 'Attached files not checked against the standard',
  'panel.standards.row.pages': 'Page count',
  'panel.standards.row.annotations': 'Annotations',
  'panel.standards.row.form_fields': 'Form fields',
  'panel.standards.row.attachments': 'Attached files',
  'panel.standards.row.document_scripts': 'Document scripts',
  'panel.standards.row.optional_content': 'Optional content (layers)',
  'panel.standards.row.tagged_structure': 'Tag structure',
  'panel.standards.row.outline': 'Bookmarks',
  'panel.standards.row.encryption': 'Encryption',
  'panel.standards.row.page_marks': 'What each page draws',
  'panel.standards.row.standard_identifiers': 'Declared standards',
  'panel.standards.row.images': 'Images',
  'panel.standards.detail.change': '{{from}} → {{to}}',
  'panel.standards.detail.subtypeCount': '{{subtype}}: {{count}}',
  'panel.standards.detail.pageMarks': 'Page {{page}} previously carried {{marks}}.',
  'panel.standards.detail.partWas': '{{part}} ({{was}})',
  'panel.standards.part.structure_tree': 'The structure tree',
  'panel.standards.part.mark_information': 'The tagged-document declaration',
  'panel.standards.part.document_language': 'The document language',
  'panel.standards.mark.text': 'text',
  'panel.standards.mark.vector': 'vector art',
  'panel.standards.mark.image': 'images',

  'panel.comments.open': 'Open a PDF to review its comments',
  'panel.comments.empty': 'This document has no comments.',
  'panel.comments.summary_one': '{{count}} comment',
  'panel.comments.summary_other': '{{count}} comments',
  'panel.comments.listAria': 'Comments',
  'panel.comments.jumpTitle': 'Go to this comment',
  'panel.comments.pageLine': '{{label}} · Page {{page}}',
  'panel.comments.editNote': 'Edit note',
  'panel.comments.addNote': 'Add note',
  'panel.comments.recolourTo': 'Recolour to {{color}}',
  'panel.comments.recolour': 'Recolour',
  'panel.comments.delete': 'Delete',
  'panel.comments.notShown_one':
    '{{count}} more comment in the file that this list can’t edit — Delete All still removes it.',
  'panel.comments.notShown_other':
    '{{count}} more comments in the file that this list can’t edit — Delete All still removes them.',
  'panel.comments.confirm': 'Delete all {{count}} comments?',
  'panel.comments.deleteAllBtn': 'Delete all',
  'panel.comments.cancel': 'Cancel',
  'panel.comments.deleteAll': 'Delete all comments',
  'panel.comments.exportTitle': 'Export every comment to an XFDF interchange file',
  'panel.comments.exportBtn': 'Export XFDF…',
  'panel.comments.importTitle': 'Add comments from an XFDF interchange file (undoable)',
  'panel.comments.importBtn': 'Import XFDF…',
  'panel.comments.exporting': 'Exporting XFDF…',
  'panel.comments.exported_one': 'Exported {{count}} comment to XFDF',
  'panel.comments.exported_other': 'Exported {{count}} comments to XFDF',
  // Shown instead of the plain count whenever the two numbers differ, so a
  // partial export never reads like a whole one.
  'panel.comments.exportedIncomplete': 'Exported {{exported}} of {{found}} comments to XFDF',
  'panel.comments.importing': 'Importing XFDF…',
  'panel.comments.imported_one': 'Imported {{count}} comment{{skipped}} — undo with Ctrl+Z',
  'panel.comments.imported_other': 'Imported {{count}} comments{{skipped}} — undo with Ctrl+Z',
  'panel.comments.importedSkipped': ' ({{count}} skipped)',
  'panel.comments.deleting': 'Deleting comments…',
  'panel.comments.removed_one': 'Removed {{count}} comment (undo with Ctrl+Z)',
  'panel.comments.removed_other': 'Removed {{count}} comments (undo with Ctrl+Z)',
  'panel.comments.kind.highlight': 'Highlight',
  'panel.comments.kind.underline': 'Underline',
  // The list names each mark with the word the TOOL STRIP used to place it,
  // not with the format's subtype. A user who pressed "Text" and then read
  // "FreeText" in the list beside it had to work out they were the same
  // thing — and /Text, the sticky note's subtype, was ALSO showing as
  // "Text", so the two were labelled backwards from the user's side. The
  // subtype is still what the engine and the file carry; it is not a
  // user-facing name.
  'panel.comments.kind.strikeout': 'Strikeout',
  'panel.comments.kind.squiggly': 'Squiggly',
  'panel.comments.kind.freetext': 'Text',
  'panel.comments.kind.ink': 'Draw',
  'panel.comments.kind.stamp': 'Stamp',
  'panel.comments.kind.note': 'Sticky note',
  'panel.comments.kind.link': 'Link',
  'panel.comments.kind.measure': 'Measurement',
  'panel.comments.kind.shape': 'Shape',
  'panel.comments.kind.callout': 'Callout',
  'panel.comments.kind.count': 'Count mark',
  'panel.comments.kind.countlegend': 'Takeoff legend',
  'panel.comments.kind.line': 'Line',
  'panel.comments.kind.square': 'Square',
  'panel.comments.kind.circle': 'Circle',
  'panel.comments.kind.polygon': 'Polygon',
  'panel.comments.kind.polyline': 'Polyline',
  'panel.comments.kind.caret': 'Caret',
  'panel.comments.kind.fileattachment': 'Attachment',
  'panel.comments.kind.sound': 'Sound',
  'panel.comments.kind.redact': 'Redaction mark',

  // The list's own controls. The order and the narrowing are the ENGINE's
  // answer; these name the choice, they never describe a second one.
  'panel.comments.sort': 'Order',
  'panel.comments.sort.page': 'Page',
  'panel.comments.sort.author': 'Author',
  'panel.comments.sort.date': 'Date',
  'panel.comments.sort.type': 'Type',
  'panel.comments.filterAuthor': 'Author',
  'panel.comments.filterType': 'Type',
  'panel.comments.filterState': 'Status',
  'panel.comments.filterPages': 'Pages',
  'panel.comments.filterPagesPlaceholder': '1,3,5-9',
  'panel.comments.filterWithText': 'With text only',
  'panel.comments.filterAny': 'Any',
  'panel.comments.filteredAway': 'Hidden by this filter: {{count}}',
  'panel.comments.rowLine': '{{label}} · Page {{page}} · {{author}} · {{date}}',
  'panel.comments.rowSubject': 'Subject: {{subject}}',
  'panel.comments.rowState': 'Status: {{state}}',
  'panel.comments.rowGrouped': 'Grouped with another comment',
  'panel.comments.rowUnknownRelationship':
    'Related to another comment in a way this document does not define',
  'panel.comments.rowOrphan': 'Replies to a comment that is not in this document',
  'panel.comments.rowCycle': 'This reply chain refers to itself',
  'panel.comments.rowReadOnly': 'This comment is in the file but cannot be edited here.',
  'panel.comments.rowPending': 'Not written to the file yet',
  'panel.comments.dateMissing': 'no date recorded',
  'panel.comments.dateWithOffset': '{{date}} (UTC{{offset}})',
  'panel.comments.dateNoOffset': '{{date}} (time zone not recorded)',

  // The summary dialog.
  'panel.comments.summaryBtn': 'Summary…',
  'panel.comments.summaryHint':
    'Create a printable PDF of every comment, with the pages they sit on',
  'panel.comments.summaryTitle': 'Comment summary',
  'panel.comments.summaryAria': 'Comment summary options',
  'panel.comments.summaryCreate': 'Create',
  'panel.comments.summarizing': 'Creating…',
  'panel.comments.summaryOpening': 'Opening the summary…',
  'panel.comments.summaryScope': 'Comments to be written: {{count}}. Types: {{types}}',
  'panel.comments.summaryDone':
    'Saved to {{output}} — sheets: {{sheets}}, comments: {{written}}',
  'panel.comments.summaryReconcile':
    '{{found}} in the document = {{written}} written + {{filtered}} filtered + {{unmodelled}} not modelled',
  'panel.comments.summaryNoPosition':
    'Written without a badge, because their position could not be read: {{count}}',
  'panel.comments.summaryBodyRefused':
    'Written without their text, because it would not lay out: {{count}}',
  'panel.comments.summaryNoBox': 'Pages listed without an image: {{pages}}',
  'panel.comments.summaryUnreadable': 'Pages whose comment list could not be read: {{pages}}',
  'panel.comments.mode': 'Contents',
  'panel.comments.mode.commentsOnly': 'Comments only',
  'panel.comments.mode.documentAndComments': 'Document and comments',
  'panel.comments.placement': 'Comments go',
  'panel.comments.placement.auto': 'Wherever the page is largest',
  'panel.comments.placement.beside': 'Beside the page',
  'panel.comments.placement.beneath': 'Beneath the page',
  'panel.comments.placement.separate': 'On their own sheets',
  'panel.comments.connectors': 'Draw a line from each comment to its entry',
  'panel.comments.gutter': 'Comment column',
  'panel.comments.gutterOption': '{{points}} pt',
  'panel.comments.paper': 'Paper',
  'panel.comments.paper.letter': 'Letter',
  'panel.comments.paper.legal': 'Legal',
  'panel.comments.paper.tabloid': 'Tabloid',
  'panel.comments.paper.a3': 'A3',
  'panel.comments.paper.a4': 'A4',
  'panel.comments.paper.a5': 'A5',

  // The furniture WRITTEN INTO the summary document. Resolved here and handed
  // to the engine, which never translates: a summary is a document about a
  // document, read by a reviewer, so its headings are in the reader's
  // language while every body, author name and subject stays verbatim.
  'panel.comments.doc.title': 'Comment summary',
  'panel.comments.doc.document': 'Document: {{name}}',
  'panel.comments.doc.pageHeading': 'Page {{page}}',
  'panel.comments.doc.pageContinued': 'Page {{page}} (continued)',
  'panel.comments.doc.entryHeader': '{{badge}}. {{author}}',
  'panel.comments.doc.entryMeta': '{{date}} · page {{page}} · {{type}}',
  'panel.comments.doc.replyHeader': 'Reply — {{author}}',
  'panel.comments.doc.replyMeta': 'Replied {{date}}',
  'panel.comments.doc.continued': '{{author}} (continued)',
  'panel.comments.doc.subject': 'Subject: {{subject}}',
  'panel.comments.doc.state': 'Status: {{state}} ({{model}})',
  'panel.comments.doc.stateNoModel': 'Status: {{state}}',
  'panel.comments.doc.groupMember': 'Grouped with the entry by {{author}}',
  'panel.comments.doc.relationshipUnknown':
    'Related to another comment in a way this document does not define',
  'panel.comments.doc.replyOrphan': 'In reply to a comment that is not in this document',
  'panel.comments.doc.replyCycle': 'This reply chain refers to itself',
  'panel.comments.doc.noPosition': 'This comment has no readable position on its page.',
  'panel.comments.doc.noBody': '(no text)',
  'panel.comments.doc.unknownAuthor': 'Unknown author',
  'panel.comments.doc.bodyRefused':
    "This comment's text could not be laid out and is not shown here.",
  'panel.comments.doc.reconcileHeading': 'Reconciliation',
  'panel.comments.doc.reconcileFound': 'Comments in the document: {{count}}',
  'panel.comments.doc.reconcileWritten': 'Comments in this summary: {{count}}',
  'panel.comments.doc.reconcileFiltered': 'Removed by the filter: {{count}}',
  'panel.comments.doc.reconcileUnmodelled':
    'Annotation types this product does not model: {{count}}',
  'panel.comments.doc.reconcileNoPosition':
    'Written without a badge (no readable position): {{count}}',
  'panel.comments.doc.reconcileBodyRefused':
    'Written without their text (it would not lay out): {{count}}',
  'panel.comments.doc.reconcileUnreadable':
    'Pages whose annotation list could not be read: {{pages}}',
  'panel.comments.doc.reconcileNoBox':
    'Pages with no media or crop box, listed without an image: {{pages}}',
  'panel.comments.doc.reconcileBalanced':
    'Every comment in the document is accounted for above.',
  'panel.comments.doc.sortedBy': 'Sorted by: {{sort}}',

  'panel.tags.open': 'Open a PDF to edit its structure tags',
  'panel.tags.untagged':
    'This document has no structure tags. Tag editing needs a tagged PDF — tags are what assistive technology reads, and this file was produced without them.',
  'panel.tags.autotag': 'Add tags automatically',
  'panel.tags.autotagDone': 'Tags added — review them below.',
  'panel.tags.autotagHint':
    'Builds a first structure from the page content — headings by size, paragraphs, figures — in page order. Refine the roles here and the sequence in Reading Order.',
  'panel.tags.summary_one': '{{count}} tag',
  'panel.tags.summary_other': '{{count}} tags',
  'panel.tags.newTypeAria': 'Type for the new tag',
  'panel.tags.newChild': 'New child',
  'panel.tags.newTag': 'New tag',
  'panel.tags.addChildTitle': 'Add an empty child tag under <{{type}}>',
  'panel.tags.addTopTitle': 'Add an empty top-level tag',
  'panel.tags.treeAria': 'Structure tags',
  // An addressed jump that cannot land says so. A tag path never outlives the
  // tree it was read from, and silently selecting something else would make an
  // accessibility finding point at the wrong element.
  'panel.tags.jumpGone': 'That tag is no longer in this document — re-check to refresh the report.',
  'panel.tags.collapse': 'Collapse {{type}}',
  'panel.tags.expand': 'Expand {{type}}',
  'panel.tags.altTitle': 'Alt text: {{alt}}',
  'panel.tags.mapsTo': ' — maps to {{role}}',
  'panel.tags.moveUpTitle': 'Move before the previous sibling',
  'panel.tags.moveUp': 'Move up',
  'panel.tags.moveDownTitle': 'Move after the next sibling',
  'panel.tags.moveDown': 'Move down',
  'panel.tags.outdentTitle': "Move out — becomes the parent's next sibling",
  'panel.tags.outdent': 'Outdent',
  'panel.tags.indentTitle': 'Nest under the previous sibling',
  'panel.tags.indent': 'Indent',
  'panel.tags.deleteTitle': 'Delete this tag and its child tags — the page content stays, untagged',
  'panel.tags.delete': 'Delete',
  'panel.tags.type': 'Type',
  'panel.tags.title': 'Title',
  'panel.tags.alt': 'Alt text (what assistive technology reads for a figure)',
  'panel.tags.actualText': 'Actual text',
  'panel.tags.lang': 'Language (e.g. en-US)',
  'panel.tags.apply': 'Apply',
  'panel.tags.noChanges': 'No changes to apply',
  'panel.tags.typeEmpty': 'The tag type must not be empty',
  'panel.tags.updated': 'Tag updated',
  'panel.tags.moved': 'Tag moved',
  'panel.tags.added': '{{type}} tag added',
  'panel.tags.deleted': 'Tag deleted (its content is now untagged)',

  'panel.encrypt.open': 'Open a PDF to encrypt',
  'panel.encrypt.enterPassword': 'Enter at least one password.',
  'panel.encrypt.ownerNeeded': 'Set an owner password to enforce permission restrictions.',
  'panel.encrypt.addRecipientFirst': 'Add at least one recipient certificate.',
  'panel.encrypt.encrypting': 'Encrypting…',
  'panel.encrypt.encrypt': 'Encrypt',
  'panel.encrypt.encryptedWith': 'Encrypted with {{cipher}}{{openSuffix}}{{permsSuffix}}',
  'panel.encrypt.openSuffix': ' (password required to open)',
  'panel.encrypt.permsSuffix': ' — permissions restricted',
  'panel.encrypt.encryptedTo_one': 'Encrypted to {{count}} recipient certificate{{permsSuffix}}',
  'panel.encrypt.encryptedTo_other': 'Encrypted to {{count}} recipient certificates{{permsSuffix}}',
  'panel.encrypt.modePassword': 'Password',
  'panel.encrypt.modeCerts': 'Certificates',
  'panel.encrypt.userPass': 'User password (to open)',
  'panel.encrypt.userPassPlaceholder': 'Leave empty for no open password',
  'panel.encrypt.ownerPass': 'Owner password (to edit/print)',
  'panel.encrypt.ownerPassPlaceholder': 'Defaults to user password',
  'panel.encrypt.recipients': 'Recipient certificates',
  'panel.encrypt.recipientsBlurb':
    "Anyone holding a listed certificate's private key can open the file — no shared password. Accepts .cer, .crt, .pem, and .der certificate files.",
  'panel.encrypt.removeRecipient': 'Remove recipient',
  'panel.encrypt.addCert': 'Add certificate…',
  'panel.encrypt.allowedReaders': 'Allowed for readers (owner password bypasses these)',
  'panel.encrypt.allowedRecipients': 'Allowed for recipients',
  'panel.encrypt.permPrint': 'Printing',
  'panel.encrypt.permCopy': 'Copying text and graphics',
  'panel.encrypt.permModify': 'Changing the document',
  'panel.encrypt.permAnnotate': 'Commenting and filling form fields',
  'panel.encrypt.a11yNote': 'Accessibility (screen-reader) extraction is always allowed.',

  'panel.hf.open': 'Open a PDF to add headers, footers, or Bates numbers',
  'panel.hf.slot.tl': 'Top left',
  'panel.hf.slot.tc': 'Top center',
  'panel.hf.slot.tr': 'Top right',
  'panel.hf.slot.bl': 'Bottom left',
  'panel.hf.slot.bc': 'Bottom center',
  'panel.hf.slot.br': 'Bottom right',
  'panel.hf.enterText': 'Enter text in at least one position',
  'panel.hf.badRange': 'Error: page range must be e.g. 1-5 or all',
  'panel.hf.applying': 'Applying…',
  'panel.hf.apply': 'Apply',
  'panel.hf.stamped_one': 'Stamped {{count}} page',
  'panel.hf.stamped_other': 'Stamped {{count}} pages',
  'panel.hf.tokensPrefix': 'Tokens:',
  'panel.hf.tokenPage': 'page number',
  'panel.hf.tokenPages': 'total pages',
  'panel.hf.tokenBates': 'Bates number',
  'panel.hf.emptySkips': 'Leave a box empty to skip it.',
  'panel.hf.fontSize': 'Font size',
  'panel.hf.margin': 'Margin',
  'panel.hf.color': 'Color',
  'panel.hf.pagesLabel': 'Pages (e.g. 1-5 or all)',
  'panel.hf.pagesAria': 'Pages',
  'panel.hf.batesStart': 'Bates start',
  'panel.hf.batesStartAria': 'Bates starting number',
  'panel.hf.batesDigits': 'Bates digits',
  'panel.hf.batesDigitsAria': 'Bates digit count',

  'panel.forms.open': 'Open a PDF to fill its form fields',
  // ISO 32000-2 Annex K requires a processor that supports XFA forms to
  // indicate clearly that the user is interacting with one. Static and
  // dynamic are different interactions, so each says what it actually is.
  'panel.forms.xfaStatic':
    'This is an XML form (XFA). Values you fill are saved into both its XML form data and its standard form fields, so every reader shows the same answers.',
  'panel.forms.xfaDynamic':
    'This is a dynamic XML form (XFA): it builds its own pages from an XML template, so its fields cannot be filled here. The fields below are read-only.',
  'panel.forms.xfaCalculations':
    "This form's XML template authors its own calculations. They are not run here, so a value another field computes from stays as the document last saved it.",
  // The value shown came from the XFA datasets packet rather than from the
  // field's own /V (ISO 32000-2 Annex K): the XFA resource carries the state
  // of the form, so a reader that understands XFA shows this answer.
  'panel.forms.fromXfa': 'From XML data',
  'panel.forms.fromXfaTitle':
    "This value comes from the form's XML data, not from the PDF field itself. Filling the form writes it into both.",
  'panel.forms.reading': 'Reading form fields…',
  'panel.forms.noFields': 'This PDF has no form fields.',
  'panel.forms.fieldsAria': 'Form fields',
  'panel.forms.flatten': 'Flatten (lock fields after filling)',
  'panel.forms.applying': 'Applying…',
  'panel.forms.fillFlatten': 'Fill & Flatten',
  'panel.forms.fillForm': 'Fill Form',
  'panel.forms.noChanges': 'No changes to apply',
  'panel.forms.fillingFlattening': 'Filling and flattening…',
  'panel.forms.filling': 'Filling form…',
  'panel.forms.filledFlattened': 'Form filled and flattened (fields locked)',
  'panel.forms.filled_one': 'Filled {{count}} field',
  'panel.forms.filled_other': 'Filled {{count}} fields',
  'panel.forms.errorReading': 'Error reading fields: {{message}}',
  'panel.forms.required': 'required',
  'panel.forms.readOnly': 'read-only',
  'panel.forms.calculated': 'calculated',
  'panel.forms.none': '— none —',
  'panel.forms.scriptsNotRun_one':
    '{{count}} field carries a script this app does not run. Its own value is left alone; every other field still calculates.',
  'panel.forms.scriptsNotRun_other':
    '{{count}} fields carry scripts this app does not run. Their own values are left alone; every other field still calculates.',
  'panel.forms.noCalculationOrder_one':
    '{{count}} field carries a calculation, but this document declares no calculation order, so it was not run.',
  'panel.forms.noCalculationOrder_other':
    '{{count}} fields carry calculations, but this document declares no calculation order, so they were not run.',
  // The stated position on document scripts, and the disclosure that makes it
  // one: what was refused, on which field, and the script itself, readable.
  'panel.forms.scriptsTitle': 'Scripts this app does not run',
  'panel.forms.scriptsPosition':
    'This app runs no form script it cannot verify. It runs the standard formatting, validation and calculation calls, which are declarative and carry no code; anything else is left in the document exactly as it was, and reported here.',
  // F26: the same list, once scripts can actually run. Off is still the
  // default, so the wording above stands and these only add what the reader
  // needs to act: which switch decides it, and what happened to each script
  // that did run.
  'panel.forms.scriptsPreferenceHint':
    'Turn on “Run unrecognized field scripts” in Preferences ▸ General to run these in the sandboxed interpreter.',
  'panel.forms.scriptsPolicyHint':
    'Field scripting is turned off for this machine by policy, so the preference cannot enable it.',
  'panel.forms.scriptsRunningTitle': 'Scripts this document runs',
  'panel.forms.scriptsRunningPosition':
    'Standard formatting, validation and calculation calls are evaluated directly and carry no code. Everything else runs in a sandboxed interpreter with no access to the network, the file system, printing or your documents. Scripts that ran without incident are not listed.',
  'panel.forms.scriptsAllClean': 'Every script in this document ran without incident.',
  'panel.forms.scriptRefused':
    'Left this call out: {{capabilities}}. The rest of the script ran.',
  'panel.forms.scriptErrored': 'Stopped with an error: {{message}}',
  'panel.forms.scriptTimedOut':
    'Did not finish within {{ms}} ms and was stopped. The rest of the form still computes.',
  'panel.forms.scriptTrigger.Fo': 'When the field is entered',
  'panel.forms.scriptTrigger.Bl': 'When the field is left',
  'panel.forms.scriptShow': 'Show the script',
  'panel.forms.scriptHide': 'Hide the script',
  'panel.forms.scriptTrigger.K': 'When a value is typed',
  'panel.forms.scriptTrigger.V': 'When a value is checked',
  'panel.forms.scriptTrigger.C': 'When the form recalculates',
  'panel.forms.scriptTrigger.F': 'When a value is displayed',
  'panel.forms.dataActionRow': '{{trigger}}: {{action}}',
  // The whole sentence, not a suffix bolted onto the row above: a translation
  // orders the clause where its own grammar wants it.
  'panel.forms.dataActionRowReported': '{{trigger}}: {{action}} — reported, not performed',

  'panel.compare.open': 'Open a PDF to compare',
  'panel.compare.comparingLabel': 'Comparing:',
  'panel.compare.against': 'against',
  'panel.compare.openSecond': 'Open a second PDF to compare against.',
  'panel.compare.openAnotherPdf': 'Open another PDF…',
  'panel.compare.modeText': 'Text',
  'panel.compare.modeVisual': 'Visual',
  'panel.compare.comparing': 'Comparing…',
  'panel.compare.compare': 'Compare',
  'panel.compare.openAnother': 'Open another…',
  'panel.compare.openAnotherTitle': 'Open another PDF into the workspace',
  'panel.compare.identical': 'The text of these PDFs is identical.',
  'panel.compare.similar': '{{pct}}% of lines unchanged',
  'panel.compare.added': '+{{count}} added',
  'panel.compare.removed': '−{{count}} removed',
  'panel.compare.pagesChanged': 'pages: {{a}} → {{b}}',
  'panel.compare.truncated': '(diff truncated)',
  'panel.compare.gap_one': '⋯ {{count}} unchanged line ⋯',
  'panel.compare.gap_other': '⋯ {{count}} unchanged lines ⋯',
  'panel.compare.visualIdentical_one':
    'These PDFs are visually identical ({{count}} page at {{dpi}} dpi).',
  'panel.compare.visualIdentical_other':
    'These PDFs are visually identical ({{count}} pages at {{dpi}} dpi).',
  'panel.compare.pairsDiffer_one': '{{differing}} of {{count}} page pair differ',
  'panel.compare.pairsDiffer_other': '{{differing}} of {{count}} page pairs differ',
  'panel.compare.onlyIn': 'only in {{side}}',
  'panel.compare.pctChanged': '{{pct}}% changed',
  'panel.compare.selectPair': 'Select a differing page pair to inspect.',
  'panel.compare.bufferUnavailable': 'File buffer unavailable.',
  'panel.compare.pageLabel': '{{label}}: {{name}} — p{{page}}',

  'panel.links.open': 'Open a PDF to manage its links',
  'panel.links.empty': 'This document has no links.',
  'panel.links.summary_one': '{{count}} link',
  'panel.links.summary_other': '{{count}} links',
  'panel.links.pageKind': 'Page {{page}} · {{kind}}',
  'panel.links.noTarget': '(no target)',
  'panel.links.removed': 'Link removed',
  'panel.links.delete': 'Delete',
  'panel.links.derive.title': 'Create links from web addresses',
  'panel.links.derive.pages': 'Pages',
  'panel.links.derive.emails': 'Link email addresses too',
  'panel.links.derive.find': 'Find addresses',
  'panel.links.derive.create': 'Create links',
  'panel.links.derive.found': '{{count}} found, {{existing}} already linked',
  'panel.links.derive.created': 'Links created',

  'panel.links.draw.title': 'Draw a link',
  'panel.links.draw.hint':
    'Drag a rectangle anywhere on the page — over a figure, a table, a heading — then choose where it goes.',
  'panel.links.draw.pending': 'Rectangle drawn on page {{page}}',
  'panel.links.draw.create': 'Create link',
  'panel.links.draw.created': 'Link created on page {{page}}',
  'panel.links.draw.discard': 'Discard',
  'panel.links.edit.open': 'Edit',
  'panel.links.edit.title': 'Link on page {{page}}',
  'panel.links.edit.apply': 'Apply',
  'panel.links.edit.cancel': 'Cancel',
  'panel.links.edit.readOnly':
    'This link carries an action this app does not author ({{action}}). Its target is left exactly as the document wrote it.',
  'panel.links.kind': 'Goes to',
  'panel.links.kind.uri': 'A web address',
  'panel.links.kind.goto': 'A page in this document',
  'panel.links.kind.named': 'A named destination',
  'panel.links.kind.file': 'Another file',
  'panel.links.kind.launch': 'A file for the system to open',
  'panel.links.kind.other': 'An action this app does not author',
  'panel.links.kind.none': 'Nothing',
  'panel.links.url': 'Address',
  'panel.links.page': 'Page',
  'panel.links.name': 'Destination',
  'panel.links.name.none': 'This document declares no named destinations.',
  'panel.links.file': 'File',
  'panel.links.file.browse': 'Choose…',
  'panel.links.file.hint':
    'A PDF opens in this app after you confirm it. Any other file is reported, never run.',
  'panel.links.file.page': 'Page in that file (optional)',
  'panel.links.file.newWindow': 'Open in a new window',
  'panel.links.view': 'View',
  'panel.links.view.inherit': 'Keep the reader’s zoom',
  'panel.links.view.xyz': 'A position and zoom',
  'panel.links.view.fit': 'Fit the page',
  'panel.links.view.fith': 'Fit the width',
  'panel.links.view.fitv': 'Fit the height',
  'panel.links.view.fitr': 'Fit a rectangle',
  'panel.links.view.fitb': 'Fit the drawn area',
  'panel.links.view.fitbh': 'Fit the drawn width',
  'panel.links.view.fitbv': 'Fit the drawn height',
  'panel.links.view.left': 'Left',
  'panel.links.view.top': 'Top',
  'panel.links.view.right': 'Right',
  'panel.links.view.bottom': 'Bottom',
  'panel.links.view.zoom': 'Zoom',
  'panel.links.appearance': 'Border',
  'panel.links.appearance.width': 'Width',
  'panel.links.appearance.invisible': 'Invisible',
  'panel.links.appearance.style': 'Style',
  'panel.links.appearance.solid': 'Solid',
  'panel.links.appearance.dashed': 'Dashed',
  'panel.links.appearance.underline': 'Underline',
  'panel.links.appearance.beveled': 'Beveled',
  'panel.links.appearance.inset': 'Inset',
  'panel.links.appearance.color': 'Colour',
  'panel.links.appearance.highlight': 'Click effect',
  'panel.links.appearance.highlight.none': 'None',
  'panel.links.appearance.highlight.invert': 'Invert',
  'panel.links.appearance.highlight.outline': 'Outline',
  'panel.links.appearance.highlight.push': 'Inset',
  'panel.links.jump': 'Go to',
  'panel.links.retargeted': 'Link target updated',
  'panel.links.problem.url': 'Enter a web address.',
  'panel.links.problem.page': 'Enter a page number.',
  'panel.links.problem.pageRange': 'This document does not have that page.',
  'panel.links.problem.name': 'Choose a destination.',
  'panel.links.problem.unknownName': 'This document has no destination by that name.',
  'panel.links.problem.path': 'Choose a file.',
  'panel.links.problem.filePage': 'A page in another file must be a whole page number.',
  'panel.links.problem.readOnly': 'This app does not author that kind of link.',
  'panel.links.problem.width': 'A border width cannot be negative.',
  'panel.links.problem.style': 'Choose solid, dashed or underline.',
  'panel.links.problem.color': 'Choose a colour.',

  'panel.pageLabels.open': 'Open a PDF to set page number labels',
  'panel.pageLabels.blurb':
    'Number pages independently of their order — front matter as “i, ii, iii”, the body as “1, 2, 3”. Each range starts on a page and runs until the next range. No ranges = plain physical numbers.',
  'panel.pageLabels.styleNone': 'None (prefix only)',
  'panel.pageLabels.fromPage': 'From page',
  'panel.pageLabels.style': 'Style',
  'panel.pageLabels.prefix': 'Prefix',
  'panel.pageLabels.startAt': 'Start at',
  'panel.pageLabels.remove': 'Remove',
  'panel.pageLabels.addRange': '+ Add range',
  'panel.pageLabels.preview': 'Preview:',
  'panel.pageLabels.applying': 'Applying…',
  'panel.pageLabels.apply': 'Apply',
  'panel.pageLabels.duplicateStart': 'Two ranges start on the same page — each start must be unique',
  'panel.pageLabels.removed': 'Page labels removed',
  'panel.pageLabels.applied_one': 'Applied {{count}} label range',
  'panel.pageLabels.applied_other': 'Applied {{count}} label ranges',

  'panel.docjs.open': 'Open a PDF to edit its document JavaScript',
  'panel.docjs.heading': 'Document JavaScript in',
  'panel.docjs.addScript': '+ Add script',
  'panel.docjs.saveScripts': 'Save scripts',
  'panel.docjs.blurb':
    'These scripts run when the document is opened in a PDF reader. This editor never runs them — it only reads and writes the text.',
  'panel.docjs.empty': 'This PDF has no document-level JavaScript. Use Add script to create one.',
  'panel.docjs.listAria': 'Document scripts',
  'panel.docjs.unnamed': '(unnamed)',
  'panel.docjs.name': 'Name',
  'panel.docjs.delete': 'Delete',
  'panel.docjs.placeholder': '// document-level JavaScript',
  'panel.docjs.needsName': 'Every script needs a name.',
  'panel.docjs.duplicateName': 'Two scripts have the same name — names must be unique.',
  'panel.docjs.saving': 'Saving document scripts…',

  'panel.watermark.open': 'Open a PDF to watermark',
  'panel.watermark.emptyText': 'Error: watermark text is empty',
  'panel.watermark.badPages': 'Error: no valid page numbers — use e.g. 1,3,5 or all',
  'panel.watermark.applying': 'Applying the watermark…',
  'panel.watermark.applyingBtn': 'Applying…',
  'panel.watermark.apply': 'Apply watermark',
  'panel.watermark.done_one': 'Watermarked {{count}} page',
  'panel.watermark.done_other': 'Watermarked {{count}} pages',
  'panel.watermark.text': 'Text',
  'panel.watermark.textAria': 'Watermark text',
  'panel.watermark.opacity': 'Opacity ({{pct}}%)',
  'panel.watermark.opacityAria': 'Opacity',
  'panel.watermark.angle': 'Angle (°)',
  'panel.watermark.angleAria': 'Angle in degrees',
  'panel.watermark.color': 'Color',
  'panel.watermark.placement': 'Placement',
  'panel.watermark.over': 'Over content',
  'panel.watermark.under': 'Behind content',
  'panel.watermark.pagesLabel': 'Pages (e.g. 1,3,5 or all)',
  'panel.watermark.pagesAria': 'Pages to watermark',
  'panel.watermark.scriptsNote':
    'Latin, Cyrillic, Greek, Hebrew, Arabic and CJK supported; other scripts (e.g. Devanagari, Thai) are not.',
  // The vertical note REPLACES the horizontal one rather than joining it: a
  // vertical stamp embeds the bundled vertical face, so the script coverage
  // the horizontal sentence describes is not the coverage in force.
  'panel.watermark.scriptsNoteVertical':
    'A vertical stamp draws through the bundled vertical face, which covers CJK.',
  // Names the axis the TEXT runs along, not the stamp's rotation: a bare
  // "Direction" beside the Angle field reads as a second way to say the same
  // thing, and the two are independent (a vertical column is still turned by
  // the angle).
  'panel.watermark.writingMode': 'Text direction',
  'panel.watermark.writingMode.horizontal': 'Horizontal',
  'panel.watermark.writingMode.vertical': 'Vertical',
  'panel.watermark.writingModeTitle':
    'A vertical stamp is one column reading down the page, turned by the angle like any other stamp.',
  // The direction the engine derived from the text — a readout of what was
  // stamped, not a control. It names the script convention the column was
  // set in, which is also what chose the face.
  'panel.watermark.columnsRtl': 'Right-to-left vertical script.',
  'panel.watermark.columnsLtr': 'Left-to-right vertical script.',
  'panel.watermark.source': 'Watermark from',
  'panel.watermark.sourceText': 'Text',
  'panel.watermark.sourceImage': 'Image',
  'panel.watermark.sourcePdf': 'PDF page',
  'panel.watermark.pdfLabel': 'PDF',
  'panel.watermark.choosePdf': 'Choose PDF…',
  'panel.watermark.noPdfChosen': 'No PDF chosen',
  'panel.watermark.noPdf': 'Error: choose a PDF to stamp',
  'panel.watermark.pdfPage': 'Page',
  'panel.watermark.pdfNote': 'The page is stamped as vector artwork and stored once, however many pages it stamps.',
  'panel.watermark.imageLabel': 'Image',
  'panel.watermark.chooseImage': 'Choose image…',
  'panel.watermark.noImageChosen': 'No image chosen',
  'panel.watermark.noImage': 'Error: choose an image to stamp',
  'panel.watermark.imageNote': 'The picture is stored once, however many pages it stamps.',
  'panel.watermark.usedFirstFrame_one': 'The picture holds {{count}} frame; the first was used.',
  'panel.watermark.usedFirstFrame_other': 'The picture holds {{count}} frames; the first was used.',
  'panel.watermark.scale': 'Scale',
  'panel.watermark.position': 'Position',
  'panel.watermark.position.center': 'Center',
  'panel.watermark.position.top-left': 'Top left',
  'panel.watermark.position.top-center': 'Top center',
  'panel.watermark.position.top-right': 'Top right',
  'panel.watermark.position.middle-left': 'Middle left',
  'panel.watermark.position.middle-right': 'Middle right',
  'panel.watermark.position.bottom-left': 'Bottom left',
  'panel.watermark.position.bottom-center': 'Bottom center',
  'panel.watermark.position.bottom-right': 'Bottom right',
  'panel.watermark.margin': 'Margin (pt)',
  'panel.watermark.tile': 'Tile across the page',
  'panel.watermark.tileGap': 'Gap (pt)',

  'panel.rebuild.open': 'Open a PDF to rebuild',
  'panel.rebuild.blurb':
    'Deep rebuild via Ghostscript. Re-renders every page through the GS interpreter into a fresh PDF. Fixes font embedding issues, colorspace problems, and corrupt content streams.',
  'panel.rebuild.note':
    'Note: May lose interactive elements (form fields, JavaScript actions). Use Tier 1 Repair first for lighter fixes.',
  'panel.rebuild.rebuilding': 'Rebuilding PDF (Tier 2: Ghostscript round-trip)…',
  'panel.rebuild.rebuildingBtn': 'Rebuilding…',
  'panel.rebuild.rebuild': 'Rebuild',
  'panel.rebuild.done': 'Rebuilt: {{from}} KB -> {{to}} KB, {{pages}} pages.',

  // ── Preflight ───────────────────────────────────────────────────────────
  //
  // The panel and both export emitters read the SAME keys, so a verdict can
  // never be worded one way on screen and another in the saved file.
  //
  // A check NAME and its EXPLANATION are two keys, never a concatenation. A
  // finding's sentence is keyed by the engine's `detail_key` and interpolates
  // the measured values — nothing downstream ever matches on rendered text. A
  // parameter's unit goes through the catalog with a placeholder, never
  // concatenated onto its number. And a SHIPPED profile's name is a catalog
  // key while a USER profile's name is authored content that is never
  // translated, which is why the schema carries both fields.
  'panel.preflight.open': 'Open a PDF to run print preflight',
  'panel.preflight.analysing': 'Analysing…',
  'panel.preflight.rerun': 'Re-run',
  'panel.preflight.allPassed': 'Ready to print — all {{count}} checks passed.',
  'panel.preflight.images_one': '{{count}} image',
  'panel.preflight.images_other': '{{count}} images',
  'panel.preflight.colour': ' · colour: {{families}}',
  'panel.preflight.export': 'Export…',
  'panel.preflight.exporting': 'Saving the report…',
  'panel.preflight.exported': 'Report saved to {{path}}',
  'panel.preflight.show': 'Show',
  'panel.preflight.hide': 'Hide',
  'panel.preflight.noCanvas': 'Open the document to show findings on its pages.',
  'panel.preflight.nothingToShow': 'Nothing in this check has a place on a page.',
  'panel.preflight.jumpTitle': 'Go to this item',
  'panel.preflight.fixing': 'Repairing…',
  'panel.preflight.fixed': 'Repaired. The report has been re-run.',
  'panel.preflight.fixAll': 'Fix what this profile can',
  'panel.preflight.nothingToFix':
    'This profile carries no fixup for anything this document failed.',
  'panel.preflight.needsValue': 'Type the value this repair writes first.',
  'panel.preflight.fixField.title': 'Title',
  'panel.preflight.fixField.trapped': 'Trapping state',
  'panel.preflight.fixField.bleed': 'Bleed',
  'panel.preflight.fixField.ink': 'Print it on',
  'panel.preflight.trapped.true': 'Trapped',
  'panel.preflight.trapped.false': 'Not trapped',
  'panel.preflight.trapped.unknown': 'Not stated',
  'panel.preflight.findingCount': '{{count}} of {{counted}}',
  'panel.preflight.moreFindings':
    '{{count}} more are not listed here — the exported report carries every one.',
  'panel.preflight.summaryLine':
    '{{passed}} passed · {{failed}} failed · {{warnings}} to improve · {{review}} to review · {{notApplicable}} not applicable — {{applicable}} of {{total}} checks apply',
  'panel.preflight.categoryCount': '{{passed}} / {{applicable}}',
  'panel.preflight.categoryNone': 'nothing to check',
  'panel.preflight.ruleLine': 'Measured against: {{rule}}',
  'panel.preflight.paramPair': '{{label}} {{value}}',
  'panel.preflight.yes': 'yes',
  'panel.preflight.no': 'no',
  'panel.preflight.anyValue': 'any',
  'panel.preflight.unit.pt': '{{value}} pt',
  'panel.preflight.unit.dpi': '{{value}} dpi',
  'panel.preflight.unit.pct': '{{value}} %',
  'panel.preflight.reportTitle': 'Print preflight report',
  'panel.preflight.reportDocument': 'Document: {{name}}',
  'panel.preflight.reportProfile': 'Profile: {{name}}',
  'panel.preflight.reportRunAt': 'Checked: {{when}}',
  'panel.preflight.reportFooter':
    'This report states which of 38 checks the document passes against the named profile. It is not a certificate of conformance.',
  // Emitted only under the three standards profiles. Their names are the
  // standard's, so the report has to say which of the standard's rules it
  // actually decided rather than letting the name answer for it.
  'panel.preflight.reportStandardsNote':
    'This profile carries the rules of {{standard}} that these checks can decide from the file. It does not cover the whole standard, and a clean report is not a conformance verdict.',
  'panel.preflight.unreadableHeading': 'Parts that could not be read',

  'panel.preflight.where.page': 'Page {{page}}',
  'panel.preflight.where.annotation': 'Annotation on page {{page}}',
  'panel.preflight.where.field': 'Field “{{name}}”',
  'panel.preflight.where.ink': 'Ink “{{name}}”',
  'panel.preflight.where.document': 'Document',

  'panel.preflight.verdict.pass': 'Passed',
  'panel.preflight.verdict.fail': 'Failed',
  'panel.preflight.verdict.warn': 'Short of the recommendation',
  'panel.preflight.verdict.needs_review': 'Needs review',
  'panel.preflight.verdict.not_applicable': 'Not applicable',

  'panel.preflight.category.document': 'Document',
  'panel.preflight.category.pages': 'Pages',
  'panel.preflight.category.colour': 'Colour',
  'panel.preflight.category.fonts': 'Fonts',
  'panel.preflight.category.images': 'Images',
  'panel.preflight.category.content': 'Content',
  'panel.preflight.category.metadata': 'Metadata',

  'panel.preflight.check.pdf_version': 'PDF version is within range',
  'panel.preflight.explain.pdf_version':
    'A RIP that predates the file’s version may not read it at all.',
  'panel.preflight.check.print_permitted': 'Printing is permitted',
  'panel.preflight.explain.print_permitted':
    'Permission bits can forbid printing, or forbid it at full resolution.',
  'panel.preflight.check.structurally_sound': 'Document is structurally sound',
  'panel.preflight.explain.structurally_sound':
    'A damaged cross-reference table is a file a press may not open.',
  'panel.preflight.check.output_intent': 'Output intent present',
  'panel.preflight.explain.output_intent':
    'The output intent names the printing condition the colour was prepared for.',
  'panel.preflight.check.pdfx_claim': 'PDF/X version claim matches',
  'panel.preflight.explain.pdfx_claim':
    'A document claiming a standard is judged against that standard.',
  'panel.preflight.check.trapped_declared': 'Trapping state is declared',
  'panel.preflight.explain.trapped_declared':
    'Whether the file is already trapped is a claim only a person may make.',
  'panel.preflight.check.embedded_files': 'No embedded files',
  'panel.preflight.explain.embedded_files':
    'An attachment travels with the document and reaches the press with it.',
  'panel.preflight.check.page_size_consistent': 'Page size is consistent',
  'panel.preflight.explain.page_size_consistent':
    'Pages of different sizes cannot be imposed as one signature.',
  'panel.preflight.check.page_size_expected': 'Page size is the expected one',
  'panel.preflight.explain.page_size_expected':
    'The job’s own trim size is what the imposition was built around.',
  'panel.preflight.check.trim_box': 'Trim box is defined',
  'panel.preflight.explain.trim_box':
    'The trim box is where the page is cut; without it the cut is a guess.',
  'panel.preflight.check.bleed_sufficient': 'Bleed is sufficient',
  'panel.preflight.explain.bleed_sufficient':
    'Art must run past the trim, or a cutting tolerance shows white.',
  'panel.preflight.check.page_count': 'Page count fits the job',
  'panel.preflight.explain.page_count':
    'A saddle-stitched job needs a page count its binding can fold.',
  'panel.preflight.check.colour_family': 'No forbidden colour family',
  'panel.preflight.explain.colour_family':
    'RGB on a press is converted by the RIP, to a colour nobody chose.',
  'panel.preflight.check.grayscale_only': 'Grayscale only',
  'panel.preflight.explain.grayscale_only':
    'A single-plate job must carry no colour a second plate would need.',
  'panel.preflight.check.device_independent_colour': 'No device-independent colour',
  'panel.preflight.explain.device_independent_colour':
    'Some standards require every colour to be device colour.',
  'panel.preflight.check.spot_ink_count': 'Spot ink count is within the limit',
  'panel.preflight.explain.spot_ink_count':
    'Each spot ink is another plate, another wash-up and another cost.',
  'panel.preflight.check.spot_ink_names': 'Spot inks are on the approved list',
  'panel.preflight.explain.spot_ink_names':
    'An ink named off the list is an ink the press has not mixed.',
  'panel.preflight.check.ink_coverage_max': 'Total area coverage is within the limit',
  'panel.preflight.explain.ink_coverage_max':
    'Too much ink on one spot does not dry; it sets off onto the next sheet.',
  'panel.preflight.check.overprint': 'Overprint is deliberate',
  'panel.preflight.explain.overprint':
    'Ink set to overprint lays over what is under it instead of knocking it out.',
  'panel.preflight.check.fonts_embedded': 'All fonts are embedded',
  'panel.preflight.explain.fonts_embedded':
    'A font the press does not have is a font the press substitutes.',
  'panel.preflight.check.fonts_subset': 'Embedded fonts are subsets',
  'panel.preflight.explain.fonts_subset':
    'A full face embeds every glyph, including the ones nothing sets.',
  'panel.preflight.check.type3_fonts': 'No Type 3 fonts',
  'panel.preflight.explain.type3_fonts':
    'A Type 3 glyph is a drawing, and it does not scale like an outline.',
  'panel.preflight.check.min_type_size': 'Type is large enough to print',
  'panel.preflight.explain.min_type_size':
    'Below a certain size type fills in on press, and reversed type fills in sooner.',
  'panel.preflight.check.small_text_k_only': 'Small black text is one ink',
  'panel.preflight.explain.small_text_k_only':
    'Black built from four inks needs registration small type will not hold.',
  'panel.preflight.check.image_min_dpi_contone': 'Contone images are high enough resolution',
  'panel.preflight.explain.image_min_dpi_contone':
    'A photograph below the screen’s own resolution prints soft.',
  'panel.preflight.check.image_min_dpi_bitonal': 'Bitonal images are high enough resolution',
  'panel.preflight.explain.image_min_dpi_bitonal':
    'Line art carries its edges in its pixels and needs far more of them.',
  'panel.preflight.check.image_max_dpi': 'Images are not over-resolution',
  'panel.preflight.explain.image_max_dpi':
    'Pixels beyond what the screen resolves cost time and buy nothing.',
  'panel.preflight.check.image_compression': 'Image compression is permitted',
  'panel.preflight.explain.image_compression':
    'Some standards forbid a codec a RIP of their era cannot decode.',
  'panel.preflight.check.image_colour_space': 'Images are in a permitted colour space',
  'panel.preflight.explain.image_colour_space':
    'An image in the wrong space is converted by the RIP, not by anyone.',
  'panel.preflight.check.live_transparency': 'No live transparency',
  'panel.preflight.explain.live_transparency':
    'A RIP that cannot composite transparency flattens it, unpredictably.',
  'panel.preflight.check.hairlines_absent': 'No hairline strokes',
  'panel.preflight.explain.hairlines_absent':
    'A hairline renders on screen and breaks up on an imagesetter.',
  'panel.preflight.check.optional_content': 'No optional content',
  'panel.preflight.explain.optional_content':
    'Which layers a RIP prints is a decision nobody made deliberately.',
  'panel.preflight.check.processing_steps': 'Processing steps are declared and non-printing',
  'panel.preflight.explain.processing_steps':
    'A die line or a varnish left switched on reaches the plate as ink.',
  'panel.preflight.check.printing_annotations': 'No printing annotations',
  'panel.preflight.explain.printing_annotations':
    'An annotation flagged to print reaches the plate with the page.',
  'panel.preflight.check.interactive_form': 'No interactive form',
  'panel.preflight.explain.interactive_form':
    'A form field prints its appearance, and its value may not be in it.',
  'panel.preflight.check.title_present': 'Document has a title',
  'panel.preflight.explain.title_present':
    'The title is how a job is identified once the file name is gone.',
  'panel.preflight.check.document_javascript': 'No document JavaScript',
  'panel.preflight.explain.document_javascript':
    'Scripting in a print file does nothing but travel with it.',
  'panel.preflight.check.xmp_present': 'XMP metadata present',
  'panel.preflight.explain.xmp_present':
    'The standards read their own claims out of the XMP packet.',

  'panel.preflight.detail.version_above_max':
    'PDF {{version}} is newer than the profile’s limit of {{max}}.',
  'panel.preflight.detail.version_below_min':
    'PDF {{version}} is older than the profile’s minimum of {{min}}.',
  'panel.preflight.detail.print_denied': 'The permissions forbid printing.',
  'panel.preflight.detail.print_highres_denied':
    'The permissions allow only low-resolution printing.',
  'panel.preflight.detail.structural_error': '{{message}}',
  'panel.preflight.detail.output_intent_missing': 'The document declares no output intent.',
  'panel.preflight.detail.output_intent_not_allowed':
    'The output intent “{{identifier}}” is not one the profile allows ({{allowed}}).',
  'panel.preflight.detail.output_intent_profile_missing':
    'The output intent “{{identifier}}” embeds no colour profile.',
  'panel.preflight.detail.pdfx_claim_missing':
    'The document claims no PDF/X version; the profile expects {{expected}}.',
  'panel.preflight.detail.pdfx_claim_mismatch':
    'The document claims {{found}}; the profile expects {{expected}}.',
  'panel.preflight.detail.trapped_undeclared':
    'The document does not say whether it has been trapped.',
  'panel.preflight.detail.trapped_not_accepted':
    'The trapping state is {{value}}; the profile accepts {{accepted}}.',
  'panel.preflight.detail.embedded_file': 'The file “{{name}}” travels with this document.',
  'panel.preflight.detail.page_size_differs':
    '{{width}} × {{height}} pt on {{count}} pages, against the first page’s {{first_width}} × {{first_height}} pt.',
  'panel.preflight.detail.page_size_unexpected':
    'Page {{page}} measures {{width}} × {{height}} pt; the job’s size is {{expected_width}} × {{expected_height}} pt.',
  'panel.preflight.detail.trim_box_missing':
    'Page {{page}} has no trim box, so where it is cut is a guess.',
  'panel.preflight.detail.bleed_box_missing': 'Page {{page}} has no bleed box.',
  'panel.preflight.detail.bleed_too_small':
    'Page {{page}} bleeds {{bleed}} pt past the trim; the profile asks for {{required}} pt.',
  'panel.preflight.detail.page_count_below':
    'The document has {{pages}} pages; the profile asks for at least {{min}}.',
  'panel.preflight.detail.page_count_above':
    'The document has {{pages}} pages; the profile allows at most {{max}}.',
  'panel.preflight.detail.page_count_not_multiple':
    'The document has {{pages}} pages, which is not a multiple of {{multiple}}.',
  'panel.preflight.detail.forbidden_colour_family':
    '{{family}} is used on page {{page}} ({{category}}).',
  'panel.preflight.detail.not_grayscale':
    '{{family}} on page {{page}} needs a plate this job does not have.',
  'panel.preflight.detail.device_independent_colour':
    '{{family}} on page {{page}} is device-independent colour.',
  'panel.preflight.detail.too_many_spots':
    '{{count}} spot inks, against a limit of {{max}}.',
  'panel.preflight.detail.spot_not_allowed':
    'The ink “{{name}}” is not on the approved list.',
  'panel.preflight.detail.tac_not_measured':
    'Page {{page}} could not be measured: {{reason}}',
  'panel.preflight.detail.tac_over_limit':
    'Page {{page}} reaches {{max_tac}} % ink against a limit of {{limit}} %, over {{area}} % of the page.',
  'panel.preflight.detail.tac_budget_exceeded':
    '{{pages}} pages beyond the profile’s budget of {{budget}} were not measured.',
  'panel.preflight.detail.overprint_zero_tint':
    'Page {{page}}: a zero-tint {{channel}} is set to overprint, so it disappears.',
  'panel.preflight.detail.overprint_unknown_ink':
    'Page {{page}}: an overprinting {{channel}} uses ink this walk could not resolve.',
  'panel.preflight.detail.overprint_present':
    'Page {{page}}: a {{channel}} is set to overprint.',
  'panel.preflight.detail.overprint_state_unpainted':
    '{{count}} overprinting graphics states are declared, and no paint using one was reached.',
  'panel.preflight.detail.font_not_embedded':
    '“{{name}}” is not embedded (pages {{pages}}).',
  'panel.preflight.detail.font_not_subset':
    '“{{name}}” embeds the whole face, not a subset.',
  'panel.preflight.detail.type3_font': '“{{name}}” is a Type 3 font.',
  'panel.preflight.detail.type_too_small':
    'Page {{page}}: {{size}} pt type, below the {{minimum}} pt minimum.',
  'panel.preflight.detail.type_too_small_reversed':
    'Page {{page}}: {{size}} pt reversed type, below the {{minimum}} pt minimum for reversed type.',
  'panel.preflight.detail.type_backdrop_unknown':
    'Page {{page}}: {{size}} pt type over a backdrop this walk could not resolve.',
  'panel.preflight.detail.small_text_multi_ink':
    'Page {{page}}: {{size}} pt black type built from {{inks}} inks, against a limit of {{max}}.',
  'panel.preflight.detail.image_below_min_dpi':
    'Page {{page}}, image {{index}}: {{dpi}} dpi, below the {{minimum}} dpi minimum.',
  'panel.preflight.detail.image_bitonal_below_min_dpi':
    'Page {{page}}, image {{index}}: {{dpi}} dpi of line art, below the {{minimum}} dpi minimum.',
  'panel.preflight.detail.images_unmeasured':
    '{{count}} image placements could not be measured, so this figure is a floor.',
  'panel.preflight.detail.image_above_max_dpi':
    'Page {{page}}, image {{index}}: {{dpi}} dpi, above the {{maximum}} dpi ceiling.',
  'panel.preflight.detail.image_forbidden_filter':
    'Page {{page}}, image {{index}} uses {{filter}}, which the profile forbids.',
  'panel.preflight.detail.image_forbidden_colour_family':
    'An image on page {{page}} is {{family}} ({{category}}).',
  'panel.preflight.detail.live_transparency': 'Page {{page}} carries live transparency.',
  'panel.preflight.detail.hairline_stroke':
    'Page {{page}}: a stroke {{width}} pt wide on the device, below {{threshold}} pt.',
  'panel.preflight.detail.hairline_border':
    'Page {{page}}: an annotation border {{width}} pt wide, below {{threshold}} pt.',
  'panel.preflight.detail.optional_content_layer':
    'The layer “{{name}}” leaves what prints to the RIP.',
  'panel.preflight.detail.processing_steps_absent':
    'This document declares no processing steps.',
  'panel.preflight.detail.processing_step_printing':
    'The processing step “{{name}}” ({{group}}) is not declared off the print, so it reaches the plate.',
  'panel.preflight.detail.processing_step_no_group':
    'The layer “{{name}}” is marked as a processing step but names no group.',
  'panel.preflight.detail.processing_step_type_on_untyped_group':
    'The layer “{{name}}” gives the type “{{type}}”, but the group “{{group}}” defines no types.',
  'panel.preflight.detail.processing_step_unregistered':
    'The layer “{{name}}” declares “{{group}}”/“{{type}}”, which is not a name this check recognizes and carries no vendor prefix. Confirm it against the standard.',
  'panel.preflight.detail.processing_step_custom':
    'The layer “{{name}}” declares the vendor-defined processing step “{{group}}”/“{{type}}”.',
  'panel.preflight.detail.printing_annotation':
    'Page {{page}}: a {{subtype}} annotation is flagged to print.',
  'panel.preflight.detail.form_field':
    'The {{type}} field “{{name}}” prints its appearance, not necessarily its value.',
  'panel.preflight.detail.title_missing': 'The document has no title.',
  'panel.preflight.detail.document_javascript': 'JavaScript at {{name}}.',
  'panel.preflight.detail.xmp_missing': 'The document carries no XMP metadata packet.',
  'panel.preflight.detail.check_disabled': 'This profile switched the check off.',
  'panel.preflight.detail.unreadable_branch':
    'Part of the document could not be read, so this check cannot report a pass: {{reason}}',
  'panel.preflight.detail.read_failed': 'This check’s own read did not complete: {{reason}}',

  'panel.preflight.param.max_version': 'Highest PDF version',
  'panel.preflight.param.min_version': 'Lowest PDF version',
  'panel.preflight.param.required': 'Required',
  'panel.preflight.param.allowed_identifiers': 'Allowed printing conditions',
  'panel.preflight.param.require_embedded_profile': 'Embedded profile required',
  'panel.preflight.param.expected': 'Expected claim',
  'panel.preflight.param.require_declared': 'Declaration required',
  'panel.preflight.param.accept': 'Accepted values',
  'panel.preflight.param.allow': 'Allowed',
  'panel.preflight.param.tolerance_pt': 'Tolerance',
  'panel.preflight.param.width_pt': 'Width',
  'panel.preflight.param.height_pt': 'Height',
  'panel.preflight.param.allow_landscape': 'Landscape allowed',
  'panel.preflight.param.min_bleed_pt': 'Minimum bleed',
  'panel.preflight.param.min_pages': 'Fewest pages',
  'panel.preflight.param.max_pages': 'Most pages',
  'panel.preflight.param.multiple_of': 'Multiple of',
  'panel.preflight.param.forbidden_families': 'Forbidden colour families',
  'panel.preflight.param.require_grayscale': 'Grayscale required',
  'panel.preflight.param.max_spots': 'Most spot inks',
  'panel.preflight.param.allowed_names': 'Approved ink names',
  'panel.preflight.param.allow_unlisted': 'Unlisted inks allowed',
  'panel.preflight.param.max_tac_pct': 'Ink limit',
  'panel.preflight.param.sample_dpi': 'Measurement resolution',
  'panel.preflight.param.over_area_pct': 'Area allowed over the limit',
  'panel.preflight.param.max_pages_measured': 'Pages measured',
  'panel.preflight.param.flag_any': 'Report every overprint',
  'panel.preflight.param.flag_white_text': 'Report overprinting white text',
  'panel.preflight.param.flag_white_fill': 'Report overprinting white fills',
  'panel.preflight.param.require_subset': 'Subsets required',
  'panel.preflight.param.allow_type3': 'Type 3 fonts allowed',
  'panel.preflight.param.min_size_pt': 'Smallest type',
  'panel.preflight.param.min_size_pt_reversed': 'Smallest reversed type',
  'panel.preflight.param.max_inks': 'Most inks',
  'panel.preflight.param.applies_below_pt': 'Applies below',
  'panel.preflight.param.min_dpi': 'Lowest resolution',
  'panel.preflight.param.max_dpi': 'Highest resolution',
  'panel.preflight.param.forbidden_filters': 'Forbidden compression',
  'panel.preflight.param.threshold_pt': 'Hairline threshold',
  'panel.preflight.param.include_annotations': 'Include annotation borders',
  'panel.preflight.param.allow_optional_content': 'Optional content allowed',
  'panel.preflight.param.require_steps_declared': 'Processing steps required',
  'panel.preflight.param.forbid_printing': 'Processing steps must be off the print',
  'panel.preflight.param.allow_custom': 'Vendor-defined steps allowed',
  'panel.preflight.param.forbidden_subtypes': 'Forbidden annotation types',
  'panel.preflight.param.printing_only': 'Printing annotations only',
  'panel.preflight.param.allow_forms': 'Forms allowed',
  'panel.preflight.param.require_title': 'Title required',
  'panel.preflight.param.allow_js': 'JavaScript allowed',
  'panel.preflight.param.require_xmp': 'XMP required',

  'panel.preflight.fixup.remove_javascript': 'Remove JavaScript',
  'panel.preflight.fixup.remove_attachments': 'Remove embedded files',
  'panel.preflight.fixup.remove_annotations': 'Remove annotations',
  'panel.preflight.fixup.embed_missing_fonts': 'Embed missing fonts',
  'panel.preflight.fixup.convert_to_cmyk': 'Convert to CMYK',
  'panel.preflight.fixup.convert_to_grayscale': 'Convert to grayscale',
  'panel.preflight.fixup.spots_to_process': 'Convert spot inks to process',
  'panel.preflight.fixup.alias_spot': 'Alias a spot ink',
  'panel.preflight.fixup.downsample_images': 'Downsample images',
  'panel.preflight.fixup.fix_hairlines': 'Thicken hairlines',
  'panel.preflight.fixup.flatten_transparency': 'Flatten transparency',
  'panel.preflight.fixup.set_trim_box': 'Set the trim box',
  'panel.preflight.fixup.grow_bleed_box': 'Grow the bleed box',
  'panel.preflight.fixup.set_document_title': 'Set the document title',
  'panel.preflight.fixup.set_trapped': 'Declare the trapping state',
  'panel.preflight.fixup.write_xmp': 'Write XMP metadata',
  'panel.preflight.fixup.set_pdf_version': 'Set the PDF version',
  'panel.preflight.fixup.convert_to_pdfx': 'Convert to PDF/X',
  'panel.preflight.fixup.convert_to_pdfa': 'Convert to PDF/A',
  'panel.preflight.fixup.add_printer_marks': 'Add printer marks',

  'panel.preflight.profileLabel': 'Profile',
  'panel.preflight.editProfile': 'Edit…',
  'panel.preflight.closeEditor': 'Back to the report',
  'panel.preflight.editorHeading': 'Editing {{name}}',
  'panel.preflight.derivedFrom': 'Derived from {{name}}',
  'panel.preflight.shippedReadOnly':
    'This profile ships with the app. Saving an edit creates a copy, so the shipped rule is always available to return to.',
  'panel.preflight.profileNameLabel': 'Name',
  'panel.preflight.saveProfile': 'Save as a copy',
  'panel.preflight.saveEdits': 'Save',
  'panel.preflight.duplicateProfile': 'Duplicate',
  'panel.preflight.deleteProfile': 'Delete',
  'panel.preflight.importProfile': 'Import…',
  'panel.preflight.exportProfile': 'Export…',
  'panel.preflight.copySuffix': '{{name}} (copy)',
  'panel.preflight.profileSaved': 'Saved the profile “{{name}}”.',
  'panel.preflight.profileRemoved': 'Removed the profile “{{name}}”.',
  'panel.preflight.profileImported': 'Imported the profile “{{name}}”.',
  'panel.preflight.profileExported': 'Wrote the profile to {{path}}.',
  'panel.preflight.enabledLabel': 'Run this check',
  'panel.preflight.severityLabel': 'When it finds something',
  'panel.preflight.severity.fail': 'Fail',
  'panel.preflight.severity.warn': 'Warn',
  'panel.preflight.fixupsHeading': 'Fixes this profile carries',
  'panel.preflight.import.notJson': 'That file is not JSON.',
  'panel.preflight.import.notProfile': 'That file does not hold a preflight profile.',
  'panel.preflight.import.wrongKind': 'That file holds a {{kind}}, not a preflight profile.',
  'panel.preflight.import.noId': 'That profile has no id, so nothing can refer to it.',
  'panel.preflight.import.wrongSchema':
    'That profile is written to schema {{schema}}; this app reads schema {{expected}}.',
  'panel.preflight.import.shippedId':
    '“{{id}}” is a profile this app ships and cannot be replaced. Rename it before importing.',

  'profile.preflight.sheetfed_offset': 'Sheetfed offset (CMYK)',
  'profile.preflight.sheetfed_offset.desc':
    'Commercial sheetfed work on coated stock: 300 % ink, 300 dpi photographs, CMYK only.',
  'profile.preflight.web_offset_heatset': 'Web offset, heatset',
  'profile.preflight.web_offset_heatset.desc':
    'Heatset web work: the same ink limit at the lower resolutions a web press holds.',
  'profile.preflight.newsprint': 'Newsprint',
  'profile.preflight.newsprint.desc':
    'Absorbent stock and heavy dot gain: 240 % ink, one spot, thicker hairlines.',
  'profile.preflight.digital_printing': 'Digital printing',
  'profile.preflight.digital_printing.desc':
    'Toner and inkjet: 280 % ink, no spot plates, and live transparency is fine.',
  'profile.preflight.large_format': 'Large format',
  'profile.preflight.large_format.desc':
    'Banners and signage read at a distance: 100 dpi photographs and a half-inch bleed.',
  'profile.preflight.pdfx_1a': 'PDF/X-1a:2001',
  'profile.preflight.pdfx_1a.desc':
    'Device colour only, no transparency, an embedded output intent, PDF 1.3.',
  'profile.preflight.pdfx_3': 'PDF/X-3:2002',
  'profile.preflight.pdfx_3.desc':
    'PDF/X-1a with device-independent colour permitted. Still PDF 1.3, still flattened.',
  'profile.preflight.pdfx_4': 'PDF/X-4',
  'profile.preflight.pdfx_4.desc':
    'Live transparency and optional content permitted, at PDF 1.6.',
  'profile.preflight.office_print': 'Office print',
  'profile.preflight.office_print.desc':
    'Will this print on the machine down the hall: fonts and readable resolution, nothing about plates.',

  'panel.outputPreview.open': 'Open a PDF to preview its separations',
  'panel.outputPreview.blurb':
    'Rasters the pages you are reading through the separation device instead of the screen renderer, so overprint and individual plates are visible. The document is not changed.',
  'panel.outputPreview.arm': 'Show separations',
  'panel.outputPreview.disarm': 'Show the page',
  'panel.outputPreview.overprint': 'Simulate overprint',
  'panel.outputPreview.processingSteps': 'Show processing steps',
  'panel.outputPreview.processingStepInks':
    'Left off the plates as processing steps: {{names}}',
  'panel.outputPreview.alarm': 'Highlight ink over',
  'panel.outputPreview.limitAria': 'Total ink limit, percent',
  'panel.outputPreview.maxTac': 'Heaviest pixel: {{pct}}% total ink',
  'panel.outputPreview.overLimit': '{{pct}}% of the page is over {{limit}}%',
  'panel.outputPreview.withinLimit': 'Nothing on the page is over {{limit}}%',
  'panel.outputPreview.inks': 'Inks',
  'panel.outputPreview.spots': 'Spot colours',
  'panel.outputPreview.showAll': 'All',
  'panel.outputPreview.hideAll': 'None',
  'panel.outputPreview.noPlates': 'No separations yet — turn the preview on to raster this page.',
  'panel.outputPreview.density': 'Density',
  'panel.outputPreview.coverageValue': '{{pct}}%',
  'panel.outputPreview.coverageNote':
    'Coverage is the share of the page each process ink covers, averaged over the whole page. The limit above measures the heaviest single pixel instead.',
  'panel.outputPreview.specialInks': 'Not separate plates: {{names}}',
  'panel.outputPreview.merged': 'with {{names}}',
  'panel.outputPreview.unknownNote':
    'Part of this document could not be read, so this page may use inks that are not listed below: {{reasons}}',
  'panel.outputPreview.platesCaveat': 'This may not be every ink on the page.',
  'panel.outputPreview.figuresCaveat':
    'These figures cover only the plates listed below, so the real totals may be higher.',
  'panel.outputPreview.simulation': 'Simulation profile',
  'panel.outputPreview.simulationNone': 'No press — show the inks',
  'panel.outputPreview.simulationDocument': 'This document’s output intent',
  'panel.outputPreview.simulationBundled': 'An installed press profile',
  'panel.outputPreview.simulationPressAria': 'Press profile',
  'panel.outputPreview.simulationPressDefault': 'Default press ({{name}})',
  'panel.outputPreview.simulationFile': 'Choose a profile file…',
  'panel.outputPreview.simulationUsing': 'Proofing through {{name}}',
  'panel.outputPreview.simulationAssumed':
    'Spot colours that are not described in CMYK are proofed through an assumed source space: {{spaces}}',
  'panel.outputPreview.paperWhite': 'Simulate paper white',
  'panel.outputPreview.blackInk': 'Simulate black ink',
  'panel.outputPreview.blackInkForced':
    'Simulating paper white already holds the black ink at its own value.',
  'panel.outputPreview.simulationCaveat':
    'An ink that could not be read is missing from this proof, so it shows the page short one colour.',
  'panel.outputPreview.simulationOff': 'Not proofed: {{reason}}',
  'panel.outputPreview.inspect': 'Point inspector',
  'panel.outputPreview.inspectHint':
    'Click the page to read what is painted at that point, in what colour space, and at what resolution.',
  'panel.outputPreview.inspectBusy': 'Reading that point…',
  'panel.outputPreview.inspectNothing': 'Nothing is painted at that point.',
  'panel.outputPreview.inspectFailed': 'That point could not be read: {{reason}}',
  'panel.outputPreview.inspectSpace': 'Colour space: {{space}}',
  'panel.outputPreview.inspectResource': 'Named in the document as {{name}}',
  'panel.outputPreview.inspectComponents': 'Values: {{values}}',
  'panel.outputPreview.inspectColorant': 'Colorant: {{names}}',
  'panel.outputPreview.inspectAlternate': 'Alternate space: {{space}}',
  'panel.outputPreview.inspectBase': 'Base space: {{space}}',
  'panel.outputPreview.inspectComponentCount': 'Components: {{count}}',
  'panel.outputPreview.inspectPatternType':
    'Pattern type {{type}} — a pattern paints no single colour.',
  'panel.outputPreview.inspectDepth': 'Bit depth: {{bpc}}',
  'panel.outputPreview.inspectResolution': 'Effective resolution: {{dpi}} dpi',
  'panel.outputPreview.inspectResolutionAxes':
    '{{x}} dpi across, {{y}} dpi down, {{width}} by {{height}} pixels',
  'panel.outputPreview.inspectResolutionNone': 'Not a raster, so it has no resolution.',
  'panel.outputPreview.inspectResolutionUnmeasured':
    'This placement’s resolution could not be measured.',
  'panel.outputPreview.inspectUnder': 'Under it',
  'panel.outputPreview.inspectAmbiguous':
    'More than one object inside this form covers the point, so the order below is the drawing order rather than a measurement.',
  'panel.outputPreview.inspectInsideForm': 'Inside form {{name}}',
  'panel.outputPreview.inspectUnknownObject':
    'Something is painted here that could not be identified.',
  'panel.outputPreview.inspectUnknownPage':
    'Part of this page could not be read, so an object here may be missing from the list: {{reasons}}',
  'panel.outputPreview.inspectInk': 'Ink at this pixel',
  'panel.outputPreview.inspectInkValue': '{{name}} {{pct}}%',
  'panel.outputPreview.inspectInkTotal': 'Total ink: {{pct}}%',
  'panel.outputPreview.inspectInkNote':
    'Every plate on this page is counted, including any switched off above.',
  'panel.outputPreview.inspectInkCaveat':
    'An ink that could not be read is on no plate, so this total is a floor.',
  'panel.outputPreview.inspectKindFill': 'Filled path',
  'panel.outputPreview.inspectKindStroke': 'Stroked path',
  'panel.outputPreview.inspectKindFillstroke': 'Filled and stroked path',
  'panel.outputPreview.inspectKindText': 'Text',
  'panel.outputPreview.inspectKindImage': 'Image',
  'panel.outputPreview.inspectKindVector': 'Vector drawing',
  'panel.outputPreview.inspectKindShading': 'Shading',
  'panel.outputPreview.inspectKindForm': 'Form',

  'panel.inkManager.open': 'Open a PDF to manage its inks',
  'panel.inkManager.blurb':
    'Two spellings of one spot colour print on two plates. Show one ink as another to check the result, then rewrite the document to make it so — or convert a spot to process, exactly, through its own tint transform.',
  'panel.inkManager.noInks': 'This document declares no inks of its own.',
  'panel.inkManager.density': 'Density',
  'panel.inkManager.moveUp': 'Earlier in the print sequence',
  'panel.inkManager.moveDown': 'Later in the print sequence',
  'panel.inkManager.settingsNote':
    'Density and print sequence are settings of this application, not of the document: PDF has no key for either. They decide how dark an ink renders in the preview and the order the plates are listed in.',
  'panel.inkManager.shownAs': 'shown as {{name}}',
  'panel.inkManager.aliasHeading': 'Show {{name}} as',
  'panel.inkManager.aliasTargetAria': 'Ink to show this one as',
  'panel.inkManager.aliasNone': 'itself',
  'panel.inkManager.aliasNote':
    'Showing one ink as another changes the preview only. Applying rewrites the colorant name in the document, so the two land on one plate for real.',
  'panel.inkManager.compare': 'Compare',
  'panel.inkManager.applyAlias': 'Apply to the document',
  'panel.inkManager.applyAnyway': 'Apply anyway',
  'panel.inkManager.applying': 'Applying the alias…',
  'panel.inkManager.aliasApplied': '{{source}} now prints on {{target}}.',
  'panel.inkManager.sameColour': '{{source}} and {{target}} describe the same colour.',
  'panel.inkManager.differentColour':
    '{{source}} and {{target}} first differ at {{tint}}% tint.',
  'panel.inkManager.convertHeading': 'Convert to process',
  'panel.inkManager.convertNote':
    'Replaces the spot with its alternate colour space everywhere it is painted — fills, strokes, images, shadings and patterns — through its own tint transform. Total ink rises where one plate becomes several.',
  'panel.inkManager.convert': 'Convert {{name}} to process',
  'panel.inkManager.converting': 'Converting…',
  'panel.inkManager.converted': '{{name}} is now process colour.{{skipped}}',
  'panel.inkManager.convertedSkipped_one':
    ' — {{count}} gradient still prints it: the conversion cannot describe its colour.',
  'panel.inkManager.convertedSkipped_other':
    ' — {{count}} gradients still print it: the conversion cannot describe their colour.',

  'panel.printerMarks.open': 'Open a PDF to add printer marks',
  'panel.printerMarks.blurb':
    'Marks are drawn outside the trim, so the page grows to hold them and the crop box grows with it. The trim, bleed and art boxes never move — they still describe the same paper. Removing the marks puts the boxes back exactly.',
  'panel.printerMarks.crop': 'Crop marks',
  'panel.printerMarks.registration': 'Registration targets',
  'panel.printerMarks.colorbars': 'Colour bars',
  'panel.printerMarks.pageinfo': 'Page information',
  'panel.printerMarks.style': 'Style',
  'panel.printerMarks.styleWestern': 'Western',
  'panel.printerMarks.styleJapanese': 'Japanese',
  'panel.printerMarks.weight': 'Weight',
  'panel.printerMarks.points': '{{value}} pt',
  'panel.printerMarks.offset': 'Offset (pt)',
  'panel.printerMarks.length': 'Length (pt)',
  'panel.printerMarks.growthNote': 'Every edge gains {{growth}} pt.',
  'panel.printerMarks.sourceTrim': 'Marks are placed against the trim box.',
  'panel.printerMarks.sourceCrop': 'No trim box: marks are placed against the crop box.',
  'panel.printerMarks.sourceMedia': 'No trim box: marks are placed against the media box.',
  'panel.printerMarks.sourceDefault': 'This page declares no boxes; a letter page is assumed.',
  'panel.printerMarks.noTrimBox': '{{pages}} page(s) declare no trim box.',
  'panel.printerMarks.tooLarge':
    'This growth would push a page past PDF’s 14400 pt limit. Reduce the offset or the length.',
  'panel.printerMarks.present': '{{pages}} page(s) already carry printer marks.',
  'panel.printerMarks.add': 'Add marks',
  'panel.printerMarks.remove': 'Remove marks',
  'panel.printerMarks.adding': 'Adding printer marks…',
  'panel.printerMarks.added': 'Printer marks added; every edge gained {{growth}} pt.',
  'panel.printerMarks.removing': 'Removing printer marks…',
  'panel.printerMarks.removed': 'Printer marks removed and the page boxes restored.',

  'panel.hairlines.open': 'Open a PDF to find its hairline strokes',
  'panel.hairlines.blurb':
    'A hairline renders fine on screen and breaks up on press. What counts is the width the device draws — the stroke’s own width through the transform above it — so a wide stroke under a small scale is a hairline too. A zero-width stroke always is.',
  'panel.hairlines.threshold': 'Hairline below (pt)',
  'panel.hairlines.replacement': 'Raise to (pt)',
  'panel.hairlines.annotations': 'Include annotation borders',
  'panel.hairlines.thresholdProblem': 'The threshold must be greater than zero.',
  'panel.hairlines.replacementProblem':
    'A replacement below the threshold would leave the strokes it corrected as hairlines.',
  'panel.hairlines.count':
    '{{count}} hairline(s): {{strokes}} stroke(s), {{annotations}} annotation border(s).',
  'panel.hairlines.widthRow': '{{count}} at {{width}} pt',
  'panel.hairlines.unreadable': 'Page(s) {{pages}} could not be read.',
  'panel.hairlines.measure': 'Measure again',
  'panel.hairlines.fix': 'Raise the hairlines',
  'panel.hairlines.fixing': 'Raising hairline strokes…',
  'panel.hairlines.fixed': 'Every hairline now draws at {{width}} pt on the device.',

  'panel.spelling.open': 'Open a PDF to check its spelling',
  'panel.spelling.blurb':
    'Checks the words on the pages, in the comments and in the form fields against the dictionary of the language the document is written in. A correction is made the way you would make it by hand, so it keeps the styling of the word it replaces and it can be undone.',
  'panel.spelling.languageLabel': 'Dictionary',
  'panel.spelling.languageAuto': 'From the document',
  'panel.spelling.addDictionary': 'Add a dictionary…',
  'panel.spelling.pairNeeded': 'Choose both halves of the dictionary — the .aff file and the .dic file.',
  'panel.spelling.dictionaryAdded': '{{name}} added.',
  'panel.spelling.source.text': 'The text on the pages',
  'panel.spelling.source.comments': 'Comments',
  'panel.spelling.source.fields': 'Form fields',
  'panel.spelling.ignoreUppercase': 'Skip words in capitals',
  'panel.spelling.ignoreWithDigits': 'Skip words containing numbers',
  'panel.spelling.check': 'Check spelling',
  'panel.spelling.checking': 'Checking…',
  'panel.spelling.clean': 'No misspellings found.',
  'panel.spelling.found_one': '{{count}} misspelling',
  'panel.spelling.found_other': '{{count}} misspellings',
  'panel.spelling.scanned': '{{words}} words read against the {{language}} dictionary.',
  'panel.spelling.skipped': 'Paragraphs left unchecked because they cannot be edited: {{count}}',
  'panel.spelling.truncated': 'Only the first results are listed. Fix these and check again.',
  'panel.spelling.noSuggestions': 'No suggestion for this word.',
  'panel.spelling.replaceWith': 'Replace with',
  'panel.spelling.change': 'Change',
  'panel.spelling.changeAll': 'Change all ({{count}})',
  'panel.spelling.ignore': 'Ignore',
  'panel.spelling.addWord': 'Add to dictionary',
  'panel.spelling.changing': 'Changing…',
  'panel.spelling.changed_one': '{{count}} occurrence changed.',
  'panel.spelling.changed_other': '{{count}} occurrences changed.',
  'panel.spelling.changedPartly': '{{done}} changed, {{failed}} left alone: {{reason}}',
  'panel.spelling.reasonGone': 'that text is no longer in the document',
  'panel.spelling.reasonMoved': 'the text changed since the check ran',
  'panel.spelling.reasonDeclined': 'the change was not confirmed',
  'panel.spelling.customWords': 'Words in your dictionary: {{count}}',
  'panel.spelling.removeWord': 'Remove {{word}} from your dictionary',

  'panel.scanEnhance.open': 'Open a PDF to enhance its scanned pages',
  'panel.scanEnhance.blurb':
    'A scan carries the defects of the machine that made it. Each correction is measured on the page first and reported here before anything is rewritten. Only pages that are scans are touched; a page drawn from text is left exactly as it is.',
  'panel.scanEnhance.scopeLabel': 'Apply to',
  'panel.scanEnhance.scopeDocument': 'The whole document',
  'panel.scanEnhance.scopePage': 'This page only',
  'panel.scanEnhance.deskew': 'Straighten (deskew)',
  'panel.scanEnhance.despeckle': 'Remove specks',
  'panel.scanEnhance.background': 'Whiten the background',
  'panel.scanEnhance.orientation': 'Detect the orientation',
  'panel.scanEnhance.strength': 'Whitening strength',
  'panel.scanEnhance.speckSize': 'Largest speck (in)',
  'panel.scanEnhance.maxSkew': 'Search up to (°)',
  // The orientation detector's own score, which is dimensionless — so the
  // noun completes the sentence where the numeric siblings above carry a
  // parenthesised unit instead.
  'panel.scanEnhance.confidence': 'Turn the page when confidence is at least',
  'panel.scanEnhance.quality': 'Re-encode quality',
  'panel.scanEnhance.nothingProblem': 'Choose at least one correction.',
  'panel.scanEnhance.maxSkewProblem': 'The skew search must be between 0.1° and 45°.',
  'panel.scanEnhance.minSkewProblem': 'The smallest skew cannot exceed the search range.',
  'panel.scanEnhance.speckSizeProblem': 'The largest speck must be between 0.001 and 0.05 inches.',
  'panel.scanEnhance.strengthProblem': 'The whitening strength must be between 0 and 1.',
  'panel.scanEnhance.qualityProblem': 'The re-encode quality must be between 1 and 100.',
  'panel.scanEnhance.scanCount_one': '{{count}} scanned page in scope.',
  'panel.scanEnhance.scanCount_other': '{{count}} scanned pages in scope.',
  'panel.scanEnhance.noScans': 'No page in scope is a scanned image.',
  'panel.scanEnhance.changing_one': '{{count}} page would change.',
  'panel.scanEnhance.changing_other': '{{count}} pages would change.',
  'panel.scanEnhance.deskewRow_one': 'Straighten {{count}} page; it leans {{angle}}°.',
  'panel.scanEnhance.deskewRow_other': 'Straighten {{count}} pages; the worst leans {{angle}}°.',
  // Counts the SPECKS; the page phrase arrives already counted and inflected
  // from `panel.common.pageCount`, so a language whose page noun is governed
  // by this verb is not asked to agree with a number it cannot see.
  'panel.scanEnhance.despeckleRow_one': 'Remove {{count}} speck from {{pages}}.',
  'panel.scanEnhance.despeckleRow_other': 'Remove {{count}} specks from {{pages}}.',
  'panel.scanEnhance.whitenRow_one': 'Whiten {{count}} page.',
  'panel.scanEnhance.whitenRow_other': 'Whiten {{count}} pages.',
  'panel.scanEnhance.rotateRow_one': 'Turn {{count}} page upright.',
  'panel.scanEnhance.rotateRow_other': 'Turn {{count}} pages upright.',
  // `count` selects the form from the length of the page list; the list
  // itself interpolates as {{pages}} and the number is never drawn.
  'panel.scanEnhance.uncertain_one':
    'Page {{pages}} looks turned, but not confidently enough to act on.',
  'panel.scanEnhance.uncertain_other':
    'Pages {{pages}} look turned, but not confidently enough to act on.',
  'panel.scanEnhance.refused_one': 'Page {{pages}} is not a scanned image.',
  'panel.scanEnhance.refused_other': 'Pages {{pages}} are not scanned images.',
  'panel.scanEnhance.measure': 'Measure again',
  'panel.scanEnhance.measuring': 'Measuring the pages…',
  'panel.scanEnhance.apply': 'Enhance the scans',
  'panel.scanEnhance.applying': 'Enhancing the scanned pages…',
  'panel.scanEnhance.applied_one': 'Enhanced {{count}} page.',
  'panel.scanEnhance.applied_other': 'Enhanced {{count}} pages.',
  'panel.scanEnhance.nothingToDo': 'Every scanned page is already square, clean and upright.',

  'panel.flattener.open': 'Open a PDF to preview its transparency flattening',
  'panel.flattener.blurb':
    'Transparency is flattened one region at a time: only the areas where objects composite are rasterized, and everything else — live text, vectors — is left exactly as it is. Region edges land on whole device pixels, so the rasterized area and the live content beside it meet without a seam.',
  'panel.flattener.preview': 'Show what would be rasterized, on the page',
  'panel.flattener.balance': 'Raster / vector balance',
  'panel.flattener.balanceVector': 'More live content',
  'panel.flattener.balanceRaster': 'Fewer regions',
  'panel.flattener.balanceValue': '{{percent}}%',
  'panel.flattener.resolution': 'Rasterize regions at',
  'panel.flattener.dpiOption': '{{dpi}} dpi',
  'panel.flattener.regions': '{{regions}} region(s) would be rasterized.',
  'panel.flattener.categoryTransparent': 'Transparent objects: {{count}}',
  'panel.flattener.categoryAffected': 'Objects under transparency: {{count}}',
  'panel.flattener.categoryRasterized': 'Objects inside a region: {{count}}',
  'panel.flattener.categoryStrokes': 'Strokes inside a region: {{count}}',
  'panel.flattener.categoryText': 'Text inside a region: {{count}}',
  'panel.flattener.categoryPatterns': 'Patterns inside a region: {{count}}',
  'panel.flattener.categoryUnknown': 'Objects that could not be analysed: {{count}}',
  'panel.flattener.outlineText': 'Convert all text to outlines',
  'panel.flattener.outlineTextNote':
    'Converted text can no longer be selected, searched or extracted.',
  'panel.flattener.outlineStrokes': 'Convert all strokes to outlines',
  'panel.flattener.outlineReport':
    'Would convert {{runs}} text run(s) and {{strokes}} stroked path(s).',
  'panel.flattener.outlineInvisible':
    '{{runs}} of those run(s) draw nothing and are simply removed, including any text layer left by recognition.',
  'panel.flattener.outlineSubstituted':
    'Text whose font this document does not embed takes its outlines from: {{faces}}',
  'panel.flattener.outlineRefusals': 'Cannot convert: {{reasons}}',
  'panel.flattener.unreadable': 'Page(s) {{pages}} could not be read.',
  'panel.flattener.unknownNote':
    'This document cannot be flattened: {{reasons}}',
  'panel.flattener.none': 'This document has no live transparency.',
  'panel.flattener.scope':
    'A larger balance merges regions, which removes seams and rasterizes more of the page; a smaller one keeps more text and vectors live and produces more regions.',
  'panel.flattener.apply': 'Flatten transparency',
  'panel.flattener.flattening': 'Flattening transparency…',
  'panel.flattener.flattened': 'Transparency flattened; {{regions}} region(s) rasterized.',

  'panel.trapPresets.open': 'Open a PDF to author its trapping presets',
  'panel.trapPresets.blurb':
    'Trapping presets are authored over the standard in-RIP trapping parameters and assigned to page ranges. Exporting to PostScript writes each range’s parameters into that page’s own setup, which is where a RIP that traps reads them.',
  'panel.trapPresets.scope':
    'The parameters are written for a device to act on; no trap network is added to the document here, so the document is never claimed to be trapped on this account.',
  'panel.trapPresets.name': 'Preset name',
  'panel.trapPresets.pages': 'Pages',
  'panel.trapPresets.pagesTo': 'to',
  'panel.trapPresets.range.empty': 'Give the preset a page range.',
  'panel.trapPresets.range.notANumber': 'A page range is two whole page numbers.',
  'panel.trapPresets.range.inverted': 'The last page comes before the first.',
  'panel.trapPresets.range.outside': 'That range is not in this document.',
  'panel.trapPresets.range.overlap': 'Another preset already covers part of that range.',
  'panel.trapPresets.add': 'Assign to these pages',
  'panel.trapPresets.remove': 'Remove',
  'panel.trapPresets.empty': 'No preset is assigned to any page yet.',
  'panel.trapPresets.row': '{{name}} — pages {{first}} to {{last}}',
  'panel.trapPresets.uncovered': 'Page(s) {{pages}} have no preset assigned.',
  'panel.trapPresets.unusedInks':
    'This document does not use {{inks}}; those overrides will have no effect here.',
  'panel.trapPresets.trapped': 'Declare the document as trapped',
  'panel.trapPresets.trappedNote':
    '“Unknown” is what a document gets until someone states otherwise. Choose “True” only if a trap network was added elsewhere — assigning a preset does not add one.',
  'panel.trapPresets.apply': 'Save the assignments',
  'panel.trapPresets.assigning': 'Saving the trapping assignments…',
  'panel.trapPresets.assigned':
    '{{count}} assignment(s) saved; the document declares Trapped {{trapped}}.',
  'panel.trapPresets.export': 'Export PostScript',
  'panel.trapPresets.exporting': 'Writing PostScript…',
  'panel.trapPresets.exported': 'PostScript written; {{pages}} page(s) carry trapping setup.',

  'panel.prepress.open': 'Open a PDF to prepare for print',
  'panel.prepress.blurb':
    "Converts the document's colours to DeviceCMYK for commercial printing, through a colour-managed (ICC) transform. Writes a new file.",
  'panel.prepress.renderIntent': 'Render intent',
  'panel.prepress.intentRelative': 'Relative colorimetric (print default)',
  'panel.prepress.intentPerceptual': 'Perceptual (photographic)',
  'panel.prepress.intentAbsolute': 'Absolute colorimetric (proofing)',
  'panel.prepress.intentSaturation': 'Saturation (business graphics)',
  'panel.prepress.destination': 'Destination',
  'panel.prepress.destinationAria': 'Destination profile',
  'panel.prepress.profileDefault': 'Default press profile',
  'panel.prepress.profileDefaultNamed': 'Default press profile ({{name}})',
  'panel.prepress.profileInstalled': 'An installed press profile',
  'panel.prepress.profileInstalledAria': 'Press profile',
  'panel.prepress.profileFile': 'Choose an .icc file…',
  'panel.prepress.profilesUnavailable':
    'The installed press profiles could not be read, so only the default press and a profile file of your own are offered.',
  'panel.prepress.converting': 'Converting…',
  'panel.prepress.convertCmyk': 'Convert to CMYK',
  'panel.prepress.convertingCmyk': 'Converting to CMYK…',
  'panel.prepress.cmykDone': 'Saved CMYK PDF — {{from}} KB → {{to}} KB',
  'panel.prepress.pdfxBlurb':
    'Or produce a PDF/X print master — the CMYK conversion plus a conformance marker and an output intent naming the printing condition (embedding the chosen destination profile when one is set above).',
  'panel.prepress.standard': 'Standard',
  'panel.prepress.x3': 'PDF/X-3 (colour-managed, default)',
  'panel.prepress.x1a': 'PDF/X-1a (legacy CMYK exchange)',
  'panel.prepress.x4': 'PDF/X-4 (keeps live transparency)',
  'panel.prepress.condition': 'Condition',
  'panel.prepress.identifier': 'Identifier',
  'panel.prepress.identifierPlaceholder':
    'Registered characterization, e.g. CGATS TR001 or FOGRA39',
  'panel.prepress.creatingPdfx': 'Creating PDF/X master…',
  'panel.prepress.working': 'Working…',
  'panel.prepress.createPdfx': 'Create PDF/X',
  'panel.prepress.pdfxDone': 'Saved. The file declares {{version}}{{suffix}}',
  'panel.prepress.pdfxNote':
    'This writes the conformance marker and the output intent. Nothing here checks the result against the standard — run the matching preflight profile to see which of its rules this app can decide.',
  'panel.prepress.pdfxEmbedded': ' with the destination profile embedded in its output intent',
  'panel.prepress.pdfxNames': ' — output intent names {{identifier}}',

  'panel.order.open': 'Open a PDF to review its reading order',
  'panel.order.untagged':
    'This document has no structure tags, so it has no reading order to edit — assistive technology falls back to raw content order.',
  'panel.order.page': 'Page',
  'panel.order.prevPage': 'Previous page',
  'panel.order.pageAria': 'Page',
  'panel.order.ofTotal': 'of {{count}}',
  'panel.order.nextPage': 'Next page',
  'panel.order.emptyPage': 'No tagged content on this page.',
  'panel.order.listAria': 'Reading order',
  'panel.order.annotation': ' [annotation]',
  'panel.order.branchHint': 'In a different branch of the tag tree — restructure it in the Tags panel',
  'panel.order.alreadyFirst': 'Already first on this page',
  'panel.order.readEarlier': 'Read this earlier',
  'panel.order.moveEarlier': 'Move earlier in the reading order',
  'panel.order.alreadyLast': 'Already last on this page',
  'panel.order.readLater': 'Read this later',
  'panel.order.moveLater': 'Move later in the reading order',
  'panel.order.updated': 'Reading order updated',

  // ── The accessibility report ──────────────────────────────────────────
  // The panel and both export emitters read the SAME keys, so a verdict can
  // never be worded one way on screen and another in the saved file.
  //
  // A check NAME and its EXPLANATION are two keys, never a concatenation: the
  // row shows the name and the detail block shows the explanation. A finding's
  // sentence is keyed by the engine's `detail_key` and interpolates the
  // measured values — nothing downstream ever matches on the rendered text.
  'panel.a11y.open': 'Open a PDF to check its accessibility',
  'panel.a11y.checking': 'Checking…',
  'panel.a11y.recheck': 'Re-check',
  'panel.a11y.export': 'Export…',
  'panel.a11y.exporting': 'Saving the report…',
  'panel.a11y.exported': 'Report saved to {{path}}',
  'panel.a11y.show': 'Show',
  'panel.a11y.hide': 'Hide',
  'panel.a11y.noCanvas': 'Open the document to show findings on its pages.',
  'panel.a11y.nothingToShow': 'Nothing in this check has a place on a page.',
  'panel.a11y.findingCount': '{{count}} of {{counted}}',
  'panel.a11y.moreFindings':
    '{{count}} more are not listed here — the exported report carries every one.',
  'panel.a11y.jumpTitle': 'Go to this item',
  'panel.a11y.findingLabel': '{{check}} — {{preview}}',
  'panel.a11y.summaryLine':
    '{{passed}} passed · {{failed}} failed · {{warnings}} to improve · {{review}} to review · {{notApplicable}} not applicable — {{applicable}} of {{total}} checks apply',
  'panel.a11y.categoryCount': '{{passed}} / {{applicable}}',
  'panel.a11y.categoryNone': 'nothing to check',
  'panel.a11y.reportTitle': 'Accessibility report',
  'panel.a11y.reportDocument': 'Document: {{name}}',
  'panel.a11y.reportRunAt': 'Checked: {{when}}',
  'panel.a11y.reportFooter':
    'This report states which of 32 checks the document passes. It is not a conformance certificate.',
  'panel.a11y.unreadableHeading': 'Pages that could not be read',
  'panel.a11y.unreadablePage': 'Page {{page}}',

  'panel.a11y.where.tag': 'Tag {{path}}',
  'panel.a11y.where.page': 'Page {{page}}',
  'panel.a11y.where.field': 'Field “{{name}}”',
  'panel.a11y.where.annotation': 'Annotation on page {{page}}',
  'panel.a11y.where.document': 'Document',

  'panel.a11y.verdict.pass': 'Passed',
  'panel.a11y.verdict.fail': 'Failed',
  'panel.a11y.verdict.warn': 'Short of the recommendation',
  'panel.a11y.verdict.needs_review': 'Needs review',
  'panel.a11y.verdict.not_applicable': 'Not applicable',

  'panel.a11y.category.document': 'Document',
  'panel.a11y.category.page_content': 'Page content',
  'panel.a11y.category.forms': 'Forms',
  'panel.a11y.category.alt_text': 'Alternate text',
  'panel.a11y.category.tables': 'Tables',
  'panel.a11y.category.lists': 'Lists',
  'panel.a11y.category.headings': 'Headings',

  'panel.a11y.check.permissions': 'Assistive technology may read the document',
  'panel.a11y.explain.permissions':
    'Encryption permissions must allow text extraction for accessibility.',
  'panel.a11y.check.image_only': 'Pages are not image-only',
  'panel.a11y.explain.image_only':
    'A scanned page with no recognized text has nothing to read aloud.',
  'panel.a11y.check.tagged': 'Document is tagged',
  'panel.a11y.explain.tagged':
    'Structure tags let assistive technology read content in a defined order.',
  'panel.a11y.check.role_map': 'Every tag resolves to a standard type',
  'panel.a11y.explain.role_map':
    'A private tag name means nothing to a reader unless the role map translates it.',
  'panel.a11y.check.suspects': 'The document does not disclaim its own tagging',
  'panel.a11y.explain.suspects':
    'The suspects flag tells readers the structure may not match the content.',
  'panel.a11y.check.untagged_graphics': 'All page graphics are tagged or declared decoration',
  'panel.a11y.explain.untagged_graphics':
    'A fill, image or shading outside every marked sequence is reached by nobody.',
  'panel.a11y.check.artifact_judgement': 'Decoration and content are told apart',
  'panel.a11y.explain.artifact_judgement':
    'Text declared decoration that continues a sentence needs a person to look.',
  'panel.a11y.check.content_grouping': 'Content is grouped as it reads',
  'panel.a11y.explain.content_grouping':
    'One paragraph split in two, or two joined into one, changes what is announced.',
  'panel.a11y.check.content_order': 'Order holds inside columns and sequences',
  'panel.a11y.explain.content_order':
    'Columns and the order within one tag are what a page-wide sort cannot see.',
  'panel.a11y.check.unicode_mapping': 'Characters map to the right text',
  'panel.a11y.explain.unicode_mapping':
    'A font whose own glyph table contradicts its character map spells words wrong.',
  'panel.a11y.check.list_numbering': 'List numbering matches the labels',
  'panel.a11y.explain.list_numbering':
    'A numbered list announced as bullets loses the count the labels show.',
  'panel.a11y.check.list_item_structure': 'List items hold a label and a body',
  'panel.a11y.explain.list_item_structure':
    'An item holding anything else has put its body where no reader looks for it.',
  'panel.a11y.check.list_semantics': 'Lists are tagged as lists',
  'panel.a11y.explain.list_semantics':
    'Labelled paragraphs, and one list tagged as two, each need a person to look.',
  'panel.a11y.check.heading_tag_mixing': 'One heading convention, not two',
  'panel.a11y.explain.heading_tag_mixing':
    'Numbered and unnumbered heading tags together give the outline two answers.',
  'panel.a11y.check.heading_semantics': 'Headings are the text that reads as headings',
  'panel.a11y.explain.heading_semantics':
    'Size is a signal and not a semantic, so each candidate needs a person to look.',
  'panel.a11y.check.structure_nesting': 'Structure types are nested where the standard allows',
  'panel.a11y.explain.structure_nesting':
    'A tag inside a parent the standard does not allow it in breaks the structure it describes.',
  'panel.a11y.check.reading_order': 'Reading order follows the page',
  'panel.a11y.explain.reading_order':
    'Tag order is what is read; where it disagrees with the layout, a person decides.',
  'panel.a11y.check.lang': 'Document language is set',
  'panel.a11y.explain.lang': 'A declared language is what picks the right pronunciation.',
  'panel.a11y.check.title': 'Document has a title, and shows it',
  'panel.a11y.explain.title':
    'The title names the document in the window bar instead of the file name.',
  'panel.a11y.check.bookmarks': 'Long document has bookmarks',
  'panel.a11y.explain.bookmarks':
    'Bookmarks are how a long document is navigated without reading it through.',
  'panel.a11y.check.contrast': 'Text has sufficient colour contrast',
  'panel.a11y.explain.contrast':
    'Text must stand out from what is painted under it, at the published ratio.',
  'panel.a11y.check.tagged_content': 'All page content is tagged',
  'panel.a11y.explain.tagged_content':
    'Text covered by no tag and not declared decoration is never read.',
  'panel.a11y.check.tagged_annotations': 'Annotations are tagged',
  'panel.a11y.explain.tagged_annotations':
    'An annotation outside the structure tree has no place in the reading order.',
  'panel.a11y.check.tab_order': 'Pages with annotations declare a tab order',
  'panel.a11y.explain.tab_order':
    'Without a structure tab order, keyboard focus follows the order of the file.',
  'panel.a11y.check.character_encoding': 'Characters map to readable text',
  'panel.a11y.explain.character_encoding':
    'A font whose bytes map to no character cannot be read aloud or searched.',
  'panel.a11y.check.tagged_multimedia': 'Multimedia is tagged',
  'panel.a11y.explain.tagged_multimedia':
    'Sound and video annotations need a place in the structure like any content.',
  'panel.a11y.check.screen_flicker': 'Nothing flashes the screen',
  'panel.a11y.explain.screen_flicker':
    'Page actions and scripts can flash the screen; each site needs a look.',
  'panel.a11y.check.scripts': 'Scripts are accessible',
  'panel.a11y.explain.scripts':
    'A script that changes the page must not leave assistive technology behind.',
  'panel.a11y.check.timed_responses': 'Nothing is on a timer',
  'panel.a11y.explain.timed_responses':
    'A response the reader has to give before a clock runs out needs a way out.',
  'panel.a11y.check.navigation_links': 'Navigation links are distinguishable',
  'panel.a11y.explain.navigation_links':
    'Links reading alike but going elsewhere cannot be told apart out of context.',
  'panel.a11y.check.tagged_form_fields': 'Form fields are tagged',
  'panel.a11y.explain.tagged_form_fields':
    'A field outside the structure tree is not reached in the reading order.',
  'panel.a11y.check.field_descriptions': 'Form fields have descriptions',
  'panel.a11y.explain.field_descriptions':
    'A field with no description is announced by its internal name, or not at all.',
  'panel.a11y.check.figures_alt': 'Figures have alternate text',
  'panel.a11y.explain.figures_alt':
    'A figure with no description conveys nothing to a reader who cannot see it.',
  'panel.a11y.check.nested_alt': 'No alternate text inside alternate text',
  'panel.a11y.explain.nested_alt': 'A description inside another description is never read.',
  'panel.a11y.check.alt_no_content': 'Alternate text is attached to content',
  'panel.a11y.explain.alt_no_content':
    'A description on an element that tags nothing describes nothing.',
  'panel.a11y.check.alt_hides_annotation': 'Alternate text does not hide an annotation',
  'panel.a11y.explain.alt_hides_annotation':
    'A description on a tag wrapping an annotation replaces the annotation’s own.',
  'panel.a11y.check.other_elements_alt': 'Links, forms and annotations are described',
  'panel.a11y.explain.other_elements_alt':
    'These elements need a description of their own or one on the object they name.',
  'panel.a11y.check.table_rows': 'Rows are inside a table',
  'panel.a11y.explain.table_rows': 'A row outside a table is not read as part of one.',
  'panel.a11y.check.table_cells': 'Cells are inside a row',
  'panel.a11y.explain.table_cells': 'A cell outside a row has no position in the table.',
  'panel.a11y.check.table_headers': 'Tables have header cells',
  'panel.a11y.explain.table_headers':
    'Header cells and their scope are what associate a value with what it means.',
  'panel.a11y.check.table_regularity': 'Table rows have the same width',
  'panel.a11y.explain.table_regularity':
    'Rows of different widths cannot be navigated cell by cell.',
  'panel.a11y.check.table_summary': 'Tables have a summary',
  'panel.a11y.explain.table_summary':
    'A summary states what a complex table shows before it is read cell by cell.',
  'panel.a11y.check.list_items': 'List items are inside a list',
  'panel.a11y.explain.list_items': 'An item outside a list is not announced as part of one.',
  'panel.a11y.check.list_labels': 'Labels and bodies are inside a list item',
  'panel.a11y.explain.list_labels': 'A label or body outside its item loses the item it belongs to.',
  'panel.a11y.check.optional_content_config':
    'Optional content configurations are named, and set no automatic state',
  'panel.a11y.explain.optional_content_config':
    'A configuration with no name, or one that adjusts itself, hides content unpredictably.',
  'panel.a11y.check.embedded_file_names': 'Attached files carry both of their names',
  'panel.a11y.explain.embedded_file_names':
    'An attachment with no file name tells nobody what it is before they open it.',
  'panel.a11y.check.trapnet_annotations': 'No trapping annotations are present',
  'panel.a11y.explain.trapnet_annotations':
    'Trap networks describe a printing press, not anything a reader can reach.',
  'panel.a11y.check.link_ismap': 'Links do not depend on a server-side image map',
  'panel.a11y.explain.link_ismap':
    'A link that sends a click coordinate cannot be used by anyone who cannot point.',
  'panel.a11y.check.media_clip_data': 'Media clips state their type and their alternate text',
  'panel.a11y.explain.media_clip_data':
    'A clip with no content type and no alternate text can only be played, never described.',
  'panel.a11y.check.reference_xobjects': 'No page imports its content from another file',
  'panel.a11y.explain.reference_xobjects':
    'Content that lives in another file is content this document cannot describe.',
  'panel.a11y.check.font_embedding': 'Every font that draws text is embedded',
  'panel.a11y.explain.font_embedding':
    'A substituted face draws different shapes at different widths than the file intends.',
  'panel.a11y.check.font_encodings': 'TrueType fonts use encodings a reader can follow',
  'panel.a11y.explain.font_encodings':
    'A font whose encoding rules are not met leaves the reader guessing which glyph is meant.',
  'panel.a11y.check.cid_to_gid_map': 'Composite fonts say which glyph each identifier selects',
  'panel.a11y.explain.cid_to_gid_map':
    'Without that mapping the same file renders differently in different readers.',
  'panel.a11y.check.print_field_attributes': 'Printed form fields are tagged as form fields',
  'panel.a11y.explain.print_field_attributes':
    'A box drawn for a pen is announced as a box unless PrintField attributes say otherwise.',
  'panel.a11y.check.dynamic_xfa': 'The document is not a dynamic XFA form',
  'panel.a11y.explain.dynamic_xfa':
    'A dynamic form builds its own pages, so the tagged content is not what is shown.',
  'panel.a11y.check.heading_nesting': 'Heading levels are not skipped',
  'panel.a11y.explain.heading_nesting':
    'Headings are how a document is skimmed; a skipped level breaks the outline.',

  'panel.a11y.fix': 'Fix',
  'panel.a11y.fixTitle': 'Repair this without leaving the report',
  'panel.a11y.fixing': 'Applying the fix…',
  'panel.a11y.fixed': 'Fix applied — re-checking the document.',
  'panel.a11y.apply': 'Apply',
  'panel.a11y.needsValue': 'Type the value this fix needs, then choose Apply.',
  'panel.a11y.langPick': 'Pick a language',

  'panel.a11y.field.alt': 'Alternate text',
  'panel.a11y.field.summary': 'Summary',
  'panel.a11y.field.description': 'Description',
  'panel.a11y.field.title': 'Title',
  'panel.a11y.field.lang': 'Language',
  'panel.a11y.field.role': 'Tag as',
  'panel.a11y.hint.alt': 'What this picture shows, in a sentence',
  'panel.a11y.hint.summary': 'What this table shows, before it is read cell by cell',
  'panel.a11y.hint.description': 'What this field is for, as a reader would hear it',
  'panel.a11y.hint.title': 'The document’s title, not its file name',
  'panel.a11y.hint.lang': 'A language tag, for example en-GB',
  'panel.a11y.hint.role': 'Content a reader should hear, or furniture it should not',
  'panel.a11y.role.P': 'Paragraph',
  'panel.a11y.role.Artifact': 'Decoration — never read aloud',
  'panel.a11y.artifactRest': 'Declare the rest decoration',
  'panel.a11y.artifactRestTitle':
    'Running heads and page numbers are furniture, not content — one step per page',

  'panel.a11y.detail.role_not_mapped':
    'The tag “{{tag}}” is not a standard structure type and the role map does not translate it, so it reaches a reader as “{{role}}” and means nothing.',
  'panel.a11y.detail.role_map_does_not_terminate':
    'The role map sends “{{tag}}” around in a circle, so it never reaches a standard structure type.',
  'panel.a11y.detail.suspects_flag_set':
    'The document flags its own tagging as possibly unreliable, which readers are entitled to act on.',
  'panel.a11y.detail.suspects_unreadable':
    'The mark information could not be read, so whether the document flags its own tagging is unknown.',
  'panel.a11y.detail.graphics_outside_marked_content':
    'Page {{page}} paints {{operations}} thing(s) outside every marked sequence, so they are neither tagged nor declared decoration.',
  'panel.a11y.detail.unicode_never_mapped':
    'In “{{font}}” on page {{page}}, code {{code}} claims to spell {{declared}}, which is not a character any glyph spells.',
  'panel.a11y.detail.unicode_contradicts_font':
    'In “{{font}}” on page {{page}}, code {{code}} claims to spell {{declared}} while the font’s own glyph table says {{program}}.',
  'panel.a11y.detail.font_program_unreadable':
    'A font program on page {{page}} could not be read, so its character mapping was not checked.',
  'panel.a11y.detail.artifact_continues_real_content':
    'This text is declared decoration but runs on from tagged content on page {{page}} — it follows “{{neighbour}}”.',
  'panel.a11y.detail.artifact_reads_as_prose':
    'This text is declared decoration but is {{words}} words of body copy on page {{page}}.',
  'panel.a11y.detail.figure_inline_in_text':
    'A {{role}} sits inside a {{parent}}, where a picture stands in the position a word occupies.',
  'panel.a11y.detail.figure_covers_the_page':
    'This {{role}} paints nothing but a field of colour over {{share}}% of the page.',
  'panel.a11y.detail.element_spans_separated_blocks':
    'This {{role}} covers {{blocks}} lines set further apart than the lines inside them.',
  'panel.a11y.detail.siblings_share_one_block':
    'This {{role}} sits on the line directly under the one before it, close enough to be part of it.',
  'panel.a11y.detail.siblings_sit_side_by_side':
    'This {{role}} sits beside the one before it rather than after it.',
  'panel.a11y.detail.figure_splits_one_unit':
    'A {{role}} sits between two {{around}} elements that may be one piece of content.',
  'panel.a11y.detail.sequence_spans_columns':
    'Sequence {{mcid}} on page {{page}} reaches across {{bands}} columns.',
  'panel.a11y.detail.sequence_draws_backwards':
    'Sequence {{mcid}} on page {{page}} draws its own words right to left {{jumps}} time(s).',
  'panel.a11y.detail.list_numbering_not_ordered':
    'The items are numbered and the list declares “{{declared}}”, so a reader announces the count as decoration.',
  'panel.a11y.detail.list_numbering_ordered':
    'The items are bulleted with {{drawn}} and the list declares “{{declared}}”, so a reader counts them aloud.',
  'panel.a11y.detail.list_numbering_wrong_bullet':
    'The items are bulleted with {{drawn}} and the list declares “{{declared}}”.',
  'panel.a11y.detail.list_item_holds_other_roles':
    'This list item holds {{roles}}, where only a label and a body belong.',
  'panel.a11y.detail.list_item_holds_content_directly':
    'This {{role}} tags page content itself instead of putting it in a body.',
  'panel.a11y.detail.list_item_has_no_body':
    'This {{role}} has no body, so the item’s content is somewhere no reader looks for it.',
  'panel.a11y.detail.list_label_inside_body':
    'This item carries no label, and its body opens with “{{label}}”.',
  'panel.a11y.detail.labelled_paragraphs_are_not_a_list':
    'These paragraphs open with list markers such as “{{label}}” and no list element tags them.',
  'panel.a11y.detail.adjacent_lists_declare_alike':
    'This list follows another declaring the same “{{numbering}}”, so the two may be one list split in half.',
  'panel.a11y.detail.heading_conventions_mixed':
    'The document uses {{numbered}} numbered heading(s) and {{generic}} unnumbered one(s), so its outline has two answers about each level.',
  'panel.a11y.detail.paragraph_is_set_like_a_heading':
    'This paragraph is set at {{size}} pt against body copy at {{body}} pt.',
  'panel.a11y.detail.heading_is_set_like_body_text':
    'This level {{level}} heading is set at {{size}} pt, no larger than body copy at {{body}} pt.',
  'panel.a11y.detail.alt_nested_inside_alt':
    'The alternate text here sits inside an element that already carries one, so it is never read.',
  'panel.a11y.detail.alt_references_no_content':
    'This element carries alternate text but tags no content at all.',
  'panel.a11y.detail.alt_replaces_annotation':
    'This alternate text replaces the annotation’s own description: “{{hidden}}”.',
  'panel.a11y.detail.annotation_not_tagged':
    'A {{subtype}} annotation on page {{page}} is outside the structure tree.',
  'panel.a11y.detail.annotations_unreadable':
    'Page {{page}} carries an annotation that could not be read, so this check did not see everything on it.',
  'panel.a11y.detail.annotations_unreadable_document':
    'The document’s annotations could not be read, so this check did not see them.',
  'panel.a11y.detail.cell_outside_row': 'This cell’s parent is {{parent}}, not a table row.',
  'panel.a11y.detail.content_not_tagged':
    'Text on page {{page}} is covered by no tag and is not declared as decoration.',
  'panel.a11y.detail.contrast_below_threshold':
    'On page {{page}}, {{ink}} on {{background}} measures {{ratio}}:1 against the required {{required}}:1.',
  'panel.a11y.detail.contrast_unknown_backdrop':
    'On page {{page}}, {{ink}} measures {{ratio}}:1 against {{background}} (the ratio required is {{required}}:1), but what is painted under it could not be resolved.',
  'panel.a11y.detail.document_language_missing': 'The document declares no language.',
  'panel.a11y.detail.element_missing_description':
    'This {{role}} element has no description of its own, and the object it names carries none either.',
  'panel.a11y.detail.field_has_no_description': 'This {{type}} field has no description.',
  'panel.a11y.detail.fields_unreadable':
    'The form field tree could not be read to its end, so this check did not see every field.',
  'panel.a11y.detail.figure_missing_alt':
    'This {{role}} has neither alternate text nor actual text.',
  'panel.a11y.detail.font_encoding_unsupported':
    'On page {{page}}, {{font}} uses an encoding this app cannot read, so its text was not checked ({{reason}}).',
  'panel.a11y.detail.font_has_no_unicode_mapping':
    'On page {{page}}, {{font}} maps to no readable characters ({{reason}}).',
  'panel.a11y.detail.form_field_not_tagged':
    'A form field on page {{page}} is outside the structure tree.',
  'panel.a11y.detail.form_field_not_in_form':
    'A form field on page {{page}} is tagged, but not inside a Form element.',
  'panel.a11y.detail.header_cell_has_no_scope':
    'This header cell declares no scope, and no cell points at it.',
  'panel.a11y.detail.heading_level_skipped':
    'The outline jumps from level {{from}} to level {{to}}.',
  'panel.a11y.detail.trapnet_annotation':
    'Page {{page}} carries a trap network annotation, which conforming files may not contain.',
  'panel.a11y.detail.link_uri_ismap':
    'The link on page {{page}} sends the click position to the server, so it works only for someone who can point at a pixel. Check whether the same destinations are reachable another way.',
  'panel.a11y.detail.media_clip_no_content_type':
    'A media clip does not say what type of media it is.',
  'panel.a11y.detail.media_clip_no_alt':
    'A media clip carries no alternate text, so it can only be played, never described.',
  'panel.a11y.detail.media_clip_unreadable':
    'A media clip could not be read, so whether it states its type and alternate text is unknown.',
  'panel.a11y.detail.reference_xobject':
    'A page imports its content from another file, which no structure tree in this one can describe.',
  'panel.a11y.detail.xobjects_unreadable':
    'The page objects could not be read, so whether any imports content from another file is unknown.',
  'panel.a11y.detail.font_not_embedded':
    'The font “{{font}}” draws text but its program is not embedded, so another face will be substituted.',
  'panel.a11y.detail.fonts_unreadable':
    'The fonts could not be read, so which of them draw text was not established.',
  'panel.a11y.detail.font_program_cmap_unreadable':
    'The embedded program of “{{font}}” could not be read, so its character map was not checked.',
  'panel.a11y.detail.symbolic_truetype_has_encoding':
    'The symbolic font “{{font}}” carries an encoding entry, which a symbolic TrueType font may not have.',
  'panel.a11y.detail.symbolic_truetype_cmap_ambiguous':
    'The program of “{{font}}” holds several character maps and none of them is the Microsoft Symbol one, so which glyph a code selects is undefined.',
  'panel.a11y.detail.nonsymbolic_truetype_bad_encoding':
    'The font “{{font}}” names neither MacRomanEncoding nor WinAnsiEncoding, which a non-symbolic TrueType font must.',
  'panel.a11y.detail.nonsymbolic_truetype_no_cmap':
    'The program of “{{font}}” holds no non-symbolic character map, so its glyphs cannot be looked up by character.',
  'panel.a11y.detail.nonsymbolic_truetype_unlisted_glyph_name':
    'The font “{{font}}” renames a code to the glyph “{{glyph}}”, which is not in the Adobe Glyph List.',
  'panel.a11y.detail.nonsymbolic_truetype_differences_no_unicode_cmap':
    'The font “{{font}}” renames codes but its program holds no Microsoft Unicode character map to resolve them against.',
  'panel.a11y.detail.cid_font_no_cid_to_gid_map':
    'The composite font “{{font}}” is embedded but never says which glyph each identifier selects.',
  'panel.a11y.detail.oc_config_no_name':
    'An optional content configuration has no name, so nothing can present it as a choice.',
  'panel.a11y.detail.oc_config_has_as':
    'An optional content configuration adjusts its own state automatically, so what a page shows cannot be predicted.',
  'panel.a11y.detail.optional_content_unreadable':
    'The optional content settings could not be read: {{reason}}.',
  'panel.a11y.detail.embedded_file_no_f':
    'An attached file has no file name in the system encoding.',
  'panel.a11y.detail.embedded_file_no_uf':
    'An attached file has no Unicode file name.',
  'panel.a11y.detail.embedded_files_unreadable':
    'An attached file specification could not be read, so whether it carries its names is unknown.',
  'panel.a11y.detail.print_field_attributes_missing':
    'The “{{tag}}” element reaches no interactive control, so it reads as a printed form field, and it carries no PrintField attributes. Check whether it is one.',
  'panel.a11y.detail.dynamic_xfa_form':
    'The document is a dynamic XFA form, which builds its own pages, so the tagged content is not what is shown.',
  'panel.a11y.detail.xfa_packet_unreadable':
    'An XFA packet could not be read, so whether the form is dynamic is unknown.',
  'panel.a11y.detail.heading_opens_below_h1':
    'The outline opens at level {{level}} instead of level 1.',
  'panel.a11y.detail.label_outside_list_item':
    'This {{role}}’s parent is {{parent}}, not a list item.',
  'panel.a11y.detail.list_item_outside_list': 'This item’s parent is {{parent}}, not a list.',
  'panel.a11y.detail.mark_info_missing':
    'The document has a structure tree but does not declare itself tagged.',
  'panel.a11y.detail.multimedia_not_tagged':
    'A {{subtype}} annotation on page {{page}} is outside the structure tree.',
  'panel.a11y.detail.no_bookmarks': 'A document of {{pages}} pages has no bookmarks.',
  'panel.a11y.detail.no_extractable_text': 'No text could be extracted from this document.',
  'panel.a11y.detail.page_is_an_image': 'Page {{page}} is a picture with no recognized text.',
  'panel.a11y.detail.page_unreadable':
    'Page {{page}} could not be read, so this check could not decide it.',
  'panel.a11y.detail.permission_blocks_extraction':
    'The encryption permissions do not allow text extraction.',
  'panel.a11y.detail.permissions_unreadable':
    'The document’s permissions could not be read, so whether assistive technology may read it is unknown.',
  'panel.a11y.detail.reading_order_disagrees':
    'On page {{page}}, {{inversions}} of {{items}} tagged items are read in a different order than they are laid out.',
  'panel.a11y.detail.repeated_target_across_pages':
    'The same target is linked {{count}} times, on pages {{pages}}.',
  'panel.a11y.detail.row_outside_table': 'This row’s parent is {{parent}}, not a table.',
  'panel.a11y.detail.same_label_different_targets':
    'The same link text leads to {{count}} different targets: {{targets}}.',
  'panel.a11y.detail.script_site': 'A {{kind}} script named {{name}}.',
  'panel.a11y.detail.scripts_unreadable':
    'A script in this document could not be read, so this check did not see what it runs.',
  'panel.a11y.detail.structure_nesting_content_model':
    '{{parent}} on page {{page}} does not hold its child tags in the sequence the standard requires for it.',
  'panel.a11y.detail.structure_nesting_unreadable':
    'A structure element’s namespace could not be read: {{reason}}. Its nesting was not checked.',
  'panel.a11y.detail.structure_nesting_violation':
    '{{child}} is inside {{parent}} on page {{page}}, where the standard does not allow it.',
  'panel.a11y.detail.structure_tree_empty':
    'The document’s structure tree holds no elements, so nothing in it is tagged.',
  'panel.a11y.detail.structure_tree_missing': 'The document has no structure tree.',
  'panel.a11y.detail.structure_truncated':
    'The structure tree could not be walked past this element, so this check did not see everything below it.',
  'panel.a11y.detail.tab_order_missing':
    'Page {{page}} carries annotations and declares no tab order.',
  'panel.a11y.detail.tab_order_not_structure':
    'Page {{page}} declares tab order {{tabs}} rather than the structure order.',
  'panel.a11y.detail.table_has_no_header_cells':
    'This table has {{rows}} rows and {{cells}} cells, none of them a header.',
  'panel.a11y.detail.table_has_no_summary': 'This table has no summary.',
  'panel.a11y.detail.table_not_modellable':
    'This table’s rows hold no cells the column arithmetic can place, so its widths were not compared.',
  'panel.a11y.detail.table_rows_have_different_widths':
    'The rows of this table are {{widths}} cells wide.',
  'panel.a11y.detail.table_span_unreadable':
    'A cell in this table declares a column or row span that is not a positive whole number, so its widths were not compared.',
  'panel.a11y.detail.title_missing': 'The document has no title.',
  'panel.a11y.detail.title_not_displayed':
    'The document has a title but is set to show its file name instead.',

  'panel.layers.open': 'Open a PDF to manage its layers',
  'panel.layers.empty': 'This document has no layers.',
  'panel.layers.hint': 'Toggle a layer to show or hide it in the document.',
  'panel.layers.hiding': 'Hiding {{name}}…',
  'panel.layers.showing': 'Showing {{name}}…',
  'panel.layers.hidden': '{{name}} hidden',
  'panel.layers.shown': '{{name}} shown',
  'panel.layers.step': 'Processing step: {{step}}',
  'panel.layers.stepTitle':
    'This layer carries a manufacturing instruction — a die line, a crease, a varnish or a legend — not artwork a press prints.',
  'panel.layers.stepNoGroup': 'no group named',
  'panel.layers.stepTypeOnUntypedGroup': 'this group defines no types',
  'panel.layers.stepUnregistered': 'unrecognized name; confirm it against the standard',
  'panel.layers.stepCustom': 'vendor-defined',

  'panel.attach.open': 'Open a PDF to manage its attachments',
  'panel.attach.attaching': 'Attaching…',
  'panel.attach.attached': 'Attached {{name}}',
  'panel.attach.extracting': 'Extracting…',
  'panel.attach.saved': 'Saved {{name}}',
  'panel.attach.removing': 'Removing…',
  'panel.attach.removed': 'Removed {{name}}',
  'panel.attach.attachFile': 'Attach a file…',
  'panel.attach.empty': 'This document has no attachments.',
  'panel.attach.save': 'Save…',
  'panel.attach.remove': 'Remove',

  'panel.pageBoxes.open': 'Open a PDF to crop pages or edit page boxes',
  'panel.pageBoxes.blurb':
    'Drag a rectangle on the page to set the area to keep, or trim points from each edge of the chosen box below. Cropping only hides content — nothing is deleted, and the crop can never fall outside the media box.',
  'panel.pageBoxes.cropDrawn': 'Crop drawn on page {{page}} — review the margins, then Apply',
  'panel.pageBoxes.enterMargin': 'Enter a margin to trim on at least one edge',
  'panel.pageBoxes.badPages': 'Error: pages must be e.g. 1,3,5-9 or all',
  'panel.pageBoxes.applying': 'Applying…',
  'panel.pageBoxes.apply': 'Apply',
  'panel.pageBoxes.updated_one': 'Updated {{count}} page{{skipped}}',
  'panel.pageBoxes.updated_other': 'Updated {{count}} pages{{skipped}}',
  'panel.pageBoxes.skippedSuffix': ' — {{count}} skipped (box would be degenerate)',
  'panel.pageBoxes.box': 'Box',
  'panel.pageBoxes.boxAria': 'Box to edit',
  'panel.pageBoxes.crop': 'Crop box (visible page)',
  'panel.pageBoxes.bleed': 'Bleed box',
  'panel.pageBoxes.trim': 'Trim box',
  'panel.pageBoxes.art': 'Art box',
  'panel.pageBoxes.top': 'Top',
  'panel.pageBoxes.bottom': 'Bottom',
  'panel.pageBoxes.left': 'Left',
  'panel.pageBoxes.right': 'Right',
  'panel.pageBoxes.edgeInset': '{{edge}} inset',
  'panel.pageBoxes.pagesLabel': 'Pages (e.g. 1,3,5-9 or all)',
  'panel.pageBoxes.pagesAria': 'Pages to crop',
  'panel.pageBoxes.autoTitle': 'Remove white margins',
  'panel.pageBoxes.autoBlurb':
    'Measures what each page draws and sets the box around it. Nothing is deleted — resetting the box brings the margin back.',
  'panel.pageBoxes.autoMargin': 'Keep around content (pt)',
  'panel.pageBoxes.autoPreview': 'Find content',
  'panel.pageBoxes.autoApply': 'Crop to content',
  'panel.pageBoxes.autoScanning': 'Measuring each page…',
  // Labelled numbers rather than a counted sentence: five figures in one
  // line, and every language reads a label followed by a value.
  'panel.pageBoxes.autoSummary':
    'To crop: {{count}} · already tight: {{unchanged}} · skipped: {{skipped}} · from ink: {{scanned}} · largest trim: {{points}}pt',
  'panel.pageBoxes.autoFound': 'Measured — to crop: {{count}}, skipped: {{skipped}}',
  'panel.pageBoxes.autoApplied': 'Cropped to content — pages: {{count}}, skipped: {{skipped}}',

  'panel.delete.open': 'Open a PDF to delete pages',
  'panel.delete.enterPages': 'Enter page numbers.',
  'panel.delete.deleting': 'Deleting pages…',
  'panel.delete.deletingBtn': 'Deleting…',
  'panel.delete.delete': 'Delete Pages',
  'panel.delete.done': 'Deleted {{count}} pages, {{remaining}} remaining',
  'panel.delete.pagesLabel': 'Pages to delete (e.g. 2,4,6-8)',
  'panel.delete.pagesAria': 'Pages to delete',
  'panel.delete.badPages': 'Error: pages must be e.g. 2,4,6-8',

  'panel.portfolio.openAlt': 'Or open an existing portfolio to manage its files',
  'panel.portfolio.creating': 'Creating portfolio…',
  'panel.portfolio.created': 'Portfolio created',
  'panel.portfolio.converting': 'Converting…',
  'panel.portfolio.converted': 'This document is now a portfolio',
  'panel.portfolio.adding': 'Adding…',
  'panel.portfolio.opening': 'Opening…',
  'panel.portfolio.saving': 'Saving…',
  'panel.portfolio.updating': 'Updating…',
  'panel.portfolio.removing': 'Removing…',
  // The DONE lines. The slice-B sweep threaded the …ing
  // states but not these six, because each was a `${}` TEMPLATE rather than
  // a bare literal; the attribute/literal regexes never saw them. Each is
  // one interpolated key ({{name}} is an attachment's own file name and
  // stays verbatim), never "Added " + name.
  'panel.portfolio.added': 'Added {{name}}',
  'panel.portfolio.opened': 'Opened {{name}}',
  'panel.portfolio.openedExternally': 'Opened {{name}} in its own app',
  'panel.portfolio.saved': 'Saved {{name}}',
  'panel.portfolio.updated': 'Updated {{name}}',
  'panel.portfolio.removed': 'Removed {{name}}',
  'panel.portfolio.createHeading': 'Create a portfolio',
  'panel.portfolio.titlePlaceholder': 'Title (optional)',
  'panel.portfolio.pickAndCreate': 'Pick files and create…',
  'panel.portfolio.createBlurb': 'Bundles any files into one PDF portfolio with a generated cover sheet.',
  'panel.portfolio.notPortfolio': 'This document is not a portfolio.',
  'panel.portfolio.convert': 'Convert this document into a portfolio',
  'panel.portfolio.convertBlurb': 'Its attachments, if any, become the portfolio’s files.',
  'panel.portfolio.count_one': '{{count}} file in this portfolio',
  'panel.portfolio.count_other': '{{count}} files in this portfolio',
  'panel.portfolio.addFile': 'Add file…',
  'panel.portfolio.empty': 'This portfolio has no files yet.',
  'panel.portfolio.openBtn': 'Open',
  'panel.portfolio.openOsTitle': 'Open with the app your PC uses for this file type',
  'panel.portfolio.saveBtn': 'Save…',
  'panel.portfolio.updateBtn': 'Update…',
  'panel.portfolio.updateTitle': 'Replace this file’s contents from a file on disk',
  'panel.portfolio.removeBtn': 'Remove',

  'panel.sig.open': 'Open a PDF to check its signatures',
  'panel.sig.verifying': 'Verifying signatures…',
  'panel.sig.heading': 'Signatures in',
  'panel.sig.recheck': 'Re-check',
  'panel.sig.signPdf': 'Sign this PDF…',
  'panel.sig.none': 'This PDF has no digital signatures.',
  'panel.sig.found_one': '{{count}} signature found.',
  'panel.sig.found_other': '{{count}} signatures found.',
  'panel.sig.listAria': 'Signatures',
  'panel.sig.trustCaveat':
    'Signer identity is not verified against a trusted authority — these results confirm cryptographic validity and whether the document was changed after signing, not who the signer really is. Choose a trust source below: add a CA certificate you trust, or turn one of the bundled sources on.',
  'panel.sig.trustVerified_one': 'Signer identity verified against your {{count}} trust anchor.',
  'panel.sig.trustVerified_other': 'Signer identity verified against your {{count}} trust anchors.',
  'panel.sig.trustFailed': 'The signer does not chain to any of your trust sources.',
  'panel.sig.trustVerifiedSystem':
    'Signer identity verified against the system certificate store.',
  'panel.sig.trustVerifiedEutl':
    'Signer identity verified against the bundled EU trusted lists.',
  'panel.sig.trustVerifiedMsctl':
    'Signer identity verified against the bundled root-program certificates.',
  'panel.sig.trustVerifiedMixed':
    'Signer identity verified — against more than one of your trust sources.',
  'panel.sig.trustAnchors': 'Trust anchors',
  'panel.sig.systemStore': 'Also trust the system certificate store',
  'panel.sig.systemStoreHint':
    'Off by default. When on, a signer whose certificate authority this computer already trusts for document signing verifies as trusted here too.',
  'panel.sig.systemStoreUnavailable':
    'This computer exposes no certificate store to read, so only your own trust anchors apply.',
  'panel.sig.eutl': 'Also trust the bundled EU trusted lists',
  'panel.sig.eutlHint':
    'Off by default. When on, a signer whose certificate authority the EU trusted lists record as a granted qualified authority verifies as trusted here. The list is bundled with the app; nothing is downloaded.',
  'panel.sig.eutlUnavailable':
    'This installation carries no trusted-list bundle, so only your other trust sources apply.',
  'panel.sig.eutlProvenance':
    'Bundled {{date}} from {{lists}} national lists — {{anchors}} certificate authorities.',
  'panel.sig.msctl': 'Also trust the bundled root-program certificates',
  'panel.sig.msctlHint':
    'Off by default. When on, a signer whose certificate authority the bundled root-certificate program lists for document signing verifies as trusted here. Authorities the program has withdrawn are not included. This adds to the certificate-store source rather than replacing it, and nothing is downloaded.',
  'panel.sig.msctlUnavailable':
    'This installation carries no root-program bundle, so only your other trust sources apply.',
  'panel.sig.msctlProvenance':
    'Bundled {{date}} — {{anchors}} certificate authorities.',
  'panel.sig.anchorIssuanceCutoff':
    'identity not trusted — the root-certificate program lists this authority only for certificates issued before {{cutoff}}, and this signer’s was issued {{issued}}.',
  'panel.sig.anchorIssuanceCutoffTimestamp':
    'identity not trusted — the root-certificate program lists the timestamp authority only for certificates issued before {{cutoff}}, and this timestamp’s was issued {{issued}}.',
  'panel.sig.trustedViaAnchor': 'identity trusted (your anchor)',
  'panel.sig.trustedViaSystem': 'identity trusted (system store)',
  'panel.sig.trustedViaEutl': 'identity trusted (EU trusted lists)',
  'panel.sig.trustedViaMsctl': 'identity trusted (root-certificate program)',
  'panel.sig.addCa': 'Add CA certificate…',
  'panel.sig.removeAnchor': 'Remove trust anchor {{path}}',
  'panel.sig.signHeading': 'Sign this document',
  'panel.sig.signBlurb':
    'Applies an invisible signature. Sign in place signs the open document (undoable; written to disk on Save); Sign & Save a copy writes a new signed file and leaves the current one unchanged. Comments, form filling, and added pages keep signatures valid; other edits invalidate them.',
  'panel.sig.visibleTitle':
    'Place a visible signature: draw its box on the page; these signer details carry over',
  'panel.sig.visibleBtn': 'Visible signature…',
  'panel.sig.password': 'Password',
  'panel.sig.reason': 'Reason',
  'panel.sig.location': 'Location',
  'panel.sig.optional': 'optional',
  'panel.sig.pades': 'PAdES (ETSI) signature profile',
  'panel.sig.tsaUrl': 'TSA URL',
  'panel.sig.tsaPlaceholder':
    'optional — RFC 3161 timestamp server (e.g. http://timestamp.digicert.com)',
  'panel.sig.ltv':
    "Embed validation info for long-term validation (LTV — requires PAdES; fetches revocation data from the certificate's own endpoints)",
  'panel.sig.cancel': 'Cancel',
  'panel.sig.signing': 'Signing…',
  'panel.sig.signInPlace': 'Sign in place',
  'panel.sig.signSaveCopy': 'Sign & Save a copy…',
  'panel.sig.enterPassword': 'Enter the signer password.',
  'panel.sig.signedAs': 'Signed as',
  'panel.sig.signedOk': ' — cryptographically valid, covers the whole document.',
  'panel.sig.signedBad': ' — but the produced signature did not verify as expected.',
  'panel.sig.savedTo': 'Saved to {{path}}',
  'panel.sig.unknownSigner': '(unknown signer)',
  'panel.sig.field': 'field: {{name}}',
  'panel.sig.pageJump': 'page {{page}} →',
  'panel.sig.page': 'page {{page}}',
  'panel.sig.integrityIntact': 'integrity: intact',
  'panel.sig.integrityBroken': 'integrity: BROKEN',
  'panel.sig.coversWhole': 'covers whole document',
  'panel.sig.coversPartial': 'does not cover whole document',
  'panel.sig.digest': 'digest: {{algo}}',
  'panel.sig.tsaTime': 'TSA time: {{time}}',
  'panel.sig.tsaUnreadable': '(unreadable)',
  'panel.sig.tsaNotVerified': ' (timestamp not verified)',
  'panel.sig.claimedTime': 'claimed time: {{time}}',
  'panel.sig.identityTrusted': 'identity trusted',
  'panel.sig.errorLine': 'error: {{message}}',
  'panel.sig.statusInvalid': 'Invalid',
  'panel.sig.statusModified': 'Valid — document changed after signing',
  'panel.sig.statusValid': 'Cryptographically valid',
  'panel.sig.kindApproval': 'Approval signature',
  'panel.sig.kindCertification': 'Certification signature',
  'panel.sig.policyWithin': 'Within the certification',
  'panel.sig.policyViolated': 'Outside what the certification allows',
  'panel.sig.policyUnjudged': 'Not checked against the certification',
  'panel.sig.levelNone': 'No changes allowed',
  'panel.sig.levelFormFill': 'Form filling and signing allowed',
  'panel.sig.levelAnnotate': 'Form filling, signing and commenting allowed',
  'panel.sig.changesNone': 'nothing changed since signing',
  'panel.sig.changesLtv': 'validation material added',
  'panel.sig.changesFormFilling': 'form fields filled in',
  'panel.sig.changesAnnotations': 'annotations changed',
  'panel.sig.changesOther': 'other changes',
  'panel.sig.changesUnknown': 'a change of an unreported kind',
  'panel.sig.certifiedBy': 'Certified by {{signer}}',
  'panel.sig.certifiedLevelUnknown':
    'This document states what may change in it in a way this version does not recognise.',
  'panel.sig.certificationViolated':
    'The signature in field {{field}} reports a change the certification does not allow: {{change}}.',
  'panel.sig.certificationUnreadable':
    'This document carries a certification that could not be read: {{message}}',
  'panel.sig.unnamedField': '(unnamed)',
  'panel.sig.certify': 'Certify this document',
  'panel.sig.certifyHint':
    'A certification signature records what may change in the document afterwards. It must be the first signature in the document, and the level cannot be changed later.',
  'panel.sig.certifyLevel': 'Permitted changes',
  'panel.sig.certifyUnavailable':
    'This document is already signed, so it cannot be certified — a certification signature must be the first signature in a document.',
  'panel.sig.lockAll': 'Locks every form field against further change',
  'panel.sig.lockIncluded': 'Locks these form fields against further change: {{fields}}',
  'panel.sig.lockExcluded': 'Locks every form field except: {{fields}}',
  'panel.sig.lockViolated':
    'The signature in field {{field}} reports a change to form fields it locks: {{fields}}.',
  'panel.sig.lock': 'Lock form fields',
  'panel.sig.lockHint':
    'A locked form field cannot be filled in or changed after this signature without the document reporting as altered.',
  'panel.sig.lockOff': 'Lock nothing',
  'panel.sig.lockActionAll': 'Every form field',
  'panel.sig.lockActionInclude': 'Only the fields chosen below',
  'panel.sig.lockActionExclude': 'Every field except those chosen below',
  'panel.sig.lockFields': 'Fields',
  'panel.sig.lockNoFields': 'This document has no form fields to lock.',

  // The visible stamp's appearance, shared by both signing surfaces.
  'panel.stamp.heading': 'Stamp appearance',
  'panel.stamp.lines': 'Lines the stamp shows',
  'panel.stamp.fieldName': 'Signer name',
  'panel.stamp.fieldDate': 'Date and time',
  'panel.stamp.fieldReason': 'Reason',
  'panel.stamp.fieldLocation': 'Location',
  'panel.stamp.fieldLabel': 'Custom line',
  'panel.stamp.labelText': 'Custom line text',
  'panel.stamp.labelPlaceholder': 'Text for the custom line',
  'panel.stamp.chooseImage': 'Choose image…',
  'panel.stamp.noImage': 'No logo or background image',
  'panel.stamp.removeImage': 'Remove',
  'panel.stamp.layout': 'Image layout',
  'panel.stamp.layoutOver': 'Text over the image',
  'panel.stamp.layoutBeside': 'Text beside the image',
  'panel.stamp.imagePosition': 'Image position',
  'panel.stamp.imageOpacity': 'Opacity',
  'panel.stamp.positionLeft': 'Left',
  'panel.stamp.positionRight': 'Right',
  'panel.stamp.positionTop': 'Above',
  'panel.stamp.positionBottom': 'Below',
  'panel.stamp.face': 'Signature to show',
  'panel.stamp.faceNone': 'No signature',
  'panel.stamp.facePosition': 'Signature position',
  'panel.stamp.faceEmpty': 'Signatures you create or import appear here.',
  'panel.stamp.faceMissing': 'That signature is no longer saved. Choose another one.',
  'panel.stamp.faceUnreadable': 'That signature could not be read. Create or import it again.',
  'panel.stamp.preview': 'Preview',
  'panel.stamp.previewAlt': 'How the signature stamp will look',
  'panel.stamp.previewPending': 'Drawing the preview…',
  // The preview has no certificate to read a subject from — the signer source
  // is chosen separately and may not be loadable yet — so it says so rather
  // than showing a name the signature will not carry.
  'panel.stamp.previewSigner': 'Certificate holder',

  'panel.settings.catGeneral': 'General',
  'panel.settings.catAppearance': 'Appearance',
  'panel.settings.catEngine': 'Engine',
  'panel.settings.catTray': 'Tray & Startup',
  'panel.settings.catLicenses': 'Updates & Licenses',
  'panel.settings.saved': 'Settings saved',
  'panel.settings.gsEngine': 'Ghostscript',
  'panel.settings.gsUsedFor':
    'Used by Compress, Grayscale, PDF/A and PDF/X, printing, page rasterization and image export, visual comparison, OCR and scan enhancement, transparency flattening, Rebuild, and PostScript conversion.',
  'panel.settings.gsStatusReady': 'Ready',
  'panel.settings.gsStatusMissing': 'Not set up',
  'panel.settings.gsPathLabel': 'Program',
  'panel.settings.gsNonePath': 'None found',
  'panel.settings.gsDiscovered': 'Found on this PC',
  'panel.settings.gsChosen': 'Chosen by you',
  'panel.settings.gsBrowse': 'Choose Ghostscript…',
  'panel.settings.gsPickTitle': 'Choose the Ghostscript program',
  'panel.settings.gsUseDiscovered': 'Use the one found on this PC',
  'panel.settings.gsRecheck': 'Check again',
  'panel.settings.gsChecking': 'Checking…',
  'panel.settings.gsDetail': 'Details: {{detail}}',
  'panel.settings.gsWhereToGet': 'Ghostscript is available from ghostscript.com.',
  'panel.settings.gsLicense':
    'Ghostscript is not part of Spectra PDF. It is a separate program under its own license (AGPL-3.0, or a commercial license from Artifex), which you install and license yourself. Spectra PDF runs it as a separate program and ships no copy of it.',
  'panel.settings.gsPromptOnLaunch': 'Tell me at startup when Ghostscript is missing',
  'panel.settings.gsPromptOnLaunchHint':
    'Shown once per startup, and only when no Ghostscript is found on this PC. Turning it off changes nothing else — the features that need Ghostscript still say so where they are used.',
  'panel.settings.categoriesAria': 'Preferences categories',
  'panel.settings.version': 'Version {{version}}',
  'panel.settings.vendor': 'Vendor: {{vendor}}',
  'panel.settings.identityName': 'Identity name',
  'panel.settings.identityPlaceholder': 'Used by dynamic stamps’ {name} token',
  'panel.settings.identityHint': 'Shown where a stamp label uses {name} — e.g. “Reviewed by {name} {date}”.',
  'panel.settings.snapshotDpi': 'Snapshot resolution (pixels per inch)',
  'panel.settings.snapshotDpiHint':
    'The Snapshot tool captures at this resolution, not at the current zoom. {{min}}–{{max}}.',
  'panel.settings.scanSelectRecognition': 'Recognize text in scanned pages for selection',
  'panel.settings.scanSelectRecognitionHint':
    'Lets you select and highlight words on a scanned page. Recognition runs on this computer and never changes the file; use Scan & OCR to add a searchable text layer.',
  'panel.settings.scanSelectLanguage': 'Language to recognize scanned pages in',
  'panel.settings.scanSelectLanguageAuto': 'From the document, or English',
  'panel.settings.scanSelectLanguageHint':
    'Choose a language when scanned pages are recognized poorly. Left automatic, the document’s own stated language is used where it names one.',
  'panel.settings.spellCheckAsYouType': 'Underline misspellings while editing text',
  'panel.settings.spellCheckAsYouTypeHint':
    'The paragraph editor marks words that are not in the chosen dictionary. Which dictionary that is, and any words you have added yourself, are set in the Spelling panel.',
  'panel.settings.compressionQuality': 'Default Compression Quality',
  'panel.settings.mrcPreset': 'Default Scan (MRC) Preset',
  'panel.settings.singleKey': 'Use single-key accelerators to access tools',
  'panel.settings.singleKeyHint': 'H Hand · V Select · U Highlight · X Text · D Draw · K Stamp — off by default',
  'panel.settings.batchLogs': 'Batch OCR logs',
  'panel.settings.batchLogWrite': 'Write a log file for each batch run',
  'panel.settings.keepLogsFor': 'Keep logs for',
  'panel.settings.keepLogsAria': 'Keep batch OCR logs for',
  'panel.settings.days7': '7 days',
  'panel.settings.days30': '30 days',
  'panel.settings.days90': '90 days',
  'panel.settings.year1': '1 year',
  'panel.settings.keepForever': 'Keep forever',
  'panel.settings.openLogFolder': 'Open log folder',
  'panel.settings.location': 'Location',
  'panel.settings.choose': 'Choose…',
  'panel.settings.chooseLogFolder': 'Choose where batch logs are written',
  'panel.settings.defaultLogDir': 'Default (this app’s data folder)',
  'panel.settings.useDefault': 'Use default',
  'panel.settings.batchLogHint':
    'Each run writes one file listing every PDF and what happened to it. Older logs are swept at the end of the next run — only files this app wrote, in this folder, are ever removed.',
  'panel.settings.batchLogSharedHint':
    'Set a shared location if runs will be scheduled under a different account: the default folder belongs to whichever account ran the batch, so a scheduled run’s log would not appear here.',
  'panel.settings.theme': 'Theme',
  'panel.settings.themeSystem': 'System',
  'panel.settings.themeDark': 'Dark',
  'panel.settings.themeLight': 'Light',
  'panel.settings.themeHighContrast': 'High contrast',
  'panel.settings.themeForcedColors':
    'A system contrast theme is on, so the system palette controls the colours of this window and the theme above has no effect until you turn it off. Documents keep their own colours either way.',
  'panel.settings.minimizeToTray': 'Minimize to system tray on close',
  'panel.settings.startMinimized': 'Start minimized to tray',
  'panel.settings.startWithWindows': 'Start with Windows',
  'panel.settings.restoreWindows': 'Reopen last session on launch',
  'panel.settings.restoreWindowsHint':
    'Reopens the windows and documents that were open when you last quit. Window size and position are always remembered; this decides whether the documents come back too.',
  'panel.settings.fieldScripts': 'Form field scripts',
  'panel.settings.runFieldScripts': 'Run unrecognized field scripts',
  'panel.settings.fieldScriptsHint':
    'Off by default. Standard formatting and calculation calls always run and carry no code; this decides whether a form’s own custom scripts execute, in a sandboxed interpreter with no access to the network, the file system or printing.',
  'panel.settings.fieldScriptsPolicy':
    'Turned off for this machine by policy — this setting has no effect.',
  'panel.settings.updates': 'Updates',
  'panel.settings.checkOnLaunch': 'Check for updates on launch',
  'panel.settings.updatesHint':
    'Spectra PDF never installs updates itself. When a newer release exists it shows a notice, and opening it takes you to the download page. You can always check manually with Help ▸ Check for Updates.',
  'panel.settings.thirdParty': 'Third-party components',
  'panel.settings.licensesP2':
    'Also bundled or embedded: Python (PSF license) with pikepdf (MPL-2.0), pdfminer.six (MIT), and pyHanko (MIT) among its packages; pdf.js (Apache-2.0); pdf-lib (MIT); Tesseract — the bundled OCR engine, also run strictly as a separate program — and its language models (Apache-2.0), with the redistribution notices for every library it links installed beside it; the Liberation and Libertinus fonts (SIL OFL 1.1); Tauri and the compiled Rust crates (MIT/Apache-2.0 and similar).',
  'panel.settings.licensesP3':
    "The complete notices ship with the app: the aggregate list (with each component's license and source) and the per-crate Rust listing.",
  'panel.settings.openLicenses': 'Open third-party licenses',
  'panel.settings.rustNotices': 'Rust crate notices',
  'panel.settings.openedLicenses': 'Opened third-party licenses',
  'panel.settings.openedRust': 'Opened Rust crate notices',
  'panel.settings.openLicensesFailed': 'Could not open the licenses file',
  'panel.settings.printTo': 'Print to Spectra PDF',
  'panel.settings.printerBlurb':
    'Installs a printer named “Spectra PDF” in every application’s print dialog. Printing to it opens the pages here as a new PDF. Conversion happens on this PC with the bundled tools; jobs are received only while this app is running (minimized to the tray counts) — a job printed while it is closed waits in the Windows print queue.',
  'panel.settings.printerInstalled': 'Printer installed',
  'panel.settings.printerNotInstalled': 'Printer not installed',
  'panel.settings.printerReady': 'ready to receive jobs',
  'panel.settings.printerDown': 'receiver down: {{status}}',
  'panel.settings.lastJobFailed': 'Last job failed: {{error}}',
  'panel.settings.removePrinter': 'Remove printer…',
  'panel.settings.installPrinter': 'Install printer…',
  'panel.settings.uacNote': 'Windows asks for administrator approval — printers are system devices.',

  'panel.ga.open': 'Open a PDF to run an action on it',
  'panel.ga.pickSource': 'Folder of PDFs to process',
  'panel.ga.pickDest': 'Destination for the processed copies',
  'panel.ga.pickInPlace': 'Folder of PDFs to process IN PLACE',
  'panel.ga.newAction': 'New guided action',
  'panel.ga.editAction': 'Edit guided action',
  'panel.ga.namePlaceholder': 'Action name',
  'panel.ga.remove': 'Remove',
  'panel.ga.askedWhenRuns': '{{label}}: asked when the action runs',
  'panel.ga.askTitle': 'Ask for this value each time the action runs',
  'panel.ga.ask': 'Ask',
  'panel.ga.saveAction': 'Save action',
  'panel.ga.cancel': 'Cancel',
  'panel.ga.beforeRunning': 'Before running “{{name}}”',
  'panel.ga.writesNewFile': ' — writes a new file you pick next',
  'panel.ga.start': 'Start',
  'panel.ga.folderRun': 'Folder run — “{{name}}”',
  'panel.ga.processing': 'Processing the folder…',
  'panel.ga.folderSummary': '{{ok}} processed · {{failed}} failed · {{total}} total',
  'panel.ga.log': 'Log: {{path}}',
  'panel.ga.backToActions': 'Back to actions',
  'panel.ga.running': 'Running “{{name}}”',
  'panel.ga.done': 'Done — every step applied. Each step is one Undo.',
  'panel.ga.stopped': 'Stopped at the failed step; earlier steps stay applied (undoable).',
  'panel.ga.heading': 'Guided actions',
  'panel.ga.importTitle': 'Import an action from a file (exported here or written for the CLI)',
  'panel.ga.import': 'Import…',
  'panel.ga.new': 'New action…',
  'panel.ga.empty':
    'No actions yet. An action runs a sequence of steps — compress, watermark, encrypt… — over the open document with one click.',
  'panel.ga.run': 'Run',
  'panel.ga.folderTitle':
    'Run this action on every PDF under a folder (originals untouched; copies mirror into a destination)',
  'panel.ga.folder': 'Folder…',
  'panel.ga.inPlaceWarning': 'Replaces the originals — no undo.',
  'panel.ga.replace': 'Replace',
  'panel.ga.keep': 'Keep',
  'panel.ga.inPlaceTitle':
    'Run this action over a folder REPLACING the originals (staged, verified, then swapped per file)',
  'panel.ga.inPlace': 'In place…',
  'panel.ga.edit': 'Edit',
  'panel.ga.duplicate': 'Duplicate',
  'panel.ga.copySuffix': '{{name}} (copy)',
  'panel.ga.exportTitle': "Save this action as a file — shareable, and runnable via the CLI's run-action",
  'panel.ga.export': 'Export…',
  'panel.ga.delete': 'Delete',
  'panel.ga.addStep': 'Add step',

  // Count & Takeoff. Group NAMES are the user's own text and
  // never pass through here; `newGroupName` is only the SEED for a fresh one,
  // which the user then edits — after that it is data, not chrome.
  'panel.takeoff.open': 'Open a PDF to count items on it',
  'panel.takeoff.groups': 'Count groups',
  'panel.takeoff.addGroup': 'New group',
  'panel.takeoff.newGroupName': 'Group',
  'panel.takeoff.empty':
    'No count groups yet. Add one, then click on the page to count — each click places a marker, and clicking a marker again removes it.',
  'panel.takeoff.armTitle': 'Count into this group',
  'panel.takeoff.edit': 'Edit',
  'panel.takeoff.nameAria': 'Group name',
  'panel.takeoff.colorAria': 'Use the colour {{color}}',
  'panel.takeoff.forget': 'Forget group',
  'panel.takeoff.forgetTitle':
    'Remove this group from the remembered list. Marks already placed keep their group.',
  'panel.takeoff.total': 'Total',
  'panel.takeoff.colGroup': 'Group',
  'panel.takeoff.colPage': 'Page',
  'panel.takeoff.colCount': 'Count',
  'panel.takeoff.placeLegend': 'Place legend',
  'panel.takeoff.legendHint':
    'Stamp a legend table onto the page. It records the counts as they are now — place it again when they change.',
  'panel.takeoff.legendPlaced': 'Legend placed on the page.',
  'panel.takeoff.nothingToLegend': 'Nothing counted yet — a legend would be empty.',
  'panel.takeoff.exportCsv': 'Export CSV…',
  'panel.takeoff.exportHint':
    'Write the takeoff summary as a CSV: one row per group per page, plus a total.',
  'panel.takeoff.exporting': 'Exporting…',
  'panel.takeoff.exported': 'Exported {{total}} marks across {{groups}} groups.',
  'panel.takeoff.marker': 'Marker',

  // Symbol palettes. A BUILT-IN symbol's name is our word and
  // localizes, exactly like a built-in stamp's; an IMPORTED set's name and its
  // symbols' names are the user's own data and are shown verbatim — never
  // translated, and never used as identity (ids are).
  'panel.symbols.title': 'Symbols',
  'panel.symbols.hint':
    'Drag a symbol onto the page to place it, or pick one as a count group’s marker.',
  'panel.symbols.search': 'Search symbols',
  'panel.symbols.searchAria': 'Search symbols',
  'panel.symbols.import': 'Import set…',
  'panel.symbols.importHint': 'Load a symbol set from a JSON file — the format Export writes.',
  'panel.symbols.export': 'Export',
  'panel.symbols.remove': 'Remove',
  'panel.symbols.removeHint': 'Remove this set. Symbols already placed keep their artwork.',
  'panel.symbols.imported': 'Imported the set {{name}}.',
  'panel.symbols.updated': 'Updated the set {{name}}.',
  'panel.symbols.exported': 'Exported the set {{name}}.',
  'panel.symbols.removed': 'Removed the set {{name}}.',
  'panel.symbols.noMatch': 'No symbols match.',
  'panel.symbols.markerSet': '{{group}} now counts with {{name}}.',
  'panel.symbols.noArmedGroup': 'Arm a count group first to use a symbol as its marker.',
  'panel.symbols.placeHint': 'Drag {{name}} onto the page, or click to arm it',

  'panel.symbols.set.markers': 'Markers',
  'panel.symbols.set.aec': 'AEC general',

  'panel.symbols.name.circle': 'Circle',
  'panel.symbols.name.square': 'Square',
  'panel.symbols.name.triangle': 'Triangle',
  'panel.symbols.name.diamond': 'Diamond',
  'panel.symbols.name.cross': 'Cross',
  'panel.symbols.name.ex': 'X',
  'panel.symbols.name.hexagon': 'Hexagon',
  'panel.symbols.name.star': 'Star',
  'panel.symbols.name.target': 'Target',

  'panel.symbols.name.aec-door': 'Door swing',
  'panel.symbols.name.aec-window': 'Window',
  'panel.symbols.name.aec-receptacle': 'Receptacle',
  'panel.symbols.name.aec-switch': 'Switch',
  'panel.symbols.name.aec-light': 'Ceiling light',
  'panel.symbols.name.aec-fixture-linear': 'Linear fixture',
  'panel.symbols.name.aec-smoke-detector': 'Smoke detector',
  'panel.symbols.name.aec-thermostat': 'Thermostat',
  'panel.symbols.name.aec-exit-sign': 'Exit sign',
  'panel.symbols.name.aec-data-outlet': 'Data outlet',
  'panel.symbols.name.aec-junction-box': 'Junction box',
  'panel.symbols.name.aec-floor-drain': 'Floor drain',
  'panel.symbols.name.aec-diffuser': 'Supply diffuser',
  'panel.symbols.name.aec-return-grille': 'Return grille',
  'panel.symbols.name.aec-sprinkler': 'Sprinkler head',
  'panel.symbols.name.aec-valve': 'Valve',
  'panel.symbols.name.aec-north-arrow': 'North arrow',
  'panel.symbols.name.aec-detail-bubble': 'Detail bubble',
  'panel.symbols.name.aec-elevation-marker': 'Elevation marker',
  'panel.symbols.name.aec-fire-extinguisher': 'Fire extinguisher',

  // ── Search & Redact ───────────────────────────────────────────────────
  // The panel produces MARKS; the status bar's apply/save/clear stays the
  // only destructive path, so nothing here promises removal.
  'panel.searchRedact.open': 'Open a PDF to search and redact',
  'panel.searchRedact.queryPlaceholder': 'Search for…',
  'panel.searchRedact.queryAria': 'Text to search for',
  'panel.searchRedact.scope': 'Search',
  'panel.searchRedact.scopeAria': 'Where to search',
  'panel.searchRedact.scopeDocument': 'This document',
  'panel.searchRedact.scopeAll': 'All open documents',
  'panel.searchRedact.scopePages': 'These pages',
  'panel.searchRedact.pagesAria': 'Pages to search',
  'panel.searchRedact.wordList': 'Word list',
  'panel.searchRedact.wordListAria': 'One term per line',
  'panel.searchRedact.wordListPlaceholder': 'One term per line',
  'panel.searchRedact.importWordList': 'Import from a file…',
  'panel.searchRedact.patterns': 'Patterns',
  'panel.searchRedact.pattern.phone': 'Phone number',
  'panel.searchRedact.pattern.email': 'Email address',
  'panel.searchRedact.pattern.credit_card': 'Credit card number',
  'panel.searchRedact.pattern.ssn': 'Social security number',
  'panel.searchRedact.pattern.date': 'Date',
  'panel.searchRedact.pattern.iban': 'IBAN',
  'panel.searchRedact.pattern.nhs_uk': 'NHS number (UK)',
  'panel.searchRedact.pattern.sin_ca': 'Social insurance number (Canada)',
  'panel.searchRedact.pattern.url': 'Web address',
  'panel.searchRedact.expand': 'Each mark covers',
  'panel.searchRedact.expand.match': 'What matched',
  'panel.searchRedact.expand.word': 'The whole word',
  'panel.searchRedact.expand.line': 'The whole line',
  'panel.searchRedact.expandHint.match': 'Searching “55” inside “1955” marks the two digits.',
  'panel.searchRedact.expandHint.word': 'Searching “55” inside “1955” marks the whole year.',
  'panel.searchRedact.expandHint.line': 'Marks everything the matched text was drawn with — a whole table row.',
  'panel.searchRedact.search': 'Search',
  'panel.searchRedact.searching': 'Searching…',
  'panel.searchRedact.found_one': '{{count}} match',
  'panel.searchRedact.found_other': '{{count}} matches',
  'panel.searchRedact.hitCount_one': '{{count}} match',
  'panel.searchRedact.hitCount_other': '{{count}} matches',
  'panel.searchRedact.markChecked_one': 'Mark checked results ({{count}})',
  'panel.searchRedact.markChecked_other': 'Mark checked results ({{count}})',
  'panel.searchRedact.pending_one': '{{count}} mark already on the page',
  'panel.searchRedact.pending_other': '{{count}} marks already on the page',
  'panel.searchRedact.marked':
    'Added {{added}} ({{duplicates}} already marked, {{skipped}} skipped).',
  'panel.searchRedact.page': 'Page {{page}}',
  'panel.searchRedact.jump': 'Go to this page',
  'panel.searchRedact.alreadyMarked': 'Already marked for redaction.',
  'panel.searchRedact.noHits': 'No matches.',
  'panel.searchRedact.nothingToSearch':
    'Enter a search term, a word list or a pattern. Searching for nothing would mark every page.',
  'panel.searchRedact.badRange': '“{{token}}” is not a page or a page range.',
  'panel.searchRedact.noCanvas': 'Open the document to mark it.',
  'panel.searchRedact.stale':
    'This document changed since the search ran. Search again — these results point at content that may no longer be there.',
  'panel.searchRedact.truncated':
    'Stopped at {{max}} matches, so this list is incomplete. Narrow the search before marking.',
  'panel.searchRedact.truncatedSelectAll': 'The list is incomplete, so it cannot be selected all at once.',
  'panel.searchRedact.pagesWithoutText_one':
    '{{count}} page carries no searchable text.',
  'panel.searchRedact.pagesWithoutText_other':
    '{{count}} pages carry no searchable text.',
  'panel.searchRedact.runOcr': 'Scan & OCR',
  'panel.searchRedact.sourceOcr': 'scan',
  'panel.searchRedact.impreciseHint':
    'This mark covers the whole run: the text could not be measured glyph by glyph, so it errs wide.',
  'panel.searchRedact.properties': 'Redaction properties',

  // ── Redaction properties ──────────────────────────────────────────────
  // The mark's appearance, in the format's own vocabulary. One surface for
  // both producers: the band drawn on the page and every mark the search
  // makes read the same persisted record.
  'panel.redactProps.fill': 'Box colour',
  'panel.redactProps.code': 'Code',
  'panel.redactProps.noCode': 'No code',
  'panel.redactProps.overlay': 'Overlay text',
  'panel.redactProps.overlayPlaceholder': 'Drawn over the box — e.g. (b)(6)',
  'panel.redactProps.align': 'Align',
  'panel.redactProps.alignLeft': 'Left',
  'panel.redactProps.alignCenter': 'Centred',
  'panel.redactProps.alignRight': 'Right',
  'panel.redactProps.size': 'Text size',
  'panel.redactProps.sizeAuto': '0 fits the box',
  'panel.redactProps.textColor': 'Text colour',
  'panel.redactProps.textColorAuto': 'Match the box automatically',
  'panel.redactProps.repeat': 'Repeat the text to fill the box',
  'panel.redactProps.importSet': 'Import a code set…',
  'panel.redactProps.exportSet': 'Export this code set…',
  'panel.redactProps.reset': 'Reset',
  'panel.redactProps.imported': 'Imported “{{name}}” ({{count}} codes).',
  'panel.redactProps.updated': 'Updated “{{name}}” ({{count}} codes).',
  'panel.redactProps.exported': 'Exported “{{name}}”.',
  'panel.redactProps.import.notJson': 'Not a valid JSON file.',
  'panel.redactProps.import.notASet':
    'Not a redaction code set — expected an id, a name and a list of codes with labels.',
  'panel.redactProps.import.builtinId':
    'That id belongs to a built-in code set — give the imported set its own id.',

  // The built-in code sets' NAMES and DESCRIPTIONS. The LABELS ((b)(6), (k)(2))
  // stay out of the catalog on purpose: a label is the statutory citation
  // itself AND the text drawn into the file, so a translated one would misname
  // the exemption a release is checked against. The prose about it localizes
  // like every other built-in catalogue label (the symbol-name precedent).
  'panel.redactProps.set.foia': 'FOIA exemptions',
  'panel.redactProps.set.privacy-act': 'Privacy Act exemptions',
  'panel.redactProps.desc.foia.b1': 'Classified in the interest of national defense or foreign policy',
  'panel.redactProps.desc.foia.b2': 'Related solely to internal personnel rules and practices',
  'panel.redactProps.desc.foia.b3': 'Specifically exempted from disclosure by another statute',
  'panel.redactProps.desc.foia.b4': 'Trade secrets and privileged or confidential commercial information',
  'panel.redactProps.desc.foia.b5': 'Privileged inter-agency or intra-agency communications',
  'panel.redactProps.desc.foia.b6': 'Personnel, medical and similar files — a clearly unwarranted invasion of personal privacy',
  'panel.redactProps.desc.foia.b7a': 'Law-enforcement records that could interfere with proceedings',
  'panel.redactProps.desc.foia.b7b': 'Law-enforcement records that would deprive a person of a fair trial',
  'panel.redactProps.desc.foia.b7c': 'Law-enforcement records — an unwarranted invasion of personal privacy',
  'panel.redactProps.desc.foia.b7d': 'Law-enforcement records that could disclose a confidential source',
  'panel.redactProps.desc.foia.b7e': 'Law-enforcement techniques, procedures or guidelines',
  'panel.redactProps.desc.foia.b7f': 'Law-enforcement records that could endanger life or physical safety',
  'panel.redactProps.desc.foia.b8': 'Records of financial institution examinations',
  'panel.redactProps.desc.foia.b9': 'Geological and geophysical information concerning wells',
  'panel.redactProps.desc.privacy-act.j1': 'General exemption — Central Intelligence Agency records',
  'panel.redactProps.desc.privacy-act.j2': 'General exemption — criminal law-enforcement records',
  'panel.redactProps.desc.privacy-act.k1': 'Classified material',
  'panel.redactProps.desc.privacy-act.k2': 'Investigatory material compiled for law-enforcement purposes',
  'panel.redactProps.desc.privacy-act.k3': 'Records maintained for Secret Service protective duties',
  'panel.redactProps.desc.privacy-act.k4': 'Statistical records required by statute',
  'panel.redactProps.desc.privacy-act.k5': 'Investigatory material for federal employment or contracts',
  'panel.redactProps.desc.privacy-act.k6': 'Testing or examination material for federal service',
  'panel.redactProps.desc.privacy-act.k7': 'Evaluation material for armed-forces promotion',

  // Prepare Form — automatic field detection. Candidates are suggestions:
  // nothing here reaches the document until the user checks a row and creates.
  'panel.prepareForm.open': 'Open a PDF to prepare it as a form',
  'panel.prepareForm.blurb':
    'Find the lines, boxes and checkboxes on a flat form and offer them as fields. Nothing is written until you create the ones you keep.',
  'panel.prepareForm.scope': 'Look at',
  'panel.prepareForm.scopeDocument': 'The whole document',
  'panel.prepareForm.scopePages': 'Certain pages',
  'panel.prepareForm.pagesAria': 'Pages to look at',
  'panel.prepareForm.pagesPlaceholder': 'e.g. 1,3,5-8',
  'panel.prepareForm.noPages': 'Give at least one page number.',
  'panel.prepareForm.noCanvas': 'Open the document on the page to review suggested fields.',
  'panel.prepareForm.detect': 'Detect form fields',
  'panel.prepareForm.detecting': 'Looking…',
  'panel.prepareForm.found_one': '{{count}} suggested field.',
  'panel.prepareForm.found_other': '{{count}} suggested fields.',
  'panel.prepareForm.foundNone': 'Nothing on these pages looks like a form field.',
  'panel.prepareForm.nothingOffered':
    'No fields were suggested. Draw one on the page instead.',
  'panel.prepareForm.truncated':
    'The page limit was reached, so this is not the whole form — select rows individually.',
  'panel.prepareForm.selectAll': 'Check all',
  'panel.prepareForm.selectNone': 'Uncheck all',
  'panel.prepareForm.checked_one': '{{count}} checked',
  'panel.prepareForm.checked_other': '{{count}} checked',
  'panel.prepareForm.pageHeading': 'Page {{page}}',
  'panel.prepareForm.nameAria': 'Field name',
  'panel.prepareForm.kindAria': 'Field type',
  'panel.prepareForm.kindText': 'Text',
  'panel.prepareForm.kindCheckbox': 'Checkbox',
  'panel.prepareForm.kindRadio': 'Radio button',
  'panel.prepareForm.kindSignature': 'Signature',
  'panel.prepareForm.multiline': 'Multiple lines',
  'panel.prepareForm.fromLabel': 'from “{{label}}”',
  'panel.prepareForm.looksLikeDate': 'looks like a date',
  'panel.prepareForm.optionValue': 'value “{{value}}”',
  'panel.prepareForm.reveal': 'Show',
  'panel.prepareForm.discard': 'Discard this suggestion',
  'panel.prepareForm.create_one': 'Create {{count}} field',
  'panel.prepareForm.create_other': 'Create {{count}} fields',
  'panel.prepareForm.creating': 'Creating…',
  'panel.prepareForm.created_one': '{{count}} field created.',
  'panel.prepareForm.created_other': '{{count}} fields created.',
  'panel.prepareForm.sigFields': 'Signature fields',
  'panel.prepareForm.sigFieldsBlurb':
    'A signature field can carry the form fields it locks. Whoever signs it is bound by that, without you signing anything.',
  'panel.prepareForm.sigFieldsNone': 'This document has no signature fields.',
  'panel.prepareForm.sigFieldSigned':
    'This field is signed, so what it locks can no longer change.',
  'panel.prepareForm.lockNone': 'Locks nothing.',
  'panel.prepareForm.lockApply': 'Apply lock',
  'panel.prepareForm.lockApplying': 'Applying…',
  'panel.prepareForm.lockApplied': 'Lock set on {{field}}.',
  'panel.prepareForm.lockDeclined': 'The document was left alone.',
  'panel.prepareForm.fieldProps': 'Field properties',
  'panel.prepareForm.fieldPropsBlurb':
    'What a field shows, what it accepts, and what it calculates from the fields around it. Every other viewer runs the same rules.',
  'panel.prepareForm.fieldPropsNone': 'This document has no text or dropdown fields.',
  'panel.prepareForm.propsApply': 'Apply properties',
  'panel.prepareForm.propsApplying': 'Applying…',
  'panel.prepareForm.propsApplied': 'Properties set on {{field}}.',

  // The Format / Accepted range / Calculate editor, shared by the placement
  // card, the detection review row and the field-properties section. A
  // typographic choice is offered as a SAMPLE, so nothing here names a
  // separator style or a mask by number.
  'panel.fieldActions.format': 'Shows as',
  'panel.fieldActions.formatNone': 'Plain text',
  'panel.fieldActions.formatNumber': 'Number',
  'panel.fieldActions.formatPercent': 'Percentage',
  'panel.fieldActions.formatDate': 'Date',
  'panel.fieldActions.formatTime': 'Time',
  'panel.fieldActions.formatSpecial': 'Fixed pattern',
  'panel.fieldActions.formatMask': 'Custom pattern',
  'panel.fieldActions.decimals': 'Decimal places',
  'panel.fieldActions.separator': 'Separators',
  'panel.fieldActions.negative': 'Negative values',
  'panel.fieldActions.currency': 'Symbol',
  'panel.fieldActions.currencyPrepend': 'Symbol before the number',
  'panel.fieldActions.mask': 'Pattern',
  'panel.fieldActions.maskHint':
    'In a pattern, 9 accepts a digit, A a letter, O a letter or a digit, X anything; every other character must be typed as written.',
  'panel.fieldActions.sample': 'On the page: {{sample}}',
  'panel.fieldActions.validate': 'Accepts',
  'panel.fieldActions.min': 'Smallest',
  'panel.fieldActions.max': 'Largest',
  'panel.fieldActions.calculate': 'Calculate',
  'panel.fieldActions.calculateNone': 'Not calculated',
  'panel.fieldActions.calculateExpression': 'From an expression',
  'panel.fieldActions.opSum': 'Sum of fields',
  'panel.fieldActions.opPrd': 'Product of fields',
  'panel.fieldActions.opAvg': 'Average of fields',
  'panel.fieldActions.opMin': 'Smallest of fields',
  'panel.fieldActions.opMax': 'Largest of fields',
  'panel.fieldActions.fields': 'From',
  'panel.fieldActions.noFields': 'This document has no other fields to calculate from.',
  'panel.fieldActions.expression': 'Expression',
  'panel.fieldActions.expressionPlaceholder': 'Subtotal + Tax',
  'panel.fieldActions.expressionInvalid':
    'This expression cannot be read, so no viewer would compute it the same way.',
  'panel.fieldActions.defaultValue': 'Starts as',
  // The data actions — the `/AA` kinds that carry no code, so all of them can
  // be both authored and performed.
  'panel.fieldActions.actions': 'Does',
  'panel.fieldActions.actionsNone': 'This field does nothing when it is used.',
  'panel.fieldActions.actionAdd': 'Add an action',
  'panel.fieldActions.actionRemove': 'Remove',
  'panel.fieldActions.actionKind': 'Action',
  'panel.fieldActions.actionDirection': 'Effect',
  'panel.fieldActions.actionTrigger': 'When',
  'panel.fieldActions.actionGoto': 'Go to a page',
  'panel.fieldActions.actionUri': 'Open a link',
  'panel.fieldActions.actionReset': 'Reset the form',
  'panel.fieldActions.actionSubmit': 'Submit the form',
  'panel.fieldActions.actionHide': 'Show or hide fields',
  'panel.fieldActions.actionImport': 'Import form data',
  'panel.fieldActions.actionNamed': 'A viewer command',
  'panel.fieldActions.actionJavascript': 'Run a script',
  'panel.fieldActions.actionRemote': 'Go to another document',
  'panel.fieldActions.actionOther': 'An action this app does not know',
  'panel.fieldActions.triggerActivate': 'It is clicked',
  'panel.fieldActions.triggerDown': 'The mouse goes down',
  'panel.fieldActions.triggerUp': 'The mouse comes up',
  'panel.fieldActions.triggerEnter': 'The pointer enters it',
  'panel.fieldActions.triggerExit': 'The pointer leaves it',
  'panel.fieldActions.triggerFocus': 'It gains focus',
  'panel.fieldActions.triggerBlur': 'It loses focus',
  'panel.fieldActions.actionPage': 'Page',
  'panel.fieldActions.actionAddress': 'Address',
  'panel.fieldActions.actionFile': 'File',
  'panel.fieldActions.actionFormat': 'Send as',
  'panel.fieldActions.actionMethod': 'Method',
  'panel.fieldActions.actionMethodPost': 'POST',
  'panel.fieldActions.actionMethodGet': 'GET',
  'panel.fieldActions.actionIncludeEmpty': 'Include fields with no value',
  'panel.fieldActions.actionShow': 'Show them',
  'panel.fieldActions.actionHideThem': 'Hide them',
  'panel.fieldActions.actionScopeAll': 'Every field',
  'panel.fieldActions.actionScopeOnly': 'Only the fields below',
  'panel.fieldActions.actionScopeExcept': 'Every field except those below',
  'panel.fieldActions.actionScope': 'Fields',
  'panel.fieldActions.actionTargets': 'Fields',
  'panel.fieldActions.actionSubmitNote':
    'The submission is built in full and shown to whoever clicks the button, who decides whether to send it. Nothing is sent without that answer, and the answer is asked every time.',
  'panel.fieldActions.actionUnauthorable':
    'This field also carries an action this app does not author ({{kinds}}). Applying here removes it.',
  'panel.prepareForm.reasonRuleWithoutLabel':
    'Page {{page}}: {{count}} line(s) with no label beside them were left out — they read as a table, not a fill-in.',
  'panel.prepareForm.reasonCovered':
    'Page {{page}}: {{count}} region(s) already carry a field.',
  'panel.prepareForm.reasonRadioDemoted':
    'Page {{page}}: {{count}} group(s) had no distinct option labels, so each option is offered on its own.',
  'panel.prepareForm.reasonOther': 'Page {{page}}: {{count}} region(s) were not offered.',

  'panel.tableReview.open': 'Open a PDF to check its tables',
  'panel.tableReview.blurb':
    'Find the tables on the page, then adjust what each one covers and where its columns fall. Nothing is written until you export.',
  'panel.tableReview.scope': 'Look at',
  'panel.tableReview.scopeDocument': 'The whole document',
  'panel.tableReview.scopePages': 'Certain pages',
  'panel.tableReview.pagesAria': 'Pages to look at',
  'panel.tableReview.pagesPlaceholder': 'e.g. 1,3,5-8',
  'panel.tableReview.noPages': 'Give at least one page number.',
  'panel.tableReview.noCanvas': 'Open the document on the page to review the tables found.',
  'panel.tableReview.detect': 'Find tables',
  'panel.tableReview.detecting': 'Looking…',
  'panel.tableReview.found_one': '{{count}} table found.',
  'panel.tableReview.found_other': '{{count}} tables found.',
  'panel.tableReview.foundNone': 'Nothing on these pages reads as a table.',
  'panel.tableReview.acceptAll': 'Check all',
  'panel.tableReview.acceptNone': 'Uncheck all',
  'panel.tableReview.accepted_one': '{{count}} checked',
  'panel.tableReview.accepted_other': '{{count}} checked',
  'panel.tableReview.acceptAria': 'Include this table',
  'panel.tableReview.pageHead': 'Page {{page}}',
  // The count is the cells that HOLD something (`_cell_count` sums the
  // non-empty ones), which rows×columns does not equal — a grid with an empty
  // total row reports fewer cells than the shape multiplies to. The bare noun
  // read as the product of the two numbers beside it.
  'panel.tableReview.shape_one': '{{rows}}×{{columns}}, {{count}} non-empty cell',
  'panel.tableReview.shape_other': '{{rows}}×{{columns}}, {{count}} non-empty cells',
  'panel.tableReview.show': 'Show the tables on the page',
  'panel.tableReview.adjustHint':
    'Drag a frame to change what a table covers, drag a rule to move a column, double-click inside to add one, double-click a rule to remove it.',
  'panel.tableReview.untabled_one': '{{count}} line of text sits outside every table.',
  'panel.tableReview.untabled_other': '{{count}} lines of text sit outside every table.',
  'panel.tableReview.verticalRuns_one':
    '{{count}} run of vertical text is not part of any column.',
  'panel.tableReview.verticalRuns_other':
    '{{count}} runs of vertical text are not part of any column.',
  'panel.tableReview.export': 'Export to spreadsheet…',
  'panel.tableReview.exporting': 'Exporting…',
  'panel.tableReview.nothingAccepted': 'Include at least one table first.',
  'panel.tableReview.documentGone': 'This document is no longer open.',
  'panel.tableReview.pagesGone':
    'A table you included is on a page this document no longer has. Find the tables again.',

  'panel.sanitize.open': 'Open a PDF to see what it carries',
  'panel.sanitize.blurb':
    'Everything in this document that is not the page you can see. Nothing is removed until you check it and apply.',
  'panel.sanitize.rerun': 'Check again',
  'panel.sanitize.applying': 'Removing…',
  'panel.sanitize.apply_one': 'Remove {{count}} category',
  'panel.sanitize.apply_other': 'Remove {{count}} categories',
  'panel.sanitize.nothingChecked': 'Check what to remove.',
  'panel.sanitize.clean': 'Nothing of this kind is in the document.',
  'panel.sanitize.blocked':
    'Part of this document could not be read ({{category}}: {{reason}}), so nothing can be removed from it.',
  'panel.sanitize.blockedPage':
    'Page {{page}} could not be read ({{category}}: {{reason}}), so nothing can be removed from this document.',
  'panel.sanitize.pagesAnalyzed_one': 'Read {{count}} page.',
  'panel.sanitize.pagesAnalyzed_other': 'Read {{count}} pages.',
  'panel.sanitize.selectAll': 'Check everything that costs nothing',
  'panel.sanitize.selectNone': 'Uncheck all',
  'panel.sanitize.details': 'Details',
  'panel.sanitize.moreRows': 'Only the first findings are listed.',
  'panel.sanitize.unreadableRow': 'This could not be read.',
  'panel.sanitize.reportedOnly': 'Reported, never removed.',

  'panel.sanitize.category.metadata': 'Document and page metadata',
  'panel.sanitize.category.embedded_files': 'Embedded and attached files',
  'panel.sanitize.category.bookmarks': 'Bookmarks',
  'panel.sanitize.category.comments': 'Comments and markup',
  'panel.sanitize.category.form_fields': 'Form fields and their values',
  'panel.sanitize.category.javascript': 'JavaScript',
  'panel.sanitize.category.hidden_layers': 'Hidden layers',
  'panel.sanitize.category.hidden_text': 'Text you cannot see',
  'panel.sanitize.category.prior_revisions': 'Earlier revisions of this file',
  'panel.sanitize.category.unreferenced_objects': 'Objects nothing points to',
  'panel.sanitize.category.links_and_actions': 'Links and actions',
  'panel.sanitize.category.thumbnails': 'Page thumbnails',
  'panel.sanitize.category.attached_structure': 'Tags, language and article threads',
  'panel.sanitize.category.signatures': 'Digital signatures',

  'panel.sanitize.cost.form_fields':
    'Removing the fields makes the form no longer fillable. Flatten instead to keep how it looks.',
  'panel.sanitize.cost.attached_structure':
    'The tags are the reading order a screen reader follows. Removing them makes this document inaccessible.',
  'panel.sanitize.cost.ocr_layer':
    'This invisible text is what makes a scan searchable. Removing it means the words can no longer be found.',
  'panel.sanitize.fieldMode': 'Form fields',
  'panel.sanitize.fieldModeRemove': 'Remove the fields',
  'panel.sanitize.fieldModeFlatten': 'Flatten (keep the look, lose the fields)',
  'panel.sanitize.includeOcr_one': 'Also remove {{count}} recognized-text run',
  'panel.sanitize.includeOcr_other': 'Also remove {{count}} recognized-text runs',
  'panel.sanitize.partialKept_one':
    '{{count}} run is only partly covered and is kept — the uncovered part is content.',
  'panel.sanitize.partialKept_other':
    '{{count}} runs are only partly covered and are kept — the uncovered part is content.',
  'panel.sanitize.xfa':
    'This document carries an XML form, so its fields cannot be removed here.',
  'panel.sanitize.revisions_one':
    '{{count}} earlier revision, {{bytes}} bytes of it recoverable from this file.',
  'panel.sanitize.revisions_other':
    '{{count}} earlier revisions, {{bytes}} bytes of them recoverable from this file.',
  'panel.sanitize.signed_one': '{{count}} signature. Removing anything breaks it.',
  'panel.sanitize.signed_other': '{{count}} signatures. Removing anything breaks them.',
  'panel.sanitize.certified':
    'This document is certified, which states what may change in it. A clean-up changes more than that allows.',

  'panel.sanitize.resultTitle': 'Before and after',
  'panel.sanitize.resultRow': '{{category}}: {{before}} → {{after}}',
  'panel.sanitize.residue':
    '{{category}} still reports {{after}}. Something in it could not be removed.',
  'panel.sanitize.done_one': '{{count}} category removed. Undo puts it back.',
  'panel.sanitize.done_other': '{{count}} categories removed. Undo puts them back.',
  'panel.sanitize.declined': 'Nothing was changed.',
} as const;

export type PanelKey = keyof typeof PANEL_STRINGS;
