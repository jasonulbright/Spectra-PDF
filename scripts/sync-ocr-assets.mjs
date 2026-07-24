// Stages tesseract.js's runtime assets (worker, WASM cores, language data)
// from the pinned npm packages into public/ocr/, which Vite copies into the
// built renderer — the app serves them from its own origin, fully offline
// (no CDN fetch, ever; enterprise/air-gapped hosts). Adapted from PDFx's
// scripts/copy-ocr-assets.mjs (same owner). public/ocr is generated and
// gitignored — the same repo-hygiene class as resources/python: vendored in
// the product, assembled by script, kept out of git.
import { copyFileSync, mkdirSync, readdirSync, rmSync, existsSync, statSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

// Single source of truth: parse the language codes straight out of the app's
// own OCR_LANGUAGES list (P1). Adding a language is a one-line edit to
// languages.ts; if the matching @tesseract.js-data package isn't installed,
// the copy below fails loudly rather than shipping a language the picker
// offers but can't recognize.
const langsFile = fileURLToPath(new URL('../src/renderer/ocr/languages.ts', import.meta.url))
const OCR_LANGS = [
  ...readFileSync(langsFile, 'utf8').matchAll(/\bcode:\s*'([a-z_]+)'/g),
].map((m) => m[1])
if (OCR_LANGS.length === 0) {
  console.error('[sync-ocr-assets] parsed zero language codes from languages.ts — refusing to stage.')
  process.exit(1)
}

const root = fileURLToPath(new URL('../', import.meta.url))
const nm = join(root, 'node_modules')
const dest = join(root, 'public', 'ocr')

const coreDir = join(nm, 'tesseract.js-core')
const workerJs = join(nm, 'tesseract.js', 'dist', 'worker.min.js')

if (!existsSync(coreDir) || !existsSync(workerJs)) {
  console.warn('[sync-ocr-assets] tesseract.js not installed yet; skipping.')
  process.exit(0)
}

rmSync(dest, { recursive: true, force: true })
mkdirSync(join(dest, 'core'), { recursive: true })
mkdirSync(join(dest, 'lang'), { recursive: true })

let bytes = 0
const copy = (from, to) => {
  copyFileSync(from, to)
  bytes += statSync(to).size
}

copy(workerJs, join(dest, 'worker.min.js'))

// LSTM cores only (the OEM the worker requests); plain + SIMD variants —
// tesseract.js picks at runtime by capability.
const coreFiles = readdirSync(coreDir).filter((f) => /-lstm\.wasm(\.js)?$/.test(f))
for (const f of coreFiles) copy(join(coreDir, f), join(dest, 'core', f))

const missing = []
for (const lang of OCR_LANGS) {
  const from = join(nm, '@tesseract.js-data', lang, '4.0.0_best_int', `${lang}.traineddata.gz`)
  if (!existsSync(from)) {
    missing.push(lang)
    continue
  }
  copy(from, join(dest, 'lang', `${lang}.traineddata.gz`))
}
// A language the picker offers but has no data for OCRs to nothing — that is
// the silent-degradation class the completeness rule forbids. Fail the build.
if (missing.length > 0) {
  console.error(
    `[sync-ocr-assets] missing traineddata for: ${missing.join(', ')}.\n` +
      `  Add the packages: npm i --save-exact ${missing.map((l) => `@tesseract.js-data/${l}@1.0.0`).join(' ')}`,
  )
  process.exit(1)
}

const mb = (bytes / 1024 / 1024).toFixed(1)
console.log(
  `[sync-ocr-assets] Staged ${coreFiles.length} core files + ${OCR_LANGS.length} languages -> public/ocr (${mb} MB).`
)
