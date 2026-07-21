# Changelog

## 2.7.0 — Style a selection, edit the shapes

### Rich text — style a SELECTION, not just the whole box
- **Colour, bold, italic, font family, and size now apply to a selected
  range** inside a paragraph: highlight a word and recolour it, embolden a
  single term, or resize a heading fragment — the rest of the paragraph keeps
  its own style. (The whole-paragraph controls are still there when nothing
  is selected.)

### Vector graphics — the drawn lines and shapes are editable
- **Select a drawn line, rectangle, or shape** on the page in the Edit tool
- **Move, resize, and rotate** it with direct-manipulation handles
- **Recolour** its fill and stroke, **set its line width**, or **delete** it
  — every change undoable, like the rest of the editor
- Shapes **inside a form/group** are selectable and editable too; editing one
  leaves the group's other uses untouched

## 2.6.0 — Author, arrange, and restyle: the editor grows up

### Put NEW things on the page
- **Add Text** — draw a box, type, pick size/colour/font family, and the
  text lands as a real, searchable, re-editable text object
- **Add Image** — draw a box and place a picture (JPEG passes through
  losslessly; everything else is embedded pixel-perfect)

### Move what's already there
- **Images are now directly manipulable**: drag to move, corner handles
  to resize, a rotate handle for free angles — plus one-click 90° turns
- **Crop and opacity** — trim an image to a region (non-destructively;
  the picture data is kept) and dim it with a live opacity slider
- **Split and merge paragraphs** — press Enter inside a paragraph to
  split it in two; Backspace at the start of one joins it to the
  paragraph above, reflowing through the same layout engine as every
  other edit

### Restyle with real typefaces
- The paragraph editor's **font family menu** substitutes a whole
  paragraph into bundled Liberation Sans, Serif, or Mono — labelled
  honestly as the face you get
- **Bold and italic** buttons substitute the matching bundled variant
  (twelve faces now ship, all metric-compatible with the common
  Windows core fonts)

### Edit more documents
- **Symbolic fonts** (icon and custom-encoded fonts with an embedded
  font program) are now editable where the program itself provides a
  usable character map — previously refused outright

### Reliability
- Fixed a race where a form field created on canvas could silently
  fail to appear (and a follow-up signature into it would fail) under
  heavy system load; field creation now either succeeds visibly or
  says exactly why it needs a redraw
- Fixed image edits on pages sharing resources leaking entries into
  sibling pages

## 2.5.0 — A bigger text editor: CJK, real fonts, and restyling

### Edit far more documents
- **Chinese, Japanese, and Korean text is now editable** — documents
  whose fonts use the standard Unicode CJK encodings (the `Uni…-UCS2`
  family) open for editing instead of being refused
- When a typed character needs a substitute font, the replacement now
  **matches the original's style** — a serif document's text converts in
  a serif face, monospaced in monospaced, instead of everything becoming
  sans-serif

### Restyle, not just retype
- The paragraph editor gained **size and colour controls**: change a
  paragraph's font size (it rewraps and re-spaces to fit) or recolour it,
  right in the editor — the first step from "fix a typo" toward real
  editing
- Outline (stroked) text recolours correctly, and an out-of-range size is
  clamped so text can't fly off the page

## 2.4.0 — Create PDF from PostScript

### The distilling job, without the extra app
- **File ▸ Create PDF from PostScript…** — convert `.ps` and `.eps`
  files to PDF with the classic quality presets (Smallest Size, eBook,
  Print Quality, Press Quality), then open the result in one click.
  Powered by the Ghostscript already bundled for compression and PDF/A —
  the tool that has always been this job's reference implementation,
  finally doing it here
- EPS files convert with their bounding box as the page — figures stay
  figures, not letter-size pages with a drawing in the corner
- Honest inputs: a non-PostScript file is refused with the reason named,
  and feeding a PDF points you at Repair's rebuild tier instead of
  silently re-rendering your document
- Full command-line parity: `openpdfstudio distill input.ps -o out.pdf
  --preset printer`
- The README now carries a **feature sourcing table** — every capability
  mapped to the open-source component that powers it, license by license

## 2.3.0 — Combine Files, findability, and a steadier workspace

### Find the features (launch-thread feedback)
- **Document ▸ Combine Files…** — merging PDFs now has a named menu
  path: pick files and their pages are appended to the current document,
  undoable like every page edit. (Dragging documents together on the
  Organize board works exactly as before — this is the same power, now
  findable by name.)
- Tool tiles say what they actually do: Organize Pages names **merge**
  and **delete**, Comment names **text boxes**, and Edit now describes
  its full surface — **text, whole paragraphs, and images**
- Nothing moved and nothing changed behavior — these are the same
  features, now discoverable

### Your place survives your edits
- Selecting pages, reading a specific section, or jumping to a bookmark
  no longer gets forgotten every time an edit is saved: **selection,
  reading position, and document focus now survive page-edit commits** —
  including edits saved in a different open file, which previously reset
  everything everywhere
- Moved pages keep their thumbnails steady across a save (no more
  flicker as they re-render)
- Under the hood this is real cross-commit page identity, engineered so
  a stale reference can never point at the wrong page — positions still
  reset only when a file's content is rebuilt outside the editor (an
  engine operation, undo of a save, or an external change), where
  holding a position would be a guess

## 2.2.0 — Edit Text & Paragraph Reflow

### Edit Paragraphs — reflow inside the box
- Text that reads as a paragraph now **selects as one box**: double-click
  it (or choose Edit Paragraph…) and edit the whole passage in a
  multi-line editor — words **rewrap inside the paragraph's own box**,
  with its alignment (left, centered, right, or justified), line spacing,
  and first-line indent preserved, and the box growing downward when the
  text does
- Styles survive the edit: mixed fonts and sizes, colored spans (links),
  superscripts, condensed text, and OCR's invisible text layer all keep
  their look — typed text takes on the style at the point you typed it
- Everything OUTSIDE the box stays put, exactly: columns beside the
  paragraph, text below it, graphics — nothing else on the page moves or
  changes appearance
- The same per-keystroke font honesty as single-line editing, span by
  span — and the one-click compatible-font fallback now converts only
  the characters that need it
- Wraps no-space scripts (CJK) correctly; hyphens are treated as document
  text (never invented or removed); right-to-left passages and rotated
  text stay on the single-line editor, with the reason stated
- Paragraph detection is honest about its limits: text that doesn't
  group cleanly simply remains individually editable line by line

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
