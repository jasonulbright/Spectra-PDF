"""Print a PDF to a Windows printer via Ghostscript's mswinpr2 device.

Same arm's-length-subprocess posture as compress/grayscale/PDF-A (the AGPL
boundary is the process boundary). mswinpr2 renders through the installed
Windows printer driver, so anything the driver can print, this can.

The operation supports the full print dialog: subset, reverse, collate, duplex,
paper size, orientation, color, comments modes, print-as-image, and the
layout modes (multiple-per-sheet, booklet, poster, custom scale). Two
mechanism families implement it:

- DRIVER (DEVMODE) options ride the job's Ghostscript switches. Duplex is
  the standard page-device pair (-dDuplex/-dTumble -> dmDuplex; documented
  for mswinpr2). Paper / orientation / color / document name go through the
  device's /UserSettings dictionary via a setpagedevice prolog — the old
  ``finddevice putdeviceprops`` incantation is REMOVED in gs 10.x
  (probe-verified); setpagedevice forwards because mswinpr2 exports
  /UserSettings. The key->DEVMODE mapping (Paper->dmPaperSize,
  Orientation->dmOrientation, Color->dmColor) is source-verified against
  the bundled 10.07.1. Paper TRAY selection is NOT possible on this device
  (dmDefaultSource is hard-forced to automatic in gdevwpr2.c) — reported as
  blocked-external, not silently faked.
- PAGE-LEVEL options (order, subsets, duplication, annotation modes,
  flatten/rasterize, imposition) build a temporary, exactly-prepared PDF in
  print_layout.py and print THAT verbatim — deterministic on every driver.

Copies are printed as N sequential Ghostscript jobs when collated: the
UserSettings /Copies key exists but rides dmCopies, which a driver that
ignores it silently turns into ONE copy — N identical jobs are deterministic
on every driver and arrive collated by construction. Uncollated copies
duplicate pages (1,1,2,2,...) into the prepared file instead — one job.
The N-job trade-off is N renders; explicit and bounded.

DEVMODE effects cannot be integration-tested headlessly (every dialog-free
printer on a dev box is either real paper or raises a file prompt), so the
switch/prolog strings are pinned byte-exact by unit tests, the key mapping
is source-verified, and everything renderable is proven through raster
devices with the same switch lists (TestPrintFitSemantics and friends).

All print renders pass -dUseCropBox: the CropBox is what the viewer shows,
and printing the MediaBox of a cropped document would silently print
content the user cannot see.
"""

import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import pikepdf

from . import gs_capability
from .print_layout import (
    NUP_ORDERS,
    apply_subset,
    booklet_sides,
    build_sequence,
    expand_page_spec,
    flatten_pdf,
    impose_poster,
    impose_sheets,
    nup_cells,
    page_geometry,
    rasterize_pdf,
    render_preview,
    strip_annotations,
)
from .validate import validate_pdf

# Per-job timeout. A print job renders every page through the driver at its
# native resolution; generous, but not unbounded.
JOB_TIMEOUT_S = 600

# Sequential jobs make large copy counts slow, but the count is explicit user
# intent and must never be silently clamped below this documented limit.
MAX_COPIES = 999

# Scale-mode switches (the fit/actual). Both pin the media to the
# printer's paper (-dFIXEDMEDIA); the PDF page-size request must never win
# over the physical paper.
#   fit    — scale the page to the paper. Probe-pinned
#            bonus: FitPage also auto-rotates a landscape page onto portrait
#            media, which is what makes orientation="auto" free here.
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

# Duplex -> standard gs page-device params (mswinpr2: dev->Duplex/tumble ->
# dmDuplex, DMDUP_VERTICAL = flip on the long edge). "printer" omits the
# pair entirely so the driver's default (or the user's printer preferences)
# stays in charge.
DUPLEX_SWITCHES: dict[str, list[str]] = {
    "printer": [],
    "simplex": ["-dDuplex=false"],
    "long": ["-dDuplex=true", "-dTumble=false"],
    "short": ["-dDuplex=true", "-dTumble=true"],
}

# UserSettings integer values (DEVMODE constants).
_ORIENT_VALUES = {"portrait": 1, "landscape": 2}
_COLOR_VALUES = {"gray": 1, "color": 2}

_ANNOT_MODES = ("all", "document", "stamps")
_SUBSETS = ("all", "odd", "even")
_LAYOUTS = ("single", "nup", "booklet", "poster")

MIN_IMAGE_DPI, MAX_IMAGE_DPI = 72, 1200
MIN_SHEET_PT, MAX_SHEET_PT = 72.0, 14400.0

# Preview scratch dirs: distinctive prefix so cleanup can never be
# talked into removing anything else, plus an age-based sweep for dirs a
# crash orphaned.
PREVIEW_PREFIX = "spectrapdf-print-preview-"
PREVIEW_MAX_PAGES = 32
_PREVIEW_STALE_S = 3600


def parse_page_spec(spec: str, page_count: int) -> str:
    """Validate a print range like "1-3,5" against the document.

    Returns the normalized spec (whitespace stripped) for -sPageList, or
    raises ValueError. Empty/whitespace input means "all pages" and returns
    "". Strict on purpose (the lesson: a lax parse turned a typo into a
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
            # Count-neutral on purpose: an interpolated plural SUFFIX is one
            # placeholder in the refusal table, so every locale's translation
            # would re-emit the English "s" verbatim.
            raise ValueError(
                f"Page {end} is beyond the document ({page_count} pages in total)"
            )
    return normalized


def printer_exists(name: str) -> bool:
    """True if Windows can open the named printer (ctypes → winspool).

    This check is what makes an unknown printer FAIL FAST: gs's mswinpr2,
    handed a name it can't open, does not error — it falls back to raising
    its own printer-selection dialog, which from a headless subprocess is an
    invisible window that hangs the job until the timeout (observed live:
    exactly 600s, caught by the e2e). The name must be proven real
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


def _ps_escape(text: str) -> str:
    return text.replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")


def build_setpagedevice_ps(
    paper: int | None,
    orientation_value: int | None,
    color_value: int | None,
    document_name: str | None,
) -> str | None:
    """The -c setpagedevice prolog carrying mswinpr2 /UserSettings.

    Returns None when every entry is defaulted (no prolog — the argv stays
    switch-only, byte-identical to the original contract). DocumentName is
    what the spooler queue shows; kept printable-ASCII (a name the DEVMODE
    round-trip could garble is omitted rather than mojibake'd) and PS-escaped.
    """
    parts: list[str] = []
    if paper is not None:
        parts.append(f"/Paper {int(paper)}")
    if orientation_value is not None:
        parts.append(f"/Orientation {int(orientation_value)}")
    if color_value is not None:
        parts.append(f"/Color {int(color_value)}")
    if document_name:
        name = document_name[:200]
        if all(32 <= ord(c) < 127 for c in name):
            parts.append(f"/DocumentName ({_ps_escape(name)})")
    if not parts:
        return None
    return "<< /UserSettings << " + " ".join(parts) + " >> >> setpagedevice"


def build_gs_args(
    file: str,
    printer: str,
    pages: str,
    fit: str,
    gs_path: str,
    duplex: str = "printer",
    setpagedevice_ps: str | None = None,
) -> list[str]:
    """The exact Ghostscript argv for one print job (pure; unit-tested).

    `pages` must already be validated/normalized by parse_page_spec, and
    `fit` must be a FIT_SWITCHES key (the scale/layout modes bake their
    geometry into the prepared file and print it "fit" or "actual").
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
        # Print what the viewer shows: the CropBox, not the MediaBox.
        "-dUseCropBox",
        *FIT_SWITCHES[fit],
        *DUPLEX_SWITCHES[duplex],
    ]
    if pages:
        args.append(f"-sPageList={pages}")
    if setpagedevice_ps:
        args += ["-c", setpagedevice_ps, "-f"]
    args.append(str(Path(file)))
    return args


def _choice(name: str, value, options) -> None:
    if value not in options:
        raise ValueError(
            f"Unknown {name} {value!r} (expected one of {', '.join(map(str, options))})"
        )


def _require_bool(name: str, value) -> None:
    if not isinstance(value, bool):
        raise ValueError(f"{name} must be true or false, got {value!r}")


def _num(name: str, value, lo, hi) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{name} must be a number, got {value!r}")
    v = float(value)
    if not (lo <= v <= hi):
        raise ValueError(f"{name} must be between {lo:g} and {hi:g}, got {value!r}")
    return v


def _run_jobs(args: list[str], jobs: int) -> None:
    # The spool run is not a budget.gs shape (the timeout bounds a printer
    # DRIVER, not a document render), so availability is decided here instead:
    # `args[0]` is validated once and replaced with the probed path before the
    # first job spawns. Deciding it before the loop means an unusable
    # Ghostscript refuses by name rather than failing `copies` times.
    args = [gs_capability.require(args[0] if args else "").path, *args[1:]]
    for _ in range(jobs):
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


def print_pdf(
    file: str,
    printer: str,
    gs_path: str = "",
    pages: str = "",
    copies: int = 1,
    fit: str = "fit",
    scale_percent: float = 100,
    collate: bool = True,
    subset: str = "all",
    reverse: bool = False,
    duplex: str = "printer",
    paper: int | None = None,
    orientation: str = "auto",
    color: str = "printer",
    annots: str = "all",
    as_image: bool = False,
    image_dpi: int = 300,
    layout: str = "single",
    nup_rows: int = 2,
    nup_cols: int = 2,
    nup_order: str = "horizontal",
    nup_border: bool = False,
    nup_auto_rotate: bool = True,
    booklet_subset: str = "both",
    booklet_binding: str = "left",
    poster_scale: float = 100,
    poster_overlap: float = 0,
    poster_cut_marks: bool = False,
    poster_labels: bool = False,
    sheet_width: float | None = None,
    sheet_height: float | None = None,
    _preview: dict | None = None,
) -> dict:
    """Print a PDF to a named Windows printer (the full option contract).

    Args (beyond the original six):
        scale_percent: custom scale (fit="scale", layout "single" only).
        collate: False duplicates pages (1,1,2,2,...) into ONE job.
        subset: "all" | "odd" | "even" — document page-number parity.
        reverse: print back to front.
        duplex: "printer" | "simplex" | "long" | "short".
        paper: DMPAPER id from the printer's capability list; None = default.
        orientation: "auto" | "portrait" | "landscape".
        color: "printer" | "color" | "gray" (driver dmColor).
        annots: "all" | "document" | "stamps".
        as_image / image_dpi: rasterize before spooling.
        layout: "single" | "nup" | "booklet" | "poster".
        sheet_width/height: PORTRAIT paper size in points — required for the
            layout modes and custom scale (the caller resolves the real
            paper; this module never guesses).
    """
    validate_pdf(file)

    if not _preview and (not printer or not printer.strip()):
        raise ValueError("No printer specified")
    if not isinstance(copies, int) or isinstance(copies, bool):
        raise ValueError(f"Copies must be a whole number, got {copies!r}")
    if not 1 <= copies <= MAX_COPIES:
        raise ValueError(f"Copies must be between 1 and {MAX_COPIES}, got {copies}")
    _choice("fit mode", fit, ("fit", "actual", "scale"))
    _choice("subset", subset, _SUBSETS)
    _choice("duplex mode", duplex, tuple(DUPLEX_SWITCHES))
    _choice("orientation", orientation, ("auto", "portrait", "landscape"))
    _choice("color mode", color, ("printer", "color", "gray"))
    _choice("comments mode", annots, _ANNOT_MODES)
    _choice("layout", layout, _LAYOUTS)
    _require_bool("collate", collate)
    _require_bool("reverse", reverse)
    _require_bool("as_image", as_image)
    if paper is not None:
        if isinstance(paper, bool) or not isinstance(paper, int) or not 1 <= paper <= 32767:
            raise ValueError(f"Unknown paper id {paper!r}")
    if as_image:
        if isinstance(image_dpi, bool) or not isinstance(image_dpi, int):
            raise ValueError(f"Image DPI must be a whole number, got {image_dpi!r}")
        if not MIN_IMAGE_DPI <= image_dpi <= MAX_IMAGE_DPI:
            raise ValueError(
                f"Image DPI must be between {MIN_IMAGE_DPI} and {MAX_IMAGE_DPI}, got {image_dpi}"
            )
    if fit == "scale":
        if layout != "single":
            raise ValueError("Custom scale applies to the single-page layout only")
        scale_percent = _num("Scale percent", scale_percent, 1, 1000)
    if layout == "nup":
        for label, v in (("Rows", nup_rows), ("Columns", nup_cols)):
            if isinstance(v, bool) or not isinstance(v, int) or not 1 <= v <= 8:
                raise ValueError(f"{label} per sheet must be 1-8, got {v!r}")
        _choice("page order", nup_order, NUP_ORDERS)
        _require_bool("nup_border", nup_border)
        _require_bool("nup_auto_rotate", nup_auto_rotate)
    if layout == "booklet":
        _choice("booklet subset", booklet_subset, ("both", "front", "back"))
        _choice("booklet binding", booklet_binding, ("left", "right"))
    if layout == "poster":
        poster_scale = _num("Poster scale", poster_scale, 1, 2000)
        _require_bool("poster_cut_marks", poster_cut_marks)
        _require_bool("poster_labels", poster_labels)

    imposition = layout != "single" or fit == "scale"
    if imposition:
        if sheet_width is None or sheet_height is None:
            raise ValueError("This layout needs the paper size (sheet_width/sheet_height)")
        sheet_width = _num("Sheet width", sheet_width, MIN_SHEET_PT, MAX_SHEET_PT)
        sheet_height = _num("Sheet height", sheet_height, MIN_SHEET_PT, MAX_SHEET_PT)
        if layout == "poster":
            poster_overlap = _num(
                "Poster overlap", poster_overlap, 0, min(sheet_width, sheet_height) / 2
            )
    # Preview renders, never spools — no winspool gate (it must work while
    # the picker is still loading, and with zero printers installed).
    if not _preview and not printer_exists(printer):
        raise ValueError(f"Unknown printer: '{printer}'")

    with pikepdf.open(file) as pdf:
        page_count = len(pdf.pages)
    page_list = parse_page_spec(pages, page_count)

    order = apply_subset(expand_page_spec(page_list, page_count), subset)
    if not order:
        raise ValueError("The page selection is empty (no pages match)")
    if reverse:
        order = list(reversed(order))

    doc_name = Path(file).name
    # Copies and collation change the SPOOL, not what a sheet looks like —
    # preview ignores them (and never duplicates pages).
    uncollated_dup = (not collate) and copies > 1 and not _preview

    # Resolve orientation. Imposition authors the sheet shape, so DEVMODE
    # must match it explicitly; booklet is always 2-up on landscape sheets.
    if layout == "booklet":
        resolved_orient = "landscape"
    elif imposition:
        resolved_orient = orientation if orientation != "auto" else "portrait"
    else:
        resolved_orient = orientation  # may stay "auto" (no DEVMODE override)

    # The plain fast path — byte-stable with the original contract when the
    # new options are defaulted (plus any pure-switch options the driver
    # applies): no temp file, -sPageList carries the (ascending) selection.
    needs_reorder = order != sorted(set(order)) or uncollated_dup
    plain = (
        annots == "all"
        and not as_image
        and not imposition
        and not needs_reorder
    )
    rotate_prepass = False
    if orientation == "auto" and fit == "actual":
        # FitPage auto-rotates; bare FIXEDMEDIA does not — a landscape page
        # at actual size would print sideways-clipped. Normalize via /Rotate.
        geo = page_geometry(file)
        rotate_prepass = any(geo[i]["display_landscape"] for i in order)
        if rotate_prepass:
            plain = False

    us_ps = build_setpagedevice_ps(
        paper,
        _ORIENT_VALUES.get(resolved_orient),
        _COLOR_VALUES.get(color),
        doc_name,
    )

    stages: list[str] = []
    sheets_out: int | None = None

    # Preview mode: cap the WORK, not just the output, where that is sound
    # — single/nup output maps 1:1 onto a prefix of the selection, so the
    # prepass (flatten!) only touches what the first sheets show. Booklet
    # and poster read the whole selection (saddle order pulls from the end;
    # tiling spans a page) and cap at render time instead.
    total_sheets_hint: int | None = None
    preview_max = int(_preview.get("max_pages", 8)) if _preview else 0
    if _preview:
        if sheet_width is None or sheet_height is None:
            raise ValueError("Preview needs the paper size (sheet_width/sheet_height)")
        sheet_width = _num("Sheet width", sheet_width, MIN_SHEET_PT, MAX_SHEET_PT)
        sheet_height = _num("Sheet height", sheet_height, MIN_SHEET_PT, MAX_SHEET_PT)
        if layout == "single":
            total_sheets_hint = len(order)
            if not plain:
                order = order[:preview_max]
        elif layout == "nup":
            per = nup_rows * nup_cols
            total_sheets_hint = -(-len(order) // per)
            order = order[: preview_max * per]

    def _emit_preview(src: str, fit_mode: str, page_spec: str, total: int) -> dict:
        psw, psh = float(sheet_width), float(sheet_height)
        if resolved_orient == "landscape":
            psw, psh = max(psw, psh), min(psw, psh)
        out_dir = tempfile.mkdtemp(prefix=PREVIEW_PREFIX)
        images = render_preview(
            gs_path, src, out_dir, int(_preview.get("dpi", 72)),
            psw, psh, FIT_SWITCHES[fit_mode],
            gray=(color == "gray"), pages=page_spec,
        )
        return {
            "preview_dir": out_dir,
            "pages": images,
            "sheets": total,
            "truncated": len(images) < total,
            "layout": layout,
            "fit": fit,
            "orientation": resolved_orient,
            "annots": annots,
            "prepass": stages,
            "page_count": page_count,
        }

    if plain:
        if _preview:
            spec = ",".join(str(p + 1) for p in order[:preview_max])
            return _emit_preview(file, fit, spec, len(order))
        args = build_gs_args(file, printer, page_list, fit, gs_path, duplex, us_ps)
        jobs = copies
        _run_jobs(args, jobs)
    else:
        with tempfile.TemporaryDirectory(prefix="spectra-print-") as td:
            tdp = Path(td)
            current = file

            if annots != "all":
                stripped = str(tdp / "stripped.pdf")
                strip_annotations(current, stripped, annots)
                current = stripped
                stages.append("annotations")

            # Render stage (raster or flatten) consumes the ascending page
            # subset; positions in `order` remap into the rendered file.
            asc = sorted(set(order))
            asc_spec = ",".join(str(i + 1) for i in asc)
            remap = {p: i for i, p in enumerate(asc)}
            if as_image:
                rendered = str(tdp / "raster.pdf")
                rasterize_pdf(
                    gs_path, current, rendered, image_dpi, asc_spec,
                    gray=(color == "gray"),
                )
                current = rendered
                order = [remap[p] for p in order]
                stages.append(f"rasterize@{image_dpi}dpi")
            elif imposition:
                flat = str(tdp / "flat.pdf")
                flatten_pdf(gs_path, current, flat, asc_spec)
                current = flat
                order = [remap[p] for p in order]
                stages.append("flatten")

            if imposition:
                sw, sh = float(sheet_width), float(sheet_height)
                if resolved_orient == "landscape":
                    sw, sh = max(sw, sh), min(sw, sh)
                imposed = str(tdp / "imposed.pdf")
                if layout == "nup":
                    cells = nup_cells(sw, sh, nup_rows, nup_cols, nup_order)
                    per = len(cells)
                    sheet_defs = [
                        list(zip(order[i : i + per], cells))
                        for i in range(0, len(order), per)
                    ]
                    sheets_out = impose_sheets(
                        current, imposed, sheet_defs, sw, sh,
                        border=nup_border, auto_rotate=nup_auto_rotate,
                    )
                    stages.append(f"nup{nup_rows}x{nup_cols}")
                elif layout == "booklet":
                    sides = booklet_sides(len(order), booklet_binding)
                    if booklet_subset == "front":
                        sides = sides[0::2]
                    elif booklet_subset == "back":
                        sides = sides[1::2]
                    half = sw / 2
                    cells = [(0.0, 0.0, half, sh), (half, 0.0, half, sh)]
                    sheet_defs = [
                        [
                            (order[pos] if pos is not None else None, cells[ci])
                            for ci, pos in enumerate(side)
                        ]
                        for side in sides
                    ]
                    sheets_out = impose_sheets(
                        current, imposed, sheet_defs, sw, sh, auto_rotate=True,
                    )
                    stages.append("booklet")
                elif layout == "poster":
                    if order != list(range(len(order))):
                        seq = str(tdp / "sequence.pdf")
                        build_sequence(current, seq, order)
                        current = seq
                        stages.append("reorder")
                    result = impose_poster(
                        current, imposed, sw, sh,
                        scale=poster_scale / 100.0,
                        overlap=poster_overlap,
                        cut_marks=poster_cut_marks,
                        labels=poster_labels,
                    )
                    sheets_out = result["sheets"]
                    stages.append("poster")
                else:  # fit == "scale", 1-up
                    cell = (0.0, 0.0, sw, sh)
                    sheet_defs = [[(i, cell)] for i in order]
                    sheets_out = impose_sheets(
                        current, imposed, sheet_defs, sw, sh,
                        auto_rotate=False, scale_override=scale_percent / 100.0,
                    )
                    stages.append(f"scale@{scale_percent:g}%")
                current = imposed
            elif order != list(range(len(order) if as_image else page_count)) or rotate_prepass:
                # Pure reorder / rotate normalization (no imposition).
                seq = str(tdp / "sequence.pdf")
                build_sequence(
                    current, seq, order,
                    rotate_landscape_to_portrait=rotate_prepass,
                )
                current = seq
                stages.append("reorder" if not rotate_prepass else "reorder+rotate")

            final_fit = (
                "fit" if layout in ("nup", "booklet")
                else "actual" if (layout == "poster" or fit == "scale")
                else fit
            )

            if _preview:
                total = sheets_out if sheets_out is not None else (
                    total_sheets_hint if total_sheets_hint is not None else len(order)
                )
                spec = f"1-{preview_max}" if total > preview_max else ""
                # Renders while the TemporaryDirectory (and `current` in
                # it) is still alive; the PNGs land in their own dir.
                return _emit_preview(current, final_fit, spec, total)

            if uncollated_dup:
                with pikepdf.open(current) as prepared:
                    n_prepared = len(prepared.pages)
                dup_order = [p for p in range(n_prepared) for _ in range(copies)]
                dup = str(tdp / "uncollated.pdf")
                build_sequence(current, dup, dup_order)
                current = dup
                stages.append("uncollated-copies")

            args = build_gs_args(current, printer, "", final_fit, gs_path, duplex, us_ps)
            jobs = 1 if uncollated_dup else copies
            _run_jobs(args, jobs)

    result = {
        "printer": printer,
        "copies": copies,
        "collate": collate,
        "pages": page_list or "all",
        "subset": subset,
        "reverse": reverse,
        "fit": fit,
        "duplex": duplex,
        "orientation": resolved_orient,
        "color": color,
        "annots": annots,
        "layout": layout,
        "page_count": page_count,
        "jobs": jobs,
        "prepass": stages,
    }
    if sheets_out is not None:
        result["sheets"] = sheets_out
    if paper is not None:
        result["paper"] = paper
    if as_image:
        result["as_image"] = True
        result["image_dpi"] = image_dpi
    return result


def _remove_preview_dir(path: str) -> None:
    """Delete ONE preview dir — refused for anything that is not ours (the
    prefix + parent check is the traversal guard; this must never become a
    general rmtree reachable over RPC)."""
    p = Path(path)
    if not p.name.startswith(PREVIEW_PREFIX):
        return
    if p.parent != Path(tempfile.gettempdir()):
        return
    shutil.rmtree(p, ignore_errors=True)


def _sweep_stale_previews() -> None:
    """Crash hygiene: preview dirs older than an hour are orphans."""
    now = time.time()
    try:
        for p in Path(tempfile.gettempdir()).glob(PREVIEW_PREFIX + "*"):
            try:
                if now - p.stat().st_mtime > _PREVIEW_STALE_S:
                    shutil.rmtree(p, ignore_errors=True)
            except OSError:
                continue
    except OSError:
        pass


def print_preview_cleanup(directory: str) -> dict:
    """Dialog-close hook: delete the last preview dir without rendering
    anything. Same prefix guard as the in-call cleanup."""
    _remove_preview_dir(directory)
    _sweep_stale_previews()
    return {"removed": True}


def print_preview(
    file: str,
    gs_path: str = "",
    dpi: int = 72,
    max_pages: int = 8,
    cleanup_dir: str | None = None,
    **options,
) -> dict:
    """Render what the print job WILL produce, sheet by sheet.

    Runs the exact `print_pdf` validation and prepass — same code, so the
    preview cannot drift from the job — then renders the prepared sheets
    to PNGs on the same fixed medium and fit switches mswinpr2 would get.
    ``options`` takes the print wire keys (pages/subset/reverse/fit/layout/
    ... plus the REQUIRED sheet_width/sheet_height); printer/copies/collate
    are ignored — they change the spool, not the sheets. ``cleanup_dir``
    deletes the CALLER'S previous preview (prefix-guarded).

    Returns {"preview_dir", "pages": [png paths], "sheets", "truncated",
    ...}. The caller owns the returned dir until its next call (or a final
    cleanup); dirs older than an hour are swept as crash orphans.
    """
    if cleanup_dir:
        _remove_preview_dir(cleanup_dir)
    _sweep_stale_previews()

    if isinstance(dpi, bool) or not isinstance(dpi, int) or not 18 <= dpi <= 300:
        raise ValueError(f"Preview DPI must be 18-300, got {dpi!r}")
    if (
        isinstance(max_pages, bool)
        or not isinstance(max_pages, int)
        or not 1 <= max_pages <= PREVIEW_MAX_PAGES
    ):
        raise ValueError(f"Preview page cap must be 1-{PREVIEW_MAX_PAGES}, got {max_pages!r}")
    for key in ("printer", "copies", "collate", "gs_path", "_preview"):
        options.pop(key, None)

    return print_pdf(
        file=file,
        printer="",
        gs_path=gs_path,
        _preview={"dpi": dpi, "max_pages": max_pages},
        **options,
    )
