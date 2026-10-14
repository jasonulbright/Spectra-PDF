// A signed document that takes a text box in a bundled face: the pieces a
// test signs, commits, appends and verifies with.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PDFDocument, PDFName, PDFString } from 'pdf-lib';
import type { PageAnnotation, PageRef } from '../../src/renderer/state/types';
import { commit } from './commit-cycle';
import { testPython } from './python';

const ROOT = join(__dirname, '..', '..');

export interface SignatureVerdict {
  intact: boolean;
  valid: boolean;
  trusted: boolean;
  modification_level: string | null;
  policy_ok: boolean | null;
  policy_judged: boolean | null;
  /** pyHanko under its own default difference policy. */
  stock: { intact: boolean; valid: boolean; bottom_line: boolean; modification_level: string | null; docmdp_ok: boolean | null } | null;
}

export interface AppendAnswer {
  report: { applied?: boolean; reason?: string; raised?: string; delta_classes?: string[] } & Record<string, unknown>;
  signatures?: SignatureVerdict[];
}

function ask<T>(request: Record<string, unknown>): T {
  const out = execFileSync(testPython(), ['-B', join(ROOT, 'tests', 'support', 'signed_append.py')], {
    input: JSON.stringify(request), cwd: ROOT, maxBuffer: 64 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  });
  return JSON.parse(out.toString('utf8')) as T;
}

export interface Pki { pfx: string; ca_pem: string }

export const buildPki = (dir: string): Pki => ask<Pki>({ op: 'pki', dir });

/** A one-page file with two text fields; the form dictionary is an object
 *  of its own or is written in the catalog. */
export async function formDocument(direct: boolean): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const ctx = doc.context;
  const helvetica = ctx.register(ctx.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica', Encoding: 'WinAnsiEncoding' }));
  const widgets = ['name', 'other'].map((name, index) => {
    const widget = ctx.obj({ Type: 'Annot', Subtype: 'Widget', FT: 'Tx', Rect: [50, 500 - index * 50, 250, 530 - index * 50], F: 4, P: page.ref });
    widget.set(PDFName.of('T'), PDFString.of(name));
    widget.set(PDFName.of('V'), PDFString.of('value'));
    widget.set(PDFName.of('DA'), PDFString.of('/Helv 0 Tf 0 g'));
    return ctx.register(widget);
  });
  page.node.set(PDFName.of('Annots'), ctx.obj(widgets));
  const form = ctx.obj({ Fields: widgets, DR: { Font: { Helv: helvetica } } });
  form.set(PDFName.of('DA'), PDFString.of('/Helv 0 Tf 0 g'));
  doc.catalog.set(PDFName.of('AcroForm'), direct ? form : ctx.register(form));
  return doc.save({ useObjectStreams: false });
}

/** Signs `bytes` into `output`. `options` are `sign_pdf` arguments. */
export function sign(bytes: Uint8Array, dir: string, name: string, pki: Pki, options: Record<string, unknown> = {}): string {
  const source = join(dir, `unsigned-${name}`);
  const output = join(dir, name);
  writeFileSync(source, bytes);
  ask({ op: 'sign', file: source, output, pfx: pki.pfx, options });
  return output;
}

/** Commits `edit` on the signed file as the page tier does, appends the
 *  result to the signed bytes, and reads the verdict of each signature. */
export async function commitAndAppend(
  signed: string, dir: string, name: string, pki: Pki, edit: (pages: PageRef[]) => PageRef[],
): Promise<AppendAnswer & { original: Uint8Array; built: Uint8Array; output: string }> {
  const original = new Uint8Array(readFileSync(signed));
  const built = await commit(original, edit);
  const modified = join(dir, `built-${name}`);
  const output = join(dir, `appended-${name}`);
  writeFileSync(modified, built);
  const answer = ask<AppendAnswer>({ op: 'append', original: signed, modified, output, ca: pki.ca_pem });
  return { ...answer, original, built, output };
}

export const textBox = (note: string, over: Partial<PageAnnotation> = {}): PageAnnotation =>
  ({ id: `box-${note}`, kind: 'freetext', x: 0.1, y: 0.1, w: 0.6, h: 0.1, color: '#2563eb', note, ...over });

/** Adds `annotation` to the first page. */
export const adding = (annotation: PageAnnotation) => (pages: PageRef[]): PageRef[] =>
  pages.map((page, index) => (index === 0 ? { ...page, annotations: [...(page.annotations ?? []), annotation] } : page));

/** Gives the first free text of the first page a new text. */
export const retyping = (note: string) => (pages: PageRef[]): PageRef[] =>
  pages.map((page, index) => (index === 0 ? {
    ...page,
    annotations: (page.annotations ?? []).map((a) => (a.kind === 'freetext' ? { ...a, note, geometryDiverged: true } : a)),
  } : page));
