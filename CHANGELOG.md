# Changelog

## 1.2.0

*Released 2026-09-03*

Maintenance Release: Various Bug Fixes

## 1.1.20

*Released 2026-08-31*

### Fixes
- Various bug fixes.

## 1.1.19

*Released 2026-08-29*

### Protected Documents
- **Compress/Grayscale/Rebuild on encrypted PDFs** — work again; operation runs first and asks only when protection is actually in the way. Per-document consent dialog states the output is an unprotected copy (no password, no permission restrictions, source unchanged), Cancel focused; result line marks the output unprotected
- **Still refused** — owner-password-held permissions and certificate-recipient encryption (no password to supply, no recipient list to reauthor); watched folders, scheduled runs and batch (nobody present to consent)
- **MRC preset bypass fixed** — the MRC quality preset ran compression before the protection check, silently returning an unprotected file; the check now precedes both compression paths

### Crop Editing
- **Crop rectangle handles** — eight resize handles like other resizable objects; Alt suspends snapping, Shift holds aspect, Escape abandons the drag; works on rotated pages; nothing applies until committed from Page Boxes

### Localization
- **Pluralized counts** — Scan & Enhance measurement/result lines use each language's plural grammar instead of "page(s)": pages to straighten/whiten/turn upright, specks removed, pages enhanced, uncertain/untreated orientation cases; dual/few/many forms carry the governed case, in all 28 shipped languages
- **Table review cell count** — shape line now says "non-empty" (the number counts only cells with text, not rows × columns)

### Guided Actions
- **Input placeholders** — ten empty inputs across Watermark, Search & Redact, Prepare Forms, Header & Footer and both export page ranges show example values; literal accepted values (pattern names, field types, page tokens) stay verbatim in every language
- **Inline step validation** — a step that cannot run (Watermark with no text/image/PDF or two of them set; Header & Footer with empty text) says so while configuring, using the same condition Save enforces; does not block editing

### Fixes
- **"Turn the page when at least"** — now "Turn the page when confidence is at least" (the value is the orientation detector's score)
- **Watermark "Direction"** — renamed "Text direction"; sets the text axis, independent of the Angle field
- **Paragraph editor resize corner** — drawn as part of the edit box instead of the browser's grey hatch

## 1.1.18

*Released 2026-08-28*

### Protected Documents
- **Encryption preserved through whole-file rewrites** — repair, recover, rotate, merge, split and imposition keep the source's encryption, cipher and permission bits; previously they wrote a decrypted copy with print/copy/modify permissions dropped
- **Refusals where protection cannot carry** — owner-password-held permissions (open with the password or decrypt first), certificate-recipient encryption (recipient list cannot be reauthored), and combining documents with differing protection (one output can carry only one)
- **Compress/Grayscale/Rebuild** — refuse on encrypted documents rather than returning them unprotected. PDF/A conversion still drops encryption (the standard forbids it) and reports the drop

### Archival Conformance
- **PDF/A-1 preserved through Repair/Recover/Optimize** — part-1 files are written without object streams and without the cross-reference stream/version bump they force; parts 2–4 keep the requested layout. On a 2,907-file corpus: 866 conformance regressions reduced to none, 45 additional files left valid
- **Object-stream layout preserved** — Repair and Recover keep a document's own layout instead of imposing one
- **Signed-document rewrites** — repairing/recovering removes signatures the rewrite would invalidate and reports how many (a rewritten file cannot satisfy a signature's byte range); documents whose signatures must survive editing still take the append-only path

### Interface
- **Menus and dropdowns themed** — chevron positioned correctly at every size and in right-to-left layouts; overlong values ellipsize instead of truncating mid-word
- **Colour swatches** — one shared boundary across highlight palettes, comment colours, ink chips, object inspector, paragraph editor colour well; visible in every theme, selection indicated
- **Contrast floor** — primary buttons take one accent treatment product-wide; signature pane detail lines legible; Read Out Loud's five transport controls one matched set (two rendered as coloured emoji plates before)
- **Measurement tool default colour** — meets the contrast floor on white, same hue; identical on screen, in preview and in the written mark; user-picked colours unchanged
- **Measurements as dimensions** — end ticks plus value chip on the line; two measurements on one page no longer ambiguous
- **Search-term highlighting** — matched term highlighted in toolbar search, Search panel and Search & Redact
- **Size columns** — one unit and precision per column, chosen from the column's values; a 70-byte reclaim no longer rounds to zero
- **Smaller fixes** — Export region name no longer overprints the table's first cell; field-action rows fit their panel; page box resets to the document's page label, not "1"; Batch OCR header shows a dismiss glyph instead of a second Close; "Invisible" reads as the width value; Details buttons aligned; Edit Text/Snapshot/Export get their own icons

### Ghostscript
- **Missing-Ghostscript launch notice** — shown once at launch on the primary window with an offer to open Settings ▸ Engine; Cancel dismisses, "Don't ask again" persists, a Settings ▸ Engine checkbox re-enables. Never shown when a path is configured. Per-feature notices unchanged

### Under the Hood
- **Deterministic signed commits** — committing a signed document twice from the same input produces identical bytes; document creation/modification dates travel instead of the run clock
- **Engine refusal messages** — translated in every shipped language
- **README screenshots** — re-shot from the current interface (workbench pane, second window, unified search, Read Out Loud, Batch OCR, Create PDF, web capture, object inspector)

## 1.1.17

*Released 2026-08-28*

### Error Reporting
- **Failed opens surfaced** — one message naming the file and reason, aggregated across multi-file drops; previously a failed open did nothing
- **Undisplayable documents surfaced** — message in the canvas instead of a healthy-looking tab over blank pages; panels that can still read the document keep working; clears if display later succeeds

### Scanner Tester
- **Page-order steps** — two guided steps verify feeder page order using three hand-numbered sheets (duplex and simplex variants, one back deliberately blank), read back page by page; report names the fault class: reversed backs, dropped blanks, one side per sheet, reversed batch, or dropped pages
- **Paper jam handling** — cleanly scanned sheets kept and offered as a partial document with the jam named; a torn page is discarded, never assembled; a scanner that disappears entirely still discards everything

## 1.1.16

*Released 2026-08-27*

### Search
- **Ctrl+L universal search** — focuses the search box from anywhere; finds document text and tools; Escape returns to previous focus
- **Usage-weighted ranking** — recently and frequently used tools rank higher within equally good matches

### Scanner Tester
- **`spectrapdf scan-test`** — guided hardware checklist covering feeder, duplex, network and failure-mode scenarios; writes a report of device details, settings and page measurements only — scans and document content never leave the machine unless explicitly attached. Tester guide at `docs/TESTER-GUIDE-SCANNING.md`
- **Non-interactive runs** — unanswerable prompts recorded as skipped with the reason instead of blocking

### Under the Hood
- **Scanner backend seam** — namespaced device identifiers, preparing for additional acquisition stacks; saved scanner selections keep working

## 1.1.15

*Released 2026-08-26*

### Scanning
- **Create PDF from Scanner (flatbed)** — pick a device; resolution, color mode and paper size offered from the device's own capabilities; scan into a new or open document; enhance and OCR through existing scan tools. Available from the Scan dialog and the command line
- **Failure modes verified on hardware** — mid-scan device failure reported by name with nothing partial kept; working files clean up even after a crash; recovery after a power cycle needs no restart

### Not Yet Supported
- **Feeder (ADF), duplex, network discovery** — pending verification on hardware that has them; controls appear only for capabilities a device reports

### Organize
- **Animated page reordering** — pages travel visibly when dragged or rearranged; respects reduced-motion; instant for large rearrangements
- **Small-target drop refusal** — drops refused (reason shown on the drag ghost) when the target renders too small at current zoom to be deliberate; space before first and after last document always available

### Fixes
- **Scan memory corruption** — ownership error in the device property handshake corrupted memory on every acquisition; now stable
- **Zoomed-out import message** — states what was actually done instead of an outcome that didn't happen

## 1.1.14

*Released 2026-08-26*

### Annotation
- **Freehand highlighter** — drag to mark any part of a page, including scans with no text layer; translucent marker stroke blends with the page, renders in every viewer; strokes are ordinary annotations (erasable, movable, undoable, preserved on save)
- **Text selection on scans** — first selection gesture recognizes the page's words locally, in memory; document never modified, nothing leaves the machine; result is a standard text highlight. Preference (on by default) disables it; writing a text layer into the file remains the explicit Scan & OCR feature. Poorly recognizing pages fall back to the freehand marker
- **Tool lock** — locked, a tool stays armed after each placement; unlocked, it places once and disarms

### Signing
- **Remote signing (Cloud Signature Consortium API)** — configure a provider, sign in via browser, pick a credential, sign; private key never leaves the service, app never sees a PIN or password. Works with visible stamps, field fill, certification, timestamping, long-term validation; returned signatures verified against the credential's certificate before writing
- **Platform root-trust snapshot** — additional offline trust source; withdrawn/restricted authorities excluded, per-purpose restrictions enforced (a timestamp-only authority cannot vouch for a signer). Off by default, additive, verified against the program's signed list

### Recognition
- **Recognition language** — text recognition for selection follows the document's declared language or a Settings choice instead of assuming English; Chinese region codes resolve to the correct script; ambiguous declarations fall back rather than guess

### Conformance
- **Results read from the file** — conversion and preflight results state what the saved file declares, read back from it, not what was requested; reports that do not verify a standard's full requirements say so by name
- **Issuance-date restrictions enforced** — a certificate issued after its authority's published cutoff is refused with both dates stated, on signer and timestamp chains

### Fixes
- **Imported ink strokes** — no longer thinned to 2-point on save; width and translucency survive import and save
- **Wide-nib clipping** — ink appearances fit fully inside their bounds in the saved file
- **Trust-bundle line endings** — exempt from checkout translation; fresh installs verify byte-for-byte against the manifest
- **Launch flash** — windows appear only after content paints, over a solid theme ground; automation-driven sizing can no longer misplace content
- **Paragraph editor toolbar** — opaque ground (text no longer bleeds through); controls wrap on narrow paragraphs

## 1.1.13

*Released 2026-08-26*

### XML Forms (XFA)
- **Static XFA fill and save** — values written into both the standard fields and the form's XML data, as the standard requires; saved documents read the same in every viewer
- **XML-only values display and print** — fixes forms filled by applications that wrote only the XML side (previously shown blank)
- **XFA layer preserved** — filling no longer strips it; all form packets byte-for-byte apart from changed values; signed documents keep valid signatures via incremental save
- **Dynamic XFA** — indicated and opened read-only; filling and field editing refused by name rather than producing a wrong result. Forms panel states static vs dynamic and reports unexecuted form-authored calculations
- **Field authoring refused on XFA** — refused by name; previously the editing tool silently discarded the XML form layer

## 1.1.12

*Released 2026-08-25*

### Form Field Scripts
- **Script execution** — form-authored JavaScript (calculations, validations, formatting) can now run. New preference "Run field scripts" (off by default); with it off the Forms panel keeps listing scripts read-only, unchanged
- **Sandbox** — isolated interpreter with no network, no file system, nothing outside the form: read/write field values, react to typing and focus, format and validate, show the form's own alerts, call the document's helper functions; anything else does nothing and is reported by name in the Forms panel
- **Hang and error handling** — a hung script is stopped after a short deadline and reported by name; the app stays responsive and the rest of the form works; errors listed per field and trigger
- **Ordinary fill path** — script-computed values shown live and saved with existing protections intact: signed-document rules, locked fields, undo behave as for typed values
- **Enterprise policy** — a policy key disables field scripts machine-wide, outranking the preference; the settings control says so
- **Automation** — command-line and automated runs never execute scripts

### Fixes
- **Fixed-text calculations** — assignments of literal text (an amount, "N/A") no longer lost; bodies resembling field-name arithmetic route to the interpreter unless every referenced name is a real field

## 1.1.11

*Released 2026-08-25*

### Form Submission
- **Submit buttons transmit** — consent dialog shows the full destination address and exact data before anything sends; one explicit click sends, Cancel sends nothing; only the field values the form's submit action selects are transmitted
- **Reply handling** — returned form data offered as an import, a returned PDF opens as a document, anything else offered as a saved file; nothing received is executed
- **Transport safety** — unencrypted destinations called out; cross-site redirects abort with both addresses named; no cookies, sign-in or stored credentials sent; no answer remembered
- **Non-web destinations** (e.g. mailto:) — refused by name, submission file offered for manual sending
- **Automation** — command-line and automated runs never transmit; they build the file and state the destination

### Open from Web Address
- **File ▸ Open from web address** — downloads a typed/pasted URL and opens it like any file; saving always asks where, never silently overwrites
- **Recents and drags** — web recents reopen the dialog pre-filled rather than re-downloading; browser-dragged URLs likewise
- **No document-triggered fetches** — document links open in the browser; remote content referenced by a document is never fetched automatically

## 1.1.10

*Released 2026-08-25*

### Print Production
- **Processing steps** — layers declared as processing steps (cutting, creasing, varnish, white, etc.) recognized and labeled in the Layers panel; unrecognized or malformed declarations called out
- **Output Preview exclusion** — processing-steps content excluded by default from composite, plates and total ink, with excluded inks named; toggle to show
- **Preflight check** — declared steps reported; profiles can require declarations or flag steps set to print
- **Corpus verification** — behavior verified against an industry-published processing-steps test suite

### Accessibility Checker
- **33 → 56 checks** — each sourced to the accessibility standard's clauses: role mapping, Unicode mapping verified against embedded fonts' own tables, list numbering/structure, heading conventions, font embedding and encoding, optional-content configuration, embedded-file names, media clips, reference XObjects, TrapNet, dynamic XFA detection
- **Undecidable judgements** — artifact-vs-content, semantic appropriateness, reading order reported for review with evidence instead of guessed
- **New automatic fixes** — clearing a stale Suspects flag; completing embedded-file names

### Fixes
- **Layer visibility through page extraction** — soft proofing and print-production staging no longer un-hide hidden layers

## 1.1.9

*Released 2026-08-24*

### Signed Documents
- **Rotate / page boxes** — keep approval signatures intact, annotations proven to stay in place
- **Remove/reorder/insert pages** — also preserve approval signatures; certified documents still refuse forbidden changes, with a clear choice before anything is written

### Print Production
- **Conformance corpus** — rendering, separations, spot plates, overprint and output intents verified against an industry-published test suite with documented expected results
- **Separations cache self-verifies** — a cached set missing a plate file was served as complete (Output Preview could show a spot page without its plates and understate total ink); now re-renders
- **Overprint toggle** — flipping overprint simulation never updated the screen; stale preview after any overprint/resolution/proofing change fixed

### Accessibility Checker
- **Clause-sourced checks** — every check sourced to the standard; nine corrected against its text. Notable: title-not-set-to-display now fails rather than warns; a title only in the document information dictionary no longer counts; links need a real alternate description (visible link text alone no longer passes)
- **Form structure** — fields must be inside a Form structure element, not merely in the structure tree
- **Fixed** — table header Scope check could never fail; undecodable text was wrongly reported not applicable
- **Corpus-verified** — against a published accessible-PDF technique corpus: every conforming example passes clean, covered failure examples correctly reported

### Conversion
- **PDF/A conversion reports lost conformance** — a declared conformance with another standard (e.g. PDF/UA) that does not survive is reported instead of silently dropped

## 1.1.8

*Released 2026-08-24*

### Windows Certificate Store Signing
- **Store-based signing** — no PFX export; private key never leaves Windows; hardware-backed keys prompt through Windows' own PIN dialog
- **Certificate picker** — eligible personal and machine-store certificates with subject, issuer, expiry and hardware-key labeling; remembers the last-used certificate
- **Full feature parity** — visible stamps, signature-field fill, PAdES, timestamping, long-term validation, certification, field locks
- **CLI** — `sign --store-cert`, `--store-machine`, `--list-store-certs`

### Signature Stamps
- **Appearance options** — logo or background image; text lines (name, date, reason, location, custom); text-beside or text-over layouts
- **Personal signature as stamp face** — drawn as vector artwork
- **Live preview** — rendered by the same code that draws the real stamp
- **CLI** — `--stamp-image`, `--stamp-fields`, `--stamp-layout`, `--stamp-label`

### Personal Signatures
- **Signature manager** — create by drawing, typing (three bundled handwriting styles), or importing a photo with optional white-background removal
- **Placement** — drawn signatures land as vector ink, typed signatures embed their font; integrate with undo and signed-document handling
- **Local only** — stored on this computer, written into a document only when explicitly placed

### Portable Version
- **Portable zip** — alongside the installer; extract and run, no installation; settings, dictionaries, session state and logs live beside the app
- **First run** — presents the bundled color-profile license; declining leaves the app working with profile-dependent features disabled by name
- **Missing WebView2** — reported with a link to the official download instead of failing silently
- **"Start with Windows"** — repairs its registry entry when the app has been moved

### Fixes
- **Packaged-app assets** — bundled handwriting fonts and imported signature images load; app-produced previews and thumbnails render
- **Stamp preview** — no longer reports an internal error
- **Custom image stamps** — import from any folder
- **Store-certificate signing** — no spurious password prompt

## 1.1.7

*Released 2026-08-19*

### Ghostscript
- **Optional, separately installed** — no copy ships in the installer; discovered via Windows, `PATH`, or a path chosen in Settings
- **Version gate** — 10.0 or newer accepted after a real capability check; newer maintenance releases not pinned out
- **Installer** — interactive install can open the official download page; silent and passive installs never download or install it
- **Feature gating** — Ghostscript-requiring features name what is missing and stay disabled until a usable copy is configured; features with a non-Ghostscript path stay available

### Colour and Images
- **22 bundled ICC profiles** — for CMYK conversion, PDF/X output, soft proofing
- **HEIF** — decode-only runtime, existing image output preserved
- **OCR runtime** — unused JBIG codec removed

### Distribution
- **Color-profile EULA** — interactive install obtains acceptance; silent/passive deployment requires `/acceptEULA`
- **Third-party notices** — match installer contents, available offline
- **HEIF source archives** — exact source for bundled decoder libraries ships with the release, listed in its checksum file
- **Clean-build hardening** — GitHub builds no longer depend on a developer's ignored Ghostscript resource folder; clean verification stages every shipped engine resource and fails if any engine test is skipped
- **LibreOffice runtime** — release builds always assemble the pinned 26.2.5 runtime regardless of what the build machine has installed
- **Office conversion fonts** — uses bundled app fonts on clean machines instead of Windows-installed fonts; OpenDocument conversion no longer reports unused CJK/complex-script style defaults as missing fonts
- **PKCS#11 verification** — clean verification exercises token signing through a pinned test-only software token instead of skipping

## 1.1.6

*Released 2026-08-18*

### Signed Documents
- **Rotate/crop** — keeps signatures intact
- **Add/remove/reorder pages** — keeps approval signatures
- **Certification-forbidden edits** — refused before anything is written
- **Rewrite consent** — every operation that rewrites a signed document asks first; when signatures cannot be kept, the commit says so instead of proceeding silently
- **Form removal** — can no longer slip through a signature-preserving save

### Windows and Exit
- **Exit recording** — every window recorded only after each has answered; a window that cannot answer stops the exit rather than being closed over; a failed session write leaves windows open
- **Tab state** — reorders made in any window survive an exit from another; a tab moved between windows arrives with its latest edits

### Conversion
- **Form field appearances** — single converted appearance through colour and grayscale conversion; fields without a stored appearance no longer leave old values printed on the page
- **Gradients** — inside stamps and annotations survive CMYK conversion
- **Field fill** — no longer erases background and border; non-Latin values convert correctly

### Reliability
- **In-place saves** — recognize two names for the same file in every case
- **Interrupted saves** — never leave a stray copy beside the document

## 1.1.5

*Released 2026-08-18*

### Spell Checking
- **Pointed Hebrew** — checks against the word's letters, matching the dictionary
- **Pointed Arabic/Hebrew suggestions** — work instead of returning nothing

### Tabs
- **Reordering** — drag within a window; a tab dropped into another window lands where the caret shows; session restore reopens tabs in arranged order

### Print Production
- **Spot-colour gradients** — survive CMYK conversion instead of flattening to process plates
- **PDF/X refusals** — conversion names plates its target level cannot carry; a destination profile not describing CMYK output refused by name
- **Bundled profile** — choosing it no longer deletes a matching file beside the output
- **Spot-ink conversion** — reports gradients that still print the ink
- **Flattener** — no longer errors after a successful flatten
- **Preflight fixes** — partial fixes say exactly what they left; the too-many-spot-inks fix works instead of failing

### Reliability
- **In-place save crash** — can no longer destroy the document
- **Portfolios** — combining PDFs into a portfolio works again
- **Table headers** — promoting a header row no longer fails
- **Deterministic font embedding** — identical on every run

## 1.1.4

*Released 2026-08-17*

### Windows and Session Restore
- **Exit records every window** — not one; cancelling an exit returns session tracking to live
- **Tab drag safety** — no transfer into a just-closed window; a drop back on its own strip no longer saves or clears undo; drags respond only to the originating pointer; a moved window no longer offsets drop targets

### Form Fields
- **Vertical/rotated fields** — clearing a vertical field or dropdown redraws; rotated text fields, dropdowns and option lists draw rotated; each option label resolves its own text direction; flattening a rotated field stamps it rotated

### Spelling
- **Decomposed accents** — no longer split into fragments; pointed Arabic checks as whole words

### Accessibility Checker
- **Ruby/Warichu** — checked for order and completeness, not membership alone

## 1.1.3

*Released 2026-08-17*

### Tabs Across Windows
- **Cross-window drag** — a tab drags into another window's strip; dropping on empty screen tears off into a new window; unsaved edits saved on move, never silently reverted; Escape cancels; menu-based moves are atomic

### Window Memory
- **Size/position restore** — every window restored on next launch; optional preference (off by default) reopens last session's windows and documents; a window from a missing monitor reopens centered on the primary

### Spell Checking
- **Korean** — ships (a reader defect had rejected the dictionary's own words); suggestions correct composed syllables
- **Finnish** — ships on a bundled morphology engine covering inflected and compound forms

### Accessibility Checker
- **Structure nesting check** — validates structure types nest where the standard allows; a list item wrapped in a grouping element no longer reported misplaced

### Form Fields
- **Vertical writing** — text, dropdown and option-list fields can be created vertical in four scripts; an option list the built-in font cannot draw is refused by name

### Fixes
- **Startup preference** — no longer erases sibling flags when toggled

## 1.1.2

*Released 2026-08-17*

### Conformance Corpus
- **Public corpus** — pinned fetch script assembles 2,940 conformance PDFs from two public archival test suites; a clause index binds 2,838 files to 203 clauses across eleven standard parts; a scoreboard records the product's per-file verdict for review

### Accessibility Checker
- **Over-firing fixed** — runs of spaces no longer reported as unmapped fonts; embedded character maps named instead of printing their contents; language checking honors structure-element and ancestor declarations, not only the document default; pages with readable text no longer reported image-only; uninterpretable encodings flagged for review instead of failed; empty text replacements honored as deliberate; hidden and zero-size annotations no longer require an accessible name; a form element's alternate text counts as its field's description; a label outside a list no longer reported as a misplaced list label

### Vertical Text
- **Watermarks** — text watermarks can be written vertically, from the panel or a guided action
- **Form fields** — a field declaring a vertical font fills down its column; values draw through the declared font instead of producing unreadable characters

## 1.1.1

*Released 2026-08-17*

### Checker Honesty
- **Unreadable inputs reported** — unreadable annotations no longer yield a clean accessibility result; the scripts check no longer reports script-free after a partial read; an empty structure tree reports as untagged; a table cell with an unreadable span is named instead of compared against a default

### Font Embedding
- **One embedding answer** — Preflight, the document checker and Properties share it; undeterminable embedding says so instead of reading as not embedded; Type 3 fonts judged by the glyph programs in their own dictionary; embedding rewrites only fonts proven to carry no program, never unreadable ones

### Font Survey
- **Coverage** — follows form XObjects, glyph procedures, appearance streams and form resources; font totals no longer undercount

### Fixes
- **Converted PostScript forms** — fields registered instead of left rendered and dead

## 1.1.0

*Released 2026-08-16*

### Output Preview
- **Press-profile proofing** — render through a named press profile: the document's own output intent when declared, a bundled press profile, or your own ICC file
- **Simulate Paper White / Black Ink** — paper tint instead of screen white; the press's actual black density; enabling paper white enables black ink (alone it changes nothing)
- **Honest read-back** — every control reads back what the engine used; a refused request cannot look applied; an unusable profile is named and the page stays unproofed
- **Compatibility** — plate toggles, ink density and the ink limit alarm keep working under a proof

### Point Inspection
- **Click-to-inspect** — click any point in Output Preview: object, colour space and ink values; ink values come from the plates, so overlapping objects report what actually prints
- **Details** — placed images report effective resolution at displayed size; stacked objects listed topmost first; bare paper says so, ink reading intact

### Comment Summaries
- **Export comments as a document** — comments alone, or pages with comments beside them; comment column beside, beneath, or on its own sheets; optional connector lines to marked locations
- **Filter and sort** — by author, type, state, page range or text; panel and document always agree on order
- **Threads and counts** — reply threads kept together, orphaned replies still listed; every summary ends with a count of included and excluded

### Multiple Windows
- **Second window** — a document moves to a new window with its tabs; a document open in one window is refused in another by name, with an offer to front the holding window
- **Isolation** — each window has its own tabs, undo history and view; closing a window closes only its documents; status bar shows when another window is using the engine

### Comment Interchange
- **Reply/group fidelity** — exports record reply vs group; a grouped comment no longer returns as a reply; replies match parents on the same page first, as the format intends
- **Loss reporting** — an uncarryable comment is reported, not silently dropped; one unreadable comment costs that comment, not the export; the panel says when an export carried fewer comments than the document holds

### Fixes
- **Cropped-page area bugs** — Output Preview measured the wrong area (ink coverage and the ink limit alarm with it); OCR placed its text layer at the wrong origin and size; recognition could cover hidden areas; visual comparison highlighted the wrong place; slide and image export exported the wrong area
- **Custom ICC profile selection** — failed for every file chosen
- **Standards conversion reporting** — PDF/A conversion now lists what it removed to meet the standard; PDF/A and PDF/X list exactly what changed; a PDF/X conversion can no longer claim a standard the converter abandoned; an unproducible conversion refuses and writes nothing
- **Accessibility checks on unreadable documents** — no passes for structure that could not be read; twenty-one checks say when they could not see the whole document; unreadable permissions no longer read as allowing screen readers
- **Document checker fonts** — unreadable fonts no longer counted as embedded; the hundred-font cap removed
- **Web capture** — closing the window mid-capture now cancels it; a capture no longer blocks work in another window
- **Joining scripts** — multi-line text no longer refuses to typeset
- **Bookmarks** — an empty outline no longer reports as having bookmarks

## 1.0.31

*Released 2026-08-15*

### Links
- **Draw-anywhere link creation** — drag a rectangle with the Links tool anywhere on a page (not only over selected text); the rectangle stays pending in the panel until a target is assigned, so a mis-drag costs only a redraw
- **Link targets** — page in this document (with view: full page, fit width, fit height, named rectangle, or current zoom), named destination declared by the document (picked from those it actually has), another file (with page number), or a URL
- **File-target handling** — a linked PDF opens in-app after confirmation; any other file type is named, never run; a link to a program is read and reported by name, and the app never writes one
- **Link appearance** — border width, style (solid/dashed/underline), and color; click effect (none/invert/outline/inset); default remains invisible
- **Editing existing links** — with the Links tool open, every link in the document is drawn on the page; click to open, retarget, restyle, or delete; the panel lists all links with targets and a Go To
- **Signed-document guard** — create/retarget/restyle/delete all share one signed-document confirmation
- **Unsupported borders** — a border style this app does not write is named rather than relabelled
- **URL auto-linking** — creating links from web addresses in text unchanged

### Signature Trust — EU Trusted Lists
- **Third trust source** — certificate authorities from the EU trusted lists; off by default like the other trust sources
- **Fully offline** — the list ships bundled in the app; nothing is downloaded, ever; verification works with no network
- **Panel disclosure** — shows the list's bundle date and European coverage; a list-vouched signature is identified by name, not just "trusted"
- **Status filtering** — only authorities currently recorded as granted count; withdrawn authorities anchor nothing; timestamp and signature authorities are kept separate
- **CLI** — the same option added for checking and signing

### Create PDF from Clipboard
- **File ▸ Create ▸ From Clipboard** — converts a copied picture, formatted text (tables/colors preserved), or plain text into a PDF
- **Image fidelity** — a copied picture keeps its own resolution (a screenshot becomes a page at its actual pixel size)
- **No network** — formatted text never fetches referenced images; only pictures carried in the copy are drawn
- **Combinable** — the pasted content joins the Create PDF list as an ordinary item; reorder, remove, combine with disk files

### Create PDF from Web Page
- **File ▸ Create ▸ From Web Page** — renders an address with the same engine a browser uses, in a visible capture window; nothing fetched in the background
- **Pre-load disclosure** — the dialog states the site to be contacted and the maximum pages before loading anything
- **Crawl depth** — capture one page or follow links one or two levels deep with a user-set page limit; a capture never leaves the starting site; hitting the limit is reported rather than looking complete
- **Layout options** — paper size, orientation, margin, page headers/footers, background graphics
- **Bookmarks** — each captured page becomes a bookmark named after its title
- **Scheme restriction** — only web and local addresses; anything else refused by name

### Vertical Text
- **Add Text direction** — horizontal or vertical (for column-written scripts); a vertical box reads down its height, columns fill across its width
- **Column direction from the script** — Japanese/Chinese run right-to-left, Mongolian left-to-right; not a setting; the card reports the chosen direction as you type
- **Round-trip** — a written column is read back the same way by the editor; vertical text uses the bundled vertical typeface; the box turns reading direction itself and is not additionally rotated
- **Inapplicable controls** — controls that cannot apply to a column say so instead of silently doing nothing
- **Horizontal-in-vertical** — a column can carry an upright horizontal block (year, page number) fitted to one column width, as vertical Japanese sets numbers
- **Ordinary text after** — searchable, restyleable, reflows in the paragraph editor

### Fixes
- **Space-free text wrapping** — text with no spaces (e.g. Japanese) wraps instead of running past its box

## 1.0.30

*Released 2026-08-15*

### Form Calculation
- **Calculations run** — fields with calculations compute live on the page as you type, before saving; a field with a display format shows the formatted value (thousands separators, currency, percentage, date) while the file stores the plain value other programs can read
- **Range validation** — a value outside a field's declared range is refused by name, with the required range
- **Calculated fields locked** — marked as calculated, not typeable, but still auto-filled
- **Missing calculation order** — a form with calculations but no run order reports that rather than leaving totals empty
- **Unsupported scripts** — a field carrying a script this app does not run is reported by name; its contents untouched, all other fields still calculate; no embedded script is ever executed
- **Signature-locked recalculation** — filling a field that would recalculate a signature-locked one warns first, naming the input and what it would change
- **CLI** — `forms --set` calculates identically

### Form Authoring
- **Display formats on placed fields** — number (chosen separators and currency symbol), percentage, date, time, postcode, telephone, or custom pattern; live sample in the picker (so `1,234.56` vs `1.234,56` reads as a choice, not two numbers)
- **Validation and defaults** — accepted-range constraint; default value restored by form reset
- **Calculations** — sum/product/average/min/max over ticked fields, or any arithmetic expression over field names; expressions checked as typed, unreadable ones refused before the field exists
- **Calculation order** — fields ordered so every calculation runs after the fields it reads, regardless of creation order; self-dependent calculations refused with the proving chain; references to nonexistent fields refused
- **Interoperable output** — standard form scripting; forms calculate identically in other viewers
- **Prepare Form ▸ Field properties** — format, range, and calculation editable on existing text and dropdown fields without recreating them
- **Detection fixes** — detected date fields now get a date format; placement card now offers the character limit and comb layout (both always accepted, never previously shown)

### Field Actions
- **Buttons act** — go to page (direct or named destination), reset form (honoring included/excluded field lists), show/hide fields (persisted in the document, undoable), import form data (FDF/XFDF detected by content, from a user-picked path — never one the document names; unknown field names reported, matching values still filled)
- **Submit** — builds the full submission (FDF, XFDF, web form data, or the document itself, as the button asks) and saves it to a file you choose; the intended destination is shown and copyable; the app sends nothing over the network
- **All gestures** — actions run on pointer in/out, mouse down/up, focus, and focus lost, not only click
- **Unperformed actions** — scripts, jumps into another document, and unrecognized actions are named rather than half-simulated; nothing changed by a named-only action
- **Authoring** — Prepare Form ▸ Field properties lists buttons and assigns any field an action (go to page, open link, reset, submit, show/hide fields, import data) on a chosen gesture
- **CLI** — `forms --reset`, `forms --import-data`, `forms --export-data` with `--data-format fdf|xfdf|html|pdf`; scoped by `--field` and `--exclude-fields`

### Script Disclosure
- **Declined-script list** — the forms panel lists every script the document carries that this app declines to run: field, trigger moment, readable script; the standing no-execution position is stated on the list
- **Declarative calls run** — standard formatting, checking, and calculation calls carry no code and do run

### Accessibility Checker
- **32 checks across seven areas** (up from six document-wide questions): Document, Page Content, Forms, Alternate Text, Tables, Lists, Headings — a document with undescribed figures and headerless tables no longer passes
- **Alternate Text checks** — missing figure descriptions, nested descriptions, descriptions attached to nothing, descriptions hiding an annotation's own words
- **Table checks** — rows outside a table, cells outside a row, uneven row widths, no header cells, headers without scope, missing summary
- **List/heading checks** — items outside a list, labels outside an item, skipped heading levels
- **Page content checks** — untagged text not declared decoration; untagged annotations, form fields, multimedia; pages with annotations but no tab order; fields with no description; fonts whose characters map to nothing readable
- **Color contrast measured** — against what is actually painted under each drawn line, using the published ratio with the large/bold-text threshold; photographic, gradient, or irregular backdrops report "cannot tell"
- **Not-applicable verdict** — a check with nothing to check reports not-applicable, leaves the passed count, and the summary states how many checks applied
- **Needs-review verdict** — reading order, scripts, timed responses, repetitive links, and unmeasurable contrast report "needs review" with items to look at instead of failing
- **Located findings** — every failure names its tag, page position, annotation, or field; an unreadable page is named, its dependent checks say so, and it is never counted clean
- **Auto-tagging body-text heuristic** — body size picked by volume of text set in it, so mixed title/body/page-number pages no longer promote body copy to headings; margin page numbers and running heads smaller than body text are marked decoration

### Accessibility Report
- **Grouped by area** — seven areas with passed/applicable counts; areas with findings open by default; each check shows a one-line purpose and its items with their own text
- **Click-through** — a finding navigates to it: tags open the Tags panel selected, page positions draw a box and scroll, fields/links/annotations open their editing panel
- **Show** — draws all of a check's page findings at once; toggles off with the same button; clears on document change
- **Export** — HTML or plain text, same verdicts/counts/findings; the HTML is self-contained; each row carries the check's short name beside its wording
- **No conformance claim** — the report states which of the 32 checks pass; it does not claim conformance because two checks cannot be machine-settled
- **Fully localized** — names, explanations, findings, and exports in all 28 languages

### Accessibility Repair
- **17 checks repairable from the report** — the fix control sits on the row; the other 15 route to the owning panel
- **12 zero-input repairs** — allow assistive-technology access on restricted files, tag untagged documents, show an existing title, derive bookmarks from headings, declare tab order, close skipped heading levels, promote a table's first row to column-scoped headers, clear nested/annotation-hiding descriptions, bind untagged annotations/fields/multimedia into the structure tree
- **5 single-value repairs** — document language and title, field description, figure alternate text, table summary; typed on the finding with the page in view; language picked from the 28 supported (by their own names) or typed as any language tag, with malformed tags refused and the reason given, leaving the document unchanged
- **Nothing invented** — no placeholder alternate text, no guessed language; a field's internal name is offered only as a suggestion; a check missing its value stays a finding
- **One undo step per fix; live re-check** — the report re-runs on landing, a repaired row turns green, Undo turns it back
- **Signed/certified documents** — repairing a signed document asks first; a no-changes certification is refused
- **CLI** — `accessibility --category <area>` runs one area; new `accessibility-fix` applies the zero-input repairs; value-requiring repairs deliberately have no headless form (a placeholder description is worse than none)

### Untagged Content Binding
- **Bind untagged text from the report** — you choose whether it is a paragraph or decoration, never the app; one action declares all of a page's remaining untagged text decoration (the usual case: running heads and page numbers)
- **Reading order preserved** — a newly tagged paragraph is placed where it is drawn, not appended
- **Two-way annotation binding** — structure points at the annotation and the annotation points back, for annotations, form fields, and multimedia
- **Reused graphics** — text drawn inside a reused graphic is refused by name (numbered inside that graphic, not on the page) rather than mis-tagged

### Preflight — Unreadable Content
- **"Could not be checked" verdict** — a check that could not read part of the document no longer reports an unearned pass; it names what it could not read, counted separately in the summary
- **Findings still findings** — RGB color found is reported found; a non-embedded font still fails regardless of what else was unreadable; unmeasurable strokes no longer report "no hairline strokes"
- **Flattener honesty** — the transparency flattener reports objects it cannot judge instead of treating them opaque; unreadable forms, forms declaring no bounds, forms nested past analysis depth, and unreadable graphics states are each named per page; such a document is refused rather than written — a flatten reporting success while live transparency survived is the one forbidden result
- **Preview parity** — the preview lists and highlights the same objects and reasons before anything runs
- **Output Preview caveats** — flags pages that may use inks it could not find; plate list and total-ink figures marked as covering only found plates; a color bar is refused outright rather than printed a patch short

### Preflight Profiles
- **37 checks across seven categories, measured against a profile** (up from five; a file with 360% total ink, a 7 dpi photograph, five spot inks, an overprinting white headline, no trim box, and a printing sticky note previously passed clean)
- **Nine shipped profiles** — sheetfed offset, heatset web, newsprint, digital printing, large format, PDF/X-1a, PDF/X-3, PDF/X-4, office; all thresholds are press figures
- **Check vs. profile** — the check decides clean/dirty; the profile decides failure vs. note, so the same document under two profiles gives two answers by design
- **Rule stated per row** — each check row states its measured rule (ink limit, resolution, hairline width), so a saved report stays readable without the profile
- **"Does not apply" verdict** — no-image documents skip image checks; profile-disabled checks say so; neither counts toward the passed tally
- **Total area coverage measured** — true per-pixel maximum, not estimated; pages beyond the profile's page budget are named unmeasured, never extrapolated; a missing measurement tool is reported by the check, not fatal to the report
- **Overprinting white detected** — overprint ink laying down nothing (a headline that vanishes on press); overprinting black (correct practice) not reported; overprint over unresolvable ink flagged for review
- **New checks** — PDF version, actual printing permission (not just "is it encrypted"), output intent, PDF/X claim, trapping declaration, embedded files, page size/count, trim/bleed boxes, spot ink names and count, device-independent color, min/max image resolution, image compression and color space, small type, multi-ink small black type, optional content, printing annotations, interactive form fields, title, document JavaScript, XMP packet
- **CLI** — `preflight --profile` and `preflight-profiles`

### Preflight Report and Custom Profiles
- **Category tree** — Document, Pages, Colour, Fonts, Images, Content, Metadata, each heading with passed/applicable counts
- **Click-through** — page findings drawn on the page; ink/font/setting findings open their panel; findings with neither say so instead of doing nothing
- **Unreadable parts listed separately** — never mistaken for passes
- **Export** — text or HTML, naming document, profile, and check time; includes every finding (including those the panel summarized as counts); footer states it is not a conformance certificate
- **Custom profiles** — duplicate any shipped profile, change thresholds, switch checks between failure and note, disable checks; editing a shipped profile saves a copy, preserving the press figures
- **Profile exchange** — export, import, delete; imports refused with the reason if not JSON, not a profile, missing an id, holding something else, or on an unreadable schema; an import that would replace a shipped profile is refused with instruction to rename
- **Verbatim names** — ink and font names reach the report exactly as the document spells them, in every language

### Preflight Repair
- **Twenty repairs, offered on the failing rows** — remove document JavaScript, embedded files, printing annotations; embed missing fonts; convert to CMYK or grayscale; convert spot inks to process or remap plates; downsample over-resolution images; thicken hairlines; flatten transparency; write a trim box; grow a bleed box; set the title; declare trapping; write the XMP packet; set the PDF version; convert to PDF/X or PDF/A; add printer marks
- **"Fix what this profile can"** — repairs every row at once in the one correct order (hairlines before flattening — a hairline inside a flattened region becomes unreachable pixels; printer marks after standard conversion — a conversion regenerates every object and pre-conversion marks could never be removed); the profile lists its repairs, the order is not up to it
- **One undo** — whether one row or all; the check re-runs after every repair so verdicts reflect the file as it now is
- **Font embedding refusals** — embeds only the face the document actually names; a face installed under a different name is refused by name; a face whose letter widths disagree with the document's declared widths is refused with both figures (embedding would reflow every line); embedding-forbidden licenses refused with the foundry's reason; partial success is partial (three of four installed embeds three, names the fourth)
- **Decisions are asked, never invented** — title, trapping state, bleed margin, and a spot ink's target plate are typed in; whether a file is trapped is a claim only a person may make
- **No dead buttons** — checks without a repair in the chosen profile route to the owning panel; no button whose only outcome is refusal
- **Fixed** — setting the PDF version now actually lowers it (asking a PDF 2.0 file for 1.7 previously reported success and left it at 2.0); converting a spot ink to process now removes the plate as well as its marks (the declared colorant previously kept appearing in plate lists); annotation removal can be narrowed to print-flagged annotations and to particular kinds
- **CLI** — `preflight-fix`

### Folder Preflight
- **Tools ▸ Preflight a Folder** — checks every PDF in a folder against one profile; check mode writes nothing to the source folder
- **Repair mode** — each document is copied, repaired with the profile's fixups, re-checked; reports state what the file is now; originals untouched unless replacement is requested
- **Reports per document** — text and HTML beside each output, plus a machine-readable data report
- **Intake management** — processed originals can be moved out so the next run skips them; unreadable documents reported by name without stopping the run; a failed repair leaves no half-processed file
- **Named settings** — save the whole configuration under a name for recurring sweeps
- **Guided actions** — a print profile can be a guided-action step (convert a folder of Office files, apply the house press rule, stamp — unattended)
- **CLI** — `preflight-sweep`

### Fixes
- **Guided-action export/import** — now works to any folder (previously only succeeded inside the app's own temporary folder)
- **Dependencies** — bundled and build-time dependencies updated, clearing GHSA-jmr9-qjv8-65gv in a test-only archive extractor

## 1.0.29

*Released 2026-08-10*

### One PDF per Folder
- **Tools ▸ One PDF per Folder** — turns a tree of scan folders into one PDF per folder; pages assembled in page-number order (`page2` before `page10`); folder `a/b` becomes `a/b.pdf` in the destination; originals never modified
- **Resilience** — an empty folder is skipped, not failed; an unreadable picture is named in the report and the rest of the folder still assembles
- **Automation** — available as a guided-action step (chainable, schedulable); CLI `create-pdf-folders`

### Batch OCR
- **Saved settings** — Batch OCR Folder saves every dialog setting (folders included) under a name; recall, rename, delete in place
- **Scheduled runs from saved sets** — a schedule seeded from a saved set keeps its own copy; later edits to the set leave the schedule alone
- **Schedule capabilities** — replace originals in place, compress scans, straighten before recognition
- **CLI** — `batch-ocr` gains `--enhance` and `--no-enhance-orientation`

### Guided Actions
- **Enhance Scans step** — all twelve settings; action files naming it now import instead of being refused as unknown

### Scanning
- **File ▸ Create PDF from Scanner…** — scan into a new document
- **Document ▸ Insert Pages ▸ From Scanner…** — scan into the open document as ordinary undoable page work
- **Scan & OCR entry point** — opens the scan dialog when nothing is open; offers scanning from its pane when something is
- **Device-driven controls** — resolutions, color modes, feeder/flatbed/duplex offered only as the scanner reports them; a control the device lacks is not shown; page count or "every page in the feeder"
- **Progress and review** — per-page progress; stoppable mid-run with finished pages kept; pages reviewable and removable before the document is built
- **Processing on save** — straightening, clean-up, searchable text
- **Honesty** — a setting the scanner did not take is reported, not silently ignored
- **Device discovery** — network scanners appear alongside connected ones; the system chooser covers devices the list misses
- **CLI** — `scan`, alongside `scanners`

## 1.0.28

*Released 2026-08-09*

### Pages Panel
- **Grid thumbnails** — widening the panel adds columns instead of enlarging one thumbnail; the panel drags much wider and always leaves room for the document
- **Reorder insertion point** — dragging shows the insertion point between the two thumbnails it falls between

### Page Ranges
- **Hyphen ranges** — Crop, Rotate, and Delete Pages read `1,3,5-9`
- **Use selection** — fills the range field from the pages selected in the page list
- **Empty ranges refused** — a range naming no page errors instead of acting on nothing and reporting success

### Save Naming
- **Derived filenames** — Compress, Optimize, Grayscale, PDF/A, Encrypt, Decrypt, Repair, Rebuild, Recover, prepress conversion, and the metadata tools suggest a name built from the source (`report_compressed.pdf`, not `compressed.pdf`); the save dialog still accepts any name

### Elsewhere
- **Recent files context menu** — Open, Show in folder, Copy full path
- **Scan detection in Compress** — the panel says when a document reads as a scan and offers the scanned-document setting in one click
- **Optimize as a guided-action step** — compress-then-optimize runs over a folder, watched folder, or schedule; the Compress and Optimize panels link to guided actions for folder runs
- **Changelog dates** — each release heading in this file carries its publication date

### Fixes
- **Range parsing** — Crop, Rotate, and Delete Pages read `5-9` as page 5 alone, then reported success over pages they never touched
- **Overwrite-prone filenames** — every operation proposed one fixed name, so a second run offered to overwrite the first result
- **Half-drawn shapes** — switching shape mid-draw abandons the half-drawn shape (choosing Cloud mid-polygon used to commit a polygon); leaving the tool also drops it, so a stray click cannot join the next shape
- **Theme compliance** — the snap options popover, stamp symbol palette, and document rulers follow the interface theme (each kept a dark fill behind dark text under the light theme); ruler numbers and palette buttons meet AA contrast in every theme
- **Stamp preset names** — drawn in the interface text color with the stamp's color on the outline (pale stamps were unreadable against the panel)

## 1.0.27

*Released 2026-08-09*

### Spell Check
- **As-you-type underlining** — paragraph editor, form field values, and note text, in the chosen dictionary
- **Spelling panel** (under the Edit tool) — checks page text, comments, and form field values; misspellings grouped by word with counts; suggestions on selection
- **Corrections** — Change fixes one occurrence; Change all fixes every occurrence and reports per occurrence; corrections keep the replaced word's styling, leave the rest of the page untouched, and are each one undo step
- **Ignore and custom dictionary** — ignore for the session or add to your own dictionary, honored by every later check
- **34 offline dictionaries ship** — Arabic, Catalan (and Valencian), Czech, Danish, German (Germany, Austria, Switzerland), Greek, English (US, UK, Australia, Canada, South Africa), Spanish (Spain, Mexico), French, Hebrew, Hungarian, Italian, Norwegian (Bokmål and Nynorsk), Dutch, Polish, Portuguese (Brazil and Portugal), Romanian, Russian, Slovak, Slovenian, Swedish (Sweden and Finland), Turkish, Ukrainian
- **Dictionary selection** — document's stated language, then interface language, or an explicit pick; **Add a dictionary…** loads any Hunspell `.aff`/`.dic` pair from disk
- **Skip rules** — all-caps words and words with numbers skipped by default (both switchable); URLs, email addresses, file names, and version numbers never flagged
- **Unopenable paragraphs** — reported as unchecked rather than listed with inapplicable corrections

### Read Out Loud
- **View ▸ Read Out Loud** — speaks the current page or reads from it to document end; transport bar with play, pause, stop, sentence step back/forward
- **Voice and speed** — chosen in the bar, both remembered; voices are the system-installed ones
- **Highlighting and follow** — paragraph, sentence, and word each highlighted; the view turns pages on its own
- **Tagged reading order** — tagged documents read in the author's declared order, not page layout order; the bar states which order is in use; page furniture marked as such is not read
- **Language-aware sentences** — sentence boundaries use the document's stated language where present
- **Shortcuts** — Ctrl+Shift+V reads the page, Ctrl+Shift+B reads to end, Ctrl+Shift+C pauses/resumes, Ctrl+Shift+E stops, Esc closes the bar
- **No-text pages** — say so and point at Scan & OCR instead of reading nothing

### Snapshot
- **Snapshot tool** — drag a rectangle over a page; the region goes to the clipboard as an image, pasteable anywhere
- **Fixed resolution** — captured at a preference-set resolution (General, default 150 ppi), not the current zoom; the captured rectangle stays on the page with its pixel size
- **Save image…** — writes the same picture to PNG
- **Dual clipboard formats** — two forms so applications that prefer either can paste; the document is never changed

### Crop to Content
- **Remove white margins** (Crop & Page Boxes) — sets the page box around actual content; **Find content** reports how many pages would crop, the widest edge removed, and how many are already tight; **Crop to content** applies exactly what was measured
- **Keep margin** — settable in points
- **Scan-aware** — scanned pages measured from their ink, so wide-bordered photocopies crop like typeset pages; corner dust specks no longer hold the margin open
- **What counts** — text, drawings, images, visible annotations; invisible links and hidden annotations do not
- **Safety** — blank pages reported and left whole; content already outside the visible box is not revealed; nothing deleted — resetting the box restores the margin
- **CLI** — `page-box --auto` with `--margin` and `--preview`

## 1.0.26

*Released 2026-08-08*

### Image Resolution Reporting
- **Document Properties ▸ Advanced ▸ Images** — image count and effective resolution, measured as pixels over placed space; the same picture drawn twice at different sizes reports two resolutions
- **Statistics** — uniform-resolution documents say so; a spread reports lowest, highest, and middle values; tilted images measured by their drawn edges so resolution is not understated; zero-area placements counted apart
- **Scan detection** — a document read from paper says so, with the scanned page count
- **Compress integration** — the same summary appears above the Compress panel's resolution control, so downsample targets are chosen against the actual resolution; no-image documents say so instead of reporting a resolution they lack

### Compress Then Optimize
- **Then optimize the result** (Compress panel) — compression followed by the optimize pass, as two separate queue operations; the result reports both halves (compression figures, post-optimize size, total reduction)
- **Partial failure** — if optimizing fails, the message states the compressed file was still written and why the second step did not finish

### Fixes
- **Crop-by-drag in the document view** — the drag now commits (it previously did nothing); the rectangle stays as a dashed keep-region mark and fills the Crop & Page Boxes margin fields; drawing an article box adds it to the selected article the same way
- **Large photographic scan compression** — finishes instead of running for hours and producing nothing; picture-heavy pages no longer go to the stencil compressor they made grow without limit, and are compressed on their own path (faster, and smaller on those pages); long-running stencil work falls back to a simpler, faster method, with the result reporting how many pages that happened to; compression never abandons a run over a slow page
- **Operation queue label** — the Optimize operation reads as **Optimize**, not a raw internal name
- **Deterministic output** — running the same operation on the same document twice writes the same file, byte for byte

## 1.0.25

*Released 2026-08-08*

### Navigation
- **Bookmarks from structure** — Bookmarks pane gains From structure…: builds an outline from a tagged document's headings; counts headings first, writes only on confirmation; each bookmark uses the heading's text and targets the heading itself, not just its page
- **Heading nesting** — sub-headings become children of the heading above; a document starting at a lower heading level grows no empty parents
- **Untagged documents** — offered the full chain: detect headings, then build; result reports which steps ran
- **Existing bookmarks** — replace-or-append prompt; nothing discarded silently; a heading with no readable text is reported, not written as an untitled bookmark
- **Create links from web addresses** — links every web and email address in the text, whole document or page range; link covers the address exactly, one link per line when an address wraps; text already covered by a link is skipped and counted, so re-runs change nothing
- **Search & Redact patterns** — web addresses join the built-in patterns
- **Articles pane** — defines a run of boxes across pages, walks it forwards and backwards, saved as a real article thread; pane states that many other readers ignore threads
- **CLI** — `outline-from-structure`, `link-from-urls` (`--preview` reports without writing), `articles`
- **Guided actions** — links-from-addresses and bookmarks-from-structure steps for whole-folder runs

### Scan Enhancement
- **Scan Enhancement pane** (Scan & OCR) — straighten, despeckle, whiten background, upright sideways pages; every correction measured and reported before rewriting (lean stated to a hundredth of a degree, speck count shown)
- **Straightening** — measures the page's own lean and turns it back; resampled once regardless of how often the tool runs
- **Speck removal** — only small, isolated marks not part of a picture; full stops, i-dots and halftones survive
- **Background whitening** — divides the page by the measured paper, lifting gutter shadows and uneven lighting; increases ink/paper separation rather than brightening both
- **Orientation** — read by the recognition engine, applied as page rotation so no pixel moves; low-confidence readings reported and not acted on
- **Scope** — scanned pages only; text-set pages refused by name, never silently skipped; whole document or current page, one undoable change; an already-clean page is left byte-identical
- **Batch OCR** — can straighten and clean each file before reading; guided actions gain an enhancement step; an enhancement step ordered after a read/replace step is refused
- **CLI** — `enhance-scan` (`--analyze` reports without changing), `ocr-file --enhance`

### Document Properties
- **Initial View tab** — page layout (single, single continuous, two-up, two-up with cover, continuous or not), navigation pane (bookmarks, thumbnails, layers, attachments, none), opening page, magnification (percentage or fit page/width/height/visible), reading direction, full screen, window options
- **Honoured on open** — layout, navigation pane, full screen, opening page, percentage magnification, fit-width; right-to-left reading direction reverses the leading page of a spread
- **Window options** — hide toolbar/menu bar/window controls, resize/centre window, title-bar text; written for other readers, and the panel says so; turning an option off removes the setting rather than writing a negative; only departures from defaults are stored
- **Script-opened documents** — setting an opening page on a document that opens by running a script is refused by name
- **Fonts tab** — every font used, grouped by type, with encoding, page count and embedded status; found in nested artwork, comment appearances, glyph procedures and a form's default appearance; a non-embedded font names the actual substitute face
- **Advanced tab** — PDF version, fast web view, tagged status, page count, file location, page sizes with standard paper names, open action and search index presence; sets the trapped flag and base URL for relative links
- **Edit semantics** — changes on both tabs are ordinary undoable edits; live signatures warn or refuse first

### Watermarks
- **PDF-page watermark** — a watermark is now text, a picture, or a page of another PDF; the page is placed as artwork, not rasterized, so lines and type stay sharp at any size
- **Source page** — pick any page (first is default), stored once regardless of how many pages carry it; source rotation honoured; comments and filled fields on the source are stamped with it
- **Opacity** — applies to the whole artwork at once, so overlapping shapes do not darken where they cross
- **Options** — scale, position, margin, tiling, angle, over/behind, page selection all work as for the other sources
- **Refusals** — a document cannot watermark itself, the source cannot be the output file; missing, empty, password-protected, page-less or unreadable sources and out-of-range page numbers refused by name
- **CLI** — `watermark --pdf-source` with `--pdf-page`; guided actions can stamp a PDF page and refuse a step naming more than one source

### Fixes
- **Outline editing** — no longer flattens positioned bookmarks to whole pages; stored position and zoom survive the edit

## 1.0.24

*Released 2026-08-07*

### Image Watermarks
- **Picture watermarks** — any picture Create PDF accepts, via file picker; stored once in the document regardless of page count
- **Scale** — 1 fills the page without crowding; also sizes text watermarks
- **Position and tiling** — centre, any edge or corner with margin; tiling repeats across the page with a set gap; both apply to text watermarks too, old placement remains the default
- **Multi-frame images** — first frame stamped, frame count reported
- **Rotated pages** — watermark now reads level instead of sideways, and no longer shrinks to the page's other dimension
- **CLI** — `watermark --image` with `--scale`, `--position`, `--margin`, `--tile`, `--tile-gap`; guided actions can stamp a picture and refuse a step naming both text and picture

### Split
- **Four modes** — page ranges, every N pages, maximum file size, top-level bookmarks
- **By size** — measured as actually written, so the limit is size on disk; a single page over the limit gets its own file and is reported
- **By bookmarks** — one file per top-level bookmark, named after the bookmark (filesystem-safe); pages ahead of the first bookmark kept in a file named after the document; a document with no top-level bookmarks says so up front and refuses by name
- **Form fields** — survive every mode; each output carries only the fields its own pages own
- **CLI** — `split --mode every-n|size|bookmarks`, with each mode's option and refusals for the others

### Text and Stroke Outlining
- **Text to outlines** — replaces each glyph with the font's own shape in place; **strokes to outlines** replaces each line with the shape the pen covered; either runs alone, even on a document with no transparency
- **Preview** — counts of text runs and stroked paths reported before writing; panel states converted text can no longer be selected, searched or extracted
- **Non-embedded fonts** — shapes taken from a named bundled face; a font whose glyphs are program code is refused by name; a zero-width line is refused by name (Fix Hairlines gives it one)
- **Fidelity** — dashes cut into segments before outlining; joins, caps, miter limit and dot patterns preserved; clipping text still clips; invisible text removed; text in reused page pieces converts without touching sharing pages
- **CLI** — `outlines-list` reports, `flatten` takes both conversions

### Table Review Before Export
- **On-page table review** — tables found on a page drawn on the document with column boundaries and rows; nothing included by default, each table opted in individually
- **Editing** — drag the frame to change coverage, drag a column rule to move a boundary, double-click to add or remove one
- **Export** — spreadsheet written from kept tables at the geometry left; unclaimed text can go to its own sheet; out-of-table lines and down-page text counted before export; the review never writes to the document
- **Availability** — offered from Export to Excel; exporting without review unchanged

### Fixes
- **Portfolio extraction** — a member named after a reserved device name now writes a real file; over-long member names shortened to filesystem-acceptable rather than failing

## 1.0.23

*Released 2026-08-07*

### Print Production
- **Print Production tool** — houses preflight, colour conversion, and the new ink tools
- **Output Preview** — renders open pages as separations on the document itself, with overprint simulation; each ink toggles without re-rendering; heaviest pixel's total ink reported with an editable limit and on-page highlight; per-ink coverage shown as the whole-page average it is
- **Ink Manager** — aliases one spot colour to another so both print on one plate; aliasing inks describing different colours refused until accepted; spot-to-process conversion uses the ink's own tint transform in fills, strokes, images, gradients and patterns; density and print sequence presented as application settings, not file settings
- **Add Printer Marks** — crop marks, registration targets, colour bars, page information outside the trim; page and crop box grow to hold them, trim/bleed/art boxes never move, removal restores every box exactly; marks in registration colour so they land on every plate; colour bar carries process solids and tints, an overprint pair, and every document spot; page information drawn with an embedded font; Western and Japanese styles, three stroke weights, growth stated before writing; no trim box → marked against crop or media box, and the panel says which
- **Fix Hairlines** — finds strokes too thin to print and raises them to a surviving width; thinness measured as device-drawn width, so a wide stroke under a small scale is caught; zero-width is always a hairline; annotation and form-field borders included (zero border width means no border, left alone); count and widths reported before rewriting; preflight gains a hairline row using the same measurement
- **Preflight** — now finds fonts and colorants used only inside patterns, shadings, images or annotations
- **Flattener Preview** — marks on the page which objects a transparency flatten would rasterize; transparent objects, what sits under them, and objects a region would absorb counted and highlighted per category; only regions rasterize, content outside stays live; region edges land on whole device pixels so flattened and live content meet seamlessly; raster/vector balance controls region merging; rasterization resolution chosen, with over-large requests refused; a page with no transparency reported and left untouched
- **Trap Presets** — named presets over standard in-RIP trapping parameters, assigned to page ranges; every parameter typed with range and default, out-of-range values refused; per-ink overrides supported, presets naming unused inks warn; PostScript export writes each range's parameters into that page's setup; trapping declaration stays "unknown" until stated — assigning a preset never claims a document is trapped; PDF/X masters no longer declare every document untrapped
- **CLI** — `printer-marks`, `printer-marks-remove`, `printer-marks-list`, `hairlines-list`, `hairlines-fix`, `flatten-list`, `flatten`, `trap-fields`, `trap-list`, `trap-assign`, `export-postscript`

### Forms
- **Signature field locks** — a new signature field can carry the form fields it locks, chosen from the document's list; whoever signs is bound without being asked; Prepare Form lists signature fields and edits the lock on any unsigned one (a signed field's lock is shown read-only); detected signature fields can lock fields created alongside them
- **CLI** — `forms --sig-field NAME --lock` and `--clear-lock`

### Export a Folder
- **Folder export** — converts every PDF under a folder to one of eleven targets: Word, rich text, OpenDocument, HTML, XHTML, plain text, spreadsheet, presentation, PNG, JPEG, TIFF
- **Behaviour** — outputs mirror the tree in a destination folder with the target's extension; each target's own options offered, only accepted ones sent; a file the format cannot be produced from is reported on its row and the run continues; originals never changed or opened; run log records each file's outcome and skip reasons
- **Automation** — guided-action export steps for watched folders and schedules; CLI `export-folder`

### Windows Contrast Themes
- **Contrast theme support** — window chrome follows the system palette; documents never recoloured (pages, annotations, text, thumbnails keep their colours, regardless of app theme)
- **Controls** — selected tools and pressed buttons use the system highlight; buttons, text fields and lists regain outlines; toolbar/menu separators and status boxes keep edges; colour swatches keep their colour with an outline; translucent bars turn solid
- **Preferences** — states the system palette is in control; the chosen theme is remembered untouched

### Languages
- **27 interface languages** — English, Spanish, French, German, Italian, Brazilian Portuguese, Japanese, Simplified Chinese, Traditional Chinese, Korean, Dutch, Danish, Swedish, Norwegian Bokmål, Finnish, Russian, Ukrainian, Polish, Czech, Slovak, Turkish, Hungarian, Greek, Romanian, Slovenian, Catalan, Arabic, Hebrew
- **Plural systems** — Russian, Ukrainian, Polish, Czech, Slovak carry all four number forms with agreement; Arabic all six forms including dual and 3–10 plural; Hebrew singular, dual and plural; Slovenian dual for exactly two; Korean and Chinese take one form; Romanian inserts "de" above nineteen
- **Grammar rules** — Turkish and Hungarian keep the noun in plain form after a numeral and never suffix file or field names; Korean never attaches a particle to file or field names; Greek headings uppercase without accents
- **Romance-language counts** — Spanish, French, Italian, Portuguese millions read in that language, not English
- **Traditional Chinese** — written for Taiwan, not converted from Simplified; Hong Kong and Macau systems open in Traditional Chinese
- **Right-to-left interfaces** — Arabic and Hebrew mirror panels, toolbars, lists and dialog buttons; the page itself never flips; resize handles keep the grabbed corner, rulers measure from the page origin; file paths, shortcuts and page ranges stay readable inside RTL sentences; Arabic page numbers use the document's own digits
- **Locale fixes** — symbol search matches an uppercase I regardless of regional format; tool search sorts by the on-screen language's alphabet; a system using the older "iw" Hebrew code opens in Hebrew; out-of-range page refusals are fully localized

### Security
- **Rendering library** — updated past GHSA-hq66-cqwq-w95j (crafted document could run arbitrary code)
- **Build-time test dependency** — updated past a reported denial-of-service vulnerability

## 1.0.22

*Released 2026-08-06*

### Signing
- **Lock fields on sign** — every field, chosen fields, or everything except them; fields picked from the document's list, beside the certification options; CLI `--lock` with `--lock-field`
- **Prepared lock rules** — a signature field prepared with its own locking rule keeps it, and the result says so; each signature reports what it locks and, separately, when a locked field changed since
- **Locked-field fills** — refused, naming the fields and pointing at saving a copy
- **System trust anchoring** — signature verification can anchor on the system certificate store, off by default; per-authority trust purposes respected; a verified signature names its vouching source; CLI `verify-signatures --system-trust`, `sign --system-trust`

### Folder Tools
- **Prepare Forms in a Folder** — detects and creates each form's fields across a folder and subfolders; **Search & Redact Folder** runs a term, word list or built-in pattern over every PDF in a folder
- **Behaviour** — files read in place, never opened; findings shown as a checkable list with nothing pre-checked; destination folder by default, in-place changes take a separate confirmation; signed documents decided per file, certified-against-changes documents refused and named
- **Options** — Search & Redact Folder can write redaction marks for later review instead of removing; Prepare Forms can hand any file to the document view; every run logs what was written, copied unchanged, or skipped and why
- **Automation** — both run in guided actions and as CLI `prepare-forms` and `search-redact`

### Optimize
- **Space breakdown** — attributes every byte to one of fourteen categories, largest first; rows sum to the file size exactly, with the total shown; each row names the setting that addresses it (only settings that exist); findings expand to individual objects with pages; never alters the document, re-runs after changes; CLI `audit-space`

### Fixes
- **Certification coverage** — filling a form or commenting on a certified document no longer leaves its certification signature reporting incomplete coverage
- **Dependencies** — GHSA-52cp-r559-cp3m, GHSA-h67p-54hq-rp68, GHSA-mh29-5h37-fv8m (js-yaml), GHSA-67mh-4wv8-2f99 (esbuild)

## 1.0.21

*Released 2026-08-06*

### Certification
- **Certifying signatures** — state what may change afterwards: nothing, form filling, or form filling and commenting; the choice is written into the document and cannot be changed later
- **Compatibility** — works with invisible signatures, visible stamps, signature files, hardware tokens and long-term validation; Signatures panel and side panel show who certified and what is allowed
- **Enforcement** — permitted edits pass untouched; anything beyond warns and names what is allowed; a document certified against all changes is not edited — saving a copy is offered; an unrecognised permission level reported as unchecked, never as pass or fail
- **CLI** — `sign --certify --certify-level` (`none`, `form-fill`, `annotate`); `verify-signatures` reports certification
- **Fixed** — commenting or filling on a certified or long-term-validated document destroyed the signature; filling a field with a separately stored on-page box reported a valid document as tampered; applying redactions to a signed document proceeded without asking (now refused on certified documents)

### Remove Hidden Information
- **Fourteen categories** of content the file carries but does not show, each with a count and named findings; empty categories say so
- **Consent model** — nothing removed until ticked; the three costly choices never pre-ticked; Apply re-reads the document and shows before/after, so an incomplete clean-up reports what remains; one undo takes back the whole pass
- **Coverage** — attachments reached only through annotations; content held by earlier file revisions (removing revisions writes the file whole); hidden layers' searchable text; invisible text, background-matching text, and text covered by something opaque (partly covered text kept)
- **Signed documents** — warn first, naming how many signatures break; certified documents flagged distinctly
- **CLI and automation** — `audit` prints the report as JSON, `sanitize --categories …` removes named categories; guided-action step

### Prepare Form
- **Detect fields** — turns page rules, boxes, checkboxes and radio buttons into suggestions, comb fields included; each named from the adjacent label and typed by shape
- **Review before write** — suggestions draw dashed and can be moved, resized, renamed, retyped or discarded; nothing written until confirmed; one undo removes the whole set
- **Image-only pages** — recognised automatically, within a point of the original; unlabeled lines and already-fielded regions reported with a count rather than offered
- **CLI** — `detect-fields` prints findings as JSON, writes nothing

### Export
- **Spreadsheet export** — finds tables (fully ruled, row-ruled only, or unruled) and writes cells as a workbook; figures written as figures with cell formats for thousands, currency, percentages and unambiguous dates; separators follow the document's conventions; spanning headings become merged cells; two tables per page produce two sheets; table-less pages and out-of-table line counts named and keepable separately; a document with no tables anywhere refused rather than saved empty
- **Presentation export** — one slide per page, real text boxes over the rendered page; slides take the document's page size or widescreen/standard; export counts what it wrote
- **Plain text export** — reading order or layout-preserving, optional page breaks; Extract Text can save straight to a file
- **CLI** — all three have command-line arms; `extract-text` writes directly
- **Fixed** — XHTML export produced an empty file for every document

### Fixes
- **Text toolbar** — rotation tooltip carried a stray internal reference; now a plain sentence

## 1.0.20

*Released 2026-08-05*

### Redaction
- **Search & Redact** — marks every occurrence of a term, imported word list, or built-in pattern in one pass; patterns cover phone numbers, emails, card numbers, social security numbers, dates, IBANs, NHS and social insurance numbers
- **Scope and matching** — this document, a page range, or every open document; matching identical to the find bar, including case, whole word and regular expressions
- **Results** — grouped by document and page, nothing pre-ticked; clicking a match navigates; check-digit numbers verified so long numbers do not pad the list; a match can be marked as found or grown to the whole word or line; pages with no searchable text reported with Scan & OCR one click away
- **Mark appearance** — fill colour and drawn text (FOIA or Privacy Act exemption codes or free text) with its own alignment, size, colour, and repeat-to-fill; both exemption sets ship with descriptions; custom code sets import and export as files; marks stored as standard PDF redaction annotations, readable by other programs
- **Measurement rewrite** — every line measured with the font that drew it, not estimated: covers letter/word spacing, stretched, rotated, stamped and vertically-set text; checked area reaches below the baseline so descenders are covered; where a document gives no usable measurements, redaction deliberately over-covers and says so
- **This affects every earlier release: files already redacted are worth re-checking.**
- **Precision** — exactly the marked characters removed, rest of the line left in place; single-shape ligatures and attached accents kept together; a damaged mark or one on a missing page reported by count and page instead of silently skipped

### Headers, Footers and Bates Numbering
- **CJK and RTL stamps** — Japanese, Chinese, Korean, Arabic, Hebrew and Persian at all six page positions; right-to-left text shaped and laid out properly with numbers where the language puts them; mixed-script header and footer handled in one pass

### Create PDF
- **Sources** — Word, Excel, PowerPoint, OpenDocument, RTF, plain text, CSV, HTML, PostScript, EPS, images from PNG to HEIC, existing PDFs, and blank pages, in a user-ordered list; unconvertible files marked rather than dropped
- **Page geometry** — each source keeps its own, or takes a paper size, orientation and margin with nothing stretched; a scanned image becomes a correctly sized page from its own resolution
- **Fidelity** — form fields, links and bookmarks survive; every page of a multi-page TIFF kept (also in Batch OCR); HEIC, WebP, JPEG 2000 and AVIF read directly
- **Safety** — conversion sealed off from the network; macros never run; missing fonts named in the result; a conversion that produced nothing says so

### Combine Files
- **Sources** — everything Create PDF takes, converting non-PDFs on the way in; each row shows type, conversion and page contribution
- **Page ranges** — each PDF takes a range like `1-3,5`; fields, links and bookmarks on those pages survive
- **Targets** — a new PDF, or append to an open document; Combine now available with nothing open

### Automation
- **CLI** — `create-pdf` writes one PDF from any source list with the same page size, margin and resolution choices; `merge` accepts non-PDF inputs; `batch <folder> create-pdf` converts every convertible file in a folder
- **Guided actions** — "Create PDF from any file" step, valid only as the first step

## 1.0.19

*Released 2026-08-04*

### Vertical Text
- **Mongolian columns** — advance left to right, and now list, read and reflow in that order; direction read from the text itself, so other vertical scripts are untouched
- **Editing** — edited Mongolian re-formed as joined words using the document's typeface where possible; still extracts, searches and copies as the typed characters
- **Layout** — an upright number inside a column stays exactly one column wide; commas, brackets and quotation marks take the typeface's upright vertical forms

### Scanned Documents
- **MRC compression** — Compress gains "Scanned document (MRC)": text, ink colour and paper separated and stored separately; text keeps scan resolution while the paper compresses to roughly a sixteenth of the original
- **Presets** — Archival, Balanced, Smallest, plus a PDF/A-safe option, each stating its guarantee
- **Scope** — scanned pages only; other pages byte-identical; a document with no scan says so instead of writing a pointless copy; form fields, comments, links, bookmarks and existing text layers untouched
- **Verification** — optional per-page read before and after; a page whose text did not survive keeps its original scan
- **Availability** — Compress panel, Preferences, Batch OCR, CLI, guided actions, watched folders, schedules
- **Rendering fixes** — pages using CCITT Group 4, JBIG2 or JPEG 2000 images rendered blank and now draw; same fix restores CJK character encodings, the standard PDF typefaces and CMYK colour profiles
- **Timeouts** — the fixed five-minute limit on compressing, converting and repairing now scales with the document

### Languages
- **Seven languages** — French, German, Italian, Brazilian Portuguese, Japanese and Simplified Chinese join Spanish; each covers the whole interface, offered only once complete
- **Terminology** — each language uses its own design, print and PDF software terms, not literal English renderings; counts inflect where the language inflects; punctuation and spacing follow each language's conventions
- **Detection** — a PC set to Portuguese or Chinese in any regional spelling opens in that language

## 1.0.17

*Released 2026-08-04*

### Drafting Aids
- **Object snap** — pointer snaps to endpoints, midpoints, centres, intersections, edges, and existing markup; per-kind toggles, Alt suspends, Tab cycles candidates under the cursor
- **Angle lock** — Shift holds a segment to the nearest angle increment; 15° default, configurable
- **Rulers** — top and left edges, in the drawing's own units, tracking the pointer
- **Guides** — drag off a ruler onto the page, movable, removable; never written into the document
- **Grid** — spaced in paper units or real-world units via the drawing scale; show and snap are separate toggles
- **Snap scope** — snapping applies to all placement, not only measuring

### Count and Takeoff
- **Count groups** — click to place a numbered marker into a named group, click again to un-count; per-group colour and symbol; Ctrl-drag box moves markers into the armed group
- **Tallies** — read from the marks themselves, per group and per page
- **Legend table** — stamp onto the page: symbol, group, count per row, plus total
- **CSV export** — one row per group per page plus totals row; app and command line
- **Persistence** — markers save as ordinary annotations; groups and numbering survive in any viewer

### Symbols
- **Symbol library** — searchable vector symbols in the stamp picker and beside count groups; 20 general AEC symbols ship with the app
- **Import/export** — load a firm's symbols from JSON, export any set; invalid files refused by name
- **Placed symbols** — carry their artwork in the document, print crisply at any size; snap, take the working colour, resize keeping shape, move/group/delete like any annotation

### Language
- **Spanish interface** — full translation, shipped only once complete
- **Settings ▸ Language** — System default or explicit choice, remembered; applies immediately, no restart, open document untouched
- **Locale formatting** — counts, sizes, timestamps follow the chosen language; OCR language list uses Windows's own localized names; assistive technology told the interface language

### Long Documents
- **Zoom accuracy** — Actual Size and Fit Width correct at any page count
- **Deep navigation** — jumping to a distant page lands and holds; End reports the last page

### Vertical Text
- **Vertical columns** — font family, bold, italic, including installed vertical faces; faces without vertical metrics refused by name with the specific reason
- **Rotated text** — quarter-turned text belongs to its paragraph and reflows with it; all four rotations edit as paragraphs
- **Limitation** — a horizontal block inside a vertical column is not reflowed, and says so

### Fixes
- **Image group delete after undo** — selection now follows the document instead of silently doing nothing
- **Theme switching** — theme and accent colour apply as one step; a slower answer cannot overwrite a newer one
- **Contrast** — accent-coloured text and focus outlines meet the contrast standard in every theme, including high contrast
- **Scheduled-run toggle** — enabled state read from the task itself; correct in any Windows language

## 1.0.16 — Deeper image, vector, and paragraph editing

*Released 2026-08-03*

### Images
- **Shear** — edge handles shear a placed image; composes with rotation and resize
- **Groups** — Shift/Ctrl-click builds a group; move, scale, rotate, align, distribute, delete as one step
- **Replace/place** — replacement fits inside the old frame; a bare click places at natural size
- **Blend and fade** — all 16 standard blend modes per image, plus draggable linear or radial fades
- **SVG placement** — places as true vector content; unsupported features refused with a stated reason

### Vector Objects
- **Selection box** — hugs the drawn curve rather than control points, including under rotation
- **Mid-path styling** — paths interleaving colour and transform changes move and restyle exactly
- **Nested forms** — vector objects inside forms within forms edit at any depth, leaving other uses undisturbed
- **Gradient fills** — list, move, delete like any vector object; deleting removes the definition from the file

### Text
- **Japanese line breaking** — fuller rules for opening brackets, small kana, prolonged-sound marks, leader runs
- **Free rotation** — new text boxes take any rotation, about their own centre
- **Font validation** — paragraph editor checks each character against the font of the span it will land in
- **Split paragraphs** — a paragraph spanning the page and an embedded drawing groups and edits as one

## 1.0.15

*Released 2026-08-03*

### Editing
- **Paragraph resize** — drag either edge and the text rewraps; a width no word fits is refused
- **Adjustable split gap** — dragged or typed, replacing the fixed distance
- **Merge** — Backspace at start merges upward, Delete at end pulls the next paragraph in; a prior edit rides in the same undo step; size/colour/font choices apply to the merged result
- **Rich paste** — keeps bold, italics, font class, size, colour; unrepresentable content arrives as plain text

### Accessibility and Appearance
- **WCAG 2.1 AA audit** — sweeps every panel, dialog, menu, preference page in all three themes on every test run; keyboard-operability suite alongside (Tab reaches every region, no dialog traps)
- **Windows accent colour** — colours every active control, focus ring, link, slider in every theme; text on accent buttons picks black or white by measured contrast, hover included
- **Dark theme tuning** — status greens and ambers softened; disabled buttons drop colour entirely
- **Theme completeness** — light and high-contrast themes complete throughout, with a consistency audit in the test battery

### Scheduling and Building
- **Schedule task folder** — creation guaranteed, proven by a live round-trip every build
- **Stalled-printer fix** — proven with real connections every test run
- **Unsigned build** — `npm run package:unsigned` produces the full installer with no signing key; README documents both build paths
- **Plain-window fallback** — remote desktop / transparency-off path exercised live by the test battery
- **Documentation** — corrected where it described retired components or overstated what publishing runs

## 1.0.14

*Released 2026-08-02*

### Printing
- **Same-second collisions** — two documents printed in the same second no longer overwrite each other's work in progress
- **Stalled jobs** — give up on their own instead of blocking all later prints until a restart

### Licensing
- **Recognition-engine notices** — complete third-party notices for the roughly fifty linked libraries ship beside it, each named with its licence and source location; upstream author list included
- **Build gate** — installer refuses to build if anything shipped is missing its notice
- **Offline notices** — stored with the source; builds need no network and produce identical notices every time

### Building and Releasing
- **Publish gates** — publishing runs the application, engine, and Windows-layer test suites first and refuses on failure; also refuses on a version mismatch between the publish and the app
- **README** — setup steps list every component a build needs

### Windows Appearance
- **Plain styling** — used with transparency effects off or over remote desktop

### Automation and Folders
- **Scheduled-task password** — handed straight to Windows, never passed on a command line
- **Case-insensitive paths** — a destination differing from the watched folder only by capitalisation is the same folder

### Command Line
- **`document-js-list` / `document-js-set`** — read and replace a document's JavaScript

## 1.0.12

*Released 2026-08-02*

### Text
- **Combining accents** — compose properly when editing, adding text, stamping a watermark, or filling a field
- **Ligatures** — form where the typeface has them; words still copy, search, and extract as ordinary letters
- **Arabic and Hebrew** — edits drawn in the document's own font where it can carry them
- **Vertical CJK** — size, colour, and weight apply

### Pages
- **Crop by rectangle** — drag in Crop & Page Boxes to mark what to keep; margins fill in, Apply crops as before

## 1.0.11 — Every font, every encoding

*Released 2026-08-02*

### Text
- **Full system font list** — Add Text card and paragraph editor list every installed font; embedding-forbidden fonts excluded, with a count of how many were left out
- **Legacy encodings** — documents using Shift-JIS, EUC, Big5, GBK, UTF-8, UTF-16, or UTF-32 open for editing

### Scan & OCR
- **Image inputs in batch** — PNG, JPEG, TIFF, BMP alongside PDFs, each becoming a searchable PDF
- **Encrypted batch input** — supply a password with the run

## 1.0.10 — Write it in any direction

*Released 2026-08-01*

### Text
- **RTL text boxes** — Arabic or Hebrew lays out in reading order, wraps, joins cursively; embedded Latin words and numbers stay the right way round
- **RTL styling** — size, colour, bold, italic on a selected word or phrase; a style change mid-joined-word is declined with a note rather than drawn

### Watermarks
- **RTL watermarks** — shaped and laid out correctly
- **CJK watermarks** — previously declined, now supported

### Forms
- **RTL field fill** — properly shaped, correctly ordered appearance, wrapped or not

### Under the Hood
- **Vocalised Arabic round-trip** — text carrying harakat is written, read back, and re-edited exactly as typed

## 1.0.9

*Released 2026-08-01*

### Text
- **RTL reflow** — Arabic, Hebrew, Persian, Urdu, and other right-to-left scripts rewrap as you type; editor works in reading order; embedded Latin stays the right way round
- **Re-shaping** — edited Arabic is re-shaped via a shaping-capable bundled font; ligatures and letter marks survive the round trip, so an edited paragraph edits again
- **Safety gate** — a paragraph is offered only when it can be read back; otherwise individual text runs stay editable

### Pages
- **Page labels** — the page box shows the document's label with the sheet position beside it; typing either works

### Images
- **Edit collapsing** — repeated moves, re-scales, and opacity changes on one image collapse instead of leaving a layer each time

### Reliability
- **File-write serialization** — two operations rewriting the same file cannot overlap; the second waits

## 1.0.8

*Released 2026-08-01*

### Text
- **Inline styling in Add Text** — per-range size, colour, bold, italic; mixed sizes lay out with correct line heights and the fit indicator measures exactly what will be drawn
- **CJK text** — add, edit, and fill into forms; a CJK-capable bundled font steps in only when the standard fonts cannot express the text

### Accessibility
- **High-contrast theme** — black backgrounds, white text, bright accents, gold focus outlines, applied from the first frame

## 1.0.7

*Released 2026-08-01*

### Text
- **Type 3 fonts** — glyph-procedure fonts (common in TeX output) now edit like any other text
- **Text-run editor** — gains size and colour; neighbouring text stays exactly where it was

### Images
- **Inline images** — images embedded directly in page content streams can be replaced and extracted

### Under the Hood
- **Render benchmarking** — test build measures page rendering to prove speedups and catch slowdowns

## 1.0.6

*Released 2026-08-01*

- **PKCS#11 signing** — smart card, USB token, or HSM: choose module, name token and certificate, enter PIN; full parity with file-based identities, including visible stamps, in-place signing, and the PAdES range
- **PostScript form annotations** — converted PDFs keep readable, fillable fields with their values
- **Composite fonts** — a missing text-mapping table is recovered from the named character collection or the embedded font
- **CFF and Type 1 fonts** — text in bare CFF or original Type 1 fonts is editable, using the font's own encoding and widths

## 1.0.5

*Released 2026-08-01*

### Certificate Encryption
- **Encrypt to certificates** — lock a document to one or more recipient certificates; matching private key opens it; same permission controls; screen-reader access never blocked
- **Open certificate-encrypted files** — including ones other tools produced, via your `.pfx`/`.p12` key file
- **Command line** — both directions supported

### Forms
- **Calculation order** — survives page inserts, merges, splits, deletions, and every other page operation
- **Document scripts** — save/print/close scripts stay with the document through page operations and compression
- **XFA guard** — page operations on an XFA form refuse with a clear message instead of silently destroying form data

### Prepress
- **CMYK conversion** — through your own ICC profile, the bundled one, or the built-in default
- **PDF/X** — X-1a, X-3, X-4 output with a real output intent; conversion verifies its own output

### Rendering
- **Rotation-pending zoom** — renders at full detail instead of scaling a coarse preview
- **Organize view zoom** — Actual Size and Fit Width zoom to the selected page

## 1.0.4

*Released 2026-08-01*

### Redaction
- **Save marks** — stores redaction marks as standard redaction annotations; other tools read them, marks never print, existing signatures stay valid

### Forms
- **Reset buttons** — clear the form to designed defaults, re-rendering every field, keeping signatures intact
- **Link buttons** — show the address and offer to copy it; the app never opens the web on its own
- **Script/submit buttons** — say so instead of doing nothing

### Drawing and Shapes
- **Eraser** — removes exactly what it touches; cutting a stroke mid-way leaves both ends trimmed at the edge
- **Rotate and mirror** — lines, arrows, polygons, clouds, drawings, measurements rotate in quarter turns and mirror either way
- **Properties** — arrowheads on either end of lines and polylines, and cloud bumpiness, editable in the properties bar

### Signing
- **Panel handoff** — the Signatures panel's sign form hands off to on-page placement with certificate details carried over

## 1.0.3 — Signed documents stay signed

*Released 2026-08-01*

### Signatures
- **Incremental append** — comments, form filling, XFDF import, added links, and added pages append to the file; existing signatures keep verifying
- **Out-of-scope edits** — removing/reordering pages, editing content, flattening behave as before
- **`incremental-save`** — applies an edited copy's changes onto a signed original as one appended revision
- **Signature cards** — name the page carrying the signature; click to go there

### Printing
- **Print preview** — every option previewed sheet by sheet: subsets, booklet order, poster tiles, pages per sheet, grayscale, scale

### Drawing
- **Stroke joining** — pen strokes drawn in quick succession join into one drawing; multi-stroke drawings from other tools import whole

### Keyboard
- **Single-key accelerators** — S sticky note, Z marquee zoom, E content editor (when enabled)

## 1.0.2

*Released 2026-07-31*

### Print Options
- **Duplex** — one side only, flip on long edge, or flip on short edge, where the printer has a duplexer
- **Driver options** — any paper the driver offers, forced portrait/landscape, colour or grayscale
- **Subsets** — odd or even pages, reverse order, collated or uncollated copies
- **Copies** — up to 999, replacing the 99-copy cap

### Sheet Layout
- **Pages per sheet** — up to 4×4, any reading order, optional borders, automatic rotation into each cell
- **Booklet** — saddle-stitched order, left or right binding, front-only and back-only passes
- **Poster tiling** — multiple sheets at any scale, with overlap, hairline cut marks, assembly labels
- **Custom scale** — type an exact percentage

### Print Content
- **Content selection** — document with markups, document alone, or document plus stamps
- **Print as image** — rasterizes at 150, 300, or 600 dpi before spooling, for drivers that mangle vector content
- **Cropped documents** — print the visible area exactly as displayed
- **Command line** — `print` gains the same option set; `printers --capabilities` reports papers, duplexer, and colour support

## 1.0.1

*Released 2026-07-31*

### Comment Arrangement
- **Move and resize** — drag to move, corner-grab to resize with the opposite corner anchored, Shift locks aspect
- **Selection** — Ctrl-click adds, Ctrl-drag rubber-bands; arrow keys nudge by a point, ten with Shift
- **Align/distribute/match sizes** — from the properties bar
- **Z-order** — bring forward or send behind; order carries into the saved file

### Drawing
- **Seven shapes** — rectangle, ellipse, line, arrow, polygon, polyline, review cloud, saved as real PDF shapes
- **Callouts** — text box with arrowed leader, opens for typing the moment drawn
- **Styling** — stroke width, fill colour, opacity for one shape or a whole selection; pen strokes take width and opacity
- **Vertex handles** — draggable on lines, arrows, polygons, callout leaders
- **Interop** — shapes drawn in other tools open as editable shapes; what cannot be represented faithfully is left untouched

### Measure
- **Calibration** — calibrate against a known length; every measurement that follows uses the ratio
- **Correction** — right-click a placed measurement to set the document scale from it, or to correct its recorded value

### Comment Interchange
- **XFDF import/export** — geometry, colours, authors, dates, replies, Accepted/Rejected/Completed statuses; Comments panel and `xfdf-export` / `xfdf-import` on the command line

## 1.0.0 — A new name: Spectra PDF

*Released 2026-07-31*

The product formerly released as "Open PDF Studio" continues as Spectra PDF, restarting numbering at 1.0.0 — same application, same code line.

### Moving from Open PDF Studio
- **Fresh install** — not an update; the old install keeps working but receives no updates
- **State starts fresh** — preferences, recents, custom stamps, saved actions do not carry over; guided actions survive as files (export from the old app, import here)
- **New names** — command line `spectrapdf.exe`; virtual printer "Spectra PDF"; scheduled runs under the `\Spectra PDF\` Task Scheduler folder; policies read from `HKLM\SOFTWARE\Spectra PDF`
- **Old printers and schedules** — belong to the old install; recreate here

### New since 2.8.7
- **Navigation pane** — Attachments, Layers, and Tags panels, open beside the document alongside a tool panel
- **Send To ▸ Email** — hands the current document to the default mail client as a ready-to-send attachment
- **Tag durability** — a tagged document's structure tree survives page moves, rotations, deletions, annotation commits
- **Automatic tagging** — gives an untagged document a usable structure tree in one step from the Tags panel
- **Batch OCR in place** — updates files in place with the same per-file isolation and reporting as mirror runs
- **Watched folders** — arriving PDFs processed through a guided action while the app is open, tray included
- **Virtual printer** — install "Spectra PDF" as a printer; anything any application prints arrives as a PDF
- **Portfolio files** — a non-PDF file inside a portfolio opens with the application owning its type
- **Measurement annotations** — save as true PDF measurement annotations, scale included, readable by other viewers
- **Four-pane split view** — linked scrolling and zoom, for wide spreadsheet-like documents

## 2.8.7

*Released 2026-07-31*

### Guided Actions
- **Folder runs** — run an action over a folder of PDFs, subfolders included, into a mirror tree with originals untouched; one file's failure never stops the rest; run log lands beside the batch OCR logs
- **Import/export** — actions export as small JSON files, import with full checking; unknown steps refused by name, imports never overwrite an existing action, exports never carry a password
- **Scheduling** — via Windows Task Scheduler, running with the app closed; a schedule keeps a frozen copy of the action; run-time-prompt actions refused

### Command Line
- **`run-action <source> --dest <folder> --action action.json`** — runs a saved action file over a folder

### Fixes
- **In-place `encrypt`/`decrypt`** — stage safely and replace the file atomically instead of silently failing

## 2.8.6

*Released 2026-07-30*

### PDF Portfolios
- **Open and manage** — cover sheet with file list alongside; open, save out, replace, add, remove files
- **Create** — from any files on disk, or convert the open document into one

### Measure
- **Distance, perimeter, area** — read as you go; real-world scale applies to every readout; finished measurements stay as deletable markups

### Stamps
- **Custom text stamps** — any label, any colour, saved for reuse
- **Dynamic stamps** — `{date}`, `{time}`, `{name}` filled at placement
- **Image stamps** — any picture, undistorted, travels with the document

### Guided Actions
- **Saved sequences** — compress, watermark, page numbers, OCR, strip metadata; one click; steps run in order, each undoable; a failed step stops the run with its reason
- **Per-run prompts** — any setting can ask each run; passwords never saved; an encrypt step always asks

### Split View
- **Window ▸ Split** — two independently scrolling and zooming views of the same document

### Fixes
- **Attachments survive page edits** — applying a page change silently dropped every attached file
- **Atomic in-place operations** — `compress`, `grayscale`, `pdf-a`, and the metadata commands stage safely and replace the file atomically

### Command Line
- **New arms** — `portfolio-info`, `portfolio-create`, `portfolio-make`, `portfolio-update`, `ocr-file`

## 2.8.5 — Batch OCR grows up

*Released 2026-07-29*

- **47 recognition languages** — app and batch runs, including Japanese, Chinese, Korean, Arabic, Hebrew, Russian
- **Run logs** — per batch run, with configurable retention and folder
- **File management** — processed originals file into moved and error folders with verify-before-move; unreadable files repaired automatically and retried
- **Schedules** — create, list, run-now, enable, disable, delete from Tools ▸ Scheduled Batch Runs; fire with the app closed, under alternate credentials or a managed service account
- **Native recognition** — runs natively for speed and under service accounts; the in-browser recognizer is gone

## 2.8.4 — Tools you can find

*Released 2026-07-25*

### Tool Pane
- **Button redesign** — tool name is the biggest element, icons smaller, descriptions in tooltips
- **Compact index** — pane narrows when browsing all tools, widens back to the chosen width; in-tool header reads "‹ All tools" instead of an unlabelled grid icon

### Search
- **Unified toolbar search** — answers with both tools and document text; arrow keys and Enter throughout

### Comments
- **One comments list** — every comment, with jump-to-page, note editing, recolouring, delete, delete-all
- **Merged tool** — Comment and Comments became one tool: arms markup and lists what is there

### Fixes
- **Comment jump** — clicking a comment always jumps to its page, including in the current document

## 2.8.3 — License notices in the box

*Released 2026-07-25*

### Tool Pane
- **Tools button** — toolbar toggle for the right-hand tool pane

### Licensing
- **Offline third-party notices** — the aggregate list and a per-component listing ship with the app
- **Font licences** — SIL Open Font License text installed alongside the bundled Liberation and Libertinus fonts; every bundled Python component keeps its licence inside the embedded runtime
- **Settings ▸ Updates & Licenses** — lists the complete bundled-component set and opens either notices file
- **Audit** — notices corrected against what actually ships

## 2.8.2 — The workbench

*Released 2026-07-25*

### Layout
- **Right pane** — every tool panel in a resizable pane, document in front
- **Status bar** — page number, zoom and Fit, Read⇄Organize switch, comments, pending work
- **Tabs** — every open file is a tab; `Shift+F4` toggles the tool pane, `Ctrl+Tab` cycles files
- **Home page** — quick actions, recent files with folder and last-opened details, full tool grid; choosing a tool with nothing open asks for a file first
- **Toolbar customization** — show/hide any button; optional buttons for Pages, Bookmarks, Signatures panes
- **Properties Bar** — `Ctrl+E`: comment kind, page, size, note, one-click recolour and delete

### Reading and Presenting
- **Two-page spreads** — with a "cover page separate" option so spreads pair like a bound book
- **Reading Mode** — `Ctrl+H` collapses the chrome; Presentation (`F5`) goes full-screen one page at a time

### Accessibility
- **Structure tags editor** — retag headings and figures, set alternative text, titles, language, restructure the tree
- **Reading order panel** — shows the exact order assistive technology reads a page, fixable in one click

### Signing
- **PAdES profiles** — B-B, B-T, B-LT, B-LTA, with RFC 3161 timestamping and embedded revocation data
- **Chain validation** — against certificate authorities you choose, managed in the app

### Export and OCR
- **Document export** — Word, RTF, ODT, HTML as real editable text via a bundled converter, nothing to install
- **Image export** — PNG or JPEG per page, or multi-page TIFF, at chosen resolution
- **47 OCR languages** — up from four, all shipping offline in the installer

## 2.8.1

*Released 2026-07-23*

### Search
- **Match modes** — match case, whole word, regular expression in the Find bar and Search panel
- **Folder search** — search every PDF in a folder without opening them; results list file and page, click opens the match

### Pages and Pagination
- **Headers, footers, Bates numbering** — six positions, page ranges, correct on rotated pages
- **Crop and page boxes** — trim the crop, bleed, trim, or art box by page
- **Page labels** — number pages independently of their order

### Documents and Security
- **Attachments** — embed, extract, remove attached files
- **Encryption permissions** — restrict printing, copying, changing, commenting; screen-reader access always preserved

### Under the Hood
- **Colour spaces** — vector fill and stroke colours read correctly for ICC, Indexed, Separation, DeviceN
- **Nested form fields** — read through the same engine as filling; previously invisible fields now appear

## 2.8.0

*Released 2026-07-22*

### Typography
- **Kerning** — added or edited text is properly kerned from the document's own metrics or a metric-compatible stand-in; editing no longer un-kerns
- **OpenType features** — real small caps and stylistic alternates on a box, paragraph, or range; where the font lacks the feature the text switches to a bundled serif, staying searchable either way

### Signing
- **In-document signing** — a signature can become part of the open document, undoably; "Sign & save a copy" remains; the file is written only on save
- **Multiple signatures** — signing an already-signed document adds a new revision; existing signatures stay intact and valid

### Document JavaScript
- **Script editor** — view, add, rename, edit, remove a document's JavaScript; never runs the scripts

### Prepress
- **CMYK conversion** — honours embedded colour profiles, preserves spot colours, with a choice of rendering intent

### Editing
- **Style preview** — bold, italic, family, size on a selected range render exactly as they will commit, each part keeping its own style

## 2.7.1 — Redaction fix (recommended update)

*Released 2026-07-21*

Three kinds of content could survive underneath a redaction mark and remain extractable from the saved file.

- **Inline images** — stored directly in the page's content stream, were left in place under the black box
- **Shading and gradient fills** — covering a marked area, were left in place
- **Unreadable annotation rectangles** — were treated as not overlapping and kept; unreadable position data now counts as overlapping
- **If you redacted documents with an earlier version, re-check those files.**

## 2.7.0

*Released 2026-07-20*

- **Range styling** — colour, bold, italic, family, size on a selected range inside a paragraph; whole-paragraph controls remain when nothing is selected
- **Shape editing** — select a drawn line, rectangle, or shape in the Edit tool; move, resize, rotate with handles; recolour fill and stroke, set line width, delete — all undoable
- **Nested shapes** — shapes inside a form or group are editable, leaving the group's other uses untouched

## 2.6.0

*Released 2026-07-19*

### Authoring
- **Add Text** — draw a box, type, pick size/colour/family; lands as real searchable text
- **Add Image** — draw a box, place a picture; JPEG passes through losslessly, everything else embeds pixel-perfect

### Editing
- **Image handling** — drag to move, corner-handle resize, free or quarter-turn rotation; non-destructive crop keeping the picture data; live opacity slider
- **Paragraph split/join** — Enter splits, Backspace at the start joins upward

### Restyling
- **Font substitution** — paragraph editor substitutes a whole paragraph into bundled Liberation Sans, Serif, or Mono; bold and italic substitute the matching variant; 12 metric-compatible faces ship

### Compatibility
- **Symbolic fonts** — editable where the embedded font program provides a usable character map

### Fixes
- **Canvas field creation** — could silently fail under heavy load; now succeeds visibly or says why
- **Shared page resources** — image edits no longer leak entries into sibling pages

## 2.5.0

*Released 2026-07-18*

### Compatibility
- **CJK documents** — standard Unicode CJK encodings open for editing; substitute fonts match the original's style (serif for serif, monospaced for monospaced)

### Restyling
- **Size and colour in the paragraph editor** — changing size rewraps and re-spaces; outline (stroked) text recolours correctly; out-of-range sizes are clamped

## 2.4.0 — Create PDF from PostScript

*Released 2026-07-18*

- **File ▸ Create PDF from PostScript…** — converts `.ps` and `.eps` with the classic quality presets, powered by the bundled Ghostscript; result opens in one click
- **EPS handling** — bounding box becomes the page, so figures stay figures
- **Refusals** — non-PostScript files refused with the reason named; a PDF input points at Repair's rebuild tier
- **`distill`** — full command-line parity
- **README** — feature sourcing table mapping every capability to the component powering it

## 2.3.0

*Released 2026-07-18*

### Discoverability
- **Document ▸ Combine Files…** — named menu path for merging; pages append to the current document, undoably
- **Tool tiles** — say what they do: Organize Pages names merge and delete, Edit names text, paragraphs, images; no behaviour changed

### Position and Selection
- **Commit stability** — selection, reading position, and document focus survive page-edit commits, including edits saved in another open file; moved pages keep thumbnails steady across a save
- **Page identity** — cross-commit identity means a stale reference can never point at the wrong page
- **Limitation** — positions reset when a file's content is rebuilt outside the editor, where holding a position would be a guess

## 2.2.0 — Edit Text & Paragraph Reflow

*Released 2026-07-18*

### Edit Paragraphs
- **Paragraph editing** — text that reads as a paragraph selects as one box and edits in a multi-line editor; words rewrap inside the paragraph's own box, keeping alignment, line spacing, first-line indent
- **Style preservation** — mixed fonts and sizes, coloured spans, superscripts, condensed text, and OCR's invisible layer keep their look; everything outside the box stays exactly put
- **Scripts and hyphens** — wraps no-space scripts correctly; hyphens are document text, never invented or removed
- **Limitations** — right-to-left passages and rotated text stay on the single-line editor with the reason stated; text that does not group cleanly remains individually editable line by line

### Edit Text
- **In-place rewrite** — double-click a run and rewrite in the document's own font, undoably; every keystroke validated against what the embedded font can express, naming the character it cannot
- **Positioning** — replacement keeps the original position; later words slide by exactly the width difference
- **Signed documents** — editing warns first; cancelling leaves the file byte-untouched
- **Fallback font** — one click re-renders an unwritable edit in a bundled compatible font, subsetted, embedded, still searchable

## 2.1.0 — Edit Images & Batch OCR

*Released 2026-07-17*

### Edit Images
- **Replace/extract/delete** — click any image on the page, undoably; an image used in several places changes only where clicked, including inside reused form graphics
- **Lossless replace** — JPEG bytes untouched; other formats convert losslessly with transparency preserved
- **Signed documents** — editing warns first

### Batch OCR
- **Tools ▸ Batch OCR Folder…** — mirrors a source folder into a destination with scanned pages made searchable; already-searchable files copy through byte-identical; source tree never modified
- **Error handling** — encrypted or damaged files skipped and reported; unreadable subfolders listed rather than missing; pages with no recognizable text reported
- **Progress** — per-file, per-page, stoppable; works with no document open; selectable recognition language
- **Safety** — a destination inside the source is refused, including via two different path spellings

## 2.0.0 — The Workbench

*Released 2026-07-16*

### Frame
- **Menu bar, toolbar, tab strip** — Home, Tools, one tab per open document; Home tab with recent files and an opened-when column replaces the welcome screen
- **Mica** — Windows 11 translucency on the chrome where supported, with a byte-identical solid fallback

### Reading View
- **Continuous virtualized view** — default, smooth with 1,000-page files
- **Text and navigation** — real selection and copy, zoom presets, page box, cross-document Find and Search
- **Rotate View** — quarter turns without touching the file; every tool keeps working
- **Hand and Select modes** — Space as a temporary hand; the Organize page-strip board one click away

### Navigation Pane
- **Panels** — Pages with drag-reorder, Bookmarks with editing, Search, Signatures; F4 toggles

### Tools, Dialogs, Print
- **Twelve tools** — Organize, Comment, Fill & Sign, Prepare Form, Redact, Scan & OCR, Compare, Protect, Optimize, Repair, Watermark, Export
- **Dialogs** — Document Properties `Ctrl+D`, Preferences `Ctrl+K`; every dialog closes on Escape and traps focus
- **Print** — `Ctrl+P` with printer picker, page range, copies, fit/actual; `print` and `printers` command-line arms
- **Insert blank pages** — sized to their neighbour, undoable

### Keyboard
- **Frozen keymap** — standard chords, document-op set, find stepping, optional single-key tool accelerators (off by default); the webview's own keys can never fire

### Correctness
- **Path canonicalization** — one file is one document however its path is spelled; canonicalized at the OS boundary
- **Pending edits** — printing, properties, and every whole-file operation see pending page edits

## 1.0.0 — The Canvas Workspace

### Canvas
- **Page strips** — every open PDF is a strip of live thumbnails; drag pages within a document, between documents, or out into a new one; single pages or multi-selections move as one undo step
- **Append and import** — one click appends a document's pages to the one above; dropping files onto a document imports their pages
- **Staged commits** — rotations, deletions, moves, imports, and annotations stay in memory until Apply changes commits every touched file atomically; multi-level undo/redo spans staged edits and applied operations
- **`.pdfx` format** — [open format](https://github.com/AlexandrosGounis/pdfx) saving several documents as one ordinary PDF that reopens as separate strips
- **Keyboard** — undo, select all, delete, rotate, find, zoom

### Annotate, Redact, Sign
- **Annotations** — highlights, text boxes, freehand ink, preset stamps with notes, recolouring, comments sidebar; existing PDF annotations import as editable objects
- **True redaction** — removes marked regions from file content: text, images, nested form XObjects, overlapping annotations
- **Signatures** — verify embedded signatures for cryptographic validity and document integrity, with an honest trust caveat; sign with a .pfx or PEM key and certificate, place a visible stamp, or generate a self-signed identity; click an empty signature field to sign into it
- **Watermarks and compare** — watermarks at any angle with auto-fit; PDF compare with word-level text diff and pixel-level visual diff

### Forms
- **Fill** — AcroForm text, checkbox, radio, dropdown, list fields on the page, baked in one click; pending values survive page edits; classic panel remains
- **Create** — draw text, checkbox, radio group, dropdown, option list, and empty signature fields
- **Durability** — form fields survive page moves, rotations, merges, splits, deletion, compression, grayscale conversion

### Find & OCR
- **Find** — in-viewer across every open file, with match navigation and per-word highlights
- **OCR** — scanned pages OCR offline; "Make searchable" persists an invisible text layer, leaving the page pixel-identical
- **Bookmarks** — click-to-jump outline with drag-reorder and a full tree editor; links and actions survive editing

### Command Line
- **New subcommands** — `forms`, `outline`, `redact`, `watermark`, `compare`, `verify-signatures`, `sign`, `generate-signer`

### Fixes
- **Form preservation** — merging, splitting, deleting pages, compressing, or converting a form PDF no longer destroys its fields
- **UTF-8 I/O** — engine I/O is UTF-8 end to end; non-ASCII names, bookmarks, form values round-trip
- **Reopen staleness** — reopening an already-open file can no longer briefly serve its previous in-memory state

## 0.9.0 — Initial Release

*Released 2026-06-09*

First public release of Open PDF Studio.

### Features
- **Pages** — merge, split by range, rotate, delete
- **Transform** — compress with presets or custom DPI, grayscale, optimize, PDF/A, PDF version control
- **Security** — encrypt and decrypt with AES-256
- **Content** — extract text; view, edit, or strip metadata
- **Repair** — three tiers of repair, rebuild, and recovery for damaged PDFs
- **Preview** — thumbnail grid, page inspector, drag-to-reorder merge workspace
- **Command line** — every operation scriptable, plus batch processing over a directory
- **Windows integration** — installer, silent install, file associations, context menu, tray, start-with-Windows, auto-update
- **Themes** — light, dark, system; WCAG 2.1 AA

### Built With
- **Tauri v2** — Rust + WebView2, React 19
- **Embedded Python 3.14** — pikepdf, pdfminer.six
- **Ghostscript 10.07.1** — vendored upstream, AGPL-3.0
