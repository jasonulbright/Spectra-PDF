import { resolve } from 'node:path';
import { expect } from '@wdio/globals';
import {
  waitForHarness,
  openByPaths,
  setView,
  addAnnotation,
  getFirstAnnotation,
  invokeAppCommand,
} from '../support/harness.js';

const SAMPLE = resolve(__dirname, '..', 'fixtures', 'sample.pdf');

// The Properties Bar toggles through view.propertiesBar,
// it shows the click-selected annotation's properties with quick recolor +
// delete. Selection is Select-tool click on the annotation body — new
// interaction surface, so the spec drives the REAL click path, not a harness
// shortcut.
describe('properties bar (I.6)', () => {
  before(async () => {
    await waitForHarness();
    await openByPaths([SAMPLE]);
    await setView('canvas');
  });

  it('toggles on, shows the empty hint, and follows a click-selection', async () => {
    expect(await invokeAppCommand('view.propertiesBar')).toBe(true);
    await $('[data-testid="properties-bar"]').waitForDisplayed({ timeout: 10_000 });
    expect(await $('[data-testid="pbar-empty"]').isDisplayed()).toBe(true);

    const { annotationId } = await addAnnotation({
      kind: 'highlight',
      x: 0.1,
      y: 0.15,
      w: 0.3,
      h: 0.1,
      color: '#ffd54a',
      note: 'pbar target',
    });

    const annot = $(`[data-annot-id="${annotationId}"]`);
    await annot.waitForDisplayed({ timeout: 10_000 });
    await annot.click();

    const kind = $('[data-testid="pbar-kind"]');
    await kind.waitForDisplayed({ timeout: 10_000 });
    // getText returns the RENDERED text — the kind label is CSS-uppercased.
    expect((await kind.getText()).toLowerCase()).toContain('highlight');
    expect(await $('[data-testid="pbar-place"]').getText()).toContain('p.1');
    expect(await $('[data-testid="pbar-note"]').getText()).toContain('pbar target');
    // The selected ring marks the annotation on the page.
    expect(await annot.getAttribute('class')).toContain('page-annot-selected');
  });

  it('recolors through the bar and Escape clears the selection', async () => {
    await $('[data-testid="pbar-color-2fbf71"]').click();
    await browser.waitUntil(
      async () => (await getFirstAnnotation())?.color === '#2fbf71',
      { timeout: 10_000, timeoutMsg: 'bar recolor never landed in state' },
    );

    await browser.keys(['Escape']);
    await $('[data-testid="pbar-empty"]').waitForDisplayed({ timeout: 10_000 });
  });

  it('deletes through the bar and the toggle hides it', async () => {
    const found = await getFirstAnnotation();
    expect(found).not.toBeNull();
    const annot = $(`[data-annot-id="${found!.annotationId}"]`);
    await annot.click();
    await $('[data-testid="pbar-delete"]').waitForDisplayed({ timeout: 10_000 });
    await $('[data-testid="pbar-delete"]').click();
    await browser.waitUntil(async () => (await getFirstAnnotation(2_000)) === null, {
      timeout: 10_000,
      timeoutMsg: 'bar delete never removed the annotation',
    });
    // The dead selection resolves to nothing and the bar says so.
    expect(await $('[data-testid="pbar-empty"]').isDisplayed()).toBe(true);

    expect(await invokeAppCommand('view.propertiesBar')).toBe(true);
    await browser.waitUntil(
      async () => !(await $('[data-testid="properties-bar"]').isExisting()),
      { timeout: 10_000, timeoutMsg: 'toggle never hid the properties bar' },
    );
  });
});
