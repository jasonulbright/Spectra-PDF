// Rung 3 — measure scale calibration: drag a known length, state its value,
// and future measurements follow; right-click an existing measurement to
// override its recorded value (exact note rewrite, undoable).
import { copyFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import {
  waitForHarness,
  openByPaths,
  setView,
  invokeAppCommand,
  getPageAnnotations,
  getFirstAnnotation,
  closeAllFiles,
} from '../support/harness.js';

const FIXTURE = resolve(__dirname, '..', 'fixtures', 'sample.pdf');

async function pageRect(): Promise<{ x: number; y: number; w: number; h: number }> {
  return (await browser.execute(function () {
    const el = document.querySelector('[data-page-id]');
    if (!el) return null as any;
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  })) as { x: number; y: number; w: number; h: number };
}

async function dragOnPage(
  pr: { x: number; y: number; w: number; h: number },
  from: [number, number],
  to: [number, number],
): Promise<void> {
  await browser
    .action('pointer', { parameters: { pointerType: 'mouse' } })
    .move({ x: Math.round(pr.x + pr.w * from[0]), y: Math.round(pr.y + pr.h * from[1]) })
    .down()
    .pause(60)
    .move({ x: Math.round(pr.x + pr.w * to[0]), y: Math.round(pr.y + pr.h * to[1]) })
    .pause(60)
    .up()
    .perform();
}

describe('measure scale calibration', () => {
  let pr: { x: number; y: number; w: number; h: number };

  before(async () => {
    await waitForHarness();
    const tmp = mkdtempSync(resolve(tmpdir(), 'measure-cal-'));
    const src = resolve(tmp, 'cal.pdf');
    copyFileSync(FIXTURE, src);
    await closeAllFiles();
    await openByPaths([src]);
    await setView('canvas');
    await browser.waitUntil(async () => (await pageRect()) !== null, {
      timeout: 15_000,
      timeoutMsg: 'no page cell appeared',
    });
    pr = await pageRect();
  });

  it('calibrates the scale from a dragged known length', async () => {
    await invokeAppCommand('tools.measurecal');
    await dragOnPage(pr, [0.2, 0.3], [0.6, 0.3]);
    const row = await browser.$('[data-testid="calibration-row"]');
    await row.waitForDisplayed({ timeout: 5_000 });
    await browser.$('[data-testid="calibration-value"]').setValue('10');
    await browser.$('[data-testid="calibration-unit"]').selectByAttribute('value', 'ft');
    await browser.$('[data-testid="calibration-apply"]').click();
    await browser.waitUntil(
      async () => !(await browser.$('[data-testid="calibration-row"]').isExisting()),
      { timeout: 5_000, timeoutMsg: 'the calibration row never closed' },
    );
    // The SAME span measured under the new scale must read ~10 ft.
    await invokeAppCommand('tools.measuredist');
    await dragOnPage(pr, [0.2, 0.3], [0.6, 0.3]);
    const first = await getFirstAnnotation();
    expect(first).not.toBeNull();
    const meas = (await getPageAnnotations(first!.docId, first!.pageId)).find((a) => a.kind === 'measure')!;
    const value = parseFloat(meas.note ?? '0');
    expect(Math.abs(value - 10)).toBeLessThan(0.4); // pointer rounding tolerance
    expect(meas.note).toContain('ft');
  });

  it('right-click override rewrites the recorded value exactly', async () => {
    // Back to Select, right-click the measurement's body.
    await invokeAppCommand('tools.close');
    const first = (await getFirstAnnotation())!;
    const meas = (await getPageAnnotations(first.docId, first.pageId)).find((a) => a.kind === 'measure')!;
    const body = (await browser.execute(function (id: string) {
      const el = Array.from(document.querySelectorAll('[data-annot-id]')).find(
        (e) => e.getAttribute('data-annot-id') === id,
      );
      if (!el) return null as any;
      const b = el.getBoundingClientRect();
      return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
    }, meas.id)) as { x: number; y: number };
    await browser
      .action('pointer', { parameters: { pointerType: 'mouse' } })
      .move({ x: Math.round(body.x), y: Math.round(body.y) })
      .down({ button: 2 })
      .up({ button: 2 })
      .perform();
    const pop = await browser.$('[data-testid="recal-popover"]');
    await pop.waitForDisplayed({ timeout: 5_000 });
    await browser.$('[data-testid="recal-value"]').setValue('100');
    await browser.$('[data-testid="recal-unit"]').selectByAttribute('value', 'm');
    await browser.$('[data-testid="recal-override"]').click();
    await browser.waitUntil(
      async () =>
        (await getPageAnnotations(first.docId, first.pageId)).find((a) => a.id === meas.id)?.note === '100 m',
      { timeout: 5_000, timeoutMsg: 'the override never rewrote the note' },
    );
  });
});
