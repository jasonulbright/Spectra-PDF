// The stamp-appearance options as the sign surfaces use them: what request
// they build, when they build none at all, and that the preview is the
// ENGINE's drawing rather than a second implementation of it.
import { describe, it, expect, vi } from 'vitest';
import {
  DEFAULT_STAMP_APPEARANCE,
  STAMP_FACE_MISSING,
  STAMP_FACE_UNREADABLE,
  decodePreviewPdf,
  faceParams,
  isDefaultStampAppearance,
  previewParams,
  resolveStampFace,
  stampStyleParams,
  type StampAppearanceOptions,
} from '../src/renderer/lib/stamp-appearance';
import type { SignatureAsset } from '../src/renderer/lib/signature-assets';

const FONT_DIR = 'C:\\app\\resources\\fonts';

function options(overrides: Partial<StampAppearanceOptions> = {}): StampAppearanceOptions {
  return { ...DEFAULT_STAMP_APPEARANCE, ...overrides };
}

const inkAsset: SignatureAsset = {
  id: 'ink-1',
  name: 'My signature',
  role: 'signature',
  aspect: 0.4,
  createdAt: 1,
  kind: 'ink',
  strokes: [[0, 0, 0.5, 1, 1, 0]],
};

const typedAsset: SignatureAsset = {
  id: 'typed-1',
  name: 'Typed',
  role: 'signature',
  aspect: 0.3,
  createdAt: 2,
  kind: 'typed',
  text: 'Jane Doe',
  face: 'greatvibes',
};

const brokenImageAsset: SignatureAsset = {
  id: 'img-1',
  name: 'Imported',
  role: 'signature',
  aspect: 0.5,
  createdAt: 3,
  kind: 'image',
  // Passes the store's validation (a data:image/ URL) but will not decode —
  // the one case a face resolution must refuse rather than substitute.
  imageData: 'data:image/png,not-base64-at-all',
};

describe('the default appearance', () => {
  it('sends no appearance at all, so an unconfigured signature is unchanged', () => {
    expect(isDefaultStampAppearance(DEFAULT_STAMP_APPEARANCE)).toBe(true);
    expect(stampStyleParams(DEFAULT_STAMP_APPEARANCE, null, FONT_DIR)).toEqual({});
  });

  it('stops being the default as soon as anything is configured', () => {
    expect(isDefaultStampAppearance(options({ label: 'Approved' }))).toBe(true);
    // A label with no line to render it on is not a configuration; ticking
    // the line is.
    expect(isDefaultStampAppearance(options({ fields: ['name'] }))).toBe(false);
    expect(isDefaultStampAppearance(options({ imagePath: 'logo.png' }))).toBe(false);
    expect(isDefaultStampAppearance(options({ signatureAssetId: 'ink-1' }))).toBe(false);
    expect(isDefaultStampAppearance(options({ fontSize: 14 }))).toBe(false);
  });

  it('sends an appearance when a face is chosen even with default lines', () => {
    const face = resolveStampFace('ink-1', [inkAsset]);
    const params = stampStyleParams(DEFAULT_STAMP_APPEARANCE, face, FONT_DIR);
    expect(params.stamp_style).toBeDefined();
    expect(params.font_dir).toBe(FONT_DIR);
  });
});

describe('the request the surfaces build', () => {
  it('carries the lines, the layout and the label', () => {
    const params = stampStyleParams(
      options({ fields: ['name', 'label'], label: '  Approved  ', layout: 'beside' }),
      null,
      FONT_DIR,
    );
    expect(params.stamp_style).toMatchObject({
      fields: ['name', 'label'],
      layout: 'beside',
      label: 'Approved',
    });
  });

  it('omits the label when its line is not shown', () => {
    const params = stampStyleParams(
      options({ fields: ['name'], label: 'Approved' }),
      null,
      FONT_DIR,
    );
    expect(params.stamp_style).not.toHaveProperty('label');
  });

  it('carries the image by PATH — the engine reads it, the renderer does not', () => {
    const params = stampStyleParams(
      options({ imagePath: 'C:\\logo.png', imagePosition: 'right', imageOpacity: 0.5 }),
      null,
      FONT_DIR,
    );
    expect(params.stamp_style).toMatchObject({
      image: { path: 'C:\\logo.png' },
      image_position: 'right',
      image_opacity: 0.5,
    });
  });

  it('sends a drawn signature as vector paths, not as a raster', () => {
    const face = resolveStampFace('ink-1', [inkAsset])!;
    expect(face.form).toBe('vector');
    const wire = faceParams(face) as { form: string; paths: number[][] };
    expect(wire.form).toBe('vector');
    expect(wire.paths.length).toBe(1);
    // Smoothed for rendering: every captured point is still on the curve, so
    // the sent path is denser than the stored one and never shorter.
    expect(wire.paths[0].length).toBeGreaterThanOrEqual(inkAsset.kind === 'ink' ? inkAsset.strokes[0].length : 0);
  });

  it('sends a typed signature as text plus the BUNDLED face file', () => {
    const face = resolveStampFace('typed-1', [typedAsset])!;
    const wire = faceParams(face) as { typed: { text: string; fontFile: string } };
    expect(wire.typed.text).toBe('Jane Doe');
    expect(wire.typed.fontFile).toBe('GreatVibes-Regular.ttf');
  });
});

describe('face resolution refuses rather than substitutes', () => {
  it('refuses an id that names no saved signature', () => {
    expect(() => resolveStampFace('gone', [inkAsset])).toThrow(STAMP_FACE_MISSING);
  });

  it('refuses a saved signature whose artwork will not decode', () => {
    expect(() => resolveStampFace('img-1', [brokenImageAsset])).toThrow(STAMP_FACE_UNREADABLE);
  });

  it('resolves to nothing when nothing is chosen', () => {
    expect(resolveStampFace(null, [inkAsset])).toBeNull();
  });
});

describe('the preview is the engine drawing', () => {
  it('asks the engine for the appearance at the box the signature will occupy', () => {
    const params = previewParams({
      options: options({ fields: ['name'] }),
      face: null,
      fontDir: FONT_DIR,
      signer: 'Certificate holder',
      reason: '  why  ',
      location: '',
      width: 220,
      height: 70,
      timestamp: '2026-01-01 00:00',
    });
    expect(params).toMatchObject({
      width: 220,
      height: 70,
      signer: 'Certificate holder',
      reason: 'why',
      font_dir: FONT_DIR,
      timestamp: '2026-01-01 00:00',
    });
    expect(params).not.toHaveProperty('location');
    expect(params.stamp_style).toMatchObject({ fields: ['name'] });
  });

  it('omits the appearance for the default one, so the preview shows the plain stamp', () => {
    const params = previewParams({
      options: DEFAULT_STAMP_APPEARANCE,
      face: null,
      fontDir: FONT_DIR,
      signer: 'S',
      reason: '',
      location: '',
      width: 220,
      height: 70,
      timestamp: 't',
    });
    expect(params).not.toHaveProperty('stamp_style');
  });

  it('decodes the engine PDF rather than building one', () => {
    const bytes = decodePreviewPdf(btoa('%PDF-1.7\n'));
    expect(new TextDecoder().decode(bytes)).toBe('%PDF-1.7\n');
  });

  it('calls exactly one engine method for the drawing', async () => {
    const call = vi.fn().mockResolvedValue({ pdf: btoa('%PDF-1.7\n') });
    const { renderStampPreview } = await import('../src/renderer/lib/stamp-appearance');
    await renderStampPreview(call, {
      options: DEFAULT_STAMP_APPEARANCE,
      face: null,
      fontDir: FONT_DIR,
      signer: 'S',
      reason: '',
      location: '',
      width: 220,
      height: 70,
      timestamp: 't',
    }).catch(() => {
      // pdf.js cannot parse the stub bytes in a node environment; what this
      // asserts is the CALL, which is the one-author claim.
    });
    expect(call).toHaveBeenCalledTimes(1);
    expect(call.mock.calls[0][0]).toBe('preview_stamp_appearance');
  });
});
