// N12 (brief 37) — chrome strings that live in JSX/dynamic code rather
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
  'chrome.status.comments': 'Comments',
  'chrome.status.commentsTitle': 'Show annotation notes',
  'chrome.status.currentPage': 'Current page',
  'chrome.status.pageLabelHint': 'Type a page label (i, iv, A-1) or a sheet number',
  'chrome.status.pageNumberHint': 'Type a page number',
  'chrome.status.sheetOfTotal': '({{sheet}} of {{total}})',
  'chrome.status.ofTotal': '/ {{total}}',
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
} as const;

export type ChromeKey = keyof typeof CHROME_STRINGS;

/** The base ids of the plural pairs above (use with tChromeCount). */
export type ChromePluralKey = {
  [K in ChromeKey]: K extends `${infer B}_one` ? B : never;
}[ChromeKey];
