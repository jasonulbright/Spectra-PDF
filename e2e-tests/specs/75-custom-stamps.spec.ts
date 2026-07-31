import { execFileSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { expect } from '@wdio/globals';
import {
  waitForHarness,
  openByPaths,
  getState,
  invokeAppCommand,
  setReactInputValue,
} from '../support/harness.js';

// § parity-map 2 — custom stamp authoring: author a dynamic TEXT stamp
// through the real library UI, place it (tokens resolve at placement), put a
// custom IMAGE stamp through the REAL commit + save and verify the /Stamp
// with the CLI, then delete from the library. Library state and armed modes
// are cleared at the end (the cross-spec-leak rule).

const SAMPLE_PDF = resolve(__dirname, '..', 'fixtures', 'sample.pdf');
const APP_EXE = resolve(__dirname, '..', '..', 'src-tauri', 'target', 'debug', 'spectrapdf.exe');
const PNG_1X1 =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

let SCRATCH = '';

async function customStampsInStore(): Promise<unknown[]> {
  return await browser.execute(() => {
    try {
      return JSON.parse(localStorage.getItem('custom-stamps') ?? '[]');
    } catch {
      return [];
    }
  });
}

describe('custom stamp authoring (parity map § 2)', () => {
  before(async () => {
    SCRATCH = mkdtempSync(resolve(tmpdir(), 'spectra-e2e-stamps-'));
    await waitForHarness();
    await browser.execute(() => localStorage.removeItem('custom-stamps'));
    await openByPaths([SAMPLE_PDF]);
    await browser.waitUntil(async () => (await getState()).view === 'canvas', {
      timeoutMsg: 'opening sample.pdf did not land on canvas',
    });
    await invokeAppCommand('view.documentView');
    await $('[data-testid="document-view"]').waitForDisplayed({ timeout: 15_000 });
  });

  after(async () => {
    await browser.execute(() => localStorage.removeItem('custom-stamps'));
    await invokeAppCommand('tools.select');
    await invokeAppCommand('tools.close');
  });

  it('authors a dynamic text stamp through the library UI', async () => {
    expect(await invokeAppCommand('tools.stamp')).toBe(true);
    await $('[data-testid="secondary-toolbar"]').waitForDisplayed({ timeout: 10_000 });

    await $('[data-testid="stamp-new-text"]').click();
    await $('[data-testid="stamp-new-label"]').waitForDisplayed();
    await setReactInputValue('[data-testid="stamp-new-label"]', 'SIGNED {date}');
    await $('[data-testid="stamp-new-color-e0393e"]').click();
    await $('[data-testid="stamp-new-add"]').click();

    // The pill appears and the library persisted.
    await browser.waitUntil(
      async () => (await $$('[data-testid^="stamp-custom-"]')).length > 0,
      { timeoutMsg: 'the custom stamp pill never appeared' },
    );
    const stored = await customStampsInStore();
    expect(stored.length).toBe(1);
    expect((stored[0] as { label: string }).label).toBe('SIGNED {date}');
  });

  it('placing it resolves the {date} token at placement time', async () => {
    // Select the custom pill (the only stamp-custom-* button, not the ×).
    const pills = await $$('[data-testid^="stamp-custom-"]');
    let pill: WebdriverIO.Element | null = null;
    for (const p of await pills) {
      const tid = await p.getAttribute('data-testid');
      if (!tid.includes('-del-')) pill = p;
    }
    expect(pill).not.toBeNull();
    await pill!.click();

    // Click the visible page.
    const rect = (await browser.execute(() => {
      const el = document.querySelector('[data-testid="document-view"] [data-page-id]');
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return { left: b.left, top: b.top, width: b.width, height: b.height };
    })) as { left: number; top: number; width: number; height: number } | null;
    expect(rect).not.toBeNull();
    await browser
      .action('pointer', { parameters: { pointerType: 'mouse' } })
      .move({ x: Math.round(rect!.left + rect!.width * 0.5), y: Math.round(rect!.top + rect!.height * 0.3) })
      .down()
      .pause(40)
      .up()
      .perform();

    const a = (await browser.executeAsync(function (done) {
      (window as any).__SPECTRA_TEST__
        .getFirstAnnotation(8000)
        .then((x: unknown) => done(x))
        .catch(() => done(null));
    })) as { kind: string; note?: string; annotationId: string; docId: string; pageId: string } | null;
    expect(a).not.toBeNull();
    expect(a!.kind).toBe('stamp');
    expect(a!.note).toMatch(/^SIGNED \d/);
    expect(a!.note).not.toContain('{date}');

    // Clear it so the image leg's first-annotation read sees ITS stamp.
    await browser.execute(
      function (docId: string, pageId: string, annotationId: string) {
        (window as any).__SPECTRA_TEST__.removeAnnotation(docId, pageId, annotationId);
      },
      a!.docId,
      a!.pageId,
      a!.annotationId,
    );
  });

  it('an image stamp survives the REAL commit and save as a /Stamp', async () => {
    const added = (await browser.executeAsync(
      function (img: string, done: (r: unknown) => void) {
        (window as any).__SPECTRA_TEST__
          .addAnnotation({
            kind: 'stamp',
            x: 0.2,
            y: 0.2,
            w: 0.3,
            h: 0.2,
            color: '#2f6fed',
            note: 'Logo',
            imageData: img,
          })
          .then((r: unknown) => done(r))
          .catch((e: unknown) => done(String(e)));
      },
      PNG_1X1,
    )) as { annotationId?: string } | string;
    expect(typeof added).not.toBe('string');

    const first = (await browser.executeAsync(function (done) {
      (window as any).__SPECTRA_TEST__
        .getFirstAnnotation(8000)
        .then((x: unknown) => done(x))
        .catch(() => done(null));
    })) as { hasImage?: boolean } | null;
    expect(first?.hasImage).toBe(true);

    // Through the REAL commit bridge + save, then the REAL CLI reads it back.
    await browser.executeAsync(function (done) {
      (window as any).__SPECTRA_TEST__.commitPendingEdits().then(() => done(null));
    });
    const dest = resolve(SCRATCH, 'stamped.pdf');
    await browser.executeAsync(
      function (d: string, done: (r: string | null) => void) {
        (window as any).__SPECTRA_TEST__
          .saveActiveAs(d)
          .then(() => done(null))
          .catch((e: unknown) => done(String(e)));
      },
      dest,
    );
    const out = execFileSync(APP_EXE, ['comments-list', dest], { encoding: 'utf-8' });
    const listed = JSON.parse(out) as { annotations?: { subtype: string }[] };
    expect((listed.annotations ?? []).some((x) => x.subtype === 'Stamp')).toBe(true);
  });

  it('deleting the custom stamp empties the library', async () => {
    const dels = await $$('[data-testid^="stamp-custom-del-"]');
    expect((await dels).length).toBe(1);
    // The × reveals on hover (opacity) — click it directly via the DOM.
    await browser.execute(() => {
      const el = document.querySelector('[data-testid^="stamp-custom-del-"]') as HTMLElement | null;
      el?.click();
    });
    await browser.waitUntil(
      async () => (await customStampsInStore()).length === 0,
      { timeoutMsg: 'delete did not empty the library' },
    );
  });
});
