// The engine's operation set — the canonical list, and the one place it lives.
//
// An "operation" is one whole-file job the product exposes (the things that used
// to be the rail's items). Tools group them by the JOB the user came to do
// (`commands/tools.ts`); this module is just the flat set and its names.
//
// `metadata` retired at M5.5b: document properties are a DIALOG (Ctrl+D), not a
// job you pick from a tool — the first op to leave this list, and the type
// system walked every dependent (the glyph map, the panel map, the owning
// tool's ops, the command ids) rather than leaving one behind.
//
// It exists because the list had drifted into FOUR declarations — the `Operation`
// union in `components/Sidebar`, a runtime `OPERATIONS` array derived from
// tool-icons' GLYPHS, `PANEL_OPS` in the registry, and the `panels`/`titles`
// Records in App — plus TWO copies of the titles, which had to be edited in
// lockstep and were kept honest only by a totality test noticing after the fact.
// A leaf module with no imports can be the single source for all of them: the
// union is DERIVED from the array (`typeof OPERATIONS[number]`), so a `Record<
// Operation, …>` elsewhere is total by construction and adding an op without its
// glyph, title, panel, or owning tool fails tsc rather than a test run.

export const OPERATIONS = [
  'split', 'rotate', 'delete',
  'compress', 'grayscale', 'optimize', 'pdfa', 'pdf_version',
  'repair', 'rebuild', 'recover',
  'encrypt', 'decrypt',
  'extract_text', 'watermark', 'forms', 'compare', 'signatures',
  'document_js', 'convert_cmyk', 'headerfooter', 'pagebox', 'pagelabels', 'attachments',
] as const;

export type Operation = (typeof OPERATIONS)[number];

/** The name an operation goes by wherever it's shown — pane heads, the op
 * switcher, the Tools menu. One copy, so a rename can't half-land. */
export const OPERATION_TITLES: Record<Operation, string> = {
  split: 'Split by Range', rotate: 'Rotate Pages', delete: 'Delete Pages',
  compress: 'Compress', grayscale: 'Convert to Grayscale', optimize: 'Optimize PDF',
  pdfa: 'Convert to PDF/A', pdf_version: 'Set PDF Version',
  encrypt: 'Encrypt PDF', decrypt: 'Decrypt PDF',
  extract_text: 'Extract Text',
  watermark: 'Watermark', forms: 'Fill Form', compare: 'Compare PDFs',
  signatures: 'Signatures',
  document_js: 'Document JavaScript',
  convert_cmyk: 'Convert to CMYK',
  headerfooter: 'Header & Footer',
  pagebox: 'Crop & Page Boxes',
  pagelabels: 'Page Labels',
  attachments: 'Attachments',
  repair: 'Repair PDF', rebuild: 'Rebuild PDF', recover: 'Recover Pages',
};
