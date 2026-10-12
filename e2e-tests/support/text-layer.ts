/**
 * Waits until `count` text layers are built at the size their page cells are
 * drawn at. A layer built while the reading view was still settling its zoom
 * is rebuilt for the new size, and that rebuild clears the selection, as a zoom
 * does; a selection made before it would not survive to be tested.
 */
export async function waitForSettledLayers(count: number, pageHeightPt: number): Promise<void> {
  await browser.waitUntil(async () => browser.execute((n: number, heightPt: number) => {
    const layers = Array.from(document.querySelectorAll('[data-testid="text-layer"]')) as HTMLElement[];
    return layers.length >= n && layers.slice(0, n).every((layer) => {
      const scale = parseFloat(layer.style.getPropertyValue('--scale-factor'));
      const cell = layer.parentElement?.getBoundingClientRect().height ?? 0;
      return Number(layer.getAttribute('data-text-build') ?? 0) > 0 && Math.abs(scale * heightPt - cell) < 2;
    });
  }, count, pageHeightPt), { timeout: 20_000, timeoutMsg: `${count} text layer(s) never settled at their drawn size` });
}
