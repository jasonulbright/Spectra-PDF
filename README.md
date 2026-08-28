# Spectra PDF

[![CI](https://github.com/jasonulbright/Spectra-PDF/actions/workflows/ci.yml/badge.svg)](https://github.com/jasonulbright/Spectra-PDF/actions/workflows/ci.yml)
[![Latest release](https://img.shields.io/github/v/release/jasonulbright/Spectra-PDF?sort=semver)](https://github.com/jasonulbright/Spectra-PDF/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/jasonulbright/Spectra-PDF/total)](https://github.com/jasonulbright/Spectra-PDF/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue)](LICENSE)
[![Platform: Windows](https://img.shields.io/badge/platform-Windows-0078d4)](https://github.com/jasonulbright/Spectra-PDF/releases/latest)

A modern, open-source PDF workbench for Windows. Tauri v2 + React, with an embedded Python engine. No ads, no telemetry, no upsells. Ships as an installer or as a portable zip you extract and run. WebView2 prerequisite (ships with Windows 10/11). A handful of features — listed below, each marked — additionally need Ghostscript, which you install separately.

Nothing here reaches the network on its own. The only network actions are ones you start and confirm: the update check (notify-only, and switchable off), opening a document from a web address, capturing a web page, submitting a form through its own Submit button behind a consent dialog, and signing through a signing service you configure. Everything else — OCR, spell check, signature trust, export, print production — runs entirely on your machine.

![Spectra PDF](docs/images/screenshot_dark_clean.png)

## What it is

A full-featured PDF workbench with a familiar user interface: a menu bar, customizable toolbar, and document tabs over a continuous reading view; a navigation pane on the left; twenty-six task-oriented tools that open in a resizable pane on the right — your document never leaves the screen; and a status bar carrying page, zoom, and any pending work. The keymap is verified against the industry-standard editor's published shortcut table, so your muscle memory just works. The interface, its messages and its saved reports are translated into 28 languages. Every whole-file operation also ships as a CLI subcommand with identical results.

### Reading & navigating
- **Reading view** — continuous, virtualized scroll; smooth with 1,000-page documents. Real text selection and copy (select text to highlight, underline, strike out, or link it), zoom presets (`Ctrl+0/1/2`), go-to-page (`Ctrl+Shift+N`), Rotate View (`Ctrl+Shift+Plus/Minus` — the page turns, the file doesn't), Hand/Select with Space as a temporary hand, marquee zoom, two-page spreads with a cover option, Reading Mode (`Ctrl+H`), and full-screen Presentation (`F5`). Rulers, a grid, draggable guides and snapping are there when you are placing something precisely
- **A workbench that never hides your document** — tools open in a resizable side pane beside the page (toggle it from the toolbar or `Shift+F4`; it narrows to an index of tool names and widens for the tool you pick), a status bar carries page/zoom/view controls and any pending work, every open file is a tab, and the toolbar is customizable (per-button show/hide). A context-sensitive Properties Bar (`Ctrl+E`) shows the selected annotation's details

![Tool pane and Properties Bar open beside a document that stays fully visible](docs/images/shot_workbench.png)
- **Organize view** — every open file as a strip of live page thumbnails; drag pages within and across documents, multi-select, whole-document merge, drop files to import their pages at that spot. All of it staged in memory, committed atomically, undoable
- **A second window** (Window ▸ New Window, or Move to New Window) — a second workspace, for a second screen. A document is owned by one window at a time: opening it in another is refused by name, with an offer to bring the window that holds it to the front. Each window keeps its own tabs, undo history and view; closing one closes only its own documents

![A document held by another window, its reopening refused by name with an offer to show that window](docs/images/shot_second_window.png)
- **Navigation pane** (`F4`) — Pages (thumbnails with drag-reorder), Bookmarks (with editing), Articles, Attachments, Layers, Tags, Search, Signatures
- **Find & Search** — a universal search box in the toolbar that answers with both **tools and document text** in one list (type a tool's name to launch it, or a phrase to jump to the page), plus floating find (`Ctrl+F`, `F3`/`Ctrl+G` stepping) and a workspace-wide Search panel (`Ctrl+Shift+F`) with regex, case and whole-word modes and an on-disk scope. Scanned pages become searchable (and selectable) via OCR — and a page with no text layer at all can still be selected and highlighted as text: the first selection gesture recognises that page's words locally, in memory, without changing the file, in the document's own declared language or one you pick in Settings (a preference turns it off; writing a real text layer stays the explicit Scan & OCR feature)

![One search box answering a query with both tool hits and document text hits](docs/images/shot_find_search.png)
- **Read Out Loud** (View ▸ Read Out Loud, `Ctrl+Shift+V`) — speaks the page or reads to the end of the document with the voices installed on your computer, highlighting the paragraph, sentence and word as it goes; a tagged document is read in the order its author declared, and page furniture is skipped

![Read Out Loud speaking a tagged page, highlighting the paragraph, sentence and word](docs/images/shot_read_aloud.png)
- **Batch OCR** (Tools ▸ Batch OCR Folder…) — point it at a folder and get a mirrored copy of the whole tree with every scanned PDF made searchable; already-searchable files copy through unchanged and problem files are reported. Your originals stay untouched unless you pick the explicit replace-in-place mode, which stages each result beside the original, verifies it reads back, and only then swaps it over. Fully offline, like all OCR here

![Batch OCR mirroring a folder tree, reporting every file's outcome including one it could not read](docs/images/shot_batch_ocr.png)

![Organize view](docs/images/screenshot_organize.png)

### The twenty-six tools

> Features marked **(requires Ghostscript)** need a Ghostscript installation,
> which you install separately — it is not part of this download and is
> licensed to you by its own publisher. Point the app at it under
> Settings ▸ Engine, or let it find one on your machine; every marked feature
> then works exactly as described. Until then each one is disabled and says so
> by name — nothing here is removed or silently degraded.

- **Organize Pages** — reorder, rotate, delete, split, extract — and merge pages between open files by dragging

![Organize view with several pages multi-selected for reorder](docs/images/shot_organize_select.png)
- **Comment** — highlights, sticky notes, text boxes, callouts, freehand ink with an eraser, a **freehand highlighter** that marks any part of a page — scans and images included — with a translucent stroke that blends like a real marker in every viewer, shapes (rectangle, ellipse, line, arrow, polygon, polyline, cloud) and stamps, with notes and recoloring on each; existing PDF annotations import as editable; one list of every comment in the document — jump to it, edit its note, recolour or delete it, or clear them all. Comments export and import as XFDF, carrying reply threads and groups. Each tool has a lock: locked, it stays armed after every placement, so marking a hundred places costs one click

![Comment tool: highlight, ink, text box and shape markup with the comment list](docs/images/shot_comment.png)

![Freehand highlighter marking words on a scanned page](docs/images/shot_scan_highlight.png)
- **Comment summary** (from the Comment panel, or `comments-summary`) — writes a printable PDF of the comments: comments on their own, or the pages with their comments beside them, beneath them, or on their own sheets. Connector lines join each entry to the place it marks. Filter by author, type, review state, page range or "has text"; sort by page, author, date or type. Every summary ends with a reconciliation — how many comments the document holds, how many were written, filtered, or could not be modelled
- **Edit** — select an image, a paragraph, or a line of text on the page: move, resize, rotate, crop, dim, replace, extract or delete images and place new ones; rewrite text in place in the document's own font with live validation, kerned like a typesetter; edit whole paragraphs with true rewrap, split and merge, restyle size, colour, family, bold and italic — plus real OpenType small caps and stylistic alternates — for a whole paragraph or a selected range; move, resize, recolour, re-width or delete drawn vector shapes, even inside groups; add brand-new text boxes. Right-to-left scripts — Arabic, Hebrew, Persian, Urdu — reflow and author like any other, with cursive letters joined correctly; Chinese, Japanese and Korean too, including **vertical text** that reads down the box and fills its columns across (Japanese and Chinese right to left, Mongolian left to right), with an upright horizontal block for a year or a page number. Vertical text is set in the bundled vertical face, and the controls that cannot apply to a column — small caps, stylistic alternates, box rotation — say so rather than doing nothing. **Spell check** underlines unrecognised words as you type and checks the whole document — page text, comments and form field values — against 36 bundled dictionaries that work with no connection — Finnish among them, whose words are generated rather than listed and so are checked by a bundled morphological analyser — with your own added words honoured everywhere

![Edit tool rewriting a line of text in the document's own font](docs/images/shot_edit_text.png)
- **Fill & Sign** — AcroForm fill on the page, including forms that **calculate**: a field's total updates as you type, and a field's display format (number, currency, percentage, date, time, postcode, telephone, or a mask of your own) shows on the page while the file stores the plain value. Field actions run — go to a page, reset the form, show or hide fields, import form data, build a submission — and an action this app does not perform is named rather than half-simulated. **Submitting** a form actually sends it, but only after a consent dialog shows the full destination and the exact values that will go: one click sends, Cancel sends nothing, a plain unencrypted destination is called out, a redirect elsewhere aborts with both addresses named, and nothing received is ever executed. **Field scripts** — the custom calculations, validations and formats a form's author wrote — run only if you turn on the "Run field scripts" preference (off by default, and an enterprise policy key can forbid it machine-wide). They run in an isolated interpreter with no network, no file system and nothing outside the form; anything beyond that surface does nothing and is named in the Forms panel, a script that hangs is stopped and reported, and headless runs never execute one. **Static XML (XFA) forms** fill and save correctly, writing both the standard fields and the form's XML data so the result reads the same everywhere; a dynamic XML form opens read-only and says so by name rather than producing a wrong result. Digital signatures: verify against your own trust anchors, the Windows certificate store, or downloadable trust lists from multiple sources (each off until you turn it on, each a snapshot read offline — nothing is fetched while you work), with per-authority restrictions honoured, so a timestamp-only authority can never vouch for a signer; sign with PFX/PEM, a PKCS#11 hardware token, a certificate in the Windows store (the key never leaves Windows), or a signing service you configure, where the key stays at the service, the app never sees a PIN or password, only the document's digest is ever sent, and what comes back is verified against the credential's own certificate before anything is written. All of it works with PAdES baseline-through-LTA profiles, timestamping, sign-into-field, certification signatures, field locking, and counter-signing. A visible stamp can carry a logo or background image, the text lines you choose (name, date, reason, location, or your own), a text-beside or text-over layout, and a **personal signature** as its face, with a live preview drawn by the same code that writes the real one. **Personal Signatures** is its own manager: draw one with the pointer, type a name in one of three bundled handwriting styles, or import a photographed signature with optional white-background removal. Place one on any page — drawn signatures land as vector ink, typed ones embed their font — and they undo like every other edit. They are stored on this computer only and are written into a document only when you place them

![Fill & Sign completing a form whose total field calculates as you type](docs/images/shot_forms_fill.png)

![Signatures panel reporting a digital signature as cryptographically valid](docs/images/shot_signing.png)
- **Prepare Form** — detect the fields on a flat form and review them before they are created, or draw new fields on the page; set each field's format, accepted range, default value, character limit, comb layout, calculation (sum, product, average, min, max, or an arithmetic expression over field names) and actions. Calculations are ordered so every total runs after the fields it reads, and a circular or unknown reference is refused by naming the chain that proves it. A field carrying its own script is listed with its trigger, whether or not you have allowed scripts to run. View and edit the document's JavaScript. Adding fields to an XML form document is refused by name rather than quietly discarding the form's XML layer

![Prepare Form reviewing detected fields on a flat form before creating them](docs/images/shot_prepare_form.png)
- **Redact** — mark by hand, or search every occurrence of a term, a word list or a built-in pattern (phone, email, card number, SSN, date, IBAN, NHS number, SIN, URL) and mark them all; applying strips the content from the file, not just from view. **Remove Hidden Information** audits what a document carries — metadata, embedded files, bookmarks, comments, form fields, JavaScript, hidden layers, invisible text, prior revisions, unreferenced objects, links and actions, thumbnails, structure — and removes the categories you name. A folder-wide search-and-redact is under Tools

![Search & Redact marking every occurrence of a term across the document](docs/images/shot_search_redact.png)
- **Measure** — distance, perimeter, and area on the page, with a real-world scale ratio ("1 in = 2 ft") you can calibrate against a known length; finished measurements stay on the page as markups you can delete like any comment

![Measure tool reading a distance on a scaled floor plan](docs/images/shot_measure.png)
- **Count & Takeoff** — count items on a drawing by group, read the tallies, place a legend on the page, or export the takeoff as CSV

![Count & Takeoff tallying door symbols on a drawing by group](docs/images/shot_takeoff.png)
- **Guided Actions** — save sequences of steps and run them on a document with one click. The steps are create a PDF, one PDF per folder, compress, optimize, grayscale, PDF/A, bring up to a print profile, header/footer, watermark, strip metadata, remove hidden information, search & redact, OCR, enhance scans, links from web addresses, bookmarks from structure, prepare forms, export to a document format, export pages as images, and encrypt to a new file. Steps built on a marked feature carry that requirement, and a saved action naming one reports it when the plan is built rather than part-way through a run. Any setting can be asked for at run time — passwords always are, and are never stored

![Guided Actions editor assembling a saved sequence of steps](docs/images/shot_guided_actions.png)
- **Scan & OCR** — acquire pages straight from a scanner (flatbed, feeder or duplex), deskew, despeckle, whiten and re-orient them, then make them searchable in 47 languages, fully offline. The cleanup and recognition passes render each page first, so **(requires Ghostscript)** for scanned input; acquisition and the dialog's own assembly do not

![Scan & OCR panel measuring a scanned page before making it searchable](docs/images/shot_ocr.png)
- **Compare** — text and visual diff. The text diff is always available; the visual diff **(requires Ghostscript)**

![Compare Files showing a text diff between two revisions of a document](docs/images/shot_compare.png)
- **Protect** — AES-256 encrypt/decrypt with owner-permission controls, and certificate encryption to named recipients (no shared password)

![Protect tool setting encryption passwords and reader permissions](docs/images/shot_protect.png)
- **Optimize** — compress, grayscale, linearize, PDF/A, PDF version, and **MRC** for scans **(compress, grayscale, PDF/A and MRC require Ghostscript; linearize and PDF version do not)**: the page separates into a text stencil, an ink colour and a paper background, so the type stays at the scan's own resolution while the background compresses hard. Three presets, and an option to recognise each compressed page and revert any whose text did not survive

![Optimize auditing where a document's bytes go, by category](docs/images/shot_optimize.png)
- **Repair** — three tiers, up to per-page salvage; tier 2 **(requires Ghostscript)**, tiers 1 and 3 do not
- **Watermark** — text, an image, or a page of another PDF stamped as vector artwork

![Watermark tool placing a text watermark behind page content](docs/images/shot_watermark.png)
- **Header & Footer** — six positions, page-number and auto-incrementing Bates tokens

![Header & Footer tool with its six positions and Bates numbering](docs/images/shot_headerfooter.png)
- **Crop & Page Boxes** — crop/bleed/trim/art, and **Remove white margins** crops each page to its own content (a scan is measured from its ink), measured first and applied second

![Crop & Page Boxes with a crop rectangle drawn on the page](docs/images/shot_crop.png)
- **Snapshot** — drag a rectangle over any part of a page and that region goes to the clipboard as a picture, at a fixed resolution, or saves as a PNG
- **Page Labels** — front matter as i, ii, iii; prefixed appendices, and the page box navigates by them

![Page Labels numbering front matter independently of page order](docs/images/shot_pagelabels.png)
- **Attachments** — embed, extract, remove

![Attachments panel listing a file embedded in the document](docs/images/shot_attachments.png)
- **Portfolio** — open a portfolio and work its files; create one from any files on disk, or convert the open document; add, open, save out, update, and remove member files
- **Layers** — show/hide optional content. Layers declared as **processing steps** (cutting, creasing, varnish, white, and the rest) are recognised and labelled, and a malformed declaration is called out rather than passed over

![Layers panel toggling optional content, including processing steps](docs/images/shot_layers.png)
- **Accessibility** — 56 checks across seven areas (Document, Page Content, Forms, Alternate Text, Tables, Lists, Headings), each sourced to a clause of the accessibility standard itself, with colour contrast measured against what is actually painted under each line of text. A check with nothing to check reports "not applicable" rather than a pass; a check that could not read part of the document says so rather than claiming one; a check no machine can settle asks for review. A judgement that genuinely cannot be settled from the file alone — artifact versus content, semantic appropriateness, reading order — is reported for review with its evidence rather than guessed either way. Clicking a finding takes you to it. Twenty-one of the checks repair from the report — sixteen need nothing from you, and the rest need one value only you can supply (the document's language and title, a field's description, a figure's alternate text, a table's summary, and whether a run of untagged content is content or decoration), and **nothing is ever invented for you**. The report exports as a web page or plain text, and states in its own footer that it is not a conformance certificate. Structure-tag editor and reading-order panel included; an untagged document can be tagged heuristically as a starting point

![Accessibility Check reporting its 56 checks over a document](docs/images/shot_accessibility.png)
- **Print Production** **(the raster-based half requires Ghostscript: output preview, ink manager, soft proof, the object inspector's ink readings, transparency flattening, trapping, CMYK conversion, DSC PostScript export and preflight's raster measurements; printer marks, hairline finding, outline conversion, profile editing and preflight's structural checks do not)** — **Output Preview** rasters the page through the separation device: individual plates, overprint, ink density, a total-ink alarm, and a **soft proof** through a named press profile — the document's own output intent, a bundled press profile, or an ICC file you pick. Simulate Paper White shows the paper's tint instead of screen white (and forces Simulate Black Ink, since it already holds black at its own value). A profile the preview cannot use is named and the page stays unproofed. Processing-steps content is left out of the composite, the plates and the total-ink figure by default — the excluded inks are named — and a toggle brings it back when you want it. The **object inspector** reads a point you click: what is painted there, its colour space, its ink values taken from the plates, and a placed image's effective resolution at the size it appears — stacked objects are listed topmost first, and bare paper says so. Also ink manager, printer marks, hairline finding and fixing, transparency flattener with preview, outline conversion, in-RIP trap presets, DSC PostScript export, colour conversion to CMYK, and **preflight**: 38 checks across seven categories measured against one of nine shipped profiles (sheetfed offset, heatset web, newsprint, digital, large format, PDF/X-1a, PDF/X-3, PDF/X-4, office), with 20 repairs offered on the rows that need them and run in a fixed order. Profiles can be duplicated, edited, exported and imported; editing a shipped one saves a copy. A profile can require processing-steps declarations or flag a step set to print. Where a check could not read part of the document it reports that separately rather than passing. Conversion and preflight results state what the saved file actually declares, read back from the file itself, and say by name where a report does not verify a standard's full requirements

![Output Preview separating a press sheet into plates with an ink density readout](docs/images/shot_output_preview.png)

![The object inspector naming what is painted under a clicked point, with its colour space and ink values](docs/images/shot_object_inspector.png)
- **Links** — draw a link region anywhere on a page, or create one from selected text or from every web and email address in the text. Target it at a page in this document (at a view you choose), a named destination the document declares, another file and a page inside it, or a web address. Style its border — width, solid/dashed/underlined, colour — and its click effect. Links are invisible by default. A PDF a link names opens in this app once you confirm; any other file is named and never run, and a link to a program is reported by name and never written

![Links tool creating link regions from the web addresses in the text](docs/images/shot_links.png)
- **Export** — text extraction, and export to Word, RTF, ODT, HTML, XHTML, plain text, **spreadsheet (.xlsx)** and **presentation (.pptx)**; page images as PNG/JPEG/TIFF **(page-image export, and the slide export's page rendering, require Ghostscript)**. Detected tables can be reviewed on the page before they become a spreadsheet

![Export tool extracting text and reviewing detected tables](docs/images/shot_export.png)

![Tools](docs/images/screenshot_tools.png)

### Documents & files
- **Create PDF** (File ▸ Create) — from files on disk (images, Office and text documents, HTML, PDFs, and PostScript **(requires Ghostscript)**), from a blank page, **from the clipboard** (a picture at its own resolution, formatted text with its tables and colours, or plain text), **from a web page**, or **from a scanner**. Sources are one list you can reorder and combine

![Create PDF combining an image, documents and a blank page in one reorderable source list](docs/images/shot_create_pdf.png)
- **Open from web address** (File ▸ Open from web address) — type or paste a URL and the document downloads and opens like any file. Saving one always asks where; it never silently overwrites. A recent entry from the web reopens the dialog pre-filled rather than re-downloading behind your back, and nothing inside a document can start a download by itself
- **Web capture** — a capture window opens where you can watch the page load; nothing is fetched in the background and closing the window cancels the run. The dialog states the site and the page limit before it loads anything. Capture the page alone or follow its links one or two levels deep, on the same site only; reaching your limit is reported rather than looking complete. Each captured page becomes a bookmark named after the page's own title

![The web capture dialog naming the site and the page limit before anything is fetched](docs/images/shot_web_capture.png)
- **Print** (`Ctrl+P`) — printer picker, page range, copies, fit/actual/custom scale, duplex, paper, orientation, colour, odd/even, reverse, collation, comments-and-forms handling, and N-up, booklet or poster layouts, to any Windows printer **(requires Ghostscript)**
- **A virtual printer** — optionally install a "Spectra PDF" printer that appears in every application's print dialog; printing to it lands the pages here as a fresh PDF. It uses an in-box Windows driver over a loopback port, ships no driver of its own and installs no service, and the listener lives only while the app is running. Installing or removing it needs one visible administrator prompt, because printer ports are machine-wide objects
- **Create PDF from PostScript** — convert `.ps`/`.eps` to PDF with quality presets (Smallest / eBook / Print / Press), the classic distilling job **(requires Ghostscript)**
- **Watched folders** (Tools ▸ Watched Folders…) — drop a PDF into an intake folder and a saved guided action runs over it: results mirror into a destination and the original files into a processed folder. Polling, with a file counted as arrived only once its size holds steady across two ticks, so a half-copied file never triggers a run
- **Scheduled batch runs** (Tools ▸ Scheduled Batch Runs…) — create, list, enable, disable, run now and delete. Windows Task Scheduler runs them, so a schedule survives logoff and reboot without this app needing to be open
- **Folder tools** — Batch OCR, Export a Folder, Preflight a Folder, Search & Redact a Folder, Prepare Forms in a Folder, One PDF per Folder. Each reads by path and writes into a mirror tree; none of them touches your open documents
- **Email** (File ▸ Email…) — hand the current document to your mail client as an attachment
- **Document Properties** (`Ctrl+D`), categorized **Preferences** (`Ctrl+K`)
- Insert pages from a file (`Ctrl+Shift+I`) or blank (`Ctrl+Shift+T`), delete (`Ctrl+Shift+D`), rotate (`Ctrl+Shift+R`), split, extract
- `.pdfx` support — [Alexandros Gounis's open format](https://github.com/AlexandrosGounis/pdfx): several documents saved as one ordinary, fully-compatible PDF that reopens as separate strips. (Unrelated to PDF/X, the print-exchange standard, which is under Print Production.)
- Multi-level undo/redo across staged page edits and applied operations; one file is one document no matter how its path is spelled
- **Signed documents edit by incremental append** where the change allows it: annotating, filling and adding pages land as the original bytes verbatim plus one revision, so existing signatures keep verifying. A change that goes further falls back to an ordinary rewrite, and says so before it does

### Desktop citizenship
NSIS installer with silent modes and enterprise policy — or a **portable zip**: extract and run, with settings, dictionaries, session state and logs kept beside the app instead of in the user profile (its first run presents the bundled colour-profile licence, and declining leaves everything working except the profile-dependent features, each disabled by name). File associations, Explorer context menu, system tray, start-with-Windows, update notifications (the app never downloads or installs updates itself), light/dark/high-contrast/system themes carrying the Windows accent + Mica, 28 interface languages, WCAG 2.1 AA (an axe-core audit of every surface in all three themes runs in the test battery, alongside a keyboard-operability suite and a theme-consistency audit), full keyboard navigation (single-key tool accelerators available, off by default).

## Command Line

When invoked with a subcommand, Spectra PDF runs headless — no window, same engine. `spectrapdf --help` lists every subcommand and `spectrapdf <subcommand> --help` its options; `spectrapdf.exe /?` opens a short summary dialog for people who reached it from Explorer.

The examples below show one form of each subcommand; most carry more options than are shown.

```bash
# Compress — quality presets, or MRC for scanned paper (both require Ghostscript)
spectrapdf compress input.pdf -o compressed.pdf --quality ebook
spectrapdf compress scan.pdf -o small.pdf --quality mrc --mrc-preset balanced --mrc-verify-text

# Merge / split / rotate / delete
spectrapdf merge a.pdf b.pdf c.pdf -o merged.pdf
spectrapdf split input.pdf -o output_dir/ --ranges "1-3,5-7"
spectrapdf split manual.pdf -o chapters/ --mode bookmarks   # also: --mode every-n --every-n 10
spectrapdf split big.pdf -o parts/ --mode size --max-mb 5
spectrapdf rotate input.pdf -o rotated.pdf --angle 90 --pages 1,3,5
spectrapdf delete input.pdf -o trimmed.pdf --pages 3,7

# Create a PDF from any accepted source: images, Office/text/HTML, PostScript, PDFs
spectrapdf create-pdf scan.jpg notes.docx cover.pdf -o combined.pdf --page-size a4
spectrapdf create-pdf-folders C:\jobs\ -d C:\assembled\   # one PDF per folder of images

# Print — to any installed Windows printer (requires Ghostscript)
spectrapdf printers                       # list printers (JSON, with the default)
spectrapdf printers --capabilities "Brother HL-L2400D"   # papers/duplex/colour as JSON
spectrapdf print input.pdf --printer "Brother HL-L2400D" --pages 1-3 --copies 2 --fit fit
# full option surface: --subset odd|even --reverse --no-collate --duplex long|short|simplex
#   --paper <id> --orientation portrait|landscape --color gray --comments document|stamps
#   --as-image --image-dpi 300 --layout nup|booklet|poster (each with its own flags; see --help)
spectrapdf print big-drawing.pdf --printer "Brother HL-L2400D" --layout poster --poster-scale 200 --poster-cut-marks

# Scanners
spectrapdf scanners                                       # list devices (JSON)
spectrapdf scanners --capabilities "<device id>"          # sources and settable properties
spectrapdf scan --device "<device id>" --dpi 300 --source feeder -o scanned.pdf

# Apply an edited copy's annotate/fill/add-page changes onto a SIGNED original
# as one incremental append — its signatures keep verifying
spectrapdf incremental-save signed.pdf edited-copy.pdf -o signed-updated.pdf

# Create PDF from PostScript/EPS (distill)
spectrapdf distill input.ps -o output.pdf --preset printer

# Encrypt / decrypt — by password, or to recipient certificates
spectrapdf encrypt input.pdf -o encrypted.pdf --password secret
spectrapdf decrypt encrypted.pdf -o decrypted.pdf --password secret
spectrapdf encrypt-certs input.pdf -o sealed.pdf --cert alice.cer --cert bob.cer --no-print
spectrapdf decrypt-cert sealed.pdf -o open.pdf --pfx alice.pfx --password pass

# PDF/A, optimize, grayscale, version
spectrapdf pdfa input.pdf -o archive.pdf --level 2b
spectrapdf audit-space input.pdf          # where the bytes went, by category (JSON)
spectrapdf optimize input.pdf -o optimized.pdf --linearize --strip-metadata --compress-streams
spectrapdf grayscale input.pdf -o grayscale.pdf
spectrapdf pdf-version input.pdf -o out.pdf --version 1.7

# Text, metadata, hidden information
spectrapdf extract-text input.pdf --pages 1,2,3
spectrapdf metadata input.pdf --title "New Title" -o updated.pdf
spectrapdf metadata input.pdf --strip -o stripped.pdf
spectrapdf audit input.pdf                                    # what the file carries (JSON)
spectrapdf sanitize input.pdf cleaned.pdf --all-removable     # remove named categories

# Forms — list fields (JSON), fill, reset, import/export form data, detect and create
spectrapdf forms input.pdf
spectrapdf forms input.pdf -o filled.pdf --set name=Ada --set subscribe=true --flatten
spectrapdf forms input.pdf -o reset.pdf --reset
spectrapdf forms input.pdf -o filled.pdf --import-data values.xfdf
spectrapdf forms input.pdf --export-data out.fdf --data-format fdf
spectrapdf detect-fields flat-form.pdf                        # where fields could go (JSON)
spectrapdf prepare-forms flat-form.pdf -o interactive.pdf --kinds text,checkbox

# Bookmarks and articles
spectrapdf outline input.pdf
spectrapdf outline input.pdf -o out.pdf --from-json bookmarks.json
spectrapdf outline-from-structure tagged.pdf -o out.pdf --levels 3
spectrapdf articles input.pdf                                 # article threads (JSON)

# Signatures
spectrapdf verify-signatures signed.pdf
spectrapdf verify-signatures signed.pdf --trust-root my-ca.pem
spectrapdf verify-signatures signed.pdf --system-trust --eutl-trust --msctl-trust
spectrapdf sign input.pdf -o signed.pdf --pfx signer.pfx --password pass
spectrapdf sign --list-store-certs                 # Windows certificate store (JSON)
spectrapdf sign input.pdf -o signed.pdf --store-cert <thumbprint>   # key stays in Windows
# Visible stamp: --stamp-image logo.png --stamp-fields name,date,reason
#   --stamp-layout beside --stamp-label "Approved"
# PAdES: --pades is a flag (B-B). Add --tsa-url for B-T, --embed-revocation for B-LT,
#   --lta for B-LTA. --certify and --lock are independent of the profile.
spectrapdf sign input.pdf -o signed.pdf --pfx signer.pfx --password pass \
  --pades --tsa-url http://timestamp.example/tsa --embed-revocation --lta
spectrapdf generate-signer -o me.pfx --cn "My Name" --password pass
# Remote signing service — only the digest is sent; the document stays here.
# Bring your own OAuth registration; no provider relationship ships with this app.
spectrapdf sign --csc-url https://signer.example --csc-client-id <id> --list-csc-credentials
spectrapdf sign input.pdf -o signed.pdf --csc-url https://signer.example \
  --csc-client-id <id> --csc-credential <credential-id>

# Compare, redact, watermark, repair tiers
spectrapdf compare a.pdf b.pdf
spectrapdf redact input.pdf -o redacted.pdf --page 1 --rect 100,100,300,150
spectrapdf search-regions input.pdf --query "Account" --pattern credit_card   # rectangles (JSON)
spectrapdf search-redact input.pdf -o redacted.pdf --pattern ssn --pattern email
spectrapdf search-redact input.pdf -o marked.pdf --query "DRAFT" --marks-only
spectrapdf watermark input.pdf -o marked.pdf --text "CONFIDENTIAL"
spectrapdf watermark input.pdf -o marked.pdf --image logo.png --position bottom-right --scale 0.4
spectrapdf repair broken.pdf -o repaired.pdf
spectrapdf rebuild broken.pdf -o rebuilt.pdf
spectrapdf recover broken.pdf -o recovered.pdf
spectrapdf check input.pdf

# OCR and scan cleanup
spectrapdf ocr-file scan.pdf -o searchable.pdf --language eng --enhance
spectrapdf enhance-scan scan.pdf -o clean.pdf          # deskew, despeckle, whiten, re-orient
spectrapdf enhance-scan scan.pdf --analyze             # what it would do (JSON)
spectrapdf batch-ocr C:\scans\ -d C:\searchable\ --lang eng+fra
spectrapdf autotag untagged.pdf -o tagged.pdf          # heuristic structure tree

# Export — Office/web formats, spreadsheets, slides, page images, whole folders
spectrapdf export input.pdf -o output.docx --format docx
spectrapdf export input.pdf -o tables.xlsx --format xlsx --sheet-per table
spectrapdf export input.pdf -o slides.pptx --format pptx --slide-size 16:9
spectrapdf export-folder C:\pdfs\ -d C:\word\ --format docx
spectrapdf export-images input.pdf -o page.png --format png --dpi 300 --pages 1-5

# Pages — headers/footers/Bates, page boxes, page-number labels
spectrapdf header-footer input.pdf -o numbered.pdf --bc "Page {page} of {pages}"
spectrapdf header-footer input.pdf -o stamped.pdf --br "BATES-{bates}" --bates-start 1000
spectrapdf page-box input.pdf -o cropped.pdf --box crop --top 36 --bottom 36 --left 36 --right 36
spectrapdf page-box input.pdf -o trimmed.pdf --auto --margin 9   # crop to each page's content
spectrapdf page-labels input.pdf -o labeled.pdf --range "1:r" --range "5:D"

# Comments — list, review, summarize, delete
spectrapdf comments-list input.pdf
spectrapdf comments-review input.pdf --sort author --state Accepted   # full review model (JSON)
spectrapdf comments-summary input.pdf -o summary.pdf --mode document_and_comments \
  --placement beside --sort page --author "R. Hale"
spectrapdf comments-delete-all input.pdf -o clean.pdf
spectrapdf xfdf-export input.pdf -o comments.xfdf   # annotations to XFDF
spectrapdf xfdf-import input.pdf --xfdf comments.xfdf -o annotated.pdf
spectrapdf count-summary plans.pdf -o takeoff.csv                # count marks → CSV takeoff

# Attachments, portfolios, layers, links
spectrapdf attach-list input.pdf
spectrapdf attach-add input.pdf -o out.pdf --source data.xlsx
spectrapdf attach-extract input.pdf --name data.xlsx -o data.xlsx
spectrapdf attach-remove input.pdf -o out.pdf --name data.xlsx
spectrapdf portfolio-info bundle.pdf
spectrapdf portfolio-create report.pdf data.xlsx -o bundle.pdf --title "Q2 pack"
spectrapdf portfolio-make report.pdf -o bundle.pdf
spectrapdf portfolio-update bundle.pdf -o out.pdf --name data.xlsx --source new.xlsx
spectrapdf layer-list plans.pdf
spectrapdf layer-set plans.pdf -o out.pdf --index 2          # hide layer 2
spectrapdf layer-set plans.pdf -o out.pdf --index 2 --show   # show it again
spectrapdf link-list input.pdf
spectrapdf link-add input.pdf -o out.pdf --page 1 --rect 100 700 300 715 --url https://example.com
spectrapdf link-set input.pdf -o out.pdf --page 1 --index 0 --url https://example.org
spectrapdf link-delete input.pdf -o out.pdf --page 1 --index 0
spectrapdf link-from-urls input.pdf -o linked.pdf

# Accessibility — check, repair, and edit the structure tags
spectrapdf accessibility input.pdf
spectrapdf accessibility input.pdf --category tables
# Only the repairs that need no authored value have a headless arm. Alt text, a
# table summary, a language and a field description are asked for in the app.
spectrapdf accessibility-fix input.pdf -o fixed.pdf --fix tagged --fix tab_order
spectrapdf tags-list input.pdf
spectrapdf tags-set input.pdf -o out.pdf --path 0,0 --type H1 --alt "Chart of quarterly totals"
spectrapdf tags-add input.pdf -o out.pdf --parent 0 --type P
spectrapdf tags-move input.pdf -o out.pdf --path 0,2 --direction up
spectrapdf tags-delete input.pdf -o out.pdf --path 0,2

# Print preflight — profiles, checks, repairs, and a folder sweep
spectrapdf preflight-profiles                                 # shipped profiles + check list
spectrapdf preflight input.pdf --profile sheetfed_offset
spectrapdf preflight input.pdf --profile-path house-rule.json
spectrapdf preflight-fix input.pdf -o press.pdf --profile pdfx_4 --fix embed_missing_fonts
spectrapdf preflight-sweep C:\intake\ -d C:\checked\ --fix --profile newsprint

# Print production — colour conversion, marks, hairlines, transparency, trapping
spectrapdf convert-cmyk input.pdf -o cmyk.pdf --render-intent relative
spectrapdf convert-pdfx input.pdf -o press.pdf --version 4 --condition "FOGRA39" --identifier FOGRA39
spectrapdf printer-marks-list input.pdf                       # boxes, trim source, marks present
spectrapdf printer-marks input.pdf -o marked.pdf              # the page grows to hold them
spectrapdf printer-marks input.pdf -o marked.pdf --marks crop,registration --style japanese --weight 0.5
spectrapdf printer-marks-remove marked.pdf -o plain.pdf       # restores the recorded page boxes
spectrapdf hairlines-list input.pdf --threshold 0.25          # strokes too thin to print
spectrapdf hairlines-fix input.pdf -o thicker.pdf --threshold 0.25 --replacement 0.25
spectrapdf flatten-list input.pdf --balance 0.5               # what would rasterize, and where
spectrapdf flatten input.pdf -o flat.pdf --balance 0.5 --dpi 300
spectrapdf outlines-list input.pdf                            # what outlining would do, and refuse
spectrapdf trap-fields                                        # the in-RIP trapping vocabulary
spectrapdf trap-list input.pdf                                # presets carried + Trapped value
spectrapdf trap-assign input.pdf -o out.pdf --name "House" --first 1 --last 8 --trapped Unknown
spectrapdf export-postscript input.pdf -o out.ps --level 3

# Document-level JavaScript — read it, or replace the whole set
spectrapdf document-js-list input.pdf
spectrapdf document-js-set input.pdf -o out.pdf --from-json scripts.json
echo [] | spectrapdf document-js-set input.pdf -o clean.pdf --from-json -   # remove all

# Guided actions and batch — run a saved step sequence, or one op over a folder
spectrapdf run-action C:\intake\ -d C:\out\ --action house-rules.json
spectrapdf batch C:\pdfs\ -o C:\out\ compress --quality ebook
```

Results are JSON on stdout. Progress and errors go to stderr. Exit codes: 0 = success, 1 = operation error, 2 = bad args.

Two subcommands are deliberately more aggressive headlessly than in the app, because a command line has no review step: `search-redact` removes every hit it finds (pass `--marks-only` to write reviewable `/Redact` annotations instead), and `prepare-forms` creates every field it detects (narrow it with `--kinds`).

## Enterprise Deployment

```bash
# Silent install (per-machine, update check disabled)
# /acceptEULA confirms acceptance of the bundled colour-profile licence.
"Spectra PDF_X.Y.Z_x64-setup.exe" /S /acceptEULA

# Silent uninstall (keeps user data for redeployment)
"C:\Program Files\Spectra PDF\uninstall.exe" /S

# Silent uninstall (removes all user data)
"C:\Program Files\Spectra PDF\uninstall.exe" /S /removeuserdata
```

A portable zip is published alongside the installer for deployments that cannot install: extract it to a share or a stick and run it, with all per-user state beside the app. It carries the same bundled runtimes and the same feature set.

Updates are notify-only — the app checks for a newer release and shows a banner, and never downloads or installs anything itself. Even the check can be disabled machine-wide via `HKLM\SOFTWARE\Spectra PDF\DisableAutoUpdate = 1` (set automatically by the silent installer). Everything the app needs is inside the installer — the Python runtime, the LibreOffice export runtime, the native OCR engine and its offline language data, the JBIG2 encoder, the edit fonts, the colour profiles, and the spelling dictionaries — so there is no second deployment step and no machine needs its own copy of any of them. The one exception is Ghostscript, which is not distributed here: deploy it separately if your users need the features marked above, and the app will find a per-machine install without any per-user step. Third-party licence notices are installed alongside the app and open from Settings ▸ Updates & Licenses. Interactive installation presents the bundled colour-profile licence and requires acceptance. Silent (`/S`) and passive (`/P`) deployment must include `/acceptEULA`; otherwise the installer exits with code 2 before copying the application. The installer's own `/?` dialog documents all switches.


## Requirements

**End users**: WebView2 (included with Windows 10/11 via Edge). The interactive installer downloads the bootstrapper if missing.

Ghostscript **10.0 or newer** is a separately installed requirement for these features: scan cleanup and OCR rendering (including batch OCR and the OCR arm of Find); scan-based automatic form detection; visual Compare; printing; PostScript/EPS input and distilling; compression, grayscale, PDF/A, MRC and repair tier 2; PDF/X and CMYK conversion; Output Preview, Ink Manager, soft proofing, raster preflight measurements and repairs, transparency flattening, trapping and object-inspector ink readings; page-image export; the rendered page graphics in slide export; and content-aware crop's fallback for an image the embedded decoder cannot read. Features and sub-features outside that list remain available without Ghostscript. A normal interactive Spectra installer offers to open the [official Ghostscript download page](https://ghostscript.com/releases/gsdnld.html); Ghostscript then has its own download, installer and licence. Silent (`/S`) and passive (`/P`) Spectra installs never download, launch or install Ghostscript.

> **Note on unsigned releases:** Spectra PDF is distributed **unsigned** (no Authenticode code-signing certificate). On first run, Windows SmartScreen may show a blue *"Windows protected your PC — Unknown publisher"* prompt. This is expected for unsigned open-source software, not a sign of tampering. To proceed, click **More info → Run anyway**. Builds are published on the [releases page](https://github.com/jasonulbright/Spectra-PDF/releases).

**Developers**:

| Requirement | Version |
|-------------|---------|
| Node.js | 22 LTS (or 20.19+) |
| Rust | Stable toolchain |
| Ghostscript | 10.0+; optional except for the end-user features listed above. Not vendored or shipped; install it separately to use those features and to run the capability-present half of the test suite |

Python 3.14 is embedded automatically — no system install needed.

## Quick Start (Development)

```bash
# Install Node.js dependencies
npm install

# Vendor every bundled runtime (first time only). Each one is a
# tauri.conf.json resource and must EXIST before a build or `npm run dev`
# will succeed, so this is not optional — provisioning only Python leaves
# the build failing on a missing resource directory.
npm run prepackage

# Start development (Tauri dev server — launches Vite + Rust backend)
npm run dev
```

`npm run prepackage` runs ten provisioning steps in order: embedded Python,
the ICC colour profiles, the edit fonts, LibreOffice, native Tesseract, the
JBIG2 encoder, the spelling dictionaries, the Finnish morphological analyser,
the OCR language models, and the pdf.js assets. To run one on its own, see
**Individual steps** below.

Ghostscript is deliberately not among them: it is not shipped with the product
and no script vendors it. Install it on your development machine the way a user
would — the app, the CLI and the test suite all discover a system install — and
the features that need it light up. Without one, the suite's
capability-present half cannot run; nothing else is affected.

## Build

```bash
# Local build — bundles every runtime, builds the Rust backend, produces the
# NSIS installer. No signing key needed.
npm run package:unsigned
```

`npm run package` (without `:unsigned`) builds the exact release shape, which
additionally produces the **signed updater artifacts** (`latest.json` + `.sig`)
— that step needs `TAURI_SIGNING_PRIVATE_KEY` in the environment, and the key
lives only in the release workflow's repository secrets. Without it the build
assembles the installer and then **fails at the updater-signing step**, so for
a local installer use `package:unsigned`: the installer is identical, it just
skips the updater artifacts, which only the publish workflow
(`.github/workflows/release.yml`) has any use for.

Either package script runs, in order: `scripts/setup-python-embed.ps1` (downloads embedded Python 3.14 + pip-installs the hash-pinned engine deps), `scripts/bundle-icc.ps1` (stages the 22 ICC colour profiles committed under `vendor/icc`, each sha256-verified against `scripts/icc-profiles.tsv` on the way out and again on disk — no network, and the build refuses if a profile lacks its notice row), `scripts/sync-edit-fonts.ps1` (the hash-pinned edit faces and their OFL licence texts — Liberation, Libertinus, Noto Sans CJK SC, IBM Plex Sans Arabic, Noto Sans Hebrew and Noto Sans Mongolian), `scripts/bundle-libreoffice.ps1` (the pinned, checksum-verified export runtime — copies a local install if you have one, else downloads it), `scripts/bundle-tesseract.ps1` (the pinned, SHA-256-verified native OCR engine, plus every redistribution notice for the ~50 libraries it links — the build REFUSES if any shipped binary lacks one), `scripts/bundle-jbig2enc.ps1` (the pinned upstream JBIG2 encoder the MRC pass needs, under the same notice gate), `scripts/bundle-dictionaries.ps1` (the 35 hash-pinned Hunspell spelling dictionaries and their notices), `scripts/bundle-voikko.ps1` (the hash-pinned Finnish morphological analyser and its notices — it writes into the same dictionaries tree, which `bundle-dictionaries.ps1` rebuilds wholesale, so it must run after it), `scripts/sync-ocr-assets.mjs` (the 47 pinned OCR language models) and `scripts/sync-pdfjs-assets.mjs` — all into `resources/` — then `cargo tauri build` (compiles Rust, bundles the WebView2 frontend, produces the NSIS installer). Seven of those produce a `tauri.conf.json` resource directory (`python`, `icc`, `fonts`, `libreoffice`, `tesseract`, `jbig2enc`, `dictionaries`), and **every one must exist before a build can succeed** — Tauri validates resource paths even with `--no-bundle`.

Output: `src-tauri/target/release/bundle/nsis/Spectra PDF_X.Y.Z_x64-setup.exe`

**Individual steps** (if needed):

| Command | What it does |
|---------|-------------|
| `npm run prepackage` | Vendors every bundled runtime — embedded Python, ICC colour profiles, edit fonts, LibreOffice, native Tesseract, jbig2enc, spelling dictionaries, OCR models, pdf.js assets (no compile) |
| `npm run build:renderer` | Vite production build of the React frontend |
| `npm run build` | `cargo tauri build` — Rust compile + NSIS installer (assumes prepackage already ran) |
| `npm run package` | All of the above in sequence, release shape — needs `TAURI_SIGNING_PRIVATE_KEY` for the updater artifacts |
| `npm run package:unsigned` | Same, minus the updater artifacts — the local-build path, no key needed |

## Architecture

```
+-------------------+      invoke()      +------------------+      JSON-RPC       +-------------------+
|   React UI        | <----------------> |   Rust Backend   | <--(stdin/stdout)--> |   Python Engine   |
|   (WebView2)      |                    |   (Tauri v2)     |                      |   (pikepdf + GS)  |
+-------------------+                    +------------------+                      +-------------------+
        |                                        |                                         |
        v                                        v                                         v
  WebView2 (Edge)                          Tauri commands                           Embedded Python 3.14
  - Menu bar / toolbar / tabs              - File dialogs + path canon              - 190+ operation handlers
  - Reading view (virtualized)             - Printer/scanner enumeration            - pikepdf (structural)
  - Organize board (page strips)           - Sidecar management                     - pdfminer.six (text)
  - Navigation pane                        - System tray                            - pyHanko (signatures)
  - Tool dock (26 tools) + status bar      - Single instance + window claims        - Tesseract (upstream: OCR)
  - Command registry + keymap              - Update check (notify-only)             - Ghostscript (user-installed:
  - pdf.js render + text layer             - Registry policy check                    compress, PDF/A, print,
                                           - Scheduler / watched folders              distill, separations)
                                           - Virtual printer listener
```

Documents are owned by one window at a time; a second window is a second workspace, and ownership is held in Rust so a renderer that goes away cannot leave a document claimed.

**Frontend**: Tauri v2 (WebView2), React 19, TailwindCSS, pdf.js, pdf-lib
**Backend**: Rust (Tauri commands) + Python 3.14 (embedded), pikepdf, pdfminer.six, pyHanko, Tesseract (upstream, Apache-2.0), and a user-installed Ghostscript where a feature needs one
**IPC**: Tauri `invoke()` (JS→Rust), JSON-RPC 2.0 over stdin/stdout (Rust→Python)

### What powers each feature

Every capability is built on open source, each component doing the job it
is best known for. AGPL tools stay at arm's length — separate processes,
never linked — so the app's own code remains MIT. Full texts and exact
versions: [THIRD-PARTY-LICENSES.md](THIRD-PARTY-LICENSES.md).

| Feature | Powered by | License |
|---------|------------|---------|
| Page rendering, selectable text, search display | pdf.js | Apache-2.0 |
| Page assembly & `.pdfx`, annotation authoring, form fill & field creation | pdf-lib | MIT |
| Structural operations (merge, split, rotate, delete), redaction, in-place text & paragraph editing, watermarks, encryption, repair tiers 1/3 | pikepdf / QPDF | MPL-2.0 / Apache-2.0 |
| Text extraction, font metrics & encodings for the text editor | pdfminer.six | MIT |
| Digital signatures — signing and verification | pyHanko + cryptography | MIT / Apache-2.0+BSD |
| Signer identity vouched for by a public trust programme | Bundled trust-list snapshots from multiple sources (read offline; nothing downloaded while you work) | see notices |
| Signing where the key stays at a service | Cloud Signature Consortium API | open specification |
| OCR — single documents and batch folder mirroring | Native Tesseract (bundled, separate process) | Apache-2.0 |
| Compress, grayscale, PDF/A, PDF/X, separations & soft proof, print rasterization, page-image export, repair tier 2, **Create PDF from PostScript (distilling)** | Ghostscript — **user-installed, not shipped**, invoked as a separate process | AGPL-3.0, licensed to you by Artifex |
| JBIG2 text stencils for MRC scan compression | jbig2enc (vendored upstream, separate process) | Apache-2.0 |
| Export to Word / RTF / ODT / HTML / XHTML | LibreOffice (bundled, separate process) | MPL-2.0 |
| Export to spreadsheet / presentation / plain text | The Python engine itself | MIT |
| Compatible-font fallback and OpenType features for text editing | Liberation + Libertinus faces, fontTools | SIL OFL 1.1 / MIT |
| Chinese, Japanese and Korean text editing and authoring, including vertical columns | Noto Sans CJK SC | SIL OFL 1.1 |
| Right-to-left text — Arabic, Hebrew, Persian, Urdu | IBM Plex Sans Arabic + Noto Sans Hebrew | SIL OFL 1.1 |
| Vertical Mongolian text | Noto Sans Mongolian | SIL OFL 1.1 |
| Spell check — 36 bundled dictionaries | spylls (pure-Python Hunspell) + LibreOffice dictionaries; libvoikko + voikko-fi for Finnish | MIT / see notices |
| Cursive letter joining (shaping) for right-to-left scripts | HarfBuzz via uharfbuzz | Apache-2.0 (HarfBuzz: MIT-0) |
| Window shell, native dialogs, IPC, updater | Tauri v2 + Rust crates | MIT / Apache-2.0 |

## Project Structure

```
spectrapdf/
├── src-tauri/                 # Tauri v2 Rust backend
│   ├── src/
│   │   ├── lib.rs             # App setup, tray, single-instance, events
│   │   ├── cli.rs             # CLI arg parsing, headless engine, batch mode
│   │   ├── commands.rs        # IPC command handlers (dialogs, paths, printers…)
│   │   ├── app_windows.rs     # Multi-window state + document ownership claims
│   │   ├── engine.rs          # Python sidecar lifecycle + response routing
│   │   ├── printers.rs        # winspool printer enumeration + capabilities
│   │   ├── scanner.rs         # WIA scanner enumeration and acquisition
│   │   ├── print_to_pdf.rs    # The virtual printer + its loopback listener
│   │   ├── web_capture.rs     # Web-page capture window
│   │   ├── clipboard_read.rs  # Clipboard sources for Create PDF
│   │   ├── scheduler.rs       # Scheduled batch runs (Windows Task Scheduler)
│   │   ├── watchers.rs        # Watched folders (intake → out → done)
│   │   ├── send_to.rs         # Hand the document to a mail client
│   │   └── snapshot.rs        # Region capture to the clipboard
│   ├── tauri.conf.json        # Tauri config, NSIS, resources, plugins
│   └── nsis-hooks.nsh         # Context menu, registry, enterprise policy
├── src/
│   ├── renderer/              # React frontend (rendered by WebView2)
│   │   ├── App.tsx            # Root — dialogs, funnels, state wiring
│   │   ├── commands/          # Command registry, menus, keymap, tools model
│   │   ├── state/             # AppState reducer, selectors, types
│   │   ├── components/        # Chrome (MenuBar/MainToolbar/TabStrip…),
│   │   │   ├── canvas/        #   the reading view + organize board
│   │   │   └── navpane/       #   the navigation pane panels
│   │   ├── panels/            # One tool panel per operation (shown in the right dock)
│   │   ├── locales/           # 28 UI catalogs + the engine-message table
│   │   ├── search/, ocr/      # Find/Search engine, OCR language model UI
│   │   ├── hooks/, lib/       # Engine bridge, commit gate, pdf builders
│   │   └── testHarness.ts     # e2e hooks (compiled in only with VITE_E2E)
│   └── engine/                # Python PDF engine (one file per operation)
├── e2e-tests/                 # WDIO specs against the built binary
├── tests/                     # vitest (renderer) + pytest (engine)
├── vendor/                    # Committed third-party artifacts: the pinned
│                              #   Python wheels and the ICC colour profiles
├── resources/                 # Vendored runtimes: embedded Python, LibreOffice,
│                              #   Tesseract, jbig2enc, edit fonts, colour
│                              #   profiles, spelling dictionaries (built by
│                              #   scripts; never committed)
└── scripts/                   # setup-python-embed.ps1, bundle-icc.ps1,
                               #   bundle-libreoffice.ps1, bundle-tesseract.ps1,
                               #   bundle-jbig2enc.ps1, bundle-dictionaries.ps1,
                               #   sync-edit-fonts.ps1, sync-ocr-assets.mjs,
                               #   sync-pdfjs-assets.mjs, gen-rust-licenses.ps1
```

## License

MIT (application code). Bundled third-party components and their licenses are listed in [THIRD-PARTY-LICENSES.md](THIRD-PARTY-LICENSES.md). Ghostscript is not bundled: it is an optional prerequisite you install and are licensed for separately, by Artifex, under the AGPL-3.0.
