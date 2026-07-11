// Stages tesseract.js's runtime assets (worker, WASM cores, language data)
// from the pinned npm packages into public/ocr/, which Vite copies into the
// built renderer — the app serves them from its own origin, fully offline
// (no CDN fetch, ever; enterprise/air-gapped hosts). Adapted from PDFx's
// scripts/copy-ocr-assets.mjs (same owner). public/ocr is generated and
// gitignored — the same repo-hygiene class as resources/python: vendored in
// the product, assembled by script, kept out of git.
import { copyFileSync, mkdirSync, readdirSync, rmSync, existsSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const OCR_LANGS = ['eng', 'deu', 'fra', 'spa']

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

for (const lang of OCR_LANGS) {
  const from = join(nm, '@tesseract.js-data', lang, '4.0.0_best_int', `${lang}.traineddata.gz`)
  if (!existsSync(from)) {
    console.warn(`[sync-ocr-assets] missing language data for "${lang}"; skipping.`)
    continue
  }
  copy(from, join(dest, 'lang', `${lang}.traineddata.gz`))
}

const mb = (bytes / 1024 / 1024).toFixed(1)
console.log(
  `[sync-ocr-assets] Staged ${coreFiles.length} core files + ${OCR_LANGS.length} languages -> public/ocr (${mb} MB).`
)
