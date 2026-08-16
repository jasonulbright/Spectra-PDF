"""What paints one point on a page: the object, its colour space, its resolution.

Three readouts answer one click, and they are three separate measurements on
purpose.

**Which object.** A paint-order walk lists what could be at the point and what
each of those objects is; one Ghostscript `pngalpha` run over a tile around
the point says which of them actually paints that pixel. A bounding box is a
SUPERSET of the mark it bounds — a glyph's counter, an image's soft mask, an
even-odd fill's hole and a non-rectangular clip are all regions the geometry
calls inside and the device leaves blank — so a readout that stopped at the
box would confidently name an object nobody is looking at. `pngalpha` is the
device because white paint is paint: a colour test reads a white fill on white
paper as nothing.

**How much ink.** Read off the PLATE coverage at that pixel, never derived
from the object. Where the object is already device CMYK the two agree to the
plate's 8-bit quantisation; where it is not they are different units, and
"red" is not an amount of ink. Both are reported under their own labels and
neither is blended into the other. The read covers every plate in the set and
not a chosen subset — a hidden plate is still an ink on the sheet — and no
display transform enters it, because nothing shown on screen changes how much
ink a press lays down.

**What resolution.** `image_resolution._measure` on the placement the hit test
picked. A vector, a text run and a shading have no resolution and say so; a
placement whose pixel dimensions or placed size are degenerate reports the
unmeasured third state rather than a number.

Frames: the caller hands over a PDF user-space point and nothing else. User
space does not move under `/Rotate` — only the projection does — so the
projection stays with whoever drew the page on screen. The plate pixel is
derived here, once, because the plates carry `/Rotate` and the crop origin
themselves; the scale comes from the plate's own pixel extent against the
page's own box, so the device's rounding of a fractional pixel edge cannot
drift the mapping.

The isolation unit is PAGE-level, so a form XObject isolates whole: the raster
answers "something inside this form paints here" and the walk's geometry ranks
which nested object it is. Two nested objects over one point are reported as a
stack with the ambiguity stated, never resolved silently.
"""

from __future__ import annotations

import shutil
import tempfile
from pathlib import Path

import pikepdf

from . import budget
from .color_spaces import build_resolver
from .content_walk import (
    ClipTracker,
    DEFAULT_COLOR,
    GraphicsTextState,
    IDENTITY,
    bbox_of_rect_under_matrix,
    mat_mult,
    transform_point,
)
from .flattener import _page_box, _placement, _text_rect, drop_dead_frames
from .image_resolution import _measure
from .redact import MAX_FORM_DEPTH, _as_matrix, _lookup_xobject, _resolve_resources
from .separations import refuse_missing_plates
from .text_metrics import _FontCache, _run_metrics
from .validate import validate_pdf

_CONSTRUCT = frozenset({"m", "l", "c", "v", "y", "re", "h"})
_CLIP = frozenset({"W", "W*"})
_PAINT_FILL = frozenset({"f", "F", "f*"})
_PAINT_STROKE = frozenset({"S", "s"})
_PAINT_BOTH = frozenset({"B", "B*", "b", "b*"})
_PAINT_VISIBLE = _PAINT_FILL | _PAINT_STROKE | _PAINT_BOTH
_PAINT_ALL = _PAINT_VISIBLE | {"n"}
_SHOW_OPS = frozenset({"Tj", "'", '"', "TJ"})

#: Text render modes that draw the stroke and not the fill. The colour a run
#: shows is then the stroke colour, and reporting the fill would name a colour
#: the page never puts on paper.
_STROKE_ONLY_TEXT = frozenset({1, 5})

#: Half the isolation tile's edge, in points. It only has to contain the
#: clicked pixel with room for the device's own edge rounding; a larger tile
#: rasters area no readout reads.
_TILE_POINTS = 12.0

#: Resolution of the isolation raster. The test is "is the alpha above zero",
#: which is resolution-independent everywhere except within half a pixel of a
#: mark's edge, so this buys edge precision and nothing else.
_ISOLATION_DPI = 300

#: Plate sets held as decoded arrays. A page's plates are read once and every
#: later point on that page indexes them; past this many sets the oldest read
#: is dropped rather than growing without bound across a long session.
_MAX_CACHED_PLATE_SETS = 4

_PLATE_CACHE: dict = {}


# ── colour spaces ──────────────────────────────────────────────────────────


def _name_text(obj) -> str:
    text = str(obj)
    return text[1:] if text.startswith("/") else text


_DEVICE_SPACES = {
    "DeviceGray": "DeviceGray", "G": "DeviceGray", "CalGray": "CalGray",
    "DeviceRGB": "DeviceRGB", "RGB": "DeviceRGB", "CalRGB": "CalRGB",
    "DeviceCMYK": "DeviceCMYK", "CMYK": "DeviceCMYK",
}

#: How deep a space may nest through another's alternate or base before the
#: read gives up. The format forbids the cycles this guards against; a
#: document that carries one still must not hang the panel.
_MAX_SPACE_DEPTH = 8


def _empty_space() -> dict:
    return {
        "family": "", "resource": "", "colorants": [], "alternate": "",
        "base": "", "hival": None, "n": None, "pattern_type": None,
        "unknown": False,
    }


def _space_record(cs, resources, depth: int = 0) -> dict:
    """What the document DECLARES a colour space to be.

    Never what a renderer would make of it: the tint transform of a
    `/Separation` is ignored by any device that carries the colorant, so on
    the separation device the tint IS the ink and the alternate is only what
    the document offers a device that lacks the plate. Reporting the
    alternate as the object's colour would answer a question nobody asked.

    An unreadable or unsupported space carries `unknown`, which is the third
    state — never an empty family the caller can read as "no colour here".
    """
    out = _empty_space()
    if depth > _MAX_SPACE_DEPTH:
        out["unknown"] = True
        return out
    if cs is None:
        out["unknown"] = True
        return out
    if isinstance(cs, (str, pikepdf.Name)):
        name = _name_text(cs)
        mapped = _DEVICE_SPACES.get(name)
        if mapped is not None:
            out["family"] = mapped
            return out
        if name == "Pattern":
            out["family"] = "Pattern"
            return out
        target = None
        if resources is not None:
            try:
                table = resources.get("/ColorSpace")
                if table is not None:
                    target = table.get(pikepdf.Name("/" + name))
            except (AttributeError, KeyError, TypeError, ValueError):
                target = None
        if target is None:
            out["unknown"] = True
            return out
        nested = _space_record(target, resources, depth + 1)
        nested["resource"] = name
        return nested
    if isinstance(cs, pikepdf.Array) and len(cs) > 0:
        family = _name_text(cs[0])
        out["family"] = _DEVICE_SPACES.get(family, family)
        if family == "ICCBased":
            try:
                out["n"] = int(cs[1].get("/N"))
            except (AttributeError, IndexError, KeyError, TypeError, ValueError):
                out["n"] = None
            try:
                alternate = cs[1].get("/Alternate")
            except (AttributeError, IndexError, KeyError):
                alternate = None
            if alternate is not None:
                out["alternate"] = _space_record(
                    alternate, resources, depth + 1
                )["family"]
            return out
        if family in ("Indexed", "I"):
            out["family"] = "Indexed"
            try:
                out["base"] = _space_record(cs[1], resources, depth + 1)["family"]
                out["hival"] = int(cs[2])
            except (IndexError, TypeError, ValueError):
                out["unknown"] = True
            return out
        if family in ("Separation", "DeviceN"):
            try:
                names = cs[1]
                out["colorants"] = (
                    [_name_text(n) for n in names]
                    if isinstance(names, pikepdf.Array)
                    else [_name_text(names)]
                )
                out["alternate"] = _space_record(cs[2], resources, depth + 1)["family"]
            except (IndexError, TypeError, ValueError):
                out["unknown"] = True
            return out
        if family == "Pattern":
            return out
        if family in _DEVICE_SPACES or family == "Lab":
            return out
        out["unknown"] = True
        return out
    out["unknown"] = True
    return out


def _pattern_type(name: str, resources) -> int | None:
    if resources is None or not name:
        return None
    try:
        table = resources.get("/Pattern")
        if table is None:
            return None
        entry = table.get(pikepdf.Name("/" + name))
        if entry is None:
            return None
        return int(entry.get("/PatternType"))
    except (AttributeError, KeyError, TypeError, ValueError):
        return None


def _swatch(cs, components, resources) -> list[float] | None:
    """A display colour for the components, or None.

    It rides ALONGSIDE the declared space and never stands in for it: a
    resolver answers "roughly what does this look like", which is not an
    answer to "what colour space is this".
    """
    resolver = build_resolver(cs, resources)
    if resolver is None:
        return None
    try:
        rgb = resolver(list(components))
    except Exception:
        return None
    if rgb is None or len(rgb) != 3:
        return None
    return [float(c) for c in rgb]


_INLINE_OPS = {"g": "DeviceGray", "rg": "DeviceRGB", "k": "DeviceCMYK"}


def _colour_of(color_state, resources) -> dict:
    """The colour a captured fill/stroke state paints in, as declared.

    `color_state` is the shared walker's `(space_op, value_op)` capture. The
    stream default — no space selected and no value set — is device-gray
    black, which is a real answer and not an unknown one.
    """
    record = _empty_space()
    record["components"] = []
    record["rgb"] = None
    if color_state is None:
        color_state = DEFAULT_COLOR
    space_op, value_op = color_state
    if value_op is None and space_op is None:
        record["family"] = "DeviceGray"
        record["components"] = [0.0]
        record["rgb"] = [0.0, 0.0, 0.0]
        return record
    components: list[float] = []
    if value_op is not None:
        for operand in value_op[1]:
            try:
                components.append(float(operand))
            except (TypeError, ValueError):
                pass
    record["components"] = components
    if value_op is not None:
        family = _INLINE_OPS.get(value_op[0].lower())
        if family is not None:
            record["family"] = family
            record["rgb"] = _swatch(pikepdf.Name("/" + family), components, resources)
            return record
    if space_op is None:
        record["unknown"] = True
        return record
    try:
        selected = space_op[1][0]
    except IndexError:
        record["unknown"] = True
        return record
    name = _name_text(selected)
    resolved = _space_record(pikepdf.Name("/" + name), resources)
    resolved["components"] = components
    if resolved["family"] == "Pattern":
        # An uncoloured pattern's `scn` carries its underlying components
        # BEFORE the pattern name, so the name is the last operand.
        resolved["pattern_type"] = _pattern_type(
            _name_text(value_op[1][-1]) if value_op is not None and value_op[1] else "",
            resources,
        )
        resolved["rgb"] = None
        # A pattern is not a flat colour, so no swatch is invented for it —
        # the space the components belong to is the pattern's own.
        resolved["components"] = []
        return resolved
    resolved["rgb"] = None
    if components and not resolved["unknown"]:
        target = selected
        if resources is not None:
            try:
                table = resources.get("/ColorSpace")
                if table is not None:
                    found = table.get(pikepdf.Name("/" + name))
                    if found is not None:
                        target = found
            except (AttributeError, KeyError, TypeError, ValueError):
                target = selected
        resolved["rgb"] = _swatch(target, components, resources)
    return resolved


def _image_colour(xobj, resources) -> dict:
    """An image's own declared space and bit depth.

    An image carries no single colour value — its components live in its
    samples — so the record states the space and leaves the components empty
    rather than inventing one pixel's worth.
    """
    record = _empty_space()
    record["components"] = []
    record["rgb"] = None
    try:
        if bool(xobj.get("/ImageMask")):
            # A stencil mask paints the current fill colour through its own
            # one-bit samples; its space is the fill's, not the image's.
            record["family"] = "ImageMask"
            return record
    except Exception:
        pass
    try:
        cs = xobj.get("/ColorSpace")
    except Exception:
        cs = None
    if cs is None:
        record["unknown"] = True
        return record
    resolved = _space_record(cs, resources)
    resolved["components"] = []
    resolved["rgb"] = None
    return resolved


# ── the paint-order walk ───────────────────────────────────────────────────


def _union(a, b) -> list[float]:
    return [min(a[0], b[0]), min(a[1], b[1]), max(a[2], b[2]), max(a[3], b[3])]


def _bpc_of(xobj) -> int:
    try:
        bpc = int(xobj.get("/BitsPerComponent") or 0)
    except (TypeError, ValueError):
        bpc = 0
    try:
        if not bpc and bool(xobj.get("/ImageMask")):
            bpc = 1
    except Exception:
        pass
    return bpc


def _filters_of(xobj) -> list[str]:
    try:
        declared = xobj.get("/Filter")
    except Exception:
        return []
    if declared is None:
        return []
    entries = declared if isinstance(declared, pikepdf.Array) else [declared]
    try:
        return [str(entry) for entry in entries]
    except (TypeError, ValueError):
        return []


class _Walk:
    """One page's painted objects, in encounter order, with their colour.

    Encounter order IS paint order, so the topmost object at a point is the
    LAST candidate rather than the first. The walk descends into form
    XObjects — the resolution and the colour of a nested object are exactly
    what a click over a form has to answer — while every entry carries the
    PAGE-level instruction indices that draw it, so the isolation raster
    stays a page-level operation.

    Raster placements are counted in the same ordinal space the shared
    placement walk uses: a marked vector form is a leaf placement there and
    is a leaf here, so an index reported for a point names the same placement
    the document-wide resolution summary reports.
    """

    def __init__(self, pdf, page):
        self.pdf = pdf
        self.page = page
        self.objects: list[dict] = []
        self.unknown: list[str] = []
        self.fonts = _FontCache()
        self.box = _page_box(page)
        self._images = 0

    def note(self, reason: str) -> None:
        if reason and reason not in self.unknown:
            self.unknown.append(reason)

    def run(self) -> None:
        resources = _resolve_resources(self.page)
        self._stream(
            list(pikepdf.parse_content_stream(self.page)),
            resources,
            resources,
            IDENTITY,
            0,
            None,
            None,
            "",
            DEFAULT_COLOR,
            DEFAULT_COLOR,
        )

    def _emit(self, kind: str, rect, unit, colour: dict, *, nested: bool,
              form: str, unknown: bool = False, resolution=None,
              image_index: int = -1) -> None:
        if rect is None:
            rect = list(self.box)
            unknown = True
        self.objects.append({
            "index": len(self.objects),
            "kind": kind,
            "rect": [float(v) for v in rect],
            "unit": tuple(unit),
            "nested": bool(nested),
            "form": form,
            "unknown": bool(unknown or colour.get("unknown")),
            "colour": colour,
            "resolution": resolution,
            "image_index": image_index,
        })

    def _stream(self, instructions, resources, fallback, base_ctm, depth,
                base_clip, root_unit, form, base_fill, base_stroke) -> None:
        state = GraphicsTextState(
            base_ctm, fill_color=base_fill, stroke_color=base_stroke
        )
        clips = ClipTracker(base_clip)
        construct: list[int] = []
        points: list[tuple[float, float]] = []
        has_clip = False
        line_width = 1.0
        width_stack: list[float] = []
        text_open: int | None = None
        text_rect = None
        text_colour: dict | None = None
        nested = depth > 0

        def unit_for(indices) -> tuple:
            # A nested object isolates through the page-level `Do` that
            # reached it: the raster removes whole objects, and half a form
            # cannot be drawn without the raster already containing it.
            if root_unit is not None:
                return root_unit
            return tuple(sorted(set(indices)))

        for idx, instruction in enumerate(instructions):
            operator = str(instruction.operator)
            operands = list(instruction.operands)
            clips.feed(operator, operands, state.ctm)
            if operator == "q":
                width_stack.append(line_width)
            elif operator == "Q" and width_stack:
                line_width = width_stack.pop()
            # BT and ET are state operators the machine consumes, so the
            # block's extent is recorded BEFORE it is fed — a check after
            # would never see either one and every text block would go
            # unlisted.
            if operator == "BT":
                text_open, text_rect, text_colour = idx, None, None
            elif operator == "ET" and text_open is not None:
                if text_rect is not None:
                    self._emit(
                        "text", text_rect, unit_for(range(text_open, idx + 1)),
                        text_colour if text_colour is not None
                        else _colour_of(DEFAULT_COLOR, resources),
                        nested=nested, form=form,
                    )
                text_open, text_rect, text_colour = None, None, None
            if state.feed(operator, operands):
                continue
            if operator == "w":
                try:
                    line_width = float(operands[0])
                except (TypeError, ValueError, IndexError):
                    pass
                continue
            if operator in _SHOW_OPS:
                if operator in ("'", '"'):
                    state.next_line()
                cap = self.fonts.capability(resources, fallback, state.font_name)
                _text, raw_width = _run_metrics(operator, operands, cap, state)
                rect = _text_rect(state, cap, raw_width)
                text_rect = rect if text_rect is None else _union(text_rect, rect)
                if text_colour is None:
                    stroked = state.render_mode in _STROKE_ONLY_TEXT
                    text_colour = _colour_of(
                        state.stroke_color if stroked else state.fill_color, resources
                    )
                state.advance_after_show(
                    raw_width, bool(cap is not None and cap.vertical)
                )
                continue
            if operator in _CONSTRUCT:
                construct.append(idx)
                points.extend(_path_points(operator, operands, state.ctm))
                continue
            if operator in _CLIP:
                has_clip = True
                continue
            if operator in _PAINT_ALL:
                if operator in _PAINT_VISIBLE and not has_clip and points:
                    self._paint(
                        operator, points, construct + [idx], state, clips,
                        line_width, resources, unit_for, nested, form,
                    )
                construct, points, has_clip = [], [], False
                continue
            if operator == "Do" and operands:
                self._do(
                    idx, str(operands[0]), state, clips, resources, fallback,
                    depth, unit_for, nested, form, root_unit,
                )
                construct, points, has_clip = [], [], False
                continue
            if operator == "INLINE IMAGE":
                self._inline(instruction, idx, state, unit_for, nested, form)
                construct, points, has_clip = [], [], False
                continue
            if operator == "sh":
                self._shading(idx, operands, clips, resources, unit_for, nested, form)
                construct, points, has_clip = [], [], False
                continue
            construct, points, has_clip = [], [], False

    def _paint(self, operator, points, indices, state, clips, line_width,
               resources, unit_for, nested, form) -> None:
        if operator in _PAINT_FILL:
            kind, colour_state = "fill", state.fill_color
        elif operator in _PAINT_STROKE:
            kind, colour_state = "stroke", state.stroke_color
        else:
            kind, colour_state = "fillstroke", state.fill_color
        ctm = state.ctm
        scale = abs(ctm[0] * ctm[3] - ctm[1] * ctm[2]) ** 0.5
        # A stroke paints half its width either side of the path, so a thin
        # line still bounds a region a click can land in.
        half = (
            0.0 if operator in _PAINT_FILL
            else max(0.0, line_width) / 2.0 * scale
        )
        xs = [p[0] for p in points]
        ys = [p[1] for p in points]
        rect = [min(xs) - half, min(ys) - half, max(xs) + half, max(ys) + half]
        if clips.clips_away(tuple(rect)):
            return
        self._emit(
            kind, rect, unit_for(indices), _colour_of(colour_state, resources),
            nested=nested, form=form,
        )

    def _do(self, idx, name, state, clips, resources, fallback, depth,
            unit_for, nested, form, root_unit) -> None:
        xobj = _lookup_xobject(name, resources, fallback)
        rect, subtype, reason = _placement(xobj, state.ctm)
        if reason:
            self.note(reason)
            self._emit(
                "form" if subtype == "/Form" else "image", rect,
                unit_for([idx]), _empty_space() | {"components": [], "rgb": None},
                nested=nested, form=form, unknown=True,
            )
            return
        if rect is None:
            return
        if clips.clips_away(tuple(rect)):
            return
        marked = None
        if subtype == "/Form":
            try:
                marked = xobj.get("/SpectraVector")
            except Exception:
                marked = None
        if subtype == "/Image" or marked is not None:
            self._placement_entry(
                xobj, marked, rect, state.ctm, unit_for([idx]), resources,
                nested, form,
            )
            return
        if subtype != "/Form":
            return
        unit = unit_for([idx])
        self._emit(
            "form", rect, unit,
            _empty_space() | {"components": [], "rgb": None},
            nested=nested, form=form,
        )
        if depth >= MAX_FORM_DEPTH:
            return
        try:
            inner = list(pikepdf.parse_content_stream(xobj))
        except Exception:
            self.note(
                f"Page content inside form {name} will not parse, so what it "
                "paints cannot be identified."
            )
            return
        inner_resources = xobj.get("/Resources")
        self._stream(
            inner,
            inner_resources if inner_resources is not None else resources,
            resources,
            mat_mult(_as_matrix(xobj.get("/Matrix")) or IDENTITY, state.ctm),
            depth + 1,
            clips.clip,
            unit if root_unit is None else root_unit,
            form or name,
            state.fill_color,
            state.stroke_color,
        )

    def _placement_entry(self, xobj, marked, rect, ctm, unit, resources,
                         nested, form) -> None:
        if marked is not None:
            try:
                viewbox = [float(v) for v in marked.get("/ViewBox")]
                native_w, native_h = int(round(viewbox[2])), int(round(viewbox[3]))
            except (TypeError, ValueError, IndexError, AttributeError):
                native_w = native_h = 0
        else:
            try:
                native_w = int(xobj.get("/Width", 0))
                native_h = int(xobj.get("/Height", 0))
            except (TypeError, ValueError):
                native_w = native_h = 0
        index = self._images
        self._images += 1
        if marked is not None:
            # A marked vector form draws no pixels, so it has no resolution
            # even though it occupies a placement's ordinal.
            self._emit(
                "vector", rect, unit,
                _empty_space() | {"components": [], "rgb": None},
                nested=nested, form=form, image_index=index,
            )
            return
        colour = _image_colour(xobj, resources)
        placement = {
            "matrix": list(ctm),
            "native_width": native_w,
            "native_height": native_h,
            "bpc": _bpc_of(xobj),
            "filters": _filters_of(xobj),
            "colour_family": colour["family"],
        }
        self._emit(
            "image", rect, unit, colour,
            nested=nested, form=form, resolution=_measure(placement),
            image_index=index,
        )

    def _inline(self, instruction, idx, state, unit_for, nested, form) -> None:
        try:
            obj = instruction.iimage.obj
        except Exception:
            obj = None
        rect = list(bbox_of_rect_under_matrix(state.ctm, 1.0, 1.0))
        index = self._images
        self._images += 1
        if obj is None:
            self._emit(
                "image", rect, unit_for([idx]),
                _empty_space() | {"components": [], "rgb": None, "unknown": True},
                nested=nested, form=form, unknown=True, image_index=index,
            )
            return
        try:
            native_w = int(obj.get("/Width", 0) or 0)
            native_h = int(obj.get("/Height", 0) or 0)
        except (TypeError, ValueError):
            native_w = native_h = 0
        colour = _image_colour(obj, None)
        placement = {
            "matrix": list(state.ctm),
            "native_width": native_w,
            "native_height": native_h,
            "bpc": _bpc_of(obj),
            "filters": _filters_of(obj),
            "colour_family": colour["family"],
        }
        self._emit(
            "image", rect, unit_for([idx]), colour, nested=nested, form=form,
            resolution=_measure(placement), image_index=index,
        )

    def _shading(self, idx, operands, clips, resources, unit_for, nested, form) -> None:
        colour = _empty_space() | {"components": [], "rgb": None}
        if operands:
            name = _name_text(operands[0])
            try:
                table = resources.get("/Shading") if resources is not None else None
                entry = table.get(pikepdf.Name("/" + name)) if table is not None else None
                if entry is not None:
                    colour = _space_record(entry.get("/ColorSpace"), resources)
                    colour["components"] = []
                    colour["rgb"] = None
            except (AttributeError, KeyError, TypeError, ValueError):
                colour["unknown"] = True
        rect = list(clips.clip) if clips.clip is not None else list(self.box)
        self._emit(
            "shading", rect, unit_for([idx]), colour, nested=nested, form=form,
        )


def _path_points(operator: str, operands: list, ctm) -> list:
    try:
        values = [float(v) for v in operands]
    except (TypeError, ValueError):
        return []
    if operator == "re" and len(values) >= 4:
        x, y, w, h = values[0], values[1], values[2], values[3]
        return [
            transform_point(ctm, cx, cy)
            for cx, cy in ((x, y), (x + w, y), (x, y + h), (x + w, y + h))
        ]
    return [
        transform_point(ctm, values[i], values[i + 1])
        for i in range(0, len(values) - 1, 2)
    ]


# ── the isolation raster ───────────────────────────────────────────────────


def _view_box(page) -> list[float]:
    """The frame the page displays in: its crop box intersected with its media
    box, falling back to the media box when the intersection is empty.

    This is what the separation device frames on, so the plate and this box
    describe the same region and a point in one indexes the other.
    """
    media = _page_box_of(page, "/MediaBox")
    if media is None:
        raise ValueError("This page has no media box.")
    crop = _page_box_of(page, "/CropBox")
    if crop is None:
        return media
    box = [
        max(media[0], crop[0]), max(media[1], crop[1]),
        min(media[2], crop[2]), min(media[3], crop[3]),
    ]
    if box[2] - box[0] <= 0 or box[3] - box[1] <= 0:
        return media
    return box


def _page_box_of(page, key: str) -> list[float] | None:
    try:
        values = [float(v) for v in page.obj.get(key)]
    except (TypeError, ValueError):
        return None
    if len(values) != 4:
        return None
    return [
        min(values[0], values[2]), min(values[1], values[3]),
        max(values[0], values[2]), max(values[1], values[3]),
    ]


def _tile(x: float, y: float, box) -> list[float]:
    """A small window on the page around the point, clamped into its box.

    Clamping matters twice: it keeps the raster off area the page does not
    display, and it keeps the tile inside the crop, so content the crop hides
    cannot paint into the window and be reported as visible.
    """
    return [
        max(box[0], x - _TILE_POINTS), max(box[1], y - _TILE_POINTS),
        min(box[2], x + _TILE_POINTS), min(box[3], y + _TILE_POINTS),
    ]


def _isolation_pdf(pdf, page, units, wanted, tile, dest: Path) -> None:
    """One page per candidate, each drawing only that candidate.

    Every OTHER object's instructions are dropped and the empty `q … Q`
    frames that remain are swept, which is the flatten's own idiom with its
    keep-set complemented. Only construction and painting operators go; every
    state operator stays, so the kept object draws in exactly the state the
    page put it in. The page boxes become the tile, and `/Rotate` goes with
    them: the raster then maps user space to pixels with one scale and one
    y-flip.
    """
    instructions = list(pikepdf.parse_content_stream(page))
    everything: set[int] = set()
    for unit in units:
        everything.update(unit)
    resources = _resolve_resources(page)
    out = pikepdf.Pdf.new()
    shared = (
        out.copy_foreign(pdf.make_indirect(resources)) if resources is not None else None
    )
    width = max(tile[2] - tile[0], 1e-3)
    height = max(tile[3] - tile[1], 1e-3)
    for unit in wanted:
        drop = everything - set(unit)
        kept = drop_dead_frames(
            [ins for i, ins in enumerate(instructions) if i not in drop]
        )
        try:
            body = pikepdf.unparse_content_stream(kept)
        except Exception as exc:
            raise ValueError(
                "The object under that point cannot be isolated on its own."
            ) from exc
        new_page = out.add_blank_page(page_size=(width, height))
        new_page.obj["/MediaBox"] = pikepdf.Array(list(tile))
        new_page.obj["/CropBox"] = pikepdf.Array(list(tile))
        new_page.Contents = out.make_stream(body)
        if shared is not None:
            new_page.obj["/Resources"] = shared
    out.save(str(dest))
    out.close()


def _refuse_isolation(detail: str) -> None:
    """State that the point's object could not be measured, as a refusal.

    Every way the raster can fail ends here, so the panel gets one sentence
    with the device's own reason inside it rather than a family of wordings
    for one condition.
    """
    raise RuntimeError(
        f"The object under that point could not be isolated for measurement: {detail}"
    )


def _painting_units(pdf, page, units, wanted, x, y, box, gs_path, source):
    """Which of the wanted isolation units actually paints the point.

    `pngalpha` and not a colour device: a pixel any object painted has alpha
    above zero, and white paint on white paper is paint.
    """
    from PIL import Image

    work = Path(tempfile.mkdtemp(prefix="spectrapdf-inspect-"))
    try:
        tile = _tile(x, y, box)
        iso = work / "isolation.pdf"
        _isolation_pdf(pdf, page, units, wanted, tile, iso)
        cmd = [
            gs_path, "-dNOPAUSE", "-dBATCH", "-dSAFER", "-q",
            "-sDEVICE=pngalpha", f"-r{_ISOLATION_DPI}",
            "-o", str(work / "iso%d.png"), str(iso),
        ]
        result = budget.gs(cmd, what="Object inspection", path=source, pages=len(wanted))
        if result.returncode != 0:
            _refuse_isolation((result.stderr or result.stdout or "").strip())
        painting: set = set()
        scale = _ISOLATION_DPI / 72.0
        for ordinal, unit in enumerate(wanted, start=1):
            frame = work / f"iso{ordinal}.png"
            if not frame.is_file():
                # A device that exits clean and writes nothing leaves the
                # question unanswered, which is not the same as "nothing is
                # here" and must not be reported as it.
                _refuse_isolation("the device wrote no raster")
            with Image.open(frame) as image:
                alpha = image.convert("RGBA")
                column = min(
                    max(int((x - tile[0]) * scale), 0), alpha.width - 1
                )
                row = min(
                    max(alpha.height - 1 - int((y - tile[1]) * scale), 0),
                    alpha.height - 1,
                )
                if alpha.getpixel((column, row))[3] > 0:
                    painting.add(unit)
        return painting
    finally:
        shutil.rmtree(work, ignore_errors=True)


# ── the plate read ─────────────────────────────────────────────────────────


def _plate_arrays(plate_dir: Path, plates: list) -> list:
    """Every named plate as ink coverage in 0…1, read once per set.

    Plate polarity is inverted on the wire, so ink is `255 - value`. The
    decode is what costs; indexing it afterwards costs nothing, so a page's
    plates are held and every later point on that page reads them directly.
    """
    import numpy as np
    from PIL import Image

    try:
        stamp = plate_dir.stat().st_mtime_ns
    except OSError:
        refuse_missing_plates()
    cached = _PLATE_CACHE.get(str(plate_dir))
    if cached is not None and cached[0] == stamp:
        return cached[1]
    layers = []
    for entry in plates:
        path = Path(str(entry.get("file") or ""))
        if not path.is_file():
            refuse_missing_plates()
        with Image.open(path) as image:
            samples = np.asarray(image.convert("L")).astype(np.float32)
        layers.append((
            str(entry.get("name") or ""),
            str(entry.get("kind") or ""),
            (255.0 - samples) / 255.0,
        ))
    if len(_PLATE_CACHE) >= _MAX_CACHED_PLATE_SETS:
        _PLATE_CACHE.pop(next(iter(_PLATE_CACHE)))
    _PLATE_CACHE[str(plate_dir)] = (stamp, layers)
    return layers


def plate_pixel(x: float, y: float, box, rotate: int,
                width: int, height: int) -> tuple[int, int]:
    """The plate pixel a user-space point lands on.

    The device applies `/Rotate` and frames on the crop box, so the plate is
    the page's own displayed frame and the mapping is a scale, a quarter turn
    and a flip. The scale comes from the plate's measured extent rather than
    from the requested resolution: the device rounds a fractional pixel edge
    down, so a plate is up to one pixel short of the arithmetic and a click on
    the far edge would index past its end.
    """
    turn = int(rotate) % 360
    across = float(box[2] - box[0])
    up = float(box[3] - box[1])
    if across <= 0 or up <= 0:
        return 0, 0
    u = (float(x) - box[0]) / across
    v = (float(y) - box[1]) / up
    if turn == 90:
        column, row = v * width, u * height
    elif turn == 180:
        column, row = (1.0 - u) * width, v * height
    elif turn == 270:
        column, row = (1.0 - v) * width, (1.0 - u) * height
    else:
        column, row = u * width, (1.0 - v) * height
    return (
        min(max(int(column), 0), max(width - 1, 0)),
        min(max(int(row), 0), max(height - 1, 0)),
    )


def _rotate_of(page) -> int:
    try:
        return int(page.obj.get("/Rotate") or 0) % 360
    except (TypeError, ValueError):
        return 0


def _ink_at(plate_dir: str, plates: list, x: float, y: float, box,
            rotate: int) -> dict:
    """Per-plate coverage at one pixel, plus the total.

    Every plate in the set is read, not the subset the composite is showing:
    an ink switched off in the picture is still an ink on the sheet, and a
    total that dropped it would describe a press run nobody ordered.
    """
    directory = Path(plate_dir) if plate_dir else None
    if directory is None or not directory.is_dir():
        refuse_missing_plates()
    layers = _plate_arrays(directory, plates)
    if not layers:
        refuse_missing_plates()
    height, width = layers[0][2].shape
    column, row = plate_pixel(x, y, box, rotate, width, height)
    values = []
    total = 0.0
    for name, kind, samples in layers:
        pct = float(samples[row, column]) * 100.0
        total += pct
        values.append({"name": name, "kind": kind, "pct": pct})
    return {
        "plates": values,
        "total": total,
        "pixel": [column, row],
        "width": int(width),
        "height": int(height),
    }


# ── the command ────────────────────────────────────────────────────────────


def _public(entry: dict) -> dict:
    return {
        "index": entry["index"],
        "kind": entry["kind"],
        "rect": entry["rect"],
        "nested": entry["nested"],
        "form": entry["form"],
        "unknown": entry["unknown"],
        "colour": entry["colour"],
        "resolution": entry["resolution"],
        "image_index": entry["image_index"],
    }


def inspect_point(
    file: str,
    page: int = 1,
    x: float = 0.0,
    y: float = 0.0,
    plates: list | None = None,
    plates_dir: str = "",
    gs_path: str = "gs",
) -> dict:
    """What is painted at one PDF user-space point, and what ink is there.

    Args:
        file: Input PDF path.
        page: 1-based page number.
        x: Point in PDF user space, horizontal.
        y: Point in PDF user space, vertical.
        plates: The plate set's entries, each carrying `name`, `kind` and
            `file`. The pairing of a plate file to an ink is the raster's own
            answer and is never re-derived from a filename here.
        plates_dir: The plate-set directory the raster produced.
        gs_path: Path to the Ghostscript executable.

    `objects` is topmost first in paint order and holds only what actually
    paints the point, so an empty list is the answer "nothing is here" — which
    is a reading and not a failure. `ink` is the sheet's, stated once, and is
    exact even over blank paper.
    """
    validate_pdf(file)
    page = int(page)
    x = float(x)
    y = float(y)
    with pikepdf.open(file) as pdf:
        total = len(pdf.pages)
        if not 1 <= page <= total:
            raise ValueError(f"Page {page} is not in this document.")
        target = pdf.pages[page - 1]
        box = _view_box(target)
        if not (box[0] <= x <= box[2] and box[1] <= y <= box[3]):
            raise ValueError("That point is not on this page.")
        ink = _ink_at(plates_dir, list(plates or ()), x, y, box, _rotate_of(target))
        walk = _Walk(pdf, target)
        try:
            walk.run()
        except ValueError:
            raise
        except Exception as exc:
            raise ValueError(
                "This page's content will not read, so nothing on it can be "
                f"identified: {exc}"
            ) from exc
        candidates = [
            entry for entry in walk.objects
            if entry["rect"][0] <= x <= entry["rect"][2]
            and entry["rect"][1] <= y <= entry["rect"][3]
        ]
        painting: set = set()
        if candidates:
            units = []
            for entry in walk.objects:
                if entry["unit"] not in units:
                    units.append(entry["unit"])
            wanted = []
            for entry in candidates:
                if entry["unit"] not in wanted:
                    wanted.append(entry["unit"])
            painting = _painting_units(
                pdf, target, units, wanted, x, y, box, gs_path, file
            )
        hits = [entry for entry in candidates if entry["unit"] in painting]
        # A form isolates whole, so two objects sharing one unit are ranked by
        # geometry rather than by the raster. Saying so is the answer; picking
        # one silently would not be. The form entry itself does not count: it
        # names the isolated unit rather than competing inside it.
        shared: dict = {}
        for entry in hits:
            if entry["kind"] == "form":
                continue
            shared[entry["unit"]] = shared.get(entry["unit"], 0) + 1
        ambiguous = any(count > 1 for count in shared.values())
        hits.reverse()
        return {
            "file": file,
            "page": page,
            "point": [x, y],
            "box": box,
            "objects": [_public(entry) for entry in hits],
            "candidates": len(candidates),
            "ambiguous": bool(ambiguous),
            "ink": ink,
            "unknown": list(walk.unknown),
        }
