// N12 slice D (brief 37) — the engine-message boundary.
//
// The FIXTURE is `src/renderer/locales/engine-messages.tsv`, produced by the
// pytest sweep of `src/engine/*.py` and kept true to the engine by
// `tests/test_engine_messages.py`. These tests take that table as given and
// prove the RENDERER half: every row round-trips through the matcher into the
// catalog, an unknown message is never swallowed, and the English survives
// for the sinks that are contractually English.
import { describe, it, expect, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import i18next from '../src/renderer/i18n';
import {
  ENGINE_MESSAGE_ROWS,
  EngineError,
  literalAnchorLength,
  localizeEngineMessage,
  matchEngineMessage,
  rawEngineMessage,
} from '../src/renderer/lib/engine-messages';

const EN: Record<string, string> = JSON.parse(
  readFileSync(resolve(__dirname, '../src/renderer/locales/en/chrome.json'), 'utf8'),
);
const ES: Record<string, string> = JSON.parse(
  readFileSync(resolve(__dirname, '../src/renderer/locales/es/chrome.json'), 'utf8'),
);

const PLACEHOLDER = /\{\{([^}]*)\}\}/g;
const placeholdersOf = (s: string): string[] =>
  (s.match(PLACEHOLDER) ?? []).map((p) => p.slice(2, -2)).sort();

/** A concrete English message as the engine would emit it, with recognizable
 *  values in the interpolated slots. */
function render(template: string, value: (name: string) => string): string {
  return template.replace(PLACEHOLDER, (_, name: string) => value(name));
}

afterAll(async () => {
  await i18next.changeLanguage('en');
});

describe('engine refusal table (N12 slice D)', () => {
  it('parses the checked-in fixture', () => {
    expect(ENGINE_MESSAGE_ROWS.length).toBeGreaterThan(250);
    for (const row of ENGINE_MESSAGE_ROWS) {
      expect(row.key, `${row.key}: empty message`).toBeTruthy();
      expect(row.message.length).toBeGreaterThan(0);
      expect(row.kind).toBe(row.message.includes('{{') ? 'pattern' : 'exact');
      expect(row.modules.length, `${row.key}: no source module`).toBeGreaterThan(0);
    }
  });

  it('every row has an en catalog entry equal to the engine English', () => {
    for (const row of ENGINE_MESSAGE_ROWS) {
      expect(EN[`engine.${row.key}`], `engine.${row.key} missing from en`).toBe(row.message);
    }
  });

  it('every row is translated in es with the same placeholders', () => {
    for (const row of ENGINE_MESSAGE_ROWS) {
      const es = ES[`engine.${row.key}`];
      expect(es, `engine.${row.key} missing from es`).toBeTruthy();
      // A dropped placeholder silently deletes a file path or a page number
      // from the sentence; an invented one renders as literal braces.
      expect(placeholdersOf(es), `engine.${row.key}: placeholder drift`).toEqual(
        placeholdersOf(row.message),
      );
    }
  });
});

describe('matching an engine message', () => {
  it('round-trips every row: rendered English → its own row and values', () => {
    for (const row of ENGINE_MESSAGE_ROWS) {
      const values: Record<string, string> = {};
      // Alphanumeric sample values on purpose: a sample containing the same
      // punctuation the template uses as a separator would be testing the
      // FIXTURE's ambiguity, not the matcher.
      let n = 0;
      const message = render(row.message, (name) => {
        values[name] = `sample${n++}`;
        return values[name];
      });
      const hit = matchEngineMessage(message);
      expect(hit, `no match for ${row.key}: ${message}`).not.toBeNull();
      expect(hit!.row.key, `${row.key} was claimed by ${hit!.row.key}`).toBe(row.key);
      expect(hit!.values).toEqual(values);
    }
  });

  it('is the IDENTITY in en, for every row — the e2e suite depends on it', () => {
    // VITE_E2E forces `en`, and ~100 specs assert the engine's own English.
    // A pattern row must therefore reassemble byte-for-byte: the literals it
    // matched on are the literals it renders, around the values it captured.
    for (const row of ENGINE_MESSAGE_ROWS) {
      let n = 0;
      const message = render(row.message, () => `sample${n++}`);
      expect(localizeEngineMessage(message), `en identity broken for ${row.key}`).toBe(
        message,
      );
    }
  });

  it('reassembles losslessly even when a value contains the separator', () => {
    // A path with a drive colon inside `... for {{file}}: {{detail}}`: whichever
    // way the greedy split lands, no character is lost or duplicated.
    const raw = 'Ghostscript render failed for C:\\a: b.pdf: broken pipe';
    expect(matchEngineMessage(raw)?.row.key).toBe('compare.ghostscriptRenderFailed');
    expect(localizeEngineMessage(raw)).toBe(raw);
  });

  it('prefers the most specific pattern when two could match', () => {
    // `{{what}} failed: {{detail}}` (print_layout) is a generic shape that the
    // Ghostscript rows also satisfy; the one with more literal text wins.
    const hit = matchEngineMessage('Ghostscript failed: /tmp/x.pdf is broken');
    expect(hit).not.toBeNull();
    expect(hit!.row.key).toBe('compress.ghostscriptFailed');
    const generic = ENGINE_MESSAGE_ROWS.find((r) => r.key === 'print_layout.failed');
    expect(generic).toBeTruthy();
    expect(literalAnchorLength(hit!.row.message)).toBeGreaterThan(
      literalAnchorLength(generic!.message),
    );
  });

  it('returns null for a message the engine is not known to raise', () => {
    expect(matchEngineMessage('kaboom')).toBeNull();
    expect(matchEngineMessage('')).toBeNull();
  });
});

describe('localizing at the boundary', () => {
  it('renders an exact row in the UI language', async () => {
    const raw = 'no text to add';
    expect(localizeEngineMessage(raw)).toBe(raw);
    await i18next.changeLanguage('es');
    expect(localizeEngineMessage(raw)).toBe('no hay texto que añadir');
    await i18next.changeLanguage('en');
    expect(localizeEngineMessage(raw)).toBe(raw);
  });

  it('carries a pattern row captured value into the translation', async () => {
    const raw = 'File not found: C:\\docs\\report.pdf';
    await i18next.changeLanguage('es');
    expect(localizeEngineMessage(raw)).toBe('Archivo no encontrado: C:\\docs\\report.pdf');
    await i18next.changeLanguage('en');
    expect(localizeEngineMessage(raw)).toBe(raw);
  });

  it('PASSES THROUGH an unknown message verbatim, in any language', async () => {
    const unknown = 'GPL Ghostscript 10.03.1: Unrecoverable error, exit code 1';
    await i18next.changeLanguage('es');
    expect(localizeEngineMessage(unknown)).toBe(unknown);
    await i18next.changeLanguage('en');
    expect(localizeEngineMessage(unknown)).toBe(unknown);
  });

  it('passes through a COMPOSED message the sweep excluded', async () => {
    // `{{font}}: {{refusal}}` (system_fonts) has almost no literal text, so it
    // is deliberately not a row — recognizing it would mean matching anything.
    await i18next.changeLanguage('es');
    expect(localizeEngineMessage('Segoe UI: not a usable font file')).toBe(
      'Segoe UI: not a usable font file',
    );
    await i18next.changeLanguage('en');
  });

  it('never invents or drops text for an unmatched message', () => {
    for (const sample of ['', ' ', 'x', 'Error: 42', 'no such thing']) {
      const out = localizeEngineMessage(sample);
      if (matchEngineMessage(sample) === null) expect(out).toBe(sample);
    }
  });
});

describe('EngineError', () => {
  it('localizes `message` on every read and keeps `raw` English', async () => {
    const err = new EngineError('no text to add');
    expect(err).toBeInstanceOf(Error);
    expect(err.raw).toBe('no text to add');
    expect(err.message).toBe('no text to add');
    await i18next.changeLanguage('es');
    // The accessor re-reads the catalog, so an error already sitting in a
    // panel's state follows a live language switch instead of freezing.
    expect(err.message).toBe('no hay texto que añadir');
    expect(err.raw).toBe('no text to add');
    await i18next.changeLanguage('en');
    expect(err.message).toBe('no text to add');
  });

  it('keeps the English in the stack for diagnostics', () => {
    const err = new EngineError('no text to add');
    expect(err.stack?.split('\n')[0]).toBe('EngineError: no text to add');
  });

  it('passes an unknown refusal through as its own message', () => {
    const err = new EngineError('something the sweep has never seen');
    expect(err.message).toBe('something the sweep has never seen');
    expect(err.raw).toBe(err.message);
  });

  it('rawEngineMessage is what the ENGLISH sinks read', async () => {
    await i18next.changeLanguage('es');
    // The batch report's `reason` and the operation log are byte-pinned to
    // English (tests/batch-log.test.ts) — they must not follow the UI.
    expect(rawEngineMessage(new EngineError('no text to add'))).toBe('no text to add');
    // A non-engine error has no English/display split.
    expect(rawEngineMessage(new Error('cancelled'))).toBe('cancelled');
    expect(rawEngineMessage('plain string')).toBe('plain string');
    await i18next.changeLanguage('en');
  });
});
