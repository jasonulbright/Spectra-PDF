import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it, vi } from 'vitest';
import {
  acceptedRegions,
  awaitReviewPages,
  captureExportRequest,
  exportRegions,
  ownedAcceptedRegions,
  quarter,
  regionsFromDetection,
  sessionMatches,
  tableReviewPages,
  type TableDetectionResult,
  type TableRegion,
  type TableReviewSession,
} from '../src/renderer/lib/table-review';

// Run the ACTUAL canvas closures — the export and the detection publish — with
// controllable workspace state. The defect this pins was a stable identity
// path sent to the engine in place of the working copy that holds the
// displayed bytes; a hand-copied closure would not prove what production
// dispatches, so the closures are lifted from the source by their names.
const path = 'src/renderer/components/canvas/WorkspaceCanvasView.tsx';
const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const closures = new Map<string, ts.Expression>();
function visit(node: ts.Node) {
  if (ts.isVariableDeclaration(node) && node.initializer && ts.isCallExpression(node.initializer)) {
    const name = node.name.getText(source);
    if (name === 'exportReviewedTables' || name === 'publishTables') closures.set(name, node.initializer.arguments[0]);
  }
  ts.forEachChild(node, visit);
}
visit(source);
for (const name of ['exportReviewedTables', 'publishTables']) {
  if (!closures.has(name)) throw new Error(`Production closure missing: ${name}`);
}
function compiled(name: string): string {
  return ts.transpileModule(`const run = ${closures.get(name)!.getText(source)};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
}

const IDENTITY = 'C:/docs/report.pdf';
const WORKING = 'C:/temp/working-copy.pdf';

const DETECTED: TableDetectionResult = {
  pages: [1],
  regions: [{
    page: 1, index: 0, bounds: [50, 250, 350, 310], columns: [50, 200], rows: [300, 280],
    evidence: 'aligned', caption: null, cells: 4,
  }],
  untabled: {},
  vertical_writing_runs: 0,
};

interface World {
  buffer: Uint8Array;
  session: TableReviewSession;
  files: Map<string, { path: string; workingPath: string; buffer: Uint8Array | null }>;
  docs: { path: string; workingPath: string; buffer: Uint8Array; pages: { id: string; sourceDocId: string; sourcePageIndex: number; rotation: number }[] }[];
  regions: TableRegion[];
  dirty: string[];
  dispatched: { method: string; params: Record<string, unknown> } | null;
  gateSaw: 'no-check' | 'threw' | 'passed';
}

function world(): World {
  const buffer = new Uint8Array([1, 2, 3]);
  const pages = [{ id: `${IDENTITY}#g1#p0`, sourceDocId: IDENTITY, sourcePageIndex: 0, rotation: 0 }];
  const { regions } = regionsFromDetection(DETECTED, IDENTITY,
    () => ({ pageId: pages[0].id, rect: { x: 0.125, y: 0.225, w: 0.75, h: 0.175 }, rotationAtDraw: 0, totalRotationAtDraw: 0 }),
    () => 'table');
  const doc = { path: IDENTITY, workingPath: WORKING, buffer, pages };
  return {
    buffer,
    session: { path: IDENTITY, workingPath: WORKING, buffer },
    files: new Map([[IDENTITY, doc]]),
    docs: [doc],
    regions: regions.map((r) => ({ ...r, accepted: true })),
    dirty: [],
    dispatched: null,
    gateSaw: 'no-check',
  };
}

/** The export closure bound to `w`; `atGeometry` and `inLock` mutate the
 * world at the two async boundaries the closure must re-check. */
function exportClosure(w: World, hooks: { atGeometry?: () => void; inLock?: () => void } = {}) {
  const tableSessionRef = { current: w.session as TableReviewSession | null };
  const env = {
    tableSessionRef,
    acceptedRegions, captureExportRequest, exportRegions, ownedAcceptedRegions, sessionMatches, tableReviewPages,
    liveTableRegionsRef: { get current() { return w.regions; } },
    filesRef: { get current() { return w.files; } },
    docsRef: { get current() { return w.docs; } },
    readState: () => ({ pageDirtyPaths: w.dirty }),
    geometryForPage: async () => { hooks.atGeometry?.(); return { box: [0, 0, 400, 400], bakedRotate: 0 }; },
    displayRectToPdf: () => [50, 250, 350, 310],
    tChrome: (k: string) => k,
    engineCall: vi.fn(async (method: string, params: Record<string, unknown>, options?: { assertCurrent?: () => void }) => {
      // The engine call's own contract: the caller's check runs inside the
      // lock, after the gate, immediately before dispatch.
      hooks.inLock?.();
      try { options?.assertCurrent?.(); w.gateSaw = 'passed'; } catch (e) { w.gateSaw = 'threw'; throw e; }
      w.dispatched = { method, params };
      return { output: params.output };
    }),
  };
  const run = new Function(...Object.keys(env), `${compiled('exportReviewedTables')}; return run;`)(...Object.values(env));
  return { run, tableSessionRef, engineCall: env.engineCall };
}

describe('reviewed table export ownership', () => {
  it('reads the WORKING COPY the reviewer looked at, never the identity path', async () => {
    const w = world();
    const { run } = exportClosure(w);
    await run('out.xlsx', { sheetPer: 'table', includeUntabled: false });
    expect(w.dispatched?.method).toBe('export_document');
    expect(w.dispatched?.params.file).toBe(WORKING);
    expect(w.dispatched?.params.file).not.toBe(IDENTITY);
    expect(w.gateSaw).toBe('passed');
  });

  it('keeps physical-page geometry: the file page and user-space bounds and columns', async () => {
    const w = world();
    w.docs[0].pages = [{ id: 'other#g1#p0', sourceDocId: IDENTITY, sourcePageIndex: 3, rotation: 0 }, ...w.docs[0].pages];
    const { run } = exportClosure(w);
    await run('out.xlsx', { sheetPer: 'page', includeUntabled: true });
    expect(w.dispatched?.params).toMatchObject({
      fmt: 'xlsx', sheet_per: 'page', include_untabled: true,
      regions: [{ page: 1, bounds: [50, 250, 350, 310], columns: [50, 200], caption: null }],
    });
  });

  it('serves a caller-captured request on the same terms as the live set', async () => {
    const w = world();
    const { run } = exportClosure(w);
    const check = vi.fn();
    await run('out.xlsx', { sheetPer: 'table', includeUntabled: false },
      { ...captureExportRequest(w.session, w.regions)!, assertCurrent: check });
    expect(w.dispatched?.params.file).toBe(WORKING);
    // The panel's own run check rides along into the lock.
    expect(check).toHaveBeenCalled();
  });

  it.each([
    ['the buffer moved before entry', (w: World) => { w.files.get(IDENTITY)!.buffer = new Uint8Array([9]); }],
    ['the working copy was reopened', (w: World) => { w.files.get(IDENTITY)!.workingPath = 'C:/temp/reopened.pdf'; }],
    ['the document closed', (w: World) => { w.files.delete(IDENTITY); }],
    ['a page edit is pending', (w: World) => { w.dirty.push(IDENTITY); }],
  ])('refuses before any geometry read when %s', async (_label, move) => {
    const w = world();
    move(w);
    const { run, engineCall } = exportClosure(w);
    await expect(run('out.xlsx', { sheetPer: 'table', includeUntabled: false })).rejects.toThrow('app.history.changed');
    expect(engineCall).not.toHaveBeenCalled();
    expect(w.dispatched).toBeNull();
  });

  it('refuses when the revision moves across the geometry await', async () => {
    const w = world();
    const { run, engineCall } = exportClosure(w, {
      atGeometry: () => { w.files.get(IDENTITY)!.buffer = new Uint8Array([9]); },
    });
    await expect(run('out.xlsx', { sheetPer: 'table', includeUntabled: false })).rejects.toThrow('app.history.changed');
    expect(engineCall).not.toHaveBeenCalled();
  });

  it('refuses inside the dispatch lock, after the gate, when the gate itself moved the bytes', async () => {
    const w = world();
    const { run } = exportClosure(w, {
      inLock: () => { w.files.get(IDENTITY)!.buffer = new Uint8Array([9]); },
    });
    await expect(run('out.xlsx', { sheetPer: 'table', includeUntabled: false })).rejects.toThrow('app.history.changed');
    expect(w.gateSaw).toBe('threw');
    expect(w.dispatched).toBeNull();
  });

  it('refuses a request captured against a different revision', async () => {
    const w = world();
    const { run, engineCall } = exportClosure(w);
    const stale = { ...w.session, buffer: new Uint8Array([0]) };
    await expect(run('out.xlsx', { sheetPer: 'table', includeUntabled: false }, captureExportRequest(stale, w.regions)!))
      .rejects.toThrow('app.history.changed');
    expect(engineCall).not.toHaveBeenCalled();
  });

  it('refuses a request naming a table that was unchecked meanwhile', async () => {
    const w = world();
    const { run, engineCall } = exportClosure(w);
    const request = captureExportRequest(w.session, w.regions)!;
    w.regions = w.regions.map((r) => ({ ...r, accepted: false }));
    await expect(run('out.xlsx', { sheetPer: 'table', includeUntabled: false }, request))
      .rejects.toThrow('app.history.changed');
    expect(engineCall).not.toHaveBeenCalled();
  });

  it('refuses a request naming a table the live set no longer holds', async () => {
    const w = world();
    const { run, engineCall } = exportClosure(w);
    const request = captureExportRequest(w.session, [...w.regions, { ...w.regions[0], id: 'vanished' }])!;
    await expect(run('out.xlsx', { sheetPer: 'table', includeUntabled: false }, request))
      .rejects.toThrow('app.history.changed');
    expect(engineCall).not.toHaveBeenCalled();
  });

  it('refuses a table from another document mixed into the live set', async () => {
    const w = world();
    const request = captureExportRequest(w.session, w.regions)!;
    w.regions = [{ ...w.regions[0], path: 'C:/docs/other.pdf' }];
    const { run, engineCall } = exportClosure(w);
    await expect(run('out.xlsx', { sheetPer: 'table', includeUntabled: false }, request))
      .rejects.toThrow('app.history.changed');
    expect(engineCall).not.toHaveBeenCalled();
  });

  it('refuses when nothing is checked, and when there is no review at all', async () => {
    const w = world();
    w.regions = w.regions.map((r) => ({ ...r, accepted: false }));
    const { run, engineCall } = exportClosure(w);
    await expect(run('out.xlsx', { sheetPer: 'table', includeUntabled: false })).rejects.toThrow('panel.tableReview.nothingAccepted');
    const none = world();
    const bare = exportClosure(none);
    bare.tableSessionRef.current = null;
    await expect(bare.run('out.xlsx', { sheetPer: 'table', includeUntabled: false })).rejects.toThrow('panel.tableReview.nothingAccepted');
    expect(engineCall).not.toHaveBeenCalled();
  });

  it('still refuses a table whose page is gone rather than leaving it out', async () => {
    const w = world();
    w.docs[0].pages = [];
    const { run, engineCall } = exportClosure(w);
    await expect(run('out.xlsx', { sheetPer: 'table', includeUntabled: false })).rejects.toThrow('app.history.changed');
    expect(engineCall).not.toHaveBeenCalled();
  });

  it('refuses changed columns while the caller waits for its picker', async () => {
    const w = world();
    const request = captureExportRequest(w.session, w.regions)!;
    w.regions = [{ ...w.regions[0], columns: [0, 0.8] }];
    const { run, engineCall } = exportClosure(w);
    await expect(run('out.xlsx', { sheetPer: 'table', includeUntabled: false }, request))
      .rejects.toThrow('app.history.changed');
    expect(engineCall).not.toHaveBeenCalled();
  });

  it.each(['atGeometry', 'inLock'] as const)('re-proves acceptance and geometry at %s', async (boundary) => {
    for (const mutation of ['uncheck', 'remove', 'columns', 'rect'] as const) {
      const w = world();
      const { run } = exportClosure(w, { [boundary]: () => {
        if (mutation === 'remove') w.regions = [];
        else if (mutation === 'uncheck') w.regions = [{ ...w.regions[0], accepted: false }];
        else if (mutation === 'columns') w.regions = [{ ...w.regions[0], columns: [0, 0.8] }];
        else w.regions = [{ ...w.regions[0], rect: { ...w.regions[0].rect, x: 0.5 } }];
      } });
      await expect(run('out.xlsx', { sheetPer: 'table', includeUntabled: false })).rejects.toThrow('app.history.changed');
      expect(w.dispatched).toBeNull();
    }
  });
});

function publishClosure(
  w: World,
  hooks: { atGeometry?: () => void; onDocsRead?: () => void } = {},
) {
  const tableSessionRef = { current: null as TableReviewSession | null };
  const published: { regions: TableRegion[] | null } = { regions: null };
  const env = {
    sessionMatches, regionsFromDetection, quarter, tableReviewPages,
    // The real wait, on a deadline a test can outlast.
    awaitReviewPages: (
      session: TableReviewSession,
      getDocs: () => World['docs'],
      isCurrent: () => boolean,
    ) => awaitReviewPages(session, getDocs, isCurrent, {
      timeoutMs: 200,
      sleep: () => Promise.resolve(),
    }),
    readState: () => ({ pageDirtyPaths: w.dirty }),
    filesRef: { get current() { return w.files; } },
    docsRef: { get current() { hooks.onDocsRead?.(); return w.docs; } },
    tableSessionRef,
    geometryForPage: async () => { hooks.atGeometry?.(); return { box: [0, 0, 400, 400], bakedRotate: 0 }; },
    pdfRectToDisplay: () => ({ x: 0.125, y: 0.225, w: 0.75, h: 0.175 }),
    tChrome: (k: string) => k,
    crypto: { randomUUID: () => 'table' },
    setTableRegions: (next: TableRegion[]) => { published.regions = next; },
    setSelectedTableId: () => {},
  };
  const run = new Function(...Object.keys(env), `${compiled('publishTables')}; return run;`)(...Object.values(env));
  return { run, tableSessionRef, published };
}

describe('detection publish ownership', () => {
  it('maps file pages across manifest partitions rather than the first strip slots', async () => {
    const w = world();
    const a = w.docs[0];
    w.docs = [{ ...a, pages: [{ ...a.pages[0], id: 'physical-B', sourcePageIndex: 1 }] }, a];
    const { run, published } = publishClosure(w);
    await run(IDENTITY, DETECTED, { workingPath: WORKING, buffer: w.buffer });
    expect(published.regions?.[0].pageId).toBe(a.pages[0].id);
    w.regions = published.regions!.map((r) => ({ ...r, accepted: true }));
    await exportClosure(w).run('out.xlsx', { sheetPer: 'table', includeUntabled: false });
    expect(w.dispatched?.params).toMatchObject({ regions: [{ page: 1 }] });
  });

  it('projects onto the index the async reindex publishes after detection returns', async () => {
    const w = world();
    const settled = w.docs;
    // The index has not caught up to the bytes the detector read: the state a
    // freshly opened document is in while its reindex is still in flight.
    w.docs = [{ ...settled[0], buffer: new Uint8Array([8]) }];
    let polls = 0;
    const { run, published } = publishClosure(w, { onDocsRead: () => {
      polls += 1;
      if (polls >= 3) w.docs = settled;
    } });
    await run(IDENTITY, DETECTED, { workingPath: WORKING, buffer: w.buffer });
    expect(published.regions?.[0]).toMatchObject({ pageId: `${IDENTITY}#g1#p0` });
  });

  it('refuses when the index never catches up to the bytes the detector read', async () => {
    const w = world();
    w.docs = [{ ...w.docs[0], buffer: new Uint8Array([8]) }];
    const { run, published } = publishClosure(w);
    await expect(run(IDENTITY, DETECTED, { workingPath: WORKING, buffer: w.buffer }))
      .rejects.toThrow('app.history.changed');
    expect(published.regions).toBeNull();
  });

  it.each(['pending', 'foreign-page', 'duplicate-page'] as const)('refuses an unproved physical index: %s', async (variant) => {
    const w = world();
    if (variant === 'pending') w.dirty = [IDENTITY];
    if (variant === 'foreign-page') w.docs[0].pages[0].sourceDocId = 'foreign.pdf';
    if (variant === 'duplicate-page') w.docs = [w.docs[0], { ...w.docs[0] }];
    const { run, published } = publishClosure(w);
    await expect(run(IDENTITY, DETECTED, { workingPath: WORKING, buffer: w.buffer }))
      .rejects.toThrow('app.history.changed');
    expect(published.regions).toBeNull();
    await expect(exportClosure(w).run('out.xlsx', { sheetPer: 'table', includeUntabled: false }))
      .rejects.toThrow('app.history.changed');
    expect(w.dispatched).toBeNull();
  });

  it('refuses an index replaced across geometry without requiring a byte change', async () => {
    const w = world();
    const { run, published } = publishClosure(w, { atGeometry: () => {
      w.docs = [{ ...w.docs[0], pages: [{ ...w.docs[0].pages[0], id: 'replacement-page' }] }];
    } });
    await expect(run(IDENTITY, DETECTED, { workingPath: WORKING, buffer: w.buffer }))
      .rejects.toThrow('app.history.changed');
    expect(published.regions).toBeNull();
  });

  it('binds the review to the revision the detector read', async () => {
    const w = world();
    const { run, tableSessionRef, published } = publishClosure(w);
    const result = await run(IDENTITY, DETECTED, { workingPath: WORKING, buffer: w.buffer });
    expect(result).toEqual({ shown: 1, skipped: 0 });
    expect(tableSessionRef.current).toEqual({ path: IDENTITY, workingPath: WORKING, buffer: w.buffer });
    expect(published.regions?.[0]).toMatchObject({ path: IDENTITY, pageId: `${IDENTITY}#g1#p0`, accepted: false });
  });

  it('does not publish old facts onto bytes the document no longer has', async () => {
    const w = world();
    w.files.get(IDENTITY)!.buffer = new Uint8Array([9]);
    const { run, tableSessionRef, published } = publishClosure(w);
    await expect(run(IDENTITY, DETECTED, { workingPath: WORKING, buffer: w.buffer })).rejects.toThrow('app.history.changed');
    expect(tableSessionRef.current).toBeNull();
    expect(published.regions).toBeNull();
  });

  it('refuses when the revision moves across the geometry await', async () => {
    const w = world();
    const { run, published } = publishClosure(w, {
      atGeometry: () => { w.files.get(IDENTITY)!.buffer = new Uint8Array([9]); },
    });
    await expect(run(IDENTITY, DETECTED, { workingPath: WORKING, buffer: w.buffer })).rejects.toThrow('app.history.changed');
    expect(published.regions).toBeNull();
  });
});
