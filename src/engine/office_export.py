"""Export a PDF to an editable Office or web format via LibreOffice.

LibreOffice is bundled and invoked as an isolated subprocess (the Ghostscript
model — unmodified upstream, redistributed under MPL-2.0; see
THIRD-PARTY-LICENSES.md § LibreOffice). It is never linked into this app's code.

Import quirk that shapes this module: LibreOffice imports EVERY PDF as a **Draw**
document. Draw exports cleanly to web/vector/image targets (HTML, XHTML), but the
Writer word-processing filters (.docx/.rtf/.odt) cannot write a Draw document —
`soffice --convert-to docx` on a PDF fails at the write step ("SfxBaseModel::
impl_store … 0xc10"). So Writer targets go through a two-step bridge: PDF → HTML
(Draw's own export, which carries the real text) → the Writer format (Writer opens
the HTML and saves it out). The bridge preserves editable text — verified: a
born-digital PDF's sentences come back as real ``<w:t>`` runs, not a page image.

`engine.soffice` provides the isolated offline profile, size-derived timeout,
and output validation used by conversions in both directions.
"""

import os
import shutil
import tempfile
from pathlib import Path

from engine.soffice import run_convert

# format key -> (extension, soffice --convert-to filter, needs the HTML bridge)
# The filter strings are LibreOffice's registered filter names; the Writer ones
# are only reachable through the bridge (see the module docstring).
_FORMATS = {
    "docx": (".docx", "docx:MS Word 2007 XML", True),
    "rtf": (".rtf", "rtf:Rich Text Format", True),
    "odt": (".odt", "odt:writer8", True),
    "html": (".html", "html", False),
    "xhtml": (".xhtml", "xhtml:XHTML Writer File", False),
}


def supported_formats() -> dict:
    """The export targets this build offers (for the UI + CLI help)."""
    return {"formats": sorted(_FORMATS.keys())}


def export_document(file: str, output: str, fmt: str, soffice_path: str) -> dict:
    """Export ``file`` to ``output`` in ``fmt`` via bundled LibreOffice.

    Args:
        file: input PDF path.
        output: destination path (the caller's chosen name + extension).
        fmt: one of ``supported_formats()``.
        soffice_path: path to the LibreOffice ``soffice`` executable.
    """
    key = str(fmt).lower()
    if key not in _FORMATS:
        raise ValueError(f"unsupported export format {fmt!r} (have {sorted(_FORMATS)})")
    want_ext, convert_to, bridged = _FORMATS[key]

    input_path = Path(file)
    output_path = Path(output)
    if not input_path.is_file():
        raise ValueError(f"input file not found: {file}")
    # A zero-byte input can still produce a zero exit code, so validate first.
    if input_path.stat().st_size == 0:
        raise ValueError(f"the input file is empty: {file}")
    # A directory destination would make shutil.move drop the file INSIDE it
    # under the intermediate's stem (e.g. a bridge's HTML-stem name) while we
    # report `output` + a directory's stat size — a silent misplace + a
    # false-success signal (the CLI passes any PathBuf straight through). Refuse.
    if output_path.is_dir():
        raise ValueError(f"output path is a directory, not a file: {output}")
    # Never let the export overwrite its own source through a path alias — the
    # same identity guard the distill/redact family uses.
    if input_path.exists() and output_path.exists() and os.path.samefile(input_path, output_path):
        raise ValueError("output path is the same file as the input")
    if not str(soffice_path).strip():
        raise RuntimeError("LibreOffice is not available (no soffice path)")

    work = Path(tempfile.mkdtemp(prefix="lo-export-"))
    try:
        if bridged:
            # PDF -> HTML (carries the real text) -> the Writer format.
            html = run_convert(soffice_path, "html", input_path, work, ".html")
            produced = run_convert(soffice_path, convert_to, html, work, want_ext)
        else:
            produced = run_convert(soffice_path, convert_to, input_path, work, want_ext)

        output_path.parent.mkdir(parents=True, exist_ok=True)
        # A read-only existing target (a re-export over a prior output) must not
        # break the move — clear the attribute first (the mirror-output lesson).
        if output_path.exists():
            try:
                os.chmod(output_path, 0o666)
            except OSError:
                pass
        shutil.move(str(produced), str(output_path))
        return {"output": str(output_path), "format": key, "size": output_path.stat().st_size}
    finally:
        shutil.rmtree(work, ignore_errors=True)
