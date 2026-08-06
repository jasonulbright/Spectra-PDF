# Changelog

## 1.0.22 — Whole folders at a time, fields a signature locks, authorities this computer already trusts, and where every byte goes

A signature can settle form fields for good. When you sign you can lock every
field, only the ones you choose, or everything except the ones you choose,
picked from the document's own list rather than typed. Afterwards each
signature says what it locks, and says separately when a locked field has been
changed since. Filling a locked field is refused rather than warned about.

Two more tools now work on whole folders. Search & Redact runs its search over
every PDF in a folder and its subfolders, and Prepare Form does the same —
working out where each form's fields belong from its ruled lines, boxes and
labels, and creating them. Nothing has to be open, and nothing is opened. Both
show you what they found before anything is written, write into a destination
folder by default so your originals are untouched, decide signed documents one
file at a time, and leave a log of what happened. Both also run unattended,
inside a guided action or from the command line.

Verifying a signature can now anchor on the certificate authorities this
computer already records, as well as the ones you added yourself. It stays off
until you turn it on, it respects the purposes each authority is trusted for,
and a verified signature says which source vouched for it.

Optimize opens on a breakdown of where a document's size actually goes: every
byte attributed to one of fourteen categories, largest first, adding up to the
file size exactly, with each row naming the setting that addresses it.

### Lock form fields when you sign

A signature can now settle particular form fields for good. When you sign, you
can lock every field, only the ones you choose, or everything except the ones
you choose — and the fields are picked from the document's own list rather than
typed. The choice sits beside the certification options on both signing
surfaces, and on the command line as `--lock` with `--lock-field`.

Locking is independent of certifying: a plain signature can lock fields, and a
certification signature can do both at once. A signature field that was prepared
with its own locking rule keeps it — signing that field applies what its author
set, and the result says so rather than repeating what was asked for.

Afterwards, each signature says what it locks, and says separately when a locked
field has been changed since. Filling a locked field is refused rather than
warned about, naming the fields and pointing at saving a copy: the file that
would result reports as altered in every reader, so there is no version of that
edit worth offering. Every other field of the same document still fills exactly
as before, and comments are unaffected — a lock covers form fields only.

### Prepare a whole folder of forms

Prepare Form has worked one document at a time. Tools ▸ Prepare Forms in a
Folder… analyses every PDF in a folder and its subfolders, works out where each
form's fields belong from its ruled lines, boxes and labels, and creates them.
Nothing has to be open, and nothing is opened: the files are read where they
sit. Scanned pages are recognised the same way the single-document tool
recognises them, in the languages you choose.

What was found arrives as a checkable list grouped by file, each row naming the
field it would create, its type, its page and the label it was read from — and
nothing is checked for you. A file that already carries fields is not analysed
twice: what it has is subtracted, and the file still reports itself with the
count it already carries rather than silently offering nothing.

Any file can be handed to the document view for a closer look — one click opens
it with Prepare Form, where each suggestion can be moved, renamed, retyped or
thrown away on the page itself.

By default the prepared documents are written into a destination folder you
choose, leaving your originals exactly as they were; you can instead add the
fields to the originals in place, which takes a separate confirmation because
there is no undo. Signed documents are decided per file: adding a field breaks
a signature, so signed files are left untouched unless you say to include them,
and a document certified to allow no changes is refused outright and named in
the results. Every run writes a log naming what was prepared, how many fields
each file got, what was copied unchanged, and what was skipped and why.

The same step is available inside a guided action, so a watched folder or a
scheduled run can do it unattended, and on the command line as `prepare-forms`.
An unattended run has nobody to ask, so it creates every field it finds — the
field types it will accept can be narrowed.

### Search & Redact a whole folder

Redaction has worked one document at a time. Tools ▸ Search & Redact Folder…
takes the same search — a term, a word list, the built-in patterns for card
numbers, national identifiers, dates and the rest — and runs it over every PDF
in a folder and its subfolders. Nothing has to be open, and nothing is opened:
the files are read where they sit.

The results arrive as a checkable list grouped by file and page, and nothing is
checked for you. You tick the occurrences that should go, and only those are
written. By default the redacted documents are written into a destination
folder you choose, leaving your originals exactly as they were; you can instead
redact the originals in place, which takes a separate confirmation because
there is no undo.

A second mode writes redaction marks instead of removing anything, so a folder
can be swept for review and the marks applied later, document by document, by
whoever signs the work off.

Signed documents are decided per file rather than swept along. Removing content
breaks a signature, so signed files are left untouched unless you say to
include them, and a document certified to allow no changes is refused outright
and named in the results. Files that cannot be read — a password, damage — are
reported the same way, and never stop the run. Every sweep writes a log naming
what was redacted, what was copied unchanged, and what was skipped and why.

The same step is available inside a guided action, so a watched folder or a
scheduled run can do it unattended, and on the command line as
`search-redact`.

### A second trust source for signature verification

Verifying a signature answers two questions: is the document cryptographically
intact, and does the signer's certificate chain to an authority you trust. The
second question has only ever had one answer here — the certificate authorities
you added yourself — so a signer backed by an authority this computer already
trusts read as untrusted, which looks like a bad signature rather than a
difference in policy.

The Signatures panel now offers **Also trust the system certificate store**,
sitting beside your trust anchors and off until you turn it on. Turn it on and
verification also anchors on the certificate authorities this computer records,
respecting the purposes each one is trusted for: an authority trusted only for
web servers or for software does not become a document authority. A verified
signature says which source vouched for it — your own anchor, or the system
store — and the Signatures pane in the navigation panel now reports the same
verdict the panel does instead of always showing the identity caveat.

Nothing changes unless you turn it on. With the setting off, verification reads
no certificate store at all, and only anchors you chose can make a signature
trusted. On the command line, `verify-signatures --system-trust` and
`sign --system-trust` do the same.

### See where a document's size actually goes

Optimize has offered settings without ever saying which one was worth using.
It now opens on a breakdown of the file: every byte attributed to one category
— images, fonts, page content, comments, form fields, attached files,
bookmarks, named destinations, accessibility tags, document structure,
metadata, JavaScript, anything left unclassified, and the cross-reference
machinery and free space that hold the rest together. Largest first, with the
share each takes.

The rows add up to the file size, exactly, and the table shows that total so it
can be checked. That is the point: a percentage you cannot add up is a
decoration, so an object is charged what the file really spends on it — an
image is measured as it is stored, not as it decodes, and an object packed
together with others is charged its share of what that package occupies. What
is left over after every category is the overhead, and it says what it is made
of: cross-reference tables, revisions the file has superseded but still
carries, objects nothing can reach any more, and the headers and padding
between them.

Each row names the setting that addresses it — and only settings that exist. A
document that is 99% image points at Compress; one that is mostly superseded
revisions points at re-saving it; fonts, named destinations and the document's
own structure say plainly that nothing here changes them. Every finding can be
expanded to name the individual objects, with the page each sits on.

The breakdown is a read: it never alters the document, it re-runs by itself
after any change, and it is available on the command line as `audit-space`.

### Fixes

- Filling in a form or commenting on a certified document could leave its
  certification signature reporting that it no longer covered the whole file,
  so the app could no longer say whether the change was one the certification
  permitted. The original signature is now carried through untouched and the
  verdict reads back as it should.

## 1.0.21 — Fields found, hidden content named, documents certified, and export to spreadsheets and slides

Preparing a form stops meaning drawing every box by hand. Open a flat form,
pick Prepare Form and choose Detect fields, and the rules, boxes, checkboxes
and radio buttons on the page come back as suggestions — each already named
from the label beside it and typed by its own shape. You review them on the
page and nothing is written into the document until you say so. It reads a
scan as readily as a drawn original.

Before a document leaves your hands, you can ask what it actually carries.
Remove Hidden Information lists fourteen kinds of content that are in the file
but not on the page — document and page metadata, attachments, earlier
revisions, hidden layers, invisible text, scripts, actions, tags and more —
with a count and a name for every finding. Nothing is removed until you tick
it, and a pass that could not fully clear a category reports what is left
rather than claiming success.

A signature can now certify. Certifying states what anyone is allowed to
change after you sign — nothing at all, filling in the forms, or filling in
the forms and commenting — and the app reads that statement back. A certified
document says so, an edit that stays inside what the certification permits
goes through untouched, and an edit that does not is warned about or refused
before it can break the file.

File ▸ Export reaches three new targets: a spreadsheet, with the tables read
off the page and figures written as figures; a presentation, one slide per
page with editable text over the rendered page; and plain text, in reading
order or with the page layout kept. All three have command-line arms.

### Certifying a document

A signature can now do more than say who signed: it can state what anyone is
allowed to change afterwards. Open the Signatures panel on a document that has
not been signed yet, tick **Certify this document**, and choose what the
certification permits — no changes at all, filling in the forms and signing, or
filling in the forms, signing and commenting. The choice is written into the
document and cannot be changed later, so it is spelled out in full rather than
named by a number. Certifying works with everything signing already did: an
invisible signature or a visible stamp you draw on the page, a signature file, a
hardware token, and the long-term validation profiles.

Opening a certified document now says so. The Signatures panel and the
signatures side panel both show who certified it and what the certification
allows, and the signature that carries it is marked as the certifying one beside
its ordinary validity badge. If something in the document has gone beyond what
the certification permits, the panel says which signature reports it and what
kind of change it was.

**A certified document is treated as what it says it is.** Filling a form on a
document certified for form filling goes through with no interruption and the
document still reports as intact afterwards; adding a comment to one certified
for commenting does the same. A change the certification does not cover warns
first and names what the certification does allow. A document certified with no
changes at all is not edited here — the app says so and points you at saving a
copy, because every edit to such a document produces a file that reports itself
as broken.

Where the certification cannot be judged, the panel says that instead of
guessing: a permission level this version does not recognise, or a
certification entry that cannot be read, is reported as unchecked rather than
as a pass or a failure.

- **Certifying has a command-line arm:**
  `spectrapdf sign <in> -o <out> --pfx signer.pfx --certify --certify-level
  form-fill` (levels: `none`, `form-fill`, `annotate`).
- **`verify-signatures` reports it too**, as a document-level certification
  block plus, per signature, which one certified the document and whether the
  changes since stay within what it permits.
- **Fixed: a certified or long-term-validated document could not be edited
  without breaking it.** Adding a comment or filling a field on one rebuilt the
  whole file instead of appending to it, which destroyed both the certification
  and the signature. Both now append, and the document keeps verifying.
- **Fixed: filling a form field could report a valid document as tampered
  with.** A field whose on-page box is stored separately from the field itself —
  the shape most authoring tools produce — had its filled appearance reported as
  an unexplained change on any signed document.
- **Fixed: applying redactions to a signed document went ahead without
  warning.** Every other edit to a signed document asked first. Applying
  redactions rewrites the page, so it now asks too — and on a document
  certified against changes it is refused, with saving a copy offered instead.
  Declining leaves your marks on the page rather than clearing them.

### A document tells you what it carries

Before you send a document out, you can now ask what is actually in it. Open
the Redact tool, choose **Remove Hidden Information**, and the panel lists
everything the file carries that is not the page you can see: document and page
metadata, embedded and attached files, bookmarks, comments, form fields and
their values, JavaScript, hidden layers, text you cannot see, earlier revisions
of the file, objects nothing points to, links and actions, page thumbnails,
accessibility tags, and any digital signatures. Every category shows a count
and opens to name each finding, and a category with nothing in it says so —
zero and absent never look the same.

**Nothing is removed until you tick it.** There is no clean-everything button
that skips the report, and the three choices that cost you something — removing
the form fields, removing the accessibility tags, and removing the invisible
text that makes a scan searchable — each say what is lost and are never
pre-ticked. Apply removes exactly what you checked, then reads the document
again and shows the before and after side by side, so a category that could not
be fully cleared reports what is left instead of a success message. One undo
takes the whole pass back.

Four things it finds that no single panel could tell you before:

- **Attached files reached through an annotation.** The Attachments panel only
  ever saw the ones in the document's own list; a payload attached to a note
  was invisible to it. Both are found now, and the report says how each one is
  reached.
- **Content an earlier revision of the file still holds.** A document that was
  edited and saved incrementally keeps everything the newest version removed,
  and anyone with the file and a text editor can read it back. Removing earlier
  revisions writes the file out whole, and the older text ceases to exist.
- **A hidden layer's words.** Hiding a layer only stops it being drawn — the
  text stays in the file and every search and extraction still reads it.
  Removing the layer removes its content, not just its visibility.
- **Text you cannot see.** Text drawn in an invisible mode, text the same
  colour as what is behind it, text covered by something opaque, and text
  inside a layer that is switched off. Text that is only partly covered is
  reported and deliberately kept — the visible half is content.

A signed document warns first, naming how many signatures the clean-up will
break, and a certified one says so distinctly. It still proceeds if you say so:
the document is yours.

- Both halves have a command-line arm: `spectrapdf audit <file>` prints the
  report as JSON and writes nothing, and
  `spectrapdf sanitize <in> <out> --categories …` removes the named categories.
  `--all-removable` covers everything except the three that cost you something,
  which must be named explicitly.
- **Remove Hidden Information** is also a step in a guided action, so a watched
  folder or a scheduled run can clean every document that passes through it.

### Prepare Form finds the fields for you

Preparing a form used to mean drawing every field by hand and typing every
name. Open a flat form, pick Prepare Form and choose **Detect fields**: the
lines, boxes, checkboxes and radio buttons on the page come back as a list of
suggestions, each already named from the label beside it and typed by its own
shape — a long rule becomes a single-line text field, a tall box becomes a
multi-line one, a small square becomes a checkbox, a circle becomes a radio
button, and a box divided by tick marks becomes a comb field with the right
number of characters.

**Nothing is written to the document until you say so.** Suggestions are drawn
on the page in a dashed outline that no real field uses, and they can be moved,
resized, renamed, retyped or discarded before you keep any of them. Tick the
ones you want and create them in one step — and one undo takes the whole set
back out.

It also reads a scan. A page with nothing but an image on it is recognised
automatically, and the rules and labels recovered from it land within a point
of where they would on the original.

Two things it deliberately does not do: it never offers a line that has no
label beside it — those read as a table, not a fill-in — and it never offers a
region that already carries a field, so running it twice on a half-prepared
form does not double anything. Both are reported with a count rather than
silently skipped.

- Detection also has a command-line arm: `spectrapdf detect-fields <file>`
  prints what it found as JSON and writes nothing.

### Export to a spreadsheet, a presentation or plain text

**File ▸ Export** gains three targets beside the ones that were there.

**Spreadsheet (.xlsx)** finds the tables on the page and writes their cells.
It reads a table however it was drawn: fully ruled, ruled only between the
rows, or with no rules at all — a column is where cells line up, and rules only
confirm it. A figure is written as a figure, so the workbook adds up: plain
numbers, grouped thousands, currency and percentages all arrive with a matching
cell format, and a date written unambiguously arrives as a date. The
separators come from the document's own conventions, so `1.200,50` is the same
number as `1,200.50` whichever language the app is running in. A heading that
spans two columns comes back as one merged cell rather than two, a page holding
two different tables produces two sheets, and each sheet is named after the
table's own caption where it has one.

**It says what it did not export.** A page with no table on it is named, and so
is the count of lines that sit outside a table — which you can also keep, on a
sheet of their own. A document with no table anywhere is refused outright
rather than saved as an empty workbook that reports success.

**Presentation (.pptx)** writes one slide per page. The text lands as real text
boxes at the positions, sizes and faces the page used, so the deck is editable
rather than a stack of pictures; everything else on the page — rules, images,
fills — is rendered underneath it, so nothing is dropped. The slides take the
document's own page size unless you pick widescreen or standard, and a page of a
different size is fitted rather than cropped, with the count reported. **The
export proves itself by counting the slides it wrote**, which is the one check
that catches a presentation file that opens and is empty.

**Plain text (.txt)** writes the document's text to a file, in reading order or
keeping the page layout, optionally with a page break between pages. The
Extract Text pane can save straight to a file now instead of only copying to the
clipboard. A document with no text layer says so and points at OCR.

- All three have command-line arms:
  `spectrapdf export <in> -o out.xlsx -f xlsx --sheet-per table --include-untabled`,
  `-f pptx --slide-size 16:9`, and
  `-f txt --layout layout --page-breaks`; `spectrapdf extract-text <in> -o out.txt`
  writes the text directly.
- **Fixed:** exporting to XHTML produced an empty file for every document. It
  now writes the page's real text, like the HTML export beside it.

### Fixes

- The rotation tooltip on the text toolbar carried a stray internal reference
  in its wording. It reads as a plain sentence now, in every language.

## 1.0.20 — Redaction that searches and measures, and a PDF from any file

Redaction stops being a box you draw by hand, one at a time. Type a term —
or paste a list of them, or pick a pattern like a card number, an IBAN or a
social security number — and every occurrence in the page range, the
document, or every document you have open comes back as a list you tick
through before anything is marked. The black box itself gained a colour, a
caption and an exemption code, and marks are stored in the document, so they
survive being closed and reopened and other programs can read them.

Underneath that, redaction now measures text with the fonts that drew it.
The old estimate ran short — on monospaced text, roughly the last sixth of
every line sat outside the area redaction checked — which means content could
be marked, blacked out, and reported as removed while it was still in the
file and readable. That is fixed. **It affects every earlier release: files
you have already redacted are worth re-checking.** And what a mark removes is
now the characters you marked, rather than every word the document happened
to draw in the same instruction.

Creating a PDF stops meaning PostScript. File ▸ Create PDF takes Word, Excel,
PowerPoint, OpenDocument, RTF, plain text, CSV, HTML and EPS files, images
from PNG to HEIC, PDFs you already have, and blank pages — in one list you
order yourself. Combine Files takes the same set, with a page range on every
PDF in it. So do the command line and saved actions, so a watched folder can
turn every document that lands in it into a stamped, searchable PDF with
nobody at the keyboard. Conversion never reaches the network, and every page
of a multi-page fax or scan is kept.

Headers, footers and Bates stamps now work in Japanese, Chinese and Korean,
and in Arabic, Hebrew and Persian, at any of the six page positions.

### Redaction
- **Search & Redact: mark every occurrence of something in one pass.** Until
  now the only way to mark content for removal was to draw a box around it by
  hand, one box at a time — which does not survive contact with a two-hundred
  page set of documents. The Redact tool now carries a Search & Redact panel:
  type a term, paste or import a list of terms, or pick from the built-in
  patterns — phone number, email address, credit card number, social security
  number, date, IBAN, NHS number, Canadian social insurance number — and
  search this document, a range of its pages, or every document you have
  open. Matching is the same as the find bar's, including match case, whole
  word and regular expressions.
- **You decide which matches go.** The results are grouped by document and
  page, with a checkbox on every match, a checkbox on every group, and
  **nothing ticked to begin with**. Clicking a match takes you to its page so
  you can read it in context before deciding. "Mark checked" turns the ones
  you ticked into ordinary redaction marks — the same marks the hand-drawn
  box makes — which you can then move, delete, undo, save into the document,
  or apply, exactly as before. Searching never removes anything on its own,
  and a match you already marked is shown as such rather than offered twice.
  Where the numbers carry a check digit — card numbers, IBANs, NHS and social
  insurance numbers — they are verified, so the list is not padded with every
  long number on the page.
- **Choose what each mark covers.** A match can be marked exactly as found,
  grown to the whole word containing it, or grown to the whole line it was
  drawn with — spelled out in the panel, because whether searching for "55"
  in "1955" should black out two digits or the whole year is your decision to
  make. Pages that are scans with no text are searched through the app's own
  text recognition where it has already read them, and any page still without
  searchable text is reported with Scan & OCR one click away, so a scanned set
  never quietly returns fewer results than it has.
- **Redaction properties: the box has a colour, a caption and a code.** The
  black box is no longer always black: choose its fill colour, and the text
  drawn over it — a FOIA exemption such as (b)(6), a Privacy Act exemption
  such as (k)(2), or anything you type — with its alignment, size and colour,
  optionally repeated to fill the box. Both exemption sets are built in with
  their descriptions, and you can import your own set of codes as a file and
  export it again to share with colleagues. The settings apply to hand-drawn
  boxes and searched matches alike, and they are stored in the document with
  the mark, so a mark you save, close and reopen comes back the way you left
  it — and other PDF programs read it too, because it is written in the
  format's own vocabulary.
- **Redaction now measures text with the document's own fonts, and covers
  everything it draws a black box over.** The width of a line of text was
  previously estimated rather than measured, and the estimate ran short on
  most typefaces — worst on monospaced ones, where roughly the last sixth of
  every line fell outside the area redaction checked. Text in that stretch
  could be marked, blacked out, and reported as removed while still being
  present in the file and readable by anything that opens it. The same
  estimate ran the opposite way on documents using embedded font subsets,
  where it reached about twice as far as the text really did, so a mark placed
  in empty space could delete a neighbouring column. Both are gone: every
  line is measured from the font that drew it, including letter and word
  spacing, stretched text, and rotated, stamped or vertically-set text. The
  area checked also now reaches below the baseline, so a mark drawn across the
  descenders of a line — the tails of p, g, y — covers the line rather than
  missing it. Where a document gives no usable measurements at all, redaction
  deliberately covers more than it needs to and says so in the result, because
  removing too much is recoverable and removing too little is not.
  **This affects every earlier release. Files you have already redacted with
  an earlier version should be checked**: search the redacted file for the
  text you removed, and redact it again with this version if it is still
  there.
- **Redaction removes what you marked, not the whole line it sits in.**
  Marking one name in a paragraph used to delete every word the document
  happened to draw in the same instruction — often the entire line or
  paragraph — leaving a small black box over a large hole. Redaction now
  removes exactly the marked characters and leaves the rest of the line
  untouched and exactly where it was, to a hundredth of a point. Letters that
  a font draws as a single shape, and accents that belong to the letter under
  them, are kept together rather than being split down the middle.
- **A saved redaction mark can no longer go missing in silence.** Marks you
  save into a document are stored in the file itself, which means a document
  can also arrive carrying marks written by another program. If one of those
  marks is damaged and cannot be read, the app now says so — naming how many
  and which pages — instead of quietly showing you the ones it could read.
  Before this, a damaged mark was skipped, the count reported only the
  survivors, and applying redaction over what was shown could permanently
  leave behind content that had been marked for removal, with a success
  message. Saving marks over a document in that state refuses for the same
  reason, and a saved mark whose page is no longer part of the open document
  is now reported rather than dropped.

### Headers, footers and Bates numbering
- **Headers, footers and Bates stamps work in every script.** Japanese,
  Chinese and Korean text — and Arabic, Hebrew and Persian — can now be
  stamped at any of the six page positions. Right-to-left text is shaped and
  laid out properly rather than drawn as disconnected letters in reverse, and
  a page or Bates number inside a right-to-left line sits where that language
  puts it. A header in one script and a footer in another are handled in a
  single pass. Latin stamps are unchanged.

### Creating a PDF
- **Create PDF now takes Word, Excel, PowerPoint, images and more — not just
  PostScript.** File ▸ Create PDF opens on a list you build: add Word,
  OpenDocument, RTF, plain text, CSV, Excel, PowerPoint, HTML, PostScript and
  EPS files, images in PNG, JPEG, TIFF, BMP, GIF, WebP, JPEG 2000, AVIF and
  HEIC, PDFs you already have, and blank pages. Reorder them by dragging or
  with the arrow buttons, remove the ones you did not mean, and convert the
  whole list into one PDF. Every row shows what it is and how it will be
  converted before you start, and a file nothing can convert is marked as such
  instead of being quietly dropped. Dropping any of these onto the window
  offers to convert them too.
- **Pages come out the size they should be.** By default every source keeps
  its own geometry — a photograph keeps its physical size, a presentation
  keeps its widescreen slides, a spreadsheet keeps its printing setup. Or
  choose a paper size (Letter, Legal, Tabloid, A3, A4, A5) with an
  orientation and a margin, and every page is placed on it, centred, at its
  original proportions. Nothing is ever stretched, and form fields, links and
  bookmarks survive the change.
- **Scanned images become correctly sized pages.** A 300-dpi scan of a letter
  becomes a letter-sized page rather than a page two feet tall, because the
  image's own resolution is read and used.
- **Every page of a multi-page TIFF is now kept.** A fax or a departmental
  scanner writes several pages into one TIFF file, and until now everything
  after the first page was silently discarded — both here and in Batch OCR,
  where a three-page fax was recognised as one page and filed as complete.
  Every frame is now its own page, at its own size.
- **HEIC photos can be turned into PDFs.** The format phones use by default is
  now read directly, along with WebP, JPEG 2000 and AVIF.
- **Converted documents never reach the network.** A Word or HTML file can
  reference an image on a web server, and converting one used to fetch it —
  which let a document somebody sent you signal that you had opened it.
  Conversion is now sealed off from the network entirely, and macros are never
  run.
- **A converted document says when a font was missing.** If the original asks
  for a typeface this machine does not have, the substitution is named in the
  result rather than left to be discovered as a layout that moved.
- **A conversion that produces nothing now says so.** An empty or damaged
  Office file used to convert "successfully" into a meaningless one-page
  document. Every conversion is now checked by reading what was produced.

### Combining files
- **Combine Files takes everything Create PDF takes.** Until now it accepted
  PDFs and nothing else. Document ▸ Combine Files opens a list you build from
  PDFs, images, Word, Excel and PowerPoint documents, OpenDocument files, RTF,
  plain text, CSV, HTML, PostScript and blank pages — anything that is not
  already a PDF is converted as it goes in. Reorder by dragging or with the
  arrow buttons, and every row shows what it is, how it will be converted and
  how many pages it will contribute before you start. A file nothing can
  convert is marked as such instead of being quietly dropped, and dropping
  files onto the window while the list is open adds them to it.
- **Take only the pages you want from a PDF.** Each PDF in the list has a page
  box: leave it empty for the whole document, or write pages and ranges like
  `1-3,5`. Form fields, links and bookmarks on the pages you keep survive.
- **Combine into a new PDF, or into a document you already have open.** Adding
  to an open document puts the pages at its end as ordinary edits — you can
  move them, undo them, and save when you are ready — exactly as inserting
  pages has always worked.
- **Combine is now available with nothing open.** It used to be greyed out
  until a document was on screen, which is the one moment you are most likely
  to reach for it.

### Automating conversion
- **Convert a whole folder from the command line.** `spectrapdf create-pdf`
  takes any list of sources and writes one PDF, with the same page size,
  orientation, margin and image-resolution choices the dialog offers.
  `spectrapdf merge` now accepts non-PDF inputs too, converting them on the
  way in, and `spectrapdf batch <folder> -o <folder> create-pdf` converts every
  convertible file in a folder.
- **A saved action can start by creating the document.** "Create PDF from any
  file" is a step you can put at the start of an action — so a watched folder
  or a scheduled run can convert every Word file that lands in it and then
  compress, stamp or make the result searchable, all in one pass. Because it
  produces the document the rest of the action works on, it is only valid as
  the first step, and the buttons that would point such an action at an
  existing document say why they cannot.

## 1.0.19 — Vertical writing, scans that shrink, and seven languages

Text set in columns finishes the job it started. Mongolian — and the Todo,
Sibe and Manchu that share its alphabet — reads and edits the way it is
written: down the page, with the columns running left to right. And the
small horizontal blocks that live inside vertical text, the years and page
numbers and two-digit figures, are now part of the column they sit in
rather than something the column has to work around.

Scanned paper gets its own kind of compression. Instead of shrinking the
whole page photograph — which blurs the words along with everything else —
a scan is separated into the text, the ink colour and the paper behind it,
and each is stored the way it should be. The text keeps every bit of its
original resolution while the paper compresses hard. A 900 KB scan of a
typed page comes out at 55 KB, sharper than it went in.

Scanned files also simply display better: images written by fax machines,
scanners and archival tools used to come up blank in the viewer, and now
they draw.

And the interface now speaks Spanish, French, German, Italian, Portuguese,
Japanese and Chinese. Seven languages beside English, each one complete
before it was offered.

### Vertical text
- **Left-to-right columns.** Mongolian text sets in vertical columns that
  advance from left to right, the opposite of the East Asian convention.
  Those columns now list, read and reflow in the right order: the leftmost
  column is the start of the paragraph, and text that grows adds a new
  column to the right. The direction is read from the text itself, so
  documents in every other vertical script are untouched.
- **Editing Mongolian keeps it joined.** Mongolian letters change shape
  according to their neighbours, and a PDF stores the final shapes rather
  than the rules that produced them. An edited column is re-formed properly
  — using the document's own typeface wherever that typeface still carries
  what is needed, and a bundled Mongolian face otherwise — so edited text
  reads as words instead of a row of disconnected letters. Edited text also
  still extracts, searches and copies as the characters that were typed.
- **Numbers inside a column are editable in place.** A year or a page
  number set upright inside vertical text is part of that column's text
  now: it appears in the editor where it appears on the page, it moves with
  the text around it, and it stays exactly one column wide even when it
  gains digits. Previously the column reflowed around such a block without
  accounting for it, which could leave text overlapping it.
- **Upright punctuation.** Commas, brackets and quotation marks in a
  column take the upright forms the typeface provides for vertical
  setting, rather than the sideways ones.

### Scanned documents
- **A compression setting made for scans.** Compress now offers "Scanned
  document (MRC)". It finds the pages that are scans, separates each into
  a full-resolution stencil of the text, the colour of the ink and the
  paper behind it, and stores the three separately. The words stay at the
  scan's own resolution; the paper, which carries no detail worth keeping,
  compresses hard. On a typed page the result is roughly a sixteenth of the
  original size — smaller than the existing 150 dpi setting while keeping
  the text at 300 dpi.
- **Three promises, not three numbers.** Archival guarantees that no
  character can be substituted for another. Balanced is the everyday
  choice. Smallest goes furthest and says plainly that glyph shapes may
  change. There is also a PDF/A-safe option for anyone whose destination is
  an archival format.
- **Only scans are touched.** Every page is classified first: a page that
  is not a scanned image is left byte-for-byte alone, and a document with
  no scan in it says so instead of writing a pointless copy. Form fields,
  comments, links, bookmarks and an existing searchable text layer all
  come through untouched, because the page itself is edited rather than
  rebuilt.
- **A check that the words survived.** Optionally, each page is read
  before and after and compared. Any page whose text did not survive keeps
  its original scan, and the result says which pages and why. A compression
  setting is allowed to be lossy; it is not allowed to quietly destroy the
  text you came for.
- **Available wherever compression already was.** The Compress panel, a
  default in Preferences, a checkbox in Batch OCR that compresses a whole
  folder of scans after making them searchable, the command line, guided
  actions, watched folders and scheduled runs. In every batch form it runs
  after recognition, so the text layer is always read from the original
  scan.
- **Fax and scanner images display again.** Pages whose images use CCITT
  Group 4, JBIG2 or JPEG 2000 — what fax machines, document scanners and
  archival optimizers produce — rendered blank in the viewer. They now
  draw. The same fix restores CJK character encodings, the standard PDF
  typefaces and CMYK colour profiles, which were failing quietly for the
  same reason.
- **Large files no longer time out.** Compressing, converting or repairing
  a big document used a fixed five-minute limit regardless of its size, so
  a large scan could fail for no reason but its length. The limit now
  scales with the document, and the message says what it was.

### Language
- **Six more languages.** French, German, Italian, Brazilian Portuguese,
  Japanese and Simplified Chinese join Spanish. Each covers the whole
  interface — menus, toolbars, the tool dock and every panel in it,
  dialogs, the navigation pane, the on-page editing chrome, and the
  messages the app shows when it cannot do something. Nothing is
  half-translated: a language is offered only once its wording is
  complete, so the list in Settings ▸ Language is exactly the set that is
  finished.
- **The words are the ones the trade already uses.** Each language uses
  the terms its own design, print and PDF software uses — blending modes,
  redaction, prepress and page-box vocabulary included — rather than a
  literal rendering of the English.
- **Written the way each language is written.** Counts inflect where the
  language inflects them and stay put where it does not; Japanese and
  Chinese use full-width punctuation and their own counters; French keeps
  its non-breaking spaces before the punctuation that needs them.
- **Regional systems find their language.** A PC set to Portuguese or
  Chinese in any regional spelling opens in Portuguese or Chinese rather
  than falling back to English.

## 1.0.17 — Drafting tools, long documents, and an interface that speaks Spanish

Markup lands where you aim it: snapping to the drawing's own geometry,
rulers, a grid in real-world units, and guides you drag off the rulers.
Quantities get a proper home — count items into named groups, watch the
tallies add up, stamp a legend onto the sheet, and export the takeoff as a
spreadsheet. Symbols arrive as a searchable palette you drag from, with
your own sets loadable from a file. Long documents stop paying for their
length — a thousand-page file zooms and navigates like a short one.
Vertical text gains ground too: a column can be restyled, and text set
sideways inside one now reflows with it. And the whole interface speaks
Spanish.

### Drafting aids
- **Snapping.** While you measure, draw, place or move, the pointer
  snaps to the drawing's own geometry — endpoints, midpoints, centres,
  intersections and edges, plus the markup you have already placed.
  Each kind can be switched off on its own, and holding Alt suspends
  snapping for the rest of a gesture. Tab steps through the candidates
  under the cursor when several are in reach.
- **Straight lines on demand.** Holding Shift holds a segment to the
  nearest angle increment — 15° by default, and configurable — measured
  from where the segment started, so a run of vertices stays regular.
- **Rulers and guides.** Rulers along the top and left edges read in the
  drawing's own units and track the pointer. Drag a guide off a ruler
  onto the page, move it, or drag it off the page to remove it. Guides
  are a drafting aid: they are never written into the document.
- **A grid in real-world units.** Show a grid spaced in paper units or —
  the useful one — in real-world units through the drawing scale, so a
  1 ft grid on a scaled sheet lands where a drafter expects. Showing the
  grid and snapping to it are separate switches, and the grid stops being
  drawn when it would be too fine to read while snapping keeps working.
- **Everything snaps to it.** Snapping applies wherever you place
  something, not only while measuring.

### Count and takeoff
- **Count items into named groups.** Pick a group, click each item on the
  sheet, and a numbered marker lands there. Clicking a marker again
  un-counts it. Each group has its own colour and symbol.
- **Recount a whole area at once.** Ctrl-drag a box over markers to move
  them into the armed group; they take that group's colour and symbol and
  are renumbered at its end.
- **Tallies that cannot go stale.** Counts are read from the marks
  themselves, per group and per page, so what the panel shows is always
  what is on the drawing.
- **Legends on the sheet.** Stamp a legend table onto the page — symbol,
  group and count per row, with a total.
- **Export the takeoff.** Write a CSV with one row per group per page and
  a totals row, from the app or from the command line.
- **The counts live in the file.** Markers are saved as ordinary
  annotations, so a drawing counted on one machine opens with its groups,
  colours, symbols and numbering intact anywhere else — and shows as a
  printable symbol in other viewers.

### Symbols
- **A symbol palette.** A searchable library of vector symbols, available
  both in the stamp picker and beside the count groups. Drag a symbol onto
  the page to place it, or click it to place with your next click.
- **General AEC symbols included.** Twenty everyday symbols ship with the
  app — door swing, window, receptacle, switch, lights, smoke detector,
  thermostat, exit sign, data outlet, junction box, floor drain, supply
  diffuser, return grille, sprinkler, valve, north arrow, detail bubble,
  elevation marker and fire extinguisher — alongside the counting markers.
- **Bring your own set.** Load a firm's standard symbols from a JSON file
  and export any set back out to share it. A file that is not a valid set
  is refused with the reason and the symbol at fault named, and nothing is
  half-imported.
- **Symbols are vectors, and they travel.** A placed symbol prints crisply
  at any size, and it carries its own artwork inside the document — so a
  drawing marked up with your firm's set opens correctly on a machine that
  has never seen it.
- **Placed symbols behave like markup.** They snap where you drop them,
  take the colour you are working in, resize keeping their shape, and
  move, group and delete like any other annotation.

### Language
- **Spanish.** The whole interface is translated — menus, toolbars, the
  tool dock and every panel in it, dialogs, the navigation pane, the
  on-page editing chrome, and the messages the app shows when it cannot
  do something. Nothing is half-translated: a language is offered only
  once its wording is complete.
- **Settings ▸ Language.** Choose System default or a language outright.
  The app follows Windows by default, and remembers your choice.
- **It switches live.** Pick a language and the interface changes
  immediately — no restart, nothing to reopen, and the document you are
  working on is untouched.
- **Numbers, dates, and plurals follow the language.** Counts, sizes, and
  timestamps are written the way the chosen language writes them, rather
  than translated word by word.
- **Recognition languages read naturally.** The OCR language list is
  shown in your interface language, using the names Windows itself uses.
- **The interface announces its language.** Assistive technology is told
  which language the interface is in, so it reads Spanish text with
  Spanish pronunciation.

### Long documents
- **Full zoom at any length.** Actual Size and Fit Width now mean what
  they say however many pages a document has. A long file used to be
  quietly capped to a smaller zoom than you asked for; it no longer is.
- **Page navigation stays exact.** Jumping to a page deep in a very long
  document lands on that page and holds there, and scrolling to the end
  reports the last page — the same at six hundred pages as at six.

### Vertical text
- **Vertical paragraphs restyle.** A column of vertical text takes a font
  family, bold and italic like any other paragraph, including a vertical
  face installed on your machine. What a vertical column genuinely cannot
  take is now stated as the absence it is, rather than refused with a
  reason that had stopped being true.
- **A face with no vertical metrics is refused by name.** Choosing a font
  that cannot set text down the page says so — and says which of the two
  reasons applies — instead of laying horizontal letterforms into a
  vertical column.
- **Sideways text joins the column.** Text turned a quarter turn — the way
  a date or a Latin word sits inside a Japanese column — now belongs to
  the paragraph it is part of and reflows with it. All four quarter turns
  edit as paragraphs, whether or not a column is involved, and a
  superscript on rotated text stays a superscript.
- **An upright block inside a column refuses by name.** A horizontal block
  set inside a vertical column is not reflowed, and says so, rather than
  moving the text around it and leaving the block behind.

### Fixes
- **Deleting several images at once after an undo.** Selecting a group of
  images and deleting them could silently do nothing once an earlier edit
  had been undone. The selection now follows the document as it changes,
  and an edit that can no longer find its page says so on screen instead
  of doing nothing.
- **Switching themes keeps the right accent.** Swapping between light,
  dark and high contrast applies the theme and its accent colour as one
  step, so a slower answer can no longer overwrite a newer one and leave a
  mismatched highlight behind.
- **Accent colour reads properly in light mode.** Accent-coloured text and
  focus outlines are worked out per theme, so they meet the contrast
  standard on a light background as well as a dark one — and under high
  contrast the accent is held to a readable minimum whatever colour
  Windows supplies.
- **Scheduled runs on a non-English Windows.** Whether a scheduled run is
  enabled is read from the task itself rather than from the status text
  Windows translates, so the Enable/Disable button is right in any Windows
  language.

## 1.0.16 — Deeper image, vector, and paragraph editing

Images gain skew, multi-select groups, blend modes, and gradient fades —
and SVG artwork now places as real vector content. Vector editing reaches
paths and gradients it used to refuse, at any nesting depth. Text editing
learns finer Japanese line breaking, free-angle authoring, and paragraphs
that flow between a page and its embedded drawings edit as one.

### Images
- **Skew.** Edge handles shear a placed image; rotation and resize compose
  with it naturally.
- **Multi-select.** Shift/Ctrl-click builds a group on a page — move,
  scale, rotate, align, distribute, or delete the whole group as one
  operation and one undo step.
- **Placement respects proportions.** Replacing an image fits the new one
  inside the old frame instead of stretching it; adding an image contains
  it in the box you drag, and a bare click places it at natural size.
- **Blend modes and fades.** Each image takes any of the sixteen standard
  blend modes, and a draggable linear or radial fade dissolves an image
  into the page. Both survive later moves and re-edits.
- **SVG places as vectors.** Vector artwork drops onto a page as true
  vector content — it scales cleanly at any zoom and moves, transforms,
  groups, and deletes exactly like an image placement. Files using
  features outside the supported set are refused with a stated reason
  rather than drawn wrong.

### Vector objects
- **Tight selection boxes on curves.** A curve's selection box now hugs
  the drawn shape, not its control points — even under rotation.
- **Busier paths are editable.** Paths whose producers interleaved colour
  and transform changes mid-path — previously refused — now move and
  restyle exactly, with downstream content proven unmoved.
- **Any nesting depth.** Vector objects inside forms within forms edit at
  any depth; a form stamped elsewhere on the page is never disturbed.
- **Gradient paints are objects.** Gradient fills list, move, and delete
  like any other vector object, and deleting one removes its definition
  from the file instead of leaving it embedded.

### Text
- **Finer Japanese line breaking.** Opening brackets no longer end a line,
  small kana and prolonged-sound marks no longer start one, and leader
  runs stay together — the fuller set of kinsoku rules.
- **Text at any angle.** New text boxes take any rotation, not just
  quarter turns — the box turns about its own center and the text lays
  out inside it unchanged.
- **Validation follows the reflow.** The paragraph editor now checks each
  character against the font of the span it will actually land in after
  the edit, so characters near a style boundary stop being refused
  spuriously. Genuinely unwritable characters still refuse by name.
- **Paragraphs cross drawing boundaries.** A paragraph whose lines are
  split between the page and an embedded drawing — or between two
  drawings — now groups and edits as a single paragraph, with each part
  written back where it lives. The evidence bar is strict, so unrelated
  blocks that merely line up stay separate; a drawing reused elsewhere on
  the page keeps its other appearances untouched.

## 1.0.15 — Paragraphs take shape, styling comes along

Paragraph editing grows real geometry — resize a paragraph's box by
dragging, choose the gap when you split, merge in either direction without
losing your edits — and pasted text now keeps its styling. Under it all,
every screen of the app now holds an accessibility bar that is checked by
machine on every test run, and the whole interface follows one accent
colour.

### Editing
- **Paragraph boxes resize by dragging.** Grab either edge of the paragraph
  editor and the text rewraps to the new width — first-line indents and
  alignment behave, and a width no word can fit into is refused rather than
  overflowed. Works on rotated pages and vertical text too.
- **The split gap is yours.** Splitting a paragraph (Enter inside the text)
  now takes an adjustable gap — drag or type it in the editor — instead of
  a fixed distance. Every allowed gap still reads back as two paragraphs.
- **Merging works in both directions, and keeps your edits.** Backspace at
  the start joins with the paragraph above, Delete at the end pulls the next
  one in — and if you had already edited the text, the edit rides along in
  the same single undo step instead of being refused.
- **Restyle while you merge.** Size, colour, and font choices made in the
  editor apply to the merged result as part of the same operation.
- **Paste keeps its styling.** Text copied from a web page or a word
  processor pastes with its bold, italics, font class, size, and colour —
  expressed in the document's own terms. What can't be represented
  faithfully arrives as plain text rather than something almost right.

### Accessibility & appearance
- **Every surface is audited, on every test run.** An accessibility audit
  (WCAG 2.1 AA) now sweeps every tool panel, dialog, menu, and preference
  page in all three themes as part of the test battery, alongside a
  keyboard-operability suite — Tab reaches every region, menus work from
  the keyboard, and no dialog traps you.
- **One accent colour, everywhere.** Your Windows accent now colours every
  active control, focus ring, link, and slider in every theme — previously
  some screens mixed the system accent with a second, built-in one. Text on
  accent-coloured buttons picks black or white by measured contrast, so
  every accent stays readable, hover included.
- **Quieter status colours in the dark theme.** The greens and ambers used
  for results and warnings are softened — they point at things now instead
  of being the brightest thing on screen. Disabled buttons drop their
  colour entirely.
- **Light and high-contrast themes are complete.** The status bar,
  operations strip, home cards, tool dock, and measurement controls no
  longer keep dark styling in a light app; the high-contrast theme's badge
  colours and title bars are corrected throughout. A theme-consistency
  audit now runs with the test battery so this class of gap stays closed.

### Scheduling, printing, and building
- **Scheduled runs are proven on a fresh machine.** Creating a schedule's
  task folder is now guaranteed rather than assumed, and every build runs a
  live registration round-trip on a machine that has never held one.
- **The stalled-printer fix has a live test.** A client that connects to
  the virtual printer and goes silent is dropped on its own, without
  blocking other jobs — now proven with real connections on every test run.
- **Local builds work out of the box.** `npm run package:unsigned` produces
  the full installer with no signing key; the README documents both build
  paths. The plain-window fallback (remote desktop, transparency off) is
  exercised live by the test battery as well.
- **Documentation matches the product.** The settings screen, README,
  contributor guide, and licence notes were corrected where they described
  retired components or overstated what publishing runs.

## 1.0.14 — Every licence in the box, every print accounted for

An outside review of the whole codebase, worked to zero. Two printing
faults that could quietly lose a document are gone, the notices for every
bundled component now travel with the app, and a release can no longer be
published without passing its tests.

### Printing
- **Two documents printed at the same moment stay two documents.** Jobs
  arriving within the same second could previously overwrite one another's
  work in progress — one would be converted twice and the other lost, with
  nothing reported. Each job now claims its own name before it starts.
- **A stuck print job no longer disables the printer.** One client that
  connected and never finished used to block every later print until the
  app was restarted. Jobs are now handled independently and a stalled one
  gives up on its own.

### Licensing
- **The complete third-party notices ship with the OCR engine.** The
  bundled recognition engine links around fifty further libraries, and only
  its own licence was travelling with it. Every component is now named,
  with its licence and where its source lives, installed beside the engine
  — and the build refuses to produce an installer if anything shipped is
  missing its notice.
- **The notices live in the project, not on the internet.** They were
  collected once for the exact recognition engine build that ships and are
  stored with the source, so building the app needs no network for them and
  produces the same notices every time.
- **The recognition engine's upstream author list ships too**, alongside
  its licence.

### Building & releasing
- **A release can't be published without passing its tests.** Publishing
  now runs the test suites first — the application's unit suite, the engine
  suite, and the Windows-layer suite — and refuses to continue if any of
  them fail, or if the version being published disagrees with the version
  inside the app. (The full on-screen interface suite is run against the
  built app on a real desktop before each release is tagged; hosted build
  machines cannot drive the app's window, so that run is recorded per
  release in the project tracker rather than performed by the publish
  workflow.)
- **Build instructions actually work.** The setup steps in the README were
  missing several of the components a build needs, so following them left
  the build failing on a missing folder. All of them are listed now.

### Windows appearance
- **The window looks right when Windows isn't drawing effects.** With
  transparency effects switched off, or over a remote desktop session, the
  app now uses its plain window styling instead of styling meant for a
  translucent backdrop it isn't getting.

### Automation & folders
- **Scheduled runs no longer expose an account password.** The password for
  a scheduled task is handed straight to Windows instead of being passed on
  a command line where other programs on the machine could read it.
- **Watched folders check their folders more carefully.** A destination
  that differed from the watched folder only by capitalisation was treated
  as a separate folder, so processed files could land back in the intake
  and be processed again.

### Command line
- **Document JavaScript is scriptable.** `document-js-list` and
  `document-js-set` read and replace a document's JavaScript, so every
  whole-file operation in the app now has a command-line equivalent.

## 1.0.12 — Accents that sit right, crops you can draw

Text with accents and ligatures now sets the way its typeface intends,
vertical Chinese, Japanese and Korean text restyles, right-to-left edits
keep the document's own typeface, and cropping is a rectangle you drag.

### Text
- **Accents land on their letters.** Text with combining accent marks now
  composes properly instead of leaving the accent stranded beside its
  letter — when you edit a paragraph, add a text box, stamp a watermark or
  fill in a form field.
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
