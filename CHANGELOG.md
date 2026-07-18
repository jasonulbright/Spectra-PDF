# Changelog

## Unreleased

### Edit Text — in-place text editing
- The Edit tool now selects **lines of text** as well as images:
  double-click a run (or select it and choose Edit Text…) and rewrite it
  in place, in the document's own font — undoable like everything else
- Honest to the font: the editor validates **every keystroke** against
  what the document's embedded font can actually express and names the
  character it can't ("this document's font does not contain '→'") —
  including characters a subsetted font never included. Text in the rare
  fonts that can't round-trip (Type3, missing ToUnicode) says why instead
  of failing
- The layout holds: replacement text keeps the original position, and
  words later on the same line slide over by exactly the width difference
  — kerned text, stretched text (Tz), and text inside reused form
  graphics all measured to the point
- Editing a signed document warns first, and cancelling really cancels —
  the file is left byte-untouched
- When the document's font can't express what you typed, one click
  re-renders the edit in a bundled compatible font (Liberation Sans, SIL
  OFL) — subsetted, embedded, and still fully searchable

## 2.1.0 — Edit Images & Batch OCR

### Edit Images — the first Edit tool
- New **Edit** tool: click any image on the page and **replace** it (the
  new picture drops into the exact same spot), **extract** it to a file,
  or **delete** it — all undoable like every other operation
- Precise by placement: an image used in several places changes only where
  you clicked, including images inside reused form graphics
- Replacing keeps JPEG quality untouched (the original file's bytes are
  embedded as-is); other formats are converted losslessly, transparency
  preserved
- Editing a digitally-signed document warns first — edits invalidate
  signatures
- Text editing is on the way as the next slices of the same tool

### Batch OCR (folder mirror)
- New Tools ▸ **Batch OCR Folder…** — pick a source folder and a destination,
  and every PDF under the source is mirrored into the destination with its
  scanned pages made searchable (invisible text layer, same recognition as
  the in-app OCR — offline, bundled). Already-searchable files copy through
  byte-identical; encrypted or damaged files are skipped and reported;
  the source tree is never modified
- The run shows per-file, per-page progress and can be stopped; the report
  is honest to the page: files where some scanned pages had no recognizable
  text say so, and unreadable subfolders are listed rather than silently
  missing from the mirror
- Works with no document open; language selectable (English, German,
  French, Spanish)
- Safety: destination inside the source is refused — including when the
  same folder is reached by two different path spellings — and overwrite
  collisions with the originals are refused at the file level as well

## 2.0.0 — The Workbench

The whole application becomes a full-featured workbench: a menu bar, a main
toolbar, tabs, a reading view, and twelve task-oriented tools over the same
engine — with a keymap verified against the industry-standard editor's
published shortcut table and frozen. Everything from 1.0 is still here; it
moved into a shape you already know how to drive.

### The frame
- Menu bar (File/Edit/View/Document/Tools/Window/Help), main toolbar, and a
  tab strip: Home, Tools, and one tab per open document
- Home tab with recent files (now with an opened-when column) replaces the
  welcome screen; the Tools tab hosts a tile grid of the twelve tools
- Windows 11 Mica translucency on the chrome where the OS supports it, with
  a byte-identical solid fallback on Windows 10

### Reading view
- A continuous, virtualized reading view is the default way to see a
  document — smooth with 1,000-page files (measured: first paint ~1/3s,
  4–6 pages mounted at any scroll depth)
- Real text selection and copy; zoom presets (Ctrl+0/1/2), a page box
  (Ctrl+Shift+N), and cross-document Find/Search
- Rotate View (view-only quarter turns, Ctrl+Shift+Plus/Minus) — the page
  turns, the file doesn't; every tool keeps working while turned
- Hand/Select modes with Space as a temporary hand
- The Organize view (the 1.0 page-strip board) remains one click away —
  View ▸ Organize All Documents — for rearranging pages across files

### Navigation pane
- Pages (thumbnails with drag-reorder), Bookmarks (with editing), Search,
  and Signatures panels; F4 toggles the pane, Shift+F4 the Tools tab

### Tools, dialogs, print
- The whole-file operations regrouped into twelve tools by the job:
  Organize, Comment, Fill & Sign, Prepare Form, Redact, Scan & OCR,
  Compare, Protect, Optimize, Repair, Watermark, Export
- Document Properties on Ctrl+D; Preferences as a categorized dialog on
  Ctrl+K; every dialog closes on Escape and traps focus properly
- **Print** (Ctrl+P): printer picker, page range, copies, fit/actual —
  through the bundled Ghostscript to any Windows printer; `print` and
  `printers` CLI arms ship alongside
- Insert blank pages (Ctrl+Shift+T) sized to their neighbor, undoable like
  every page edit

### Keyboard
- The keymap, cross-verified against the industry-standard editor's
  published table and frozen: standard chords, the document-op set
  (Ctrl+Shift+D/I/R/T/N), F3/Ctrl+G find stepping, and optional single-key
  tool accelerators (H/V/U/X/D/K) — off by default
- The webview's own keys (reload, browser zoom) can never fire — a
  disabled shortcut means nothing happens, not something surprising

### Correctness
- One file is one document no matter how its path is spelled (case,
  slashes, short names) — paths canonicalize at the OS boundary
- Printing, properties, and every whole-file operation see pending page
  edits (the commit gate holds across the new views)

## 1.0.0 — The Canvas Workspace

Open PDF Studio grows from a batch-operations tool into a visual PDF workspace:
open several files as page strips on one canvas, rearrange pages within and
across them, annotate, redact, fill and build forms, sign, OCR, and compare —
every edit staged in memory, applied atomically, and undoable. The CLI keeps
full parity for every whole-file transform.

### The canvas
- Multi-file canvas: every open PDF is a strip of live page thumbnails; drag
  pages to reorder within a document, move them between documents, or pull
  them out into a new one — single pages or multi-selections (Ctrl/Shift
  click, Ctrl+A), always as one undo step
- Whole-document merge: one click appends a document's pages to the one
  above; drop files onto a document to import their pages at that position,
  or use the per-row "add pages" control
- Staged edits: rotations, deletions, moves, imports, and annotations stay
  in memory until "Apply changes" commits every touched file atomically;
  multi-level undo/redo spans staged edits and applied operations
- The `.pdfx` format ([Alexandros Gounis's open format](https://github.com/AlexandrosGounis/pdfx)):
  several documents saved as one ordinary, fully-compatible PDF that
  reopens as separate strips
- Keyboard shortcuts throughout (Ctrl+Z/Y, Ctrl+A, Delete, `[`/`]` rotate,
  Ctrl+F find, Ctrl+=/−/0 zoom)

### Annotate, redact, sign
- Highlights, text boxes, freehand ink, and preset stamps with notes,
  recoloring, and a comments sidebar; existing PDF annotations import as
  editable objects
- True redaction: marked regions are REMOVED from the file's content —
  text, images, nested form XObjects, and overlapping annotations — never
  merely covered
- Digital signatures: verify embedded signatures (cryptographic validity +
  document integrity, with an honest trust caveat); sign with a .pfx or a
  PEM key + certificate, place a visible stamp anywhere on a page, generate
  a self-signed identity in-app — or click an empty signature field and
  sign directly into it
- Watermarks (text, any angle, auto-fit) and PDF compare: a text diff with
  word-level highlights AND a pixel-level visual diff that catches
  scanned/image-only changes

### Forms
- Fill AcroForm fields directly on the page — text, checkboxes, radios,
  dropdowns, list boxes — with pending values that survive page edits, then
  bake them in one click; or use the classic panel
- Create new fields by drawing them: text, checkbox, radio group, dropdown,
  option list, and empty signature fields
- Form fields now survive every structural operation — page moves and
  rotations, merges, splits, page deletion, compression, and grayscale
  conversion all preserve fields and their values

### Find & OCR
- In-viewer Find (Ctrl+F) across every open file with match navigation and
  per-word highlights
- Scanned pages OCR automatically (offline, bundled recognition); "Make
  searchable" persists an invisible text layer into the file — the page
  stays pixel-identical and its text becomes selectable and searchable in
  any PDF reader
- Bookmarks: a click-to-jump outline sidebar with drag-reorder, plus the
  full tree editor; bookmark links and actions survive editing

### CLI
- New subcommands: `forms` (read/fill/flatten), `outline` (get/set JSON),
  `redact`, `watermark`, `compare` (text + `--visual`), `verify-signatures`,
  `sign` (including `--existing-field`), and `generate-signer`

### Fixed
- Merging, splitting, deleting pages, compressing, or converting a form PDF
  no longer silently destroys its form fields
- Engine I/O is UTF-8 end to end — non-ASCII text (names, bookmarks, form
  values) round-trips correctly in both GUI and CLI (was cp1252 on Windows)
- Reopening an already-open file can no longer briefly serve its previous
  in-memory state

## 0.9.0 — Initial Release

First public release of Open PDF Studio.

### Features
- **Pages** — merge, split by range, rotate, delete
- **Transform** — compress (presets + custom DPI), grayscale, optimize, PDF/A, PDF version control
- **Security** — encrypt / decrypt (AES-256)
- **Content** — extract text, view / edit / strip metadata
- **Repair** — repair, rebuild, and recover damaged PDFs (3-tier)
- **Preview** — thumbnail grid, page inspector, drag-to-reorder merge workspace
- **CLI / headless** — every operation scriptable, plus batch processing over a directory
- **Windows integration** — NSIS installer, silent install/uninstall, file associations, Explorer context menu, system tray, start-with-Windows, auto-update
- Light / dark / system themes, WCAG 2.1 AA

### Built with
- Tauri v2 (Rust + WebView2) + React 19
- Embedded Python 3.14 (pikepdf, pdfminer.six)
- Vendored upstream Ghostscript 10.07.1 (AGPL-3.0)
