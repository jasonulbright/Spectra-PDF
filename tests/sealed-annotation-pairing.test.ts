// A document opened with its user password is shown by pdf.js from its
// encrypted bytes, and its annotation sidecar is read from the bytes the
// engine decrypts, which qpdf numbers anew. An annotation id is an object
// number, so the import must read both sides from the same bytes.
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { OpenDocument, OpenFile, PageAnnotation, PageRef, PdfBuffer } from '../src/renderer/state/types';

vi.mock('../src/renderer/lib/pdfRenderer', () => ({ loadDocument: vi.fn() }));

import { loadDocument } from '../src/renderer/lib/pdfRenderer';
import { indexImportSource } from '../src/renderer/lib/workspace';
import { base64ToBytes, bytesToBase64, setSealedReader } from '../src/renderer/lib/sealed-edit';
import { forgetDocumentPassword, rememberDocumentPassword } from '../src/renderer/lib/document-passwords';
import { parseDocumentSecurity, PERMISSION_NAMES } from '../src/renderer/lib/document-permissions';
import { planCommit, buildCommitBytes } from '../src/renderer/lib/workspace-commit';
import { testPython } from './support/python';

const require = createRequire(import.meta.url);
pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs')).href;

const SEALED = parseDocumentSecurity({
  opener: 'user',
  permissions: Object.fromEntries(PERMISSION_NAMES.map((name) => [name, true])),
});

// An AES-256 file (its object keys do not depend on object numbers) whose
// /Annots holds A (/Rect [10 10 20 20]) and B (/Rect [50 50 60 60]) under
// object numbers a writer other than qpdf chose: the references are swapped in
// the written bytes, at equal length. `plain` is the engine's decrypting save
// (`sealed_plaintext`: open with the password, save with no encryption).
const FIXTURE = `
import base64, io, json, re, pikepdf
doc = pikepdf.new()
doc.add_blank_page(page_size=(300, 400))
page = doc.pages[0]
def square(rect):
    return doc.make_indirect(pikepdf.Dictionary(Type=pikepdf.Name.Annot, Subtype=pikepdf.Name.Square, Rect=rect, C=[1, 0, 0]))
filler = doc.make_indirect(pikepdf.Dictionary(Filler=True))
a = square([10, 10, 20, 20])
b = square([50, 50, 60, 60])
page.Annots = pikepdf.Array([filler, a])
page.Zz = b
out = io.BytesIO()
doc.save(out, encryption=pikepdf.Encryption(user='u', owner='o', R=6), object_stream_mode=pikepdf.ObjectStreamMode.disable)
data = bytearray(out.getvalue())
annots = re.search(rb'/Annots\\s*\\[\\s*(\\d+) 0 R\\s+(\\d+) 0 R\\s*\\]', data)
other = re.search(rb'/Zz\\s+(\\d+) 0 R', data)
p, q, r = annots.group(1), annots.group(2), other.group(1)
assert len(p) == len(q) == len(r)
data[annots.start(1):annots.end(1)] = q
data[annots.start(2):annots.end(2)] = r
data[other.start(1):other.end(1)] = p
cipher = bytes(data)
opened = pikepdf.open(io.BytesIO(cipher), password='u')
cipher_ids = [x.objgen[0] for x in opened.pages[0].Annots]
rects = [[int(v) for v in x.Rect] for x in opened.pages[0].Annots]
plain = io.BytesIO()
opened.save(plain, encryption=False, deterministic_id=True)
reopened = pikepdf.open(io.BytesIO(plain.getvalue()))
plain_ids = [x.objgen[0] for x in reopened.pages[0].Annots]
print(json.dumps({
    'cipher': base64.b64encode(cipher).decode('ascii'),
    'plain': base64.b64encode(plain.getvalue()).decode('ascii'),
    'cipherIds': cipher_ids, 'plainIds': plain_ids, 'rects': rects,
}))
`;

interface Fixture {
  cipher: string;
  plain: string;
  cipherIds: number[];
  plainIds: number[];
  rects: number[][];
}

let fixture: Fixture;
let cipher: Uint8Array;
let plain: Uint8Array;

beforeAll(() => {
  fixture = JSON.parse(execFileSync(testPython(), ['-B', '-c', FIXTURE],
    { env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }, encoding: 'utf8', timeout: 30_000 })) as Fixture;
  cipher = base64ToBytes(fixture.cipher);
  plain = base64ToBytes(fixture.plain);
}, 40_000);

afterEach(() => {
  setSealedReader(null);
  forgetDocumentPassword('a.pdf');
});

function sealedFile(): OpenFile {
  vi.mocked(loadDocument).mockImplementation(async (buffer: PdfBuffer, password?: string) =>
    (await pdfjs.getDocument({ data: new Uint8Array(buffer as Uint8Array).slice(), password }).promise) as PDFDocumentProxy);
  rememberDocumentPassword('a.pdf', 'u');
  setSealedReader(async (method, params) => {
    expect(method).toBe('sealed_plaintext');
    expect(params.data).toBe(bytesToBase64(cipher));
    return { data: fixture.plain };
  });
  return { path: 'a.pdf', workingPath: 'a.w', name: 'a.pdf', pageCount: 1, buffer: cipher,
    dirty: false, undoStack: [], redoStack: [], security: SEALED };
}

const isB = (a: PageAnnotation): boolean => a.importedOriginal?.rect[0] === 50;

/** The commit's build over the decrypted bytes, as the page-tier commit of a
 *  user-opened file runs it. */
async function commit(doc: OpenDocument, page: PageRef): Promise<number[][]> {
  const file: OpenFile = { path: 'a.pdf', workingPath: 'a.w', name: 'a.pdf', pageCount: 1, buffer: plain,
    dirty: false, undoStack: [], redoStack: [] };
  const [plan] = planCommit({ documents: [{ ...doc, pages: [page] }] }, new Map([['a.pdf', file]]), ['a.pdf']);
  const out = await buildCommitBytes(plan);
  const pdf = (await pdfjs.getDocument({ data: out.slice() }).promise) as PDFDocumentProxy;
  const annots = (await (await pdf.getPage(1)).getAnnotations()) as { subtype: string; rect: number[] }[];
  await pdf.loadingTask.destroy();
  return annots.filter((a) => a.subtype === 'Square').map((a) => a.rect.map(Math.round));
}

describe('a user-opened document whose decrypted bytes carry other object numbers', () => {
  it('the fixture: the decrypting save renumbers the annotations, and one number names A in one and B in the other', () => {
    expect(fixture.rects).toEqual([[10, 10, 20, 20], [50, 50, 60, 60]]);
    expect(fixture.plainIds).not.toEqual(fixture.cipherIds);
    expect(fixture.plainIds[1]).toBe(fixture.cipherIds[0]);
  });

  it('imports both annotations and leaves no slot untouched', async () => {
    const [doc] = await indexImportSource(sealedFile());
    const [page] = doc.pages;
    expect(page.annotations?.map((a) => a.importedOriginal?.rect)).toEqual([[10, 10, 20, 20], [50, 50, 60, 60]]);
    expect(page.untouchedAnnotationSlots).toBeUndefined();
  });

  it('moving B leaves two annotations: A, and B at its new place', async () => {
    const [doc] = await indexImportSource(sealedFile());
    const [page] = doc.pages;
    const moved = (page.annotations ?? []).map((a) => (isB(a) ? { ...a, x: a.x + 0.3 } : a));
    expect(moved.some(isB)).toBe(true);
    const squares = await commit(doc, { ...page, annotations: moved });
    expect(squares).toHaveLength(2);
    expect(squares).toContainEqual([10, 10, 20, 20]);
    expect(squares).not.toContainEqual([50, 50, 60, 60]);
  });

  it('deleting B leaves A alone', async () => {
    const [doc] = await indexImportSource(sealedFile());
    const [page] = doc.pages;
    const b = (page.annotations ?? []).find(isB);
    expect(b).toBeDefined();
    const squares = await commit(doc, {
      ...page,
      annotations: (page.annotations ?? []).filter((a) => !isB(a)),
      removedImportedOriginals: [b!.importedOriginal!],
    });
    expect(squares).toEqual([[10, 10, 20, 20]]);
  });
});
