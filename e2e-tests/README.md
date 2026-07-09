# Spectra PDF — E2E test suite

WebdriverIO + `tauri-driver` driving the actual built binary against an
embedded WebView2. Tests use a renderer-side test harness exposed at
`window.__SPECTRA_TEST__`, only compiled in when `VITE_E2E=1` is set at
build time. Release builds never set the flag — the global is absent in
shipped binaries.

## One-time setup

```powershell
cargo install tauri-driver --locked
cargo install --git https://github.com/chippers/msedgedriver-tool
cd e2e-tests
npm ci
```

WebView2 is Chromium-based and updates roughly monthly via Windows Update;
msedgedriver only talks to the exact major version it was built for. So
`npm test`'s `onPrepare` hook re-runs `msedgedriver-tool` itself at the start
of every run, downloading a copy of `msedgedriver.exe` into `e2e-tests/`
(gitignored) that matches whatever WebView2 is installed *right now* — there
is no version pinned anywhere, minimum or otherwise. `wdio.conf.ts` then
points `tauri-driver --native-driver` straight at that freshly-resolved
copy, rather than trusting PATH to already have a correctly-versioned one.
`msedgedriver-tool` itself just needs to be on PATH (from the `cargo install`
above); nothing else to maintain by hand.

## Build the test binary

From the repo root:

```powershell
$env:VITE_E2E = "1"
npx tauri build --debug --no-bundle
```

`tauri build --debug` embeds the production frontend into the binary, so
the suite exercises the same renderer path as a release build.
`--no-bundle` skips the NSIS installer step.

The output is `src-tauri/target/debug/spectrapdf.exe`.

Prereqs for the binary to actually start the engine: `resources/python/`
must contain a working `python.exe` (run `scripts/setup-python-embed.ps1`
once) and `resources/ghostscript/` must exist (stub `gswin64c.exe` +
`gsdll64.dll` are fine for tests that don't exercise GS).

## Run the suite

```powershell
npm test
```

WebdriverIO spawns `tauri-driver` on port 4444, launches the binary, and
runs every `specs/*.spec.ts` file.

## What's covered

| Spec | Verifies |
|---|---|
| `01-boot.spec.ts` | Header renders, version is shown, harness installs |
| `02-open-pdf.spec.ts` | Valid PDF loads, page count is correct, dirty=false |
| `03-view-switch.spec.ts` | Header view switcher (Home / Tools / Pages) works |
| `04-save-as.spec.ts` | Working copy serializes to disk as a non-empty PDF |
| `05-malformed-refuse.spec.ts` | Structurally broken PDF is refused, app stays alive |
| `06-annotations.spec.ts` | Highlight/stamp/recolor bake into the saved file via the commit bridge |
| `07-import-existing-annotations.spec.ts` | Pre-existing annotations import, edit, and delete round-trip |
| `08-redaction.spec.ts` | Marked region's text is stripped from the saved file; unmarked text and other pages survive |
| `09-watermark.spec.ts` | Watermark panel form stamps text onto every page of the saved file |
| `10-forms.spec.ts` | Forms panel lists AcroForm fields, fills them, and the values bake into the saved file |

## Adding a spec

1. Drop a file in `specs/`. Use the helpers from `support/harness.ts`.
2. Use `openByPaths` and `saveActiveAs` from the harness, which open and
   save through the engine directly rather than the native Win32 dialogs.
3. Keep fixtures under `fixtures/`. Anything > 100 KB should be
   `.gitignore`d and committed only if hand-curated and stable.

## Tooling

WebdriverIO drives W3C WebDriver through `tauri-driver` → `msedgedriver`,
exercising the as-built binary directly and matching Tauri's official
example shape.
