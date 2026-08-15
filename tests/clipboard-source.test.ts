// The clipboard acquisition layer.
//
// The load-bearing pin is TOTALITY across processes: Rust writes the payload
// with one of four extensions, the engine converts by extension, and this
// module badges by the same table. A clipboard payload that landed on an
// extension nothing converts would be a door that only looks open, and the
// only way to catch that is to read the Rust source rather than trust a copy
// of its table — the `create-pdf.test.ts` precedent.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  CLIPBOARD_EXTENSIONS,
  CLIPBOARD_KINDS,
  CLIPBOARD_KIND_LABEL_KEYS,
  clipboardKindConverts,
  clipboardRow,
  clipboardSummary,
  type ClipboardSourceResult,
} from '../src/renderer/lib/clipboard-source';
import { ACCEPTED_SUFFIXES, classify } from '../src/renderer/lib/create-pdf';
import { DIALOG_STRINGS } from '../src/renderer/i18n-dialogs';

const RUST = readFileSync(
  resolve(__dirname, '../src-tauri/src/clipboard_read.rs'),
  'utf8',
);

function result(over: Partial<ClipboardSourceResult>): ClipboardSourceResult {
  return {
    path: 'C:/tmp/spectrapdf/clipboard/clipboard-1-0.txt',
    kind: 'text',
    format: 'CF_UNICODETEXT',
    bytes: 10,
    ...over,
  };
}

describe('clipboard sources', () => {
  it('every extension the Rust side writes reaches a converter', () => {
    for (const kind of CLIPBOARD_KINDS) {
      const kinds = clipboardKindConverts(kind);
      expect(kinds.length, `${kind} declares no extension`).toBeGreaterThan(0);
      for (const converter of kinds) {
        expect(converter, `${kind} classifies to nothing`).not.toBe('');
      }
      for (const ext of CLIPBOARD_EXTENSIONS[kind]) {
        expect(ACCEPTED_SUFFIXES, `${ext} is not in the accepted set`).toContain(ext);
      }
    }
  });

  it('the extension table agrees with the Rust source that writes them', () => {
    // `write_scratch("dib", …)` / the `match extension` arms — the literals
    // that decide what lands on disk.
    const written = new Set(
      [...RUST.matchAll(/write_scratch\("([a-z0-9]+)"/g)].map((m) => `.${m[1]}`),
    );
    const declared = new Set(Object.values(CLIPBOARD_EXTENSIONS).flat());
    expect([...written].sort()).toEqual([...declared].sort());
  });

  it('the kinds the Rust side reports are exactly the kinds this module knows', () => {
    const reported = new Set(
      [...RUST.matchAll(/kind:\s*"([a-z]+)"\.to_string\(\)/g)].map((m) => m[1]),
    );
    expect([...reported].sort()).toEqual([...CLIPBOARD_KINDS].sort());
  });

  it('a clipboard row is an ordinary source row with an honest kind badge', () => {
    const row = clipboardRow(result({ path: 'C:/tmp/clip.dib', kind: 'image' }));
    expect(row.kind).toBe('image');
    expect(row.origin).toBe('clipboard');
    expect(row.clipboardKind).toBe('image');
    expect(row.path).toBe('C:/tmp/clip.dib');
    // The same constructor a picked file goes through: the id is fresh, so
    // two pastes are two rows.
    const second = clipboardRow(result({ path: 'C:/tmp/clip.dib', kind: 'image' }));
    expect(second.id).not.toBe(row.id);
  });

  it('an HTML payload classifies through the office arm, not a new one', () => {
    expect(classify('x.html')).toBe('office');
    expect(clipboardRow(result({ path: 'C:/t/c.html', kind: 'html' })).kind).toBe('office');
  });

  it('the summary reports pixels for an image and characters for text', () => {
    expect(clipboardSummary(result({ kind: 'image', width: 1200, height: 800 }))).toEqual({
      key: 'dialog.createPdf.clipboardImageSize',
      params: { width: 1200, height: 800 },
    });
    // A DIB whose header carries no usable size still gets a line — a blank
    // detail row would read as a payload with nothing in it.
    expect(clipboardSummary(result({ kind: 'image' })).key).toBe(
      'dialog.createPdf.clipboardImagePlain',
    );
    expect(clipboardSummary(result({ kind: 'text', chars: 42 }))).toEqual({
      key: 'dialog.createPdf.clipboardTextChars',
      params: { count: 42 },
      count: 42,
    });
  });

  it('a SourceURL is reported and a missing one is not invented', () => {
    const withSource = clipboardSummary(
      result({ kind: 'html', chars: 9, source_url: 'https://example.test/a' }),
    );
    expect(withSource.key).toBe('dialog.createPdf.clipboardHtmlFrom');
    expect(withSource.params.source).toBe('https://example.test/a');
    expect(clipboardSummary(result({ kind: 'html', chars: 9 })).key).toBe(
      'dialog.createPdf.clipboardHtmlChars',
    );
  });

  it('`count` is present exactly where the key is a plural pair', () => {
    const catalog = DIALOG_STRINGS as Record<string, string>;
    const cases: ClipboardSourceResult[] = [
      result({ kind: 'image', width: 4, height: 5 }),
      result({ kind: 'image' }),
      result({ kind: 'text', chars: 1 }),
      result({ kind: 'html', chars: 1 }),
      result({ kind: 'html', chars: 1, source_url: 'https://a.test/' }),
    ];
    for (const c of cases) {
      const summary = clipboardSummary(c);
      const plural = catalog[`${summary.key}_one`] !== undefined;
      expect(plural, `${summary.key} plural/count disagree`).toBe(summary.count !== undefined);
      if (!plural) expect(catalog[summary.key], `${summary.key} missing`).toBeTruthy();
    }
  });

  it('every kind has a label key the catalog carries', () => {
    const catalog = DIALOG_STRINGS as Record<string, string>;
    for (const kind of CLIPBOARD_KINDS) {
      expect(catalog[CLIPBOARD_KIND_LABEL_KEYS[kind]], `${kind} label missing`).toBeTruthy();
    }
  });
});
