// The personal-signature asset store and its pure geometry.
//
// A LEAF module: localStorage + pure helpers only, so the store's merge, the
// stroke normalization, the render-time smoothing and the placement mapping
// are unit-testable. There is no DOM test environment, so the breakable part
// must be the testable part (the stamp-library precedent).
//
// THREE CAPTURE DOORS, three payload shapes, one asset type:
// - `ink`   — the drawn strokes, one flat [x0,y0,x1,y1,...] path per pen lift,
//             normalized into the drawing's own bounding box (0..1, y DOWN,
//             the display convention every annotation stores in). The points
//             are the RAW captured ones: nothing is resampled, decimated or
//             smoothed on the way in, because a capture that smooths has
//             thrown away what it smoothed and can never offer another curve.
//             Smoothing is a RENDER decision (`smoothStrokes`).
// - `typed` — the name plus which bundled script face draws it. No system
//             font is ever named: see lib/signature-fonts.
// - `image` — an imported PNG/JPEG as a data URL, optionally with its white
//             background already removed (lib/signature-image).
//
// `aspect` is height/width of the asset's own artwork. Placement sizes the
// box from it so the signature lands undistorted on paper, exactly as a
// custom image stamp does.
//
// The store is LOCAL ONLY and is never written into a document: a document
// gets a signature when the user places one, and by no other route.

import type { SignatureFaceId } from './signature-fonts';
import { SIGNATURE_FACES } from './signature-fonts';

/** What the asset is FOR. Both are ordinary assets — the role is what lets a
 * surface offer "your initials" without the user hunting through a list. */
export type SignatureRole = 'signature' | 'initials';

interface SignatureAssetBase {
  id: string;
  /** The user's own name for it. Display only; never derived from. */
  name: string;
  role: SignatureRole;
  /** height / width of the artwork. Always finite and > 0. */
  aspect: number;
  /** Epoch ms of creation — orders the list and breaks merge ties. */
  createdAt: number;
}

export interface InkSignatureAsset extends SignatureAssetBase {
  kind: 'ink';
  /** One flat [x0,y0,...] path per pen lift, 0..1 over the artwork box. */
  strokes: number[][];
}

export interface TypedSignatureAsset extends SignatureAssetBase {
  kind: 'typed';
  text: string;
  face: SignatureFaceId;
}

export interface ImageSignatureAsset extends SignatureAssetBase {
  kind: 'image';
  /** PNG or JPEG data URL. Background removal, if any, is already applied —
   * the asset stores what the user approved in the preview, never a
   * threshold to re-apply later. */
  imageData: string;
}

export type SignatureAsset =
  | InkSignatureAsset
  | TypedSignatureAsset
  | ImageSignatureAsset;

/** Shared by every window, like `spectra-recent` and unlike the per-window
 * `workbench-ui` family: a signature is the person's, not the window's. */
const KEY = 'spectra-signatures';

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

function isFlatPath(v: unknown): v is number[] {
  return (
    Array.isArray(v) &&
    v.length >= 4 &&
    v.length % 2 === 0 &&
    v.every((n) => typeof n === 'number' && Number.isFinite(n))
  );
}

/** A stored value is an asset, or it is not persisted at all. A malformed row
 * is DROPPED rather than repaired: a repaired signature is someone else's
 * mark drawn under this user's name. */
export function isSignatureAsset(v: unknown): v is SignatureAsset {
  if (typeof v !== 'object' || v === null) return false;
  const a = v as Record<string, unknown>;
  if (typeof a.id !== 'string' || !a.id) return false;
  if (typeof a.name !== 'string') return false;
  if (a.role !== 'signature' && a.role !== 'initials') return false;
  if (typeof a.aspect !== 'number' || !Number.isFinite(a.aspect) || a.aspect <= 0) return false;
  if (typeof a.createdAt !== 'number' || !Number.isFinite(a.createdAt)) return false;
  if (a.kind === 'ink') {
    return Array.isArray(a.strokes) && a.strokes.length > 0 && a.strokes.every(isFlatPath);
  }
  if (a.kind === 'typed') {
    return (
      typeof a.text === 'string' &&
      a.text.trim().length > 0 &&
      typeof a.face === 'string' &&
      SIGNATURE_FACES.some((f) => f.id === a.face)
    );
  }
  if (a.kind === 'image') {
    return typeof a.imageData === 'string' && a.imageData.startsWith('data:image/');
  }
  return false;
}

/** Pure, testable core: JSON-valid-but-wrong-shape (object, string, null) →
 * [], never a non-array that would crash the list's .map. */
export function parseSignatureAssets(raw: string | null): SignatureAsset[] {
  try {
    const parsed: unknown = JSON.parse(raw || '[]');
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isSignatureAsset);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// The store (read-modify-write, shared across windows)
// ---------------------------------------------------------------------------

function readStored(): SignatureAsset[] {
  try {
    return parseSignatureAssets(localStorage.getItem(KEY));
  } catch {
    return [];
  }
}

/** What THIS window last put on the key. Assets on the key that are not in it
 * arrived from another window; assets in it that this window has since
 * dropped were deleted here and must not come back — a blind union cannot
 * tell those apart, and getting it wrong makes Delete not work. */
let lastWritten: SignatureAsset[] | null = null;

export function loadSignatureAssets(): SignatureAsset[] {
  const list = readStored();
  lastWritten = list;
  return list;
}

/** Fold two lists into one, newest first, one row per id. */
export function mergeSignatureAssets(
  a: readonly SignatureAsset[],
  b: readonly SignatureAsset[],
): SignatureAsset[] {
  const byId = new Map<string, SignatureAsset>();
  for (const asset of [...a, ...b]) {
    const held = byId.get(asset.id);
    if (!held || asset.createdAt > held.createdAt) byId.set(asset.id, asset);
  }
  return [...byId.values()].sort((x, y) => y.createdAt - x.createdAt);
}

/**
 * Persist `next`, folding in whatever another window has added since this one
 * last wrote, and return what was actually stored.
 */
export function persistSignatureAssets(next: readonly SignatureAsset[]): SignatureAsset[] {
  const stored = readStored();
  const known = new Set((lastWritten ?? stored).map((s) => s.id));
  const foreign = stored.filter((s) => !known.has(s.id));
  const merged = mergeSignatureAssets(next, foreign);
  try {
    localStorage.setItem(KEY, JSON.stringify(merged));
  } catch {
    // Storage full or unavailable. The caller's in-memory list still holds
    // what the user made; nothing is silently altered.
  }
  lastWritten = merged;
  return merged;
}

// ---------------------------------------------------------------------------
// Ink geometry
// ---------------------------------------------------------------------------

/** The bounding box of a stroke set in its own coordinates, or null when the
 * set has no extent (a single tap is not a signature). */
export function strokesBox(
  strokes: readonly (readonly number[])[],
): { x: number; y: number; w: number; h: number } | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const s of strokes) {
    for (let i = 0; i + 1 < s.length; i += 2) {
      if (s[i] < minX) minX = s[i];
      if (s[i] > maxX) maxX = s[i];
      if (s[i + 1] < minY) minY = s[i + 1];
      if (s[i + 1] > maxY) maxY = s[i + 1];
    }
  }
  if (!Number.isFinite(minX) || !Number.isFinite(minY)) return null;
  const w = maxX - minX;
  const h = maxY - minY;
  if (w <= 0 && h <= 0) return null;
  return { x: minX, y: minY, w, h };
}

/**
 * Raw captured strokes (any coordinate system, y down) → the asset's stored
 * form: normalized into their own bounding box, plus that box's aspect.
 *
 * The pen has WIDTH, so a purely horizontal stroke has a zero-height box and
 * a purely vertical one a zero-width box; normalizing by zero would divide a
 * real drawing into NaN. Both degenerate axes take the other axis's extent as
 * their scale and centre the artwork, which keeps a dash a dash instead of
 * stretching it to fill a square.
 *
 * Nothing is resampled or smoothed: the returned points are the captured ones
 * in new coordinates.
 */
export function normalizeStrokes(
  strokes: readonly (readonly number[])[],
): { strokes: number[][]; aspect: number } | null {
  const box = strokesBox(strokes);
  if (!box) return null;
  const scale = Math.max(box.w, box.h);
  const offX = box.w > 0 ? box.x : box.x - scale / 2;
  const offY = box.h > 0 ? box.y : box.y - scale / 2;
  const spanX = box.w > 0 ? box.w : scale;
  const spanY = box.h > 0 ? box.h : scale;
  const out: number[][] = [];
  for (const s of strokes) {
    if (s.length < 2) continue;
    const flat: number[] = [];
    for (let i = 0; i + 1 < s.length; i += 2) {
      flat.push((s[i] - offX) / spanX, (s[i + 1] - offY) / spanY);
    }
    if (flat.length >= 2) out.push(flat);
  }
  if (out.length === 0) return null;
  return { strokes: out, aspect: spanY / spanX };
}

/** How many line segments each captured span is drawn as when smoothed. Four
 * is where a signature at print size stops showing its corners; more only
 * grows the content stream. */
const SMOOTH_STEPS = 4;

/**
 * RENDER-time smoothing: a captured polyline → a denser polyline that follows
 * a centripetal-ish Catmull-Rom through the SAME points.
 *
 * Every captured point is still on the curve, so smoothing never moves the
 * signature — it only fills in between the samples a pointer device happened
 * to deliver. It is applied here and never at capture, so the stored asset
 * can be re-rendered at another density (or none) without having lost
 * anything.
 *
 * A two-point stroke has no neighbours to curve through and passes straight
 * back out.
 */
export function smoothStrokes(
  strokes: readonly (readonly number[])[],
  steps: number = SMOOTH_STEPS,
): number[][] {
  const out: number[][] = [];
  for (const s of strokes) {
    const n = s.length / 2;
    if (n < 3 || steps < 2) {
      out.push([...s]);
      continue;
    }
    const px = (i: number): number => s[Math.min(n - 1, Math.max(0, i)) * 2];
    const py = (i: number): number => s[Math.min(n - 1, Math.max(0, i)) * 2 + 1];
    const flat: number[] = [px(0), py(0)];
    for (let i = 0; i < n - 1; i += 1) {
      const x0 = px(i - 1);
      const y0 = py(i - 1);
      const x1 = px(i);
      const y1 = py(i);
      const x2 = px(i + 1);
      const y2 = py(i + 1);
      const x3 = px(i + 2);
      const y3 = py(i + 2);
      for (let k = 1; k <= steps; k += 1) {
        const t = k / steps;
        const t2 = t * t;
        const t3 = t2 * t;
        // Uniform Catmull-Rom in Hermite form, tension 1/2.
        flat.push(
          0.5 *
            ((2 * x1) +
              (-x0 + x2) * t +
              (2 * x0 - 5 * x1 + 4 * x2 - x3) * t2 +
              (-x0 + 3 * x1 - 3 * x2 + x3) * t3),
          0.5 *
            ((2 * y1) +
              (-y0 + y2) * t +
              (2 * y0 - 5 * y1 + 4 * y2 - y3) * t2 +
              (-y0 + 3 * y1 - 3 * y2 + y3) * t3),
        );
      }
    }
    out.push(flat);
  }
  return out;
}

/**
 * Unit-box strokes → strokes in a target rect of the SAME space the rect is
 * expressed in (the canvas's display-normalized 0..1 page box).
 *
 * This is the whole of "place a drawn signature": the placement rect is
 * computed from the asset's aspect so the mapping is uniform, and the result
 * is what an ordinary ink annotation stores. There is no second door.
 */
export function placeStrokes(
  strokes: readonly (readonly number[])[],
  rect: { x: number; y: number; w: number; h: number },
): number[][] {
  return strokes.map((s) => {
    const flat: number[] = [];
    for (let i = 0; i + 1 < s.length; i += 2) {
      flat.push(rect.x + s[i] * rect.w, rect.y + s[i + 1] * rect.h);
    }
    return flat;
  });
}

/**
 * The placement footprint for an asset, display-normalized against a page
 * cell of `dispW` x `dispH` display units.
 *
 * `widthFrac` is how much of the page's WIDTH the signature spans; the height
 * follows from the artwork's own aspect and the cell's shape, so the mark is
 * undistorted on paper (the image-stamp convention). Both are clamped so a
 * tall asset cannot be placed larger than the page.
 */
export function signatureFootprint(
  aspect: number,
  dispW: number,
  dispH: number,
  widthFrac: number,
): { w: number; h: number } {
  const w = Math.max(0.02, Math.min(1, widthFrac));
  const h = w * aspect * (dispW / dispH);
  if (h <= 1) return { w, h };
  const shrunk = w / h;
  return { w: shrunk, h: 1 };
}

// ---------------------------------------------------------------------------
// The F30 consumer's accessor
// ---------------------------------------------------------------------------

/** One chosen asset, resolved into what a stamp-appearance author needs:
 * vector paths, or image bytes, or typed text plus the face file to set it
 * in — plus the metadata that names and sizes it. The engine-side stamp lane
 * consumes this and nothing else about the store. */
export interface SignatureFaceSource {
  assetId: string;
  name: string;
  role: SignatureRole;
  /** height / width of the artwork. */
  aspect: number;
  form: 'vector' | 'image' | 'typed';
  /** form 'vector': unit-box paths, already smoothed for rendering. */
  paths?: number[][];
  /** form 'image': the decoded raster and its type. */
  image?: { bytes: Uint8Array; mime: 'image/png' | 'image/jpeg' };
  /** form 'typed': the text and the BUNDLED face file it is set in (a file
   * name within the app's fonts resource directory — never a system font,
   * and never a path this side invents). */
  typed?: { text: string; faceId: SignatureFaceId; fontFile: string };
}

/** Decode a `data:` URL's payload. Returns null on anything that is not a
 * PNG or JPEG data URL — the caller then has an honest absence rather than a
 * zero-length buffer that looks like an image. */
export function decodeImageDataUrl(
  dataUrl: string,
): { bytes: Uint8Array; mime: 'image/png' | 'image/jpeg' } | null {
  const comma = dataUrl.indexOf(',');
  if (comma < 0) return null;
  const header = dataUrl.slice(0, comma);
  const mime = header.startsWith('data:image/png')
    ? 'image/png'
    : header.startsWith('data:image/jpeg') || header.startsWith('data:image/jpg')
      ? 'image/jpeg'
      : null;
  if (!mime || !header.includes(';base64')) return null;
  try {
    const bin = atob(dataUrl.slice(comma + 1));
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
    return { bytes, mime };
  } catch {
    return null;
  }
}

/**
 * Resolve an asset into the certificate-stamp face source (F30's one entry
 * point into this store).
 *
 * Returns null when the asset cannot be presented as a face at all — an
 * image whose data URL will not decode. Callers surface that; nothing
 * substitutes a different mark.
 */
export function signatureFaceSource(asset: SignatureAsset): SignatureFaceSource | null {
  const base = {
    assetId: asset.id,
    name: asset.name,
    role: asset.role,
    aspect: asset.aspect,
  };
  if (asset.kind === 'ink') {
    return { ...base, form: 'vector', paths: smoothStrokes(asset.strokes) };
  }
  if (asset.kind === 'typed') {
    const face = SIGNATURE_FACES.find((f) => f.id === asset.face);
    if (!face) return null;
    return {
      ...base,
      form: 'typed',
      typed: { text: asset.text, faceId: face.id, fontFile: face.file },
    };
  }
  const image = decodeImageDataUrl(asset.imageData);
  if (!image) return null;
  return { ...base, form: 'image', image };
}
