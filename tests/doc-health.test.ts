// The document-health ledger's rules.
//
// The verdict is what these tests are really about: a ledger that can report
// an unread document as clean is worse than no ledger, so every path that
// could produce `healthy` is pinned, and so is every path that must not.
import { describe, it, expect } from 'vitest';
import {
  EMPTY_HEALTH_LEDGER,
  beginCollection,
  factCount,
  factsFor,
  groupByBoundary,
  isCollecting,
  isTracked,
  pruneHealthLedger,
  recordCollection,
  retireHealth,
  runOf,
  verdictFor,
  type HealthFact,
} from '../src/renderer/lib/doc-health';
import { parseEngineHealth } from '../src/renderer/lib/doc-health-engine';
import {
  healthBoundaryKey,
  healthKindKey,
  healthMessageKey,
  healthSubject,
} from '../src/renderer/lib/doc-health-messages';

const A = { id: 'bytes-a' };
const B = { id: 'bytes-b' };

function fact(over: Partial<HealthFact> = {}): HealthFact {
  return {
    kind: 'font',
    severity: 'warning',
    boundary: 'engine',
    code: 'font.notEmbedded',
    page: null,
    params: {},
    ...over,
  };
}

/** Both runs finished, with whatever facts are given. */
function collected(path: string, buffer: object, facts: HealthFact[] = []) {
  let l = beginCollection(EMPTY_HEALTH_LEDGER, path, buffer);
  l = recordCollection(l, path, buffer, 'engine', 'collected', facts.filter((f) => f.boundary !== 'pdfjs'));
  l = recordCollection(l, path, buffer, 'pdfjs', 'collected', facts.filter((f) => f.boundary === 'pdfjs'));
  return l;
}

describe('health ledger verdicts', () => {
  it('is no-evidence before anything is collected', () => {
    expect(verdictFor(EMPTY_HEALTH_LEDGER, '/a.pdf', A)).toBe('no-evidence');
    expect(isTracked(EMPTY_HEALTH_LEDGER, '/a.pdf', A)).toBe(false);
  });

  it('stays no-evidence while a run is still in flight', () => {
    const l = beginCollection(EMPTY_HEALTH_LEDGER, '/a.pdf', A);
    expect(verdictFor(l, '/a.pdf', A)).toBe('no-evidence');
    expect(isCollecting(l, '/a.pdf', A)).toBe(true);
  });

  it('is no-evidence when only ONE boundary has answered', () => {
    let l = beginCollection(EMPTY_HEALTH_LEDGER, '/a.pdf', A);
    l = recordCollection(l, '/a.pdf', A, 'engine', 'collected', []);
    expect(verdictFor(l, '/a.pdf', A)).toBe('no-evidence');
  });

  it('is healthy only when EVERY boundary finished with zero facts', () => {
    const l = collected('/a.pdf', A);
    expect(verdictFor(l, '/a.pdf', A)).toBe('healthy');
    expect(isCollecting(l, '/a.pdf', A)).toBe(false);
  });

  it('is facts when both finished and something was reported', () => {
    const l = collected('/a.pdf', A, [fact()]);
    expect(verdictFor(l, '/a.pdf', A)).toBe('facts');
    expect(factCount(l, '/a.pdf', A)).toBe(1);
  });

  it('a FAILED run is undetermined, never healthy', () => {
    let l = beginCollection(EMPTY_HEALTH_LEDGER, '/a.pdf', A);
    l = recordCollection(l, '/a.pdf', A, 'engine', 'collected', []);
    l = recordCollection(l, '/a.pdf', A, 'pdfjs', 'failed', []);
    expect(verdictFor(l, '/a.pdf', A)).toBe('undetermined');
  });

  it('an undetermined FACT is undetermined, never facts and never healthy', () => {
    const l = collected('/a.pdf', A, [fact({ kind: 'undetermined', code: 'font.unreadable' })]);
    expect(verdictFor(l, '/a.pdf', A)).toBe('undetermined');
  });

  it('the four verdicts are distinct answers, not shades of one', () => {
    const seen = new Set([
      verdictFor(EMPTY_HEALTH_LEDGER, '/a.pdf', A),
      verdictFor(collected('/a.pdf', A), '/a.pdf', A),
      verdictFor(collected('/a.pdf', A, [fact()]), '/a.pdf', A),
      verdictFor(collected('/a.pdf', A, [fact({ kind: 'undetermined' })]), '/a.pdf', A),
    ]);
    expect(seen).toEqual(new Set(['no-evidence', 'healthy', 'facts', 'undetermined']));
  });
});

describe('retirement on a bytes change', () => {
  it('a new buffer retires the row: healthy does not survive the edit', () => {
    const l = collected('/a.pdf', A, []);
    expect(verdictFor(l, '/a.pdf', A)).toBe('healthy');
    expect(verdictFor(l, '/a.pdf', B)).toBe('no-evidence');
    expect(factsFor(l, '/a.pdf', B)).toEqual([]);
    expect(isTracked(l, '/a.pdf', B)).toBe(false);
  });

  it('facts do not survive the edit either', () => {
    const l = collected('/a.pdf', A, [fact()]);
    expect(factCount(l, '/a.pdf', B)).toBe(0);
    expect(verdictFor(l, '/a.pdf', B)).toBe('no-evidence');
  });

  it('a null buffer is never a verdict about anything', () => {
    const l = collected('/a.pdf', A, [fact()]);
    expect(verdictFor(l, '/a.pdf', null)).toBe('no-evidence');
    expect(verdictFor(l, '/a.pdf', undefined)).toBe('no-evidence');
  });

  it('a result for retired bytes is DROPPED rather than merged', () => {
    let l = beginCollection(EMPTY_HEALTH_LEDGER, '/a.pdf', A);
    // The bytes change under the in-flight run…
    l = beginCollection(l, '/a.pdf', B);
    // …and the old run finally answers.
    l = recordCollection(l, '/a.pdf', A, 'engine', 'collected', [fact()]);
    expect(factsFor(l, '/a.pdf', B)).toEqual([]);
    expect(verdictFor(l, '/a.pdf', B)).toBe('no-evidence');
  });

  it('re-check discards the row for the SAME bytes', () => {
    const l = collected('/a.pdf', A, [fact()]);
    const after = retireHealth(l, '/a.pdf');
    expect(verdictFor(after, '/a.pdf', A)).toBe('no-evidence');
    expect(retireHealth(after, '/a.pdf')).toBe(after);
  });

  it('re-collecting one boundary replaces only that boundary’s facts', () => {
    let l = collected('/a.pdf', A, [
      fact({ boundary: 'engine' }),
      fact({ boundary: 'qpdf', kind: 'recovered', code: 'xref.reconstructed' }),
      fact({ boundary: 'pdfjs', code: 'font.substituted' }),
    ]);
    l = recordCollection(l, '/a.pdf', A, 'engine', 'collected', []);
    // qpdf's facts arrive on the ENGINE's run, so they go with it.
    expect(factsFor(l, '/a.pdf', A).map((f) => f.boundary)).toEqual(['pdfjs']);
  });

  it('runOf sends qpdf facts down the engine run', () => {
    expect(runOf('qpdf')).toBe('engine');
    expect(runOf('engine')).toBe('engine');
    expect(runOf('pdfjs')).toBe('pdfjs');
  });
});

describe('facts never leak between documents', () => {
  it('one file’s row says nothing about another', () => {
    let l = collected('/a.pdf', A, [fact()]);
    l = beginCollection(l, '/b.pdf', B);
    l = recordCollection(l, '/b.pdf', B, 'engine', 'collected', []);
    l = recordCollection(l, '/b.pdf', B, 'pdfjs', 'collected', []);
    expect(factCount(l, '/a.pdf', A)).toBe(1);
    expect(factCount(l, '/b.pdf', B)).toBe(0);
    expect(verdictFor(l, '/b.pdf', B)).toBe('healthy');
  });

  it('the same buffer object under a different path is still a different row', () => {
    const l = collected('/a.pdf', A, [fact()]);
    expect(verdictFor(l, '/b.pdf', A)).toBe('no-evidence');
  });

  it('closing a file drops its row, and nothing else', () => {
    let l = collected('/a.pdf', A, [fact()]);
    l = beginCollection(l, '/b.pdf', B);
    const pruned = pruneHealthLedger(l, new Set(['/b.pdf']));
    expect(verdictFor(pruned, '/a.pdf', A)).toBe('no-evidence');
    expect(isTracked(pruned, '/b.pdf', B)).toBe(true);
  });

  it('pruning nothing returns the same ledger', () => {
    const l = collected('/a.pdf', A);
    expect(pruneHealthLedger(l, new Set(['/a.pdf']))).toBe(l);
  });
});

describe('grouping', () => {
  it('groups by boundary in reader order and drops empty groups', () => {
    const facts = [
      fact({ boundary: 'engine' }),
      fact({ boundary: 'pdfjs', code: 'font.substituted' }),
    ];
    expect(groupByBoundary(facts).map((g) => g.boundary)).toEqual(['pdfjs', 'engine']);
    expect(groupByBoundary([])).toEqual([]);
  });
});

describe('the engine reply parser', () => {
  it('converts 1-based page numbers to indexes', () => {
    const parsed = parseEngineHealth({
      status: 'collected',
      facts: [{ kind: 'font', severity: 'warning', boundary: 'engine', code: 'font.notEmbedded', page: 1, params: { font: 'Helvetica' } }],
    });
    expect(parsed.ok).toBe(true);
    expect(parsed.facts[0].page).toBe(0);
    expect(parsed.facts[0].params.font).toBe('Helvetica');
  });

  it('keeps a document-level fact page-less', () => {
    const parsed = parseEngineHealth({
      status: 'collected',
      facts: [{ kind: 'recovered', severity: 'warning', boundary: 'qpdf', code: 'xref.reconstructed', page: null, params: {} }],
    });
    expect(parsed.facts[0].page).toBeNull();
  });

  it('an unrecognized kind becomes undetermined, never a benign one', () => {
    const parsed = parseEngineHealth({ status: 'collected', facts: [{ code: 'x', kind: 'delightful' }] });
    expect(parsed.facts[0].kind).toBe('undetermined');
    // …and that is enough to keep the document off a clean verdict.
    const l = collected('/a.pdf', A, [...parsed.facts]);
    expect(verdictFor(l, '/a.pdf', A)).toBe('undetermined');
  });

  it('a reply of the wrong shape is not ok, so the caller fails the run', () => {
    expect(parseEngineHealth(null).ok).toBe(false);
    expect(parseEngineHealth('boom').ok).toBe(false);
    expect(parseEngineHealth({ status: 'collected' }).ok).toBe(false);
  });

  it('drops params that are not scalar values', () => {
    const parsed = parseEngineHealth({
      status: 'collected',
      facts: [{ kind: 'font', code: 'c', params: { font: 'A', nested: { x: 1 } } }],
    });
    expect(parsed.facts[0].params).toEqual({ font: 'A' });
  });
});

describe('codes map to catalog keys, never to sentences', () => {
  it('maps every code the engine and pdf.js emit', () => {
    const codes = [
      'xref.reconstructed', 'structure.repaired', 'font.notEmbedded', 'font.substituted',
      'font.unreadable', 'page.mediaBoxMissing', 'page.contentUnreadable',
      'page.imageUnreadable', 'document.xfa', 'document.encrypted', 'document.unreadable',
      'document.metadataUnreadable', 'page.unreadable', 'page.resourcesUnreadable',
      'pages.unreadable', 'fonts.unenumerable', 'warnings.unreadable',
    ];
    for (const code of codes) {
      expect(healthMessageKey(code), code).not.toBe('panel.health.code.unknown');
      expect(healthMessageKey(code), code).toMatch(/^panel\.health\.code\./);
    }
  });

  it('an unknown code degrades to "something was reported", not to silence', () => {
    expect(healthMessageKey('from.a.newer.engine')).toBe('panel.health.code.unknown');
  });

  it('boundary and kind labels come from the catalog too', () => {
    expect(healthBoundaryKey('qpdf')).toBe('panel.health.boundary.qpdf');
    expect(healthKindKey('undetermined')).toBe('panel.health.kind.undetermined');
  });

  it('the subject is the document’s own name for the thing', () => {
    expect(healthSubject({ font: 'Helvetica' })).toBe('Helvetica');
    expect(healthSubject({ name: 'Im0' })).toBe('Im0');
    expect(healthSubject({})).toBe('');
  });
});
