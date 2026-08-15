// The web-capture pure layer.
//
// The Rust gate is the ONE authority on what may be loaded and how far a
// crawl may go; everything here is presentation and request-building. So the
// pins that matter read `web_capture.rs` and require agreement — a renderer
// that offered a scheme the gate refuses, or advertised a budget the gate
// clamps, would be a dialog telling the user something untrue.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  CAPTURE_DEPTHS,
  CAPTURE_PAPERS,
  CAPTURE_PAPER_IDS,
  CAPTURE_SCHEMES,
  DEPTH_LABEL_KEYS,
  MAX_DEPTH_CEILING,
  MAX_PAGES_CEILING,
  buildRequest,
  outlineFromRows,
  paperInches,
  previewHost,
} from '../src/renderer/lib/web-capture';
import { PAGE_SIZES } from '../src/renderer/lib/create-pdf';
import { DIALOG_STRINGS } from '../src/renderer/i18n-dialogs';

const RUST = readFileSync(resolve(__dirname, '../src-tauri/src/web_capture.rs'), 'utf8');

describe('web capture', () => {
  it('offers exactly the schemes the Rust gate admits', () => {
    const arm = RUST.match(/matches!\(\s*scheme\.as_str\(\),([^)]*)\)/);
    expect(arm, 'the scheme gate moved — this pin must follow it').toBeTruthy();
    const schemes = [...arm![1].matchAll(/"([a-z]+)"/g)].map((m) => m[1]);
    expect(schemes.sort()).toEqual([...CAPTURE_SCHEMES].sort());
  });

  it('states the same ceilings the Rust side clamps to', () => {
    const pages = RUST.match(/MAX_PAGES_CEILING:\s*u32\s*=\s*(\d+)/);
    const depth = RUST.match(/MAX_DEPTH_CEILING:\s*u32\s*=\s*(\d+)/);
    expect(Number(pages![1])).toBe(MAX_PAGES_CEILING);
    expect(Number(depth![1])).toBe(MAX_DEPTH_CEILING);
    // Every depth the dialog offers must be one the gate will honour.
    for (const d of CAPTURE_DEPTHS) expect(d).toBeLessThanOrEqual(MAX_DEPTH_CEILING);
  });

  it('names the host it is about to contact', () => {
    expect(previewHost('example.test/a')).toBe('example.test');
    expect(previewHost('https://User:pw@Example.TEST:8443/x')).toBe('example.test:8443');
    expect(previewHost('http://example.test')).toBe('example.test');
  });

  it('shows nothing for an address the gate would refuse', () => {
    for (const raw of ['', '   ', 'javascript:alert(1)', 'data:text/html,x', 'mailto:a@b.test']) {
      expect(previewHost(raw), `${raw} must not name a host`).toBeNull();
    }
  });

  it('names the FILE for a file: address, which has no host', () => {
    expect(previewHost('file:///c:/tmp/page.html')).toBe('page.html');
  });

  it('clamps depth, budget, scale and margin rather than trusting them', () => {
    const wild = buildRequest({
      url: '  https://example.test/  ',
      depth: 99,
      maxPages: 9999,
      scale: 42,
      marginIn: -3,
    });
    expect(wild.depth).toBe(MAX_DEPTH_CEILING);
    expect(wild.maxPages).toBe(MAX_PAGES_CEILING);
    expect(wild.scale).toBe(1);
    expect(wild.marginIn).toBe(0);
    expect(wild.url).toBe('https://example.test/');
  });

  it('a single-page capture advertises a budget of one', () => {
    // Depth 0 can only produce one page, so a budget above 1 would promise a
    // crawl that cannot happen.
    expect(buildRequest({ url: 'a.test', depth: 0, maxPages: 50 }).maxPages).toBe(1);
    expect(buildRequest({ url: 'a.test', depth: 1, maxPages: 50 }).maxPages).toBe(50);
  });

  it('a non-numeric budget falls to the floor, never to NaN', () => {
    const built = buildRequest({ url: 'a.test', depth: 1, maxPages: Number.NaN });
    expect(built.maxPages).toBe(1);
    expect(built.pageWidthIn).toBe(8.5);
    expect(built.pageHeightIn).toBe(11);
    expect(built.orientation).toBe('portrait');
  });

  it('paper dimensions are always portrait, so orientation cannot disagree', () => {
    for (const id of CAPTURE_PAPER_IDS) {
      const [w, h] = paperInches(id);
      expect(w, `${id} is not portrait`).toBeLessThanOrEqual(h);
      expect(CAPTURE_PAPERS[id][0]).toBe(w);
    }
  });

  it('every paper it offers reuses a page-size label the catalog already has', () => {
    const catalog = DIALOG_STRINGS as Record<string, string>;
    for (const id of CAPTURE_PAPER_IDS) {
      expect(PAGE_SIZES, `${id} has no Create PDF counterpart`).toContain(id);
      expect(catalog[`dialog.createPdf.pageSize.${id}`], `${id} label missing`).toBeTruthy();
    }
  });

  it('every depth it offers has a label key the catalog carries', () => {
    const catalog = DIALOG_STRINGS as Record<string, string>;
    for (const d of CAPTURE_DEPTHS) {
      expect(catalog[DEPTH_LABEL_KEYS[d]], `depth ${d} label missing`).toBeTruthy();
    }
  });

  it('bookmarks land on the pages the captures actually produced', () => {
    const rows = [
      { origin: 'web' as const, captureUrl: 'https://a.test/', captureTitle: 'Home' },
      { origin: 'web' as const, captureUrl: 'https://a.test/b', captureTitle: 'B' },
    ];
    expect(outlineFromRows(rows, [3, 2])).toEqual([
      { title: 'Home', page: 1 },
      { title: 'B', page: 4 },
    ]);
  });

  it('a mixed list offsets the bookmarks past the local files', () => {
    const rows = [
      {},
      { origin: 'web' as const, captureUrl: 'https://a.test/', captureTitle: 'Home' },
      { origin: 'clipboard' as const },
      { origin: 'web' as const, captureUrl: 'https://a.test/b', captureTitle: 'B' },
    ];
    expect(outlineFromRows(rows, [5, 2, 1, 4])).toEqual([
      { title: 'Home', page: 6 },
      { title: 'B', page: 9 },
    ]);
  });

  it('a titleless page is bookmarked by its address', () => {
    const rows = [{ origin: 'web' as const, captureUrl: 'https://a.test/x', captureTitle: '   ' }];
    expect(outlineFromRows(rows, [1])).toEqual([{ title: 'https://a.test/x', page: 1 }]);
  });

  it('counts that do not line up produce NO bookmarks rather than wrong ones', () => {
    const rows = [{ origin: 'web' as const, captureUrl: 'https://a.test/', captureTitle: 'Home' }];
    expect(outlineFromRows(rows, [])).toEqual([]);
    expect(outlineFromRows(rows, [1, 2])).toEqual([]);
    expect(outlineFromRows(rows, [0])).toEqual([]);
    expect(outlineFromRows([], [])).toEqual([]);
  });

  it('a list with no captured page has no outline to write', () => {
    expect(outlineFromRows([{}, { origin: 'clipboard' }], [2, 1])).toEqual([]);
  });
});
