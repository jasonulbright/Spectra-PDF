"""True content redaction: remove what lies under a region from the content
itself, then paint the region's box over it — never just an overlay.

Per page, the content stream is walked with the graphics and text state
(`content_walk`) so every drawing operator's device-space footprint is known,
and each kind of content loses exactly the part under a mark:

  - TEXT is measured through its font (`text_metrics`, shared with the text
    lister): glyph advances plus TJ kerns, Tc, Tw and Tz, and the font's own
    ascent and descent. A show operator is SPLIT: the clusters whose boxes meet
    a mark go, the rest are re-shown from their original bytes, and each
    removed stretch becomes one TJ number with exactly the advance it had, so
    every surviving glyph stays put. A run the font cannot measure goes whole
    (`runs_removed_whole`), its box taken WIDE — 1 em per code.
  - An IMAGE (`Do` or inline) loses the pixels under the mark in a COPY
    (`image_redact`); only that occurrence is rewritten to the copy, and
    placements with the same plan share one copy. A mark over the whole
    placed area, or a placement with no area, removes the occurrence; an
    image whose encoding cannot be rewritten safely refuses by name before
    anything is written.
  - A PATH loses the area under the mark (`vector_redact`): fills are
    clipped, strokes are cut short of it, clip paths lose it too.
  - A FORM XObject, the group of a soft mask set by `gs`, and the cell of a
    tiling pattern painted under a mark are redacted as COPIES, registered
    under fresh names; the originals stay for any placement the mark does not
    reach. A copy carries only the keys that describe how to draw it
    (`FORM_KEPT_KEYS`, `PATTERN_KEPT_KEYS`).
  - A marked-content sequence that lost content loses its /ActualText, /Alt
    and /E, and its MCID is recorded so the structure element is scrubbed too.
  - A shading painted with `sh` whose clip meets a mark goes whole.

Then per page: the region boxes (with any overlay text) are painted on top;
the page's resource dictionary becomes its own, the copies are registered in
it, and every content-bearing category is pruned to the names the rewritten
stream still uses BEFORE qpdf's unreferenced-resource sweep — a replaced
original left listed stays reachable, and a form without /Resources that is
still listed keeps alive every name its content draws. Page-level derivatives
of the content go (`_PAGE_DERIVATIVES`), and annotations over a mark are
removed with their popups and replies.

Last, once per document (`redact_document.finish`): shared and inherited
resource dictionaries that still list a replaced original, structure
references to replaced objects, fields whose widgets were all removed, JBIG2
symbol dictionaries a redacted image used, the document's own thumbnails and
private data, and every font the removed text drew with, cut to what the
remaining text draws (`redact_fonts`, measured against a scan taken before the
first page changes).

Remaining limitations:
  - A glyph's box is its ADVANCE box. Ink can overhang the advance by a side
    bearing (an italic `f`, a swash), so a region touching ONLY that overhang
    and no part of the advance box does not remove the glyph. Bounding each
    glyph by the font's /FontBBox instead would be exact and useless — for
    Helvetica that box is 1.166 em wide, four times the advance of an `i`, so
    every mark would take several neighbouring glyphs with it.
  - Form, pattern and soft-mask recursion is depth-capped (MAX_FORM_DEPTH).
    Beyond the cap an intersecting `Do` is DROPPED WHOLE rather than left
    intact. Only reachable on pathological (cyclic) nesting.
"""

import math
from pathlib import Path
from typing import NamedTuple

import pikepdf
from pikepdf import Name

from engine import image_redact, redact_document, redact_fonts, vector_redact
from engine.inplace import is_same_file, staged_write
from engine.pdf_save import save_pdf
from engine.pdf_tree import walk_inheritable
from engine.content_walk import (
    IDENTITY,
    ClipTracker,
    GraphicsTextState,
    Matrix,
    Rect,
    as_matrix,
    bbox_of_corners_under_matrix,
    bbox_of_rect_under_matrix,
    mat_mult,
    transform_point,
)
from engine.text_metrics import (
    _child_state,
    _FontCache,
    _run_metrics,
    cluster_span,
    measurable,
    show_bytes,
    show_clusters,
    show_items,
    wide_width,
)

# Depth cap for Form-XObject recursion — only there to terminate on malformed
# cyclic forms; real documents never approach it.
MAX_FORM_DEPTH = 16

# Matrix/bbox helpers live in content_walk.py (the one-interpreter
# consolidation) — these aliases keep this module's established names (and
# page_images.py's imports) stable.
_mat_mult = mat_mult
_transform_point = transform_point
_bbox_of_rect_under_matrix = bbox_of_rect_under_matrix
_bbox_of_corners_under_matrix = bbox_of_corners_under_matrix
_as_matrix = as_matrix


def _normalize_rect(rect: list[float]) -> Rect:
    x0, y0, x1, y1 = rect
    return (min(x0, x1), min(y0, y1), max(x0, x1), max(y0, y1))


def _intersects(a: Rect, b: Rect) -> bool:
    return not (a[2] <= b[0] or b[2] <= a[0] or a[3] <= b[1] or b[3] <= a[1])


def _intersects_any(bbox: Rect, regions: list[Rect]) -> bool:
    return any(_intersects(bbox, r) for r in regions)


def _lookup_xobject(name, resources, fallback_resources):
    """Resolve a /Do XObject name against this stream's resources, then the
    invoker's resources as a lenient per-name fallback (a form whose own
    /Resources omits a single name). Returns the XObject or None."""
    if not name:
        return None
    for res in (resources, fallback_resources):
        if res is None:
            continue
        xod = res.get("/XObject")
        if xod is not None:
            obj = xod.get(Name(name))
            if obj is not None:
                return obj
    return None


def _colorspace_resolver(resources, fallback_resources):
    """Resolve an image's /ColorSpace NAME against the resources in scope.

    An inline image may name its colour space (`/CS /CS0`), and a malformed
    generator sometimes does the same on an image XObject. The name must be
    resolvable before the pixel rewrite can know how many components a sample
    has; `image_redact` refuses the image when this returns None.
    """

    def resolve(name: str):
        for res in (resources, fallback_resources):
            if res is None:
                continue
            try:
                table = res.get("/ColorSpace")
                if table is not None:
                    found = table.get(Name(name))
                    if found is not None:
                        return found
            except Exception:
                continue
        return None

    return resolve


def _resolve_resources(page: "pikepdf.Page"):
    """Resources are inheritable via the page tree — a page dict lacking its
    own /Resources takes it from the nearest ancestor /Pages node that has
    one (common output from generators that put a single shared /Resources
    on the /Pages node rather than duplicating it per page). `page.get` only
    ever sees the page's OWN dict, so relying on it alone silently treats
    such a page as having no XObjects at all — a false negative (an image
    that should have been redacted, wasn't), the one failure direction this
    module can't tolerate. The walk itself is shared with watermark.py via
    pdf_tree.walk_inheritable."""
    resources = walk_inheritable(page, "/Resources")
    return resources if resources is not None else {}


def _span_bbox(
    combined: Matrix,
    x0: float,
    x1: float,
    vertical: bool,
    state: GraphicsTextState,
    ink: tuple[float, float],
) -> Rect:
    """The device-space box of a stretch of one show operator's INK.

    Horizontal: the stretch runs from `x0` to `x1` along the pen's sweep
    (pre-Tz text space, scaled here), and the ink reaches `below` under the
    baseline and `above` over it — the font's own descent/ascent, not the em
    box. `Ts` (rise) lifts it.

    Vertical: the run occupies one em-wide column centred on the pen
    and spans its advance sum DOWNWARD, the lister's convention; Tz never
    applies vertically.
    """
    below, above = ink
    size = max(state.font_size, 0.01)
    if vertical:
        half = size / 2.0
        lo, hi = min(x0, x1), max(x0, x1)
        if hi - lo < 0.01:
            hi = lo + 0.01
        return _bbox_of_corners_under_matrix(combined, -half, -hi, half, -lo)
    lo, hi = sorted((x0 * state.h_scale, x1 * state.h_scale))
    if hi - lo < 0.01:
        hi = lo + 0.01
    y0 = state.rise - below * size
    y1 = state.rise + above * size
    if y1 - y0 < 0.01:
        y1 = y0 + 0.01
    return _bbox_of_corners_under_matrix(combined, lo, y0, hi, y1)


def _run_bbox(
    combined: Matrix,
    raw_width: float,
    slack: float,
    vertical: bool,
    state: GraphicsTextState,
    ink: tuple[float, float],
) -> Rect:
    """The whole run's box. `slack` grows it BACKWARD by however far an earlier
    unmeasurable run on this line may have over-advanced (upward, vertically)."""
    if vertical:
        return _span_bbox(combined, -slack, max(raw_width, 0.01), True, state, ink)
    return _span_bbox(
        combined, -slack / max(state.h_scale, 1e-9), raw_width, False, state, ink
    )


def _merge_tj_parts(parts: list) -> list:
    """Collapse a TJ operand list: adjacent strings concatenate, adjacent
    numbers add, and a zero number drops. Byte-for-byte equivalent to the
    unmerged form and much easier to read in a dumped stream."""
    out: list = []
    for part in parts:
        if isinstance(part, bytes):
            if out and isinstance(out[-1], bytes):
                out[-1] = out[-1] + part
            else:
                out.append(part)
            continue
        if out and isinstance(out[-1], float):
            out[-1] = out[-1] + part
        else:
            out.append(float(part))
    return [p for p in out if not (isinstance(p, float) and abs(p) < 1e-9)]


def _state_only_instructions(operator: str, operands: list) -> list:
    """The state side effects of a show operator that is being removed WHOLE.
    `'` is `T* Tj` and `"` is `aw Tw ac Tc T* Tj`, so dropping either outright
    swallowed a line advance and moved every following line up the page."""
    out: list = []
    if operator == '"' and len(operands) >= 3:
        out.append(pikepdf.ContentStreamInstruction([operands[0]], pikepdf.Operator("Tw")))
        out.append(pikepdf.ContentStreamInstruction([operands[1]], pikepdf.Operator("Tc")))
    if operator in ("'", '"'):
        out.append(pikepdf.ContentStreamInstruction([], pikepdf.Operator("T*")))
    return out


def _split_instructions(
    operator: str,
    operands: list,
    items: list,
    clusters: list,
    removed: set,
    state: GraphicsTextState,
) -> list:
    """Re-emit a show operator with the marked clusters GONE and every
    surviving glyph still where it was.

    Each removed cluster becomes ONE TJ number carrying exactly the advance it
    contributed, so the pen arrives at the next surviving glyph at the same
    place it always did — `-N/1000 × Tfs` is the displacement a TJ number
    makes, and Tz multiplies that and the glyph advances alike, so it cancels.
    Tc and Tw ride INSIDE the removed advance and are absorbed by the number;
    surviving glyphs keep their own because their own bytes are re-shown.

    The surviving bytes are SLICED from the original operands, never
    re-encoded: a round trip through decode/encode could substitute a
    different code for the same character (the ligature table is filtered
    to unambiguous inverses, so it cannot be relied on to give a byte back),
    and there is nothing to gain from asking.

    `'` and `"` are expanded to their spec equivalences first (T*, and the
    `aw Tw ac Tc` prefix) so their state side effects outlive the rewrite —
    dropping a `'` outright, as the whole-run path did, silently swallowed the
    line advance and shifted every following line up the page.
    """
    out: list = []
    if operator == '"' and len(operands) >= 3:
        out.append(pikepdf.ContentStreamInstruction([operands[0]], pikepdf.Operator("Tw")))
        out.append(pikepdf.ContentStreamInstruction([operands[1]], pikepdf.Operator("Tc")))
    if operator in ("'", '"'):
        out.append(pikepdf.ContentStreamInstruction([], pikepdf.Operator("T*")))

    parts: list = []
    for index, cluster in enumerate(clusters):
        if index in removed:
            total = sum(items[i].advance for i in cluster)
            parts.append(-total * 1000.0 / state.font_size)
            continue
        for i in cluster:
            item = items[i]
            parts.append(item.number if item.kern else item.data)

    merged = _merge_tj_parts(parts)
    array = pikepdf.Array(
        [
            pikepdf.String(p) if isinstance(p, bytes) else round(p, 6)
            for p in merged
        ]
    )
    out.append(pikepdf.ContentStreamInstruction([array], pikepdf.Operator("TJ")))
    return out


class WalkResult(NamedTuple):
    kept: list
    text_runs_removed: int
    text_runs_split: int  # runs that lost SOME codes and kept the rest
    runs_removed_whole: int  # runs removed entire because they could not be split
    images_removed: int
    images_modified: int  # occurrences whose marked PIXELS were destroyed in place
    dropped_image_names: set
    surviving_image_names: set
    new_forms: dict  # name(str) -> redacted form Stream to register in this scope
    new_images: dict  # name(str) -> pixel-redacted image Stream to register here
    replaced_form_names: set  # original form names whose Do was rewritten/dropped
    replaced_image_names: set  # original image names whose Do was rewritten to a copy
    forms_dropped_at_cap: int  # intersecting form Dos dropped whole at the depth cap
    new_resources: dict  # category -> {name: object} for patterns, graphics states, properties
    replaced_resources: dict  # category -> original names this stream stopped using
    paths_redacted: int
    changed: bool  # anything at all was removed, split, or rewritten


# The keys a redacted COPY of a form or a tiling pattern carries. Everything
# else is dropped, because it can hand back what was redacted: /Metadata (XMP,
# with thumbnails), /PieceInfo and /LastModified (an application's private copy
# of the content), /AF (associated source files), /OPI (the unredacted
# original), /Ref (a reference form draws ANOTHER document's page in place of
# this content), /PtData (point data about what is pictured), and any key this
# list does not name.
FORM_KEPT_KEYS = frozenset(
    {
        "/Type",
        "/Subtype",
        "/FormType",
        "/BBox",
        "/Matrix",
        "/Group",
        "/OC",
        "/Name",
        "/StructParent",
        "/StructParents",
        "/Measure",
    }
)
PATTERN_KEPT_KEYS = frozenset(
    {"/Type", "/PatternType", "/PaintType", "/TilingType", "/BBox", "/XStep", "/YStep", "/Matrix"}
)
# Resource categories whose entries can carry content; a redacted stream's
# dictionary is pruned to the names it still uses in these.
_PRUNED_CATEGORIES = ("/XObject", "/Pattern", "/ExtGState", "/Shading", "/Properties")
# More tiles than this under one mark and the whole cell is taken: at that
# density the mark covers the cell's content many times over anyway.
MAX_PATTERN_TILES = 4096
_DESCRIPTIONS = ("/ActualText", "/Alt", "/E")
_EVERYWHERE = (-1e12, -1e12, 1e12, 1e12)


def _objgen(obj):
    try:
        if obj.is_indirect:
            return tuple(obj.objgen)
    except Exception:
        pass
    return None


class _Run:
    """What one redaction run accumulates across pages and forms, for the
    document-wide pass (`redact_document.finish`) and the result."""

    def __init__(self, pdf, gs_path: str = ""):
        self.context = image_redact.Context(pdf, gs_path)
        self.copies_of: dict = {}  # original objgen -> redacted copies
        self.removed_originals: set = set()
        self.touched_mcids: set = set()  # (StructParents, MCID) of redacted content
        self.touched_stream_mcids: set = set()  # (stream objgen, MCID) of redacted content
        self.touched_struct_parents: set = set()  # /StructParent of redacted objects
        self.removed_widgets: set = set()
        self.removed_annotations: set = set()
        self.paths_redacted = 0
        self.inline_count = 0
        self.fonts = None  # redact_fonts.FontBaseline, taken before any page changes

    def note_copy(self, original, copy) -> None:
        key = _objgen(original)
        if key is None:
            return
        copies = self.copies_of.setdefault(key, [])
        if not any(c is copy or _objgen(c) == _objgen(copy) for c in copies):
            copies.append(copy)
        self._note_struct(original)

    def note_removed(self, original) -> None:
        key = _objgen(original)
        if key is not None:
            self.removed_originals.add(key)
        self._note_struct(original)

    def _note_struct(self, original) -> None:
        try:
            value = original.get("/StructParent")
            if value is not None:
                self.touched_struct_parents.add(int(value))
        except (TypeError, ValueError, AttributeError):
            pass


def _do_instruction(name: str):
    return pikepdf.ContentStreamInstruction([Name(name)], pikepdf.Operator("Do"))


def _existing_xobject_names(resources) -> set:
    return _existing_names(resources, "/XObject")


def _existing_names(resources, category: str) -> set:
    table = resources.get(category) if resources is not None else None
    return {str(k) for k in table.keys()} if isinstance(table, pikepdf.Dictionary) else set()


def _new_scoped_name(prefix: str, name_counter: list, taken: set) -> str:
    while True:
        name = f"/{prefix}{name_counter[0]}"
        name_counter[0] += 1
        if name not in taken:
            taken.add(name)
            return name


def _new_form_name(name_counter: list, taken: set) -> str:
    return _new_scoped_name("RdxFm", name_counter, taken)


def _new_image_name(name_counter: list, taken: set) -> str:
    return _new_scoped_name("RdxIm", name_counter, taken)


def _lookup_resource(resources, fallback_resources, category: str, name):
    if not name:
        return None
    for res in (resources, fallback_resources):
        if res is None:
            continue
        table = res.get(category)
        if isinstance(table, pikepdf.Dictionary):
            found = table.get(Name(str(name)))
            if found is not None:
                return found
    return None


def _is_pattern_space(operand, resources, fallback_resources) -> bool:
    if not isinstance(operand, pikepdf.Name):
        return False
    if str(operand) == "/Pattern":
        return True
    space = _lookup_resource(resources, fallback_resources, "/ColorSpace", operand)
    if isinstance(space, pikepdf.Name):
        return str(space) == "/Pattern"
    if isinstance(space, pikepdf.Array) and len(space):
        return str(space[0]) == "/Pattern"
    return False


def _number(value, fallback):
    try:
        return float(value)
    except (TypeError, ValueError):
        return fallback


def _style_from_extgstate(style, ext):
    try:
        if ext.get("/LW") is not None:
            style = style._replace(width=float(ext.get("/LW")))
        if ext.get("/LC") is not None:
            style = style._replace(cap=int(ext.get("/LC")))
        if ext.get("/LJ") is not None:
            style = style._replace(join=int(ext.get("/LJ")))
        if ext.get("/ML") is not None:
            style = style._replace(miter=float(ext.get("/ML")))
        dash = ext.get("/D")
        if isinstance(dash, pikepdf.Array) and len(dash) == 2:
            style = style._replace(dash=tuple(float(v) for v in dash[0]), phase=float(dash[1]))
    except (TypeError, ValueError):
        pass
    return style


def _tile_regions(pattern, m_pat, regions: list, boxes: list) -> list:
    """The marks, moved into the ONE pattern cell every tile repeats.

    A tiling pattern paints its cell at every (i*XStep, j*YStep) of pattern
    space. The cell's content under a mark in tile (i, j) is the content at the
    mark shifted back by that tile's offset — a translation in device space —
    so the cell is redacted once, against every shifted mark whose tile meets
    the painted area. Every tile then loses those pixels: more than the mark,
    never less.
    """
    try:
        bx0, by0, bx1, by1 = (float(v) for v in pattern.get("/BBox"))
        xstep = float(pattern.get("/XStep"))
        ystep = float(pattern.get("/YStep"))
    except (TypeError, ValueError):
        return [_EVERYWHERE]
    if xstep == 0 or ystep == 0:
        return [_EVERYWHERE]
    a, b, c, d, e, f = m_pat
    det = a * d - b * c
    if abs(det) < 1e-12:
        return [_EVERYWHERE]
    inverse = (d / det, -b / det, -c / det, a / det, (c * f - d * e) / det, (b * e - a * f) / det)
    out: list = []
    count = 0
    for box in boxes:
        for r in regions:
            x0, y0 = max(r[0], box[0]), max(r[1], box[1])
            x1, y1 = min(r[2], box[2]), min(r[3], box[3])
            if x1 <= x0 or y1 <= y0:
                continue
            corners = [
                (inverse[0] * x + inverse[2] * y + inverse[4], inverse[1] * x + inverse[3] * y + inverse[5])
                for x, y in ((x0, y0), (x1, y0), (x1, y1), (x0, y1))
            ]
            px0 = min(p[0] for p in corners)
            px1 = max(p[0] for p in corners)
            py0 = min(p[1] for p in corners)
            py1 = max(p[1] for p in corners)
            i_bounds = sorted(((px0 - bx1) / xstep, (px1 - bx0) / xstep))
            j_bounds = sorted(((py0 - by1) / ystep, (py1 - by0) / ystep))
            i_lo, i_hi = math.ceil(i_bounds[0]), math.floor(i_bounds[1])
            j_lo, j_hi = math.ceil(j_bounds[0]), math.floor(j_bounds[1])
            count += max(i_hi - i_lo + 1, 0) * max(j_hi - j_lo + 1, 0)
            if count > MAX_PATTERN_TILES:
                return [_EVERYWHERE]
            for i in range(i_lo, i_hi + 1):
                for j in range(j_lo, j_hi + 1):
                    tx = i * xstep * a + j * ystep * c
                    ty = i * xstep * b + j * ystep * d
                    out.append((x0 - tx, y0 - ty, x1 - tx, y1 - ty))
    return out


def _walk(
    pdf: "pikepdf.Pdf",
    instructions,
    resources,
    regions: list[Rect],
    base_ctm: Matrix,
    depth: int,
    name_counter: list,
    fonts: "_FontCache",
    parent_state: "GraphicsTextState | None" = None,
    fallback_resources=None,
    run: "_Run | None" = None,
    stroke: "vector_redact.StrokeStyle | None" = None,
    struct_parents=None,
    stream_key=None,
) -> WalkResult:
    """Redact one content-stream instruction list, recursing into Form
    XObjects, tiling patterns and soft-mask groups. `base_ctm` is the device
    CTM in effect at the start of this stream (IDENTITY for a page;
    form-matrix∘Do-CTM for a form), so every computed bbox is in page/device
    space where `regions` live. `parent_state` is the text state in effect at
    the invoking `Do` (`_child_state` is the shared inheritance rule the lister
    uses). `fonts` is the per-call capability cache; `fallback_resources` are
    the invoker's resources, consulted for a name a form's own /Resources
    omits. `run` gathers what the document-wide pass needs; `struct_parents`
    is this stream's /StructParents, the key its marked-content ids sit under
    in the parent tree, and `stream_key` the page or form a structure
    element's own /Pg or /Stm names."""
    if run is None:
        run = _Run(pdf)
    # The state machine lives in content_walk.GraphicsTextState (the
    # one-interpreter consolidation): q/Q save/restore CTM AND text-state
    # parameters; restoring only the CTM left a stale font size after
    # `q .. Tf .. Q`, under-sizing a later bbox — an under-redaction leak.
    state = _child_state(base_ctm, parent_state)

    # `sh` paints the CURRENT CLIP, so bounding it needs the clip. FRESH per
    # stream (base_clip None = unbounded): a form's `sh` then "covers
    # everything" and is removed, redaction's safe over-removal direction.
    clips = ClipTracker()

    # How far the pen position may LAG what we have tracked, in scaled
    # text-space units, since the last repositioning operator. A run whose
    # font cannot measure it advances by the WIDE estimate, so the following
    # runs' boxes grow leftward by the accumulated slack — the same fail-wide
    # direction as the width itself.
    slack = 0.0

    kept: list = []
    text_runs_removed = 0
    text_runs_split = 0
    runs_removed_whole = 0
    images_removed = 0
    images_modified = 0
    dropped_image_names: set = set()
    surviving_image_names: set = set()
    new_forms: dict = {}
    new_images: dict = {}
    replaced_form_names: set = set()
    replaced_image_names: set = set()
    forms_dropped_at_cap = 0
    new_resources: dict = {"/Pattern": {}, "/ExtGState": {}, "/Properties": {}}
    replaced_resources: dict = {"/Pattern": set(), "/ExtGState": set(), "/Properties": set()}
    paths_redacted = 0
    changed = False
    taken_names = _existing_xobject_names(resources)
    taken_other = {category: _existing_names(resources, category) for category in new_resources}
    image_names: dict = {}  # id(copy) -> the name it is registered under here
    resolve_colorspace = _colorspace_resolver(resources, fallback_resources)
    stroke = stroke or vector_redact.StrokeStyle()
    fill_is_pattern = False
    stroke_is_pattern = False
    fill_pattern = None  # (index in kept of the scn that chose it, pattern name)
    stroke_pattern = None
    style_stack: list = []
    pattern_uses: dict = {}  # index in kept -> [pattern name, [device boxes]]
    path_ops: list = []
    clip_op = None
    marked: list = []  # open marked-content sequences: [index, operands, props, touched]

    def touch():
        nonlocal changed
        changed = True
        for entry in marked:
            entry[3] = True

    def flush_path():
        nonlocal path_ops, clip_op
        kept.extend(path_ops)
        if clip_op is not None:
            kept.append(clip_op)
        path_ops = []
        clip_op = None

    def demand_pattern(box, fills: bool, strokes: bool):
        for flag, current in ((fills, fill_pattern), (strokes, stroke_pattern)):
            if flag and current is not None:
                pattern_uses.setdefault(current[0], [current[1], []])[1].append(box)

    def close_marked(entry):
        index, mc_operands, props, touched = entry
        if not touched or props is None:
            return
        mcid = props.get("/MCID")
        if mcid is not None:
            try:
                number = int(mcid)
                if struct_parents is not None:
                    run.touched_mcids.add((int(struct_parents), number))
                if stream_key is not None:
                    run.touched_stream_mcids.add((stream_key, number))
            except (TypeError, ValueError):
                pass
        if not any(key in props for key in _DESCRIPTIONS):
            return
        # A replacement text or a description spans the whole sequence, so it
        # names the redacted content too; it goes, and extraction falls back
        # to the glyphs that are still there.
        cleaned = pikepdf.Dictionary({k: props[k] for k in props.keys() if k not in _DESCRIPTIONS})
        tag = mc_operands[0]
        if isinstance(mc_operands[1], pikepdf.Name):
            new_name = _new_scoped_name("RdxMc", name_counter, taken_other["/Properties"])
            new_resources["/Properties"][new_name] = pdf.make_indirect(cleaned)
            replaced_resources["/Properties"].add(str(mc_operands[1]))
            kept[index] = pikepdf.ContentStreamInstruction([tag, Name(new_name)], pikepdf.Operator("BDC"))
        else:
            kept[index] = pikepdf.ContentStreamInstruction([tag, cleaned], pikepdf.Operator("BDC"))

    for instruction in instructions:
        operator = str(instruction.operator)
        operands = list(instruction.operands)

        # Clip bookkeeping rides alongside the shared state machine (fed with
        # the CURRENT ctm, BEFORE state.feed applies this op's own effect —
        # path-point ops never move the CTM, so pre-feed ctm is correct).
        clips.feed(operator, operands, state.ctm)

        if operator in vector_redact.PATH_OPS:
            path_ops.append(instruction)
            continue
        if operator in ("W", "W*") and path_ops:
            clip_op = instruction
            continue
        if operator in vector_redact.PAINT_OPS:
            if not path_ops and clip_op is None:
                kept.append(instruction)
                continue
            fills = operator in ("f", "F", "f*", "B", "B*", "b", "b*")
            strokes = operator in ("S", "s", "B", "B*", "b", "b*")
            if (fills and fill_pattern is not None) or (strokes and stroke_pattern is not None):
                box = vector_redact.control_box(path_ops, state.ctm)
                if box is not None and _intersects_any(box, regions):
                    demand_pattern(box, fills, strokes)
            replacement = vector_redact.redact_path(path_ops, instruction, clip_op, state.ctm, stroke, regions)
            if replacement is None:
                flush_path()
                kept.append(instruction)
            else:
                kept.extend(replacement)
                path_ops = []
                clip_op = None
                paths_redacted += 1
                touch()
            continue
        if path_ops or clip_op is not None:
            flush_path()

        if operator == "q":
            style_stack.append((stroke, fill_is_pattern, stroke_is_pattern, fill_pattern, stroke_pattern))
        elif operator == "Q":
            if style_stack:
                stroke, fill_is_pattern, stroke_is_pattern, fill_pattern, stroke_pattern = style_stack.pop()
        elif operator == "w" and operands:
            stroke = stroke._replace(width=_number(operands[0], stroke.width))
        elif operator == "J" and operands:
            stroke = stroke._replace(cap=int(_number(operands[0], stroke.cap)))
        elif operator == "j" and operands:
            stroke = stroke._replace(join=int(_number(operands[0], stroke.join)))
        elif operator == "M" and operands:
            stroke = stroke._replace(miter=_number(operands[0], stroke.miter))
        elif operator == "d" and len(operands) == 2:
            try:
                stroke = stroke._replace(dash=tuple(float(v) for v in operands[0]), phase=float(operands[1]))
            except (TypeError, ValueError):
                pass

        if operator in ("Td", "TD", "Tm", "T*", "BT", "ET"):
            slack = 0.0

        if state.feed(operator, operands):
            kept.append(instruction)
            if operator == "cs":
                fill_is_pattern = bool(operands) and _is_pattern_space(operands[0], resources, fallback_resources)
                fill_pattern = None
            elif operator == "CS":
                stroke_is_pattern = bool(operands) and _is_pattern_space(operands[0], resources, fallback_resources)
                stroke_pattern = None
            elif operator in ("g", "rg", "k"):
                fill_is_pattern = False
                fill_pattern = None
            elif operator in ("G", "RG", "K"):
                stroke_is_pattern = False
                stroke_pattern = None
            elif operator == "scn":
                has_name = bool(operands) and isinstance(operands[-1], pikepdf.Name)
                fill_pattern = (len(kept) - 1, str(operands[-1])) if fill_is_pattern and has_name else None
            elif operator == "SCN":
                has_name = bool(operands) and isinstance(operands[-1], pikepdf.Name)
                stroke_pattern = (len(kept) - 1, str(operands[-1])) if stroke_is_pattern and has_name else None
        elif operator == "gs":
            name = str(operands[0]) if operands else ""
            ext = _lookup_resource(resources, fallback_resources, "/ExtGState", name)
            if isinstance(ext, pikepdf.Dictionary):
                stroke = _style_from_extgstate(stroke, ext)
                smask = ext.get("/SMask")
                group = smask.get("/G") if isinstance(smask, pikepdf.Dictionary) else None
                if isinstance(group, pikepdf.Stream) and depth < MAX_FORM_DEPTH:
                    # The soft mask's content decides what shows through every
                    # later paint; its images and text under a mark are
                    # content under the mark. Its coordinate system is the CTM
                    # at this gs (ISO 32000-2 §11.6.5.2).
                    group_ctm = _mat_mult(_as_matrix(group.get("/Matrix")) or IDENTITY, state.ctm)
                    copy, _sub = _redact_form(
                        pdf, group, resources, regions, group_ctm, depth + 1,
                        name_counter, fonts, None, run=run,
                    )
                    if copy is not None:
                        new_smask = pikepdf.Dictionary({k: smask[k] for k in smask.keys()})
                        new_smask["/G"] = copy
                        new_ext = pikepdf.Dictionary({k: ext[k] for k in ext.keys()})
                        new_ext["/SMask"] = new_smask
                        new_name = _new_scoped_name("RdxGs", name_counter, taken_other["/ExtGState"])
                        new_resources["/ExtGState"][new_name] = pdf.make_indirect(new_ext)
                        replaced_resources["/ExtGState"].add(name)
                        run.note_copy(group, copy)
                        kept.append(pikepdf.ContentStreamInstruction([Name(new_name)], pikepdf.Operator("gs")))
                        touch()
                        continue
            kept.append(instruction)
        elif operator in ("BDC", "BMC"):
            kept.append(instruction)
            props = None
            if operator == "BDC" and len(operands) >= 2:
                operand = operands[1]
                if isinstance(operand, pikepdf.Dictionary):
                    props = operand
                elif isinstance(operand, pikepdf.Name):
                    found = _lookup_resource(resources, fallback_resources, "/Properties", operand)
                    props = found if isinstance(found, pikepdf.Dictionary) else None
            marked.append([len(kept) - 1, operands, props, False])
        elif operator == "EMC":
            kept.append(instruction)
            if marked:
                close_marked(marked.pop())
        elif operator == "sh":
            # A shading paints the current clip. Unclipped (`clip is None`) it
            # covers the page, so it covers every region — remove it.
            if clips.clip is None or _intersects_any(clips.clip, regions):
                images_removed += 1
                touch()
            else:
                kept.append(instruction)
        elif operator in ("Tj", "'", '"', "TJ"):
            # ' and " implicitly advance to the next line BEFORE showing, and
            # " sets Tw/Tc BEFORE showing — both affect this run's own width.
            if operator in ("'", '"'):
                state.next_line()
                slack = 0.0
                if operator == '"' and len(operands) >= 2:
                    try:
                        state.word_spacing = float(operands[0])
                        state.char_spacing = float(operands[1])
                    except (TypeError, ValueError):
                        pass
            cap = fonts.capability(resources, fallback_resources, state.font_name)
            data = show_bytes(operator, operands)
            measured = measurable(cap, data)
            if measured:
                _text, raw_width = _run_metrics(operator, operands, cap, state)
            else:
                raw_width = wide_width(operator, operands, cap, state)
            # `writes_vertical`, not `vertical`: a REFUSED Identity-V font
            # still draws its column downward.
            vertical = bool(cap is not None and cap.writes_vertical)
            combined = _mat_mult(state.tm, state.ctm)
            ink = fonts.ink_extent(resources, fallback_resources, state.font_name)
            bbox = _run_bbox(combined, raw_width, slack, vertical, state, ink)
            if not _intersects_any(bbox, regions):
                kept.append(instruction)
            else:
                emitted = None
                if measured and state.font_size > 0 and slack == 0.0:
                    items = show_items(operator, operands, cap, state)
                    clusters = show_clusters(items)
                    removed_clusters = {
                        index
                        for index, cluster in enumerate(clusters)
                        if _intersects_any(
                            _span_bbox(
                                combined, *cluster_span(items, cluster),
                                vertical, state, ink,
                            ),
                            regions,
                        )
                    }
                    if removed_clusters:
                        emitted = _split_instructions(
                            operator, operands, items, clusters,
                            removed_clusters, state,
                        )
                        if len(removed_clusters) < len(clusters):
                            text_runs_split += 1
                    else:
                        # The run's box meets a region but no GLYPH does — the
                        # mark sits in a kerning gap. Nothing to remove.
                        kept.append(instruction)
                        emitted = []
                if emitted is None:
                    # Unmeasurable (or the slack has already blurred where this
                    # run sits): the whole operator goes, the over-removing
                    # direction. The line-advance side effect of ' and " stays.
                    runs_removed_whole += 1
                    text_runs_removed += 1
                    kept.extend(_state_only_instructions(operator, operands))
                    touch()
                    demand_pattern(bbox, state.render_mode in (0, 2, 4, 6), state.render_mode in (1, 2, 5, 6))
                elif emitted:
                    kept.extend(emitted)
                    text_runs_removed += 1
                    touch()
                    demand_pattern(bbox, state.render_mode in (0, 2, 4, 6), state.render_mode in (1, 2, 5, 6))
            # Advance the text matrix so subsequent same-line Tj/TJ calls
            # don't all collapse onto the same origin point.
            state.advance_after_show(raw_width, vertical)
            if not measured:
                slack += raw_width if vertical else raw_width * state.h_scale
        elif operator == "INLINE IMAGE":
            # A BI/ID/EI object draws the unit square under the live CTM
            # exactly as an image `Do` does. Kept verbatim, its pixels stayed
            # in the stream under a black box. A partial mark brings it back
            # as an image XObject with the marked pixels destroyed; either way
            # the inline bytes leave the stream.
            bbox = _bbox_of_rect_under_matrix(state.ctm, 1.0, 1.0)
            if not _intersects_any(bbox, regions):
                kept.append(instruction)
                continue
            placement = image_redact.plan_inline(pdf, operands[0], state.ctm, regions, run.context, resolve_colorspace)
            if placement.kind == "keep":
                kept.append(instruction)
                continue
            run.inline_count += 1
            identity = ("inline", run.inline_count)
            touch()
            if placement.kind == "remove":
                images_removed += 1
                run.context.removed.add(identity)
                if placement.codec:
                    run.context.removed_for_codec.add(identity)
            else:
                new_name = _new_image_name(name_counter, taken_names)
                new_images[new_name] = placement.stream
                kept.append(_do_instruction(new_name))
                images_modified += 1
                run.context.modified.add(identity)
                if placement.widened:
                    run.context.widened.add(identity)
        elif operator == "Do":
            name = str(operands[0]) if operands else None
            xobj = _lookup_xobject(name, resources, fallback_resources)
            subtype = str(xobj.get("/Subtype", "")) if xobj is not None else ""

            if xobj is not None and subtype == "/Image":
                bbox = _bbox_of_rect_under_matrix(state.ctm, 1.0, 1.0)
                placement = (
                    image_redact.plan_placement(pdf, xobj, state.ctm, regions, run.context, resolve_colorspace)
                    if _intersects_any(bbox, regions)
                    else None
                )
                if placement is None or placement.kind == "keep":
                    if name:
                        surviving_image_names.add(name)
                    kept.append(instruction)
                    continue
                identity = image_redact._identity(xobj)
                touch()
                if placement.kind == "remove":
                    images_removed += 1
                    if name:
                        dropped_image_names.add(name)
                    run.context.removed.add(identity)
                    if placement.codec:
                        run.context.removed_for_codec.add(identity)
                    run.note_removed(xobj)
                else:
                    # Per PLACEMENT, on a copy: a shared XObject drawn again
                    # outside the mark keeps the original; placements with the
                    # same plan share one copy.
                    new_name = image_names.get(id(placement.stream))
                    if new_name is None:
                        new_name = _new_image_name(name_counter, taken_names)
                        image_names[id(placement.stream)] = new_name
                        new_images[new_name] = placement.stream
                    if name:
                        replaced_image_names.add(name)
                    kept.append(_do_instruction(new_name))
                    images_modified += 1
                    run.context.modified.add(identity)
                    if placement.widened:
                        run.context.widened.add(identity)
                    run.note_copy(xobj, placement.stream)
            elif xobj is not None and subtype == "/Form":
                form_matrix = _as_matrix(xobj.get("/Matrix")) or IDENTITY
                form_ctm = _mat_mult(form_matrix, state.ctm)
                bbox_arr = xobj.get("/BBox")
                placed = None
                if bbox_arr is not None:
                    try:
                        bx0, by0, bx1, by1 = (float(v) for v in bbox_arr)
                        placed = _bbox_of_corners_under_matrix(form_ctm, bx0, by0, bx1, by1)
                    except (TypeError, ValueError):
                        placed = None
                intersects = placed is None or _intersects_any(placed, regions)
                if not intersects:
                    kept.append(instruction)
                elif depth >= MAX_FORM_DEPTH:
                    # Past the recursion cap the form cannot be inspected, and
                    # it DOES overlap a region — drop the whole draw rather
                    # than leak whatever it contains. Only reachable on
                    # pathological (cyclic) nesting.
                    forms_dropped_at_cap += 1
                    if name:
                        replaced_form_names.add(name)
                    run.note_removed(xobj)
                    touch()
                else:
                    copy, sub = _redact_form(
                        pdf, xobj, resources, regions, form_ctm, depth + 1,
                        name_counter, fonts, state, run=run, stroke=stroke,
                    )
                    if copy is not None:
                        new_name = _new_form_name(name_counter, taken_names)
                        new_forms[new_name] = copy
                        if name:
                            replaced_form_names.add(name)
                        kept.append(_do_instruction(new_name))
                        text_runs_removed += sub[0]
                        text_runs_split += sub[1]
                        runs_removed_whole += sub[2]
                        images_removed += sub[3]
                        images_modified += sub[4]
                        run.note_copy(xobj, copy)
                        touch()
                    else:
                        kept.append(instruction)
            else:
                kept.append(instruction)
        else:
            kept.append(instruction)

    flush_path()
    while marked:
        close_marked(marked.pop())

    for index, (pattern_name, boxes) in pattern_uses.items():
        pattern = _lookup_resource(resources, fallback_resources, "/Pattern", pattern_name)
        if not isinstance(pattern, pikepdf.Stream) or depth >= MAX_FORM_DEPTH:
            continue
        try:
            if int(pattern.get("/PatternType", 0)) != 1:
                continue
        except (TypeError, ValueError):
            continue
        m_pat = _mat_mult(_as_matrix(pattern.get("/Matrix")) or IDENTITY, base_ctm)
        cell_regions = _tile_regions(pattern, m_pat, regions, boxes)
        if not cell_regions:
            continue
        copy, sub = _redact_form(
            pdf, pattern, resources, cell_regions, m_pat, depth + 1,
            name_counter, fonts, None, run=run, kept_keys=PATTERN_KEPT_KEYS,
        )
        if copy is None:
            continue
        new_name = _new_scoped_name("RdxPt", name_counter, taken_other["/Pattern"])
        new_resources["/Pattern"][new_name] = copy
        replaced_resources["/Pattern"].add(pattern_name)
        original = kept[index]
        kept[index] = pikepdf.ContentStreamInstruction(
            list(original.operands)[:-1] + [Name(new_name)], original.operator
        )
        images_removed += sub[3]
        images_modified += sub[4]
        run.note_copy(pattern, copy)
        changed = True

    run.paths_redacted += paths_redacted
    return WalkResult(
        kept,
        text_runs_removed,
        text_runs_split,
        runs_removed_whole,
        images_removed,
        images_modified,
        dropped_image_names,
        surviving_image_names,
        new_forms,
        new_images,
        replaced_form_names,
        replaced_image_names,
        forms_dropped_at_cap,
        new_resources,
        replaced_resources,
        paths_redacted,
        changed,
    )


def _referenced_xobject_names(instructions) -> set:
    return {
        str(ins.operands[0])
        for ins in instructions
        if str(ins.operator) == "Do" and ins.operands
    }


def _referenced_names(instructions, resources, depth: int = 0) -> dict:
    """Every resource name, per content-bearing category, that `instructions`
    use — including the names a form WITHOUT its own /Resources resolves
    here, since it draws with this dictionary."""
    used: dict = {category: set() for category in _PRUNED_CATEGORIES}
    for ins in instructions:
        op = str(ins.operator)
        operands = list(ins.operands)
        if op == "Do" and operands:
            used["/XObject"].add(str(operands[0]))
        elif op == "gs" and operands:
            used["/ExtGState"].add(str(operands[0]))
        elif op == "sh" and operands:
            used["/Shading"].add(str(operands[0]))
        elif op in ("scn", "SCN") and operands and isinstance(operands[-1], pikepdf.Name):
            used["/Pattern"].add(str(operands[-1]))
        elif op == "BDC" and len(operands) >= 2 and isinstance(operands[1], pikepdf.Name):
            used["/Properties"].add(str(operands[1]))
    if depth < MAX_FORM_DEPTH:
        table = resources.get("/XObject") if resources is not None else None
        for name in list(used["/XObject"]):
            form = table.get(Name(name)) if isinstance(table, pikepdf.Dictionary) else None
            if (
                isinstance(form, pikepdf.Stream)
                and form.get("/Subtype") == Name("/Form")
                and form.get("/Resources") is None
            ):
                try:
                    inner = _referenced_names(pikepdf.parse_content_stream(form), resources, depth + 1)
                except Exception:
                    continue
                for category, names in inner.items():
                    used[category] |= names
    return used


def _prune_to_references(resources, instructions) -> None:
    """Remove every entry of a content-bearing category that the stream no
    longer uses. A replaced original left listed stays reachable — and a form
    without /Resources that is still listed keeps alive every name its own
    content draws, which is how an image survived a redaction reported as
    done."""
    if resources is None:
        return
    used = _referenced_names(instructions, resources)
    for category in _PRUNED_CATEGORIES:
        table = resources.get(category)
        if not isinstance(table, pikepdf.Dictionary):
            continue
        for name in [str(k) for k in table.keys()]:
            if name not in used[category]:
                del table[Name(name)]


def _drop_replaced_forms(xobjects, referenced: set, replaced: set) -> None:
    """Delete the original form entries we rewrote to redacted copies, but only
    where no surviving Do still references them."""
    if xobjects is None:
        return
    for nm in replaced:
        if nm not in referenced and Name(nm) in xobjects:
            del xobjects[Name(nm)]


def _copy_resources_for_write(pdf: "pikepdf.Pdf", resources):
    """A fresh /Resources dict: every content-bearing category is a NEW
    subdict (so pruning and registering never touch the original's), the
    others are shared by reference since they are only read."""
    new = pikepdf.Dictionary()
    if resources is not None:
        for key in resources.keys():
            new[key] = resources[key]
    for category in _PRUNED_CATEGORIES:
        source = resources.get(category) if resources is not None else None
        table = pikepdf.Dictionary()
        if isinstance(source, pikepdf.Dictionary):
            for key in source.keys():
                table[key] = source[key]
        new[category] = table
    return new


def _register(resources, result: "WalkResult") -> None:
    xo = resources.get("/XObject")
    if xo is None:
        xo = pikepdf.Dictionary()
        resources["/XObject"] = xo
    for nm, st in result.new_forms.items():
        xo[Name(nm)] = st
    for nm, st in result.new_images.items():
        xo[Name(nm)] = st
    for category, entries in result.new_resources.items():
        if not entries:
            continue
        table = resources.get(category)
        if table is None:
            table = pikepdf.Dictionary()
            resources[category] = table
        for nm, obj in entries.items():
            table[Name(nm)] = obj


def _redact_form(
    pdf, form, parent_resources, regions, form_ctm, depth, name_counter, fonts,
    parent_state=None, run=None, stroke=None, kept_keys=None,
):
    """Build a redacted COPY of a Form XObject (or of a tiling pattern, or of a
    soft mask's group), or return (None, None) if nothing inside it changed
    (the caller then keeps the original). Returns (copy_stream, (text_removed,
    text_split, removed_whole, images_removed, images_modified))."""
    form_res = form.get("/Resources")
    read_res = form_res if form_res is not None else parent_resources
    result = _walk(
        pdf,
        pikepdf.parse_content_stream(form),
        read_res,
        regions,
        form_ctm,
        depth,
        name_counter,
        fonts,
        parent_state=parent_state,
        fallback_resources=parent_resources,
        run=run,
        stroke=stroke,
        struct_parents=form.get("/StructParents"),
        stream_key=_objgen(form),
    )
    if not result.changed and result.forms_dropped_at_cap == 0:
        return None, None

    copy = pdf.make_stream(pikepdf.unparse_content_stream(result.kept))
    # make_stream stores the rebuilt content UNCOMPRESSED with no filter, so
    # the original's /Filter or /DecodeParms must NOT travel: a /FlateDecode
    # over raw bytes yields a stream no reader can inflate.
    keep = kept_keys if kept_keys is not None else FORM_KEPT_KEYS
    for key in form.keys():
        if key in keep and key != "/Resources":
            copy[key] = form[key]

    copy_res = _copy_resources_for_write(pdf, read_res)
    _register(copy_res, result)
    _prune_to_references(copy_res, result.kept)
    copy["/Resources"] = copy_res

    return copy, (
        result.text_runs_removed,
        result.text_runs_split,
        result.runs_removed_whole,
        result.images_removed,
        result.images_modified,
    )


# ── redaction properties: the overlay a region is painted with ──
#
# The format's own vocabulary, and `save_redaction_marks` already writes three
# of its neighbours: `/IC` is the fill, `/OverlayText` the text drawn over it,
# `/Repeat` tiles that text to fill the box, `/Q` aligns it and `/DA` carries
# the font, size and colour. Until now the fill was hard-coded `0 0 0 rg` here
# and hard-coded `[0,0,0]` there — two copies of a decision the user never got
# to make, on a tool where a FOIA exemption code printed in the box is the
# whole point of the redaction for the reader who receives the file.


class RedactionProperties(NamedTuple):
    """One region's appearance. Every field has a format key behind it."""

    fill: tuple  # /IC — the box colour, RGB 0..1
    overlay_text: str  # /OverlayText
    repeat: bool  # /Repeat — tile the text to fill the box
    align: int  # /Q — 0 left, 1 centred, 2 right
    font_size: float  # /DA — 0 = fit the box
    text_color: tuple  # /DA


DEFAULT_FILL = (0.0, 0.0, 0.0)
# Leading as a multiple of the font size, for a repeated/tiled overlay.
OVERLAY_LINE_EM = 1.15
MIN_OVERLAY_SIZE = 4.0
MAX_OVERLAY_SIZE = 72.0
# The overlay is inset from the box edge so a glyph never touches the border.
OVERLAY_PAD_EM = 0.15


def _rgb(value, fallback: tuple) -> tuple:
    try:
        parts = [float(v) for v in value]
    except (TypeError, ValueError):
        return fallback
    if len(parts) != 3:
        return fallback
    return tuple(min(max(p, 0.0), 1.0) for p in parts)


def _auto_text_color(fill: tuple) -> tuple:
    """White on a dark fill, black on a light one.

    A DEFAULT, not a decision taken from the user: `text_color` given
    explicitly always wins. Defaulting to a fixed colour instead would make
    the common "white box, coded overlay" case draw white on white — an
    overlay nobody can read is the same as no overlay, on a surface whose job
    is telling the reader WHY something was removed.
    """
    r, g, b = fill
    luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b
    return (0.0, 0.0, 0.0) if luminance > 0.55 else (1.0, 1.0, 1.0)


def properties_of(spec: dict) -> RedactionProperties:
    """Read one region's properties, defaulting to today's shipped look — a
    plain black box with no overlay, so a caller that sends none gets exactly
    the bytes it got before redaction properties existed."""
    fill = _rgb(spec.get("fill"), DEFAULT_FILL)
    text = str(spec.get("overlay_text") or "")
    align = spec.get("align", 0)
    try:
        align = int(align)
    except (TypeError, ValueError):
        align = 0
    if align not in (0, 1, 2):
        raise ValueError("align must be 0 (left), 1 (centred) or 2 (right)")
    try:
        size = float(spec.get("font_size") or 0.0)
    except (TypeError, ValueError):
        size = 0.0
    if size < 0:
        raise ValueError("font size must not be negative")
    color = (
        _rgb(spec.get("text_color"), _auto_text_color(fill))
        if spec.get("text_color") is not None
        else _auto_text_color(fill)
    )
    return RedactionProperties(fill, text, bool(spec.get("repeat_overlay")), align, size, color)


class _OverlayFace(NamedTuple):
    """A face that can DRAW and MEASURE one line of overlay text."""

    obj: object
    show: object  # (text) -> the complete show-operator bytes
    width_em: object  # (text) -> advance in ems


def _helvetica_face(pdf) -> _OverlayFace:
    from engine.pdf_metrics import text_width_em

    obj = pdf.make_indirect(
        pikepdf.Dictionary(
            Type=Name("/Font"),
            Subtype=Name("/Type1"),
            BaseFont=Name("/Helvetica"),
            Encoding=Name("/WinAnsiEncoding"),
        )
    )

    def show(text: str) -> bytes:
        escaped = "".join(
            ("\\" + ch) if ch in ("(", ")", "\\") else (ch if 32 <= ord(ch) <= 255 else "?")
            for ch in text
        )
        return b"(" + escaped.encode("latin-1") + b") Tj"

    return _OverlayFace(obj, show, text_width_em)


def _overlay_face(pdf, text: str, font_dir: str) -> _OverlayFace:
    """The face to draw `text` with.

    Latin-1 keeps the standard-14 Helvetica emission byte for byte (so an
    ASCII overlay adds no font program to the file). Anything else EMBEDS
    through the bundled fallback — the precedent: a non-Latin-1 overlay is
    not a refusal and is never `?`-mapped, because a redaction code printed as
    question marks tells the reader nothing. A right-to-left overlay goes
    through `rtl_text`, the builder the watermark and the field appearances
    already share — a per-character `Tj` would draw a joining script
    disconnected and reversed.
    """
    if not text or all(ord(ch) <= 255 for ch in text):
        return _helvetica_face(pdf)
    if not font_dir:
        # No fonts directory to embed from. Refuse rather than draw '?' — an
        # overlay that lies about what it says is worse than the refusal.
        raise ValueError(
            "this overlay text needs an embedded font and no font directory was given"
        )
    from engine.font_fallback import build_fallback_font, resolve_fallback_font

    try:
        from engine import bidi

        rtl = bidi.has_strong_rtl(text)
    except Exception:
        rtl = False
    face = resolve_fallback_font(font_dir, text=text, rtl_ok=rtl)
    if rtl:
        from engine import rtl_text

        built = rtl_text.build(pdf, face, text)
        if built is not None:
            return _OverlayFace(
                built.font_obj,
                lambda t: built.show(t, 1.0),
                lambda t: built.width_em(t),
            )
    font_dict, encode, width_1000 = build_fallback_font(pdf, face, text)
    return _OverlayFace(
        font_dict,
        lambda t: b"<" + encode(t).hex().encode("ascii") + b"> Tj",
        lambda t: width_1000(t) / 1000.0,
    )


def _fit_size(props: RedactionProperties, face: _OverlayFace, w: float, h: float) -> float:
    if props.font_size > 0:
        return props.font_size
    advance = max(face.width_em(props.overlay_text), 0.01)
    inner = max(w - 2 * OVERLAY_PAD_EM * 12.0, 1.0)
    by_width = inner / advance
    by_height = h / OVERLAY_LINE_EM
    return max(MIN_OVERLAY_SIZE, min(MAX_OVERLAY_SIZE, min(by_width, by_height)))


def _overlay_lines(props: RedactionProperties, face: _OverlayFace, size: float, w: float, h: float):
    """(text, x, y) baselines for the overlay, in the box's own coordinates.

    `/Repeat` tiles the text to FILL the box — horizontally by repeating it
    within a line, vertically by drawing as many lines as fit. Without it, one
    line, vertically centred, which is what a single exemption code wants.
    """
    unit = max(face.width_em(props.overlay_text) * size, 0.01)
    pad = OVERLAY_PAD_EM * size
    inner = max(w - 2 * pad, 0.01)
    line_h = OVERLAY_LINE_EM * size
    if props.repeat:
        per_line = max(int(inner // unit), 1)
        text = props.overlay_text * per_line
        rows = max(int(h // line_h), 1)
    else:
        text = props.overlay_text
        rows = 1
    width = face.width_em(text) * size
    if props.align == 1:
        x = (w - width) / 2.0
    elif props.align == 2:
        x = w - pad - width
    else:
        x = pad
    out = []
    if props.repeat:
        # Top-down, so the first line sits where a reader starts.
        top = h - line_h
        for row in range(rows):
            out.append((text, x, top - row * line_h + 0.25 * size))
    else:
        out.append((text, x, (h - size * 0.7) / 2.0 + 0.02 * size))
    return out


def _overlay_stream(
    pdf, specs: list, font_dir: str
) -> tuple[bytes, dict]:
    """The content painted OVER the rebuilt page: one filled box per region,
    plus its overlay text clipped to that box. Returns (bytes, fonts to
    register), where an empty font map means the standard-14 path was enough.
    """
    parts: list[bytes] = []
    fonts: dict = {}
    counter = 0
    for spec in specs:
        rect = spec["rect"]
        props = spec["props"]
        x0, y0, x1, y1 = rect
        w, h = x1 - x0, y1 - y0
        r, g, b = props.fill
        parts.append(
            f"q {r:.6g} {g:.6g} {b:.6g} rg {x0} {y0} {w} {h} re f Q\n".encode("ascii")
        )
        if not props.overlay_text or w <= 0 or h <= 0:
            continue
        face = _overlay_face(pdf, props.overlay_text, font_dir)
        name = f"/RdxOv{counter}"
        counter += 1
        fonts[name] = face.obj
        size = _fit_size(props, face, w, h)
        tr, tg, tb = props.text_color
        body = [
            f"q {x0} {y0} {w} {h} re W n {tr:.6g} {tg:.6g} {tb:.6g} rg BT "
            f"{name} {size:.6g} Tf\n".encode("ascii")
        ]
        for text, tx, ty in _overlay_lines(props, face, size, w, h):
            body.append(f"1 0 0 1 {x0 + tx:.6g} {y0 + ty:.6g} Tm ".encode("ascii"))
            body.append(face.show(text))
            body.append(b"\n")
        body.append(b"ET Q\n")
        parts.append(b"".join(body))
    return b"".join(parts), fonts


def _annot_key(obj):
    """Identity key for an annotation object, so /Popup /Parent /IRT references
    can be matched against /Annots entries. Indirect objects key on objgen;
    the rare inline annotation falls back to Python identity."""
    try:
        if obj.is_indirect:
            num, gen = obj.objgen
            return ("i", num, gen)
    except Exception:
        pass
    return ("d", id(obj))


# The keys a removed annotation keeps: what it was, never what it held.
_ANNOT_HUSK_KEYS = frozenset({"/Type", "/Subtype"})


def _scrub_annotation(annot) -> None:
    """Empty a removed annotation object down to its type, so that any OTHER
    surviving reference to it (a structure-tree entry, a field's calculation
    order, a reference we didn't model) cannot expose what it held — its text,
    its appearance, a field value, a link's target, an attached file."""
    try:
        keys = [str(key) for key in annot.keys()]
    except Exception:
        return
    for key in keys:
        if key in _ANNOT_HUSK_KEYS:
            continue
        try:
            del annot[key]
        except Exception:
            pass


def _annot_overlaps(annot, regions: list[Rect]) -> bool:
    """Does this annotation touch a redaction region?

    FAILS CLOSED. An annotation whose `/Rect` cannot be read is treated as
    OVERLAPPING, so it is removed. Redaction is a security tool: the only
    tolerable error is removing too much. This previously returned False on
    an unreadable `/Rect` — an annotation with a damaged or broken-indirect
    rect sitting on top of a redacted region SURVIVED, silently, in a
    function whose whole job is to decide what must not survive.
    """
    try:
        rect = annot.get("/Rect")
    except Exception:
        return True  # unreadable — assume it overlaps
    if rect is None:
        # No /Rect at all: it has no position to compare, so it cannot be
        # shown to be clear of the regions. Remove it.
        return True
    try:
        r = _normalize_rect([float(v) for v in rect])
    except (TypeError, ValueError):
        return True  # non-numeric — assume it overlaps
    return _intersects_any(r, regions)


def _strip_annotations(
    page: "pikepdf.Page", regions: list[Rect], removed_widgets: "set | None" = None, removed: "set | None" = None
) -> int:
    """Remove annotations whose /Rect intersects a region — and cascade to
    their companions (a /Popup, or an /IRT reply) which commonly sit at a
    non-overlapping /Rect but reference the removed annotation via /Parent or
    /IRT, keeping its (secret-bearing) object reachable if left behind.
    Removed objects are also content-scrubbed as a belt-and-suspenders against
    any reference we don't model. /Rect is in page user space, like `regions`.
    A removed form WIDGET is recorded in `removed_widgets`: its field keeps the
    value in the form tree, which the document pass takes out. Every removed
    annotation is recorded in `removed`, for the structure references to it."""
    annots = page.obj.get("/Annots")
    if annots is None:
        return 0
    entries = list(annots)
    present = {_annot_key(a) for a in entries}

    remove = {_annot_key(a) for a in entries if _annot_overlaps(a, regions)}
    if not remove:
        return 0

    # Cascade: pull in each removed annot's /Popup, and any entry whose /Parent
    # or /IRT resolves to something already slated for removal. Iterate to a
    # fixed point so reply-chains are fully collected.
    changed = True
    while changed:
        changed = False
        for a in entries:
            key = _annot_key(a)
            if key in remove:
                for companion_key in ("/Popup",):
                    try:
                        companion = a.get(companion_key)
                    except Exception:
                        companion = None
                    if companion is not None:
                        ck = _annot_key(companion)
                        if ck in present and ck not in remove:
                            remove.add(ck)
                            changed = True
                continue
            for ref_key in ("/Parent", "/IRT"):
                try:
                    ref = a.get(ref_key)
                except Exception:
                    ref = None
                if ref is not None and _annot_key(ref) in remove:
                    remove.add(key)
                    changed = True
                    break

    kept = []
    count = 0
    for a in entries:
        if _annot_key(a) in remove:
            count += 1
            try:
                if a.is_indirect:
                    if removed is not None:
                        removed.add(tuple(a.objgen))
                    if removed_widgets is not None and a.get("/Subtype") == Name("/Widget"):
                        removed_widgets.add(tuple(a.objgen))
            except Exception:
                pass
            _scrub_annotation(a)
        else:
            kept.append(a)
    if kept:
        page.obj["/Annots"] = pikepdf.Array(kept)
    else:
        del page.obj["/Annots"]
    return count


# Page-level entries that hold a derivative of the page as it was drawn: a
# raster of it (/Thumb), an authoring application's private copy of it
# (/PieceInfo, with the /LastModified that dates it), its own XMP (/Metadata,
# which can carry thumbnails and descriptions), and associated source files
# (/AF). A rewrite of the content stream leaves every one of them showing
# exactly what was removed.
_PAGE_DERIVATIVES = ("/Thumb", "/PieceInfo", "/LastModified", "/Metadata", "/AF")


def _own_resources(page: "pikepdf.Page"):
    """The page's resources as a dictionary this page alone owns.

    An inherited dictionary (on a /Pages node) and one several pages point at
    directly are both shared, and registering copies in it or pruning the
    replaced originals out of it would change every page that shares it. The
    page gets a fresh dictionary whose content-bearing categories are fresh
    too; the values themselves stay shared by reference.
    """
    source = _resolve_resources(page)
    own = pikepdf.Dictionary()
    if isinstance(source, pikepdf.Dictionary):
        for key in source.keys():
            value = source[key]
            if key in _PRUNED_CATEGORIES and isinstance(value, pikepdf.Dictionary):
                table = pikepdf.Dictionary()
                for name in value.keys():
                    table[name] = value[name]
                value = table
            own[key] = value
    page.obj["/Resources"] = own
    return own


def _redact_page(
    pdf: "pikepdf.Pdf", page: "pikepdf.Page", specs: list, font_dir: str = "", run: "_Run | None" = None
) -> dict:
    if run is None:
        run = _Run(pdf)
    resources = _own_resources(page)
    regions: list[Rect] = [spec["rect"] for spec in specs]
    name_counter = [0]
    result = _walk(
        pdf, pikepdf.parse_content_stream(page), resources, regions, IDENTITY, 0,
        name_counter, _FontCache(), run=run, struct_parents=page.obj.get("/StructParents"),
        stream_key=_objgen(page.obj),
    )

    new_bytes = pikepdf.unparse_content_stream(result.kept)
    overlay, overlay_fonts = _overlay_stream(pdf, specs, font_dir)
    page.Contents = pdf.make_stream(new_bytes + b"\n" + overlay)

    _register(resources, result)
    if overlay_fonts:
        # The overlay draws in the PAGE's content stream, so its font lives in
        # the page's own /Resources — registered BEFORE the unreferenced-
        # resource sweep below, which would otherwise drop a font nothing had
        # referenced yet.
        fonts = resources.get("/Font")
        if fonts is None:
            fonts = pikepdf.Dictionary()
            resources["/Font"] = fonts
        for nm, obj in overlay_fonts.items():
            fonts[Name(nm)] = obj

    # The replaced originals leave the dictionary BEFORE the sweep. qpdf's
    # sweep treats every form still LISTED as drawing its content, and a form
    # without /Resources draws with the page's names — so a replaced form left
    # listed kept the very image the redaction had just taken out of it.
    _prune_to_references(resources, result.kept)
    page.remove_unreferenced_resources()

    for key in _PAGE_DERIVATIVES:
        if key in page.obj:
            del page.obj[key]

    annotations_removed = _strip_annotations(page, regions, run.removed_widgets, run.removed_annotations)

    return {
        "text_runs_removed": result.text_runs_removed,
        "text_runs_split": result.text_runs_split,
        "runs_removed_whole": result.runs_removed_whole,
        "annotations_removed": annotations_removed,
    }


def redact(
    file: str, output: str, regions: list[dict], font_dir: str = "", gs_path: str = ""
) -> dict:
    """Strip content under one or more rectangular regions and black them out.

    Args:
        file: Input PDF path.
        output: Output PDF path.
        regions: List of `{"page": <1-based int>, "rect": [x0, y0, x1, y1]}`,
            rect in the page's own /MediaBox point space (i.e. the same
            coordinate system the page's content stream already uses —
            callers are responsible for accounting for /Rotate themselves).
            Each region may also carry its REDACTION PROPERTIES,
            in the format's own vocabulary: `fill` (`/IC`), `overlay_text`
            (`/OverlayText`), `repeat_overlay` (`/Repeat`), `align` (`/Q`),
            `font_size` and `text_color` (`/DA`). Omitting them all paints the
            plain black box this function has always painted, byte for byte.
        font_dir: The bundled fonts directory, for an overlay whose text is
            not Latin-1 — it EMBEDS rather than refusing or drawing '?'.
        gs_path: The user's Ghostscript, needed only to decode a JBIG2 image
            that is partly marked; discovered when not given.

    Image counts are of distinct images, however many times each is drawn:
    `images_modified` kept the image and lost only the marked pixels;
    `images_removed` went whole; `images_widened` (of the modified) lost pixels
    past the mark because their compression ties those pixels to it;
    `images_removed_for_compression` (of the removed) were only partly marked
    but a lossy JPEG 2000 codestream ties every pixel to the mark. An image
    whose encoding cannot be rewritten safely raises instead (see
    `image_redact`), before anything is written, so the input keeps its bytes.
    """
    input_path = Path(file)
    output_path = Path(output)
    same_file = is_same_file(str(input_path), str(output_path))

    by_page: dict[int, list[dict]] = {}
    for region in regions:
        page_num = int(region["page"])
        by_page.setdefault(page_num, []).append(
            {"rect": _normalize_rect(region["rect"]), "props": properties_of(region)}
        )

    stats = {
        "text_runs_removed": 0,
        "text_runs_split": 0,
        "runs_removed_whole": 0,
        "annotations_removed": 0,
    }
    pages_redacted = 0
    with pikepdf.open(file) as pdf:
        run = _Run(pdf, gs_path)
        total = len(pdf.pages)
        marked = [pdf.pages[number - 1] for number in by_page if 1 <= number <= total]
        if marked:
            run.fonts = redact_fonts.baseline(pdf, marked)
        for page_num, specs in by_page.items():
            if not (1 <= page_num <= total):
                continue
            page_stats = _redact_page(pdf, pdf.pages[page_num - 1], specs, font_dir, run)
            for key in stats:
                stats[key] += page_stats[key]
            pages_redacted += 1
        if pages_redacted:
            redact_document.finish(pdf, run)

        if same_file:
            with staged_write(output_path) as staged:
                save_pdf(pdf, str(staged))
                pdf.close()
        else:
            save_pdf(pdf, output_path)

    return {
        "output": str(output_path),
        "pages_redacted": pages_redacted,
        "regions_applied": len(regions),
        **stats,
        "images_modified": len(run.context.modified),
        "images_removed": len(run.context.removed),
        "images_widened": len(run.context.widened),
        "images_removed_for_compression": len(run.context.removed_for_codec),
        "paths_redacted": run.paths_redacted,
    }
