import type { Operation } from './operations';
import type { CanvasTool } from '../state/types';

// The workbench's TOOLS — the data the Tools Center tiles,
// the task panes and the secondary toolbars all read. Like the menu tree and the
// keymap, this is data over the command registry rather than hand-placed UI,
// which makes the configuration directly testable.
//
// The shape of the change: 19 operations, grouped into 12 tools by the JOB the
// user came to do. The old rail's groups (Pages / Transform / Repair / Security
// / Content) were a taxonomy of the ENGINE — they named what the code does. A
// forms author does not think "I need a Content operation"; they think "I'm
// preparing a form". Tool titles use familiar, task-oriented vocabulary.
//
// Every operation the app has is reachable through exactly one tool — checked by
// a totality test, so an operation can't be orphaned by a future edit.

export type ToolId =
  | 'organize'
  | 'comment'
  | 'edit'
  | 'fillsign'
  | 'prepareform'
  | 'redact'
  | 'measure'
  | 'takeoff'
  | 'actions'
  | 'ocr'
  | 'compare'
  | 'protect'
  | 'optimize'
  | 'repair'
  | 'watermark'
  | 'headerfooter'
  | 'pagebox'
  | 'pagelabels'
  | 'attachments'
  | 'portfolio'
  | 'layers'
  | 'accessibility'
  | 'printproduction'
  | 'links'
  | 'export';

export interface ToolDef {
  id: ToolId;
  /** Tile and task-pane heading using descriptive industry terminology. */
  title: string;
  /** One line, shown on the tile. Says what the tool is FOR, not how it works. */
  description: string;
  /** The operations this tool hosts, in the order the pane lists them. May be
   * empty for a tool whose whole surface is on the canvas (its work is a mode,
   * not a form) — those still get a tile, because the tile is how you find it.
   *
   * Also THE test for where a tool lives: ops ⇒ its home is the Tools tab; no
   * ops ⇒ its home is the document. `openTool` reads it that way. */
  ops: Operation[];
  /**
   * The canvas interaction modes this tool OWNS, in secondary-toolbar order.
   *
   * Ownership, not just "what to arm": it answers both "which mode does opening
   * this tool arm?" (the first) and, on a document tab, "which tool is armed?"
   * (`toolForCanvasTool`) — the question the secondary toolbar exists to answer
   * and the reason a flat pill cluster of eight modes could not. Comment owns
   * four modes that together form the tool.
   *
   * Deliberately the state slice's own `CanvasTool`, not a copy of its members:
   * a re-spelled union here would let a tool name a mode the canvas doesn't
   * have and still typecheck (it did, once — `'sign'` vs `'signature'`).
   * `'select'` belongs to no tool; it is the absence of one.
   */
  canvasTools?: CanvasTool[];
}

export const TOOL_DEFS: readonly ToolDef[] = [
  {
    id: 'organize',
    title: 'Organize Pages',
    // Name the verbs users search for, especially "merge",
    // whose only surface is the board's direct manipulation.
    description: 'Reorder, rotate, delete, split, extract — and merge pages between open files.',
    ops: ['rotate', 'delete', 'split'],
  },
  {
    id: 'comment',
    title: 'Comment',
    description: 'Highlight, add text boxes, draw, stamp — and review every comment in the document.',
    // fold: 'comments' (the review list) was a SECOND tool sitting next to
    // this one in the grid, one letter apart — "Comment" to make them,
    // "Comments" to read them. That is not a distinction a user should have to
    // infer from a plural. It is one job, so it is one tool: the modes below
    // author the markup, and the op below is the list of what is there.
    // Safe against the mode: `worksOnPage` is true either way (canvasTools),
    // and the reducer arms a tool's canvas mode BEFORE it considers ops — so
    // Comment still lands you ON the page, with its pane seated one dock-click
    // away rather than grabbing horizontal space.
    ops: ['comments'],
    // Six modes belong to one tool. 'shape' fans out through
    // the secondary toolbar's figure picker (rect/ellipse/line/arrow/polygon/
    // polyline/cloud — rung 2); 'callout' is the leadered text box.
    canvasTools: ['highlight', 'freetext', 'ink', 'stamp', 'shape', 'callout', 'note', 'inkerase'],
  },
  {
    id: 'edit',
    title: 'Edit',
    // Name text, paragraph, image, and text-authoring capabilities explicitly.
    description: 'Edit text, whole paragraphs, and images — or add new text — right on the page.',
    ops: [],
    // Three modes: 'edit' (click existing content to edit), 'addtext' (drag a
    // box to author new text), 'addimage' (drag a box, pick a raster). Opening
    // the tool arms the first; the secondary toolbar switches between them.
    canvasTools: ['edit', 'addtext', 'addimage'],
  },
  {
    id: 'fillsign',
    title: 'Fill & Sign',
    description: 'Fill in a form and sign it, or verify a signature.',
    ops: ['signatures'],
    canvasTools: ['forms', 'signature'],
  },
  {
    id: 'prepareform',
    title: 'Prepare Form',
    description: 'Detect the fields on a flat form, or add and edit them by hand, then flatten.',
    ops: ['prepareform', 'forms', 'document_js'],
    canvasTools: ['formfields'],
  },
  {
    id: 'redact',
    title: 'Redact',
    description: 'Mark text to remove — by hand, or by searching every occurrence — then permanently strip it from the file.',
    ops: ['search_redact', 'sanitize'],
    // It still ARMS the band mode when opened (worksOnPage stays true because
    // it owns a canvas mode), and the Search & Redact panel is one dock click
    // away — the Comment/Takeoff precedent, not a tool that yanks the user off
    // the page to fill in a form.
    canvasTools: ['redact'],
  },
  {
    id: 'measure',
    title: 'Measure',
    description: 'Measure distances, perimeters, and areas on the page.',
    ops: [],
    canvasTools: ['measuredist', 'measureperim', 'measurearea', 'measurecal'],
  },
  {
    id: 'takeoff',
    title: 'Count & Takeoff',
    description: 'Count items on a drawing by group, then export the takeoff or place a legend.',
    // It HAS an op, so by the registry's own rule its home is the tool dock:
    // the panel is where groups are managed, tallies are read, the legend is
    // placed and the CSV is written. The `count` mode is what puts you on the
    // page, and `openTool` arms a tool's canvas mode BEFORE it considers ops
    // (the Comment precedent), so opening Takeoff lands you counting with the
    // panel one dock-click away.
    ops: ['takeoff'],
    canvasTools: ['count'],
  },
  {
    id: 'actions',
    title: 'Guided Actions',
    description: 'Save sequences of steps and run them on a document with one click.',
    ops: ['actions'],
  },
  {
    id: 'ocr',
    title: 'Scan & OCR',
    description: 'Make a scanned document searchable.',
    ops: [],
  },
  {
    id: 'compare',
    title: 'Compare Files',
    description: 'See what changed between two documents.',
    ops: ['compare'],
  },
  {
    id: 'protect',
    title: 'Protect',
    description: 'Add or remove a password.',
    ops: ['encrypt', 'decrypt'],
  },
  {
    id: 'optimize',
    title: 'Optimize',
    description: 'Reduce file size, convert to grayscale or PDF/A.',
    ops: ['compress', 'optimize', 'grayscale', 'pdfa', 'pdf_version'],
  },
  {
    id: 'repair',
    title: 'Repair',
    description: 'Validate a damaged file and rebuild it, in escalating tiers.',
    ops: ['repair', 'rebuild', 'recover'],
  },
  {
    id: 'watermark',
    title: 'Watermark',
    description: 'Stamp text across every page.',
    ops: ['watermark'],
  },
  {
    id: 'headerfooter',
    title: 'Header & Footer',
    description: 'Add headers, footers, page numbers, and Bates numbering.',
    ops: ['headerfooter'],
  },
  {
    id: 'pagebox',
    title: 'Crop & Page Boxes',
    description: 'Crop pages and edit the crop/bleed/trim/art boxes.',
    ops: ['pagebox'],
    // Opening the tool arms the draw mode, so the crop cursor is live on
    // the page the moment you pick Crop — the numeric fields in the dock are
    // where the drag LANDS, not a second way to do the same job.
    canvasTools: ['cropdraw'],
  },
  {
    id: 'pagelabels',
    title: 'Page Labels',
    description: 'Number pages as i/ii/iii, 1/2/3, A/B/C, with prefixes.',
    ops: ['pagelabels'],
  },
  {
    id: 'attachments',
    title: 'Attachments',
    description: 'Embed, extract, and remove attached files.',
    ops: ['attachments'],
  },
  {
    id: 'portfolio',
    title: 'Portfolio',
    description: 'Create a PDF portfolio and manage its member files.',
    ops: ['portfolio'],
  },
  {
    id: 'layers',
    title: 'Layers',
    description: 'Show or hide the document’s optional-content layers.',
    ops: ['layers'],
  },
  {
    id: 'accessibility',
    title: 'Accessibility',
    description: 'Check the document, edit its structure tags, and fix the reading order.',
    ops: ['accessibility', 'tags', 'readingorder'],
  },
  {
    id: 'printproduction',
    title: 'Print Production',
    // Colour conversion moved here out of Optimize: converting a document to
    // CMYK is a press decision, not a file-size one, and it belongs beside
    // the tools that inspect the separations it produces.
    description: 'Preview separations and ink coverage, manage inks, check print readiness, and convert colour.',
    ops: ['outputpreview', 'inkmanager', 'preflight', 'convert_cmyk'],
  },
  {
    id: 'links',
    title: 'Links',
    description: 'Review, retarget, or delete the document’s link regions.',
    ops: ['links'],
  },
  {
    id: 'export',
    title: 'Export',
    // Properties lives here: "what is this document?" is a dialog you
    // ask about the file in front of you (Ctrl+D), not a job you pick from a
    // grid of tools.
    description: 'Pull the text out of a document.',
    ops: ['extract_text'],
  },
] as const;

export const TOOL_IDS: readonly ToolId[] = TOOL_DEFS.map((t) => t.id);

/** The tool with this id, or undefined. Takes a `string` on purpose — the ui
 * slice stores `activeToolId` loosely (it can't import this without a cycle),
 * so callers arrive with a string and an unknown id must be answerable, not a
 * cast that pretends it can't happen. */
export function toolById(id: string): ToolDef | undefined {
  return TOOL_DEFS.find((t) => t.id === id);
}

/** The tool that hosts an operation (each op belongs to exactly one). Takes a
 * `string` for the same reason as toolById — `UiState.activeOp` is a loose
 * `string`, and the reducer must be able to ask this about any of them. */
export function toolForOp(op: string): ToolDef | undefined {
  return TOOL_DEFS.find((t) => (t.ops as readonly string[]).includes(op));
}

/**
 * The tool that owns a canvas mode — i.e. which tool is active on a DOCUMENT
 * tab. `'select'` returns undefined: it is the absence of a tool, not one.
 *
 * This is how the secondary toolbar knows what to show. `activeToolId` can't
 * answer it: that names the tool whose pane the TOOLS TAB is showing, which is
 * a different question with a different answer (a tool can be open there while
 * the canvas has nothing armed, and vice versa).
 */
export function toolForCanvasTool(mode: CanvasTool): ToolDef | undefined {
  if (mode === 'select') return undefined;
  return TOOL_DEFS.find((t) => t.canvasTools?.includes(mode));
}

/** The mode opening this tool arms, if it drives the canvas at all. */
export function armedModeOf(tool: ToolDef): CanvasTool | undefined {
  return tool.canvasTools?.[0];
}

/**
 * Is this tool's work ON the document, rather than in a form on the Tools tab?
 *
 * True if it owns a canvas mode (Comment, Redact, Fill & Sign, Prepare Form) or
 * has no operations at all (Scan & OCR — not a mode, but its surface is Find,
 * which lives on the page). This is where opening the tool takes you.
 *
 * Note Fill & Sign and Prepare Form have BOTH: ops (their panes) and modes.
 * Testing ops first sent them to the Tools tab, i.e. away from the page they had
 * just armed a mode on — which the floating pill masked, because its
 * always-present Fill/Sign/+Field buttons could re-arm from the canvas. The pill
 * is gone; owning a mode is what decides.
 */
export function worksOnPage(tool: ToolDef): boolean {
  return (tool.canvasTools?.length ?? 0) > 0 || tool.ops.length === 0;
}

/**
 * The modes in which a page shows its form widgets.
 *
 * `PageCell` renders a widget ONLY in one of these (FormWidgetView returns null
 * otherwise), so this set is literally "when can you see the fields". It covers
 * authoring as well as filling: placing a new field over the ones already there
 * has to be something you can aim, and the field you just created must not
 * vanish the instant the mode changes — the create popup promises it is
 * "fillable right away".
 *
 * NOT derivable from `canvasTools` ownership: Fill & Sign also owns `signature`,
 * and widgets stay hidden there (as they always have). It's a real list, so it
 * lives here — named, used by PageCell, and tested — rather than as an inline
 * `tool === 'forms' || tool === 'formfields'` that the next mode silently misses.
 */
export const FORM_WIDGET_MODES: readonly CanvasTool[] = ['forms', 'formfields'];

export function showsFormWidgets(mode: CanvasTool): boolean {
  return FORM_WIDGET_MODES.includes(mode);
}
