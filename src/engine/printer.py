"""Print a PDF to a Windows printer via Ghostscript's mswinpr2 device.

Same arm's-length-subprocess posture as compress/grayscale/PDF-A (the AGPL
boundary is the process boundary). mswinpr2 renders through the installed
Windows printer driver, so anything the driver can print, this can.

Copies are printed as N sequential Ghostscript jobs, NOT -dNumCopies: the
documented mswinpr2 surface (OutputFile/NoCancel + PostScript UserSettings)
does not include a copies control, and a driver-dependent flag that silently
prints one copy where it isn't honored is a broken feature. N identical jobs
are deterministic on every driver, and arrive collated as a bonus.
"""

import re
import subprocess
import sys
from pathlib import Path

import pikepdf

from .validate import validate_pdf

# Per-job timeout. A print job renders every page through the driver at its
# native resolution; generous, but not unbounded.
JOB_TIMEOUT_S = 600

MAX_COPIES = 99

# Scale-mode switches (§ 3.4's fit/actual). Both pin the media to the
# printer's paper (-dFIXEDMEDIA); the PDF page-size request must never win
# over the physical paper.
#   fit    — scale the page to the paper (Acrobat's "Fit").
#   actual — 1:1 at the printable origin; content larger than the paper
#            clips, by design. NOT centered: Ghostscript has no sound switch
#            for centering under FIXEDMEDIA (-dCenterPages is silently
#            ignored — caught by TestPrintFitSemantics, which renders these
#            exact switch lists through a raster device), and the known
#            workaround (injecting a computed per-page BeginPage translate
#            table in PostScript) is placement-altering cleverness a print
#            path should not carry. 100% scale is the contract; anchoring is
#            the driver's origin.
FIT_SWITCHES: dict[str, list[str]] = {
    "fit": ["-dFIXEDMEDIA", "-dFitPage"],
    "actual": ["-dFIXEDMEDIA"],
}


def parse_page_spec(spec: str, page_count: int) -> str:
    """Validate a print range like "1-3,5" against the document.

    Returns the normalized spec (whitespace stripped) for -sPageList, or
    raises ValueError. Empty/whitespace input means "all pages" and returns
    "". Strict on purpose (the 2e lesson: a lax parse turned a typo into a
    whole-document operation): every token must be N or N-M, 1-based,
    ascending, within the document.
    """
    normalized = spec.replace(" ", "")
    if not normalized:
        return ""
    tokens = normalized.split(",")
    for token in tokens:
        # ASCII-only on purpose: Python's int() happily parses unicode digits
        # ("١٢" == 12), but the normalized string goes to gs -sPageList
        # VERBATIM — a token int() accepts and gs's parser doesn't would pass
        # validation here and fail the job downstream.
        m = re.fullmatch(r"(\d+)(?:-(\d+))?", token, flags=re.ASCII)
        if not m:
            raise ValueError(f"Invalid page range token: '{token or spec}'")
        start = int(m.group(1))
        end = int(m.group(2)) if m.group(2) is not None else start
        if start < 1 or end < 1:
            raise ValueError(f"Page numbers are 1-based: '{token}'")
        if end < start:
            raise ValueError(f"Descending page range: '{token}'")
        if end > page_count:
            raise ValueError(
                f"Page {end} is beyond the document ({page_count} page"
                f"{'s' if page_count != 1 else ''})"
            )
    return normalized


def printer_exists(name: str) -> bool:
    """True if Windows can open the named printer (ctypes → winspool).

    This check is what makes an unknown printer FAIL FAST: gs's mswinpr2,
    handed a name it can't open, does not error — it falls back to raising
    its own printer-selection dialog, which from a headless subprocess is an
    invisible window that hangs the job until the timeout (observed live:
    exactly 600s, caught by the M-P e2e). The name must be proven real
    before gs ever spawns.
    """
    if sys.platform != "win32":  # engine ships Windows-only; keep tests portable
        return True
    import ctypes
    from ctypes import wintypes

    winspool = ctypes.WinDLL("winspool.drv")
    winspool.OpenPrinterW.argtypes = [
        wintypes.LPWSTR, ctypes.POINTER(wintypes.HANDLE), ctypes.c_void_p,
    ]
    winspool.OpenPrinterW.restype = wintypes.BOOL
    winspool.ClosePrinter.argtypes = [wintypes.HANDLE]
    winspool.ClosePrinter.restype = wintypes.BOOL

    handle = wintypes.HANDLE()
    if not winspool.OpenPrinterW(name, ctypes.byref(handle), None):
        return False
    winspool.ClosePrinter(handle)
    return True


def build_gs_args(
    file: str, printer: str, pages: str, fit: str, gs_path: str
) -> list[str]:
    """The exact Ghostscript argv for one print job (pure; unit-tested).

    `pages` must already be validated/normalized by parse_page_spec.
    """
    args = [
        gs_path,
        "-dNOPAUSE",
        "-dBATCH",
        "-dQUIET",
        "-dSAFER",
        "-sDEVICE=mswinpr2",
        # Headless subprocess: no progress window, and the printer comes from
        # the OutputFile — gs must never raise its own printer-picker dialog.
        "-dNoCancel",
        f"-sOutputFile=%printer%{printer}",
        *FIT_SWITCHES[fit],
    ]
    if pages:
        args.append(f"-sPageList={pages}")
    args.append(str(Path(file)))
    return args


def print_pdf(
    file: str,
    printer: str,
    gs_path: str = "gs",
    pages: str = "",
    copies: int = 1,
    fit: str = "fit",
) -> dict:
    """Print a PDF to a named Windows printer.

    Args:
        file: Input PDF path.
        printer: Exact Windows printer name (never empty — an empty name
            would make mswinpr2 prompt with its own dialog).
        gs_path: Path to the Ghostscript executable.
        pages: Page range like "1-3,5"; empty = all pages.
        copies: 1..99; printed as that many sequential jobs (see module doc).
        fit: "fit" (scale to paper) or "actual" (1:1).
    """
    validate_pdf(file)

    if not printer or not printer.strip():
        raise ValueError("No printer specified")
    if not isinstance(copies, int) or isinstance(copies, bool):
        raise ValueError(f"Copies must be a whole number, got {copies!r}")
    if not 1 <= copies <= MAX_COPIES:
        raise ValueError(f"Copies must be between 1 and {MAX_COPIES}, got {copies}")
    if fit not in FIT_SWITCHES:
        raise ValueError(f"Unknown fit mode '{fit}' (expected 'fit' or 'actual')")
    if not printer_exists(printer):
        raise ValueError(f"Unknown printer: '{printer}'")

    with pikepdf.open(file) as pdf:
        page_count = len(pdf.pages)
    page_list = parse_page_spec(pages, page_count)

    args = build_gs_args(file, printer, page_list, fit, gs_path)
    for _ in range(copies):
        try:
            result = subprocess.run(
                args,
                capture_output=True,
                text=True,
                timeout=JOB_TIMEOUT_S,
                # stdin isolation: gs must never inherit the RPC pipe
                # (distill review; -dSAFER does not sandbox std streams).
                stdin=subprocess.DEVNULL,
            )
        except subprocess.TimeoutExpired:
            raise RuntimeError(
                f"Print job timed out after {JOB_TIMEOUT_S}s — the printer "
                "driver did not respond"
            ) from None
        if result.returncode != 0:
            # mswinpr2 reports driver/printer failures on stdout as often as
            # stderr; forward whichever has content.
            detail = (result.stderr or "").strip() or (result.stdout or "").strip()
            raise RuntimeError(f"Ghostscript print failed: {detail or 'unknown error'}")

    return {
        "printer": printer,
        "copies": copies,
        "pages": page_list or "all",
        "fit": fit,
        "page_count": page_count,
    }
