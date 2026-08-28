// The CANVAS and its overlays: the contextual
// secondary toolbar, the page-cell editors and their annotation chrome, the
// image/vector transform overlays, the text-selection menu, the find bar, the
// document/presentation views and the drag hints that live over the page.
// Fifth typed record after i18n-chrome.ts, i18n-panels.ts,
// i18n-dialogs.ts and i18n-workbench.ts; same contract throughout —
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

  // ── The secondary toolbar ────────────────────────────────────────────
  // The mode group's label names the owning TOOL, so the tool name rides in
  // as a variable rather than being glued to the word "tools".
  'canvas.toolbar.modes': '{{tool}} tools',

  // The tool lock. Two labels rather than one with a state suffix: the button
  // says what it currently IS, and the hint says what that means.
  'canvas.toolbar.locked': 'Locked',
  'canvas.toolbar.unlocked': 'Unlocked',
  'canvas.toolbar.lockHint':
    'Keep the selected tool ready after each mark, so you can mark page after page without picking it again.',

  // Shape mode options (rung 2).
  'canvas.toolbar.shapeGroup': 'Shape',
  'canvas.shape.rect': 'Rectangle',
  'canvas.shape.ellipse': 'Ellipse',
  'canvas.shape.line': 'Line',
  'canvas.shape.arrow': 'Arrow',
  'canvas.shape.polygon': 'Polygon',
  'canvas.shape.polyline': 'Polyline',
  'canvas.shape.cloud': 'Cloud',

  // Measure — scale row + the calibration follow-up.
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

  // Edit tool — image/text/paragraph actions.
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

  // Blend modes. The option VALUE stays the PDF name; these are
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

  // Gradient fade mask.
  'canvas.edit.fade': 'Fade',
  'canvas.edit.fadeTitle': 'Gradient fade mask',
  'canvas.edit.fadeNone': 'None',
  'canvas.edit.fadeLinear': 'Linear',
  'canvas.edit.fadeRadial': 'Radial',
  'canvas.edit.fadeAlphaTitle': 'Fade start and end opacity (%)',

  // Align/distribute (multi-select). The GLYPHS are shared with the
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

  // Opacity.
  'canvas.edit.opacity': 'Opacity',
  'canvas.edit.opacityTitle': 'Image opacity',
  'canvas.edit.opacityValue': '{{value}}%',

  // ── Stamps ───────────────────────────────────────────────────────────
  // The built-in stamp WORDS localize: a stamp's label is placed INTO the
  // document as its appearance text, so an author working in Spanish is
  // stamping their own document in Spanish (the new-bookmark-name precedent).
  // Identity is the preset's stable `id`, never its label — a label-derived
  // test id or comparison is exactly the landmine this avoids.
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
  // The symbol palette inside the stamp picker.
  'canvas.stamp.symbols': 'Symbols…',
  'canvas.stamp.symbolsHint':
    'Vector symbols — drag one onto the page, or click to place it with the next click',

  // The personal-signature strip inside the stamp picker.
  'canvas.signature.group': 'My signatures',
  'canvas.signature.create': 'Create signature…',
  'canvas.signature.manage': 'Manage signatures…',
  'canvas.signature.arm': 'Place “{{name}}”',
  'canvas.signature.empty': 'No saved signatures yet',

  'canvas.toolbar.colorGroup': 'Annotation colour',

  // ── Properties bar ──────────────────────────────────────────────────
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
  'canvas.pbar.kind.count': 'Count mark',
  'canvas.pbar.kind.countlegend': 'Takeoff legend',
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
  'canvas.ocrSelect.busy': 'Recognizing text…',
  'canvas.pbar.newColor.inkhighlight': 'New freehand highlight color',
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

  // ── Read Out Loud ────────────────────────────────────────────────────
  // The transport bar. `×` in the speed values is notation — the same
  // multiplication sign in every locale, the measure-symbol rule — so only
  // the LABELS below carry keys.
  'canvas.readAloud.barLabel': 'Read Out Loud',
  'canvas.readAloud.pause': 'Pause',
  'canvas.readAloud.resume': 'Resume',
  'canvas.readAloud.previous': 'Previous sentence',
  'canvas.readAloud.next': 'Next sentence',
  'canvas.readAloud.stop': 'Stop reading',
  'canvas.readAloud.close': 'Close (Esc)',
  'canvas.readAloud.preparing': 'Preparing…',
  'canvas.readAloud.onPage': 'Page {{page}}',
  // Two readings of the same fact, because the reader is owed the
  // difference: a tagged page is read in the order its author declared, and
  // an untagged one in the order the text sits on the page.
  'canvas.readAloud.onPageTagged': 'Page {{page}} · tagged order',
  'canvas.readAloud.voice': 'Voice',
  'canvas.readAloud.voiceDefault': 'System default',
  'canvas.readAloud.rate': 'Speed',
  'canvas.readAloud.rateValue': '{{rate}}×',
  'canvas.readAloud.errorUnsupported': 'This window cannot speak text.',
  'canvas.readAloud.errorUnavailable': 'No speech voices are installed on this computer.',
  'canvas.readAloud.errorFailed': 'The speech synthesizer stopped unexpectedly.',
  'canvas.readAloud.errorLanguage': 'No installed voice speaks this document’s language.',
  'canvas.readAloud.errorVoice': 'The chosen voice is no longer installed.',
  'canvas.readAloud.errorBusy': 'The audio device is in use by something else.',
  // The tool arrives as a PLACEHOLDER, resolved through its own command
  // title, so the sentence names the tool by the name that tool carries in
  // the reader's language rather than by a second, drifting copy of it.
  'canvas.readAloud.errorNoText':
    'There is no readable text here — recognize the page first with {{tool}}.',

  // ── The organizer's document header / row chrome ─────────────────────
  'canvas.doc.moveUp': 'Move up',
  'canvas.doc.moveDown': 'Move down',
  'canvas.doc.mergeUp': "Merge into the document above (copies this document's pages to its end)",
  'canvas.doc.remove': 'Remove document',
  'canvas.doc.addPages': 'Add pages from a file',
  'canvas.doc.addDocument': 'Add document',
  // Shown on the drag ghost while the pointer is over a document drawn too
  // small at the current zoom for a drop position to be aimed at.
  'canvas.drop.refusedZoom': 'Too small to drop into — zoom in to place pages in this document',

  // ── Presentation view ────────────────────────────────────────────────
  'canvas.present.label': 'Presentation',
  'canvas.present.counter': '{{current}} / {{total}}',
  'canvas.present.exitTitle': 'Exit presentation (Esc)',
  'canvas.present.exitAria': 'Exit presentation',

  // ── The image/vector transform overlay handles ───────────────────────
  'canvas.imgtx.skew': 'Skew — drag along the edge',
  'canvas.imgtx.gradientStart': 'Gradient start',
  'canvas.imgtx.gradientEnd': 'Gradient end',

  // ── Form-widget overlays (on-canvas fill / sign) ─────────────────────
  // Every one of these was `${widget.fieldName} — <state>` in code. The FIELD
  // NAME is the document's own (never translated); the sentence around it is
  // ours, and it is one key so the name can move within it.
  'canvas.widget.pending': '{{field}} — filled, not yet applied',
  'canvas.widget.signHere': '{{field}} — click to sign this field',
  'canvas.widget.signed': '{{field}} — already signed',
  'canvas.widget.readonlySig': '{{field}} — read-only signature field',
  'canvas.widget.readonly': '{{field}} — read-only',
  'canvas.widget.calculated': '{{field}} — calculated by the form',
  'canvas.widget.radio': '{{field}}: {{option}}',
  'canvas.widget.radioUnmapped': '(unmapped option)',
  'canvas.widget.button': '{{field}} — {{action}}',
  // A button's own label is the kind it carries, named from the ONE table the
  // properties editor names it from (`ACTION_KIND_LABEL`) — a link keeps its
  // address, which is the only part of an action a hover needs to show.
  'canvas.widget.action.uri': 'links to {{uri}}',
  'canvas.widget.action.none': 'no action',
  'canvas.widget.badge.signHere': 'SIGN HERE',
  'canvas.widget.badge.signed': 'SIGNED',
  'canvas.widget.badge.signature': 'SIGNATURE',

  // ── Vector-object chrome ─────────────────────────────────────────────
  'canvas.editvec.shadingTitle':
    'A gradient fill has no flat colour to change — move or delete it',
  'canvas.editvec.shading': 'Gradient fill',
  'canvas.editvec.fillTitle': 'Fill colour',
  'canvas.editvec.fill': 'Fill',
  'canvas.editvec.strokeTitle': 'Stroke colour',
  'canvas.editvec.stroke': 'Line',
  'canvas.editvec.widthTitle': 'Line width',
  'canvas.editvec.width': 'W',
  // The object KIND (fill/stroke/shading/text) is the engine's own listing
  // vocabulary; the sentence and the nested clause are ours.
  'canvas.editvec.hit': 'Vector object ({{kind}})',
  'canvas.editvec.hitNested': 'Vector object ({{kind}}) — inside a group',
  'canvas.editvec.delete': 'Delete this vector object',

  // ── Annotation hover chrome ──────────────────────────────────────────
  'canvas.annot.recolorTo': 'Recolor to {{color}}',
  'canvas.annot.removeText': 'Remove text',
  'canvas.annot.removeDrawing': 'Remove drawing',
  'canvas.annot.removeStamp': 'Remove stamp',
  'canvas.annot.removeNote': 'Remove note',
  'canvas.annot.removeHighlight': 'Remove highlight',
  // One key per markup type: "Remove " + type is the banned concatenation,
  // and several languages inflect the verb with the object.
  'canvas.annot.removeMarkup.highlight': 'Remove highlight',
  'canvas.annot.removeMarkup.underline': 'Remove underline',
  'canvas.annot.removeMarkup.strikeout': 'Remove strikeout',
  'canvas.annot.removeMarkup.squiggly': 'Remove squiggly',

  // ── On-page placements and marks ─────────────────────────────────────
  'canvas.mark.redact': 'REDACT',
  'canvas.mark.redactRemove': 'Remove redaction mark',
  'canvas.mark.signature': 'SIGNATURE',
  'canvas.mark.signatureRemove': 'Remove signature placement',
  'canvas.mark.newField': 'NEW FIELD',
  'canvas.mark.newFieldRemove': 'Remove field placement',
  'canvas.candidate.remove': 'Discard this suggested field',
  'canvas.tableReview.accept': 'Include this table in the spreadsheet',
  'canvas.tableReview.reject': 'Leave this table out of the spreadsheet',
  'canvas.tableReview.untitled': 'Table',
  'canvas.mark.newText': 'NEW TEXT',
  'canvas.mark.newTextRemove': 'Remove text placement',
  'canvas.mark.keep': 'KEEP',
  'canvas.mark.cropRemove': 'Remove crop rectangle',

  // ── Snapshot ─────────────────────────────────────────────────────────
  'canvas.snapshot.copied': 'COPIED {{width}} × {{height}}',
  'canvas.snapshot.save': 'Save image…',
  'canvas.snapshot.dismiss': 'Dismiss the snapshot',
  'canvas.snapshot.failed': 'The snapshot could not be copied: {{message}}',

  // ── Edit-tool object hit targets ─────────────────────────────────────
  'canvas.editimg.vector': 'Vector graphic',
  'canvas.editimg.nested': 'Image (inside a form)',
  'canvas.editimg.image': 'Image',
  'canvas.editpara.hit': 'Paragraph — double-click to edit',

  // ── The paragraph editor (9.A/9.K) ───────────────────────────────────
  'canvas.editpara.resizeGrip': 'Drag to resize the paragraph box',
  'canvas.editpara.resizeReadout': '{{width}} pt',
  'canvas.editpara.styleGroup': 'Text style',
  'canvas.editpara.size': 'Size',
  'canvas.editpara.sizeTitle':
    'With text selected, sizes the selection; otherwise the whole paragraph',
  'canvas.editpara.splitGap': 'Split gap',
  'canvas.editpara.splitGapTitle':
    'Gap between the halves when Enter splits inside the text (× line height)',
  'canvas.editpara.dragToAdjust': 'Drag to adjust',
  'canvas.editpara.colour': 'Colour',
  'canvas.editpara.colourTitle':
    'With text selected, recolours the selection; otherwise the whole paragraph',
  'canvas.editpara.font': 'Font',
  'canvas.editpara.keepFont': 'Keep original font',
  // FACE NAMES (Liberation Sans, an installed family) are proper nouns and
  // stay verbatim; the GROUP headings are ours.
  'canvas.editpara.bundled': 'Bundled',
  'canvas.editpara.installed': 'Installed',
  'canvas.editpara.installedRestricted': 'Installed ({{count}} not shown — licence)',
  // Vertical text CAN be restyled: the weight axis is real and an
  // installed vertical face is a first-class choice. What stays
  // unavailable is stated as the ABSENCE it is — no bundled vertical
  // family, and no feature request on a vertical embed.
  'canvas.editpara.verticalNoBundledFace':
    'No bundled face draws vertical text except the CJK one — pick an installed face with vertical metrics',
  'canvas.editpara.verticalSmallCaps':
    'Small caps are not applied to vertical text — the column embeds the face’s upright forms',
  'canvas.editpara.verticalAlternates':
    'Stylistic alternates are not applied to vertical text — the column embeds the face’s upright forms',
  'canvas.editpara.familyTitle': "Replaces the paragraph's font with the chosen bundled face",
  // Single-letter style buttons: they are ABBREVIATED WORDS (bold, italic,
  // small caps, alternates), not symbols — Spanish writes N and K — so they
  // localize while their stable test ids do not.
  'canvas.editpara.bold': 'B',
  'canvas.editpara.boldTitle': 'Bold — substitutes the bundled bold face',
  'canvas.editpara.italic': 'I',
  'canvas.editpara.italicTitle': 'Italic — substitutes the bundled italic face',
  'canvas.editpara.smallCaps': 'SC',
  'canvas.editpara.smallCapsTitle':
    'Small caps — uses the font’s own if it has them, else Libertinus Serif',
  'canvas.editpara.alternates': 'Alt',
  'canvas.editpara.alternatesTitle':
    'Stylistic alternates (salt) — uses the font’s own if it has them, else Libertinus Serif',
  'canvas.editpara.altIndexTitle': 'Which stylistic alternate to use, when the font offers several',
  'canvas.editpara.textAria': 'Paragraph text',
  // The missing characters arrive already quoted and joined — one finished
  // unit, so the sentence around them is a single key.
  'canvas.editpara.missingGlyphs': "This document's font does not contain {{chars}}",
  'canvas.editpara.useCompatibleFont': 'Use a compatible font',

  // ── The inline text-run editor ───────────────────────────────────────
  'canvas.edittext.sizePlaceholder': '{{size}}pt',
  'canvas.edittext.keepColour': 'Keep current colour',
  'canvas.edittext.colour': 'Colour {{color}}',
  'canvas.edittext.applyStyle': 'Apply style',

  // ── The workspace canvas view ────────────────────────────────────────
  'canvas.view.noDocuments': 'No documents open',
  'canvas.view.dropHint': 'Drop PDF files anywhere, or open them to lay them out here',
  'canvas.view.openPdf': 'Open PDF',
  // The engine opened these documents and the renderer cannot draw them. Said
  // in the canvas, in place, because that is the only thing that is broken:
  // the documents stay open and the panels keep working.
  'canvas.unrenderable': 'The pages of {{names}} could not be displayed.',

  // Measure re-calibration popover. The CURRENT note is the engine's own
  // formatted measurement and passes through verbatim.
  'canvas.recal.areaTitle': 'This area measures',
  'canvas.recal.distanceTitle': 'This distance measures',
  'canvas.recal.now': '(now: {{note}})',
  // "sq" + the unit symbol: the word is ours, the symbol is notation.
  'canvas.recal.sqUnit': 'sq {{unit}}',
  'canvas.recal.override': 'Override this measurement',
  'canvas.recal.setScale': 'Set scale from it',

  // Edit-tool notices. `canvas.edit.cancelled` was ELEVEN copies of one
  // literal; the engine's own refusal text still passes through verbatim.
  'canvas.edit.cancelled': 'Edit cancelled — the document was left unchanged.',
  'canvas.edit.textNotEditable': 'This text is not editable.',
  'canvas.edit.imagePageGone': 'The page this image was placed on no longer exists.',

  // Multi-file failures. The per-file line is one shared shape (file name +
  // the ENGINE's own message, verbatim); each op's banner is its own whole
  // sentence around the joined reasons — never a glued suffix.
  'canvas.common.fileFailure': '{{name}}: {{message}}',
  // The title over a document's own `app.alert` text. The body is the
  // document author's words, never this app's.
  'canvas.forms.scriptAlertTitle': 'Message from this form',
  'canvas.forms.fillFailed': 'Filling failed — {{reasons}}. Those values are still pending.',
  'canvas.ocr.applyFailed': 'Applying OCR text failed — {{reasons}}',
  'canvas.ocr.skipped_one': '{{count}} scanned page skipped (no longer available)',
  'canvas.ocr.skipped_other': '{{count}} scanned pages skipped (no longer available)',
  'canvas.ocr.noReadyPages': 'no OCR-ready pages to apply',
  'canvas.redact.failed': 'Redaction failed — {{reasons}}. Those marks are still pending.',
  'canvas.redact.failedSingle': 'Redaction failed — {{reasons}}. The marks are still pending.',
  'canvas.redact.saveMarksFailed': 'Saving marks failed — {{reasons}}.',
  // The stored /Redact set could not be read back in full. Both of these
  // exist so a PARTIAL seed can never look like a complete one — the engine
  // refuses when a mark will not resolve, and the seed itself counts marks
  // whose page this view no longer has.
  'canvas.redact.seedFailed':
    "{{name}}: the saved redaction marks could not be read — {{message}} Marks you draw now still apply; the file's stored ones are not shown.",
  'canvas.redact.seedOrphaned_one':
    '{{name}}: {{count}} saved redaction mark is not shown — its page is no longer in this document.',
  'canvas.redact.seedOrphaned_other':
    '{{name}}: {{count}} saved redaction marks are not shown — their pages are no longer in this document.',
  'canvas.doc.mergedCannotClose':
    '"{{name}}" is merged into another document — Apply changes first, then close it.',

  // Link authoring refusals.
  'canvas.link.pagesGone': 'Those pages are no longer in the document.',
  'canvas.link.nothingSelected': 'Nothing selected to link.',
  'canvas.link.regionTitle': 'Edit this link',
  'canvas.link.seedFailed':
    '{{name}}: the document’s links could not be read — {{message}} Links you draw now still work; the existing ones are not shown on the page.',
  'canvas.link.seedOrphaned_one':
    '{{name}}: {{count}} link is not shown on the page — its page is no longer in this document.',
  'canvas.link.seedOrphaned_other':
    '{{name}}: {{count}} links are not shown on the page — their pages are no longer in this document.',

  // The on-canvas sign card.
  'canvas.sign.fieldTitle': 'Sign field "{{field}}"',
  'canvas.sign.stampTitle': 'Sign with a visible stamp',
  'canvas.sign.fieldBlurb':
    'The signature fills this existing field (its own box is the stamp); the signed copy is written to a NEW file — this file is left unchanged.',
  'canvas.sign.stampBlurb':
    'The stamp is drawn at the box you placed; the signed copy is written to a NEW file — this file is left unchanged.',
  'canvas.sign.password': 'Password',
  'canvas.sign.reason': 'Reason',
  'canvas.sign.location': 'Location',
  'canvas.sign.optional': 'optional',
  'canvas.sign.signing': 'Signing…',
  'canvas.sign.apply': 'Sign & Save…',
  'canvas.sign.enterPassword': 'Enter the signer password.',
  'canvas.sign.applyEditsFirst': 'Apply the pending page changes first, then sign the field.',
  'canvas.sign.pageChanged': 'The page this signature was placed on changed — draw the box again.',
  'canvas.sign.pageGone': 'The page this signature was placed on no longer exists.',
  'canvas.sign.fileClosed': 'The file this signature was placed on is no longer open.',
  // The done banner was FOUR JSX fragments glued around a <strong> — one
  // sentence per outcome now, the emphasis dropped for translatability (the
  // Settings licence-notice precedent).
  'canvas.sign.doneOk':
    'Signed as {{signer}} — valid, covers the whole document. Saved to {{output}}',
  'canvas.sign.doneBad':
    'Signed as {{signer}} — but the signature did not verify as expected. Saved to {{output}}',
  'canvas.sign.unknownSigner': '(unknown)',

  // The new-form-field card.
  'canvas.newfield.title': 'New form field',
  'canvas.newfield.blurb': 'The field is created at the box you placed and is fillable right away.',
  'canvas.newfield.name': 'Name',
  'canvas.newfield.type': 'Type',
  'canvas.newfield.type.text': 'Text',
  'canvas.newfield.type.checkbox': 'Checkbox',
  'canvas.newfield.type.radio': 'Radio group',
  'canvas.newfield.type.dropdown': 'Dropdown',
  'canvas.newfield.type.optionlist': 'Option list',
  'canvas.newfield.type.signature': 'Signature (empty)',
  'canvas.newfield.multiline': 'Multiline',
  'canvas.newfield.comb': 'One box per character',
  'canvas.newfield.maxLength': 'Character limit',
  // Direction and the script it binds. Two choices only, as elsewhere: the
  // column direction is a property of the script, not a thing to pick.
  'canvas.newfield.writingMode': 'Direction',
  'canvas.newfield.writingMode.horizontal': 'Horizontal',
  'canvas.newfield.writingMode.vertical': 'Vertical',
  'canvas.newfield.writingModeTitle':
    'A vertical field reads down its box and fills across it. Its typed value is drawn in the script chosen below.',
  'canvas.newfield.script': 'Script',
  'canvas.newfield.scriptTitle':
    'The character collection the field is bound to — a vertical field is bound to exactly one.',
  'canvas.newfield.script.japanese': 'Japanese',
  'canvas.newfield.script.simplifiedChinese': 'Simplified Chinese',
  'canvas.newfield.script.traditionalChinese': 'Traditional Chinese',
  'canvas.newfield.script.korean': 'Korean',
  'canvas.newfield.options': 'Options',
  'canvas.newfield.optionsPlaceholder': 'one per line (or comma-separated)',
  'canvas.newfield.creating': 'Creating…',
  'canvas.newfield.create': 'Create field',
  'canvas.newfield.pageChanged': 'The page this field was placed on changed — draw the box again.',
  'canvas.newfield.pageGone': 'The page this field was placed on no longer exists.',

  // The add-text card.
  'canvas.addtext.title': 'Add text',
  'canvas.addtext.blurb':
    'Text fills the box you drew and wraps to its width. It stays searchable and editable.',
  'canvas.addtext.placeholder': 'Type the text to add…',
  'canvas.addtext.spans': 'Spans',
  'canvas.addtext.spansTitle': 'Select text above, choose a look, then Style selection',
  'canvas.addtext.sizePlaceholder': 'size',
  'canvas.addtext.styleSelection': 'Style selection',
  'canvas.addtext.selectTextFirst': 'Select some text above first, then apply the span style.',
  'canvas.addtext.pickAStyleFirst': 'Pick a size, colour, or style for the span first.',
  // The span CHIP is a compact symbolic readout: the range is notation, and
  // each optional segment is its own finished unit (the Comments panel's
  // "(N skipped)" suffix precedent), never an English fragment glued in code.
  'canvas.addtext.spanRange': '{{start}}–{{end}}',
  'canvas.addtext.spanSize': ' · {{size}}pt',
  'canvas.addtext.spanBold': ' · B',
  'canvas.addtext.spanItalic': ' · I',
  'canvas.addtext.spanChipTitle': '"{{text}}"',
  'canvas.addtext.font': 'Font',
  'canvas.addtext.family.sans': 'Sans-serif',
  'canvas.addtext.family.serif': 'Serif',
  'canvas.addtext.family.mono': 'Monospace',
  'canvas.addtext.writingMode': 'Direction',
  'canvas.addtext.writingMode.horizontal': 'Horizontal',
  'canvas.addtext.writingMode.vertical': 'Vertical',
  'canvas.addtext.writingModeTitle':
    'Vertical text reads down the height of the box you drew, and its columns fill across its width.',
  'canvas.addtext.columnsRtl': 'Columns run right to left.',
  'canvas.addtext.columnsLtr': 'Columns run left to right.',
  'canvas.addtext.verticalNoBundledFace':
    'Vertical text uses the bundled vertical face — no vertical serif or monospace is available.',
  'canvas.addtext.verticalNoFeatures':
    'Small caps and alternates do not apply to vertical text.',
  'canvas.addtext.verticalNoRotate':
    'A vertical box already turns the reading direction, so it cannot also be rotated.',
  'canvas.addtext.size': 'Size',
  'canvas.addtext.degrees': '{{deg}}°',
  'canvas.addtext.rotateTitle':
    'Rotation — cycle the quarter turns (the field beside takes any angle)',
  'canvas.addtext.rotateDegTitle':
    'Rotation in degrees — any angle; quarter turns keep the reading-direction layout',
  'canvas.addtext.bold': 'B',
  'canvas.addtext.boldTitle': 'Bold — authors in the bundled bold face',
  'canvas.addtext.kern': 'AV',
  'canvas.addtext.kernTitle':
    "Kerning — tightens pairs like AV and To using the face's own metrics",
  'canvas.addtext.italic': 'I',
  'canvas.addtext.italicTitle': 'Italic — authors in the bundled italic face',
  'canvas.addtext.smallCaps': 'Sc',
  'canvas.addtext.smallCapsTitle':
    'Small caps — authors in Libertinus Serif (carries real small caps)',
  'canvas.addtext.alternates': 'Alt',
  'canvas.addtext.alternatesTitle': 'Stylistic alternates (salt) — authors in Libertinus Serif',
  'canvas.addtext.altIndexTitle': 'Which stylistic alternate to use, when the face offers several',
  'canvas.addtext.colour': 'Colour',
  'canvas.addtext.overflow': 'The text extends below the box — it will continue past it.',
  'canvas.addtext.adding': 'Adding…',
  'canvas.addtext.enterText': 'Enter some text to add.',
  'canvas.addtext.pageChanged': 'The page this text was placed on changed — draw the box again.',
  'canvas.addtext.pageGone': 'The page this text was placed on no longer exists.',

  // Snapping. The TYPE names double as the marker badge and as
  // what the aria-live announcement reads out — one string, two surfaces, so
  // a reader hearing "Endpoint" and a reader seeing it are told the same
  // thing. The keyboard modifiers (Alt/Tab) are key NAMES, not translatable
  // copy, and ride in as variables.
  'canvas.snap.type.endpoint': 'Endpoint',
  'canvas.snap.type.intersection': 'Intersection',
  'canvas.snap.type.midpoint': 'Midpoint',
  'canvas.snap.type.center': 'Centre',
  'canvas.snap.type.guide': 'Guide',
  'canvas.snap.type.grid': 'Grid',
  'canvas.snap.type.edge': 'Edge',
  'canvas.snap.announce': 'Snapped to {{type}}',

  // Rulers, grid and guides. The ruler's NUMBERS go through
  // `tNumber` and its unit symbol is notation (ft/in/mm), so neither carries
  // a key; what localizes is the furniture around them — the accessible
  // names, and the guide's own announcement when one is placed or removed.
  'canvas.rulers.horizontal': 'Horizontal ruler',
  'canvas.rulers.vertical': 'Vertical ruler',
  'canvas.rulers.dragHint': 'Drag from a ruler onto the page to place a guide',
  'canvas.grid.label': 'Drawing grid',
  'canvas.guides.layer': 'Guides',
  'canvas.guides.placed': 'Guide placed',
  'canvas.guides.removed': 'Guide removed',

  // The redaction confirm — the one canvas action that destroys content.
  'canvas.redact.title': 'Redact content',
  // Two counts, one sentence: the outer key agrees with the REGION count and
  // takes the already-pluralized page phrase as a finished unit.
  'canvas.redact.confirm_one':
    'Permanently remove the content under {{count}} marked region across {{pages}}?',
  'canvas.redact.confirm_other':
    'Permanently remove the content under {{count}} marked regions across {{pages}}?',
  'canvas.redact.pageCount_one': '{{count}} page',
  'canvas.redact.pageCount_other': '{{count}} pages',
  'canvas.redact.warning':
    "Text and images under each region are removed from the file's content, not just covered. Undo can restore the file while it stays open; once saved, the content is gone for good.",
  'canvas.redact.apply': 'Redact',

  // Count & takeoff. The GROUP NAME is user data and is never
  // translated — it lands in /Subj and in the mark's "<group> <seq>" contents
  // verbatim, the measure format-string rule. Only the chrome around it
  // localizes: the strip's picker and its hints.
  'canvas.count.groupPicker': 'Count group',
  'canvas.count.armTitle': 'Count into “{{group}}”',
  'canvas.count.noGroups': 'Add a count group in the Count & Takeoff panel',
} as const;

export type CanvasKey = keyof typeof CANVAS_STRINGS;

/** The base ids of the plural pairs above (use with tChromeCount). */
export type CanvasPluralKey = {
  [K in CanvasKey]: K extends `${infer B}_one` ? B : never;
}[CanvasKey];
