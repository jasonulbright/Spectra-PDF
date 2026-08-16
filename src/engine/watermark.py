"""Watermark: stamp translucent text, an image OR a PDF page across pages.

Approach (per page): author a small Form XObject carrying the stamp ops and
its OWN private /Resources (standard-14 Helvetica, the shared image
XObject, or the shared lifted-page form, plus an /ExtGState with the
requested alpha), then attach it with
pikepdf's ``Page.add_overlay`` / ``add_underlay``. Using the library's
overlay API instead of hand-editing
``page.Contents`` sidesteps two traps the redaction review taught us:

  - **Inherited /Resources** — assigning ``page.Resources`` to register a
    font would SHADOW a resources dict inherited from an ancestor /Pages
    node (the same generator pattern ``redact._resolve_resources`` walks the
    /Parent chain for). The form carries its font privately, so the page's
    resource dict only ever gains the collision-safely-named form itself.
  - **Unbalanced graphics state** — add_overlay q/Q-shields the stamp from
    whatever state the existing content leaves dangling.

**The form's box is the DISPLAYED page box, and its coordinates are the
reader's.** ``add_overlay`` places a form into the rectangle *as displayed*:
on a /Rotate 90 or 270 page it writes a rotation into the placement matrix
and matches the form's BBox against the SWAPPED dimensions. Two consequences,
both load-bearing:

  - The BBox is ``[0 0 disp_w disp_h]``, so the fit-scale is exactly 1 at
    every /Rotate. A BBox in un-rotated user dimensions makes qpdf scale the
    stamp by ``min(W/H, H/W)`` on a rotated non-square page.
  - ``angle`` is drawn as given. It already means degrees in the displayed
    orientation, and the placement matrix supplies the /Rotate part; adding
    /Rotate here again turns the stamp a second time and lays it on its side.

/Rotate and the crop/media boxes are inheritable page attributes — resolved
via pdf_tree.walk_inheritable, the one shared /Parent-chain walk that
redact's resource lookup also uses (one implementation, so a fix propagates
to every consumer).

The IMAGE and PDF-PAGE sources embed ONCE per call: the picture is decoded
and encoded, or the source page is lifted, a single time before the page loop
and made indirect, and every page's form references that one XObject through
its own /Resources.

Placement (position, tiling) is shared by all three sources — one helper
decides where the stamp centres go, and each source only knows how to draw
itself at a centre.

Deliberately NOT Ghostscript: a gs pdfwrite round-trip regenerates the
whole file to add one stream per page, and GS-backed ops don't run in dev
until the bundle script has been run.
"""

import contextlib
import io
import math
import os
import re
import shutil
import tempfile
from pathlib import Path

import pikepdf
from pikepdf import Dictionary, Name

from engine.pdf_save import save_pdf
from engine.pdf_tree import walk_inheritable


# Helvetica metrics moved to pdf_metrics.py (shared with forms.py);
# the aliases below keep this module's call sites and tests unchanged.
from engine.pdf_metrics import (
    GLYPH_HEIGHT_EM as _GLYPH_HEIGHT_EM,
    HELVETICA_ASCII_WIDTHS as _HELVETICA_ASCII_WIDTHS,
    NON_ASCII_ADVANCE_EM as _NON_ASCII_ADVANCE_EM,
    flatten_control_chars as _flatten_control_chars,
    text_width_em as _text_width_em,
)

MIN_AUTO_FONT_SIZE = 8.0
MAX_AUTO_FONT_SIZE = 144.0
# Fraction of the box's crossing length (along the text direction) the
# auto-sized text should span.
AUTO_FIT_FRACTION = 0.65

# Anchors, named in the page's DISPLAYED orientation.
POSITIONS = (
    "center",
    "top-left",
    "top-center",
    "top-right",
    "middle-left",
    "middle-right",
    "bottom-left",
    "bottom-center",
    "bottom-right",
)
DEFAULT_MARGIN = 36.0
DEFAULT_TILE_GAP = 24.0
# A stamp small enough to demand more copies than this is a mistake, not a
# request: the content stream would grow past what a viewer will finish.
MAX_TILES = 2000


def _parse_color(color: str) -> tuple[float, float, float]:
    m = re.fullmatch(r"#?([0-9a-fA-F]{6})", color.strip())
    if not m:
        raise ValueError(f"color must be #rrggbb, got: {color!r}")
    v = int(m.group(1), 16)
    return ((v >> 16 & 0xFF) / 255.0, (v >> 8 & 0xFF) / 255.0, (v & 0xFF) / 255.0)


def _escape_pdf_text(text: str) -> str:
    """Best-effort WinAnsi, matching the frontend's appearance streams:
    escape the literal-string specials, map anything past Latin-1 to '?'."""
    out = []
    for ch in text:
        code = ord(ch)
        if ch in ("(", ")", "\\"):
            out.append("\\" + ch)
        elif 32 <= code <= 255:
            out.append(ch)
        else:
            out.append("?")
    return "".join(out)


def _resolve_rotate(page: pikepdf.Page) -> int:
    """/Rotate is inheritable — resolved via the page-tree walk shared with
    redact (pdf_tree.walk_inheritable); page.obj.get alone would misread
    files that hoist it onto an ancestor /Pages node."""
    value = walk_inheritable(page, "/Rotate")
    rotate = int(value) if value is not None else 0
    return ((rotate % 360) + 360) % 360


def _resolve_box(page: pikepdf.Page) -> tuple[float, float, float, float]:
    """The page's crop box (fall back to media box), inheritance-aware,
    normalized to (x0, y0, x1, y1) with x0<x1, y0<y1."""
    box = walk_inheritable(page, "/CropBox")
    if box is None:
        box = walk_inheritable(page, "/MediaBox")
    if box is None:
        raise ValueError("page has no /CropBox or /MediaBox anywhere in its page tree")
    x0, y0, x1, y1 = (float(box[i]) for i in range(4))
    return (min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1))


def _auto_font_size(
    text: str,
    width: float,
    height: float,
    rotate: int,
    angle: float,
    em_width: float | None = None,
    glyph_height_em: float | None = None,
) -> float:
    """Size the text so that BOTH of its axes fit the box.

    Baseline axis: span ~AUTO_FIT_FRACTION of the box's crossing length along
    the text direction — the length of a line through the box center at that
    angle, min(W/|cos|, H/|sin|). NOT the projection extent (W|cos| + H|sin|):
    a centered segment sized to the projection can poke far outside the box
    (dramatically so for wide-short pages) — the overflow the e2e caught.

    Glyph-height axis: the SAME bound rotated 90° — near axis-aligned angles
    the baseline crossing degenerates to inf on one term and stops seeing the
    box dimension PERPENDICULAR to the text run entirely, so a banner-shaped
    box such as 1500×10 at angle 0 would get a size independent of its height
    and clip vertically. The perpendicular crossing is
    min(W/|sin|, H/|cos|); the text's vertical extent (ascender+descender)
    must fit the same fraction of it.

    A centered fraction < 1 of each crossing keeps that axis inside the box
    by construction. width/height are user-space crop dims; the DISPLAYED
    dims swap when /Rotate is 90 or 270. MIN_AUTO_FONT_SIZE is a legibility
    floor and wins below it (a box thinner than ~12pt clips rather than
    rendering unreadable dust)."""
    disp_w, disp_h = (height, width) if rotate in (90, 270) else (width, height)
    theta = math.radians(angle)
    cos_a, sin_a = abs(math.cos(theta)), abs(math.sin(theta))
    baseline_crossing = min(
        disp_w / cos_a if cos_a > 1e-9 else math.inf,
        disp_h / sin_a if sin_a > 1e-9 else math.inf,
    )
    perp_crossing = min(
        disp_w / sin_a if sin_a > 1e-9 else math.inf,
        disp_h / cos_a if cos_a > 1e-9 else math.inf,
    )
    # On the embedded-Unicode path the caller passes the run's own em
    # advance AND its real ascent+descent extent; WinAnsi keeps the Helvetica
    # metrics (byte-identical auto-size). Using Helvetica's 0.925-em height for
    # a taller embedded face such as Liberation Sans silently shrinks the
    # perpendicular-axis margin.
    advance = max(em_width if em_width is not None else _text_width_em(text), 0.1)
    gh = glyph_height_em if glyph_height_em is not None else _GLYPH_HEIGHT_EM
    fit = min(
        AUTO_FIT_FRACTION * baseline_crossing / advance,
        AUTO_FIT_FRACTION * perp_crossing / gh,
    )
    return max(MIN_AUTO_FONT_SIZE, min(MAX_AUTO_FONT_SIZE, fit))


def _n(v: float) -> str:
    """Compact stable numeric formatting for content-stream operands."""
    return f"{v:.4f}".rstrip("0").rstrip(".") or "0"


def _displayed_box(width: float, height: float, rotate: int) -> tuple[float, float]:
    """The page box as the READER sees it. /Rotate 90 and 270 swap the axes."""
    return (height, width) if rotate in (90, 270) else (width, height)


def _rotated_extent(w: float, h: float, angle: float) -> tuple[float, float]:
    """Half-width and half-height of a w×h stamp's bounding box at `angle`."""
    theta = math.radians(angle)
    cos_a, sin_a = abs(math.cos(theta)), abs(math.sin(theta))
    return ((w * cos_a + h * sin_a) / 2.0, (w * sin_a + h * cos_a) / 2.0)


def _anchor(position: str, disp_w: float, disp_h: float, hw: float, hh: float,
            margin: float) -> tuple[float, float]:
    """The stamp centre for `position`, in DISPLAYED coordinates."""
    if position == "center":
        return (disp_w / 2.0, disp_h / 2.0)
    vertical, _, horizontal = position.partition("-")
    x = {
        "left": margin + hw,
        "center": disp_w / 2.0,
        "right": disp_w - margin - hw,
    }[horizontal]
    y = {
        "top": disp_h - margin - hh,
        "middle": disp_h / 2.0,
        "bottom": margin + hh,
    }[vertical]
    return (x, y)


def _centers(
    disp_w: float,
    disp_h: float,
    angle: float,
    stamp_w: float,
    stamp_h: float,
    position: str,
    margin: float,
    tile: bool,
    tile_gap: float,
) -> list[tuple[float, float]]:
    """Where the stamp is drawn inside the form's box, one point per copy.

    The form's box IS the displayed page box (see the module docstring), so
    every coordinate here is a coordinate the reader would point at.

    `center` with no tiling returns the box centre EXACTLY — the shipped
    single-stamp geometry, unchanged by arithmetic that would only introduce
    rounding.
    """
    if not tile and position == "center":
        return [(disp_w / 2.0, disp_h / 2.0)]
    hw, hh = _rotated_extent(stamp_w, stamp_h, angle)
    if not tile:
        return [_anchor(position, disp_w, disp_h, hw, hh, margin)]

    cell_w = max(2.0 * hw + tile_gap, 1e-3)
    cell_h = max(2.0 * hh + tile_gap, 1e-3)
    cols = max(1, math.ceil(disp_w / cell_w))
    rows = max(1, math.ceil(disp_h / cell_h))
    if cols * rows > MAX_TILES:
        raise ValueError(
            f"tiling this watermark would need {cols * rows} copies per page, "
            f"more than the {MAX_TILES} allowed — increase the scale or the gap"
        )
    x0 = disp_w / 2.0 - (cols - 1) * cell_w / 2.0
    y0 = disp_h / 2.0 - (rows - 1) * cell_h / 2.0
    return [
        (x0 + c * cell_w, y0 + r * cell_h)
        for r in range(rows)
        for c in range(cols)
    ]


def _unicode_watermark_face(font_dir: str, text: str = "") -> str | None:
    """The bundled fallback .ttf to embed for a non-Latin-1 watermark (sans,
    matching the WinAnsi Helvetica shape). None when no fonts DIR is available
    → the text is refused (never crashed on a bogus path).

    `text` opts into the text-driven step, so a right-to-left stamp
    lands on a face that can express it. Passing the text is only correct
    because the stamp emitter now reorders and shapes (`_rtl_stamp`) — an
    emitter that did neither would draw the words reversed and the letters
    disconnected, which is why the step is opt-in in the first place."""
    if not font_dir or not Path(font_dir).is_dir():
        return None
    from engine.font_fallback import resolve_fallback_font

    try:
        from engine import bidi

        rtl = bidi.has_strong_rtl(text)
        return resolve_fallback_font(font_dir, text=text or None, rtl_ok=rtl)
    except (ValueError, OSError):
        return None


def _rtl_stamp(pdf, face: str, draw_text: str):
    """(font object, em width, show bytes) for a right-to-left stamp,
    or None when the text is not right-to-left.

    A stamp is a SINGLE line, so there is no wrap to interact with and the
    shared `rtl_text` builder does the whole job: shape the joining words,
    permute the line into visual order, emit. The form draws at 1 em (the
    caller's Tf carries the size), so the rise scale is 1.0."""
    from engine import rtl_text

    built = rtl_text.build(pdf, face, draw_text)
    if built is None:
        return None
    return built.font_obj, built.width_em(draw_text), built.show(draw_text, 1.0)


def _face_glyph_height_em(face_path: str) -> float:
    """The embedded face's ascender+descender extent in em — the perpendicular-
    axis metric `_auto_font_size` needs (Helvetica's `_GLYPH_HEIGHT_EM` is wrong
    for a taller face). Best-effort: any read error falls back to the Helvetica
    value (the auto-size is a fit heuristic, never load-bearing)."""
    try:
        from fontTools.ttLib import TTFont

        from engine.font_fallback import _font_metrics

        ttf = TTFont(face_path, fontNumber=0, lazy=True)
        try:
            m = _font_metrics(ttf)
        finally:
            ttf.close()
        return max((m["ascent"] - m["descent"]) / 1000.0, 0.1)
    except Exception:
        return _GLYPH_HEIGHT_EM


def _plain(value):
    """A PDF value rebuilt out of primitives, owned by no document.

    Image dictionary entries are copied between documents by VALUE here; a
    direct assignment would carry a reference into a document that is about
    to close.
    """
    if isinstance(value, pikepdf.Array):
        return pikepdf.Array([_plain(v) for v in value])
    if isinstance(value, pikepdf.Dictionary):
        return Dictionary({str(k): _plain(v) for k, v in value.items()})
    if isinstance(value, pikepdf.Name):
        return Name(str(value))
    return value


def _embed_image(pdf: pikepdf.Pdf, path: str) -> tuple[pikepdf.Object, int, int, int]:
    """The picture as ONE Image XObject in `pdf`: (object, px width, px height,
    frame count).

    The decode and the encode go through Create PDF's own normalisation and
    Pillow PDF writer (`create_pdf._normalise` / `_frame_pdf`), so the filter
    choice per image mode is decided in one place for both features. The
    one-page PDF that comes back holds exactly one Image XObject; its raw
    (still-encoded) bytes and the handful of image keys are rebuilt here, so
    nothing depends on a foreign document staying open.

    A multi-frame source (animated GIF, multi-page TIFF) contributes its
    FIRST frame — a watermark is one picture — and the frame count is
    reported so the caller can say so.
    """
    from engine import create_pdf as create_pdf_mod  # noqa: PLC0415

    src_path = Path(path)
    if not src_path.is_file():
        raise ValueError(f"watermark image not found: {path}")
    if src_path.stat().st_size == 0:
        raise ValueError(f"watermark image is empty: {path}")
    suffix = src_path.suffix.lower()
    if suffix == ".pdf":
        # Named apart from the generic type refusal: a PDF handed to the image
        # source is a caller who wants the PDF-PAGE source, not a caller who
        # picked an unsupported picture format.
        raise ValueError(
            f"a PDF page is a watermark source of its own — set the PDF source "
            f"instead of the image source: {path}"
        )
    if suffix not in create_pdf_mod.IMAGE_SUFFIXES:
        raise ValueError(
            f"watermark image type not supported: {suffix or '(none)'} "
            f"(accepted: {', '.join(create_pdf_mod.accepted_image_suffixes())})"
        )
    # The variable name is `src_path` because this sentence is the SAME
    # refusal Create PDF raises, and the message table keys one row by the
    # interpolated names — a second spelling would fork the row and orphan
    # its translations.
    if suffix in create_pdf_mod.HEIF_SUFFIXES and not create_pdf_mod._register_heif():
        raise RuntimeError(
            f"HEIC/HEIF images need the pillow-heif plugin, which this runtime "
            f"does not have: {src_path}"
        )
    create_pdf_mod._register_heif()

    from PIL import Image, ImageSequence, UnidentifiedImageError  # noqa: PLC0415

    try:
        with Image.open(src_path) as im:
            frames = 0
            first = None
            for raw in ImageSequence.Iterator(im):
                frames += 1
                if first is None:
                    first = create_pdf_mod._normalise(raw.copy())
            if first is None:
                raise ValueError(f"the watermark image contains no frames: {path}")
            px_w, px_h = first.size
            # 72 dpi: the wrapper page's size is irrelevant here — only the
            # image XObject is lifted, and a watermark is placed relative to
            # the page it stamps, never at the picture's own physical size.
            data = create_pdf_mod._frame_pdf(first, 72.0)
    except UnidentifiedImageError as exc:
        raise ValueError(f"unreadable watermark image: {path} ({exc})") from None
    except (OSError, ValueError) as exc:
        raise ValueError(f"unreadable watermark image: {path} ({exc})") from None

    # Outside the decode's try: a degenerate size is the caller's picture, not
    # an unreadable file, and a raise the surrounding except re-labels would
    # reach the user under the wrong sentence.
    if px_w <= 0 or px_h <= 0:
        raise ValueError("the watermark image has no pixels")

    with pikepdf.open(io.BytesIO(data)) as wrapper:
        xobjects = wrapper.pages[0].obj.get("/Resources", {}).get("/XObject", {})
        source = None
        for _, candidate in (xobjects.items() if xobjects else []):
            if candidate.get("/Subtype") == Name.Image:
                source = candidate
                break
        if source is None:
            raise ValueError(f"unreadable watermark image: {path} (no image stream)")
        # The stream is copied still ENCODED (read_raw_bytes), so the filter
        # chain has to travel with it verbatim — decoding and re-encoding
        # here would throw away the plugin's per-mode filter choice, which is
        # the whole reason the encode goes through Create PDF.
        image = pdf.make_stream(source.read_raw_bytes())
        image.Type = Name.XObject
        image.Subtype = Name.Image
        image.Width = int(source.Width)
        image.Height = int(source.Height)
        image.BitsPerComponent = int(source.get("/BitsPerComponent", 8))
        # `_normalise` guarantees a mode the plugin writes with a NAMED device
        # colour space, so nothing indirect travels with the stream.
        image.ColorSpace = Name(str(source.ColorSpace))
        for key in ("/Filter", "/DecodeParms", "/Decode", "/ImageMask"):
            value = source.get(key)
            if value is not None:
                image[key] = _plain(value)
    return pdf.make_indirect(image), px_w, px_h, frames


def _same_path(a: str, b: str) -> bool:
    """Whether two paths name the same file ON DISK.

    Identity, never a string compare: two spellings of one file (a junction, a
    short name, a differently-cased drive letter) are the same file, and the
    recursion guard exists to catch exactly that. `samefile` needs both to
    exist, so a not-yet-written output falls back to the resolved paths.
    """
    try:
        return os.path.samefile(a, b)
    except OSError:
        try:
            return Path(a).resolve() == Path(b).resolve()
        except OSError:
            return False


def _page_content_bytes(page: pikepdf.Page) -> bytes:
    """The page's content stream(s), concatenated in order.

    A /Contents ARRAY is one stream split across objects and a token may
    straddle the split, so the parts join with a newline rather than being
    parsed and re-emitted.
    """
    contents = page.obj.get("/Contents")
    if contents is None:
        return b""
    if isinstance(contents, pikepdf.Array):
        return b"\n".join(bytes(part.read_bytes()) for part in contents)
    return bytes(contents.read_bytes())


def _source_matrix(
    x0: float, y0: float, width: float, height: float, rotate: int
) -> tuple[tuple[float, float, float, float, float, float], tuple[float, float]]:
    """(/Matrix, displayed size) placing a lifted page's own space so the form
    occupies [0 0 disp_w disp_h] under an identity CTM.

    The form's /BBox stays the source's crop box — clipping belongs in the
    source's own coordinates — and this matrix folds the crop origin away and
    turns the content by the source page's /Rotate, so the stamp shows what the
    source's own reader sees. /Rotate turns the page CLOCKWISE, which is why 90
    maps (x, y) to (y, W - x).
    """
    r = ((int(rotate) % 360) + 360) % 360
    if r == 90:
        return (0.0, -1.0, 1.0, 0.0, -y0, width + x0), (height, width)
    if r == 180:
        return (-1.0, 0.0, 0.0, -1.0, width + x0, height + y0), (width, height)
    if r == 270:
        return (0.0, 1.0, -1.0, 0.0, height + y0, -x0), (height, width)
    return (1.0, 0.0, 0.0, 1.0, -x0, -y0), (width, height)


def _appearance_ops(page: pikepdf.Page, resources: Dictionary) -> bytes:
    """Draw ops for the visible annotations on `page`, into `resources`.

    A Form XObject carries CONTENT only, so a page lifted without this loses
    whatever it draws as an annotation — a stamp, a freetext note, a filled
    widget — silently. The placement is the full appearance algorithm: the
    appearance /BBox is transformed by its own /Matrix, the bounding box of the
    result is mapped onto /Rect, and the two compose. The identity-/Matrix
    shortcut is not available here because a freetext appearance counter-rotates
    through exactly that key.

    /Popup (a reader's note window) and /Link (a navigation region) are not page
    artwork and are skipped, as is anything flagged Hidden or NoView.
    """
    annots = page.obj.get("/Annots")
    if not isinstance(annots, pikepdf.Array):
        return b""
    from engine.forms import AF_HIDDEN, AF_NOVIEW  # noqa: PLC0415

    xobjects = Dictionary(resources.get("/XObject") or Dictionary())
    ops: list[bytes] = []
    for index, annot in enumerate(annots):
        if not isinstance(annot, pikepdf.Dictionary):
            continue
        if str(annot.get("/Subtype", "")) in ("/Popup", "/Link"):
            continue
        try:
            flags = int(annot.get("/F", 0))
        except (TypeError, ValueError):
            flags = 0
        if flags & (AF_HIDDEN | AF_NOVIEW):
            continue
        appearance = annot.get("/AP")
        if not isinstance(appearance, pikepdf.Dictionary):
            continue
        normal = appearance.get("/N")
        if isinstance(normal, pikepdf.Dictionary) and not isinstance(normal, pikepdf.Stream):
            state = annot.get("/AS")
            normal = normal.get(state) if state is not None else None
        if not isinstance(normal, pikepdf.Stream):
            continue
        rect = annot.get("/Rect")
        if rect is None or len(rect) != 4:
            continue
        try:
            values = [float(v) for v in rect]
            bbox = [float(v) for v in (normal.get("/BBox") or [0, 0, 1, 1])]
            m = [float(v) for v in (normal.get("/Matrix") or [1, 0, 0, 1, 0, 0])]
        except (TypeError, ValueError):
            continue
        rx0, rx1 = min(values[0], values[2]), max(values[0], values[2])
        ry0, ry1 = min(values[1], values[3]), max(values[1], values[3])
        xs, ys = [], []
        for cx, cy in (
            (bbox[0], bbox[1]), (bbox[2], bbox[1]), (bbox[2], bbox[3]), (bbox[0], bbox[3])
        ):
            xs.append(m[0] * cx + m[2] * cy + m[4])
            ys.append(m[1] * cx + m[3] * cy + m[5])
        span_x = (max(xs) - min(xs)) or 1.0
        span_y = (max(ys) - min(ys)) or 1.0
        sx = (rx1 - rx0) / span_x
        sy = (ry1 - ry0) / span_y
        name = f"/WmAp{index}"
        xobjects[Name(name)] = normal
        ops.append(
            (
                f"q {_n(sx)} 0 0 {_n(sy)} "
                f"{_n(rx0 - min(xs) * sx)} {_n(ry0 - min(ys) * sy)} cm {name} Do Q"
            ).encode("latin-1")
        )
    if not ops:
        return b""
    resources["/XObject"] = xobjects
    return b"\n".join(ops)


def _lift_page(
    source_pdf: pikepdf.Pdf, index: int, path: str, page_number: int
) -> tuple[pikepdf.Object, float, float]:
    """The source page as ONE Form XObject in `source_pdf`: (object, displayed
    width, displayed height). The caller copy_foreigns it into the target.

    Built BY HAND rather than through `Page.as_form_xobject()`. That helper
    returns a stream whose data provider still reads the PAGE's contents at
    write time — measured on pikepdf 10.11.0 / libqpdf 12.3.2, where the
    returned object's objgen DIFFERS from the page's content stream and its
    BYTES still follow a later replacement of it. An object-identity check
    reports "not aliased" and is wrong. It also boxes the form on the media box
    and does not fold a non-zero crop origin.

    The form carries /Group << /S /Transparency >>: an /ExtGState alpha applies
    per painting operation, so without a group two overlapping opaque objects
    inside a lifted page composite twice and the overlap comes out twice as
    dark. A group makes the alpha apply to the artwork as a whole, which is what
    "this letterhead at 15%" means. The group is minimal — non-isolated,
    non-knockout, and NO /CS: an isolated group would require one, and naming a
    blending space pushes CMYK artwork through it on the way to the page.
    """
    page = source_pdf.pages[index]
    try:
        x0, y0, x1, y1 = _resolve_box(page)
    except ValueError:
        raise ValueError(
            f"watermark PDF page {page_number} has no /CropBox or /MediaBox: {path}"
        ) from None
    width, height = x1 - x0, y1 - y0
    if width <= 0 or height <= 0:
        raise ValueError(f"watermark PDF page {page_number} has no area: {path}")
    matrix, (disp_w, disp_h) = _source_matrix(x0, y0, width, height, _resolve_rotate(page))

    # A COPY of the resolved (inheritance-aware) resource dict, and a copy of
    # its /XObject sub-dictionary: registering the annotation appearances must
    # not mutate the source document.
    inherited = walk_inheritable(page, "/Resources")
    resources = Dictionary(inherited) if inherited is not None else Dictionary()
    body = b"q\n" + _page_content_bytes(page) + b"\nQ"
    appearances = _appearance_ops(page, resources)
    if appearances:
        body += b"\n" + appearances

    form = source_pdf.make_stream(body)
    form.Type = Name.XObject
    form.Subtype = Name.Form
    form.FormType = 1
    form.BBox = pikepdf.Array([x0, y0, x1, y1])
    form.Matrix = pikepdf.Array(list(matrix))
    form.Resources = resources
    form.Group = Dictionary(Type=Name.Group, S=Name.Transparency)
    return source_pdf.make_indirect(form), disp_w, disp_h


def _text_draw(
    pdf: pikepdf.Pdf,
    text: str,
    size: float,
    rgb: tuple[float, float, float],
    theta: float,
    centers: list[tuple[float, float]],
    uni: tuple | None,
) -> tuple[bytes, pikepdf.Object, float]:
    """(content ops, font object, em width) for the text source."""
    cos_t, sin_t = math.cos(theta), math.sin(theta)
    if uni is None:
        em_width = _text_width_em(text)
        show = b"(" + _escape_pdf_text(text).encode("latin-1") + b") Tj"
        font_obj = pdf.make_indirect(
            Dictionary(
                Type=Name.Font,
                Subtype=Name.Type1,
                BaseFont=Name.Helvetica,
                Encoding=Name.WinAnsiEncoding,
            )
        )
    else:
        font_obj, em_width, show = uni
    est_width = em_width * size
    r, g, b = rgb
    out = b""
    for cx, cy in centers:
        # Start of the baseline: back from center by half the text width along
        # the baseline direction, and down by ~half the cap height along the
        # rotated up-vector so the text is vertically centered too.
        tx = cx - (est_width / 2.0) * cos_t + (0.35 * size) * sin_t
        ty = cy - (est_width / 2.0) * sin_t - (0.35 * size) * cos_t
        out += (
            f"{_n(r)} {_n(g)} {_n(b)} rg "
            f"BT /F0 {_n(size)} Tf "
            f"{_n(cos_t)} {_n(sin_t)} {_n(-sin_t)} {_n(cos_t)} {_n(tx)} {_n(ty)} Tm "
        ).encode("latin-1") + show + b" ET"
    return out, font_obj, em_width


def _stamp_draw_size(
    src_w: float,
    src_h: float,
    disp_w: float,
    disp_h: float,
    angle: float,
    scale: float,
) -> tuple[float, float]:
    """The drawn width and height of a src_w x src_h stamp, in points.

    Auto fit is the size at which the stamp's ROTATED bounding box fills
    AUTO_FIT_FRACTION of the DISPLAYED page box, aspect preserved — the same
    fraction and the same displayed-orientation reasoning `_auto_font_size`
    uses, so `scale` 1.0 means the same thing to a reader for every source.
    `scale` multiplies that; above 1 it may overflow the page, which is what
    a bleed watermark asks for.

    src_w/src_h are the picture's PIXELS or the lifted page's DISPLAYED
    points — only their ratio is read, and neither is a physical size. An
    image's stored DPI is deliberately not consulted: a watermark is placed
    relative to the page it stamps, so the same logo at 72 and at 600 dpi must
    land identically.
    """
    hw, hh = _rotated_extent(src_w, src_h, angle)
    fit = min(
        AUTO_FIT_FRACTION * disp_w / (2.0 * hw),
        AUTO_FIT_FRACTION * disp_h / (2.0 * hh),
    )
    k = fit * scale
    return (src_w * k, src_h * k)


def _xobject_draw(
    draw_w: float,
    draw_h: float,
    theta: float,
    centers: list[tuple[float, float]],
    name: str,
    unit: tuple[float, float] = (1.0, 1.0),
) -> bytes:
    """Content ops placing the shared XObject `name` at each centre.

    One `cm` carries the size, the rotation and the translation together, with
    the XObject's own extent normalized into it: an Image XObject's space IS
    the unit square (`unit` (1, 1), and the emission is then byte-identical to
    the arithmetic the image arm shipped), while a lifted page's form spans its
    own displayed box.
    """
    unit_w, unit_h = unit
    cos_t, sin_t = math.cos(theta), math.sin(theta)
    a, b = draw_w * cos_t / unit_w, draw_w * sin_t / unit_w
    c, d = -draw_h * sin_t / unit_h, draw_h * cos_t / unit_h
    out = b""
    for cx, cy in centers:
        e = cx - (draw_w * cos_t) / 2.0 + (draw_h * sin_t) / 2.0
        f = cy - (draw_w * sin_t) / 2.0 - (draw_h * cos_t) / 2.0
        out += (
            f"q {_n(a)} {_n(b)} {_n(c)} {_n(d)} {_n(e)} {_n(f)} cm {name} Do Q"
        ).encode("latin-1")
    return out


def _make_watermark_form(
    pdf: pikepdf.Pdf,
    body: bytes,
    resources: Dictionary,
    opacity: float,
    width: float,
    height: float,
) -> pikepdf.Object:
    """Form XObject wrapping `body` in the shared alpha state, over a
    [0 0 W H] box. `resources` names the stamp's own font or image."""
    gs = pdf.make_indirect(Dictionary(Type=Name.ExtGState, ca=opacity, CA=opacity))
    form = pdf.make_stream(b"q /GS0 gs " + body + b" Q")
    form.Type = Name.XObject
    form.Subtype = Name.Form
    form.FormType = 1
    form.BBox = pikepdf.Array([0, 0, width, height])
    resources = Dictionary(resources)
    resources["/ExtGState"] = Dictionary(GS0=gs)
    form.Resources = resources
    return form


def watermark(
    file: str,
    output: str,
    text: str = "",
    opacity: float = 0.15,
    angle: float = 45.0,
    color: str = "#808080",
    font_size: float = 0.0,
    layer: str = "over",
    pages: list | None = None,
    font_dir: str = "",
    image: str = "",
    pdf_source: str = "",
    pdf_page: int = 1,
    scale: float = 1.0,
    position: str = "center",
    margin: float = DEFAULT_MARGIN,
    tile: bool = False,
    tile_gap: float = DEFAULT_TILE_GAP,
) -> dict:
    """Stamp translucent text, an image or a PDF page across pages.

    Args:
        file: Input PDF path.
        output: Output PDF path (may equal ``file`` for in-place).
        text: Watermark text. Latin-1 draws with WinAnsi Helvetica; anything
            outside it embeds a subsetted Unicode face from ``font_dir``, and
            is refused by name when no bundled face covers it.
        opacity: Fill/stroke alpha, 0 < opacity <= 1.
        angle: Degrees counter-clockwise in the page's DISPLAYED orientation
            (45 = classic diagonal).
        color: ``#rrggbb`` (text source only).
        font_size: Points; 0 auto-fits per page (~65% of the displayed
            extent along the text direction).
        layer: ``"over"`` (default — survives scans/opaque fills) or
            ``"under"`` (classic behind-the-text watermark).
        pages: 1-based page numbers; None = all pages, an explicit empty
            list = ZERO pages (matching rotate.py's convention — an empty
            selection must never silently widen to the whole document; the
            CLI's --pages parse rejects garbage for the same reason).
            Out-of-range entries are ignored (same convention as redact).
        image: Path to a picture to stamp INSTEAD of text — exactly one of
            ``text``, ``image`` and ``pdf_source`` is the source. Accepted
            extensions are Create PDF's own image set. The picture embeds ONCE
            per call and every page references that one XObject.
        pdf_source: Path to a PDF whose page is stamped as VECTOR artwork —
            a letterhead, a pre-drawn stamp. The page is lifted as one Form
            XObject, embedded ONCE per call, and nothing is rasterized. The
            source's own /Rotate is honoured and its visible annotations are
            drawn with it.
        pdf_page: 1-based page of ``pdf_source`` to lift (default 1).
        scale: Multiplier on the auto fit (the size at which the stamp's
            rotated bounding box fills ~65% of the displayed page box).
            Values above 1 may overflow the page, which is a real request.
        position: One of ``POSITIONS``, named in the DISPLAYED orientation.
        margin: Points inset from the page box for the non-centred anchors.
        tile: Repeat the stamp across the whole page box on a centred grid;
            ``position`` is ignored while tiling.
        tile_gap: Points between tiles in both directions.
    """
    has_text = bool(text and text.strip())
    has_image = bool(image and str(image).strip())
    has_pdf = bool(pdf_source and str(pdf_source).strip())
    if sum((has_text, has_image, has_pdf)) > 1:
        raise ValueError("a watermark has one source: give text, an image or a PDF page")
    if not (has_text or has_image or has_pdf):
        raise ValueError("a watermark needs text, an image or a PDF page")
    if not 0 < float(opacity) <= 1:
        raise ValueError(f"opacity must be in (0, 1], got {opacity}")
    if layer not in ("over", "under"):
        raise ValueError(f'layer must be "over" or "under", got {layer!r}')
    if position not in POSITIONS:
        raise ValueError(
            f"watermark position must be one of {', '.join(POSITIONS)}, got {position!r}"
        )
    try:
        scale_value = float(scale)
    except (TypeError, ValueError):
        raise ValueError(f"watermark scale must be a number, got {scale!r}") from None
    if not scale_value > 0:
        raise ValueError(f"watermark scale must be greater than 0, got {scale}")
    margin_value = float(margin)
    if margin_value < 0:
        raise ValueError(f"watermark margin must not be negative, got {margin}")
    gap_value = float(tile_gap)
    if gap_value < 0:
        raise ValueError(f"watermark tile gap must not be negative, got {tile_gap}")
    rgb = _parse_color(color)

    input_path = Path(file)
    output_path = Path(output)
    same_file = input_path.resolve() == output_path.resolve()

    source_path = ""
    page_number = 1
    if has_pdf:
        source_path = str(pdf_source).strip()
        page_number = int(pdf_page)
        if page_number < 1:
            raise ValueError(
                f"watermark page number must be 1 or greater, got {pdf_page}"
            )
        source_file = Path(source_path)
        if not source_file.is_file():
            raise ValueError(f"watermark PDF not found: {source_path}")
        if source_file.stat().st_size == 0:
            raise ValueError(f"watermark PDF is empty: {source_path}")
        # The recursion guard, by IDENTITY: a document whose every page carries
        # a copy of itself is nobody's request, and a source that IS the output
        # is about to be overwritten by the thing that reads it.
        if _same_path(source_path, str(input_path)):
            raise ValueError(f"a PDF cannot be its own watermark source: {source_path}")
        if _same_path(source_path, str(output_path)):
            raise ValueError(
                f"the watermark PDF and the output are the same file: {source_path}"
            )

    wanted: set[int] | None = None
    if pages is not None:
        wanted = {int(p) for p in pages}

    pages_watermarked = 0
    font_size_applied = 0.0
    tiles_per_page = 0
    image_frames = 0
    pdf_page_count = 0
    with contextlib.ExitStack() as stack:
        pdf = stack.enter_context(pikepdf.open(file))
        # A non-Latin-1 stamp is drawn with a subsetted Type0 font SHARED
        # across pages (the text is constant), else the WinAnsi Helvetica path
        # (uni=None, byte-identical). Resolve the FACE upfront (cheap, no
        # mutation) so a bad font_dir refuses before touching pages; the embed
        # itself is built LAZILY on the first stamped page, so pages=[] / an
        # An all-out-of-range selection is a true no-op that never fails on
        # coverage. The build's uncoverable-character raise still
        # happens before any add_overlay/save = atomic.
        needs_unicode = False
        face = ""
        draw_text = ""
        glyph_height: float | None = None
        if has_text:
            try:
                text.encode("latin-1")
            except UnicodeEncodeError:
                needs_unicode = True
                face = _unicode_watermark_face(font_dir, text) or ""
                if not face:
                    raise ValueError(
                        "watermark text contains characters outside Latin-1 and no "
                        "fallback font is available"
                    )
                # A stamp is single-line: every layout control or separator,
                # including \x0b, \x0c, and U+2028,
                # flattens to space so the drawn glyph set matches the embed.
                draw_text = _flatten_control_chars(text, keep_newline=False)
                glyph_height = _face_glyph_height_em(face)

        # The picture embeds ONCE, before the loop: one XObject in the file
        # however many pages reference it. Doing it here also means a bad
        # image refuses before any page is touched.
        image_obj = None
        stamp_px: tuple[float, float] = (0.0, 0.0)
        if has_image:
            image_obj, px_w, px_h, image_frames = _embed_image(pdf, str(image).strip())
            stamp_px = (float(px_w), float(px_h))

        # The lifted page embeds ONCE, on the same rule and for the same
        # reason. The source document is entered on the STACK, so it outlives
        # the copy_foreign and stays open through this document's save.
        source_obj = None
        source_unit: tuple[float, float] = (1.0, 1.0)
        if has_pdf:
            try:
                source_pdf_doc = stack.enter_context(pikepdf.open(source_path))
            except pikepdf.PasswordError:
                raise ValueError(
                    f"the watermark PDF is password protected: {source_path}"
                ) from None
            except pikepdf.PdfError as exc:
                raise ValueError(
                    f"unreadable watermark PDF: {source_path} ({exc})"
                ) from None
            pdf_page_count = len(source_pdf_doc.pages)
            if pdf_page_count == 0:
                raise ValueError(f"the watermark PDF has no pages: {source_path}")
            if page_number > pdf_page_count:
                raise ValueError(
                    f"watermark PDF page {page_number} is out of range — "
                    f"{source_path} has {pdf_page_count} pages"
                )
            lifted, src_w, src_h = _lift_page(
                source_pdf_doc, page_number - 1, source_path, page_number
            )
            source_obj = pdf.copy_foreign(lifted)
            stamp_px = (src_w, src_h)
            source_unit = (src_w, src_h)

        uni: tuple | None = None
        auto_em: float | None = None
        auto_gh: float | None = None
        for index, page in enumerate(pdf.pages, start=1):
            if wanted is not None and index not in wanted:
                continue
            rotate = _resolve_rotate(page)
            x0, y0, x1, y1 = _resolve_box(page)
            width, height = x1 - x0, y1 - y0
            if width <= 0 or height <= 0:
                continue
            # The form is placed into the page's DISPLAYED rectangle (module
            # docstring), so the form's own box is the displayed box and its
            # coordinates are the reader's. `angle` therefore needs no /Rotate
            # correction: it already means degrees in the displayed
            # orientation, which is what it is documented to mean.
            disp_w, disp_h = _displayed_box(width, height, rotate)
            theta = math.radians(angle)
            if has_image or has_pdf:
                draw_w, draw_h = _stamp_draw_size(
                    stamp_px[0], stamp_px[1], disp_w, disp_h, float(angle), scale_value
                )
                centers = _centers(
                    disp_w, disp_h, float(angle), draw_w, draw_h,
                    position, margin_value, bool(tile), gap_value,
                )
                if has_image:
                    body = _xobject_draw(draw_w, draw_h, theta, centers, "/Im0")
                    resources = Dictionary(XObject=Dictionary(Im0=image_obj))
                else:
                    body = _xobject_draw(
                        draw_w, draw_h, theta, centers, "/Fm0", unit=source_unit
                    )
                    resources = Dictionary(XObject=Dictionary(Fm0=source_obj))
                size = 0.0
            else:
                if needs_unicode and uni is None:
                    # A right-to-left stamp reorders (and shapes, where the
                    # script joins) before it is drawn; everything else keeps
                    # the shipped single-`Tj` emission byte for byte.
                    rtl_built = _rtl_stamp(pdf, face, draw_text)
                    if rtl_built is not None:
                        font_obj, auto_em, show = rtl_built
                    else:
                        from engine.font_fallback import build_fallback_font

                        font_obj, encode, width_1000 = build_fallback_font(pdf, face, draw_text)
                        auto_em = width_1000(draw_text) / 1000.0
                        show = b"<" + encode(draw_text).hex().encode("ascii") + b"> Tj"
                    auto_gh = glyph_height
                    uni = (font_obj, auto_em, show)
                # `scale` multiplies the AUTO size, so it means the same thing
                # to a reader for either source. An explicit `font_size` is an
                # explicit size and is not scaled — two numbers fighting over
                # one dimension would make neither of them mean anything. The
                # legibility floor is inside the auto fit and is deliberately
                # not re-applied: a small scale is a request, not an accident.
                size = (
                    float(font_size)
                    if float(font_size) > 0
                    else _auto_font_size(
                        text, width, height, rotate, angle,
                        em_width=auto_em, glyph_height_em=auto_gh,
                    ) * scale_value
                )
                em = auto_em if auto_em is not None else _text_width_em(text)
                gh = auto_gh if auto_gh is not None else _GLYPH_HEIGHT_EM
                centers = _centers(
                    disp_w, disp_h, float(angle), em * size, gh * size,
                    position, margin_value, bool(tile), gap_value,
                )
                body, font_used, _ = _text_draw(pdf, text, size, rgb, theta, centers, uni)
                resources = Dictionary(Font=Dictionary(F0=font_used))
            form = _make_watermark_form(pdf, body, resources, float(opacity), disp_w, disp_h)
            rect = pikepdf.Rectangle(x0, y0, x1, y1)
            if layer == "over":
                page.add_overlay(form, rect)
            else:
                page.add_underlay(form, rect)
            if pages_watermarked == 0:
                font_size_applied = size
                tiles_per_page = len(centers)
            pages_watermarked += 1

        if same_file:
            with tempfile.NamedTemporaryFile(
                suffix=".pdf", delete=False, dir=str(input_path.parent)
            ) as tmp:
                tmp_path = tmp.name
            save_pdf(pdf, tmp_path)
        else:
            save_pdf(pdf, output_path)

    if same_file:
        shutil.move(tmp_path, str(output_path))

    return {
        "output": str(output_path),
        "pages_watermarked": pages_watermarked,
        "font_size_applied": round(font_size_applied, 2),
        "layer": layer,
        "source": "pdf" if has_pdf else ("image" if has_image else "text"),
        "image_frames": image_frames,
        "pdf_pages": pdf_page_count,
        "pdf_page_used": page_number if has_pdf else 0,
        "scale_applied": round(scale_value, 4),
        "tiles_per_page": tiles_per_page,
    }
