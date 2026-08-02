# Changelog

## 1.0.12 — Accents that sit right, crops you can draw

Text with accents and ligatures now sets the way its typeface intends,
vertical Chinese, Japanese and Korean text restyles, right-to-left edits
keep the document's own typeface, and cropping is a rectangle you drag.

### Text
- **Accents land on their letters.** Text edited with combining accent
  marks now composes properly instead of leaving the accent stranded
  beside its letter.
- **Ligatures form where the typeface has them.** A face that carries
  ligatures uses them when you edit — and the words still copy, search and
  extract as ordinary letters.
- **Right-to-left edits keep the document's own typeface.** When the
  document's font can carry the edit, Arabic and Hebrew changes are drawn
  in that font rather than substituted for a bundled one.
- **Vertical Chinese, Japanese and Korean text restyles.** Size, colour
  and weight now apply to text set in columns, using the upright letter
  forms and column spacing the font provides.

### Pages
- **Draw a crop.** Pick Crop & Page Boxes and drag a rectangle on the page
  to mark what to keep; the margins fill in, and Apply crops as before.
  Typing the margins still works exactly the same way.

## 1.0.11 — Every font, every encoding

The font list is now the one on your machine, the last text encodings that
refused to open now edit, and batch OCR takes loose images and locked files.

### Text
- **Use any font you have installed.** The Add Text card and the paragraph
  editor now list every font on this machine alongside the bundled
  families. Fonts whose licence forbids embedding are not offered, and the
  picker says how many were left out rather than leaving you hunting.
- **Older Chinese, Japanese and Korean encodings edit.** Documents using
  Shift-JIS, EUC, Big5 or GBK text — which mix one- and two-byte
  characters in the same line — open for editing instead of being
  declined, as do documents using UTF-8, UTF-16 and UTF-32 text.

### Scan & OCR
- **OCR loose images in a batch.** Point a batch run at a folder and it
  can now take PNG, JPEG, TIFF and BMP files alongside the PDFs, turning
  each into a searchable PDF.
- **Batch past a password.** Supply the password for an encrypted file
  with the run and it is processed like any other; without one it is
  skipped and named in the report, exactly as before.

## 1.0.10 — Write it in any direction

Right-to-left text is no longer something the app can only read and
reflow — you can now write it: new text boxes, styled selections,
watermarks and form fields all take Arabic, Hebrew, Persian and Urdu.

### Text
- **Add Text writes right-to-left.** Type Arabic or Hebrew into a new
  text box and it lays out in reading order, wraps, and draws with
  cursive letters properly joined. Mixed text keeps embedded Latin words
  and numbers the right way round.
- **Style a selection in right-to-left text.** Size, colour, bold and
  italic apply to a selected word or phrase, the same as anywhere else.
  A style change in the *middle* of a joined word is declined with a
  note rather than drawn — the word would break open at the seam.

### Watermarks
- **Right-to-left watermarks**, shaped and laid out correctly.
- **Chinese, Japanese and Korean watermarks**, which were previously
  declined.

### Forms
- **Right-to-left form values.** Filling a field with Arabic or Hebrew
  now produces a properly shaped, correctly ordered appearance, on one
  line or wrapped across several.

### Under the hood
- **Fully vocalised Arabic round-trips.** Text carrying vowel marks —
  harakat — is written, read back, and re-edited exactly as typed,
  including words that form ligatures.

## 1.0.9 — Right to left, and it reads back

Arabic, Hebrew and Persian paragraphs edit and reflow like any others.
Repeated image edits stop piling up. Documents that number their pages
their own way are navigated that way.

### Text
- **Right-to-left paragraphs edit.** Arabic, Hebrew, Persian, Urdu and
  the other right-to-left scripts now reflow: type into a paragraph and
  it re-wraps, re-orders and re-draws correctly, with embedded Latin
  words and numbers staying the right way round. The text you edit is in
  reading order, and the box you type into reads that way too.
- **Arabic letters stay joined.** Arabic is cursive — every letter
  changes shape depending on its neighbours — so edited text is
  re-shaped rather than re-typed letter by letter. A shaping-capable
  font ships with the app for exactly this. Ligatures and letter marks
  survive the round trip, so an edited paragraph can be edited again.
- **A paragraph is only offered when it can be read back.** Where a
  document's drawing order cannot be traced to a single reading order,
  the paragraph says so instead of guessing — the individual text runs
  stay editable, as before.

### Pages
- **Navigate by the page's own number.** A document that labels its pages
  the way the printed thing does — i, ii, iii for front matter, then a
  body restarting at 1 — now shows that label in the page box, with the
  sheet position beside it. Type a label or a sheet number; either works.

### Images
- **Repeated edits stop stacking.** Moving or re-scaling the same image
  several times used to leave a layer of transform behind each time, and
  the same for opacity. Both now collapse, so a much-adjusted image
  leaves a file no more complicated than a once-adjusted one.

### Reliability
- **One file, one operation at a time.** Two operations that rewrite the
  same file can no longer overlap; the second waits for the first. A
  failed operation releases its file immediately.

## 1.0.8 — Style the spans, read every script

Added text gains per-selection styling, Chinese, Japanese and Korean text
becomes fully writable, and a high-contrast theme joins the app.

### Text
- **Style parts of added text.** Select any part of the text in the Add
  Text card and give it its own size, colour, bold, or italic — mixed
  sizes lay out with correct line heights, and the fit indicator measures
  exactly what will be drawn.
- **Chinese, Japanese, Korean.** Text in CJK scripts can now be added,
  edited, and filled into forms. A CJK-capable font ships with the app
  and steps in exactly when the standard fonts can't express the text —
  never otherwise. Mixed CJK-and-Latin strings stay in one font.

### Accessibility
- **High-contrast theme.** Settings ▸ Theme gains a high-contrast option:
  black backgrounds, full-white text, bright accents, and strong gold
  focus outlines — applied from the first frame, with document pages
  left exactly as the file renders them.

## 1.0.7 — Every font edits, every image too

The last font-format refusals fall, inline images join the image tools,
and text runs gain styling.

### Text
- **Type 3 fonts edit.** Documents using glyph-procedure fonts — common in
  TeX output and older generators — now edit like any other text.
- **Style a text run.** The text-run editor gains size and colour: change
  one run's size or colour without touching its text, with neighboring
  text staying exactly where it was.

### Images
- **Inline images are full citizens.** Images embedded directly in page
  content streams — previously visible but untouchable — can now be
  replaced and extracted like any other image.

### Under the hood
- **Render-performance tracking.** The test build now measures page
  rendering, so future releases can prove they got faster — or catch
  themselves getting slower.

## 1.0.6 — Sign with hardware, edit more fonts

Signing gains hardware-token support, PostScript forms distill into working
forms, and two long-standing font limits fall.

### Sign with a hardware token
- **PKCS#11 devices.** Sign with a smart card, USB token, or HSM: choose
  the vendor's PKCS#11 module, name the token and certificate, and enter
  the PIN — every signing feature works the same as with a file-based
  identity, including visible stamps, signing into existing fields,
  in-place signing, and the full PAdES range with timestamps and long-term
  validation. On the command line too.

### Forms from PostScript
- **Distilled forms work.** PostScript files carrying Distiller-style form
  annotations now produce PDFs whose fields actually work — readable,
  fillable, and saved values intact. Previously the fields arrived
  visible but dead.

### More documents become editable
- **CJK text without an embedded text map.** Documents whose composite
  fonts lack the usual text-mapping table now recover it — from the
  registered character collection when one is named, or from the embedded
  font itself for subset fonts. Text that used to refuse editing with
  "cannot be re-entered" edits normally.
- **Classic font formats.** Text set in bare CFF or original Type 1 fonts
  — common in older documents — is now editable, using the font's own
  built-in encoding and widths.

## 1.0.5 — Lock with certificates, print with intent

Documents can now be encrypted to certificates instead of passwords, form
behavior survives every page operation, and the prepress tools grow real
colour-profile control and PDF/X output.

### Certificate encryption
- **Encrypt to people, not passwords.** Lock a document to one or more
  recipient certificates — anyone holding a matching private key opens it,
  and nobody has to share a password. The same permission controls apply,
  and screen-reader access is never blocked.
- **Opening certificate-encrypted files.** The app now recognizes them and
  asks for your key file (.pfx / .p12) — including files other tools
  encrypted this way, which previously failed with an unhelpful error.
- Both directions are on the command line too.

### Forms keep their behavior
- **Calculation order survives.** Forms whose fields calculate from each
  other keep their calculation order through page inserts, merges, splits,
  deletions, and every other page operation — reconciled field by field,
  so removed fields drop out cleanly.
- **Document scripts survive.** Scripts that run on save, print, or close
  stay with the document through page operations and through compression.
- **XML (XFA) forms are protected.** Page operations on an XFA form would
  detach the form from its pages, so they now refuse with a clear message —
  previously the form data was silently destroyed.

### Prepress
- **Choose your destination profile.** Convert to CMYK through your own
  ICC profile, the bundled one, or Ghostscript's built-in default.
- **PDF/X print masters.** Produce PDF/X-1a, X-3, or X-4 files carrying a
  real output intent — naming a standard printing condition, or embedding
  your chosen profile. The conversion verifies its own output before
  reporting success.

### Sharper and handier
- **Zoom stays sharp on rotated pages.** Zooming into a page whose
  rotation hasn't been applied yet now renders at full detail instead of
  scaling up a coarse preview.
- **Actual Size and Fit Width on the page board.** Both presets now work
  in the page-organizing view, zooming to the selected page.

## 1.0.4 — Marks that keep, buttons that work

Redaction marks now survive closing the file. Form buttons do what they
say. Shapes rotate and flip, pen drawings get an eraser, and visible
signatures start straight from the panel.

### Redaction you can put down and pick up
- **Save your marks.** A new "Save marks" button stores redaction marks in
  the document as standard redaction annotations — close the file, reopen
  it next week, and the marks are waiting. Other PDF tools see them too,
  because they're saved in the format's own interchange form.
- Marks never print, and saving them keeps existing signatures valid.
  Applying the redaction consumes them, exactly as before.

### Forms: buttons act, and reset means reset
- **Push buttons respond.** Reset buttons actually clear the form back to
  its designed defaults. Link buttons show you the address and offer to
  copy it — the app never opens the web on its own. Buttons wired to
  scripts or submissions say so honestly instead of doing nothing.
- **Reset from the panel or button** re-renders every field's appearance
  and keeps signatures intact.

### Drawing and shape polish
- **An eraser for pen drawings.** The comment toolbar's new Eraser removes
  exactly what it touches — cut a stroke in the middle and both ends
  survive, trimmed at the eraser's edge. One undo restores the scrub.
- **Rotate and flip shapes.** Lines, arrows, polygons, clouds, drawings,
  and measurements rotate in quarter turns and mirror horizontally or
  vertically — group selections turn as one.
- **Line endings and cloud style.** Arrowheads on either end of lines and
  polylines, and cloud bumpiness, are now editable in the properties bar.

### Signing
- **Visible signature, straight from the panel.** The Signatures panel's
  sign form now hands off to on-page placement with your certificate
  details carried over — pick the spot, sign, done.

## 1.0.3 — Signed documents stay signed

The headline: you can now comment on, fill in, and add pages to a signed
document without breaking its signatures. Alongside it: a live print
preview, pen strokes that behave like a pen, and three long-reserved
keyboard shortcuts come alive.

### Signatures survive your edits
- **Comment, fill, and add pages — signatures intact.** Edits to a signed
  document are now appended to the file the way the format intends, so
  every existing signature keeps verifying. This covers comments and
  markups, form filling (in the panel, on the canvas, and from the command
  line), importing a reviewer's XFDF comments, adding links, and adding
  pages.
- **Honest limits.** Edits a signed file cannot carry — removing or
  reordering pages, editing page content, flattening — behave exactly as
  before. And structural edits still warn before invalidating.
- **`incremental-save`** joins the command line: apply an edited copy's
  changes onto a signed original as one appended revision.
- **Jump to a signature.** Signature cards now name the page carrying the
  signature — click to go there.

### See it before you print it
- **Live preview in the Print dialog.** Every option — page subsets,
  booklet order, poster tiles, multiple pages per sheet, grayscale,
  comments modes, custom scale — renders exactly as it will land on paper,
  sheet by sheet, as you change it.

### A pen that acts like a pen
- **Multi-stroke drawings.** Pen strokes drawn in quick succession join
  into one drawing — sign your name in four strokes and it's one
  annotation, not four. Drawings made of several strokes in other tools
  now import whole, too.

### Three keys wake up
- With single-key accelerators enabled: **S** places a sticky note where
  you click (and opens it for typing), **Z** is marquee zoom — sweep a
  region and the view zooms to it — and **E** opens the content editor.

## 1.0.2 — Print the way print shops do

The Print dialog grows from four controls to the full professional surface —
two-sided printing, paper selection, booklets, posters, and more — driven by
what your printer actually supports.

### Choose how it prints
- **Two-sided printing.** One side only, flip on the long edge, or flip on
  the short edge — offered when the printer has a duplexer, left to the
  printer's own default otherwise.
- **Paper size, orientation, and colour.** Pick any paper the driver offers,
  force portrait or landscape (Auto rotates landscape pages for you), and
  print in colour or grayscale.
- **Odd or even pages, reverse order, collation.** Print the odd pages, flip
  the stack, print the even — manual two-sided that lines up. Uncollated
  copies (1,1,2,2,…) spool as a single job.
- **Up to 999 copies.** The old 99-copy cap is gone.

### Lay pages out on the sheet
- **Multiple pages per sheet.** Up to 4×4, in any reading order, with
  optional page borders and automatic rotation into each cell.
- **Booklet printing.** Saddle-stitched order on landscape sheets, left or
  right binding, and front-only / back-only passes for printers without a
  duplexer.
- **Poster tiling.** Print a large page across multiple sheets at any scale,
  with overlap, hairline cut marks, and assembly labels.
- **Custom scale.** Exactly 50%? 130%? Type the percentage.

### Control what prints
- **Comments and forms.** Print the document with its markups, the document
  alone (form fields still print), or document plus stamps.
- **Print as image.** A compatibility mode that rasterizes pages (150, 300,
  or 600 dpi) before spooling — for the rare driver that mangles vector
  content.
- **What you see is what prints.** Cropped documents now print their visible
  area, exactly as displayed on screen.

All of it works from the command line too — `print` gained the same option
set, and `printers --capabilities` reports any printer's papers, duplexer,
and colour support as JSON.

## 1.0.1 — Comments you can move, shapes you can draw, measurements you can trust

Annotations grow up: everything you place can now be moved, resized, and
arranged; a full set of drawing shapes joins the Comment toolbar; measuring
gains real-world calibration; and comments travel between tools as XFDF.

### Arrange your comments
- **Move and resize any comment.** Drag a comment to move it, grab a corner
  to resize — with the opposite corner anchored, and Shift locking the
  aspect. Text markups stay anchored to their text, as they should.
- **Select several at once.** Ctrl-click adds to the selection; Ctrl-drag
  sweeps a rubber band over everything it touches. Delete removes them all
  in one step; arrow keys nudge by a point (ten with Shift).
- **Align, distribute, and match sizes** from the properties bar — left,
  center, right, top, and bottom alignment, even gaps, and size matching to
  the first-selected comment.
- **Front and back.** Bring a comment forward or send it behind its
  neighbours; the order carries into the saved file.

### Draw on the page
- **Seven shapes.** Rectangle, ellipse, line, arrow, polygon, polyline, and
  the review cloud — drawn with the gestures you expect (drag a box, drag a
  line, click the corners) and saved as the real PDF shapes other tools
  recognize and edit.
- **Callouts.** A text box with an arrowed leader pointing at what you mean;
  the text opens for typing the moment you draw it.
- **Style them.** Stroke width, fill colour, and opacity — for one shape or
  a whole selection at once, and pen strokes take width and opacity too.
- **Edit by the point.** Lines, arrows, polygons, and callout leaders show
  draggable vertex handles when selected.
- **Faithful exchange.** Shapes drawn in other tools open as editable
  shapes here — including cloud borders, fills, stroke widths, opacity, and
  arrowheads — and anything this app can't represent faithfully is left
  exactly as it was rather than quietly simplified.

### Measure with confidence
- **Calibrate against a known length.** Drag along something whose size you
  know — a scale bar, a dimension line — type its real value, and every
  measurement that follows uses the ratio.
- **Recalibrate any measurement.** Right-click a placed measurement to set
  the document scale from it, or to correct that one measurement's recorded
  value — undoable, geometry untouched.

### Comments that travel
- **XFDF import and export.** Send every comment to the interchange format
  reviewers share, and bring a colleague's comments in — geometry, colours,
  authors, dates, and the review thread itself: replies stay attached to
  what they answer, and Accepted/Rejected/Completed statuses survive the
  round trip. In the Comments panel, and on the command line as
  `xfdf-export` / `xfdf-import`.

## 1.0.0 — A new name: Spectra PDF

The product formerly released as "Open PDF Studio" continues here as
**Spectra PDF**. A naming conflict with another open-source project made the
old name untenable; rather than share it, the app returns to its original
working name and restarts its public numbering at 1.0.0. Same application,
same code line — only the name is new.

### Moving from Open PDF Studio

- **Spectra PDF is a fresh install, not an update.** Download it from the
  new home. An existing Open PDF Studio install keeps working but will not
  receive updates; uninstall it whenever you like.
- **Settings and saved items do not carry over.** Preferences, recents,
  custom stamps, and saved actions start fresh. Guided actions survive the
  move as files: export them from the old app, import them here — the file
  format is unchanged.
- **The moving parts follow the name.** The command line is
  `spectrapdf.exe`; the virtual printer appears as "Spectra PDF"; scheduled
  runs live under the `\Spectra PDF\` Task Scheduler folder; enterprise
  policies read from `HKLM\SOFTWARE\Spectra PDF`. Printers and schedules
  created by the old app belong to the old install — recreate them here.

### New since 2.8.7

Everything below was built after 2.8.7 and ships for the first time in 1.0.0.

- **Navigation panels on the left dock.** Attachments, Layers, and Tags join
  the navigation pane — open beside the document, at the same time as a tool
  panel.
- **Send To ▸ Email.** Hand the current document to your default mail client
  as a ready-to-send attachment.
- **Accessibility tags survive page edits.** A tagged document's structure
  tree — and the rest of the document catalog — now travels through page
  moves, rotations, deletions, and annotation commits instead of being
  silently dropped.
- **Automatic tagging.** Give an untagged document a usable structure tree
  in one step from the Tags panel — headings, paragraphs, figures, and
  reading order inferred from the page layout.
- **Batch OCR in place.** Batch OCR can update files where they stand, with
  the same per-file isolation and honest reporting as mirror runs.
- **Watched folders.** Point a folder at a guided action and PDFs that
  arrive are processed automatically while the app is open — including
  minimized to the tray.
- **A virtual printer.** Install "Spectra PDF" as a printer and anything any
  application prints arrives in the app as a PDF.
- **Portfolio files open in their own apps.** A non-PDF file inside a
  portfolio now opens with the application that owns its type.
- **Real measurement annotations.** Measurements save as true PDF
  measurement annotations — scale included — that other PDF viewers
  understand.
- **Four-pane split view.** Split the document 2×2 with linked scrolling
  and zoom, for wide, spreadsheet-like documents.

## 2.8.7 — Actions that travel: files to share, schedules that run themselves

Guided actions finish growing up: run one over a whole folder, hand one to a
colleague as a file, and put one on a schedule that fires even when the app
is closed.

### Guided Actions
- **Run an action over a folder.** Point an action at a folder of PDFs and a
  destination: every PDF — subfolders included — is processed into a mirror
  of the tree. Originals are untouched, one file's failure never stops the
  rest, and a run log lands beside the batch OCR logs.
- **Share actions as files.** Export any action as a small JSON file;
  import one with full checking — an unknown step or setting is refused by
  name, never guessed at, and an import never overwrites an existing action.
  An exported file never contains a password.
- **Schedule an action.** Scheduled Batch Runs now schedules a guided
  action too: pick the action, the folders, and the time, and Windows Task
  Scheduler runs it even while the app is closed — under another account or
  a managed service account, with the same explicit-log-folder rule as
  scheduled OCR. The schedule keeps its own frozen copy of the action, so it
  always runs exactly what you scheduled. Actions that ask for values at run
  time are refused up front: an unattended run has nobody to ask.

### Command line
- New arm: `run-action <source> --dest <folder> --action action.json` runs a
  saved action file over a folder — the same file the app exports. In
  hand-written files, a header/footer step may use the app's simple
  `position`/`text` form as well as the fuller `placements` list.

### Fixed
- **In-place `encrypt` and `decrypt` work from the command line** — the last
  two operations that silently failed when the output path equalled the
  input now stage safely and replace the file atomically.

## 2.8.6 — Portfolios, measuring, stamps of your own, and guided actions

Four new capabilities land at once, a long-standing silent bug is fixed, and
sequences of everyday jobs can now run themselves.

### PDF Portfolios
- **Open a portfolio and see its files.** A portfolio opens on its cover
  sheet with the file list alongside — open a PDF inside it as its own tab,
  save any file out, replace a file's contents, add and remove files.
- **Create portfolios** from any files on disk, or convert the open document
  into one; its attachments become the portfolio's files.

### Measure
- **Distance, perimeter, and area on the page** — drag for a distance,
  click corners for a perimeter or an area, and read the value as you go.
- **Real-world scale** — set "1 in = 2 ft" and every readout follows,
  including areas. A finished measurement stays on the page as a note-carrying
  markup you can delete like any comment.

### Stamps of your own
- **Make your own text stamps** — any label, any colour, saved for reuse.
- **Dynamic stamps** — write `{date}`, `{time}`, or `{name}` in a stamp's
  label and it fills in when you place it. Your name comes from the new
  Identity name setting.
- **Image stamps** — turn any picture into a stamp; it lands undistorted
  and travels with the document like any other stamp.

### Guided Actions
- **Save a sequence of steps — compress, watermark, page numbers, OCR,
  strip metadata — and run it on a document with one click.** Steps run in
  order, each one undoable, and a failed step stops the run with its reason.
- **Ask-at-run** — mark any setting to be asked for each run instead of
  saved (a watermark's text, say). Passwords are never saved at all: an
  encrypt step always asks, and writes a new locked file so the document
  you're working on stays open and readable.

### Split view
- **Window ▸ Split** shows two independently scrolling and zooming views of
  the same document; click a pane to make it the one your commands and page
  readout follow.

### Fixed
- **Attachments no longer vanish when page edits are applied.** Applying any
  page change (a rotation was enough) silently dropped every attached file a
  document carried — and would have stripped a portfolio to its cover sheet.
  Both now survive every page edit.
- **In-place command-line operations work.** `compress`, `grayscale`,
  `pdf-a`, and the metadata commands silently failed when the output path
  equalled the input; all now stage safely and replace the file atomically.

### Command line
- New arms: `portfolio-info` / `portfolio-create` / `portfolio-make` /
  `portfolio-update`, and `ocr-file` to make a single PDF searchable.

## 2.8.5 — Batch OCR grows up

Everything the first outside feature request asked for, built around one
native recognizer that serves the app, the command line, and scheduled runs
alike.

- **47 recognition languages** — Japanese, Chinese, Korean, Arabic, Hebrew,
  Russian, Greek, Thai, Vietnamese, and the full European set, in the app
  and in batch runs.
- **A log for every batch run** — kept with a retention you control, in a
  folder you can choose (essential when scheduled runs happen under a
  service account).
- **Moved and error folders** — processed originals can file themselves
  away, with verify-before-move so nothing is moved unless its output is
  sound; unreadable files can be repaired automatically and retried.
- **Scheduled batch runs** — create, list, run-now, enable, disable, and
  delete schedules from Tools ▸ Scheduled Batch Runs. Runs fire even with
  the app closed, and can run under alternate credentials or a managed
  service account.
- **One recognizer** — recognition now runs natively for speed and works
  under service accounts; the in-browser recognizer is gone.

## 2.8.4 — Tools you can find

The tool pane and search both got the pass they needed after living with the
new layout, and the two things called "Comments" became one.

### The tool pane
- **Smaller, clearer tool buttons** — the tool's NAME is now the biggest thing
  on the button instead of the smallest, icons are smaller, and each tool's
  description has moved into a tooltip. More tools fit on screen at once.
- **The pane sizes itself to what it's showing** — it narrows to a compact
  index when you're browsing all tools, and widens back to your own chosen
  width when you open one.
- **A clear way back** — inside a tool, the pane header now says
  **‹ All tools** instead of showing an unlabelled grid icon.

### One search box for everything
- **Search from the toolbar** — one box that answers with both **tools and
  document text**. Type part of a tool's name to open it, or type a phrase to
  see the pages it appears on and jump straight there. Arrow keys and Enter
  work throughout.

### One comments list
- **Comments are now in a single place.** Previously two different lists were
  both called "Comments" and could report different numbers — one could edit
  but quietly hid any comment without a note, the other showed everything but
  was read-only. Now there is one list: every comment in the document, with
  jump-to-page, note editing, recolouring, delete, and delete-all.
- **"Comment" and "Comments" are one tool, so the tool list is 21 instead of
  22.** Having two tiles a single letter apart — one to make comments, one to
  read them — was never a distinction worth asking you to infer. The Comment
  tool now does both: it arms highlighting, text boxes, ink and stamps on the
  page as before, and its pane holds the list of what's there.

### Fixed
- **Clicking a comment now always jumps to its page.** If you were already
  reading the document it belonged to — the usual case — nothing happened.

## 2.8.3 — License notices in the box

Mainly a compliance release: the third-party notices now travel with the
application instead of living only in the source repository. One interface
fix rides along.

### The tool pane has a visible switch again
- **A Tools button now sits in the toolbar**, so the right-hand tool pane can
  be shown and hidden from the top row. Previously the pane could be closed
  with its own ✕ but only reopened from the View menu or `Shift+F4` — easy to
  close and hard to get back. (If you had already added this button yourself
  from View ▸ Customize Toolbar…, nothing changes for you.)

### Licensing
- **The full third-party notices now ship with the app**, so they are
  available offline, in the box, without an internet connection: the
  aggregate list of every bundled component with its license and source, and
  a complete per-component listing for the compiled application binary.
- **Font licenses ship beside the fonts** — the SIL Open Font License text
  for the bundled Liberation and Libertinus families is now installed
  alongside the font files themselves.
- **Every bundled Python component keeps its own license text** inside the
  embedded runtime, where previously the packaging step stripped it.
- **Settings ▸ Updates & Licenses** now lists the complete set of bundled
  components and opens either notices file directly.
- The notices themselves were audited and corrected against what actually
  ships.

## 2.8.2 — The workbench

The interface has been rebuilt around one rule: **your document never leaves
the screen.**

### The new layout
- **Tools open beside the page, not instead of it** — every tool panel now
  lives in a resizable pane on the right, with the document still in front of
  you. Switch between a tool's operations inside the pane, or browse all
  tools from its grid view. Your pane width is remembered.
- **A real status bar** — page number (type to jump), zoom and Fit, the
  Read⇄Organize switch, and Comments now sit in a slim bar under the page.
  Pending work — unapplied page edits, form fills, redactions — shows there
  too, always visible, never floating over your content.
- **Pure document tabs** — every open file is a tab, and that's all tabs are
  now. `Shift+F4` opens and closes the tool pane; `Ctrl+Tab` cycles files.
- **A cleaner Home** — quick actions (Open, Combine, Create PDF, Batch OCR),
  your recent files with folder and last-opened details, and the full tool
  grid, in one tidy landing page.
- **Pick first, tool ready** — choosing a tool with nothing open now asks for
  a file, then opens with that document loaded, instead of showing an empty
  form.
- **Customizable toolbar** — show or hide any toolbar button, and add
  optional buttons for the Pages, Bookmarks, and Signatures panes
  (right-click the toolbar, or View ▸ Customize Toolbar…).
- **Properties Bar** (`Ctrl+E`) — click any comment with the Select tool to
  see its details in a context strip: kind, page, size, note — with one-click
  recolor and delete.

### Reading and presenting
- **Two-page spreads** — read facing pages side by side, with a "cover page
  separate" option so spreads pair the way a bound book does.
- **Reading Mode** (`Ctrl+H`) — collapse the app chrome around the document.
- **Presentation** (`F5`) — full-screen, one page at a time, with keyboard
  and click navigation.

### Accessibility
- **Structure tags editor** — view and edit the document's accessibility
  tags: retag headings and figures, set alternative text, titles, and
  language, create and delete tags, and restructure the tree.
- **Reading order panel** — see the exact order assistive technology reads a
  page, with text previews, and fix it with one click.

### Signing
- **PAdES signatures** — sign to the modern European baseline profiles (B-B,
  B-T, B-LT, B-LTA), with RFC 3161 timestamping and embedded revocation data
  for long-term validation.
- **Your own trust list** — verification can validate the signer's chain
  against certificate authorities you choose, managed in the app.

### Export and OCR
- **Export to Word, RTF, ODT, and HTML** — real editable text, via a bundled
  converter; nothing to install.
- **Export pages as images** — PNG or JPEG per page, or a multi-page TIFF,
  at the resolution you choose, in color or grayscale.
- **47 OCR languages** — up from four; every language ships offline in the
  installer, including Japanese, Chinese, Korean, Arabic, Hebrew, Russian,
  Greek, Thai, and Vietnamese.

## 2.8.1 — Search, pagination, and document tools

### Search
- **Advanced find** — the Find bar and Search panel gain **match case**,
  **whole word**, and **regular expression** modes, with a clear "invalid
  pattern" indication for a malformed expression.
- **Search across files on disk** — search every PDF in a folder without
  opening them; results list each file and page, and a click opens the match.

### Pages and pagination
- **Headers, footers & Bates numbering** — stamp text at any of six positions
  with page-number, total, and auto-incrementing Bates tokens, across a page
  range, correctly placed even on rotated pages.
- **Crop & page boxes** — trim the crop, bleed, trim, or art box by page.
- **Page number labels** — number pages independently of their order (front
  matter as i, ii, iii; the body as 1, 2, 3; appendices with a prefix).

### Documents and security
- **Attachments** — embed, extract, and remove attached files.
- **Encryption permissions** — restrict printing, copying, changing, and
  commenting; screen-reader access is always preserved.

### Under the hood
- Vector fill and stroke colours now read correctly for ICC, Indexed,
  Separation, and DeviceN colour spaces, so more objects show an accurate
  swatch and recolour precisely.
- Form fields read through the same engine as filling, so nested fields that
  were previously invisible now appear.

## 2.8.0 — Fine typography, in-place signing, and a press-ready path

### Typography — kerning and OpenType features
- **Kerning** — text you add or edit is now properly kerned, so pairs like
  "AV" and "To" tighten the way a typesetter would, instead of sitting loose.
  The spacing comes from the font's own metrics: the document's embedded font
  where it has them, a non-embedded standard font's metrics where it doesn't,
  or a metric-compatible stand-in. Editing text no longer un-kerns it.
- **Small caps and stylistic alternates** — apply real OpenType small caps
  (the font's own, not shrunken capitals) and a font's stylistic alternates to
  text you add or edit — the whole box, a whole paragraph, or just a selected
  range. When the document's own font carries the feature it is used in place;
  otherwise the text switches to a bundled feature-rich serif, and stays
  searchable either way.

### Signing — sign the open document, in place
- **Sign in place** — a signature can now become part of the document you have
  open, and the change is undoable, instead of only ever producing a separate
  signed file. "Sign & save a copy" is still there when you want a separate
  artifact. The file on disk is written only when you save.
- **Counter-signing** — signing an already-signed document adds your signature
  as a new revision and leaves the existing signatures intact and valid.

### Document JavaScript
- **View and edit document-level JavaScript** — the scripts a PDF runs when it
  is opened in a reader. Add, rename, edit, and remove them from a dedicated
  editor. It only reads and writes the script text — it never runs it.

### Prepress
- **Convert to CMYK** — a colour-managed conversion of the document's colours
  to CMYK for commercial printing, honouring embedded colour profiles and
  preserving spot colours, with a choice of rendering intent (relative
  colorimetric, perceptual, or absolute).

### Editing polish
- **Per-span face and size, rendered faithfully** — bold, italic, family, and
  size applied to a selected range now render exactly as they will commit,
  each part of a mixed selection keeping its own style instead of collapsing
  to one, with the caret and selection tracking the styled text precisely.

## 2.7.1 — Redaction fix (recommended update)

### Redaction now removes everything under a mark
Redaction removes content from the file rather than covering it. Three kinds
of content could survive underneath a redaction mark and remain extractable
from the saved file:

- **Inline images** — images stored directly in the page's content stream,
  rather than as a separate resource. One under a mark was left in place with
  the black box drawn over it.
- **Shading and gradient fills** covering a marked area.
- **Annotations whose position could not be read** — a damaged or malformed
  rectangle caused the annotation to be treated as "not overlapping" and kept.
  Position data that cannot be read is now treated as overlapping, so the
  annotation is removed.

If you have redacted documents with an earlier version and the originals
contained inline images, gradients, or damaged annotations in the redacted
areas, re-check those files.

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
