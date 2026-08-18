"""Author new AcroForm fields into a document, by path.

The interactive canvas tier authors fields renderer-side; this is the twin the
folder and headless tiers need, in the same relationship form FILL already has
between ``lib/forms.ts`` and ``fill_form_fields``. Both halves are pinned
against a shared spec corpus, because two implementations of one rule drift the
moment nothing compares them.

A spec is the shape the renderer already speaks::

    {"name", "type", "page_index" (0-based), "rect" [x0,y0,x1,y1],
     "options": [str | {"label", "rect"}], "multiline", "comb", "max_length",
     "lock": {"action", "fields"},
     "format": {"kind", ...}, "validate": {"min", "max"},
     "calculate": {"op", "fields"} | {"sfn"}, "default_value"}

``lock`` belongs to a signature field alone and is the seed whoever signs that
field later is bound by. Its names are validated against the document AND
against the batch's own new fields: laying out a form and locking the fields
being laid out in the same pass is the ordinary case.

``format``, ``validate`` and ``calculate`` become the field's ``/AA`` scripts
-- the stock ``AF*`` call shapes, written by ``engine.afemit`` so every other
viewer executes what this app authors. A ``calculate`` also puts the field into
``/AcroForm /CO``, ordered by a topological sort over the dependency graph: a
field placed before what it reads computes a stale value everywhere. A cycle
refuses the batch by name, and so does a calculation naming a field neither the
document nor the batch has.

``default_value`` is ``/DV``: what ``reset_form_fields`` restores to.

Validation is fail-closed and PRE-mutation: every problem in the batch is
reported at once, each naming the field it belongs to, and nothing is written
until all of them pass. A batch that aborts half-way leaves a document carrying
the fields created before the throw, which is the state no caller can reason
about.

An XFA document REFUSES. A dynamic form's fields live in the XML, not in
/AcroForm, so writing an AcroForm field into one either does nothing or
destroys the form when a consumer drops the XML.
"""

from pathlib import Path

import pikepdf
from pikepdf import Array, Dictionary, Name, String

from engine import afemit, fieldactions
from engine.acroform import (
    calculation_order_names,
    form_field_forest,
    refuse_if_xfa,
    write_calculation_order,
)
from engine.document_js import _BOM_BE, decode_js
from engine.fieldmdp import lock_dictionary, validated_lock
from engine.forms import (
    FF_COMBO,
    FF_MULTILINE,
    FF_MULTISELECT,
    FF_RADIO,
    _all_fields,
)
from engine.incremental import signature_policy, signed_edit_decision
from engine.inplace import is_same_file, staged_write
from engine.pdf_save import save_pdf
from engine.validate import validate_pdf

FF_NO_TOGGLE_TO_OFF = 1 << 14
FF_COMB = 1 << 24

_MAX_PARENT_DEPTH = 32

FIELD_TYPES = ("text", "checkbox", "radio", "dropdown", "optionlist", "signature")
CHOICE_TYPES = ("radio", "dropdown", "optionlist")

#: The writing modes a FIELD may state. A field states its writing mode in
#: its /DA font's CMap (ISO 32000-2 9.7.5.1), and a CMap carries no column
#: direction, so the two explicit spellings the authored-box tier accepts
#: (`vertical-rl`, `vertical-lr`) cannot be expressed here and are refused by
#: name rather than silently narrowed to `vertical`.
FIELD_WRITING_MODES = ("horizontal", "vertical")

#: The kinds whose value is drawn as a text run. A button draws a mark from
#: ZapfDingbats and a signature field draws no value at all, so vertical
#: writing is undefined for them.
VERTICAL_FIELD_TYPES = ("text", "dropdown", "optionlist")

# The border and background every created widget carries, so a prepared field
# is visible on a page that only ever had a printed rule under it.
BORDER_WIDTH = 1.0
DEFAULT_DA = "/Helv 0 Tf 0 g"


class FieldSpecError(ValueError):
    """Every problem in a batch at once.

    ``problems`` keeps them separated so a caller can report them one per row;
    the message the bridge carries is the localizable frame around the joined
    list, which is how a multi-problem refusal stays one catalog row.
    """

    def __init__(self, message: str, problems: list[str]):
        super().__init__(message)
        self.problems = list(problems)


def _save(pdf, output_path: Path, same_file: bool) -> None:
    """Land every authoring edit in this module: a same-file write stages
    beside the document and swaps the directory entry; a distinct output has
    its parent directory created first. The Pdf is closed inside the block
    because the destination cannot be replaced while it is held open."""
    if same_file:
        with staged_write(output_path) as staged:
            save_pdf(pdf, str(staged))
            pdf.close()
    else:
        output_path.parent.mkdir(parents=True, exist_ok=True)
        save_pdf(pdf, output_path)


# ── Names already in the document ─────────────────────────────────────────


def _top_level_names(pdf: pikepdf.Pdf) -> set:
    """The /T of every top-level /AcroForm /Fields entry.

    Non-terminal hierarchy parents count: two same-/T siblings are forbidden by
    the format, and a terminal-only walk cannot see a parent node.
    """
    names = set()
    acro = pdf.Root.get("/AcroForm")
    if acro is None:
        return names
    fields = acro.get("/Fields")
    if fields is None:
        return names
    for entry in fields:
        try:
            title = entry.get("/T")
        except Exception:
            continue
        if title is not None:
            names.add(str(title))
    return names


def existing_field_names(file: str) -> set:
    """Every field name the document carries, terminal and parent alike."""
    with pikepdf.open(file) as pdf:
        names = _top_level_names(pdf)
        for field in _all_fields(pdf):
            names.add(field.name)
        return names


# ── Validation ────────────────────────────────────────────────────────────


def _options_of(spec: dict) -> list[dict]:
    out = []
    for option in spec.get("options") or []:
        if isinstance(option, dict):
            label = str(option.get("label", "")).strip()
            rect = option.get("rect")
        else:
            label = str(option).strip()
            rect = None
        if not label:
            continue
        out.append({"label": label, "rect": rect})
    return out


def _rect_of(spec, key="rect") -> tuple:
    raw = [float(v) for v in (spec.get(key) or [])]
    if len(raw) != 4:
        return ()
    x0, y0 = min(raw[0], raw[2]), min(raw[1], raw[3])
    x1, y1 = max(raw[0], raw[2]), max(raw[1], raw[3])
    return (x0, y0, x1, y1)


def _lock_of(spec: dict) -> dict | None:
    raw = spec.get("lock")
    return raw if isinstance(raw, dict) else None


def _writing_of(spec: dict) -> tuple[str, str]:
    """``(writing_mode, script)`` as the spec states them.

    An absent ``writing_mode`` is horizontal: a surface that offers no
    direction control contributes no key, which is the same shape the
    authored-box tier's writing parameters take.
    """
    mode = str(spec.get("writing_mode") or "horizontal").strip().lower()
    script = str(spec.get("script") or "").strip().lower()
    return mode, script


def _require_vertical_face(font_dir: str) -> None:
    """Refuse before anything is written when the bundled vertical face is
    out of reach. The /DR font's descriptor is read off that face, so its
    absence is a problem the batch reports with the rest rather than a throw
    from inside the write."""
    if not font_dir or not Path(font_dir).is_dir():
        raise ValueError(
            "this field writes vertically and no vertical font is available to "
            "state its metrics"
        )


def _writing_problems(spec: dict, kind: str) -> list[str]:
    """Every problem the spec's writing mode and script carry.

    Vertical writing is a property of the FONT a field's /DA names, so the
    combinations refused here are the ones no font can express: a field kind
    whose value is a mark rather than a text run, a comb field (whose cells
    divide the box across the very axis a column runs down), and a column
    direction, which a CMap does not carry.
    """
    from engine.text_authoring import VERTICAL_SCRIPTS

    mode, script = _writing_of(spec)
    problems: list[str] = []
    if mode not in FIELD_WRITING_MODES:
        if mode in ("vertical-rl", "vertical-lr"):
            problems.append(
                "a field states its writing mode in its font's CMap, which carries no "
                "column direction -- use vertical"
            )
        else:
            problems.append(f"unknown writing mode {mode or '(none)'}")
        return problems
    if mode == "horizontal":
        if script:
            problems.append(
                "a script names the character collection a vertical field's font is "
                "bound to, and this field writes horizontally"
            )
        return problems
    if kind not in VERTICAL_FIELD_TYPES:
        problems.append(
            f"a {kind or '(none)'} field draws a mark rather than a text run, so it "
            "has no writing mode"
        )
    if not script:
        problems.append(
            "a vertical field needs the script naming the character collection its "
            "font is bound to"
        )
    elif script not in VERTICAL_SCRIPTS:
        allowed = ", ".join(sorted(VERTICAL_SCRIPTS))
        problems.append(f"unknown script {script} (the scripts are: {allowed})")
    if kind == "text" and spec.get("comb"):
        problems.append(
            "a comb field divides its box across the axis a column runs down, so it "
            "cannot also write vertically"
        )
    return problems


# ── Field actions (/AA), the calculation order (/CO) and /DV ──────────────


def _dict_of(spec: dict, key: str) -> dict | None:
    raw = spec.get(key)
    return raw if isinstance(raw, dict) else None


def _calculate_of(spec: dict) -> dict | None:
    return _dict_of(spec, "calculate")


def _existing_calculations(pdf: pikepdf.Pdf) -> tuple[list, dict]:
    """The document's own ``/CO`` order and, for each entry, the names its
    calculate script reads. An entry whose script this app does not recognize
    contributes no edge: nothing here can say what it reads.
    """
    order = calculation_order_names(pdf)
    forest = form_field_forest(pdf)
    inputs: dict = {}
    for name in order:
        node = forest.get(name)
        if node is None:
            continue
        aa = node.get("/AA")
        if aa is None or not isinstance(aa, Dictionary):
            continue
        action = aa.get("/C")
        if action is None or not isinstance(action, Dictionary):
            continue
        js = decode_js(action)
        if js is not None:
            inputs[name] = afemit.script_inputs(js)
    return order, inputs


def _batch_calculations(specs: list) -> list:
    """``[(name, [input names])]`` for every spec that carries a calculation,
    in authoring order — the batch half of the topological sort."""
    entries = []
    for spec in specs:
        if not isinstance(spec, dict):
            continue
        calc = _calculate_of(spec)
        name = str(spec.get("name", "")).strip()
        if calc is None or not name:
            continue
        try:
            entries.append((name, afemit.calculate_inputs(calc)))
        except afemit.EmitError:
            # The emission problem is reported on its own row; an unreadable
            # calculation contributes no ordering edge.
            continue
    return entries


def _js_object(pdf: pikepdf.Pdf, js: str):
    """A ``/JavaScript`` action carrying this body.

    ASCII rides as a PDF string, which is what the ecosystem writes and what
    keeps a stock call byte-identical to the same call from any other producer.
    Anything else -- a currency symbol, a mask carrying an accented literal --
    goes as a UTF-16BE stream, the convention ``document_js.py`` already uses.
    """
    try:
        js.encode("ascii")
    except UnicodeEncodeError:
        body = pdf.make_stream(_BOM_BE + js.encode("utf-16-be"))
    else:
        body = String(js)
    return pdf.make_indirect(Dictionary(S=Name("/JavaScript"), JS=body))


#: Which value triggers each spec member owns. A caller that does not address
#: a member leaves its triggers alone -- writing a button's action must not
#: silently destroy a calculation the caller never mentioned.
_MEMBER_TRIGGERS = {"format": ("F", "K"), "validate": ("V",), "calculate": ("C",)}

#: Every value trigger, for the create path, where there is nothing to
#: preserve.
ALL_VALUE_TRIGGERS = ("F", "K", "V", "C")


def _apply_actions(pdf: pikepdf.Pdf, field, spec: dict, addressed=ALL_VALUE_TRIGGERS) -> None:
    """Write the spec's ``/AA`` scripts and ``/DV`` onto a field dictionary.

    Every ADDRESSED trigger is REPLACED wholesale and every other key of an
    existing ``/AA`` is left alone: a widget trigger (``/E``, ``/U``) is not
    this door's business, a spec that no longer carries a format must not leave
    the old format's ``/F`` behind, and a trigger nobody addressed must not
    lose the script it already had.
    """
    scripts = afemit.emitted_scripts(spec)
    aa = field.get("/AA")
    if not isinstance(aa, Dictionary):
        aa = None
    for trigger in ALL_VALUE_TRIGGERS:
        if trigger not in addressed:
            continue
        key = "/" + trigger
        if trigger in scripts:
            if aa is None:
                aa = Dictionary()
                field["/AA"] = aa
            aa[key] = _js_object(pdf, scripts[trigger])
        elif aa is not None and key in aa:
            del aa[key]
    if aa is not None and len(aa.keys()) == 0:
        del field["/AA"]
    if "default_value" in spec:
        _apply_default(field, spec)


def _apply_default(field, spec: dict) -> None:
    """``/DV`` -- the value ``reset_form_fields`` restores to. None removes it,
    so "this field defaults to nothing" is a value rather than an operation."""
    value = spec.get("default_value")
    if value is None:
        if field.get("/DV") is not None:
            del field["/DV"]
        return
    kind = str(spec.get("type", "")) or _kind_of_field(field)
    if kind in ("checkbox", "radio"):
        name = "/Off"
        if kind == "checkbox":
            name = "/Yes" if value is True or str(value) not in ("", "Off", "false") else "/Off"
        else:
            name = "/" + str(value) if str(value) else "/Off"
        field["/DV"] = Name(name)
        return
    if isinstance(value, list):
        field["/DV"] = Array([String(str(v)) for v in value])
        return
    field["/DV"] = String(str(value))


def _kind_of_field(field) -> str:
    ft = _effective_ft(field)
    if ft == "/Btn":
        return "radio" if int(field.get("/Ff", 0)) & FF_RADIO else "checkbox"
    if ft == "/Ch":
        return "dropdown" if int(field.get("/Ff", 0)) & FF_COMBO else "optionlist"
    if ft == "/Sig":
        return "signature"
    return "text"


def _action_problems(spec: dict, kind: str) -> list:
    """Every problem the spec's format/validate/calculate carries, in the
    engine's own English. The emitter states the condition; the type rules are
    this module's, because they are about what a field can hold."""
    problems: list = []
    for key, allowed, label in (
        ("format", afemit.FORMAT_TYPES, "a format"),
        ("validate", afemit.VALIDATE_TYPES, "a range check"),
        ("calculate", afemit.CALCULATE_TYPES, "a calculation"),
    ):
        if spec.get(key) is None:
            continue
        if kind not in allowed:
            problems.append(
                f"{label} belongs to a {' or '.join(allowed)} field, not a {kind or '(none)'} field"
            )
    if spec.get("default_value") is not None and kind == "signature":
        problems.append("a signature field has no default value")
    try:
        afemit.emitted_scripts(spec)
    except afemit.EmitError as exc:
        problems.extend(exc.problems)
    return problems


def _drawable_problems(options: list, font_dir: str) -> list[str]:
    """Every option label a list box's appearance could not draw.

    Each label on its OWN: the emitter picks a font per row, so a list whose
    Korean and Greek rows no single bundled face covers still draws.
    """
    from engine.forms import _text_value_problem

    problems: list[str] = []
    for option in options:
        label = str(option.get("label", ""))
        if _text_value_problem("this option list", label, DEFAULT_DA, font_dir) is not None:
            problems.append(
                f"option {label!r} is outside the built-in font's encoding and no "
                "font is available to embed for it"
            )
    return problems


def _validate(pdf: pikepdf.Pdf, specs: list, font_dir: str = "") -> None:
    problems: list[str] = []
    taken = _top_level_names(pdf)
    for field in _all_fields(pdf):
        taken.add(field.name)
    # What a lock may name: the document's fields plus the batch's own, since a
    # form laid out in one pass locks the fields laid out with it.
    lockable = set(taken) | {
        str(s.get("name", "")).strip()
        for s in specs
        if isinstance(s, dict) and str(s.get("name", "")).strip()
    }
    page_count = len(pdf.pages)
    batch = len(specs) > 1

    for index, spec in enumerate(specs):
        if not isinstance(spec, dict):
            problems.append(f"field {index + 1}: not a field description")
            continue
        name = str(spec.get("name", "")).strip()
        label = name or f"#{index + 1}"

        def problem(text: str) -> None:
            problems.append(f"{label}: {text}" if batch else text)

        kind = str(spec.get("type", ""))
        if kind not in FIELD_TYPES:
            problem(f"unknown field type {kind or '(none)'}")
        if not name:
            problem("a field needs a name")
        # '.' separates a parent from its child in a field's fully qualified
        # name, so a name carrying one would create a hierarchy nobody asked
        # for.
        if "." in name:
            problem("a field name cannot contain a dot")
        page_index = spec.get("page_index")
        if not isinstance(page_index, int) or page_index < 0 or page_index >= page_count:
            got = page_index if isinstance(page_index, int) else "(none)"
            problem(f"page {got} is outside this document ({page_count} pages)")
        rect = _rect_of(spec)
        if not rect or rect[2] - rect[0] <= 0 or rect[3] - rect[1] <= 0:
            problem("a field needs a rectangle with a positive width and height")
        if kind in CHOICE_TYPES:
            options = _options_of(spec)
            if not options:
                problem("a choice field needs at least one option")
            elif len({o["label"] for o in options}) != len(options):
                problem("a choice field's options must be different from one another")
            placed = [o for o in options if o["rect"]]
            if placed and len(placed) != len(options):
                problem("either every option carries its own rectangle or none does")
            for option in placed:
                box = _rect_of(option)
                if not box or box[2] - box[0] <= 0 or box[3] - box[1] <= 0:
                    problem("an option's rectangle needs a positive width and height")
                    break
            if kind == "optionlist":
                # A list box's appearance draws EVERY label, so a label the
                # standard face has no code for needs an embedded one. Checked
                # before anything is written, so a batch that cannot be drawn
                # refuses whole rather than half-writing then raising from
                # inside the emitter.
                for text in _drawable_problems(options, font_dir):
                    problem(text)
        if kind == "text":
            max_length = spec.get("max_length")
            if max_length is not None and int(max_length) <= 0:
                problem("a maximum length must be a positive number")
            if spec.get("comb"):
                if not max_length or int(max_length) <= 0:
                    problem("a comb field needs a maximum length to divide its box into")
                if spec.get("multiline"):
                    problem("a comb field cannot also be multiline")
        for text in _action_problems(spec, kind):
            problem(text)
        for text in _writing_problems(spec, kind):
            problem(text)
        calc = _calculate_of(spec)
        if calc is not None:
            try:
                targets = afemit.calculate_inputs(calc)
            except afemit.EmitError:
                targets = []
            for target in targets:
                # The same rule /Lock already applies to its targets: a
                # calculation naming a field nothing has reads nothing, and
                # silently contributes a zero to somebody's total.
                if not afemit.resolves(target, lockable):
                    problem(
                        f'its calculation names "{target}", which this document does not have'
                    )
        lock = _lock_of(spec)
        if lock is not None:
            if kind != "signature":
                problem("only a signature field can lock form fields")
            else:
                try:
                    validated_lock(
                        lock.get("action"), lock.get("fields"), lockable, name or None
                    )
                except ValueError as exc:
                    problem(str(exc))
        if name:
            if name in taken:
                problem(f"a field named {name} already exists")
            else:
                taken.add(name)

    # The batch's /CO, checked before anything is written: a cycle is a
    # calculation that can never settle, and one pass over it computes a number
    # no viewer agrees with. Reported by the chain that proves it.
    entries = _batch_calculations(specs)
    if entries:
        order, inputs = _existing_calculations(pdf)
        try:
            afemit.calculation_order(order, inputs, entries)
        except afemit.CycleError as exc:
            head = exc.chain[0]
            chain = " -> ".join(exc.chain)
            text = f"its calculation depends on itself through {chain}"
            problems.append(f"{head}: {text}" if batch else text)

    if problems:
        joined = "; ".join(problems)
        raise FieldSpecError(f"these form fields cannot be created: {joined}", problems)

    if any(
        isinstance(spec, dict) and _writing_of(spec)[0] != "horizontal" for spec in specs
    ):
        _require_vertical_face(font_dir)


# ── Appearances ───────────────────────────────────────────────────────────


def _dr_fonts(pdf: pikepdf.Pdf):
    """The /AcroForm /DR /Font dictionary, created on demand.

    A widget's appearance stream names a font resource; a viewer that
    regenerates appearances reads /DR, so a font referenced by a /DA that is
    absent from /DR renders as a substitution nobody chose.
    """
    acro = _acroform(pdf)
    dr = acro.get("/DR")
    if dr is None:
        dr = pdf.make_indirect(Dictionary())
        acro["/DR"] = dr
    fonts = dr.get("/Font")
    if fonts is None:
        fonts = pdf.make_indirect(Dictionary())
        dr["/Font"] = fonts
    return fonts


def _helv(pdf: pikepdf.Pdf):
    fonts = _dr_fonts(pdf)
    existing = fonts.get("/Helv")
    if existing is not None:
        return existing
    font = pdf.make_indirect(
        Dictionary(
            Type=Name.Font,
            Subtype=Name.Type1,
            BaseFont=Name.Helvetica,
            Encoding=Name.WinAnsiEncoding,
        )
    )
    fonts["/Helv"] = font
    return font


def _zapf(pdf: pikepdf.Pdf):
    """ZapfDingbats, the face a button's on-state mark is drawn in."""
    fonts = _dr_fonts(pdf)
    existing = fonts.get("/ZaDb")
    if existing is not None:
        return existing
    font = pdf.make_indirect(
        Dictionary(
            Type=Name.Font,
            Subtype=Name.Type1,
            BaseFont=Name.ZapfDingbats,
        )
    )
    fonts["/ZaDb"] = font
    return font


def _vertical_face_metrics(font_dir: str) -> tuple[str, dict]:
    """``(PostScript name, metrics)`` of the bundled vertical face.

    The /DR font this module writes embeds NOTHING, so its descriptor is a
    description of the face the fill will actually draw through rather than
    of a font program in the file. Every number is read off that face; none
    is assumed.
    """
    from fontTools.ttLib import TTFont

    from engine.font_fallback import _font_metrics, resolve_vertical_font

    _require_vertical_face(font_dir)
    face = resolve_vertical_font(font_dir, "", style="regular")
    ttf = TTFont(face, fontNumber=0, lazy=True)
    try:
        name = ttf["name"].getDebugName(6)
        metrics = _font_metrics(ttf)
        metrics["cff"] = "CFF " in ttf
        metrics["italic_angle"] = float(ttf["post"].italicAngle)
    finally:
        ttf.close()
    if not name:
        raise ValueError(
            "the bundled vertical font states no PostScript name, so no font "
            "descriptor can name it"
        )
    return str(name), metrics


def _vertical_font(pdf: pikepdf.Pdf, script: str, font_dir: str) -> str:
    """The /DR resource name of the NON-EMBEDDED vertical font for ``script``,
    created on demand and shared by every field bound to that collection.

    The font is a Type 0 on a predefined vertical CMap (ISO 32000-2 Table
    116) over a CID-keyed descendant whose /CIDSystemInfo names the
    collection (9.7.3). Nothing is embedded: an empty field's /DA font has to
    cover characters nobody has typed yet, and the value's own glyphs are
    embedded as a subset inside the appearance stream when the field is
    filled.
    """
    from engine.text_authoring import vertical_collection

    cmap, registry, ordering, supplement = vertical_collection(script)
    fonts = _dr_fonts(pdf)
    resource = f"V{ordering}"
    existing = fonts.get("/" + resource)
    if existing is not None:
        if str(existing.get("/Encoding", "")) == "/" + cmap:
            return resource
        # A name already bound to a different encoding is somebody else's
        # font; a fresh one is written rather than that one rewritten.
        index = 2
        while fonts.get(f"/{resource}{index}") is not None:
            index += 1
        resource = f"{resource}{index}"

    base, metrics = _vertical_face_metrics(font_dir)
    descriptor = pdf.make_indirect(
        Dictionary(
            Type=Name("/FontDescriptor"),
            FontName=Name("/" + base),
            # 9.8.2 bit 3: the character set lies outside the Latin one the
            # standard encodings describe.
            Flags=4,
            FontBBox=Array(metrics["bbox"]),
            ItalicAngle=metrics["italic_angle"],
            Ascent=metrics["ascent"],
            Descent=metrics["descent"],
            CapHeight=metrics["cap_height"],
            # 9.8.1 Table 120: zero states an UNKNOWN dominant stem width,
            # which is the honest value for a face whose program is absent.
            StemV=0,
        )
    )
    descendant = pdf.make_indirect(
        Dictionary(
            Type=Name("/Font"),
            # 9.7.4.1: a CFF-based CIDFont is CIDFontType0, a TrueType-based
            # one CIDFontType2. /CIDToGIDMap is defined for the latter alone
            # and is absent here by construction (nothing is embedded).
            Subtype=Name("/CIDFontType0" if metrics["cff"] else "/CIDFontType2"),
            BaseFont=Name("/" + base),
            CIDSystemInfo=Dictionary(
                Registry=String(registry),
                Ordering=String(ordering),
                Supplement=supplement,
            ),
            FontDescriptor=descriptor,
        )
    )
    fonts["/" + resource] = pdf.make_indirect(
        Dictionary(
            Type=Name("/Font"),
            Subtype=Name("/Type0"),
            BaseFont=Name("/" + base),
            Encoding=Name("/" + cmap),
            DescendantFonts=Array([descendant]),
        )
    )
    return resource


def _chrome(w: float, h: float) -> str:
    """Background and border, the operators every widget's appearance opens
    with. The border is drawn on the box's inset centre line, so a 1 pt stroke
    lands inside the rectangle rather than straddling it."""
    half = BORDER_WIDTH / 2
    return (
        f"q 1 1 1 rg 0 0 {w:.4f} {h:.4f} re f Q\n"
        f"q 0 0 0 RG {BORDER_WIDTH:.4f} w "
        f"{half:.4f} {half:.4f} {w - BORDER_WIDTH:.4f} {h - BORDER_WIDTH:.4f} re S Q\n"
    )


def _form_xobject(pdf: pikepdf.Pdf, body: str, w: float, h: float, resources=None):
    stream = pdf.make_stream(body.encode("ascii"))
    stream.stream_dict["/Type"] = Name("/XObject")
    stream.stream_dict["/Subtype"] = Name("/Form")
    stream.stream_dict["/BBox"] = Array([0, 0, w, h])
    stream.stream_dict["/Resources"] = resources if resources is not None else Dictionary()
    return stream


def _text_ap(pdf: pikepdf.Pdf, w: float, h: float):
    """An empty text widget's appearance: chrome, and the marked content a
    viewer replaces when the field is filled."""
    body = _chrome(w, h) + "/Tx BMC\nEMC\n"
    resources = Dictionary(Font=Dictionary(Helv=_helv(pdf)))
    return _form_xobject(pdf, body, w, h, resources)


def _button_ap(pdf: pikepdf.Pdf, w: float, h: float, glyph: str):
    """A button's on-state: the chrome plus a centred ZapfDingbats mark sized
    to the box."""
    size = max(4.0, min(w, h) * 0.72)
    # ZapfDingbats' check and bullet are roughly 0.75 em wide and sit on the
    # baseline, so the mark centres by its own metrics rather than by the box.
    x = (w - size * 0.75) / 2
    y = (h - size * 0.72) / 2
    body = (
        _chrome(w, h)
        + f"q 0 0 0 rg BT /ZaDb {size:.4f} Tf {x:.4f} {y:.4f} Td ({glyph}) Tj ET Q\n"
    )
    resources = Dictionary(Font=Dictionary(ZaDb=_zapf(pdf)))
    return _form_xobject(pdf, body, w, h, resources)


def _off_ap(pdf: pikepdf.Pdf, w: float, h: float):
    return _form_xobject(pdf, _chrome(w, h), w, h, Dictionary())


# ── Field construction ────────────────────────────────────────────────────


def _acroform(pdf: pikepdf.Pdf):
    acro = pdf.Root.get("/AcroForm")
    if acro is None:
        acro = pdf.make_indirect(Dictionary(Fields=Array()))
        pdf.Root["/AcroForm"] = acro
    if acro.get("/Fields") is None:
        acro["/Fields"] = Array()
    return acro


def _attach(pdf: pikepdf.Pdf, page, annot) -> None:
    existing = page.obj.get("/Annots")
    page.obj["/Annots"] = (
        Array([*existing, annot]) if existing is not None else Array([annot])
    )


def _widget(pdf: pikepdf.Pdf, page, rect: tuple, caption: str = "") -> Dictionary:
    mk = Dictionary(BG=Array([1, 1, 1]), BC=Array([0, 0, 0]))
    if caption:
        # /MK /CA is what a viewer regenerating a button's appearance draws;
        # without it a rebuilt on-state is an empty box.
        mk["/CA"] = String(caption)
    return Dictionary(
        Type=Name("/Annot"),
        Subtype=Name("/Widget"),
        Rect=Array(list(rect)),
        F=4,  # print
        P=page.obj,
        MK=mk,
        BS=Dictionary(W=BORDER_WIDTH, S=Name("/S")),
    )


def _default_appearance(pdf: pikepdf.Pdf, spec: dict, font_dir: str) -> str:
    """The /DA string a spec's field carries.

    A vertical field's /DA names the collection font written into /DR: the
    CMap that font is encoded with is the one place the format states a
    field's writing mode (ISO 32000-2 9.7.5.1), so naming it IS the request.
    Size 0 leaves the fill to auto-size, as the horizontal default does.
    """
    mode, script = _writing_of(spec)
    if mode == "horizontal":
        return DEFAULT_DA
    return f"/{_vertical_font(pdf, script, font_dir)} 0 Tf 0 g"


def _create_text(pdf: pikepdf.Pdf, page, spec: dict, rect: tuple, font_dir: str = ""):
    w, h = rect[2] - rect[0], rect[3] - rect[1]
    field = _widget(pdf, page, rect)
    field["/FT"] = Name("/Tx")
    field["/T"] = String(spec["name"].strip())
    field["/DA"] = String(_default_appearance(pdf, spec, font_dir))
    flags = 0
    if spec.get("multiline"):
        flags |= FF_MULTILINE
    if spec.get("comb"):
        flags |= FF_COMB
    if flags:
        field["/Ff"] = flags
    if spec.get("max_length"):
        field["/MaxLen"] = int(spec["max_length"])
    field["/AP"] = Dictionary(N=_text_ap(pdf, w, h))
    _apply_actions(pdf, field, spec)
    return pdf.make_indirect(field)


def _create_checkbox(pdf: pikepdf.Pdf, page, spec: dict, rect: tuple):
    w, h = rect[2] - rect[0], rect[3] - rect[1]
    field = _widget(pdf, page, rect, caption="4")
    field["/FT"] = Name("/Btn")
    field["/T"] = String(spec["name"].strip())
    field["/DA"] = String("/ZaDb 0 Tf 0 g")
    field["/V"] = Name("/Off")
    field["/AS"] = Name("/Off")
    states = Dictionary()
    states["/Yes"] = _button_ap(pdf, w, h, "4")
    states["/Off"] = _off_ap(pdf, w, h)
    field["/AP"] = Dictionary(N=states)
    _apply_actions(pdf, field, spec)
    return pdf.make_indirect(field)


def _create_signature(pdf: pikepdf.Pdf, page, spec: dict, rect: tuple):
    # An empty signature field carries no appearance by convention: a viewer
    # draws its own affordance, and a generated one would claim a look the
    # signing flow then replaces.
    field = _widget(pdf, page, rect)
    field["/FT"] = Name("/Sig")
    field["/T"] = String(spec["name"].strip())
    del field["/MK"]
    del field["/BS"]
    lock = _lock_of(spec)
    seed = validated_lock(lock.get("action"), lock.get("fields")) if lock is not None else None
    if seed is not None:
        field["/Lock"] = lock_dictionary(pdf, seed)
    return pdf.make_indirect(field)


def _option_cells(rect: tuple, count: int) -> list:
    """Equal horizontal cells with a square button centred in each — the
    layout for a group given ONE rectangle and N options."""
    x0, y0, x1, y1 = rect
    cell = (x1 - x0) / count
    side = min(cell * 0.8, (y1 - y0) * 0.8)
    cells = []
    for i in range(count):
        cx = x0 + i * cell + (cell - side) / 2
        cy = y0 + ((y1 - y0) - side) / 2
        cells.append((cx, cy, cx + side, cy + side))
    return cells


def _create_radio(pdf: pikepdf.Pdf, page, spec: dict, rect: tuple, options: list):
    field = pdf.make_indirect(
        Dictionary(
            FT=Name("/Btn"),
            T=String(spec["name"].strip()),
            Ff=FF_RADIO | FF_NO_TOGGLE_TO_OFF,
            V=Name("/Off"),
            DA=String("/ZaDb 0 Tf 0 g"),
            Kids=Array(),
        )
    )
    _apply_actions(pdf, field, spec)
    boxes = [_rect_of(o) for o in options] if all(o["rect"] for o in options) else None
    if boxes is None:
        boxes = _option_cells(rect, len(options))
    kids = []
    for option, box in zip(options, boxes):
        w, h = box[2] - box[0], box[3] - box[1]
        kid = _widget(pdf, page, box, caption="l")
        kid["/Parent"] = field
        kid["/AS"] = Name("/Off")
        # The on-state is NAMED by the option's export value: two options
        # sharing a state are one button as far as the format is concerned.
        states = Dictionary()
        states["/" + option["label"]] = _button_ap(pdf, w, h, "l")
        states["/Off"] = _off_ap(pdf, w, h)
        kid["/AP"] = Dictionary(N=states)
        kids.append(pdf.make_indirect(kid))
    field["/Kids"] = Array(kids)
    return field, kids


def _create_choice(
    pdf: pikepdf.Pdf, page, spec: dict, rect: tuple, options: list, font_dir: str = ""
):
    w, h = rect[2] - rect[0], rect[3] - rect[1]
    field = _widget(pdf, page, rect)
    field["/FT"] = Name("/Ch")
    field["/T"] = String(spec["name"].strip())
    field["/DA"] = String(_default_appearance(pdf, spec, font_dir))
    field["/Opt"] = Array([String(o["label"]) for o in options])
    field["/Ff"] = FF_COMBO if spec["type"] == "dropdown" else FF_MULTISELECT
    if spec["type"] == "optionlist":
        # A list box's appearance IS its list, so a created one is drawn
        # rather than left as an empty box a viewer may or may not fill in.
        # The same emitter the fill and the appearance door use.
        from engine.forms import _choice_list_appearance

        _choice_list_appearance(
            pdf, field, [o["label"] for o in options], set(), 0,
            str(field["/DA"]), 0, font_dir,
        )
    else:
        field["/AP"] = Dictionary(N=_text_ap(pdf, w, h))
    _apply_actions(pdf, field, spec)
    return pdf.make_indirect(field)


def _create(pdf: pikepdf.Pdf, spec: dict, font_dir: str = "") -> list:
    """One spec into the document; returns the /Fields entries it adds."""
    page = pdf.pages[int(spec["page_index"])]
    rect = _rect_of(spec)
    kind = spec["type"]
    options = _options_of(spec)

    if kind == "radio":
        field, kids = _create_radio(pdf, page, spec, rect, options)
        for kid in kids:
            _attach(pdf, page, kid)
        return [field]
    if kind in ("dropdown", "optionlist"):
        field = _create_choice(pdf, page, spec, rect, options, font_dir)
    elif kind == "checkbox":
        field = _create_checkbox(pdf, page, spec, rect)
    elif kind == "signature":
        field = _create_signature(pdf, page, spec, rect)
    else:
        field = _create_text(pdf, page, spec, rect, font_dir)
    _attach(pdf, page, field)
    return [field]


def _write_order(pdf: pikepdf.Pdf, specs: list) -> None:
    """Rewrite ``/CO`` for the calculations this batch just created.

    Run AFTER the fields exist, so the entries are references to real objects;
    the order itself was already proved acyclic before anything was written.
    """
    entries = _batch_calculations(specs)
    if not entries:
        return
    order, inputs = _existing_calculations(pdf)
    # The batch's own entries are not in the document's /CO yet, so their
    # inputs come from the batch half alone.
    write_calculation_order(pdf, afemit.calculation_order(order, inputs, entries))


# ── The door ──────────────────────────────────────────────────────────────


def add_form_fields(
    file: str,
    output: str,
    fields=None,
    allow_signed: bool = False,
    font_dir: str = "",
) -> dict:
    """Create ``fields`` in ``file`` and write the result to ``output``.

    Returns ``{output, created, names}``. Every problem in the batch is
    reported at once and nothing is written when any of them fails.

    ``font_dir`` is the bundled font folder. A spec asking for vertical
    writing is bound to a non-embedded collection font whose descriptor is
    read off the bundled vertical face, so a vertical spec without it
    refuses; a batch of horizontal specs never reads it.

    A document certified to allow no changes REFUSES; one whose signatures the
    edit merely invalidates refuses unless ``allow_signed`` says the caller
    accepted that. Adding a field is a structural edit -- it is outside the
    incremental-append tier, so no revision can preserve the existing
    signatures.
    """
    specs = list(fields or [])
    validate_pdf(file)
    decision = signed_edit_decision(signature_policy(file), "structural")
    if decision["kind"] == "refuse":
        raise RuntimeError(
            "this document is certified to allow no changes, so adding form "
            "fields would produce a file that reports as illegally modified"
        )
    if decision["kind"] == "warn" and not allow_signed:
        raise RuntimeError(
            "this document is signed and adding form fields invalidates its "
            "signatures -- the run must state that signed documents are "
            "included before it will touch one"
        )

    input_path = Path(file)
    output_path = Path(output)
    same_file = is_same_file(str(input_path), str(output_path))
    names = []
    with pikepdf.open(file) as pdf:
        refuse_if_xfa(pdf, input_path, "adding form fields")
        _validate(pdf, specs, font_dir)
        acro = _acroform(pdf)
        _helv(pdf)
        entries = list(acro["/Fields"])
        has_signature = False
        for spec in specs:
            for created in _create(pdf, spec, font_dir):
                entries.append(created)
            names.append(str(spec["name"]).strip())
            has_signature = has_signature or spec["type"] == "signature"
        acro["/Fields"] = Array(entries)
        if has_signature:
            # A document that can hold signatures advertises it.
            acro["/SigFlags"] = int(acro.get("/SigFlags", 0)) | 1
        _write_order(pdf, specs)
        _save(pdf, output_path, same_file)
    return {"output": str(output_path), "created": len(specs), "names": names}


def author_vertical_field_font(
    file: str,
    output: str,
    fields=None,
    script: str = "",
    font_dir: str = "",
    allow_signed: bool = False,
) -> dict:
    """Bind EXISTING text-ish fields to a vertical font, and write ``output``.

    Returns ``{output, fields, font, cmap, registry, ordering, supplement}``.

    The font half of vertical field authoring, for the tiers that create the
    field itself with something that cannot write a CID-keyed font. It writes
    the non-embedded collection font into /AcroForm /DR once and renames each
    field's /DA font to it, keeping that /DA's size and colour -- the writing
    mode is the ONLY axis this door moves.

    Every problem is reported at once and nothing is written when any of them
    fails, which is the posture the create path already takes: a run that
    bound half a form to a vertical font leaves a document nobody can reason
    about.
    """
    from engine.forms import _parse_da
    from engine.text_authoring import vertical_collection

    names = [str(name).strip() for name in (fields or []) if str(name).strip()]
    if not names:
        raise ValueError("Name the form fields whose writing mode is being set.")
    cmap, registry, ordering, supplement = vertical_collection(script)
    _require_vertical_face(font_dir)
    validate_pdf(file)
    decision = signed_edit_decision(signature_policy(file), "structural")
    if decision["kind"] == "refuse":
        raise RuntimeError(
            "this document is certified to allow no changes, so setting a field's "
            "writing mode would produce a file that reports as illegally modified"
        )
    if decision["kind"] == "warn" and not allow_signed:
        raise RuntimeError(
            "this document is signed and setting a field's writing mode invalidates "
            "its signatures -- the run must state that signed documents are "
            "included before it will touch one"
        )

    input_path = Path(file)
    output_path = Path(output)
    same_file = is_same_file(str(input_path), str(output_path))
    with pikepdf.open(file) as pdf:
        refuse_if_xfa(pdf, input_path, "setting a field's writing mode")
        forest = form_field_forest(pdf)
        problems: list[str] = []
        targets = []
        for name in names:
            target = forest.get(name)
            if target is None:
                problems.append(
                    f"{name}: this document has no form field with that name"
                )
                continue
            kind = _kind_of_field(target)
            if kind not in VERTICAL_FIELD_TYPES:
                problems.append(
                    f"{name}: a {kind} field draws a mark rather than a text run, so "
                    "it has no writing mode"
                )
                continue
            # Bit 25 means COMB on a text field alone; on a choice field the
            # same bit is CommitOnSelChange, so reading it there would refuse
            # a dropdown for a flag that says nothing about its box.
            if kind == "text" and _effective_flags(target) & FF_COMB:
                problems.append(
                    f"{name}: a comb field divides its box across the axis a column "
                    "runs down, so it cannot also write vertically"
                )
                continue
            targets.append((name, target))
        if problems:
            joined = "; ".join(problems)
            raise FieldSpecError(
                f"these form fields cannot write vertically: {joined}", problems
            )
        resource = _vertical_font(pdf, script, font_dir)
        for _name, target in targets:
            _requested, size, color = _parse_da(_field_appearance(target, pdf))
            target["/DA"] = String(f"/{resource} {_fmt_size(size)} Tf {color}")
        _save(pdf, output_path, same_file)
    return {
        "output": str(output_path),
        "fields": [name for name, _target in targets],
        "font": resource,
        "cmap": cmap,
        "registry": registry,
        "ordering": ordering,
        "supplement": supplement,
    }


def author_choice_appearance(
    file: str,
    output: str,
    fields=None,
    font_dir: str = "",
    allow_signed: bool = False,
) -> dict:
    """Redraw EXISTING option lists' widget appearances, and write ``output``.

    Returns ``{output, fields, embedded}`` -- ``embedded`` names the fields
    whose appearance had to embed a font because some label leaves WinAnsi.

    The appearance half of option-list authoring, for the tiers that create
    the field itself with something that can only draw the standard WinAnsi
    faces. A list box's appearance lays out EVERY label, so it is the one
    field kind whose appearance depends on arbitrary authored text; this door
    rebuilds each widget's ``/AP /N`` through the engine's own per-line font
    ladder, so a Korean row embeds a subset and a Latin row beside it keeps
    the standard face.

    A list bound to a vertical font (its ``/DA`` font's CMap says so) draws
    its rows as columns through the same emitter -- one door, not two.

    Every problem is reported at once and nothing is written when any of them
    fails, which is the posture the create path already takes.
    """
    from engine.forms import (
        _acroform as _forms_acroform,
        _all_fields,
        _choice_list_appearance,
        _classify,
        _encodes_winansi,
        _field_da,
        _options,
        _selected_indices,
        _top_index,
    )

    names = [str(name).strip() for name in (fields or []) if str(name).strip()]
    if not names:
        raise ValueError("Name the option lists whose appearance is being drawn.")
    validate_pdf(file)
    decision = signed_edit_decision(signature_policy(file), "structural")
    if decision["kind"] == "refuse":
        raise RuntimeError(
            "this document is certified to allow no changes, so redrawing an option "
            "list would produce a file that reports as illegally modified"
        )
    if decision["kind"] == "warn" and not allow_signed:
        raise RuntimeError(
            "this document is signed and redrawing an option list invalidates its "
            "signatures -- the run must state that signed documents are "
            "included before it will touch one"
        )

    input_path = Path(file)
    output_path = Path(output)
    same_file = is_same_file(str(input_path), str(output_path))
    with pikepdf.open(file) as pdf:
        refuse_if_xfa(pdf, input_path, "redrawing an option list")
        terminals = {field.name: field for field in _all_fields(pdf)}
        acro = _forms_acroform(pdf)
        problems: list[str] = []
        targets = []
        for name in names:
            target = terminals.get(name)
            if target is None:
                problems.append(
                    f"{name}: this document has no form field with that name"
                )
                continue
            kind = _classify(target)
            if kind != "optionlist":
                problems.append(
                    f"{name}: a {kind} field draws no list of options, so it has no "
                    "list appearance"
                )
                continue
            targets.append((name, target))
        if problems:
            joined = "; ".join(problems)
            raise FieldSpecError(
                f"these option lists cannot be drawn: {joined}", problems
            )
        embedded: list[str] = []
        for name, target in targets:
            labels = _options(target)
            da = _field_da(target, acro)
            quadding = _quadding_of(target)
            if any(not _encodes_winansi(label) for label in labels):
                embedded.append(name)
            try:
                for widget in target.widgets:
                    _choice_list_appearance(
                        pdf,
                        widget,
                        labels,
                        _selected_indices(target),
                        _top_index(target),
                        da,
                        quadding,
                        font_dir,
                    )
            except ValueError as exc:
                problems.append(f"{name}: {exc}")
        if problems:
            joined = "; ".join(problems)
            raise FieldSpecError(
                f"these option lists cannot be drawn: {joined}", problems
            )
        _save(pdf, output_path, same_file)
    return {
        "output": str(output_path),
        "fields": [name for name, _target in targets],
        "embedded": embedded,
    }


def _quadding_of(field) -> int:
    value = field.attr("/Q")
    try:
        return int(value) if value is not None else 0
    except (TypeError, ValueError):
        return 0


def _field_appearance(field, pdf: pikepdf.Pdf) -> str | None:
    """The /DA in effect for a field: its own, inherited, else the form's."""
    node = field
    for _ in range(_MAX_PARENT_DEPTH):
        if node is None:
            break
        da = node.get("/DA")
        if da is not None:
            return str(da)
        node = node.get("/Parent")
    acro = pdf.Root.get("/AcroForm")
    da = acro.get("/DA") if acro is not None else None
    return str(da) if da is not None else None


def _effective_flags(field) -> int:
    """A field's ``/Ff``, inherited from its ancestors when it carries none."""
    node = field
    for _ in range(_MAX_PARENT_DEPTH):
        if node is None:
            return 0
        flags = node.get("/Ff")
        if flags is not None:
            try:
                return int(flags)
            except (TypeError, ValueError):
                return 0
        node = node.get("/Parent")
    return 0


def _fmt_size(size: float) -> str:
    """A /DA font size, with an integral value written as an integer so the
    ordinary auto-size string stays `0` rather than `0.0`."""
    return str(int(size)) if float(size).is_integer() else f"{size:g}"


def _effective_ft(field):
    """A field's ``/FT``, inherited from its ancestors when it carries none."""
    node = field
    for _ in range(_MAX_PARENT_DEPTH):
        if node is None:
            return None
        ft = node.get("/FT")
        if ft is not None:
            return str(ft)
        node = node.get("/Parent")
    return None


def set_field_lock(
    file: str,
    output: str,
    field: str = "",
    lock=None,
    lock_fields=None,
    allow_signed: bool = False,
) -> dict:
    """Set the ``/Lock`` an UNSIGNED signature field carries, and write ``output``.

    Returns ``{output, field, lock}``. ``lock`` of None removes the field's lock:
    the door is total, since "this field locks nothing" is a value rather than a
    separate operation.

    A field that is already SIGNED refuses. Its ``/Lock`` sits inside what the
    signature covers, so rewriting it both breaks the signature and rewrites a
    constraint whoever signed accepted.
    """
    name = str(field or "").strip()
    if not name:
        raise ValueError("Name the signature field whose lock is being set.")
    validate_pdf(file)
    decision = signed_edit_decision(signature_policy(file), "structural")
    if decision["kind"] == "refuse":
        raise RuntimeError(
            "this document is certified to allow no changes, so setting a field "
            "lock would produce a file that reports as illegally modified"
        )
    if decision["kind"] == "warn" and not allow_signed:
        raise RuntimeError(
            "this document is signed and setting a field lock invalidates its "
            "signatures -- the run must state that signed documents are "
            "included before it will touch one"
        )

    input_path = Path(file)
    output_path = Path(output)
    same_file = is_same_file(str(input_path), str(output_path))
    with pikepdf.open(file) as pdf:
        refuse_if_xfa(pdf, input_path, "setting a field lock")
        forest = form_field_forest(pdf)
        target = forest.get(name)
        if target is None:
            raise ValueError(f'This document has no form field named "{name}".')
        if _effective_ft(target) != "/Sig":
            raise ValueError(
                f'Form field "{name}" is not a signature field, and only a signature '
                "field can lock form fields."
            )
        if target.get("/V") is not None:
            raise ValueError(
                f'Signature field "{name}" is already signed, so its field lock can no '
                "longer change. Its lock is part of what that signature covers."
            )
        seed = validated_lock(lock, lock_fields, set(forest), name)
        if seed is None:
            if target.get("/Lock") is not None:
                del target["/Lock"]
        else:
            target["/Lock"] = lock_dictionary(pdf, seed)
        _save(pdf, output_path, same_file)
    return {"output": str(output_path), "field": name, "lock": seed}


def set_field_description(
    file: str,
    output: str,
    field: str = "",
    description: str = "",
    allow_signed: bool = False,
) -> dict:
    """Set the ``/TU`` description of an EXISTING field, and write ``output``.

    ``/TU`` is what assistive technology announces when it reaches the field.
    A field without one is announced by its internal name or not at all, which
    is why the checker reports it — and why the field's own name is offered as
    a STARTING SUGGESTION in the surface and never written here silently: a
    description that merely repeats `Text1` is the same failure wearing a
    different key.

    An empty description removes the key: "this field has none" is a value, not
    a separate operation.
    """
    name = str(field or "").strip()
    if not name:
        raise ValueError("Name the form field whose description is being set.")
    text = str(description or "").strip()
    validate_pdf(file)
    decision = signed_edit_decision(signature_policy(file), "structural")
    if decision["kind"] == "refuse":
        raise RuntimeError(
            "this document is certified to allow no changes, so setting a field "
            "description would produce a file that reports as illegally modified"
        )
    if decision["kind"] == "warn" and not allow_signed:
        raise RuntimeError(
            "this document is signed and setting a field description invalidates its "
            "signatures -- the run must state that signed documents are "
            "included before it will touch one"
        )

    input_path = Path(file)
    output_path = Path(output)
    same_file = is_same_file(str(input_path), str(output_path))
    with pikepdf.open(file) as pdf:
        refuse_if_xfa(pdf, input_path, "setting a field description")
        forest = form_field_forest(pdf)
        target = forest.get(name)
        if target is None:
            raise ValueError(f'This document has no form field named "{name}".')
        if text:
            target[Name.TU] = String(text)
        elif "/TU" in target:
            del target["/TU"]
        _save(pdf, output_path, same_file)
    return {"output": str(output_path), "field": name, "description": text}


def set_field_actions(
    file: str,
    output: str,
    field: str = "",
    format=None,
    validate=None,
    calculate=None,
    default_value=None,
    actions=None,
    clear=None,
    allow_signed: bool = False,
) -> dict:
    """Set the Format, Validate, Calculate and data actions an EXISTING field
    carries.

    Returns ``{output, field, scripts, data_actions, calculation_order}``. The
    door is total: every one of the four value triggers this app authors is
    rewritten from the arguments, so omitting an argument REMOVES that action
    rather than leaving the previous one behind. ``clear`` names the members to
    remove explicitly (``["format", "validate", "calculate", "default_value",
    "actions"]``), which is how a caller distinguishes "leave the default value
    alone" from "there is none". Every other ``/AA`` key -- a script this app
    does not run -- is left untouched.

    ``actions`` is the DATA half: the `/GoTo`, `/URI`, `/ResetForm`,
    `/SubmitForm`, `/Hide` and `/ImportData` kinds, each on its own trigger
    (``A`` activation, ``D`` ``U`` ``E`` ``X`` ``Fo`` ``Bl``). It is total the
    same way -- a trigger absent from the list loses its action -- and it is
    written onto the WIDGETS, which is where a consumer looks for the thing a
    click does. Passing it at all takes over every one of those triggers, so a
    caller that means to leave them alone omits it and does not name it in
    ``clear``.

    ``/CO`` is rewritten by the same topological rule the create path uses, so
    a calculation added here lands after the fields it reads. A cycle refuses.

    Writing a field property rewrites the file, so the signed decision is taken
    where every other structural edit takes it.
    """
    name = str(field or "").strip()
    if not name:
        raise ValueError("Name the form field whose actions are being set.")
    validate_pdf(file)
    decision = signed_edit_decision(signature_policy(file), "structural")
    if decision["kind"] == "refuse":
        raise RuntimeError(
            "this document is certified to allow no changes, so setting a field "
            "action would produce a file that reports as illegally modified"
        )
    if decision["kind"] == "warn" and not allow_signed:
        raise RuntimeError(
            "this document is signed and setting a field action invalidates its "
            "signatures -- the run must state that signed documents are "
            "included before it will touch one"
        )

    input_path = Path(file)
    output_path = Path(output)
    same_file = is_same_file(str(input_path), str(output_path))
    dropped = set(clear or ())
    with pikepdf.open(file) as pdf:
        refuse_if_xfa(pdf, input_path, "setting a field action")
        forest = form_field_forest(pdf)
        target = forest.get(name)
        if target is None:
            raise ValueError(f'This document has no form field named "{name}".')
        kind = _kind_of_field(target)
        spec = {"name": name, "type": kind}
        if format is not None:
            spec["format"] = format
        if validate is not None:
            spec["validate"] = validate
        if calculate is not None:
            spec["calculate"] = calculate
        if default_value is not None or "default_value" in dropped:
            spec["default_value"] = default_value
        # A member is ADDRESSED when the caller either supplied it or named it
        # in `clear`. Anything else is left as the document has it, so a caller
        # editing one half of this door never destroys the other.
        addressed = tuple(
            trigger
            for member, triggers in _MEMBER_TRIGGERS.items()
            if member in spec or member in dropped
            for trigger in triggers
        )
        problems = _action_problems(spec, kind)
        writes_actions = actions is not None or "actions" in dropped
        data_actions = list(actions or ())
        if writes_actions:
            known_names = set(forest)
            for terminal in _all_fields(pdf):
                known_names.add(terminal.name)
            problems.extend(
                fieldactions.action_problems(data_actions, known_names, len(pdf.pages))
            )
        if calculate is not None:
            known = set(forest)
            for terminal in _all_fields(pdf):
                known.add(terminal.name)
            try:
                targets = afemit.calculate_inputs(calculate)
            except afemit.EmitError:
                targets = []
            for candidate in targets:
                if candidate == name:
                    problems.append(f'its calculation names "{candidate}", which is itself')
                elif not afemit.resolves(candidate, known):
                    problems.append(
                        f'its calculation names "{candidate}", which this document does not have'
                    )
        if problems:
            labelled = [f"{name}: {problem}" for problem in problems]
            raise FieldSpecError(
                f"this form field's actions cannot be set: {'; '.join(labelled)}",
                labelled,
            )

        order, inputs = _existing_calculations(pdf)
        entries = []
        if calculate is not None:
            entries.append((name, afemit.calculate_inputs(calculate)))
            inputs.pop(name, None)
        try:
            new_order = afemit.calculation_order(order, inputs, entries)
        except afemit.CycleError as exc:
            chain = " -> ".join(exc.chain)
            text = f"{name}: its calculation depends on itself through {chain}"
            raise FieldSpecError(
                f"this form field's actions cannot be set: {text}", [text]
            ) from exc
        if calculate is None and "C" in addressed and name in new_order:
            # The calculation was removed, so the field no longer belongs to
            # the order it was in. A calculation nobody addressed keeps both.
            new_order = [entry for entry in new_order if entry != name]

        _apply_actions(pdf, target, spec, addressed)
        if writes_actions:
            fieldactions.write_actions(pdf, target, data_actions)
        write_calculation_order(pdf, new_order)
        _save(pdf, output_path, same_file)
    return {
        "output": str(output_path),
        "field": name,
        "scripts": afemit.emitted_scripts(spec) if addressed else {},
        "data_actions": data_actions if writes_actions else None,
        "calculation_order": new_order,
    }
