// The en catalog is GENERATED from the data tables that
// already name every chrome surface (command ids, menu/submenu ids), and
// this test is BOTH the parity gate and the generator: run normally it
// fails when `locales/en/chrome.json` is stale against the tables; run
// with I18N_WRITE=1 (npm run i18n:en) it rewrites the file and passes.
// Hand-editing the en catalog is what this exists to prevent — English
// copy lives in the tables, translations live in the other locales, and
// every other locale's key set must equal en's, expanded to that locale's
// own CLDR plural categories (no silent fallback in a shipped locale, no
// dead keys).
import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { COMMANDS } from '../src/renderer/commands/registry';
import { MENUS, type MenuNode } from '../src/renderer/commands/menus';
import { CHROME_STRINGS } from '../src/renderer/i18n-chrome';
import { PANEL_STRINGS } from '../src/renderer/i18n-panels';
import { DIALOG_STRINGS } from '../src/renderer/i18n-dialogs';
import { WORKBENCH_STRINGS } from '../src/renderer/i18n-workbench';
import { CANVAS_STRINGS } from '../src/renderer/i18n-canvas';
import { REFUSAL_STRINGS } from '../src/renderer/i18n-refusals';
import { TOOL_DEFS } from '../src/renderer/commands/tools';
import { NAV_PANEL_TITLES } from '../src/renderer/commands/navpanels';
import { TOOLBAR_CATALOG } from '../src/renderer/commands/toolbars';
import { FRIENDLY_NAMES } from '../src/renderer/hooks/useOperationQueue';
import { STEP_CATALOG } from '../src/renderer/lib/guided-actions';
import { ENGINE_MESSAGE_ROWS } from '../src/renderer/lib/engine-messages';

const EN_PATH = resolve(__dirname, '../src/renderer/locales/en/chrome.json');
// Mirrors SHIPPED_LOCALES in src/renderer/i18n.ts — imported indirectly
// would drag i18next's init (and its DOM expectations) into this node
// test, so the list is pinned here and a drift fails the parity loop.
const SHIPPED_LOCALES = ['en', 'es', 'fr', 'de', 'it', 'pt-BR', 'ja', 'zh-CN', 'nl', 'da', 'sv', 'nb', 'fi', 'ru', 'uk', 'pl', 'cs', 'sk', 'ko', 'zh-TW', 'tr', 'hu', 'el', 'ro', 'sl', 'ca', 'ar'];

/**
 * The plural categories a locale's forms must cover, read from CLDR at gate
 * time. i18next resolves a count through this same `Intl.PluralRules` data,
 * so the gate and the runtime cannot disagree about which suffix a count
 * selects; a hand-maintained per-locale form list would go stale against an
 * ICU update. A category the locale does not have is a DEAD key: nothing
 * selects it, so parity rejects it in both directions.
 */
function pluralCategories(locale: string): readonly string[] {
  return new Intl.PluralRules(locale).resolvedOptions().pluralCategories;
}

/**
 * Per-locale departures from the default plural policy. A row is a
 * grammatical fact about the target language, never a shortcut around a hard
 * string.
 *
 * `keys` — plural bases whose one/other forms are legitimately IDENTICAL
 * because the noun the message counts has no plural form in that language.
 * Italian `file`, `byte` and `tag` are invariant loanwords: 3 file is the
 * correct plural, and inventing 3 files to make the forms differ would be
 * writing Italian wrong to satisfy a test. Every other Italian count inflects
 * and is still gated; where an inflecting synonym was genuinely the right word
 * it was used instead (search results count documento/documenti, links count
 * collegamento/collegamenti), so this list is the residue.
 *
 * `policy: 'numeral-invariant'` — the language takes the BARE SINGULAR after a
 * numeral, so `_one` and `_other` are required to be identical and a split is
 * the defect. Every plural base in this catalog is numeral-prefixed, and
 * Turkish and Hungarian govern the counted noun that way (1 dosya / 5 dosya,
 * 1 fájl / 5 fájl). Demanding a difference there means writing the language
 * wrong to satisfy a test. Arabic governs the SAME pair the same way from the
 * other end of a six-category set: the counted noun is a singular tamyeez
 * after 1 and again after 100+ and after a fraction, and the two are spelled
 * identically (1 صفحة / 100 صفحة). Arabic's number agreement is carried by the
 * categories en has no counterpart for — the dual at 2, the broken plural at
 * 3–10, the accusative singular at 11–99 — which is why the policy costs
 * nothing here: those three forms are still required to be present, and
 * `merged` still pins zero to few.
 *
 * `merged` — category PAIRS that share ONE form across the whole locale, and
 * are therefore required to be identical rather than merely allowed to be.
 * CLDR Arabic `zero` (0) and `few` (3–10) take the same broken plural.
 */
interface PluralPolicy {
  readonly policy?: 'numeral-invariant';
  readonly keys?: readonly string[];
  readonly merged?: readonly (readonly [string, string])[];
}
const INVARIANT_PLURALS: Record<string, PluralPolicy> = {
  it: {
    keys: [
      'dialog.exportImages.fileCount',
      'dialog.props.bytes',
      'panel.portfolio.count',
      'panel.tags.summary',
    ],
  },
  // Danish `sprog` is a neuter noun whose plural is identical to its singular
  // (et sprog / to sprog); no inflecting synonym names a recognition language.
  da: { keys: ['dialog.ocr.langCount'] },
  // Swedish neuter nouns ending in a consonant take a bare plural: ett fält /
  // flera fält, ett språk / språk, ett objekt / objekt, ett certifikat /
  // certifikat, en byte / byte. Every one of these messages is the noun alone
  // after the numeral, with no participle or predicative adjective to agree —
  // where one exists the plural IS written (movedCount, pageLabels.applied,
  // prepareForm.created, formPrep.candidates), so this list is the residue.
  sv: {
    keys: [
      'chrome.status.fillFields',
      'dialog.formPrep.existingFields',
      'dialog.ocr.langCount',
      'dialog.props.bytes',
      'panel.encrypt.encryptedTo',
      'panel.optimize.audit.objects',
      'panel.prepareForm.create',
    ],
  },
  // Norwegian Bokmål neuter monosyllables take a bare plural: et treff / flere
  // treff, et språk / språk, en byte / byte. `treff` is the only word for a
  // search hit, and every other Norwegian count in this catalog inflects.
  nb: {
    keys: [
      'canvas.find.summary',
      'dialog.diskRedact.hits',
      'dialog.ocr.langCount',
      'dialog.props.bytes',
      'panel.searchRedact.found',
      'panel.searchRedact.hitCount',
    ],
  },
  // Finnish inflects the counted noun after a numeral (1 sivu / 3 sivua), so
  // almost every base differs. These four put the counted noun in an oblique
  // case — genitive, ablative, allative, and a partitive governed by `vastaan`
  // — where the numeral takes the SAME singular form at any count.
  fi: {
    keys: [
      'canvas.redact.confirm',
      'dialog.exportDoc.doneTxt',
      'panel.encrypt.encryptedTo',
      'panel.sig.trustVerified',
    ],
  },
  // Ukrainian neuter nouns in -ння have the same form in the nominative
  // singular, the nominative plural and the genitive singular, so `one`, `few`
  // and `other` coincide: 1 посилання / 2 посилання / 1,5 посилання, with
  // `many` (посилань) the only distinct form. `посилання` is the only word for
  // a link and `зображення` the only word for an image; every other Ukrainian
  // count in this catalog inflects and is still gated.
  uk: { keys: ['panel.links.summary', 'panel.preflight.images'] },
  // Greek borrows `byte` as an indeclinable neuter: 1 byte / 5 byte. The
  // native ψηφιολέξη inflects but names a unit no Greek file-size readout
  // uses. Every other Greek count in this catalog inflects and is still gated.
  el: { keys: ['dialog.props.bytes'] },
  tr: { policy: 'numeral-invariant' },
  hu: { policy: 'numeral-invariant' },
  ar: { policy: 'numeral-invariant', merged: [['zero', 'few']] },
};

/** en's key set with every plural base expanded to THIS locale's categories. */
function expectedKeys(locale: string, enKeys: readonly string[]): string[] {
  const cats = pluralCategories(locale);
  const out: string[] = [];
  for (const k of enKeys) {
    if (k.endsWith('_other')) continue; // expanded alongside its `_one` sibling
    if (k.endsWith('_one')) {
      const base = k.slice(0, -'_one'.length);
      for (const c of cats) out.push(`${base}_${c}`);
      continue;
    }
    out.push(k);
  }
  return out.sort();
}

/** The en value a locale key's placeholders are compared against. A plural
 * form en has no counterpart for (`_many`, `_few`, …) compares against en's
 * `_other`, which carries the same placeholders as every form of its base. */
function enCounterpart(key: string, en: Record<string, string>): string | undefined {
  if (key in en) return en[key];
  const base = key.slice(0, key.lastIndexOf('_'));
  return `${base}_one` in en ? en[`${base}_other`] : undefined;
}

function expectedCatalog(): Record<string, string> {
  const out: Record<string, string> = {
    ...CHROME_STRINGS,
    ...PANEL_STRINGS,
    ...DIALOG_STRINGS,
    ...WORKBENCH_STRINGS,
    ...CANVAS_STRINGS,
    ...REFUSAL_STRINGS,
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
  // keys here, like the command titles). Recognition-language options are
  // excluded: they resolve through Intl.DisplayNames.
  for (const def of STEP_CATALOG) {
    out[`gaction.step.${def.op}`] = def.title;
    for (const p of def.params) {
      out[`gaction.param.${def.op}.${p.key}`] = p.label;
      if (p.hint) out[`gaction.hint.${def.op}.${p.key}`] = p.hint;
      // A recognition-language list is excluded wherever it appears: those
      // names come from Intl.DisplayNames, and deriving 47 keys per step that
      // offers one would author by hand what the platform already knows.
      if (p.options && p.key !== 'language') {
        for (const o of p.options) {
          out[`gaction.opt.${def.op}.${p.key}.${o.value}`] = o.label;
        }
      }
    }
  }
  // The ENGINE refusals. English lives in the engine (and in
  // the checked-in table that mirrors it, gated by tests/test_engine_messages
  // .py), so the en catalog derives from the table exactly like the other
  // data tables: never hand-authored, never allowed to drift from the source.
  for (const row of ENGINE_MESSAGE_ROWS) {
    out[`engine.${row.key}`] = row.message;
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

describe('i18n catalogs', () => {
  it('en/chrome.json matches the data tables (I18N_WRITE=1 regenerates)', () => {
    const expected = expectedCatalog();
    if (process.env.I18N_WRITE === '1') {
      writeFileSync(EN_PATH, JSON.stringify(expected, null, 2) + '\n');
    }
    expect(existsSync(EN_PATH), 'locales/en/chrome.json missing — run npm run i18n:en').toBe(true);
    const actual = JSON.parse(readFileSync(EN_PATH, 'utf8'));
    expect(actual, 'stale en catalog — run npm run i18n:en and commit the diff').toEqual(expected);
  });

  it("every shipped locale has EXACTLY en's key set, expanded to its plural forms", () => {
    const enKeys = Object.keys(JSON.parse(readFileSync(EN_PATH, 'utf8')));
    const suffixed = (s: string): string[] =>
      enKeys.filter((k) => k.endsWith(s)).map((k) => k.slice(0, -s.length)).sort();
    // `expectedKeys` expands a base from its `_one` key, so an `_other`
    // without an `_one` sibling would drop out of the expected set unseen.
    expect(suffixed('_other'), 'an en plural base carries _other without _one').toEqual(
      suffixed('_one'),
    );
    for (const locale of SHIPPED_LOCALES) {
      const p = resolve(__dirname, `../src/renderer/locales/${locale}/chrome.json`);
      const keys = Object.keys(JSON.parse(readFileSync(p, 'utf8'))).sort();
      expect(keys, `locale ${locale} key set diverges from en's`).toEqual(
        expectedKeys(locale, enKeys),
      );
    }
  });

  // The locale-QA gates. The catalog review ran both of these
  // over the es catalog by hand; they are tests so a future locale (or a new
  // key) cannot regress them silently. A dropped `{{name}}` is the worst
  // class of translation bug: the sentence still reads, and the value it was
  // supposed to name simply vanishes.
  it('every locale carries EXACTLY en\'s interpolation placeholders per key', () => {
    const en = JSON.parse(readFileSync(EN_PATH, 'utf8')) as Record<string, string>;
    const placeholders = (s: string): string =>
      [...s.matchAll(/\{\{([^}]*)\}\}/g)].map((m) => m[1].trim()).sort().join(',');
    for (const locale of SHIPPED_LOCALES) {
      if (locale === 'en') continue;
      const p = resolve(__dirname, `../src/renderer/locales/${locale}/chrome.json`);
      const cat = JSON.parse(readFileSync(p, 'utf8')) as Record<string, string>;
      for (const [k, v] of Object.entries(cat)) {
        const src = enCounterpart(k, en);
        expect(src, `${locale}:${k} has no en counterpart`).toBeDefined();
        expect(placeholders(v), `${locale}:${k} placeholders diverge from en`).toBe(
          placeholders(src ?? ''),
        );
      }
    }
  });

  it("every plural form its locale's rules select is authored, and obeys the policy", () => {
    const en = JSON.parse(readFileSync(EN_PATH, 'utf8')) as Record<string, string>;
    const bases = Object.keys(en)
      .filter((k) => k.endsWith('_one'))
      .map((k) => k.slice(0, -'_one'.length));
    expect(bases.length).toBeGreaterThan(0);
    for (const locale of SHIPPED_LOCALES) {
      const p = resolve(__dirname, `../src/renderer/locales/${locale}/chrome.json`);
      const cat = JSON.parse(readFileSync(p, 'utf8')) as Record<string, string>;
      const cats = pluralCategories(locale);
      const declared = INVARIANT_PLURALS[locale] ?? {};
      // A declaration that names something the locale does not have is a
      // stale exception, which is how an exception table stops being read.
      for (const pair of declared.merged ?? []) {
        for (const c of pair) {
          expect(cats, `${locale} declares merged category ${c}, which CLDR does not give it`)
            .toContain(c);
        }
      }
      for (const b of declared.keys ?? []) {
        expect(bases, `${locale} declares invariant key ${b}, which is not a plural base`)
          .toContain(b);
      }
      for (const base of bases) {
        for (const c of cats) {
          expect(cat[`${base}_${c}`], `${locale}:${base}_${c} missing`).toBeTruthy();
        }
        for (const [a, b] of declared.merged ?? []) {
          expect(
            cat[`${base}_${a}`],
            `${locale}:${base} splits ${a}/${b}, which share one form in ${locale}`,
          ).toBe(cat[`${base}_${b}`]);
        }
        // One category: the runtime shows the single form for every count,
        // so there is no pair to compare.
        if (!cats.includes('one')) continue;
        if (declared.policy === 'numeral-invariant') {
          expect(
            cat[`${base}_one`],
            `${locale}:${base} splits a plural a numeral governs in ${locale}`,
          ).toBe(cat[`${base}_other`]);
          continue;
        }
        // Identical forms are LEGITIMATE where the source does not inflect
        // either ("{{count}} selected" reads the same at 1 and at 3, while
        // Spanish still inflects it). What is never legitimate is a locale
        // collapsing a distinction the source makes — that is one form
        // pasted over the other. The one honest exception is a target-language
        // noun that HAS no plural form (INVARIANT_PLURALS above): forcing a
        // difference there would mean writing the language wrong to satisfy a
        // test, so the collapse is declared per locale and per key instead of
        // being hidden.
        //
        // The check is scoped to one/other — the pair en itself distinguishes.
        // A category en has no form for (many, few, two, zero) is required to
        // be present and non-empty and nothing more: an English source cannot
        // prove what a target language's fifth form has to say.
        if (
          en[`${base}_one`] !== en[`${base}_other`] &&
          !(declared.keys ?? []).includes(base)
        ) {
          expect(
            cat[`${base}_one`] === cat[`${base}_other`],
            `${locale}:${base} collapses a plural distinction en makes`,
          ).toBe(false);
        }
      }
    }
  });

  // A locale can pass every check above and still render English: i18next only
  // serves a language it was handed a `resources` entry for, and the entry is
  // a separate edit from the SHIPPED_LOCALES row. The failure is silent — the
  // fallback IS English — so the two lists are compared as source text here.
  it('every shipped locale is registered as an i18next resource', () => {
    const src = readFileSync(resolve(__dirname, '../src/renderer/i18n.ts'), 'utf8');
    const block = src.slice(src.indexOf('resources: {'), src.indexOf('interpolation:'));
    expect(block.length).toBeGreaterThan(0);
    const registered = new Set(
      [...block.matchAll(/^\s*'?([A-Za-z-]+)'?:\s*\{\s*chrome:/gm)].map((m) => m[1]),
    );
    for (const locale of SHIPPED_LOCALES) {
      expect(registered.has(locale), `${locale} is shipped but has no resources entry`).toBe(true);
    }
    // The detector must be able to fail: a name that is not registered.
    expect(registered.has('qqq')).toBe(false);
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
