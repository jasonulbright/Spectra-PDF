// The script faces a TYPED personal signature is set in.
//
// APP-BUNDLED ONLY. Nothing here ever names a system font: a clean machine
// has no handwriting face installed, and a typed signature that silently fell
// back to the platform default would be a wrong mark rather than a missing
// one. The three faces ship in `resources/fonts` beside the Edit-tool
// fallback family (scripts/sync-signature-fonts.ps1, sha256-pinned, OFL 1.1;
// notice rows in THIRD-PARTY-LICENSES.md section Fonts).
//
// They are OUTSIDE the font-resolution ladder by construction: the engine's
// fallback resolver knows nothing about them, and only a signature asset that
// names one draws with it. A typed signature embeds the face's SUBSET at
// commit, so the placed mark renders on a machine that never had the face.
//
// Two consumers need the bytes and they need them differently:
// - the capture dialog's live preview, through the CSS Font Loading API, so
//   the typed name is previewed in the face it will be committed in;
// - the commit, through pdf-lib's subsetting embed.
// Both read the same file once and share the cache below.

import { app, file } from './tauri-bridge';

export type SignatureFaceId = 'greatvibes' | 'sacramento' | 'parisienne';

export interface SignatureFace {
  id: SignatureFaceId;
  /** The file name inside the app's fonts resource directory. */
  file: string;
  /** The face's own name, used as the CSS family and as the picker label.
   * A PROPER NAME: never translated, never derived from. */
  familyName: string;
  /** The embedded subset's /BaseFont name, tag included.
   *
   * FIXED per face, never generated: a subset tag is six uppercase letters,
   * and pdf-lib picks a RANDOM one per embed — which would put six different
   * bytes in the file every time the same document was committed, and an
   * order-independent byte diff is exactly what the font-embedding invariants
   * exist to protect (the `recalcTimestamp=False` lesson, same class). The
   * tags differ per face so two subsets in one document never collide. */
  baseFontName: string;
}

export const SIGNATURE_FACES: readonly SignatureFace[] = [
  {
    id: 'greatvibes',
    file: 'GreatVibes-Regular.ttf',
    familyName: 'Great Vibes',
    baseFontName: 'GVIBES+GreatVibes-Regular',
  },
  {
    id: 'sacramento',
    file: 'Sacramento-Regular.ttf',
    familyName: 'Sacramento',
    baseFontName: 'SACRTO+Sacramento-Regular',
  },
  {
    id: 'parisienne',
    file: 'Parisienne-Regular.ttf',
    familyName: 'Parisienne',
    baseFontName: 'PARISN+Parisienne-Regular',
  },
];

export const DEFAULT_SIGNATURE_FACE: SignatureFaceId = 'greatvibes';

export function signatureFaceById(id: string): SignatureFace | undefined {
  return SIGNATURE_FACES.find((f) => f.id === id);
}

/** The CSS family name the preview binds a loaded face to. Prefixed so a
 * same-named system face can never be what renders. */
export function signatureCssFamily(id: SignatureFaceId): string {
  return `SpectraSignature-${id}`;
}

const bytesCache = new Map<SignatureFaceId, Uint8Array>();
const inFlight = new Map<SignatureFaceId, Promise<Uint8Array>>();

/**
 * The face's program bytes, read once per session.
 *
 * REJECTS, never substitutes, when the face cannot be read: a signature set
 * in a face other than the one the user chose is a wrong result, and the
 * shipped resource tree always carries these three, so a failure here is a
 * genuinely broken installation and says so.
 */
export async function loadSignatureFontBytes(id: SignatureFaceId): Promise<Uint8Array> {
  const cached = bytesCache.get(id);
  if (cached) return cached;
  const pending = inFlight.get(id);
  if (pending) return pending;
  const face = signatureFaceById(id);
  if (!face) throw new Error(`unknown signature face: ${id}`);
  const load = (async (): Promise<Uint8Array> => {
    const dir = await app.getEditFontPath();
    const sep = dir.includes('/') && !dir.includes('\\') ? '/' : '\\';
    const bytes = await file.readBuffer(`${dir}${sep}${face.file}`);
    const out = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    bytesCache.set(id, out);
    return out;
  })();
  inFlight.set(id, load);
  try {
    return await load;
  } finally {
    inFlight.delete(id);
  }
}

const cssLoaded = new Set<SignatureFaceId>();

/**
 * Register the face with the document so CSS can draw with it.
 *
 * The bytes are handed to `FontFace` directly rather than pointed at by a
 * URL: an asset URL for a file outside the bundle is a content-security
 * question the preview has no business asking, and the commit needs the same
 * bytes anyway.
 */
export async function ensureSignatureFaceLoaded(id: SignatureFaceId): Promise<void> {
  if (cssLoaded.has(id)) return;
  const bytes = await loadSignatureFontBytes(id);
  // A fresh copy: FontFace takes ownership of the buffer it is given, and the
  // cached bytes are also the commit's source.
  const face = new FontFace(signatureCssFamily(id), new Uint8Array(bytes).buffer as ArrayBuffer);
  await face.load();
  document.fonts.add(face);
  cssLoaded.add(id);
}
