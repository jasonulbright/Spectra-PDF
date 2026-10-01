"""Submit a print job to the system's CUPS (Linux).

CUPS is user-supplied: `libcups.so.2` is loaded from the system with ctypes
when a job is submitted, and is never bundled. A system without it refuses by
name. The job goes through the destination API the CUPS Programming Manual
documents for printing a file: `cupsGetNamedDest` -> `cupsCopyDestInfo` ->
`cupsCreateDestJob` -> `cupsStartDestDocument` -> `cupsWriteRequestData` ->
`cupsFinishDestDocument`. The document is always submitted as
`application/pdf`; CUPS converts it for the destination.

Job options are IPP job-template attributes (RFC 8011 section 5.2 and PWG
5100.13): `page-ranges`, `sides`, `media`, `orientation-requested`,
`print-color-mode`, `print-scaling`. The destination's saved options (the
user's lpoptions defaults and an instance's options) are applied first and
the dialog's choices override them, the same precedence `lp` uses.

What is spooled is what the viewer shows: CUPS filters choose the page box
on their own, so a document whose pages carry a CropBox, or which is
encrypted, is spooled from a prepared copy whose MediaBox is the visible area
and which carries no encryption (the print permission was already checked).
The copy is written through the save seam into a private temporary folder
(mode 0700) that is removed once the jobs are submitted.
"""

from __future__ import annotations

import ctypes
import os
import re
import tempfile

from engine.credentials import open_pdf
from engine.pdf_save import save_pdf

LIBRARY = "libcups.so.2"

#: The only document format submitted.
FORMAT_PDF = b"application/pdf"

#: `HTTP_STATUS_CONTINUE`: a document request accepted and waiting for data.
_HTTP_STATUS_CONTINUE = 100
#: The last successful-ok status code (RFC 8011 section 4.1.6).
_IPP_STATUS_OK_MAX = 0x00FF

_CHUNK = 64 * 1024

#: A media keyword as CUPS reports it: PWG 5101.1 self-describing names and
#: the legacy names PPD-based destinations expose.
_MEDIA_KEYWORD = re.compile(r"[A-Za-z0-9][A-Za-z0-9_.\-]{0,126}")

#: Duplex control -> IPP `sides` (RFC 8011 section 5.2.8). "printer" sends
#: nothing, so the destination's default stays in charge.
SIDES = {
    "printer": None,
    "simplex": "one-sided",
    "long": "two-sided-long-edge",
    "short": "two-sided-short-edge",
}

#: Orientation control -> IPP `orientation-requested` enum (RFC 8011 section
#: 5.2.10): 3 portrait, 4 landscape. "auto" sends nothing.
ORIENTATION = {"auto": None, "portrait": "3", "landscape": "4"}

#: Colour control -> IPP `print-color-mode` (PWG 5100.13 section 6.2.3).
COLOR = {"printer": None, "color": "color", "gray": "monochrome"}

#: Fit control -> IPP `print-scaling` (PWG 5100.13 section 6.2.4): "fit"
#: scales the page to the paper, "actual" prints it at 100%.
SCALING = {"fit": "fit", "actual": "none"}


class _Option(ctypes.Structure):
    _fields_ = [("name", ctypes.c_char_p), ("value", ctypes.c_char_p)]


class _Dest(ctypes.Structure):
    _fields_ = [
        ("name", ctypes.c_char_p),
        ("instance", ctypes.c_char_p),
        ("is_default", ctypes.c_int),
        ("num_options", ctypes.c_int),
        ("options", ctypes.POINTER(_Option)),
    ]


_lib = None


def load_library():
    """The system's libcups with the entry points this module calls declared."""
    global _lib
    if _lib is not None:
        return _lib
    try:
        lib = ctypes.CDLL(LIBRARY)
    except OSError:
        raise RuntimeError(
            f"System printing needs CUPS ({LIBRARY}), which is not installed on this system."
        ) from None
    dest_p = ctypes.POINTER(_Dest)
    opts_p = ctypes.POINTER(_Option)
    vp = ctypes.c_void_p
    signatures = {
        "cupsGetNamedDest": (dest_p, [vp, ctypes.c_char_p, ctypes.c_char_p]),
        "cupsFreeDests": (None, [ctypes.c_int, dest_p]),
        "cupsCopyDestInfo": (vp, [vp, dest_p]),
        "cupsFreeDestInfo": (None, [vp]),
        "cupsAddOption": (
            ctypes.c_int,
            [ctypes.c_char_p, ctypes.c_char_p, ctypes.c_int, ctypes.POINTER(opts_p)],
        ),
        "cupsFreeOptions": (None, [ctypes.c_int, opts_p]),
        "cupsCreateDestJob": (
            ctypes.c_int,
            [vp, dest_p, vp, ctypes.POINTER(ctypes.c_int), ctypes.c_char_p, ctypes.c_int, opts_p],
        ),
        "cupsStartDestDocument": (
            ctypes.c_int,
            [vp, dest_p, vp, ctypes.c_int, ctypes.c_char_p, ctypes.c_char_p,
             ctypes.c_int, opts_p, ctypes.c_int],
        ),
        "cupsWriteRequestData": (ctypes.c_int, [vp, ctypes.c_char_p, ctypes.c_size_t]),
        "cupsFinishDestDocument": (ctypes.c_int, [vp, dest_p, vp]),
        "cupsCancelDestJob": (ctypes.c_int, [vp, dest_p, ctypes.c_int]),
        "cupsLastError": (ctypes.c_int, []),
        "cupsLastErrorString": (ctypes.c_char_p, []),
    }
    for name, (restype, argtypes) in signatures.items():
        try:
            fn = getattr(lib, name)
        except AttributeError:
            raise RuntimeError(
                f"The installed CUPS library ({LIBRARY}) has no {name}; it is too old for printing."
            ) from None
        fn.restype = restype
        fn.argtypes = argtypes
    _lib = lib
    return lib


def split_destination(name: str) -> tuple[str, str | None]:
    """`queue` or `queue/instance` -> (queue, instance). A queue name never
    contains `/` (lpadmin(8))."""
    queue, sep, instance = name.partition("/")
    return queue, (instance if sep and instance else None)


def _last_error(lib) -> str:
    text = lib.cupsLastErrorString()
    return text.decode("utf-8", "replace") if text else "unknown error"


def _named_dest(lib, name: str):
    queue, instance = split_destination(name)
    return lib.cupsGetNamedDest(
        None,
        queue.encode("utf-8"),
        instance.encode("utf-8") if instance else None,
    )


def destination_exists(name: str, lib=None) -> bool:
    """True when the print system knows the destination. An unreachable print
    system is a named failure, never a quiet no."""
    lib = lib or load_library()
    dest = _named_dest(lib, name)
    if dest:
        lib.cupsFreeDests(1, dest)
        return True
    if lib.cupsLastError() > _IPP_STATUS_OK_MAX and not _is_not_found(lib.cupsLastError()):
        detail = _last_error(lib)
        raise RuntimeError(f"The print system could not be reached: {detail}")
    return False


def _is_not_found(status: int) -> bool:
    # client-error-not-found (RFC 8011 section 4.1.6.2 0x0406).
    return status == 0x0406


def validate_media(paper) -> str:
    if not isinstance(paper, str) or not _MEDIA_KEYWORD.fullmatch(paper):
        raise ValueError(f"Unknown paper id {paper!r}")
    return paper


def job_options(
    pages: str,
    fit: str,
    duplex: str,
    paper: str | None,
    orientation: str,
    color: str,
) -> list[tuple[str, str]]:
    """The IPP job-template attributes for one job (pure; unit-tested).

    `pages` is already normalized by parse_page_spec; ascending and
    non-overlapping, as `page-ranges` requires (RFC 8011 section 5.2.7).
    """
    options: list[tuple[str, str]] = []
    if pages:
        options.append(("page-ranges", pages))
    options.append(("print-scaling", SCALING[fit]))
    for name, table, key in (
        ("sides", SIDES, duplex),
        ("orientation-requested", ORIENTATION, orientation),
        ("print-color-mode", COLOR, color),
    ):
        value = table[key]
        if value is not None:
            options.append((name, value))
    if paper is not None:
        options.append(("media", validate_media(paper)))
    return options


def _effective_box(page, key: str):
    box = page.obj.get(key)
    if box is None:
        return None
    x0, y0, x1, y1 = (float(v) for v in box)
    return min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1)


def _visible_area(page):
    """The page's CropBox clipped to its MediaBox (ISO 32000-2 14.11.2), or
    None when the two agree."""
    media = page.mediabox
    mx0, my0, mx1, my1 = (float(v) for v in media)
    media_rect = (min(mx0, mx1), min(my0, my1), max(mx0, mx1), max(my0, my1))
    crop = page.cropbox
    cx0, cy0, cx1, cy1 = (float(v) for v in crop)
    crop_rect = (min(cx0, cx1), min(cy0, cy1), max(cx0, cx1), max(cy0, cy1))
    if crop_rect == media_rect:
        return None
    clipped = (
        max(crop_rect[0], media_rect[0]),
        max(crop_rect[1], media_rect[1]),
        min(crop_rect[2], media_rect[2]),
        min(crop_rect[3], media_rect[3]),
    )
    if clipped[2] <= clipped[0] or clipped[3] <= clipped[1]:
        # An empty intersection displays nothing; the default CropBox is the
        # MediaBox (ISO 32000-2 Table 31), which is what a viewer falls back to.
        return None
    return clipped


def prepare_for_spool(source: str, workdir: str) -> str:
    """`source`, or a prepared copy CUPS filters print exactly as displayed.

    A copy is written when the document is encrypted (CUPS cannot open it) or
    when any page's CropBox narrows its MediaBox.
    """
    import pikepdf

    with open_pdf(source) as pdf:
        changed = False
        for page in pdf.pages:
            area = _visible_area(page)
            if area is None:
                continue
            page.obj.MediaBox = pikepdf.Array([float(v) for v in area])
            if "/CropBox" in page.obj:
                del page.obj["/CropBox"]
            changed = True
        if not changed and not pdf.is_encrypted:
            return source
        target = os.path.join(workdir, "spool.pdf")
        # The spool copy is not the document: it is consumed by CUPS and
        # deleted with its folder, so it leaves the protection behind. The
        # seam still refuses a restricted recipient copy's plaintext here.
        save_pdf(pdf, target, drop_encryption=True)
        return target


def submit(path: str, destination: str, title: str, options, lib=None) -> int:
    """Spool one PDF to a destination; returns the print system's job id."""
    lib = lib or load_library()
    dest = _named_dest(lib, destination)
    if not dest:
        if lib.cupsLastError() > _IPP_STATUS_OK_MAX and not _is_not_found(lib.cupsLastError()):
            detail = _last_error(lib)
            raise RuntimeError(f"The print system could not be reached: {detail}")
        printer = destination
        raise ValueError(f"Unknown printer: '{printer}'")
    info = None
    num = ctypes.c_int(0)
    opts = ctypes.POINTER(_Option)()
    try:
        # The destination's saved options first; the job's own override them.
        chosen = {name for name, _ in options}
        record = dest.contents
        for i in range(record.num_options):
            saved = record.options[i]
            if saved.name and saved.name.decode("utf-8", "replace") not in chosen:
                num.value = lib.cupsAddOption(saved.name, saved.value, num.value, ctypes.byref(opts))
        for name, value in options:
            num.value = lib.cupsAddOption(
                name.encode("utf-8"), value.encode("utf-8"), num.value, ctypes.byref(opts)
            )
        info = lib.cupsCopyDestInfo(None, dest)
        if not info:
            printer, detail = destination, _last_error(lib)
            raise RuntimeError(f"The printer '{printer}' did not report its capabilities: {detail}")
        job_id = ctypes.c_int(0)
        name = title.encode("utf-8", "replace")[:255]
        status = lib.cupsCreateDestJob(None, dest, info, ctypes.byref(job_id), name, num.value, opts)
        if status > _IPP_STATUS_OK_MAX or job_id.value <= 0:
            printer, detail = destination, _last_error(lib)
            raise RuntimeError(f"The printer '{printer}' refused the job: {detail}")
        started = lib.cupsStartDestDocument(
            None, dest, info, job_id.value, name, FORMAT_PDF, 0, None, 1
        )
        if started != _HTTP_STATUS_CONTINUE:
            lib.cupsCancelDestJob(None, dest, job_id.value)
            printer, detail = destination, _last_error(lib)
            raise RuntimeError(f"The printer '{printer}' refused the document: {detail}")
        with open(path, "rb") as f:
            while True:
                chunk = f.read(_CHUNK)
                if not chunk:
                    break
                if lib.cupsWriteRequestData(None, chunk, len(chunk)) != _HTTP_STATUS_CONTINUE:
                    lib.cupsFinishDestDocument(None, dest, info)
                    lib.cupsCancelDestJob(None, dest, job_id.value)
                    detail = _last_error(lib)
                    raise RuntimeError(f"The print system stopped accepting the document: {detail}")
        finished = lib.cupsFinishDestDocument(None, dest, info)
        if finished > _IPP_STATUS_OK_MAX:
            printer, detail = destination, _last_error(lib)
            raise RuntimeError(f"The printer '{printer}' did not accept the job: {detail}")
        return job_id.value
    finally:
        if info:
            lib.cupsFreeDestInfo(info)
        if num.value:
            lib.cupsFreeOptions(num.value, opts)
        lib.cupsFreeDests(1, dest)


def print_file(
    path: str,
    destination: str,
    pages: str,
    fit: str,
    duplex: str,
    paper: str | None,
    orientation: str,
    color: str,
    title: str,
    jobs: int,
    lib=None,
) -> list[int]:
    """Spool `path` `jobs` times (collated copies are sequential jobs, the
    same contract as the Windows path). Returns the job ids."""
    options = job_options(pages, fit, duplex, paper, orientation, color)
    lib = lib or load_library()
    with tempfile.TemporaryDirectory(prefix="spectra-spool-") as workdir:
        spooled = prepare_for_spool(path, workdir)
        return [submit(spooled, destination, title, options, lib=lib) for _ in range(jobs)]
