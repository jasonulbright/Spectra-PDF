"""AcroForm read / fill / flatten using pikepdf — WITH appearance generation.

The GUI fill is renderer-side pdf-lib, chosen because filling is really an
appearance-stream problem: a set /V with no regenerated /AP renders blank in
most viewers. This module is the engine-side implementation that gives the
CLI the same behavior as the GUI. The target is pdf-lib's behavior, not
every form variation found in arbitrary PDFs:

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

from engine import afcalc, fieldactions, formdata
from engine.acroform import calculation_order_names
from engine.afscript import recognize
from engine.document_js import decode_js
from engine.fieldmdp import lock_of_field_dict
from engine.pdf_metrics import (
    GLYPH_HEIGHT_EM,
    HELVETICA_DESCENT_EM,
    flatten_control_chars,
    text_width_em,
)
from engine.pdf_save import save_pdf

# Field flags (1-based bit positions per the PDF spec, expressed as masks).
FF_READ_ONLY = 1 << 0
FF_REQUIRED = 1 << 1
FF_MULTILINE = 1 << 12
FF_RADIO = 1 << 15
FF_PUSHBUTTON = 1 << 16
FF_COMBO = 1 << 17
FF_EDIT = 1 << 18
FF_MULTISELECT = 1 << 21  # choice fields: a list box may select several items

# Sentinel: an EMPTY value on a choice field (radio/dropdown/optionlist) means
# "clear the selection" (pdf-lib's field.clear()), NOT an invalid option — else
# a deliberate clear (or the on-canvas "—" option) would be refused. Text fields
# treat "" as a legitimate empty value, so they never use this.
_CLEAR = object()

# Widget annotation flags.
AF_HIDDEN = 1 << 1
AF_NOVIEW = 1 << 5

TEXT_PAD = 2.0
MIN_FONT_SIZE = 4.0
DEFAULT_FONT_SIZE = 12.0
LINE_SPACING = 1.2

INHERITABLE_KEYS = ("/FT", "/Ff", "/V", "/DV", "/DA", "/Q", "/Opt")
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
        # kid is a widget of this node, never an independent field, even when
        # it carries a stray /FT. Treating it independently creates a
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


def _option_export_index(field: _Field, wanted: str) -> tuple[str, int] | None:
    """(export string, 0-based /Opt index) for `wanted` (display or export), or
    None if /Opt exists and nothing matches. A field without /Opt has no index
    (-1). Used for multi-select list boxes, whose /I holds the selected /Opt
    indices."""
    opt = field.attr("/Opt")
    if opt is None:
        return (wanted, -1)
    for i, entry in enumerate(opt):
        try:
            if isinstance(entry, pikepdf.Array) and len(entry) >= 2:
                export, display = str(entry[0]), str(entry[1])
            else:
                export = display = str(entry)
        except Exception:
            continue
        if wanted == display or wanted == export:
            return (export, i)
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
    """User-facing radio options. With /Opt (the indexed-widget
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


def _field_description(field: _Field) -> str:
    """The field's ``/TU``. Read off the field's OWN dictionary: `/TU` is not
    among the inheritable field attributes, so a parent's description does not
    describe its children."""
    try:
        value = field.obj.get("/TU")
    except (AttributeError, TypeError):
        return ""
    if value is None:
        return ""
    try:
        return str(value).strip()
    except (TypeError, ValueError):
        return ""


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
            # A multi-select list box reports its FULL selection as a list
            # (was silently truncated to the first item).
            return [str(x) for x in v]
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
                    # malformed and reachable through arbitrary input the CLI
                    # reader must tolerate. Never silently
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


def _widget_geometry(
    field, ftype: str, options: list[str], annot_map: dict, page_map: dict
) -> list:
    """Per-widget placement — `{page (0-based, or None if unplaced), rect
    [x0,y0,x1,y1] normalized, hidden, option?}`. The geometry
    the on-canvas overlay needs to project each widget; `_Field.widgets` already
    collects a typed terminal's nested widgets, so nested widgets surface to
    the GUI once the read routes through the engine.

    `hidden` mirrors the renderer's old pdf-lib read: a /F Hidden or NoView
    widget shows nothing on the raster, so the overlay must offer no input over
    it. `option` (radio only) is the DISPLAY option this widget's on-state
    selects — the overlay uses it to know which radio a widget commits — mapped
    through /Opt and included only when it is one of the field's fillable
    options (an on-state with no matching option leaves the widget inert, the
    same honest posture as the pdf-lib read)."""
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
        try:
            flags = int(w.get("/F", 0))
        except (TypeError, ValueError):
            flags = 0
        entry = {
            "page": page,
            "rect": [min(r[0], r[2]), min(r[1], r[3]), max(r[0], r[2]), max(r[1], r[3])],
            "hidden": bool(flags & (AF_HIDDEN | AF_NOVIEW)),
        }
        if ftype == "radio":
            on = _widget_on_state(w)
            if on is not None:
                display = _radio_display_value(field, on)
                if display in options:
                    entry["option"] = display
        out.append(entry)
    return out


def _widget_actions(pdf: pikepdf.Pdf, field: _Field) -> dict:
    """``{trigger: classified action}`` for a field, through the one
    classifier (`engine.fieldactions`) the writer's inverse also uses.

    A field's data actions are reported for EVERY trigger it carries, not
    only the pushbutton activation the fill overlay used to read: an action
    on mouse-enter is an action the author wrote, and one this app runs.
    """
    return fieldactions.read_actions(pdf, field.obj)


# ── Field scripts (/AA) and the calculation order (/CO) ───────────────────
#
# The four FIELD additional-action triggers, in the order a commit runs them:
# keystroke (may reject or rewrite), validate (may reject), calculate (writes
# this field from others), format (produces the display string). Every other
# /AA key is a widget trigger and carries no value semantics.
_TRIGGERS = {"/K": "K", "/V": "V", "/C": "C", "/F": "F"}


def _field_action_sources(field: _Field) -> dict:
    """{trigger: raw /JS text} for the field's `/AA`. An action whose `/S` is
    not `/JavaScript` carries no script and is not one."""
    aa = field.obj.get("/AA")
    if aa is None or not isinstance(aa, pikepdf.Dictionary):
        return {}
    out: dict = {}
    for key, trigger in _TRIGGERS.items():
        action = aa.get(key)
        if action is None or not isinstance(action, pikepdf.Dictionary):
            continue
        try:
            if str(action.get("/S")) != "/JavaScript":
                continue
        except Exception:
            continue
        js = decode_js(action)
        if js is not None:
            out[trigger] = js
    return out


def _field_scripts(field: _Field) -> tuple[dict, list[str]]:
    """({trigger: recognized script}, [triggers this app does not run]).

    A script the recognizer does not accept keeps its `/JS` bytes untouched
    and is reported by name; the rest of the form still calculates.
    """
    scripts: dict = {}
    not_run: list[str] = []
    for trigger, js in _field_action_sources(field).items():
        script = recognize(js)
        if script is None or afcalc.unrunnable(script):
            not_run.append(trigger)
        else:
            scripts[trigger] = script
    return scripts, not_run


def _calculation_order(pdf: pikepdf.Pdf) -> list[str]:
    """`/CO` as fully-qualified names, in the order the document declares.

    One reader for the key that `acroform.py` carries and `form_authoring.py`
    writes — a second answer to "what order does this document declare" is a
    second answer to what its Total is.
    """
    return calculation_order_names(pdf)


def _calc_value(field: _Field, ftype: str) -> str:
    """A field's current value as the evaluator sees it — the raw text, never
    a formatted display string, which would corrupt the next calculation."""
    value = _field_value(field, ftype)
    if isinstance(value, bool):
        return "Yes" if value else "Off"
    if isinstance(value, list):
        return value[0] if value else ""
    return str(value) if value is not None else ""


def read_form_fields(file: str) -> dict:
    """Enumerate AcroForm fields (read-only)."""
    with pikepdf.open(file) as pdf:
        annot_map, page_map = _page_index_maps(pdf)
        order = _calculation_order(pdf)
        calculated = set(order)
        fields = []
        for field in _all_fields(pdf):
            ftype = _classify(field)
            if ftype == "radio":
                options = _radio_display_options(field)
            elif ftype in ("dropdown", "optionlist"):
                options = _options(field)
            else:
                options = []
            entry = {
                "name": field.name,
                "type": ftype,
                "value": _field_value(field, ftype),
                "read_only": bool(field.flags & FF_READ_ONLY),
                "required": bool(field.flags & FF_REQUIRED),
                # /TU — what assistive technology announces at this field. The
                # accessibility checker reads it from here, and the Forms panel
                # authors it; empty means the field has none, which is the
                # finding rather than an absence of information.
                "description": _field_description(field),
                # Per-widget page+rect (+hidden, +radio option) so the
                # engine read can drive the on-canvas overlay
                # and nested widgets list with geometry.
                "widgets": _widget_geometry(field, ftype, options, annot_map, page_map),
            }
            if ftype == "text":
                entry["multiline"] = bool(field.flags & FF_MULTILINE)
            if ftype in ("radio", "dropdown", "optionlist"):
                entry["options"] = options
            if ftype == "signature":
                # The overlay badges a signed vs empty signature field.
                entry["filled"] = field.attr("/V") is not None
                # The seed an unsigned field carries binds whoever signs it
                # later, so the preparer surface reads it from here.
                entry["lock"] = lock_of_field_dict(field.obj)
            # The data actions this field carries, by trigger — the /AA and
            # /A kinds that are not scripts, so all of them can be both
            # reported and run without a JavaScript engine.
            data_actions = _widget_actions(pdf, field)
            if data_actions:
                entry["field_actions"] = data_actions
            # The field's own scripts, as RAW /JS text: the renderer runs its
            # own recognizer over these (the twin), and the two are pinned
            # against tests/fixtures/af-corpus.json. `scripts_not_run` is this
            # side's verdict, so a panel can report the refusal by name without
            # re-deriving it.
            sources = _field_action_sources(field)
            if sources:
                entry["actions"] = sources
                _, not_run = _field_scripts(field)
                if not_run:
                    entry["scripts_not_run"] = not_run
            if field.name in calculated:
                entry["calculated"] = True
            fields.append(entry)
        return {
            "has_xfa": _has_xfa(pdf),
            "fields": fields,
            "count": len(fields),
            # The declared calculation order. Empty means calculations do not
            # run — see `_calculation_order`.
            "calculation_order": order,
        }


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
    stream's own /Resources only, never under the original name or in shared
    /DR. Registering Helvetica as e.g. "TiRo" in /DR renders the wrong face
    while claiming the
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
    embedded font's own metric on the Unicode path."""
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


def _fit_font_size(
    text: str,
    multiline: bool,
    w: float,
    h: float,
    width_em=text_width_em,
    wrap=_wrap_lines,
    cross_em: float = GLYPH_HEIGHT_EM,
) -> float:
    """Auto-size (DA size 0): largest size that fits the box, pdf-lib-style
    downward scan, floored at MIN_FONT_SIZE. `width_em` as in `_wrap_lines`.

    `w` is the extent along the READING axis and `h` the extent across it,
    which is what lets a column run this same scan with the two swapped:
    its wrap and its perpendicular metric are the only axis-dependent terms
    and both arrive as arguments. The defaults are the shipped horizontal
    ones, so the line path is unchanged by construction."""
    size = min(DEFAULT_FONT_SIZE * 2, h - 2 * TEXT_PAD)
    size = max(size, MIN_FONT_SIZE)
    while size > MIN_FONT_SIZE:
        if multiline:
            lines = wrap(text, size, w - 2 * TEXT_PAD, width_em)
            needed = len(lines) * size * LINE_SPACING
            widest = max((width_em(ln) * size for ln in lines), default=0.0)
            if needed <= h - 2 * TEXT_PAD and widest <= w - 2 * TEXT_PAD:
                return size
        else:
            if (
                width_em(text) * size <= w - 2 * TEXT_PAD
                and size * cross_em <= h - 2 * TEXT_PAD
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


def _unicode_face(font_dir: str, da: str | None, value: str = "") -> str | None:
    """The bundled fallback .ttf to embed for a non-WinAnsi value, by the /DA
    family. None when no fonts DIR is available (→ the value is refused, never
    crashed): a missing/non-directory path fails safe here rather than letting
    `_face_missing`/`build_fallback_font` raise on a bogus path later."""
    if not font_dir or not Path(font_dir).is_dir():
        return None
    from engine.font_fallback import resolve_fallback_font, synthetic_family_font

    try:
        # The VALUE drives the CJK step — a CJK form value lands on
        # the CJK-capable face instead of the coverage refusal.
        # And the right-to-left step, opted into because the appearance
        # builder below now reorders and shapes. Opting in without that would
        # turn an honest "cannot express" into a field drawn backwards.
        from engine import bidi

        return resolve_fallback_font(
            font_dir, synthetic_family_font(_family_for_da(da)), text=value or None,
            rtl_ok=bidi.has_strong_rtl(value or ""),
        )
    except (ValueError, OSError):
        return None


def _da_writes_vertically(pdf: pikepdf.Pdf, da: str | None) -> bool:
    """Whether the /DA-requested /DR font's CMap writes DOWN the page.

    The format states a field's writing mode in exactly one place — the CMap
    its /DA font is encoded with — so that is where this reads it. A
    predefined vertical CMap is named `…-V`; an embedded one carries
    /WMode 1. Everything else, a missing /DR entry included, is horizontal:
    a field is never guessed into a column."""
    requested, _size, _color = _parse_da(da)
    acro = _acroform(pdf)
    if acro is None:
        return False
    try:
        dr = acro.get("/DR")
        fonts = dr.get("/Font") if isinstance(dr, Dictionary) else None
        font = fonts.get(Name("/" + requested)) if isinstance(fonts, Dictionary) else None
        if font is None:
            return False
        encoding = font.get("/Encoding")
    except (AttributeError, TypeError, ValueError):
        return False
    if encoding is None:
        return False
    if isinstance(encoding, pikepdf.Stream):
        try:
            return int(encoding.get("/WMode", 0)) == 1
        except (TypeError, ValueError):
            return False
    return str(encoding).endswith("-V")


def _vertical_field_face(font_dir: str, da: str | None, value: str) -> str | None:
    """The bundled face a VERTICAL field's value draws through, or None when
    nothing bundled can draw it.

    Resolved through the shared vertical ladder and WITHOUT embedding
    anything, so the fill's "report every problem, then mutate nothing"
    atomicity holds for a column exactly as it does for a Unicode line."""
    if not font_dir or not Path(font_dir).is_dir():
        return None
    from engine.text_authoring import resolve_writing, vertical_face

    drawn = flatten_control_chars(value, keep_newline=True)
    try:
        _frame, columns, _vertical = resolve_writing("vertical", drawn)
        return vertical_face(font_dir, _family_for_da(da), "regular", drawn, columns)[0]
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

    A value outside WinAnsi is drawn with an EMBEDDED subsetted
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

    if _da_writes_vertically(pdf, da):
        _vertical_appearance(
            pdf, widget, value, da, multiline, quadding, font_dir, w, h, size, color
        )
        # An intentional embed, not a /DR-missing fallback — the same
        # distinction the Unicode line path draws.
        return False

    try:
        value.encode("cp1252")
        unicode_face = None
    except UnicodeEncodeError:
        unicode_face = _unicode_face(font_dir, da, value)

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
        # here (LF kept for multiline wrapping), or a validated multi-paragraph
        # value can crash inside the fill. Normalize every layout control, not
        # only newline, carriage return, and tab.
        layout_value = flatten_control_chars(value, keep_newline=True)
        # A right-to-left value shapes and reorders through the shared
        # builder; everything else keeps the shipped single-`Tj` emission
        # byte for byte. Built ONCE over the whole value so one subset
        # carries every glyph any wrapped line will draw.
        from engine import rtl_text

        rtl = rtl_text.build(pdf, unicode_face, layout_value.replace("\n", " "))
        font_name = "TxU"  # one font per appearance stream, in its own /Resources
        substituted = False  # an intentional embed, not a /DR-missing fallback
        if rtl is not None:
            font_obj = rtl.font_obj

            def width_em(s: str, _r=rtl) -> float:
                return _r.width_em(s)

            def emit(line: str, _r=rtl) -> bytes:
                # `size` is read at CALL time, after `_fit_font_size` has
                # resolved it — `Ts` is in unscaled text-space units, so a
                # mark's rise has to be scaled by the font size here rather
                # than by the Tf that follows it.
                return _r.show(line, size)
        else:
            font_obj, encode, width_1000 = build_fallback_font(
                pdf, unicode_face, layout_value.replace("\n", " ")
            )

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


def _vertical_appearance(
    pdf: pikepdf.Pdf,
    widget,
    value: str,
    da: str | None,
    multiline: bool,
    quadding: int,
    font_dir: str,
    w: float,
    h: float,
    size: float,
    color: str,
) -> None:
    """Regenerate a VERTICAL field's /AP /N — the value as columns.

    A field is vertical when its /DA font's CMap says so, which is the only
    place the format states it. Drawing such a field's value across its own
    columns is the silent degradation this replaces: the value lands where
    the form was never laid out and the document reads as neither.

    The /DR font is the SIGNAL, never the drawing face. Its CMap may be a
    predefined one whose CID tables this app does not ship, so the
    appearance embeds its own subset into its own /Resources — the honesty
    `_dr_font` already states for a substituted line font, one axis over.

    Geometry is the shared column geometry (`vertical_text`), reached
    through the writing frame at the same two boundaries the authored box
    uses: the widget box enters at `box`, each column's pen leaves at
    `matrix`. `quadding` keeps meaning alignment along the READING axis,
    which for a column is its top, middle or bottom."""
    from engine import vertical_text

    layout_value = flatten_control_chars(value, keep_newline=True)
    if not font_dir or not Path(font_dir).is_dir():
        raise ValueError(
            "this field writes vertically and no fallback font is available"
        )
    vt = vertical_text.build(
        pdf, font_dir, layout_value.replace("\n", " "),
        family=_family_for_da(da),
    )

    def wrap(text: str, at_size: float, max_length: float, _width_em=None) -> list[str]:
        return vt.wrap(text, at_size, max_length)

    if size <= 0:
        fit_value = layout_value if multiline else layout_value.replace("\n", " ")
        # The reading axis is the box's HEIGHT and the stacking axis its
        # WIDTH, so the shared scan runs with the two swapped.
        size = _fit_font_size(
            fit_value, multiline, h, w,
            width_em=vt.advance_em, wrap=wrap, cross_em=vt.cross_em,
        )

    if multiline:
        columns = vt.wrap(layout_value, size, h - 2 * TEXT_PAD)
    else:
        columns = [layout_value.replace("\n", " ")]

    l_left, l_right, l_top, _l_bottom = vt.box(0.0, 0.0, w, h)
    reading = l_right - l_left
    # The first column's centre line sits half its own width in from the
    # stacking axis' leading edge, and the pen offset states where the pen
    # is inside that width — zero for an upright column, whose /W2 position
    # vector already puts it on the centre line.
    across = (
        l_top - TEXT_PAD - vt.cross_em * size / 2.0 + vt.cross_offset_em * size
    )
    parts = [b"/Tx BMC", b"q", f"1 1 {_fmt(w - 2)} {_fmt(h - 2)} re W n".encode("ascii"), b"BT"]
    parts.append(color.encode("ascii"))
    parts.append(f"/TxV {_fmt(size)} Tf".encode("ascii"))
    for index, column in enumerate(columns):
        if not column:
            continue  # a blank column still consumes its pitch, via `index`
        length = vt.advance_em(column) * size
        if quadding == 1:
            along = l_left + (reading - length) / 2.0
        elif quadding == 2:
            along = l_right - TEXT_PAD - length
        else:
            along = l_left + TEXT_PAD
        along = max(along, l_left + TEXT_PAD)
        parts.append(vt.matrix(along, across - index * size * LINE_SPACING))
        parts.append(vt.show(column, size))
    parts.extend([b"ET", b"Q", b"EMC"])

    stream = pdf.make_stream(b"\n".join(parts))
    stream["/Type"] = Name.XObject
    stream["/Subtype"] = Name.Form
    stream["/BBox"] = pikepdf.Array([0, 0, w, h])
    stream["/Resources"] = Dictionary(Font=Dictionary({"/TxV": vt.font_obj}))
    widget["/AP"] = Dictionary(N=pdf.make_indirect(stream))
    if "/AS" in widget:
        del widget["/AS"]


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


def _text_value_problem(
    name: str, text: str, da: str | None, font_dir: str, vertical: bool = False
) -> str | None:
    """None when `text` can be DRAWN into `name`'s appearance — WinAnsi
    directly, or via an embedded Unicode font when `font_dir` provides a
    face that covers every glyph. Else the problem string. Doing the coverage
    check HERE keeps the fill's 'list ALL problems, then mutate nothing on
    failure' atomicity for the Unicode path too (the appearance writer never
    half-fills then raises).

    A VERTICAL field has no WinAnsi shortcut to take: no standard-14 face
    states a vertical advance, so every value goes through the vertical
    ladder and a value it cannot draw is refused here rather than drawn
    across the column it belongs in."""
    if vertical:
        if _vertical_field_face(font_dir, da, text) is None:
            return (
                f"value for {name} writes vertically and no available font can "
                f"draw it that way"
            )
        return None
    try:
        text.encode("cp1252")
        return None
    except UnicodeEncodeError:
        pass
    face = _unicode_face(font_dir, da, text)
    if face is None:
        return (
            f"value for {name} contains characters outside the form font's "
            f"encoding (WinAnsi) and no fallback font is available"
        )
    # Layout control chars (\t/\x0b/U+2028/…) are flattened to spaces before the
    # appearance embeds the font (below), so they must NOT count as "missing"
    # here, or a renderable value would be refused before normalization.
    missing = _face_missing(face, flatten_control_chars(text, keep_newline=True))
    if missing:
        pretty = " ".join(f"'{c}'" for c in sorted(set(missing)))
        return f"value for {name} contains characters no available font can render ({pretty})"
    return None


def _script_problem(name: str, value: str, problem) -> str:
    """A keystroke or validate rejection, worded for the batch's problem list.

    Built from the structured refusal kind the evaluator reports, never by
    matching text: the kinds are stable and the wording is not.
    """
    kind, args = problem
    if kind == "range":
        return f"{name}: {value} is outside the allowed range {args[0]}–{args[1]}"
    if kind == "min":
        return f"{name}: {value} is below the allowed minimum {args[0]}"
    if kind == "max":
        return f"{name}: {value} is above the allowed maximum {args[0]}"
    if kind == "date":
        return f'{name}: "{value}" is not a valid date in the format {args[0]}'
    if kind == "mask":
        return f'{name}: "{value}" does not match the pattern {args[0]}'
    return f'{name}: "{value}" is not a valid number'


def _in_scope(name: str, named: list | None, exclude: bool) -> bool:
    """Whether a field falls inside an action's `/Fields` scope.

    A named field covers its CHILDREN too (``Address`` covers ``Address.City``)
    -- that is what naming a hierarchy parent means -- and `/Flags` bit 1
    inverts the whole test into an exclude list. One implementation, because
    reset, submit and import all scope the same way and a second answer to
    "which fields does this act on" is a second answer to what it did.
    """
    if not named:
        return True
    hit = any(name == n or name.startswith(str(n) + ".") for n in named)
    return hit != bool(exclude)


def form_data_values(
    pdf: pikepdf.Pdf,
    fields: list | None = None,
    exclude: bool = False,
    include_empty: bool = False,
) -> dict:
    """``{field name: value}`` for a submission or an export.

    Buttons and signatures carry no submittable value and are never included.
    An empty field is left out unless ``include_empty`` says the receiver
    wants to see it, which is what `/SubmitForm`'s IncludeNoValueFields bit
    asks for.
    """
    out: dict = {}
    for field in _all_fields(pdf):
        ftype = _classify(field)
        if ftype in ("button", "signature", "unknown"):
            continue
        if not _in_scope(field.name, fields, exclude):
            continue
        value = _field_value(field, ftype)
        empty = value in (None, "", False) or (isinstance(value, list) and not value)
        if empty and not include_empty:
            continue
        out[field.name] = "" if value is None else value
    return out


def export_form_data(
    file: str,
    output: str,
    format: str = "fdf",
    fields: list | None = None,
    exclude: bool = False,
    include_empty: bool = False,
    source: str = "",
) -> dict:
    """Write this document's field values as FDF, XFDF, HTML or the PDF itself.

    This is the whole of `/SubmitForm` except the request. **Nothing is sent.**
    The app performs no outbound request and opens no external address; the
    submission lands in a file the caller names and the destination is
    reported back so a human can complete it.

    ``format`` ``pdf`` copies the document, which is what SubmitPDF means.
    """
    fmt = str(format or "fdf")
    if fmt not in formdata.FORMAT_EXTENSION:
        raise ValueError(
            f"unknown submission format {fmt}; expected one of "
            f"{', '.join(sorted(formdata.FORMAT_EXTENSION))}"
        )
    output_path = Path(output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    if fmt == "pdf":
        if Path(file).resolve() != output_path.resolve():
            shutil.copyfile(file, output_path)
        return {"output": str(output_path), "format": fmt, "count": 0}
    with pikepdf.open(file) as pdf:
        values = form_data_values(pdf, fields, exclude, include_empty)
    name = source or Path(file).name
    if fmt == "fdf":
        payload = formdata.write_fdf(values, name)
    elif fmt == "xfdf":
        payload = formdata.write_xfdf_fields(values, name)
    else:
        payload = formdata.write_html_form_data(values)
    output_path.write_bytes(payload)
    return {"output": str(output_path), "format": fmt, "count": len(values)}


def import_form_data(
    file: str,
    output: str,
    data: str = "",
    fields: list | None = None,
    exclude: bool = False,
    font_dir: str = "",
) -> dict:
    """Fill this document from an FDF or XFDF data file.

    `/ImportData`'s honest half. The data file is read from the LOCAL path the
    caller names -- never from the path the action itself carries, which is
    the document telling the app to open a file the user never chose.

    A name the document does not have is REPORTED, not fatal: a data file
    written for a revision of the form is the ordinary case, and refusing the
    whole import over one stale name would lose every value that does fit.
    Implemented as a delegated fill, so the import inherits keystroke
    validation, the calculation pass, appearance regeneration and signature
    preservation without a second implementation to drift.
    """
    if not str(data or "").strip():
        raise ValueError("Name the form-data file to import.")
    values = formdata.parse_form_data(str(data))
    with pikepdf.open(file) as pdf:
        known: dict = {}
        for field in _all_fields(pdf):
            known[field.name] = _classify(field)
    edits: dict = {}
    unknown: list[str] = []
    skipped: list[str] = []
    for name, value in values.items():
        ftype = known.get(name)
        if ftype is None:
            unknown.append(name)
            continue
        if ftype in ("button", "signature", "unknown"):
            skipped.append(name)
            continue
        if not _in_scope(name, fields, exclude):
            continue
        if ftype == "checkbox":
            edits[name] = str(value).strip().lower() not in ("", "off", "false", "no", "0")
        elif ftype == "optionlist":
            edits[name] = value if isinstance(value, list) else [str(value)]
        else:
            edits[name] = value[0] if isinstance(value, list) and value else (
                "" if isinstance(value, list) else str(value)
            )
    if not edits:
        if Path(file).resolve() != Path(output).resolve():
            shutil.copyfile(file, output)
        out = {"output": str(output), "imported": 0}
        if unknown:
            out["unknown"] = unknown
        if skipped:
            out["skipped"] = skipped
        return out
    result = fill_form_fields(file, output, edits, font_dir=font_dir)
    out = {"output": result["output"], "imported": result["filled"]}
    if unknown:
        out["unknown"] = unknown
    if skipped:
        out["skipped"] = skipped
    for key in ("calculated", "scripts_not_run", "signatures_preserved"):
        if result.get(key):
            out[key] = result[key]
    return out


def set_widget_visibility(
    file: str,
    output: str,
    targets: list | None = None,
    hide: bool = True,
) -> dict:
    """Show or hide the widgets of the named fields -- the `/Hide` action.

    A visibility change is a real change to the document, not view state: the
    page raster is drawn from the file's own annotations, so a widget hidden
    only in a viewer's memory is still on the page every other reader sees.
    It is written as the annotation `/F` Hidden bit, which is exactly what
    `/Hide` means, and the caller's undo covers it like any other edit.
    """
    names = [str(n) for n in (targets or []) if str(n).strip()]
    if not names:
        raise ValueError("Name the form fields to show or hide.")
    input_path = Path(file)
    output_path = Path(output)
    same_file = input_path.resolve() == output_path.resolve()
    changed = 0
    missing: list[str] = []
    with pikepdf.open(file) as pdf:
        by_name = {f.name: f for f in _all_fields(pdf)}
        acted: list[str] = []
        for name in names:
            field = by_name.get(name)
            if field is None:
                missing.append(name)
                continue
            acted.append(name)
            changed += fieldactions.set_widget_hidden(field.obj, bool(hide))
        if missing and not acted:
            raise ValueError(
                "this document has no form field named " + ", ".join(missing)
            )
        if same_file:
            with tempfile.NamedTemporaryFile(
                suffix=".pdf", delete=False, dir=str(input_path.parent)
            ) as tmp:
                staged = tmp.name
            save_pdf(pdf, staged)
        else:
            output_path.parent.mkdir(parents=True, exist_ok=True)
            save_pdf(pdf, output_path)
    if same_file:
        shutil.move(staged, str(output_path))
    out = {"output": str(output_path), "changed": changed, "hidden": bool(hide)}
    if missing:
        out["missing"] = missing
    return out


def reset_form_fields(
    file: str,
    output: str,
    fields: list | None = None,
    exclude: bool = False,
    font_dir: str = "",
) -> dict:
    """ResetForm: restore fields to their /DV defaults, else clear them.

    ``fields`` scopes the reset by fully-qualified name (a name also covers
    its children); ``exclude=True`` inverts it to everything-but — the two
    shapes /ResetForm's /Fields + /Flags bit 1 encode. Buttons, signatures,
    and read-only fields are never touched (the spec's own boundary).

    Implemented as a DELEGATED FILL with DV-derived values — one setter
    machinery, so reset inherits appearance regeneration, per-widget
    checkbox on-states, choice clearing, Unicode handling, and signature
    preservation without a second implementation to drift.
    """
    named = [str(n) for n in fields] if fields else None

    def _chosen(name: str) -> bool:
        return _in_scope(name, named, exclude)

    values: dict = {}
    skipped_bad_dv: list[str] = []
    with pikepdf.open(file) as pdf:
        for f in _all_fields(pdf):
            ftype = _classify(f)
            if ftype in ("button", "signature", "unknown"):
                continue
            if f.flags & FF_READ_ONLY:
                continue
            if not _chosen(f.name):
                continue
            dv = f.attr("/DV")
            try:
                if ftype == "text":
                    values[f.name] = str(dv) if dv is not None else ""
                elif ftype == "checkbox":
                    values[f.name] = dv is not None and str(dv) != "/Off"
                elif ftype == "radio":
                    values[f.name] = (
                        str(dv)[1:] if isinstance(dv, pikepdf.Name) and str(dv) != "/Off" else ""
                    )
                elif ftype == "optionlist":
                    if isinstance(dv, pikepdf.Array):
                        values[f.name] = [str(x) for x in dv]
                    elif dv is not None:
                        values[f.name] = [str(dv)]
                    else:
                        values[f.name] = []
                else:  # dropdown
                    values[f.name] = str(dv) if dv is not None else ""
            except Exception:
                skipped_bad_dv.append(f.name)

    if not values:
        # Nothing to reset is a RESULT (the button did its job on an empty
        # scope), not an error — but the output must still exist.
        if Path(file).resolve() != Path(output).resolve():
            shutil.copyfile(file, output)
        return {"output": str(output), "reset": 0}

    result = fill_form_fields(file, output, values, font_dir=font_dir)
    out = {"output": result["output"], "reset": result["filled"]}
    if skipped_bad_dv:
        out["skipped"] = skipped_bad_dv
    if result.get("signatures_preserved"):
        out["signatures_preserved"] = True
    return out


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
        font_dir: the bundled fallback-fonts directory. When
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
                # The "list all problems" contract includes every appearance
                # encoding failure so multiple bad fields report together. A
                # non-WinAnsi value is fillable via an embedded Unicode font
                # when `font_dir` covers it, else refused here.
                fda = _field_da(field, acro)
                prob = _text_value_problem(
                    name, text, fda, font_dir, _da_writes_vertically(pdf, fda)
                )
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
                if str(value) == "":
                    plan.append((field, ftype, _CLEAR))  # deliberate de-selection
                else:
                    state = _radio_state_for(field, str(value))
                    if state is None:
                        opts = ", ".join(_radio_display_options(field))
                        problems.append(f"radio {name} has no option {value!r} (options: {opts})")
                    else:
                        plan.append((field, ftype, state))
            elif ftype == "optionlist" and isinstance(value, (list, tuple)):
                # A multi-select list box — every element must be an option;
                # store /V as the export array + /I as the selected indices.
                if len(value) == 0:
                    plan.append((field, ftype, _CLEAR))  # nothing selected
                    continue
                pairs: list[tuple[str, int]] = []
                bad: list[str] = []
                for v in value:
                    ei = _option_export_index(field, str(v))
                    if ei is None:
                        bad.append(str(v))
                    else:
                        pairs.append(ei)
                if bad:
                    opts = ", ".join(_options(field))
                    problems.append(f"optionlist {name} has no option(s) {bad} (options: {opts})")
                else:
                    # The appearance draws the selected exports (one per line);
                    # coverage-check that combined text.
                    joined = "\n".join(e for e, _i in pairs)
                    fda = _field_da(field, acro)
                    prob = _text_value_problem(
                        name, joined, fda, font_dir, _da_writes_vertically(pdf, fda)
                    )
                    if prob is not None:
                        problems.append(prob)
                    else:
                        plan.append((field, ftype, pairs))
            elif ftype in ("dropdown", "optionlist"):
                editable = bool(field.flags & FF_EDIT) and ftype == "dropdown"
                if str(value) == "" and not editable:
                    plan.append((field, ftype, _CLEAR))  # de-select a fixed choice
                    continue
                export = _option_export(field, str(value))
                if export is None and not editable:
                    opts = ", ".join(_options(field))
                    problems.append(f"{ftype} {name} has no option {value!r} (options: {opts})")
                else:
                    chosen = export if export is not None else str(value)
                    fda = _field_da(field, acro)
                    prob = _text_value_problem(
                        name, chosen, fda, font_dir, _da_writes_vertically(pdf, fda)
                    )
                    if prob is not None:
                        problems.append(prob)
                    else:
                        plan.append((field, ftype, chosen))
            else:
                problems.append(f"field {name} has type {ftype!r}, which is not fillable")

        # ── the field-script pass ─────────────────────────────────────────
        #
        # Keystroke and validate run over the caller's values BEFORE anything
        # is stored, so a rejected value never triggers a recalculation and
        # every problem is reported with the rest. The calculation then runs
        # once over `/CO`, and its results form a SECOND, DERIVED plan half —
        # structurally separate, never a flag threaded through the plan above,
        # because that separation IS the scope of the read-only bypass below.
        scripts_by_name: dict = {}
        scripts_not_run: list[str] = []
        for name, field in fields.items():
            entry, not_run = _field_scripts(field)
            if entry:
                scripts_by_name[name] = entry
            if not_run:
                scripts_not_run.append(name)
        order = _calculation_order(pdf)
        terminals = list(fields.keys())

        checked: list[tuple[_Field, str, object]] = []
        for field, ftype, value in plan:
            entry = scripts_by_name.get(field.name, {})
            if not isinstance(value, str) or not entry:
                checked.append((field, ftype, value))
                continue
            stored = value
            rejected = False
            for trigger in ("K", "V"):
                script = entry.get(trigger)
                if script is None:
                    continue
                try:
                    event = afcalc.run(script, stored)
                except afcalc.Unsupported:
                    if field.name not in scripts_not_run:
                        scripts_not_run.append(field.name)
                    continue
                if not event.rc:
                    problems.append(_script_problem(field.name, stored, event.problem))
                    rejected = True
                    break
                stored = afcalc.as_stored(event.value)
            if not rejected:
                checked.append((field, ftype, stored))
        plan = checked

        values_now = {name: _calc_value(f, _classify(f)) for name, f in fields.items()}
        for field, _ftype, value in plan:
            if isinstance(value, str):
                values_now[field.name] = value
        recalculated = afcalc.calculate(values_now, scripts_by_name, order, terminals)

        planned = {field.name for field, _t, _v in plan}
        derived: list[tuple[_Field, str, str]] = []
        calc_skipped: list[str] = []
        for name, value in recalculated.items():
            field = fields.get(name)
            if field is None:
                continue
            ftype = _classify(field)
            if ftype not in ("text", "dropdown"):
                # A calculation into a checkbox or a radio has no value shape
                # to write. Counted, never silently dropped.
                calc_skipped.append(name)
                continue
            if name in planned:
                plan = [(f, t, value if f.name == name else v) for f, t, v in plan]
            else:
                # Read-only means "the user may not type here", not "the
                # document may not compute here": a calculated Total is
                # routinely read-only and the reference computes into it. The
                # bypass is scoped to fields reached through /CO, which is
                # exactly what this list contains. A caller who NAMES a
                # read-only field still refuses, above.
                derived.append((field, ftype, value))

        # The appearance draws the FORMATTED value while /V keeps the raw one.
        display: dict[str, str] = {}
        for field, _ftype, value in [*plan, *derived]:
            if not isinstance(value, str):
                continue
            script = scripts_by_name.get(field.name, {}).get("F")
            if script is None:
                continue
            try:
                shown = afcalc.format_display(script, value)
            except afcalc.Unsupported:
                if field.name not in scripts_not_run:
                    scripts_not_run.append(field.name)
                continue
            display[field.name] = shown
            fda = _field_da(field, acro)
            prob = _text_value_problem(
                field.name, shown, fda, font_dir, _da_writes_vertically(pdf, fda)
            )
            if prob is not None:
                problems.append(prob)
        for field, _ftype, value in derived:
            if field.name in display:
                continue
            fda = _field_da(field, acro)
            prob = _text_value_problem(
                field.name, value, fda, font_dir, _da_writes_vertically(pdf, fda)
            )
            if prob is not None:
                problems.append(prob)

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
        for field, ftype, value in [*plan, *derived]:
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
                        # field. Gating on one cached name leaves sibling
                        # widgets visually unchecked.
                        widget_on = _widget_on_state(widget) or on
                        widget["/AS"] = Name("/" + widget_on)
                    else:
                        widget["/AS"] = Name("/Off")
            elif ftype == "radio":
                if value is _CLEAR:
                    field.obj["/V"] = Name("/Off")
                    for widget in field.widgets:
                        widget["/AS"] = Name("/Off")
                else:
                    field.obj["/V"] = Name("/" + str(value))
                    for widget in field.widgets:
                        widget["/AS"] = (
                            Name("/" + str(value))
                            if _widget_on_state(widget) == str(value)
                            else Name("/Off")
                        )
            else:  # text / dropdown / optionlist
                if value is _CLEAR:
                    # De-select: drop /V and /I, blank the appearance.
                    if "/V" in field.obj:
                        del field.obj["/V"]
                    if "/I" in field.obj:
                        del field.obj["/I"]
                    appearance_text = ""
                    multiline = False
                elif isinstance(value, list):
                    # Multi-select list box: value = [(export, /Opt index)].
                    exports = [e for e, _i in value]
                    indices = sorted(i for _e, i in value if i >= 0)
                    # A multi-value /V requires the MultiSelect flag or the field
                    # is non-conforming. pdf-lib promotes it automatically.
                    if len(exports) > 1 and not (field.flags & FF_MULTISELECT):
                        field.obj["/Ff"] = int(field.flags) | FF_MULTISELECT
                    field.obj["/V"] = pikepdf.Array([pikepdf.String(e) for e in exports])
                    if indices:
                        field.obj["/I"] = pikepdf.Array(indices)
                    elif "/I" in field.obj:
                        del field.obj["/I"]
                    appearance_text = "\n".join(exports)  # one selected item per line
                    multiline = True
                else:
                    # /V holds the RAW value and /AP draws the FORMATTED one.
                    # A fill that stored the formatted string would corrupt
                    # the value for the next calculation that reads it.
                    field.obj["/V"] = pikepdf.String(str(value))
                    appearance_text = display.get(field.name, str(value))
                    if "/I" in field.obj:
                        del field.obj["/I"]
                    multiline = ftype == "text" and bool(field.flags & FF_MULTILINE)
                try:
                    for widget in field.widgets:
                        if _text_appearance(
                            pdf, widget, appearance_text, da, multiline, quadding, font_dir
                        ):
                            if field.name not in fonts_substituted:
                                fonts_substituted.append(field.name)
                except ValueError as exc:
                    raise ValueError(
                        f"couldn't regenerate the appearance for {field.name}: {exc}"
                    ) from None
            filled += 1
        # The caller's own fields; the recalculated ones are reported apart so
        # a count of "what the user changed" stays what it was.
        filled -= len(derived)

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
            save_pdf(pdf, tmp_path)
        else:
            save_pdf(pdf, output_path)

    # Filling a SIGNED document lands as an incremental append —
    # original bytes verbatim + one revision carrying the value/appearance
    # updates, so existing signatures keep verifying. Flatten removes widgets,
    # which the
    # transplant refuses by design; that path keeps today's rewrite (a
    # flatten inherently destroys what the signature covers).
    from engine.incremental import finalize_preserving_signatures

    landed = tmp_path if same_file else str(output_path)
    preserved = finalize_preserving_signatures(str(input_path), landed)

    if same_file:
        shutil.move(tmp_path, str(output_path))

    result = {
        "output": str(output_path),
        "filled": filled,
        "flattened": flattened,
        "xfa_stripped": xfa_stripped,
        # Fields whose /DA named a font missing from /DR — their appearances
        # render (honestly) in Helvetica. Surfaced, never silent.
        "fonts_substituted": fonts_substituted,
    }
    if derived:
        # Fields the DOCUMENT computed rather than the caller naming them.
        result["calculated"] = [f.name for f, _t, _v in derived]
    if calc_skipped:
        result["calculation_unwritable"] = calc_skipped
    if scripts_not_run:
        # Fields carrying a script this app does not run. Their /JS bytes are
        # untouched and every other field still calculated.
        result["scripts_not_run"] = scripts_not_run
    if preserved.get("preserved"):
        result["signatures_preserved"] = True
    return result


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
