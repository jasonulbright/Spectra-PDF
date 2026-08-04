// N12 (brief 37) — the en catalog is GENERATED from the data tables that
// already name every chrome surface (command ids, menu/submenu ids), and
// this test is BOTH the parity gate and the generator: run normally it
// fails when `locales/en/chrome.json` is stale against the tables; run
// with I18N_WRITE=1 (npm run i18n:en) it rewrites the file and passes.
// Hand-editing the en catalog is what this exists to prevent — English
// copy lives in the tables, translations live in the other locales, and
// every other locale's key set must equal en's exactly (no silent
// fallback in a shipped locale, no dead keys).
import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { COMMANDS } from '../src/renderer/commands/registry';
import { MENUS, type MenuNode } from '../src/renderer/commands/menus';
import { CHROME_STRINGS } from '../src/renderer/i18n-chrome';
import { PANEL_STRINGS } from '../src/renderer/i18n-panels';
import { DIALOG_STRINGS } from '../src/renderer/i18n-dialogs';
import { WORKBENCH_STRINGS } from '../src/renderer/i18n-workbench';
import { TOOL_DEFS } from '../src/renderer/commands/tools';
import { NAV_PANEL_TITLES } from '../src/renderer/commands/navpanels';
import { TOOLBAR_CATALOG } from '../src/renderer/commands/toolbars';
import { FRIENDLY_NAMES } from '../src/renderer/hooks/useOperationQueue';
import { STEP_CATALOG } from '../src/renderer/lib/guided-actions';

const EN_PATH = resolve(__dirname, '../src/renderer/locales/en/chrome.json');
// Mirrors SHIPPED_LOCALES in src/renderer/i18n.ts — imported indirectly
// would drag i18next's init (and its DOM expectations) into this node
// test, so the list is pinned here and a drift fails the parity loop.
const SHIPPED_LOCALES = ['en', 'es'];

function expectedCatalog(): Record<string, string> {
  const out: Record<string, string> = {
    ...CHROME_STRINGS,
    ...PANEL_STRINGS,
    ...DIALOG_STRINGS,
    ...WORKBENCH_STRINGS,
  };
  for (const [id, cmd] of Object.entries(COMMANDS)) {
    out[`cmd.${id}`] = cmd.title;
  }
  // Tool blurbs (the tile tooltip). The tool's NAME is not derived here: it is
  // already `cmd.tools.open.<id>`, and tToolTitle reads that one key so the
  // menu and the dock cannot name a tool differently in one language.
  for (const tool of TOOL_DEFS) {
    out[`tool.desc.${tool.id}`] = tool.description;
  }
  // Nav-pane titles (the icon-strip tooltip and the panel header) — a data
  // table with no command behind it, so its keys derive here.
  for (const [id, title] of Object.entries(NAV_PANEL_TITLES)) {
    out[`navpanel.${id}`] = title;
  }
  // Toolbar catalog group labels (the Customize Toolbar dialog's section
  // heads) — a data table, so its display strings derive keys here.
  for (const group of TOOLBAR_CATALOG) {
    out[`toolbar.group.${group.id}`] = group.label;
  }
  // Operation-queue op names, likewise a table (the queue LINE's composition
  // shapes live in DIALOG_STRINGS as whole interpolated messages).
  for (const [method, name] of Object.entries(FRIENDLY_NAMES)) {
    out[`opqueue.op.${method}`] = name;
  }
  // Guided-actions step catalog (serialized DATA — display strings derive
  // keys here, like the command titles). OCR language options excluded:
  // they await the Intl.DisplayNames switch in the dialogs pass.
  for (const def of STEP_CATALOG) {
    out[`gaction.step.${def.op}`] = def.title;
    for (const p of def.params) {
      out[`gaction.param.${def.op}.${p.key}`] = p.label;
      if (p.hint) out[`gaction.hint.${def.op}.${p.key}`] = p.hint;
      if (p.options && !(def.op === 'ocr_file' && p.key === 'language')) {
        for (const o of p.options) {
          out[`gaction.opt.${def.op}.${p.key}.${o.value}`] = o.label;
        }
      }
    }
  }
  const walk = (nodes: MenuNode[]): void => {
    for (const n of nodes) {
      if (n.kind === 'submenu') {
        out[`menu.${n.id}`] = n.label;
        walk(n.items);
      }
    }
  };
  for (const menu of MENUS) {
    out[`menu.${menu.id}`] = menu.label;
    walk(menu.items);
  }
  // Deterministic order so the checked-in file diffs cleanly.
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)));
}

describe('i18n catalogs (N12)', () => {
  it('en/chrome.json matches the data tables (I18N_WRITE=1 regenerates)', () => {
    const expected = expectedCatalog();
    if (process.env.I18N_WRITE === '1') {
      writeFileSync(EN_PATH, JSON.stringify(expected, null, 2) + '\n');
    }
    expect(existsSync(EN_PATH), 'locales/en/chrome.json missing — run npm run i18n:en').toBe(true);
    const actual = JSON.parse(readFileSync(EN_PATH, 'utf8'));
    expect(actual, 'stale en catalog — run npm run i18n:en and commit the diff').toEqual(expected);
  });

  it('every shipped locale has EXACTLY the en key set', () => {
    const enKeys = Object.keys(JSON.parse(readFileSync(EN_PATH, 'utf8'))).sort();
    for (const locale of SHIPPED_LOCALES) {
      if (locale === 'en') continue;
      const p = resolve(__dirname, `../src/renderer/locales/${locale}/chrome.json`);
      const keys = Object.keys(JSON.parse(readFileSync(p, 'utf8'))).sort();
      expect(keys, `locale ${locale} key set diverges from en`).toEqual(enKeys);
    }
  });

  it('no catalog value is empty', () => {
    for (const locale of SHIPPED_LOCALES) {
      const p = resolve(__dirname, `../src/renderer/locales/${locale}/chrome.json`);
      const cat = JSON.parse(readFileSync(p, 'utf8')) as Record<string, string>;
      for (const [k, v] of Object.entries(cat)) {
        expect(typeof v === 'string' && v.length > 0, `${locale}:${k} is empty`).toBe(true);
      }
    }
  });
});
