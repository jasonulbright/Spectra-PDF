import { resolve } from 'node:path';
import { expect } from '@wdio/globals';
import { waitForHarness, openByPaths, setView, invokeAppCommand } from '../support/harness.js';

const SAMPLE = resolve(__dirname, '..', 'fixtures', 'sample.pdf');

// Phase 10 slice B2 — the panel-fit AUDIT, automated: every operation panel
// must render inside the dock at its default width with NO horizontal
// overflow. This measures instead of eyeballing; a panel that outgrows the
// dock fails by name. (Audit width = the shipped default, 400px; the dock's
// CSS min-width rules cover the drag-to-minimum edge.)
//
// The op list mirrors commands/operations.ts OPERATIONS — specs can't import
// renderer modules, but drift self-checks: a renamed/removed op makes
// invokeAppCommand throw on the unknown tools.panel id, and a NEW op that's
// missing here shows up in the next audit sweep of this list.
const OPS = [
  'split', 'rotate', 'delete',
  'compress', 'grayscale', 'optimize', 'pdfa', 'pdf_version',
  'repair', 'rebuild', 'recover',
  'encrypt', 'decrypt',
  'extract_text', 'watermark', 'forms', 'compare', 'signatures',
  'document_js', 'convert_cmyk', 'headerfooter', 'pagebox', 'pagelabels',
  'attachments', 'portfolio', 'layers', 'accessibility',
  'comments', 'preflight', 'links', 'tags', 'readingorder', 'actions',
];

describe('dock panel fit (Phase 10 B2)', () => {
  before(async () => {
    await waitForHarness();
    await openByPaths([SAMPLE]);
    await setView('canvas');
    await invokeAppCommand('view.documentView');
    await $('[data-testid="document-view"]').waitForDisplayed({ timeout: 15_000 });
  });

  it('the measurement sees real geometry (anti-vacuity guard)', async () => {
    // If the dock body ever measured 0×0 (hidden, unmounted), sw > cw + 1
    // could never trip and the whole audit would pass vacuously. Prove the
    // probe reads real, plausible pixels off a known-dense panel first.
    expect(await invokeAppCommand('tools.panel.compare')).toBe(true);
    await $('[data-testid="tool-dock"]').waitForDisplayed({ timeout: 10_000 });
    await browser.pause(150);
    const m = await browser.execute(() => {
      const body = document.querySelector('[data-testid="tool-dock"] .tool-dock-body');
      return body ? { sw: body.scrollWidth, cw: body.clientWidth } : null;
    });
    expect(m).not.toBeNull();
    expect(m!.cw).toBeGreaterThan(300); // default width 400 minus padding
    expect(m!.sw).toBeGreaterThan(200); // real content laid out
  });

  it('every operation panel renders in the dock without horizontal overflow', async () => {
    const failures: string[] = [];
    for (const op of OPS) {
      expect(await invokeAppCommand(`tools.panel.${op}`)).toBe(true);
      await $('[data-testid="tool-dock"]').waitForDisplayed({ timeout: 10_000 });
      // Let the panel settle (async engine reads render empty/loaded states).
      await browser.pause(150);
      const m = await browser.execute(() => {
        const body = document.querySelector('[data-testid="tool-dock"] .tool-dock-body');
        if (!body) return null;
        return { sw: body.scrollWidth, cw: body.clientWidth };
      });
      if (!m) {
        failures.push(`${op}: dock body missing`);
        continue;
      }
      if (m.sw > m.cw + 1) {
        failures.push(`${op}: overflows the dock (${m.sw}px content in ${m.cw}px)`);
      }
    }
    expect(failures).toEqual([]);
  });
});
