// Guided actions sequence model. This leaf module uses localStorage and pure
// helpers so the
// catalog integrity, validation, and param mapping are unit-testable (no DOM
// test environment; the breakable part must be the testable part).
//
// An action is a named, ordered list of steps; every step is an EXISTING
// gated engine op with a compact param form. The runner (the panel) drives
// each step through the standard snapshot → call → reload shape, so a run is
// undoable step-by-step and stops on the first failure. Deliberately NO new
// engine surface: the catalog is a curation over ops that already ship.

import { OCR_LANGUAGES } from '../ocr/languages';
// The unattended-run refusal is USER-FACING copy, so it resolves
// through the catalog. That is the one non-pure import here — i18n is
// itself a data module (catalogs + i18next), so the helpers below stay
// unit-testable with no DOM.
import { tChrome, tStepParam, tStepTitle } from '../i18n';
// The export targets' table is the one declaration of what each target takes;
// a second list here would drift from the engine's own refusals.
import { EXPORT_TARGETS, exportParams, type ExportFormat } from './export-targets';
import { pagesParam } from './page-scope';

// Slice 2 grew the catalog: OCR (the batch pipeline's single-file arm),
// header/footer (one positioned text per step — several positions compose as
// several steps), and ENCRYPT as a TERMINAL step that writes a NEW picked
// file (an in-place encrypt would make the open working copy unreadable,
// which is why it is excluded; EncryptPanel has the same shape).
// One step PRODUCES a document rather than transforming one: `create_pdf`. It is why `StepDef` grew `sourceStep` —
// see that field, and `openDocumentBlocker` / `inPlaceBlocker` below.
export type GuidedStepOp =
  | 'create_pdf'
  | 'compress'
  | 'optimize'
  | 'grayscale'
  | 'convert_pdfa'
  | 'preflight'
  | 'strip_metadata'
  | 'sanitize'
  | 'search_redact'
  | 'prepare_forms'
  | 'links_from_urls'
  | 'outline_from_structure'
  | 'watermark'
  | 'ocr_file'
  | 'enhance_scan'
  | 'add_header_footer'
  | 'encrypt'
  | 'create_pdf_folders'
  | 'export_document'
  | 'export_images';

export interface GuidedStep {
  op: GuidedStepOp;
  params: Record<string, string | number>;
  /** Param keys collected at RUN time instead of stored (ask-at-run).
   * `secret` params are implicitly always here and never persisted. */
  ask?: string[];
}

export interface GuidedAction {
  id: string;
  name: string;
  steps: GuidedStep[];
}

export interface StepParamDef {
  key: string;
  label: string;
  kind: 'text' | 'password' | 'select' | 'number';
  options?: readonly { value: string; label: string }[];
  defaultValue: string | number;
  /** Refused empty at validate (e.g. a watermark with no text). An asked
   * param's emptiness is checked at the PRE-RUN form instead. */
  required?: boolean;
  /** Never persisted, always collected at run time (passwords). */
  secret?: boolean;
  /** Editor hint under the input (token syntax etc.). */
  hint?: string;
  min?: number;
  max?: number;
  step?: number;
}

export interface StepDef {
  op: GuidedStepOp;
  title: string;
  /** The step's engine call takes gs_path (the panel resolves it once per run). */
  needsGs?: boolean;
  /** The step's engine call takes font_dir (Unicode text faces). */
  needsFontDir?: boolean;
  /** The step's engine call takes tesseract_path (OCR). */
  needsTesseract?: boolean;
  /** The step's engine call takes soffice_path (the bridged export targets). */
  needsSoffice?: boolean;
  /** The step writes a NEW file picked at run time instead of the working
   * copy (encrypt); must be the LAST step and never mutates the open doc. */
  terminalOutput?: boolean;
  /**
   * The step PRODUCES the document the rest of the action works on
   * (`create_pdf`) rather than transforming one.
   *
   * Three consequences, all enforced rather than documented — and all
   * mirrored by `engine/guided_actions.py`, which is the half a CLI or a
   * scheduled run reaches without passing through this editor at all:
   * it must be the FIRST step, the action cannot run against the open
   * document (there is nothing for it to create FROM), and it cannot run
   * in place (the converted document is a new file, not a replacement).
   */
  sourceStep?: boolean;
  /** Reshape the flat form params into the engine call's shape (e.g. the
   * header/footer position+text pair into its `placements` list). */
  mapParams?: (params: Record<string, string | number>) => Record<string, unknown>;
  /** Param keys of which EXACTLY ONE carries a value (watermark's text or
   * image source). A `required` flag cannot express it: neither key is
   * required on its own, and both together is as wrong as neither.
   * `engine/guided_actions.py` enforces the same pairs, so an exported
   * action file cannot run headlessly in a shape the editor refuses. */
  requireOneOf?: readonly string[];
  params: readonly StepParamDef[];
}

export const STEP_CATALOG: readonly StepDef[] = [
  {
    op: 'compress',
    title: 'Compress',
    needsGs: true,
    params: [
      {
        key: 'quality',
        label: 'Quality',
        kind: 'select',
        options: [
          { value: 'screen', label: 'Screen (72 dpi)' },
          { value: 'ebook', label: 'Ebook (150 dpi)' },
          { value: 'printer', label: 'Printer (300 dpi)' },
          { value: 'prepress', label: 'Prepress (300 dpi)' },
        ],
        defaultValue: 'ebook',
      },
    ],
  },
  {
    // The Compress panel's "then optimize" checkbox, as a step — so the pair
    // the single-document flow already offers together is reachable over a
    // folder. Lossless and Ghostscript-free, which is why it needs no tool
    // path and composes after any other step.
    op: 'optimize',
    title: 'Optimize (lossless)',
    params: [
      {
        key: 'linearize',
        label: 'Web view',
        kind: 'select',
        options: [
          { value: 'yes', label: 'Arrange for fast web viewing' },
          { value: 'no', label: 'Leave the arrangement alone' },
        ],
        defaultValue: 'yes',
      },
      {
        key: 'compress_streams',
        label: 'Object streams',
        kind: 'select',
        options: [
          { value: 'yes', label: 'Pack the objects together' },
          { value: 'no', label: 'Keep them as they are' },
        ],
        defaultValue: 'yes',
      },
      {
        key: 'strip_metadata',
        label: 'Metadata',
        kind: 'select',
        options: [
          { value: 'no', label: 'Keep it' },
          { value: 'yes', label: 'Remove the document’s metadata' },
        ],
        defaultValue: 'no',
      },
    ],
    mapParams: (params) => ({
      linearize: String(params.linearize ?? 'yes') === 'yes',
      compress_streams: String(params.compress_streams ?? 'yes') === 'yes',
      strip_metadata: String(params.strip_metadata ?? 'no') === 'yes',
    }),
  },
  { op: 'grayscale', title: 'Convert to Grayscale', needsGs: true, params: [] },
  {
    op: 'convert_pdfa',
    title: 'Convert to PDF/A',
    needsGs: true,
    params: [
      {
        key: 'level',
        label: 'Level',
        kind: 'select',
        options: [
          { value: '1b', label: 'PDF/A-1b' },
          { value: '2b', label: 'PDF/A-2b' },
          { value: '3b', label: 'PDF/A-3b' },
        ],
        defaultValue: '2b',
      },
    ],
  },
  {
    // A print profile inside a longer authored action. It calls the SAME
    // `apply_fixups` door the panel button, the command line and the droplet
    // call, so what repairing a finding means is not answered a second time.
    // Fix only: every step here TRANSFORMS the document it is handed, and a
    // check produces a report an action has nowhere to put — Tools ▸ Preflight
    // a Folder is where a check over a folder lives.
    op: 'preflight',
    title: 'Bring Up to a Print Profile',
    needsGs: true,
    needsFontDir: true,
    needsTesseract: true,
    params: [
      {
        key: 'profile',
        label: 'Profile',
        kind: 'text',
        defaultValue: 'sheetfed_offset',
        required: true,
        hint: 'A profile id — the command line lists them with preflight-profiles.',
      },
    ],
  },
  { op: 'strip_metadata', title: 'Strip Metadata', params: [] },
  {
    // Folder scope is where this earns its keep: a tree of documents whose
    // addresses should be clickable is exactly the job nobody does by hand.
    op: 'links_from_urls',
    title: 'Create Links from Web Addresses',
    params: [
      {
        key: 'pages',
        label: 'Pages',
        kind: 'text',
        defaultValue: 'all',
        hint: 'A list such as 1,3,5 — or all.',
      },
      {
        key: 'emails',
        label: 'Email addresses',
        kind: 'select',
        options: [
          { value: 'yes', label: 'Link them too' },
          { value: 'no', label: 'Leave them alone' },
        ],
        defaultValue: 'yes',
      },
      {
        key: 'existing',
        label: 'Text a link already covers',
        kind: 'select',
        options: [
          { value: 'skip', label: 'Leave the existing link' },
          { value: 'relink', label: 'Add a link anyway' },
        ],
        defaultValue: 'skip',
      },
    ],
    mapParams: (params) => ({
      pages: pagesParam(params.pages),
      emails: String(params.emails ?? 'yes') === 'yes',
      skip_existing: String(params.existing ?? 'skip') === 'skip',
    }),
  },
  {
    // No reviewer in a folder run, so the mode and the depth are the whole
    // narrowing — and `autotag` is opt-in, because inventing headings from
    // font sizes is a different claim from reading tagged ones.
    op: 'outline_from_structure',
    title: 'Bookmarks from Structure',
    params: [
      {
        key: 'mode',
        label: 'Existing bookmarks',
        kind: 'select',
        options: [
          { value: 'replace', label: 'Replace them' },
          { value: 'append', label: 'Keep them and add after' },
        ],
        defaultValue: 'replace',
      },
      {
        key: 'levels',
        label: 'Deepest heading level',
        kind: 'number',
        defaultValue: 6,
        min: 1,
        max: 6,
        step: 1,
      },
      {
        key: 'untagged',
        label: 'A document with no tags',
        kind: 'select',
        options: [
          { value: 'skip', label: 'Leave it alone' },
          { value: 'autotag', label: 'Detect its headings first' },
        ],
        defaultValue: 'skip',
      },
    ],
    mapParams: (params) => ({
      mode: String(params.mode ?? 'replace'),
      max_level: Number(params.levels ?? 6),
      tag_if_untagged: String(params.untagged ?? 'skip') === 'autotag',
    }),
  },
  {
    // The categories are named as a comma-separated list rather than picked
    // from checkboxes: an action runs unattended over a folder, so what it
    // removes has to be written down in the action itself.
    op: 'sanitize',
    title: 'Remove Hidden Information',
    params: [
      {
        key: 'categories',
        label: 'Categories',
        kind: 'text',
        defaultValue: 'metadata,embedded_files,comments,javascript,prior_revisions',
        required: true,
        hint: 'metadata, embedded_files, bookmarks, comments, form_fields, javascript, hidden_layers, hidden_text, prior_revisions, unreferenced_objects, links_and_actions, thumbnails, attached_structure',
      },
      {
        key: 'form_fields_mode',
        label: 'Form fields',
        kind: 'select',
        options: [
          { value: 'remove', label: 'Remove the fields' },
          { value: 'flatten', label: 'Flatten (keep the look)' },
        ],
        defaultValue: 'remove',
      },
    ],
    mapParams: (params) => ({
      categories: String(params.categories ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
      form_fields_mode: String(params.form_fields_mode ?? 'remove'),
    }),
  },
  {
    // A folder run has no review step, so this redacts every hit. The
    // reviewable half is the marks mode, which writes /Redact annotations and
    // removes nothing.
    op: 'search_redact',
    title: 'Search & Redact',
    needsFontDir: true,
    params: [
      { key: 'query', label: 'Search for', kind: 'text', defaultValue: '' },
      {
        key: 'terms',
        label: 'Word list',
        kind: 'text',
        defaultValue: '',
        hint: 'Comma-separated. Combined with the search term and the patterns.',
      },
      {
        key: 'patterns',
        label: 'Patterns',
        kind: 'text',
        defaultValue: '',
        hint: 'Comma-separated: phone, email, credit_card, ssn, date, iban, nhs_uk, sin_ca, url',
      },
      {
        key: 'expand',
        label: 'Each hit covers',
        kind: 'select',
        options: [
          { value: 'match', label: 'The matched text' },
          { value: 'word', label: 'The whole word' },
          { value: 'line', label: 'The whole line' },
        ],
        defaultValue: 'match',
      },
      {
        key: 'mode',
        label: 'Mode',
        kind: 'select',
        options: [
          { value: 'apply', label: 'Remove the content' },
          { value: 'marks', label: 'Mark for review (removes nothing)' },
        ],
        defaultValue: 'apply',
      },
      {
        key: 'overlay_text',
        label: 'Overlay text',
        kind: 'text',
        defaultValue: '',
        hint: 'Drawn over each box — e.g. an exemption code. Empty draws a plain box.',
      },
      {
        key: 'signed',
        label: 'Signed documents',
        kind: 'select',
        options: [
          { value: 'skip', label: 'Refuse (leave them untouched)' },
          { value: 'include', label: 'Redact anyway (their signatures break)' },
        ],
        defaultValue: 'skip',
      },
    ],
    mapParams: (params) => {
      const list = (value: string | number | undefined): string[] =>
        String(value ?? '')
          .split(',')
          .map((s) => s.trim())
          .filter((s) => s.length > 0);
      const overlay = String(params.overlay_text ?? '');
      return {
        query: String(params.query ?? ''),
        terms: list(params.terms),
        patterns: list(params.patterns),
        expand: String(params.expand ?? 'match'),
        marks_only: String(params.mode ?? 'apply') === 'marks',
        allow_signed: String(params.signed ?? 'skip') === 'include',
        ...(overlay ? { properties: { overlay_text: overlay } } : {}),
      };
    },
  },
  {
    // A folder run has no review step, so this creates every field the
    // detector offers. The kinds list is the only narrowing available without
    // a reviewer.
    op: 'prepare_forms',
    title: 'Prepare Forms (detect fields)',
    needsGs: true,
    needsTesseract: true,
    needsFontDir: true,
    params: [
      {
        key: 'kinds',
        label: 'Field types to add',
        kind: 'text',
        defaultValue: '',
        hint: 'Comma-separated: text, checkbox, radio, signature. Empty adds every type it finds.',
      },
      {
        key: 'scan',
        label: 'Scanned pages',
        kind: 'select',
        options: [
          { value: 'auto', label: 'Recognise a page with nothing readable on it' },
          { value: 'never', label: 'Never recognise — stay offline' },
          { value: 'always', label: 'Recognise every page' },
        ],
        defaultValue: 'auto',
      },
      {
        key: 'language',
        label: 'Recognition language',
        kind: 'select',
        options: OCR_LANGUAGES.map((l) => ({ value: l.code, label: l.label })),
        defaultValue: 'eng',
      },
      {
        key: 'signed',
        label: 'Signed documents',
        kind: 'select',
        options: [
          { value: 'skip', label: 'Refuse (leave them untouched)' },
          { value: 'include', label: 'Add fields anyway (their signatures break)' },
        ],
        defaultValue: 'skip',
      },
    ],
    mapParams: (params) => {
      const kinds = String(params.kinds ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
      return {
        scan: String(params.scan ?? 'auto'),
        lang: String(params.language ?? 'eng'),
        allow_signed: String(params.signed ?? 'skip') === 'include',
        ...(kinds.length > 0 ? { kinds } : {}),
      };
    },
  },
  {
    op: 'watermark',
    title: 'Watermark',
    needsFontDir: true,
    requireOneOf: ['text', 'image', 'pdf_source'],
    params: [
      { key: 'text', label: 'Text', kind: 'text', defaultValue: '' },
      {
        key: 'image',
        label: 'Image file',
        kind: 'text',
        defaultValue: '',
        hint: 'Full path to a picture. Set exactly one source.',
      },
      {
        key: 'pdf_source',
        label: 'PDF file',
        kind: 'text',
        defaultValue: '',
        hint: 'Full path to a PDF whose page is stamped as vector artwork. Set exactly one source.',
      },
      {
        key: 'pdf_page',
        label: 'PDF page',
        kind: 'number',
        defaultValue: 1,
        min: 1,
        step: 1,
      },
      {
        key: 'opacity',
        label: 'Opacity',
        kind: 'number',
        defaultValue: 0.15,
        min: 0.05,
        max: 1,
        step: 0.05,
      },
      { key: 'angle', label: 'Angle', kind: 'number', defaultValue: 45, min: -180, max: 180, step: 5 },
      { key: 'scale', label: 'Scale', kind: 'number', defaultValue: 1, min: 0.05, max: 4, step: 0.05 },
      {
        key: 'position',
        label: 'Position',
        kind: 'select',
        options: [
          { value: 'center', label: 'Center' },
          { value: 'top-left', label: 'Top left' },
          { value: 'top-center', label: 'Top center' },
          { value: 'top-right', label: 'Top right' },
          { value: 'middle-left', label: 'Middle left' },
          { value: 'middle-right', label: 'Middle right' },
          { value: 'bottom-left', label: 'Bottom left' },
          { value: 'bottom-center', label: 'Bottom center' },
          { value: 'bottom-right', label: 'Bottom right' },
        ],
        defaultValue: 'center',
      },
    ],
  },
  {
    op: 'ocr_file',
    title: 'Make Searchable (OCR)',
    needsGs: true,
    needsTesseract: true,
    params: [
      {
        key: 'language',
        label: 'Language',
        kind: 'select',
        options: OCR_LANGUAGES.map((l) => ({ value: l.code, label: l.label })),
        defaultValue: 'eng',
      },
    ],
  },
  {
    // Deskew, despeckle, whiten and re-orient the scanned pages. The engine
    // enforces the ORDER against the other two scan steps (before OCR, before
    // MRC compression); the numbers below are the same thresholds the Scan &
    // OCR panel exposes, spelled out because an unattended run has no reviewer
    // to look at a measurement first.
    op: 'enhance_scan',
    title: 'Enhance Scans',
    needsGs: true,
    needsTesseract: true,
    params: [
      {
        key: 'pages',
        label: 'Pages',
        kind: 'text',
        defaultValue: 'all',
        hint: 'A list such as 1,3,5 — or all.',
      },
      {
        key: 'deskew',
        label: 'Straighten (deskew)',
        kind: 'select',
        options: [
          { value: 'yes', label: 'Straighten a leaning page' },
          { value: 'no', label: 'Leave the angle alone' },
        ],
        defaultValue: 'yes',
      },
      {
        key: 'despeckle',
        label: 'Remove specks',
        kind: 'select',
        options: [
          { value: 'yes', label: 'Remove scanning specks' },
          { value: 'no', label: 'Leave the specks' },
        ],
        defaultValue: 'yes',
      },
      {
        key: 'background',
        label: 'Whiten the background',
        kind: 'select',
        options: [
          { value: 'yes', label: 'Whiten a greyed background' },
          { value: 'no', label: 'Leave the background' },
        ],
        defaultValue: 'yes',
      },
      {
        key: 'orientation',
        label: 'Detect the orientation',
        kind: 'select',
        options: [
          { value: 'yes', label: 'Turn a sideways page upright' },
          { value: 'no', label: 'Leave the page as it is' },
        ],
        defaultValue: 'yes',
      },
      {
        key: 'max_skew_deg',
        label: 'Search up to (°)',
        kind: 'number',
        defaultValue: 10,
        min: 0.1,
        max: 45,
        step: 0.1,
      },
      {
        key: 'min_skew_deg',
        label: 'Smallest skew worth fixing (°)',
        kind: 'number',
        defaultValue: 0.1,
        min: 0,
        max: 45,
        step: 0.1,
      },
      {
        key: 'speck_size_in',
        label: 'Largest speck (in)',
        kind: 'number',
        defaultValue: 0.01,
        min: 0.001,
        max: 0.05,
        step: 0.001,
      },
      {
        key: 'speck_gap_in',
        label: 'Keep a speck this close to ink (in)',
        kind: 'number',
        defaultValue: 0.02,
        min: 0.001,
        max: 0.2,
        step: 0.001,
      },
      {
        key: 'background_strength',
        label: 'Whitening strength',
        kind: 'number',
        defaultValue: 1,
        min: 0,
        max: 1,
        step: 0.05,
      },
      {
        key: 'osd_confidence',
        label: 'Turn the page when at least',
        kind: 'number',
        defaultValue: 2,
        min: 0,
        max: 10,
        step: 0.1,
      },
      {
        key: 'jpeg_quality',
        label: 'Re-encode quality',
        kind: 'number',
        defaultValue: 85,
        min: 1,
        max: 100,
        step: 1,
      },
    ],
    mapParams: (params) => ({
      pages: pagesParam(params.pages),
      deskew: String(params.deskew ?? 'yes') === 'yes',
      despeckle: String(params.despeckle ?? 'yes') === 'yes',
      background: String(params.background ?? 'yes') === 'yes',
      orientation: String(params.orientation ?? 'yes') === 'yes',
      max_skew_deg: Number(params.max_skew_deg ?? 10),
      min_skew_deg: Number(params.min_skew_deg ?? 0.1),
      speck_size_in: Number(params.speck_size_in ?? 0.01),
      speck_gap_in: Number(params.speck_gap_in ?? 0.02),
      background_strength: Number(params.background_strength ?? 1),
      osd_confidence: Number(params.osd_confidence ?? 2),
      jpeg_quality: Number(params.jpeg_quality ?? 85),
    }),
  },
  {
    op: 'add_header_footer',
    title: 'Header & Footer',
    needsFontDir: true,
    mapParams: (p) => ({
      placements: [{ position: String(p.position), text: String(p.text) }],
      font_size: p.font_size,
    }),
    params: [
      {
        key: 'position',
        label: 'Position',
        kind: 'select',
        options: [
          { value: 'tl', label: 'Top left' },
          { value: 'tc', label: 'Top center' },
          { value: 'tr', label: 'Top right' },
          { value: 'bl', label: 'Bottom left' },
          { value: 'bc', label: 'Bottom center' },
          { value: 'br', label: 'Bottom right' },
        ],
        defaultValue: 'bc',
      },
      {
        key: 'text',
        label: 'Text',
        kind: 'text',
        defaultValue: '',
        required: true,
        hint: 'Tokens: {page}, {pages}, {bates}. One position per step — stack steps for more.',
      },
      { key: 'font_size', label: 'Size', kind: 'number', defaultValue: 10, min: 4, max: 72, step: 1 },
    ],
  },
  {
    op: 'encrypt',
    title: 'Encrypt to a new file',
    terminalOutput: true,
    params: [
      { key: 'user_password', label: 'Open password', kind: 'password', defaultValue: '', secret: true },
      { key: 'owner_password', label: 'Owner password', kind: 'password', defaultValue: '', secret: true },
    ],
  },
  {
    // The two steps that CONSUME the document: they write a file of another
    // kind, so nothing can follow them — the terminal shape encrypt already
    // wears. The form offers every option any target takes and `mapParams`
    // emits only the ones the CHOSEN target declares, because the engine
    // refuses an undeclared option rather than ignoring it.
    op: 'export_document',
    title: 'Export to a document format',
    terminalOutput: true,
    needsGs: true,
    needsSoffice: true,
    params: [
      {
        key: 'fmt',
        label: 'Format',
        kind: 'select',
        options: [
          { value: 'docx', label: 'Word processor document (.docx)' },
          { value: 'rtf', label: 'Rich text (.rtf)' },
          { value: 'odt', label: 'OpenDocument text (.odt)' },
          { value: 'html', label: 'Web page (.html)' },
          { value: 'xhtml', label: 'Web page, XHTML (.xhtml)' },
          { value: 'txt', label: 'Plain text (.txt)' },
          { value: 'xlsx', label: 'Spreadsheet (.xlsx)' },
          { value: 'pptx', label: 'Presentation (.pptx)' },
        ],
        defaultValue: 'docx',
      },
      {
        key: 'pages',
        label: 'Pages',
        kind: 'text',
        defaultValue: '',
        hint: 'Blank is every page. Read by the text, spreadsheet and presentation targets only.',
      },
      {
        key: 'layout',
        label: 'Text order (plain text)',
        kind: 'select',
        options: [
          { value: 'reading', label: 'Reading order' },
          { value: 'layout', label: 'Preserve the page layout' },
        ],
        defaultValue: 'reading',
      },
      {
        key: 'page_breaks',
        label: 'Page breaks (plain text)',
        kind: 'select',
        options: [
          { value: 'no', label: 'Run the pages together' },
          { value: 'yes', label: 'Separate pages with a page break' },
        ],
        defaultValue: 'no',
      },
      {
        key: 'sheet_per',
        label: 'Sheets (spreadsheet)',
        kind: 'select',
        options: [
          { value: 'table', label: 'One sheet per table' },
          { value: 'page', label: 'One sheet per page' },
        ],
        defaultValue: 'table',
      },
      {
        key: 'include_untabled',
        label: 'Text outside the tables (spreadsheet)',
        kind: 'select',
        options: [
          { value: 'no', label: 'Leave it out' },
          { value: 'yes', label: 'Add a sheet carrying it' },
        ],
        defaultValue: 'no',
      },
      {
        key: 'slide_size',
        label: 'Slide size (presentation)',
        kind: 'select',
        options: [
          { value: 'page', label: 'The document’s own page size' },
          { value: '16:9', label: 'Widescreen (16:9)' },
          { value: '4:3', label: 'Standard (4:3)' },
        ],
        defaultValue: 'page',
      },
    ],
    mapParams: (params) =>
      exportParams(String(params.fmt ?? 'docx') as ExportFormat, {
        pages: String(params.pages ?? ''),
        layout: String(params.layout ?? 'reading'),
        pageBreaks: String(params.page_breaks ?? 'no') === 'yes',
        sheetPer: String(params.sheet_per ?? 'table'),
        includeUntabled: String(params.include_untabled ?? 'no') === 'yes',
        slideSize: String(params.slide_size ?? 'page'),
      }),
  },
  {
    op: 'export_images',
    title: 'Export the pages as images',
    terminalOutput: true,
    needsGs: true,
    params: [
      {
        key: 'fmt',
        label: 'Format',
        kind: 'select',
        options: [
          { value: 'png', label: 'PNG images — one per page' },
          { value: 'jpeg', label: 'JPEG images — one per page' },
          { value: 'tiff', label: 'TIFF — one multi-page file per document' },
        ],
        defaultValue: 'png',
      },
      {
        key: 'pages',
        label: 'Pages',
        kind: 'text',
        defaultValue: '',
        hint: 'Blank is every page. Ranges like 1-3,5 are read as written.',
      },
      { key: 'dpi', label: 'Resolution (dpi)', kind: 'number', defaultValue: 150, min: 18, max: 1200, step: 1 },
      {
        key: 'gray',
        label: 'Colour',
        kind: 'select',
        options: [
          { value: 'no', label: 'Colour' },
          { value: 'yes', label: 'Grayscale' },
        ],
        defaultValue: 'no',
      },
      { key: 'quality', label: 'JPEG quality', kind: 'number', defaultValue: 90, min: 1, max: 100, step: 1 },
    ],
    mapParams: (params) =>
      exportParams(String(params.fmt ?? 'png') as ExportFormat, {
        pages: String(params.pages ?? ''),
        layout: 'reading',
        pageBreaks: false,
        sheetPer: 'table',
        includeUntabled: false,
        slideSize: 'page',
        dpi: Number(params.dpi ?? 150),
        gray: String(params.gray ?? 'no') === 'yes',
        quality: Number(params.quality ?? 90),
      }),
  },
  {
    // LAST in the catalog even though it is always FIRST in an
    // action: `AddStepPicker` defaults to `STEP_CATALOG[0]`, and making the
    // rarest step the default "Add step" would be a regression for every
    // ordinary action. Position here is a picker default, not an order.
    op: 'create_pdf',
    title: 'Create PDF from any file',
    sourceStep: true,
    needsGs: true,
    params: [
      {
        key: 'page_size',
        label: 'Page size',
        kind: 'select',
        options: [
          { value: 'auto', label: 'Keep each source’s own size' },
          { value: 'first', label: 'Match the first source' },
          { value: 'letter', label: 'Letter' },
          { value: 'legal', label: 'Legal' },
          { value: 'tabloid', label: 'Tabloid' },
          { value: 'a3', label: 'A3' },
          { value: 'a4', label: 'A4' },
          { value: 'a5', label: 'A5' },
        ],
        defaultValue: 'auto',
      },
      {
        key: 'orientation',
        label: 'Orientation',
        kind: 'select',
        options: [
          { value: 'auto', label: 'Follow the content' },
          { value: 'portrait', label: 'Portrait' },
          { value: 'landscape', label: 'Landscape' },
        ],
        defaultValue: 'auto',
      },
      { key: 'margin_pt', label: 'Margin (pt)', kind: 'number', defaultValue: 0, min: 0, max: 288, step: 1 },
      {
        key: 'image_dpi_default',
        label: 'Image resolution (dpi)',
        kind: 'number',
        defaultValue: 200,
        min: 1,
        max: 2400,
        step: 1,
      },
      {
        key: 'distill_preset',
        label: 'PostScript quality',
        kind: 'select',
        options: [
          { value: 'screen', label: 'Smallest Size (72 dpi)' },
          { value: 'ebook', label: 'eBook (150 dpi)' },
          { value: 'printer', label: 'Print Quality (300 dpi)' },
          { value: 'prepress', label: 'Press Quality' },
          { value: 'default', label: 'Standard (Ghostscript defaults)' },
        ],
        defaultValue: 'printer',
      },
    ],
  },
  {
    // The second source step. It changes the run's UNIT from a file to a
    // DIRECTORY: a folder of page images is one document, which is the shape a
    // flatbed produces. Everything after it runs on the assembled PDF, so
    // "one PDF per scan folder, then straighten, then make searchable" is one
    // unattended job. `needsSoffice` is declared for accuracy and is inert
    // here — a source step never runs against an open document, and the
    // folder runner passes every tool path unconditionally.
    op: 'create_pdf_folders',
    title: 'Create one PDF per folder',
    sourceStep: true,
    needsGs: true,
    needsSoffice: true,
    params: [
      {
        key: 'sources',
        label: 'Files to assemble',
        kind: 'select',
        options: [
          { value: 'images', label: 'Pictures only' },
          { value: 'all', label: 'Every kind Create PDF accepts' },
        ],
        defaultValue: 'images',
      },
      {
        key: 'include_subfolders',
        label: 'Subfolders',
        kind: 'select',
        options: [
          { value: 'yes', label: 'Walk the whole tree' },
          { value: 'no', label: 'Only the folder itself' },
        ],
        defaultValue: 'yes',
      },
      {
        key: 'page_size',
        label: 'Page size',
        kind: 'select',
        options: [
          { value: 'auto', label: 'Keep each source’s own size' },
          { value: 'first', label: 'Match the first source' },
          { value: 'letter', label: 'Letter' },
          { value: 'legal', label: 'Legal' },
          { value: 'tabloid', label: 'Tabloid' },
          { value: 'a3', label: 'A3' },
          { value: 'a4', label: 'A4' },
          { value: 'a5', label: 'A5' },
        ],
        defaultValue: 'auto',
      },
      {
        key: 'orientation',
        label: 'Orientation',
        kind: 'select',
        options: [
          { value: 'auto', label: 'Follow the content' },
          { value: 'portrait', label: 'Portrait' },
          { value: 'landscape', label: 'Landscape' },
        ],
        defaultValue: 'auto',
      },
      { key: 'margin_pt', label: 'Margin (pt)', kind: 'number', defaultValue: 0, min: 0, max: 288, step: 1 },
      {
        key: 'image_dpi_default',
        label: 'Image resolution (dpi)',
        kind: 'number',
        defaultValue: 200,
        min: 1,
        max: 2400,
        step: 1,
      },
      {
        key: 'distill_preset',
        label: 'PostScript quality',
        kind: 'select',
        options: [
          { value: 'screen', label: 'Smallest Size (72 dpi)' },
          { value: 'ebook', label: 'eBook (150 dpi)' },
          { value: 'printer', label: 'Print Quality (300 dpi)' },
          { value: 'prepress', label: 'Press Quality' },
          { value: 'default', label: 'Standard (Ghostscript defaults)' },
        ],
        defaultValue: 'printer',
      },
    ],
    mapParams: (params) => ({
      sources: String(params.sources ?? 'images'),
      include_subfolders: String(params.include_subfolders ?? 'yes') === 'yes',
      page_size: String(params.page_size ?? 'auto'),
      orientation: String(params.orientation ?? 'auto'),
      margin_pt: Number(params.margin_pt ?? 0),
      image_dpi_default: Number(params.image_dpi_default ?? 200),
      distill_preset: String(params.distill_preset ?? 'printer'),
    }),
  },
];

export function stepDefFor(op: GuidedStepOp): StepDef {
  const def = STEP_CATALOG.find((d) => d.op === op);
  if (!def) throw new Error(`unknown guided step: ${op}`);
  return def;
}

/** A fresh step with the catalog's defaults. */
export function newStep(op: GuidedStepOp): GuidedStep {
  const def = stepDefFor(op);
  const params: Record<string, string | number> = {};
  for (const p of def.params) params[p.key] = p.defaultValue;
  return { op, params };
}

/** The param keys a run must collect up front: everything the user marked
 * ask-at-run, plus every secret (which is never stored). */
export function askedParamKeys(step: GuidedStep): string[] {
  const def = stepDefFor(step.op);
  const asked = new Set(step.ask ?? []);
  for (const p of def.params) if (p.secret) asked.add(p.key);
  return def.params.filter((p) => asked.has(p.key)).map((p) => p.key);
}

/**
 * The engine-call params for a step — the FILE-INDEPENDENT half; the runner
 * adds file/output and the resolved tool paths, and merges any ask-at-run
 * values (pass them as `overrides`) BEFORE coercion so clamps apply to them
 * too. `mapParams` reshapes last (e.g. header/footer's position+text pair
 * into its `placements` list).
 */
export function buildStepParams(
  step: GuidedStep,
  overrides?: Record<string, string | number>,
): Record<string, unknown> {
  const def = stepDefFor(step.op);
  const merged = { ...step.params, ...overrides };
  const out: Record<string, string | number> = {};
  for (const p of def.params) {
    const raw = merged[p.key] ?? p.defaultValue;
    if (p.kind === 'number') {
      let v = typeof raw === 'number' ? raw : parseFloat(String(raw));
      if (!Number.isFinite(v)) v = Number(p.defaultValue);
      if (p.min !== undefined) v = Math.max(p.min, v);
      if (p.max !== undefined) v = Math.min(p.max, v);
      out[p.key] = v;
    } else {
      out[p.key] = String(raw);
    }
  }
  return def.mapParams ? def.mapParams(out) : out;
}

/** null when valid; else the first human-readable problem.
 *
 * Every refusal is ONE interpolated catalog key, and the STEP
 * and PARAM names inside it resolve through the same `gaction.*` keys the
 * editor renders — a message naming "Watermark" in a Spanish UI while the
 * step list above it says "Marca de agua" would be worse than English. */
export function validateAction(action: GuidedAction): string | null {
  if (!action.name.trim()) return tChrome('refusal.action.needsName');
  if (action.steps.length === 0) return tChrome('refusal.action.needsStep');
  for (let i = 0; i < action.steps.length; i++) {
    const step = action.steps[i];
    const def = STEP_CATALOG.find((d) => d.op === step.op);
    if (!def) return tChrome('refusal.action.unknownOp', { index: i + 1 });
    const asked = new Set(askedParamKeys(step));
    for (const p of def.params) {
      // An asked/secret param's emptiness is the PRE-RUN form's problem.
      if (p.required && !asked.has(p.key) && !String(step.params[p.key] ?? '').trim()) {
        return tChrome('refusal.action.paramRequired', {
          index: i + 1,
          step: tStepTitle(def.op, def.title),
          param: tStepParam(def.op, p.key, p.label),
        });
      }
    }
    if (def.requireOneOf) {
      // An asked key's value is the PRE-RUN form's problem, so an asked pair
      // is left to `validateRunValues`.
      const askedEither = def.requireOneOf.some((k) => asked.has(k));
      const set = def.requireOneOf.filter((k) => String(step.params[k] ?? '').trim());
      if (!askedEither && set.length !== 1) {
        return tChrome('refusal.action.paramOneOf', {
          index: i + 1,
          step: tStepTitle(def.op, def.title),
          params: def.requireOneOf
            .map((k) => tStepParam(def.op, k, def.params.find((p) => p.key === k)?.label ?? k))
            .join(' / '),
        });
      }
    }
    // A terminal step never mutates the open doc, so nothing may follow it.
    if (def.terminalOutput && i < action.steps.length - 1) {
      return tChrome('refusal.action.terminalNotLast', {
        step: tStepTitle(def.op, def.title),
      });
    }
    // A source step PRODUCES the document the rest of the action works on,
    // so anywhere but first it would convert a file the earlier steps had
    // already rewritten. `engine/guided_actions.py`'s `validate_steps`
    // refuses the same thing — this is the editor's half, by name, so the
    // action cannot be SAVED into a shape the runner will reject.
    if (def.sourceStep && i > 0) {
      return tChrome('refusal.action.sourceNotFirst', {
        step: tStepTitle(def.op, def.title),
      });
    }
  }
  return null;
}

/** The name a terminal step's save dialog opens on. Read from the step's own
 * chosen target, so an export offers the extension it is about to write rather
 * than a name the user has to correct. */
export function terminalOutputName(step: GuidedStep): string {
  if (step.op === 'export_document' || step.op === 'export_images') {
    const target = EXPORT_TARGETS[String(step.params.fmt) as ExportFormat];
    if (target) return `export.${target.ext}`;
  }
  return 'encrypted.pdf';
}

/** Does this action END by exporting to another format? The engine refuses an
 * in-place folder run of one, and so does the editor. */
export function exportsItsResult(action: GuidedAction): boolean {
  const last = action.steps[action.steps.length - 1];
  return last !== undefined && (last.op === 'export_document' || last.op === 'export_images');
}

/** Does this action START by creating its own document? */
export function createsItsOwnSource(action: GuidedAction): boolean {
  const first = action.steps[0];
  return first !== undefined && Boolean(stepDefFor(first.op).sourceStep);
}

/**
 * Why this action cannot run against the OPEN document, or null.
 *
 * An action that begins by creating a document has nothing to create FROM
 * when it is pointed at a document that already exists — it is a folder run
 * by construction, and saying so is better than running it and producing a
 * confusing result.
 */
export function openDocumentBlocker(action: GuidedAction): string | null {
  if (!createsItsOwnSource(action)) return null;
  const def = stepDefFor(action.steps[0].op);
  return tChrome('refusal.action.sourceNeedsFolder', {
    step: tStepTitle(def.op, def.title),
  });
}

/** Why this action cannot REPLACE the originals, or null. Mirrors the
 * engine's own in-place refusal: the converted document is a new file, so
 * "replace `report.docx` with a PDF still called `report.docx`" is a
 * destroyed source with a misleading name, not an in-place edit. */
export function inPlaceBlocker(action: GuidedAction): string | null {
  if (exportsItsResult(action)) {
    // The engine refuses this too. Replacing `report.pdf` with a spreadsheet
    // still called `report.pdf` is a destroyed source under a misleading name.
    const def = stepDefFor(action.steps[action.steps.length - 1].op);
    return tChrome('refusal.action.exportNotInPlace', {
      step: tStepTitle(def.op, def.title),
    });
  }
  if (!createsItsOwnSource(action)) return null;
  const def = stepDefFor(action.steps[0].op);
  return tChrome('refusal.action.sourceNotInPlace', {
    step: tStepTitle(def.op, def.title),
  });
}

/** Pre-run check of the collected ask-at-run values for one step. */
export function validateRunValues(
  step: GuidedStep,
  values: Record<string, string | number>,
): string | null {
  const def = stepDefFor(step.op);
  for (const key of askedParamKeys(step)) {
    const p = def.params.find((x) => x.key === key)!;
    if (p.required && !String(values[key] ?? '').trim()) {
      return tChrome('refusal.action.runParamRequired', {
        step: tStepTitle(def.op, def.title),
        param: tStepParam(def.op, p.key, p.label),
      });
    }
  }
  if (def.requireOneOf) {
    // The effective value: an asked key comes from this form, an unasked one
    // from what the step stored.
    const asked = new Set(askedParamKeys(step));
    const effective = (k: string): string =>
      String((asked.has(k) ? values[k] : step.params[k]) ?? '').trim();
    if (def.requireOneOf.filter((k) => effective(k)).length !== 1) {
      return tChrome('refusal.action.runParamOneOf', {
        step: tStepTitle(def.op, def.title),
        params: def.requireOneOf
          .map((k) => tStepParam(def.op, k, def.params.find((p) => p.key === k)?.label ?? k))
          .join(' / '),
      });
    }
  }
  if (step.op === 'encrypt') {
    const u = String(values.user_password ?? '').trim();
    const o = String(values.owner_password ?? '').trim();
    if (!u && !o) return tChrome('refusal.action.encryptNeedsPassword');
  }
  return null;
}

/**
 * Why an action cannot run UNATTENDED, or null if it can (scheduling).
 * A scheduled run has nobody at the keyboard: ask-at-run values
 * (and secrets, which are implicitly asked and by rule never persisted) make
 * a task that would fail every time it fires. Refuse at scheduling time,
 * naming the step — never register a task that will not run.
 */
export function unattendedBlocker(action: GuidedAction): string | null {
  for (let i = 0; i < action.steps.length; i++) {
    const step = action.steps[i];
    const def = stepDefFor(step.op);
    const asked = askedParamKeys(step);
    if (asked.length === 0) continue;
    // One whole interpolated message per refusal (the two halves
    // used to be concatenated template fragments). The asked-for PARAM
    // KEYS stay verbatim — they are the action file's own vocabulary.
    const vars = { index: i + 1, step: tStepTitle(step.op, def.title) };
    if (def.params.some((p) => p.secret && asked.includes(p.key))) {
      return tChrome('dialog.unattended.secret', vars);
    }
    return tChrome('dialog.unattended.asks', { ...vars, params: asked.join(', ') });
  }
  return null;
}

const STORE_KEY = 'guided-actions';

export function isGuidedAction(v: unknown): v is GuidedAction {
  if (typeof v !== 'object' || v === null) return false;
  const a = v as Record<string, unknown>;
  if (typeof a.id !== 'string' || typeof a.name !== 'string' || !Array.isArray(a.steps)) return false;
  return a.steps.every((s) => {
    if (typeof s !== 'object' || s === null) return false;
    const step = s as Record<string, unknown>;
    return (
      typeof step.op === 'string' &&
      STEP_CATALOG.some((d) => d.op === step.op) &&
      typeof step.params === 'object' &&
      step.params !== null
    );
  });
}

export function loadGuidedActions(): GuidedAction[] {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isGuidedAction);
  } catch {
    return [];
  }
}

/** Strip secret param values (passwords) from an action; the keys stay
 * implicitly ask-at-run. Every path that writes an action OUTSIDE React
 * state — the localStorage persist, the file export — goes through this,
 * which is what makes "a saved or exported action can never carry a
 * password" true by construction rather than by call-site discipline. */
export function sanitizeAction(a: GuidedAction): GuidedAction {
  return {
    ...a,
    steps: a.steps.map((s) => {
      const def = STEP_CATALOG.find((d) => d.op === s.op);
      if (!def?.params.some((p) => p.secret)) return s;
      const params = { ...s.params };
      for (const p of def.params) if (p.secret) delete params[p.key];
      return { ...s, params };
    }),
  };
}

export function saveGuidedActions(actions: GuidedAction[]): void {
  // SECURITY: secret params (passwords) are NEVER persisted — sanitizeAction
  // strips them at the one write path, so a saved action can carry an
  // Encrypt step but never its passwords.
  localStorage.setItem(STORE_KEY, JSON.stringify(actions.map(sanitizeAction)));
}

/** The export file body — the `{name, steps}` shape the CLI consumes
 * (`run-action --action file.json`). No id: imports mint their own. Secrets
 * are stripped by the SAME construction as the persist path. */
export function actionFileJson(action: GuidedAction): string {
  const clean = sanitizeAction(action);
  return `${JSON.stringify({ name: clean.name, steps: clean.steps }, null, 2)}\n`;
}

/**
 * Parse + validate an action FILE (the `{name, steps}` export shape — also
 * what the CLI consumes). Mirrors the engine `validate_steps` refusals BY
 * NAME against the renderer's own catalog: an op or param this editor cannot
 * represent is refused with the offending name, never silently dropped
 * (buildStepParams would otherwise discard it and the imported action would
 * run differently here than through the CLI). Returns a ready-to-append
 * action with a freshly minted id — imports never collide with or overwrite
 * an existing action. Throws a human-readable message on refusal.
 */
export function parseActionFile(text: string): GuidedAction {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(tChrome('refusal.actionFile.notJson'));
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(tChrome('refusal.actionFile.notAnActionFile'));
  }
  const a = parsed as Record<string, unknown>;
  if (typeof a.name !== 'string' || !Array.isArray(a.steps)) {
    throw new Error(tChrome('refusal.actionFile.notAnActionFile'));
  }
  const steps = a.steps.map((s, i) => parseImportedStep(s, i));
  const action: GuidedAction = { id: crypto.randomUUID(), name: a.name.trim(), steps };
  const problem = validateAction(action);
  if (problem) throw new Error(problem);
  return action;
}

// Every refusal below is one interpolated catalog key. The `op`
// id and the parameter NAMES stay verbatim inside them — they are the action
// FILE's own vocabulary, and a translated key would name something the file
// being fixed does not contain.
function parseImportedStep(s: unknown, i: number): GuidedStep {
  const n = i + 1;
  if (typeof s !== 'object' || s === null || Array.isArray(s)) {
    throw new Error(tChrome('refusal.actionFile.stepNotObject', { index: n }));
  }
  const raw = s as Record<string, unknown>;
  const op = raw.op;
  if (typeof op !== 'string') {
    throw new Error(tChrome('refusal.actionFile.stepNotObject', { index: n }));
  }
  const def = STEP_CATALOG.find((d) => d.op === op);
  if (!def) throw new Error(tChrome('refusal.actionFile.unknownOp', { index: n, op }));
  const rawParams = raw.params ?? {};
  if (typeof rawParams !== 'object' || rawParams === null || Array.isArray(rawParams)) {
    throw new Error(tChrome('refusal.actionFile.paramsNotObject', { index: n, op }));
  }
  const params: Record<string, unknown> = { ...(rawParams as Record<string, unknown>) };
  // The engine's placements list is this editor's position+text pair: fold a
  // single-entry list back into the form shape (CLI-authored files). More
  // placements than one per step is not representable in the editor.
  if (op === 'add_header_footer' && 'placements' in params) {
    if ('position' in params || 'text' in params) {
      throw new Error(tChrome('refusal.actionFile.placementsConflict', { index: n, op }));
    }
    const pl = params.placements;
    delete params.placements;
    if (!Array.isArray(pl) || pl.length === 0) {
      throw new Error(tChrome('refusal.actionFile.placementsEmpty', { index: n, op }));
    }
    if (pl.length > 1) {
      throw new Error(tChrome('refusal.actionFile.placementsMulti', { index: n, op }));
    }
    const first = pl[0] as Record<string, unknown> | null;
    if (typeof first !== 'object' || first === null) {
      throw new Error(tChrome('refusal.actionFile.placementsShape', { index: n, op }));
    }
    params.position = first.position;
    params.text = first.text;
  }
  const allowed = new Map(def.params.map((p) => [p.key, p]));
  const unknown = Object.keys(params)
    .filter((k) => !allowed.has(k))
    .sort();
  if (unknown.length > 0) {
    throw new Error(
      tChrome('refusal.actionFile.unknownParams', {
        index: n,
        op,
        params: unknown.join(', '),
      }),
    );
  }
  const clean: Record<string, string | number> = {};
  for (const [key, v] of Object.entries(params)) {
    const p = allowed.get(key)!;
    if (typeof v !== 'string' && typeof v !== 'number') {
      throw new Error(
        tChrome('refusal.actionFile.paramType', { index: n, op, param: key }),
      );
    }
    if (p.kind === 'select' && !p.options!.some((o) => o.value === String(v))) {
      throw new Error(
        tChrome('refusal.actionFile.invalidValue', {
          index: n,
          op,
          value: String(v),
          param: key,
        }),
      );
    }
    clean[key] = v;
  }
  // ask: param keys collected at run time. Keys the catalog doesn't know are
  // meaningless here (askedParamKeys intersects anyway) — keep the known.
  if (raw.ask === undefined) return { op: def.op, params: clean };
  if (!Array.isArray(raw.ask) || raw.ask.some((k) => typeof k !== 'string')) {
    throw new Error(tChrome('refusal.actionFile.askNotList', { index: n, op }));
  }
  return { op: def.op, params: clean, ask: (raw.ask as string[]).filter((k) => allowed.has(k)) };
}
