// N12 slice C (brief 37) — the CANVAS and its overlays: the contextual
// secondary toolbar, the page-cell editors and their annotation chrome, the
// image/vector transform overlays, the text-selection menu, the find bar, the
// document/presentation views and the drag hints that live over the page.
// Fifth typed record after i18n-chrome.ts (slice A), i18n-panels.ts,
// i18n-dialogs.ts and i18n-workbench.ts (slice B); same contract throughout —
// the record carries the English, the en catalog is GENERATED from it by
// tests/i18n-catalog.test.ts, every shipped locale's key set must equal en's
// exactly, and a surface is either FULLY threaded or not started.
//
// What is NOT here, deliberately:
//   • TOOL/MODE NAMES. Every canvas mode is a command (`tools.<mode>`) whose
//     title IS `TOOL_TITLES[mode]`, already generated into `cmd.*`; the strip
//     reads that key through tCommandTitle, and the owning tool's name through
//     tToolTitle. A second copy would let the Tools menu and the strip name one
//     mode two ways in one language.
//   • MEASURE UNIT symbols (pt/in/mm/ft…) and PDF blend-mode VALUES. The
//     symbols are notation, identical in every locale (the FindModeToggles
//     precedent); the blend VALUE is the PDF name written into the content
//     stream — only its human LABEL localizes, through the keys below.
//   • Engine text: an edit refusal, an extract's output name, a search-core
//     timeout. Those cross the slice-D boundary and pass through verbatim
//     inside a localized frame.
export const CANVAS_STRINGS = {
  // ── Shared across the canvas surfaces ────────────────────────────────
  'canvas.common.apply': 'Apply',
  'canvas.common.cancel': 'Cancel',
  'canvas.common.delete': 'Delete',
  'canvas.common.working': 'Working…',

  // ── The secondary toolbar (§ 3.1) ────────────────────────────────────
  // The mode group's label names the owning TOOL, so the tool name rides in
  // as a variable rather than being glued to the word "tools".
  'canvas.toolbar.modes': '{{tool}} tools',

  // Shape mode options (rung 2).
  'canvas.toolbar.shapeGroup': 'Shape',
  'canvas.shape.rect': 'Rectangle',
  'canvas.shape.ellipse': 'Ellipse',
  'canvas.shape.line': 'Line',
  'canvas.shape.arrow': 'Arrow',
  'canvas.shape.polygon': 'Polygon',
  'canvas.shape.polyline': 'Polyline',
  'canvas.shape.cloud': 'Cloud',

  // Measure (parity map § 2) — scale row + the calibration follow-up.
  'canvas.measure.optionsGroup': 'Measure options',
  'canvas.measure.scale': 'Scale',
  'canvas.measure.paperAmount': 'Scale: paper amount',
  'canvas.measure.paperUnit': 'Scale: paper unit',
  'canvas.measure.realAmount': 'Scale: real-world amount',
  'canvas.measure.realUnit': 'Scale: real-world unit',
  'canvas.measure.leaveMarkup': 'Leave markup',
  'canvas.measure.calibrationGroup': 'Calibration',
  // `pt` is the PDF unit, identical in every locale; the NUMBER formats
  // through Intl (never toFixed) and arrives already rendered.
  'canvas.measure.measured': 'Measured {{length}} pt =',

  // Edit tool (7.1) — image/text/paragraph actions.
  'canvas.edit.actionsGroup': 'Image actions',
  'canvas.edit.hint': 'Click an image, a paragraph, or a line of text on the page',
  'canvas.edit.editParagraph': 'Edit Paragraph…',
  'canvas.edit.editText': 'Edit Text…',
  'canvas.edit.replace': 'Replace…',
  'canvas.edit.extract': 'Extract…',
  'canvas.edit.vectorNoReplace':
    'A vector graphic cannot be replaced with a raster image — delete it and add a new graphic',
  'canvas.edit.vectorNoExtract': 'A vector graphic has no image bytes to extract',
  'canvas.edit.crop': 'Crop',
  'canvas.edit.cropTitle': 'Crop — drag inside the image to keep a region',
  'canvas.edit.rotateCcw': 'Rotate 90° counter-clockwise',
  'canvas.edit.rotateCw': 'Rotate 90° clockwise',

  // Blend modes (P7 slice D). The option VALUE stays the PDF name; these are
  // only the labels the reader sees.
  'canvas.edit.blend': 'Blend',
  'canvas.edit.blendTitle': 'Blend mode',
  'canvas.blend.Normal': 'Normal',
  'canvas.blend.Multiply': 'Multiply',
  'canvas.blend.Screen': 'Screen',
  'canvas.blend.Overlay': 'Overlay',
  'canvas.blend.Darken': 'Darken',
  'canvas.blend.Lighten': 'Lighten',
  'canvas.blend.ColorDodge': 'Color Dodge',
  'canvas.blend.ColorBurn': 'Color Burn',
  'canvas.blend.HardLight': 'Hard Light',
  'canvas.blend.SoftLight': 'Soft Light',
  'canvas.blend.Difference': 'Difference',
  'canvas.blend.Exclusion': 'Exclusion',
  'canvas.blend.Hue': 'Hue',
  'canvas.blend.Saturation': 'Saturation',
  'canvas.blend.Color': 'Color',
  'canvas.blend.Luminosity': 'Luminosity',

  // Gradient fade mask (P7 slice E).
  'canvas.edit.fade': 'Fade',
  'canvas.edit.fadeTitle': 'Gradient fade mask',
  'canvas.edit.fadeNone': 'None',
  'canvas.edit.fadeLinear': 'Linear',
  'canvas.edit.fadeRadial': 'Radial',
  'canvas.edit.fadeAlphaTitle': 'Fade start and end opacity (%)',

  // Align/distribute (P7 multi-select). The GLYPHS are shared with the
  // properties bar's annotation row and stay verbatim; the tooltips localize.
  'canvas.edit.alignGroup': 'Align images',
  'canvas.edit.alignLeft': 'Align left edges',
  'canvas.edit.alignCenterh': 'Align horizontal centers',
  'canvas.edit.alignRight': 'Align right edges',
  'canvas.edit.alignTop': 'Align top edges',
  'canvas.edit.alignCenterv': 'Align vertical centers',
  'canvas.edit.alignBottom': 'Align bottom edges',
  'canvas.edit.alignDisth': 'Distribute horizontally (even gaps)',
  'canvas.edit.alignDistv': 'Distribute vertically (even gaps)',
  'canvas.edit.groupCount_one': '{{count}} selected',
  'canvas.edit.groupCount_other': '{{count}} selected',

  // Opacity (9.C3).
  'canvas.edit.opacity': 'Opacity',
  'canvas.edit.opacityTitle': 'Image opacity',
  'canvas.edit.opacityValue': '{{value}}%',

  // ── Stamps (parity map § 2) ──────────────────────────────────────────
  // The built-in stamp WORDS localize: a stamp's label is placed INTO the
  // document as its appearance text, so an author working in Spanish is
  // stamping their own document in Spanish (the new-bookmark-name precedent).
  // Identity is the preset's stable `id`, never its label — a label-derived
  // test id or comparison is exactly the landmine slice B kept finding.
  'canvas.stamp.presetGroup': 'Stamp preset',
  'canvas.stamp.preset.approved': 'APPROVED',
  'canvas.stamp.preset.rejected': 'REJECTED',
  'canvas.stamp.preset.draft': 'DRAFT',
  'canvas.stamp.preset.confidential': 'CONFIDENTIAL',
  'canvas.stamp.preset.reviewed': 'REVIEWED',
  'canvas.stamp.dynamic': '{{label}} — dynamic: tokens resolve when placed',
  'canvas.stamp.remove': 'Remove this stamp from the library',
  'canvas.stamp.new': 'New stamp…',
  'canvas.stamp.fromImage': 'From image…',
  'canvas.stamp.newGroup': 'New custom stamp',
  // `{date}` / `{time}` / `{name}` are the LITERAL tokens the placement
  // resolves — they are syntax, not words, and stay verbatim in every locale.
  'canvas.stamp.labelPlaceholder': 'Label — {date} {time} {name} allowed',
  'canvas.stamp.add': 'Add',
  'canvas.stamp.defaultName': 'Stamp',

  'canvas.toolbar.colorGroup': 'Annotation colour',

  // ── The properties bar (I.6, Acrobat's Ctrl+E) ───────────────────────
  'canvas.pbar.barLabel': 'Properties bar',
  // What the selected annotation IS, in human words. Deliberately NOT the
  // Comments panel's `panel.comments.kind.*` — those are the PDF's own
  // subtype names (FreeText, StrikeOut) and this bar speaks plain language.
  'canvas.pbar.kind.highlight': 'Highlight box',
  'canvas.pbar.kind.freetext': 'Text box',
  'canvas.pbar.kind.ink': 'Ink stroke',
  'canvas.pbar.kind.stamp': 'Stamp',
  'canvas.pbar.kind.textmarkup': 'Text markup',
  'canvas.pbar.kind.note': 'Sticky note',
  'canvas.pbar.kind.measure': 'Measurement',
  'canvas.pbar.kind.shape': 'Shape',
  'canvas.pbar.kind.callout': 'Callout',
  'canvas.pbar.markup.highlight': 'Highlight',
  'canvas.pbar.markup.underline': 'Underline',
  'canvas.pbar.markup.strikeout': 'Strike out',
  'canvas.pbar.markup.squiggly': 'Squiggly',

  'canvas.pbar.zorderGroup': 'Z-order',
  'canvas.pbar.z.front': 'Bring to front',
  'canvas.pbar.z.forward': 'Bring forward',
  'canvas.pbar.z.backward': 'Send backward',
  'canvas.pbar.z.back': 'Send to back',

  'canvas.pbar.styleGroup': 'Style',
  'canvas.pbar.strokeWidth': 'Stroke width',
  'canvas.pbar.strokeWidthOption': '{{width}} pt',
  'canvas.pbar.opacity': 'Opacity',
  'canvas.pbar.opacityOption': '{{percent}}%',
  'canvas.pbar.noFill': 'No fill',
  'canvas.pbar.fillWith': 'Fill with {{color}}',

  'canvas.pbar.rotateFlipGroup': 'Rotate and flip',
  'canvas.pbar.flipH': 'Flip horizontal',
  'canvas.pbar.flipV': 'Flip vertical',

  'canvas.pbar.shapeOptionsGroup': 'Shape options',
  'canvas.pbar.lineStart': 'Line start',
  'canvas.pbar.lineEnd': 'Line end',
  // One key per (ending, end) PAIR: "Open arrow" + " start" is two fragments
  // whose order differs per language, which is the concatenation the brief
  // bans. The VALUE stays the PDF's /LE name.
  'canvas.pbar.endingStart.None': 'Plain start',
  'canvas.pbar.endingStart.OpenArrow': 'Open arrow start',
  'canvas.pbar.endingStart.ClosedArrow': 'Closed arrow start',
  'canvas.pbar.endingEnd.None': 'Plain end',
  'canvas.pbar.endingEnd.OpenArrow': 'Open arrow end',
  'canvas.pbar.endingEnd.ClosedArrow': 'Closed arrow end',
  'canvas.pbar.cloudIntensity': 'Cloud intensity',
  'canvas.pbar.cloudOption': 'Cloud {{level}}',

  'canvas.pbar.selectedCount_one': '{{count}} selected',
  'canvas.pbar.selectedCount_other': '{{count}} selected',
  'canvas.pbar.alignGroup': 'Align',
  'canvas.pbar.distributeGroup': 'Distribute',
  'canvas.pbar.distHAria': 'Distribute horizontally',
  'canvas.pbar.distVAria': 'Distribute vertically',
  'canvas.pbar.matchSizeGroup': 'Match size',
  'canvas.pbar.matchWidths': 'Match widths (to the first selected)',
  'canvas.pbar.matchWidthsAria': 'Match widths',
  'canvas.pbar.matchHeights': 'Match heights (to the first selected)',
  'canvas.pbar.matchHeightsAria': 'Match heights',
  'canvas.pbar.matchBoth': 'Match size (to the first selected)',
  'canvas.pbar.matchBothAria': 'Match size',

  'canvas.pbar.recolorAllGroup': 'Recolor all',
  'canvas.pbar.recolorAll': 'Recolor all to {{color}}',
  'canvas.pbar.colorGroup': 'Color',
  'canvas.pbar.recolorTo': 'Recolor to {{color}}',
  // The whole placement readout is ONE sentence: "p." is an abbreviation a
  // translator replaces, and the ×-separated size is not two fragments.
  'canvas.pbar.place': 'p.{{page}} · {{width}}×{{height}} pt',
  // The quotation marks are locale typography, so they live in the catalog.
  'canvas.pbar.note': '“{{note}}”',

  'canvas.pbar.newColorGroup': 'New annotation color',
  // One key per comment mode: "New " + mode + " color" glued a raw mode id
  // into an English sentence — untranslatable, and it printed the id.
  'canvas.pbar.newColor.highlight': 'New highlight color',
  'canvas.pbar.newColor.freetext': 'New text box color',
  'canvas.pbar.newColor.ink': 'New ink color',
  'canvas.pbar.newColor.stamp': 'New stamp color',
  'canvas.pbar.useForNew': 'Use {{color}} for new annotations',

  'canvas.pbar.empty':
    'Click a comment with the Select tool to see its properties — Ctrl-click or Ctrl-drag for several.',
  'canvas.pbar.close': 'Hide the properties bar (Ctrl+E)',
  'canvas.pbar.closeAria': 'Hide the properties bar',

  // ── The text-selection markup bar ────────────────────────────────────
  'canvas.markup.barLabel': 'Mark selected text',
  'canvas.markup.highlight': 'Highlight',
  'canvas.markup.underline': 'Underline',
  'canvas.markup.strikeout': 'Strikeout',
  'canvas.markup.squiggly': 'Squiggly',
  'canvas.markup.link': 'Link',
  'canvas.markup.linkTitle': 'Link to a URL',
  'canvas.markup.enterUrl': 'Enter a URL.',

  // ── The find bar ─────────────────────────────────────────────────────
  'canvas.find.placeholder': 'Find in documents',
  // The composed count follows the nav-pane precedent: the OUTER key
  // pluralizes on the match count and takes the page count as a finished
  // grammatical unit, so a translator controls both agreements.
  'canvas.find.summary_one': '{{count}} match on {{pages}}',
  'canvas.find.summary_other': '{{count}} matches on {{pages}}',
  'canvas.find.pageCount_one': '{{count}} page',
  'canvas.find.pageCount_other': '{{count}} pages',
  'canvas.find.noResults': 'No results',
  'canvas.find.invalidPattern': 'Invalid pattern',
  'canvas.find.patternTooSlow': 'Pattern too slow',
  'canvas.find.cursor': '{{current}}/{{total}}',
  'canvas.find.cursorTotal': '{{total}}',
  'canvas.find.prev': 'Previous match page (Shift+Enter)',
  'canvas.find.next': 'Next match page (Enter)',
  'canvas.find.ocrProgress': 'Recognizing {{count}}…',
  'canvas.find.ocrProgressTitle': 'Reading scanned pages',
  'canvas.find.ocrLanguage': 'OCR language for scanned pages',
  'canvas.find.applyOcrTitle':
    'Write the recognized text into the scanned pages as an invisible, searchable text layer',
  'canvas.find.applying': 'Applying…',
  'canvas.find.makeSearchable': 'Make searchable',
  'canvas.find.close': 'Close (Esc)',

  // ── The organizer's document header / row chrome ─────────────────────
  'canvas.doc.moveUp': 'Move up',
  'canvas.doc.moveDown': 'Move down',
  'canvas.doc.mergeUp': "Merge into the document above (copies this document's pages to its end)",
  'canvas.doc.remove': 'Remove document',
  'canvas.doc.addPages': 'Add pages from a file',
  'canvas.doc.addDocument': 'Add document',

  // ── Presentation view ────────────────────────────────────────────────
  'canvas.present.label': 'Presentation',
  'canvas.present.counter': '{{current}} / {{total}}',
  'canvas.present.exitTitle': 'Exit presentation (Esc)',
  'canvas.present.exitAria': 'Exit presentation',

  // ── The image/vector transform overlay handles ───────────────────────
  'canvas.imgtx.skew': 'Skew — drag along the edge',
  'canvas.imgtx.gradientStart': 'Gradient start',
  'canvas.imgtx.gradientEnd': 'Gradient end',
} as const;

export type CanvasKey = keyof typeof CANVAS_STRINGS;

/** The base ids of the plural pairs above (use with tChromeCount). */
export type CanvasPluralKey = {
  [K in CanvasKey]: K extends `${infer B}_one` ? B : never;
}[CanvasKey];
