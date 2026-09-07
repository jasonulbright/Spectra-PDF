import { OPS } from 'pdfjs-dist';
import type { PDFDocumentProxy, PDFPageProxy } from 'pdfjs-dist';
import type { HealthFact } from './doc-health';

// The pdf.js half of the health ledger: facts taken from pdf.js's own
// STRUCTURED signals, never from its console output.
//
// Which hook supplies which fact, in the bundled pdfjs-dist 6.2:
//
//   font substitution   `page.getOperatorList()` resolves every font the page
//                       draws with into `page.commonObjs`; the entry is a
//                       `FontFaceObject` whose `missingFile` getter is true
//                       exactly when the program was absent and pdf.js drew a
//                       fallback (`display/font_loader.d.ts`). The font ids
//                       come from the operator list's own `OPS.setFont`
//                       arguments, so only fonts the page ACTUALLY draws with
//                       are reported — a resource entry nothing selects is not
//                       a substitution.
//   broken content      a `getOperatorList()` REJECTION is pdf.js refusing the
//                       page's content stream. It is the only verdict pdf.js
//                       states rather than logs.
//   XFA                 `PDFDocumentProxy.isPureXfa` — a document whose real
//                       content is an XFA form, which this renderer draws as
//                       the (usually empty) AcroForm fallback.
//   metadata            `getMetadata()` rejecting means the document's own
//                       description could not be read; recorded as
//                       undetermined rather than as nothing.
//
// What this boundary CANNOT supply: pdf.js removed `onUnsupportedFeature` /
// the `UnsupportedFeature` event after v3, and 6.2 reports unsupported
// constructs and image-decode failures only as console warnings. Scraping
// console text is not evidence, so those classes collect NOTHING here and are
// left to the engine boundary; the ledger says "no evidence collected" for
// them rather than implying they were checked.

/** `PDFObjects.has` is real in pdf.js 6.2 but absent from its published
 * types, so the map is narrowed here rather than at each call. */
interface CommonObjs {
  has(id: string): boolean;
  get(id: string): unknown;
}

/** The shape of a resolved font entry this collector reads. */
interface FontEntry {
  missingFile?: boolean;
  isType3Font?: boolean;
  name?: string;
  fallbackName?: string;
}

function fact(
  kind: HealthFact['kind'],
  severity: HealthFact['severity'],
  code: string,
  page: number | null,
  params: Record<string, string | number> = {},
): HealthFact {
  return { kind, severity, boundary: 'pdfjs', code, page, params };
}

/** The loaded-font ids an operator list selects, in first-use order. */
function fontIdsIn(opList: { fnArray: unknown[]; argsArray: unknown[] }): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < opList.fnArray.length; i += 1) {
    if (opList.fnArray[i] !== OPS.setFont) continue;
    const args = opList.argsArray[i] as unknown[] | undefined;
    const id = args?.[0];
    if (typeof id !== 'string' || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

async function collectPage(
  doc: PDFDocumentProxy,
  index: number,
  substituted: Set<string>,
): Promise<HealthFact[]> {
  let page: PDFPageProxy;
  try {
    page = await doc.getPage(index + 1);
  } catch {
    return [fact('undetermined', 'warning', 'page.unreadable', index)];
  }
  let opList: { fnArray: unknown[]; argsArray: unknown[] };
  try {
    opList = await page.getOperatorList();
  } catch {
    // The page's content stream will not parse. pdf.js draws nothing for it.
    return [fact('skipped', 'warning', 'page.contentUnreadable', index)];
  }
  const objs = page.commonObjs as unknown as CommonObjs;
  const out: HealthFact[] = [];
  for (const id of fontIdsIn(opList)) {
    let entry: FontEntry | null;
    try {
      entry = objs.has(id) ? (objs.get(id) as FontEntry) : null;
    } catch {
      entry = null;
    }
    if (!entry) {
      // The operator list named a font the worker never resolved — the
      // substitution question for it has no answer, which is not the same as
      // no substitution.
      out.push(fact('undetermined', 'warning', 'font.unreadable', index, { font: '' }));
      continue;
    }
    if (!entry.missingFile || entry.isType3Font) continue;
    // Once per document: one missing program is one substitution, however
    // many pages select it.
    const name = String(entry.name ?? entry.fallbackName ?? '');
    if (substituted.has(name)) continue;
    substituted.add(name);
    out.push(fact('font', 'warning', 'font.substituted', index, { font: name }));
  }
  return out;
}

/**
 * Every fact the pdf.js boundary reports about one loaded document.
 *
 * EVERY page is walked. A bounded sweep would report a subset as a total, and
 * a document whose only substituted font is on page 400 would read as clean.
 * The cost is one operator-list build per page, which is the work rendering
 * that page would do anyway; the run is off the paint path and its result is
 * dropped if the document's bytes change under it.
 *
 * Throws only if the document proxy itself is unusable — the caller records
 * that as a FAILED run, which is `undetermined`, never healthy.
 */
export async function collectPdfjsFacts(doc: PDFDocumentProxy): Promise<HealthFact[]> {
  const facts: HealthFact[] = [];
  if (doc.isPureXfa) facts.push(fact('skipped', 'info', 'document.xfa', null));
  try {
    await doc.getMetadata();
  } catch {
    facts.push(fact('undetermined', 'warning', 'document.metadataUnreadable', null));
  }
  const substituted = new Set<string>();
  for (let i = 0; i < doc.numPages; i += 1) {
    // Idle between pages. pdf.js's worker is one serial queue, so a long
    // document's sweep would otherwise sit in front of the renders the user is
    // waiting for. Yielding does not shorten the sweep and does not reduce
    // what it covers; it decides who goes first.
    await idle();
    facts.push(...(await collectPage(doc, i, substituted)));
  }
  return facts;
}

interface IdleHost {
  requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => void;
}

function idle(): Promise<void> {
  const host = globalThis as IdleHost;
  return new Promise((resolve) => {
    if (typeof host.requestIdleCallback === 'function') {
      // The timeout is the floor: an app that never goes idle must still
      // finish the sweep, or the ledger would sit at `no-evidence` forever.
      host.requestIdleCallback(() => resolve(), { timeout: 500 });
    } else {
      setTimeout(resolve, 0);
    }
  });
}
