"""Separation preview — the ink inventory and the separation raster.

Three capabilities, in the order the preview uses them.

`list_inks` enumerates the `/Separation` and `/DeviceN` colorants a page can
paint with, resolving each to a display colour through `color_spaces`. It
reports what it could NOT read beside what it found: a resource branch the
walk skipped may hold an ink, and a plate inventory that answered only with
what it reached would hide one.

`render_separations` rasterizes one page to one 8-bit grayscale plate per
separation through Ghostscript's `tiffsep` device. **Plate polarity is
inverted: 0 is FULL ink and 255 is no ink.** The 4-channel composite the
device writes alongside the plates folds spots into process and therefore
cannot drive a spot toggle — the preview composites from the individual
plates instead.

`composite_separations` turns a chosen subset of those plates into an RGB PNG
plus the total-ink statistics, in numpy, so toggling an ink never re-runs
Ghostscript. With a simulation profile it composites through `soft_proof`
instead: the coverages become a CMYK accumulation buffer and one ICC
transform takes that buffer to sRGB. Without one the arithmetic is
byte-for-byte what it always was.

**Overprint can only be simulated by the separation device.** Every RGB device
renders an overprinting fill identically to a knocking-out one, so no RGB
raster — including the viewer's own — can show overprint. `-dOverprint=/disable`
turns the simulation off; nothing turns it on, because it is the default.

**`inkcov` is a page average, not an alarm.** On a page whose true maximum
total ink is 340 %, its four fractions sum to 200 %. It ships as what it is —
per-ink page coverage — and the over-limit alarm reads the per-pixel maximum
off the plates.

**Every stage frames on the CropBox.** `-dUseCropBox` puts the plates and the
coverage measurement in the frame the viewer shows. Without it a page whose
CropBox is smaller than its MediaBox rasters the larger box: the composite
stretches over a region the page never displays, and every figure measured off
it — the ink list, the per-ink coverage, the total-area alarm, the soft proof —
describes area the reader cannot see. Ghostscript intersects the CropBox with
the MediaBox, normalizes a reversed one and falls back to the MediaBox on an
empty one, which is what the viewer's own page box does, so the two frames
agree with no further normalization; both also apply `/Rotate` themselves. A
staged intermediate carries the CropBox through `pdfwrite` verbatim, so the
flag frames the staged separation too.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import tempfile
from pathlib import Path

import pikepdf

from . import budget, icc_profiles, soft_proof
from .acroform import has_form_fields
from .color_spaces import build_resolver
from .pdf_save import save_pdf
from .preflight import COLORSPACE, walk_page_resources
from .processing_steps import hide_processing_steps, processing_step_only_colorants
from .validate import validate_pdf
from .widget_faces import regenerate_appearances_file

# The four exact spellings the separation device uses for process inks. A
# colorant named anything else is a spot.
PROCESS_INKS = ("Cyan", "Magenta", "Yellow", "Black")

# The device's own spot ceiling. Past it, spots fold silently into process.
MAX_SPOTS_CEILING = 60
_MIN_SPOT_REQUEST = 10

# Printed on stdout when the device folds spots it could not keep.
_FOLD_MARKER = "Max spot colorants reached"

# Bytes the plate-filename escape replaces: the escape marker itself, plus
# every character a Windows path forbids. Everything else printable passes
# through verbatim.
_ESCAPED_BYTES = frozenset(b'%/\\:*?"<>|')

#: How far the inventory follows a colorant space nested in another's
#: alternate. ISO 32000 forbids the nesting; the cap is what keeps a
#: self-referential one from recursing.
_MAX_ALTERNATE_DEPTH = 4

#: How far the optional-content walk follows nested resource dictionaries
#: (form XObjects, tiling patterns, soft-mask groups, appearance streams).
#: Reaching it means the walk did not see every group the page can select
#: content by, and the profile staging refuses rather than carry a partial
#: set — see `_carry_off_configuration`.
_MAX_OC_RESOURCE_DEPTH = 8

#: Private key stamped on each source OCG dictionary before page extraction.
#: Extraction copies the group dictionaries whole, so the key crosses it and
#: gives the extracted page's own copies an exact identity. Stripped from the
#: staged file once the configuration is rebuilt.
_OC_KEY = "/SpectraOCKey"

_PREVIEW_DIR_NAME = "separation-preview"
# Plate sets left by earlier previews are evicted oldest-first past this many.
_MAX_CACHED_SETS = 24


def plate_name_escape(name: str) -> str:
    """The device's plate-filename spelling of an ink name.

    Every byte outside printable ASCII, and every byte in the reserved set, is
    written `%XX`; the rest pass through. Measured over an adversarial name
    set against the bundled device — and used to PREDICT the filename, never
    to parse an ink name back out of one, because the convention is the
    device's internal business and can move between versions.
    """
    out: list[str] = []
    for byte in name.encode("utf-8"):
        if 32 <= byte <= 126 and byte not in _ESCAPED_BYTES:
            out.append(chr(byte))
        else:
            out.append(f"%{byte:02X}")
    return "".join(out)


def ink_kind(name: str) -> str:
    """`process`, `all`, `none` or `spot`.

    `/All` and `/None` are not inks: `/All` paints every plate and has none of
    its own, `/None` paints nothing. Neither is ever offered as a toggle.
    """
    if name == "All":
        return "all"
    if name == "None":
        return "none"
    if name in PROCESS_INKS:
        return "process"
    return "spot"


def refuse_unknown_colorants(page: int, detail: str) -> None:
    """State that a page's inks could not all be established, as a refusal.

    The one place the sentence exists. The inventory REPORTS it (a read may
    still return the inks it did reach) and the printer-mark colour bar
    RAISES it (a write over an unknown colorant would print a bar missing a
    patch, with nothing on the sheet to say so), so both consumers make one
    claim about one document.
    """
    raise ValueError(
        f"Page {page} uses a colour space this engine cannot read, so the "
        f"inks on it cannot all be established: {detail}"
    )


def refuse_missing_plates() -> None:
    """State that a page's plate set is gone, as a refusal.

    The cache is bounded and evicts by age, so a long session across many
    documents can retire a set under a live panel. Every reader of a plate
    set fails on the same missing directory, and the one place the sentence
    exists is here so they cannot make two claims about one cache.
    """
    raise ValueError("The separation plates for this page are no longer available.")


def unknown_colorant_message(page: int, detail: str) -> str:
    """The sentence the refusal carries, for the report that must not raise.

    Asking the refusal itself keeps one wording: an inventory that described
    an unreadable colorant branch differently from the refusal it predicts
    would be two claims about one document.
    """
    try:
        refuse_unknown_colorants(page, detail)
    except ValueError as exc:
        return str(exc)
    return ""


def _name_text(obj) -> str:
    text = str(obj)
    return text[1:] if text.startswith("/") else text


def _rgb255(rgb) -> list[int]:
    return [max(0, min(255, int(round(float(c) * 255.0)))) for c in rgb]


def _separation_display(cs, resources) -> list[int] | None:
    resolver = build_resolver(cs, resources)
    if resolver is None:
        return None
    try:
        rgb = resolver([1.0])
    except Exception:
        return None
    return _rgb255(rgb) if rgb is not None and len(rgb) == 3 else None


def _devicen_component_display(cs, resources, index: int, count: int) -> list[int] | None:
    """The display colour of ONE component of a DeviceN space.

    `/Attributes /Colorants` names each component's own Separation space when
    the document supplies one; without it the component is evaluated through
    the DeviceN tint transform alone, at full tint with every sibling at zero.
    """
    try:
        attrs = cs[4] if len(cs) >= 5 else None
        colorants = attrs.get("/Colorants") if attrs is not None else None
    except Exception:
        colorants = None
    if colorants is not None:
        try:
            name = _name_text(cs[1][index])
            own = colorants.get(pikepdf.Name("/" + name))
        except Exception:
            own = None
        if own is not None:
            rgb = _separation_display(own, resources)
            if rgb is not None:
                return rgb
    resolver = build_resolver(cs, resources)
    if resolver is None:
        return None
    comps = [0.0] * count
    comps[index] = 1.0
    try:
        rgb = resolver(comps)
    except Exception:
        return None
    return _rgb255(rgb) if rgb is not None and len(rgb) == 3 else None


def _alternate_label(cs) -> str:
    try:
        alt = cs[2]
    except Exception:
        return ""
    if isinstance(alt, pikepdf.Array) and len(alt) > 0:
        return _name_text(alt[0])
    return _name_text(alt)


#: Content-stream operators that set a device colour without naming any
#: resource. A page painted entirely through them declares no colour space,
#: so the resource walk alone would report it as carrying no colour at all.
_DEVICE_COLOUR_OPS = {
    "g": "DeviceGray", "G": "DeviceGray",
    "rg": "DeviceRGB", "RG": "DeviceRGB",
    "k": "DeviceCMYK", "K": "DeviceCMYK",
}

#: The device spaces `cs`/`CS` may name directly, and the abbreviations an
#: inline image's `/CS` may spell them with.
_DEVICE_SPACE_NAMES = {
    "DeviceGray": "DeviceGray", "G": "DeviceGray",
    "DeviceRGB": "DeviceRGB", "RGB": "DeviceRGB",
    "DeviceCMYK": "DeviceCMYK", "CMYK": "DeviceCMYK",
}


def _stream_families(obj) -> set:
    """The device colour families one content stream sets inline."""
    families: set = set()
    try:
        instructions = pikepdf.parse_content_stream(obj)
    except Exception:
        return families
    for instruction in instructions:
        try:
            operator = str(instruction.operator)
        except Exception:
            continue
        family = _DEVICE_COLOUR_OPS.get(operator)
        if family is not None:
            families.add(family)
            continue
        if operator in ("cs", "CS"):
            try:
                named = _name_text(instruction.operands[0])
            except Exception:
                continue
            mapped = _DEVICE_SPACE_NAMES.get(named)
            if mapped is not None:
                families.add(mapped)
            continue
        if operator == "INLINE IMAGE":
            try:
                named = _name_text(instruction.operands[0].colorspace)
            except Exception:
                continue
            families.add(_DEVICE_SPACE_NAMES.get(named, named))
    return families


def _page_numbers(pdf, pages) -> list[int]:
    total = len(pdf.pages)
    if pages is None:
        return list(range(1, total + 1))
    if isinstance(pages, int):
        pages = [pages]
    wanted = []
    for value in pages:
        number = int(value)
        if number < 1 or number > total:
            raise ValueError(f"Page {number} is not in this document.")
        if number not in wanted:
            wanted.append(number)
    return wanted


def list_inks(file: str, pages=None, show_processing_steps: bool = False) -> dict:
    """The `/Separation` and `/DeviceN` colorants each page can paint with.

    Args:
        file: Input PDF path.
        pages: 1-based page numbers, or None for the whole document.
        show_processing_steps: True counts the non-printing processing-step
            layers (die lines, creases, varnish, white) as printing content.
            The default excludes them, which is what a plate list is FOR: a
            die line is a manufacturing instruction, not an ink, and a
            varnish colorant on the plate list would be one more plate the
            job does not have and one more ink in every total-ink figure
            measured over it. A colorant the artwork also paints stays —
            exclusion is per COLORANT, not per layer.

    Each entry carries the colorant name verbatim (an ink name is document
    content and is never translated), its kind, its alternate space, an sRGB
    display colour taken at full tint, the pages it appears on, and the
    resource categories it was reached through.

    `color_families` is every colour family the pages carry, resource spaces
    and inline device operators alike. It is what decides whether a soft
    proof has to colour-manage the page before separating it: a page made
    only of DeviceCMYK, Separation and DeviceN separates to the document's
    own ink numbers on any press, and anything else on it reached the plates
    through Ghostscript's compiled-in default.

    `unknown` is the other half of the answer. A resource branch the walk
    could not read may hold a colorant, so an inventory that reported only
    what it reached would present a plate list it has not earned — the ink
    would be missing from the plate inventory and from every total-ink figure
    measured over it, with nothing saying so. The list is empty on a document
    the walk read whole, and a caller must not read a non-empty one as
    "nothing else there".
    """
    validate_pdf(file)
    found: dict[str, dict] = {}
    unknown: list[str] = []
    families: set = set()

    with pikepdf.open(file) as pdf:
        numbers = _page_numbers(pdf, pages)
        for number in numbers:
            page = pdf.pages[number - 1]
            resources = page.obj.get("/Resources")

            def on_unreadable(facts, reason: str, _n=number) -> None:
                # Only a branch that could have held a COLORANT clouds an ink
                # inventory: an unreadable font table hides no plate.
                if COLORSPACE not in facts:
                    return
                message = unknown_colorant_message(_n, reason)
                if message not in unknown:
                    unknown.append(message)

            def record(name: str, kind: str, alternate: str, rgb, category: str) -> None:
                entry = found.get(name)
                if entry is None:
                    entry = {
                        "name": name,
                        "kind": kind,
                        "alternate": alternate,
                        "display_rgb": rgb,
                        "pages": [],
                        "used_in": [],
                    }
                    found[name] = entry
                if entry["display_rgb"] is None and rgb is not None:
                    entry["display_rgb"] = rgb
                if number not in entry["pages"]:
                    entry["pages"].append(number)
                if category not in entry["used_in"]:
                    entry["used_in"].append(category)

            def on_stream(obj, _category) -> None:
                families.update(_stream_families(obj))

            def on_colorspace(cs, category, _res=resources, _depth=0) -> None:
                if isinstance(cs, (str, pikepdf.Name)):
                    families.add(_name_text(cs))
                    return
                if not isinstance(cs, pikepdf.Array) or len(cs) < 2:
                    return
                family = _name_text(cs[0])
                families.add(family)
                if family == "Separation" and len(cs) >= 4:
                    name = _name_text(cs[1])
                    record(name, ink_kind(name), _alternate_label(cs),
                           _separation_display(cs, _res), category)
                elif family == "DeviceN" and len(cs) >= 4:
                    try:
                        names = [_name_text(n) for n in cs[1]]
                    except Exception:
                        return
                    for index, name in enumerate(names):
                        record(name, ink_kind(name), _alternate_label(cs),
                               _devicen_component_display(cs, _res, index, len(names)),
                               category)
                else:
                    return
                # A colorant space nested in another one's alternate is still
                # a colorant the device plates, and a plate the inventory does
                # not know cannot be labelled — the whole preview refuses
                # rather than mislabel one.
                if _depth < _MAX_ALTERNATE_DEPTH:
                    try:
                        alternate = cs[2]
                    except Exception:
                        return
                    if isinstance(alternate, pikepdf.Array):
                        on_colorspace(alternate, category, _res, _depth + 1)

            walk_page_resources(page, on_colorspace=on_colorspace,
                                on_stream=on_stream,
                                on_unreadable=on_unreadable)

        excluded = (
            set() if show_processing_steps
            else processing_step_only_colorants(pdf, numbers)
        )

    # Only a SPOT can be dropped. The four process plates exist for the job
    # by construction — the device writes them whether or not a named
    # `/Separation` space declares one — so removing Cyan because the only
    # named Cyan space on the page is painted on the die line would leave a
    # plate the preview cannot label. `/All` and `/None` are not plates at
    # all: the panel names them as the special colorants they are, and a
    # panel that stopped naming `/All` would be hiding an ink that paints
    # every plate.
    excluded = {name for name in excluded if ink_kind(name) == "spot"}
    for name in sorted(excluded):
        found.pop(name, None)

    inks = sorted(
        found.values(),
        key=lambda e: (("process", "spot", "all", "none").index(e["kind"]),
                       PROCESS_INKS.index(e["name"]) if e["kind"] == "process" else 0,
                       e["name"]),
    )
    spots = [e for e in inks if e["kind"] == "spot"]
    return {
        "inks": inks,
        "spot_count": len(spots),
        "pages": numbers,
        "unknown": unknown,
        "color_families": sorted(families),
        # Named, not merely absent: a plate list one ink shorter than the
        # document declares has to say which ink and why, or it reads as a
        # document that never had it.
        "processing_step_inks": sorted(excluded),
    }


# ── the separation raster ──────────────────────────────────────────────────


def _cache_root() -> Path:
    root = Path(tempfile.gettempdir()) / "spectrapdf" / _PREVIEW_DIR_NAME
    root.mkdir(parents=True, exist_ok=True)
    return root


def _evict_old_sets(root: Path) -> None:
    """Keep the plate cache bounded. A plate set is whole or absent — eviction
    removes the directory, never a plate out of a live set."""
    try:
        sets = [d for d in root.iterdir() if d.is_dir()]
    except OSError:
        return
    if len(sets) <= _MAX_CACHED_SETS:
        return
    sets.sort(key=lambda d: d.stat().st_mtime)
    for stale in sets[: len(sets) - _MAX_CACHED_SETS]:
        shutil.rmtree(stale, ignore_errors=True)


def _set_key(file: str, page: int, dpi: int, overprint: bool, profile: str = "",
             font_dir: str = "", processing_steps: bool = False) -> str:
    """The plate set's identity.

    `profile` is empty unless the page has to be colour-managed before it is
    separated: the device ignores the destination profile, so a page already
    made of device CMYK, spot and DeviceN plates identically under every
    press and must not have its cache split by a choice that changes nothing.

    `font_dir` is empty on the same reasoning — it can only change the plates
    of a document that carries a form field, because that is the one document
    an appearance can be regenerated in. Where it can change them it has to be
    in the key, or a set rendered without the fallback faces would be served
    to a caller that supplied them.

    `processing_steps` is in the key UNCONDITIONALLY, and that is deliberate.
    It decides whether the die line and the varnish reached the device at
    all, so the two states are two different plate sets of the same page; a
    key component that does not reach the key serves the old raster after the
    flip and the switch reads as broken.
    """
    source = Path(file)
    try:
        stamp = f"{source.stat().st_mtime_ns}:{source.stat().st_size}"
    except OSError:
        stamp = "0:0"
    digest = hashlib.sha256(
        f"{source}\0{stamp}\0{page}\0{dpi}\0{int(overprint)}\0{profile}"
        f"\0{font_dir}\0{int(processing_steps)}".encode("utf-8")
    ).hexdigest()
    return digest[:24]


def _carries_form_fields(file: str) -> bool:
    with pikepdf.open(file) as pdf:
        return has_form_fields(pdf)


def _stage_without_processing_steps(source: Path, out_dir: Path):
    """A working copy with every processing-step layer forced off, or None.

    None means the document declares no processing steps at all, in which
    case there is nothing to stage and the original is rastered directly.
    """
    with pikepdf.open(str(source)) as pdf:
        if hide_processing_steps(pdf) == 0:
            return None
        staged = out_dir / "noprocsteps.pdf"
        save_pdf(pdf, staged)
    return staged


def _page_optional_content_groups(pdf) -> tuple[list, bool]:
    """Every OCG dictionary the pages of this PDF can select content by.

    Returns the groups and whether the walk was COMPLETE. False means
    `_MAX_OC_RESOURCE_DEPTH` cut a branch off, so the list is a subset of
    what the page can address and cannot be reasoned about as a whole.

    Content selects a group from far more places than a page's own
    `/Properties`: a tiling or shading pattern carries its own resources, an
    ExtGState soft mask paints through a form XObject group with resources of
    its own, and an annotation's appearance stream is a form XObject the page
    dictionary never lists. Each of those is walked, and an OCMD is followed
    through both `/OCGs` and the `/VE` visibility expression.
    """
    groups: list = []
    seen: set = set()
    complete = True

    def add(obj) -> None:
        if not isinstance(obj, pikepdf.Dictionary):
            return
        key = obj.objgen
        if key != (0, 0) and key in seen:
            return
        if key != (0, 0):
            seen.add(key)
        if str(obj.get("/Type", "")) == "/OCMD":
            for source in (obj.get("/OCGs"), obj.get("/VE")):
                add_any(source)
            return
        if str(obj.get("/Type", "")) != "/OCG":
            return
        groups.append(obj)

    def add_any(obj, depth: int = 0) -> None:
        """An OCG, an OCMD, or any array nesting them — `/VE` included.

        A visibility expression is an array whose head is an operator name
        and whose tail is groups or further expressions. Every group named
        anywhere in it is collected: the expression can turn its content off
        through any one of them, and the safe direction here is the opposite
        of the processing-step scan's. There a missed group only leaves an
        already-visible colorant on the plate list; here a missed group
        leaves content the document hides VISIBLE on the plates, so the carry
        errs towards more groups, never fewer.
        """
        if depth > _MAX_OC_RESOURCE_DEPTH:
            nonlocal complete
            complete = False
            return
        if isinstance(obj, pikepdf.Array):
            for item in obj:
                add_any(item, depth + 1)
        elif isinstance(obj, pikepdf.Dictionary):
            add(obj)

    def walk(resources, depth: int = 0) -> None:
        nonlocal complete
        if not isinstance(resources, pikepdf.Dictionary):
            return
        if depth > _MAX_OC_RESOURCE_DEPTH:
            complete = False
            return
        properties = resources.get("/Properties")
        if isinstance(properties, pikepdf.Dictionary):
            for value in properties.values():
                add_any(value)
        for category in ("/XObject", "/Pattern", "/Shading"):
            entries = resources.get(category)
            if not isinstance(entries, pikepdf.Dictionary):
                continue
            for entry in entries.values():
                if not isinstance(entry, (pikepdf.Dictionary, pikepdf.Stream)):
                    continue
                add_any(entry.get("/OC"))
                walk(entry.get("/Resources"), depth + 1)
        states = resources.get("/ExtGState")
        if isinstance(states, pikepdf.Dictionary):
            for state in states.values():
                if not isinstance(state, pikepdf.Dictionary):
                    continue
                mask = state.get("/SMask")
                if not isinstance(mask, pikepdf.Dictionary):
                    continue
                group = mask.get("/G")
                if isinstance(group, pikepdf.Stream):
                    add_any(group.get("/OC"))
                    walk(group.get("/Resources"), depth + 1)

    def walk_appearance(obj, depth: int = 0) -> None:
        nonlocal complete
        if depth > _MAX_OC_RESOURCE_DEPTH:
            complete = False
            return
        if isinstance(obj, pikepdf.Stream):
            add_any(obj.get("/OC"))
            walk(obj.get("/Resources"))
        elif isinstance(obj, pikepdf.Dictionary):
            for state in obj.values():
                walk_appearance(state, depth + 1)

    for page in pdf.pages:
        walk(page.obj.get("/Resources"))
        for annot in page.obj.get("/Annots", []) or []:
            if not isinstance(annot, pikepdf.Dictionary):
                continue
            add_any(annot.get("/OC"))
            appearance = annot.get("/AP")
            if isinstance(appearance, pikepdf.Dictionary):
                for stream in appearance.values():
                    walk_appearance(stream)
    return groups, complete


def _tag_optional_content_groups(source: str, out_dir: Path):
    """A working copy of `source` whose OCGs carry a unique identity key.

    Returns `(path, off_keys)`, or `(None, set())` when the document declares
    no default configuration, turns nothing off, or cannot be read.

    Page extraction rebuilds the catalog and hands the extracted page its own
    COPIES of the group dictionaries, so object identity cannot cross it. A
    name cannot stand in for identity — two groups may share one, and unnamed
    groups all share the empty string — so the identity is manufactured
    before the extraction instead: each group dictionary gets a private key,
    extraction copies the dictionary whole, and the key arrives on the other
    side naming exactly one group. The extraction runs over THIS copy, never
    the user's file, and the key is stripped from the staged page again.
    """
    try:
        with pikepdf.open(source) as src:
            properties = src.Root.get("/OCProperties")
            config = (properties.get("/D")
                      if isinstance(properties, pikepdf.Dictionary) else None)
            if not isinstance(config, pikepdf.Dictionary):
                return None, set()
            off = [g for g in (config.get("/OFF") or [])
                   if isinstance(g, pikepdf.Dictionary)]
            if not off:
                return None, set()
            reachable, _complete = _page_optional_content_groups(src)
            declared = [g for g in (properties.get("/OCGs") or [])
                        if isinstance(g, pikepdf.Dictionary)]
            stamped: set = set()
            for index, group in enumerate(off + declared + reachable):
                identity = group.objgen
                if identity != (0, 0) and identity in stamped:
                    continue
                if identity != (0, 0):
                    stamped.add(identity)
                group[_OC_KEY] = pikepdf.String(f"{index}")
            off_keys = {str(g[_OC_KEY]) for g in off if _OC_KEY in g}
            if not off_keys:
                return None, set()
            tagged = out_dir / "octagged.pdf"
            # An intermediate consumed by the renderer, never a user output.
            save_pdf(src, tagged, drop_encryption=True)
        return tagged, off_keys
    except (OSError, pikepdf.PdfError, ValueError):
        return None, set()


def _carry_off_configuration(single: Path, off_keys: set) -> bool:
    """Re-establish the source's default OC configuration on the extracted page.

    Page extraction rebuilds the catalog, so `/OCProperties` does not survive
    it — and with it goes every group the processing-step exclusion or the
    Layers panel turned OFF. Without this the profile staging would hand the
    conversion a page whose die line and varnish are visible again, and the
    plates and every ink figure measured over them would silently carry
    manufacturing content the preview was asked to leave out.

    Groups are paired by the key `_tag_optional_content_groups` stamped on
    the source before extraction, so a group's state crosses the extraction
    on its own: two same-named groups land with their own states, and
    unnamed groups do not collide.

    True means the page is safe to stage — the configuration was carried, or
    the walk completed and found nothing this page turns off.

    False is a REFUSAL: the caller must not stage this page. It is returned
    when the resource walk hit `_MAX_OC_RESOURCE_DEPTH`, or the page could
    not be read. The groups found are then a SUBSET, and writing a
    configuration from a subset declares the groups it missed VISIBLE — the
    failure that puts hidden manufacturing content on the plates. Refusing
    costs the profile staging, which moves ink amounts; carrying a partial
    set changes which content is on the page at all, so the refusal is the
    cheaper wrong answer and the only honest one.
    """
    if not off_keys:
        return True
    try:
        with pikepdf.open(single, allow_overwriting_input=True) as pdf:
            groups, complete = _page_optional_content_groups(pdf)
            if not complete:
                return False
            off = [g for g in groups
                   if _OC_KEY in g and str(g[_OC_KEY]) in off_keys]
            for group in groups:
                if _OC_KEY in group:
                    del group[_OC_KEY]
            if off:
                pdf.Root["/OCProperties"] = pdf.make_indirect(pikepdf.Dictionary({
                    "/OCGs": pikepdf.Array([pdf.make_indirect(g) for g in groups]),
                    "/D": pikepdf.Dictionary({
                        "/OFF": pikepdf.Array([pdf.make_indirect(g) for g in off]),
                        "/Order": pikepdf.Array([]),
                    }),
                }))
            pdf.save(str(single))
        return True
    except (OSError, pikepdf.PdfError):
        return False


def _stage_for_profile(file: str, page: int, profile_path: str, out_dir: Path,
                       gs_path: str, icc_dir: str = ""):
    """One page, colour-managed to the press profile, as its own PDF.

    The separation device ignores the destination profile, so this is where
    the profile enters the ink amounts. The page is extracted first and the
    conversion runs over that alone: `convert_cmyk` stays the one door for
    source-to-CMYK conversion, and staging a whole document to separate one
    page of it would pay for every page the preview is not showing.

    The source's OCGs are tagged BEFORE the extraction so the extracted page
    can be given back the groups the document turns off. None means the carry
    refused and the caller rasters the unstaged document, whose own
    `/OCProperties` still hides them.
    """
    from .prepress import convert_cmyk
    from .split import _render_part

    tagged, off_keys = _tag_optional_content_groups(file, out_dir)
    single = out_dir / "page.pdf"
    try:
        single.write_bytes(_render_part(str(tagged or file), [page - 1]))
    finally:
        if tagged is not None:
            tagged.unlink(missing_ok=True)
    if not _carry_off_configuration(single, off_keys):
        single.unlink(missing_ok=True)
        return None
    staged = out_dir / "staged.pdf"
    try:
        convert_cmyk(str(single), str(staged), dest_profile=profile_path,
                     gs_path=gs_path, icc_dir=icc_dir)
    finally:
        single.unlink(missing_ok=True)
    return staged


def render_separations(
    file: str,
    page: int = 1,
    dpi: int = 150,
    gs_path: str = "",
    overprint: bool = True,
    reuse: bool = True,
    simulation=None,
    font_dir: str = "",
    icc_dir: str = "",
    show_processing_steps: bool = False,
) -> dict:
    """Rasterize one page to one grayscale plate per separation.

    Args:
        file: Input PDF path.
        page: 1-based page number.
        dpi: Raster resolution. The preview caps this at display resolution;
            the plate arithmetic is resolution-independent, so a higher number
            buys nothing but time.
        gs_path: Path to the Ghostscript executable.
        overprint: False renders with overprint simulation disabled.
        reuse: False re-runs the device even when the plate set is cached.
        simulation: The soft proof's profile request. A page carrying colour
            that is not already device CMYK is colour-managed to that profile
            BEFORE it is separated — the device ignores the destination
            profile, so without the staging the ink amounts would come from
            the conversion's own default destination rather than the chosen
            press.
        font_dir: The bundled fallback faces, for regenerating the appearance
            of a widget that carries none. Without it such a field rasters
            through the device's own synthesis — `/V`'s UTF-16BE bytes drawn
            through the form's WinAnsi face (ISO 32000-2 7.9.2.2), which is
            mojibake for any value outside that encoding. The preview then
            shows a value the document does not state.
        show_processing_steps: True rasters the non-printing processing-step
            layers along with the artwork. The default excludes them: they
            are manufacturing instructions, and a die line on a plate is a
            die line printed. The exclusion is a VIEW — it stages a working
            copy with those groups forced off and never writes the document.

    The plate set is cached on disk keyed by file identity, page, resolution,
    overprint, whether processing steps were rastered and — only where each
    applies — the profile and the fallback faces, so an ink toggle
    re-composites without another device run and a page that separates
    identically on every press keeps one cache entry.
    """
    validate_pdf(file)
    page = int(page)
    dpi = max(1, int(dpi))
    show_processing_steps = bool(show_processing_steps)

    inventory = list_inks(file, pages=[page],
                          show_processing_steps=show_processing_steps)
    inks = inventory["inks"]
    # The device writes a plate per `/Separation` colorant in the page
    # RESOURCES, painted or not, so forcing the step groups off leaves the
    # die line's plate on disk while the inventory has already dropped its
    # colorant. Those plates are EXPECTED-BUT-SUPPRESSED: dropped from the
    # set, never a refusal. Empty whenever the steps are being rastered.
    suppressed = {
        f"s1({plate_name_escape(name)}).tif"
        for name in inventory["processing_step_inks"]
    }
    spots = [e["name"] for e in inks if e["kind"] == "spot"]
    n = len(spots)
    limit = MAX_SPOTS_CEILING
    if n > limit:
        raise ValueError(
            f"This page uses {n} spot colours; separation preview supports {limit}."
        )

    request = soft_proof.read_request(simulation)
    profile = None
    if request is not None and request.source != "none":
        intent = (
            soft_proof.read_output_intent(file)
            if request.source == "document"
            else None
        )
        # A refusal is not raised here: the composite resolves the same
        # request and REPORTS it, so a proof that cannot be produced falls
        # back to the ordinary plates rather than failing the raster.
        profile, _refusal = soft_proof.resolve_profile(
            request, intent=intent, icc_dir=icc_dir
        )
    stage = profile is not None and soft_proof.staging_applies(
        inventory["color_families"]
    )

    root = _cache_root()
    out_dir = root / _set_key(
        file, page, dpi, overprint, profile.digest if stage else "",
        font_dir if _carries_form_fields(file) else "",
        show_processing_steps,
    )
    marker = out_dir / "plates.done"
    if reuse and _set_is_whole(out_dir, marker):
        os.utime(out_dir, None)
        return _describe_set(out_dir, inks, file, page, dpi, gs_path, overprint,
                             suppressed)

    shutil.rmtree(out_dir, ignore_errors=True)
    out_dir.mkdir(parents=True, exist_ok=True)

    # A widget carrying no appearance is given one BEFORE either arm reads
    # this document as content: the preview then rasters what the fill would
    # draw rather than what the device synthesizes from `/V` and flattens.
    # The regenerated copy stays beside the plates because the coverage
    # measurement has to describe the same document the plates came from.
    prepared = regenerate_appearances_file(Path(file), out_dir, font_dir) or Path(file)

    # The die line, the crease and the varnish come off BEFORE the device
    # sees the page, on a working copy: forcing them off in the default
    # configuration is what a RIP already honours, so nothing here has to
    # rewrite content. The copy stays beside the plates because the coverage
    # measurement has to describe the same page the plates came from.
    if not show_processing_steps:
        without = _stage_without_processing_steps(prepared, out_dir)
        if without is not None:
            prepared = without

    rastered = None
    if stage:
        # None is the optional-content carry refusing (see
        # `_carry_off_configuration`): the page is rastered unstaged instead,
        # keeping the document's own hidden groups hidden at the cost of the
        # profile. The refusal is a function of the document's bytes, so the
        # profile-keyed cache entry holds what re-running would produce.
        rastered = _stage_for_profile(str(prepared), page, profile.path, out_dir,
                                      gs_path, icc_dir)
        first = 1
    if rastered is None:
        rastered = prepared
        first = page

    max_spots = min(MAX_SPOTS_CEILING, max(_MIN_SPOT_REQUEST, len(spots)))
    cmd = [
        gs_path, "-dNOPAUSE", "-dBATCH", "-dSAFER", "-q",
        "-sDEVICE=tiffsep", f"-r{dpi}", "-dUseCropBox",
        f"-dFirstPage={first}", f"-dLastPage={first}",
        f"-dMaxSpots={max_spots}",
    ]
    if not overprint:
        cmd.append("-dOverprint=/disable")
    cmd += ["-o", str(out_dir / "s%d.tif"), str(rastered)]

    result = budget.gs(cmd, what="Separation render", path=file, pages=1)
    stdout = result.stdout or ""
    stderr = result.stderr or ""
    if _FOLD_MARKER in stdout or _FOLD_MARKER in stderr:
        shutil.rmtree(out_dir, ignore_errors=True)
        raise ValueError(
            f"Ghostscript folded {n} spot colours into process; "
            "raise the spot limit or reduce the document's spots."
        )
    if result.returncode != 0:
        shutil.rmtree(out_dir, ignore_errors=True)
        raise RuntimeError(f"Ghostscript separation render failed: {stderr or stdout}")

    described = _describe_set(out_dir, inks, file, page, dpi, gs_path, overprint,
                              suppressed)
    # The suppressed plates are removed rather than recorded, so the
    # manifest keeps its EXACT-equality property: what the glob finds is
    # what the set was written with. The other flag state is a different
    # cache key with its own full render, so nothing is lost by deleting.
    for filename in suppressed:
        (out_dir / filename).unlink(missing_ok=True)
    _write_manifest(marker, out_dir, described)
    _evict_old_sets(root)
    return described


_MANIFEST_VERSION = 1

# The files a plate set cannot be rebuilt without. `staged.pdf`,
# `noprocsteps.pdf` and `regenerated.pdf` are the coverage measurement's
# subject: with any of them gone the measurement silently moves to a document
# further up the staging chain, which is a figure about a different page than
# the plates carry.
_SET_SIDECARS = ("staged.pdf", "noprocsteps.pdf", "regenerated.pdf")


def _write_manifest(marker: Path, out_dir: Path, described: dict) -> None:
    """Record what the set contains, so reuse can tell whole from decayed."""
    marker.write_text(json.dumps({
        "version": _MANIFEST_VERSION,
        "plates": sorted(Path(p["file"]).name for p in described["plates"]),
        "sidecars": sorted(n for n in _SET_SIDECARS if (out_dir / n).is_file()),
    }), encoding="utf-8")


def _set_is_whole(out_dir: Path, marker: Path) -> bool:
    """Whether the cached set still holds every file it was written with.

    Eviction removes a set with `ignore_errors=True`, so a partially removed
    directory is a reachable state, and the pairing in `_describe_set` cannot
    tell a plate that decayed out of a cached set from a colorant the page
    declared but never painted — on a fresh render the second is the only
    possibility, on reuse both are. A set that does not match its manifest is
    therefore treated as absent and re-rendered; a marker carrying no manifest
    (a set written by an earlier version) is absent for the same reason.
    """
    try:
        stored = json.loads(marker.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return False
    if not isinstance(stored, dict) or stored.get("version") != _MANIFEST_VERSION:
        return False
    plates, sidecars = stored.get("plates"), stored.get("sidecars")
    if not isinstance(plates, list) or not plates or not isinstance(sidecars, list):
        return False
    if {p.name for p in out_dir.glob("s1(*).tif")} != set(plates):
        return False
    return all((out_dir / str(name)).is_file() for name in sidecars)


def _describe_set(out_dir: Path, inks: list[dict], file: str, page: int,
                  dpi: int, gs_path: str, overprint: bool,
                  suppressed: set[str] | None = None) -> dict:
    """Pair the written plate files with the inventory, or refuse.

    The device names each plate by the ink it separates, so the pairing is a
    PREDICTION from the inventory: an ink the inventory does not know cannot
    be labelled, and a preview that mislabels a plate is worse than no
    preview. An expected plate that never appeared is the other case and is
    NOT a refusal — a colorant a page declares but never paints has no plate
    by construction, and the fold that would drop a painted one is caught by
    its own marker before this runs. That reading holds only because the set
    is known whole: on the reuse path `_set_is_whole` establishes it against
    the manifest before this runs, and a decayed set is re-rendered instead.

    `suppressed` is the third case, and the reason the default state renders
    at all: the device writes a plate for every colorant in the page
    resources, so a page whose step groups were forced off still yields a die
    line plate the inventory has deliberately dropped. Such a plate is
    expected, and is neither served nor counted. A plate matching nothing at
    all still refuses.
    """
    written = {p.name: p for p in out_dir.glob("s1(*).tif")}
    for filename in (suppressed or ()):
        written.pop(filename, None)
    expected: dict[str, dict] = {}
    for entry in inks:
        if entry["kind"] in ("all", "none"):
            continue
        expected[f"s1({plate_name_escape(entry['name'])}).tif"] = entry
    for name in PROCESS_INKS:
        filename = f"s1({name}).tif"
        expected.setdefault(filename, {
            "name": name, "kind": "process", "alternate": "DeviceCMYK",
            "display_rgb": None, "pages": [page], "used_in": [],
        })

    unexpected = sorted(set(written) - set(expected))
    if unexpected:
        raise ValueError(
            "Separation output did not match the document's inks — "
            "the preview cannot be trusted."
        )

    plates = []
    for filename, entry in expected.items():
        path = written.get(filename)
        if path is None:
            continue
        plates.append({
            "name": entry["name"],
            "kind": entry["kind"],
            "display_rgb": entry["display_rgb"] or _default_display(entry["name"]),
            "file": str(path),
        })
    plates.sort(key=lambda p: (
        0 if p["kind"] == "process" else 1,
        PROCESS_INKS.index(p["name"]) if p["kind"] == "process" else 0,
        p["name"],
    ))
    if not plates:
        raise ValueError(
            "Separation output did not match the document's inks — "
            "the preview cannot be trusted."
        )

    width, height = _plate_extent(plates[0]["file"])
    _record_source(out_dir, file, page)
    # Coverage describes the ink actually on the plates, so a staged set is
    # measured on the staged page: under a press profile the figure IS a
    # number about that press.
    # The staging chain runs regenerated → processing steps off → press
    # profile, so the LAST copy written is the one the device read. A total
    # ink figure measured a step earlier would count the varnish.
    staged = out_dir / "staged.pdf"
    without_steps = out_dir / "noprocsteps.pdf"
    regenerated = out_dir / "regenerated.pdf"
    if staged.is_file():
        measured, measured_page = str(staged), 1
    elif without_steps.is_file():
        measured, measured_page = str(without_steps), page
    elif regenerated.is_file():
        measured, measured_page = str(regenerated), page
    else:
        measured, measured_page = file, page
    return {
        "dir": str(out_dir),
        "plates": plates,
        "width": width,
        "height": height,
        "dpi": dpi,
        "page": page,
        "overprint": bool(overprint),
        "coverage": _cached_coverage(out_dir, measured, measured_page, gs_path),
    }


def _record_source(out_dir: Path, file: str, page: int) -> None:
    """Name the document and page a plate set came from.

    The composite reads it only when a soft proof needs the document's own
    tint transforms or output intent, which is the one thing the plates
    cannot carry. Toggling an ink still touches no PDF: what the read
    produces is cached beside the plates.
    """
    store = out_dir / "source.json"
    if store.is_file():
        return
    try:
        store.write_text(json.dumps({"file": str(file), "page": int(page)}), encoding="utf-8")
    except OSError:
        pass


def _cached_coverage(out_dir: Path, file: str, page: int, gs_path: str) -> dict:
    """Page coverage is a property of the plate set, so it is measured once
    per set — a cache hit must not re-run the device."""
    store = out_dir / "coverage.json"
    if store.is_file():
        try:
            return json.loads(store.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            pass
    coverage = _ink_coverage(file, page, gs_path)
    try:
        store.write_text(json.dumps(coverage), encoding="utf-8")
    except OSError:
        pass
    return coverage


def _default_display(name: str) -> list[int]:
    """The display colour of a plate the inventory could not resolve.

    Only the process inks reach this: their plate always exists, whether or
    not the page declares a named colour space for them.
    """
    return {
        "Cyan": [0, 174, 239],
        "Magenta": [236, 0, 140],
        "Yellow": [255, 241, 0],
        "Black": [35, 31, 32],
    }.get(name, [128, 128, 128])


def _plate_extent(path: str) -> tuple[int, int]:
    from PIL import Image

    with Image.open(path) as im:
        return int(im.size[0]), int(im.size[1])


_INKCOV_LINE = re.compile(
    r"([0-9.]+)\s+([0-9.]+)\s+([0-9.]+)\s+([0-9.]+)\s+CMYK"
)


def _ink_coverage(file: str, page: int, gs_path: str) -> dict:
    """Per-ink page coverage, as fractions of the CROPPED page area.

    This is the device's own page AVERAGE and it is reported as one. It
    cannot drive the over-limit alarm: on a page whose true maximum total ink
    is 340 %, these four sum to 200 %.

    The frame is the plates' frame. A coverage fraction taken over the
    MediaBox of a cropped page is a fraction of an area the plates do not
    cover, so the panel would print two figures about two different regions.
    """
    cmd = [
        gs_path, "-dNOPAUSE", "-dBATCH", "-dSAFER", "-q",
        "-sDEVICE=inkcov", "-r72", "-dUseCropBox",
        f"-dFirstPage={page}", f"-dLastPage={page}",
        "-o", "-", str(file),
    ]
    try:
        result = budget.gs(cmd, what="Ink coverage", path=file, pages=1)
    except RuntimeError:
        return {}
    match = _INKCOV_LINE.search(result.stdout or "")
    if match is None:
        return {}
    values = [float(v) for v in match.groups()]
    return dict(zip(PROCESS_INKS, values))


# ── ink arithmetic ─────────────────────────────────────────────────────────


def _load_ink_layers(plate_files) -> list:
    """Each plate as ink coverage in 0…1. Plate polarity is inverted, so ink
    is `255 - value`."""
    import numpy as np
    from PIL import Image

    layers = []
    for path in plate_files:
        with Image.open(path) as im:
            layers.append((255.0 - np.asarray(im.convert("L")).astype(np.float32)) / 255.0)
    return layers


def ink_statistics(plate_files, limit_pct: float = 300.0) -> dict:
    """Per-pixel total ink over a set of plates.

    Returns the maximum total and how much of the page exceeds `limit_pct`.
    The maximum is the alarm's input; the device's own `inkcov` average
    cannot serve, because it reports 200 % on a page whose true maximum is
    340 %.
    """
    import numpy as np

    layers = _load_ink_layers(plate_files)
    if not layers:
        return {"max_tac": 0.0, "over_pixels": 0, "total_pixels": 0, "over_fraction": 0.0}
    total = np.sum(np.stack(layers), axis=0) * 100.0
    return _statistics_of(total, limit_pct)


def _statistics_of(total, limit_pct: float) -> dict:
    over = total > float(limit_pct)
    over_pixels = int(over.sum())
    return {
        "max_tac": float(total.max()),
        "over_pixels": over_pixels,
        "total_pixels": int(total.size),
        "over_fraction": over_pixels / float(total.size),
    }


def _ink_spec(entry) -> tuple[str, list[int] | None, float, str]:
    """A requested ink as (name, display colour, density, the ink it is shown as).

    A plate is found by its OWN name — that is the file the device wrote —
    but it takes the identity of the ink it is drawn as. Under the multiply
    model that identity is carried entirely by the display colour; under a
    press profile it also decides which channel of the CMYK buffer the
    coverage lands in, and a colour cannot answer that.
    """
    if isinstance(entry, str):
        return entry, None, 1.0, entry
    name = str(entry.get("name", ""))
    rgb = entry.get("display_rgb")
    if rgb is not None:
        try:
            rgb = [max(0, min(255, int(c))) for c in rgb][:3]
        except (TypeError, ValueError):
            rgb = None
        if rgb is not None and len(rgb) != 3:
            rgb = None
    try:
        density = float(entry.get("density", 1.0))
    except (TypeError, ValueError):
        density = 1.0
    return name, rgb, max(0.0, min(4.0, density)), str(entry.get("shown_as") or name)


def _read_source(plate_dir: Path) -> tuple[str, int]:
    """The document and page a plate set came from, or ("", 0)."""
    try:
        stored = json.loads((plate_dir / "source.json").read_text(encoding="utf-8"))
        return str(stored.get("file") or ""), int(stored.get("page") or 0)
    except (OSError, ValueError, TypeError):
        return "", 0


def _cached_alternates(plate_dir: Path) -> dict:
    """The page's spot alternates, measured once per plate set.

    A tint transform is document data, not press data, so the table is the
    same under every profile and is cached beside the plates: only the first
    composite under a proof opens the PDF, and an ink toggle never does.
    """
    store = plate_dir / "alternates.json"
    if store.is_file():
        try:
            return json.loads(store.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            pass
    file, page = _read_source(plate_dir)
    if not file or page < 1:
        return {}
    found = soft_proof.page_alternates(file, page)
    try:
        store.write_text(json.dumps(found), encoding="utf-8")
    except OSError:
        pass
    return found


def _cached_output_intent(plate_dir: Path) -> dict:
    """The document's own output intent, measured once per plate set."""
    store = plate_dir / "output-intent.json"
    profile = plate_dir / "output-intent.icc"
    if store.is_file():
        try:
            stored = json.loads(store.read_text(encoding="utf-8"))
            raw = profile.read_bytes() if profile.is_file() else b""
            return {
                "present": bool(stored.get("present")),
                "identifier": str(stored.get("identifier") or ""),
                "embedded": raw,
            }
        except (OSError, ValueError):
            pass
    file, _page = _read_source(plate_dir)
    if not file:
        return {"present": False, "identifier": "", "embedded": b""}
    found = soft_proof.read_output_intent(file)
    try:
        store.write_text(
            json.dumps({"present": found["present"], "identifier": found["identifier"]}),
            encoding="utf-8",
        )
        if found["embedded"]:
            profile.write_bytes(found["embedded"])
    except OSError:
        pass
    return found


def _resolve_proof(plate_dir: Path, request, chosen, icc_dir: str):
    """(the record to return, the CMYK→sRGB transform, the spot tables).

    A refusal comes back as a record carrying the sentence and no transform:
    the composite then draws the ordinary multiply image, and the panel
    renders its controls from this record, so an unhonoured request cannot
    look honoured.
    """
    intent = _cached_output_intent(plate_dir) if request.source == "document" else None
    profile, refusal = soft_proof.resolve_profile(request, intent=intent, icc_dir=icc_dir)
    if refusal:
        return soft_proof.refused_record(refusal), None, {}
    if profile is None:
        return soft_proof.empty_record(), None, {}

    shown = [shown_as for _n, _p, _c, _d, shown_as in chosen]
    if not any(name in PROCESS_INKS for name in shown):
        return soft_proof.refused_record(soft_proof.no_process_plate_message()), None, {}

    spots = sorted({name for name in shown if name not in PROCESS_INKS})
    tables: dict = {}
    assumed: list = []
    if spots:
        tables, assumed, refusal = soft_proof.spot_tables(
            spots, _cached_alternates(plate_dir), profile.path
        )
        if refusal:
            return soft_proof.refused_record(refusal), None, {}

    intent_name, bpc = soft_proof.normalized_pair(request.paper_white, request.black_ink)
    transform, refusal = soft_proof.build_transform(profile.path, intent_name, bpc)
    if refusal:
        return soft_proof.refused_record(refusal), None, {}
    return (
        {
            "source": profile.source,
            "name": profile.name,
            "intent": intent_name,
            "black_point_compensation": bpc,
            "refusal": "",
            "assumed": assumed,
        },
        transform,
        tables,
    )


def composite_separations(
    dir: str,
    inks: list | None = None,
    limit_pct: float = 300.0,
    alarm: bool = False,
    output: str = "",
    simulation=None,
    gs_path: str = "",
    icc_dir: str = "",
) -> dict:
    """Composite the chosen plates into an RGB PNG, with the ink statistics.

    Args:
        dir: A plate-set directory `render_separations` produced.
        inks: The inks to show — names, or entries carrying `name`,
            `display_rgb`, `density` and `shown_as`. None shows every plate in
            the set.
        limit_pct: Total-ink limit the alarm measures against.
        alarm: True tints the over-limit pixels in the composite.
        output: PNG path to write. Empty writes `composite.png` beside the
            plates.
        simulation: The soft proof's profile request. Absent or `none`
            composites through the multiply model, unchanged.
        gs_path: Path to the Ghostscript executable.
        icc_dir: The bundled colour-profile directory, for the press profile
            a `bundled` request names.

    Without a profile each visible ink multiplies its display colour down,
    scaled by its density, so an ink switched off leaves the page exactly as
    if it had never printed. With one the same coverages accumulate into a
    CMYK buffer — process inks into their own channel, spots through the
    alternate space the document says they approximate — and one ICC
    transform takes the buffer to sRGB.

    The statistics are measured over the SAME plate subset the image shows,
    on the coverage rather than on the transformed image: no display
    transform changes how much ink is on the sheet, so the figures are
    identical with and without a profile. The over-limit tint composites
    AFTER the transform, in sRGB, because an alarm colour that dimmed with
    the press profile would be a warning the user has to learn afresh per
    profile.

    `simulation` in the return says what was USED, never what was asked for:
    a request the engine refused comes back with the reason and the source
    `none`, so a proof that quietly fell back cannot look honoured.
    """
    import numpy as np
    from PIL import Image

    plate_dir = Path(dir)
    if not plate_dir.is_dir():
        refuse_missing_plates()

    available: dict[str, Path] = {}
    for path in plate_dir.glob("s1(*).tif"):
        available[path.name[len("s1("):-len(").tif")]] = path

    requested = inks if inks is not None else sorted(available)
    chosen: list[tuple[str, Path, list[int], float, str]] = []
    for entry in requested:
        name, rgb, density, shown_as = _ink_spec(entry)
        path = available.get(plate_name_escape(name)) or available.get(name)
        if path is not None:
            chosen.append((name, path, rgb or _default_display(name), density, shown_as))

    target = Path(output) if output else plate_dir / "composite.png"
    if not chosen:
        Image.fromarray(np.full((1, 1, 3), 255, dtype=np.uint8)).save(target, "PNG")
        return {"png": str(target), "width": 1, "height": 1, "inks": [],
                "max_tac": 0.0, "over_pixels": 0, "total_pixels": 0, "over_fraction": 0.0,
                "simulation": soft_proof.empty_record()}

    request = soft_proof.read_request(simulation)
    record = soft_proof.empty_record()
    transform = None
    spot_tables: dict = {}
    if request is not None and request.source != "none":
        record, transform, spot_tables = _resolve_proof(plate_dir, request, chosen, icc_dir)

    layers = _load_ink_layers([p for _, p, _, _, _ in chosen])
    height, width = layers[0].shape
    if transform is None:
        rgb_out = np.ones((height, width, 3), dtype=np.float32)
        for layer, (_name, _path, color, density, _shown) in zip(layers, chosen):
            absorb = 1.0 - (np.asarray(color, dtype=np.float32) / 255.0)
            rgb_out *= np.clip(1.0 - layer[..., None] * density * absorb[None, None, :],
                               0.0, 1.0)
    else:
        buffer = np.zeros((height, width, 4), dtype=np.float32)
        for layer, (_name, _path, _color, density, shown) in zip(layers, chosen):
            # Density above 1 can drive a channel past 100 %, and the buffer
            # clips before the transform: there is no ICC description of
            # 140 % cyan.
            tint = np.clip(layer * density, 0.0, 1.0)
            if shown in PROCESS_INKS:
                buffer[..., PROCESS_INKS.index(shown)] += tint
            else:
                table = spot_tables[shown]
                index = np.clip(
                    tint * (soft_proof.TINT_STEPS - 1) + 0.5, 0, soft_proof.TINT_STEPS - 1
                ).astype(np.uint8)
                buffer += table[index]
        np.clip(buffer, 0.0, 1.0, out=buffer)
        rgb_out = soft_proof.to_srgb(buffer, transform)

    total = np.sum(np.stack(layers), axis=0) * 100.0
    stats = _statistics_of(total, limit_pct)
    if alarm and stats["over_pixels"] > 0:
        over = total > float(limit_pct)
        rgb_out[over] = (rgb_out[over] * 0.25
                         + np.array([1.0, 0.0, 0.35], dtype=np.float32) * 0.75)

    Image.fromarray((rgb_out * 255.0).astype(np.uint8)).save(target, "PNG")
    return {
        "png": str(target),
        "width": int(width),
        "height": int(height),
        "inks": [name for name, _, _, _, _ in chosen],
        **stats,
        "simulation": record,
    }


def list_simulation_profiles(file: str = "", gs_path: str = "",
                             icc_dir: str = "") -> dict:
    """Which press profiles this document can be proofed against.

    The panel needs this before it composites anything: the default is the
    document's OWN output intent when it embeds a profile, and otherwise no
    proof at all. Falling through to a bundled press would proof against a
    press neither the user chose nor the document declared.

    An intent that names a registered characterization by identifier alone is
    reported `present` without `embedded` — it is still offered, and choosing
    it refuses by name rather than substituting a press the document never
    named.

    `bundled` is the whole installed press set, each by its ICC description
    string, plus which of them a request that names none resolves to. The
    panel shows the names: a proof against an unnamed press is a picture
    nobody can check.
    """
    intent = (
        soft_proof.read_output_intent(file)
        if file
        else {"present": False, "identifier": "", "embedded": b""}
    )
    raw = bytes(intent.get("embedded") or b"")
    name = ""
    embedded = False
    if raw:
        description, space, refusal = soft_proof.describe_profile(raw)
        if not refusal and space == "CMYK":
            embedded = True
            name = description
    presses = soft_proof.bundled_presses(icc_dir)
    default = ""
    if presses:
        try:
            default = icc_profiles.default_cmyk(icc_dir).description
        except (ValueError, RuntimeError):
            default = ""
    return {
        "document": {
            "present": bool(intent.get("present")),
            "embedded": embedded,
            "identifier": str(intent.get("identifier") or ""),
            "name": name,
        },
        "bundled": {
            "present": bool(presses),
            # `name` is the default press. It stays beside the full list so a
            # caller that only ever showed one bundled entry keeps naming a
            # real press instead of an empty string.
            "name": default,
            "default": default,
            "names": [p.description for p in presses],
        },
    }
