// Chrome strings that live in JSX/dynamic code rather
// than in the COMMANDS/MENUS tables. ONE typed record, so the tChrome
// helpers are compile-time key-safe and the en catalog stays GENERATED
// (the i18n-catalog gate merges this record with the tables —
// hand-editing locales/en/chrome.json remains impossible by
// construction).
//
// Keys are stable semantic ids; values are the English copy. Plural
// messages carry i18next's `_one`/`_other` suffix pairs and are used via
// `tChromeCount(base, count)`; interpolations use `{{name}}` placeholders
// (concatenated fragments are banned — word order differs per language).
// A leaf data module (no component imports), the navpanels.ts pattern.
export const CHROME_STRINGS = {
  'chrome.menu.noRecentFiles': 'No Recent Files',
  'chrome.menu.noOpenDocuments': 'No Open Documents',
  'chrome.status.barLabel': 'Document status bar',
  'chrome.status.fillFields_one': 'Fill {{count}} field',
  'chrome.status.fillFields_other': 'Fill {{count}} fields',
  'chrome.status.filling': 'Filling…',
  'chrome.status.redactRegions_one': 'Redact {{count}} region',
  'chrome.status.redactRegions_other': 'Redact {{count}} regions',
  'chrome.status.redacting': 'Redacting…',
  'chrome.status.saveMarks': 'Save marks',
  'chrome.status.savingMarks': 'Saving…',
  'chrome.status.saveMarksTitle':
    'Save the pending marks into the document to revisit later (nothing is redacted yet)',
  'chrome.status.clear': 'Clear',
  'chrome.status.clearFormsTitle': 'Discard all pending form values',
  'chrome.status.clearMarksTitle': 'Clear all pending redaction marks',
  'chrome.status.applyChanges': 'Apply changes',
  // One engine serves every window, strictly serially, so a run started in
  // another window is why this one's next operation waits.
  'chrome.status.otherWindowBusy': 'Another window is working',
  'chrome.status.otherWindowBusyTitle':
    'One processing engine is shared between windows — this window’s next operation runs when the other finishes',
  'chrome.status.comments': 'Comments',
  'chrome.status.commentsTitle': 'Show annotation notes',
  'chrome.status.currentPage': 'Current page',
  'chrome.status.pageLabelHint': 'Type a page label (i, iv, A-1) or a sheet number',
  'chrome.status.pageNumberHint': 'Type a page number',
  'chrome.status.sheetOfTotal': '({{sheet}} of {{total}})',
  'chrome.status.ofTotal': '/ {{total}}',
  // Snapping. The status bar is the docked home for
  // never-invisible view state, so the master toggle and its options popover
  // live there; `View ▸ Snapping` mirrors the toggle in the menu table. `px`
  // is notation, identical in every locale (the measure-unit rule), so it
  // carries no key of its own.
  'chrome.status.snap': 'Snap',
  'chrome.status.snapTitle': 'Snap to page geometry while drawing',
  'chrome.status.snapHint': 'Hold Alt to suspend · Tab to cycle targets',
  'chrome.status.snapOptions': 'Snap options',
  'chrome.status.snapTypes': 'Snap to',
  'chrome.status.snapRadius': 'Radius',
  // Slice B: the angle increment and the grid live in the same popover, so
  // the whole drafting-aid set is configured in one place. Unit SYMBOLS (in,
  // ft, °) stay notation and carry no keys; the grid's unit is a <select>
  // over those symbols, and its label is what localizes.
  'chrome.status.snapAngle': 'Angle step',
  'chrome.status.snapAngleTitle':
    'Hold Shift while dragging to hold the segment to this angle',
  'chrome.status.snapGridTitle': 'Grid',
  'chrome.status.snapGridShow': 'Show grid',
  'chrome.status.snapGridSpacing': 'Spacing',
  'chrome.status.snapGridUnit': 'Grid unit',
  'chrome.status.snapGridScaled': 'Drawing scale',
  'chrome.status.snapGridScaledTitle':
    'Read the spacing in the measuring scale’s real-world units instead of paper units',
  'chrome.status.zoom': 'Zoom',
  'chrome.status.zoomOut': 'Zoom out',
  'chrome.status.zoomIn': 'Zoom in',
  'chrome.status.fit': 'Fit',
  'chrome.status.fitTitle': 'Fit to view',
  'chrome.status.toOrganizer': 'Switch to the page organizer',
  'chrome.status.toReading': 'Switch to the reading view',
  'chrome.status.organize': 'Organize',
  'chrome.status.read': 'Read',
  'chrome.tabs.home': 'Home',
  'chrome.tabs.closeFile': 'Close {{name}}',
  'chrome.tabs.allOpenDocuments': 'All open documents',
  'chrome.toolbar.mainLabel': 'Main toolbar',
  'chrome.toolbar.titleWithShortcut': '{{title}} ({{shortcut}})',
  'chrome.toolbar.customize': 'Customize Toolbar…',
  'chrome.home.title': 'Home',
  'chrome.home.subtitle': 'Open a document to start, or pick a tool below.',
  'chrome.home.openPdf': 'Open a PDF',
  'chrome.home.combineFiles': 'Combine files',
  'chrome.home.createPdf': 'Create PDF',
  'chrome.home.batchOcr': 'Batch OCR',
  'chrome.home.dropHint': 'Drop PDF files anywhere to open them',
  'chrome.home.recentFiles': 'Recent files',
  'chrome.home.clear': 'Clear',
  'chrome.home.noRecents': 'No recent files yet — anything you open shows up here.',
  'chrome.home.allTools': 'All tools',
  'chrome.recent.open': 'Open',
  'chrome.recent.reveal': 'Show in folder',
  'chrome.recent.copyPath': 'Copy full path',
  'chrome.recent.revealFailed': 'That file could not be shown — it may have been moved or deleted.',
  'chrome.recent.today': 'Today {{time}}',
  'chrome.recent.yesterday': 'Yesterday {{time}}',
  'chrome.prefs.language': 'Language',
  'chrome.prefs.languageSystem': 'System default',
  'chrome.search.placeholder': 'Search tools and text',
  'chrome.search.ariaLabel': 'Search tools and document text',
  'chrome.search.noMatch': 'No tools or text match “{{query}}”.',
  'chrome.search.tools': 'Tools',
  'chrome.search.inThisDocument': 'In this document',
  'chrome.search.inOpenDocuments': 'In open documents',
  'chrome.search.openFirst': 'Open a PDF first',
  'chrome.empty.openToStart': 'Open a PDF to get started',
  'chrome.empty.openPdf': 'Open PDF',

  // ── Keyboard-shortcut display ────────────────────────────────────────
  // The shortcut a menu row, a toolbar tooltip or the presentation exit
  // shows. Only the MODIFIER and the NAMED keys localize — a letter key is
  // the letter on the reader's own keyboard, and '+' is the chord separator
  // every Windows locale writes (Ctrl+Mayús+S), so it stays notation in the
  // joiner rather than becoming a one-character catalog key.
  'shortcut.ctrl': 'Ctrl',
  'shortcut.shift': 'Shift',
  'shortcut.key.delete': 'Del',
  'shortcut.key.backspace': 'Backspace',
  'shortcut.key.tab': 'Tab',
  'shortcut.key.escape': 'Esc',
  'shortcut.key.space': 'Space',

  // The effective-resolution summary. Shared copy: Properties ▸ Advanced and
  // the Compress panel render the same component, so a document cannot be
  // described one way in one place and another way in the other.
  'imageres.title': 'Images',
  'imageres.loading': 'Measuring the images in this document…',
  'imageres.failed': 'The images in this document could not be measured.',
  'imageres.none': 'This document draws no images.',
  'imageres.count_one': '{{count}} image',
  'imageres.count_other': '{{count}} images',
  'imageres.single': '{{images}} at {{dpi}} DPI',
  'imageres.range': '{{images}} from {{min}} to {{max}} DPI, median {{median}}',
  'imageres.unmeasured': 'Not measurable: {{unmeasured}}',
  'imageres.scanned': 'Scanned document — {{scanned}} of {{pages}} pages classify as scans.',
  'imageres.scanPages': '{{scanned}} of {{pages}} pages classify as scans.',
} as const;

export type ChromeKey = keyof typeof CHROME_STRINGS;

/** The base ids of the plural pairs above (use with tChromeCount). */
export type ChromePluralKey = {
  [K in ChromeKey]: K extends `${infer B}_one` ? B : never;
}[ChromeKey];
