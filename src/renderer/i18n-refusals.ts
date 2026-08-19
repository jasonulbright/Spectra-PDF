// The RENDERER's own refusal messages, sixth typed
// record after chrome / panels / dialogs / workbench / canvas.
//
// The boundary this record names, and why it is separate from the
// `engine.*` keys: an ENGINE refusal is English at the engine (the CLI, the
// operation log and the fingerprint text stay byte-stable) and is recognized
// at the bridge through the checked-in message table. These are the OTHER
// half — refusals the renderer itself throws, in leaf libs and in the App/
// panel handlers, which reach the user through the same `e.message` display
// sites. Nothing recognizes them at a bridge because nothing has to: they
// are ours, so they resolve through the catalog at the point they are built.
//
// Same contract as every other record: this file carries the English, the en
// catalog is GENERATED from it, and every shipped locale's key set equals
// en's exactly.
//
// Two things stay VERBATIM inside these messages on purpose:
//   • an ACTION FILE's own vocabulary — the `op` id and the parameter names
//     an imported JSON carries (`add_header_footer`, `gs_path`). Translating
//     one would name a key that does not exist in the file the reader is
//     being asked to fix.
//   • a FILE PATH.
// Both ride `{{var}}` placeholders; no message is composed from fragments.
export const REFUSAL_STRINGS = {
  // ── Guided actions: the editor's own validation ──────────────────────
  'refusal.action.needsName': 'The action needs a name.',
  'refusal.action.needsStep': 'Add at least one step.',
  'refusal.action.unknownOp': 'Step {{index}} names an unknown operation.',
  'refusal.action.paramRequired': 'Step {{index}} ({{step}}): {{param}} is required.',
  'refusal.action.terminalNotLast':
    '{{step}} writes a new file and must be the last step.',
  'refusal.action.sourceNotFirst':
    '{{step}} produces the document the rest of the action works on, so it must be the first step.',
  'refusal.action.sourceNeedsFolder':
    '{{step}} creates a document, so this action runs over a folder of files rather than against the document you have open.',
  'refusal.action.sourceNotInPlace':
    '{{step}} creates a new document, so this action cannot replace the original files.',
  'refusal.action.exportNotInPlace':
    '{{step}} writes a file of another kind, so this action cannot replace the original files.',
  'refusal.action.paramOneOf': 'Step {{index}} ({{step}}): set {{params}} — exactly one of them.',
  'refusal.action.runParamRequired': '{{step}}: {{param}} is required.',
  'refusal.action.runParamOneOf': '{{step}}: set {{params}} — exactly one of them.',
  'refusal.action.encryptNeedsPassword': 'Encrypt: set an open or an owner password.',
  'refusal.action.needsGhostscript':
    '{{steps}} need Ghostscript, which Spectra PDF does not include. Install it and point Spectra PDF at it in Settings ▸ Engine, or take those steps out of this action.',
  'refusal.action.needsGhostscriptOne':
    '{{steps}} needs Ghostscript, which Spectra PDF does not include. Install it and point Spectra PDF at it in Settings ▸ Engine, or take that step out of this action.',

  // ── Guided actions: importing an action FILE ─────────────────────────
  'refusal.actionFile.notJson': 'Not a valid JSON file.',
  'refusal.actionFile.notAnActionFile':
    'Not an action file — expected an object with "name" and "steps".',
  'refusal.actionFile.stepNotObject': 'Step {{index}} is not a step object.',
  'refusal.actionFile.unknownOp': "Step {{index}}: unknown operation '{{op}}'.",
  'refusal.actionFile.paramsNotObject':
    'Step {{index}} ({{op}}): params must be an object.',
  'refusal.actionFile.placementsConflict':
    'Step {{index}} ({{op}}): use placements or position/text, not both.',
  'refusal.actionFile.placementsEmpty':
    'Step {{index}} ({{op}}): placements must be a non-empty list.',
  'refusal.actionFile.placementsMulti':
    'Step {{index}} ({{op}}): only one placement per step is editable here — split into one step per position.',
  'refusal.actionFile.placementsShape':
    'Step {{index}} ({{op}}): placements must be a list of {position, text}.',
  'refusal.actionFile.unknownParams':
    'Step {{index}} ({{op}}): unknown parameter(s) [{{params}}].',
  'refusal.actionFile.paramType':
    "Step {{index}} ({{op}}): parameter '{{param}}' must be text or a number.",
  'refusal.actionFile.invalidValue':
    "Step {{index}} ({{op}}): invalid value '{{value}}' for '{{param}}'.",
  'refusal.actionFile.askNotList':
    'Step {{index}} ({{op}}): "ask" must be a list of parameter names.',

  // ── Form-field authoring: the spec problems ──────────────────────────
  // Reported ALL AT ONCE (the engine ops' fail-closed posture), so each one
  // is its own key and FieldSpecError joins them — a joined sentence would
  // be one key carrying several unrelated grammars.
  'refusal.field.nameRequired': 'A field name is required.',
  'refusal.field.nameDot':
    'Field names cannot contain "." (it separates parent and child names).',
  'refusal.field.pageOutOfRange': 'Page {{page}} is out of range (1-{{count}}).',
  'refusal.field.rectEmpty': 'The field rectangle is empty.',
  'refusal.field.needsOption': 'This field type needs at least one option.',
  'refusal.field.optionsUnique': 'Options must be unique.',
  'refusal.field.nameExists': 'A field named "{{name}}" already exists.',
  'refusal.field.optionRectsPartial':
    'Either every option carries its own rectangle, or none of them do.',
  'refusal.field.combNeedsMaxLength':
    'A comb field needs a character count to divide its box into.',
  'refusal.field.combNotMultiline': 'A comb field holds one line, so it cannot be multiline.',
  'refusal.field.maxLengthPositive': 'The character limit must be at least 1.',
  // The writing mode. A field states it in the CMap of the font its default
  // appearance names, so every rule here is about what a font can express.
  'refusal.field.writingKindOnly':
    'Only a text, dropdown or option-list field can write vertically — the others draw a mark rather than text.',
  'refusal.field.scriptRequired':
    'A vertical field needs the script naming the character collection its font is bound to.',
  'refusal.field.scriptOnHorizontal':
    'A script belongs to a vertical field, and this field writes horizontally.',
  'refusal.field.combNotVertical':
    'A comb field divides its box across the axis a column runs down, so it cannot also write vertically.',
  'refusal.field.lockNotSignature': 'Only a signature field can lock form fields.',
  'refusal.field.lockTakesNoFields':
    'A lock covering every form field takes no field names.',
  'refusal.field.lockNeedsFields': 'Choose at least one form field to lock.',
  'refusal.field.lockUnknownField':
    'There is no form field named "{{name}}", so that field cannot be locked.',
  'refusal.field.lockSelf':
    'A signature field cannot lock itself: "{{name}}" names the field being signed.',
  // Format, Validate and Calculate. The kind rules are about what a field can
  // hold; the rest are conditions the script emitter states.
  'refusal.field.formatKindOnly':
    'Only a text or dropdown field can carry a format or an accepted range.',
  'refusal.field.calculateKindOnly': 'Only a text field can be calculated.',
  'refusal.field.defaultOnSignature': 'A signature field has no default value.',
  'refusal.field.formatUnknown': '"{{value}}" is not a format this app writes.',
  'refusal.field.formatSetting': '"{{value}}" is not a setting this format has.',
  'refusal.field.maskRequired': 'This format needs a mask.',
  'refusal.field.rangeNeedsBound':
    'An accepted range needs a smallest value, a largest value, or both.',
  'refusal.field.rangeNotNumber': 'A range bound must be a number.',
  'refusal.field.rangeInverted':
    'The smallest accepted value cannot be larger than the largest.',
  'refusal.field.calcUnknown': '"{{value}}" is not a calculation this app writes.',
  'refusal.field.calcNeedsFields': 'Choose at least one field to calculate from.',
  'refusal.field.sfnEmpty': 'Enter the expression this field is calculated from.',
  'refusal.field.sfnUnreadable': 'This expression cannot be read: {{value}}',
  'refusal.field.calcUnknownField':
    'The calculation names "{{name}}", which this document does not have.',
  'refusal.field.calcCycle': 'The calculation depends on itself through {{chain}}.',
  // A batch reports every problem at once, so each one says which field it is
  // about; the parts stay separate keys because only the wrapper is a sentence.
  'refusal.field.inField': '{{field}}: {{problem}}',

  // ── Workspace / file handlers ────────────────────────────────────────
  'refusal.commit.sourceClosed':
    'Cannot commit: source file is no longer open ({{path}})',
  'refusal.file.noLongerOpen': 'The file is no longer open.',
  'refusal.file.noActiveDocument': 'No active document.',
  'refusal.file.noActiveToSign': 'No active file to sign.',

  // ── Symbol sets: importing a set FILE ────────────────────────────────
  // The guided-actions import shape exactly: one interpolated key per
  // problem, naming the offending SYMBOL ID (the file's own vocabulary, so it
  // stays verbatim — a translated id would name something the file being
  // fixed does not contain). A refused file imports nothing.
  'refusal.symbolSet.notJson': 'Not a valid JSON file.',
  'refusal.symbolSet.notASet':
    'Not a symbol set — expected an object with "name" and "symbols".',
  'refusal.symbolSet.noSymbols': 'The set contains no symbols.',
  'refusal.symbolSet.tooManySymbols': 'A set may hold at most {{max}} symbols.',
  'refusal.symbolSet.setId':
    'The set id may use only letters, digits, dot, dash and underscore.',
  'refusal.symbolSet.builtinId':
    '"{{id}}" is a built-in set — give the imported set its own id.',
  'refusal.symbolSet.symbolShape': 'Symbol {{index}} is not a symbol object.',
  'refusal.symbolSet.symbolId':
    'Symbol {{index}} needs an id of letters, digits, dot, dash or underscore.',
  'refusal.symbolSet.duplicateId': 'The set uses the id "{{id}}" twice.',
  'refusal.symbolSet.idInUse': 'The id "{{id}}" is already used by the set {{set}}.',
  'refusal.symbolSet.parts':
    'Symbol "{{id}}": every part must be a poly or circle drawn inside the unit square.',

  // ── Scanner ──────────────────────────────────────────────────────────
  // The device layer refuses with a stable KEY beside its English sentence,
  // so these resolve from the catalog and nothing matches a message. The key
  // set is pinned across the two languages by
  // `tests/fixtures/scan-refusal-keys.json`, which both suites read.
  'refusal.scan.busy': 'A scan is already running on this scanner.',
  'refusal.scan.cancelledAtDevice': 'The scan was cancelled at the scanner.',
  'refusal.scan.coverOpen': 'Close the scanner cover.',
  'refusal.scan.deviceBusy': 'The scanner is busy. Try again in a moment.',
  'refusal.scan.deviceGone': 'The scanner is no longer connected.',
  'refusal.scan.deviceLocked': 'Another program is using the scanner.',
  'refusal.scan.deviceOffline': 'The scanner is turned off or cannot be reached.',
  'refusal.scan.driverError': 'The scanner driver reported a problem.',
  'refusal.scan.failed': 'The scanner reported an error.',
  'refusal.scan.feederEmpty': 'Put paper in the feeder.',
  'refusal.scan.needsAttention': 'The scanner needs attention at the device.',
  'refusal.scan.notResponding': 'The scanner stopped responding.',
  'refusal.scan.paperJam': 'Clear the paper jam, then scan again.',
  'refusal.scan.paperProblem': 'Check the paper in the feeder.',
  'refusal.scan.settingRejected': 'The scanner rejected one of the requested settings.',
} as const;

export type RefusalKey = keyof typeof REFUSAL_STRINGS;
