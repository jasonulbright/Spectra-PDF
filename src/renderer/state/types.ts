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
  // them and the page tier is empty.
  importOnly?: boolean;
  // Identity channel: the ids the LAST page-tier commit
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
// WITHOUT re-authoring it — see there).
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
// first-class editable annotations. Distinct from `kind: 'highlight'`,
// which authors a /Square rectangle; a native /Highlight must round-trip as
// /Highlight + /QuadPoints, never be converted to a Square.
export type TextMarkupType = 'highlight' | 'underline' | 'strikeout' | 'squiggly';

// Drawing-shape figures. Rectangles and ellipses are box-defined (x/y/w/h);
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
  // /Line, /PolyLine, or /Polygon carrying /IT + /Measure so other tools can
  // re-measure it. For 'shape', shapeType picks the geometry and
  // it commits as that real subtype. 'callout' is a text box with a leader
  // line (/FreeText + /IT /FreeTextCallout + /CL): x/y/w/h span the FULL
  // extent (box + leader) so selection and manipulation cover everything;
  // calloutBox is the text sub-rect and `points` the leader [tip, knee,
  // attach], all in the same display-normalized page space.
  // 'count' is a takeoff count mark: a real /Stamp carrying
  // /IT /Count, its group in /Subj, "<group> <seq>" in /Contents and a vector
  // symbol appearance. Point-placed like 'note' (fixed marker size, so it
  // moves but never resizes); tallies are DERIVED from these, never stored.
  // 'countlegend' is a placed takeoff legend — a /FreeText + /IT /CountLegend
  // whose rows are a SNAPSHOT (carried in `legendRows`, mirrored into the
  // private /SpectraLegend so a re-commit reproduces what was placed).
  kind:
    | 'highlight'
    | 'freetext'
    | 'ink'
    | 'stamp'
    | 'textmarkup'
    | 'note'
    | 'measure'
    | 'shape'
    | 'callout'
    | 'count'
    | 'countlegend';
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
  // ink only: the pen strokes, one flat [x0,y0,...] path per pen-lift,
  // in the same display-normalized space. Ink uses `strokes` EXCLUSIVELY —
  // a single-stroke drawing is strokes.length === 1 — so a multi-stroke
  // /InkList (a signature) round-trips whole instead of being refused.
  strokes?: number[][];
  // stamp only: a custom IMAGE stamp's raster as a data URL (PNG/JPEG,
  // downscaled at library-import time). Present → the appearance draws the
  // embedded image instead of the bordered label; `note` still carries the
  // stamp's display name for the comment sidebar and /Contents.
  imageData?: string;
  // stamp only: a TYPED personal signature (F31's "type" door). The id of the
  // app-bundled script face — see lib/signature-fonts, whose faces are
  // outside the font-resolution ladder and named only by an asset. `note`
  // carries the name itself and lands in /Contents like any stamp's label;
  // the commit embeds the face's subset and draws it with no border or fill.
  // A DRAWN signature is not this: it places as an ordinary `ink` annotation,
  // so its strokes are vector paths by the same route a freehand drawing
  // takes. An IMPORTED one places as an image stamp (`imageData`).
  signatureFont?: string;
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
  // count only: the group's NAME (→ /Subj — user data, never
  // translated), the marker symbol's id (→ the private /SpectraSymbol), and
  // the mark's sequence number within its group (→ /Contents, with the group).
  // The group's colour is the annotation's own `color`.
  countGroup?: string;
  countSymbol?: string;
  countSeq?: number;
  // A VECTOR SYMBOL placed as a stamp: which registry symbol it
  // is (→ the private /SpectraSymbol), and its own geometry (→ the private
  // /SpectraSymbolParts).
  //
  // The parts travel WITH the annotation deliberately. A symbol from an
  // imported set is unknown to a machine that never imported that set, and
  // resolving an unknown id to the default marker would silently redraw
  // someone's drawing — so the geometry is carried, and the id is what
  // re-identifies it where the set IS present. A count mark carries parts too
  // when its group's marker came from an imported set (a built-in marker
  // needs no snapshot: every build has it).
  symbolId?: string;
  symbolParts?: readonly import('../lib/count-marks').SymbolPart[];
  // countlegend only: the rows the legend was placed with — a snapshot, so a
  // commit reproduces what the user saw rather than re-deriving numbers that
  // have moved since. Mirrored into /SpectraLegend and read back on import.
  legendRows?: import('../lib/count-marks').CountLegendRow[];
  legendTitle?: string;
  legendTotalWord?: string;
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
// and the keymap can read it; PageCell re-exports the type for
// its overlay consumers.
export type CanvasTool =
  | 'select'
  // How you HOLD the page: drag-scrolls the reading view, suppresses
  // page pickup on the board. The second OWNERLESS mode beside 'select' —
  // hand is not a tool's mode, it's the absence of one with a different grip.
  | 'hand'
  // Separation preview: the pages in view raster through the separation
  // device instead of the viewer's RGB renderer, because no RGB device
  // simulates overprint and no RGB raster can show one plate. It changes what
  // the page LOOKS like and not what a pointer does, so it belongs to no tool
  // — the OWNERLESS class 'select'/'hand'/'zoommarquee' are in. Being a mode
  // is what makes `openTool` disarm it: a preview left armed by a closed tool
  // would go silently live on the next document.
  | 'outputpreview'
  // Flattener preview: the page shows which objects a transparency flatten
  // would rasterize at the chosen balance. Same class and same reason as
  // 'outputpreview' — it changes what the page SHOWS and claims no gesture,
  // so it belongs to no tool and `openTool` is what disarms it.
  | 'flattenpreview'
  // Table review: the page carries the detected table regions, their column
  // boundaries and their rows, adjustable before the spreadsheet export reads
  // them. Same class and same reason as the two previews above — it belongs to
  // no tool and `openTool` is what disarms it, so a review left armed by a
  // closed tool cannot go silently live on the next document.
  | 'tablereview'
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
  // Selecting page IMAGES to replace/extract/delete. The Edit
  // tool's mode; placements come from the engine's list_page_images.
  | 'edit'
  // AUTHORING new text: drag to place a box, then type. The Edit
  // tool's SECOND mode — a sibling of 'edit', not a replacement (Comment owns
  // four the same way). Bands like 'formfields'/'signature'; commits a fresh
  // Type0 text object via the engine's add_text_box, undoable.
  | 'addtext'
  // AUTHORING a new image: drag a box, then pick a raster. The
  // Edit tool's THIRD mode. Bands like 'addtext'; the picked image is embedded
  // at the box via the engine's add_page_image, undoable — an ordinary
  // placement afterward (movable and resizable).
  | 'addimage'
  // Measuring uses three modes in one tool: distance is a drag, while
  // perimeter and area are click-a-vertex sequences
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
  // Sticky note: click places a native /Text note at the point and opens
  // its editor. Comment's mode; the note keeps its fixed icon size (rung 1's
  // kind rule) so placement is the only geometry.
  | 'note'
  // The ink eraser cuts stroke segments out of ink annotations. A mid-stroke
  // cut splits the
  // stroke, which the per-stroke model holds exactly). Comment's mode.
  | 'inkerase'
  // Zoom marquee bands a region and zooms the reading view to it. It is a pure
  // navigation mode beside Select and Hand, with no
  // tool, commits nothing.
  | 'zoommarquee'
  // Count: click places a takeoff mark of the armed group at
  // the point; clicking an existing mark of that group removes it (the
  // "click again to un-count" convention). Ctrl-drag bands a marquee that
  // re-files the marks it covers into the armed group. Count & Takeoff's mode.
  | 'count'
  // Article bead draw: band a box the article visits. Ownerless, like the
  // three preview modes — it is armed by the Articles nav panel and no tool
  // claims it, so `openTool` disarms it the moment any tool opens. The band
  // is a REQUEST: it appends a box to the article being built and nothing
  // reaches the document until the panel saves.
  | 'beaddraw'
  // Crop draw: band the region to KEEP; the Page Boxes panel receives
  // it as per-edge insets and commits through the same `set_page_boxes` op a
  // typed crop uses. The band is a REQUEST, not page state — nothing changes
  // until the panel's Apply, so a mis-drag costs a redraw, not an undo.
  | 'cropdraw'
  // Snapshot: band a region of the page and put THAT REGION on the clipboard
  // as an image, re-rendered at the snapshot resolution rather than sampled
  // from the zoom the reader happens to sit at. The document is never
  // touched; the band leaves a transient card offering to save the same
  // raster as a file.
  | 'snapshot'
  // Link draw: band the region a link covers, anywhere on the page — over a
  // figure, a table, a heading, not only over words a selection can reach.
  // The band is a REQUEST: the Links panel receives the rect in page space
  // and owns Create, so a mis-drag costs a redraw rather than an undo.
  | 'linkdraw';

// The tab-strip model: Home | Tools | one tab per open
// document. A doc tab focuses that file and shows the document pane —
// either the all-docs organize board with that file active, or the per-doc
// Document view. The legacy ViewMode literals survive only as the harness
// snapshot's derived view (home→'welcome', tools→'operations', doc→'canvas')
// so legacy e2e specs keep their assertions.
// 'tools' RETIRED — the Tools tab is gone; ops panels live
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

// Left navigation pane. The panel-id union is the full
// stable set; the runtime NAV_PANELS registry (components/navpane) only lists
// the panels that actually exist at a given sub-slice, so an icon never
// appears without a working panel (completeness rule). Persisted under the
// `workbench-ui` localStorage key (new keys don't extend `spectra-`).
export type NavPanelId =
  | 'pages'
  | 'bookmarks'
  | 'articles'
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

// Per-document view mode. `document` = the continuous
// single-column reading view; `organize` = the existing
// strips board (page-management). Global (one mode, like `tool`) — a doc tab
// renders one or the other. Entered via the toolbar toggle / Organize Pages
// tool; `View ▸ Organize All Documents` forces the board.
export type DocViewMode = 'document' | 'organize';

// Reading-view page layout (I.6): one page per row, or two-up facing spreads.
export type PageLayoutMode = 'single' | 'two';

// Which way a two-up spread reads. Set from the open document's
// /ViewerPreferences /Direction; only meaningful while pageLayout === 'two',
// since a single-page column has no facing order to reverse.
export type SpreadDirection = 'l2r' | 'r2l';

export const NAV_PANE_MIN_WIDTH = 180;
// The Pages panel adds a thumbnail column roughly every 124px, so the cap is
// what decides how many columns are reachable at all. 520 allowed four and
// read as "the pane will not widen" against a long document. This is the
// ABSOLUTE bound; the drag additionally reserves room for the document
// itself, which is a viewport question and so lives at the drag site.
export const NAV_PANE_MAX_WIDTH = 1200;
export const NAV_PANE_DEFAULT_WIDTH = 240;
/** Document width the nav-pane drag will not eat into. */
export const NAV_PANE_BOARD_RESERVE = 420;

// The right-hand tool dock. Panels were authored around
// ~380px of comfortable form width; the clamp keeps a drag from crushing them
// or swallowing the document.
export interface ToolDockState {
  open: boolean;
  width: number; // px, clamped to [TOOL_DOCK_MIN_WIDTH, TOOL_DOCK_MAX_WIDTH]
  // NOTE: the `view: 'tool' | 'comments'` is GONE. Comments are a
  // normal op panel now, seated through `tools.panel.comments` like every
  // other tool, so the dock has ONE mode and the status-bar Comments toggle
  // and the Comments tool cannot land on different surfaces.
}

export const TOOL_DOCK_MIN_WIDTH = 300;
export const TOOL_DOCK_MAX_WIDTH = 640;
export const TOOL_DOCK_DEFAULT_WIDTH = 400;
/**
 * The all-tools list width is deliberately below `TOOL_DOCK_MIN_WIDTH` and is
 * not the user's resizable width. The list is a fixed-width index of tool names;
 * a panel is a
 * working surface. The dock contracts to this when showing the list and
 * expands back to the user's width when a tool opens, so the pane is sized to
 * what it currently holds rather than to the widest thing it might hold.
 */
export const TOOL_DOCK_LIST_WIDTH = 250;

// UI state the command registry needs to read (menus/toolbars can't read
// component-local state). Ephemeral interaction state
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
  // Document-pane view mode. The board and the reading view are two
  // renders of the same per-page cells; commands/toolbar read this.
  docViewMode: DocViewMode;
  // Reading-view page layout (I.6). `twoUpCover` = first page alone (the book
  // convention); only meaningful while pageLayout === 'two'.
  pageLayout: PageLayoutMode;
  twoUpCover: boolean;
  // Facing-page order, from the open document's own reading direction.
  spreadDirection: SpreadDirection;
  // Reading mode (I.6): collapse the app chrome (toolbar, tab strip, nav pane)
  // around the document. Menu bar stays (the discoverable exit); Esc/Ctrl+H
  // leave; leaving the doc tab clears it (chrome must exist on Home/Tools).
  readingMode: boolean;
  // Properties bar: a contextual strip under the
  // secondary toolbar showing the selected annotation's properties (or the
  // armed comment tool's defaults). Session-scoped like navPane.open.
  propertiesBar: boolean;
  // Split view divides the reading view
  // over the SAME document. 'two' = stacked panes with independent
  // scroll and zoom state. 'quad' is a 2×2 grid with frozen-pane semantics:
  // panes
  // in a row share vertical scroll, panes in a column share horizontal
  // scroll, and zoom is broadcast (linked positions under unequal zooms
  // would misalign the frozen rows). This state is session-scoped. The
  // organize board never splits
  // (one d3 world; both commands are document-mode-gated).
  splitView: 'off' | 'two' | 'quad';
  // Toolbar customization (I.6): the user's show/hide overrides against the
  // toolbar catalog. Persisted — App mirrors it to localStorage, the
  // recent-files pattern (lib/toolbar-layout.ts).
  toolbarOverrides: ToolbarOverrides;
  // The right-hand TOOL DOCK: where ops-tool panels render
  // over an always-visible document. Persisted with navPane in workbench-ui.
  toolDock: ToolDockState;
  // WHICH document the reading view shows, as an `OpenDocument.id`.
  // The board renders every doc at once, but the reading view renders exactly
  // one — and a tab addresses a FILE, while a `.pdfx` partitions one file into
  // several documents. Without this, "the focused doc" could only ever be the
  // FIRST partition of the active file, so partitions 2+ were unreachable in
  // Read mode and a Find match inside one could never be shown. null = default
  // to the active file's first document. Resolution falls back to that default
  // when the id no longer exists (ids are positional and rebuilt on reindex).
  focusedDocId: string | null;
  // Rotate View: render-only quarter-turns of the READING
  // view's display, per file path. NEVER the page tier — Document ▸ Rotate
  // Pages… is the persisted edit; this is how you look at the page, dropped on
  // close and never persisted. Keyed by path (a tab's worth of reading), only
  // non-zero entries stored. The board never reads it: the board is where REAL
  // rotation lives, and a view gesture must not read as a page edit.
  viewRotationByPath: Record<string, 0 | 90 | 180 | 270>;
  // The page the reading view is currently ON, as a `PageRef.id`. The
  // Pages nav panel highlights and scroll-follows it, which is a DIFFERENT thing
  // from `selectedPageIds` — you can be reading page 40 with nothing selected,
  // or have a selection you scrolled away from. Reading-view only (the board
  // shows every page at once and reports no "current"), so it is null there.
  // Positional like every id here, so it is invalidated on the same triggers as
  // `focusedDocId`; a stale one would only mis-highlight, but it would still be
  // wrong.
  currentPageId: string | null;
  // Canvas multi-select — view state, never the page-edit tier.
  // Positional PageRef ids: any buffer-identity change clears the selection
  // (the reducer does this where the buffers change; formerly a
  // WorkspaceCanvasView effect).
  selectedPageIds: ReadonlySet<string>;
  selectionAnchor: string | null;
  // Recent files (the `spectra-recent` list) — in state because the File ▸
  // Open Recent menu and the Home tab render it; App owns persistence.
  recentFiles: import('../lib/recent-files').RecentEntry[];
  // Left navigation pane. App mirrors it to the `workbench-ui` key.
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
  // `index` is a position in TAB space (byte-only import sources are not in
  // it). Absent, the file appends, which is what every open but a dropped tab
  // does; given, it lands at that position, clamped.
  | { type: 'OPEN_FILE'; path: string; workingPath: string; name: string; pageCount: number; buffer: PdfBuffer; index?: number }
  // Move an open document's TAB to an index. View arrangement, not a document
  // edit: nothing is dirtied, no history is touched, and the files Map's
  // insertion order stays the one authority on tab order.
  | { type: 'REORDER_FILE'; path: string; index: number }
  // Register a file's bytes WITHOUT a strip, as an import source. Not a
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
        // The identity channel — old ids in authored (new-file) order.
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
  // zero pages).
  | { type: 'MOVE_PAGES'; pageIds: string[]; toDocId: string; toIndex: number }
  | { type: 'MOVE_PAGES_TO_NEW_DOC'; pageIds: string[]; docIndex: number; newDocId: string; newName: string }
  // Splice NEW page refs (sourced from a REGISTER_IMPORT_SOURCE byte-only file)
  // into an existing document at an index — the import-into-doc machinery,
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
        strokes?: number[][]; // ink only
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
      style: {
        strokeWidth?: number;
        fillColor?: string | null;
        opacity?: number;
        // Kind-specific sheet fields (residual): the reducer applies
        // each only to kinds that carry it — endings to line/arrow/
        // polyline, cloud intensity to clouds.
        lineEndings?: [string, string];
        cloudIntensity?: number;
      };
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
  // Re-file count marks into another group (the Ctrl-marquee
  // gesture). Colour and symbol travel with the group, and each moved mark is
  // renumbered at the end of the target — its old number belonged to the
  // group it left.
  | {
      type: 'REGROUP_COUNT_MARKS';
      docId: string;
      pageId: string;
      annotationIds: string[];
      group: string;
      color: string;
      symbol: string;
    }
  | { type: 'SPLIT_DOC'; docId: string; atIndex: number; newDocId: string; newName: string }
  | { type: 'ROTATE_PAGE_REF'; docId: string; pageId: string; rotation: 0 | 90 | 180 | 270 }
  | { type: 'ROTATE_PAGE_REFS'; pageIds: string[]; delta: 90 | 180 | 270 }
  | { type: 'REORDER_DOCS'; docId: string; direction: -1 | 1 }
  | { type: 'RENAME_DOC'; docId: string; name: string }
  | { type: 'REMOVE_DOC'; docId: string }
  | { type: 'UNDO_PAGE_OP' }
  | { type: 'REDO_PAGE_OP' }
  | { type: 'CLEAR_PAGE_EDITS' }
  // ui slice. One dispatch pathway so the whole app state
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
  // A document's own initial view, applied as ONE act. Null fields are what
  // the document did not state; the workbench keeps what the user had.
  | { type: 'UI_APPLY_INITIAL_VIEW'; plan: import('../lib/initial-view').InitialViewPlan }
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
  // Nav pane. Open on a panel (icon-strip toggle: re-opening the active
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
