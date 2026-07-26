// Stages the OCR language models into resources/tesseract/tessdata, where the
// VENDORED NATIVE TESSERACT reads them (Phase 12 step 3).
//
// This script used to stage tesseract.js's worker + WASM cores + gzipped models
// into public/ocr for the WebView recognizer. tesseract.js is retired: there is
// ONE recognizer now, native tesseract.exe driven by the engine, because two
// recognizers can disagree about the same page and a scheduled/CLI run has no
// WebView to host a WASM one in.
//
// What did NOT change, deliberately:
//   - the SOURCE of the models is still the pinned, hash-locked
//     `@tesseract.js-data/*` npm packages. They are plain Apache-2.0
//     .traineddata (the same files upstream ships); sourcing them from the
//     lockfile keeps the build reproducible and offline, which downloading
//     from a tessdata release at build time would not.
//   - the offered-language list is still parsed out of the app's own
//     languages.ts, so adding a language stays a one-line edit and a language
//     the picker offers but has no data for still FAILS THE BUILD.
//
// What did change: the models are DECOMPRESSED on the way in. tesseract.js
// consumed `.traineddata.gz`; native tesseract wants `.traineddata`.
import {
  copyFileSync,
  mkdirSync,
  readdirSync,
  rmSync,
  existsSync,
  statSync,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

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
const tessDir = join(root, 'resources', 'tesseract')
const dest = join(tessDir, 'tessdata')

// ── TRANSITIONAL: public/ocr is still staged ──────────────────────────────
// The native path is vendored and the engine `recognize` op exists, but the
// RENDERER still runs tesseract.js (search/engine.ts + the batch dialog). Until
// that rewiring lands, dropping public/ocr would break OCR for a fresh clone —
// so both destinations are staged. Delete this whole block, and the
// tesseract.js dependencies, in the commit that rewires the renderer; shipping
// two live recognizers is exactly what this program refused.
const legacyDest = join(root, 'public', 'ocr')
const coreDir = join(nm, 'tesseract.js-core')
const workerJs = join(nm, 'tesseract.js', 'dist', 'worker.min.js')
if (existsSync(coreDir) && existsSync(workerJs)) {
  rmSync(legacyDest, { recursive: true, force: true })
  mkdirSync(join(legacyDest, 'core'), { recursive: true })
  mkdirSync(join(legacyDest, 'lang'), { recursive: true })
  copyFileSync(workerJs, join(legacyDest, 'worker.min.js'))
  const coreFiles = readdirSync(coreDir).filter((f) => /-lstm\.wasm(\.js)?$/.test(f))
  for (const f of coreFiles) copyFileSync(join(coreDir, f), join(legacyDest, 'core', f))
  for (const lang of OCR_LANGS) {
    const from = join(nm, '@tesseract.js-data', lang, '4.0.0_best_int', `${lang}.traineddata.gz`)
    if (existsSync(from)) copyFileSync(from, join(legacyDest, 'lang', `${lang}.traineddata.gz`))
  }
  console.log(`[sync-ocr-assets] (transitional) staged tesseract.js assets -> public/ocr.`)
}

// The binary is vendored by scripts/bundle-tesseract.ps1. Staging models into a
// tree with no tesseract.exe would produce a silently useless resource folder,
// so say so plainly instead.
if (!existsSync(join(tessDir, 'tesseract.exe'))) {
  console.warn(
    '[sync-ocr-assets] resources/tesseract has no tesseract.exe yet — run scripts/bundle-tesseract.ps1 first. Skipping the native half.',
  )
  process.exit(0)
}

const dataRoot = join(nm, '@tesseract.js-data')
if (!existsSync(dataRoot)) {
  console.warn('[sync-ocr-assets] @tesseract.js-data packages not installed yet; skipping.')
  process.exit(0)
}

// Clear only the LANGUAGE MODELS. `configs/`, `tessconfigs/` and the
// installer's own osd/eng come from the vendoring script — wiping the whole
// folder here would delete configs/tsv, and TSV is how word boxes are read.
mkdirSync(dest, { recursive: true })
for (const f of readdirSync(dest)) {
  if (f.endsWith('.traineddata') && f !== 'osd.traineddata') rmSync(join(dest, f), { force: true })
}

let bytes = 0
const missing = []
for (const lang of OCR_LANGS) {
  const from = join(nm, '@tesseract.js-data', lang, '4.0.0_best_int', `${lang}.traineddata.gz`)
  if (!existsSync(from)) {
    missing.push(lang)
    continue
  }
  const to = join(dest, `${lang}.traineddata`)
  writeFileSync(to, gunzipSync(readFileSync(from)))
  bytes += statSync(to).size
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

// osd (orientation & script detection) has no npm package and only ships in the
// installer. It is not an offered language, so its absence is not a build
// failure — but note it, because page-orientation handling degrades without it.
if (!existsSync(join(dest, 'osd.traineddata'))) {
  console.warn('[sync-ocr-assets] osd.traineddata absent — re-run scripts/bundle-tesseract.ps1.')
}

// Guard the thing that actually breaks recognition output (see the vendoring
// script): TSV is a config FILE, not a model, and without it tesseract prints
// plain text and the engine parses no boxes.
if (!existsSync(join(dest, 'configs', 'tsv'))) {
  console.error(
    '[sync-ocr-assets] tessdata/configs/tsv is missing — word-box output would silently not work. Re-run scripts/bundle-tesseract.ps1.',
  )
  process.exit(1)
}

const mb = (bytes / 1024 / 1024).toFixed(1)
console.log(
  `[sync-ocr-assets] Staged ${OCR_LANGS.length} language models -> resources/tesseract/tessdata (${mb} MB).`,
)
