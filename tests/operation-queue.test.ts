import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { QueueItem } from '../src/renderer/components/OperationQueue';
import {
  FRIENDLY_NAMES,
  describeResult,
  formatOutcome,
  formatQueueLabel,
  isTrackableMethod,
  runTracked,
  upsertQueueItem,
  type QueueSinks,
} from '../src/renderer/hooks/useOperationQueue';

// The INTERNAL_METHODS allowlist exempts pure reads from the commit gate +
// the visible operation queue. A read that slips OUT of the list force-
// commits pending page edits on every call (the get_pdf_version incident).
describe('isTrackableMethod — internal-read exemptions', () => {
  it('exempts the pure reads (they must never gate/queue)', () => {
    for (const m of [
      'get_page_count',
      'get_metadata',
      'get_pdf_version',
      'get_outline',
      'open_document_attempt',
      // The fit indicator fires on every keystroke pause; if it
      // gated, it would commit unrelated pending page edits mid-typing.
      'measure_text_box',
    ]) {
      expect(isTrackableMethod(m)).toBe(false);
    }
  });

  it('tracks real operations (they gate + queue)', () => {
    for (const m of ['add_text_box', 'merge', 'sign_pdf', 'delete']) {
      expect(isTrackableMethod(m)).toBe(true);
    }
  });
});

// A trackable method with no FRIENDLY_NAMES row reaches the queue and the log
// as its raw engine id. Every method the engine registers, and every literal
// method id a renderer call site names, is either an internal read or a named
// operation; a name on an untracked method would be dead text.
describe('every engine method is classified', () => {
  const classified = (m: string): boolean => !isTrackableMethod(m) || Object.hasOwn(FRIENDLY_NAMES, m);

  it('covers every method the engine registers', () => {
    const main = readFileSync(resolve(__dirname, '../src/engine/__main__.py'), 'utf8');
    const registered = [...main.matchAll(/server\.register\("([a-z_0-9]+)"/g)].map((m) => m[1]);
    expect(registered.length).toBeGreaterThan(200);
    expect(registered.filter((m) => !classified(m))).toEqual([]);
  });

  it('covers every literal method id at a renderer call site', () => {
    const root = resolve(__dirname, '../src/renderer');
    const callSite =
      /\b(?:call|callRaw|performOperation|trackOperation|track)\(\s*(?:[A-Za-z_.]+\s*,\s*)?'([a-z][a-z_0-9]+)'/g;
    const ids = new Set<string>();
    for (const rel of readdirSync(root, { recursive: true, encoding: 'utf8' })) {
      if (!/\.tsx?$/.test(rel) || rel.startsWith('locales')) continue;
      for (const m of readFileSync(join(root, rel), 'utf8').matchAll(callSite)) ids.add(m[1]);
    }
    expect(ids.size).toBeGreaterThan(100);
    expect([...ids].filter((m) => !classified(m)).sort()).toEqual([]);
  });

  it('names only methods that reach the queue', () => {
    expect(Object.keys(FRIENDLY_NAMES).filter((m) => !isTrackableMethod(m))).toEqual([]);
  });

  it('renders a read that was unnamed as its operation name, never its id', () => {
    expect(formatQueueLabel({ method: 'list_text_paragraphs', file: 'a.pdf' }, 'en')).toBe('Read Paragraphs — a.pdf');
  });
});

// A redaction run that reports only its region count cannot tell a user what
// happened to a scanned page: an image under a mark either keeps its unmarked
// pixels or is removed whole — and either can have gone further than the mark
// because of how the image was compressed. The record distinguishes all four.
describe('describeResult — what a redaction did to the images under the marks', () => {
  const result = {
    images_modified: 3,
    images_widened: 1,
    images_removed: 2,
    images_removed_for_compression: 1,
  };

  it('reads the four counts of a redaction', () => {
    expect(describeResult('redact', result)).toEqual({
      imagesModified: 3,
      imagesWidened: 1,
      imagesRemoved: 2,
      imagesRemovedForCompression: 1,
    });
  });

  it('reads a search-and-redact run the same way', () => {
    expect(describeResult('search_and_redact', result)).toEqual(describeResult('redact', result));
  });

  it('never counts more widened or compressed images than the totals they belong to', () => {
    expect(
      describeResult('redact', { images_modified: 1, images_widened: 4, images_removed: 0, images_removed_for_compression: 2 }),
    ).toEqual({ imagesModified: 1, imagesWidened: 1, imagesRemoved: 0, imagesRemovedForCompression: 0 });
  });

  it('is null when no image was touched, so the record stays quiet', () => {
    expect(describeResult('redact', { images_modified: 0, images_removed: 0 })).toBeNull();
    expect(describeResult('redact', { text_runs_removed: 3 })).toBeNull();
  });

  it('reads nothing from any other method, and nothing from a non-object', () => {
    expect(describeResult('merge', { images_modified: 2 })).toBeNull();
    expect(describeResult('redact', null)).toBeNull();
    expect(describeResult('redact', 'ok')).toBeNull();
  });

  it('ignores values that are not numbers rather than passing them through', () => {
    expect(describeResult('redact', { images_modified: 'lots' })).toBeNull();
  });
});

describe('formatOutcome — a finished line, in the language asked for', () => {
  it('names every category that happened, each once', () => {
    expect(
      formatOutcome(
        { imagesModified: 3, imagesWidened: 1, imagesRemoved: 2, imagesRemovedForCompression: 1 },
        'en',
      ),
    ).toBe(
      'Complete — 2 images partly redacted, 1 image redacted past the mark because of its compression, ' +
        '1 image removed, 1 image removed whole because of its compression',
    );
  });

  it('names only what happened', () => {
    expect(
      formatOutcome({ imagesModified: 1, imagesWidened: 0, imagesRemoved: 0, imagesRemovedForCompression: 0 }, 'en'),
    ).toBe('Complete — 1 image partly redacted');
    expect(
      formatOutcome({ imagesModified: 0, imagesWidened: 0, imagesRemoved: 2, imagesRemovedForCompression: 2 }, 'en'),
    ).toBe('Complete — 2 images removed whole because of their compression');
  });

  it('falls back to the plain completion for every other operation', () => {
    expect(formatOutcome(null, 'en')).toBe('Complete');
  });

  it('renders from the catalog of the language it is given', () => {
    const outcome = { imagesModified: 2, imagesWidened: 0, imagesRemoved: 1, imagesRemovedForCompression: 0 };
    const german = formatOutcome(outcome, 'de');
    expect(german.startsWith('Abgeschlossen')).toBe(true);
    expect(german).not.toContain('image');
    expect(formatOutcome(null, 'de')).toBe('Abgeschlossen');
  });
});

describe('runTracked — one operation, one line, one log entry', () => {
  function sinks(): QueueSinks & { items: QueueItem[]; lines: string[] } {
    const record = { items: [] as QueueItem[], lines: [] as string[] };
    let clock = 1_000;
    return Object.assign(record, {
      put: (item: QueueItem) => {
        record.items = upsertQueueItem(record.items, item);
      },
      log: (line: string) => {
        record.lines.push(line);
      },
      now: () => (clock += 500),
    });
  }

  it('records what a redaction did on the line and in the log', async () => {
    const sink = sinks();
    const result = { images_modified: 1, images_removed: 0 };
    await expect(
      runTracked('1', 'redact', { file: 'C:/scan.pdf', regions: [{}] }, async () => result, sink),
    ).resolves.toBe(result);
    expect(sink.items).toHaveLength(1);
    expect(sink.items[0].status).toBe('done');
    expect(sink.items[0].outcome).toEqual({
      imagesModified: 1,
      imagesWidened: 0,
      imagesRemoved: 0,
      imagesRemovedForCompression: 0,
    });
    expect(sink.lines).toHaveLength(1);
    expect(sink.lines[0]).toContain('[OK]');
    expect(sink.lines[0]).toContain('Complete — 1 image partly redacted');
  });

  it('shows the operation running before it finishes', async () => {
    const sink = sinks();
    let release: (value: unknown) => void = () => {};
    const pending = runTracked('7', 'merge', {}, () => new Promise((resolve) => (release = resolve)), sink);
    expect(sink.items.map((item) => item.status)).toEqual(['running']);
    release({});
    await pending;
    expect(sink.items.map((item) => item.status)).toEqual(['done']);
    expect(sink.items[0].outcome).toBeNull();
    expect(sink.lines[0]).toContain('Complete');
  });

  it('fixes the elapsed time at completion, matching the log', async () => {
    const sink = sinks();
    await runTracked('3', 'merge', {}, async () => ({}), sink);
    const done = sink.items[0];
    expect(done.endTime).toBe(2_000);
    expect(done.endTime! - done.startTime).toBe(500);
    expect(sink.lines[0]).toContain('(0.5s)');
    sink.now();
    expect(sink.items[0].endTime).toBe(2_000);
  });

  it("keeps a failure's own text on the line and in the log, and rethrows it", async () => {
    const sink = sinks();
    const refusal = new Error('This image cannot be partly redacted (a JPEG 2000 palette image). Mark the whole image to remove it.');
    await expect(
      runTracked('2', 'redact', { regions: [] }, async () => {
        throw refusal;
      }, sink),
    ).rejects.toBe(refusal);
    expect(sink.items[0].status).toBe('error');
    expect(sink.items[0].message).toBe(refusal.message);
    expect(sink.lines[0]).toContain('[ERROR]');
    expect(sink.lines[0]).toContain('a JPEG 2000 palette image');
  });

  it('records a synchronous failure before the operation returns a promise', async () => {
    const sink = sinks();
    const refusal = new Error('The operation could not start.');
    const pending = Promise.resolve().then(() =>
      runTracked('4', 'merge', {}, () => { throw refusal; }, sink),
    );
    await expect(pending).rejects.toBe(refusal);
    expect(sink.items[0].status).toBe('error');
    expect(sink.items[0].message).toBe(refusal.message);
    expect(sink.lines).toHaveLength(1);
    expect(sink.lines[0]).toContain('[ERROR]');
  });
});

describe('upsertQueueItem', () => {
  const item = (id: string, status: QueueItem['status']): QueueItem => ({
    id,
    label: { method: 'merge' },
    status,
    message: '',
    outcome: null,
    startTime: 0,
  });

  it('adds a new operation at the end and replaces a known one in place', () => {
    const first = upsertQueueItem(upsertQueueItem([], item('1', 'running')), item('2', 'running'));
    const updated = upsertQueueItem(first, item('1', 'done'));
    expect(updated.map((entry) => [entry.id, entry.status])).toEqual([
      ['1', 'done'],
      ['2', 'running'],
    ]);
  });
});
