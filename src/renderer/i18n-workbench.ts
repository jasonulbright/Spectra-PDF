// N12 slice B (brief 37) — the WORKBENCH chrome's strings: the right tool
// dock and its all-tools list, the left nav pane and its panels, the shared
// page context menu, and App's confirm/notice MESSAGES. Fourth typed record
// after i18n-chrome.ts (slice A chrome), i18n-panels.ts (dock panels) and
// i18n-dialogs.ts (chrome dialogs); same contract throughout — the record
// carries the English, the en catalog is GENERATED from it by
// tests/i18n-catalog.test.ts, every shipped locale's key set must equal en's
// exactly, and a surface is either FULLY threaded or not started.
//
// What is NOT here, deliberately:
//   • TOOL TITLES and OPERATION TITLES. Every tool and every operation
//     already names a COMMAND (`tools.open.<id>` / `tools.panel.<op>`) whose
//     title is generated into `cmd.*`, so the dock reads THOSE keys through
//     tToolTitle/tOperationTitle. A second copy would let the menu and the
//     dock disagree about a tool's name in one language — the exact failure
//     `commands/tools.ts` exists to prevent in English.
//   • Tool DESCRIPTIONS and NAV-PANEL titles: data tables with no command, so
//     the catalog gate derives `tool.desc.*` / `navpanel.*` from them, the way
//     it derives the toolbar groups and the guided-action steps.
export const WORKBENCH_STRINGS = {
  // ── The right tool dock (Phase 10 slice B1) ───────────────────────────
  'dock.paneLabel': 'Tool pane',
  'dock.resize': 'Drag to resize',
  'dock.allTools': 'All tools',
  // The back affordance carries its chevron INSIDE the key: a leading glyph
  // is part of the phrase's direction, so the translator places it.
  'dock.backLabel': '‹ All tools',
  'dock.backTitle': 'Back to the open tool',
  'dock.backAria': 'Back to all tools',
  'dock.close': 'Close the tool pane',

  // ── The all-tools grid (ToolsCenter) ──────────────────────────────────
  'tools.heading': 'Tools',
  'tools.sub': 'Choose what you want to do with your document.',
  'tools.openFirst': 'Open a PDF first',

  // ── The left nav pane (Phase 4 M3) ────────────────────────────────────
  'nav.resize': 'Drag to resize',
  'nav.common.noDocument': 'No document open.',

  'nav.pages.aria': 'Page thumbnails',

  'nav.bookmarks.loading': 'Loading bookmarks…',
  'nav.bookmarks.empty': 'No bookmarks yet.',
  'nav.bookmarks.truncated': 'Outline truncated (too many bookmarks)',
  'nav.bookmarks.saving': 'Saving…',
  'nav.bookmarks.dragHandle': 'Drag to reorder / nest',
  // The name a NEW bookmark is born with. It is written into the document,
  // not just shown — which is exactly why it localizes: an author working in
  // Spanish is naming their own outline, and the placeholder that echoes it
  // has to read the same key or the two would disagree on screen.
  'nav.bookmarks.untitled': 'Untitled',
  'nav.bookmarks.jumpToPage': 'Jump to page {{page}}',
  'nav.bookmarks.noTargetPage': 'No target page',
  'nav.bookmarks.targetPage': 'Target page',
  'nav.bookmarks.addChild': 'Add child bookmark',
  'nav.bookmarks.delete': 'Delete bookmark (and children)',
  'nav.bookmarks.add': '+ Add bookmark',

  'nav.find.matchCase': 'Match case',
  'nav.find.wholeWord': 'Whole word',
  'nav.find.regex': 'Use regular expression',

  'nav.search.placeholderOpen': 'Search all open documents',
  'nav.search.placeholderDisk': 'Search PDFs in a folder',
  'nav.search.scopeOpen': 'Open documents',
  'nav.search.scopeDisk': 'On disk',
  'nav.search.chooseFolder': 'Choose folder…',
  'nav.search.chooseFolderDialog': 'Choose a folder to search',
  'nav.search.chooseFolderFirst': 'Choose a folder to search its PDFs.',
  'nav.search.typeToSearchOpen': 'Type to search the open documents.',
  'nav.search.typeToSearchFolder': 'Type to search this folder.',
  'nav.search.searching': 'Searching…',
  'nav.search.invalidRegex': 'Invalid regular expression: {{error}}',
  'nav.search.noMatches': 'No matches for “{{query}}”.',
  'nav.search.noMatchesIn': 'No matches for “{{query}}” in {{folder}}.',
  // Two counts in one sentence: the OUTER key pluralizes on the pages and
  // takes the file phrase as a finished grammatical unit (`fileCount`, itself
  // a plural pair) — the ExportImages precedent. Composing two catalog
  // strings in the CATALOG's own word order is not the banned concatenation;
  // gluing fragments in code would be.
  'nav.search.summary_one': '{{count}} page in {{files}}',
  'nav.search.summary_other': '{{count}} pages in {{files}}',
  'nav.search.fileCount_one': '{{count}} file',
  'nav.search.fileCount_other': '{{count}} files',
  'nav.search.diskSummary_one': '{{count}} page in {{files}} ({{searched}} searched){{truncated}}',
  'nav.search.diskSummary_other': '{{count}} pages in {{files}} ({{searched}} searched){{truncated}}',
  'nav.search.truncatedSuffix': ' — first {{shown}} of {{total}} files',
  'nav.search.unreadable_one': '{{count}} file could not be read',
  'nav.search.unreadable_other': '{{count}} files could not be read',
  'nav.search.goToPage': 'Go to page {{page}}',
  'nav.search.openAtPage': 'Open {{name}} at page {{page}}',
  'nav.search.page': 'Page {{page}}',

  'nav.sig.verifying': 'Verifying signatures…',
  'nav.sig.none': 'This PDF has no digital signatures.',
  'nav.sig.count_one': '{{count}} signature',
  'nav.sig.count_other': '{{count}} signatures',
  // One whole-paragraph key: the English marked the middle clause with
  // <strong>, and an inline emphasis span pins a phrase boundary that does
  // not survive translation (the Settings license-notice precedent).
  'nav.sig.caveat':
    'Signer identity is not verified against a trusted authority — these results confirm cryptographic validity and whether the document changed after signing, not who the signer really is.',
  'nav.sig.recheck': 'Re-check',
  'nav.sig.unknownSigner': '(unknown signer)',
  'nav.sig.intact': 'integrity intact',
  'nav.sig.broken': 'integrity BROKEN',
  'nav.sig.wholeDocument': 'whole document',
  'nav.sig.partialCoverage': 'partial coverage',
  'nav.sig.detail': '{{integrity}} · {{coverage}}',
  'nav.sig.field': 'field: {{field}}',
  'nav.sig.claimedTime': 'claimed time: {{time}}',
  'nav.sig.error': 'error: {{error}}',

  // ── The shared page context menu (lib/page-context-menu.ts) ───────────
  // One definition serves the canvas board and the nav-pane Pages panel, so
  // one set of keys does too. The multi-select forms are plural pairs even
  // though `multi` implies count > 1 in English: a locale with a `_few`
  // category still needs the count to pick the form.
  'pagemenu.open': 'Open',
  'pagemenu.rotateRight': 'Rotate right 90°',
  'pagemenu.rotateLeft': 'Rotate left 90°',
  'pagemenu.rotateRightN_one': 'Rotate {{count}} page right 90°',
  'pagemenu.rotateRightN_other': 'Rotate {{count}} pages right 90°',
  'pagemenu.rotateLeftN_one': 'Rotate {{count}} page left 90°',
  'pagemenu.rotateLeftN_other': 'Rotate {{count}} pages left 90°',
  'pagemenu.extractText': 'Extract text…',
  'pagemenu.deletePage': 'Delete page',
  'pagemenu.deleteN_one': 'Delete {{count}} page',
  'pagemenu.deleteN_other': 'Delete {{count}} pages',

  // ── App-level confirms and notices ────────────────────────────────────
  // The DIALOGS that render these were threaded in the dialogs batch; the
  // MESSAGES App hands them were not, so a Spanish user got a localized
  // frame around an English sentence. Titles ride the same records as the
  // bodies — a notice's title is part of its message, not chrome.
  'app.prefs.aria': 'Preferences',
  'app.prefs.title': 'Preferences',
  'app.prefs.close': 'Close',

  'app.formButton.title': 'Form button',
  'app.formButton.externalTitle': 'Form button — external link',
  'app.formButton.noAction': '"{{field}}" has no action attached.',
  'app.formButton.uri':
    '"{{field}}" links to:\n\n{{uri}}\n\nThis app never opens external sites itself. Copy the address to the clipboard?',
  'app.formButton.clipboardFailed': 'Could not access the clipboard.',
  'app.formButton.javascript':
    '"{{field}}" runs document JavaScript, which this app does not execute.',
  'app.formButton.submit':
    '"{{field}}" submits the form to a server, which this app does not do. Fill the form and save or export it instead.',
  'app.formButton.named':
    '"{{field}}" triggers the viewer action "{{action}}", which this app does not map.',
  'app.formButton.unsupported': '"{{field}}" carries an action this app does not support.',

  'app.sendEmail.title': 'Send by Email',

  'app.close.unsaved': '"{{name}}" has unsaved changes. Save before closing?',
  'app.closeAll.unsaved': 'Unsaved changes in: {{names}}. Save before closing all?',
  'app.exit.unsaved': 'Unsaved changes in: {{names}}. Save before exiting?',
  'app.window.unsaved': 'Unsaved changes in: {{names}}. Save before closing?',
} as const;

export type WorkbenchKey = keyof typeof WORKBENCH_STRINGS;

/** The base ids of the plural pairs above (use with tChromeCount). */
export type WorkbenchPluralKey = {
  [K in WorkbenchKey]: K extends `${infer B}_one` ? B : never;
}[WorkbenchKey];
