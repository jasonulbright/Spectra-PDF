// Issue #43: a file the user asked to open shows as a tab at once, with a
// loading pane, and leaves the strip the moment its open reaches a verdict.
// Closing the placeholder is a cancel the open funnel honours.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createPendingOpens } from '../src/renderer/lib/pending-opens';

describe('pending opens', () => {
  it('one placeholder per path, in request order', () => {
    const p = createPendingOpens();
    const a = p.begin('C:\\a.pdf', 'a.pdf');
    const b = p.begin('C:\\b.pdf', 'b.pdf');
    expect(a).not.toBeNull();
    expect(p.begin('C:\\a.pdf', 'a.pdf'), 'a second open of the path owns no placeholder').toBeNull();
    expect(p.snapshot().items.map((i) => i.name)).toEqual(['a.pdf', 'b.pdf']);
    p.settle(b);
    expect(p.snapshot().items.map((i) => i.name)).toEqual(['a.pdf']);
  });

  it('a settle by a stale handle leaves a newer placeholder alone', () => {
    const p = createPendingOpens();
    const first = p.begin('x.pdf', 'x.pdf');
    p.cancel('x.pdf');
    const second = p.begin('x.pdf', 'x.pdf');
    p.settle(first);
    expect(p.snapshot().items).toHaveLength(1);
    p.settle(second);
    expect(p.snapshot().items).toHaveLength(0);
  });

  it('cancel marks the handle and removes the tab; focus follows removal', () => {
    const p = createPendingOpens();
    const h = p.begin('x.pdf', 'x.pdf')!;
    p.focus('x.pdf');
    expect(p.snapshot().focused).toBe('x.pdf');
    p.cancel('x.pdf');
    expect(h.cancelled).toBe(true);
    expect(p.snapshot()).toEqual({ items: [], focused: null });
  });

  it('settlePath removes whichever open owns the placeholder', () => {
    const p = createPendingOpens();
    const h = p.begin('x.pdf', 'x.pdf')!;
    p.settlePath('x.pdf');
    expect(h.cancelled).toBe(false);
    expect(p.snapshot().items).toHaveLength(0);
  });

  it('focus on an unknown path is no focus; snapshots are stable between changes', () => {
    const p = createPendingOpens();
    p.focus('nope.pdf');
    expect(p.snapshot().focused).toBeNull();
    const s1 = p.snapshot();
    expect(p.snapshot()).toBe(s1);
    let calls = 0;
    const stop = p.subscribe(() => { calls += 1; });
    p.begin('x.pdf', 'x.pdf');
    stop();
    p.settlePath('x.pdf');
    expect(calls).toBe(1);
  });

  it('the open funnel honours a cancel before reading and before landing OPEN_FILE', () => {
    const app = readFileSync(resolve(__dirname, '../src/renderer/App.tsx'), 'utf8');
    expect(app).toContain('if (placeholder?.cancelled) return false;');
    expect(app).toMatch(/if \(placeholder\?\.cancelled\) \{\s*\/\/[^]*?discardDocumentWorkingCopy\(filePath, prepared\.workingPath/);
    expect(app).toContain('for (const handle of placeholders.values()) pendingOpens.settle(handle);');
  });
});
