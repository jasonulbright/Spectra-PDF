// A pdf.js proxy is valid only for the exact bytes it was loaded from. Keying
// the canvas map by path alone left the OLD proxy exposed when the same path
// took new bytes and the new load FAILED — the canvas drew the previous
// document while the panels and File ▸ Save addressed the new one.
import { describe, expect, it } from 'vitest';
import {
  pruneProxyEntries,
  visibleProxies,
  withProxyEntry,
  type ProxyEntries,
} from '../src/renderer/lib/pdf-proxy-entries';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { OpenFile, PdfBuffer } from '../src/renderer/state/types';

const A = new Uint8Array([1]);
const B = new Uint8Array([2]);

function proxy(tag: string): PDFDocumentProxy {
  return { tag } as unknown as PDFDocumentProxy;
}

function files(...rows: [string, PdfBuffer | null][]): Map<string, OpenFile> {
  return new Map(rows.map(([path, buffer]) => [path, { path, buffer } as unknown as OpenFile]));
}

describe('pdf proxy buffer identity', () => {
  it('exposes a proxy only while its recorded buffer is the file s current one', () => {
    const entries: ProxyEntries = new Map([['x.pdf', { buffer: A, proxy: proxy('a') }]]);
    expect([...visibleProxies(entries, files(['x.pdf', A])).keys()]).toEqual(['x.pdf']);
    expect([...visibleProxies(entries, files(['x.pdf', B])).keys()]).toEqual([]);
  });

  it('A loads, the same path takes B, and B fails: nothing is exposed', () => {
    // A rendered.
    let entries: ProxyEntries = new Map();
    entries = withProxyEntry(entries, 'x.pdf', A, proxy('a'), files(['x.pdf', A]));
    expect(visibleProxies(entries, files(['x.pdf', A])).size).toBe(1);
    // The buffer is replaced. The stale entry goes at that moment — not when
    // the new load answers, which for a rejection is never.
    const now = files(['x.pdf', B]);
    entries = pruneProxyEntries(entries, now);
    expect(entries.size).toBe(0);
    // B's load rejects: no entry is ever recorded, so the canvas has a
    // placeholder rather than A's pages.
    expect(visibleProxies(entries, now).size).toBe(0);
  });

  it('drops the entry for a closed path', () => {
    const entries: ProxyEntries = new Map([['x.pdf', { buffer: A, proxy: proxy('a') }]]);
    expect(pruneProxyEntries(entries, files()).size).toBe(0);
  });

  it('returns the same map when nothing is stale, so a state setter can bail out', () => {
    const entries: ProxyEntries = new Map([['x.pdf', { buffer: A, proxy: proxy('a') }]]);
    expect(pruneProxyEntries(entries, files(['x.pdf', A]))).toBe(entries);
  });

  it('discards a proxy whose buffer lost the race across the async gap', () => {
    const entries: ProxyEntries = new Map();
    // A's load resolves after the file already moved to B.
    const next = withProxyEntry(entries, 'x.pdf', A, proxy('a'), files(['x.pdf', B]));
    expect(next).toBe(entries);
  });

  it('records a proxy against the buffer it was loaded from', () => {
    const entries = withProxyEntry(new Map(), 'x.pdf', B, proxy('b'), files(['x.pdf', B]));
    expect(entries.get('x.pdf')?.buffer).toBe(B);
  });
});
