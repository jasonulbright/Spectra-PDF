// The all-true snapshots below were computed from the unfiltered MENUS,
// COMMAND_IDS, TOOL_DEFS and KEY_BINDINGS before platform filtering existed;
// with every flag true the filtered model must reproduce them exactly.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { availableMenus, filterMenuNodes, MENUS, menuCommandIds, type MenuNode } from '../src/renderer/commands/menus';
import { availableCommandIds, COMMAND_IDS, type CommandId } from '../src/renderer/commands/registry';
import { TOOL_DEFS } from '../src/renderer/commands/tools';
import { KEY_BINDINGS } from '../src/renderer/commands/standard-keys';
import { shortcutForCommand } from '../src/renderer/commands/keymap';
import {
  PREFERENCE_CONTROLS,
  availablePreferenceControls,
  availableToolDefs,
  commandAvailable,
  type PreferenceControl,
} from '../src/renderer/commands/platform';
import {
  ALL_PLATFORM_CAPABILITIES,
  loadPlatformCapabilities,
  parsePlatformCapabilities,
  PLATFORM_FEATURES,
  platformCapabilities,
  platformCapability,
  resetPlatformCapabilities,
  setPlatformCapabilities,
  type PlatformFeature,
} from '../src/renderer/lib/platform-capabilities';
import { emptySourceFor, sourceOnOpen } from '../src/renderer/lib/signer-sources';

afterEach(() => resetPlatformCapabilities());

function describeNodes(nodes: readonly MenuNode[]): unknown[] {
  return nodes.map((n) => {
    switch (n.kind) {
      case 'command':
        return `${n.command}|${n.testid ?? ''}`;
      case 'separator':
        return '---';
      case 'submenu':
        return { submenu: n.id, label: n.label, items: describeNodes(n.items) };
      case 'dynamic':
        return `dynamic:${n.id}`;
    }
  });
}

describe('all flags true reproduces the unfiltered model', () => {
  it('menus', () => {
    const menus = availableMenus();
    menus.forEach((m, i) => expect(m).toBe(MENUS[i]));
    expect(menus.map((m) => ({ id: m.id, label: m.label, items: describeNodes(m.items) }))).toMatchInlineSnapshot(`
      [
        {
          "id": "file",
          "items": [
            "file.open|menuitem-file-open",
            "file.openFromWeb|menuitem-file-open-from-web",
            {
              "items": [
                "dynamic:recent-list",
                "---",
                "file.clearRecent|menuitem-file-clear-recent",
              ],
              "label": "Open Recent",
              "submenu": "file-recent",
            },
            "---",
            "file.createPdf|menuitem-file-create-pdf",
            "file.createFromClipboard|menuitem-file-create-from-clipboard",
            "file.createFromWebPage|menuitem-file-create-from-web-page",
            "file.createFromScanner|menuitem-file-create-from-scanner",
            "---",
            "file.save|menuitem-file-save",
            "file.saveAs|menuitem-file-save-as",
            "file.close|menuitem-file-close",
            "file.closeAll|menuitem-file-close-all",
            "---",
            {
              "items": [
                "tools.panel.extract_text|menuitem-file-export-text",
                "---",
                "file.exportWord|menuitem-file-export-word",
                "file.exportRtf|menuitem-file-export-rtf",
                "file.exportOdt|menuitem-file-export-odt",
                "file.exportHtml|menuitem-file-export-html",
                "file.exportXhtml|menuitem-file-export-xhtml",
                "---",
                "file.exportText|menuitem-file-export-txt",
                "file.exportExcel|menuitem-file-export-excel",
                "file.exportPowerpoint|menuitem-file-export-powerpoint",
                "file.exportImages|menuitem-file-export-images",
              ],
              "label": "Export",
              "submenu": "file-export",
            },
            {
              "items": [
                "file.sendToEmail|menuitem-file-send-email",
              ],
              "label": "Send To",
              "submenu": "file-send-to",
            },
            "---",
            "file.print|menuitem-file-print",
            "---",
            "file.properties|menuitem-file-properties",
            "---",
            "file.exit|menuitem-file-exit",
          ],
          "label": "File",
        },
        {
          "id": "edit",
          "items": [
            "edit.undo|menuitem-edit-undo",
            "edit.redo|menuitem-edit-redo",
            "---",
            "edit.copy|menuitem-edit-copy",
            "---",
            "edit.selectAll|menuitem-edit-select-all",
            "edit.deselect|menuitem-edit-deselect",
            "---",
            "edit.find|menuitem-edit-find",
            "view.navPanel.search|menuitem-edit-search",
            "---",
            "edit.preferences|menuitem-edit-preferences",
          ],
          "label": "Edit",
        },
        {
          "id": "view",
          "items": [
            {
              "items": [
                "view.navPanel.pages|menuitem-navpanel-pages",
                "view.navPanel.bookmarks|menuitem-navpanel-bookmarks",
                "view.navPanel.articles|menuitem-navpanel-articles",
                "view.navPanel.attachments|menuitem-navpanel-attachments",
                "view.navPanel.layers|menuitem-navpanel-layers",
                "view.navPanel.tags|menuitem-navpanel-tags",
                "view.navPanel.search|menuitem-navpanel-search",
                "view.navPanel.signatures|menuitem-navpanel-signatures",
                "---",
                "view.navPane|menuitem-view-nav-pane",
              ],
              "label": "Navigation Panels",
              "submenu": "view-nav-panels",
            },
            "view.toolsPane|menuitem-view-tools-pane",
            "---",
            {
              "items": [
                "view.zoomIn|menuitem-view-zoom-in",
                "view.zoomOut|menuitem-view-zoom-out",
                "---",
                "view.actualSize|menuitem-view-actual-size",
                "view.fit|menuitem-view-fit",
                "view.fitWidth|menuitem-view-fit-width",
              ],
              "label": "Zoom",
              "submenu": "view-zoom",
            },
            "---",
            {
              "items": [
                "view.rotateCW|menuitem-view-rotate-cw",
                "view.rotateCCW|menuitem-view-rotate-ccw",
              ],
              "label": "Rotate View",
              "submenu": "view-rotate",
            },
            "---",
            "view.documentView|menuitem-view-document",
            {
              "items": [
                "view.singlePage|menuitem-view-single-page",
                "view.twoUp|menuitem-view-two-up",
                "---",
                "view.twoUpCover|menuitem-view-two-up-cover",
              ],
              "label": "Page Display",
              "submenu": "view-page-display",
            },
            "view.readingMode|menuitem-view-reading-mode",
            {
              "items": [
                "view.readAloud.page|menuitem-view-read-aloud-page",
                "view.readAloud.document|menuitem-view-read-aloud-document",
                "---",
                "view.readAloud.pause|menuitem-view-read-aloud-pause",
                "view.readAloud.stop|menuitem-view-read-aloud-stop",
              ],
              "label": "Read Out Loud",
              "submenu": "view-read-aloud",
            },
            "view.propertiesBar|menuitem-view-properties-bar",
            "view.snapping|menuitem-view-snapping",
            {
              "items": [
                "view.rulers|menuitem-view-rulers",
                "view.grid|menuitem-view-grid",
                "---",
                "view.guides|menuitem-view-guides",
                "view.clearGuides|menuitem-view-clear-guides",
              ],
              "label": "Rulers & Grids",
              "submenu": "view-rulers-grids",
            },
            "view.customizeToolbar|menuitem-view-customize-toolbar",
            "view.presentation|menuitem-view-presentation",
            "tools.open.organize|menuitem-view-organize",
            "view.organizeAll|menuitem-view-organize-all",
          ],
          "label": "View",
        },
        {
          "id": "document",
          "items": [
            {
              "items": [
                "document.insertFromFile|menuitem-document-insert-file",
                "document.insertFromScanner|menuitem-document-insert-scanner",
                "document.insertBlankPage|menuitem-document-insert-blank",
              ],
              "label": "Insert Pages",
              "submenu": "document-insert",
            },
            "document.combineFiles|menuitem-document-combine",
            "---",
            "tools.panel.delete|menuitem-document-delete",
            "tools.panel.rotate|menuitem-document-rotate",
            "tools.panel.split|menuitem-document-split",
            "tools.panel.extract_text|menuitem-document-extract-text",
            "---",
            "tools.panel.watermark|menuitem-document-watermark",
            "---",
            "document.applyPageEdits|menuitem-document-apply-page-edits",
            "---",
            "tools.open.ocr|menuitem-document-make-searchable",
          ],
          "label": "Document",
        },
        {
          "id": "tools",
          "items": [
            "tools.open.organize|menuitem-tool-organize",
            "tools.open.comment|menuitem-tool-comment",
            "tools.open.edit|menuitem-tool-edit",
            "tools.open.fillsign|menuitem-tool-fillsign",
            "tools.open.prepareform|menuitem-tool-prepareform",
            "tools.open.redact|menuitem-tool-redact",
            "tools.open.measure|menuitem-tool-measure",
            "tools.open.takeoff|menuitem-tool-takeoff",
            "tools.open.actions|menuitem-tool-actions",
            "tools.open.ocr|menuitem-tool-ocr",
            "tools.open.compare|menuitem-tool-compare",
            "tools.open.protect|menuitem-tool-protect",
            "tools.open.optimize|menuitem-tool-optimize",
            "tools.open.repair|menuitem-tool-repair",
            "tools.open.watermark|menuitem-tool-watermark",
            "tools.open.headerfooter|menuitem-tool-headerfooter",
            "tools.open.pagebox|menuitem-tool-pagebox",
            "tools.open.snapshot|menuitem-tool-snapshot",
            "tools.open.pagelabels|menuitem-tool-pagelabels",
            "tools.open.attachments|menuitem-tool-attachments",
            "tools.open.portfolio|menuitem-tool-portfolio",
            "tools.open.layers|menuitem-tool-layers",
            "tools.open.accessibility|menuitem-tool-accessibility",
            "tools.open.printproduction|menuitem-tool-printproduction",
            "tools.open.links|menuitem-tool-links",
            "tools.open.export|menuitem-tool-export",
            "---",
            "tools.batchOcr|menuitem-tools-batch-ocr",
            "tools.diskRedact|menuitem-tools-disk-redact",
            "tools.formPrepFolder|menuitem-tools-form-prep-folder",
            "tools.folderExport|menuitem-tools-folder-export",
            "tools.folderCreatePdf|menuitem-tools-folder-create-pdf",
            "tools.folderPreflight|menuitem-tools-folder-preflight",
            "tools.scheduledRuns|menuitem-tools-scheduled-runs",
            "tools.watchedFolders|menuitem-tools-watched-folders",
          ],
          "label": "Tools",
        },
        {
          "id": "window",
          "items": [
            "window.nextTab|menuitem-window-next-tab",
            "window.prevTab|menuitem-window-prev-tab",
            "---",
            "window.split|menuitem-window-split",
            "window.spreadsheetSplit|menuitem-window-spreadsheet-split",
            "---",
            "window.newWindow|menuitem-window-new-window",
            "window.moveToNewWindow|menuitem-window-move-to-new-window",
            "---",
            "dynamic:window-docs",
            "---",
            "window.minimizeToTray|menuitem-window-minimize-tray",
          ],
          "label": "Window",
        },
        {
          "id": "help",
          "items": [
            "help.about|menuitem-help-about",
            "help.licenses|menuitem-help-licenses",
            "help.checkUpdates|menuitem-help-check-updates",
          ],
          "label": "Help",
        },
      ]
    `);
  });
  it('commands', () => {
    expect(availableCommandIds()).toEqual([...COMMAND_IDS]);
    expect(availableCommandIds()).toMatchInlineSnapshot(`
      [
        "file.open",
        "file.openFromWeb",
        "file.openInPlace",
        "file.properties",
        "file.print",
        "file.sendToEmail",
        "tools.close",
        "file.save",
        "file.saveAs",
        "file.exportWord",
        "file.exportRtf",
        "file.exportOdt",
        "file.exportHtml",
        "file.exportXhtml",
        "file.exportText",
        "file.exportExcel",
        "file.exportPowerpoint",
        "file.exportImages",
        "file.close",
        "file.closeAll",
        "edit.undo",
        "edit.redo",
        "edit.copy",
        "edit.selectAll",
        "edit.deselect",
        "edit.find",
        "edit.findNext",
        "edit.findPrev",
        "edit.preferences",
        "view.home",
        "view.navPane",
        "view.navPanel.pages",
        "view.navPanel.bookmarks",
        "view.navPanel.articles",
        "view.navPanel.attachments",
        "view.navPanel.layers",
        "view.navPanel.tags",
        "view.navPanel.search",
        "view.navPanel.signatures",
        "view.zoomIn",
        "view.zoomOut",
        "view.fit",
        "view.actualSize",
        "view.fitWidth",
        "view.documentView",
        "view.presentation",
        "view.readingMode",
        "view.readAloud.page",
        "view.readAloud.document",
        "view.readAloud.pause",
        "view.readAloud.stop",
        "view.propertiesBar",
        "view.snapping",
        "view.rulers",
        "view.grid",
        "view.guides",
        "view.clearGuides",
        "view.customizeToolbar",
        "view.singlePage",
        "view.twoUp",
        "view.twoUpCover",
        "view.organizeAll",
        "view.goToPage",
        "view.omniSearch",
        "view.rotateCW",
        "view.rotateCCW",
        "view.toolsPane",
        "document.insertBlankPage",
        "document.insertFromFile",
        "document.insertFromScanner",
        "document.combineFiles",
        "document.deleteSelection",
        "document.rotateSelectionCW",
        "document.rotateSelectionCCW",
        "document.applyPageEdits",
        "window.nextTab",
        "window.prevTab",
        "window.split",
        "window.spreadsheetSplit",
        "window.newWindow",
        "window.moveToNewWindow",
        "window.minimizeToTray",
        "help.about",
        "help.licenses",
        "help.checkUpdates",
        "file.exit",
        "file.clearRecent",
        "tools.batchOcr",
        "tools.diskRedact",
        "tools.formPrepFolder",
        "tools.folderExport",
        "tools.folderCreatePdf",
        "tools.folderPreflight",
        "tools.scheduledRuns",
        "tools.watchedFolders",
        "file.createPdf",
        "file.createFromClipboard",
        "file.createFromWebPage",
        "file.createFromScanner",
        "tools.select",
        "tools.hand",
        "tools.highlight",
        "tools.freetext",
        "tools.ink",
        "tools.inkhighlight",
        "tools.stamp",
        "tools.redact",
        "tools.signature",
        "tools.forms",
        "tools.formfields",
        "tools.edit",
        "tools.addtext",
        "tools.addimage",
        "tools.measuredist",
        "tools.measureperim",
        "tools.measurearea",
        "tools.measurecal",
        "tools.shape",
        "tools.callout",
        "tools.note",
        "tools.inkerase",
        "tools.zoommarquee",
        "tools.cropdraw",
        "tools.count",
        "tools.outputpreview",
        "tools.flattenpreview",
        "tools.tablereview",
        "tools.beaddraw",
        "tools.snapshot",
        "tools.linkdraw",
        "tools.panel.split",
        "tools.panel.rotate",
        "tools.panel.delete",
        "tools.panel.compress",
        "tools.panel.grayscale",
        "tools.panel.optimize",
        "tools.panel.pdfa",
        "tools.panel.pdf_version",
        "tools.panel.repair",
        "tools.panel.rebuild",
        "tools.panel.recover",
        "tools.panel.encrypt",
        "tools.panel.decrypt",
        "tools.panel.extract_text",
        "tools.panel.watermark",
        "tools.panel.forms",
        "tools.panel.compare",
        "tools.panel.signatures",
        "tools.panel.document_js",
        "tools.panel.convert_cmyk",
        "tools.panel.headerfooter",
        "tools.panel.pagebox",
        "tools.panel.pagelabels",
        "tools.panel.attachments",
        "tools.panel.portfolio",
        "tools.panel.layers",
        "tools.panel.accessibility",
        "tools.panel.comments",
        "tools.panel.preflight",
        "tools.panel.outputpreview",
        "tools.panel.inkmanager",
        "tools.panel.printermarks",
        "tools.panel.hairlines",
        "tools.panel.flattener",
        "tools.panel.trappresets",
        "tools.panel.links",
        "tools.panel.tags",
        "tools.panel.readingorder",
        "tools.panel.actions",
        "tools.panel.takeoff",
        "tools.panel.search_redact",
        "tools.panel.prepareform",
        "tools.panel.sanitize",
        "tools.panel.tablereview",
        "tools.panel.scanenhance",
        "tools.panel.spelling",
        "tools.open.organize",
        "tools.open.comment",
        "tools.open.edit",
        "tools.open.fillsign",
        "tools.open.prepareform",
        "tools.open.redact",
        "tools.open.measure",
        "tools.open.takeoff",
        "tools.open.actions",
        "tools.open.ocr",
        "tools.open.compare",
        "tools.open.protect",
        "tools.open.optimize",
        "tools.open.repair",
        "tools.open.watermark",
        "tools.open.headerfooter",
        "tools.open.pagebox",
        "tools.open.snapshot",
        "tools.open.pagelabels",
        "tools.open.attachments",
        "tools.open.portfolio",
        "tools.open.layers",
        "tools.open.accessibility",
        "tools.open.printproduction",
        "tools.open.links",
        "tools.open.export",
      ]
    `);
  });
  it('tools', () => {
    expect(availableToolDefs()).toEqual(TOOL_DEFS);
    expect(availableToolDefs().map((t) => t.id)).toMatchInlineSnapshot(`
      [
        "organize",
        "comment",
        "edit",
        "fillsign",
        "prepareform",
        "redact",
        "measure",
        "takeoff",
        "actions",
        "ocr",
        "compare",
        "protect",
        "optimize",
        "repair",
        "watermark",
        "headerfooter",
        "pagebox",
        "snapshot",
        "pagelabels",
        "attachments",
        "portfolio",
        "layers",
        "accessibility",
        "printproduction",
        "links",
        "export",
      ]
    `);
  });
  it('bindings', () => {
    expect(KEY_BINDINGS.filter((b) => commandAvailable(b.command)).map((b) => `${b.ctrl ? 'C-' : ''}${b.shift ? 'S-' : ''}${b.key}>${b.command}`)).toMatchInlineSnapshot(`
      [
        "C-o>file.open",
        "C-s>file.save",
        "C-S-s>file.saveAs",
        "C-w>file.close",
        "C-q>file.exit",
        "C-k>edit.preferences",
        "C-p>file.print",
        "C-d>file.properties",
        "C-S-d>tools.panel.delete",
        "C-S-r>tools.panel.rotate",
        "C-S-i>document.insertFromFile",
        "C-S-t>document.insertBlankPage",
        "C-S-n>view.goToPage",
        "C-l>view.omniSearch",
        "C-S-v>view.readAloud.page",
        "C-S-b>view.readAloud.document",
        "C-S-c>view.readAloud.pause",
        "C-S-e>view.readAloud.stop",
        "C-h>view.readingMode",
        "C-e>view.propertiesBar",
        "f5>view.presentation",
        "f3>edit.findNext",
        "S-f3>edit.findPrev",
        "C-g>edit.findNext",
        "C-S-g>edit.findPrev",
        "C-tab>window.nextTab",
        "C-S-tab>window.prevTab",
        "f4>view.navPane",
        "S-f4>view.toolsPane",
        "C-S-f>view.navPanel.search",
        "C-z>edit.undo",
        "C-S-z>edit.redo",
        "C-y>edit.redo",
        "C-f>edit.find",
        "C-a>edit.selectAll",
        "delete>document.deleteSelection",
        "backspace>document.deleteSelection",
        "]>document.rotateSelectionCW",
        "[>document.rotateSelectionCCW",
        "C-=>view.zoomIn",
        "C-+>view.zoomIn",
        "C-->view.zoomOut",
        "C-S-+>view.rotateCW",
        "C-S-_>view.rotateCCW",
        "C-S-->view.rotateCCW",
        "C-0>view.fit",
        "C-1>view.actualSize",
        "C-2>view.fitWidth",
        "h>tools.hand",
        "v>tools.select",
        "u>tools.highlight",
        "x>tools.freetext",
        "d>tools.ink",
        "k>tools.stamp",
        "s>tools.note",
        "z>tools.zoommarquee",
        "e>tools.open.edit",
      ]
    `);
  });
});

describe('capability module', () => {
  it('defaults to every flag true', () => {
    expect(platformCapabilities()).toEqual(ALL_PLATFORM_CAPABILITIES);
    for (const f of PLATFORM_FEATURES) expect(platformCapability(f)).toBe(true);
    expect(PLATFORM_FEATURES).toHaveLength(15);
  });

  it('parses only an exact true as available', () => {
    const caps = parsePlatformCapabilities({ systemPrinting: true, scanning: 'true', snapshot: 1 });
    expect(caps.systemPrinting).toBe(true);
    expect(caps.scanning).toBe(false);
    expect(caps.snapshot).toBe(false);
    expect(caps.backdrop).toBe(false);
    expect(parsePlatformCapabilities(null)).toEqual(
      Object.fromEntries(PLATFORM_FEATURES.map((f) => [f, false])),
    );
  });

  it('loads the report once and caches it', async () => {
    const read = vi.fn(async () => ({ ...ALL_PLATFORM_CAPABILITIES, scanning: false }));
    await loadPlatformCapabilities(read);
    expect(read).toHaveBeenCalledTimes(1);
    expect(platformCapability('scanning')).toBe(false);
    expect(platformCapability('systemPrinting')).toBe(true);
  });

  it('keeps the current record when the read fails or times out', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    setPlatformCapabilities({ webCapture: false });
    await loadPlatformCapabilities(() => Promise.reject(new Error('bridge')));
    expect(platformCapability('webCapture')).toBe(false);
    expect(platformCapability('scanning')).toBe(true);
    await loadPlatformCapabilities(() => new Promise(() => {}), 5);
    expect(platformCapability('webCapture')).toBe(false);
    expect(error).toHaveBeenCalledTimes(2);
    error.mockRestore();
  });

  it('harness override changes named flags only; reset restores all true', () => {
    setPlatformCapabilities({ trayResidency: false });
    expect(platformCapability('trayResidency')).toBe(false);
    expect(platformCapability('snapshot')).toBe(true);
    resetPlatformCapabilities();
    expect(platformCapabilities()).toEqual(ALL_PLATFORM_CAPABILITIES);
  });
});

const EXPECTED_DROPS: Record<PlatformFeature, CommandId[]> = {
  systemPrinting: ['file.print'],
  virtualPrinter: [],
  scanning: ['document.insertFromScanner', 'file.createFromScanner'],
  scheduledActions: ['tools.scheduledRuns'],
  storeCertificates: [],
  sendByEmail: ['file.sendToEmail'],
  webCapture: ['file.createFromWebPage'],
  clipboardRead: ['file.createFromClipboard'],
  snapshot: ['tools.snapshot', 'tools.open.snapshot'],
  accentColor: [],
  enterprisePolicy: [],
  trayResidency: ['window.minimizeToTray'],
  backdrop: [],
  consoleAttach: [],
  startWithSystem: [],
};

const EXPECTED_PREFERENCE_DROPS: Record<PlatformFeature, PreferenceControl[]> = {
  systemPrinting: [],
  virtualPrinter: [],
  scanning: [],
  scheduledActions: [],
  storeCertificates: [],
  sendByEmail: [],
  webCapture: [],
  clipboardRead: [],
  snapshot: [],
  accentColor: [],
  enterprisePolicy: [],
  trayResidency: ['minimizeToTray', 'startMinimized'],
  backdrop: [],
  consoleAttach: [],
  startWithSystem: ['startWithSystem'],
};

function allMenuIds(): CommandId[] {
  return menuCommandIds(availableMenus().flatMap((m) => m.items));
}

function expectTidy(nodes: readonly MenuNode[]): void {
  nodes.forEach((n, i) => {
    if (n.kind === 'separator') {
      expect(i).toBeGreaterThan(0);
      expect(i).toBeLessThan(nodes.length - 1);
      expect(nodes[i - 1].kind).not.toBe('separator');
    }
    if (n.kind === 'submenu') {
      expect(n.items.some((c) => c.kind !== 'separator')).toBe(true);
      expectTidy(n.items);
    }
  });
}

describe.each(PLATFORM_FEATURES)('flag %s false', (feature) => {
  it('drops exactly its commands and nothing else', () => {
    setPlatformCapabilities({ [feature]: false });
    const available = new Set(availableCommandIds());
    expect(COMMAND_IDS.filter((id) => !available.has(id))).toEqual(EXPECTED_DROPS[feature]);
  });

  it('drops exactly its menu entries, tools and shortcuts', () => {
    const fullMenu = allMenuIds();
    setPlatformCapabilities({ [feature]: false });
    const drops = new Set<CommandId>(EXPECTED_DROPS[feature]);
    expect(allMenuIds()).toEqual(fullMenu.filter((id) => !drops.has(id)));
    for (const m of availableMenus()) expectTidy(m.items);
    expect(availableToolDefs().map((t) => t.id)).toEqual(
      TOOL_DEFS.filter((t) => !drops.has(`tools.open.${t.id}` as CommandId)).map((t) => t.id),
    );
    for (const b of KEY_BINDINGS) {
      expect(commandAvailable(b.command)).toBe(!drops.has(b.command));
      if (drops.has(b.command)) expect(shortcutForCommand(b.command)).toBeNull();
    }
  });
});

describe('preferences controls', () => {
  it('shows every control with every flag true', () => {
    expect(availablePreferenceControls()).toEqual(['minimizeToTray', 'startMinimized', 'startWithSystem']);
  });

  it.each(PLATFORM_FEATURES)('flag %s false drops exactly its controls', (feature) => {
    setPlatformCapabilities({ [feature]: false });
    const drops = new Set(EXPECTED_PREFERENCE_DROPS[feature]);
    expect(availablePreferenceControls()).toEqual(PREFERENCE_CONTROLS.filter((c) => !drops.has(c)));
  });
});

describe('menu filtering', () => {
  it('removes a submenu its only command leaves empty', () => {
    setPlatformCapabilities({ sendByEmail: false });
    const file = availableMenus().find((m) => m.id === 'file')!;
    expect(file.items.some((n) => n.kind === 'submenu' && n.id === 'file-send-to')).toBe(false);
  });

  it('collapses separators the removal strands', () => {
    setPlatformCapabilities({ systemPrinting: false });
    const nodes: MenuNode[] = [
      { kind: 'command', command: 'file.open' },
      { kind: 'separator' },
      { kind: 'command', command: 'file.print' },
      { kind: 'separator' },
      { kind: 'command', command: 'file.exit' },
      { kind: 'separator' },
      { kind: 'command', command: 'file.print' },
    ];
    expect(filterMenuNodes(nodes)).toEqual([
      { kind: 'command', command: 'file.open' },
      { kind: 'separator' },
      { kind: 'command', command: 'file.exit' },
    ]);
  });

  it('shows the print shortcut only while printing is available', () => {
    expect(shortcutForCommand('file.print')).not.toBeNull();
    setPlatformCapabilities({ systemPrinting: false });
    expect(shortcutForCommand('file.print')).toBeNull();
  });
});

describe('certificate store source', () => {
  it('opens on the store only when the platform offers it', () => {
    expect(sourceOnOpen(emptySourceFor('store'))).toBe('store');
    expect(sourceOnOpen(emptySourceFor('store'), false)).toBe('pfx');
    expect(sourceOnOpen({ mode: 'store', thumbprint: 'AB', machineStore: false }, false)).toBe('pfx');
    expect(sourceOnOpen({ mode: 'pem', keyPath: 'k', certPath: null }, false)).toBe('pem');
  });
});
