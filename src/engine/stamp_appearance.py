"""The visible certificate-signature stamp's appearance: one author.

Everything a signature stamp can look like is specified here and drawn here —
the text lines, the logo or background raster, the layout that decides whether
the raster sits behind the text or beside it, and the personal-signature face.
`signatures.sign_pdf` calls `stamp_style()` and nothing else, so EVERY
placement (a new visible stamp, an existing-field fill, in-place signing, the
incremental append onto an already-signed document, PAdES/TSA/LTV,
certification, locks) and every signer source draws through this module.

The preview is the same author again: `preview_appearance()` renders the stamp
into a one-page PDF whose page IS the stamp box, and the surfaces rasterize
that PDF the way they rasterize any document. A surface never re-implements
the drawing, so a preview cannot disagree with what gets signed.

COMPOSITION. A stamp is a text block with up to two SIDECARS attached to it,
each occupying a band on one side, plus an optional background behind
everything:

  - the raster with `layout` "over" becomes the background (pyHanko's own
    `background`/`background_opacity`/`background_layout` members), scaled
    with the aspect preserved;
  - the raster with `layout` "beside" becomes a sidecar on `image_position`;
  - the personal-signature face is always a sidecar, on `signature_position`.

The sidecar mechanism is the extension point pyHanko's own QR stamp uses —
`TextStamp._inner_layout_natural_size` — generalized from one sidecar to a
list. Nothing here forks the stamp machinery.

DETERMINISM. The same request drawn twice must produce the same bytes: an
appearance that differs run to run turns an in-place save and its control into
an order-dependent byte diff (the `recalcTimestamp=False` lesson). So every
resource name in the appearance is derived from the content that names it,
never from a fresh uuid, and the typed personal signature is drawn as GLYPH
OUTLINES rather than as an embedded font program. Outlines carry no `head`
timestamp and need no subset tag, which pyHanko's font engine draws at random
per instantiation; and a signature face is artwork rather than readable text,
so nothing is lost that a mark needs. The interpolated signing time is the one
part that legitimately varies, and it varies in the text block only.
"""

import base64
import binascii
import hashlib
import io
import os
from dataclasses import dataclass

from pyhanko import stamp
from pyhanko.pdf_utils import content, layout
from pyhanko.pdf_utils.images import PdfImage

__all__ = [
    "StampAppearance",
    "parse_appearance",
    "stamp_style",
    "preview_appearance",
    "TEXT_FIELDS",
    "LAYOUTS",
    "POSITIONS",
]

# The lines a stamp can render, in the order this module knows how to build
# them. The REQUEST decides which ones appear and in what order.
TEXT_FIELDS = ("name", "date", "reason", "location", "label")
LAYOUTS = ("over", "beside")
POSITIONS = ("left", "right", "top", "bottom")

DEFAULT_FIELDS = ("name", "date", "reason", "location")

# Padding between a sidecar and what it sits beside, in points.
INNER_SEPARATION = 4

# Below this the text is not text any more. A box that would force the stamp
# under it is refused by name rather than signed with an illegible mark.
MIN_LEGIBLE_FONT_SIZE = 4.0

class StampAppearanceRefusal(ValueError):
    """A stamp that cannot be drawn as asked. Every message names what is
    wrong and what would fix it; nothing here substitutes a different mark for
    the one the user chose."""


# ---------------------------------------------------------------------------
# The specification
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class FaceSource:
    """The personal-signature face, resolved. Mirrors the renderer's
    `SignatureFaceSource` (src/renderer/lib/signature-assets.ts) — the surface
    resolves its own store and sends the resolved form, so this module knows
    nothing about where a signature is kept."""

    form: str  # "vector" | "image" | "typed"
    aspect: float
    paths: tuple = ()
    image_bytes: bytes | None = None
    text: str = ""
    font_file: str = ""


@dataclass(frozen=True)
class StampAppearance:
    fields: tuple = DEFAULT_FIELDS
    label: str = ""
    layout_mode: str = "over"
    image_bytes: bytes | None = None
    image_position: str = "left"
    image_opacity: float = 1.0
    signature: FaceSource | None = None
    signature_position: str = "left"
    font_size: int = 10
    # Where the bundled signature faces live (the Rust `get_edit_font_path`
    # directory the other engine text paths are handed).
    font_dir: str = ""

    def is_default(self) -> bool:
        """True when the appearance asks for exactly what a stamp drew before
        appearances existed — the one case that must reproduce the old style
        object rather than a new one."""
        return (
            self.fields == DEFAULT_FIELDS
            and not self.label
            and self.image_bytes is None
            and self.signature is None
        )


def _one_of(value, allowed, what: str) -> str:
    text = str(value or "").strip().lower()
    if text not in allowed:
        raise StampAppearanceRefusal(
            f"{what} must be one of {', '.join(allowed)}, not \"{value}\"."
        )
    return text


def _decode_image(spec: dict) -> bytes:
    """The raster's bytes, from a path or from inline base64. Refuses by name
    when it cannot be read or is not a raster we can embed."""
    from PIL import Image, UnidentifiedImageError

    data = spec.get("data")
    path = spec.get("path")
    if data:
        try:
            raw = base64.b64decode(data, validate=True)
        except (binascii.Error, ValueError):
            raise StampAppearanceRefusal(
                "The stamp image could not be read — it is not valid image data."
            ) from None
    elif path:
        try:
            with open(path, "rb") as fh:
                raw = fh.read()
        except OSError:
            raise StampAppearanceRefusal(
                f'The stamp image "{path}" could not be read — check that the '
                "file exists and is a PNG or JPEG."
            ) from None
    else:
        raise StampAppearanceRefusal(
            "The stamp image needs a file path or image data."
        )
    try:
        with Image.open(io.BytesIO(raw)) as probe:
            probe.load()
            kind = probe.format or "unknown"
    except (UnidentifiedImageError, OSError, ValueError):
        raise StampAppearanceRefusal(
            "The stamp image could not be read — it is not a readable PNG or JPEG."
        ) from None
    # Outside the decode's own guard: a format we can read but will not embed
    # is a different answer from a file we cannot read at all, and it must not
    # be caught by the handler that speaks to the second case.
    if kind not in ("PNG", "JPEG"):
        raise StampAppearanceRefusal(
            f"The stamp image is a {kind} file — use a PNG or a JPEG."
        )
    return raw


def _face_from_file(path: str) -> dict:
    """A personal signature named by FILE rather than resolved from the app's
    own store.

    The store lives in the renderer's local settings, which a command-line run
    has no window to read; rather than pretend otherwise, the CLI names a file.
    A PNG or JPEG is the mark itself; a `.json` file is the same resolved face
    the surfaces build (`SignatureFaceSource`), so a drawn or typed signature
    reaches the CLI through exactly one shape and not a second dialect."""
    import json

    try:
        with open(path, "rb") as fh:
            raw = fh.read()
    except OSError:
        raise StampAppearanceRefusal(
            f'The signature file "{path}" could not be read.'
        ) from None
    if raw[:1] in (b"{", b"["):
        try:
            parsed = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            raise StampAppearanceRefusal(
                f'The signature file "{path}" is not a readable signature.'
            ) from None
        if not isinstance(parsed, dict):
            raise StampAppearanceRefusal(
                f'The signature file "{path}" is not a readable signature.'
            )
        return parsed
    from PIL import Image, UnidentifiedImageError

    try:
        with Image.open(io.BytesIO(raw)) as probe:
            probe.load()
            aspect = (probe.height / probe.width) if probe.width else 0.0
    except (UnidentifiedImageError, OSError, ValueError):
        raise StampAppearanceRefusal(
            f'The signature file "{path}" is not a readable PNG, JPEG, or '
            "exported signature."
        ) from None
    return {
        "form": "image",
        "aspect": aspect,
        "image": {"data": base64.b64encode(raw).decode("ascii")},
    }


def _parse_face(spec: dict, font_dir: str) -> FaceSource:
    if spec.get("file") and not spec.get("form"):
        spec = _face_from_file(str(spec["file"]))
    form = _one_of(spec.get("form"), ("vector", "image", "typed"), "The signature form")
    try:
        aspect = float(spec.get("aspect") or 0.0)
    except (TypeError, ValueError):
        aspect = 0.0
    if not (aspect > 0):
        raise StampAppearanceRefusal(
            "The chosen signature has no usable shape — capture or import it again."
        )
    if form == "vector":
        raw_paths = spec.get("paths") or []
        paths = []
        for entry in raw_paths:
            try:
                flat = [float(v) for v in entry]
            except (TypeError, ValueError):
                flat = []
            if len(flat) >= 4 and len(flat) % 2 == 0:
                paths.append(tuple(flat))
        if not paths:
            raise StampAppearanceRefusal(
                "The chosen signature has no strokes to draw."
            )
        return FaceSource(form=form, aspect=aspect, paths=tuple(paths))
    if form == "image":
        return FaceSource(
            form=form, aspect=aspect, image_bytes=_decode_image(spec.get("image") or {})
        )
    typed = spec.get("typed") or {}
    text = str(typed.get("text") or "").strip()
    file_name = str(typed.get("fontFile") or "").strip()
    if not text:
        raise StampAppearanceRefusal("The typed signature has no text to set.")
    # The face is named by FILE NAME within the app's own fonts directory and
    # resolved here; a path that escapes that directory is not a bundled face,
    # and a system font is never one (lib/signature-fonts).
    if not file_name or os.path.basename(file_name) != file_name:
        raise StampAppearanceRefusal(
            f'"{file_name}" is not one of the signature faces that ship with the app.'
        )
    resolved = os.path.join(font_dir or "", file_name)
    if not font_dir or not os.path.isfile(resolved):
        raise StampAppearanceRefusal(
            f'The signature face "{file_name}" could not be read from the '
            "app's fonts folder — the installation is incomplete."
        )
    return FaceSource(form=form, aspect=aspect, text=text, font_file=resolved)


def parse_appearance(spec: dict | None, font_dir: str = "") -> StampAppearance:
    """The wire dict → a validated appearance. Every refusal this can raise is
    raised HERE, before any signing work starts, so a bad appearance never
    costs a hardware key its consent prompt."""
    if not spec:
        return StampAppearance(font_dir=font_dir)
    raw_fields = spec.get("fields")
    if raw_fields is None:
        fields = DEFAULT_FIELDS
    else:
        fields = []
        for name in raw_fields:
            key = str(name or "").strip().lower()
            if key not in TEXT_FIELDS:
                raise StampAppearanceRefusal(
                    f'"{name}" is not a signature stamp line — choose from '
                    f"{', '.join(TEXT_FIELDS)}."
                )
            if key not in fields:
                fields.append(key)
        fields = tuple(fields)
    layout_mode = _one_of(spec.get("layout") or "over", LAYOUTS, "The stamp layout")
    image_spec = spec.get("image")
    image_bytes = _decode_image(image_spec) if image_spec else None
    try:
        opacity = float(spec.get("image_opacity", 1.0))
    except (TypeError, ValueError):
        opacity = 1.0
    opacity = min(1.0, max(0.0, opacity))
    face_spec = spec.get("signature")
    try:
        font_size = int(spec.get("font_size") or 10)
    except (TypeError, ValueError):
        font_size = 10
    return StampAppearance(
        fields=fields,
        label=str(spec.get("label") or "").strip(),
        layout_mode=layout_mode,
        image_bytes=image_bytes,
        image_position=_one_of(
            spec.get("image_position") or "left", POSITIONS, "The image position"
        ),
        image_opacity=opacity,
        signature=_parse_face(face_spec, font_dir) if face_spec else None,
        signature_position=_one_of(
            spec.get("signature_position") or "left", POSITIONS, "The signature position"
        ),
        font_size=max(1, min(72, font_size)),
        font_dir=font_dir,
    )


# ---------------------------------------------------------------------------
# The text block
# ---------------------------------------------------------------------------


def stamp_text(appearance: StampAppearance, reason: str | None, location: str | None) -> str:
    """The template pyHanko interpolates. USER TEXT IS %-ESCAPED —
    TextStampStyle interpolates with %(...)s, so a literal % in a reason like
    "100% reviewed" would otherwise raise (or worse, interpolate) at sign
    time."""
    lines = []
    for name in appearance.fields:
        if name == "name":
            lines.append("Digitally signed by %(signer)s")
        elif name == "date":
            lines.append("%(ts)s")
        elif name == "reason" and reason and reason.strip():
            lines.append("Reason: " + reason.strip().replace("%", "%%"))
        elif name == "location" and location and location.strip():
            lines.append("Location: " + location.strip().replace("%", "%%"))
        elif name == "label" and appearance.label:
            lines.append(appearance.label.replace("%", "%%"))
    return "\n".join(lines)


# ---------------------------------------------------------------------------
# The personal-signature face as drawable content
# ---------------------------------------------------------------------------


def _fmt(value: float) -> str:
    """A number with a FIXED spelling. `repr` of a float differs across the
    same value reached two ways; a stamp that spells its own coordinates
    differently run to run is not byte-identical."""
    return f"{value:.4f}".rstrip("0").rstrip(".") or "0"


def _vector_commands(paths, width: float, height: float) -> bytes:
    """Unit-box paths (y DOWN, the display convention the asset store uses)
    drawn as PDF vector content (y UP) filling `width` x `height`.

    The ink is STROKED, not filled: a captured signature is a pen path, and
    filling it would close every stroke into a blob."""
    pen = max(0.35, min(width, height) * 0.02)
    out = [b"q 0 0 0 RG %s w 1 J 1 j" % _fmt(pen).encode("ascii")]
    for flat in paths:
        segments = []
        for i in range(0, len(flat) - 1, 2):
            x = flat[i] * width
            y = (1.0 - flat[i + 1]) * height
            segments.append(
                b"%s %s %s" % (
                    _fmt(x).encode("ascii"),
                    _fmt(y).encode("ascii"),
                    b"m" if i == 0 else b"l",
                )
            )
        if segments:
            out.append(b" ".join(segments))
            out.append(b"S")
    out.append(b"Q")
    return b" ".join(out)


def _typed_commands(face: FaceSource, width: float, height: float) -> bytes:
    """A typed signature drawn as glyph OUTLINES from the bundled face.

    Shaped through the face's own tables (so a script face's ligatures and
    kerning are the face's, not this module's guesswork), then filled. No font
    program travels into the document, so there is no `head.modified` to
    freeze and no random subset tag to pin — the appearance is deterministic
    by construction rather than by discipline."""
    from fontTools.ttLib import TTFont

    from . import shaping

    try:
        run = shaping.shape(face.font_file, face.text, rtl=False)
    except ValueError:
        raise StampAppearanceRefusal(
            "The chosen signature face cannot set that name — choose another "
            "face, or draw or import the signature instead."
        ) from None
    if not run.glyphs:
        raise StampAppearanceRefusal("The typed signature has no text to set.")

    # `recalcTimestamp=False`: the face's own `head.modified` travels, never
    # the run's clock. Nothing is saved from here, and the flag stays anyway —
    # the invariant is that this project never opens a face without it.
    tt = TTFont(face.font_file, fontNumber=0, recalcTimestamp=False)
    try:
        upem = float(tt["head"].unitsPerEm or 1000)
        glyph_set = tt.getGlyphSet()
        # Draw in a 1000/em space (the space `shaping` reports advances in),
        # then scale the whole run into the box.
        scale_1000 = 1000.0 / upem
        contours = []
        cursor = 0.0
        min_y = None
        max_y = None
        for name, advance, dx, dy in run.glyphs:
            if name not in glyph_set:
                raise StampAppearanceRefusal(
                    "The chosen signature face cannot set that name — choose "
                    "another face, or draw or import the signature instead."
                )
            pen = _CubicPen(glyph_set)
            glyph_set[name].draw(pen)
            origin = (cursor + dx, dy)
            for op, args in pen.value:
                points = [
                    (origin[0] + px * scale_1000, origin[1] + py * scale_1000)
                    for (px, py) in args
                ]
                for _px, py in points:
                    min_y = py if min_y is None else min(min_y, py)
                    max_y = py if max_y is None else max(max_y, py)
                contours.append((op, points))
            cursor += advance
    finally:
        tt.close()

    total = cursor or 1.0
    span = (max_y - min_y) if (min_y is not None and max_y is not None) else 0.0
    if span <= 0:
        span = 1000.0
        min_y = 0.0
    # Uniform: the artwork's own aspect decides the height it occupies, so the
    # name is never stretched to the box's shape.
    unit = min(width / total, height / span)
    off_x = (width - total * unit) / 2.0
    off_y = (height - span * unit) / 2.0 - (min_y or 0.0) * unit

    out = [b"q 0 0 0 rg"]
    for op, points in contours:
        coords = " ".join(
            f"{_fmt(off_x + px * unit)} {_fmt(off_y + py * unit)}" for px, py in points
        )
        if op == "moveTo":
            out.append(f"{coords} m".encode("ascii"))
        elif op == "lineTo":
            out.append(f"{coords} l".encode("ascii"))
        elif op == "curveTo":
            out.append(f"{coords} c".encode("ascii"))
        elif op == "closePath":
            out.append(b"h")
    out.append(b"f")
    out.append(b"Q")
    return b" ".join(c for c in out if c)


def _cubic_pen_class():
    """`BasePen` subclass recording only the four operators PDF has.

    `BasePen` is the conversion: it decomposes composite glyphs through the
    glyph set it is given and expresses TrueType's quadratic curves as cubics,
    so nothing here has to reproduce either rule."""
    from fontTools.pens.basePen import BasePen

    class _Pen(BasePen):
        def __init__(self, glyph_set):
            super().__init__(glyph_set)
            self.value: list = []

        def _moveTo(self, pt):
            self.value.append(("moveTo", (pt,)))

        def _lineTo(self, pt):
            self.value.append(("lineTo", (pt,)))

        def _curveToOne(self, pt1, pt2, pt3):
            self.value.append(("curveTo", (pt1, pt2, pt3)))

        def _closePath(self):
            self.value.append(("closePath", ()))

    return _Pen


_CUBIC_PEN = None


def _CubicPen(glyph_set):  # noqa: N802 - a class factory used as a constructor
    global _CUBIC_PEN
    if _CUBIC_PEN is None:
        _CUBIC_PEN = _cubic_pen_class()
    return _CUBIC_PEN(glyph_set)


class _FaceContent(content.PdfContent):
    """The personal-signature face as a piece of PDF content sized to its own
    box. One class for all three forms, so the sidecar machinery has exactly
    one kind of thing to place."""

    def __init__(self, face: FaceSource, width: float, height: float):
        super().__init__(box=layout.BoxConstraints(width, height))
        self.face = face
        self._width = width
        self._height = height

    def render(self) -> bytes:
        face = self.face
        if face.form == "vector":
            return _vector_commands(face.paths, self._width, self._height)
        if face.form == "typed":
            return _typed_commands(face, self._width, self._height)
        image = _pdf_image(face.image_bytes, box=layout.BoxConstraints(
            round(self._width), round(self._height)
        ))
        image.set_writer(self.writer)
        rendered = image.render()
        self.import_resources(image.resources)
        return rendered


def _pdf_image(raw: bytes, box=None, opacity: float | None = None) -> PdfImage:
    """A raster as pyHanko content, with a resource name derived from the
    BYTES rather than from a fresh uuid — two runs of one request must name
    the same image the same way."""
    from PIL import Image

    img = Image.open(io.BytesIO(raw))
    img.load()
    return PdfImage(
        img,
        name=hashlib.sha256(raw).hexdigest()[:16],
        box=box,
        opacity=opacity,
    )


# ---------------------------------------------------------------------------
# The stamp
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class _Sidecar:
    """A piece of content occupying a band on one side of the text block."""

    position: str
    aspect: float
    build: object  # (width, height) -> content.PdfContent


@dataclass(frozen=True)
class SidecarStampStyle(stamp.TextStampStyle):
    """A text stamp with content attached to its sides.

    This is the same seam pyHanko's own QR stamp extends, generalized from one
    attached graphic to a list of them: `TextStamp._inner_layout_natural_size`
    reports the inner block's commands and natural size, and a subclass may
    grow that block before the stamp positions it. Nothing about the stamp
    machinery is forked."""

    sidecars: tuple = ()
    innsep: int = INNER_SEPARATION
    min_font_size: float = MIN_LEGIBLE_FONT_SIZE

    def create_stamp(self, writer, box, text_params) -> "SidecarStamp":
        return SidecarStamp(writer=writer, style=self, box=box, text_params=text_params)


class SidecarStamp(stamp.TextStamp):
    def _inner_content_layout_rule(self):
        return self.style.inner_content_layout or layout.SimpleBoxLayoutRule(
            x_align=layout.AxisAlignment.ALIGN_MID,
            y_align=layout.AxisAlignment.ALIGN_MID,
            margins=layout.Margins.uniform(self.style.innsep),
            inner_content_scaling=layout.InnerScaling.SHRINK_TO_FIT,
        )

    def _render_inner_content(self):
        """The library states a box that cannot hold its margins as a layout
        error. That is this module's fit refusal reached by another road, so it
        arrives as the same sentence rather than as a library string."""
        try:
            return super()._render_inner_content()
        except layout.LayoutError:
            raise StampAppearanceRefusal(
                "The signature stamp does not fit in that box — make the box bigger, "
                "or leave out the image, the signature, or some of the text lines."
            ) from None

    def _inner_layout_natural_size(self):
        commands, (width, height) = super()._inner_layout_natural_size()
        for index, sidecar in enumerate(self.style.sidecars):
            commands, (width, height) = self._attach(
                commands, width, height, sidecar, index
            )
        self._refuse_if_illegible(width, height)
        return commands, (width, height)

    def _refuse_if_illegible(self, inner_width: float, inner_height: float) -> None:
        """A box too small for what was asked for is a REFUSAL, not a stamp
        rendered at a size nobody can read.

        An invisible signature never reaches this: the library builds no stamp
        at all for a zero-size widget, which is how an existing signature field
        with one signs invisibly by its own design."""
        box = self.box
        if not (box.width_defined and box.height_defined):
            return
        rule = self._inner_content_layout_rule()
        margins = rule.margins
        eff_w = margins.effective_width(box.width)
        eff_h = margins.effective_height(box.height)
        if eff_w <= 0 or eff_h <= 0 or inner_width <= 0 or inner_height <= 0:
            raise StampAppearanceRefusal(
                "The signature stamp does not fit in that box — make the box bigger, "
                "or leave out the image, the signature, or some of the text lines."
            )
        scale = min(eff_w / inner_width, eff_h / inner_height, 1.0)
        if scale * self.style.text_box_style.font_size < self.style.min_font_size:
            raise StampAppearanceRefusal(
                "The signature stamp does not fit in that box — make the box bigger, "
                "or leave out the image, the signature, or some of the text lines."
            )

    def _attach(self, commands, width: float, height: float, sidecar: _Sidecar, index: int):
        """Put `sidecar` on one side of the block built so far, and return the
        grown block. Sizing keeps the sidecar's own aspect: it takes the
        block's extent along the shared axis and derives the other."""
        innsep = self.style.innsep
        horizontal = sidecar.position in ("left", "right")
        aspect = sidecar.aspect if sidecar.aspect > 0 else 1.0
        if horizontal:
            sc_h = max(1.0, height)
            sc_w = max(1.0, sc_h / aspect)
        else:
            sc_w = max(1.0, width)
            sc_h = max(1.0, sc_w * aspect)

        item = sidecar.build(sc_w, sc_h)
        item.set_writer(self.writer)
        rendered = item.render()
        self.import_resources(item.resources)
        name = ("/Sidecar%d" % index).encode("ascii")
        self.set_resource(
            category=content.ResourceType.XOBJECT,
            name=content.pdf_name(name.decode("ascii")),
            value=self.writer.add_object(item.as_form_xobject()),
        )

        if horizontal:
            new_w = width + sc_w + innsep
            new_h = max(height, sc_h)
            sc_x = 0.0 if sidecar.position == "left" else width + innsep
            block_x = sc_w + innsep if sidecar.position == "left" else 0.0
            sc_y = (new_h - sc_h) / 2.0
            block_y = (new_h - height) / 2.0
        else:
            new_w = max(width, sc_w)
            new_h = height + sc_h + innsep
            sc_y = height + innsep if sidecar.position == "top" else 0.0
            block_y = 0.0 if sidecar.position == "top" else sc_h + innsep
            sc_x = (new_w - sc_w) / 2.0
            block_x = (new_w - width) / 2.0

        out = [
            b"q 1 0 0 1 %s %s cm %s Do Q"
            % (_fmt(sc_x).encode("ascii"), _fmt(sc_y).encode("ascii"), name),
            b"q 1 0 0 1 %s %s cm"
            % (_fmt(block_x).encode("ascii"), _fmt(block_y).encode("ascii")),
        ]
        out.extend(commands)
        out.append(b"Q")
        return out, (new_w, new_h)


def _sidecars(appearance: StampAppearance) -> tuple:
    """The attached graphics, innermost first: the personal signature sits
    against the text, and a beside-layout logo sits outside it."""
    out = []
    face = appearance.signature
    if face is not None:
        out.append(
            _Sidecar(
                position=appearance.signature_position,
                aspect=face.aspect,
                build=lambda w, h, f=face: _FaceContent(f, w, h),
            )
        )
    if appearance.image_bytes is not None and appearance.layout_mode == "beside":
        raw = appearance.image_bytes
        from PIL import Image

        with Image.open(io.BytesIO(raw)) as probe:
            aspect = (probe.height / probe.width) if probe.width else 1.0
        out.append(
            _Sidecar(
                position=appearance.image_position,
                aspect=aspect,
                build=lambda w, h, b=raw: _pdf_image(
                    b, box=layout.BoxConstraints(round(w), round(h))
                ),
            )
        )
    return tuple(out)


def stamp_style(
    reason: str | None,
    location: str | None,
    appearance: StampAppearance | None = None,
) -> "stamp.TextStampStyle":
    """The style every visible placement draws with.

    With no appearance — or with one that asks for exactly the default lines
    and nothing else — this returns the plain text stamp signing has always
    produced, so an unconfigured signature is byte-for-byte the signature it
    was before appearances existed."""
    from dataclasses import replace

    appearance = appearance or StampAppearance()
    text = stamp_text(appearance, reason, location)
    default_text_box = stamp.TextStampStyle().text_box_style
    text_box = (
        default_text_box
        if appearance.font_size == default_text_box.font_size
        else replace(default_text_box, font_size=appearance.font_size)
    )
    if appearance.is_default() and text_box is default_text_box:
        return stamp.TextStampStyle(stamp_text=text)
    background = None
    if appearance.image_bytes is not None and appearance.layout_mode == "over":
        background = _pdf_image(appearance.image_bytes)
    return SidecarStampStyle(
        stamp_text=text,
        text_box_style=text_box,
        background=background,
        background_opacity=appearance.image_opacity,
        background_layout=layout.SimpleBoxLayoutRule(
            x_align=layout.AxisAlignment.ALIGN_MID,
            y_align=layout.AxisAlignment.ALIGN_MID,
            inner_content_scaling=layout.InnerScaling.STRETCH_TO_FIT,
        ),
        sidecars=_sidecars(appearance),
    )


# ---------------------------------------------------------------------------
# The preview
# ---------------------------------------------------------------------------


def preview_appearance(
    width: float = 200.0,
    height: float = 60.0,
    signer: str = "",
    reason: str | None = None,
    location: str | None = None,
    stamp_style_spec: dict | None = None,
    font_dir: str = "",
    timestamp: str = "",
) -> dict:
    """Draw the stamp into a one-page PDF whose page IS the stamp box.

    THE SAME AUTHOR AS THE SIGNATURE: this builds the style through
    `stamp_style()` and paints it through pyHanko's own stamping API, so a
    surface that rasterizes the returned PDF is looking at the drawing the
    signature will carry. A surface that redrew the stamp itself could
    disagree with the signed file, and the point of routing the preview
    through here is that it structurally cannot.

    `timestamp` fixes the interpolated signing time so a preview does not
    re-render on every clock tick; empty means "now".
    """
    from pyhanko.pdf_utils.writer import PdfFileWriter

    appearance = parse_appearance(stamp_style_spec, font_dir)
    width = max(1.0, float(width))
    height = max(1.0, float(height))
    style = stamp_style(reason, location, appearance)
    if timestamp:
        from dataclasses import replace

        style = replace(style, stamp_text=style.stamp_text.replace("%(ts)s", "%(fixed_ts)s"))

    writer = PdfFileWriter()
    writer.insert_page(
        _blank_page(writer, width, height)
    )
    params = {"signer": signer or ""}
    if timestamp:
        params["fixed_ts"] = timestamp.replace("%", "%%")
    try:
        drawn = style.create_stamp(
            writer, layout.BoxConstraints(width=round(width), height=round(height)), params
        )
        drawn.apply(0, 0, 0)
    except layout.LayoutError:
        raise StampAppearanceRefusal(
            "The signature stamp does not fit in that box — make the box bigger, "
            "or leave out the image, the signature, or some of the text lines."
        ) from None
    out = io.BytesIO()
    writer.write(out)
    return {
        "pdf": base64.b64encode(out.getvalue()).decode("ascii"),
        "width": width,
        "height": height,
    }


def _blank_page(writer, width: float, height: float):
    from pyhanko.pdf_utils import generic
    from pyhanko.pdf_utils.generic import pdf_name

    return generic.DictionaryObject(
        {
            pdf_name("/Type"): pdf_name("/Page"),
            pdf_name("/MediaBox"): generic.ArrayObject(
                [
                    generic.NumberObject(0),
                    generic.NumberObject(0),
                    generic.FloatObject(width),
                    generic.FloatObject(height),
                ]
            ),
            pdf_name("/Resources"): generic.DictionaryObject(),
            pdf_name("/Contents"): writer.add_object(
                generic.StreamObject(stream_data=b"")
            ),
        }
    )
