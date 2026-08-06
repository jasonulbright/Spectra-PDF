// The folder form-preparation driver, with the engine and the filesystem
// injected. What is proved here is what the e2e cannot reach cheaply — the
// per-file isolation of every failure mode, the signature gate as a per-file
// decision, cancellation, and the mirror's pass-through — and what the e2e
// proves instead is that real bytes come back carrying real fields.
import { describe, expect, it, vi } from 'vitest';
import {
  candidateKey,
  kindCounts,
  runPrepApply,
  runPrepDetect,
  selectableKeys,
  summarize,
  type DetectRequest,
  type FolderPrepIo,
  type PrepDetection,
} from '../src/renderer/lib/folder-prep';
import { fileIsEligible, ineligibleReason, type DiskEntry } from '../src/renderer/lib/folder-sweep';
import type { DetectedCandidate, DetectionResult } from '../src/renderer/lib/form-candidates';
import type { SignaturePolicy } from '../src/renderer/lib/signatures';

const UNSIGNED: SignaturePolicy = { signed: false, count: 0, certified: false, level: null };
const REQUEST: DetectRequest = { scan: 'auto', lang: 'eng' };

function candidate(index: number, name: string, kind = 'text', page = 1): DetectedCandidate {
  return {
    page,
    index,
    kind,
    rect: [10, 10, 200, 30],
    label: name,
    label_source: 'left',
    label_gap: 4,
    name,
    evidence: 'rule',
    nested: false,
    group: null,
    export: null,
    multiline: false,
    comb: null,
    max_len: null,
    format: null,
    warnings: [],
  };
}

function detection(candidates: DetectedCandidate[], existing = 0): DetectionResult {
  return {
    candidates,
    pages_analyzed: [1],
    pages_by_source: { '1': 'vector' },
    unoffered: [],
    existing_fields: existing,
    truncated: false,
  };
}

interface FakeOptions {
  found?: Record<string, DetectedCandidate[]>;
  existing?: Record<string, number>;
  detectFails?: Record<string, string>;
  policies?: Record<string, SignaturePolicy>;
  policyFails?: Record<string, string>;
  createFails?: Record<string, string>;
}

function fakeIo(options: FakeOptions = {}): FolderPrepIo & {
  creates: { abs: string; output: string; candidates: number; includeSigned: boolean }[];
  copies: { src: string; dest: string }[];
} {
  const creates: {
    abs: string;
    output: string;
    candidates: number;
    includeSigned: boolean;
  }[] = [];
  const copies: { src: string; dest: string }[] = [];
  return {
    creates,
    copies,
    async detect(abs) {
      const failure = options.detectFails?.[abs];
      if (failure) throw new Error(failure);
      return detection(options.found?.[abs] ?? [], options.existing?.[abs] ?? 0);
    },
    async signaturePolicy(abs) {
      const failure = options.policyFails?.[abs];
      if (failure) throw new Error(failure);
      return options.policies?.[abs] ?? UNSIGNED;
    },
    async create(abs, output, candidates, includeSigned) {
      const failure = options.createFails?.[abs];
      if (failure) throw new Error(failure);
      creates.push({ abs, output, candidates: candidates.length, includeSigned });
      return candidates.length;
    },
    async copyFile(src, dest) {
      copies.push({ src, dest });
    },
    async ensureParentDirs() {},
  };
}

const ENTRIES: DiskEntry[] = [
  { abs: 'C:\\src\\a.pdf', rel: 'a.pdf' },
  { abs: 'C:\\src\\sub\\b.pdf', rel: 'sub\\b.pdf' },
];

async function detectTwo(options: FakeOptions = {}) {
  const io = fakeIo(options);
  const report = await runPrepDetect(ENTRIES, [], REQUEST, io, {});
  return { io, report };
}

describe('the detect sweep', () => {
  it('carries every file its own candidates', async () => {
    const { report } = await detectTwo({
      found: {
        'C:\\src\\a.pdf': [candidate(0, 'First_name'), candidate(1, 'Last_name')],
        'C:\\src\\sub\\b.pdf': [candidate(0, 'Employer')],
      },
    });
    expect(report.files.map((f) => f.candidates.length)).toEqual([2, 1]);
    expect(report.cancelled).toBe(false);
  });

  it('turns one unreadable file into one result and keeps sweeping', async () => {
    const { report } = await detectTwo({
      detectFails: { 'C:\\src\\a.pdf': 'this document is password-protected' },
      found: { 'C:\\src\\sub\\b.pdf': [candidate(0, 'Employer')] },
    });
    expect(report.files[0].skipReason).toBe('this document is password-protected');
    expect(report.files[1].candidates.length).toBe(1);
  });

  it('reports a file with no candidates rather than dropping it', async () => {
    const { report } = await detectTwo({ existing: { 'C:\\src\\a.pdf': 4 } });
    expect(report.files[0].candidates).toEqual([]);
    expect(report.files[0].existingFields).toBe(4);
    expect(report.files[0].skipReason).toBeNull();
  });

  it('spends the signature read only on files with something to write', async () => {
    const io = fakeIo({ found: { 'C:\\src\\sub\\b.pdf': [candidate(0, 'Employer')] } });
    const spy = vi.spyOn(io, 'signaturePolicy');
    await runPrepDetect(ENTRIES, [], REQUEST, io, {});
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('C:\\src\\sub\\b.pdf');
  });

  it('marks a signed file consentable and a no-changes certification refused', async () => {
    const { report } = await detectTwo({
      found: {
        'C:\\src\\a.pdf': [candidate(0, 'First_name')],
        'C:\\src\\sub\\b.pdf': [candidate(0, 'Employer')],
      },
      policies: {
        'C:\\src\\a.pdf': { signed: true, count: 1, certified: false, level: null },
        'C:\\src\\sub\\b.pdf': { signed: true, count: 1, certified: true, level: 'none' },
      },
    });
    expect(report.files[0].signed).toEqual({ reason: 'signed', count: 1, refused: false });
    expect(report.files[1].signed?.refused).toBe(true);
    expect(fileIsEligible(report.files[0], true)).toBe(true);
    expect(fileIsEligible(report.files[0], false)).toBe(false);
    // No consent reaches a refusing certification.
    expect(fileIsEligible(report.files[1], true)).toBe(false);
  });

  it('treats an unreadable signature policy as a policy that does not permit', async () => {
    const { report } = await detectTwo({
      found: { 'C:\\src\\a.pdf': [candidate(0, 'First_name')] },
      policyFails: { 'C:\\src\\a.pdf': 'the signature dictionary is damaged' },
    });
    expect(report.files[0].skipReason).toBe('the signature dictionary is damaged');
    expect(ineligibleReason(report.files[0], true)).toBe('the signature dictionary is damaged');
  });

  it('stops between files when cancelled and keeps what it found', async () => {
    const io = fakeIo({ found: { 'C:\\src\\a.pdf': [candidate(0, 'First_name')] } });
    let seen = 0;
    const report = await runPrepDetect(ENTRIES, [], REQUEST, io, {
      onProgress: () => {
        seen += 1;
      },
      isCancelled: () => seen >= 1,
    });
    expect(report.cancelled).toBe(true);
    expect(report.files.length).toBe(1);
  });

  it('offers no candidate key from a file the run would refuse', async () => {
    const { report } = await detectTwo({
      found: {
        'C:\\src\\a.pdf': [candidate(0, 'First_name')],
        'C:\\src\\sub\\b.pdf': [candidate(0, 'Employer')],
      },
      policies: {
        'C:\\src\\a.pdf': { signed: true, count: 1, certified: true, level: 'none' },
      },
    });
    const keys = selectableKeys(report.files, true);
    expect(keys).toEqual([candidateKey('C:\\src\\sub\\b.pdf', candidate(0, 'Employer'))]);
  });
});

describe('the kind histogram', () => {
  it('counts each kind the detector named', () => {
    expect(
      kindCounts([
        candidate(0, 'A'),
        candidate(1, 'B'),
        candidate(2, 'C', 'checkbox'),
      ]),
    ).toEqual({ text: 2, checkbox: 1 });
  });
});

// ── the apply sweep ───────────────────────────────────────────────────────

function detected(
  abs: string,
  rel: string,
  candidates: DetectedCandidate[],
  extra: Partial<PrepDetection> = {},
): PrepDetection {
  return {
    abs,
    rel,
    candidates,
    unoffered: [],
    existingFields: 0,
    truncated: false,
    skipReason: null,
    signed: null,
    ...extra,
  };
}

describe('the apply sweep', () => {
  it('writes only the checked candidates and mirrors the rest', async () => {
    const io = fakeIo();
    const files = [
      detected('C:\\src\\a.pdf', 'a.pdf', [candidate(0, 'First_name'), candidate(1, 'Last_name')]),
      detected('C:\\src\\sub\\b.pdf', 'sub\\b.pdf', [candidate(0, 'Employer')]),
    ];
    const selected = new Set([candidateKey('C:\\src\\a.pdf', candidate(0, 'First_name'))]);
    const report = await runPrepApply(files, selected, io, {
      destRoot: 'D:\\out',
      includeSigned: false,
    });
    expect(io.creates).toEqual([
      {
        abs: 'C:\\src\\a.pdf',
        output: 'D:\\out\\a.pdf',
        candidates: 1,
        includeSigned: false,
      },
    ]);
    // Every enumerated file lands in the mirror: one prepared, one copied.
    expect(io.copies).toEqual([{ src: 'C:\\src\\sub\\b.pdf', dest: 'D:\\out\\sub\\b.pdf' }]);
    expect(report.results.map((r) => r.status)).toEqual(['prepared', 'copied']);
  });

  it('leaves a file alone in place rather than copying it over itself', async () => {
    const io = fakeIo();
    const files = [detected('C:\\src\\a.pdf', 'a.pdf', [candidate(0, 'First_name')])];
    const report = await runPrepApply(files, new Set(), io, {
      destRoot: '',
      includeSigned: false,
    });
    expect(io.copies).toEqual([]);
    expect(report.results[0].status).toBe('unchanged');
  });

  it('writes in place over the source when no destination is given', async () => {
    const io = fakeIo();
    const files = [detected('C:\\src\\a.pdf', 'a.pdf', [candidate(0, 'First_name')])];
    await runPrepApply(files, new Set([candidateKey('C:\\src\\a.pdf', candidate(0, 'First_name'))]), io, {
      destRoot: '',
      includeSigned: false,
    });
    expect(io.creates[0].output).toBe('C:\\src\\a.pdf');
  });

  it('gives a refused file no output at all', async () => {
    const io = fakeIo();
    const files = [
      detected('C:\\src\\a.pdf', 'a.pdf', [candidate(0, 'First_name')], {
        signed: { reason: 'certified-no-changes', count: 1, refused: true },
      }),
    ];
    const report = await runPrepApply(
      files,
      new Set([candidateKey('C:\\src\\a.pdf', candidate(0, 'First_name'))]),
      io,
      { destRoot: 'D:\\out', includeSigned: true },
    );
    expect(io.creates).toEqual([]);
    expect(io.copies).toEqual([]);
    expect(report.results[0]).toEqual({
      rel: 'a.pdf',
      status: 'skipped',
      reason: 'certified to allow no changes',
    });
  });

  it('carries the consent through to the engine call', async () => {
    const io = fakeIo();
    const files = [
      detected('C:\\src\\a.pdf', 'a.pdf', [candidate(0, 'First_name')], {
        signed: { reason: 'signed', count: 1, refused: false },
      }),
    ];
    await runPrepApply(files, new Set([candidateKey('C:\\src\\a.pdf', candidate(0, 'First_name'))]), io, {
      destRoot: 'D:\\out',
      includeSigned: true,
    });
    expect(io.creates[0].includeSigned).toBe(true);
  });

  it('turns one failed write into one file result', async () => {
    const io = fakeIo({ createFails: { 'C:\\src\\a.pdf': 'these form fields cannot be created: x' } });
    const files = [
      detected('C:\\src\\a.pdf', 'a.pdf', [candidate(0, 'First_name')]),
      detected('C:\\src\\sub\\b.pdf', 'sub\\b.pdf', [candidate(0, 'Employer')]),
    ];
    const selected = new Set([
      candidateKey('C:\\src\\a.pdf', candidate(0, 'First_name')),
      candidateKey('C:\\src\\sub\\b.pdf', candidate(0, 'Employer')),
    ]);
    const report = await runPrepApply(files, selected, io, {
      destRoot: 'D:\\out',
      includeSigned: false,
    });
    expect(report.results[0]).toEqual({
      rel: 'a.pdf',
      status: 'skipped',
      reason: 'these form fields cannot be created: x',
    });
    expect(report.results[1].status).toBe('prepared');
  });

  it('reports progress for a file it refuses, so a run of refusals still moves', async () => {
    const io = fakeIo();
    const phases: string[] = [];
    const files = [
      detected('C:\\src\\a.pdf', 'a.pdf', [candidate(0, 'First_name')], {
        skipReason: 'this document is password-protected',
      }),
    ];
    await runPrepApply(files, new Set(), io, {
      destRoot: 'D:\\out',
      includeSigned: false,
      onProgress: (p) => phases.push(p.phase),
    });
    expect(phases).toEqual(['skipping']);
  });

  it('stops between files when cancelled', async () => {
    const io = fakeIo();
    const files = [
      detected('C:\\src\\a.pdf', 'a.pdf', [candidate(0, 'First_name')]),
      detected('C:\\src\\sub\\b.pdf', 'sub\\b.pdf', [candidate(0, 'Employer')]),
    ];
    let seen = 0;
    const report = await runPrepApply(files, new Set(), io, {
      destRoot: 'D:\\out',
      includeSigned: false,
      onProgress: () => {
        seen += 1;
      },
      isCancelled: () => seen >= 1,
    });
    expect(report.cancelled).toBe(true);
    expect(report.results.length).toBe(1);
  });

  it('summarizes what landed', () => {
    expect(
      summarize({
        cancelled: false,
        skippedDirs: [],
        results: [
          { rel: 'a.pdf', status: 'prepared', fields: 3, candidates: 5 },
          { rel: 'b.pdf', status: 'copied' },
          { rel: 'c.pdf', status: 'skipped', reason: 'x' },
        ],
      }),
    ).toEqual({ prepared: 1, copied: 1, unchanged: 0, skipped: 1, fields: 3 });
  });
});
