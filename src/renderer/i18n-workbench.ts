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
} as const;

export type WorkbenchKey = keyof typeof WORKBENCH_STRINGS;

/** The base ids of the plural pairs above (use with tChromeCount). */
export type WorkbenchPluralKey = {
  [K in WorkbenchKey]: K extends `${infer B}_one` ? B : never;
}[WorkbenchKey];
