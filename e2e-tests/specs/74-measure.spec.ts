import { resolve } from 'node:path';
import { expect } from '@wdio/globals';
import {
  waitForHarness,
  openByPaths,
  getState,
  invokeAppCommand,
} from '../support/harness.js';

// § parity-map 2 — the Measure tool: distance drag, area click-ring, the
// scale ratio applied through the REAL toolbar controls, and the left-behind
// ink markup whose note carries the value. Trusted pointer input via the W3C
// actions API (the spec-23 mechanism); geometry against the visible page
// cell's rect.

const SAMPLE_PDF = resolve(__dirname, '..', 'fixtures', 'sample.pdf');

interface CellRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

async function firstCellRect(): Promise<CellRect> {
  const r = (await browser.execute(() => {
    const el = document.querySelector('[data-testid="document-view"] [data-page-id]');
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return { left: b.left, top: b.top, width: b.width, height: b.height };
  })) as CellRect | null;
  expect(r).not.toBeNull();
  return r!;
}

async function firstAnnotation(): Promise<{ kind: string; note?: string } | null> {
  return await browser.executeAsync(function (done) {
    (window as any).__SPECTRA_TEST__
      .getFirstAnnotation(8000)
      .then((a: unknown) => done(a))
      .catch(() => done(null));
  });
}

async function dragMeasure(rect: CellRect, x0: number, y0: number, x1: number, y1: number): Promise<void> {
  await browser
    .action('pointer', { parameters: { pointerType: 'mouse' } })
    .move({ x: Math.round(rect.left + rect.width * x0), y: Math.round(rect.top + rect.height * y0) })
    .down()
    .pause(60)
    .move({ x: Math.round(rect.left + rect.width * (x0 + (x1 - x0) / 2)), y: Math.round(rect.top + rect.height * (y0 + (y1 - y0) / 2)) })
    .pause(40)
    .move({ x: Math.round(rect.left + rect.width * x1), y: Math.round(rect.top + rect.height * y1) })
    .pause(60)
    .up()
    .perform();
}

const valueOf = (text: string): number => parseFloat(text);

describe('measure tool (parity map § 2)', () => {
  before(async () => {
    await waitForHarness();
    await openByPaths([SAMPLE_PDF]);
    await browser.waitUntil(async () => (await getState()).view === 'canvas', {
      timeoutMsg: 'opening sample.pdf did not land on canvas',
    });
    await invokeAppCommand('view.documentView');
    await $('[data-testid="document-view"]').waitForDisplayed({ timeout: 15_000 });
  });

  after(async () => {
    // Disarm + close the tool so no measure mode leaks into the next spec.
    await invokeAppCommand('tools.select');
    await invokeAppCommand('tools.close');
  });

  it('opening the Measure tool arms Distance and shows the scale controls', async () => {
    expect(await invokeAppCommand('tools.open.measure')).toBe(true);
    await browser.waitUntil(async () => (await getState()).tool === 'measuredist', {
      timeoutMsg: 'opening Measure did not arm the distance mode',
    });
    await $('[data-testid="secondary-toolbar"]').waitForDisplayed({ timeout: 10_000 });
    await expect($('[data-testid="tool-measuredist"]')).toBeDisplayed();
    await expect($('[data-testid="tool-measureperim"]')).toBeDisplayed();
    await expect($('[data-testid="tool-measurearea"]')).toBeDisplayed();
    await expect($('[data-testid="measure-scale-from"]')).toBeDisplayed();
    await expect($('[data-testid="measure-leave-markup"]')).toBeSelected();
  });

  it('a distance drag reports inches and leaves an ink markup carrying the value', async () => {
    const rect = await firstCellRect();
    await dragMeasure(rect, 0.2, 0.4, 0.7, 0.4);

    await $('[data-testid="measure-result"]').waitForDisplayed({
      timeout: 10_000,
      timeoutMsg: 'no measurement value reported',
    });
    const text = await $('[data-testid="measure-result"]').getText();
    expect(text).toMatch(/^\d+(\.\d+)? in$/);
    expect(valueOf(text)).toBeGreaterThan(0);

    const a = await firstAnnotation();
    expect(a).not.toBeNull();
    expect(a!.kind).toBe('ink');
    expect(a!.note).toBe(text);
  });

  it('the scale ratio scales the SAME drag: 1 in = 2 ft doubles into feet', async () => {
    const before = valueOf(await $('[data-testid="measure-result"]').getText());

    // Set "1 in = 2 ft" through the real controls.
    const toInput = await $('[data-testid="measure-scale-to"]');
    await toInput.click();
    await browser.keys(['Control', 'a']);
    await browser.keys(['2']);
    await $('[data-testid="measure-scale-to-unit"]').selectByAttribute('value', 'ft');

    const rect = await firstCellRect();
    await dragMeasure(rect, 0.2, 0.6, 0.7, 0.6); // same span, different row
    await browser.waitUntil(
      async () => /ft$/.test(await $('[data-testid="measure-result"]').getText()),
      { timeout: 10_000, timeoutMsg: 'scale change did not reach the readout' },
    );
    const scaled = valueOf(await $('[data-testid="measure-result"]').getText());
    expect(scaled).toBeCloseTo(before * 2, 1);
  });

  it('an area click-ring double-click reports sq units and perimeter', async () => {
    expect(await invokeAppCommand('tools.measurearea')).toBe(true);
    await browser.waitUntil(async () => (await getState()).tool === 'measurearea', {
      timeoutMsg: 'the Area pill did not arm',
    });
    const rect = await firstCellRect();
    const px = (x: number): number => Math.round(rect.left + rect.width * x);
    const py = (y: number): number => Math.round(rect.top + rect.height * y);

    // Three corners; the double-click on the last vertex finishes the ring.
    await browser
      .action('pointer', { parameters: { pointerType: 'mouse' } })
      .move({ x: px(0.25), y: py(0.2) })
      .down().pause(40).up()
      .pause(120)
      .move({ x: px(0.55), y: py(0.2) })
      .down().pause(40).up()
      .pause(120)
      .move({ x: px(0.55), y: py(0.35) })
      .down().pause(40).up()
      .pause(60)
      .down().pause(40).up()
      .perform();

    await browser.waitUntil(
      async () => /sq ft/.test(await $('[data-testid="measure-result"]').getText()),
      { timeout: 10_000, timeoutMsg: 'the area ring never reported' },
    );
    const text = await $('[data-testid="measure-result"]').getText();
    expect(text).toMatch(/^\d+(\.\d+)? sq ft · perimeter \d+(\.\d+)? ft$/);
  });
});
