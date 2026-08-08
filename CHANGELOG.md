# Changelog

## 1.0.25

### Document Properties: Initial View, Fonts and Advanced
- Document Properties gains three tabs beside Description and Security.
- **Initial View** sets how a document opens: the page layout, which navigation pane appears, the opening page and its magnification, the reading direction, and the window options.
- Page layout offers single page, single page continuous, two-up and two-up with a cover page, continuous or not.
- The navigation pane can open on bookmarks, page thumbnails, layers or attachments — or the document can open with no pane, or full screen.
- Magnification takes a percentage or fit page, width, height or visible area, and applies to the opening page.
- The app honours what it can of a document's own initial view when it opens one: the layout, the navigation pane, full screen, the opening page, a percentage magnification, fit-width, and a right-to-left reading direction, which reverses which side of a spread the leading page takes.
- The rest — hide the toolbar, the menu bar or the window controls, resize or centre the window, show the document title in the title bar — is written for other readers, and the panel says so rather than implying an effect.
- A document that opens by running a script keeps that script: setting an opening page is refused by name instead of quietly replacing it.
- A window option turned off removes the setting rather than writing a negative one, so a document only ever carries what departs from the default.
- **Fonts** lists every font the document uses, grouped by type, with its encoding, how many pages use it, and whether its program is in the file.
- Fonts are found wherever they hide: nested artwork, comment appearances, glyph procedures and a form's default appearance, not just the page's own resources.
- A font that is not in the file names the face this app actually substitutes for it.
- **Advanced** reports the PDF version, fast web view, whether the document is tagged, its page count, its page sizes with their standard paper names, whether an open action and a search index are recorded, and where the file lives.
- Advanced also sets the trapped flag and the base URL that relative links in the document resolve against.
- Changes on both tabs are ordinary undoable edits to the open document, and a document with live signatures warns or refuses first, as every other structural edit does.

### Watermarking with a page of another PDF
- A watermark is now text, a picture, or a page of another PDF, and the panel offers all three.
- A letterhead, a pre-drawn stamp or a vector logo can be stamped straight from the PDF it lives in.
- The page is placed as artwork, not as a picture: its lines and its type stay sharp at any size.
- Pick which page of the source to use; the first is the default.
- The source page is stored once in the document, however many pages carry it.
- The source page's own rotation is honoured, so it lands the way its own reader sees it.
- Anything the source page shows as a comment or a filled field is stamped along with it.
- Opacity applies to the whole artwork at once, so overlapping shapes in it do not darken where they cross.
- Scale, position, margin, tiling, angle, over-or-behind and the page selection all work as they do for the other two sources.
- Choosing a PDF in the picture picker says so, and points at the PDF source.
- A document cannot be its own watermark source, and the source cannot be the file being written.
- A missing, empty, password-protected, page-less or unreadable source is refused by name, as is a page number past the end.
- Command line: `watermark --pdf-source` with `--pdf-page`.
- Guided actions can stamp a page of another PDF, and refuse a step that names more than one source.

## 1.0.24

### Watermarking with a picture
- A watermark is now text or a picture, and the panel offers both.
- Any picture Create PDF accepts can be stamped, chosen through a file picker.
- The picture is stored once in the document, however many pages carry it.
- Scale sets how large it goes; 1 fills the page without crowding it, and it sizes a text watermark too.
- Position places it in the middle or against any edge or corner, with a margin.
- Tiling repeats the stamp across the whole page, with a gap you set.
- Position and tiling apply to text watermarks too, and the old placement is still the default.
- Opacity, angle, over-or-behind and the page selection work as they did.
- A picture with several frames stamps the first, and says how many it held.
- A watermark now reads level on a rotated page instead of lying on its side.
- A watermark on a rotated page no longer shrinks to fit the page's other dimension.
- Command line: `watermark --image`, with `--scale`, `--position`, `--margin`, `--tile` and `--tile-gap`.
- Guided actions can stamp a picture, and refuse a step that names both a text and a picture.

### Splitting a document four ways
- Split still takes page ranges, and now also a page count, a maximum file size, or top-level bookmarks.
- Every N pages writes as many files as it takes, the last one holding the remainder.
- Splitting by size measures each file as it is really written, so the limit is the size on disk.
- A page larger than the limit on its own gets a file of its own, and is reported.
- Splitting at bookmarks writes one file per top-level bookmark, from that bookmark to the next.
- Each file is named after the bookmark it starts at, with a name the filesystem accepts.
- Pages ahead of the first bookmark are kept, in a file named after the document.
- A document with no top-level bookmarks says so before you run it, and refuses by name if you do.
- Form fields survive every mode: each output carries the fields its own pages own, and no others.
- Command line: `split --mode every-n|size|bookmarks`, with the option each mode needs and a refusal for the ones it does not.

### Converting text and strokes to outlines
- The flattener converts all text to outlines, replacing each glyph with the font's own shape at the same place.
- It converts all strokes to outlines, replacing each line with the shape the pen covered.
- Either conversion runs on its own, on a document with no transparency at all.
- The panel says, before anything is written, how many text runs and stroked paths would convert.
- It states plainly that converted text can no longer be selected, searched or extracted.
- Text whose font the document does not embed takes its shapes from a bundled face the panel names.
- A font whose glyphs are program code rather than shapes is refused by name, never skipped in silence.
- A line with no width is refused by name, and Fix Hairlines is the tool that gives it one.
- Dashes are preserved by cutting the line into its dashes before each one is outlined.
- Line joins, caps, the miter limit and dotted patterns all come through as drawn.
- Text used as a clipping shape still clips, and invisible text is removed rather than left behind.
- Text inside reused page pieces converts without touching the other pages that share them.
- Command line: `outlines-list` reports what would convert, and `flatten` takes both conversions.

### Reviewing tables before a spreadsheet
- Find the tables on a page and see each one drawn on the document itself.
- Every table is shown with its column boundaries and its rows.
- A table is included or left out one by one, and nothing is included by default.
- Drag a table's frame to change what it covers.
- Drag a column rule to move a boundary, and the cells follow it.
- Double-click inside a table to add a boundary, or on a rule to remove it.
- The spreadsheet is written from the tables you kept, at the geometry you left them.
- Text no table claimed can still be carried to its own sheet.
- Lines outside every table and text written down the page are counted before you export.
- The review writes nothing to the document, whatever you change.
- Export to Excel offers the review, and exporting without it works exactly as before.

### Fixes
- Extracting a portfolio member named after a reserved device name now writes a real file.
- An over-long portfolio member name is shortened to one the filesystem accepts, rather than failing.

## 1.0.23

### Print production
- A new Print Production tool holds preflight, colour conversion, and the two new ink tools.
- Output Preview renders the pages you are reading as separations, on the document itself.
- Overprint is simulated, which no screen rendering of a page can show.
- Every ink switches off and on, and the page redraws without rendering again.
- The heaviest pixel's total ink is reported, with an editable limit and an on-page highlight.
- Per-ink page coverage is shown for what it is: an average over the whole page.
- Ink Manager shows one spot colour as another, then rewrites the document so both print on one plate.
- Aliasing two inks that describe different colours is refused until you accept the change.
- A spot converts to process exactly, through its own tint transform, in fills, strokes, images, gradients and patterns.
- Ink density and print sequence are offered as what they are: settings of the application, not of the file.
- Add Printer Marks draws crop marks, registration targets, colour bars and page information outside the trim.
- The page grows to hold them and the crop box grows with it, so no viewer clips the marks away.
- The trim, bleed and art boxes never move, and removing the marks restores every box exactly as it was.
- Marks print in registration colour, so they land on every plate rather than on the black one alone.
- The colour bar carries process solids and tints, an overprint pair, and every spot in the document.
- Page information is drawn with an embedded font, in the document's own conventions.
- Western and Japanese mark styles, three stroke weights, and a stated growth before anything is written.
- A document with no trim box is marked against its crop or media box, and the panel says which.
- Fix Hairlines finds strokes too thin to survive printing and raises them to a width that does.
- Thinness is measured as the width the device draws, so a wide stroke under a small scale is found too.
- A zero-width stroke is always a hairline, and the correction lands on the device width whatever the transform.
- Annotation and form-field borders are included, and a border width of zero is left alone because it means no border.
- The count and the widths found are reported before anything is rewritten.
- Preflight gains a hairline row, reading the same measurement the fix uses.
- Preflight now finds fonts and colorants used only inside patterns, shadings, images or annotations.
- Flattener Preview marks, on the page itself, which objects a transparency flatten would rasterize.
- Transparent objects, what sits under them, and every object a region would take in are counted and highlighted per category.
- Flattening rasterizes only those regions: text and vectors outside them stay live text and live vectors.
- Region edges land on whole device pixels, so flattened and live content meet without a seam.
- A raster/vector balance decides how far regions merge — fewer seams at one end, more live content at the other.
- The regions rasterize at a resolution you choose, and a request too large to render is refused rather than attempted.
- A page with no transparency is reported as such and left exactly as it was.
- Trap Presets authors named presets over the standard in-RIP trapping parameters and assigns them to page ranges.
- Every parameter carries its type, range and default; a value outside its range is refused.
- Per-ink overrides are supported; a preset naming an unused ink warns rather than refuses.
- Exporting to PostScript writes each range's parameters into that page's own setup, where a press that traps reads them.
- The trapping declaration stays "unknown" until stated; assigning a preset never claims a document is trapped.
- PDF/X masters no longer declare every document untrapped; the declaration is yours to make.
- On the command line as `printer-marks`, `printer-marks-remove`, `printer-marks-list`, `hairlines-list`, `hairlines-fix`, `flatten-list`, `flatten`, `trap-fields`, `trap-list`, `trap-assign` and `export-postscript`.

### Preparing forms
- A new signature field can carry the form fields it locks, chosen from the document's own list.
- Whoever signs that field is bound by the lock without asking for one.
- Prepare Form lists the document's signature fields and edits the lock on any unsigned one.
- A signed field's lock is shown but cannot be changed.
- Detected signature fields can lock the fields being created alongside them.
- On the command line as `forms --sig-field NAME --lock` and `--clear-lock`.

### Exporting a folder
- Export a Folder converts every PDF under a folder to a chosen format in one run.
- All eleven export targets are offered: Word, rich text, OpenDocument, HTML, XHTML, plain text, spreadsheet, presentation, PNG, JPEG and TIFF.
- Outputs land in a destination folder at the same place in the tree, with the target's extension.
- Each target's own options are offered, and only the ones it accepts are sent.
- A document the chosen format cannot be produced from is reported against its own row; the run continues.
- The originals are never changed and never opened.
- A run log records each file, what it produced, and why anything was skipped.
- Guided actions gain export steps, so watched folders and scheduled runs can export too.
- On the command line as `export-folder`.

### Windows contrast themes
- The app now responds to the Windows contrast themes setting.
- Documents are never recoloured: pages, annotations, their text and thumbnails keep their own colours.
- That protection no longer depends on which app theme is picked; it applies at all times.
- The window's own chrome follows the system palette, which is what the setting asks for.
- Selected tools and pressed toolbar buttons show as selected in the system's own highlight colour.
- Buttons, text fields and lists regain their outlines, so a control is visible as a control.
- Toolbar and menu separators, and a panel's status box, keep their edges.
- Colour swatches keep the colour they are offering, with an outline so they still read as buttons.
- Translucent window bars turn solid, as a contrast theme expects.
- Preferences says the system palette is in control, and remembers the theme you chose untouched.

### Languages
- The interface is available in English, Spanish, French, German, Italian, Brazilian Portuguese, Japanese, Simplified Chinese, Traditional Chinese, Korean, Dutch, Danish, Swedish, Norwegian Bokmål, Finnish, Russian, Ukrainian, Polish, Czech, Slovak, Turkish, Hungarian, Greek, Romanian, Slovenian, Catalan, Arabic and Hebrew.
- Russian, Ukrainian, Polish, Czech and Slovak counts carry all four number forms, with matching agreement.
- Spanish, French, Italian and Portuguese counts in the millions now read in that language, not English.
- Symbol search matches an uppercase I whatever regional format the computer is set to.
- Tool search results sort by the alphabet of the language on screen.
- Traditional Chinese is written for Taiwan, not a character conversion of the Simplified translation.
- Korean and Chinese counts take one form, as those languages do, rather than an invented singular and plural.
- Turkish and Hungarian counts keep the noun in its plain form after a numeral, which is how those languages count.
- Turkish and Hungarian never attach an ending to a file or field name, so endings always agree.
- Korean never attaches a particle to a file or field name, for the same reason.
- Romanian counts insert "de" above nineteen, the way Romanian is written.
- Slovenian counts use the dual for exactly two, alongside its singular, few and plural forms.
- Greek headings uppercase without their accents, as Greek is set in capitals.
- A Traditional Chinese, Hong Kong or Macau system opens in Traditional Chinese.
- In Arabic and Hebrew the whole interface reads right to left: panels, toolbars, lists and dialog buttons all change sides.
- The page itself never flips, whatever language the interface is in.
- Resize handles keep the corner you grabbed, and rulers still measure from the page origin.
- Arabic counts carry all six number forms, including the dual and the three-to-ten plural.
- Hebrew counts carry its singular, dual and plural forms.
- Arabic page numbers use the same digits the document draws on its pages.
- File paths, keyboard shortcuts and page ranges stay readable inside right-to-left sentences.
- A system set to Hebrew under the older "iw" language code now opens in Hebrew.
- A page range past the last page is refused fully in the language on screen.

### Security
- The bundled PDF rendering library is updated past GHSA-hq66-cqwq-w95j, where opening a crafted document could run arbitrary code.
- A build-time test dependency is updated past a reported denial-of-service vulnerability.

## 1.0.22

### Signing
- Lock form fields when you sign: every field, only the ones you choose, or everything except them.
- Fields are picked from the document's own list, beside the certification options and as `--lock` with `--lock-field`.
- A signature field prepared with its own locking rule keeps it, and the result says so.
- Each signature reports what it locks, and separately when a locked field has changed since.
- Filling a locked field is refused, naming the fields and pointing at saving a copy.
- Signature verification can also anchor on the system certificate store, off until you turn it on.
- The purposes each authority is trusted for are respected, and a verified signature names the source that vouched for it.
- On the command line as `verify-signatures --system-trust` and `sign --system-trust`.

### Folder tools
- Tools ▸ Prepare Forms in a Folder… works out and creates each form's fields across a folder and its subfolders.
- Tools ▸ Search & Redact Folder… runs a term, word list or built-in pattern over every PDF in a folder.
- Neither opens the files: they are read where they sit, and nothing has to be open.
- Both show what they found before anything is written, as a checkable list with nothing checked for you.
- Both write into a destination folder by default; redacting or preparing originals in place takes a separate confirmation.
- Signed documents are decided per file, and a document certified against changes is refused and named.
- Search & Redact Folder can write redaction marks for later review instead of removing anything.
- Prepare Forms in a Folder can hand any file to the document view for a closer look.
- Every run writes a log naming what was written, what was copied unchanged, and what was skipped and why.
- Both run inside a guided action and on the command line as `prepare-forms` and `search-redact`.

### Optimize
- Optimize opens on a breakdown attributing every byte of a document to one of fourteen categories, largest first.
- The rows add up to the file size exactly, and the table shows the total so it can be checked.
- Each row names the setting that addresses it, and only settings that exist.
- Every finding expands to name the individual objects, with the page each sits on.
- The breakdown never alters the document, re-runs itself after a change, and is available as `audit-space`.

### Fixes
- Filling a form or commenting on a certified document no longer leaves its certification signature reporting incomplete coverage.
- Updated bundled and build-time dependencies, fixing GHSA-52cp-r559-cp3m, GHSA-h67p-54hq-rp68 and GHSA-mh29-5h37-fv8m in js-yaml and GHSA-67mh-4wv8-2f99 in esbuild.

## 1.0.21

### Certifying a document
- A signature can certify, stating what may change afterwards: nothing, form filling, or form filling and commenting.
- The choice is written into the document and cannot be changed later, so it is spelled out in full.
- Certifying works with invisible signatures, visible stamps, signature files, hardware tokens and long-term validation.
- The Signatures panel and side panel show who certified a document and what the certification allows.
- An edit within what the certification permits goes through untouched; anything beyond it warns and names what is allowed.
- A document certified against all changes is not edited here; saving a copy is offered instead.
- A permission level this version does not recognise is reported as unchecked rather than as a pass or a failure.
- Command line: `sign --certify --certify-level` (`none`, `form-fill`, `annotate`), and `verify-signatures` reports certification.
- Fixed: adding a comment or filling a field on a certified or long-term-validated document destroyed the signature.
- Fixed: filling a field whose on-page box is stored separately reported a valid signed document as tampered with.
- Fixed: applying redactions to a signed document went ahead without asking, and is now refused on a certified one.

### Remove Hidden Information
- Redact ▸ Remove Hidden Information lists fourteen kinds of content the file carries but does not show.
- Every category shows a count and opens to name each finding; a category with nothing in it says so.
- Nothing is removed until you tick it, and the three choices that cost you something are never pre-ticked.
- Apply reads the document again and shows before and after, so an incomplete clean-up reports what is left.
- One undo takes the whole pass back.
- It finds attached files reached through an annotation, which the Attachments panel never saw.
- It finds content an earlier revision of the file still holds, and removing revisions writes the file out whole.
- It finds a hidden layer's words, which stay searchable while the layer is merely undrawn.
- It finds invisible text, text matching its background and text covered by something opaque; partly covered text is kept.
- A signed document warns first, naming how many signatures the clean-up will break; a certified one says so distinctly.
- Command line: `audit` prints the report as JSON, and `sanitize --categories …` removes the named categories.
- Also available as a step in a guided action.

### Prepare Form
- Detect fields turns the rules, boxes, checkboxes and radio buttons on the page into suggestions.
- Each suggestion is named from the label beside it and typed by its own shape, comb fields included.
- Suggestions draw in a dashed outline and can be moved, resized, renamed, retyped or discarded first.
- Nothing is written to the document until you say so, and one undo takes the whole set back out.
- A page with nothing but an image on it is recognised automatically, within a point of the original.
- A line with no label, and a region that already carries a field, are reported with a count rather than offered.
- Command line: `detect-fields` prints what it found as JSON and writes nothing.

### Export
- Export to a spreadsheet finds the tables on the page and writes their cells as a workbook.
- Tables are read whether fully ruled, ruled only between rows, or drawn with no rules at all.
- Figures are written as figures, with matching cell formats for thousands, currency, percentages and unambiguous dates.
- Separators follow the document's own conventions, whichever language the app is running in.
- A spanning heading comes back as one merged cell, and two tables on a page produce two sheets.
- Pages with no table, and the count of lines outside a table, are named and can be kept separately.
- A document with no table anywhere is refused rather than saved as an empty workbook.
- Export to a presentation writes one slide per page, with real text boxes over the rendered page.
- Slides take the document's page size unless you pick widescreen or standard, and the export counts what it wrote.
- Export to plain text writes the document's text in reading order or keeping the layout, optionally with page breaks.
- Extract Text can save straight to a file instead of only copying to the clipboard.
- All three have command-line arms, and `extract-text` writes the text directly.
- Fixed: exporting to XHTML produced an empty file for every document.

### Fixes
- The rotation tooltip on the text toolbar carried a stray internal reference; it reads as a plain sentence now.

## 1.0.20

### Redaction
- Search & Redact marks every occurrence of a term, an imported word list or a built-in pattern in one pass.
- Built-in patterns cover phone numbers, emails, card numbers, social security numbers, dates, IBANs, NHS and social insurance numbers.
- Search this document, a range of its pages, or every document you have open.
- Matching is the same as the find bar's, including match case, whole word and regular expressions.
- Results group by document and page with nothing ticked to begin with, and clicking a match goes to its page.
- Numbers carrying a check digit are verified, so the list is not padded with every long number on the page.
- A match can be marked as found, grown to the whole word containing it, or grown to the whole line.
- Pages with no searchable text are reported with Scan & OCR one click away.
- A redaction mark takes a fill colour and drawn text — a FOIA or Privacy Act exemption code, or anything you type.
- The text takes its own alignment, size and colour, and can repeat to fill the box.
- Both exemption sets ship with their descriptions, and your own set of codes imports and exports as a file.
- Marks are stored in the document in the format's own vocabulary, so other PDF programs read them.
- Redaction now measures every line with the font that drew it, rather than estimating its width.
- Measurement covers letter and word spacing, stretched text, and rotated, stamped and vertically-set text.
- The checked area reaches below the baseline, so a mark drawn across descenders covers the line.
- Where a document gives no usable measurements, redaction deliberately covers more than it needs to and says so.
- **This affects every earlier release: files you have already redacted are worth re-checking.**
- Redaction removes exactly the marked characters and leaves the rest of the line where it was.
- Letters a font draws as one shape, and accents belonging to the letter under them, are kept together.
- A saved mark that is damaged, or whose page is gone, is now reported by count and page instead of silently skipped.

### Headers, footers and Bates numbering
- Japanese, Chinese, Korean, Arabic, Hebrew and Persian stamps at any of the six page positions.
- Right-to-left text is shaped and laid out properly, with page and Bates numbers where the language puts them.
- A header in one script and a footer in another are handled in a single pass.

### Creating a PDF
- File ▸ Create PDF takes Word, Excel, PowerPoint, OpenDocument, RTF, plain text, CSV, HTML, PostScript and EPS.
- It also takes images from PNG to HEIC, PDFs you already have, and blank pages, in a list you order yourself.
- Every row shows what it is and how it converts; a file nothing can convert is marked rather than dropped.
- Pages keep each source's own geometry, or take a paper size, orientation and margin with nothing stretched.
- Form fields, links and bookmarks survive the conversion.
- A scanned image becomes a correctly sized page, because the image's own resolution is read and used.
- Every page of a multi-page TIFF is kept, in Create PDF and in Batch OCR.
- HEIC, WebP, JPEG 2000 and AVIF photos are read directly.
- Conversion is sealed off from the network entirely, and macros are never run.
- A missing font is named in the result, and a conversion that produced nothing now says so.

### Combining files
- Combine Files takes everything Create PDF takes, converting non-PDF sources as they go in.
- Every row shows what it is, how it converts and how many pages it will contribute.
- Each PDF in the list takes a page range like `1-3,5`; fields, links and bookmarks on those pages survive.
- Combine into a new PDF, or add the pages to the end of a document you already have open.
- Combine is now available with nothing open.

### Automating conversion
- `create-pdf` writes one PDF from any list of sources, with the same page size, margin and resolution choices.
- `merge` accepts non-PDF inputs, and `batch <folder> create-pdf` converts every convertible file in a folder.
- "Create PDF from any file" is a guided-action step, valid only as the first step.

## 1.0.19

### Vertical text
- Mongolian columns advance left to right, and now list, read and reflow in that order.
- The direction is read from the text itself, so documents in other vertical scripts are untouched.
- Edited Mongolian is re-formed so it reads as joined words, using the document's own typeface where it can.
- Edited text still extracts, searches and copies as the characters that were typed.
- A number set upright inside a column is part of that column's text and stays exactly one column wide.
- Commas, brackets and quotation marks take the upright forms the typeface provides for vertical setting.

### Scanned documents
- Compress gains "Scanned document (MRC)": text, ink colour and paper are separated and stored separately.
- The words keep the scan's own resolution while the paper compresses hard — roughly a sixteenth of the original.
- Three settings — Archival, Balanced and Smallest — plus a PDF/A-safe option, each stating what it guarantees.
- Only scanned pages are touched; every other page is left byte-for-byte alone.
- A document with no scan in it says so instead of writing a pointless copy.
- Form fields, comments, links, bookmarks and an existing searchable text layer come through untouched.
- Optionally each page is read before and after, and a page whose text did not survive keeps its original scan.
- Available in the Compress panel, Preferences, Batch OCR, the command line, guided actions, watched folders and schedules.
- Pages using CCITT Group 4, JBIG2 or JPEG 2000 images rendered blank in the viewer and now draw.
- The same fix restores CJK character encodings, the standard PDF typefaces and CMYK colour profiles.
- The fixed five-minute limit on compressing, converting and repairing now scales with the document.

### Language
- French, German, Italian, Brazilian Portuguese, Japanese and Simplified Chinese join Spanish.
- Each covers the whole interface, and a language is offered only once its wording is complete.
- Each language uses the terms its own design, print and PDF software uses, not a literal rendering of the English.
- Counts inflect where the language inflects them, and punctuation and spacing follow each language's conventions.
- A PC set to Portuguese or Chinese in any regional spelling opens in that language.

## 1.0.17

### Drafting aids
- The pointer snaps to endpoints, midpoints, centres, intersections and edges, and to markup already placed.
- Each snap kind switches off on its own, Alt suspends snapping, and Tab steps through the candidates under the cursor.
- Holding Shift holds a segment to the nearest angle increment, 15° by default and configurable.
- Rulers along the top and left edges read in the drawing's own units and track the pointer.
- Drag a guide off a ruler onto the page, move it, or drag it off; guides are never written into the document.
- A grid spaced in paper units or in real-world units through the drawing scale, with showing and snapping separate.
- Snapping applies wherever you place something, not only while measuring.

### Count and takeoff
- Count items into named groups: click each item for a numbered marker, and click it again to un-count.
- Each group has its own colour and symbol, and Ctrl-dragging a box moves markers into the armed group.
- Tallies are read from the marks themselves, per group and per page.
- Stamp a legend table onto the page — symbol, group and count per row, with a total.
- Export the takeoff as CSV, one row per group per page plus a totals row, from the app or the command line.
- Markers save as ordinary annotations, so a counted drawing opens with its groups and numbering intact anywhere.

### Symbols
- A searchable library of vector symbols, in the stamp picker and beside the count groups.
- Twenty general AEC symbols ship with the app, alongside the counting markers.
- Load a firm's symbols from a JSON file and export any set back out; an invalid file is refused by name.
- A placed symbol carries its own artwork inside the document and prints crisply at any size.
- Placed symbols snap, take the working colour, resize keeping their shape, and move, group and delete like any annotation.

### Language
- Spanish: the whole interface, offered only once its wording is complete.
- Settings ▸ Language chooses System default or a language outright, and the choice is remembered.
- The interface changes immediately with no restart, and the document you are working on is untouched.
- Counts, sizes and timestamps are written the way the chosen language writes them.
- The OCR language list is shown in your interface language, using the names Windows itself uses.
- Assistive technology is told which language the interface is in.

### Long documents
- Actual Size and Fit Width mean what they say however many pages a document has.
- Jumping to a page deep in a long document lands there and holds, and the end reports the last page.

### Vertical text
- A column of vertical text takes a font family, bold and italic, including an installed vertical face.
- A face with no vertical metrics is refused by name, saying which of the two reasons applies.
- Text turned a quarter turn belongs to its paragraph and reflows with it, and all four turns edit as paragraphs.
- A horizontal block set inside a vertical column is not reflowed, and says so.

### Fixes
- Deleting a group of images after an undo could silently do nothing; the selection now follows the document.
- Switching themes applies the theme and its accent colour as one step, so a slower answer cannot overwrite a newer one.
- Accent-coloured text and focus outlines meet the contrast standard in every theme, including high contrast.
- Whether a scheduled run is enabled is read from the task itself, so the button is right in any Windows language.

## 1.0.16 — Deeper image, vector, and paragraph editing

### Images
- Edge handles shear a placed image, and rotation and resize compose with it naturally.
- Shift/Ctrl-click builds a group on a page — move, scale, rotate, align, distribute or delete as one step.
- Replacing an image fits the new one inside the old frame, and a bare click places at natural size.
- Each image takes any of the sixteen standard blend modes, plus a draggable linear or radial fade.
- SVG artwork places as true vector content; files using unsupported features are refused with a stated reason.

### Vector objects
- A curve's selection box hugs the drawn shape rather than its control points, even under rotation.
- Paths interleaving colour and transform changes mid-path now move and restyle exactly.
- Vector objects inside forms within forms edit at any depth, leaving a form's other uses undisturbed.
- Gradient fills list, move and delete like any other vector object, and deleting removes the definition from the file.

### Text
- Fuller Japanese line-breaking rules for opening brackets, small kana, prolonged-sound marks and leader runs.
- New text boxes take any rotation, not just quarter turns, turning about their own centre.
- The paragraph editor checks each character against the font of the span it will actually land in.
- A paragraph split between the page and an embedded drawing groups and edits as a single paragraph.

## 1.0.15

### Editing
- Drag either edge of the paragraph editor and the text rewraps; a width no word fits is refused.
- Splitting a paragraph takes an adjustable gap, dragged or typed, instead of a fixed distance.
- Backspace at the start merges with the paragraph above and Delete at the end pulls the next one in.
- An edit already made rides along in the same single undo step instead of being refused.
- Size, colour and font choices made in the editor apply to the merged result.
- Pasted text keeps its bold, italics, font class, size and colour; what cannot be represented arrives as plain text.

### Accessibility and appearance
- A WCAG 2.1 AA audit sweeps every tool panel, dialog, menu and preference page in all three themes on every test run.
- A keyboard-operability suite runs alongside it: Tab reaches every region and no dialog traps you.
- The Windows accent colours every active control, focus ring, link and slider in every theme.
- Text on accent-coloured buttons picks black or white by measured contrast, hover included.
- Status greens and ambers are softened in the dark theme, and disabled buttons drop their colour entirely.
- The light and high-contrast themes are complete throughout, with a theme-consistency audit in the test battery.

### Scheduling and building
- Creating a schedule's task folder is guaranteed rather than assumed, proven by a live round-trip every build.
- The stalled-printer fix is proven with real connections on every test run.
- `npm run package:unsigned` produces the full installer with no signing key, and the README documents both build paths.
- The plain-window fallback for remote desktop and transparency-off is exercised live by the test battery.
- Documentation was corrected where it described retired components or overstated what publishing runs.

## 1.0.14

### Printing
- Two documents printed in the same second no longer overwrite one another's work in progress.
- A stalled print job gives up on its own instead of blocking every later print until a restart.

### Licensing
- Complete third-party notices for the roughly fifty libraries the bundled recognition engine links ship beside it.
- Each component is named with its licence and where its source lives.
- The build refuses to produce an installer if anything shipped is missing its notice.
- Notices are stored with the source, so building needs no network and produces the same notices every time.
- The recognition engine's upstream author list ships alongside its licence.

### Building and releasing
- Publishing runs the application, engine and Windows-layer test suites first and refuses to continue on a failure.
- It also refuses when the version being published disagrees with the version inside the app.
- The README setup steps list every component a build needs.

### Windows appearance
- With transparency effects off, or over a remote desktop session, the app uses its plain window styling.

### Automation and folders
- A scheduled task's password is handed straight to Windows instead of passing on a command line.
- A destination differing from the watched folder only by capitalisation is no longer treated as a separate folder.

### Command line
- `document-js-list` and `document-js-set` read and replace a document's JavaScript.

## 1.0.12

### Text
- Combining accent marks compose properly when editing, adding text, stamping a watermark or filling a field.
- Ligatures form where the typeface has them, and the words still copy, search and extract as ordinary letters.
- Arabic and Hebrew edits are drawn in the document's own font where it can carry them.
- Size, colour and weight apply to vertical Chinese, Japanese and Korean text.

### Pages
- Drag a rectangle in Crop & Page Boxes to mark what to keep; the margins fill in and Apply crops as before.

## 1.0.11 — Every font, every encoding

### Text
- The Add Text card and the paragraph editor list every font installed on this machine.
- Fonts whose licence forbids embedding are not offered, and the picker says how many were left out.
- Documents using Shift-JIS, EUC, Big5, GBK, UTF-8, UTF-16 or UTF-32 text open for editing.

### Scan & OCR
- A batch run takes PNG, JPEG, TIFF and BMP files alongside the PDFs, turning each into a searchable PDF.
- Supply a password with the run and an encrypted file is processed like any other.

## 1.0.10 — Write it in any direction

### Text
- Arabic or Hebrew typed into a new text box lays out in reading order, wraps, and joins cursively.
- Mixed text keeps embedded Latin words and numbers the right way round.
- Size, colour, bold and italic apply to a selected word or phrase in right-to-left text.
- A style change in the middle of a joined word is declined with a note rather than drawn.

### Watermarks
- Right-to-left watermarks, shaped and laid out correctly.
- Chinese, Japanese and Korean watermarks, which were previously declined.

### Forms
- Filling a field with Arabic or Hebrew produces a properly shaped, correctly ordered appearance, wrapped or not.

### Under the hood
- Fully vocalised Arabic round-trips: text carrying harakat is written, read back and re-edited exactly as typed.

## 1.0.9

### Text
- Arabic, Hebrew, Persian, Urdu and the other right-to-left scripts reflow: type and the paragraph re-wraps.
- Embedded Latin words and numbers stay the right way round, and the editor works in reading order.
- Edited Arabic is re-shaped rather than re-typed letter by letter, using a shaping-capable bundled font.
- Ligatures and letter marks survive the round trip, so an edited paragraph can be edited again.
- A paragraph is offered only when it can be read back; otherwise the individual text runs stay editable.

### Pages
- A document that labels its pages shows that label in the page box, with the sheet position beside it.
- Type either a label or a sheet number; both work.

### Images
- Repeated moves, re-scales and opacity changes on one image collapse instead of leaving a layer behind each time.

### Reliability
- Two operations that rewrite the same file can no longer overlap; the second waits for the first.

## 1.0.8

### Text
- Style any part of the text in the Add Text card with its own size, colour, bold or italic.
- Mixed sizes lay out with correct line heights, and the fit indicator measures exactly what will be drawn.
- Chinese, Japanese and Korean text can be added, edited and filled into forms.
- A CJK-capable font ships with the app and steps in only when the standard fonts cannot express the text.

### Accessibility
- A high-contrast theme: black backgrounds, white text, bright accents and gold focus outlines, applied from the first frame.

## 1.0.7

### Text
- Documents using Type 3 glyph-procedure fonts, common in TeX output, now edit like any other text.
- The text-run editor gains size and colour, with neighbouring text staying exactly where it was.

### Images
- Images embedded directly in page content streams can now be replaced and extracted like any other image.

### Under the hood
- The test build measures page rendering, so future releases can prove they got faster or catch a slowdown.

## 1.0.6

- Sign with a PKCS#11 smart card, USB token or HSM: choose the module, name the token and certificate, enter the PIN.
- Every signing feature works as with a file-based identity, including visible stamps, in-place signing and the PAdES range.
- PostScript files carrying form annotations now produce PDFs whose fields are readable, fillable and keep their values.
- Composite fonts lacking a text-mapping table recover it, from the named character collection or the embedded font itself.
- Text set in bare CFF or original Type 1 fonts is now editable, using the font's own encoding and widths.

## 1.0.5

### Certificate encryption
- Lock a document to one or more recipient certificates; anyone holding a matching private key opens it.
- The same permission controls apply, and screen-reader access is never blocked.
- Certificate-encrypted files, including ones other tools produced, now open by asking for your .pfx or .p12 key file.
- Both directions are on the command line.

### Forms
- Field calculation order survives page inserts, merges, splits, deletions and every other page operation.
- Scripts that run on save, print or close stay with the document through page operations and compression.
- Page operations on an XFA form refuse with a clear message instead of silently destroying the form data.

### Prepress
- Convert to CMYK through your own ICC profile, the bundled one, or the built-in default.
- Produce PDF/X-1a, X-3 or X-4 files carrying a real output intent; the conversion verifies its own output.

### Sharper and handier
- Zooming into a page whose rotation is not yet applied renders at full detail instead of scaling a coarse preview.
- Actual Size and Fit Width work in the page-organizing view, zooming to the selected page.

## 1.0.4

### Redaction
- "Save marks" stores redaction marks in the document as standard redaction annotations, so they survive closing it.
- Other PDF tools read them, marks never print, and saving them keeps existing signatures valid.

### Forms
- Reset buttons clear the form back to its designed defaults, re-rendering every field and keeping signatures intact.
- Link buttons show the address and offer to copy it; the app never opens the web on its own.
- Buttons wired to scripts or submissions say so instead of doing nothing.

### Drawing and shapes
- An Eraser removes exactly what it touches; cutting a stroke in the middle leaves both ends trimmed at the edge.
- Lines, arrows, polygons, clouds, drawings and measurements rotate in quarter turns and mirror either way.
- Arrowheads on either end of lines and polylines, and cloud bumpiness, are editable in the properties bar.

### Signing
- The Signatures panel's sign form hands off to on-page placement with your certificate details carried over.

## 1.0.3 — Signed documents stay signed

### Signatures
- Comments, form filling, XFDF import, added links and added pages append to the file, so existing signatures keep verifying.
- Edits a signed file cannot carry — removing or reordering pages, editing page content, flattening — behave as before.
- `incremental-save` applies an edited copy's changes onto a signed original as one appended revision.
- Signature cards name the page carrying the signature; click to go there.

### Printing
- The Print dialog previews every option — subsets, booklet order, poster tiles, pages per sheet, grayscale, scale — sheet by sheet.

### Drawing
- Pen strokes drawn in quick succession join into one drawing, and multi-stroke drawings from other tools import whole.

### Keyboard
- With single-key accelerators on: S places a sticky note, Z is marquee zoom, and E opens the content editor.

## 1.0.2

### Print options
- Two-sided printing: one side only, flip on the long edge, or flip on the short edge, where the printer has a duplexer.
- Pick any paper the driver offers, force portrait or landscape, and print in colour or grayscale.
- Print the odd or even pages, in reverse order, with collated or uncollated copies.
- Up to 999 copies, replacing the old 99-copy cap.

### Sheet layout
- Up to 4×4 pages per sheet, in any reading order, with optional borders and automatic rotation into each cell.
- Booklet printing: saddle-stitched order, left or right binding, and front-only and back-only passes.
- Poster tiling across multiple sheets at any scale, with overlap, hairline cut marks and assembly labels.
- Type an exact custom scale percentage.

### Control what prints
- Print the document with its markups, the document alone, or the document plus stamps.
- Print as image rasterizes pages at 150, 300 or 600 dpi before spooling, for drivers that mangle vector content.
- A cropped document prints its visible area, exactly as displayed on screen.
- `print` gained the same option set, and `printers --capabilities` reports a printer's papers, duplexer and colour support.

## 1.0.1

### Arrange your comments
- Drag a comment to move it and grab a corner to resize, with the opposite corner anchored and Shift locking the aspect.
- Ctrl-click adds to the selection and Ctrl-drag sweeps a rubber band; arrow keys nudge by a point, ten with Shift.
- Align, distribute and match sizes from the properties bar.
- Bring a comment forward or send it behind its neighbours; the order carries into the saved file.

### Drawing
- Seven shapes — rectangle, ellipse, line, arrow, polygon, polyline and review cloud — saved as real PDF shapes.
- Callouts: a text box with an arrowed leader, which opens for typing the moment you draw it.
- Stroke width, fill colour and opacity, for one shape or a whole selection, and pen strokes take width and opacity.
- Lines, arrows, polygons and callout leaders show draggable vertex handles when selected.
- Shapes drawn in other tools open as editable shapes; what cannot be represented faithfully is left exactly as it was.

### Measure
- Calibrate against a known length and every measurement that follows uses the ratio.
- Right-click a placed measurement to set the document scale from it, or to correct its recorded value.

### Comments that travel
- XFDF import and export carries geometry, colours, authors, dates, replies and Accepted/Rejected/Completed statuses.
- In the Comments panel, and on the command line as `xfdf-export` and `xfdf-import`.

## 1.0.0 — A new name: Spectra PDF

The product formerly released as "Open PDF Studio" continues here as Spectra PDF and restarts its numbering at 1.0.0 — same application, same code line.

### Moving from Open PDF Studio
- Spectra PDF is a fresh install, not an update; an existing install keeps working but receives no updates.
- Preferences, recents, custom stamps and saved actions start fresh.
- Guided actions survive the move as files: export them from the old app and import them here.
- The command line is `spectrapdf.exe`, and the virtual printer appears as "Spectra PDF".
- Scheduled runs live under the `\Spectra PDF\` Task Scheduler folder, and policies read from `HKLM\SOFTWARE\Spectra PDF`.
- Printers and schedules created by the old app belong to the old install; recreate them here.

### New since 2.8.7
- Attachments, Layers and Tags join the navigation pane, open beside the document alongside a tool panel.
- Send To ▸ Email hands the current document to your default mail client as a ready-to-send attachment.
- A tagged document's structure tree survives page moves, rotations, deletions and annotation commits.
- Automatic tagging gives an untagged document a usable structure tree in one step from the Tags panel.
- Batch OCR can update files in place, with the same per-file isolation and reporting as mirror runs.
- Watched folders process arriving PDFs through a guided action while the app is open, tray included.
- Install "Spectra PDF" as a printer and anything any application prints arrives in the app as a PDF.
- A non-PDF file inside a portfolio opens with the application that owns its type.
- Measurements save as true PDF measurement annotations, scale included, that other viewers understand.
- Four-pane split view with linked scrolling and zoom, for wide, spreadsheet-like documents.

## 2.8.7

### Guided actions
- Run an action over a folder of PDFs, subfolders included, into a mirror of the tree with originals untouched.
- One file's failure never stops the rest, and a run log lands beside the batch OCR logs.
- Export any action as a small JSON file, and import one with full checking.
- An unknown step or setting is refused by name, an import never overwrites an existing action, and no export carries a password.
- Schedule an action through Windows Task Scheduler, running even while the app is closed.
- A schedule keeps its own frozen copy of the action, and an action that asks for values at run time is refused.

### Command line
- `run-action <source> --dest <folder> --action action.json` runs a saved action file over a folder.

### Fixes
- In-place `encrypt` and `decrypt` now stage safely and replace the file atomically instead of silently failing.

## 2.8.6

### PDF portfolios
- A portfolio opens on its cover sheet with the file list alongside; open, save out, replace, add and remove files.
- Create portfolios from any files on disk, or convert the open document into one.

### Measure
- Distance, perimeter and area on the page, read as you go.
- Set a real-world scale and every readout follows; a finished measurement stays as a markup you can delete.

### Stamps
- Make your own text stamps: any label, any colour, saved for reuse.
- Dynamic stamps fill in `{date}`, `{time}` or `{name}` when you place them.
- Turn any picture into an image stamp; it lands undistorted and travels with the document.

### Guided actions
- Save a sequence of steps — compress, watermark, page numbers, OCR, strip metadata — and run it in one click.
- Steps run in order, each one undoable, and a failed step stops the run with its reason.
- Mark any setting to be asked for each run; passwords are never saved, and an encrypt step always asks.

### Split view
- Window ▸ Split shows two independently scrolling and zooming views of the same document.

### Fixes
- Applying a page change silently dropped every attached file a document carried; attachments now survive every page edit.
- In-place `compress`, `grayscale`, `pdf-a` and the metadata commands now stage safely and replace the file atomically.

### Command line
- New arms: `portfolio-info`, `portfolio-create`, `portfolio-make`, `portfolio-update`, and `ocr-file`.

## 2.8.5 — Batch OCR grows up

- 47 recognition languages in the app and in batch runs, including Japanese, Chinese, Korean, Arabic, Hebrew and Russian.
- A log for every batch run, with a retention you control, in a folder you can choose.
- Processed originals can file themselves into moved and error folders, with verify-before-move.
- Unreadable files can be repaired automatically and retried.
- Create, list, run-now, enable, disable and delete schedules from Tools ▸ Scheduled Batch Runs.
- Scheduled runs fire with the app closed, under alternate credentials or a managed service account.
- Recognition runs natively for speed and works under service accounts; the in-browser recognizer is gone.

## 2.8.4 — Tools you can find

### The tool pane
- A tool's name is now the biggest thing on its button, icons are smaller, and descriptions moved into tooltips.
- The pane narrows to a compact index when you browse all tools and widens back to your chosen width.
- Inside a tool the pane header says "‹ All tools" instead of an unlabelled grid icon.

### Search
- One toolbar box answers with both tools and document text; arrow keys and Enter work throughout.

### Comments
- One comments list: every comment in the document, with jump-to-page, note editing, recolouring, delete and delete-all.
- Comment and Comments became one tool, which arms markup on the page and lists what is there.

### Fixes
- Clicking a comment now always jumps to its page, including in the document you were already reading.

## 2.8.3 — License notices in the box

### The tool pane
- A Tools button in the toolbar shows and hides the right-hand tool pane from the top row.

### Licensing
- The full third-party notices ship with the app and are available offline: the aggregate list and a per-component listing.
- The SIL Open Font License text is installed alongside the bundled Liberation and Libertinus font files.
- Every bundled Python component keeps its own licence text inside the embedded runtime.
- Settings ▸ Updates & Licenses lists the complete set of bundled components and opens either notices file directly.
- The notices were audited and corrected against what actually ships.

## 2.8.2 — The workbench

### The new layout
- Every tool panel lives in a resizable pane on the right, with the document still in front of you.
- A status bar carries the page number, zoom and Fit, the Read⇄Organize switch, comments, and pending work.
- Every open file is a tab and that is all tabs are; `Shift+F4` toggles the tool pane and `Ctrl+Tab` cycles files.
- A Home page with quick actions, recent files with folder and last-opened details, and the full tool grid.
- Choosing a tool with nothing open asks for a file, then opens with that document loaded.
- Show or hide any toolbar button, and add optional buttons for the Pages, Bookmarks and Signatures panes.
- A Properties Bar (`Ctrl+E`) shows a comment's kind, page, size and note, with one-click recolour and delete.

### Reading and presenting
- Two-page spreads, with a "cover page separate" option so spreads pair the way a bound book does.
- Reading Mode (`Ctrl+H`) collapses the app chrome, and Presentation (`F5`) goes full-screen one page at a time.

### Accessibility
- A structure tags editor: retag headings and figures, set alternative text, titles and language, and restructure the tree.
- A reading order panel shows the exact order assistive technology reads a page, fixable in one click.

### Signing
- PAdES signatures to the B-B, B-T, B-LT and B-LTA profiles, with RFC 3161 timestamping and embedded revocation data.
- Verification can validate the signer's chain against certificate authorities you choose, managed in the app.

### Export and OCR
- Export to Word, RTF, ODT and HTML as real editable text, via a bundled converter with nothing to install.
- Export pages as PNG or JPEG per page, or a multi-page TIFF, at the resolution you choose.
- 47 OCR languages, up from four, every one shipping offline in the installer.

## 2.8.1

### Search
- The Find bar and Search panel gain match case, whole word and regular expression modes.
- Search every PDF in a folder without opening them; results list each file and page, and a click opens the match.

### Pages and pagination
- Headers, footers and Bates numbering at any of six positions, across a page range, correct on rotated pages.
- Crop and page boxes: trim the crop, bleed, trim or art box by page.
- Page number labels number pages independently of their order.

### Documents and security
- Attachments: embed, extract and remove attached files.
- Encryption permissions restrict printing, copying, changing and commenting; screen-reader access is always preserved.

### Under the hood
- Vector fill and stroke colours read correctly for ICC, Indexed, Separation and DeviceN colour spaces.
- Form fields read through the same engine as filling, so nested fields that were invisible now appear.

## 2.8.0

### Typography
- Text you add or edit is properly kerned, from the document's own font metrics or a metric-compatible stand-in.
- Editing text no longer un-kerns it.
- Apply real OpenType small caps and stylistic alternates to a whole box, a paragraph or a selected range.
- Where the document's font lacks the feature the text switches to a bundled serif, and stays searchable either way.

### Signing
- A signature can become part of the open document, undoably, instead of only producing a separate signed file.
- "Sign & save a copy" remains, and the file on disk is written only when you save.
- Signing an already-signed document adds a new revision and leaves existing signatures intact and valid.

### Document JavaScript
- View, add, rename, edit and remove a document's JavaScript in a dedicated editor; it never runs the scripts.

### Prepress
- Convert to CMYK honouring embedded colour profiles and preserving spot colours, with a choice of rendering intent.

### Editing polish
- Bold, italic, family and size on a selected range render exactly as they will commit, each part keeping its own style.

## 2.7.1 — Redaction fix (recommended update)

Three kinds of content could survive underneath a redaction mark and remain extractable from the saved file.

- Inline images stored directly in the page's content stream were left in place with the black box drawn over them.
- Shading and gradient fills covering a marked area were left in place.
- An annotation whose rectangle could not be read was treated as not overlapping and kept; unreadable position data now counts as overlapping.
- **If you redacted documents with an earlier version, re-check those files.**

## 2.7.0

- Colour, bold, italic, font family and size apply to a selected range inside a paragraph.
- The whole-paragraph controls remain when nothing is selected.
- Select a drawn line, rectangle or shape in the Edit tool and move, resize or rotate it with handles.
- Recolour its fill and stroke, set its line width, or delete it — every change undoable.
- Shapes inside a form or group are selectable and editable too, leaving the group's other uses untouched.

## 2.6.0

### Authoring
- Add Text: draw a box, type, pick size, colour and font family, and the text lands as real searchable text.
- Add Image: draw a box and place a picture; JPEG passes through losslessly and everything else embeds pixel-perfect.

### Editing
- Images drag to move, resize from corner handles, and rotate freely or in one-click quarter turns.
- Crop an image to a region non-destructively, keeping the picture data, and dim it with a live opacity slider.
- Enter splits a paragraph in two, and Backspace at the start joins it to the paragraph above.

### Restyling
- The paragraph editor's font family menu substitutes a whole paragraph into bundled Liberation Sans, Serif or Mono.
- Bold and italic substitute the matching bundled variant; twelve metric-compatible faces now ship.

### Edit more documents
- Symbolic fonts with an embedded font program are editable where the program provides a usable character map.

### Reliability
- A form field created on canvas could silently fail to appear under heavy load; it now succeeds visibly or says why.
- Image edits on pages sharing resources no longer leak entries into sibling pages.

## 2.5.0

### More documents
- Chinese, Japanese and Korean documents using the standard Unicode CJK encodings open for editing.
- A substitute font matches the original's style — serif for serif, monospaced for monospaced.

### Restyling
- The paragraph editor gained size and colour controls; changing size rewraps and re-spaces the paragraph.
- Outline (stroked) text recolours correctly, and an out-of-range size is clamped so text cannot fly off the page.

## 2.4.0 — Create PDF from PostScript

- File ▸ Create PDF from PostScript… converts `.ps` and `.eps` files with the classic quality presets.
- The result opens in one click, powered by the Ghostscript already bundled for compression and PDF/A.
- EPS files convert with their bounding box as the page, so figures stay figures.
- A non-PostScript file is refused with the reason named, and feeding a PDF points you at Repair's rebuild tier.
- Full command-line parity via `distill`.
- The README carries a feature sourcing table mapping every capability to the component that powers it.

## 2.3.0

### Find the features
- Document ▸ Combine Files… gives merging a named menu path; pages append to the current document, undoably.
- Tool tiles say what they do: Organize Pages names merge and delete, and Edit names text, paragraphs and images.
- Nothing moved and nothing changed behavior — the same features, now discoverable.

### Position and selection
- Selection, reading position and document focus survive page-edit commits, including edits saved in another open file.
- Moved pages keep their thumbnails steady across a save, with no flicker as they re-render.
- Cross-commit page identity means a stale reference can never point at the wrong page.
- Positions still reset when a file's content is rebuilt outside the editor, where holding a position would be a guess.

## 2.2.0 — Edit Text & Paragraph Reflow

### Edit Paragraphs
- Text that reads as a paragraph selects as one box and edits in a multi-line editor.
- Words rewrap inside the paragraph's own box, keeping its alignment, line spacing and first-line indent.
- Mixed fonts and sizes, coloured spans, superscripts, condensed text and OCR's invisible layer keep their look.
- Everything outside the box stays exactly put — neighbouring columns, text below, graphics.
- Wraps no-space scripts correctly; hyphens are treated as document text, never invented or removed.
- Right-to-left passages and rotated text stay on the single-line editor, with the reason stated.
- Text that does not group cleanly remains individually editable line by line.

### Edit Text
- Double-click a run of text and rewrite it in place, in the document's own font, undoably.
- Every keystroke is validated against what the embedded font can express, naming the character it cannot.
- Fonts that cannot round-trip say why instead of failing.
- Replacement text keeps the original position, and later words on the line slide over by exactly the width difference.
- Editing a signed document warns first, and cancelling leaves the file byte-untouched.
- One click re-renders an unwritable edit in a bundled compatible font, subsetted, embedded and still searchable.

## 2.1.0 — Edit Images & Batch OCR

### Edit Images
- Click any image on the page to replace, extract or delete it, undoably.
- An image used in several places changes only where you clicked, including inside reused form graphics.
- Replacing keeps JPEG bytes untouched; other formats convert losslessly with transparency preserved.
- Editing a digitally-signed document warns first.

### Batch OCR
- Tools ▸ Batch OCR Folder… mirrors a source folder into a destination with scanned pages made searchable.
- Already-searchable files copy through byte-identical, and the source tree is never modified.
- Encrypted or damaged files are skipped and reported, and unreadable subfolders are listed rather than missing.
- The run shows per-file, per-page progress, can be stopped, and reports pages with no recognizable text.
- Works with no document open, with a selectable recognition language.
- A destination inside the source is refused, including when reached by two different path spellings.

## 2.0.0 — The Workbench

### The frame
- A menu bar, main toolbar and tab strip: Home, Tools, and one tab per open document.
- A Home tab with recent files and an opened-when column replaces the welcome screen.
- Windows 11 Mica translucency on the chrome where the OS supports it, with a byte-identical solid fallback.

### Reading view
- A continuous, virtualized reading view is the default, smooth with 1,000-page files.
- Real text selection and copy, zoom presets, a page box, and cross-document Find and Search.
- Rotate View turns the page in quarter turns without touching the file, and every tool keeps working.
- Hand and Select modes, with Space as a temporary hand.
- The Organize page-strip board remains one click away for rearranging pages across files.

### Navigation pane
- Pages with drag-reorder, Bookmarks with editing, Search and Signatures panels; F4 toggles the pane.

### Tools, dialogs, print
- Twelve task-oriented tools: Organize, Comment, Fill & Sign, Prepare Form, Redact, Scan & OCR, Compare, Protect, Optimize, Repair, Watermark, Export.
- Document Properties on Ctrl+D and Preferences on Ctrl+K; every dialog closes on Escape and traps focus properly.
- Print (Ctrl+P) with a printer picker, page range, copies and fit/actual, plus `print` and `printers` command-line arms.
- Insert blank pages sized to their neighbour, undoable like every page edit.

### Keyboard
- A frozen keymap: standard chords, the document-op set, find stepping, and optional single-key tool accelerators, off by default.
- The webview's own keys can never fire, so a disabled shortcut does nothing rather than something surprising.

### Correctness
- One file is one document no matter how its path is spelled; paths canonicalize at the OS boundary.
- Printing, properties and every whole-file operation see pending page edits.

## 1.0.0 — The Canvas Workspace

### The canvas
- Every open PDF is a strip of live page thumbnails; drag pages within a document, between documents, or out into a new one.
- Single pages or multi-selections move as one undo step.
- One click appends a document's pages to the one above, and dropping files onto a document imports their pages there.
- Rotations, deletions, moves, imports and annotations stay in memory until Apply changes commits every touched file atomically.
- Multi-level undo and redo spans staged edits and applied operations.
- The `.pdfx` [open format](https://github.com/AlexandrosGounis/pdfx) saves several documents as one ordinary PDF that reopens as separate strips.
- Keyboard shortcuts throughout for undo, select all, delete, rotate, find and zoom.

### Annotate, redact, sign
- Highlights, text boxes, freehand ink and preset stamps with notes, recolouring and a comments sidebar.
- Existing PDF annotations import as editable objects.
- True redaction removes marked regions from the file's content — text, images, nested form XObjects and overlapping annotations.
- Verify embedded signatures for cryptographic validity and document integrity, with an honest trust caveat.
- Sign with a .pfx or a PEM key and certificate, place a visible stamp, or generate a self-signed identity in the app.
- Click an empty signature field to sign directly into it.
- Watermarks at any angle with auto-fit, and a PDF compare with a word-level text diff and a pixel-level visual diff.

### Forms
- Fill AcroForm text, checkbox, radio, dropdown and list fields on the page, then bake them in one click.
- Pending values survive page edits, and the classic panel is still there.
- Create fields by drawing them: text, checkbox, radio group, dropdown, option list and empty signature fields.
- Form fields survive page moves and rotations, merges, splits, deletion, compression and grayscale conversion.

### Find & OCR
- In-viewer Find across every open file, with match navigation and per-word highlights.
- Scanned pages OCR offline, and "Make searchable" persists an invisible text layer, leaving the page pixel-identical.
- A click-to-jump bookmark outline with drag-reorder and a full tree editor; bookmark links and actions survive editing.

### Command line
- New subcommands: `forms`, `outline`, `redact`, `watermark`, `compare`, `verify-signatures`, `sign` and `generate-signer`.

### Fixed
- Merging, splitting, deleting pages, compressing or converting a form PDF no longer destroys its form fields.
- Engine I/O is UTF-8 end to end, so non-ASCII names, bookmarks and form values round-trip correctly.
- Reopening an already-open file can no longer briefly serve its previous in-memory state.

## 0.9.0 — Initial Release

First public release of Open PDF Studio.

### Features
- Pages: merge, split by range, rotate, delete.
- Transform: compress with presets or custom DPI, grayscale, optimize, PDF/A, PDF version control.
- Security: encrypt and decrypt with AES-256.
- Content: extract text, and view, edit or strip metadata.
- Repair: three tiers of repair, rebuild and recovery for damaged PDFs.
- Preview: thumbnail grid, page inspector, drag-to-reorder merge workspace.
- Command line: every operation scriptable, plus batch processing over a directory.
- Windows integration: installer, silent install, file associations, context menu, tray, start-with-Windows, auto-update.
- Light, dark and system themes, WCAG 2.1 AA.

### Built with
- Tauri v2 (Rust + WebView2) and React 19.
- Embedded Python 3.14 (pikepdf, pdfminer.six).
- Vendored upstream Ghostscript 10.07.1 (AGPL-3.0).
