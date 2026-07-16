import type { Operation } from './operations';
import type { CanvasTool } from '../state/types';

// The workbench's TOOLS (Phase 4 M5, § 7) — the data the Tools Center tiles,
// the task panes and the secondary toolbars all read. Like the menu tree and the
// keymap, this is DATA over the command registry, not hand-placed UI: that is
// what makes "Acrobat-like" a configuration we can test rather than pixels.
//
// The shape of the change: 19 operations, grouped into 12 tools by the JOB the
// user came to do. The old rail's groups (Pages / Transform / Repair / Security
// / Content) were a taxonomy of the ENGINE — they named what the code does. A
// forms author does not think "I need a Content operation"; they think "I'm
// preparing a form". Acrobat's own tool names are the industry's vocabulary for
// those jobs, and this persona already has them in muscle memory.
//
// Every operation the app has is reachable through exactly one tool — checked by
// a totality test, so an operation can't be orphaned by a future edit.

export type ToolId =
  | 'organize'
  | 'comment'
  | 'fillsign'
  | 'prepareform'
  | 'redact'
  | 'ocr'
  | 'compare'
  | 'protect'
  | 'optimize'
  | 'repair'
  | 'watermark'
  | 'export';

export interface ToolDef {
  id: ToolId;
  /** Tile + task-pane heading. Acrobat's vocabulary where it fits (§ 1: names
   * are descriptive terms in common industry use — no Adobe branding). */
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
   * and the reason a flat pill cluster of eight modes couldn't. Comment owns
   * four; that IS the tool, in Acrobat's model and now in ours.
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
    description: 'Reorder, rotate, delete, split and extract pages.',
    ops: ['rotate', 'delete', 'split'],
  },
  {
    id: 'comment',
    title: 'Comment',
    description: 'Highlight, add notes, draw and stamp.',
    ops: [],
    // Four modes, one tool — the pill listed them flat and made the user infer
    // the grouping; Acrobat's Comment toolbar states it.
    canvasTools: ['highlight', 'freetext', 'ink', 'stamp'],
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
    description: 'Add and edit form fields, then flatten them.',
    ops: ['forms'],
    canvasTools: ['formfields'],
  },
  {
    id: 'redact',
    title: 'Redact',
    description: 'Permanently remove text and images from the file.',
    ops: [],
    canvasTools: ['redact'],
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
    id: 'export',
    title: 'Export',
    description: 'Pull the text out, or edit the document properties.',
    ops: ['extract_text', 'metadata'],
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
