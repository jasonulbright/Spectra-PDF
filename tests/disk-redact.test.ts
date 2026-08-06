// The disk Search & Redact driver: the folder half of the feature, with the
// engine and the filesystem injected. What is proved here is what the e2e
// cannot reach cheaply — the per-file isolation of every failure mode, the
// signature gate as a per-file decision, cancellation, and the mirror's
// pass-through — and what the e2e proves instead is that real bytes come back
// redacted.
import { describe, expect, it, vi } from 'vitest';
import {
  fileIsEligible,
  ineligibleReason,
  joinDest,
  runDiskApply,
  runDiskSearch,
  selectableKeys,
  signedReasonText,
  summarize,
  type DiskEntry,
  type DiskRedactIo,
  type DiskSearchResult,
} from '../src/renderer/lib/disk-redact';
import { hitKey, type SearchHit, type SearchRequest } from '../src/renderer/lib/search-redact';
import type { SignaturePolicy } from '../src/renderer/lib/signatures';

const UNSIGNED: SignaturePolicy = { signed: false, count: 0, certified: false, level: null };

const REQUEST: SearchRequest = {
  query: 'Jane Roe',
  terms: [],
  patterns: [],
  options: {},
  expand: 'match',
  pages: null,
  maxHits: 50000,
};

function hit(page: number, index: number, text = 'Jane Roe'): SearchHit {
  return {
    page,
    index,
    text,
    source: 'query',
    context: text,
    rects: [{ run: 0, rect: [10, 10, 60, 24], codes: [0, 8], partial: false, imprecise: false }],
    runs: [0],
  };
}

interface FakeOptions {
  hits?: Record<string, SearchHit[]>;
  searchFails?: Record<string, string>;
  policies?: Record<string, SignaturePolicy>;
  policyFails?: Record<string, string>;
  writeFails?: Record<string, string>;
}

function fakeIo(options: FakeOptions = {}): DiskRedactIo & {
  writes: { abs: string; output: string; regions: number; marksOnly: boolean }[];
  copies: { src: string; dest: string }[];
} {
  const writes: { abs: string; output: string; regions: number; marksOnly: boolean }[] = [];
  const copies: { src: string; dest: string }[] = [];
  return {
    writes,
    copies,
    async search(abs) {
      const failure = options.searchFails?.[abs];
      if (failure) throw new Error(failure);
      return {
        hits: options.hits?.[abs] ?? [],
        truncated: false,
        pages_without_text: [],
        error: null,
      };
    },
    async signaturePolicy(abs) {
      const failure = options.policyFails?.[abs];
      if (failure) throw new Error(failure);
      return options.policies?.[abs] ?? UNSIGNED;
    },
    async write(abs, output, regions, marksOnly) {
      const failure = options.writeFails?.[abs];
      if (failure) throw new Error(failure);
      writes.push({ abs, output, regions: regions.length, marksOnly });
    },
    async copyFile(src, dest) {
      copies.push({ src, dest });
    },
    async ensureParentDirs() {},
  };
}

const entries: DiskEntry[] = [
  { abs: 'C:\\src\\a.pdf', rel: 'a.pdf' },
  { abs: 'C:\\src\\sub\\b.pdf', rel: 'sub\\b.pdf' },
];

describe('joinDest', () => {
  it('uses the separator style the root already uses', () => {
    expect(joinDest('C:\\out', 'sub\\b.pdf')).toBe('C:\\out\\sub\\b.pdf');
    expect(joinDest('/out/', 'sub/b.pdf')).toBe('/out/sub/b.pdf');
    expect(joinDest('C:\\out\\', 'a.pdf')).toBe('C:\\out\\a.pdf');
  });
});

describe('the search sweep', () => {
  it('reports hits per file and reindexes them', async () => {
    const io = fakeIo({ hits: { 'C:\\src\\a.pdf': [hit(1, 7), hit(3, 9)] } });
    const report = await runDiskSearch(entries, [], REQUEST, false, io);
    expect(report.cancelled).toBe(false);
    expect(report.files).toHaveLength(2);
    expect(report.files[0].hits.map((h) => h.index)).toEqual([0, 1]);
    expect(report.files[1].hits).toHaveLength(0);
  });

  it('turns one file failure into one file result and keeps sweeping', async () => {
    const io = fakeIo({
      searchFails: { 'C:\\src\\a.pdf': 'invalid password' },
      hits: { 'C:\\src\\sub\\b.pdf': [hit(1, 0)] },
    });
    const report = await runDiskSearch(entries, [], REQUEST, false, io);
    expect(report.files[0].skipReason).toBe('invalid password');
    expect(report.files[1].hits).toHaveLength(1);
  });

  it('spends the signature read only on files that have something to write', async () => {
    const spy = vi.fn(async () => UNSIGNED);
    const io = { ...fakeIo({ hits: { 'C:\\src\\a.pdf': [hit(1, 0)] } }), signaturePolicy: spy };
    await runDiskSearch(entries, [], REQUEST, false, io);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('records a warning decision for a signed document and a refusal for a locked one', async () => {
    const io = fakeIo({
      hits: { 'C:\\src\\a.pdf': [hit(1, 0)], 'C:\\src\\sub\\b.pdf': [hit(1, 0)] },
      policies: {
        'C:\\src\\a.pdf': { signed: true, count: 2, certified: false, level: null },
        'C:\\src\\sub\\b.pdf': { signed: true, count: 1, certified: true, level: 'none' },
      },
    });
    const report = await runDiskSearch(entries, [], REQUEST, false, io);
    expect(report.files[0].signed).toEqual({ reason: 'signed', count: 2, refused: false });
    expect(report.files[1].signed?.refused).toBe(true);
  });

  it('marks mode asks the annotate question, so a signed document passes', async () => {
    const io = fakeIo({
      hits: { 'C:\\src\\a.pdf': [hit(1, 0)] },
      policies: { 'C:\\src\\a.pdf': { signed: true, count: 1, certified: false, level: null } },
    });
    const report = await runDiskSearch(entries, [], REQUEST, true, io);
    expect(report.files[0].signed).toBeNull();
  });

  it('a policy that cannot be read makes the file ineligible rather than assumed clear', async () => {
    const io = fakeIo({
      hits: { 'C:\\src\\a.pdf': [hit(1, 0)] },
      policyFails: { 'C:\\src\\a.pdf': 'unreadable catalog' },
    });
    const report = await runDiskSearch(entries, [], REQUEST, false, io);
    expect(report.files[0].skipReason).toBe('unreadable catalog');
    expect(fileIsEligible(report.files[0], true)).toBe(false);
  });

  it('stops between files when cancelled', async () => {
    const io = fakeIo();
    const report = await runDiskSearch(entries, [], REQUEST, false, io, {
      isCancelled: () => true,
    });
    expect(report.cancelled).toBe(true);
    expect(report.files).toHaveLength(0);
  });
});

describe('eligibility', () => {
  const warned: DiskSearchResult = {
    abs: 'C:\\src\\a.pdf',
    rel: 'a.pdf',
    hits: [hit(1, 0)],
    pagesWithoutText: [],
    truncated: false,
    error: null,
    skipReason: null,
    signed: { reason: 'signed', count: 1, refused: false },
  };
  const refused: DiskSearchResult = {
    ...warned,
    signed: { reason: 'certified-no-changes', count: 1, refused: true },
  };

  it('a warning is consentable and a refusal never is', () => {
    expect(fileIsEligible(warned, false)).toBe(false);
    expect(fileIsEligible(warned, true)).toBe(true);
    expect(fileIsEligible(refused, true)).toBe(false);
  });

  it('the ineligible reason is the engine text when there is one', () => {
    expect(ineligibleReason({ ...warned, skipReason: 'damaged' }, true)).toBe('damaged');
    expect(ineligibleReason(warned, false)).toBe('signed (1 signature)');
    expect(ineligibleReason(warned, true)).toBeNull();
  });

  it('a check-everything control never offers a file the run would refuse', () => {
    expect(selectableKeys([warned, refused], true)).toEqual([hitKey(warned.abs, warned.hits[0])]);
    expect(selectableKeys([warned, refused], false)).toEqual([]);
  });

  it('every signed reason has English for the log', () => {
    for (const reason of [
      'signed',
      'certified-no-changes',
      'certified-form-fill',
      'certified-annotate',
      'certified-unknown',
    ] as const) {
      expect(signedReasonText({ reason, count: 2, refused: false }).length).toBeGreaterThan(0);
    }
  });
});

describe('the apply sweep', () => {
  async function searched(options: FakeOptions = {}): Promise<DiskSearchResult[]> {
    const report = await runDiskSearch(entries, [], REQUEST, false, fakeIo(options));
    return report.files;
  }

  it('writes only the checked hits and copies the rest of the tree through', async () => {
    const files = await searched({
      hits: { 'C:\\src\\a.pdf': [hit(1, 0), hit(2, 1)], 'C:\\src\\sub\\b.pdf': [hit(1, 0)] },
    });
    const io = fakeIo();
    const selected = new Set([hitKey(files[0].abs, files[0].hits[0])]);
    const report = await runDiskApply(files, selected, io, {
      destRoot: 'C:\\out',
      marksOnly: false,
      includeSigned: false,
    });
    expect(io.writes).toEqual([
      { abs: 'C:\\src\\a.pdf', output: 'C:\\out\\a.pdf', regions: 1, marksOnly: false },
    ]);
    expect(io.copies).toEqual([
      { src: 'C:\\src\\sub\\b.pdf', dest: 'C:\\out\\sub\\b.pdf' },
    ]);
    expect(report.results.map((r) => r.status)).toEqual(['redacted', 'copied']);
    expect(summarize(report)).toMatchObject({ redacted: 1, copied: 1, regions: 1 });
  });

  it('in place writes over the source and leaves an unchecked file alone', async () => {
    const files = await searched({ hits: { 'C:\\src\\a.pdf': [hit(1, 0)] } });
    const io = fakeIo();
    const report = await runDiskApply(
      files,
      new Set([hitKey(files[0].abs, files[0].hits[0])]),
      io,
      { destRoot: '', marksOnly: true, includeSigned: false },
    );
    expect(io.writes[0]).toMatchObject({ abs: 'C:\\src\\a.pdf', output: 'C:\\src\\a.pdf', marksOnly: true });
    expect(io.copies).toEqual([]);
    expect(report.results.map((r) => r.status)).toEqual(['marked', 'unchanged']);
  });

  it('an ineligible file is skipped with its reason and is not mirrored', async () => {
    const files = await searched({
      hits: { 'C:\\src\\a.pdf': [hit(1, 0)] },
      policies: { 'C:\\src\\a.pdf': { signed: true, count: 1, certified: true, level: 'none' } },
    });
    const io = fakeIo();
    const report = await runDiskApply(files, new Set(selectableKeys(files, true)), io, {
      destRoot: 'C:\\out',
      marksOnly: false,
      includeSigned: true,
    });
    expect(report.results[0]).toEqual({
      rel: 'a.pdf',
      status: 'skipped',
      reason: 'certified to allow no changes',
    });
    // Not written, and not mirrored either: a file the run may not change has
    // no output, and the report is where it is accounted for.
    expect(io.writes).toEqual([]);
    expect(io.copies.map((c) => c.src)).not.toContain('C:\\src\\a.pdf');
  });

  it('a write failure is one file result, not a run failure', async () => {
    const files = await searched({
      hits: { 'C:\\src\\a.pdf': [hit(1, 0)], 'C:\\src\\sub\\b.pdf': [hit(1, 0)] },
    });
    const io = fakeIo({ writeFails: { 'C:\\src\\a.pdf': 'output is read-only' } });
    const report = await runDiskApply(files, new Set(selectableKeys(files, false)), io, {
      destRoot: 'C:\\out',
      marksOnly: false,
      includeSigned: false,
    });
    expect(report.results[0]).toMatchObject({ status: 'skipped', reason: 'output is read-only' });
    expect(report.results[1].status).toBe('redacted');
  });

  it('stops between files when cancelled and reports what landed', async () => {
    const files = await searched({
      hits: { 'C:\\src\\a.pdf': [hit(1, 0)], 'C:\\src\\sub\\b.pdf': [hit(1, 0)] },
    });
    const io = fakeIo();
    let calls = 0;
    const report = await runDiskApply(files, new Set(selectableKeys(files, false)), io, {
      destRoot: 'C:\\out',
      marksOnly: false,
      includeSigned: false,
      isCancelled: () => calls++ > 0,
    });
    expect(report.cancelled).toBe(true);
    expect(report.results).toHaveLength(1);
  });
});
