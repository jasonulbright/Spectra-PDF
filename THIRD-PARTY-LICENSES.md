# Third-Party Licenses

Open PDF Studio's own code is MIT-licensed (see [LICENSE](LICENSE)). The application
**vendors** several third-party components (per the "vendor everything that isn't a
first-party system prerequisite" approach). Each is listed below with its license
and source. First-party system prerequisites that are **not** vendored — Microsoft
WebView2, the MSVC runtime — are obtained from the user's Windows installation.

## Ghostscript

- **Version:** 10.07.1 (unmodified upstream)
- **License:** GNU Affero General Public License v3.0 (AGPL-3.0)
- **Role:** Invoked by Open PDF Studio as a separate process (no linking) for
  compression, grayscale conversion, and PDF/A output.
- **Binary source:** <https://github.com/ArtifexSoftware/ghostpdl-downloads/releases/tag/gs10071>
- **Corresponding source:** <https://github.com/ArtifexSoftware/ghostpdl-downloads/releases/download/gs10071/ghostpdl-10.07.1.tar.gz>
- **License text shipped at:** `resources/ghostscript/LICENSE-Ghostscript.txt`

Because Open PDF Studio is open-source and invokes Ghostscript as an independent
program (mere aggregation), the two may be distributed together. Ghostscript
remains under the AGPL-3.0; its complete corresponding source is available at the
link above.

## LibreOffice

- **Version:** current stable (unmodified upstream; not version-pinned — the
  bundling script vendors whatever stable release it downloads)
- **License:** Mozilla Public License v2.0 (MPL-2.0)
- **Role:** Invoked by Open PDF Studio as a separate process (`soffice
  --headless`, no linking) to export a PDF to editable Word (.docx), RTF, ODT,
  HTML, and XHTML (the O1 export feature).
- **Binary source:** <https://www.libreoffice.org/download/download/>
- **Corresponding source:** <https://www.libreoffice.org/about-us/source-code/>
- **License text shipped at:** `resources/libreoffice/LICENSE` (from the
  upstream install; the bundling script copies it in)

LibreOffice is invoked as an independent program (mere aggregation), so the two
may be distributed together. LibreOffice remains under the MPL-2.0; its complete
corresponding source is available at the link above.

## Embedded Python runtime

- **CPython 3.14.5** — Python Software Foundation License (PSF) — <https://www.python.org/>

Bundled Python packages (installed into the embedded runtime):

| Package | License | Source |
|---------|---------|--------|
| pikepdf 10.7.2 | MPL-2.0 | <https://github.com/pikepdf/pikepdf> |
| pdfminer.six 20260107 | MIT | <https://github.com/pdfminer/pdfminer.six> |
| cryptography | Apache-2.0 / BSD-3-Clause | <https://github.com/pyca/cryptography> |
| cffi | MIT | <https://github.com/python-cffi/cffi> |
| lxml | BSD-3-Clause | <https://github.com/lxml/lxml> |
| pycparser | BSD-3-Clause | <https://github.com/eliben/pycparser> |

## Fonts

**Liberation Sans, Liberation Serif, Liberation Mono** (Regular) —
© Red Hat / the Liberation Fonts project, licensed under the **SIL Open
Font License 1.1**. Bundled (vendored by `scripts/sync-edit-fonts.ps1`
into the app's `fonts` resources) as the Edit tool's replacement font
family: when a document's own font cannot express a typed character, the
edited run is re-rendered in a subset of the face matching that font's
style (serif documents convert in serif, monospaced in monospaced). All
three are metric-compatible with the corresponding Microsoft core fonts.
License text: https://github.com/liberationfonts/liberation-fonts/blob/main/LICENSE

**Libertinus Serif** (Regular, Bold, Italic, Bold Italic) —
© The Libertinus Project (Philipp H. Poll and contributors), licensed
under the **SIL Open Font License 1.1**. Bundled (vendored by
`scripts/sync-edit-fonts.ps1`, hash-pinned) as the Edit tool's
**feature-bearing** family (Phase 9.K2): unlike Liberation, these OTF
(CFF) faces carry real OpenType features — small caps (`smcp`/`c2sc`) and
stylistic alternates (`salt`). They are an explicit opt-in, never an
automatic substitution: Liberation remains the sole metric-compatible
fallback, and Libertinus Serif is used only when a document's own font
lacks a requested feature and the user asks to apply small caps or
alternates (or authors new text with them).
License text: https://github.com/alerque/libertinus/blob/master/OFL.txt

## Frontend / runtime libraries

Bundled into the WebView2 renderer (see `package.json` for exact versions):
React (MIT), pdf.js (Apache-2.0), @dnd-kit (MIT), Radix UI (MIT), Tailwind CSS (MIT).

Rust crates compiled into the backend are listed in `src-tauri/Cargo.toml` /
`Cargo.lock`; Tauri and its plugins are MIT / Apache-2.0.

## PDFx

- **Author:** Alex (Alexandros) Gounis
- **License:** MIT
- **Source:** <https://github.com/AlexandrosGounis/pdfx>
- **Role:** Open PDF Studio's multi-document canvas plumbing (layout,
  drag controllers, zoom, lazy rendering), OCR worker integration, search
  engine, and the `.pdfx` single-file/multi-document format originated as
  ports from PDFx and have been adapted and extended throughout. The
  `.pdfx` format itself is his design: several documents stored as one
  ordinary, fully compatible PDF.

Per the MIT license's terms, its copyright and permission notice:

```
MIT License

Copyright (c) 2026 Alex Gounis

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
