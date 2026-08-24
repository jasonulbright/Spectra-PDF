// What a visible certificate-signature stamp looks like: the options both
// sign surfaces collect, the engine request they build, and the preview.
//
// ONE APPEARANCE AUTHOR. Nothing here draws a stamp. The preview asks the
// ENGINE to draw the appearance into a one-page PDF whose page IS the stamp
// box, and the surface rasterizes that PDF the way it rasterizes any
// document. A preview that re-implemented the drawing in TypeScript could
// disagree with the signed file, and routing it through the engine means it
// structurally cannot (the widget-faces lesson).
//
// A LEAF module: pure option handling plus two calls the caller supplies, so
// the request building and the default-detection are unit-testable without a
// DOM.

import { signatureFaceSource, type SignatureAsset, type SignatureFaceSource } from './signature-assets';

/** The lines a stamp can render, in the order the engine knows how to build
 * them. The REQUEST decides which appear and in what order. */
export type StampField = 'name' | 'date' | 'reason' | 'location' | 'label';
export const STAMP_FIELDS: readonly StampField[] = [
  'name',
  'date',
  'reason',
  'location',
  'label',
];

/** Where the logo sits relative to the text. */
export type StampLayout = 'over' | 'beside';
export const STAMP_LAYOUTS: readonly StampLayout[] = ['over', 'beside'];

export type StampPosition = 'left' | 'right' | 'top' | 'bottom';
export const STAMP_POSITIONS: readonly StampPosition[] = ['left', 'right', 'top', 'bottom'];

export interface StampAppearanceOptions {
  fields: StampField[];
  /** The free "label" line's text. Rendered only when `fields` includes it. */
  label: string;
  layout: StampLayout;
  /** Absolute path to a PNG or JPEG. The engine reads it; the renderer never
   * loads the bytes just to hand them back. */
  imagePath: string | null;
  imagePosition: StampPosition;
  /** 0..1, applied to an `over` background only. */
  imageOpacity: number;
  /** Which saved personal signature draws the face, by asset id. */
  signatureAssetId: string | null;
  signaturePosition: StampPosition;
  fontSize: number;
}

export const DEFAULT_STAMP_FIELDS: StampField[] = ['name', 'date', 'reason', 'location'];

/** The appearance a signature has always had: the plain signer + timestamp +
 * reason/location stamp, nothing attached. */
export const DEFAULT_STAMP_APPEARANCE: StampAppearanceOptions = {
  fields: DEFAULT_STAMP_FIELDS,
  label: '',
  layout: 'over',
  imagePath: null,
  imagePosition: 'left',
  imageOpacity: 1,
  signatureAssetId: null,
  signaturePosition: 'left',
  fontSize: 10,
};

function sameFields(a: readonly StampField[], b: readonly StampField[]): boolean {
  return a.length === b.length && a.every((f, i) => f === b[i]);
}

/**
 * True when the options ask for exactly what an unconfigured signature draws.
 *
 * The request omits the appearance entirely in that case, so a user who never
 * opened the section signs the file the engine would have produced before
 * appearances existed — no new object, no new bytes.
 */
export function isDefaultStampAppearance(options: StampAppearanceOptions): boolean {
  return (
    // The label is not consulted: the default line list does not include the
    // custom line, so text typed for a line that is not shown changes nothing
    // about the stamp and must not turn an unconfigured signature into a
    // configured one.
    sameFields(options.fields, DEFAULT_STAMP_FIELDS) &&
    options.imagePath === null &&
    options.signatureAssetId === null &&
    options.fontSize === DEFAULT_STAMP_APPEARANCE.fontSize
  );
}

/** Base64 for the engine's wire, which is JSON and cannot carry bytes. */
function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

/** The resolved face on the wire. Mirrors the engine's `_parse_face`; the
 * renderer resolves its own store and sends the RESOLVED form, so the engine
 * knows nothing about where a signature is kept. */
export function faceParams(face: SignatureFaceSource): Record<string, unknown> {
  const base = { form: face.form, aspect: face.aspect };
  if (face.form === 'vector') return { ...base, paths: face.paths ?? [] };
  if (face.form === 'typed') {
    return {
      ...base,
      typed: { text: face.typed?.text ?? '', fontFile: face.typed?.fontFile ?? '' },
    };
  }
  return {
    ...base,
    image: face.image
      ? { data: toBase64(face.image.bytes), mime: face.image.mime }
      : {},
  };
}

/**
 * Resolve the chosen saved signature into the face the engine draws.
 *
 * Returns null when nothing is chosen. THROWS when the chosen id names an
 * asset that is gone or one whose artwork will not decode — a signature the
 * user picked and a different mark on the paper is the one outcome this must
 * never produce, so the caller surfaces the refusal instead.
 */
export function resolveStampFace(
  assetId: string | null,
  assets: readonly SignatureAsset[],
): SignatureFaceSource | null {
  if (!assetId) return null;
  const asset = assets.find((a) => a.id === assetId);
  if (!asset) throw new Error(STAMP_FACE_MISSING);
  const face = signatureFaceSource(asset);
  if (!face) throw new Error(STAMP_FACE_UNREADABLE);
  return face;
}

/** Sentinels, not display text: the surfaces map them to catalog keys. Control
 * flow never matches on localized text. */
export const STAMP_FACE_MISSING = 'stamp-face-missing';
export const STAMP_FACE_UNREADABLE = 'stamp-face-unreadable';

/**
 * The `stamp_style` + `font_dir` params for `sign_pdf`, or `{}` when the
 * appearance is the default one.
 */
export function stampStyleParams(
  options: StampAppearanceOptions,
  face: SignatureFaceSource | null,
  fontDir: string,
): Record<string, unknown> {
  if (isDefaultStampAppearance(options) && !face) return {};
  const spec: Record<string, unknown> = {
    fields: options.fields,
    layout: options.layout,
    font_size: options.fontSize,
  };
  if (options.fields.includes('label') && options.label.trim()) {
    spec.label = options.label.trim();
  }
  if (options.imagePath) {
    spec.image = { path: options.imagePath };
    spec.image_position = options.imagePosition;
    spec.image_opacity = options.imageOpacity;
  }
  if (face) {
    spec.signature = faceParams(face);
    spec.signature_position = options.signaturePosition;
  }
  return { stamp_style: spec, font_dir: fontDir };
}

export interface StampPreviewRequest {
  options: StampAppearanceOptions;
  face: SignatureFaceSource | null;
  fontDir: string;
  signer: string;
  reason: string;
  location: string;
  /** The stamp box in points. The preview draws at the box the signature will
   * occupy, so "does it fit" is answered by the same rule that will answer it
   * at sign time. */
  width: number;
  height: number;
  /** Fixes the interpolated signing time so the preview does not re-render on
   * every clock tick. */
  timestamp: string;
}

/** The parameters of a preview call, split out so a surface can memoize on
 * them without reaching into the request's shape. */
export function previewParams(request: StampPreviewRequest): Record<string, unknown> {
  const style = stampStyleParams(request.options, request.face, request.fontDir);
  return {
    width: request.width,
    height: request.height,
    signer: request.signer,
    ...(request.reason.trim() ? { reason: request.reason.trim() } : {}),
    ...(request.location.trim() ? { location: request.location.trim() } : {}),
    ...(style.stamp_style ? { stamp_style: style.stamp_style } : {}),
    font_dir: request.fontDir,
    timestamp: request.timestamp,
  };
}

/** Decode the engine's base64 PDF. */
export function decodePreviewPdf(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

type EngineCall = (method: string, params: Record<string, unknown>) => Promise<unknown>;

/**
 * The live preview: the engine draws, pdf.js rasterizes, the surface shows the
 * result. Returns a data URL.
 *
 * Refusals (an unreadable image, a signature face that is gone, a box the
 * stamp cannot fit) arrive as engine errors and are shown as they are — the
 * same refusals signing would raise, raised before the user commits to it.
 */
export async function renderStampPreview(
  call: EngineCall,
  request: StampPreviewRequest,
  scale = 2,
): Promise<string> {
  const res = (await call('preview_stamp_appearance', previewParams(request))) as {
    pdf: string;
  };
  // Imported here, not at module scope: everything above is pure option
  // handling that must stay testable without a canvas, and pdf.js reaches for
  // the DOM the moment it loads.
  const { loadDocument, renderPageToCanvas } = await import('./pdfRenderer');
  const doc = await loadDocument(decodePreviewPdf(res.pdf));
  try {
    const canvas = await renderPageToCanvas(doc, 1, scale);
    return canvas.toDataURL('image/png');
  } finally {
    void doc.loadingTask.destroy().catch(() => {});
  }
}
