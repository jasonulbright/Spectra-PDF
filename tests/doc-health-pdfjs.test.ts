// The pdf.js half of the health ledger under FAILURE: what happens when the
// worker itself does not behave — a page that will not parse, a worker that
// has been torn down mid-sweep, and a metadata call that never settles.
//
// The invariant under test is the one `collect-pdfjs-facts.ts` (now) promises
// structurally and the one `getMetadata` used not to: no unhandled rejection,
// the sweep always SETTLES (never hangs), and a page or a document that could
// not be read reports `undetermined`, never a clean answer.
import './helpers/dommatrix-stub';
import { describe, it, expect, vi } from 'vitest';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import { OPS } from 'pdfjs-dist';
import { collectPdfjsFacts } from '../src/renderer/lib/doc-health-pdfjs';

interface FakePageSpec {
  /** Throws (or never resolves, if `hang` set) instead of returning a page. */
  unreadable?: boolean;
  /** `getOperatorList()` rejects for this page. */
  opListRejects?: Error;
}

function fakeDoc(pages: FakePageSpec[], opts: {
  isPureXfa?: boolean;
  metadata?: 'ok' | 'reject' | 'hang';
} = {}): PDFDocumentProxy {
  const doc = {
    isPureXfa: opts.isPureXfa ?? false,
    numPages: pages.length,
    getMetadata: () => {
      if (opts.metadata === 'reject') return Promise.reject(new Error('metadata boom'));
      if (opts.metadata === 'hang') return new Promise(() => undefined); // never settles
      return Promise.resolve({ info: {}, metadata: null });
    },
    getPage: (n: number) => {
      const spec = pages[n - 1];
      if (!spec) return Promise.reject(new Error('no such page'));
      if (spec.unreadable) return Promise.reject(new Error('page unreadable'));
      const page: Partial<PDFPageProxy> = {
        getOperatorList: () => {
          if (spec.opListRejects) return Promise.reject(spec.opListRejects);
          return Promise.resolve({ fnArray: [], argsArray: [] } as never);
        },
        commonObjs: { has: () => false, get: () => undefined } as never,
      };
      return Promise.resolve(page as PDFPageProxy);
    },
  };
  return doc as unknown as PDFDocumentProxy;
}

describe('collectPdfjsFacts under boundary failure', () => {
  it('a page whose operator list rejects is reported skipped, and the sweep continues past it', async () => {
    // Page 3 of 5 (index 2) rejects; the other four must still be walked.
    const doc = fakeDoc([{}, {}, { opListRejects: new Error('content boom') }, {}, {}]);
    const facts = await collectPdfjsFacts(doc);
    const skipped = facts.filter((f) => f.code === 'page.contentUnreadable');
    expect(skipped).toHaveLength(1);
    expect(skipped[0].page).toBe(2);
    // No fact at all for the four pages whose content stream read fine.
    expect(facts.filter((f) => f.kind === 'undetermined')).toHaveLength(0);
  });

  it('a worker torn down mid-sweep rejects every later page, and every one of them is reported — never silently dropped', async () => {
    const torn = new Error('worker was destroyed');
    // Pages 1-2 fine, then the worker is gone for every page after.
    const doc = fakeDoc([{}, {}, { opListRejects: torn }, { opListRejects: torn }, { opListRejects: torn }]);
    const facts = await collectPdfjsFacts(doc);
    const skipped = facts.filter((f) => f.code === 'page.contentUnreadable');
    expect(skipped.map((f) => f.page)).toEqual([2, 3, 4]);
    // The run reaches the end rather than hanging or throwing.
  });

  it('a page that will not even open is undetermined, not silently absent', async () => {
    const doc = fakeDoc([{}, { unreadable: true }, {}]);
    const facts = await collectPdfjsFacts(doc);
    const unreadable = facts.filter((f) => f.code === 'page.unreadable');
    expect(unreadable).toHaveLength(1);
    expect(unreadable[0].page).toBe(1);
    expect(unreadable[0].kind).toBe('undetermined');
  });

  it('a metadata call that REJECTS is recorded as undetermined, never as clean', async () => {
    const doc = fakeDoc([{}], { metadata: 'reject' });
    const facts = await collectPdfjsFacts(doc);
    expect(facts.some((f) => f.code === 'document.metadataUnreadable' && f.kind === 'undetermined')).toBe(true);
  });

  it('a metadata call that never resolves does not hang the sweep forever: it is bounded and recorded undetermined', async () => {
    vi.useFakeTimers();
    try {
      const doc = fakeDoc([{}, {}], { metadata: 'hang' });
      const pending = collectPdfjsFacts(doc);
      let settled = false;
      void pending.then(() => { settled = true; });

      // Nothing settles before the bound: the hang is real until the timeout.
      await vi.advanceTimersByTimeAsync(1000);
      expect(settled).toBe(false);

      // Past the bound the sweep must resolve on its own — no manual
      // intervention, no external cancellation.
      await vi.advanceTimersByTimeAsync(60_000);
      const facts = await pending;
      expect(settled).toBe(true);
      expect(facts.some((f) => f.code === 'document.metadataUnreadable' && f.kind === 'undetermined')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('an unresolved font id is undetermined, never a benign substitution', async () => {
    const doc = {
      isPureXfa: false,
      numPages: 1,
      getMetadata: () => Promise.resolve({}),
      getPage: () =>
        Promise.resolve({
          getOperatorList: () =>
            Promise.resolve({ fnArray: [OPS.setFont], argsArray: [['g_missing']] }),
          commonObjs: { has: () => false, get: () => undefined },
        } as unknown as PDFPageProxy),
    } as unknown as PDFDocumentProxy;
    const facts = await collectPdfjsFacts(doc);
    expect(facts.some((f) => f.code === 'font.unreadable' && f.kind === 'undetermined')).toBe(true);
  });
});
