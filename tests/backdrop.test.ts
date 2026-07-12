// Backdrop stamping (Phase 3b): only a positive "mica" report from the
// backend may enable the translucent shell CSS — unknown values, missing
// commands, and errors must all leave the solid look untouched.
import { describe, expect, it, vi } from 'vitest';

vi.mock('../src/renderer/lib/tauri-bridge', () => ({
  app: { getWindowBackdrop: vi.fn() },
}));

import { app } from '../src/renderer/lib/tauri-bridge';
import { backdropAttrFor, initBackdrop } from '../src/renderer/lib/backdrop';

const getWindowBackdrop = vi.mocked(app.getWindowBackdrop);

describe('backdropAttrFor', () => {
  it('maps only "mica" to the attribute value', () => {
    expect(backdropAttrFor('mica')).toBe('mica');
  });

  it('maps everything else to no attribute', () => {
    expect(backdropAttrFor('none')).toBeNull();
    expect(backdropAttrFor('acrylic')).toBeNull(); // unshipped kinds stay inert
    expect(backdropAttrFor('')).toBeNull();
    expect(backdropAttrFor(undefined)).toBeNull();
    expect(backdropAttrFor(null)).toBeNull();
    expect(backdropAttrFor(42)).toBeNull();
  });
});

describe('initBackdrop', () => {
  // These run without a DOM on purpose: the no-backdrop paths must resolve
  // without ever touching `document` (node throws if they do).
  it('resolves quietly when the backend reports none', async () => {
    getWindowBackdrop.mockResolvedValueOnce('none');
    await expect(initBackdrop()).resolves.toBeUndefined();
  });

  it('swallows a missing/failing command (old backend, harness)', async () => {
    getWindowBackdrop.mockRejectedValueOnce(new Error('unknown command'));
    await expect(initBackdrop()).resolves.toBeUndefined();
  });
});
