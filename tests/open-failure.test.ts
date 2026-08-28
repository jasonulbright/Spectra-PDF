// U7 — a failed open must say something, and what it says must name the file
// the user chose. Both halves are pure: the translation away from the temp
// working copy, and the collapse of a batch's outcomes into ONE notice.
import { describe, it, expect } from 'vitest';
import {
  summarizeOpenOutcomes,
  translateOpenFailure,
  type OpenOutcome,
} from '../src/renderer/lib/open-failure';

const TEMP =
  'C:\\Users\\someone\\AppData\\Local\\Temp\\spectrapdf-8f21\\05-no-root-in-trailer.pdf';
const USER = 'C:\\Users\\someone\\Documents\\Quarterly Report.pdf';
const NAME = 'Quarterly Report.pdf';

describe('translateOpenFailure', () => {
  it('replaces the temp working-copy path with the user filename', () => {
    const out = translateOpenFailure(`${TEMP}: unable to find /Root dictionary`, {
      name: NAME,
      workingPath: TEMP,
      path: USER,
    });
    expect(out).toBe('unable to find /Root dictionary');
    expect(out).not.toContain('Temp');
    expect(out).not.toContain('spectrapdf-8f21');
  });

  it('scrubs a temp path it was never told about', () => {
    // The throw can happen before a working path exists to pass in; the
    // message still must not carry one.
    const out = translateOpenFailure(`${TEMP}: unable to find /Root dictionary`, { name: NAME });
    expect(out).toBe('unable to find /Root dictionary');
    expect(out).not.toContain('AppData');
  });

  it('scrubs a temp path in the middle of a sentence, in either separator', () => {
    const posix = TEMP.replace(/\\/g, '/');
    const out = translateOpenFailure(`error reading ${posix} while opening`, { name: NAME });
    expect(out).toBe(`error reading ${NAME} while opening`);
  });

  it('keeps the reason when the message carries no path at all', () => {
    expect(translateOpenFailure('  Invalid PDF structure  ', { name: NAME })).toBe(
      'Invalid PDF structure',
    );
  });

  it('leaves PDF structural names alone', () => {
    const out = translateOpenFailure('unable to find /Root dictionary in /Pages', { name: NAME });
    expect(out).toBe('unable to find /Root dictionary in /Pages');
  });

  it('does not stutter the filename the surrounding sentence already gives', () => {
    expect(translateOpenFailure(`${NAME}: ${NAME}: broken`, { name: NAME })).toBe('broken');
  });

  it('never leaks the user path either — a message names a file, not a location', () => {
    const out = translateOpenFailure(`${USER}: damaged`, { name: NAME, path: USER });
    expect(out).toBe('damaged');
  });

  // The engine's text is influenced by the document, so a hostile file can
  // choose it. A path matcher whose segment class also matched the separator
  // backtracked exponentially on a separator flood — ~5s at 30 separators,
  // doubling every two more — hanging the renderer.
  it('completes on a separator flood instead of backtracking', () => {
    const flood = `error reading C:\\${'/'.repeat(30)}! while opening`;
    const started = performance.now();
    const out = translateOpenFailure(flood, { name: NAME });
    expect(performance.now() - started).toBeLessThan(200);
    expect(out).toBe(flood);
  });

  it('scrubs a very long path in linear time', () => {
    const deep = `C:\\${'seg/'.repeat(1250)}report.pdf`;
    const started = performance.now();
    const out = translateOpenFailure(`error reading ${deep} while opening`, { name: NAME });
    expect(performance.now() - started).toBeLessThan(200);
    expect(out).toBe(`error reading ${NAME} while opening`);
  });
});

describe('summarizeOpenOutcomes', () => {
  const ok = (name: string): OpenOutcome => ({ name, reason: null });
  const bad = (name: string, reason: string): OpenOutcome => ({ name, reason });

  it('says nothing when every file opened', () => {
    expect(summarizeOpenOutcomes([ok('a.pdf'), ok('b.pdf')])).toEqual({ kind: 'none' });
  });

  it('says nothing for an empty batch', () => {
    expect(summarizeOpenOutcomes([])).toEqual({ kind: 'none' });
  });

  it('reports a lone failure as itself', () => {
    expect(summarizeOpenOutcomes([bad('a.pdf', 'damaged')])).toEqual({
      kind: 'single',
      name: 'a.pdf',
      reason: 'damaged',
    });
  });

  it('aggregates a multi-file batch into ONE result, never one per file', () => {
    const summary = summarizeOpenOutcomes([
      ok('a.pdf'),
      bad('b.pdf', 'no /Root'),
      ok('c.pdf'),
      bad('d.pdf', 'not a PDF'),
    ]);
    expect(summary).toEqual({
      kind: 'batch',
      openedCount: 2,
      totalCount: 4,
      failures: [
        { name: 'b.pdf', reason: 'no /Root' },
        { name: 'd.pdf', reason: 'not a PDF' },
      ],
    });
  });

  it('stays a batch when a multi-file open failed entirely', () => {
    const summary = summarizeOpenOutcomes([bad('a.pdf', 'x'), bad('b.pdf', 'y')]);
    expect(summary.kind).toBe('batch');
    if (summary.kind !== 'batch') return;
    expect(summary.openedCount).toBe(0);
    expect(summary.totalCount).toBe(2);
  });
});
