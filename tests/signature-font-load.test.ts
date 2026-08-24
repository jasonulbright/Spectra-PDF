// Where the bundled signature faces are read FROM.
//
// The faces ship in the app's resource tree. The capability-scoped filesystem
// plugin (`file.readBuffer`) reaches only `$TEMP/spectrapdf/**` and refuses
// everything else, so a resource read must go through the arbitrary-path
// command instead — a scoped read here loads no face at all and every typed
// preview silently draws in the CSS fallback cursive.
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { readBuffer, readExternalBuffer, getEditFontPath } = vi.hoisted(() => ({
  readBuffer: vi.fn(async () => new Uint8Array([1, 2, 3])),
  readExternalBuffer: vi.fn(async (filePath: string) => new Uint8Array([filePath.length])),
  getEditFontPath: vi.fn(async () => 'C:\\Program Files\\SpectraPDF\\resources\\fonts'),
}));

vi.mock('../src/renderer/lib/tauri-bridge', () => ({
  app: { getEditFontPath },
  file: { readBuffer, readExternalBuffer },
}));

import { SIGNATURE_FACES, loadSignatureFontBytes } from '../src/renderer/lib/signature-fonts';

describe('signature face bytes', () => {
  beforeEach(() => {
    readBuffer.mockClear();
    readExternalBuffer.mockClear();
  });

  it('reads each face through the unscoped path, never the scoped plugin', async () => {
    for (const face of SIGNATURE_FACES) {
      await loadSignatureFontBytes(face.id);
    }
    expect(readBuffer).not.toHaveBeenCalled();
    expect(readExternalBuffer).toHaveBeenCalledTimes(SIGNATURE_FACES.length);
    for (const face of SIGNATURE_FACES) {
      expect(
        readExternalBuffer.mock.calls.some((c) => String(c[0]).endsWith(`\\${face.file}`)),
      ).toBe(true);
    }
  });

  it('rejects rather than substituting when a face cannot be read', async () => {
    // A fresh module: the loader caches bytes for the session.
    vi.resetModules();
    readExternalBuffer.mockImplementationOnce(async () => {
      throw new Error('forbidden path');
    });
    const fresh = await import('../src/renderer/lib/signature-fonts');
    await expect(fresh.loadSignatureFontBytes('parisienne')).rejects.toThrow();
  });
});
