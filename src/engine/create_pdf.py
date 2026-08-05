"""Create PDFs through one conversion and assembly pipeline.

Create PDF, Combine Files, the CLI, guided actions, and batch OCR all use
`create_pdf`. Each non-PDF source is converted independently, its page range is
applied, and the results are assembled with the form-aware merge path. Page
sizing is applied once to the assembled document.

Images use the Pillow path because it preserves stored DPI. Each multi-frame
image frame is saved separately so its own DPI controls its page size; the
pages are then concatenated with `add_pages_from`. Supported modes are passed
through, palette images are converted to RGB, and alpha is composited on white.
"""

from __future__ import annotations

import io
import math
import os
import re
import shutil
import tempfile
from contextlib import ExitStack
from pathlib import Path

import pikepdf

from engine import distill as distill_mod
from engine import merge as merge_mod
from engine import soffice as soffice_mod
from engine.acroform import (
    carry_doc_form_extras,
    carry_pure_data_fields,
    prune_form_to_pages,
    refresh_sig_flags,
)
from engine.split import parse_ranges

# Accepted raster formats. Bundled Pillow decodes WEBP, JPEG 2000, AVIF, GIF,
# and common formats; pillow-heif supplies HEIC/HEIF camera-image support.
IMAGE_SUFFIXES = (
    ".png",
    ".jpg",
    ".jpeg",
    ".jpe",
    ".tif",
    ".tiff",
    ".bmp",
    ".dib",
    ".gif",
    ".webp",
    ".jp2",
    ".j2k",
    ".j2c",
    ".jpc",
    ".jpf",
    ".jpx",
    ".avif",
    ".heic",
    ".heif",
)

# Handled by the plugin rather than by Pillow itself, so their absence is a
# NAMED refusal — never a silent skip of somebody's photograph.
HEIF_SUFFIXES = (".heic", ".heif")

# Modes the PDF plugin encodes directly, measured. `1` stays `1` deliberately:
# it lands as CCITTFaxDecode, which is what a bilevel fax page should be.
_DIRECT_MODES = ("1", "L", "RGB", "CMYK")

# Integer/float sample modes the plugin refuses outright.
_WIDE_MODES = ("I", "I;16", "I;16B", "I;16L", "I;16N", "F")

_heif_registered: bool | None = None


def accepted_image_suffixes() -> tuple[str, ...]:
    """The raster extensions this arm accepts (for pickers, CLI help, refusals)."""
    return IMAGE_SUFFIXES


def is_image(path: str | Path) -> bool:
    return Path(path).suffix.lower() in IMAGE_SUFFIXES


def _register_heif() -> bool:
    """Register the HEIF decoder once. False when the plugin is not provisioned."""
    global _heif_registered
    if _heif_registered is None:
        try:
            import pillow_heif  # noqa: PLC0415

            pillow_heif.register_heif_opener()
            _heif_registered = True
        except Exception:  # noqa: BLE001 - any import/registration failure is "absent"
            _heif_registered = False
    return _heif_registered


def _resolution(info: dict, dpi_default: float) -> float:
    """The image's own stored DPI, or the default.

    A stored value of 0 (TIFF's "unset") or 1 is not a resolution — it is a
    placeholder, and honouring it would produce a page metres across.
    """
    dpi = (info or {}).get("dpi")
    try:
        value = float(dpi[0])  # type: ignore[index]
    except (TypeError, ValueError, IndexError):
        return float(dpi_default)
    if not math.isfinite(value) or value <= 1.0:
        return float(dpi_default)
    return value


def _normalise(frame):
    """One frame in a mode the PDF plugin encodes well (see rule 4 above)."""
    from PIL import Image  # noqa: PLC0415

    mode = frame.mode
    if mode in _DIRECT_MODES:
        return frame
    if mode in _WIDE_MODES:
        # A direct convert("L") CLIPS at 255 — a 16-bit scan would come back
        # almost entirely white (measured: 10000 -> 255). Scale instead.
        return frame.convert("I").point(lambda v: v * (1 / 256)).convert("L")
    if mode == "P" and "transparency" not in frame.info:
        # /Indexed + ASCIIHexDecode measured 23x the size of the same picture
        # as RGB, for no fidelity gain.
        return frame.convert("RGB")
    if mode == "LA":
        base = Image.new("L", frame.size, 255)
        base.paste(frame.convert("L"), mask=frame.getchannel("A"))
        return base
    if mode in ("RGBA", "PA", "P") or "A" in frame.getbands():
        rgba = frame.convert("RGBA")
        base = Image.new("RGB", rgba.size, (255, 255, 255))
        base.paste(rgba, mask=rgba.getchannel("A"))
        return base
    return frame.convert("RGB")


def _frame_pdf(frame, resolution: float) -> bytes:
    """One normalised frame as a one-page PDF, sized by `resolution`.

    The frame object is saved EXACTLY ONCE and never reused — Pillow merges
    into a stale `encoderinfo` and the stale value wins (measured), so a reused
    image silently carries a previous call's resolution.
    """
    buf = io.BytesIO()
    frame.save(buf, "PDF", resolution=resolution)
    return buf.getvalue()


def image_to_pdf(src: str | Path, dest: str | Path, *, dpi_default: float = 200.0) -> dict:
    """Wrap ONE image file into a PDF — every frame a page, at its own size.

    Args:
        src: the image file.
        dest: the PDF to write.
        dpi_default: the resolution assumed when the image stores none.

    Returns a report: pages, the per-page DPI actually used, and the first
    page's size in points.
    """
    from PIL import Image, ImageSequence, UnidentifiedImageError  # noqa: PLC0415

    src_path = Path(src)
    dest_path = Path(dest)
    try:
        default = float(dpi_default)
    except (TypeError, ValueError):
        raise ValueError("the image DPI default must be a positive number") from None
    if not math.isfinite(default) or default <= 0:
        raise ValueError("the image DPI default must be a positive number")

    if not src_path.is_file():
        raise ValueError(f"image file not found: {src_path}")
    # A zero-byte source is refused BEFORE any decoder sees it — the same rule
    # the LibreOffice arm needs, where an empty .docx converts "successfully".
    if src_path.stat().st_size == 0:
        raise ValueError(f"the image file is empty: {src_path}")
    if src_path.suffix.lower() in HEIF_SUFFIXES and not _register_heif():
        raise RuntimeError(
            f"HEIC/HEIF images need the pillow-heif plugin, which this runtime "
            f"does not have: {src_path}"
        )
    # Registering unconditionally costs nothing and lets a .heic that arrived
    # under a wrong extension still decode.
    _register_heif()

    parts: list[bytes] = []
    sizes: list[tuple[float, float]] = []
    resolutions: list[float] = []
    try:
        with Image.open(src_path) as im:
            for raw in ImageSequence.Iterator(im):
                resolution = _resolution(raw.info or im.info, default)
                frame = _normalise(raw.copy())
                parts.append(_frame_pdf(frame, resolution))
                resolutions.append(resolution)
                sizes.append(
                    (
                        frame.size[0] * 72.0 / resolution,
                        frame.size[1] * 72.0 / resolution,
                    )
                )
    except UnidentifiedImageError as exc:
        raise ValueError(f"unreadable image: {src_path} ({exc})") from None
    except (OSError, ValueError) as exc:
        # Pillow raises OSError for a truncated frame mid-sequence; a partial
        # page set is not a success, so the whole source refuses.
        raise ValueError(f"unreadable image: {src_path} ({exc})") from None

    if not parts:
        raise ValueError(f"the image contains no frames: {src_path}")

    dest_path.parent.mkdir(parents=True, exist_ok=True)
    if len(parts) == 1:
        dest_path.write_bytes(parts[0])
    else:
        merged = pikepdf.Pdf.new()
        with ExitStack() as stack:
            for data in parts:
                page_pdf = stack.enter_context(pikepdf.open(io.BytesIO(data)))
                # add_pages_from, never `pages.extend` — the structural-page-ops
                # invariant holds even where no source can carry a form, because
                # the exception is what erodes.
                merged.add_pages_from(page_pdf)
            merged.save(str(dest_path))

    return {
        "output": str(dest_path),
        "pages": len(parts),
        "dpi": [round(r, 2) for r in resolutions],
        "page_size": [round(sizes[0][0], 2), round(sizes[0][1], 2)],
    }


# --------------------------------------------------------------------------
# The door: four arms, convert-then-merge, sizing at assembly.
# --------------------------------------------------------------------------

# Paper sizes in points, portrait. `auto` keeps each source's own geometry — an
# image its DPI-derived size, a .pptx its 16:9 slide, a spreadsheet
# LibreOffice's own paper choice — and is the default because normalising by
# default would silently reformat every deck the product touched.
PAGE_SIZES: dict[str, tuple[float, float]] = {
    "letter": (612.0, 792.0),
    "legal": (612.0, 1008.0),
    "tabloid": (792.0, 1224.0),
    "a3": (841.89, 1190.55),
    "a4": (595.28, 841.89),
    "a5": (419.53, 595.28),
}
PAGE_SIZE_CHOICES = ("auto", "first", *sorted(PAGE_SIZES))
ORIENTATIONS = ("auto", "portrait", "landscape")

POSTSCRIPT_SUFFIXES = (".ps", ".eps")

# What a blank member is when the caller names no size.
DEFAULT_BLANK_SIZE = PAGE_SIZES["letter"]

_KIND_PDF = "pdf"
_KIND_IMAGE = "image"
_KIND_OFFICE = "office"
_KIND_POSTSCRIPT = "postscript"
_KIND_BLANK = "blank"


def classify(path: str | Path) -> str:
    """Which arm converts this source. An unknown extension returns ``""``.

    The renderer carries the same table (`lib/create-pdf.ts`) so a picker can
    badge a row before any engine call; this is the authority they agree on.
    """
    suffix = Path(path).suffix.lower()
    if suffix == ".pdf":
        return _KIND_PDF
    if suffix in IMAGE_SUFFIXES:
        return _KIND_IMAGE
    if suffix in POSTSCRIPT_SUFFIXES:
        return _KIND_POSTSCRIPT
    if soffice_mod.is_office_source(path):
        return _KIND_OFFICE
    return ""


def accepted_suffixes() -> tuple[str, ...]:
    """Every extension Create PDF takes — for pickers, CLI help and refusals."""
    return (
        ".pdf",
        *IMAGE_SUFFIXES,
        *POSTSCRIPT_SUFFIXES,
        *soffice_mod.OFFICE_SUFFIXES,
    )


def _blank_pdf(dest: Path, width, height) -> int:
    try:
        w = float(width)
        h = float(height)
    except (TypeError, ValueError):
        raise ValueError("a blank page needs a positive width and height") from None
    if not (math.isfinite(w) and math.isfinite(h)) or w <= 0 or h <= 0:
        raise ValueError("a blank page needs a positive width and height")
    pdf = pikepdf.Pdf.new()
    pdf.add_blank_page(page_size=(w, h))
    pdf.save(str(dest))
    return 1


def _page_box(page) -> tuple[float, float, float, float]:
    box = page.get("/MediaBox") or [0, 0, 612, 792]
    x0, y0, x1, y1 = (float(v) for v in box)
    return (min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1))


def _displayed(page) -> tuple[float, float]:
    """The page as a READER sees it — /Rotate applied."""
    x0, y0, x1, y1 = _page_box(page)
    width, height = (x1 - x0), (y1 - y0)
    if int(page.get("/Rotate", 0) or 0) % 360 in (90, 270):
        return (height, width)
    return (width, height)


def _target_box(
    page_size: str,
    orientation: str,
    first_displayed: tuple[float, float],
    displayed: tuple[float, float],
) -> tuple[float, float]:
    """The size this page is placed on, in DISPLAYED (post-/Rotate) points."""
    base = first_displayed if page_size == "first" else PAGE_SIZES[page_size]
    short, long_ = min(base), max(base)
    if orientation == "portrait":
        return (short, long_)
    if orientation == "landscape":
        return (long_, short)
    # auto: follow the CONTENT's own aspect, per page.
    return (long_, short) if displayed[0] > displayed[1] else (short, long_)


def _page_content_bytes(page) -> bytes:
    """The page's drawing operators, however many streams they arrived in."""
    contents = page.get("/Contents")
    if contents is None:
        return b""
    if isinstance(contents, pikepdf.Array):
        return b"\n".join(bytes(stream.read_bytes()) for stream in contents)
    return bytes(contents.read_bytes())


def _transform_rect(rect, scale: float, tx: float, ty: float) -> list[float]:
    out: list[float] = []
    for index, value in enumerate(float(v) for v in rect):
        out.append(value * scale + (tx if index % 2 == 0 else ty))
    return out


def _place_page(pdf, page, target: tuple[float, float], margin: float) -> None:
    """Put one page's content, unstretched and centred, on a `target` page.

    The content is wrapped as a Form XObject and drawn through a single `cm`,
    so nothing is re-rendered and nothing is rasterised. **Annotations travel
    through the SAME affine** and stay the same objects, so a widget keeps its
    /AcroForm registration and a link keeps working; building a fresh page
    dictionary instead would have silently dropped every field on every sized
    page — the structural-page-ops rule, met at a new surface.

    /Rotate is left alone and the target box is un-rotated to match, so "make
    this A4 landscape" means what the reader SEES, not what the box says.
    """
    rotate = int(page.get("/Rotate", 0) or 0) % 360
    x0, y0, x1, y1 = _page_box(page)
    width, height = (x1 - x0), (y1 - y0)
    if width <= 0 or height <= 0:
        return
    box_w, box_h = (target[1], target[0]) if rotate in (90, 270) else target
    avail_w = max(box_w - 2 * margin, 1.0)
    avail_h = max(box_h - 2 * margin, 1.0)
    scale = min(avail_w / width, avail_h / height)
    tx = (box_w - scale * width) / 2.0 - scale * x0
    ty = (box_h - scale * height) / 2.0 - scale * y0

    # Built by hand rather than through `Page.as_form_xobject()`: that helper
    # hands back the page's OWN content stream object, so replacing
    # `page.Contents` a line later rewrote the form too and the page drew
    # itself invoking itself — one recursive `Do` and not a glyph of the
    # document's text left extractable (reproduced).
    raw = _page_content_bytes(page)
    resources = page.get("/Resources")
    form_ref = pdf.make_indirect(
        pikepdf.Stream(
            pdf,
            b"q\n" + raw + b"\nQ",
            Type=pikepdf.Name.XObject,
            Subtype=pikepdf.Name.Form,
            BBox=pikepdf.Array([x0, y0, x1, y1]),
            Resources=resources if resources is not None else pikepdf.Dictionary(),
        )
    )
    page.Contents = pdf.make_stream(
        f"q {scale:.6f} 0 0 {scale:.6f} {tx:.4f} {ty:.4f} cm /SpectraPlaced Do Q".encode("ascii")
    )
    page.Resources = pikepdf.Dictionary(XObject=pikepdf.Dictionary(SpectraPlaced=form_ref))
    page.MediaBox = pikepdf.Array([0, 0, box_w, box_h])
    for key in ("/CropBox", "/BleedBox", "/TrimBox", "/ArtBox"):
        if key in page:
            del page[key]
    for annot in page.get("/Annots") or []:
        if "/Rect" in annot:
            annot.Rect = pikepdf.Array(_transform_rect(annot.Rect, scale, tx, ty))
        if "/QuadPoints" in annot:
            annot.QuadPoints = pikepdf.Array(_transform_rect(annot.QuadPoints, scale, tx, ty))


def _apply_page_size(path: Path, page_size: str, orientation: str, margin: float) -> None:
    """Apply sizing once to the assembled document."""
    if page_size == "auto" and orientation == "auto":
        return
    with pikepdf.open(str(path), allow_overwriting_input=True) as pdf:
        if len(pdf.pages) == 0:
            return
        first_displayed = _displayed(pdf.pages[0])
        for index, page in enumerate(pdf.pages):
            displayed = _displayed(page)
            if page_size == "auto":
                # Orientation alone: keep this page's own paper, turn it.
                short, long_ = min(displayed), max(displayed)
                target = (short, long_) if orientation == "portrait" else (long_, short)
            else:
                if page_size == "first" and index == 0 and orientation == "auto":
                    continue
                target = _target_box(page_size, orientation, first_displayed, displayed)
            if (
                margin == 0
                and abs(target[0] - displayed[0]) < 0.01
                and abs(target[1] - displayed[1]) < 0.01
            ):
                # Already the right size: never rewrite a page for nothing.
                continue
            _place_page(pdf, page, target, margin)
        pdf.save(str(path))


# A member's page range, as the Combine dialog and the CLI spell it: "1-3,5".
# Validated BEFORE `parse_ranges` sees it, because that helper's `int()` on a
# malformed part raises a bare ValueError naming a literal the user never
# typed — a refusal has to name what was actually asked for.
_RANGE_PART = re.compile(r"^\s*\d+\s*(?:-\s*\d+\s*)?$")


def _subset(src: Path, dest: Path, spec: str, label: str) -> int:
    """Keep only ``spec``'s pages of ``src``, into ``dest``. Returns the count.

    Form-aware by the same construction `split` uses — prune the field tree to
    the kept pages, then `add_pages_from`, then the pure-data and /CO carries.
    A range applied to a member of a Combine is exactly a split of that member,
    so it must not be a second, weaker implementation: a bare `pages.append`
    here would leave every widget on a kept page orphaned (the
    structural-page-ops invariant).
    """
    parts = [p for p in str(spec).split(",") if p.strip()]
    if not parts or any(not _RANGE_PART.match(p) for p in parts):
        raise ValueError(
            f"the page range {spec!r} for {label} is not a list of pages or "
            f"ranges like '1-3,5'"
        )
    with pikepdf.open(str(src)) as pdf:
        indices = parse_ranges(str(spec), len(pdf.pages))
        if not indices:
            raise ValueError(
                f"the page range {spec!r} selects no pages of {label} "
                f"(it has {len(pdf.pages)})"
            )
        prune_form_to_pages(pdf, indices)
        out = pikepdf.Pdf.new()
        copied = out.add_pages_from(pdf, pages=indices)
        pure = carry_pure_data_fields(out, pdf)
        refresh_sig_flags(out)
        renames = dict(copied.renamed_fields)
        renames.update({r["from"]: r["to"] for r in pure})
        carry_doc_form_extras(out, pdf, renames)
        out.save(str(dest))
    return len(indices)


def _convert_one(
    source: dict,
    index: int,
    scratch: Path,
    *,
    image_dpi_default: float,
    soffice_path: str,
    gs_path: str,
    distill_preset: str,
) -> dict:
    """One source -> one scratch PDF, plus the report row § 6 describes."""
    kind = str(source.get("kind") or "").lower()
    page_range = str(source.get("pages") or "").strip()
    if kind == _KIND_BLANK:
        if page_range:
            # Refused rather than ignored: a range that silently does nothing
            # is a user believing they selected something.
            raise ValueError("a blank page has no pages to select a range from")
        dest = scratch / f"{index:04d}-blank.pdf"
        pages = _blank_pdf(
            dest,
            source.get("width", DEFAULT_BLANK_SIZE[0]),
            source.get("height", DEFAULT_BLANK_SIZE[1]),
        )
        return {"kind": _KIND_BLANK, "converter": "blank", "pages": pages, "_file": str(dest)}

    raw_path = source.get("path")
    if not raw_path:
        raise ValueError("every source needs a path (or the kind 'blank')")
    path = Path(str(raw_path))
    detected = classify(path)
    if not detected:
        raise ValueError(
            f"Create PDF cannot convert {path.name} "
            f"(accepted: {', '.join(accepted_suffixes())})"
        )
    if not path.is_file():
        raise ValueError(f"input file not found: {path}")
    # Every arm validates its source BEFORE a converter runs — soffice returns
    # 0 on a zero-byte input, so an exit code cannot be the gate.
    if path.stat().st_size == 0:
        raise ValueError(f"the input file is empty: {path}")

    row: dict = {"path": str(path), "kind": detected}
    if detected == _KIND_PDF:
        with pikepdf.open(str(path)) as pdf:
            row["pages"] = len(pdf.pages)
        row["converter"] = "passthrough"
        row["_file"] = str(path)
    elif detected == _KIND_IMAGE:
        dest = scratch / f"{index:04d}-image.pdf"
        report = image_to_pdf(path, dest, dpi_default=image_dpi_default)
        row.update(
            converter="image",
            pages=report["pages"],
            dpi=report["dpi"],
            page_size=report["page_size"],
            _file=str(dest),
        )
    elif detected == _KIND_OFFICE:
        dest = scratch / f"{index:04d}-office.pdf"
        report = soffice_mod.to_pdf(path, dest, soffice_path)
        row.update(converter="libreoffice", pages=report["pages"], _file=str(dest))
        if report.get("fonts_substituted"):
            row["fonts_substituted"] = report["fonts_substituted"]
    else:
        dest = scratch / f"{index:04d}-distilled.pdf"
        report = distill_mod.distill(str(path), str(dest), preset=distill_preset, gs_path=gs_path)
        row.update(
            converter="ghostscript",
            pages=report["pages"],
            eps=bool(report.get("eps", False)),
            _file=str(dest),
        )

    # The range is applied AFTER conversion, once, to whatever the arm
    # produced — so "pages 2-3 of that .docx" works exactly as "pages 2-3 of
    # that PDF" does, and no arm needs to learn about ranges.
    if page_range:
        ranged = scratch / f"{index:04d}-range.pdf"
        row["pages"] = _subset(Path(row["_file"]), ranged, page_range, path.name)
        row["_file"] = str(ranged)
        row["page_range"] = page_range
    return row


def create_pdf(
    sources: list,
    output: str,
    page_size: str = "auto",
    orientation: str = "auto",
    margin_pt: float = 0.0,
    image_dpi_default: float = 200.0,
    soffice_path: str = "",
    gs_path: str = "gs",
    distill_preset: str = "printer",
    on_unsupported: str = "refuse",
) -> dict:
    """Build ONE PDF from an ordered list of sources of any accepted kind.

    Args:
        sources: ordered ``{"path": …}`` entries, plus ``{"kind": "blank",
            "width": …, "height": …}`` for a blank member. Any path entry may
            carry ``"pages": "1-3,5"`` to contribute only those pages — applied
            after that source's conversion, so it reads the same on a `.docx`
            as on a PDF (this is what Combine Files' per-member range sends).
        output: the PDF to write.
        page_size: ``auto`` (each source keeps its own geometry), ``first``
            (the first source's first page size), or a named paper size.
        orientation: ``auto`` (per page, from the content's aspect),
            ``portrait`` or ``landscape``.
        margin_pt: white space kept around placed content when a page size is
            named. ``auto``/``auto`` moves nothing, so it ignores this.
        image_dpi_default: the resolution assumed for an image storing none.
        soffice_path / gs_path: the bundled converters.
        distill_preset: the Ghostscript quality preset for PostScript sources.
        on_unsupported: ``refuse`` (default — one bad source fails the run) or
            ``skip`` (report the row and carry on). A skipped row is NEVER
            silent: it is a `warnings` entry AND a `sources` row with `error`.
    """
    if not isinstance(sources, list) or not sources:
        raise ValueError("Create PDF needs at least one source")
    if page_size not in PAGE_SIZE_CHOICES:
        raise ValueError(f"unknown page size {page_size!r} ({', '.join(PAGE_SIZE_CHOICES)})")
    if orientation not in ORIENTATIONS:
        raise ValueError(f"unknown orientation {orientation!r} ({', '.join(ORIENTATIONS)})")
    if on_unsupported not in ("refuse", "skip"):
        raise ValueError(f"unknown on_unsupported {on_unsupported!r} (refuse, skip)")
    try:
        margin = float(margin_pt)
    except (TypeError, ValueError):
        raise ValueError("the margin must be a number of points") from None
    if not math.isfinite(margin) or margin < 0:
        raise ValueError("the margin must be a number of points")

    output_path = Path(output)
    if output_path.is_dir():
        raise ValueError(f"output path is a directory, not a file: {output}")
    # Identity, never string comparison: a canonical string cannot see a UNC
    # vs mapped-letter or a hardlink alias of one physical file, and writing
    # the output over a source destroys it.
    if output_path.exists():
        for source in sources:
            candidate = source.get("path") if isinstance(source, dict) else None
            if candidate and Path(str(candidate)).exists() and os.path.samefile(
                str(candidate), str(output_path)
            ):
                raise ValueError("the output is one of the sources — choose another name")

    scratch = Path(tempfile.mkdtemp(prefix="create-pdf-"))
    rows: list[dict] = []
    warnings: list[str] = []
    parts: list[str] = []
    try:
        for index, source in enumerate(sources):
            if not isinstance(source, dict):
                raise ValueError("every source must be an object with a path or a kind")
            try:
                row = _convert_one(
                    source,
                    index,
                    scratch,
                    image_dpi_default=image_dpi_default,
                    soffice_path=soffice_path,
                    gs_path=gs_path,
                    distill_preset=distill_preset,
                )
            except Exception as exc:
                if on_unsupported == "refuse":
                    raise
                name = str(source.get("path") or source.get("kind") or "source")
                rows.append({"path": name, "kind": "", "pages": 0, "error": str(exc)})
                warnings.append(f"{Path(name).name}: {exc}")
                continue
            parts.append(row.pop("_file"))
            rows.append(row)

        if not parts:
            raise RuntimeError("nothing could be converted, so there is no PDF to write")

        output_path.parent.mkdir(parents=True, exist_ok=True)
        # ALWAYS through the shipped merge, even for one member — that is what
        # makes the /AcroForm, outline and struct carries impossible to forget,
        # and what stops the single-source case drifting from the multi.
        merged = merge_mod.merge(parts, str(output_path))
        _apply_page_size(output_path, page_size, orientation, margin)

        with pikepdf.open(str(output_path)) as pdf:
            pages = len(pdf.pages)
        if pages == 0:
            # The zero-page invariant holds at the builder as well as at the
            # reducer and the planner.
            output_path.unlink(missing_ok=True)
            raise RuntimeError("the sources produced no pages, so no PDF was written")

        for row in rows:
            for face in row.get("fonts_substituted", []):
                warnings.append(
                    f"{Path(row['path']).name}: {face} was not available and was substituted"
                )
        result = {
            "output": str(output_path),
            "pages": pages,
            "sources": rows,
            "size_bytes": output_path.stat().st_size,
        }
        if merged.get("fields_renamed"):
            result["fields_renamed"] = merged["fields_renamed"]
        if warnings:
            result["warnings"] = warnings
        return result
    finally:
        shutil.rmtree(scratch, ignore_errors=True)
