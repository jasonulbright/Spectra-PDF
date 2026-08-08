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
  'refusal.action.paramOneOf': 'Step {{index}} ({{step}}): set {{params}} — one of them, not both.',
  'refusal.action.runParamRequired': '{{step}}: {{param}} is required.',
  'refusal.action.runParamOneOf': '{{step}}: set {{params}} — one of them, not both.',
  'refusal.action.encryptNeedsPassword': 'Encrypt: set an open or an owner password.',

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
  'refusal.field.lockNotSignature': 'Only a signature field can lock form fields.',
  'refusal.field.lockTakesNoFields':
    'A lock covering every form field takes no field names.',
  'refusal.field.lockNeedsFields': 'Choose at least one form field to lock.',
  'refusal.field.lockUnknownField':
    'There is no form field named "{{name}}", so that field cannot be locked.',
  'refusal.field.lockSelf':
    'A signature field cannot lock itself: "{{name}}" names the field being signed.',
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
} as const;

export type RefusalKey = keyof typeof REFUSAL_STRINGS;
