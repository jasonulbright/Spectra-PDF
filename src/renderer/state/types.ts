import type { ToolbarOverrides } from '../lib/toolbar-layout';

// Bytes read over Tauri IPC arrive as a JSON number[] (read_file_buffer),
// but may also be an ArrayBuffer/Uint8Array depending on the source. pdf.js
// accepts any of these; this union avoids unsafe ArrayBuffer casts.
export type PdfBuffer = ArrayBuffer | Uint8Array | number[];

export interface OpenFile {
  path: string;           // original file path
  workingPath: string;    // temp working copy path
  name: string;
  pageCount: number;
  buffer: PdfBuffer | null;
  dirty: boolean;
  undoStack: string[];    // snapshot paths (most recent last)
  redoStack: string[];    // snapshot paths for redo
  // Registered only so its bytes are available (for rendering imported pages
  // and for the commit builder), NOT as a document of its own — the workspace
  // indexer skips these, so they never get a strip. Set by REGISTER_IMPORT_SOURCE
  // for pages imported into another document; evicted once no page references
  // them and the page tier is empty. See 2n.3 in the phase doc.
  importOnly?: boolean;
  // Phase 5 (§ F) identity channel: the ids the LAST page-tier commit
  // authored for this file's pages/partitions, valid only while `buffer`
  // IS the record's buffer object (adoption checks identity — any later
  // buffer change makes the record inert with no cleanup choreography).
  // Set by COMMIT_PAGE_EDITS; consumed by the workspace indexer.
  authoredIdentity?: import('../lib/durable-identity').AuthoredIdentity;
}

// A fingerprint of a pre-existing PDF annotation object as read at import
// time — raw PDF-space rect, not display-normalized, so rotation never
// invalidates it. Used at commit (pdfx-build.ts's stripImportedOriginals) to
// positively match and remove that one original from the copied page's real
// /Annots before re-authoring it (or, for PageRef.removedImportedOriginals,
// WITHOUT re-authoring it — see there). See
// docs/architecture/05-phase2c-annotations.md, "importing existing
// annotations safely".
export interface ImportedAnnotationFingerprint {
  subtype:
    | 'Square' | 'FreeText' | 'Ink' | 'Stamp' | 'Highlight' | 'Underline' | 'StrikeOut'
    | 'Squiggly' | 'Text'
    // Rung 2 — the shape subtypes import as editable shapes/callouts.
    | 'Circle' | 'Line' | 'Polygon' | 'PolyLine';
  rect: [number, number, number, number];
  contents?: string;
  // Color at import time — NOT used for the commit-time fingerprint match
  // (that only checks subtype/rect/contents), only to detect whether the
  // annotation has been recolored since import (see PageCell: pdf.js's
  // base raster already draws every real annotation in the currently
  // loaded file — including ones we've imported but not yet re-edited —
  // so the overlay must not also paint a visible body for those, or it
  // doubles up. Once color or note diverges from this snapshot, the file
  // on disk is stale relative to the edit and the overlay must take over.
  color: string;
  // Whether pdf.js reported the original as having a real /AP appearance
  // stream at import time. pdf.js's base raster (AnnotationMode.ENABLE)
  // synthesizes fallback appearances for AP-less Square/FreeText/Ink, but
  // NOT for a custom-name /Stamp with no /AP — so PageCell must only
  // suppress its own visible body (to avoid double-rendering) when this is
  // true; otherwise an AP-less imported annotation would render as nothing
  // until the user happens to edit it.
  hasAppearance: boolean;
}

// Native PDF text-markup subtypes (quad-based) — imported from a foreign PDF as
// first-class editable annotations (N1). Distinct from `kind: 'highlight'`,
// which authors a /Square rectangle; a native /Highlight must round-trip as
// /Highlight + /QuadPoints, never be converted to a Square.
export type TextMarkupType = 'highlight' | 'underline' | 'strikeout' | 'squiggly';

// The drawing-shape figures (rung 2 — the king's comment-toolbar shapes and
// the rival's shape set). rect/ellipse are box-defined (x/y/w/h alone);
// line/arrow are two-point; polygon/polyline/cloud carry a vertex list in
// `points` (open vertices — polygon/cloud close implicitly, UNLIKE measure's
// stored-closed area ring). Each commits as its REAL subtype (/Square
// /Circle /Line /Polygon /PolyLine) with an appearance stream.
export type ShapeType = 'rect' | 'ellipse' | 'line' | 'arrow' | 'polygon' | 'polyline' | 'cloud';

export interface PageAnnotation {
  id: string;
  // 'note' is a native /Text sticky note — a comment icon at a point, with its
  // text in `note`. Rect-based like the box kinds (no quads/points).
  // 'measure' is a finished measurement (points-based like ink): commits as a
  // REAL /Line //PolyLine //Polygon carrying /IT + /Measure, so other tools
  // can re-measure it (the king's dimension-annotation class).
  // 'shape' is a drawing figure (rung 2): shapeType picks the geometry, and
  // it commits as that real subtype. 'callout' is a text box with a leader
  // line (/FreeText + /IT /FreeTextCallout + /CL): x/y/w/h span the FULL
  // extent (box + leader) so selection and manipulation cover everything;
  // calloutBox is the text sub-rect and `points` the leader [tip, knee,
  // attach], all in the same display-normalized page space.
  kind: 'highlight' | 'freetext' | 'ink' | 'stamp' | 'textmarkup' | 'note' | 'measure' | 'shape' | 'callout';
  x: number;
  y: number;
  w: number;
  h: number;
  // textmarkup only: which markup style, and the quads it covers. `quads` is a
  // flat [x0,y0,x1,y1,...] list of AXIS-ALIGNED rects (one per marked text run),
  // display-normalized in the same 0..1 space as x/y/w/h and re-projected on
  // rotation point-by-point like `points`. x/y/w/h hold the quads' bounding box.
  markupType?: TextMarkupType;
  quads?: number[];
  // highlight: fill color. freetext: text color. ink: stroke color.
  // stamp: border/text color (fixed per preset — see STAMP_PRESETS).
  color: string; // #rrggbb
  // highlight: optional popup note. freetext: the drawn text. stamp: the
  // preset label (e.g. "APPROVED"). All three land in /Contents at commit,
  // and are what the comment sidebar lists.
  note?: string;
  // measure/callout: flat [x0,y0,x1,y1,...] vertex path, display-normalized
  // in the same space as x/y/w/h (which store the path's bounding box).
  // Re-projected point-by-point alongside the bbox on rotation. NOT used by
  // ink (see `strokes`).
  points?: number[];
  // ink only (N2): the pen strokes, one flat [x0,y0,...] path per pen-lift,
  // in the same display-normalized space. Ink uses `strokes` EXCLUSIVELY —
  // a single-stroke drawing is strokes.length === 1 — so a multi-stroke
  // /InkList (a signature) round-trips whole instead of being refused.
  strokes?: number[][];
  // stamp only: a custom IMAGE stamp's raster as a data URL (PNG/JPEG,
  // downscaled at library-import time). Present → the appearance draws the
  // embedded image instead of the bordered label; `note` still carries the
  // stamp's display name for the comment sidebar and /Contents.
  imageData?: string;
  // shape only: which figure. See ShapeType.
  shapeType?: ShapeType;
  // line/arrow/polyline only: the /LE ending names at [start, end], limited
  // to the authorable set (None, OpenArrow, ClosedArrow). Absent = plain.
  // Imports carry the original's pair so a ClosedArrow round-trips closed.
  lineEndings?: [string, string];
  // cloud only: the /BE /I intensity (default 2); imports keep the donor's.
  cloudIntensity?: number;
  // shape/callout styling (+ ink honors strokeWidth/opacity too). strokeWidth
  // is in PDF points (→ /BS /W); fillColor fills the interior (→ /IC + the
  // AP's fill — absent = none); opacity 0..1 applies to the whole annotation
  // (→ /CA). Defaults when absent: width 2, no fill, opaque.
  strokeWidth?: number;
  fillColor?: string;
  opacity?: number;
  // callout only: the text sub-rect [x,y,w,h] inside the full-extent x/y/w/h
  // (→ /RD insets at commit). The leader lives in `points`.
  calloutBox?: [number, number, number, number];
  // measure only: which dimension class (→ /Line //PolyLine //Polygon +
  // matching /IT), the ratio string (→ /Measure /R) and the reported-units-
  // per-PDF-point factor (→ the NumberFormat /C other tools re-measure with;
  // captured at measurement time so a later scale change never rewrites a
  // finished measurement).
  measureKind?: 'distance' | 'perimeter' | 'area';
  measureRatio?: string;
  measureUnitsPerPt?: number;
  measureUnit?: string;
  // Present only for annotations imported from a pre-existing PDF object.
  // Never touched after import; edits to x/y/w/h/color/note/points do not
  // update it.
  importedOriginal?: ImportedAnnotationFingerprint;
  // Set by TRANSFORM_ANNOTATIONS when an IMPORTED annotation's geometry
  // moves: the pristine-import render suppression keys on color/note, which
  // a pure move leaves equal — without this flag the moved body would stay
  // invisible (raster-only, at the OLD spot) until commit. The raster's
  // original still shows until the commit resolves both — the same
  // pending-tier semantics as deleting an imported annotation.
  geometryDiverged?: boolean;
}

export interface PageRef {
  id: string;              // stable synthetic id, survives reorder
  sourceDocId: string;     // files-map key of the file this page's bytes come from
  sourcePageIndex: number; // 0-based index into that source file's original pages
  rotation: 0 | 90 | 180 | 270;
  width: number;           // page size at scale 1, from the pdf.js viewport
  height: number;
  annotations?: PageAnnotation[]; // pending only — baked into the file at commit
  // Fingerprints of imported annotations the user REMOVED (REMOVE_ANNOTATION
  // on a PageAnnotation with importedOriginal). Once removed, the fingerprint
  // is gone from `annotations` too — without this list, stripImportedOriginals
  // would have nothing left to match the original against and would leave it
  // in place, silently undoing the removal on commit. These are consumed the
  // same way as a live annotation's importedOriginal (match → strip → done),
  // just never re-appended. Cleared implicitly on next reindex — a freshly
  // indexed PageRef has none, and the removed original is genuinely gone
  // from the file by then.
  removedImportedOriginals?: ImportedAnnotationFingerprint[];
}

// A document as composed in the workspace. Usually one per open file; a .pdfx
// manifest partitions a single file into several documents, which then share
// the same path/workingPath/buffer and differ only in id/name/pages.
export interface OpenDocument extends OpenFile {
  id: string;       // unique within the workspace — path alone can't distinguish manifest partitions
  pages: PageRef[]; // page-level index, mutated in memory by page-level ops
}

export interface Workspace {
  documents: OpenDocument[]; // ordered — the canvas view renders these as strips
}

// One entry of the in-memory page-edit undo tier: whole workspace snapshots
// are cheap (arrays of references, no bytes).
export interface PageEditSnapshot {
  documents: OpenDocument[];
  dirtyPaths: string[];
}

// The canvas interaction tool. Lives in the ui slice so command enablement
// and the keymap can read it (Phase 4 M1); PageCell re-exports the type for
// its overlay consumers. Generalizes to the 2.0 ToolId at M5.
export type CanvasTool =
  | 'select'
  // How you HOLD the page (M6.2): drag-scrolls the reading view, suppresses
  // page pickup on the board. The second OWNERLESS mode beside 'select' —
  // hand is not a tool's mode, it's the absence of one with a different grip.
  | 'hand'
  | 'highlight'
  | 'freetext'
  | 'ink'
  | 'stamp'
  | 'redact'
  | 'signature'
  // Filling a form: widgets are live inputs. Fill & Sign's mode.
  | 'forms'
  // AUTHORING a form: drag to place a new field. Prepare Form's mode.
  //
  // Was a `formsAddMode` boolean in WorkspaceCanvasView, threaded as a prop
  // through DocLayer/DocumentRow/DocumentView into PageCell — a mode in all but
  // name, invisible to the command registry and the keymap, and (being a second
  // axis on top of `tool`) the reason 'forms' had two owning tools at once and
  // "which tool is armed?" had no answer. It's a mode; it says so now.
  | 'formfields'
  // Selecting page IMAGES to replace/extract/delete (Phase 7.1). The Edit
  // tool's mode; placements come from the engine's list_page_images.
  | 'edit'
  // AUTHORING new text: drag to place a box, then type (Phase 9.A2). The Edit
  // tool's SECOND mode — a sibling of 'edit', not a replacement (Comment owns
  // four the same way). Bands like 'formfields'/'signature'; commits a fresh
  // Type0 text object via the engine's add_text_box, undoable.
  | 'addtext'
  // AUTHORING a new image: drag a box, then pick a raster (Phase 9.C2). The
  // Edit tool's THIRD mode. Bands like 'addtext'; the picked image is embedded
  // at the box via the engine's add_page_image, undoable — an ordinary
  // placement afterward (movable/resizable via C1).
  | 'addimage'
  // Measuring (parity map § 2 — the king's Measuring Tool). Three modes, one
  // tool: distance is a drag, perimeter/area are click-a-vertex sequences
  // (double-click finishes; area closes the ring). Values are computed in the
  // DISPLAYED frame (lengths are rotation-invariant); a completed measurement
  // lands as an ordinary 'ink' annotation whose note carries the value.
  | 'measuredist'
  | 'measureperim'
  | 'measurearea'
  // Scale calibration (rung 3): drag a KNOWN length, then state its value —
  // the toolbar ratio derives from it. Commits nothing.
  | 'measurecal'
  // Drawing shapes (rung 2) — ONE mode; the secondary toolbar's shape picker
  // (like stamp's preset picker) chooses WHICH figure the gesture draws:
  // rect/ellipse band, line/arrow drag, polygon/polyline/cloud vertex clicks.
  | 'shape'
  // Callout (rung 2): drag the text box; the leader lands pointing at the
  // drag origin, editable per-vertex afterward.
  | 'callout'
  // Sticky note (N3): click places a native /Text note at the point and opens
  // its editor. Comment's mode; the note keeps its fixed icon size (rung 1's
  // kind rule) so placement is the only geometry.
  | 'note'
  // Zoom marquee (N3, Acrobat's Z): band a region, the reading view zooms to
  // it. The THIRD ownerless mode beside select/hand — pure navigation, no
  // tool, commits nothing.
  | 'zoommarquee';

// The tab-strip model (Phase 4 M2, § 3.1): Home | Tools | one tab per open
// document. A doc tab focuses that file and shows the document pane (at M2:
// the all-docs organize board with that file active; M4 adds the per-doc
// Document view). The legacy ViewMode literals survive only as the harness
// snapshot's derived view (home→'welcome', tools→'operations', doc→'canvas')
// so pre-M2 e2e specs keep their assertions.
// Phase 10 slice C: 'tools' RETIRED — the Tools tab is gone; ops panels live
// in the right dock (ToolDock) and the tile grid lives on Home. ViewMode
// keeps the 'operations' literal ONLY as the harness setView() INPUT
// vocabulary (the bridge maps it to "focus the doc tab + open the dock");
// viewOf can no longer produce it.
export type FocusedTab = 'home' | { doc: string };
export type ViewMode = 'welcome' | 'operations' | 'canvas';

/** Doc-tab-land = a document tab is focused (the canvas board is showing). */
export function isDocTab(tab: FocusedTab): tab is { doc: string } {
  return typeof tab === 'object';
}

/** The harness/back-compat projection of the tab model. */
export function viewOf(tab: FocusedTab): ViewMode {
  if (tab === 'home') return 'welcome';
  return 'canvas';
}

// Left navigation pane (Phase 4 M3, § 5). The panel-id union is the full
// stable set; the runtime NAV_PANELS registry (components/navpane) only lists
// the panels that actually exist at a given sub-slice, so an icon never
// appears without a working panel (completeness rule). Persisted under the
// `workbench-ui` localStorage key (§ 4.3 — new keys don't extend `spectra-`).
export type NavPanelId =
  | 'pages'
  | 'bookmarks'
  | 'attachments'
  | 'layers'
  | 'tags'
  | 'search'
  | 'signatures';

export interface NavPaneState {
  open: boolean;
  panel: NavPanelId;
  width: number; // px, clamped ≥ NAV_PANE_MIN_WIDTH
}

// Per-document view mode (Phase 4 M4, § 6.1). `document` = the continuous
// single-column reading view (the 2.0 centerpiece); `organize` = the existing
// strips board (page-management). Global (one mode, like `tool`) — a doc tab
// renders one or the other. Entered via the toolbar toggle / Organize Pages
// tool; `View ▸ Organize All Documents` forces the board.
export type DocViewMode = 'document' | 'organize';

// Reading-view page layout (I.6): one page per row, or two-up facing spreads.
export type PageLayoutMode = 'single' | 'two';

export const NAV_PANE_MIN_WIDTH = 180;
export const NAV_PANE_MAX_WIDTH = 520;
export const NAV_PANE_DEFAULT_WIDTH = 240;

// The right-hand tool dock (Phase 10 slice B1). Panels were authored around
// ~380px of comfortable form width; the clamp keeps a drag from crushing them
// or swallowing the document.
export interface ToolDockState {
  open: boolean;
  width: number; // px, clamped to [TOOL_DOCK_MIN_WIDTH, TOOL_DOCK_MAX_WIDTH]
  // NOTE: slice D's `view: 'tool' | 'comments'` is GONE (U3). Comments are a
  // normal op panel now, seated through `tools.panel.comments` like every
  // other tool, so the dock has ONE mode and the status-bar Comments toggle
  // and the Comments tool cannot land on different surfaces.
}

export const TOOL_DOCK_MIN_WIDTH = 300;
export const TOOL_DOCK_MAX_WIDTH = 640;
export const TOOL_DOCK_DEFAULT_WIDTH = 400;
/**
 * The all-tools LIST view's width — deliberately BELOW `TOOL_DOCK_MIN_WIDTH`
 * and deliberately NOT the user's resizable width (U1, owner-directed
 * 2026-07-25). The list is a fixed-width index of tool names; a panel is a
 * working surface. The dock contracts to this when showing the list and
 * expands back to the user's width when a tool opens, so the pane is sized to
 * what it currently holds rather than to the widest thing it might hold.
 */
export const TOOL_DOCK_LIST_WIDTH = 250;

// UI state the command registry needs to read (menus/toolbars can't read
// component-local state — 19-phase4 § 4.3). Ephemeral interaction state
// (in-flight drags, rubber bands, inline edits, pending marks/placements)
// stays component-local: it has no command consumers.
export interface UiState {
  focusedTab: FocusedTab;
  activeOp: string; // Sidebar Operation id; typed loosely here to avoid a component import cycle
  // Which TOOL the Tools tab has open (a `ToolId`; loosely typed for the same
  // reason). null = show the Tools Center grid — that is the tab's landing
  // state, and the reason this can't just be derived from `activeOp`, which
  // always names some operation.
  activeToolId: string | null;
  tool: CanvasTool;
  // Document-pane view mode (M4). The board and the reading view are two
  // renders of the same per-page cells (§ 6.2); commands/toolbar read this.
  docViewMode: DocViewMode;
  // Reading-view page layout (I.6). `twoUpCover` = first page alone (the book
  // convention); only meaningful while pageLayout === 'two'.
  pageLayout: PageLayoutMode;
  twoUpCover: boolean;
  // Reading mode (I.6): collapse the app chrome (toolbar, tab strip, nav pane)
  // around the document. Menu bar stays (the discoverable exit); Esc/Ctrl+H
  // leave; leaving the doc tab clears it (chrome must exist on Home/Tools).
  readingMode: boolean;
  // Properties bar (I.6, Acrobat's Ctrl+E): a contextual strip under the
  // secondary toolbar showing the selected annotation's properties (or the
  // armed comment tool's defaults). Session-scoped like navPane.open.
  propertiesBar: boolean;
  // Split view (I.6, the king's Window ▸ Split): the reading view divides
  // over the SAME document. 'two' = stacked panes with independent
  // scroll/zoom (DocumentView state is per-instance already). 'quad' = the
  // king's SPREADSHEET split: a 2×2 grid with frozen-pane semantics — panes
  // in a row share vertical scroll, panes in a column share horizontal
  // scroll, and zoom is broadcast (linked positions under unequal zooms
  // would misalign the frozen rows). Session-scoped like propertiesBar —
  // the king doesn't persist split either. The organize board never splits
  // (one d3 world; both commands are document-mode-gated).
  splitView: 'off' | 'two' | 'quad';
  // Toolbar customization (I.6): the user's show/hide overrides against the
  // toolbar catalog. Persisted — App mirrors it to localStorage, the
  // recent-files pattern (lib/toolbar-layout.ts).
  toolbarOverrides: ToolbarOverrides;
  // The right-hand TOOL DOCK (Phase 10 slice B1): where ops-tool panels render
  // over an always-visible document. Persisted with navPane in workbench-ui.
  toolDock: ToolDockState;
  // WHICH document the reading view shows (M4.1c), as an `OpenDocument.id`.
  // The board renders every doc at once, but the reading view renders exactly
  // one — and a tab addresses a FILE, while a `.pdfx` partitions one file into
  // several documents. Without this, "the focused doc" could only ever be the
  // FIRST partition of the active file, so partitions 2+ were unreachable in
  // Read mode and a Find match inside one could never be shown. null = default
  // to the active file's first document. Resolution falls back to that default
  // when the id no longer exists (ids are positional and rebuilt on reindex).
  focusedDocId: string | null;
  // Rotate View (M6.1, § 9.1/§ 9.2): render-only quarter-turns of the READING
  // view's display, per file path. NEVER the page tier — Document ▸ Rotate
  // Pages… is the persisted edit; this is how you look at the page, dropped on
  // close and never persisted. Keyed by path (a tab's worth of reading), only
  // non-zero entries stored. The board never reads it: the board is where REAL
  // rotation lives, and a view gesture must not read as a page edit.
  viewRotationByPath: Record<string, 0 | 90 | 180 | 270>;
  // The page the reading view is currently ON (M4.1e), as a `PageRef.id`. The
  // Pages nav panel highlights and scroll-follows it, which is a DIFFERENT thing
  // from `selectedPageIds` — you can be reading page 40 with nothing selected,
  // or have a selection you scrolled away from. Reading-view only (the board
  // shows every page at once and reports no "current"), so it is null there.
  // Positional like every id here, so it is invalidated on the same triggers as
  // `focusedDocId`; a stale one would only mis-highlight, but it would still be
  // wrong (see roadmap § F).
  currentPageId: string | null;
  // Canvas multi-select (2n.1) — view state, never the page-edit tier.
  // Positional PageRef ids: any buffer-identity change clears the selection
  // (the reducer does this where the buffers change; formerly a
  // WorkspaceCanvasView effect).
  selectedPageIds: ReadonlySet<string>;
  selectionAnchor: string | null;
  // Recent files (the `spectra-recent` list) — in state because the File ▸
  // Open Recent menu and the Home tab render it; App owns persistence.
  recentFiles: import('../lib/recent-files').RecentEntry[];
  // Left navigation pane (M3). App mirrors it to the `workbench-ui` key.
  navPane: NavPaneState;
}

export interface AppState {
  files: Map<string, OpenFile>;
  activeFileId: string | null;
  ui: UiState;
  // Parallel page-level view of `files`, kept in sync asynchronously by
  // useWorkspaceIndexer. The canvas view renders it; other views still read
  // `files` directly.
  workspace: Workspace;
  // In-memory page-edit tier. Pending edits are always newer than the last
  // disk snapshot (the commit bridge drains this tier before any whole-file
  // op), so undo pops here first, then falls back to snapshot undo.
  pageUndoStack: PageEditSnapshot[];
  pageRedoStack: PageEditSnapshot[];
  pageDirtyPaths: string[]; // open files whose content must be rebuilt at commit
}

export type AppAction =
  | { type: 'OPEN_FILE'; path: string; workingPath: string; name: string; pageCount: number; buffer: PdfBuffer }
  // Register a file's bytes WITHOUT a strip, as an import source (2n.3). Not a
  // page edit (doesn't touch the page-tier undo history or activeFileId);
  // idempotent. Its pages are then spliced into a real document via IMPORT_PAGES.
  | { type: 'REGISTER_IMPORT_SOURCE'; path: string; workingPath: string; name: string; pageCount: number; buffer: PdfBuffer }
  | { type: 'CLOSE_FILE'; path: string }
  | { type: 'SET_ACTIVE_FILE'; path: string }
  | { type: 'UPDATE_FILE'; path: string; pageCount: number; buffer: PdfBuffer; snapshotPath: string }
  // Atomic variant dispatched by the commit bridge after all files are
  // rebuilt on disk: applies every file update and clears the page-edit tier
  // in one step, so no intermediate state is observable.
  | {
      type: 'COMMIT_PAGE_EDITS';
      updates: {
        path: string;
        pageCount: number;
        buffer: PdfBuffer;
        snapshotPath: string;
        // The § F identity channel — old ids in authored (new-file) order.
        authored: { pages: string[]; documents: { id: string; name: string }[] };
      }[];
    }
  // Snapshot-tier history. UNDO carries a snapshot of the pre-restore state
  // so REDO can return to it; the caller performs the disk restore and then
  // refreshes the buffer via REFRESH_BUFFER (which must not touch history —
  // that was the original multi-level-undo bug: refreshing via OPEN_FILE
  // reset the stacks after every undo).
  | { type: 'UNDO'; path: string; redoSnapshot: string }
  | { type: 'REDO'; path: string; undoSnapshot: string }
  | { type: 'REFRESH_BUFFER'; path: string; pageCount: number; buffer: PdfBuffer }
  | { type: 'MARK_SAVED'; path: string }
  // Workspace actions. SET_WORKSPACE_DOCUMENTS is dispatched by
  // useWorkspaceIndexer after a file is opened or its buffer changes. The
  // page-level mutations below are the in-memory tier: each pushes onto
  // pageUndoStack and marks the touched files dirty for the commit bridge.
  | { type: 'SET_WORKSPACE_DOCUMENTS'; path: string; documents: OpenDocument[] }
  | { type: 'REORDER_PAGES'; docId: string; order: string[] } // permutation of PageRef ids
  | { type: 'MOVE_PAGE'; fromDocId: string; toDocId: string; pageId: string; toIndex: number }
  | { type: 'MOVE_PAGE_TO_NEW_DOC'; fromDocId: string; pageId: string; docIndex: number; newDocId: string; newName: string }
  // Batched multi-select variants of the moves/delete/rotate below. Each is one
  // reducer step = one page-edit undo entry (a per-page dispatch loop would push
  // N snapshots). pageIds may span docs/files; the pages move in
  // workspace-flattened order. Same guards as the singulars (no file emptied to
  // zero pages). See docs/architecture/16-phase2n-canvas-completeness.md § 2n.1.
  | { type: 'MOVE_PAGES'; pageIds: string[]; toDocId: string; toIndex: number }
  | { type: 'MOVE_PAGES_TO_NEW_DOC'; pageIds: string[]; docIndex: number; newDocId: string; newName: string }
  // Splice NEW page refs (sourced from a REGISTER_IMPORT_SOURCE byte-only file)
  // into an existing document at an index — the import-into-doc machinery (2n.3),
  // one page-edit undo step.
  | { type: 'IMPORT_PAGES'; toDocId: string; toIndex: number; pages: PageRef[] }
  | { type: 'DELETE_PAGE_REF'; docId: string; pageId: string }
  | { type: 'DELETE_PAGE_REFS'; pageIds: string[] }
  | { type: 'ADD_ANNOTATION'; docId: string; pageId: string; annotation: PageAnnotation }
  | { type: 'UPDATE_ANNOTATION'; docId: string; pageId: string; annotationId: string; note: string }
  | { type: 'RECOLOR_ANNOTATION'; docId: string; pageId: string; annotationId: string; color: string }
  | { type: 'REMOVE_ANNOTATION'; docId: string; pageId: string; annotationId: string }
  // Annotation manipulation (rung 1). One dispatch = one gesture = one undo
  // step, so every action below is BATCH-shaped even when the UI sends one
  // entry. Geometry is display-normalized in the page.rotation frame (the
  // stored frame) — callers un-project view-frame gestures first.
  // Kind rules are enforced HERE, not per call site (the ui.tool lesson):
  // 'textmarkup' never transforms (quads are text-anchored); 'note' moves
  // but keeps its icon w/h; 'measure' recomputes its note from the caller.
  | {
      type: 'TRANSFORM_ANNOTATIONS';
      docId: string;
      edits: {
        pageId: string;
        annotationId: string;
        x: number;
        y: number;
        w: number;
        h: number;
        points?: number[];
        strokes?: number[][]; // ink only (N2)
        note?: string; // measure only: the recomputed value
        calloutBox?: [number, number, number, number]; // callout only
      }[];
    }
  // Shared style edit (rung 2): stroke width / fill / opacity across the
  // selection, one undo step. The reducer applies each property only to
  // kinds that carry it (shape/callout; ink takes width+opacity, no fill).
  // `fillColor: null` clears the fill; undefined leaves it untouched.
  | {
      type: 'RESTYLE_ANNOTATIONS';
      docId: string;
      pageId: string;
      annotationIds: string[];
      style: { strokeWidth?: number; fillColor?: string | null; opacity?: number };
    }
  | {
      type: 'REORDER_ANNOTATIONS';
      docId: string;
      pageId: string;
      annotationIds: string[];
      direction: 'front' | 'back' | 'forward' | 'backward';
    }
  | { type: 'RECOLOR_ANNOTATIONS'; docId: string; pageId: string; annotationIds: string[]; color: string }
  // Rung 3: override ONE measurement's recorded scale — new /Measure factors
  // + ratio + recomputed note, undoable like any edit. Geometry untouched.
  | {
      type: 'RECALIBRATE_ANNOTATION';
      docId: string;
      pageId: string;
      annotationId: string;
      measureUnitsPerPt: number;
      measureUnit: string;
      measureRatio: string;
      note: string;
    }
  | { type: 'REMOVE_ANNOTATIONS'; docId: string; pageId: string; annotationIds: string[] }
  | { type: 'SPLIT_DOC'; docId: string; atIndex: number; newDocId: string; newName: string }
  | { type: 'ROTATE_PAGE_REF'; docId: string; pageId: string; rotation: 0 | 90 | 180 | 270 }
  | { type: 'ROTATE_PAGE_REFS'; pageIds: string[]; delta: 90 | 180 | 270 }
  | { type: 'REORDER_DOCS'; docId: string; direction: -1 | 1 }
  | { type: 'RENAME_DOC'; docId: string; name: string }
  | { type: 'REMOVE_DOC'; docId: string }
  | { type: 'UNDO_PAGE_OP' }
  | { type: 'REDO_PAGE_OP' }
  | { type: 'CLEAR_PAGE_EDITS' }
  // ui slice (Phase 4 M1/M2). One dispatch pathway so the whole app state
  // stays snapshot-testable; commands and the keymap read state.ui.
  // Focusing a doc tab syncs activeFileId; entering doc-land is always
  // caller/command-driven (the reducer never yanks the user onto the board).
  | { type: 'UI_FOCUS_TAB'; tab: FocusedTab }
  | { type: 'UI_SET_RECENT_FILES'; files: import('../lib/recent-files').RecentEntry[] }
  | { type: 'UI_SET_ACTIVE_OP'; op: string }
  | { type: 'UI_OPEN_TOOL'; toolId: string | null }
  | { type: 'UI_SET_TOOL'; tool: CanvasTool }
  | { type: 'UI_SET_DOC_VIEW_MODE'; mode: DocViewMode }
  | { type: 'UI_SET_PAGE_LAYOUT'; layout: PageLayoutMode }
  | { type: 'UI_TOGGLE_TWOUP_COVER' }
  | { type: 'UI_TOGGLE_READING_MODE' }
  | { type: 'UI_ROTATE_VIEW'; path: string; delta: 90 | 270 }
  | { type: 'UI_FOCUS_DOC'; docId: string | null }
  | { type: 'UI_SET_CURRENT_PAGE'; pageId: string | null }
  // Click selection with the canvas's modifier semantics (computed here —
  // range/toggle need the workspace-flattened order, which lives in state):
  // 'single' replaces; 'toggle' is Ctrl-click; 'range' is Shift-click from the
  // anchor; 'context' is right-click (keep an existing multi-selection that
  // contains the page, else select just it).
  | { type: 'UI_SELECT_PAGE'; pageId: string; mode: 'single' | 'toggle' | 'range' | 'context' }
  | { type: 'UI_SELECT_ALL_PAGES' }
  | { type: 'UI_CLEAR_SELECTION' }
  // Explicit set — drag re-select after a move, and the e2e harness.
  | { type: 'UI_SET_SELECTION'; pageIds: string[]; anchor: string | null }
  // Nav pane (M3). Open on a panel (icon-strip toggle: re-opening the active
  // panel closes); toggle open/closed; resize.
  | { type: 'UI_OPEN_NAV_PANEL'; panel: NavPanelId }
  | { type: 'UI_TOGGLE_NAV_PANE' }
  | { type: 'UI_TOGGLE_PROPERTIES_BAR' }
  | { type: 'UI_TOGGLE_SPLIT_VIEW' }
  // The 2×2 spreadsheet split (frozen-pane scroll linking); quad ↔ off.
  | { type: 'UI_TOGGLE_SPREADSHEET_SPLIT' }
  | { type: 'UI_SET_TOOLBAR_OVERRIDES'; overrides: ToolbarOverrides }
  | { type: 'UI_SET_TOOL_DOCK_OPEN'; open: boolean }
  | { type: 'UI_SET_TOOL_DOCK_WIDTH'; width: number }
  | { type: 'UI_SET_NAV_PANE_WIDTH'; width: number };
