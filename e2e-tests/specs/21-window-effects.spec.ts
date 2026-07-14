import { resolve } from 'node:path';
import { expect } from '@wdio/globals';
import { waitForHarness, openByPaths, setView, getState } from '../support/harness.js';

// Phase 3b: the backend reports which backdrop it actually applied
// ("mica" on Win11, "none" elsewhere/on failure); the renderer stamps
// <html data-backdrop> to match and keys the translucent shell CSS on it.
// The assertions branch on the report, so the spec is honest on any
// Windows build — on the Win11 dev box the mica branch is the live one.

const SAMPLE_PDF = resolve(__dirname, '..', 'fixtures', 'sample.pdf');

/** Invoke a backend command through Tauri's runtime global. */
async function invokeCommand<T>(cmd: string): Promise<T> {
  const result = await browser.executeAsync<{ ok: T } | { err: string }, [string]>(
    function (c, done) {
      (window as any).__TAURI_INTERNALS__
        .invoke(c)
        .then((v: T) => done({ ok: v }))
        .catch((e: unknown) => done({ err: String(e) }));
    },
    cmd,
  );
  if ('err' in result) throw new Error(`${cmd} failed: ${result.err}`);
  return result.ok;
}

/** Alpha channel of a computed CSS color. */
function alphaOf(color: string): number {
  const m = /^rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(color);
  if (!m) throw new Error(`unparsable color: ${color}`);
  return m[1] === undefined ? 1 : Number(m[1]);
}

describe('window effects + accent theming', () => {
  it('reports a backdrop and stamps <html> to match', async () => {
    await waitForHarness();
    const kind = await invokeCommand<string>('get_window_backdrop');
    expect(['mica', 'none']).toContain(kind);

    const attr = await browser.execute(() =>
      document.documentElement.getAttribute('data-backdrop'),
    );
    if (kind === 'mica') {
      expect(attr).toBe('mica');
    } else {
      expect(attr).toBeNull();
    }
  });

  it('renders the shell per the backdrop: translucent frame, opaque content', async () => {
    const kind = await invokeCommand<string>('get_window_backdrop');
    // Computed styles, not class lists — this is what actually composes. The
    // Phase 4 M2 frame is three bars (menu bar, main toolbar, tab strip), all
    // carrying .app-shell-bar; every one must tint under Mica (spec-21
    // extension per § 10.3 — the re-key done by class reuse).
    const styles = await browser.execute(() => {
      const bg = (sel: string) => {
        const el = document.querySelector(sel);
        return el ? getComputedStyle(el).backgroundColor : null;
      };
      return {
        shell: bg('.app-shell'),
        menubar: bg('[data-testid="menubar"]'),
        toolbar: bg('[data-testid="main-toolbar"]'),
        tabstrip: bg('[data-testid="tab-strip"]'),
        content: bg('.app-content'),
      };
    });
    expect(styles.shell).not.toBeNull();
    expect(styles.menubar).not.toBeNull();
    expect(styles.toolbar).not.toBeNull();
    expect(styles.tabstrip).not.toBeNull();
    expect(styles.content).not.toBeNull();

    if (kind === 'mica') {
      // Shell lets the material through; every frame bar carries a translucent
      // tint; content is exactly as opaque as the old shell background.
      expect(alphaOf(styles.shell!)).toBe(0);
      for (const bar of [styles.menubar!, styles.toolbar!, styles.tabstrip!]) {
        const a = alphaOf(bar);
        expect(a).toBeGreaterThan(0);
        expect(a).toBeLessThan(1);
      }
      expect(alphaOf(styles.content!)).toBe(1);
    } else {
      // Solid look: the shell paints opaque, exactly as before 3b.
      expect(alphaOf(styles.shell!)).toBe(1);
    }
  });

  it('applies the Windows accent under the default System theme', async () => {
    // Fresh profile → theme defaults to System; the accent source
    // (UISettings, registry fallback) reports a color on any Windows box,
    // so the variables must populate shortly after boot.
    await browser.waitUntil(
      async () =>
        Boolean(
          await browser.execute(() =>
            document.documentElement.style.getPropertyValue('--accent').trim(),
          ),
        ),
      { timeoutMsg: '--accent never appeared on :root under the System theme' },
    );
    const accent = await browser.execute(() =>
      document.documentElement.style.getPropertyValue('--accent').trim(),
    );
    expect(accent).toMatch(/^#[0-9A-F]{6}$/i);

    const fg = await browser.execute(() =>
      document.documentElement.style.getPropertyValue('--accent-fg').trim(),
    );
    expect(['#ffffff', '#1a1a1a']).toContain(fg);
  });

  it('routes the accent into the canvas selection color', async () => {
    await openByPaths([SAMPLE_PDF]);
    await setView('canvas');
    await browser.waitUntil(async () => (await getState()).view === 'canvas', {
      timeoutMsg: 'view did not switch to canvas',
    });
    await browser.waitUntil(
      async () => Boolean(await browser.execute(() => document.querySelector('.canvas-view'))),
      { timeoutMsg: 'canvas view never mounted' },
    );

    const pair = await browser.execute(() => {
      const cv = document.querySelector('.canvas-view');
      return {
        select: cv ? getComputedStyle(cv).getPropertyValue('--select').trim() : null,
        accent: document.documentElement.style.getPropertyValue('--accent').trim(),
      };
    });
    expect(pair.select).not.toBeNull();
    expect(pair.select!.toLowerCase()).toBe(pair.accent.toLowerCase());
  });
});
