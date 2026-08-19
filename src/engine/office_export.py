"""Export a PDF to an editable Office, web or plain-text format.

The door is one dispatcher over two kinds of producer, and which kind a target
takes is a property of the FORMAT, not of what happens to be bundled.

LibreOffice is bundled and invoked as an isolated subprocess — unmodified
upstream, never linked into this app's code. The tree is MPL-2.0 apart from the
PDF-import helper these targets depend on, which is GPL-2.0-or-later; see
THIRD-PARTY-LICENSES.md § LibreOffice and scripts/libreoffice-notices.tsv.

Import quirk that shapes the LibreOffice half: LibreOffice imports EVERY PDF as a
**Draw** document. Draw exports cleanly to web/vector/image targets (HTML, XHTML),
but the Writer word-processing filters (.docx/.rtf/.odt) cannot write a Draw
document — `soffice --convert-to docx` on a PDF fails at the write step
("SfxBaseModel::impl_store … 0xc10"). So Writer targets go through a two-step
bridge: PDF → HTML (Draw's own export, which carries the real text) → the Writer
format (Writer opens the HTML and saves it out). The bridge preserves editable
text — verified: a born-digital PDF's sentences come back as real ``<w:t>`` runs,
not a page image.

The same import quirk is why the spreadsheet and presentation targets do NOT go
through it: the conversion changes the container, not the document model, and a
spreadsheet filter cannot write a drawing. Those targets are produced from the
document's own text and geometry instead.

`engine.soffice` provides the isolated offline profile, size-derived timeout,
and output validation used by conversions in both directions.
"""

import os
import shutil
import tempfile
import zipfile
from pathlib import Path

from engine.soffice import run_convert

LIBREOFFICE = "libreoffice"
ENGINE = "engine"


class _Target:
    """One export target: its extension, its producer, and its option names."""

    __slots__ = ("ext", "producer", "convert_to", "bridged", "options")

    def __init__(self, ext, producer, convert_to=None, bridged=False, options=()):
        self.ext = ext
        self.producer = producer
        self.convert_to = convert_to
        self.bridged = bridged
        self.options = tuple(options)


# The filter strings are LibreOffice's registered filter names; the Writer ones
# are only reachable through the bridge (see the module docstring).
_FORMATS = {
    "docx": _Target(".docx", LIBREOFFICE, "docx:MS Word 2007 XML", True),
    "rtf": _Target(".rtf", LIBREOFFICE, "rtf:Rich Text Format", True),
    "odt": _Target(".odt", LIBREOFFICE, "odt:writer8", True),
    "html": _Target(".html", LIBREOFFICE, "html"),
    # The DRAW flavour of the XHTML filter, because a PDF imports as a Draw
    # document: the Writer flavour accepts the job, exits zero and writes a
    # zero-byte file.
    "xhtml": _Target(".xhtml", LIBREOFFICE, "xhtml:XHTML Draw File"),
    "txt": _Target(".txt", ENGINE, options=("pages", "layout", "page_breaks")),
    "xlsx": _Target(
        ".xlsx", ENGINE, options=("pages", "sheet_per", "include_untabled", "regions")
    ),
    "pptx": _Target(".pptx", ENGINE, options=("pages", "slide_size")),
}

# Every option name any target declares. An option a target does not declare is
# refused rather than ignored: a silently dropped option is a silently wrong
# output that still reports success.
_ALL_OPTIONS = (
    "pages", "layout", "page_breaks", "sheet_per", "include_untabled", "slide_size", "regions",
)


def supported_formats() -> dict:
    """The export targets this build offers (for the UI + CLI help)."""
    return {
        "formats": [
            {"key": key, "ext": target.ext, "options": list(target.options)}
            for key, target in sorted(_FORMATS.items())
        ]
    }


def target_extension(fmt: str) -> str:
    """The extension a target writes, dot included. The one place a caller
    building an output name reads it from — a folder sweep that spelled the
    extension itself would drift the moment a target's changed."""
    key = str(fmt).lower()
    if key not in _FORMATS:
        raise ValueError(f"unsupported export format {fmt!r} (have {sorted(_FORMATS)})")
    return _FORMATS[key].ext


def _reject_unknown_options(key: str, target: _Target, given: dict) -> None:
    for name in _ALL_OPTIONS:
        if given.get(name) is None:
            continue
        if name not in target.options:
            raise ValueError(f"the {key} export takes no {name} option")


def export_document(
    file: str,
    output: str,
    fmt: str,
    soffice_path: str = "",
    pages=None,
    layout=None,
    page_breaks=None,
    sheet_per=None,
    include_untabled=None,
    slide_size=None,
    regions=None,
    gs_path: str = "",
) -> dict:
    """Export ``file`` to ``output`` in ``fmt``.

    Args:
        file: input PDF path.
        output: destination path (the caller's chosen name + extension).
        fmt: one of ``supported_formats()``.
        soffice_path: path to the LibreOffice ``soffice`` executable. Required
            only by the LibreOffice-produced targets.
        pages: list of 1-based page numbers, or 'all'.
        layout: text ordering, for the plain-text target.
        page_breaks: write a form feed between pages, for the plain-text target.
        sheet_per: sheet grouping, for the spreadsheet target.
        include_untabled: carry the text no table claimed, for the spreadsheet
            target.
        slide_size: deck dimensions, for the presentation target.
        regions: a reviewed table set, for the spreadsheet target. Detection
            does not run when it is given.
        gs_path: path to the Ghostscript executable. Required only by the
            presentation target, which renders each page's graphics.
    """
    key = str(fmt).lower()
    if key not in _FORMATS:
        raise ValueError(f"unsupported export format {fmt!r} (have {sorted(_FORMATS)})")
    target = _FORMATS[key]
    given = {
        "pages": pages,
        "layout": layout,
        "page_breaks": page_breaks,
        "sheet_per": sheet_per,
        "include_untabled": include_untabled,
        "slide_size": slide_size,
        "regions": regions,
    }
    _reject_unknown_options(key, target, given)

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

    if target.producer == ENGINE:
        return _export_engine(key, input_path, output_path, given, gs_path)
    return _export_libreoffice(key, target, input_path, output_path, soffice_path)


def _export_engine(key, input_path, output_path, given, gs_path) -> dict:
    """Targets produced from the document's own text and geometry.

    These never touch LibreOffice, so an unprovisioned LibreOffice must not make
    them fail and must not be named in anything they raise.
    """
    pages = "all" if given["pages"] is None else given["pages"]
    if key == "txt":
        from engine.text_export import export_text

        return export_text(
            str(input_path),
            str(output_path),
            pages=pages,
            layout="reading" if given["layout"] is None else given["layout"],
            page_breaks=bool(given["page_breaks"]),
        )
    if key == "xlsx":
        from engine.table_export import export_tables

        return export_tables(
            str(input_path),
            str(output_path),
            # A reviewed set names its own pages, so the scope is not defaulted
            # over it: `pages` reaching the reviewed arm at all is the refusal.
            pages=given["pages"] if given["regions"] is not None else pages,
            sheet_per="table" if given["sheet_per"] is None else given["sheet_per"],
            include_untabled=bool(given["include_untabled"]),
            regions=given["regions"],
        )
    if key == "pptx":
        from engine.slide_export import export_slides

        return export_slides(
            str(input_path),
            str(output_path),
            pages=pages,
            slide_size="page" if given["slide_size"] is None else given["slide_size"],
            gs_path=gs_path,
        )
    raise ValueError(f"unsupported export format {key!r} (have {sorted(_FORMATS)})")


# What proves a produced file carries a DOCUMENT rather than an empty wrapper.
# A package format is proven by its body part, a flat format by the element that
# opens its body. Neither an exit code nor a byte count proves it: a filter that
# cannot express the source can still write a well-formed, non-empty file with
# none of the source in it.
_BODY_PART = {"docx": "word/document.xml", "odt": "content.xml"}
_BODY_MARKER = {"rtf": b"{\\rtf", "html": b"<body", "xhtml": b"<body"}


def _verify_produced(key: str, produced: Path) -> None:
    part = _BODY_PART.get(key)
    if part is not None:
        try:
            with zipfile.ZipFile(produced) as package:
                present = part in package.namelist()
        except (OSError, zipfile.BadZipFile):
            present = False
        if not present:
            raise RuntimeError(
                f"the conversion wrote a {key} file that carries no document content"
            )
        return
    marker = _BODY_MARKER.get(key)
    if marker is None:
        return
    body = produced.read_bytes()
    if marker.lower() not in body.lower():
        raise RuntimeError(
            f"the conversion wrote a {key} file that carries no document content"
        )


def _export_libreoffice(key, target, input_path, output_path, soffice_path) -> dict:
    if not str(soffice_path).strip():
        raise RuntimeError("LibreOffice is not available (no soffice path)")

    work = Path(tempfile.mkdtemp(prefix="lo-export-"))
    try:
        if target.bridged:
            # PDF -> HTML (carries the real text) -> the Writer format.
            html = run_convert(soffice_path, "html", input_path, work, ".html")
            produced = run_convert(soffice_path, target.convert_to, html, work, target.ext)
        else:
            produced = run_convert(
                soffice_path, target.convert_to, input_path, work, target.ext
            )
        _verify_produced(key, produced)

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
