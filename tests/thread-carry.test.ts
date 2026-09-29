// Articles on donor pages: a bead copied from another document is reachable
// only through a listed thread (ISO 32000-2 12.4.3), so the rebuild lists the
// threads of every contributing source, not only the owner's.
import { describe, expect, it } from 'vitest';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRef, PDFString } from 'pdf-lib';
import { buildPdf, buildPdfx } from '../src/renderer/lib/pdfx-build';
import type { ExportPage } from '../src/renderer/lib/pdfx-format';

const N = PDFName.of.bind(PDFName);

async function source(pageCount: number, title?: string, onPages: number[] = [], closed = true): Promise<Uint8Array> {
  const pdf = await PDFDocument.create({ updateMetadata: false });
  for (let i = 0; i < pageCount; i++) pdf.addPage([300 + 100 * i, 700]);
  if (title) {
    const ctx = pdf.context, threadRef = ctx.register(ctx.obj({ Type: 'Thread', I: { Title: PDFString.of(title) } }));
    const beads = onPages.map(p => ctx.register(ctx.obj({ Type: 'Bead', P: pdf.getPage(p).ref, R: [10, 10, 100, 100] })));
    beads.forEach((ref, i) => {
      const bead = ctx.lookup(ref, PDFDict);
      if (closed || i + 1 < beads.length) bead.set(N('N'), beads[(i + 1) % beads.length]);
      bead.set(N('V'), beads[(i - 1 + beads.length) % beads.length]);
      if (i === 0) bead.set(N('T'), threadRef);
      pdf.getPage(onPages[i]).node.set(N('B'), ctx.obj([ref]));
    });
    ctx.lookup(threadRef, PDFDict).set(N('F'), beads[0]);
    pdf.catalog.set(N('Threads'), ctx.obj([threadRef]));
  }
  return pdf.save();
}

const at = (bytes: Uint8Array, sourceKey: string, pageIndex: number): ExportPage => ({ bytes, sourceKey, pageIndex });

async function build(format: 'pdf' | 'pdfx', pages: ExportPage[], own: Uint8Array): Promise<PDFDocument> {
  const built = format === 'pdf' ? await buildPdf(pages, own, 'own')
    : await buildPdfx([{ name: 'Document', pages }], 'Document', own, 'own');
  return PDFDocument.load(built, { updateMetadata: false });
}

function listed(out: PDFDocument): { title: string; ring: PDFDict[]; thread: PDFRef }[] {
  const threads = out.catalog.lookupMaybe(N('Threads'), PDFArray);
  return (threads?.asArray() ?? []).map(raw => {
    const thread = out.context.lookup(raw, PDFDict);
    const ring: PDFDict[] = [];
    let cursor = thread.lookup(N('F'), PDFDict);
    while (!ring.includes(cursor) && ring.length < 100) { ring.push(cursor); cursor = cursor.lookup(N('N'), PDFDict); }
    expect(cursor).toBe(ring[0]);
    return { title: thread.lookup(N('I'), PDFDict).lookup(N('Title'), PDFString).decodeText(), ring, thread: raw as PDFRef };
  });
}

describe.each(['pdf', 'pdfx'] as const)('donor threads are listed (%s)', format => {
  it('lists a donor thread whose beads arrive on copied pages', async () => {
    const own = await source(1, 'Own', [0]);
    const donor = await source(2, 'Donor', [0, 1]);
    const out = await build(format, [at(own, 'own', 0), at(donor, 'donor', 0), at(donor, 'donor', 1)], own);
    const threads = listed(out);
    expect(threads.map(t => t.title)).toEqual(['Own', 'Donor']);
    const pages = out.getPages().map(p => p.ref.tag);
    const donorThread = threads[1];
    expect(donorThread.ring.map(b => (b.get(N('P')) as PDFRef).tag)).toEqual([pages[1], pages[2]]);
    expect(donorThread.ring[0].get(N('T'))).toBe(donorThread.thread);
    expect(donorThread.ring[0].get(N('V'))).toBe(out.context.getObjectRef(donorThread.ring[1]));
  });

  it('re-closes a donor ring over the copied beads only', async () => {
    const own = await source(1);
    const donor = await source(3, 'Donor', [0, 1, 2]);
    const out = await build(format, [at(own, 'own', 0), at(donor, 'donor', 2), at(donor, 'donor', 0)], own);
    const [thread] = listed(out);
    expect(thread.title).toBe('Donor');
    expect(thread.ring).toHaveLength(2);
    expect(thread.ring[0].get(N('T'))).toBe(thread.thread);
    const pages = new Set(out.getPages().map(p => p.ref.tag));
    for (const bead of thread.ring) expect(pages.has((bead.get(N('P')) as PDFRef).tag)).toBe(true);
  });

  it('does not list a donor thread with no copied bead or an open ring', async () => {
    const own = await source(1);
    const elsewhere = await source(2, 'Elsewhere', [1]);
    const open = await source(2, 'Open', [0, 1], false);
    const out = await build(format, [at(own, 'own', 0), at(elsewhere, 'a', 0), at(open, 'b', 0)], own);
    expect(out.catalog.get(N('Threads'))).toBeUndefined();
  });
});
