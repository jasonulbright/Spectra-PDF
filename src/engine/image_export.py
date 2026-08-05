"""Export PDF pages as raster images via bundled Ghostscript (image half).

Why Ghostscript and not the LibreOffice route the Office exports use:
LibreOffice's CLI image export renders the FIRST page only — useless for a
multi-page document. The gs raster is already bundled, already trusted for
visual compare (`compare.py`) and printing, and renders every page.

Formats:
  png / jpeg — one file PER PAGE. The user's chosen name is treated as the
      naming template: a single rendered page gets exactly that name; multiple
      pages get ``<stem>-<n><ext>`` via gs's ``%d`` output template (1-based,
      numbered in RENDER order — page 3 of a "3,5" selection is ``-1``).
  tiff — ONE multi-page file (tiff24nc / tifflzw-gray), the archival shape.

The user's own ``%`` characters in the output name are escaped (``%%``) before
our ``%d`` is appended — gs treats ``%`` as a template character, and a name
like "Q4 50% off.png" would otherwise silently splinter (the distill review's
class). Page selection reuses the print dialog's strict ``parse_page_spec``
(the lesson: a lax parse turns a typo into a whole-document run).
"""

import subprocess
from pathlib import Path

import pikepdf

from .printer import parse_page_spec
from .validate import validate_pdf

# format -> (color device, grayscale device, extension, one file per page?)
_FORMATS = {
    "png": ("png16m", "pnggray", ".png", True),
    "jpeg": ("jpeg", "jpeggray", ".jpg", True),
    "tiff": ("tiff24nc", "tifflzw", ".tiff", False),
}

_MIN_DPI, _MAX_DPI = 18, 1200
_TIMEOUT = 600  # a 1,000-page doc at 300 dpi is minutes, not the default 300s


def _pages_in_spec(spec: str, page_count: int) -> int:
    """How many pages a validated -sPageList spec selects ('' = all)."""
    if not spec:
        return page_count
    n = 0
    for token in spec.split(","):
        if "-" in token:
            a, b = token.split("-")
            n += int(b) - int(a) + 1
        else:
            n += 1
    return n


def export_images(
    file: str,
    output: str,
    fmt: str = "png",
    dpi: int = 150,
    pages: str = "",
    gray: bool = False,
    quality: int = 90,
    gs_path: str = "gs",
) -> dict:
    """Render pages of ``file`` to raster images.

    Args:
        file: input PDF.
        output: destination name. For png/jpeg this is the naming template
            (multi-page renders become ``<stem>-<n><ext>``); for tiff it is the
            one multi-page file.
        fmt: png | jpeg | tiff.
        dpi: render resolution, clamped [18, 1200].
        pages: "1-3,5" style selection ('' = all), strict-validated.
        gray: grayscale devices instead of color.
        quality: JPEG quality 1-100 (jpeg only).
    """
    key = str(fmt).lower()
    if key not in _FORMATS:
        raise ValueError(f"unsupported image format {fmt!r} (have {sorted(_FORMATS)})")
    color_dev, gray_dev, ext, per_page = _FORMATS[key]
    device = gray_dev if gray else color_dev

    try:
        dpi = int(dpi)
    except (TypeError, ValueError):
        raise ValueError(f"dpi must be a number, got {dpi!r}")
    if not (_MIN_DPI <= dpi <= _MAX_DPI):
        raise ValueError(f"dpi must be {_MIN_DPI}-{_MAX_DPI}, got {dpi}")
    quality = max(1, min(100, int(quality)))

    validate_pdf(file)
    input_path = Path(file)
    output_path = Path(output)
    if output_path.is_dir():
        raise ValueError(f"output path is a directory, not a file: {output}")

    with pikepdf.open(file) as pdf:
        page_count = len(pdf.pages)
    spec = parse_page_spec(pages or "", page_count)
    n_pages = _pages_in_spec(spec, page_count)

    # Resolve the produced file names UP FRONT so the result can list exactly
    # what was written (and so a partial gs failure is detectable).
    out_dir = output_path.parent
    stem = output_path.stem
    if per_page and n_pages > 1:
        expected = [out_dir / f"{stem}-{i}{ext}" for i in range(1, n_pages + 1)]
        # gs template: user % escaped, then our literal %d.
        gs_out = str(out_dir / f"{stem}-".replace("%", "%%")) + "%d" + ext
    else:
        expected = [output_path]
        gs_out = str(output_path).replace("%", "%%")

    cmd = [
        gs_path,
        f"-sDEVICE={device}",
        f"-r{dpi}",
        "-dNOPAUSE",
        "-dBATCH",
        "-dQUIET",
        "-dSAFER",
        # Anti-aliasing: text at screen DPIs is unreadable without it.
        "-dTextAlphaBits=4",
        "-dGraphicsAlphaBits=4",
    ]
    if key == "jpeg":
        cmd.append(f"-dJPEGQ={quality}")
    if spec:
        cmd.append(f"-sPageList={spec}")
    cmd.extend([f"-sOutputFile={gs_out}", str(input_path)])

    result = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        timeout=_TIMEOUT,
        stdin=subprocess.DEVNULL,  # gs must never inherit the RPC pipe
    )
    if result.returncode != 0:
        raise RuntimeError(f"Ghostscript failed: {result.stderr.strip() or result.stdout.strip()}")

    missing = [str(p) for p in expected if not p.is_file()]
    if missing:
        raise RuntimeError(
            f"Ghostscript reported success but {len(missing)} expected output "
            f"file(s) are missing (first: {missing[0]})"
        )
    return {
        "outputs": [str(p) for p in expected],
        "format": key,
        "dpi": dpi,
        "pages_rendered": n_pages,
        "gray": bool(gray),
    }
