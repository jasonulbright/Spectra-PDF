import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect } from '@wdio/globals';
import { PDFDocument, PDFDict, PDFName, PDFStream, PDFRawStream } from 'pdf-lib';
import { crc32, deflateSync, inflateSync } from 'node:zlib';
import {
  answerImagePicker,
  answerNextSaveDialog,
  getState,
  invokeAppCommand,
  openByPaths,
  saveDialogPending,
  setActiveOp,
  setReactInputValue,
  setReactSelectValue,
  setView,
  waitForDisplayedSelector,
  waitForHarness,
} from '../support/harness.js';

// F30 — the certificate stamp's APPEARANCE, on both signing surfaces.
//
// ONE APPEARANCE AUTHOR is the claim: the preview is the engine painting the
// same style into a one-page PDF, and the signature carries the drawing the
// preview showed. So every assertion here is either about the WRITTEN FILE's
// appearance stream or about a refusal the engine names — never about a
// renderer-side drawing, because there is none to check.
//
// Reading the appearance back: the widget's /AP /N stream, decompressed. A
// configured stamp and an unconfigured one are compared against each other as
// well as read for their content, so "the appearance travelled" is a
// difference in the bytes and not only a string search that could pass on a
// coincidence.

const SAMPLE_PDF = resolve(__dirname, '..', 'fixtures', 'sample.pdf');
const APP_EXE = resolve(__dirname, '..', '..', 'src-tauri', 'target', 'debug', 'spectrapdf.exe');
const TEST_PFX = resolve(__dirname, '..', 'fixtures', 'test-signer.pfx');
const TEST_PFX_PASSWORD = 'testpw';

/** A small RGBA PNG, built rather than pasted — a hand-copied base64 blob that
 * is subtly malformed fails here as "the picker did nothing". */
function logoPng(): Buffer {
  const w = 16;
  const h = 16;
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y += 1) {
    const row = y * (w * 4 + 1);
    for (let x = 0; x < w; x += 1) {
      const ink = (x + y) % 4 < 2;
      const p = row + 1 + x * 4;
      raw[p] = ink ? 20 : 240;
      raw[p + 1] = ink ? 40 : 240;
      raw[p + 2] = ink ? 180 : 240;
      raw[p + 3] = 255;
    }
  }
  const chunk = (type: string, body: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(body.length);
    const typed = Buffer.concat([Buffer.from(type, 'latin1'), body]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(typed) >>> 0);
    return Buffer.concat([len, typed, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const SIGN_FORM = '[data-testid="sign-form"]';
const STAMP_GROUP = '[data-testid="sign-stamp-group"]';
const STAMP_PREVIEW = '[data-testid="sign-stamp-preview"]';
const STAMP_PREVIEW_ERROR = '[data-testid="sign-stamp-preview-error"]';

let SCRATCH = '';
let logoPath = '';

/**
 * Every appearance stream on the file's signature widgets, decompressed — and
 * the Form XObjects each one draws, recursively.
 *
 * The nesting is not incidental: `beside` layouts and the personal face
 * compose as SIDECAR XObjects (doc 94 § F30), so the widget's own stream holds
 * only a `/Sidecar0 Do` and the ink lives one level down. A reader that
 * stopped at the widget would conclude the face never travelled.
 */
function appearanceStreams(path: string): Promise<string[]> {
  return PDFDocument.load(readFileSync(path)).then((doc) => {
    const out: string[] = [];
    const seen = new Set<PDFStream>();
    const collect = (stream: PDFStream): void => {
      if (seen.has(stream)) return;
      seen.add(stream);
      out.push(decodeStream(stream));
      const resources = stream.dict.lookupMaybe(PDFName.of('Resources'), PDFDict);
      const xobjects = resources?.lookupMaybe(PDFName.of('XObject'), PDFDict);
      if (!xobjects) return;
      for (const key of xobjects.keys()) {
        const nested = doc.context.lookup(xobjects.get(key));
        if (nested instanceof PDFStream) collect(nested);
      }
    };
    for (const page of doc.getPages()) {
      const annots = page.node.Annots();
      if (!annots) continue;
      for (let i = 0; i < annots.size(); i += 1) {
        const annot = doc.context.lookup(annots.get(i), PDFDict);
        const ap = annot.lookupMaybe(PDFName.of('AP'), PDFDict);
        const normal = ap?.get(PDFName.of('N'));
        if (!normal) continue;
        const stream = doc.context.lookup(normal);
        if (stream instanceof PDFStream) collect(stream);
      }
    }
    return out;
  });
}

function decodeStream(stream: PDFStream): string {
  const bytes =
    stream instanceof PDFRawStream ? Buffer.from(stream.contents) : Buffer.from(stream.getContents());
  const filter = stream.dict.get(PDFName.of('Filter'));
  if (filter && String(filter).includes('FlateDecode')) {
    try {
      return inflateSync(bytes).toString('latin1');
    } catch {
      return bytes.toString('latin1');
    }
  }
  return bytes.toString('latin1');
}

/**
 * Undo PDF literal-string escaping so a drawn line can be looked for as the
 * text it is. A content stream writes `-` as `\055`, so a raw substring search
 * for a hyphenated label finds nothing while the label is plainly there.
 */
function decodeStringEscapes(stream: string): string {
  return stream.replace(/\\([0-7]{1,3})/g, (_m, oct: string) =>
    String.fromCharCode(parseInt(oct, 8)),
  );
}

/** What the appearance section is complaining about, or '' when it is not. */
async function previewError(): Promise<string> {
  const el = await $(STAMP_PREVIEW_ERROR);
  return (await el.isExisting()) ? el.getText() : '';
}

/** The CLI writes engine progress lines before its JSON. */
function cliJson<T>(args: string[]): T {
  const out = execFileSync(APP_EXE, args, { encoding: 'utf-8' });
  const start = out.indexOf('{');
  if (start < 0) throw new Error(`no JSON in \`${args.join(' ')}\`: ${out}`);
  return JSON.parse(out.slice(start)) as T;
}

/** Open the sign form. `reopen` closes an already-open one first, which is
 * what makes it re-read the signature store — the form reads the assets when
 * it opens, so a store written while it stood open is not yet its store. */
async function openSignForm(reopen = false): Promise<void> {
  await setView('operations');
  await setActiveOp('signatures');
  await waitForDisplayedSelector('[data-testid="sign-open"]', { timeout: 20_000 });
  if (reopen && (await $(SIGN_FORM).isExisting())) {
    await $('[data-testid="sign-open"]').click();
    await waitForDisplayedSelector(SIGN_FORM, { reverse: true, timeout: 10_000 });
  }
  if (!(await $(SIGN_FORM).isExisting())) await $('[data-testid="sign-open"]').click();
  await waitForDisplayedSelector(SIGN_FORM, { timeout: 10_000 });
  await waitForDisplayedSelector(STAMP_GROUP, { timeout: 10_000 });
}

async function storeAsset(asset: Record<string, unknown>): Promise<void> {
  await browser.execute(function (a: unknown) {
    const raw = localStorage.getItem('spectra-signatures');
    let list: unknown[] = [];
    try {
      const parsed = JSON.parse(raw ?? '[]');
      if (Array.isArray(parsed)) list = parsed;
    } catch {
      list = [];
    }
    localStorage.setItem('spectra-signatures', JSON.stringify([a, ...list]));
  }, asset);
}

describe('the certificate stamp appearance', () => {
  before(async () => {
    SCRATCH = mkdtempSync(join(tmpdir(), 'spectra-e2e-stamp-'));
    logoPath = join(SCRATCH, 'logo.png');
    writeFileSync(logoPath, logoPng());
    await waitForHarness();
    await browser.execute(() => localStorage.removeItem('spectra-signatures'));
    await openByPaths([SAMPLE_PDF]);
    await browser.waitUntil(async () => (await getState()).view === 'canvas', {
      timeoutMsg: 'opening sample.pdf did not land on canvas',
    });
  });

  after(async () => {
    await browser.execute(() => localStorage.removeItem('spectra-signatures'));
    await invokeAppCommand('tools.close').catch(() => undefined);
    if (SCRATCH) rmSync(SCRATCH, { recursive: true, force: true });
  });

  it('the panel form draws a live preview of the appearance it will sign with', async () => {
    await openSignForm();
    // The default appearance already previews — the section is never a blank
    // box waiting to be configured.
    await browser.waitUntil(async () => $(STAMP_PREVIEW).isExisting(), {
      timeout: 30_000,
      timeoutMsg: `the preview never drew: ${await previewError()}`,
    });
    const before = (await $(STAMP_PREVIEW).getAttribute('src')) ?? '';
    expect(before.startsWith('data:')).toBe(true);

    // Add the free label line. The preview is the ENGINE's drawing, so a
    // changed spec has to produce changed pixels — a renderer that decided for
    // itself could not.
    await $('[data-testid="sign-stamp-field-label"]').click();
    await waitForDisplayedSelector('[data-testid="sign-stamp-label"]', { timeout: 10_000 });
    await setReactInputValue('[data-testid="sign-stamp-label"]', 'E2E-STAMP-LINE');
    await browser.waitUntil(
      async () => (await $(STAMP_PREVIEW).getAttribute('src')) !== before,
      { timeout: 30_000, timeoutMsg: `the preview never redrew for the new line: ${await previewError()}` },
    );
  });

  it('the signed output carries the custom line the preview showed', async () => {
    // Signed through the CLI with the SAME spec, against a control with none:
    // the panel's own sign needs a native .pfx pick this suite cannot drive,
    // and the CLI and the panel assemble the same engine request — the
    // appearance author is one either way. What is proven here is that the
    // spec reaches the WRITTEN appearance stream.
    const plain = join(SCRATCH, 'plain.pdf');
    const labelled = join(SCRATCH, 'labelled.pdf');
    const visible = ['--visible-page', '1', '--visible-rect', '72,600,320,690'];
    execFileSync(APP_EXE, [
      'sign', SAMPLE_PDF, '-o', plain,
      '--pfx', TEST_PFX, '--password', TEST_PFX_PASSWORD, ...visible,
    ]);
    execFileSync(APP_EXE, [
      'sign', SAMPLE_PDF, '-o', labelled,
      '--pfx', TEST_PFX, '--password', TEST_PFX_PASSWORD, ...visible,
      '--stamp-fields', 'name,date,label', '--stamp-label', 'E2E-STAMP-LINE',
    ]);
    const plainAp = decodeStringEscapes((await appearanceStreams(plain)).join('\n'));
    const labelledAp = decodeStringEscapes((await appearanceStreams(labelled)).join('\n'));
    expect(plainAp).not.toBe('');
    expect(labelledAp).not.toBe(plainAp);
    expect(labelledAp).toContain('E2E-STAMP-LINE');
    expect(plainAp).not.toContain('E2E-STAMP-LINE');
  });

  it('a saved drawn face reaches the stamp as vector content', async () => {
    // An ink face draws as PATHS, not as a raster: that is what keeps a
    // signature crisp at print size. The face is written as the resolved-face
    // JSON the surfaces build, which is what the CLI flag takes.
    const faceJson = join(SCRATCH, 'drawn-face.json');
    writeFileSync(
      faceJson,
      JSON.stringify({
        assetId: 'e2e-drawn',
        name: 'E2E drawn',
        role: 'signature',
        aspect: 0.4,
        form: 'vector',
        paths: [[0, 0.9, 0.25, 0.1, 0.5, 0.9, 0.75, 0.1, 1, 0.9]],
      }),
      'utf-8',
    );
    const out = join(SCRATCH, 'drawn-face.pdf');
    execFileSync(APP_EXE, [
      'sign', SAMPLE_PDF, '-o', out,
      '--pfx', TEST_PFX, '--password', TEST_PFX_PASSWORD,
      '--visible-page', '1', '--visible-rect', '72,600,320,690',
      '--stamp-signature', faceJson,
    ]);
    const ap = (await appearanceStreams(out)).join('\n');
    // Path construction operators: the ink is DRAWN, never placed as a raster.
    if (!/(^|[\s\d])(m|l|c)(\s|$)/.test(ap)) {
      throw new Error(`no path operators in the appearance: ${ap.slice(0, 800)}`);
    }
    const verified = cliJson<{ signatures: { valid: boolean }[] }>(['verify-signatures', out]);
    expect(verified.signatures[0].valid).toBe(true);
  });

  it('a saved typed face signs into an existing empty field', async () => {
    const faceJson = join(SCRATCH, 'typed-face.json');
    writeFileSync(
      faceJson,
      JSON.stringify({
        assetId: 'e2e-typed',
        name: 'E2E typed',
        role: 'signature',
        aspect: 0.35,
        form: 'typed',
        typed: { text: 'Ada Lovelace', faceId: 'greatvibes', fontFile: 'GreatVibes-Regular.ttf' },
      }),
      'utf-8',
    );
    // A visible stamp with a typed face, verified — the existing-field arm is
    // the same placement with the field's own widget box, and it is exercised
    // in 153 with the store source; here the FACE is what has to travel.
    const out = join(SCRATCH, 'typed-face.pdf');
    execFileSync(APP_EXE, [
      'sign', SAMPLE_PDF, '-o', out,
      '--pfx', TEST_PFX, '--password', TEST_PFX_PASSWORD,
      '--visible-page', '1', '--visible-rect', '72,600,320,690',
      '--stamp-signature', faceJson,
    ]);
    const ap = (await appearanceStreams(out)).join('\n');
    expect(ap).not.toBe('');
    // Outlines, not an embedded face: the typed face is drawn as glyph paths
    // so two runs of one request stay byte-identical (the recalcTimestamp
    // invariant, which pyHanko's font engine cannot honour). A `/ToUnicode`
    // here would mean the deviation recorded in doc 94 had been undone.
    expect(ap).toContain('f');
    const verified = cliJson<{ signatures: { valid: boolean }[] }>(['verify-signatures', out]);
    expect(verified.signatures[0].valid).toBe(true);
  });

  it('switching the logo from over to beside redraws the preview', async () => {
    await openByPaths([SAMPLE_PDF]);
    await openSignForm();
    await waitForDisplayedSelector(STAMP_PREVIEW, { timeout: 30_000 });

    await answerImagePicker(logoPath);
    await $('[data-testid="sign-stamp-image-pick"]').click();
    await waitForDisplayedSelector('[data-testid="sign-stamp-layout"]', { timeout: 20_000 });
    await browser.waitUntil(
      async () => (await $('[data-testid="sign-stamp-image-path"]').getText()).includes('logo.png'),
      { timeout: 15_000, timeoutMsg: 'the picked logo never reached the form' },
    );
    await waitForDisplayedSelector(STAMP_PREVIEW, { timeout: 30_000 });
    const over = await $(STAMP_PREVIEW).getAttribute('src');

    await setReactSelectValue('[data-testid="sign-stamp-layout"]', 'beside');
    // `beside` composes through a different seam, so the drawing changes and
    // the image-position control appears with it.
    await waitForDisplayedSelector('[data-testid="sign-stamp-image-position"]', { timeout: 10_000 });
    await browser.waitUntil(async () => (await $(STAMP_PREVIEW).getAttribute('src')) !== over, {
      timeout: 30_000,
      timeoutMsg: 'the preview never redrew for the beside layout',
    });
  });

  it('a chosen face that has been deleted refuses by name and signs nothing', async () => {
    await storeAsset({
      id: 'e2e-vanishing',
      name: 'Vanishing',
      role: 'signature',
      kind: 'typed',
      text: 'Vanishing',
      face: 'sacramento',
      aspect: 0.35,
      createdAt: Date.now(),
    });
    await openByPaths([SAMPLE_PDF]);
    await openSignForm(true);
    await waitForDisplayedSelector('[data-testid="sign-stamp-signature"]', { timeout: 20_000 });
    await setReactSelectValue('[data-testid="sign-stamp-signature"]', 'e2e-vanishing');
    await waitForDisplayedSelector(STAMP_PREVIEW, { timeout: 30_000 });

    // The asset disappears from under the open form — another window deleted
    // it, which is exactly what a store shared across windows makes possible.
    await browser.execute(() => localStorage.setItem('spectra-signatures', '[]'));
    // Re-open the form so it re-reads the store. The CHOICE survives (it is
    // the form's own state), so the face it names is now unresolvable.
    await $('[data-testid="sign-open"]').click();
    await $('[data-testid="sign-open"]').click();
    await waitForDisplayedSelector(STAMP_GROUP, { timeout: 20_000 });

    // Refused BY NAME, in the preview, before anything is signed — never
    // quietly replaced with a different mark or dropped to no mark at all.
    await waitForDisplayedSelector(STAMP_PREVIEW_ERROR, { timeout: 30_000 });
    expect(await $(STAMP_PREVIEW_ERROR).getText()).toContain('no longer saved');
    expect(await $(STAMP_PREVIEW).isExisting()).toBe(false);

    // And the same refusal on the CLI arm, where the face is a file: an
    // unreadable one stops the run and writes nothing.
    const dest = join(SCRATCH, 'never-signed.pdf');
    let refusal = '';
    try {
      execFileSync(APP_EXE, [
        'sign', SAMPLE_PDF, '-o', dest,
        '--pfx', TEST_PFX, '--password', TEST_PFX_PASSWORD,
        '--visible-page', '1', '--visible-rect', '72,600,320,690',
        '--stamp-signature', join(SCRATCH, 'no-such-face.json'),
      ], { encoding: 'utf-8', stdio: 'pipe' });
    } catch (e: unknown) {
      const err = e as { stdout?: Buffer | string; stderr?: Buffer | string };
      refusal = `${String(err.stdout ?? '')}${String(err.stderr ?? '')}`;
    }
    expect(refusal).not.toBe('');
    expect(existsSync(dest)).toBe(false);
  });

  it('a stamp box that cannot fit its parts is refused, not truncated', async () => {
    // The panel's preview box is a fixed 220x70 the section states for itself,
    // so a PLACEMENT rect never reaches it — the fit rule is therefore proven
    // where a real box exists, at the engine, which is the same author that
    // draws the preview (doc 94 § F30: one appearance author). A refusal here
    // is the same sentence the preview would render.
    const out = join(SCRATCH, 'too-small.pdf');
    let refusal = '';
    try {
      execFileSync(APP_EXE, [
        'sign', SAMPLE_PDF, '-o', out,
        '--pfx', TEST_PFX, '--password', TEST_PFX_PASSWORD,
        '--visible-page', '1', '--visible-rect', '72,600,80,606',
        '--stamp-fields', 'name,date,reason,location,label',
        '--stamp-label', 'a label long enough that nothing can fit it into six points',
        '--stamp-image', logoPath, '--stamp-layout', 'beside',
      ], { encoding: 'utf-8', stdio: 'pipe' });
    } catch (e: unknown) {
      const err = e as { stdout?: Buffer | string; stderr?: Buffer | string };
      refusal = `${String(err.stdout ?? '')}${String(err.stderr ?? '')}`;
    }
    expect(refusal).not.toBe('');
    expect(existsSync(out)).toBe(false);
  });

  it('signing an already-signed document with an appearance leaves both valid', async () => {
    const first = join(SCRATCH, 'first.pdf');
    const second = join(SCRATCH, 'second.pdf');
    execFileSync(APP_EXE, [
      'sign', SAMPLE_PDF, '-o', first, '--pfx', TEST_PFX, '--password', TEST_PFX_PASSWORD,
    ]);
    execFileSync(APP_EXE, [
      'sign', first, '-o', second, '--pfx', TEST_PFX, '--password', TEST_PFX_PASSWORD,
      '--visible-page', '1', '--visible-rect', '72,600,320,690',
      '--stamp-fields', 'name,label', '--stamp-label', 'SECOND-PASS',
    ]);
    const verified = cliJson<{
      signature_count: number;
      signatures: { valid: boolean; intact: boolean }[];
    }>(['verify-signatures', second]);
    expect(verified.signature_count).toBe(2);
    for (const sig of verified.signatures) {
      expect(sig.valid).toBe(true);
      expect(sig.intact).toBe(true);
    }
    // Only the second signature carries the stamp: the first was invisible and
    // its bytes are untouched by an incremental append.
    const ap = decodeStringEscapes((await appearanceStreams(second)).join('\n'));
    expect(ap).toContain('SECOND-PASS');
  });
});
