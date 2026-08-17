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

## The run's WARN/ERROR inventory

A green suite still prints red rows: WebdriverIO logs a driver-level failure at
WARN and again at ERROR even when its own middleware retries the command and
the spec goes on to pass. Colour is stripped on redirect, which is how every
battery is captured, so those rows survive in the log unnoticed.

Every run therefore ends with an inventory, printed by `wdio.conf.ts`'s
`onComplete` hook and grouped three ways:

- **UNEXPLAINED** — rows matching no registry entry, with their counts and the
  specs they occurred under. These are the ones to fix.
- **KNOWN** — rows registered in `log-registry.ts`, counted, not expanded.
- **STALE** — registry entries that matched nothing in this run. Reported as
  loudly as UNEXPLAINED: an entry that stops matching is standing permission
  for a row nobody produces, and it keeps suppressing its pattern after the
  spec that justified it changes meaning.

The inventory is a report. It never changes the exit code, which stays
WebdriverIO's verdict alone, and anything the scanner throws is swallowed.

A registry entry names the pattern, the spec that provokes it, and why the row
is correct behaviour. An entry grants permission for one message under one
spec — `scan-run-log.ts` requires both to agree wherever the log carries
attribution.

Fixing an UNEXPLAINED `element not interactable` means fixing the wait, not
lengthening a timeout: fold the verdict into the predicate that also proves the
control is clickable, and re-query the element inside it. `waitForExist`
followed by a click is check-then-act — existence is not interactability.

The run's own output is also saved to `logs/last-run.log` (gitignored), and any
saved log can be re-scanned without re-running the suite:

```powershell
npm run scan:log -- ..\battery-v1031.local.log
```

## What's covered

> The suite is **132 specs** (`specs/*.spec.ts`, all run by the config). The
> table below is a hand-maintained sample of the foundational specs and is
> deliberately partial — it stops at 13 and does not list the later ones
> (content editing, per-span styling, vector graphics, kerning, and the rest).
> Treat `ls specs/` as the source of truth for coverage; this table is
> orientation, not an inventory, and a full regeneration is outstanding work.

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
| `11-compare.spec.ts` | Compare panel diffs two open PDFs and reports the differing line |
| `12-signatures.spec.ts` | Signatures panel verifies a signed PDF: signer, valid badge, and the trust caveat |
| `13-signing.spec.ts` | Signing a PDF with a PKCS#12 signer produces a self-verifying signed file; wrong password fails closed |

## Adding a spec

1. Drop a file in `specs/`. Use the helpers from `support/harness.ts`.
2. Use `openByPaths` and `saveActiveAs` from the harness, which open and
   save through the engine directly rather than the native Win32 dialogs.
3. Keep fixtures under `fixtures/`. Anything > 100 KB should be
   `.gitignore`d and committed only if hand-curated and stable.
4. **After any engine op (commit or undo), key waits on the page id
   ADVANCING, not on listing content alone.** Page ids are
   generation-tagged (`…#gN#pI`) and the post-op reindex is async: a wait
   that matches on text can be satisfied by the STALE pre-op listing
   whenever the op leaves the text unchanged (restyles, transforms), and
   racing past it leaves the reindex to land mid-next-step — where (by
   durable-identity design) it invalidates open editors/selections keyed
   to the old generation. Capture `editTextPageIds()[0]` before the op
   and wait for it to change AND the content condition to hold — see
   `waitForReindexedListing` in `49-restyle-family.spec.ts`, which exists
   because exactly this race failed deterministically.
5. **Never hold an element across a render.** A resolved handle polls the
   node it resolved, so a re-render turns every later poll into a
   stale-element round trip the driver has to detect and refetch — that
   is where the suite's `stale element - terminating request` warnings
   came from, in `31-print`, `137-scan` and `145-multi-window` alike.
   Keep the SELECTOR in a constant and ask for it again each time, and
   use `waitForDisplayedSelector` from the harness where the wait itself
   spans the render.
6. **Never call WDIO's `scrollIntoView()` on an element handle.** It
   composes a wheel gesture through the Actions API, whose origin must
   already lie inside the viewport, so anything currently off screen
   raises `move target out of bounds` and silently falls back to the Web
   API. `scrollIntoReach` in the harness calls the DOM's own
   `scrollIntoView` inside the page instead — which is also why the
   `node?.scrollIntoView(...)` calls inside a `browser.execute` are fine
   — and returns the centre point only once a hit test lands on the
   element, because a coordinate the pointer can be moved to is not yet a
   coordinate the element's own handler sees.
7. **`await $$(sel)` is not the resolved array.** `ChainablePromiseArray`
   declares no `then`, so TypeScript leaves `.length` as
   `Promise<number>` and a length comparison silently compares against a
   promise. Use `await $$(sel).getElements()` when the array is what you
   want, and the chainable's own async `map`/`length` when it is not.

## Tooling

WebdriverIO drives W3C WebDriver through `tauri-driver` → `msedgedriver`,
exercising the as-built binary directly and matching Tauri's official
example shape.
