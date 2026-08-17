// Stages pdf.js's RUNTIME-FETCHED assets out of the pinned `pdfjs-dist`
// package into `public/pdfjs/`, where Vite copies them verbatim into
// `dist/renderer/pdfjs/` and the renderer points pdf.js at them.
//
// WHY THIS EXISTS (a live silent-degradation defect, not new
// feature scaffolding). pdf.js 6 does not inline these; it FETCHES them from
// the four `getDocument` URL options, each of which defaults to `null`:
//
//   wasmUrl            jbig2.wasm      -> /JBIG2Decode AND /CCITTFaxDecode
//                                        (CCITTFaxStream delegates to
//                                        JBig2CCITTFaxImage — one module)
//                      openjpeg.wasm   -> /JPXDecode
//                      qcms_bg.wasm    -> ICC-based colour spaces
//   iccUrl             the CGATS CMYK profile -> /DeviceN + ICC CMYK
//   cMapUrl            168 .bcmap files -> CJK encodings
//   standardFontDataUrl the bundled substitute faces -> the standard 14 when a
//                                        document embeds nothing
//
// With the option null, pdf.js throws "Ensure that the `wasmUrl` API parameter
// is provided" INSIDE the image decoder, warns, and draws nothing — a
// fax-derived or scanner-optimized PDF renders BLANK with no error surfaced to
// the user. That is exactly the population MRC output lands in.
//
// Shape follows scripts/sync-ocr-assets.mjs deliberately: npm-sourced (so the
// lockfile pins it), fully offline, deterministic, and it FAILS THE BUILD when
// an expected file is absent rather than staging a tree that silently drops a
// codec. The upstream layout is enumerated per set below, so a pdfjs-dist bump
// that moves or renames a file stops the build instead of shipping a viewer
// that cannot draw three image filters.
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const root = fileURLToPath(new URL('../', import.meta.url))
const src = join(root, 'node_modules', 'pdfjs-dist')
const dest = join(root, 'public', 'pdfjs')

/**
 * The staged sets. `required` is the list whose ABSENCE is a build failure —
 * the licence texts are in it too, because they ship beside the binaries they
 * cover (THIRD-PARTY-LICENSES.md § Frontend / runtime libraries points at
 * them). `minFiles` guards the sets that are too large to enumerate: a cmaps
 * directory that upstream truncated would otherwise pass a name check.
 */
export const PDFJS_ASSET_SETS = [
  {
    dir: 'wasm',
    // Every image filter pdf.js routes through WebAssembly, plus each one's
    // pure-JS fallback (pdf.js imports the fallback when instantiation fails,
    // so staging the .wasm without its sibling leaves no path at all).
    required: [
      'jbig2.wasm',
      'jbig2_nowasm_fallback.js',
      'openjpeg.wasm',
      'openjpeg_nowasm_fallback.js',
      'qcms_bg.wasm',
      'LICENSE_JBIG2',
      'LICENSE_OPENJPEG',
      'LICENSE_QCMS',
    ],
    minFiles: 8,
  },
  {
    dir: 'iccs',
    required: ['CGATS001Compat-v2-micro.icc', 'LICENSE'],
    minFiles: 2,
  },
  {
    dir: 'standard_fonts',
    required: [
      'FoxitDingbats.pfb',
      'FoxitFixed.pfb',
      'FoxitFixedBold.pfb',
      'FoxitFixedBoldItalic.pfb',
      'FoxitFixedItalic.pfb',
      'FoxitSerif.pfb',
      'FoxitSerifBold.pfb',
      'FoxitSerifBoldItalic.pfb',
      'FoxitSerifItalic.pfb',
      'FoxitSymbol.pfb',
      'LiberationSans-Bold.ttf',
      'LiberationSans-BoldItalic.ttf',
      'LiberationSans-Italic.ttf',
      'LiberationSans-Regular.ttf',
      'LICENSE_FOXIT',
      'LICENSE_LIBERATION',
    ],
    minFiles: 16,
  },
  {
    dir: 'cmaps',
    // Four representative packed CMaps (one per CJK registry) plus the count
    // floor; naming all 168 would be churn with no extra signal.
    required: [
      'UniGB-UCS2-H.bcmap',
      'UniJIS-UCS2-H.bcmap',
      'UniKS-UCS2-H.bcmap',
      'UniCNS-UCS2-H.bcmap',
      'LICENSE',
    ],
    minFiles: 160,
  },
]

/** Verify a set against a pdfjs-dist tree. Returns a list of problems. */
export function checkAssetSet(set, pdfjsRoot) {
  const dir = join(pdfjsRoot, set.dir)
  if (!existsSync(dir)) return [`${set.dir}/ is missing from pdfjs-dist`]
  const present = new Set(readdirSync(dir))
  const problems = []
  for (const file of set.required) {
    if (!present.has(file)) problems.push(`${set.dir}/${file} is missing`)
  }
  if (present.size < set.minFiles) {
    problems.push(`${set.dir}/ holds ${present.size} files, expected at least ${set.minFiles}`)
  }
  return problems
}

/** Stage every set into public/pdfjs. Throws on an incomplete upstream tree. */
export function stagePdfjsAssets() {
  if (!existsSync(src)) {
    throw new Error('node_modules/pdfjs-dist is not installed — run `npm ci` first.')
  }

  const problems = PDFJS_ASSET_SETS.flatMap((set) => checkAssetSet(set, src))
  if (problems.length > 0) {
    throw new Error(
      'pdfjs-dist does not carry the assets the renderer fetches at run time:\n' +
        problems.map((p) => `  - ${p}`).join('\n') +
        '\n  The package layout changed. Fix scripts/sync-pdfjs-assets.mjs against the new\n' +
        '  layout — do NOT relax the check: a missing module makes CCITT/JBIG2/JPX pages\n' +
        '  render blank with no error the user can see.',
    )
  }

  // Rebuild the destination so a removed upstream file cannot linger.
  rmSync(dest, { recursive: true, force: true })
  mkdirSync(dest, { recursive: true })

  let bytes = 0
  let files = 0
  for (const set of PDFJS_ASSET_SETS) {
    cpSync(join(src, set.dir), join(dest, set.dir), { recursive: true })
    for (const f of readdirSync(join(dest, set.dir))) {
      bytes += statSync(join(dest, set.dir, f)).size
      files += 1
    }
  }
  return { files, bytes }
}

// Run only when invoked directly (the vitest pin imports the manifest).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    const { files, bytes } = stagePdfjsAssets()
    const mb = (bytes / 1024 / 1024).toFixed(1)
    console.log(`[sync-pdfjs-assets] Staged ${files} files -> public/pdfjs (${mb} MB).`)
  } catch (err) {
    console.error(`[sync-pdfjs-assets] ${err.message}`)
    process.exit(1)
  }
}
