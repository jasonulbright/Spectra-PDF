"""SVG → PDF Form XObject compiler (P7 slice F — vector placement).

Compiles the STATIC subset of SVG that maps onto PDF graphics into a Form
XObject with BBox [0,0,1,1] (the viewBox normalized to the unit square with
the SVG y-flip baked in), so a placed vector graphic draws EXACTLY like an
image placement — the unit square under the live CTM — and the whole
transform/delete/opacity/blend/mask/crop machinery in `page_images.py`
applies to it verbatim (the P7 convergence). The form carries a private
`/SpectraVector` marker naming the source viewBox; the placement walker
treats marker-carrying forms as LEAF placements and never recurses.

Supported: svg (viewBox/width/height), g, path (full data grammar, arcs →
cubics), rect (incl. rounded), circle, ellipse, line, polyline, polygon,
transform lists, presentation attributes + inline style + simple <style>
sheets (type/.class/#id selectors only, id > class > type specificity —
anything beyond that grammar refuses the FILE, because silently skipping a
rule would mis-render), #hex/rgb()/named colors, currentColor, fill-rule,
stroke geometry (width/cap/join/miterlimit/dash), fill-opacity /
stroke-opacity (exact — one gs sets /ca+/CA), element/group `opacity`
(TRUE group semantics — the subtree compiles into its own transparency
group so overlapping fill+stroke can't double-darken), defs/use
(cycle-guarded), linear/radial gradients (userSpaceOnUse +
objectBoundingBox, gradientTransform, href templates, multi-stop via
stitching functions) emitted as clip-then-`sh` — NEVER fill patterns,
whose matrix is page-anchored and would pin the gradient to the page
while the placement moves; clip-path (path-based).

Refused, by name (`SvgUnsupported`): DOCTYPE/DTD (entity-expansion class),
text/tspan/textPath (a placement pipeline has no shaping/font arm — convert
text to paths in the editor), image, filter, mask, pattern paints,
foreignObject, switch, symbol, marker references, gradient STROKES (needs
path outlining), stop-opacity ≠ 1 (PDF shadings carry no per-stop alpha),
non-px units, and un-analyzable CSS. Animation/script elements are ignored
(static snapshot = the initial state).
"""

import math
import re
import xml.etree.ElementTree as ET

import pikepdf
from pikepdf import Dictionary, Name


class SvgUnsupported(ValueError):
    """A stated refusal — the file uses SVG outside the supported subset."""


SVG_NS = "{http://www.w3.org/2000/svg}"
XLINK_NS = "{http://www.w3.org/1999/xlink}"

# Elements that are static no-ops (animation/metadata/scripting): the initial
# state IS the static snapshot, so they drop silently rather than refusing.
IGNORED = {
    "animate", "animateMotion", "animateTransform", "set", "mpath",
    "metadata", "title", "desc", "script", "view", "cursor",
}
REFUSED = {
    "text", "tspan", "textPath", "image", "filter", "mask", "pattern",
    "foreignObject", "switch", "symbol", "marker", "feGaussianBlur",
}

_INHERITED = (
    "fill", "stroke", "stroke-width", "stroke-linecap", "stroke-linejoin",
    "stroke-miterlimit", "stroke-dasharray", "fill-rule", "color",
    "fill-opacity", "stroke-opacity",
    # `visibility` INHERITS (a child can re-show inside a hidden group) —
    # unlike display, which removes the subtree outright.
    "visibility",
)

_DEFAULT_STYLE = {
    "fill": "black",
    "stroke": "none",
    "stroke-width": "1",
    "stroke-linecap": "butt",
    "stroke-linejoin": "miter",
    "stroke-miterlimit": "4",
    "stroke-dasharray": "none",
    "fill-rule": "nonzero",
    "color": "black",
    "fill-opacity": "1",
    "stroke-opacity": "1",
}

# CSS basic + extended color keywords (the SVG 1.1 recognized set, subset of
# CSS named colors that covers real exports; missing names refuse loudly).
NAMED_COLORS = {
    "black": (0, 0, 0), "silver": (192, 192, 192), "gray": (128, 128, 128),
    "grey": (128, 128, 128), "white": (255, 255, 255), "maroon": (128, 0, 0),
    "red": (255, 0, 0), "purple": (128, 0, 128), "fuchsia": (255, 0, 255),
    "green": (0, 128, 0), "lime": (0, 255, 0), "olive": (128, 128, 0),
    "yellow": (255, 255, 0), "navy": (0, 0, 128), "blue": (0, 0, 255),
    "teal": (0, 128, 128), "aqua": (0, 255, 255), "orange": (255, 165, 0),
    "aliceblue": (240, 248, 255), "antiquewhite": (250, 235, 215),
    "aquamarine": (127, 255, 212), "azure": (240, 255, 255),
    "beige": (245, 245, 220), "bisque": (255, 228, 196),
    "blanchedalmond": (255, 235, 205), "blueviolet": (138, 43, 226),
    "brown": (165, 42, 42), "burlywood": (222, 184, 135),
    "cadetblue": (95, 158, 160), "chartreuse": (127, 255, 0),
    "chocolate": (210, 105, 30), "coral": (255, 127, 80),
    "cornflowerblue": (100, 149, 237), "cornsilk": (255, 248, 220),
    "crimson": (220, 20, 60), "cyan": (0, 255, 255),
    "darkblue": (0, 0, 139), "darkcyan": (0, 139, 139),
    "darkgoldenrod": (184, 134, 11), "darkgray": (169, 169, 169),
    "darkgrey": (169, 169, 169), "darkgreen": (0, 100, 0),
    "darkkhaki": (189, 183, 107), "darkmagenta": (139, 0, 139),
    "darkolivegreen": (85, 107, 47), "darkorange": (255, 140, 0),
    "darkorchid": (153, 50, 204), "darkred": (139, 0, 0),
    "darksalmon": (233, 150, 122), "darkseagreen": (143, 188, 143),
    "darkslateblue": (72, 61, 139), "darkslategray": (47, 79, 79),
    "darkslategrey": (47, 79, 79), "darkturquoise": (0, 206, 209),
    "darkviolet": (148, 0, 211), "deeppink": (255, 20, 147),
    "deepskyblue": (0, 191, 255), "dimgray": (105, 105, 105),
    "dimgrey": (105, 105, 105), "dodgerblue": (30, 144, 255),
    "firebrick": (178, 34, 34), "floralwhite": (255, 250, 240),
    "forestgreen": (34, 139, 34), "gainsboro": (220, 220, 220),
    "ghostwhite": (248, 248, 255), "gold": (255, 215, 0),
    "goldenrod": (218, 165, 32), "greenyellow": (173, 255, 47),
    "honeydew": (240, 255, 240), "hotpink": (255, 105, 180),
    "indianred": (205, 92, 92), "indigo": (75, 0, 130),
    "ivory": (255, 255, 240), "khaki": (240, 230, 140),
    "lavender": (230, 230, 250), "lavenderblush": (255, 240, 245),
    "lawngreen": (124, 252, 0), "lemonchiffon": (255, 250, 205),
    "lightblue": (173, 216, 230), "lightcoral": (240, 128, 128),
    "lightcyan": (224, 255, 255), "lightgoldenrodyellow": (250, 250, 210),
    "lightgray": (211, 211, 211), "lightgrey": (211, 211, 211),
    "lightgreen": (144, 238, 144), "lightpink": (255, 182, 193),
    "lightsalmon": (255, 160, 122), "lightseagreen": (32, 178, 170),
    "lightskyblue": (135, 206, 250), "lightslategray": (119, 136, 153),
    "lightslategrey": (119, 136, 153), "lightsteelblue": (176, 196, 222),
    "lightyellow": (255, 255, 224), "limegreen": (50, 205, 50),
    "linen": (250, 240, 230), "magenta": (255, 0, 255),
    "mediumaquamarine": (102, 205, 170), "mediumblue": (0, 0, 205),
    "mediumorchid": (186, 85, 211), "mediumpurple": (147, 112, 219),
    "mediumseagreen": (60, 179, 113), "mediumslateblue": (123, 104, 238),
    "mediumspringgreen": (0, 250, 154), "mediumturquoise": (72, 209, 204),
    "mediumvioletred": (199, 21, 133), "midnightblue": (25, 25, 112),
    "mintcream": (245, 255, 250), "mistyrose": (255, 228, 225),
    "moccasin": (255, 228, 181), "navajowhite": (255, 222, 173),
    "oldlace": (253, 245, 230), "olivedrab": (107, 142, 35),
    "orangered": (255, 69, 0), "orchid": (218, 112, 214),
    "palegoldenrod": (238, 232, 170), "palegreen": (152, 251, 152),
    "paleturquoise": (175, 238, 238), "palevioletred": (219, 112, 147),
    "papayawhip": (255, 239, 213), "peachpuff": (255, 218, 185),
    "peru": (205, 133, 63), "pink": (255, 192, 203),
    "plum": (221, 160, 221), "powderblue": (176, 224, 230),
    "rebeccapurple": (102, 51, 153), "rosybrown": (188, 143, 143),
    "royalblue": (65, 105, 225), "saddlebrown": (139, 69, 19),
    "salmon": (250, 128, 114), "sandybrown": (244, 164, 96),
    "seagreen": (46, 139, 87), "seashell": (255, 245, 238),
    "sienna": (160, 82, 45), "skyblue": (135, 206, 235),
    "slateblue": (106, 90, 205), "slategray": (112, 128, 144),
    "slategrey": (112, 128, 144), "snow": (255, 250, 250),
    "springgreen": (0, 255, 127), "steelblue": (70, 130, 180),
    "tan": (210, 180, 140), "thistle": (216, 191, 216),
    "tomato": (255, 99, 71), "turquoise": (64, 224, 208),
    "violet": (238, 130, 238), "wheat": (245, 222, 179),
    "whitesmoke": (245, 245, 245), "yellowgreen": (154, 205, 50),
}

_NUM = r"[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?"
_NUM_RE = re.compile(_NUM)
_UNIT_RE = re.compile(rf"^\s*({_NUM})\s*(px)?\s*$")


def _local(tag: str) -> str:
    """Element name without the SVG namespace."""
    return tag[len(SVG_NS):] if tag.startswith(SVG_NS) else tag


def _floats(text: str) -> list[float]:
    return [float(m) for m in _NUM_RE.findall(text or "")]


def _length(value: str, what: str) -> float:
    """A px-or-unitless length. Any other unit refuses — SVG physical units
    depend on rendering DPI and honest conversion needs layout context."""
    m = _UNIT_RE.match(value)
    if not m:
        raise SvgUnsupported(
            f"unsupported length {value!r} for {what} (only px / unitless numbers)"
        )
    return float(m.group(1))


# ── matrices (row-vector, the engine convention: point·M, matMul(a,b)=a then b) ──


def _mat_mult(m1, m2):
    a1, b1, c1, d1, e1, f1 = m1
    a2, b2, c2, d2, e2, f2 = m2
    return (
        a1 * a2 + b1 * c2,
        a1 * b2 + b1 * d2,
        c1 * a2 + d1 * c2,
        c1 * b2 + d1 * d2,
        e1 * a2 + f1 * c2 + e2,
        e1 * b2 + f1 * d2 + f2,
    )


def _apply(m, x, y):
    return (m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5])


_TRANSFORM_RE = re.compile(r"(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)")


def parse_transform(text: str):
    """An SVG transform LIST → one affine matrix. SVG applies the list left
    to right to the element's user space, i.e. the leftmost entry is the
    OUTERMOST — with row-vector composition that means folding each entry as
    `total = entry · total` walked right-to-left, or equivalently left-fold
    `total = matMul(next, total)`."""
    total = (1.0, 0.0, 0.0, 1.0, 0.0, 0.0)
    matched_len = 0
    for m in _TRANSFORM_RE.finditer(text or ""):
        matched_len += len(m.group(0))
        kind = m.group(1)
        args = _floats(m.group(2))
        if kind == "matrix" and len(args) == 6:
            entry = tuple(args)
        elif kind == "translate" and len(args) in (1, 2):
            tx, ty = args[0], args[1] if len(args) == 2 else 0.0
            entry = (1, 0, 0, 1, tx, ty)
        elif kind == "scale" and len(args) in (1, 2):
            sx, sy = args[0], args[1] if len(args) == 2 else args[0]
            entry = (sx, 0, 0, sy, 0, 0)
        elif kind == "rotate" and len(args) in (1, 3):
            a = math.radians(args[0])
            cos, sin = math.cos(a), math.sin(a)
            entry = (cos, sin, -sin, cos, 0, 0)
            if len(args) == 3:
                cx, cy = args[1], args[2]
                entry = _mat_mult(
                    _mat_mult((1, 0, 0, 1, -cx, -cy), entry), (1, 0, 0, 1, cx, cy)
                )
        elif kind == "skewX" and len(args) == 1:
            entry = (1, 0, math.tan(math.radians(args[0])), 1, 0, 0)
        elif kind == "skewY" and len(args) == 1:
            entry = (1, math.tan(math.radians(args[0])), 0, 1, 0, 0)
        else:
            raise SvgUnsupported(f"malformed transform entry {m.group(0)!r}")
        # entry is APPLIED FIRST relative to what's already folded.
        total = _mat_mult(entry, total)
    stripped = re.sub(r"[\s,]", "", text or "")
    consumed = re.sub(r"[\s,]", "", "".join(
        mm.group(0) for mm in _TRANSFORM_RE.finditer(text or "")
    ))
    if stripped != consumed:
        raise SvgUnsupported(f"unparseable transform {text!r}")
    return total


# ── colors ────────────────────────────────────────────────────────────────


def parse_color(value: str, current_color=(0.0, 0.0, 0.0)):
    """A paint COLOR → (r,g,b) 0..1. Gradients/None are handled by the
    caller (this only sees real colors and currentColor)."""
    v = (value or "").strip()
    low = v.lower()
    if low == "currentcolor":
        return current_color
    if low in NAMED_COLORS:
        r, g, b = NAMED_COLORS[low]
        return (r / 255.0, g / 255.0, b / 255.0)
    m = re.match(r"^#([0-9a-fA-F]{3})$", v)
    if m:
        h = m.group(1)
        return tuple(int(ch * 2, 16) / 255.0 for ch in h)
    m = re.match(r"^#([0-9a-fA-F]{6})$", v)
    if m:
        h = m.group(1)
        return tuple(int(h[i : i + 2], 16) / 255.0 for i in (0, 2, 4))
    m = re.match(r"^rgba?\(([^)]*)\)$", low)
    if m:
        parts = [p.strip() for p in m.group(1).split(",")]
        if len(parts) in (3, 4):
            def channel(p):
                if p.endswith("%"):
                    return max(0.0, min(1.0, float(p[:-1]) / 100.0))
                return max(0.0, min(1.0, float(p) / 255.0))
            try:
                rgb = tuple(channel(p) for p in parts[:3])
                # rgba alpha is ignored HERE — fill/stroke-opacity carry
                # alpha; an rgba() alpha channel folds into them upstream.
                return rgb
            except ValueError:
                pass
    raise SvgUnsupported(f"unsupported color {value!r}")


def _rgba_alpha(value: str) -> float:
    m = re.match(r"^rgba\(([^)]*)\)$", (value or "").strip().lower())
    if not m:
        return 1.0
    parts = [p.strip() for p in m.group(1).split(",")]
    if len(parts) == 4:
        try:
            return max(0.0, min(1.0, float(parts[3])))
        except ValueError:
            return 1.0
    return 1.0


# ── CSS (the simple grammar) ──────────────────────────────────────────────

_DECL_RE = re.compile(r"([-a-zA-Z]+)\s*:\s*([^;]+)")
_SIMPLE_SEL_RE = re.compile(r"^\s*([.#]?)([-_a-zA-Z][-_a-zA-Z0-9]*)\s*$")


def parse_css(text: str):
    """`<style>` sheets, simple grammar ONLY: `sel[, sel…] { decls }` where
    each sel is a bare type, .class or #id. Anything else refuses the file —
    a rule we can't evaluate is a rule we'd silently drop, and that
    mis-renders (the fail-closed rule)."""
    rules = []
    body = re.sub(r"/\*.*?\*/", "", text or "", flags=re.S)
    pos = 0
    while True:
        brace = body.find("{", pos)
        if brace == -1:
            if body[pos:].strip():
                raise SvgUnsupported("un-analyzable CSS in <style> (trailing content)")
            break
        close = body.find("}", brace)
        if close == -1:
            raise SvgUnsupported("un-analyzable CSS in <style> (unclosed rule)")
        sel_text = body[pos:brace]
        if "@" in sel_text:
            raise SvgUnsupported("un-analyzable CSS in <style> (at-rules)")
        decls = dict(
            (k.strip().lower(), v.strip())
            for k, v in _DECL_RE.findall(body[brace + 1 : close])
        )
        for sel in sel_text.split(","):
            m = _SIMPLE_SEL_RE.match(sel)
            if not m:
                raise SvgUnsupported(f"un-analyzable CSS selector {sel.strip()!r}")
            marker, name = m.groups()
            # id > class > type — encoded as a numeric specificity.
            spec = {"#": 2, ".": 1, "": 0}[marker]
            rules.append((spec, marker, name, decls))
        pos = close + 1
    return rules


def _css_matches(rules, elem):
    """Matching declarations for one element, lowest specificity first (the
    caller overlays in order, so higher specificity wins)."""
    tag = _local(elem.tag)
    el_id = elem.get("id") or ""
    classes = set((elem.get("class") or "").split())
    out = []
    for spec, marker, name, decls in sorted(rules, key=lambda r: r[0]):
        if marker == "" and name == tag:
            out.append(decls)
        elif marker == "." and name in classes:
            out.append(decls)
        elif marker == "#" and name == el_id:
            out.append(decls)
    return out


# ── path data ─────────────────────────────────────────────────────────────


def _arc_to_cubics(x1, y1, rx, ry, phi_deg, large, sweep, x2, y2):
    """SVG endpoint arc → cubic segments (§B.2.4 endpoint→center), split at
    ≤90° per segment. Returns [(c1x,c1y,c2x,c2y,x,y), …]."""
    if rx == 0 or ry == 0 or (x1 == x2 and y1 == y2):
        return []
    rx, ry = abs(rx), abs(ry)
    phi = math.radians(phi_deg % 360)
    cosp, sinp = math.cos(phi), math.sin(phi)
    dx2, dy2 = (x1 - x2) / 2.0, (y1 - y2) / 2.0
    x1p = cosp * dx2 + sinp * dy2
    y1p = -sinp * dx2 + cosp * dy2
    lam = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry)
    if lam > 1:
        s = math.sqrt(lam)
        rx *= s
        ry *= s
    num = rx * rx * ry * ry - rx * rx * y1p * y1p - ry * ry * x1p * x1p
    den = rx * rx * y1p * y1p + ry * ry * x1p * x1p
    co = math.sqrt(max(0.0, num / den)) if den else 0.0
    if large == sweep:
        co = -co
    cxp = co * rx * y1p / ry
    cyp = -co * ry * x1p / rx
    cx = cosp * cxp - sinp * cyp + (x1 + x2) / 2.0
    cy = sinp * cxp + cosp * cyp + (y1 + y2) / 2.0

    def angle(ux, uy, vx, vy):
        dot = ux * vx + uy * vy
        length = math.hypot(ux, uy) * math.hypot(vx, vy)
        ang = math.acos(max(-1.0, min(1.0, dot / length)))
        if ux * vy - uy * vx < 0:
            ang = -ang
        return ang

    theta1 = angle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry)
    dtheta = angle(
        (x1p - cxp) / rx, (y1p - cyp) / ry, (-x1p - cxp) / rx, (-y1p - cyp) / ry
    )
    if not sweep and dtheta > 0:
        dtheta -= 2 * math.pi
    elif sweep and dtheta < 0:
        dtheta += 2 * math.pi

    segs = max(1, int(math.ceil(abs(dtheta) / (math.pi / 2))))
    delta = dtheta / segs
    t = (4.0 / 3.0) * math.tan(delta / 4.0)
    out = []
    th = theta1
    for _ in range(segs):
        cos1, sin1 = math.cos(th), math.sin(th)
        th2 = th + delta
        cos2, sin2 = math.cos(th2), math.sin(th2)

        def to_user(cx0, cy0):
            return (
                cosp * rx * cx0 - sinp * ry * cy0 + cx,
                sinp * rx * cx0 + cosp * ry * cy0 + cy,
            )

        p1 = to_user(cos1, sin1)
        p2 = to_user(cos2, sin2)
        d1 = (
            -rx * sin1 * cosp - ry * cos1 * sinp,
            -rx * sin1 * sinp + ry * cos1 * cosp,
        )
        d2 = (
            -rx * sin2 * cosp - ry * cos2 * sinp,
            -rx * sin2 * sinp + ry * cos2 * cosp,
        )
        out.append(
            (
                p1[0] + t * d1[0],
                p1[1] + t * d1[1],
                p2[0] - t * d2[0],
                p2[1] - t * d2[1],
                p2[0],
                p2[1],
            )
        )
        th = th2
    return out


_PATH_TOKEN_RE = re.compile(rf"([MmLlHhVvCcSsQqTtAaZz])|({_NUM})")


def parse_path(d: str):
    """SVG path data → segments [('M',x,y) | ('L',x,y) | ('C',c1x,c1y,c2x,
    c2y,x,y) | ('Z',)] — quadratics elevated to cubics, arcs converted,
    relative commands resolved. Refuses malformed data."""
    tokens = []
    for m in _PATH_TOKEN_RE.finditer(d or ""):
        tokens.append(m.group(1) or float(m.group(2)))
    leftover = re.sub(_PATH_TOKEN_RE, "", d or "")
    if re.sub(r"[\s,]", "", leftover):
        raise SvgUnsupported(f"unparseable path data near {leftover.strip()[:20]!r}")
    segs = []
    i = 0
    cx = cy = 0.0  # current point
    sx = sy = 0.0  # subpath start
    last_cmd = None
    last_ctrl = None  # reflection point for S/T

    def need(n):
        nonlocal i
        if i + n > len(tokens) or any(isinstance(tokens[i + k], str) for k in range(n)):
            raise SvgUnsupported("malformed path data (missing numbers)")
        vals = tokens[i : i + n]
        i += n
        return vals

    while i < len(tokens):
        tok = tokens[i]
        if isinstance(tok, str):
            cmd = tok
            i += 1
        elif last_cmd is None:
            raise SvgUnsupported("path data must start with a moveto")
        else:
            # Implicit repeat: M/m repeats as L/l per spec.
            cmd = {"M": "L", "m": "l"}.get(last_cmd, last_cmd)
        rel = cmd.islower()
        c = cmd.upper()
        if c == "M":
            x, y = need(2)
            if rel:
                x += cx
                y += cy
            segs.append(("M", x, y))
            cx, cy, sx, sy = x, y, x, y
            last_ctrl = None
        elif c == "L":
            x, y = need(2)
            if rel:
                x += cx
                y += cy
            segs.append(("L", x, y))
            cx, cy = x, y
            last_ctrl = None
        elif c == "H":
            (x,) = need(1)
            if rel:
                x += cx
            segs.append(("L", x, cy))
            cx = x
            last_ctrl = None
        elif c == "V":
            (y,) = need(1)
            if rel:
                y += cy
            segs.append(("L", cx, y))
            cy = y
            last_ctrl = None
        elif c == "C":
            x1, y1, x2, y2, x, y = need(6)
            if rel:
                x1 += cx; y1 += cy; x2 += cx; y2 += cy; x += cx; y += cy
            segs.append(("C", x1, y1, x2, y2, x, y))
            last_ctrl = (x2, y2)
            cx, cy = x, y
        elif c == "S":
            x2, y2, x, y = need(4)
            if rel:
                x2 += cx; y2 += cy; x += cx; y += cy
            if last_cmd and last_cmd.upper() in ("C", "S") and last_ctrl:
                x1, y1 = 2 * cx - last_ctrl[0], 2 * cy - last_ctrl[1]
            else:
                x1, y1 = cx, cy
            segs.append(("C", x1, y1, x2, y2, x, y))
            last_ctrl = (x2, y2)
            cx, cy = x, y
        elif c == "Q":
            qx, qy, x, y = need(4)
            if rel:
                qx += cx; qy += cy; x += cx; y += cy
            segs.append(_quad_to_cubic(cx, cy, qx, qy, x, y))
            last_ctrl = (qx, qy)
            cx, cy = x, y
        elif c == "T":
            x, y = need(2)
            if rel:
                x += cx
                y += cy
            if last_cmd and last_cmd.upper() in ("Q", "T") and last_ctrl:
                qx, qy = 2 * cx - last_ctrl[0], 2 * cy - last_ctrl[1]
            else:
                qx, qy = cx, cy
            segs.append(_quad_to_cubic(cx, cy, qx, qy, x, y))
            last_ctrl = (qx, qy)
            cx, cy = x, y
        elif c == "A":
            rx, ry, rot, large, sweep, x, y = need(7)
            if rel:
                x += cx
                y += cy
            for cub in _arc_to_cubics(cx, cy, rx, ry, rot, bool(large), bool(sweep), x, y):
                segs.append(("C",) + cub)
            if not _arc_to_cubics(cx, cy, rx, ry, rot, bool(large), bool(sweep), x, y):
                segs.append(("L", x, y))  # degenerate arc = line per spec
            cx, cy = x, y
            last_ctrl = None
        elif c == "Z":
            segs.append(("Z",))
            cx, cy = sx, sy
            last_ctrl = None
        else:
            raise SvgUnsupported(f"unsupported path command {cmd!r}")
        last_cmd = cmd
    return segs


def _quad_to_cubic(x0, y0, qx, qy, x, y):
    return (
        "C",
        x0 + 2.0 / 3.0 * (qx - x0),
        y0 + 2.0 / 3.0 * (qy - y0),
        x + 2.0 / 3.0 * (qx - x),
        y + 2.0 / 3.0 * (qy - y),
        x,
        y,
    )


def path_bbox(segs):
    """The TIGHT bbox of parsed segments — cubic extrema included (an
    objectBoundingBox gradient mapped to a control-point bbox would land the
    fade visibly off)."""
    xs: list[float] = []
    ys: list[float] = []
    cx = cy = 0.0
    for seg in segs:
        if seg[0] == "M" or seg[0] == "L":
            xs.append(seg[1])
            ys.append(seg[2])
            cx, cy = seg[1], seg[2]
        elif seg[0] == "C":
            x1, y1, x2, y2, x3, y3 = seg[1:]
            for p0, p1, p2, p3, acc in ((cx, x1, x2, x3, xs), (cy, y1, y2, y3, ys)):
                acc.append(p3)
                # dB/dt = 0: at² + bt + c with the standard cubic coefficients.
                a = -p0 + 3 * p1 - 3 * p2 + p3
                b = 2 * (p0 - 2 * p1 + p2)
                cc = p1 - p0
                roots = []
                if abs(a) < 1e-12:
                    if abs(b) > 1e-12:
                        roots = [-cc / b]
                else:
                    disc = b * b - 4 * a * cc
                    if disc >= 0:
                        sq = math.sqrt(disc)
                        roots = [(-b + sq) / (2 * a), (-b - sq) / (2 * a)]
                for t in roots:
                    if 0 < t < 1:
                        mt = 1 - t
                        acc.append(
                            mt * mt * mt * p0
                            + 3 * mt * mt * t * p1
                            + 3 * mt * t * t * p2
                            + t * t * t * p3
                        )
            xs.append(cx)
            ys.append(cy)
            cx, cy = x3, y3
    if not xs:
        return None
    return (min(xs), min(ys), max(xs), max(ys))


# ── shape → path ──────────────────────────────────────────────────────────

_KAPPA = 4.0 * (math.sqrt(2) - 1) / 3.0


def _ellipse_segs(cx, cy, rx, ry):
    k = _KAPPA
    return [
        ("M", cx + rx, cy),
        ("C", cx + rx, cy + k * ry, cx + k * rx, cy + ry, cx, cy + ry),
        ("C", cx - k * rx, cy + ry, cx - rx, cy + k * ry, cx - rx, cy),
        ("C", cx - rx, cy - k * ry, cx - k * rx, cy - ry, cx, cy - ry),
        ("C", cx + k * rx, cy - ry, cx + rx, cy - k * ry, cx + rx, cy),
        ("Z",),
    ]


def shape_to_segs(elem):
    """rect/circle/ellipse/line/polyline/polygon → path segments, or None
    when the element isn't a shape."""
    tag = _local(elem.tag)
    g = lambda name, default="0": elem.get(name, default)  # noqa: E731
    if tag == "rect":
        x = _length(g("x"), "rect x")
        y = _length(g("y"), "rect y")
        w = _length(g("width"), "rect width")
        h = _length(g("height"), "rect height")
        if w <= 0 or h <= 0:
            return []
        rx_attr, ry_attr = elem.get("rx"), elem.get("ry")
        rx = _length(rx_attr, "rect rx") if rx_attr is not None else None
        ry = _length(ry_attr, "rect ry") if ry_attr is not None else None
        if rx is None and ry is None:
            return [("M", x, y), ("L", x + w, y), ("L", x + w, y + h), ("L", x, y + h), ("Z",)]
        rx = rx if rx is not None else ry
        ry = ry if ry is not None else rx
        rx = min(rx, w / 2)
        ry = min(ry, h / 2)
        k = _KAPPA
        return [
            ("M", x + rx, y),
            ("L", x + w - rx, y),
            ("C", x + w - rx + k * rx, y, x + w, y + ry - k * ry, x + w, y + ry),
            ("L", x + w, y + h - ry),
            ("C", x + w, y + h - ry + k * ry, x + w - rx + k * rx, y + h, x + w - rx, y + h),
            ("L", x + rx, y + h),
            ("C", x + rx - k * rx, y + h, x, y + h - ry + k * ry, x, y + h - ry),
            ("L", x, y + ry),
            ("C", x, y + ry - k * ry, x + rx - k * rx, y, x + rx, y),
            ("Z",),
        ]
    if tag == "circle":
        r = _length(g("r"), "circle r")
        if r <= 0:
            return []
        return _ellipse_segs(_length(g("cx"), "cx"), _length(g("cy"), "cy"), r, r)
    if tag == "ellipse":
        rx = _length(g("rx"), "rx")
        ry = _length(g("ry"), "ry")
        if rx <= 0 or ry <= 0:
            return []
        return _ellipse_segs(_length(g("cx"), "cx"), _length(g("cy"), "cy"), rx, ry)
    if tag == "line":
        return [
            ("M", _length(g("x1"), "x1"), _length(g("y1"), "y1")),
            ("L", _length(g("x2"), "x2"), _length(g("y2"), "y2")),
        ]
    if tag in ("polyline", "polygon"):
        pts = _floats(elem.get("points", ""))
        if len(pts) < 4 or len(pts) % 2:
            return []
        segs = [("M", pts[0], pts[1])]
        for j in range(2, len(pts), 2):
            segs.append(("L", pts[j], pts[j + 1]))
        if tag == "polygon":
            segs.append(("Z",))
        return segs
    if tag == "path":
        return parse_path(elem.get("d", ""))
    return None


# ── compilation ───────────────────────────────────────────────────────────


def _op(operands, name):
    return pikepdf.ContentStreamInstruction(operands, pikepdf.Operator(name))


def _r(v: float):
    return round(float(v), 6)


def _emit_segs(out, segs):
    for seg in segs:
        if seg[0] == "M":
            out.append(_op([_r(seg[1]), _r(seg[2])], "m"))
        elif seg[0] == "L":
            out.append(_op([_r(seg[1]), _r(seg[2])], "l"))
        elif seg[0] == "C":
            out.append(_op([_r(v) for v in seg[1:]], "c"))
        else:
            out.append(_op([], "h"))


class _Compiler:
    """One compile pass. Instructions accumulate per-stream; resources
    (ExtGState / Shading / XObject for opacity groups) accumulate on the
    stream being built — nested transparency groups carry their own."""

    def __init__(self, pdf, root):
        self.pdf = pdf
        self.root = root
        self.css = []
        self.ids = {}
        self.counter = 0
        self.use_stack: list[str] = []
        for elem in root.iter():
            el_id = elem.get("id")
            if el_id and el_id not in self.ids:
                self.ids[el_id] = elem
            if _local(elem.tag) == "style":
                self.css.extend(parse_css("".join(elem.itertext())))

    def fresh(self, prefix: str) -> str:
        self.counter += 1
        return f"{prefix}{self.counter}"

    # — style resolution —

    # Non-inherited properties still read from attributes/CSS/inline style —
    # they apply to THIS element only and are popped before cascading down.
    _PER_ELEMENT = (
        "opacity", "clip-path", "display", "filter", "mask",
        "marker-start", "marker-mid", "marker-end", "marker",
    )

    def computed_style(self, elem, inherited):
        style = dict(inherited)
        for key in self._PER_ELEMENT + ("transform",):
            style.pop(key, None)  # non-inherited entries never cascade
        # Presentation attributes (lowest priority).
        for key in _INHERITED + self._PER_ELEMENT:
            v = elem.get(key)
            if v is not None:
                style[key] = v
        # CSS rules by specificity, then inline style (highest).
        for decls in _css_matches(self.css, elem):
            for k, v in decls.items():
                style[k] = v
        for k, v in _DECL_RE.findall(elem.get("style") or ""):
            style[k.strip().lower()] = v.strip()
        for key in ("marker-start", "marker-mid", "marker-end", "marker"):
            if style.get(key, "none") not in ("none",):
                raise SvgUnsupported("marker references are not supported")
        if style.get("filter", "none").strip() != "none":
            raise SvgUnsupported("filter effects are not supported")
        if style.get("mask", "none").strip() != "none":
            raise SvgUnsupported("mask references are not supported")
        if style.get("display", "").strip() == "none":
            # display:none removes the SUBTREE (checked by compile_element).
            style["__display_none__"] = "1"
        return style

    # — gradients —

    def _gradient_elem(self, ref: str):
        m = re.match(r"^url\(\s*['\"]?#([^'\")]+)['\"]?\s*\)$", (ref or "").strip())
        if not m:
            return None
        target = self.ids.get(m.group(1))
        if target is None:
            raise SvgUnsupported(f"paint reference {ref!r} resolves to nothing")
        return target

    def _gradient_chain(self, elem, seen=None):
        """The element + its href template ancestry (nearest first)."""
        seen = seen or set()
        chain = [elem]
        href = elem.get("href") or elem.get(f"{XLINK_NS}href")
        while href:
            if not href.startswith("#") or href[1:] in seen:
                break
            seen.add(href[1:])
            parent = self.ids.get(href[1:])
            if parent is None:
                break
            chain.append(parent)
            href = parent.get("href") or parent.get(f"{XLINK_NS}href")
        return chain

    def _gradient_attr(self, chain, name, default=None):
        for e in chain:
            v = e.get(name)
            if v is not None:
                return v
        return default

    def _gradient_stops(self, chain, current_color):
        stops = []
        for e in chain:
            found = [c for c in e if _local(c.tag) == "stop"]
            if found:
                for s in found:
                    offset_raw = (s.get("offset") or "0").strip()
                    offset = (
                        float(offset_raw[:-1]) / 100.0
                        if offset_raw.endswith("%")
                        else float(offset_raw)
                    )
                    style = dict(
                        (k.strip().lower(), v.strip())
                        for k, v in _DECL_RE.findall(s.get("style") or "")
                    )
                    color_raw = style.get("stop-color", s.get("stop-color", "black"))
                    op_raw = style.get("stop-opacity", s.get("stop-opacity", "1"))
                    alpha = float(op_raw) * _rgba_alpha(color_raw)
                    if alpha < 0.999:
                        raise SvgUnsupported(
                            "gradient stop-opacity is not supported (PDF shadings have no per-stop alpha)"
                        )
                    stops.append((max(0.0, min(1.0, offset)), parse_color(color_raw, current_color)))
                break
        if len(stops) < 2:
            raise SvgUnsupported("gradient needs at least two stops")
        stops.sort(key=lambda s: s[0])
        return stops

    def _stops_function(self, stops):
        def exp_fn(c0, c1):
            return Dictionary(
                FunctionType=2,
                Domain=pikepdf.Array([0, 1]),
                C0=pikepdf.Array([_r(v) for v in c0]),
                C1=pikepdf.Array([_r(v) for v in c1]),
                N=1,
            )

        # Pad implicit 0/1 endpoints per the SVG stop rules.
        if stops[0][0] > 0:
            stops = [(0.0, stops[0][1])] + stops
        if stops[-1][0] < 1:
            stops = stops + [(1.0, stops[-1][1])]
        if len(stops) == 2:
            return exp_fn(stops[0][1], stops[1][1])
        fns = []
        bounds = []
        encode = []
        for (o0, c0), (o1, c1) in zip(stops, stops[1:]):
            fns.append(exp_fn(c0, c1))
            encode.extend([0, 1])
        for o, _c in stops[1:-1]:
            bounds.append(_r(o))
        return Dictionary(
            FunctionType=3,
            Domain=pikepdf.Array([0, 1]),
            Functions=pikepdf.Array(fns),
            Bounds=pikepdf.Array(bounds),
            Encode=pikepdf.Array(encode),
        )

    def _gradient_coord(self, chain, name, default, axis_for_percent):
        raw = self._gradient_attr(chain, name, default)
        raw = str(raw).strip()
        if raw.endswith("%"):
            return float(raw[:-1]) / 100.0 * axis_for_percent
        return _length(raw, f"gradient {name}")

    def emit_gradient_fill(self, out, resources, grad, segs, bbox, style, fill_rule):
        """Fill `segs` with a gradient: clip to the path, transform into
        gradient space, `sh`. Placement-relative by construction (`sh`
        paints in CURRENT user space; a fill pattern's matrix would be
        page-anchored and pin the gradient to the page)."""
        chain = self._gradient_chain(grad)
        kind = _local(grad.tag)
        units = self._gradient_attr(chain, "gradientUnits", "objectBoundingBox")
        if units not in ("objectBoundingBox", "userSpaceOnUse"):
            raise SvgUnsupported(f"gradientUnits {units!r} is not supported")
        current_color = parse_color(style.get("color", "black"))
        stops = self._gradient_stops(chain, current_color)
        func = self._stops_function(stops)
        ob = units == "objectBoundingBox"
        axis_x = 1.0 if ob else 0.0  # percent basis; userSpace % refuses below
        if not ob:
            def pct_refuser(v):
                if str(v).strip().endswith("%"):
                    raise SvgUnsupported("percent gradient coords need objectBoundingBox")
            for nm in ("x1", "y1", "x2", "y2", "cx", "cy", "r", "fx", "fy"):
                v = self._gradient_attr(chain, nm)
                if v is not None:
                    pct_refuser(v)
        if kind == "linearGradient":
            x1 = self._gradient_coord(chain, "x1", "0%", axis_x)
            y1 = self._gradient_coord(chain, "y1", "0%", axis_x)
            x2 = self._gradient_coord(chain, "x2", "100%", axis_x)
            y2 = self._gradient_coord(chain, "y2", "0%", axis_x)
            shading = Dictionary(
                ShadingType=2,
                ColorSpace=Name("/DeviceRGB"),
                Coords=pikepdf.Array([_r(x1), _r(y1), _r(x2), _r(y2)]),
                Function=func,
                Extend=pikepdf.Array([True, True]),
            )
        else:
            cx = self._gradient_coord(chain, "cx", "50%", axis_x)
            cy = self._gradient_coord(chain, "cy", "50%", axis_x)
            r = self._gradient_coord(chain, "r", "50%", axis_x)
            fx_raw = self._gradient_attr(chain, "fx")
            fy_raw = self._gradient_attr(chain, "fy")
            fx = self._gradient_coord(chain, "fx", fx_raw, axis_x) if fx_raw is not None else cx
            fy = self._gradient_coord(chain, "fy", fy_raw, axis_x) if fy_raw is not None else cy
            shading = Dictionary(
                ShadingType=3,
                ColorSpace=Name("/DeviceRGB"),
                Coords=pikepdf.Array([_r(fx), _r(fy), 0, _r(cx), _r(cy), _r(r)]),
                Function=func,
                Extend=pikepdf.Array([True, True]),
            )
        sh_name = self.fresh("Sh")
        resources.setdefault("Shading", {})[sh_name] = shading
        gt = self._gradient_attr(chain, "gradientTransform")
        out.append(_op([], "q"))
        _emit_segs(out, segs)
        out.append(_op([], "W" if fill_rule == "nonzero" else "W*"))
        out.append(_op([], "n"))
        # Gradient space: (unit oBB → bbox) then gradientTransform INSIDE it.
        if ob:
            bx0, by0, bx1, by1 = bbox
            out.append(
                _op([_r(bx1 - bx0), 0, 0, _r(by1 - by0), _r(bx0), _r(by0)], "cm")
            )
        if gt:
            out.append(_op([_r(v) for v in parse_transform(gt)], "cm"))
        out.append(_op([Name("/" + sh_name)], "sh"))
        out.append(_op([], "Q"))

    # — elements —

    def compile_children(self, parent, out, resources, inherited):
        for child in parent:
            self.compile_element(child, out, resources, inherited)

    def compile_element(self, elem, out, resources, inherited):
        tag = _local(elem.tag)
        if tag in IGNORED or tag == "style":
            return
        if tag in REFUSED:
            raise SvgUnsupported(f"<{tag}> is not supported")
        if tag == "defs":
            return  # referenced content only
        if tag in ("linearGradient", "radialGradient", "clipPath", "stop"):
            return  # instantiated at reference sites
        style = self.computed_style(elem, inherited)
        if "__display_none__" in style:
            return  # the whole subtree is gone
        opacity_raw = style.get("opacity", elem.get("opacity", "1"))
        try:
            opacity = max(0.0, min(1.0, float(opacity_raw)))
        except ValueError:
            opacity = 1.0
        transform = elem.get("transform")
        clip_ref = style.get("clip-path", "none").strip()

        if tag == "use":
            href = elem.get("href") or elem.get(f"{XLINK_NS}href") or ""
            if not href.startswith("#"):
                raise SvgUnsupported(f"use href {href!r} must be a local reference")
            ref_id = href[1:]
            if ref_id in self.use_stack:
                raise SvgUnsupported(f"use cycle through #{ref_id}")
            target = self.ids.get(ref_id)
            if target is None:
                raise SvgUnsupported(f"use references missing #{ref_id}")
            x = _length(elem.get("x", "0"), "use x")
            y = _length(elem.get("y", "0"), "use y")
            body: list = []
            self.use_stack.append(ref_id)
            try:
                self.compile_element(target, body, resources, style)
            finally:
                self.use_stack.pop()
            self._emit_wrapped(
                out, resources, body, transform_extra=(1, 0, 0, 1, x, y),
                transform=transform, clip_ref=clip_ref, opacity=opacity, style=style,
            )
            return

        if tag in ("svg", "g", "a"):
            body = []
            self.compile_children(elem, body, resources, style)
            self._emit_wrapped(
                out, resources, body, transform=transform, clip_ref=clip_ref,
                opacity=opacity, style=style,
            )
            return

        segs = shape_to_segs(elem)
        if segs is None:
            raise SvgUnsupported(f"<{tag}> is not supported")
        if not segs:
            return
        if style.get("visibility", "visible").strip() in ("hidden", "collapse"):
            return  # geometry suppressed; the (inherited) property may be
            # re-enabled by a sibling deeper in the tree, so only the SHAPE drops
        body = []
        self._emit_shape(body, resources, elem, segs, style)
        self._emit_wrapped(
            out, resources, body, transform=transform, clip_ref=clip_ref,
            opacity=opacity, style=style,
        )

    def _clip_segs(self, clip_ref):
        m = re.match(r"^url\(\s*['\"]?#([^'\")]+)['\"]?\s*\)$", clip_ref)
        if not m:
            raise SvgUnsupported(f"unsupported clip-path {clip_ref!r}")
        clip_elem = self.ids.get(m.group(1))
        if clip_elem is None or _local(clip_elem.tag) != "clipPath":
            raise SvgUnsupported(f"clip-path {clip_ref!r} resolves to nothing")
        if (clip_elem.get("clipPathUnits") or "userSpaceOnUse") != "userSpaceOnUse":
            raise SvgUnsupported("clipPathUnits=objectBoundingBox is not supported")
        segs = []
        for child in clip_elem:
            child_segs = shape_to_segs(child)
            if child_segs is None:
                raise SvgUnsupported("clipPath may contain only shape/path children")
            t = child.get("transform")
            if t:
                mt = parse_transform(t)
                child_segs = [
                    (s[0], *(_flatten_pts(mt, s[1:]))) if s[0] != "Z" else s
                    for s in child_segs
                ]
            segs.extend(child_segs)
        if not segs:
            raise SvgUnsupported("clipPath has no usable geometry")
        return segs

    def _emit_wrapped(
        self, out, resources, body, transform=None, transform_extra=None,
        clip_ref="none", opacity=1.0, style=None,
    ):
        """Wrap compiled body ops in transform/clip frames; opacity < 1
        compiles the body into its OWN transparency group (true SVG group
        semantics — a plain ca would double-darken overlapping fill+stroke)."""
        if not body:
            return
        if opacity < 0.999:
            body = self._group_form_do(resources, body, opacity)
        needs_frame = transform or transform_extra or clip_ref != "none"
        if needs_frame:
            out.append(_op([], "q"))
            if clip_ref != "none":
                _emit_segs(out, self._clip_segs(clip_ref))
                out.append(_op([], "W"))
                out.append(_op([], "n"))
            if transform:
                out.append(_op([_r(v) for v in parse_transform(transform)], "cm"))
            if transform_extra and transform_extra != (1, 0, 0, 1, 0, 0):
                out.append(_op([_r(v) for v in transform_extra], "cm"))
            out.extend(body)
            out.append(_op([], "Q"))
        else:
            out.extend(body)

    def _group_form_do(self, resources, body, opacity):
        """body → an isolated transparency-group Form XObject + the wrapped
        `q /GS gs /Fm Do Q` sequence (returned as ONE composite op list —
        appended flat by the caller)."""
        inner_resources: dict = {}
        # The body may reference resources it registered — they were written
        # into THIS stream's `resources`; a nested form needs its own dict.
        # Recompiling would be wasteful; instead the group form SHARES the
        # parent resources object (registered once at build time, below).
        stream = self.pdf.make_stream(
            pikepdf.unparse_content_stream(body)
        )
        stream["/Type"] = Name("/XObject")
        stream["/Subtype"] = Name("/Form")
        stream["/BBox"] = pikepdf.Array([-1e5, -1e5, 1e5, 1e5])
        stream["/Group"] = Dictionary(
            Type=Name("/Group"), S=Name("/Transparency"), I=True
        )
        self._pending_shared_resources = getattr(self, "_pending_shared_resources", [])
        self._pending_shared_resources.append(stream)
        fm = self.fresh("Fm")
        gs = self.fresh("GS")
        resources.setdefault("XObject", {})[fm] = stream
        resources.setdefault("ExtGState", {})[gs] = Dictionary(
            Type=Name("/ExtGState"), ca=_r(opacity), CA=_r(opacity)
        )
        return [
            _op([], "q"),
            _op([Name("/" + gs)], "gs"),
            _op([Name("/" + fm)], "Do"),
            _op([], "Q"),
        ]

    def _emit_shape(self, out, resources, elem, segs, style):
        fill_raw = style.get("fill", "black").strip()
        stroke_raw = style.get("stroke", "none").strip()
        current_color = parse_color(style.get("color", "black"))
        fill_rule = style.get("fill-rule", "nonzero")
        try:
            fill_alpha = max(0.0, min(1.0, float(style.get("fill-opacity", "1"))))
        except ValueError:
            fill_alpha = 1.0
        try:
            stroke_alpha = max(0.0, min(1.0, float(style.get("stroke-opacity", "1"))))
        except ValueError:
            stroke_alpha = 1.0
        fill_alpha *= _rgba_alpha(fill_raw)
        stroke_alpha *= _rgba_alpha(stroke_raw)

        fill_grad = self._gradient_elem(fill_raw) if fill_raw.startswith("url(") else None
        if fill_grad is not None and _local(fill_grad.tag) not in (
            "linearGradient",
            "radialGradient",
        ):
            raise SvgUnsupported("pattern paints are not supported")
        stroke_is_url = stroke_raw.startswith("url(")
        if stroke_is_url:
            raise SvgUnsupported(
                "gradient strokes are not supported (convert the stroke to a filled outline)"
            )

        wants_fill = fill_raw.lower() != "none" and fill_alpha > 0
        wants_stroke = stroke_raw.lower() != "none" and stroke_alpha > 0

        alpha_gs = None
        if (wants_fill and fill_alpha < 0.999) or (wants_stroke and stroke_alpha < 0.999):
            gs = self.fresh("GS")
            resources.setdefault("ExtGState", {})[gs] = Dictionary(
                Type=Name("/ExtGState"), ca=_r(fill_alpha), CA=_r(stroke_alpha)
            )
            alpha_gs = gs

        if alpha_gs:
            out.append(_op([], "q"))
            out.append(_op([Name("/" + alpha_gs)], "gs"))

        if wants_fill and fill_grad is not None:
            bbox = path_bbox(segs)
            if bbox is None:
                pass
            else:
                self.emit_gradient_fill(out, resources, fill_grad, segs, bbox, style, fill_rule)
        elif wants_fill:
            r, g, b = parse_color(fill_raw, current_color)
            out.append(_op([_r(r), _r(g), _r(b)], "rg"))

        if wants_stroke:
            r, g, b = parse_color(stroke_raw, current_color)
            out.append(_op([_r(r), _r(g), _r(b)], "RG"))
            out.append(_op([_r(_length(style.get("stroke-width", "1"), "stroke-width"))], "w"))
            cap = {"butt": 0, "round": 1, "square": 2}.get(style.get("stroke-linecap", "butt"))
            join = {"miter": 0, "round": 1, "bevel": 2}.get(
                style.get("stroke-linejoin", "miter")
            )
            if cap is None or join is None:
                raise SvgUnsupported("unsupported stroke cap/join")
            out.append(_op([cap], "J"))
            out.append(_op([join], "j"))
            miter = style.get("stroke-miterlimit", "4")
            out.append(_op([_r(float(miter))], "M"))
            dash = style.get("stroke-dasharray", "none").strip()
            if dash and dash != "none":
                pattern = _floats(dash)
                if pattern:
                    out.append(_op([pikepdf.Array([_r(v) for v in pattern]), 0], "d"))

        # The gradient fill (when any) was already painted above via
        # clip-then-`sh`; what remains is one paint pass for the plain fill
        # and/or the stroke — never both a combined B and a second S (the
        # double-stroke this branch structure replaced, review-caught).
        plain_fill = wants_fill and fill_grad is None
        if plain_fill or wants_stroke:
            _emit_segs(out, segs)
            if plain_fill and wants_stroke:
                out.append(_op([], "B" if fill_rule == "nonzero" else "B*"))
            elif plain_fill:
                out.append(_op([], "f" if fill_rule == "nonzero" else "f*"))
            else:
                out.append(_op([], "S"))

        if alpha_gs:
            out.append(_op([], "Q"))


def _flatten_pts(mt, coords):
    out = []
    for i in range(0, len(coords), 2):
        x, y = _apply(mt, coords[i], coords[i + 1])
        out.extend([x, y])
    return tuple(out)


def _build_resources(pdf, spec: dict):
    res = Dictionary()
    for kind, table in spec.items():
        d = Dictionary()
        for name, obj in table.items():
            d[Name("/" + name)] = pdf.make_indirect(obj)
        res[Name("/" + kind)] = d
    return res


def compile_svg(pdf, svg_bytes: bytes):
    """Compile SVG bytes into a unit-square Form XObject on `pdf`.

    Returns (form_stream, view_w, view_h). The form's BBox is [0,0,1,1];
    its content opens with the viewBox→unit normalization (including the
    SVG y-flip), so the placement `cm` alone decides where and how big —
    exactly the image-placement contract. view_w/view_h are the viewBox
    extents (the natural size for contain/at placement)."""
    head = svg_bytes.lstrip()[:200].lower()
    if b"<!doctype" in head:
        raise SvgUnsupported("SVG with a DOCTYPE is not supported")
    try:
        root = ET.fromstring(svg_bytes)
    except ET.ParseError as exc:
        raise SvgUnsupported(f"not well-formed SVG: {exc}") from None
    if _local(root.tag) != "svg":
        raise SvgUnsupported("root element is not <svg>")

    vb = root.get("viewBox")
    if vb:
        parts = _floats(vb)
        if len(parts) != 4 or parts[2] <= 0 or parts[3] <= 0:
            raise SvgUnsupported(f"malformed viewBox {vb!r}")
        minx, miny, vw, vh = parts
    else:
        w_attr, h_attr = root.get("width"), root.get("height")
        if not w_attr or not h_attr:
            raise SvgUnsupported("SVG needs a viewBox or width+height")
        minx, miny = 0.0, 0.0
        vw = _length(w_attr, "svg width")
        vh = _length(h_attr, "svg height")
        if vw <= 0 or vh <= 0:
            raise SvgUnsupported("SVG width/height must be positive")

    compiler = _Compiler(pdf, root)
    body: list = []
    resources_spec: dict = {}
    inherited = dict(_DEFAULT_STYLE)
    compiler.compile_children(root, body, resources_spec, inherited)

    # viewBox → unit square with the y-flip: (x,y) → ((x−minx)/vw, (maxy−y)/vh).
    norm = (1.0 / vw, 0.0, 0.0, -1.0 / vh, -minx / vw, (miny + vh) / vh)
    ops: list = [_op([], "q"), _op([_r(v) for v in norm], "cm")]
    ops.extend(body)
    ops.append(_op([], "Q"))

    form = pdf.make_stream(pikepdf.unparse_content_stream(ops))
    form["/Type"] = Name("/XObject")
    form["/Subtype"] = Name("/Form")
    form["/BBox"] = pikepdf.Array([0, 0, 1, 1])
    resources = _build_resources(pdf, resources_spec)
    form["/Resources"] = resources
    # Opacity-group forms share the TOP form's resources (their bodies were
    # compiled against the same tables) — registered after the dict exists.
    for pending in getattr(compiler, "_pending_shared_resources", []):
        pending["/Resources"] = resources
    form["/SpectraVector"] = Dictionary(
        ViewBox=pikepdf.Array([_r(minx), _r(miny), _r(vw), _r(vh)]),
    )
    return form, vw, vh
