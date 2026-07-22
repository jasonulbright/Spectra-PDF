"""AcroForm read / fill / flatten using pikepdf — WITH appearance generation.

The GUI fill is renderer-side pdf-lib, chosen because filling is really an
appearance-stream problem: a set /V with no regenerated /AP renders blank in
most viewers (docs/architecture/08-phase2f-forms.md). This module is the
engine-side implementation that gives the CLI parity
(docs/architecture/14-phase2l-gui-cli-parity.md). The parity target is
pdf-lib's BEHAVIOR (what the GUI produces), not full Acrobat semantics:

- Checkboxes/radios need no appearance generation — their widgets already
  carry every state in /AP /N; filling sets /V to the on-state name and each
  widget's /AS to match. Exact, not approximate.
- Text/dropdown/optionlist regenerate /AP /N per widget from the field's
  effective /DA (font, size, color) against the AcroForm /DR resources.
  Layout (wrap/align/auto-size) uses the shared Helvetica metrics
  (pdf_metrics.py); a non-Helvetica /DA font still RENDERS with the right
  face (the stream references the real /DR font) while layout approximates
  with Helvetica widths — pdf-lib's own default-appearance behavior is
  Helvetica-based, so this matches the parity target.
- /NeedAppearances is set false (real appearances are generated) — pdf-lib's
  posture.
- /XFA is stripped on fill (reported), matching pdf-lib's documented
  auto-delete: both paths' outputs are pure AcroForm.
- Values with characters outside cp1252 (WinAnsi) fail with a clear error —
  the same class of failure pdf-lib surfaces for its WinAnsi Helvetica.

Fail-closed: every edit is validated BEFORE any mutation (all problems
reported at once); output is written only after the full fill succeeds.
"""

import shutil
import tempfile
from pathlib import Path

import pikepdf
from pikepdf import Dictionary, Name

from engine.pdf_metrics import (
    GLYPH_HEIGHT_EM,
    HELVETICA_DESCENT_EM,
    flatten_control_chars,
    text_width_em,
)

# Field flags (1-based bit positions per the PDF spec, expressed as masks).
FF_READ_ONLY = 1 << 0
FF_REQUIRED = 1 << 1
FF_MULTILINE = 1 << 12
FF_RADIO = 1 << 15
FF_PUSHBUTTON = 1 << 16
FF_COMBO = 1 << 17
FF_EDIT = 1 << 18

# Widget annotation flags.
AF_HIDDEN = 1 << 1
AF_NOVIEW = 1 << 5

TEXT_PAD = 2.0
MIN_FONT_SIZE = 4.0
DEFAULT_FONT_SIZE = 12.0
LINE_SPACING = 1.2

INHERITABLE_KEYS = ("/FT", "/Ff", "/V", "/DA", "/Q", "/Opt")
MAX_FIELD_DEPTH = 32


def _acroform(pdf: pikepdf.Pdf):
    return pdf.Root.get("/AcroForm")


def _has_xfa(pdf: pikepdf.Pdf) -> bool:
    acro = _acroform(pdf)
    return acro is not None and "/XFA" in acro


class _Field:
    """One terminal field: its dict, fully-qualified name, inherited
    attributes, and widget annotation dicts."""

    def __init__(self, obj, name: str, inherited: dict):
        self.obj = obj
        self.name = name
        self.inherited = inherited

    def attr(self, key: str):
        return self.inherited.get(key)

    @property
    def ft(self) -> str:
        v = self.attr("/FT")
        return str(v) if v is not None else ""

    @property
    def flags(self) -> int:
        v = self.attr("/Ff")
        try:
            return int(v) if v is not None else 0
        except (TypeError, ValueError):
            return 0

    @property
    def widgets(self) -> list:
        """The widget annotation dicts this field draws through — the field
        dict itself when merged (has /Subtype /Widget), else its /Kids
        entries that are widgets (no /T of their own)."""
        if self.obj.get("/Subtype") == Name.Widget:
            return [self.obj]
        kids = self.obj.get("/Kids")
        if kids is None:
            return []
        out = []
        for kid in kids:
            try:
                if kid.get("/T") is None:
                    out.append(kid)
            except Exception:
                continue
        return out


def _walk_fields(node, prefix: str, inherited: dict, depth: int, out: list) -> None:
    if depth > MAX_FIELD_DEPTH:
        raise ValueError("AcroForm field tree nested too deeply")
    try:
        t = node.get("/T")
    except Exception:
        return
    name = prefix
    if t is not None:
        part = str(t)
        name = f"{prefix}.{part}" if prefix else part

    merged = dict(inherited)
    for key in INHERITABLE_KEYS:
        v = node.get(key)
        if v is not None:
            merged[key] = v

    kids = node.get("/Kids")
    has_field_kids = False
    has_widget_kids = False
    if kids is not None:
        for kid in kids:
            try:
                if kid.get("/T") is not None:
                    has_field_kids = True
                else:
                    has_widget_kids = True
            except Exception:
                continue
    if kids is not None and has_field_kids:
        # Recurse ONLY into kids that are themselves named fields. A /T-less
        # kid is a WIDGET of this node, never an independent field — even when
        # it carries a stray /FT (review-caught: such kids each became a
        # duplicate _Field under the parent's name, and the fill's name→field
        # dict silently dropped all but the last, leaving real widgets
        # unfillable). Mixed containers stay terminal for their widget kids.
        for kid in kids:
            try:
                if kid.get("/T") is not None:
                    _walk_fields(kid, name, merged, depth + 1, out)
            except Exception:
                continue
        if has_widget_kids and merged.get("/FT") is not None and name:
            out.append(_Field(node, name, merged))
    elif merged.get("/FT") is not None and name:
        out.append(_Field(node, name, merged))


def _all_fields(pdf: pikepdf.Pdf) -> list:
    acro = _acroform(pdf)
    if acro is None:
        return []
    fields = acro.get("/Fields")
    if fields is None:
        return []
    out: list = []
    for node in fields:
        _walk_fields(node, "", {}, 0, out)
    return out


def _classify(field: _Field) -> str:
    ft = field.ft
    ff = field.flags
    if ft == "/Tx":
        return "text"
    if ft == "/Btn":
        if ff & FF_PUSHBUTTON:
            return "button"
        if ff & FF_RADIO:
            return "radio"
        return "checkbox"
    if ft == "/Ch":
        return "dropdown" if ff & FF_COMBO else "optionlist"
    if ft == "/Sig":
        return "signature"
    return "unknown"


def _options(field: _Field) -> list[str]:
    """Display strings from /Opt ([display] or [[export, display]] pairs)."""
    opt = field.attr("/Opt")
    if opt is None:
        return []
    out = []
    for entry in opt:
        try:
            if isinstance(entry, pikepdf.Array) and len(entry) >= 2:
                out.append(str(entry[1]))
            else:
                out.append(str(entry))
        except Exception:
            continue
    return out


def _option_export(field: _Field, wanted: str) -> str | None:
    """Match `wanted` against /Opt display OR export strings; return the
    EXPORT string to store in /V, or None when /Opt exists and nothing
    matches. Fields without /Opt return the value as-is."""
    opt = field.attr("/Opt")
    if opt is None:
        return wanted
    for entry in opt:
        try:
            if isinstance(entry, pikepdf.Array) and len(entry) >= 2:
                export, display = str(entry[0]), str(entry[1])
            else:
                export = display = str(entry)
        except Exception:
            continue
        if wanted == display or wanted == export:
            return export
    return None


def _radio_on_states(field: _Field) -> list[str]:
    """The non-/Off appearance-state names across the field's widgets, in
    widget order (the names /V must take to select each option)."""
    states = []
    for widget in field.widgets:
        name = _widget_on_state(widget)
        states.append(name if name is not None else "")
    return states


def _radio_display_options(field: _Field) -> list[str]:
    """User-facing radio options. With /Opt (the pdf-lib/Acrobat indexed
    convention: widget on-states are indices, /Opt holds the display strings)
    the display strings; otherwise the raw on-state names."""
    opt = field.attr("/Opt")
    if opt is not None:
        out = []
        for entry in opt:
            try:
                out.append(str(entry))
            except Exception:
                out.append("")
        return out
    return [s for s in _radio_on_states(field) if s]


def _radio_state_for(field: _Field, wanted: str) -> str | None:
    """The on-state name /V must take to select `wanted`, accepting either a
    display string (mapped through /Opt to its index) or a raw state name.
    None when nothing matches."""
    states = _radio_on_states(field)
    opt = field.attr("/Opt")
    if opt is not None:
        for i, entry in enumerate(opt):
            try:
                display = str(entry)
            except Exception:
                continue
            if wanted == display and str(i) in states:
                return str(i)
    if wanted in states:
        return wanted
    return None


def _radio_display_value(field: _Field, state: str) -> str:
    """The display string for a raw on-state name (inverse of the above)."""
    opt = field.attr("/Opt")
    if opt is not None:
        try:
            index = int(state)
            if 0 <= index < len(opt):
                return str(opt[index])
        except (TypeError, ValueError):
            pass
    return state


def _widget_on_state(widget) -> str | None:
    ap = widget.get("/AP")
    if ap is None:
        return None
    n = ap.get("/N")
    if n is None or not isinstance(n, pikepdf.Dictionary):
        return None
    for key in n.keys():
        if str(key) != "/Off":
            return str(key).lstrip("/")
    return None


def _field_value(field: _Field, ftype: str):
    v = field.attr("/V")
    if ftype == "checkbox":
        return v is not None and str(v) != "/Off"
    if ftype == "radio":
        if v is None or str(v) == "/Off":
            return ""
        return _radio_display_value(field, str(v).lstrip("/"))
    if ftype in ("text", "dropdown"):
        return str(v) if v is not None else ""
    if ftype == "optionlist":
        if v is None:
            return ""
        if isinstance(v, pikepdf.Array):
            return str(v[0]) if len(v) > 0 else ""
        return str(v)
    return None


def _page_index_maps(pdf) -> tuple[dict, dict]:
    """(annot-objgen → 0-based page index, page-objgen → 0-based page index).
    A widget's page is authoritatively where it appears in a page's /Annots
    (a widget's own /P can be absent or stale); the page map is the /P fallback.
    Only INDIRECT objects (objid ≠ 0) are keyed — direct objects all share
    (0,0) and would false-match, so they map to None (unplaced)."""
    annot_map: dict = {}
    page_map: dict = {}
    for i, page in enumerate(pdf.pages):
        try:
            og = page.obj.objgen
            if og[0] != 0:
                page_map[og] = i
        except Exception:
            pass
        annots = page.obj.get("/Annots")
        if annots is None:
            continue
        for a in annots:
            try:
                og = a.objgen
                if og[0] == 0:
                    continue
                if og in annot_map:
                    # The SAME widget object listed in ≥2 pages' /Annots is
                    # malformed (reachable via arbitrary third-party input the
                    # CLI reader must tolerate — gauntlet MEDIUM). Never silently
                    # pick a page: mark it ambiguous (None) so `_widget_geometry`
                    # falls back to the spec-authoritative /P, else reports
                    # unplaced — no silent misattribution.
                    if annot_map[og] != i:
                        annot_map[og] = None
                else:
                    annot_map[og] = i
            except Exception:
                continue
    return annot_map, page_map


def _widget_geometry(field, annot_map: dict, page_map: dict) -> list:
    """Per-widget placement — `{page (0-based, or None if unplaced), rect
    [x0,y0,x1,y1] normalized}`. FC3 (§I.0 S6/FC4): the geometry the on-canvas
    overlay needs to project each widget; `_Field.widgets` already collects a
    typed terminal's nested widgets, so this surfaces S6 to the GUI once the
    read routes through the engine."""
    out = []
    for w in field.widgets:
        try:
            r = [float(v) for v in w.get("/Rect")]
        except (TypeError, ValueError):
            continue
        if len(r) != 4:
            continue
        page = None
        try:
            og = w.objgen
            if og[0] != 0:
                page = annot_map.get(og)
        except Exception:
            page = None
        if page is None:
            p = w.get("/P")
            if p is not None:
                try:
                    pog = p.objgen
                    if pog[0] != 0:
                        page = page_map.get(pog)
                except Exception:
                    page = None
        out.append(
            {
                "page": page,
                "rect": [min(r[0], r[2]), min(r[1], r[3]), max(r[0], r[2]), max(r[1], r[3])],
            }
        )
    return out


def read_form_fields(file: str) -> dict:
    """Enumerate AcroForm fields (read-only)."""
    with pikepdf.open(file) as pdf:
        annot_map, page_map = _page_index_maps(pdf)
        fields = []
        for field in _all_fields(pdf):
            ftype = _classify(field)
            entry = {
                "name": field.name,
                "type": ftype,
                "value": _field_value(field, ftype),
                "read_only": bool(field.flags & FF_READ_ONLY),
                "required": bool(field.flags & FF_REQUIRED),
                # FC3: per-widget page+rect so the engine read can drive the
                # on-canvas overlay (the S1 re-route, FC4) and nested widgets
                # (S6) list with geometry.
                "widgets": _widget_geometry(field, annot_map, page_map),
            }
            if ftype == "text":
                entry["multiline"] = bool(field.flags & FF_MULTILINE)
            if ftype == "radio":
                entry["options"] = _radio_display_options(field)
            elif ftype in ("dropdown", "optionlist"):
                entry["options"] = _options(field)
            fields.append(entry)
        return {"has_xfa": _has_xfa(pdf), "fields": fields, "count": len(fields)}


# ── Appearance generation ─────────────────────────────────────────────────


def _parse_da(da: str | None) -> tuple[str, float, str]:
    """(font resource name, size, color ops) from a /DA string like
    '/Helv 10 Tf 0 g'. Missing/unparseable pieces fall back to Helvetica
    defaults; size 0 means auto-size."""
    import re

    font_name = "Helv"
    size = DEFAULT_FONT_SIZE
    color = "0 g"
    if da:
        m = re.search(r"/([^\s/]+)\s+([\d.]+)\s+Tf", da)
        if m:
            font_name = m.group(1)
            try:
                size = float(m.group(2))
            except ValueError:
                size = DEFAULT_FONT_SIZE
        cm = re.search(r"([\d.]+(?:\s+[\d.]+){0,3})\s+(g|rg|k)\b", da)
        if cm:
            color = f"{cm.group(1)} {cm.group(2)}"
    return font_name, size, color


def _dr_font(pdf: pikepdf.Pdf, font_name: str) -> tuple[str, "pikepdf.Object", bool]:
    """Resolve the /DA-requested font against /AcroForm /DR. Returns
    (resource name to USE in the stream, font object, substituted).

    When the requested resource is MISSING from /DR, the fallback is a
    standard Helvetica registered under the name "Helv" in the appearance
    stream's OWN /Resources only — never under the original name, and never
    written into the shared /DR (review-caught: registering Helvetica as
    e.g. "TiRo" in /DR silently rendered the wrong face while CLAIMING the
    right one, for every field in the document that referenced that name).
    The substitution is honest (the stream both uses and names Helvetica)
    and reported to the caller via the `substituted` flag."""
    acro = _acroform(pdf)
    if acro is not None:
        dr = acro.get("/DR")
        if dr is not None:
            fonts = dr.get("/Font")
            if fonts is not None:
                f = fonts.get(Name("/" + font_name))
                if f is not None:
                    return font_name, f, False
    helv = pdf.make_indirect(
        Dictionary(
            Type=Name.Font,
            Subtype=Name.Type1,
            BaseFont=Name.Helvetica,
            Encoding=Name.WinAnsiEncoding,
        )
    )
    return "Helv", helv, font_name != "Helv"


def _escape_pdf_text(value: str) -> bytes:
    """cp1252 (≈WinAnsi) encoding with PDF string escapes. Raises ValueError
    on characters outside the encoding — surfaced as the documented
    'couldn't regenerate appearances' error class."""
    try:
        raw = value.encode("cp1252")
    except UnicodeEncodeError:
        raise ValueError(
            "value contains characters outside the form font's encoding (WinAnsi)"
        ) from None
    return raw.replace(b"\\", b"\\\\").replace(b"(", b"\\(").replace(b")", b"\\)")


def _wrap_lines(text: str, size: float, max_width: float, width_em=text_width_em) -> list[str]:
    """Greedy word wrap; explicit newlines respected. `width_em(s)` is the em
    advance of `s` — Helvetica by default (byte-identical WinAnsi path), or an
    embedded font's own metric on the Unicode path (FC1)."""
    lines: list[str] = []
    for para in text.split("\n"):
        if not para:
            lines.append("")
            continue
        current = ""
        for word in para.split(" "):
            candidate = word if not current else current + " " + word
            if width_em(candidate) * size <= max_width or not current:
                current = candidate
            else:
                lines.append(current)
                current = word
        lines.append(current)
    return lines


def _fit_font_size(text: str, multiline: bool, w: float, h: float, width_em=text_width_em) -> float:
    """Auto-size (DA size 0): largest size that fits the box, pdf-lib-style
    downward scan, floored at MIN_FONT_SIZE. `width_em` as in `_wrap_lines`."""
    size = min(DEFAULT_FONT_SIZE * 2, h - 2 * TEXT_PAD)
    size = max(size, MIN_FONT_SIZE)
    while size > MIN_FONT_SIZE:
        if multiline:
            lines = _wrap_lines(text, size, w - 2 * TEXT_PAD, width_em)
            needed = len(lines) * size * LINE_SPACING
            widest = max((width_em(ln) * size for ln in lines), default=0.0)
            if needed <= h - 2 * TEXT_PAD and widest <= w - 2 * TEXT_PAD:
                return size
        else:
            if (
                width_em(text) * size <= w - 2 * TEXT_PAD
                and size * GLYPH_HEIGHT_EM <= h - 2 * TEXT_PAD
            ):
                return size
        size -= 0.5
    return MIN_FONT_SIZE


def _family_for_da(da: str | None) -> str:
    """Map the /DA font to a fallback FAMILY for an embedded Unicode appearance
    (Helvetica→sans default, Times→serif, Courier→mono). Liberation covers
    Latin/Cyrillic/Greek in all three; the family only picks the shape."""
    req, _sz, _c = _parse_da(da)
    low = req.lower()
    if any(k in low for k in ("times", "tiro", "serif", "georgia", "roman")):
        return "serif"
    if any(k in low for k in ("cour", "mono")):
        return "mono"
    return "sans"


def _unicode_face(font_dir: str, da: str | None) -> str | None:
    """The bundled fallback .ttf to embed for a non-WinAnsi value, by the /DA
    family. None when no fonts DIR is available (→ the value is refused, never
    crashed): a missing/non-directory path fails safe here rather than letting
    `_face_missing`/`build_fallback_font` raise on a bogus path later."""
    if not font_dir or not Path(font_dir).is_dir():
        return None
    from engine.font_fallback import resolve_fallback_font, synthetic_family_font

    try:
        return resolve_fallback_font(font_dir, synthetic_family_font(_family_for_da(da)))
    except (ValueError, OSError):
        return None


def _face_missing(face_path: str, text: str) -> list[str]:
    """Characters `face_path` cannot map through its cmap — the CJK/uncovered
    boundary. Checked in VALIDATION so an unrenderable value is reported with
    the rest and the fill stays atomic (it never half-writes then raises).
    Layout-only chars (newline/tab/CR) are not glyphs and never missing."""
    from fontTools.ttLib import TTFont

    font = TTFont(face_path, fontNumber=0, lazy=True)
    try:
        cmap = font.getBestCmap() or {}
    finally:
        font.close()
    return [
        ch
        for ch in dict.fromkeys(text)
        if ch not in "\n\r\t" and ord(ch) not in cmap
    ]


def _text_appearance(
    pdf: pikepdf.Pdf,
    widget,
    value: str,
    da: str | None,
    multiline: bool,
    quadding: int,
    font_dir: str = "",
) -> bool:
    """Regenerate the widget's /AP /N form XObject for a text-ish value.
    Returns True when the /DA-requested font was missing from /DR and
    Helvetica was substituted (honestly — named as itself, locally only).

    FC1 (§I.0 S3): a value outside WinAnsi is drawn with an EMBEDDED subsetted
    Unicode font (Identity-H, via `build_fallback_font`) when `font_dir` is
    available — validation has already confirmed the face can render it. A
    pure-WinAnsi value keeps the byte-identical standard-14 path. The ONLY axes
    that differ are the font resource, the width metric, and the show-string
    encoding; wrapping, quadding and vertical placement are shared (Liberation
    is metric-compatible with Helvetica, so the Helvetica descent/height keep
    the baseline consistent)."""
    rect = [float(v) for v in widget["/Rect"]]
    w = abs(rect[2] - rect[0])
    h = abs(rect[3] - rect[1])
    requested_font, size, color = _parse_da(da)

    try:
        value.encode("cp1252")
        unicode_face = None
    except UnicodeEncodeError:
        unicode_face = _unicode_face(font_dir, da)

    if unicode_face is None:
        # WinAnsi — byte-identical: everything below runs on the raw value
        # (Helvetica metrics + `_escape_pdf_text` both tolerate control bytes).
        layout_value = value
        font_name, font_obj, substituted = _dr_font(pdf, requested_font)
        width_em = text_width_em

        def emit(line: str) -> bytes:
            return b"(" + _escape_pdf_text(line) + b") Tj"
    else:
        from engine.font_fallback import build_fallback_font

        # The embedded font is SUBSET to the drawn glyphs, and `build_fallback_
        # font`/`encode`/`width_1000` all reject a character not in that subset.
        # Layout-only control/separator chars are never glyphs; validation
        # excluded them from coverage, so flatten them AWAY of the glyph set
        # here (LF kept for multiline wrapping) or a validated multi-paragraph
        # value would crash inside the fill (gauntlet HIGH — broadened to all
        # control chars, not just \n/\r/\t, matching S4).
        layout_value = flatten_control_chars(value, keep_newline=True)
        font_obj, encode, width_1000 = build_fallback_font(
            pdf, unicode_face, layout_value.replace("\n", " ")
        )
        font_name = "TxU"  # one font per appearance stream, in its own /Resources
        substituted = False  # an intentional embed, not a /DR-missing fallback

        def width_em(s: str, _w=width_1000) -> float:
            return _w(s) / 1000.0

        def emit(line: str, _e=encode) -> bytes:
            return b"<" + _e(line).hex().encode("ascii") + b"> Tj"

    if size <= 0:
        # Single-line width is measured on the flattened text (no `\n`); the
        # WinAnsi path keeps `value` verbatim so its auto-size is byte-identical.
        fit_value = layout_value if (multiline or unicode_face is None) else layout_value.replace("\n", " ")
        size = _fit_font_size(fit_value, multiline, w, h, width_em)

    if multiline:
        lines = _wrap_lines(layout_value, size, w - 2 * TEXT_PAD, width_em)
        # Top-aligned like pdf-lib: first baseline one line down from the top.
        y = h - TEXT_PAD - size * GLYPH_HEIGHT_EM + size * HELVETICA_DESCENT_EM
    else:
        lines = [layout_value.replace("\n", " ")]
        y = (h - size * GLYPH_HEIGHT_EM) / 2 + size * HELVETICA_DESCENT_EM

    parts = [b"/Tx BMC", b"q", f"1 1 {_fmt(w - 2)} {_fmt(h - 2)} re W n".encode("ascii"), b"BT"]
    parts.append(color.encode("ascii"))
    parts.append(f"/{font_name} {_fmt(size)} Tf".encode("ascii"))
    first = True
    for line in lines:
        tw = width_em(line) * size
        if quadding == 1:
            x = (w - tw) / 2
        elif quadding == 2:
            x = w - TEXT_PAD - tw
        else:
            x = TEXT_PAD
        x = max(x, TEXT_PAD)
        if first:
            parts.append(f"{_fmt(x)} {_fmt(y)} Td".encode("ascii"))
            first = False
            last_x = x
        else:
            parts.append(f"{_fmt(x - last_x)} {_fmt(-size * LINE_SPACING)} Td".encode("ascii"))
            last_x = x
        parts.append(emit(line))
    parts.extend([b"ET", b"Q", b"EMC"])

    stream = pdf.make_stream(b"\n".join(parts))
    stream["/Type"] = Name.XObject
    stream["/Subtype"] = Name.Form
    stream["/BBox"] = pikepdf.Array([0, 0, w, h])
    stream["/Resources"] = Dictionary(Font=Dictionary({("/" + font_name): font_obj}))
    widget["/AP"] = Dictionary(N=pdf.make_indirect(stream))
    if "/AS" in widget:
        del widget["/AS"]
    return substituted


def _fmt(v: float) -> str:
    return f"{v:.2f}".rstrip("0").rstrip(".") or "0"


# ── Fill ──────────────────────────────────────────────────────────────────


def _coerce_bool(value) -> bool | None:
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        s = value.strip().lower()
        if s in ("true", "yes", "on", "1"):
            return True
        if s in ("false", "no", "off", "0"):
            return False
    return None


def _field_da(field, acro) -> str | None:
    """The /DA in effect for a field: its own, else the AcroForm default."""
    da = field.attr("/DA")
    if da is None and acro is not None:
        da = acro.get("/DA")
    return str(da) if da is not None else None


def _text_value_problem(name: str, text: str, da: str | None, font_dir: str) -> str | None:
    """None when `text` can be DRAWN into `name`'s appearance — WinAnsi
    directly, or (FC1) via an embedded Unicode font when `font_dir` provides a
    face that covers every glyph. Else the problem string. Doing the coverage
    check HERE keeps the fill's 'list ALL problems, then mutate nothing on
    failure' atomicity for the Unicode path too (the appearance writer never
    half-fills then raises)."""
    try:
        text.encode("cp1252")
        return None
    except UnicodeEncodeError:
        pass
    face = _unicode_face(font_dir, da)
    if face is None:
        return (
            f"value for {name} contains characters outside the form font's "
            f"encoding (WinAnsi) and no fallback font is available"
        )
    # Layout control chars (\t/\x0b/U+2028/…) are flattened to spaces before the
    # appearance embeds the font (below), so they must NOT count as "missing"
    # here — else a value the king renders fine would be refused (S4 gauntlet's
    # broad-control-char lesson, applied to the shared form path too).
    missing = _face_missing(face, flatten_control_chars(text, keep_newline=True))
    if missing:
        pretty = " ".join(f"'{c}'" for c in sorted(set(missing)))
        return f"value for {name} contains characters no available font can render ({pretty})"
    return None


def fill_form_fields(
    file: str, output: str, edits: dict, flatten: bool = False, font_dir: str = ""
) -> dict:
    """Fill AcroForm fields and regenerate appearances; optionally flatten.

    Args:
        file: Input PDF path.
        output: Output PDF path (may equal input — temp+rename).
        edits: {fully-qualified field name: value} — str for text/choice,
            bool (or true/false/yes/no/on/off strings) for checkboxes.
        flatten: Bake appearances into page content and remove all fields.
        font_dir: the bundled fallback-fonts directory (FC1, §I.0 S3). When
            given, a value outside WinAnsi is drawn with an embedded subsetted
            Unicode font instead of being refused; empty keeps the WinAnsi-only
            behaviour. Callers pass the same dir as the text-editing ops
            (Rust `get_edit_font_path`).
    """
    input_path = Path(file)
    output_path = Path(output)
    same_file = input_path.resolve() == output_path.resolve()

    with pikepdf.open(file) as pdf:
        fields = {f.name: f for f in _all_fields(pdf)}
        acro = _acroform(pdf)

        # Validate EVERYTHING before mutating ANYTHING — report all problems.
        problems: list[str] = []
        plan: list[tuple[_Field, str, object]] = []
        for name, value in (edits or {}).items():
            field = fields.get(str(name))
            if field is None:
                problems.append(f"no such field: {name}")
                continue
            ftype = _classify(field)
            if field.flags & FF_READ_ONLY:
                problems.append(f"field is read-only: {name}")
                continue
            if ftype == "text":
                text = str(value)
                # Encodability is part of validation, not a mutation-time
                # surprise: the "list ALL problems" contract must include the
                # appearance-encoding failures (review-caught: two bad fields
                # reported one problem at a time across two attempts). FC1: a
                # non-WinAnsi value is fillable via an embedded Unicode font
                # when `font_dir` covers it, else refused here.
                prob = _text_value_problem(name, text, _field_da(field, acro), font_dir)
                if prob is not None:
                    problems.append(prob)
                else:
                    plan.append((field, ftype, text))
            elif ftype == "checkbox":
                b = _coerce_bool(value)
                if b is None:
                    problems.append(f"checkbox {name} needs true/false, got: {value!r}")
                else:
                    plan.append((field, ftype, b))
            elif ftype == "radio":
                state = _radio_state_for(field, str(value))
                if state is None:
                    opts = ", ".join(_radio_display_options(field))
                    problems.append(f"radio {name} has no option {value!r} (options: {opts})")
                else:
                    plan.append((field, ftype, state))
            elif ftype in ("dropdown", "optionlist"):
                export = _option_export(field, str(value))
                editable = bool(field.flags & FF_EDIT) and ftype == "dropdown"
                if export is None and not editable:
                    opts = ", ".join(_options(field))
                    problems.append(f"{ftype} {name} has no option {value!r} (options: {opts})")
                else:
                    chosen = export if export is not None else str(value)
                    prob = _text_value_problem(name, chosen, _field_da(field, acro), font_dir)
                    if prob is not None:
                        problems.append(prob)
                    else:
                        plan.append((field, ftype, chosen))
            else:
                problems.append(f"field {name} has type {ftype!r}, which is not fillable")
        if problems:
            raise ValueError("; ".join(problems))

        xfa_stripped = False
        if acro is not None and "/XFA" in acro:
            # Parity with the GUI's pdf-lib path, which auto-deletes /XFA on
            # getForm()/save: every fill output is pure AcroForm.
            del acro["/XFA"]
            xfa_stripped = True

        filled = 0
        fonts_substituted: list[str] = []
        for field, ftype, value in plan:
            da = _field_da(field, acro)
            q = field.attr("/Q")
            try:
                quadding = int(q) if q is not None else 0
            except (TypeError, ValueError):
                quadding = 0

            if ftype == "checkbox":
                on = None
                for widget in field.widgets:
                    on = on or _widget_on_state(widget)
                on = on or "Yes"
                field.obj["/V"] = Name("/" + on) if value else Name("/Off")
                for widget in field.widgets:
                    if value:
                        # Each widget lights via ITS OWN on-state name —
                        # multi-widget checkboxes can legitimately use
                        # different names ("Yes"/"On") for the same logical
                        # field (review-caught: gating on one cached name
                        # left sibling widgets visually unchecked).
                        widget_on = _widget_on_state(widget) or on
                        widget["/AS"] = Name("/" + widget_on)
                    else:
                        widget["/AS"] = Name("/Off")
            elif ftype == "radio":
                field.obj["/V"] = Name("/" + str(value))
                for widget in field.widgets:
                    widget["/AS"] = (
                        Name("/" + str(value))
                        if _widget_on_state(widget) == str(value)
                        else Name("/Off")
                    )
            else:  # text / dropdown / optionlist
                text = str(value)
                field.obj["/V"] = pikepdf.String(text)
                if "/I" in field.obj:
                    del field.obj["/I"]
                multiline = ftype == "text" and bool(field.flags & FF_MULTILINE)
                try:
                    for widget in field.widgets:
                        if _text_appearance(pdf, widget, text, da, multiline, quadding, font_dir):
                            if field.name not in fonts_substituted:
                                fonts_substituted.append(field.name)
                except ValueError as exc:
                    raise ValueError(
                        f"couldn't regenerate the appearance for {field.name}: {exc}"
                    ) from None
            filled += 1

        if acro is not None and "/NeedAppearances" in acro:
            del acro["/NeedAppearances"]

        flattened = False
        if flatten:
            _flatten_fields(pdf)
            flattened = True

        if same_file:
            with tempfile.NamedTemporaryFile(
                suffix=".pdf", delete=False, dir=str(input_path.parent)
            ) as tmp:
                tmp_path = tmp.name
            pdf.save(tmp_path)
        else:
            pdf.save(output_path)

    if same_file:
        shutil.move(tmp_path, str(output_path))

    return {
        "output": str(output_path),
        "filled": filled,
        "flattened": flattened,
        "xfa_stripped": xfa_stripped,
        # Fields whose /DA named a font missing from /DR — their appearances
        # render (honestly) in Helvetica. Surfaced, never silent.
        "fonts_substituted": fonts_substituted,
    }


# ── Flatten ───────────────────────────────────────────────────────────────


def _effective_appearance(widget):
    """The widget's effective /N appearance stream (resolved through /AS for
    state dictionaries), or None."""
    ap = widget.get("/AP")
    if ap is None:
        return None
    n = ap.get("/N")
    if n is None:
        return None
    if isinstance(n, pikepdf.Dictionary) and not isinstance(n, pikepdf.Stream):
        state = widget.get("/AS")
        if state is None:
            return None
        return n.get(state)
    return n


def _flatten_fields(pdf: pikepdf.Pdf) -> None:
    """Stamp every visible widget's appearance into its page's content and
    remove all form interactivity (widget annots + /AcroForm) — pdf-lib
    flatten() parity."""
    for page in pdf.pages:
        annots = page.obj.get("/Annots")
        if annots is None:
            continue
        keep = []
        stamps: list[tuple] = []
        for annot in annots:
            try:
                subtype = annot.get("/Subtype")
            except Exception:
                keep.append(annot)
                continue
            if subtype != Name.Widget:
                keep.append(annot)
                continue
            try:
                flags = int(annot.get("/F", 0))
            except (TypeError, ValueError):
                flags = 0
            stream = _effective_appearance(annot)
            if stream is not None and not (flags & AF_HIDDEN) and not (flags & AF_NOVIEW):
                stamps.append((annot, stream))
        if stamps:
            resources = page.obj.get("/Resources")
            if resources is None:
                resources = Dictionary()
                page.obj["/Resources"] = resources
            xobjects = resources.get("/XObject")
            if xobjects is None:
                xobjects = Dictionary()
                resources["/XObject"] = xobjects
            ops = []
            for i, (annot, stream) in enumerate(stamps):
                rect = [float(v) for v in annot["/Rect"]]
                rx0, ry0 = min(rect[0], rect[2]), min(rect[1], rect[3])
                rw = abs(rect[2] - rect[0])
                rh = abs(rect[3] - rect[1])
                bbox = [float(v) for v in stream.get("/BBox", [0, 0, rw or 1, rh or 1])]
                bx0, by0 = min(bbox[0], bbox[2]), min(bbox[1], bbox[3])
                bw = abs(bbox[2] - bbox[0]) or 1.0
                bh = abs(bbox[3] - bbox[1]) or 1.0
                sx = rw / bw
                sy = rh / bh
                # Standard widget stamping: map the appearance BBox onto the
                # widget Rect (identity /Matrix assumed — true for both our
                # generated streams and typical checkbox states).
                name = f"/FlatW{len(xobjects)}x{i}"
                xobjects[Name(name)] = stream
                ops.append(
                    f"q {_fmt(sx)} 0 0 {_fmt(sy)} {_fmt(rx0 - bx0 * sx)} {_fmt(ry0 - by0 * sy)} cm {name} Do Q".encode(
                        "ascii"
                    )
                )
            existing = pikepdf.parse_content_stream(page)
            new_content = pikepdf.unparse_content_stream(existing) + b"\n" + b"\n".join(ops)
            page.Contents = pdf.make_stream(new_content)
        if keep:
            page.obj["/Annots"] = pikepdf.Array(keep)
        elif "/Annots" in page.obj:
            del page.obj["/Annots"]
    if "/AcroForm" in pdf.Root:
        del pdf.Root["/AcroForm"]
