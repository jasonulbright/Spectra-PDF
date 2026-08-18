"""Ink Manager — aliasing, spot-to-process conversion, density and sequence.

**Aliasing is a name rewrite.** The separation device plates BY THE COLORANT
NAME, so two `/Separation` spaces that name one ink land on one plate the
moment they spell it the same way. The transform is element 1 of the
`/Separation` array, the matching entry of a `/DeviceN` `/Names` array, and
the key of its `/Attributes /Colorants` dictionary — nothing else.

**Aliasing two spaces whose tint transforms disagree changes the document's
appearance**, because the surviving name carries one transform and the
document had two. `compare_tint_transforms` measures the disagreement over
eleven tints; the applied door refuses without explicit consent.

**Spot to process is a content rewrite, not a whole-file conversion.** Every
`cs`/`scn` pair for the ink becomes the alternate space's operator with the
components its own tint transform produces; image samples convert through the
same transform; a shading's colour space is replaced and the transform is
composed onto its function. This is exact and it preserves vectors — unlike
the document-wide colour conversion, which is a different capability and stays
one.

**Composing onto a shading's function samples ONE input, so a shading whose
colour is not a function of one input cannot be converted that way.** Such a
shading is skipped IN PLACE — the colorant stays live in it — and named in the
result's `skipped` list, so the caller reads a partial conversion as partial.
One shading that cannot convert never refuses the whole operation, and it is
never converted anyway with colour the composition invented.

**A DeviceN converts whole or not at all.** Its components are painted
together through one transform, so there is no operator that could route one
component through the alternate and leave the rest in DeviceN. Converting any
component therefore converts the space, and the result names every colorant
that went with it.

**Neutral density and print sequence are not PDF keys.** No such entry exists
in any colour space or page dictionary, so they are stored as application
settings and drive exactly two things: how dark an ink renders in the
separation preview's composite, and the order the plates are listed in.
"""

from __future__ import annotations

import pikepdf
from pikepdf import Array, Dictionary, Name

from .color_spaces import build_function
from .separations import PROCESS_INKS, ink_kind, list_inks
from .validate import validate_pdf
from engine.pdf_save import save_pdf

_MAX_DEPTH = 12
# Tints the two transforms are compared at, endpoints included.
_TINT_SAMPLES = 11
# A component difference this small cannot survive 8-bit output.
_TINT_TOLERANCE = 1.0 / 255.0
# Samples a composed shading function is written with when neither half is a
# straight line. The RIP interpolates a sampled function the same way.
_SHADING_SAMPLES = 1024

_DEVICE_COMPONENTS = {"/DeviceGray": 1, "/DeviceRGB": 3, "/DeviceCMYK": 4}
_DEVICE_OPERATORS = {1: ("g", "G"), 3: ("rg", "RG"), 4: ("k", "K")}

# Why composing a tint transform onto a shading's function would not describe
# the shading's colour. Reported verbatim; they are report text, not refusals.
SHADING_PLANAR = "the shading maps a point in the plane, not one parametric value"
SHADING_BACKGROUND = "the shading states a background colour in the colorant's own space"
SHADING_UNREADABLE = "the shading's type or domain cannot be read"
SHADING_NO_TRANSFORM = "the colorant's tint transform cannot be read"
SHADING_NO_ALTERNATE = "the alternate colour space has no component count"
SHADING_NO_COMPOSE = "the shading's function cannot be composed with the tint transform"


def _name_text(obj) -> str:
    text = str(obj)
    return text[1:] if text.startswith("/") else text


# ── the resource walk ──────────────────────────────────────────────────────


def _content_owners(pdf, annotations: bool = True):
    """Every object that owns a content stream and a `/Resources`.

    Pages, Form XObjects, tiling patterns and annotation appearance streams
    all paint, so all four must be rewritten — an ink that survives in a
    pattern is an ink the user was told had been converted.

    `annotations=False` stops at the page tier. An appearance stream is not
    reachable from page content, so a caller that rewrites page content and
    then reads the result back cannot see one; the prepress carve-out asks for
    exactly that boundary.
    """
    seen: set = set()
    out: list = []

    def mark(obj) -> bool:
        ident = obj.objgen if getattr(obj, "is_indirect", False) else id(obj)
        if ident in seen:
            return False
        seen.add(ident)
        return True

    def visit(owner, resources, depth: int) -> None:
        if resources is None or depth > _MAX_DEPTH:
            return
        for key in ("/XObject", "/Pattern"):
            group = resources.get(key)
            if group is None:
                continue
            for entry in list(group.keys()):
                try:
                    obj = group[entry]
                except Exception:
                    continue
                if not isinstance(obj, pikepdf.Stream) or not mark(obj):
                    continue
                if key == "/XObject" and str(obj.get("/Subtype")) != "/Form":
                    continue
                out.append(obj)
                visit(obj, obj.get("/Resources"), depth + 1)

    for page in pdf.pages:
        out.append(page.obj)
        visit(page.obj, page.obj.get("/Resources"), 0)
        annots = page.obj.get("/Annots") if annotations else None
        if annots is None:
            continue
        for annot in list(annots):
            try:
                ap = annot.get("/AP")
            except Exception:
                continue
            if ap is None:
                continue
            for state in list(ap.keys()):
                entry = ap[state]
                streams = [entry] if isinstance(entry, pikepdf.Stream) else [
                    entry[k] for k in list(entry.keys())
                ]
                for stream in streams:
                    if not isinstance(stream, pikepdf.Stream) or not mark(stream):
                        continue
                    out.append(stream)
                    visit(stream, stream.get("/Resources"), 1)
    return out


def _colorspace_dicts(pdf):
    """Every `/Resources /ColorSpace` dictionary in the document."""
    out = []
    for owner in _content_owners(pdf):
        resources = owner.get("/Resources")
        if resources is None:
            continue
        table = resources.get("/ColorSpace")
        if table is not None:
            out.append(table)
    return out


def _shading_dicts(pdf, annotations: bool = True):
    """Every shading, whether named in `/Shading` or worn by a pattern."""
    out = []
    seen: set = set()

    def add(obj):
        ident = obj.objgen if getattr(obj, "is_indirect", False) else id(obj)
        if ident in seen:
            return
        seen.add(ident)
        out.append(obj)

    for owner in _content_owners(pdf, annotations):
        resources = owner.get("/Resources")
        if resources is None:
            continue
        shadings = resources.get("/Shading")
        if shadings is not None:
            for key in list(shadings.keys()):
                add(shadings[key])
        patterns = resources.get("/Pattern")
        if patterns is not None:
            for key in list(patterns.keys()):
                pattern = patterns[key]
                shading = pattern.get("/Shading") if pattern is not None else None
                if shading is not None:
                    add(shading)
    return out


def shading_skip_reason(shading) -> str | None:
    """Why the tint transform cannot be composed onto this shading's function,
    or None when it can.

    Composing samples ONE input. A function-based shading (type 1) maps a point
    in the plane instead — two inputs, a four-entry `/Domain` — so a composition
    driven by one input does not describe its colour; it invents one. A
    `/Background` is stated in the shading's OWN colour space and the
    composition does not reach it, so replacing that space would leave
    components naming a colorant the shading no longer has.

    One predicate for both callers: the spot-to-process rewrite skips what it
    reports, and the prepress carve-out hands the same shadings to the producer.
    """
    try:
        if int(shading.get("/ShadingType") or 0) == 1:
            return SHADING_PLANAR
        domain = shading.get("/Domain")
        if domain is not None and len(domain) != 2:
            return SHADING_PLANAR
        if shading.get("/Background") is not None:
            return SHADING_BACKGROUND
    except (TypeError, ValueError):
        return SHADING_UNREADABLE
    return None


def _images(pdf):
    """Every image XObject reachable from a painting owner."""
    out = []
    seen: set = set()
    for owner in _content_owners(pdf):
        resources = owner.get("/Resources")
        if resources is None:
            continue
        xobjects = resources.get("/XObject")
        if xobjects is None:
            continue
        for key in list(xobjects.keys()):
            obj = xobjects[key]
            if not isinstance(obj, pikepdf.Stream):
                continue
            if str(obj.get("/Subtype")) != "/Image":
                continue
            ident = obj.objgen if getattr(obj, "is_indirect", False) else id(obj)
            if ident in seen:
                continue
            seen.add(ident)
            out.append(obj)
    return out


def _is_separation(cs) -> bool:
    return (isinstance(cs, pikepdf.Array) and len(cs) >= 4
            and _name_text(cs[0]) == "Separation")


def _is_devicen(cs) -> bool:
    return (isinstance(cs, pikepdf.Array) and len(cs) >= 4
            and _name_text(cs[0]) == "DeviceN")


def _colorant_names(cs) -> list[str]:
    if _is_separation(cs):
        return [_name_text(cs[1])]
    if _is_devicen(cs):
        try:
            return [_name_text(n) for n in cs[1]]
        except TypeError:
            return []
    return []


# ── tint-transform comparison ──────────────────────────────────────────────


def _alternate_signature(cs) -> str:
    alt = cs[2]
    if isinstance(alt, pikepdf.Array) and len(alt) > 0:
        family = _name_text(alt[0])
        if family == "ICCBased" and len(alt) >= 2:
            try:
                return f"ICCBased/{int(alt[1].get('/N'))}"
            except (TypeError, ValueError, AttributeError):
                return "ICCBased/?"
        return family
    return _name_text(alt)


def _first_space_named(pdf, name: str):
    """The first `/Separation` array in the document for this colorant.

    A colorant can appear as a `/Separation` of its own OR as a component of
    a `/DeviceN`, whose `/Attributes /Colorants` names the same Separation —
    both are the transform this ink prints through, so both are searched.
    """
    fallback = None
    for table in _colorspace_dicts(pdf):
        for key in list(table.keys()):
            cs = table[key]
            if _is_separation(cs) and _name_text(cs[1]) == name:
                return cs
            if _is_devicen(cs) and name in _colorant_names(cs) and len(cs) >= 5:
                attrs = cs[4]
                colorants = attrs.get("/Colorants") if attrs is not None else None
                if colorants is not None:
                    own = colorants.get(Name("/" + name))
                    if _is_separation(own):
                        fallback = fallback or own
    return fallback


def compare_tint_transforms(file: str, a: str, b: str) -> dict:
    """Do two colorants describe the same colour?

    Args:
        file: Input PDF path.
        a: One colorant name.
        b: The other.

    Compares the alternate spaces first, then the tint transforms at eleven
    tints from 0 to 1. `diverges_at` is the first tint whose components differ
    by more than one 8-bit step — the value that makes a disagreement
    checkable rather than asserted.
    """
    validate_pdf(file)
    with pikepdf.open(file) as pdf:
        space_a = _first_space_named(pdf, a)
        space_b = _first_space_named(pdf, b)
        for name, space in ((a, space_a), (b, space_b)):
            if space is None:
                raise ValueError(f'Ink "{name}" is not used in this document.')
        alt_a = _alternate_signature(space_a)
        alt_b = _alternate_signature(space_b)
        fn_a = build_function(space_a[3])
        fn_b = build_function(space_b[3])
        if fn_a is None or fn_b is None:
            return {
                "match": False, "alternate_a": alt_a, "alternate_b": alt_b,
                "diverges_at": 0.0, "max_delta": 1.0,
                "reason": "unreadable_transform",
            }
        if alt_a != alt_b:
            return {
                "match": False, "alternate_a": alt_a, "alternate_b": alt_b,
                "diverges_at": 0.0, "max_delta": 1.0,
                "reason": "alternate",
            }
        diverges_at = None
        max_delta = 0.0
        for step in range(_TINT_SAMPLES):
            tint = step / (_TINT_SAMPLES - 1)
            out_a = fn_a([tint])
            out_b = fn_b([tint])
            if out_a is None or out_b is None or len(out_a) != len(out_b):
                diverges_at = tint if diverges_at is None else diverges_at
                max_delta = 1.0
                break
            delta = max(abs(x - y) for x, y in zip(out_a, out_b)) if out_a else 0.0
            max_delta = max(max_delta, delta)
            if delta > _TINT_TOLERANCE and diverges_at is None:
                diverges_at = tint
        return {
            "match": diverges_at is None,
            "alternate_a": alt_a,
            "alternate_b": alt_b,
            "diverges_at": diverges_at,
            "max_delta": max_delta,
            "reason": "" if diverges_at is None else "transform",
        }


# ── aliasing ───────────────────────────────────────────────────────────────


def alias_ink(
    file: str,
    output: str,
    source: str,
    target: str,
    accept_target_transform: bool = False,
) -> dict:
    """Make `source` print on `target`'s plate.

    Args:
        file: Input PDF path.
        output: Output PDF path.
        source: The colorant to rename.
        target: The colorant it joins.
        accept_target_transform: Consent to the appearance change when the
            two tint transforms disagree — the surviving name carries ONE
            transform and the document had two.

    A process ink is never aliased onto a spot: the four process plates are
    what the press runs, and moving one onto a spot plate would silently drop
    it from the job.
    """
    validate_pdf(file)
    source = str(source)
    target = str(target)
    if source == target:
        raise ValueError(f'Ink "{source}" is not used in this document.')
    if ink_kind(source) == "process" and ink_kind(target) != "process":
        raise ValueError("Process inks cannot be aliased to a spot colour.")

    comparison = compare_tint_transforms(file, source, target)
    if not comparison["match"] and not accept_target_transform:
        raise ValueError(
            f'"{source}" and "{target}" describe different colours; '
            "aliasing them will change the document's appearance."
        )

    renamed = 0
    with pikepdf.open(file) as pdf:
        for table in _colorspace_dicts(pdf):
            for key in list(table.keys()):
                cs = table[key]
                if _is_separation(cs) and _name_text(cs[1]) == source:
                    cs[1] = Name("/" + target)
                    renamed += 1
                elif _is_devicen(cs):
                    names = cs[1]
                    for index in range(len(names)):
                        if _name_text(names[index]) == source:
                            names[index] = Name("/" + target)
                            renamed += 1
                    if len(cs) >= 5:
                        attrs = cs[4]
                        colorants = attrs.get("/Colorants") if attrs is not None else None
                        if colorants is not None and Name("/" + source) in colorants:
                            colorants[Name("/" + target)] = colorants[Name("/" + source)]
                            del colorants[Name("/" + source)]
        if renamed == 0:
            raise ValueError(f'Ink "{source}" is not used in this document.')
        save_pdf(pdf, output)
    return {
        "source": source,
        "target": target,
        "renamed": renamed,
        "transforms_matched": comparison["match"],
        "diverges_at": comparison["diverges_at"],
    }


# ── spot to process ────────────────────────────────────────────────────────


def _alternate_operand(alt):
    """How the alternate space is named in a `cs` operand, and how many
    components its `scn` takes."""
    if isinstance(alt, (pikepdf.Name, str)):
        family = str(alt) if str(alt).startswith("/") else "/" + str(alt)
        return family, _DEVICE_COMPONENTS.get(family)
    if isinstance(alt, pikepdf.Array) and len(alt) > 0:
        family = _name_text(alt[0])
        if family in ("DeviceGray", "DeviceRGB", "DeviceCMYK"):
            return "/" + family, _DEVICE_COMPONENTS["/" + family]
        if family == "ICCBased" and len(alt) >= 2:
            try:
                return None, int(alt[1].get("/N"))
            except (TypeError, ValueError, AttributeError):
                return None, None
        if family == "Lab":
            return None, 3
        if family == "CalRGB":
            return None, 3
        if family == "CalGray":
            return None, 1
    return None, None


def _install_alternate(resources, alt, cache: dict) -> str:
    """The resource name a `cs` operand can use for the alternate space.

    A device space names itself; anything else is added to the owner's
    `/ColorSpace` under a fresh key, because an operand must be a name.
    """
    direct, _ = _alternate_operand(alt)
    if direct is not None:
        return direct
    table = resources.get("/ColorSpace")
    if table is None:
        table = Dictionary()
        resources["/ColorSpace"] = table
    key = cache.get(id(resources))
    if key is not None:
        return key
    index = 0
    while Name(f"/InkAlt{index}") in table:
        index += 1
    key = f"/InkAlt{index}"
    table[Name(key)] = alt
    cache[id(resources)] = key
    return key


def _paint_operator(alt, stroke: bool) -> str | None:
    _, components = _alternate_operand(alt)
    pair = _DEVICE_OPERATORS.get(components or 0)
    if pair is None:
        return None
    return pair[1] if stroke else pair[0]


def _numeric_operands(operands) -> list[float] | None:
    """The operands as floats, or None when any of them is not a number.

    A content-stream operand arrives as a Python int, a Decimal or a pikepdf
    object depending on how it was written, so the test is whether it
    CONVERTS — a type check misses the Decimal a fractional tint parses to.
    """
    values: list[float] = []
    for operand in operands:
        try:
            values.append(float(operand))
        except (TypeError, ValueError):
            return None
    return values


def _rewrite_stream(pdf, owner, targets: dict, alt_cache: dict) -> int:
    """Replace every selection-and-paint of a target space in one stream.

    `targets` maps a resource key to (colour-space array, tint function,
    alternate). A `cs` that selects a target arms the rewrite; the `scn` that
    follows carries the tint through the transform and paints in the alternate
    instead.
    """
    resources = owner.get("/Resources")
    if resources is None:
        return 0
    try:
        instructions = list(pikepdf.parse_content_stream(owner))
    except Exception as exc:
        name = next(iter(targets.values()))[3]
        raise ValueError(
            f'Ink "{name}" is used by a pattern this tool cannot rewrite.'
        ) from exc

    out = []
    armed = {"fill": None, "stroke": None}
    changed = 0
    for instruction in instructions:
        operator = str(instruction.operator)
        operands = list(instruction.operands)
        if operator in ("cs", "CS") and operands:
            key = str(operands[0])
            slot = "fill" if operator == "cs" else "stroke"
            target = targets.get(key)
            if target is not None:
                cs, tint, alt, _name = target
                armed[slot] = target
                operand = _install_alternate(resources, alt, alt_cache)
                out.append(pikepdf.ContentStreamInstruction(
                    [Name(operand)], pikepdf.Operator(operator)))
                continue
            armed[slot] = None
        elif operator in ("scn", "SCN", "sc", "SC"):
            slot = "fill" if operator in ("scn", "sc") else "stroke"
            target = armed[slot]
            if target is not None:
                cs, tint, alt, _name = target
                # A pattern selection carries a NAME operand, not a tint —
                # it selects the pattern, and the pattern's own stream is
                # rewritten as its own owner.
                numbers = _numeric_operands(operands)
                converted = tint(numbers) if numbers else None
                paint = _paint_operator(alt, slot == "stroke")
                if converted is not None and paint is not None:
                    out.append(pikepdf.ContentStreamInstruction(
                        [round(float(v), 6) for v in converted],
                        pikepdf.Operator(paint)))
                    changed += 1
                    continue
                if converted is not None:
                    out.append(pikepdf.ContentStreamInstruction(
                        [round(float(v), 6) for v in converted],
                        pikepdf.Operator("scn" if slot == "fill" else "SCN")))
                    changed += 1
                    continue
        out.append(instruction)
    if changed:
        data = pikepdf.unparse_content_stream(out)
        if isinstance(owner, pikepdf.Stream):
            owner.write(data)
        else:
            # A page owns its content by reference, and may own several
            # streams; the parse concatenated them, so the rewrite replaces
            # the whole reference with one stream.
            owner["/Contents"] = pdf.make_stream(data)
    return changed


def _convert_images(pdf, target_names: set[str]) -> int:
    """Convert image samples out of a target space through its transform."""
    import numpy as np

    converted = 0
    for image in _images(pdf):
        cs = image.get("/ColorSpace")
        if cs is None or not (_is_separation(cs) or _is_devicen(cs)):
            continue
        if not (set(_colorant_names(cs)) & target_names):
            continue
        tint = build_function(cs[3])
        alt = cs[2]
        _, out_components = _alternate_operand(alt)
        if tint is None or out_components is None:
            continue
        try:
            width = int(image.get("/Width"))
            height = int(image.get("/Height"))
            bits = int(image.get("/BitsPerComponent") or 8)
            raw = image.read_bytes()
        except Exception:
            continue
        if bits != 8:
            continue
        in_components = len(_colorant_names(cs))
        expected = width * height * in_components
        if len(raw) < expected:
            continue
        samples = np.frombuffer(raw[:expected], dtype=np.uint8).reshape(-1, in_components)
        unique, inverse = np.unique(samples, axis=0, return_inverse=True)
        table = np.zeros((len(unique), out_components), dtype=np.float32)
        for row, tuple_in in enumerate(unique):
            value = tint([float(v) / 255.0 for v in tuple_in])
            if value is None:
                table[row] = 0.0
            else:
                table[row] = [max(0.0, min(1.0, float(v))) for v in value[:out_components]]
        out = (table[inverse] * 255.0).round().astype(np.uint8)
        image.write(out.tobytes())
        image.ColorSpace = alt
        converted += 1
    return converted


def _compose_shading_function(pdf, shading, tint, out_components: int):
    """The shading's own function, followed by the tint transform.

    Two straight lines compose to a straight line, so that case is written
    exactly as a type-2 function. Anything else is written as a sampled
    function — which is what the interpolation on the other side does with it
    regardless.

    The owning `pdf` is passed in: a sampled result is a STREAM, and a stream
    needs the document it will belong to — a pikepdf object cannot name its
    own owner.
    """
    fn_obj = shading.get("/Function")
    if fn_obj is None:
        return None
    shading_fn = build_function(fn_obj)
    if shading_fn is None:
        return None
    domain = [0.0, 1.0]
    try:
        raw = shading.get("/Domain")
        if raw is not None:
            domain = [float(v) for v in raw][:2]
    except (TypeError, ValueError):
        pass

    def composed(t: float):
        mid = shading_fn([t])
        if mid is None:
            return None
        return tint(list(mid))

    linear = (
        isinstance(fn_obj, pikepdf.Dictionary)
        and int(fn_obj.get("/FunctionType") or 0) == 2
        and abs(float(fn_obj.get("/N") or 1) - 1.0) < 1e-9
    )
    if linear:
        lo = composed(domain[0])
        hi = composed(domain[1])
        mid = composed((domain[0] + domain[1]) / 2.0)
        if lo is not None and hi is not None and mid is not None:
            straight = all(
                abs(((a + b) / 2.0) - m) <= _TINT_TOLERANCE
                for a, b, m in zip(lo, hi, mid)
            )
            if straight:
                return Dictionary(
                    FunctionType=2, Domain=Array(domain), N=1,
                    C0=Array([round(float(v), 6) for v in lo[:out_components]]),
                    C1=Array([round(float(v), 6) for v in hi[:out_components]]),
                    Range=Array([0, 1] * out_components),
                )

    samples = bytearray()
    for step in range(_SHADING_SAMPLES):
        t = domain[0] + (domain[1] - domain[0]) * step / (_SHADING_SAMPLES - 1)
        value = composed(t)
        if value is None:
            return None
        for component in value[:out_components]:
            samples.append(max(0, min(255, int(round(float(component) * 255.0)))))
    return pikepdf.Stream(
        pdf, bytes(samples),
        FunctionType=0, Domain=Array(domain), Range=Array([0, 1] * out_components),
        Size=Array([_SHADING_SAMPLES]), BitsPerSample=8,
    )


def _convert_shadings(pdf, target_names: set[str]):
    """(shadings converted, a record per shading left alone).

    A shading the composition cannot describe is left exactly as it was — the
    colorant stays live in it — and recorded. `shading` is the resource walk's
    position, which is stable for one document: walking it again yields the
    same numbering.
    """
    converted = 0
    skipped: list[dict] = []
    for index, shading in enumerate(_shading_dicts(pdf), start=1):
        cs = shading.get("/ColorSpace")
        if cs is None or not (_is_separation(cs) or _is_devicen(cs)):
            continue
        colorants = sorted(set(_colorant_names(cs)) & target_names)
        if not colorants:
            continue

        def skip(reason: str, _index=index, _colorants=colorants) -> None:
            skipped.append({
                "shading": _index, "colorants": _colorants, "reason": reason,
            })

        reason = shading_skip_reason(shading)
        if reason is not None:
            skip(reason)
            continue
        tint = build_function(cs[3])
        if tint is None:
            skip(SHADING_NO_TRANSFORM)
            continue
        alt = cs[2]
        _, out_components = _alternate_operand(alt)
        if out_components is None:
            skip(SHADING_NO_ALTERNATE)
            continue
        replacement = _compose_shading_function(pdf, shading, tint, out_components)
        if replacement is None:
            skip(SHADING_NO_COMPOSE)
            continue
        shading["/ColorSpace"] = alt
        shading["/Function"] = pdf.make_indirect(replacement)
        converted += 1
    return converted, skipped


def _names_selecting(resources, key: str) -> bool:
    """Does anything in these resources still SELECT this colour-space key by
    name? An image or a shading may carry `/ColorSpace /S2` rather than the
    array itself, and those two are converted by their own passes only where
    the array is inline — so a key one of them still names stays."""
    wanted = pikepdf.Name("/" + key.lstrip("/"))
    for group_key in ("/XObject", "/Shading", "/Pattern"):
        group = resources.get(group_key)
        if not isinstance(group, pikepdf.Dictionary):
            continue
        for entry in list(group.keys()):
            try:
                obj = group[entry]
                if obj.get("/ColorSpace") == wanted:
                    return True
                shading = obj.get("/Shading")
                if shading is not None and shading.get("/ColorSpace") == wanted:
                    return True
            except Exception:  # noqa: BLE001 — an unreadable entry keeps the key
                return True
    return False


def _drop_converted_spaces(resources, table, targets: dict) -> None:
    """Remove the declarations the rewrite just stopped using.

    Converting the PAINTS and leaving the `/Separation` in `/ColorSpace` left
    the plate still declared: every reader that counts plates from the
    resource tables — this app's own ink list among them — went on reporting a
    colorant nothing prints. A conversion that does not remove the declaration
    has not converted the plate, only the marks on it.
    """
    for key in targets:
        if _names_selecting(resources, key):
            continue
        try:
            del table[pikepdf.Name("/" + key.lstrip("/"))]
        except Exception:  # noqa: BLE001 — a key that will not delete stays
            continue


def spot_to_process(
    file: str,
    output: str,
    inks: list,
    pages=None,
) -> dict:
    """Replace named colorants with their alternate space, everywhere.

    Args:
        file: Input PDF path.
        output: Output PDF path.
        inks: Colorant names to convert.
        pages: Accepted and reported; a colour space is a document-level
            object, so converting it on one page and not another would need
            two copies of it and is not what the caller asked for.

    Content streams, image samples, shadings and patterns all convert through
    the colorant's own tint transform, so the result is exact and stays
    vector. A DeviceN converts whole — its components paint together through
    one transform — and the result names every colorant that went with it.

    `skipped` names each shading the composition could not describe, with the
    colorants still live in it and the reason. A shading is skipped in place
    and the conversion proceeds: one gradient that cannot convert costs that
    gradient, not the whole operation, and the caller can tell a whole
    conversion from a partial one without reading the file back.
    """
    validate_pdf(file)
    wanted = {str(name) for name in inks}
    if not wanted:
        raise ValueError("Name at least one ink to convert.")

    inventory = {e["name"]: e for e in list_inks(file)["inks"]}
    for name in sorted(wanted):
        if name not in inventory:
            raise ValueError(f'Ink "{name}" is not used in this document.')

    carried: set[str] = set()
    converted_spaces = 0
    changed_paints = 0

    with pikepdf.open(file) as pdf:
        # Which resource keys, in which owner, select a space that must go.
        for name in sorted(wanted):
            space = _first_space_named(pdf, name)
            if space is not None and space[2] is None:
                raise ValueError(f'Ink "{name}" declares no alternate colour space.')

        alt_cache: dict = {}
        for owner in _content_owners(pdf):
            resources = owner.get("/Resources")
            if resources is None:
                continue
            table = resources.get("/ColorSpace")
            if table is None:
                continue
            targets: dict = {}
            for key in list(table.keys()):
                cs = table[key]
                if not (_is_separation(cs) or _is_devicen(cs)):
                    continue
                names = _colorant_names(cs)
                if not (set(names) & wanted):
                    continue
                alt = cs[2]
                if alt is None:
                    raise ValueError(
                        f'Ink "{names[0]}" declares no alternate colour space.'
                    )
                tint = build_function(cs[3])
                if tint is None:
                    raise ValueError(
                        f'Ink "{names[0]}" declares no alternate colour space.'
                    )
                _, out_components = _alternate_operand(alt)
                if out_components is None:
                    raise ValueError(
                        f'Ink "{names[0]}" declares no alternate colour space.'
                    )
                carried.update(set(names) - wanted)
                targets[str(key)] = (cs, tint, alt, names[0])
                converted_spaces += 1
            if targets:
                changed_paints += _rewrite_stream(pdf, owner, targets, alt_cache)
                _drop_converted_spaces(resources, table, targets)

        changed_images = _convert_images(pdf, wanted)
        changed_shadings, skipped_shadings = _convert_shadings(pdf, wanted)
        save_pdf(pdf, output)

    return {
        "inks": sorted(wanted),
        "carried": sorted(carried),
        "spaces": converted_spaces,
        "paints": changed_paints,
        "images": changed_images,
        "shadings": changed_shadings,
        "skipped": skipped_shadings,
        "pages": pages,
    }


# ── density and print sequence ─────────────────────────────────────────────


def ink_settings_defaults(file: str) -> dict:
    """The starting density and print sequence for a document's inks.

    Neither value is a PDF key: no colour space or page dictionary carries
    one. They are application settings, and what they drive is the preview's
    compositing and the order the plates are listed in.
    """
    inventory = list_inks(file)["inks"]
    order: list[str] = []
    for name in PROCESS_INKS:
        if any(e["name"] == name for e in inventory):
            order.append(name)
    order.extend(e["name"] for e in inventory if e["kind"] == "spot")
    return {
        "sequence": order,
        "density": {name: 1.0 for name in order},
        "stored_in_document": False,
    }
