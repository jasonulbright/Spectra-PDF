// Stage OCR language models into resources/tesseract/tessdata for the vendored
// native Tesseract runtime. There is one recognizer driven by the engine; two
// recognizers could disagree, and a scheduled or CLI run has no
// WebView to host a WASM one in.
//
// Model sources are pinned, hash-locked `@tesseract.js-data/*` packages. They
// contain the upstream Apache-2.0 .traineddata files, keeping builds reproducible
// and offline. The offered-language list is parsed from languages.ts so any
// picker language without model data fails the build.
//
// Models are decompressed on the way in because native Tesseract requires
// `.traineddata` rather than `.traineddata.gz`.
import { mkdirSync, readdirSync, rmSync, existsSync, statSync, readFileSync, writeFileSync } from 'node:fs'
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
