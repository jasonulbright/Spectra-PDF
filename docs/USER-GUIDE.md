# Spectra PDF User Guide

This guide is for people who use Spectra PDF at work. It does not assume technical knowledge. Each task has numbered steps.

How to read the guide:

- A menu path looks like this: **File > Open…**. Click the first menu name. Then click each item in the path.
- A keyboard shortcut looks like this: `Ctrl+O`. Hold the first key. Then press the last key.
- A name in bold is the exact text on the screen.
- The guide uses the English names. If you change the language of the app, the names change with it.

## Contents

- [About Spectra PDF](#about-spectra-pdf)
- [Install and first start](#install-and-first-start)
- [Open, save and the working copy](#open-save-and-the-working-copy)
- [The workbench layout](#the-workbench-layout)
- [View and navigate](#view-and-navigate)
- [Edit text and images](#edit-text-and-images)
- [Annotate and comment](#annotate-and-comment)
- [Forms](#forms)
- [Signatures](#signatures)
- [Redaction and search](#redaction-and-search)
- [Compare](#compare)
- [Scan and OCR](#scan-and-ocr)
- [Page tools](#page-tools)
- [Compress, optimize, PDF/A and preflight](#compress-optimize-pdfa-and-preflight)
- [Encrypt and decrypt](#encrypt-and-decrypt)
- [Print](#print)
- [Export to Office and image formats](#export-to-office-and-image-formats)
- [Batch and guided actions](#batch-and-guided-actions)
- [Settings, language and updates](#settings-language-and-updates)
- [Troubleshooting](#troubleshooting)
- [Glossary](#glossary)

## About Spectra PDF

Spectra PDF is a desktop program for PDF files. It runs on Windows and on Linux. You use it to read, mark up, edit, sign, redact, compare, scan, print and convert PDF files.

Spectra PDF opens in one window. You can open more windows. The document stays on the screen while you work. Many tools open in a pane next to the document.

What Spectra PDF never does:

- It does not show ads. It does not collect usage data. It does not show upgrade offers.
- It does not use the network for its own purposes, except to look for, download and install updates. By default it looks for a new release when it starts. You can turn this off. See [Settings, language and updates](#settings-language-and-updates).
- It uses the network for other work only when you start that work. Examples are opening a document from a web address, capturing a web page, sending a form with its own Submit button, and signing with a signing service. OCR, spell check, signature trust, export and print production run on your computer.
- It does not change your original file until you save. One action can save for you: **Window > Move to New Window**, and dragging a tab out of the window, write the document to its original file first, after asking. See [Open, save and the working copy](#open-save-and-the-working-copy).
- It does not fetch an address that is written inside a document by itself. Nothing in a document that you open from the web address is run.
- It does not run the custom scripts of a form, unless you turn on the setting **Run unrecognized field scripts**. The setting is off at first.
- It does not send a document to a signing service. When you sign with a signing service, only the digest of the signed part is sent.
- It does not change the files in a source folder when you run a folder tool, unless you choose an option that replaces or moves the originals. **Tools > Watched Folders…** always moves each processed original to a processed folder.

## Install and first start

### Windows

Spectra PDF for Windows comes in two forms:

- The installer. Run the installer and follow the steps. The installer shows a color-profile notice. You must accept it to continue an interactive installation.
- The portable zip. Extract the zip file to a folder and start the program from there. The program keeps its settings, dictionaries, session state and logs beside itself. If that folder is not writable, it uses your user profile. The first start shows the color-profile notice.

If you do not accept the color-profile notice, everything works except the features that need the color profiles. Each of those features names the reason when you use it.

Spectra PDF needs WebView2. Windows 10 and Windows 11 include it. If it is missing, the interactive installer downloads it.

Everything else that Spectra PDF needs is in the Windows installer. This includes the document engine, Ghostscript, the OCR engine and the spelling dictionaries. You do not install a second program. Only music recognition needs Audiveris, which is optional.

### Linux

Spectra PDF for Linux is for x86-64 computers. It comes as an AppImage, a `.deb` package and an `.rpm` package.

1. To install the `.deb` package, run `sudo apt install ./spectrapdf_<version>_amd64.deb`.
2. To install the `.rpm` package, run `sudo dnf install ./spectrapdf-<version>-1.x86_64.rpm`.
3. The `.deb` and `.rpm` packages use the Ghostscript of your system. Ghostscript must be version 10.0 or newer. If your system has an older version, install a newer one and choose it in **Edit > Preferences…**, category **Engine**. The AppImage has its own Ghostscript.
4. To use the AppImage, make the file executable with `chmod +x`. Then start the file.

The AppImage needs FUSE. If FUSE is not on your computer, start the AppImage with `--appimage-extract-and-run`.

### First start

1. Start Spectra PDF.
2. The window opens on the **Home** tab. The tab says: Open a document to start, or pick a tool below.
3. While the document engine starts, a short message appears in a corner of the window: **Starting the document engine…**.
4. If the program cannot find Ghostscript, it shows the message **Ghostscript was not found**. Everything else works without Ghostscript. See [Troubleshooting](#troubleshooting).

The **Home** tab has these buttons: **Open a PDF**, **Create PDF**, **Combine files** and **Batch OCR**. It also has a list of **Recent files** and the group **All tools**. You can drop PDF files on the window to open them.

## Open, save and the working copy

### Open a file

1. Click **File > Open…** or press `Ctrl+O`.
2. Choose one or more PDF files.

You can also click **Open a PDF** on the **Home** tab. You can also drop PDF files on the window.

Each open file gets its own tab. A file can be edited in one window at a time. If you try to open a file that another window holds, the message **Open in Another Window** appears. Click **Show that window** to go to it.

If the file has a password, the dialog **Password Required** appears. Type the password.

To open a recent file, click **File > Open Recent**. Then click the file name. To empty the list, click **File > Open Recent > Clear Recent**.

### Open a file from the web

1. Click **File > Open from Web Address…**.
2. In the field **Web address**, type the address. Only http and https addresses work.
3. Click **Open**.

Spectra PDF downloads the file to a temporary copy and opens it. A document that you open this way has no file of yours to save back to. **File > Save** asks where to keep it.

### Create a PDF

Click **File > Create PDF…**. The dialog **Create PDF** builds a PDF from these sources:

- Images, Word, Excel and PowerPoint documents, text, HTML, PostScript and PDF files. Click **Add Files…**.
- A blank page. Click **Add Blank Page**.
- The clipboard. Click **From Clipboard**.
- A web page. Click **From Web Page…**.

The sources are one list. Drag a source to change its place in the list. In the field **Output**, choose **One PDF** or **One PDF per file**. Click **Convert…**.

You can also use **File > Create PDF from Clipboard**, **File > Create PDF from Web Page…** and **File > Create PDF from Scanner…**.

### The working copy

When you open a file, Spectra PDF makes a temporary working copy. All your edits go to the working copy. The original file does not change until you save. One exception: **Window > Move to New Window**, and dragging a tab out of the window, write the working copy to the original file first. If the document has unsaved changes they ask before they do, and after a move you cannot undo earlier edits.

- **File > Save** (`Ctrl+S`) writes the working copy over the original file. The item is dim when the document has no unsaved changes.
- **File > Save As…** (`Ctrl+Shift+S`) writes the working copy to a file that you choose.
- **File > Close** (`Ctrl+W`) closes the document. **File > Close All** closes every document.
- **File > Exit** (`Ctrl+Q`) closes the program.

When you close a document that has unsaved changes, Spectra PDF asks if you want to save first. Choose **Save**, **Don't Save** or **Cancel**.

If the folder does not allow Spectra PDF to replace the file safely, the save fails and the original file stays as it was. Use **File > Save As…** and choose another folder.

### Undo and redo

- **Edit > Undo** (`Ctrl+Z`) reverses the last edit.
- **Edit > Redo** (`Ctrl+Shift+Z`) does the edit again. `Ctrl+Y` does the same.

### Pending page edits

Some page edits stay in memory first. Examples are moving, rotating and deleting pages in the page grid. The status bar then shows the button **Apply changes**. You can also click **Document > Apply Page Edits**. Spectra PDF also applies pending page edits by itself before it saves, before it runs a whole-file tool, and before it closes the document.

### Signed and protected documents

- If you edit a signed document, the message **Document is signed** appears. It says that the edit makes the digital signatures invalid. Choose to continue or to cancel.
- Some edits keep the signatures valid. Adding comments, filling a form and adding pages are written as one new revision at the end of the file, when the document allows it. If a change goes further, Spectra PDF rewrites the file and tells you before it does so.
- If the document is certified with no changes allowed, the message **Document is certified** appears and you cannot edit it. Save a copy and edit the copy. The copy is no longer the certified document.
- A document can forbid some actions, for example printing or copying. Spectra PDF then dims the menu item. A message names the missing permission, for example: This document does not allow printing.

### Document properties

Click **File > Properties…** or press `Ctrl+D`. The dialog shows and sets the fields Title, Author, Subject and Keywords. It also lists the fonts that the document uses and sets how the document opens in other readers.

## The workbench layout

The window has these parts, from the top to the bottom:

1. The menu bar. The menus are **File**, **Edit**, **View**, **Document**, **Tools**, **Window** and **Help**.
2. The main toolbar. It has buttons for **Open…**, **Save**, **Undo**, **Redo**, **Hand**, **Select**, **Zoom Out**, **Fit Page**, **Zoom In**, **Find** and **Tools Pane**. Point at a button to see its name and its shortcut. The search box **Search tools and text** is in the toolbar.
3. The tab strip. The first tab is **Home**. Each open document has its own tab. Press `Ctrl+Tab` for the next tab. Press `Ctrl+Shift+Tab` for the previous tab.
4. The secondary toolbar. It appears when you open a tool that works on the page. It has one button for each mode of the tool and a switch **Locked** or **Unlocked**. The switch is on **Locked** at first. The mode then stays ready after each mark. You can mark many places and do not pick the mode again. To use the mode once, set the switch to **Unlocked**.
5. The navigation pane. It is on the left side. See [View and navigate](#view-and-navigate).
6. The document area. It shows the pages.
7. The tool pane. It is on the right side. It shows one tool at a time.
8. The status bar. It is at the bottom.

### Customize the toolbar

1. Click **View > Customize Toolbar…**.
2. Show or hide each button. The buttons are in these groups: **File**, **Undo & redo**, **Hand & select**, **Edit**, **Zoom**, **Find** and **Panes**.

Some buttons are hidden at first. They are the button for the **Edit** tool and the buttons for the navigation panels.

### The tool pane

- Click **View > Tools Pane** or press `Shift+F4` to show or hide the tool pane.
- To open a tool, click its name in the **Tools** menu. Or type its name in the search box.
- A tool that has more than one function shows a switch for them at the top of the pane.
- These tools work on the page: **Comment**, **Edit**, **Fill & Sign**, **Prepare Form**, **Redact**, **Measure**, **Count & Takeoff** and **Snapshot**. When you click one of them in the **Tools** menu, Spectra PDF turns on a mode on the page. It does not open the tool pane. The secondary toolbar shows the modes. To use the panels of such a tool, click **View > Tools Pane**.
- Click **‹ All tools** to go back to the list of tools.
- Drag the edge of the pane to change its width.
- Click the close button of the pane (**Close the tool pane**) to close it.

The **Tools** menu has these tools:

| Tool | What it does |
|---|---|
| **Organize Pages** | Reorder, rotate, delete, split, extract — and merge pages between open files. |
| **Comment** | Highlight, add text boxes, draw, stamp — and review every comment in the document. |
| **Edit** | Edit text, whole paragraphs, and images — or add new text — right on the page. |
| **Fill & Sign** | Fill in a form and sign it, or verify a signature. |
| **Prepare Form** | Detect the fields on a flat form, or add and edit them by hand, then flatten. |
| **Redact** | Mark text to remove — by hand, or by searching every occurrence — then permanently strip it from the file. |
| **Measure** | Measure distances, perimeters, and areas on the page. |
| **Count & Takeoff** | Count items on a drawing by group, then export the takeoff or place a legend. |
| **Guided Actions** | Save sequences of steps and run them on a document with one click. |
| **Scan & OCR** | Scan pages, straighten and clean them, make them searchable, or turn printed music into MusicXML. |
| **Compare Files** | See what changed between two documents. |
| **Protect** | Add or remove a password. |
| **Optimize** | Reduce file size, convert to grayscale or PDF/A. |
| **Repair** | Validate a damaged file and rebuild it, in escalating tiers. |
| **Watermark** | Stamp text across every page. |
| **Header & Footer** | Add headers, footers, page numbers, and Bates numbering. |
| **Crop & Page Boxes** | Crop pages and edit the crop/bleed/trim/art boxes. |
| **Snapshot** | Copy a region of the page to the clipboard as a picture. |
| **Page Labels** | Number pages as i/ii/iii, 1/2/3, A/B/C, with prefixes. |
| **Attachments** | Embed, extract, and remove attached files. |
| **Portfolio** | Create a PDF portfolio and manage its member files. |
| **Layers** | Show or hide the document’s optional-content layers. |
| **Accessibility** | Check the document, edit its structure tags, and fix the reading order. |
| **Print Production** | Preview separations and ink coverage, manage inks, check print readiness, and convert color. |
| **Links** | Draw link regions, target them at a page, a file or an address, and style their borders. |
| **Export** | Pull the text out of a document, and check its tables before they become a spreadsheet. |

The **Tools** menu also has the folder tools. See [Batch and guided actions](#batch-and-guided-actions).

If a document forbids the action of a tool, the tool is dim. See [Open, save and the working copy](#open-save-and-the-working-copy).

### The Properties Bar

Click **View > Properties Bar** or press `Ctrl+E`. The bar shows the details of the annotation that you selected.

### The status bar

The status bar shows these controls:

- The current page. Type a page number, or a page label such as `iv`, and press Enter. The total number of pages is next to it.
- The zoom level. Type a percent and press Enter. The **Fit** menu sets how the page fits the window.
- The page layout: **Single** or **Multiple**.
- The scroll mode: **Continuous** or **Paged**.
- The button **Organize**, which switches to the page grid. In the page grid, the button is **Read**, which switches back to the reading view.
- The **Snap** controls, which set how drawing snaps to the page.
- Buttons for pending work. They appear only when work is pending: a button to fill form fields, a button to redact marked regions, and the button **Apply changes**. Each of them has a **Clear** or a **Save marks** button next to it, where that applies.

### The page grid

The page grid shows each open document as a strip of page thumbnails. To open it, click **Organize** in the status bar, or click **View > Organize Pages**. To show all open documents in the grid, click **View > Organize All Documents**. To go back to the reading view, click **Read** in the status bar, or click **View > Document View**.

In the page grid:

- Click a page to select it. Hold `Ctrl` and click to add a page to the selection. Hold `Shift` and click to select a range. Press `Ctrl+A` or click **Edit > Select All Pages** to select every page. Click **Edit > Deselect** to clear the selection.
- Drag pages to reorder them. You can drag pages between documents.
- Press `Del` to delete the selected pages. Spectra PDF refuses to delete every page of a document.
- Press `]` to rotate the selected pages 90° to the right. Press `[` to rotate them 90° to the left.
- Right-click a page for these items: **Open**, **Rotate left 90°**, **Rotate right 90°**, **Delete page** and **Extract text…**.
- Double-click a page to read it.

These edits stay pending until you apply them. See [Pending page edits](#pending-page-edits).

## View and navigate

### Zoom

| Action | Menu path | Shortcut |
|---|---|---|
| Zoom in | **View > Zoom > Zoom In** | `Ctrl+=` |
| Zoom out | **View > Zoom > Zoom Out** | `Ctrl+-` |
| Actual size | **View > Zoom > Actual Size** | `Ctrl+1` |
| Fit the whole page | **View > Zoom > Fit Page** | `Ctrl+0` |
| Fit the page width | **View > Zoom > Fit Width** | `Ctrl+2` |
| Fit the page height | **View > Zoom > Fit Height** | `Ctrl+3` |

You can also type a zoom level in the status bar. The range is 1 to 6400 percent.

### Go to a page

In the reading view, press `Ctrl+Shift+N`. The page box in the status bar is ready for a page number.

### Page display

Use **View > Page Display** to choose the layout:

- **Single Page** shows one page in each row.
- **Multiple Pages** shows as many pages in each row as the window holds.
- **Show Cover Page Separately** turns the separate cover page on or off. It is available when the layout is **Multiple Pages**.
- **Continuous Scrolling** scrolls through the pages without stops.
- **Paged Scrolling** moves one row of pages at a time.

### Rotate the view

Click **View > Rotate View > Rotate View Clockwise** (`Ctrl+Shift++`) or **View > Rotate View > Rotate View Counterclockwise** (`Ctrl+Shift+_`). The page turns on the screen. The file does not change. To rotate the pages in the file, use [Page tools](#page-tools).

### Hand and Select

Click **Hand** in the toolbar to pan the page. Click **Select** to select text and objects.

### Reading Mode, Presentation and Read Out Loud

- **View > Reading Mode** (`Ctrl+H`) hides the parts of the window around the document. Click it again to show them.
- **View > Presentation (Full Screen)** (`F5`) shows the document on the full screen. Press `Esc` to leave.
- **View > Read Out Loud > Read This Page** (`Ctrl+Shift+V`) speaks the page.
- **View > Read Out Loud > Read to End of Document** (`Ctrl+Shift+B`) speaks until the end.
- **View > Read Out Loud > Pause Reading** (`Ctrl+Shift+C`) pauses.
- **View > Read Out Loud > Stop Reading** (`Ctrl+Shift+E`) stops.

Read Out Loud uses the voices that are installed on your computer.

### Rulers, grid, guides and snapping

Click **View > Rulers & Grids** and choose **Rulers**, **Grid**, **Guides** or **Clear Guides**. To place a guide, drag from a ruler onto the page. Click **View > Snapping** to turn snapping on or off.

### The navigation pane

Press `F4` or click **View > Navigation Panels > Navigation Pane** to show or hide the navigation pane. To open a panel, click **View > Navigation Panels** and then the name of the panel. The panels are:

- **Pages** shows page thumbnails. You can drag the thumbnails to reorder the pages.
- **Bookmarks** shows the bookmarks of the document. Click **+ Add bookmark** to add one. Each bookmark has the actions **Add child bookmark** and **Delete bookmark (and children)**. Drag the handle of a bookmark to reorder or nest it. Click **From structure…** to build bookmarks from the headings of the document.
- **Articles**
- **Attachments**
- **Layers**
- **Tags**
- **Search**
- **Signatures**

### Find

1. Press `Ctrl+F` or click **Edit > Find**. The find bar opens with the text **Find in documents**.
2. Type the text.
3. Press `F3` for the next match. Press `Shift+F3` for the previous match. You can also click the arrow buttons in the find bar.
4. Press `Esc` to close the find bar.

The find bar has three switches. The switch `Aa` is **Match case**. The switch `ab` is **Whole word**. The switch `.*` is **Use regular expression**.

### Search in all open documents or in a folder

1. Click **Edit > Search** or press `Ctrl+Shift+F`. The panel **Search** opens.
2. Choose **Open documents** or **On disk**.
3. For **On disk**, click **Choose folder…** and choose the folder.
4. Type the text. The list shows the pages that match. Click a result to go to the page.

### Search tools and text

Press `Ctrl+L` to go to the search box in the toolbar. Type the name of a tool, or a phrase. The list shows **Tools**, text **In this document** and text **In open documents**. Click a result to open the tool or go to the page.

### Window menu

- **Window > Split** shows two panes over the same document. Each pane has its own scroll position and zoom.
- **Window > New Window** opens a second window. **Window > Move to New Window** moves the document to a new window. If the document has unsaved changes, Spectra PDF asks, then saves them to the original file first. Choose Cancel to keep the document where it is. A document belongs to one window at a time.
- **Window > Minimize to Tray** minimizes the window to the system tray.

## Edit text and images

Click **Tools > Edit**. The secondary toolbar shows the modes **Select & Edit**, **Add Text** and **Add Image**. In the mode **Select & Edit**, the toolbar says: **Click an image, a paragraph, or a line of text on the page**.

### Change text

1. Point at the text. The label says **Text — double-click to edit** or **Paragraph — double-click to edit**.
2. Double-click the text.
3. Type your change. Spectra PDF uses the font of the document. If the font does not have a character that you type, the message says: This document's font does not contain that character.
4. To keep the change, click outside the text.
5. To cancel, press `Esc`. The document stays unchanged.

When you edit a paragraph, press `Enter` inside the text to split the paragraph into two paragraphs.

The style controls for a paragraph are **Font**, **Size**, **Color**, **B** (bold), **I** (italic), **SC** (small caps) and **Alt** (stylistic alternates). When text is selected, the controls change the selection. When no text is selected, they change the whole paragraph. The font menu has the choices **Bundled** and **Installed**. Click **Keep original font** to keep the font of the document.

The preference **Underline misspellings while editing text** marks words that are not in the dictionary. See [Settings, language and updates](#settings-language-and-updates).

### Add new text

1. Click **Add Text** on the secondary toolbar.
2. Draw a box on the page. The text fills the box and wraps to its width.
3. In the field **Type the text to add…**, type the text.
4. Set **Font**, **Size** and **Color**. The **Direction** menu has the choices **Horizontal** and **Vertical**.
5. Click **Add text**.

The new text can be searched and edited.

### Work with images

1. Click an image on the page.
2. Drag the image to move it. Drag a handle to resize it.
3. Use the buttons on the secondary toolbar: **Crop**, **Replace…**, **Extract…**, **Delete**, **Rotate 90° clockwise**, **Rotate 90° counter-clockwise** and **Opacity**.

You cannot replace a vector graphic with a picture. You cannot extract a vector graphic. You can delete it.

To add a new image, click **Add Image** on the secondary toolbar. Draw a box on the page, or click the page to place the image at its own size.

Every edit can be undone with **Edit > Undo**.

## Annotate and comment

Click **Tools > Comment**. The secondary toolbar shows these modes: **Highlight**, **Freehand Highlight**, **Text**, **Draw**, **Stamp**, **Shape**, **Callout**, **Sticky Note** and **Eraser**.

### Mark text

1. Click **Select** in the toolbar.
2. Select text on the page.
3. In the bar **Mark selected text**, click **Highlight**, **Underline**, **Strikeout** or **Squiggly**. Click **Link** to make the text a link to a web address.

### Place a mark

1. Click a mode on the secondary toolbar, for example **Sticky Note**.
2. Click or draw on the page.
3. The switch **Locked** keeps the mode ready for the next mark. To place one mark only, set the switch to **Unlocked**.

Choose the color from the group **Annotation color**. For **Shape**, choose a shape: **Rectangle**, **Ellipse**, **Line**, **Arrow**, **Polygon**, **Polyline** or **Cloud**. **Freehand Highlight** marks any part of a page with a translucent stroke. This includes scanned pages.

### Stamps

Click **Stamp**. The presets are **APPROVED**, **CONFIDENTIAL**, **DRAFT**, **REJECTED** and **REVIEWED**. Click **New stamp…** to make your own stamp. Click **From image…** to use a picture. A label can contain the words `{date}`, `{time}` and `{name}`. Spectra PDF fills them in when you place the stamp. The name comes from the preference **Identity name**.

### Select and change a mark

Click a mark to select it. The Properties Bar shows its details.

### The list of comments

1. Click **Tools > Comment**. Then click **View > Tools Pane** if the tool pane is closed.
2. In the switch at the top of the pane, choose **Comments**.
3. The list shows every comment of the document. Click a comment to go to it. You can edit its note, recolor it or delete it.

In the **Comments** panel:

- **Delete all comments** removes every comment. Spectra PDF asks you to confirm.
- **Export XFDF…** writes every comment to an XFDF file.
- **Import XFDF…** adds the comments of an XFDF file. You can undo it with `Ctrl+Z`.
- **Summary…** makes a printable PDF of the comments. In the field **Contents**, choose **Comments only** or **Document and comments**. In the field **Comments go**, choose **Beside the page**, **Beneath the page**, **On their own sheets** or **Wherever the page is largest**. You can filter by **Author**, **Type**, **Status** and **Pages**, and you can set the **Order**. The summary ends with a **Reconciliation** that shows how many comments the document holds and how many the summary contains.

## Forms

### Fill a form

1. Click **Tools > Fill & Sign**.
2. Click **Fill Fields** on the secondary toolbar.
3. Click a field on the page and type or choose a value. Some fields calculate their value from other fields.
4. The status bar shows a button that fills the form. It shows the number of fields. Click it to write the values to the document. Click **Clear** to discard the values that are not yet written.
5. Click **File > Save**.

The panel **Fill Form** lists the fields. It is in the tool **Prepare Form**. Click **Tools > Prepare Form**. Then click **View > Tools Pane** if the tool pane is closed. It has the buttons **Fill Form** and **Fill & Flatten**. **Fill & Flatten** writes the values and locks the fields. The text of the setting is **Flatten (lock fields after filling)**.

Forms with static XML (XFA) are filled in both their XML data and their standard fields. A dynamic XML form opens read-only. The panel says so.

### Scripts in forms

Spectra PDF always runs the standard formatting, validation and calculation of a form. It does not run the other scripts of a form at first. To run them, follow these steps:

1. Click **Edit > Preferences…**.
2. Choose the category **Updates & Licenses**.
3. Under **Form field scripts**, select **Run unrecognized field scripts**.

The scripts run in a sandboxed interpreter. It has no access to the network, the file system or printing. An administrator can turn the setting off for the whole computer. The setting is then dim.

### Submit a form

If the form has a Submit button, click it. A consent dialog shows the destination and the exact values that will be sent. **Cancel** sends nothing. Nothing is sent until you choose **Submit**.

### Prepare a flat form

1. Click **Tools > Prepare Form**. Then click **View > Tools Pane** if the tool pane is closed.
2. In the switch at the top of the pane, choose **Detect Form Fields**.
3. In the field **Look at**, choose **The whole document** or **Certain pages**.
4. Click **Detect form fields**. The panel lists the suggested fields.
5. Select the fields to keep. Then click the button that creates them. Its text shows the number of fields. You can click **Check all** or **Uncheck all**.

To add a field by hand, click **Add Field** on the secondary toolbar. Draw a box on the page. In the dialog **New form field**, set the **Name** and the **Type**. The types are **Text**, **Checkbox**, **Radio group**, **Dropdown**, **Option list** and **Signature (empty)**. Click **Create field**.

## Signatures

### Check the signatures of a document

Click **View > Navigation Panels > Signatures**. The panel lists the signatures and tells you:

- **integrity intact** or **integrity BROKEN**.
- If the signature covers the **whole document** or has **partial coverage**.
- If the signer is verified against your trust sources.

By default, no trust source is on. The panel then says that it confirms the cryptographic validity and whether the document changed after signing. It does not confirm who the signer is. To choose trust sources, click **Tools > Fill & Sign**. Click **View > Tools Pane** if the tool pane is closed. Then open the **Signatures** panel. You can add **Trust anchors** with **Add CA certificate…**. You can also turn on **Also trust the system certificate store**, **Also trust the bundled EU trusted lists** and **Also trust the bundled root-program certificates**. All of them are off at first. Click **Re-check** after you change a source.

### Sign a document

1. Click **Tools > Fill & Sign**.
2. Click **Sign** on the secondary toolbar and draw a box on the page. Or open the panel **Signatures** in the tool pane and click **Sign this PDF…**.
3. Choose where the certificate comes from. The choices are **.pfx file**, **PEM key + cert**, **Token (PKCS#11)**, **Windows store** and **Signing service**. The choice **Windows store** is for Windows only. With **Windows store**, the key stays in Windows.
4. Type the password. For a token, the password field is the PIN of the token.
5. Click **Sign & Save…**. Spectra PDF writes the signed copy to a new file. The open file does not change.

The panel **Signatures** has more choices:

- **Sign in place** signs the open document. You can undo it. The signature is written to disk when you save.
- **Sign & Save a copy…** writes a new signed file.
- **Visible signature…** places a visible signature. You draw its box on the page.
- **TSA URL** is the address of a timestamp server. This field is optional.
- **Certify this document** sets what may change in the document after signing. A certification must be the first signature of the document. You cannot certify a document that is already signed.
- **Lock form fields** locks form fields against later change.

When you sign with a signing service, you register Spectra PDF with the service first. The dialog asks for the address of the service and the client ID. The address must start with `https://`.

### Personal signatures

A personal signature is a saved picture of your signature or initials. It is stored only on this computer. It is written into a document only when you place it.

1. Click **Tools > Fill & Sign**.
2. Click **Sign** on the secondary toolbar. The group **My signatures** appears.
3. Click **Create signature…**. If you already have saved signatures, click **Manage signatures…**.
4. The dialog **Personal Signatures** has three tabs: **Draw**, **Type** and **Import**. On **Draw**, draw your signature in the box. On **Type**, type your name and choose a handwriting style. On **Import**, click **Choose image…** and choose a PNG or JPEG image. You can select **Remove the white background**.
5. In the group **Use as**, choose **Signature** or **Initials**.
6. Click **Save signature**.
7. To place it, click its picture in the group **My signatures**. Then click the page.

## Redaction and search

Redaction removes content from the file. Text and images under each marked region are removed from the content of the file. Then Spectra PDF paints a box over the area. The box is black unless you change the color. You can undo the redaction until you save. After you save, you cannot undo it, and the content is gone from the saved file.

### Mark by hand

1. Click **Tools > Redact**.
2. To mark text, drag over it with the pointer. When you release the button, Spectra PDF marks each selected line with one box. The boxes are as tall as the lines. You can also double-click a word or triple-click a line.
3. To mark a picture, a scan, or any area without text, start the drag on an empty part of the page and draw a box. A drag that starts on text selects text. It does not draw a box. To draw a box over text, for example over a picture that has a text layer, hold `Shift` and drag.
4. Each box is labeled **REDACT**. Mark all the places. To remove one mark, click the **×** on the box.
5. In the status bar, click the button that redacts the marked regions. It shows the number of regions.
6. Spectra PDF asks you to confirm. It says that it will permanently remove the content under the regions.
7. Save the document.

The status bar also has the buttons **Save marks** and **Clear**. **Save marks** keeps the marks in the document so you can review them later. Nothing is redacted until you redact the marked regions. **Clear** removes the marks.

### Mark by search

1. Click **Tools > Redact**. Then click **View > Tools Pane** if the tool pane is closed.
2. In the switch at the top of the pane, choose **Search & Redact**.
3. In the field **Search for…**, type the text. You can also use a **Word list** with one term on each line, or choose from the **Patterns**. The patterns are **Credit card number**, **Date**, **Email address**, **IBAN**, **NHS number (UK)**, **Phone number**, **Social insurance number (Canada)**, **Social security number** and **Web address**.
4. In the field **Search**, choose **This document**, **These pages** or **All open documents**.
5. In the field **Each mark covers**, choose **What matched**, **The whole word** or **The whole line**.
6. Click **Search**. Check the results.
7. Click the button that marks the checked results. Its text shows the number of results. If the list says that it is incomplete, narrow the search first. The list stops at 50,000 results.
8. Redact the marks as described above.

If a page has no text that can be searched, the panel says so. A scanned page can have no searchable text. In that case, click **Scan & OCR** in the panel to run OCR. See [Scan and OCR](#scan-and-ocr).

After a redaction, Spectra PDF checks if the redacted text still appears in other places of the file, for example in page labels, article threads, field values or scripts. If it does, the dialog **Redacted text appears elsewhere** lists the places. Click **Remove** to remove the text from them.

### Remove hidden information

1. Click **Tools > Redact**. Then click **View > Tools Pane** if the tool pane is closed.
2. In the switch at the top of the pane, choose **Remove Hidden Information**.
3. The panel lists what the document holds that is not the page you can see. The categories include **Comments and markup**, **Document and page metadata**, **Bookmarks**, **JavaScript** and **Embedded and attached files**.
4. Select the categories to remove.
5. Click the button that removes them. Its text shows the number of categories.

Nothing is removed until you select it and click the button. The panel warns when a removal costs something. Removing tags makes the document inaccessible. Removing the text layer of a scan makes the words impossible to find. You can undo the removal.

### Search without redaction

See [Find](#find) and [Search in all open documents or in a folder](#search-in-all-open-documents-or-in-a-folder).

To search and redact all the PDF files in a folder, click **Tools > Search & Redact Folder…**. See [Batch and guided actions](#batch-and-guided-actions).

## Compare

1. Open both documents.
2. Click **Tools > Compare Files**.
3. In the panel **Compare PDFs**, choose the document in the field **against**. If it is not open, click **Open another PDF…**.
4. Choose **Text** or **Visual**.
5. Click **Compare**.

In **Text** mode, the result shows the lines that were added and removed. In **Visual** mode, the result shows how many page pairs differ. Select a page pair to see the differences. If nothing differs, the panel says that the documents are identical.

## Scan and OCR

### Scan pages

1. Connect the scanner and switch it on.
2. Click **File > Create PDF from Scanner…** to scan into a new document. Or click **Document > Insert Pages > From Scanner…** to add the scanned pages to the open document.
3. In the dialog **Scan**, choose the **Scanner**, the **Source** (**Flatbed**, **Feeder** or **Feeder (both sides)**), the **Resolution**, the **Color** mode and the **Paper** size.
4. Click **Scan**. Click **Scan More** to add pages. Click **Stop** to stop.
5. Select **Straighten and clean up pages** or **Make text searchable** if you want them.
6. Click **Save as PDF**.

If the dialog says **No scanners found.**, check that the scanner is switched on and connected. Then click **Refresh**. A network scanner must be reachable from your computer.

### Make a scanned document searchable

OCR reads the words of a scanned page. Spectra PDF writes them as an invisible text layer. The page looks the same. You can search and select the words.

1. Open the document.
2. Press `Ctrl+F` and type a word. Spectra PDF reads the scanned pages. A message shows how many pages are left to recognize.
3. If the document has scanned pages, a list of languages appears. Choose the language of the scan.
4. Click **Make searchable**. The button writes the recognized text into the scanned pages.
5. Click **Save**. Or click **Copy text** to copy the recognized text to the clipboard.

You can also click **Document > Scan & OCR** or **Tools > Scan & OCR**. This opens the find bar and the pane of the tool.

OCR runs on your computer. It needs Ghostscript.

To select and highlight words on a scanned page, you do not need to run OCR first. Spectra PDF recognizes the words of that page in memory and does not change the file. The preference **Recognize text in scanned pages for selection** turns this on or off. Use **Language to recognize scanned pages in** if the recognition is poor.

### Straighten and clean scans

1. Click **Tools > Scan & OCR**.
2. In the switch at the top of the pane, choose **Enhance Scans**.
3. In the field **Apply to**, choose **This page only** or **The whole document**.
4. Select the corrections: **Straighten (deskew)**, **Detect the orientation**, **Whiten the background** and **Remove specks**.
5. Click **Enhance the scans**.

The panel measures each page first and reports what it will change. It changes only pages that are scans.

### Sheet music

The function **Recognize Music** turns printed sheet music into MusicXML. It needs the separate program Audiveris, which Spectra PDF does not include. Install Audiveris. Then click **Edit > Preferences…**, choose the category **Engine** and set up Audiveris.

### Many files

To make all the PDF files in a folder searchable, see [Batch and guided actions](#batch-and-guided-actions).

## Page tools

Rotate, delete and insert change the pages of the open document. You can undo them with **Edit > Undo**. To keep the changes on disk, click **File > Save**. Split writes new files and does not change the open document.

### Rotate pages

1. Click **Document > Rotate Pages** or press `Ctrl+Shift+R`.
2. In the field **Pages (e.g. 1,3,5-9 or all)**, type the pages.
3. Choose **90 CW**, **90 CCW** or **180**.
4. Click **Rotate**.

### Delete pages

1. Click **Document > Delete Pages** or press `Ctrl+Shift+D`.
2. In the field **Pages to delete (e.g. 2,4,6-8)**, type the pages.
3. Click **Delete Pages**.

### Split a document

1. Click **Document > Split by Range**.
2. In the field **Split by**, choose **Page ranges**, **Number of pages**, **File size** or **Top-level bookmarks**.
3. Fill in the field for the mode that you chose: **Page ranges (e.g. 1-5,10-15)**, **Pages per file** or **Maximum size per file (MB)**.
4. Click **Split**.
5. For **Page ranges**, choose a file name. For the other modes, choose a folder.

Splitting writes new files. The open document does not change. If one page is larger than the maximum size, Spectra PDF writes it to a file of its own and reports it.

### Insert pages

- **Document > Insert Pages > From File…** (`Ctrl+Shift+I`) adds the pages of another file.
- **Document > Insert Pages > From Scanner…** adds scanned pages.
- **Document > Insert Pages > Blank Page** (`Ctrl+Shift+T`) adds a blank page.

### Combine files

1. Click **Document > Combine Files…**.
2. Click **Add Files…** and choose the files. Anything that is not a PDF is converted when you add it. Click **Add Blank Page** to add a blank page.
3. Drag the files to set the order. In the page field of each file, type the pages to take.
4. In the field **Put the combined pages in**, choose **A new PDF** or **A document that is already open**.
5. Click **Combine…**.

### Reorder pages

Drag the page thumbnails in the page grid or in the navigation panel **Pages**. See [The page grid](#the-page-grid).

### Page labels

Page labels set the number that is shown for each page, for example `i, ii, iii` for the front matter and `1, 2, 3` for the body.

1. Click **Tools > Page Labels**.
2. Click **+ Add range**.
3. In the field **From page**, type the first page of the range. Set the **Style**, the **Prefix** and **Start at**.
4. The **Preview:** line shows the result.
5. Click **Apply**.

Each range runs until the next range starts. With no ranges, the pages have plain numbers.

### Page boxes and cropping

1. Click **Tools > Crop & Page Boxes**.
2. In the field **Box to edit**, choose **Crop box (visible page)**, **Bleed box**, **Trim box** or **Art box**.
3. Draw a rectangle on the page to set the area to keep. Or type the insets for **Left**, **Right**, **Top** and **Bottom**.
4. In the field **Pages (e.g. 1,3,5-9 or all)**, type the pages.
5. Click **Apply**.

Cropping hides content. It does not delete content. The panel **Remove white margins** has the button **Find content** and the button **Crop to content**. They measure what each page draws and set the box around it.

### Headers, footers and watermarks

- **Tools > Header & Footer** puts text in six positions: **Top left**, **Top center**, **Top right**, **Bottom left**, **Bottom center** and **Bottom right**. The text can contain the tokens `{page}` (page number), `{pages}` (total pages) and `{bates}` (Bates number). Leave a box empty to skip it. Set **Bates start** and **Bates digits** for Bates numbers.
- **Document > Watermark** stamps text, an image or a PDF page. Set **Position**, **Angle (°)**, **Opacity**, and choose **Over content** or **Behind content**.

## Compress, optimize, PDF/A and preflight

These tools are in the tool **Optimize**. Click **Tools > Optimize**. Choose the function in the switch at the top of the pane. The functions that write a new file ask for a file name. The name proposed has a suffix, for example `report_compressed.pdf`. The open document does not change.

Ghostscript is needed for **Compress**, **Convert to Grayscale** and **Convert to PDF/A**.

### Compress

1. Choose **Compress**.
2. Choose a preset: **Screen (72 dpi, smallest)**, **Ebook (150 dpi)**, **Printer (300 dpi)**, **Prepress (300 dpi, highest)** or **Custom DPI**. For a scan, choose **Scanned document (MRC)**.
3. To optimize the result as well, select **Then optimize the result**.
4. Click **Compress**.
5. Choose the file name.

The result line shows the size before and after.

With **Scanned document (MRC)**, choose a **Scan preset**: **Smallest**, **Balanced** or **Archival**. **Smallest** can change the shapes of letters. With **Archival**, no character is replaced by another. Select **Verify the text after compressing** to keep the original scan on any page where the words did not survive. This is slower.

### Optimize

1. Choose **Optimize PDF**.
2. Select what you want: **Linearize (web-optimize)**, **Compress object streams** and **Strip metadata**.
3. Click **Optimize**.
4. Choose the file name.

The section **Where the space goes** lists every category of the file, for example **Images** and **Fonts**, with its size. The largest row is the setting that is worth changing.

### Convert to grayscale

Choose **Convert to Grayscale**. Click **Convert to Grayscale**.

### Convert to PDF/A

1. Choose **Convert to PDF/A**.
2. In the field **Conformance Level**, choose a level.
3. Click **Convert to PDF/A**.
4. Choose the file name.

The conversion writes the conformance claim and reads it back. Spectra PDF does not check if the file meets the standard. No validator runs.

### Set the PDF version

Choose **Set PDF Version**. Choose the **Target Version**. Click **Set Version**.

### Preflight

Preflight checks if a file is ready to print.

1. Click **Tools > Print Production**.
2. In the switch at the top of the pane, choose **Preflight**.
3. In the field **Profile**, choose a profile: **Office print**, **Digital printing**, **Large format**, **Newsprint**, **Sheetfed offset (CMYK)**, **Web offset, heatset**, **PDF/X-1a:2001**, **PDF/X-3:2002** or **PDF/X-4**.
4. The panel analyzes the document at once. It shows a report. The report groups the checks as **Color**, **Content**, **Document**, **Fonts**, **Images**, **Metadata** and **Pages**. The summary line shows how many checks passed, failed, can be improved or need review.
5. Click **Re-run** to check again.
6. Click **Export report…** to save the report.

The report states which of 38 checks the document passes against the profile. It is not a certificate of conformance.

If a profile carries repairs for what failed, the button **Fix what this profile can** applies them. You can edit a profile. Spectra PDF saves the edit as a copy. The profiles that come with the program are not changed.

## Encrypt and decrypt

These functions are in the tool **Protect**. Click **Tools > Protect**. Both functions write a new file. The open document does not change.

### Add a password

1. Choose **Encrypt PDF**.
2. Choose **Password** or **Certificates**.
3. For **Password**:
   1. In **User password (to open)**, type the password that readers need to open the file. If you leave it empty, the file opens without a password.
   2. In **Owner password (to edit/print)**, type the password that lifts the restrictions. If you leave it empty, it is the same as the user password. To restrict printing, editing or copying, you must set an owner password.
   3. Under **Allowed for readers (owner password bypasses these)**, select what readers may do: **Printing**, **Changing the document**, **Copying text and graphics**, **Commenting and filling form fields**.
4. For **Certificates**, click **Add certificate…** to add the certificate of each recipient. Anyone who holds the private key of a listed certificate can open the file. No shared password is needed.
5. Click **Encrypt**.
6. Choose the file name.

The restrictions work only with an owner password. Screen-reader access to the text is always allowed.

### Remove a password

1. Open the encrypted file and type its password.
2. Choose **Decrypt PDF**.
3. In the field **Password**, type the owner password of the document. If the file has an owner password, the user password is not enough.
4. Click **Decrypt**.
5. Choose the file name.

## Print

1. Click **File > Print…** or press `Ctrl+P`.
2. Set the options below.
3. Check the **Preview** on the right. Use **Previous sheet** and **Next sheet** to look at the sheets. The preview shows the first 8 sheets.
4. Click **Print**.

Printing needs Ghostscript. Spectra PDF applies pending page edits when the dialog opens.

### Printer and pages

| Option | What it does |
|---|---|
| **Printer** | The list of printers on your computer. |
| **Pages** | All pages (the list shows the number), or only the pages that you type in the field **Pages:**, for example `1-3, 5`. |
| **All pages in range**, **Odd pages only**, **Even pages only** | Prints only the odd or only the even pages of the range. |
| **Reverse order** | Prints the last page first. |
| **Copies** | The number of copies, from 1 to 999. |
| **Collate** | Keeps the pages of each copy together. It is dim when **Copies** is 1. |

### Layout

In the group **Page sizing & layout**, open the list and choose one of these:

- **Size**: Choose **Fit to paper**, **Actual size** or **Custom scale**. For **Custom scale**, type a percent from 1 to 1000.
- **Multiple pages per sheet**: In **Grid**, choose the number of rows and the number of columns. Each can be from 1 to 4. In the list of page order, choose **Across, then down**, **Across (right to left)**, **Down, then across** or **Down (right to left)**. Select **Page borders** to draw a border around each page. **Auto-rotate pages** is on at first.
- **Booklet**: It puts two pages on each landscape sheet in saddle order. Choose **Both sides**, **Front sides only** or **Back sides only**. Choose **Left binding** or **Right binding**. Spectra PDF fixes the orientation to **Landscape** for a booklet. If **Two-sided** is on **Printer default** and the printer can print two-sided, a booklet prints with **Flip on short edge**.
- **Poster (tile large pages)**: Spectra PDF prints a large page on several sheets. Set **Tile scale** (a percent from 1 to 2000) and **Overlap** (in points). Select **Cut marks** and **Labels** if you want them.

### Paper, orientation, two-sided and color

| Option | Choices |
|---|---|
| **Orientation** | **Auto**, **Portrait**, **Landscape**. |
| **Paper size** | **Printer default**, or one of the sizes that the printer reports. |
| **Two-sided** | **Printer default**, **One side only**, **Flip on long edge**, **Flip on short edge**. |
| **Color** | **Printer default**, **Color**, **Grayscale**. |
| **Comments & forms** | **Document and markups**, **Document only**, **Document and stamps**. |

The list **Two-sided** appears only if the printer can print on both sides. For a black-and-white printer, the program shows **Black & white printer** instead of the list **Color**.

Select **Print as image** to send each page as a picture. Choose the resolution: 150 dpi, 300 dpi or 600 dpi.

### Print to a PDF with the Spectra PDF printer

You can add a printer called Spectra PDF to your computer. Programs then list it in their print dialog. Only the Windows account that installed the printer can print to it. When you print to it, the pages open in Spectra PDF as a new PDF.

1. Click **Edit > Preferences…**.
2. In the category **General**, find **Print to Spectra PDF**.
3. Click **Install printer…**. Windows asks for administrator approval, because printers are system devices.
4. To remove the printer, click **Remove printer…**.

On Windows, Spectra PDF receives the jobs only while it is running. A minimized program in the tray counts as running. A job that you print while Spectra PDF is closed waits in the print queue.

## Export to Office and image formats

Click **File > Export**. Then choose a format. Each choice asks for a file name.

| Menu path | Result |
|---|---|
| **File > Export > Word (.docx)…** | A Word document. |
| **File > Export > Rich Text (.rtf)…** | A Rich Text file. |
| **File > Export > OpenDocument (.odt)…** | An OpenDocument text file. |
| **File > Export > Web Page (.html)…** | A web page. |
| **File > Export > XHTML (.xhtml)…** | An XHTML page. |
| **File > Export > Plain Text (.txt)…** | A text file. |
| **File > Export > Spreadsheet (.xlsx)…** | A spreadsheet with the tables of the document. |
| **File > Export > Presentation (.pptx)…** | A presentation with one slide for each page. |
| **File > Export > Images (PNG/JPEG/TIFF)…** | One picture for each page, or one TIFF file. |
| **File > Export > Extract Text** | Opens the panel **Extract Text**. |

The Word, Rich Text, OpenDocument, web page and XHTML exports use LibreOffice, which is part of the program. Your computer does not need LibreOffice.

If the document does not allow copying its content, Spectra PDF dims these items.

### Plain text

In the dialog **Export as Plain Text**, type the **Pages (e.g. 1,3)**. Leave the field empty for all pages. In the field **Text order**, choose **Preserve the page layout** or **Reading order**. Select **Separate pages with a page break** if you want it. Click **Export…**.

### Spreadsheet

In the dialog **Export as a Spreadsheet**, choose **One sheet per page** or **One sheet per table** in the field **Sheets**. Select **Add a sheet with the text outside the tables** if you want it. Click **Review tables…** to see the tables on the page and adjust them before the spreadsheet is written. Click **Export…**.

### Presentation

In the dialog **Export as a Presentation**, choose the **Slide size**: **Standard (4:3)**, **Widescreen (16:9)** or **The document's own page size**. Click **Export…**. The presentation export needs Ghostscript.

### Images

In the dialog **Export Pages as Images**, choose the **Format**: **JPEG — one image per page**, **PNG — one image per page** or **TIFF — single multi-page file**. Choose the **Resolution**. Type the **Pages (e.g. 1-3,5)**. Select **Grayscale** if you want it. Click **Export…**.

### Extract text

Click **File > Export > Extract Text** or **Document > Extract Text**. In the field **Pages (e.g. 1,3 or all)**, type the pages. Click **Extract**. Then click **Copy** or **Save as .txt**.

### Send by email

Click **File > Send To > Email…**. Spectra PDF gives the current document to your mail client as an attachment. The mail client shows its own compose window. Spectra PDF does not send the message.

## Batch and guided actions

### Guided actions

A guided action is a saved sequence of steps. You run it on the open document with one click.

1. Click **Tools > Guided Actions**.
2. Click **New action…**.
3. Type a name in the field **Action name**.
4. Click **Add step** and choose a step. The steps include **Compress**, **Watermark**, **Convert to PDF/A**, **Header & Footer**, **Search & Redact**, **Strip Metadata**, **Remove Hidden Information**, **Make Searchable (OCR)** and **Encrypt to a new file**.
5. For each step, set its values. Click **Ask** to be asked for a value each time the action runs.
6. Click **Save action**.
7. To run it, select the action and click **Run**.

Each step is one undo. If a step fails, the action stops at that step. The earlier steps stay applied.

You can **Duplicate**, **Edit**, **Delete**, **Export…** and **Import…** an action. An exported action is a file. You can share it.

To run an action on every PDF in a folder, click **Folder…**. Spectra PDF leaves the originals as they are and writes copies into the destination folder. Click **In place…** to replace the originals. The warning says: **Replaces the originals — no undo.**

### Folder tools

The folder tools are in the **Tools** menu. Each one reads files by their path. None of them uses your open documents. Most of them write the results to a destination folder.

| Menu path | What it does |
|---|---|
| **Tools > Batch OCR Folder…** | Makes the scanned PDF files of a folder searchable. |
| **Tools > Search & Redact Folder…** | Searches and redacts the PDF files of a folder. |
| **Tools > Prepare Forms in a Folder…** | Analyzes the files of a folder as forms. It can also write the prepared forms in place. |
| **Tools > Export a Folder…** | Exports every file to a format. Originals are never changed. |
| **Tools > One PDF per Folder…** | Makes one PDF from each folder that holds files. Sources are never modified. |
| **Tools > Preflight a Folder…** | Measures every PDF of a folder against one print profile. It writes nothing to the folder it reads. |
| **Tools > Scheduled Batch Runs…** | Runs a batch on a schedule, also when Spectra PDF is closed. |
| **Tools > Watched Folders…** | Runs a saved guided action on every PDF that arrives in a folder. |

### Batch OCR

1. Click **Tools > Batch OCR Folder…**.
2. In **Source folder**, choose the folder that holds the PDF files.
3. In **Destination folder**, choose a different folder. The destination must be outside the source folder.
4. Choose the **Recognition languages**.
5. Select the options that you want:
   - **Straighten and clean scans before recognition**.
   - **Compress scans after recognition (MRC)**.
   - **Try to repair damaged files**.
   - **Repair only (no OCR)**.
6. Click **Start**. Use **Pause** and **Resume**, or **Stop**.

Spectra PDF copies the whole folder tree into the destination. Scanned pages get an invisible text layer. Files that are already searchable are copied unchanged. Files that cannot be processed are reported.

The source folder is never changed unless you choose **Replace the originals in place (no destination folder)**. Spectra PDF then replaces each original with a checked copy. The dialog warns that there is no undo. An in-place run cannot pause. Use **Stop**.

Each run writes a log file. See [Settings, language and updates](#settings-language-and-updates).

### Scheduled runs and watched folders

- **Scheduled Batch Runs…** uses Windows Task Scheduler on Windows and systemd user timers on Linux. A schedule runs also when Spectra PDF is closed. An action that asks for values when it runs cannot be scheduled.
- **Watched Folders…** watches an intake folder. Processed copies go to the destination. The originals move to the processed folder. Watching runs while Spectra PDF is open. A minimized program in the tray counts as open.

## Settings, language and updates

### Preferences

Click **Edit > Preferences…** or press `Ctrl+K`. The categories are:

- **General**: Identity name, snapshot resolution, spelling underline while editing, recognition of scanned pages for selection, default compression quality, default scan (MRC) preset, single-key shortcuts, batch OCR logs, the Spectra PDF printer and the File Explorer commands.
- **Viewing**: How a document opens: **Zoom**, **Page layout**, **Scrolling**, and **Use the document’s own initial view when it has one**. A document that you opened before opens with the view you left.
- **Appearance**: **Theme** and **Language**.
- **Engine**: The location of Ghostscript and of Audiveris.
- **Tray & Startup**: **Minimize to system tray on close**, **Start minimized to tray**, **Start with Windows** and **Reopen last session on launch**.
- **Updates & Licenses**: Updates and form field scripts.

### Single-key shortcuts

The setting **Use single-key accelerators to access tools** is off at first. When it is on, `H` is Hand, `V` is Select, `U` is Highlight, `X` is Text, `D` is Draw, `K` is Stamp, `S` is Sticky Note, `Z` is Marquee Zoom and `E` opens the Edit tool.

### Theme

In **Appearance**, set **Theme** to **System**, **Dark**, **Light** or **High contrast**. The default is **System**. If a Windows contrast theme is on, the system colors are used and **Theme** has no effect. Documents keep their own colors.

### Language

1. Click **Edit > Preferences…**.
2. Choose the category **Appearance**.
3. In the field **Language**, choose a language. The first choice is **System default**.

The interface changes at once. The messages and the saved reports are also translated.

### Ghostscript

Ghostscript is a separate program that Spectra PDF runs for some functions. Click **Edit > Preferences…** and choose the category **Engine**. The panel shows if Ghostscript is **Ready** or **Not set up**, and where it is. To use another copy, click **Choose Ghostscript…**. Click **Check again** after you change it. The setting **Tell me at startup when Ghostscript is missing** controls the message at startup.

These functions use Ghostscript: Compress, Grayscale, PDF/A and PDF/X, printing, page rasterization and image export, visual comparison, OCR and scan enhancement, transparency flattening, Rebuild, and PostScript conversion.

### Updates

In the category **Updates & Licenses**, two settings control updates:

- **Check for updates automatically** is on at first. Spectra PDF looks for a new release when it starts.
- **Install updates automatically** is on at first. On Windows, Spectra PDF downloads a new release, checks its signature, and installs it when you exit. You can click **Restart now** to install it at once. If you turn this setting off, nothing is downloaded until you click **Install update**.

To check by hand, click **Help > Check for Updates**. The messages include Update available, **You’re up to date.** and **Update ready — restart to install it.** The button **View release** opens the release page. The button **Dismiss** closes the message.

On Linux, Spectra PDF only shows a notice that opens the download page. It does not install updates.

If an administrator turned off updates for the computer, the update settings are dim. The settings page says: **Turned off for this machine by policy — these settings have no effect.** The update message says: **Updates are managed by your organization.**

### Batch logs

In **General**, the group **Batch OCR logs** has the setting **Write a log file for each batch run**. Set **Keep logs for** to 7 days, 30 days, 90 days, 1 year or **Keep forever**. Click **Open log folder** to see the logs.

### Other settings

- **Minimize to system tray on close** keeps the program running in the tray when you close the window.
- **Reopen last session on launch** opens the windows and documents that were open when you quit. The size and position of the window are always remembered.
- **Show Spectra PDF commands in the File Explorer context menu** adds the commands Convert to PDF and Combine into one PDF to the right-click menu of files in Windows.

## Troubleshooting

### A file will not open

1. Read the message. The dialog **Could Not Open** gives the reason.
2. If the dialog **Password Required** appears, type the password. If the message says **Incorrect password. Please try again.**, type it again.
3. If the message **Open in Another Window** appears, the file is open in another window of Spectra PDF. Click **Show that window**.
4. If the message says that a run is writing to the folder, wait until the run stops. Then open the file again.
5. If the file is badly damaged, Spectra PDF refuses it and names the file. A file with a broken page table can open and show no pages. The repair functions of the tool **Repair** work on an open document. To repair a file that will not open, use **Tools > Batch OCR Folder…**. Put the file in a folder. Select **Repair only (no OCR)**. Choose a destination folder. Click **Start**. Spectra PDF repairs the file and writes it to the destination.
6. For an address on the web, check that it has no spaces and no user name or password. Spectra PDF refuses a link that sends you to another site. It also refuses files over 64 MB.

### A function says that it needs Ghostscript

1. Read the message in the panel or in the print dialog.
2. Click **Set up Ghostscript**. Preferences opens on the category **Engine**.
3. Click **Choose Ghostscript…** and choose a Ghostscript program of version 10.0 or newer. Or, on Windows, install Spectra PDF again. The Windows installer includes Ghostscript.
4. Click **Check again**.

### A print comes out wrong

Check each setting in the print dialog. The **Preview** shows the sheets.

- The paper is wrong. Set **Paper size**. **Printer default** uses the paper that the printer has set.
- The page is cut off or too small. Set **Fit to paper**, **Actual size** or **Custom scale** under **Size**.
- The back of a two-sided sheet flips on the wrong edge. The list **Two-sided** sets the edge where the sheet flips. Choose **Flip on long edge** or **Flip on short edge** to match how you bind the pages.
- The list **Two-sided** is not there. The list shows only when the printer can print on both sides.
- Comments are missing, or you do not want them. Set **Comments & forms**.
- The print is gray, not color. Set **Color** to **Printer default** or **Color**.
- The page order is wrong. Check **Reverse order** and the page order of **Multiple pages per sheet**.
- The button **Print** is dim. The dialog shows the reason in red, for example an invalid page range, an invalid number of copies or an invalid scale. If no printer is listed, the dialog says **No printers are installed.** If the dialog says **Needs the printer's paper size — options unavailable**, Spectra PDF cannot read the paper sizes of that printer. Choose another printer.
- Printing needs Ghostscript. See the section above.

### The engine does not start

The document engine is a program inside the Spectra PDF installation. While it starts, the message **Starting the document engine…** appears. If an operation fails with a message that begins with **Failed to start engine** or says **The document engine stopped before completing the operation.**, do these steps:

1. Close Spectra PDF.
2. Start Spectra PDF again.
3. If the message returns, install Spectra PDF again. The engine is part of the installer.

If the AppImage does not start on Linux, check that FUSE is installed. Or start the AppImage with `--appimage-extract-and-run`. The AppImage needs a writable `/tmp` folder.

### A feature is dim

- The document may not allow it. The message says: This document does not allow that action.
- The tool may need an open document. Open a file first.
- A document that is signed or certified can limit the edits. See [Open, save and the working copy](#open-save-and-the-working-copy).

## Glossary

| Term | Meaning |
|---|---|
| Annotation | A mark on a page that is not part of the page content. Highlights, notes, stamps and drawings are annotations. This guide also calls them comments. |
| Bates number | A number that Spectra PDF puts on each page with the tool Header & Footer. You set the first number and the number of digits. |
| Bookmark | An entry in the panel Bookmarks that goes to a page when you click it. |
| Certification | A first signature that sets what may change in the document later. |
| Document engine | The part of Spectra PDF that reads and writes PDF files. It is inside the installation. |
| Flatten | Write the values of a form into the page and lock the fields. |
| Ghostscript | A separate program that Spectra PDF runs for some functions, such as printing and compression. |
| Guided action | A saved sequence of steps that you run with one click. |
| OCR | Optical character recognition. Spectra PDF reads the words of a scanned page and writes them as an invisible text layer. |
| Owner password | The password that lifts the restrictions that you set on a document. |
| Page grid | The view that shows each open document as a strip of page thumbnails. |
| PDF/A | A level that a PDF file can claim. The tool Convert to PDF/A writes the claim for the level that you choose. |
| Preflight | A set of checks that tell you if a file is ready to print. |
| Redaction | The permanent removal of content from a file. |
| Tool pane | The pane at the right of the window that shows one tool. |
| User password | The password that a reader types to open an encrypted document. |
| Working copy | The temporary copy of a file that Spectra PDF edits. The original file changes only when you save, or when you move the document to a new window. |
