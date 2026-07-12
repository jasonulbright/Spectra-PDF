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

## Frontend / runtime libraries

Bundled into the WebView2 renderer (see `package.json` for exact versions):
React (MIT), pdf.js (Apache-2.0), @dnd-kit (MIT), Radix UI (MIT), Tailwind CSS (MIT).

Rust crates compiled into the backend are listed in `src-tauri/Cargo.toml` /
`Cargo.lock`; Tauri and its plugins are MIT / Apache-2.0.
