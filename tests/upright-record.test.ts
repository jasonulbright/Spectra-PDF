// The record of upright stamps, and what a page render costs with it.
//
// Every page render of every document goes through `renderPageUpright`. A
// page with no upright stamp, and a page with no record, must cost what
// `page.render` costs: the render starts in the turn of the call, the caller
// gets pdf.js's own task, and the render path reads no annotations. A change
// that adds a tick or a worker request there delays the first pixel of every
// page.

import { describe, expect, it } from 'vitest';
import type { PDFPageProxy } from 'pdfjs-dist';
import { renderPageUpright, renderPageUprightOnce } from '../src/renderer/lib/upright-stamps';
import type { UprightPage } from '../src/renderer/lib/upright-stamps';
import {
  NO_UPRIGHT_STAMPS, bindUprightDocument, carryUprightPages, expectUprightKey, holdUprightRecord, readUprightStamps,
  recordAsksRepaint, recordUprightStamps, releaseUprightRecord, subscribeUprightRecord, uprightCarried, uprightDocumentDestroyed,
  uprightDocumentGone, uprightPagesOf, uprightRecordCount, uprightRenderPlan, uprightStampsAmong, uprightStampsOn,
} from '../src/renderer/lib/upright-record';
import * as rasterHooks from '../src/renderer/components/canvas/useUprightTurn';
import { keepsPaintedRaster } from '../src/renderer/components/canvas/useUprightTurn';
import { importPage } from '../src/renderer/lib/annotation-import';
import { PDFDocument, PDFName } from 'pdf-lib';
import { loadPdf } from './support/saved-pdf';

type RenderParameters = Parameters<PDFPageProxy['render']>[0];

const RECT: [number, number, number, number] = [150, 250, 250, 300];
const STAMP = { id: '5R', rect: RECT };
let keys = 0;
const freshKey = (): string => `record-test-${++keys}`;

/** How many microtasks pass before `promise` settles. */
async function microtasks(promise: Promise<unknown>): Promise<number> {
  let settled = false;
  void promise.then(() => { settled = true; }, () => { settled = true; });
  let n = 0;
  while (!settled && n < 1000) {
    await Promise.resolve();
    n++;
  }
  return n;
}

interface Counted {
  page: UprightPage & { getAnnotations: () => Promise<unknown[]> };
  renders: unknown[];
  tasks: Array<{ promise: Promise<unknown>; cancel: () => void }>;
  reads: () => number;
}

function countedPage(pageNumber = 1, listing: unknown[] = []): Counted {
  const renders: unknown[] = [];
  const tasks: Counted['tasks'] = [];
  let reads = 0;
  return {
    renders,
    tasks,
    reads: () => reads,
    page: {
      pageNumber,
      getAnnotations: async () => {
        reads++;
        return listing;
      },
      render: (params) => {
        renders.push(params);
        const task = { promise: Promise.resolve(), cancel: () => {} };
        tasks.push(task);
        return task;
      },
    },
  };
}

const params = { canvasContext: {}, viewport: { transform: [1, 0, 0, -1, 0, 600] } } as unknown as RenderParameters;

describe('a page render with no upright stamp costs what page.render costs', () => {
  const cases: Array<[string, () => object]> = [
    ['a document with no record', () => ({})],
    ['a document whose key has no record for the page', () => {
      const pdf = {};
      const key = freshKey();
      recordUprightStamps(key, [undefined, [STAMP]]);
      bindUprightDocument(pdf, key);
      return pdf;
    }],
    ['a page the record lists no stamp for', () => {
      const pdf = {};
      const key = freshKey();
      recordUprightStamps(key, [[], [STAMP]]);
      bindUprightDocument(pdf, key);
      return pdf;
    }],
  ];

  for (const [label, document] of cases) {
    it(`${label}: the render starts in the turn of the call, with the caller's parameters`, () => {
      const counted = countedPage();
      const task = renderPageUpright(document(), counted.page, params);
      // No await stands between the call and these lines.
      expect(counted.renders.length).toBe(1);
      expect(counted.renders[0]).toBe(params);
      expect(task).toBe(counted.tasks[0]);
      expect(task.upright).toBeUndefined();
    });

    it(`${label}: the task settles in as many microtasks as page.render's`, async () => {
      const plain = countedPage();
      const expected = await microtasks(plain.page.render(params).promise);
      const counted = countedPage();
      expect(await microtasks(renderPageUpright(document(), counted.page, params).promise)).toBe(expected);
    });

    it(`${label}: the render path reads no annotations`, async () => {
      const counted = countedPage(1, [{ id: '5R', subtype: 'Stamp', noRotate: true, hasAppearance: true, rect: RECT }]);
      const pdf = document();
      for (let n = 0; n < 3; n++) await renderPageUpright(pdf, counted.page, params).promise;
      expect(counted.reads()).toBe(0);
      expect(counted.renders.length).toBe(3);
    });
  }

  it('a page the record lists a stamp for starts its first render in the turn of the call and reads no annotations', async () => {
    const pdf = {};
    const key = freshKey();
    recordUprightStamps(key, [[STAMP]]);
    bindUprightDocument(pdf, key);
    const counted = countedPage();
    const context = { save: () => {}, restore: () => {}, setTransform: () => {}, drawImage: () => {} };
    const task = renderPageUpright(pdf, counted.page, { ...params, canvasContext: context } as unknown as RenderParameters);
    expect(counted.renders.length).toBe(1);
    expect(task.upright).toEqual([STAMP]);
    await task.promise;
    expect(counted.reads()).toBe(0);
  });

  it('a render that is used once starts in the turn of the call when the page has a record', () => {
    const pdf = {};
    const key = freshKey();
    recordUprightStamps(key, [[]]);
    bindUprightDocument(pdf, key);
    const counted = countedPage();
    void renderPageUprightOnce(pdf, counted.page, params);
    expect(counted.renders.length).toBe(1);
    expect(counted.renders[0]).toBe(params);
    expect(counted.reads()).toBe(0);
  });

  it('a render that is used once reads a page with no record once, also when the read fails', async () => {
    const pdf = {};
    let reads = 0;
    const renders: unknown[] = [];
    const page = {
      pageNumber: 3,
      getAnnotations: async (): Promise<unknown[]> => {
        reads++;
        throw new Error('gone');
      },
      render: (given: RenderParameters) => {
        renders.push(given);
        return { promise: Promise.resolve(), cancel: () => {} };
      },
    };
    expect(await renderPageUprightOnce(pdf, page, params)).toBe(0);
    expect(await renderPageUprightOnce(pdf, page, params)).toBe(0);
    expect(await renderPageUprightOnce(pdf, page, params)).toBe(0);
    expect(reads).toBe(1);
    expect(renders).toEqual([params, params, params]);
    expect(uprightStampsOn(pdf, 2)).toBe(NO_UPRIGHT_STAMPS);
  });
});

describe('the record of upright stamps', () => {
  it('takes a stamp with the flag, an appearance and a rectangle with an area', () => {
    const stamp = { id: '5R', subtype: 'Stamp', noRotate: true, hasAppearance: true, rect: [250, 300, 150, 250] };
    expect(uprightStampsAmong([stamp])).toEqual([{ id: '5R', rect: [150, 250, 250, 300] }]);
    expect(uprightStampsAmong([
      { ...stamp, noRotate: false },
      { ...stamp, hasAppearance: false },
      { ...stamp, subtype: 'Square' },
      { ...stamp, rect: [150, 250, 150, 300] },
      { ...stamp, rect: null },
      { ...stamp, id: undefined },
    ])).toBe(NO_UPRIGHT_STAMPS);
  });

  it('is shared by every document over the bytes of one key, by page index', () => {
    const key = freshKey();
    const first = {};
    const second = {};
    bindUprightDocument(first, key);
    expect(uprightStampsOn(first, 0)).toBeUndefined();
    recordUprightStamps(key, [[STAMP], []]);
    bindUprightDocument(second, key);
    expect(uprightStampsOn(first, 0)).toEqual([STAMP]);
    expect(uprightStampsOn(second, 0)).toBe(uprightStampsOn(first, 0));
    expect(uprightStampsOn(second, 1)).toBe(NO_UPRIGHT_STAMPS);
    expect(uprightStampsOn(second, 2)).toBeUndefined();
    expect(uprightStampsOn({}, 0)).toBeUndefined();
  });

  it('a document bound to another key reads the record of that key', () => {
    const old = freshKey();
    const next = freshKey();
    recordUprightStamps(old, [[STAMP]]);
    const pdf = {};
    bindUprightDocument(pdf, next);
    expect(uprightStampsOn(pdf, 0)).toBeUndefined();
    recordUprightStamps(next, [[]]);
    expect(uprightStampsOn(pdf, 0)).toBe(NO_UPRIGHT_STAMPS);
  });

  it('a key that settles later is recorded when it settles', async () => {
    const key = freshKey();
    const pdf = {};
    bindUprightDocument(pdf, key);
    recordUprightStamps(Promise.resolve(key), [[STAMP]]);
    expect(uprightStampsOn(pdf, 0)).toBeUndefined();
    await Promise.resolve();
    await Promise.resolve();
    expect(uprightStampsOn(pdf, 0)).toEqual([STAMP]);
  });

  it('tells its listeners of a record and of a bound document, and not of an equal record', () => {
    let calls = 0;
    const stop = subscribeUprightRecord(() => { calls++; });
    try {
      const key = freshKey();
      recordUprightStamps(key, [[STAMP]]);
      expect(calls).toBe(1);
      const pdf = {};
      bindUprightDocument(pdf, key);
      expect(calls).toBe(2);
      bindUprightDocument(pdf, key);
      expect(calls).toBe(2);
      const kept = uprightStampsOn(pdf, 0);
      recordUprightStamps(key, [[{ id: '5R', rect: [...RECT] as typeof RECT }]]);
      expect(calls).toBe(2);
      expect(uprightStampsOn(pdf, 0)).toBe(kept);
      recordUprightStamps(key, [[{ id: '6R', rect: RECT }]]);
      expect(calls).toBe(3);
    } finally {
      stop();
    }
    recordUprightStamps(freshKey(), [[STAMP]]);
    expect(calls).toBe(3);
  });

  it('leaves with the last cached document of its key', () => {
    const key = freshKey();
    const pdf = {};
    bindUprightDocument(pdf, key);
    holdUprightRecord(key);
    holdUprightRecord(key);
    recordUprightStamps(key, [[STAMP]]);
    releaseUprightRecord(key);
    expect(uprightStampsOn(pdf, 0)).toEqual([STAMP]);
    releaseUprightRecord(key);
    expect(uprightStampsOn(pdf, 0)).toBeUndefined();
    releaseUprightRecord(key);
    expect(uprightStampsOn(pdf, 0)).toBeUndefined();
  });

  it('keeps a record written before a document holds its key, and a bounded number of records nobody holds', () => {
    const early = freshKey();
    recordUprightStamps(early, [[STAMP]]);
    holdUprightRecord(early);
    const pdf = {};
    bindUprightDocument(pdf, early);
    expect(uprightStampsOn(pdf, 0)).toEqual([STAMP]);
    for (let n = 0; n < 60; n++) recordUprightStamps(freshKey(), [[STAMP]]);
    // The one held record and at most sixteen that nobody holds.
    expect(uprightRecordCount()).toBeLessThanOrEqual(17);
    expect(uprightStampsOn(pdf, 0)).toEqual([STAMP]);
    releaseUprightRecord(early);
  });

  it('a read fills a page with no record once per document and page', async () => {
    const pdf = {};
    let reads = 0;
    const page = {
      pageNumber: 2,
      getAnnotations: async (): Promise<unknown[]> => {
        reads++;
        return [{ id: '5R', subtype: 'Stamp', noRotate: true, hasAppearance: true, rect: RECT }];
      },
    };
    const both = await Promise.all([readUprightStamps(pdf, page), readUprightStamps(pdf, page)]);
    expect(both[0]).toEqual([STAMP]);
    expect(both[1]).toBe(both[0]);
    expect(await readUprightStamps(pdf, page)).toBe(both[0]);
    expect(uprightStampsOn(pdf, 1)).toBe(both[0]);
    expect(reads).toBe(1);
    // The record of the index outranks the read.
    const key = freshKey();
    recordUprightStamps(key, [undefined, []]);
    bindUprightDocument(pdf, key);
    expect(uprightStampsOn(pdf, 1)).toBe(NO_UPRIGHT_STAMPS);
  });
});

describe('when a painted raster renders again', () => {
  it('a record that lists stamps the render did not have asks for one more render', () => {
    const listed = [STAMP];
    expect(recordAsksRepaint(listed, true, undefined)).toBe(true);
    expect(recordAsksRepaint(listed, true, listed)).toBe(false);
    expect(recordAsksRepaint(listed, true, [{ id: '6R', rect: RECT }])).toBe(true);
    expect(recordAsksRepaint(listed, true, [{ id: '5R', rect: [150, 250, 250, 301] }])).toBe(true);
  });

  it('a record equal to what a read of the page gave asks for none, and one that differs asks for one', () => {
    const read = [{ id: '5R', rect: [...RECT] as typeof RECT }];
    expect(recordAsksRepaint([STAMP], true, read)).toBe(false);
    expect(recordAsksRepaint(NO_UPRIGHT_STAMPS, true, read)).toBe(true);
    expect(recordAsksRepaint(NO_UPRIGHT_STAMPS, true, NO_UPRIGHT_STAMPS)).toBe(false);
    expect(recordAsksRepaint(NO_UPRIGHT_STAMPS, false, read)).toBe(false);
  });

  it('a page with no record, a page with no stamp and a render that has not started ask for none', () => {
    expect(recordAsksRepaint(undefined, true, undefined)).toBe(false);
    expect(recordAsksRepaint(NO_UPRIGHT_STAMPS, true, undefined)).toBe(false);
    expect(recordAsksRepaint([STAMP], false, undefined)).toBe(false);
  });

  it('the painted bitmap stays for a new render of the same page of the same document only', () => {
    const document = {};
    expect(keepsPaintedRaster(null, { document, pageNumber: 1 })).toBe(false);
    expect(keepsPaintedRaster({ document, pageNumber: 1 }, { document, pageNumber: 1 })).toBe(true);
    expect(keepsPaintedRaster({ document, pageNumber: 1 }, { document, pageNumber: 2 })).toBe(false);
    expect(keepsPaintedRaster({ document, pageNumber: 1 }, { document: {}, pageNumber: 1 })).toBe(false);
  });
});

describe('the import lists the upright stamps of a page', () => {
  it('with the ids of the document it read, for the workspace index to record', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([400, 600]);
    page.node.set(PDFName.of('Rotate'), doc.context.obj(90));
    const appearance = doc.context.register(doc.context.stream('1 0 0 rg 0 0 100 40 re f', {
      Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 100, 40], Resources: {},
    }));
    const stamps = [20, 4, 20].map((flags, index) => doc.context.register(doc.context.obj({
      Type: 'Annot', Subtype: 'Stamp', Rect: index === 2 ? [10, 10, 10, 40] : RECT, F: flags, AP: { N: appearance },
    })));
    page.node.set(PDFName.of('Annots'), doc.context.obj(stamps));
    doc.addPage([400, 600]);
    const pdf = await loadPdf(await doc.save());
    try {
      const first = await importPage(await pdf.getPage(1));
      expect(first.uprightStamps).toEqual([{ id: `${stamps[0].objectNumber}R`, rect: RECT }]);
      expect((await importPage(await pdf.getPage(2))).uprightStamps).toEqual([]);
    } finally {
      await pdf.loadingTask.destroy();
    }
  });
});

const LISTED = [{ id: '5R', subtype: 'Stamp', noRotate: true, hasAppearance: true, rect: RECT }];
const drawing = { save: () => {}, restore: () => {}, setTransform: () => {}, drawImage: () => {} };
const drawParams = { ...params, canvasContext: drawing } as unknown as RenderParameters;

describe('a document that replaces one with an upright stamp', () => {
  it('is told the pages, and a told page names no stamp', () => {
    const pdf = {};
    let told = 0;
    const off = subscribeUprightRecord(() => { told++; });
    carryUprightPages(pdf, [1, 3]);
    off();
    expect([0, 1, 2, 3].map((index) => uprightCarried(pdf, index))).toEqual([false, true, false, true]);
    expect([0, 1, 2, 3].map((index) => uprightStampsOn(pdf, index))).toEqual([undefined, undefined, undefined, undefined]);
    expect(told).toBe(0);
  });

  it('is told nothing when the replaced document had no such page', () => {
    const pdf = {};
    carryUprightPages(pdf, []);
    expect(uprightCarried(pdf, 0)).toBe(false);
    expect(uprightPagesOf(pdf)).toEqual([]);
  });

  it('hands on the pages with a recorded stamp, with a read stamp, and those it was told and knows nothing of', async () => {
    const pdf = {};
    expect(uprightPagesOf(pdf)).toEqual([]);
    const key = freshKey();
    recordUprightStamps(key, [[], [STAMP], [], undefined]);
    bindUprightDocument(pdf, key);
    expect(uprightPagesOf(pdf)).toEqual([1]);
    // Page 2 was told and its record lists no stamp; page 3 is not known.
    carryUprightPages(pdf, [2, 3, 5, 6]);
    expect(uprightPagesOf(pdf)).toEqual([1, 3, 5, 6]);
    // A read finds a stamp on page 5 and none on page 6.
    await readUprightStamps(pdf, { pageNumber: 6, getAnnotations: async () => LISTED });
    await readUprightStamps(pdf, { pageNumber: 7, getAnnotations: async () => [] });
    expect(uprightPagesOf(pdf)).toEqual([1, 3, 5]);
  });
});

describe('what a render of a page shows', () => {
  it('every plan renders the document it is asked for: none keeps the pixels a raster holds', () => {
    const plans: string[] = [];
    for (const known of [undefined, NO_UPRIGHT_STAMPS, [STAMP]]) {
      for (const carried of [false, true]) plans.push(uprightRenderPlan(known, carried));
    }
    expect(plans).toEqual(['plain', 'read', 'plain', 'plain', 'stamps', 'stamps']);
  });

  it('a render of a document with another content key starts a render of that document, in every state of its page', async () => {
    const old = {};
    const oldKey = freshKey();
    recordUprightStamps(oldKey, [[STAMP]]);
    bindUprightDocument(old, oldKey);
    const states: Array<[string, (pdf: object) => void]> = [
      ['no record, not told', () => {}],
      ['no record, told', (pdf) => carryUprightPages(pdf, uprightPagesOf(old))],
      ['a record with no stamp, told', (pdf) => {
        carryUprightPages(pdf, uprightPagesOf(old));
        const key = freshKey();
        recordUprightStamps(key, [[]]);
        bindUprightDocument(pdf, key);
      }],
      ['a record with a stamp', (pdf) => {
        const key = freshKey();
        recordUprightStamps(key, [[{ id: '9R', rect: RECT }]]);
        bindUprightDocument(pdf, key);
      }],
    ];
    for (const [label, prepare] of states) {
      const pdf = {};
      prepare(pdf);
      // Nothing of the replaced document's record is read for the new one.
      expect(uprightStampsOn(pdf, 0), label).not.toEqual([STAMP]);
      const counted = countedPage(1, []);
      await renderPageUpright(pdf, counted.page, drawParams).promise;
      expect(counted.renders.length, label).toBeGreaterThan(0);
      // The bitmap of the replaced document is never kept visible.
      expect(keepsPaintedRaster({ document: old, pageNumber: 1 }, { document: pdf, pageNumber: 1 }), label).toBe(false);
    }
  });

  it('no raster hook keeps pixels for a record', () => {
    expect(Object.keys(rasterHooks).sort()).toEqual(['keepsPaintedRaster', 'useUprightRecord', 'useUprightTurn']);
  });
});

describe('a page render of a page the replaced document had an upright stamp on', () => {
  it('reads the page once, then renders with the stamps the document holds; every other page reads nothing', async () => {
    const pdf = {};
    carryUprightPages(pdf, [0]);
    const told = countedPage(1, LISTED);
    const task = renderPageUpright(pdf, told.page, drawParams);
    // The read is first: no render has started in the turn of the call.
    expect([told.reads(), told.renders.length]).toEqual([1, 0]);
    expect(task.upright).toBeUndefined();
    await task.promise;
    expect(task.upright).toEqual([STAMP]);
    expect(told.renders.length).toBe(2);
    expect(uprightStampsOn(pdf, 0)).toEqual([STAMP]);
    // Later renders of the page start in the turn of the call and read nothing.
    for (let n = 0; n < 3; n++) {
      const before = told.renders.length;
      const again = renderPageUpright(pdf, told.page, drawParams);
      expect(told.renders.length).toBe(before + 1);
      await again.promise;
    }
    expect(told.reads()).toBe(1);

    const other = countedPage(2, LISTED);
    for (let n = 0; n < 3; n++) {
      const plain = renderPageUpright(pdf, other.page, params);
      expect(plain).toBe(other.tasks[n]);
      await plain.promise;
    }
    expect([other.reads(), other.renders.length]).toEqual([0, 3]);
  });

  it('three rasters of one page share one read', async () => {
    const pdf = {};
    carryUprightPages(pdf, [0]);
    const counted = countedPage(1, []);
    await Promise.all([0, 1, 2].map(() => renderPageUpright(pdf, counted.page, params).promise));
    expect([counted.reads(), counted.renders]).toEqual([1, [params, params, params]]);
    expect(uprightStampsOn(pdf, 0)).toBe(NO_UPRIGHT_STAMPS);
  });

  it('a read that fails renders the page as pdf.js draws it, and no later render reads', async () => {
    const pdf = {};
    carryUprightPages(pdf, [2]);
    let reads = 0;
    const renders: unknown[] = [];
    const page = {
      pageNumber: 3,
      getAnnotations: async (): Promise<unknown[]> => {
        reads++;
        throw new Error('unreadable');
      },
      render: (given: RenderParameters) => {
        renders.push(given);
        return { promise: Promise.resolve(), cancel: () => {} };
      },
    };
    await renderPageUpright(pdf, page, params).promise;
    const again = renderPageUpright(pdf, page, params);
    expect(renders).toEqual([params, params]);
    await again.promise;
    expect(reads).toBe(1);
  });

  it('uses the record of a pending content key and reads nothing', async () => {
    const pdf = {};
    carryUprightPages(pdf, [0]);
    const key = freshKey();
    recordUprightStamps(key, [[STAMP]]);
    expectUprightKey(pdf, Promise.resolve(key));
    const counted = countedPage(1, []);
    const task = renderPageUpright(pdf, counted.page, drawParams);
    await task.promise;
    expect(task.upright).toEqual([STAMP]);
    expect(counted.reads()).toBe(0);
  });

  it('a cancel during the read starts no render and rejects as a cancelled render', async () => {
    const pdf = {};
    carryUprightPages(pdf, [0]);
    let answer!: (annotations: unknown[]) => void;
    const renders: unknown[] = [];
    const page = {
      pageNumber: 1,
      getAnnotations: () => new Promise<unknown[]>((resolve) => { answer = resolve; }),
      render: (given: RenderParameters) => {
        renders.push(given);
        return { promise: Promise.resolve(), cancel: () => {} };
      },
    };
    const task = renderPageUpright(pdf, page, params);
    const outcome = task.promise.then(() => 'rendered', (error: Error) => error.name);
    task.cancel();
    answer(LISTED);
    expect(await outcome).toBe('RenderingCancelledException');
    expect(renders).toEqual([]);
  });

  it('a document destroyed during the read settles the read, starts no render and rejects as a cancelled render', async () => {
    const pdf = {};
    carryUprightPages(pdf, [0]);
    const renders: unknown[] = [];
    const page = {
      pageNumber: 1,
      getAnnotations: () => new Promise<unknown[]>(() => {}),
      render: (given: RenderParameters) => {
        renders.push(given);
        return { promise: Promise.resolve(), cancel: () => {} };
      },
    };
    const outcome = renderPageUpright(pdf, page, params).promise.then(() => 'rendered', (error: Error) => error.name);
    uprightDocumentDestroyed(pdf);
    expect(await outcome).toBe('RenderingCancelledException');
    expect(renders).toEqual([]);
  });

  it('a page that cannot be read renders as pdf.js draws it, in the turn of the call', () => {
    const pdf = {};
    carryUprightPages(pdf, [0]);
    const counted = countedPage();
    const page: UprightPage = { pageNumber: 1, render: counted.page.render };
    expect(renderPageUpright(pdf, page, params)).toBe(counted.tasks[0]);
  });
});

describe('a read of the upright stamps for a render that is used once', () => {
  const listing = [{ id: '5R', subtype: 'Stamp', noRotate: true, hasAppearance: true, rect: RECT }];

  it('is one read per document object and page, however often the render is asked for', async () => {
    const documents = [{}, {}];
    const reads = new Map<string, number>();
    const pageOf = (document: number, pageNumber: number) => ({
      pageNumber,
      getAnnotations: async (): Promise<unknown[]> => {
        const name = `${document}/${pageNumber}`;
        reads.set(name, (reads.get(name) ?? 0) + 1);
        return [];
      },
      render: () => ({ promise: Promise.resolve(), cancel: () => {} }),
    });
    for (let round = 0; round < 3; round++) {
      for (const [index, pdf] of documents.entries()) {
        for (const pageNumber of [1, 2]) await renderPageUprightOnce(pdf, pageOf(index, pageNumber), params);
      }
    }
    expect([...reads.entries()].sort()).toEqual([['0/1', 1], ['0/2', 1], ['1/1', 1], ['1/2', 1]]);
  });

  it('reads nothing when the record of the content key exists, also while the key is still pending', async () => {
    const counted = countedPage(1, listing);
    const bound = {};
    const key = freshKey();
    recordUprightStamps(key, [[STAMP]]);
    bindUprightDocument(bound, key);
    expect(await readUprightStamps(bound, counted.page)).toEqual([STAMP]);
    // The key of this document settles later; its record is there.
    const pending = {};
    let settle!: (value: string) => void;
    expectUprightKey(pending, new Promise<string>((resolve) => { settle = resolve; }));
    const read = readUprightStamps(pending, counted.page);
    await Promise.resolve();
    expect(counted.reads()).toBe(0);
    settle(key);
    expect(await read).toEqual([STAMP]);
    expect(counted.reads()).toBe(0);
    expect(uprightStampsOn(pending, 0)).toEqual([STAMP]);
  });

  it('reads once when the pending key settles and has no record of the page', async () => {
    const counted = countedPage(2, listing);
    const pdf = {};
    expectUprightKey(pdf, Promise.resolve(freshKey()));
    expect(await readUprightStamps(pdf, counted.page)).toEqual([STAMP]);
    expect(await readUprightStamps(pdf, counted.page)).toEqual([STAMP]);
    expect(counted.reads()).toBe(1);
  });

  it('settles when the document is destroyed during the read, and the render rejects as cancelled without starting', async () => {
    const pdf = {};
    let reads = 0;
    let renders = 0;
    const page = {
      pageNumber: 1,
      // A request to a document that is being destroyed is never answered.
      getAnnotations: (): Promise<unknown[]> => {
        reads++;
        return new Promise(() => {});
      },
      render: () => {
        renders++;
        return { promise: Promise.resolve(), cancel: () => {} };
      },
    };
    const read = readUprightStamps(pdf, page);
    const once = renderPageUprightOnce(pdf, page, params);
    const outcome = once.then(() => 'rendered', (error: Error) => error.name);
    uprightDocumentDestroyed(pdf);
    expect(await read).toBe(NO_UPRIGHT_STAMPS);
    expect(await outcome).toBe('RenderingCancelledException');
    expect([reads, renders]).toEqual([1, 0]);
    expect(uprightDocumentGone(pdf)).toBe(true);
    // Nothing is kept for the page, and no later call reads.
    expect(uprightStampsOn(pdf, 0)).toBeUndefined();
    expect(await readUprightStamps(pdf, page)).toBe(NO_UPRIGHT_STAMPS);
    expect(reads).toBe(1);
  });

  it('reads nothing from a document or a page that is destroyed already', async () => {
    let reads = 0;
    const getAnnotations = (): Promise<unknown[]> => {
      reads++;
      return new Promise(() => {});
    };
    expect(await readUprightStamps({ loadingTask: { destroyed: true } }, { pageNumber: 1, getAnnotations })).toBe(NO_UPRIGHT_STAMPS);
    const destroyedPage = { pageNumber: 1, destroyed: true, getAnnotations };
    expect(await readUprightStamps({}, destroyedPage)).toBe(NO_UPRIGHT_STAMPS);
    expect(reads).toBe(0);
  });

  it('a read that pdf.js answers after the destruction keeps nothing', async () => {
    const pdf: { loadingTask: { destroyed: boolean } } = { loadingTask: { destroyed: false } };
    let answer!: (annotations: unknown[]) => void;
    const page = { pageNumber: 1, getAnnotations: () => new Promise<unknown[]>((resolve) => { answer = resolve; }) };
    const read = readUprightStamps(pdf, page);
    pdf.loadingTask.destroyed = true;
    answer(listing);
    expect(await read).toBe(NO_UPRIGHT_STAMPS);
    expect(uprightStampsOn(pdf, 0)).toBeUndefined();
  });
});
