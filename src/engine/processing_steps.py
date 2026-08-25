"""Processing steps — the non-printing layers of a packaging or label file.

A packaging PDF carries more than the artwork that reaches a plate. The die
line, the crease pattern, the glue flaps, the braille positions, the varnish
area and the legend block all travel in the same file, each on its own
optional-content group, and each of them is a MANUFACTURING instruction rather
than something a press lays down as ink. A tool that renders them like artwork
puts a die line on a plate; a tool that counts them in total ink reports a
number about a sheet nobody will print.

SOURCING — A RECORDED GAP
=========================

The standard that governs this is **ISO 19593-1** (Graphic technology — Use of
PDF to associate processing steps and content data — Part 1: Processing steps
for packaging and labels). This repository does NOT hold it: it is not in
`pdfa/`, and per the doc-authority rule that makes every claim below
SECOND-HAND. It is recorded as a gap rather than presented as normative.

What this module is sourced from, in order of weight:

  1. The **GWG Processing Steps Test Suite v1.0** (Ghent Workgroup, February
     2025) — 39 test patches built expressly to check an implementation
     against the ISO specification, plus the suite's own documentation stating
     each patch's expected verdict. The suite's files are the closest thing to
     the standard's own text that is available here, because they were
     authored to exercise it. Every structural claim below about HOW a
     processing step is written into a PDF is read off those 39 files and
     paraphrased; nothing here reproduces the suite's prose.
  2. Public secondary descriptions of the standard's group and type
     vocabulary. These disagree with each other on the size of the
     `Structural` type list, which is exactly why `GROUP_TYPES` below is
     treated as a KNOWN-GOOD set and never as a closed one: a type outside it
     is reported as unrecognized for review, never pronounced invalid.

Nothing this module produces may be described as an ISO 19593-1 conformance
verdict. It reports what a document declares and what is structurally wrong
with the declaration; the questions that need the standard's text stay open
and say so.

HOW A PROCESSING STEP IS WRITTEN
================================

Read off the suite's 39 patches, every one of which agrees: the declaration
lives on the OPTIONAL CONTENT GROUP dictionary itself, in a `/GTS_Metadata`
sub-dictionary holding

    /GTS_ProcStepsGroup   a name — the processing step's GROUP (required)
    /GTS_ProcStepsType    a name — the step's TYPE within that group, present
                          only for the groups that define types

An OCG with no `/GTS_Metadata` is ordinary artwork. The corpus's typed groups
appear as `/Structural` with `/Cutting`, `/Punching`, `/Gluing`, `/Bleed`; the
untyped ones as `/White` and `/Legend`, carrying a group and no type at all.

The PDF page-element mechanism (`/Usage` `/PageElement` `/Subtype`) is a
DIFFERENT thing and is not how a processing step is declared: across the whole
corpus the only `/Usage` dictionaries present are Illustrator `/CreatorInfo`
entries. It is read here and reported as `page_element` for information —
some producers do write a step's name there as well — but it never stands in
for `/GTS_Metadata`, because nothing in the corpus supports that reading.

CUSTOM STEPS AND THE SECOND CLASS NAME
======================================

The standard admits vendor-defined groups and types. The suite's patches show
the mechanism as a REGISTERED PREFIX joined to the name by an underscore — its
own custom entries are spelled `GWGS_…`, and the suite documents both halves
of the rule with dedicated patches: a custom step carrying such a prefix is
compliant-but-notable (a warning patch), and a custom step WITHOUT one is an
error patch. So a name outside the known vocabulary splits two ways here:
prefixed is `custom`, unprefixed is `unregistered`.
"""

from __future__ import annotations

import re

import pikepdf

#: The OCG key the declaration lives under, and its two members.
METADATA_KEY = "/GTS_Metadata"
GROUP_KEY = "/GTS_ProcStepsGroup"
TYPE_KEY = "/GTS_ProcStepsType"

#: Groups that define no types. A type written on one of these is a declared
#: error in the suite (patch PS-012-02E: a type on a group that expects none).
UNTYPED_GROUPS = ("Dimensions", "Braille", "Legend", "White", "Varnish")

#: Groups that define types, and the types this repository can NAME. Sourced
#: second-hand (see the module docstring) and therefore treated as known-good
#: rather than closed: a type absent from this table is `unregistered`, which
#: is a state a human reviews, never a failure this module pronounces.
GROUP_TYPES = {
    "Structural": (
        "Cutting", "PartialCutting", "ReversePartialCutting",
        "Creasing", "ReverseCreasing",
        "CuttingCreasing", "ReverseCuttingCreasing",
        "PartialCuttingCreasing", "ReversePartialCuttingCreasing",
        "Drilling", "Gluing", "FoilStamping", "ColdFoilStamping",
        "Embossing", "Debossing", "Perforating", "Bleed",
        "VarnishFree", "InkFree", "InkVarnishFree",
        "Folding", "Punching", "Stapling",
    ),
    "Positions": (
        "Hologram", "Barcode", "ContentArea", "CodingMarking", "Imprinting",
    ),
}

#: A vendor-defined name: a registered prefix, an underscore, then the name.
#: The prefix carries no spaces; what follows it may (`GWGS_Test Suite Custom
#: Group` is one of the suite's own).
_SECOND_CLASS = re.compile(r"^[A-Za-z0-9]+_.+$")

# Declaration states, in the order a reviewer cares about them.
STANDARD = "standard"
CUSTOM = "custom"
UNREGISTERED = "unregistered"
TYPE_ON_UNTYPED_GROUP = "type_on_untyped_group"
MISSING_GROUP = "missing_group"

#: How far a colorant space nested in another's alternate is followed. Same
#: cap and same reasoning as the ink inventory's: the nesting is forbidden,
#: and the cap is what stops a self-referential one recursing.
_MAX_ALTERNATE_DEPTH = 4

#: How deep the content scan follows form XObjects into one another.
_MAX_FORM_DEPTH = 12


def _text(obj) -> str:
    """A `/Name` or a string object as plain text, with no leading slash.

    An absent key and a PDF null both read as the EMPTY string. `str(None)`
    is `"None"`, which would have made a missing type indistinguishable from
    a layer declaring a type actually spelled `/None`.
    """
    if obj is None or isinstance(obj, type(None)):
        return ""
    try:
        if obj is pikepdf.Null() or str(obj) == "null":
            return ""
    except Exception:
        pass
    try:
        return str(obj).lstrip("/")
    except Exception:
        return ""


def _objgen(obj):
    try:
        return obj.objgen
    except Exception:
        return None


def has_second_class_name(name: str) -> bool:
    """Is this a vendor-defined name carrying a registered prefix?"""
    return bool(_SECOND_CLASS.match(name))


def classify(group: str, step_type: str) -> str:
    """The declaration's state: one of the five constants above.

    A group nobody declared is `missing_group` — the `/GTS_Metadata` is there
    and says nothing, which is worse than absent because a reader would show
    the layer as a processing step it cannot name.
    """
    if not group:
        return MISSING_GROUP
    known_typed = group in GROUP_TYPES
    known_untyped = group in UNTYPED_GROUPS
    if not (known_typed or known_untyped):
        return CUSTOM if has_second_class_name(group) else UNREGISTERED
    if not step_type:
        # An untyped group is complete without one, and a typed group's type
        # is optional in the corpus (PS-001-02G declares `/Legend` alone).
        return STANDARD
    if known_untyped:
        return TYPE_ON_UNTYPED_GROUP
    if step_type in GROUP_TYPES[group]:
        return STANDARD
    return CUSTOM if has_second_class_name(step_type) else UNREGISTERED


def read_processing_step(ocg) -> dict | None:
    """One OCG's processing-step declaration, or None for ordinary artwork.

    `page_element` is the PDF page-element subtype where the OCG happens to
    carry one. It is reported beside the declaration and is never read AS the
    declaration — see the module docstring.
    """
    if not isinstance(ocg, pikepdf.Dictionary):
        return None
    metadata = ocg.get(METADATA_KEY)
    page_element = ""
    usage = ocg.get("/Usage")
    if isinstance(usage, pikepdf.Dictionary):
        element = usage.get("/PageElement")
        if isinstance(element, pikepdf.Dictionary):
            page_element = _text(element.get("/Subtype"))
    if not isinstance(metadata, pikepdf.Dictionary):
        return None
    group = _text(metadata.get(GROUP_KEY))
    step_type = _text(metadata.get(TYPE_KEY))
    return {
        "group": group,
        "type": step_type,
        "status": classify(group, step_type),
        "page_element": page_element,
    }


def processing_step_ocgs(pdf) -> dict:
    """Every OCG that declares a processing step, keyed by objgen.

    Membership is by object identity, never by name: an OCG name is not
    unique, and the whole point of the answer is which physical group a piece
    of content sits in.
    """
    found: dict = {}
    ocp = pdf.Root.get("/OCProperties")
    if not isinstance(ocp, pikepdf.Dictionary):
        return found
    ocgs = ocp.get("/OCGs")
    if not isinstance(ocgs, pikepdf.Array):
        return found
    for ocg in ocgs:
        step = read_processing_step(ocg)
        if step is None:
            continue
        key = _objgen(ocg)
        if key is None:
            continue
        found[key] = dict(step, name=_text(ocg.get("/Name")))
    return found


def hide_processing_steps(pdf) -> int:
    """Force every processing-step OCG OFF in the DEFAULT configuration.

    This is how the raster stops carrying them: a device renders the default
    configuration, so a group in `/D /OFF` does not reach a plate. It is
    applied to a working COPY of the document — nothing here is ever written
    back over the user's file, because which layers are on is document state
    and the preview's exclusion is a view.

    Returns how many groups moved, so a caller can skip staging entirely when
    the document declares none.
    """
    steps = processing_step_ocgs(pdf)
    if not steps:
        return 0
    ocp = pdf.Root.get("/OCProperties")
    config = ocp.get("/D")
    if not isinstance(config, pikepdf.Dictionary):
        config = pikepdf.Dictionary()
        ocp["/D"] = config
    targets = [ocg for ocg in ocp.get("/OCGs") if _objgen(ocg) in steps]
    keep_on = []
    existing_on = config.get("/ON")
    if isinstance(existing_on, pikepdf.Array):
        keep_on = [el for el in existing_on if _objgen(el) not in steps]
    off = []
    existing_off = config.get("/OFF")
    if isinstance(existing_off, pikepdf.Array):
        off = [el for el in existing_off if _objgen(el) not in steps]
    config["/ON"] = pikepdf.Array(keep_on)
    config["/OFF"] = pikepdf.Array(off + targets)
    return len(targets)


# ── which colorants a processing step owns ─────────────────────────────────
#
# A plate list is a question about CONTENT, not about resources: a `/Varnish`
# colour space sits in the page's `/Resources` whether or not anything paints
# with it, and it is named there by the same dictionary whichever layer paints
# with it. So the only way to say "this ink is only ever laid down on the
# varnish layer" is to walk the content stream, track which optional-content
# section each painting operator is inside, and attribute the colorant to that
# section. That is what the scan below does.


def _colorants(cs, resources, out: set, depth: int = 0) -> None:
    """Every `/Separation` and `/DeviceN` colorant name this space can paint."""
    if isinstance(cs, (pikepdf.Name, str)):
        named = _text(cs)
        space = None
        if isinstance(resources, pikepdf.Dictionary):
            table = resources.get("/ColorSpace")
            if isinstance(table, pikepdf.Dictionary):
                space = table.get("/" + named)
        if space is not None and depth < _MAX_ALTERNATE_DEPTH:
            _colorants(space, resources, out, depth + 1)
        return
    if not isinstance(cs, pikepdf.Array) or len(cs) < 2:
        return
    family = _text(cs[0])
    if family == "Separation" and len(cs) >= 4:
        out.add(_text(cs[1]))
    elif family == "DeviceN" and len(cs) >= 4:
        try:
            for component in cs[1]:
                out.add(_text(component))
        except Exception:
            return
    else:
        return
    if depth < _MAX_ALTERNATE_DEPTH:
        try:
            alternate = cs[2]
        except Exception:
            return
        if isinstance(alternate, pikepdf.Array):
            _colorants(alternate, resources, out, depth + 1)


def _resource(resources, category: str, name):
    if not isinstance(resources, pikepdf.Dictionary):
        return None
    table = resources.get(category)
    if not isinstance(table, pikepdf.Dictionary):
        return None
    return table.get("/" + _text(name))


def _oc_is_processing_step(obj, steps: dict) -> bool:
    """Does this `/OC` value select a processing-step group?

    An OCMD naming several groups counts when ANY of them is a processing
    step: content that only shows when the die line shows is die-line
    content.
    """
    if not isinstance(obj, pikepdf.Dictionary):
        return False
    if _objgen(obj) in steps:
        return True
    if _text(obj.get("/Type")) == "OCMD":
        groups = obj.get("/OCGs")
        if isinstance(groups, pikepdf.Array):
            return any(_objgen(g) in steps for g in groups)
        return _objgen(groups) in steps
    return False


def _bdc_opens_step(operands, resources, steps: dict) -> bool:
    if len(operands) < 2 or _text(operands[0]) != "OC":
        return False
    prop = operands[1]
    if isinstance(prop, pikepdf.Dictionary):
        return _oc_is_processing_step(prop, steps)
    return _oc_is_processing_step(_resource(resources, "/Properties", prop), steps)


def _scan(stream, resources, steps: dict, inside: set, outside: set,
          *, in_step: bool, seen: set, depth: int) -> None:
    """One content stream, attributing every colorant to a side.

    `in_step` carries the enclosing state into a form XObject: an XObject
    invoked from inside a die-line section paints inside it, whatever the
    XObject's own dictionary says.
    """
    try:
        instructions = pikepdf.parse_content_stream(stream)
    except Exception:
        return
    mc_depth = 0
    step_at = 0 if in_step else None

    def sink() -> set:
        return inside if step_at is not None else outside

    for instruction in instructions:
        try:
            operator = str(instruction.operator)
            operands = list(instruction.operands)
        except Exception:
            continue

        if operator in ("BDC", "BMC"):
            mc_depth += 1
            if (step_at is None and operator == "BDC"
                    and _bdc_opens_step(operands, resources, steps)):
                step_at = mc_depth
            continue
        if operator == "EMC":
            if step_at is not None and step_at == mc_depth:
                step_at = None
            mc_depth = max(0, mc_depth - 1)
            continue

        if operator in ("cs", "CS") and operands:
            _colorants(operands[0], resources, sink())
        elif operator in ("scn", "SCN") and operands:
            pattern = _resource(resources, "/Pattern", operands[-1])
            if pattern is not None:
                _pattern(pattern, steps, inside, outside,
                         in_step=step_at is not None, seen=seen, depth=depth)
        elif operator == "sh" and operands:
            shading = _resource(resources, "/Shading", operands[0])
            if isinstance(shading, pikepdf.Dictionary):
                _colorants(shading.get("/ColorSpace"), resources, sink())
        elif operator == "Do" and operands:
            xobject = _resource(resources, "/XObject", operands[0])
            _xobject(xobject, steps, inside, outside,
                     in_step=step_at is not None, seen=seen, depth=depth)
        elif operator == "INLINE IMAGE":
            # An inline image may only name a device space or one of the
            # page's own; the named case resolves through /Resources.
            try:
                _colorants(instruction.operands[0].colorspace, resources, sink())
            except Exception:
                continue


def _xobject(xobject, steps: dict, inside: set, outside: set,
             *, in_step: bool, seen: set, depth: int) -> None:
    if not isinstance(xobject, pikepdf.Stream) or depth >= _MAX_FORM_DEPTH:
        return
    key = _objgen(xobject)
    own = _oc_is_processing_step(xobject.get("/OC"), steps)
    marker = (key, in_step or own)
    if key is not None:
        if marker in seen:
            return
        seen.add(marker)
    subtype = _text(xobject.get("/Subtype"))
    if subtype == "Image":
        target = inside if (in_step or own) else outside
        _colorants(xobject.get("/ColorSpace"), xobject.get("/Resources"), target)
        return
    _scan(xobject, xobject.get("/Resources"), steps, inside, outside,
          in_step=in_step or own, seen=seen, depth=depth + 1)


def _pattern(pattern, steps: dict, inside: set, outside: set,
             *, in_step: bool, seen: set, depth: int) -> None:
    if not isinstance(pattern, (pikepdf.Dictionary, pikepdf.Stream)):
        return
    shading = pattern.get("/Shading")
    if isinstance(shading, pikepdf.Dictionary):
        _colorants(shading.get("/ColorSpace"), pattern.get("/Resources"),
                   inside if in_step else outside)
        return
    if isinstance(pattern, pikepdf.Stream) and depth < _MAX_FORM_DEPTH:
        _scan(pattern, pattern.get("/Resources"), steps, inside, outside,
              in_step=in_step, seen=seen, depth=depth + 1)


def page_colorant_split(page, steps: dict) -> tuple[set, set]:
    """(painted on a processing step, painted anywhere else) for one page.

    A colorant in the first set and not the second is laid down ONLY by
    processing-step content — it is a die-line or varnish plate and belongs
    off the printing plate list. A colorant in both stays: an ink used by the
    artwork does not stop being an ink because the die line also uses it.

    A colorant DECLARED in `/Resources` and never painted by any operator
    lands in neither set. It is left alone deliberately: nothing attributes
    it to a layer, so the inventory keeps reporting it exactly as before.
    """
    inside: set = set()
    outside: set = set()
    if not steps:
        return inside, outside
    resources = page.obj.get("/Resources")
    _scan(page, resources, steps, inside, outside,
          in_step=False, seen=set(), depth=0)

    annots = page.obj.get("/Annots")
    if isinstance(annots, pikepdf.Array):
        for annot in annots:
            if not isinstance(annot, pikepdf.Dictionary):
                continue
            on_step = _oc_is_processing_step(annot.get("/OC"), steps)
            appearance = annot.get("/AP")
            if not isinstance(appearance, pikepdf.Dictionary):
                continue
            normal = appearance.get("/N")
            if isinstance(normal, pikepdf.Dictionary) and not isinstance(
                normal, pikepdf.Stream
            ):
                states = [v for v in normal.values()]
            else:
                states = [normal]
            for state in states:
                _xobject(state, steps, inside, outside,
                         in_step=on_step, seen=set(), depth=0)
    return inside, outside


def processing_step_only_colorants(pdf, page_numbers) -> set:
    """Colorants laid down ONLY by processing-step content, across the pages.

    Document-wide, not per page: an ink is one plate for the job, so a
    colorant the artwork paints on page 2 is a printing ink on page 1's plate
    list too.
    """
    steps = processing_step_ocgs(pdf)
    if not steps:
        return set()
    inside: set = set()
    outside: set = set()
    for number in page_numbers:
        page_inside, page_outside = page_colorant_split(pdf.pages[number - 1], steps)
        inside |= page_inside
        outside |= page_outside
    return inside - outside


def prints_by_default(ocg, off: set) -> bool:
    """Would a device that prints the default configuration lay this group down?

    Two things can take a group off the print, and they are not the same
    thing. `/D /OFF` hides it everywhere, screen included. The optional
    content USAGE entry `/Usage /Print /PrintState /OFF` (ISO 32000-2 8.11.4)
    takes it off the PRINT while leaving it on screen, which is what a die
    line wants: visible to the person, absent from the plate.

    A group in neither state prints. Note what that does NOT mean: the whole
    GWG test corpus leaves its processing-step groups printing in exactly
    this sense, and every one of those files is a compliant file. Whether a
    packaging file OUGHT to carry the usage entry is a house rule, which is
    why the check that reads this is off by default.
    """
    if _objgen(ocg) in off:
        return False
    usage = ocg.get("/Usage") if isinstance(ocg, pikepdf.Dictionary) else None
    if isinstance(usage, pikepdf.Dictionary):
        printing = usage.get("/Print")
        if isinstance(printing, pikepdf.Dictionary):
            if _text(printing.get("/PrintState")) == "OFF":
                return False
    return True


def document_processing_steps(file: str) -> dict:
    """Every declared processing step in one document, for a report.

    `printing` is `prints_by_default` above: nothing hides the group and
    nothing declares it off the print, so a device that prints the default
    configuration puts it on a plate.
    """
    from engine.sanitize_content import off_ocg_set

    with pikepdf.open(file) as pdf:
        steps = processing_step_ocgs(pdf)
        off = off_ocg_set(pdf)
        rows = []
        ocp = pdf.Root.get("/OCProperties")
        ocgs = ocp.get("/OCGs") if isinstance(ocp, pikepdf.Dictionary) else None
        order = list(ocgs) if isinstance(ocgs, pikepdf.Array) else []
        for index, ocg in enumerate(order):
            key = _objgen(ocg)
            step = steps.get(key)
            if step is None:
                continue
            rows.append(dict(step, index=index,
                             printing=prints_by_default(ocg, off)))
        return {"steps": rows, "count": len(rows)}
