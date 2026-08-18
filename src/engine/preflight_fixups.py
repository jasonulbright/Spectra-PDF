"""What repairing a preflight finding MEANS — one table, one order.

Nineteen of the twenty fixups are an existing op called with the parameters a
profile carries; ``font_embed.embed_missing_fonts`` is the twentieth. The panel
button, the command line, the droplet and the guided-action step all call
THIS, so "what does fixing `hairlines_absent` mean" has one answer rather than
one per surface — the `accessibility_fixes` ruling applied to a second checker.

**The ORDER is canonical and a profile may not change it.** ``fixups`` in a
profile is a SET; the order below is the engine's, and the result reports the
order it actually ran. The reason is that each stage changes what the next one
measures:

  1. strip (JavaScript, attachments, annotations) — before anything rewrites
     the file, so the rewrite does not carry what is about to be deleted;
  2. embed missing fonts — BEFORE any Ghostscript stage, because ``pdfwrite``
     re-embeds what it can and substitutes what it cannot, and embedding first
     is what makes the substitution not happen;
  3. the colour conversion;
  4. the spot work — after the conversion, because a colorant's tint transform
     targets its alternate space and the conversion has just re-described it;
  5. downsampling — after the conversion (fewer components to resample) and
     before flattening (so the region raster is computed against the final
     image data);
  6. hairlines — BEFORE flattening. A hairline inside a rasterized region
     becomes pixels at the flatten resolution, where nothing can reach it
     again;
  7. flattening — after everything that edits vector content;
  8. the boxes — geometry, unaffected by content edits, and required before
     marks (``printer_marks.resolve_trim``);
  9. metadata — last before the standard conversion, which writes its own
     version and its own ``/GTS_PDFXVersion``;
 10. the standard conversion — the whole-file ``pdfwrite`` rewrite;
 11. printer marks — AFTER it, deliberately. ``pdfwrite`` regenerates every
     object, so marks added before it survive as content but lose their
     ``/SpectraPrinterMarks`` record and could never be removed again.

A door that refuses does not stop the run: its refusal is recorded against its
fixup and the rest still land. A run where NOTHING landed and something
refused raises, so a caller asking for one fixup gets that fixup's own refusal
rather than an empty success.

A door may also land PARTLY. Its `changed` then counts only what the file
actually carries, and the row names the rest under `partial` — a count that
included what the door could not finish would report a repair the document
does not have.
"""

from __future__ import annotations

from pathlib import Path
from typing import NamedTuple

from engine.preflight_profiles import FIXUP_IDS, resolve_profile

#: Every fixup, in the ONE order a run applies them. The profile names a set;
#: this names the sequence, and `apply_fixups` reports the sequence it ran.
FIXUP_ORDER = (
    "remove_javascript",
    "remove_attachments",
    "remove_annotations",
    "embed_missing_fonts",
    "convert_to_cmyk",
    "convert_to_grayscale",
    "spots_to_process",
    "alias_spot",
    "downsample_images",
    "fix_hairlines",
    "flatten_transparency",
    "set_trim_box",
    "grow_bleed_box",
    "set_document_title",
    "set_trapped",
    "write_xmp",
    "set_pdf_version",
    "convert_to_pdfx",
    "convert_to_pdfa",
    "add_printer_marks",
)

#: Which fixups repair which check. A per-row Fix control sends the CHECK id;
#: this is what turns it into the doors that answer it, and it is mirrored
#: renderer-side by `lib/preflight-fixes.ts` under a parity gate.
#:
#: Two fixups answer no check — `convert_to_pdfa` and `add_printer_marks` are
#: things a profile DOES to a document rather than repairs to a finding, so
#: they run only in a whole-profile pass.
CHECK_FIXUPS: dict[str, tuple] = {
    "pdf_version": ("set_pdf_version",),
    "output_intent": ("convert_to_pdfx",),
    "pdfx_claim": ("convert_to_pdfx",),
    "trapped_declared": ("set_trapped",),
    "embedded_files": ("remove_attachments",),
    "trim_box": ("set_trim_box",),
    "bleed_sufficient": ("grow_bleed_box",),
    "colour_family": ("convert_to_cmyk",),
    "grayscale_only": ("convert_to_grayscale",),
    "device_independent_colour": ("convert_to_cmyk",),
    "spot_ink_count": ("spots_to_process",),
    "spot_ink_names": ("alias_spot", "spots_to_process"),
    "fonts_embedded": ("embed_missing_fonts",),
    "image_max_dpi": ("downsample_images",),
    "image_compression": ("downsample_images",),
    "image_colour_space": ("convert_to_cmyk",),
    "live_transparency": ("flatten_transparency",),
    "hairlines_absent": ("fix_hairlines",),
    "printing_annotations": ("remove_annotations",),
    "title_present": ("set_document_title",),
    "document_javascript": ("remove_javascript",),
    "xmp_present": ("write_xmp",),
}

#: The fixups that need a value no machine may invent. Named here so a surface
#: can ask this module which kind a fixup is rather than keeping a second list.
AUTHORED_FIXUPS = (
    "alias_spot",
    "grow_bleed_box",
    "set_document_title",
    "set_trapped",
)

#: The verdicts a fixup is offered against — a `warn` is short of the
#: recommendation, which is still something a door repairs.
_FIXABLE_STATES = ("fail", "warn")


class _Run:
    """One fixup's context: what the profile said, what the report saw, and
    where the optional tools are."""

    __slots__ = ("params", "report", "gs_path", "font_dir", "tesseract_path")

    def __init__(self, params: dict, report: dict, gs_path: str, font_dir: str,
                 tesseract_path: str):
        self.params = params
        self.report = report
        self.gs_path = gs_path
        self.font_dir = font_dir
        self.tesseract_path = tesseract_path

    def get(self, name: str, default):
        value = self.params.get(name, default)
        return default if value is None else value

    def check(self, check_id: str) -> dict:
        for row in self.report.get("checks", []):
            if row["id"] == check_id:
                return row
        return {"id": check_id, "status": "not_applicable", "findings": []}


class _DoorResult(NamedTuple):
    """What a door did, when a count is not the whole answer.

    A door returning a bare `int` means "this many, and nothing left over" —
    the shape nineteen of the twenty keep. `changed` counts only what the
    output file actually carries. `partial` records what the door edited but
    could not finish, one entry per item, and `wrote` says an output exists:
    a door that landed partly has written a file even when `changed` is 0, and
    that file is what the next door in the order must read.
    """

    changed: int
    partial: tuple = ()
    wrote: bool = True


def _door_result(value) -> _DoorResult:
    if isinstance(value, _DoorResult):
        return value
    count = int(value)
    return _DoorResult(count, (), count > 0)


# ── the doors ─────────────────────────────────────────────────────────────


def _remove_javascript(source: str, output: str, run: _Run) -> int:
    from engine.sanitize import sanitize_pdf

    sanitize_pdf(source, output, categories=["javascript"])
    return 1


def _remove_attachments(source: str, output: str, run: _Run) -> int:
    from engine.attachments import list_attachments, remove_attachment

    names = [entry["name"] for entry in list_attachments(source)["attachments"]]
    if not names:
        return 0
    current = source
    for name in names:
        remove_attachment(current, output, name)
        current = output
    return len(names)


def _remove_annotations(source: str, output: str, run: _Run) -> int:
    from engine.annotations import delete_all_annotations

    result = delete_all_annotations(
        source,
        output,
        subtypes=list(run.get("subtypes", [])) or None,
        # The check's own default: an annotation that never reaches a plate is
        # not what a press job is asking about, so the fixup does not take it.
        printing_only=bool(run.get("printing_only", True)),
    )
    return int(result.get("removed", 0))


def _embed_missing_fonts(source: str, output: str, run: _Run) -> int:
    from engine.font_embed import embed_missing_fonts

    result = embed_missing_fonts(
        source,
        output,
        sources=tuple(run.get("sources", ("system",))),
        allow_substitute=bool(run.get("allow_substitute", False)),
        font_dir=run.font_dir,
    )
    return len(result["embedded"])


def _convert_to_cmyk(source: str, output: str, run: _Run) -> int:
    from engine.prepress import convert_cmyk

    convert_cmyk(
        source,
        output,
        render_intent=str(run.get("render_intent", "relative")),
        dest_profile=str(run.get("dest_profile", "")),
        gs_path=run.gs_path,
        font_dir=run.font_dir,
    )
    return 1


def _convert_to_grayscale(source: str, output: str, run: _Run) -> int:
    from engine.grayscale import grayscale

    grayscale(source, output, gs_path=run.gs_path, font_dir=run.font_dir)
    return 1


def _spots_to_process(source: str, output: str, run: _Run):
    """The named inks, or everything past the profile's own spot limit.

    "Everything past the limit" is resolved from the document's ink list in
    the order `list_inks` reports, which is the order the plates were found —
    a limit of two keeps the first two rather than an arbitrary two.

    A colorant `spot_to_process` left live in a shading it could not describe
    is NOT converted, so it is counted as partial rather than as a repair.
    """
    from engine.ink_manager import spot_to_process
    from engine.separations import list_inks

    named = [str(v) for v in run.get("inks", [])]
    if not named:
        inks = list_inks(source)
        spots = [entry["name"] for entry in inks["inks"] if entry["kind"] == "spot"]
        allowed = [str(v) for v in run.get("keep", [])]
        if allowed:
            named = [name for name in spots if name not in allowed]
        else:
            limit = int(run.get("max_spots", _profile_max_spots(run)))
            named = spots[limit:] if limit >= 0 else []
    if not named:
        return 0
    result = spot_to_process(source, output, inks=named)
    partial = _shading_residue(named, result.get("skipped", ()))
    return _DoorResult(len(named) - len(partial), partial)


def _shading_residue(named: list[str], skipped) -> tuple:
    """One record per named colorant a shading kept, in the order asked for.

    `spot_to_process` skips a shading whose colour its composition cannot
    describe IN PLACE — the colorant stays live in that gradient while every
    other occurrence of it converts. The document therefore still separates
    that plate, which is what makes the colorant unconverted rather than
    converted with a caveat.
    """
    residue: dict = {}
    for entry in skipped:
        reason = str(entry.get("reason", ""))
        for colorant in entry.get("colorants", ()):
            row = residue.setdefault(
                str(colorant),
                {"item": str(colorant), "shadings": [], "reasons": []},
            )
            row["shadings"].append(int(entry.get("shading", 0)))
            if reason and reason not in row["reasons"]:
                row["reasons"].append(reason)
    return tuple(residue[name] for name in named if name in residue)


def _profile_max_spots(run: _Run) -> int:
    row = run.check("spot_ink_count")
    try:
        return int(row.get("params", {}).get("max_spots", 0))
    except (TypeError, ValueError):
        return 0


def _alias_spot(source: str, output: str, run: _Run) -> int:
    from engine.ink_manager import alias_ink

    origin = str(run.get("source", "")).strip()
    target = str(run.get("target", "")).strip()
    if not origin or not target:
        raise ValueError(
            "alias_spot needs the ink to move and the ink it joins — an alias "
            "is a decision about which plate a colour prints on, and no machine "
            "may make it."
        )
    alias_ink(
        source,
        output,
        source=origin,
        target=target,
        accept_target_transform=bool(run.get("accept_target_transform", False)),
    )
    return 1


def _downsample_images(source: str, output: str, run: _Run) -> int:
    from engine.compress import compress

    dpi = int(run.get("dpi", 0))
    if dpi <= 0:
        raise ValueError(
            "downsample_images needs the resolution to downsample to."
        )
    compress(
        source,
        output,
        quality=str(run.get("quality", "prepress")),
        dpi=dpi,
        gs_path=run.gs_path,
        tesseract_path=run.tesseract_path,
        font_dir=run.font_dir,
    )
    return 1


def _fix_hairlines(source: str, output: str, run: _Run) -> int:
    from engine.hairlines import DEFAULT_THRESHOLD_PT, fix_hairlines

    threshold = float(run.get("threshold_pt", DEFAULT_THRESHOLD_PT))
    result = fix_hairlines(
        source,
        output,
        threshold_pt=threshold,
        # A replacement below the threshold leaves a hairline, so the
        # threshold is what a profile that named no replacement lands on.
        replacement_pt=float(run.get("replacement_pt", threshold)),
        include_annotations=bool(run.get("include_annotations", True)),
    )
    return int(result.get("fixed", 0))


def _flatten_transparency(source: str, output: str, run: _Run) -> int:
    from engine.flattener import DEFAULT_BALANCE, DEFAULT_DPI, flatten_transparency

    flatten_transparency(
        source,
        output,
        balance=float(run.get("balance", DEFAULT_BALANCE)),
        dpi=int(run.get("dpi", DEFAULT_DPI)),
        outline_text=bool(run.get("outline_text", False)),
        outline_strokes=bool(run.get("outline_strokes", False)),
        gs_path=run.gs_path,
        font_dir=run.font_dir,
    )
    return 1


def _box_groups(source: str, key: str, target_of) -> tuple[list, list]:
    """(page groups sharing one inset, refusals) for a box edit.

    ``set_page_boxes`` insets from the box's own current value, else the media
    box, and clamps into the media box silently. A fixup may not clamp — it
    would report a success over a box it did not write — so the target is
    computed here, checked against the media box BY NAME, and expressed as the
    insets that produce it.
    """
    import pikepdf

    from engine.page_boxes import effective_box

    wanted: dict = {}
    refusals: list = []
    with pikepdf.open(source) as pdf:
        for number, page in enumerate(pdf.pages, start=1):
            media = effective_box(page, "/MediaBox")
            target, refusal = target_of(page, media, number)
            if refusal:
                refusals.append(refusal)
                continue
            if target is None:
                continue
            base = effective_box(page, key) or media
            insets = (
                round(base[3] - target[3], 4),
                round(target[1] - base[1], 4),
                round(target[0] - base[0], 4),
                round(base[2] - target[2], 4),
            )
            wanted.setdefault(insets, []).append(number)
    return sorted(wanted.items()), refusals


def _set_trim_box(source: str, output: str, run: _Run) -> int:
    """A trim box where the page has none, at zero inset from the crop box.

    That is exactly the fallback ``printer_marks.resolve_trim`` already takes
    silently; writing it down is what makes the marks reproducible.
    """
    from engine.page_boxes import effective_box, set_page_boxes

    from_box = "/" + str(run.get("from_box", "crop")).strip().lstrip("/").capitalize() + "Box"
    if from_box not in ("/CropBox", "/MediaBox", "/BleedBox", "/ArtBox"):
        raise ValueError(f"set_trim_box: there is no page box called {from_box}.")

    def target_of(page, media, number):
        if effective_box(page, "/TrimBox") is not None:
            return None, None
        base = effective_box(page, from_box) or media
        if base is None:
            return None, (
                f"page {number} has neither a crop box nor a media box that "
                "will read, so there is nothing to take a trim from"
            )
        return base, None

    groups, refusals = _box_groups(source, "/TrimBox", target_of)
    if refusals:
        raise ValueError(f"set_trim_box: {refusals[0]}")
    return _apply_box_groups(source, output, "trim", groups, set_page_boxes)


def _grow_bleed_box(source: str, output: str, run: _Run) -> int:
    """A bleed box the profile's own margin wide, around the trim box."""
    from engine.page_boxes import effective_box, set_page_boxes

    bleed = float(run.get("bleed_pt", 0.0))
    if bleed <= 0:
        raise ValueError("grow_bleed_box needs the bleed margin to grow to.")

    def target_of(page, media, number):
        trim = effective_box(page, "/TrimBox")
        if trim is None:
            # Nothing to grow a bleed around. `set_trim_box` runs in the same
            # stage and writes one; a page that still has none is a page this
            # fixup has no geometry for.
            return None, None
        want = (trim[0] - bleed, trim[1] - bleed, trim[2] + bleed, trim[3] + bleed)
        current = effective_box(page, "/BleedBox")
        if current is not None and (
            current[0] <= want[0] + 1e-6 and current[1] <= want[1] + 1e-6
            and current[2] >= want[2] - 1e-6 and current[3] >= want[3] - 1e-6
        ):
            return None, None
        if media is None:
            return None, f"page {number} has no media box that will read"
        room = min(
            trim[0] - media[0], trim[1] - media[1],
            media[2] - trim[2], media[3] - trim[3],
        )
        if room + 1e-6 < bleed:
            return None, (
                f"page {number} has {max(room, 0.0):.2f} pt between its trim "
                f"and the edge of the sheet, and the profile asks for "
                f"{bleed:.2f} pt — growing the bleed box does not make room "
                "for it"
            )
        return want, None

    groups, refusals = _box_groups(source, "/BleedBox", target_of)
    if refusals:
        raise ValueError(f"grow_bleed_box: {refusals[0]}")
    return _apply_box_groups(source, output, "bleed", groups, set_page_boxes)


def _apply_box_groups(source: str, output: str, box: str, groups, door) -> int:
    """One `set_page_boxes` call per distinct inset. Pages differ, and the door
    takes one inset for a range — so the range is what varies, not the door."""
    if not groups:
        return 0
    current = source
    changed = 0
    for (top, bottom, left, right), pages in groups:
        result = door(
            current, output, box=box, top=top, bottom=bottom, left=left,
            right=right, pages=pages,
        )
        current = output
        changed += int(result.get("changed", 0))
    return changed


def _set_document_title(source: str, output: str, run: _Run) -> int:
    from engine.doc_properties import set_document_title

    title = str(run.get("title", "")).strip()
    if not title:
        raise ValueError(
            "set_document_title needs the title to write — a title a machine "
            "invented is the same failure wearing a different name."
        )
    set_document_title(source, output, title=title, allow_signed=True)
    return 1


def _set_trapped(source: str, output: str, run: _Run) -> int:
    from engine.doc_properties import set_advanced_properties

    trapped = str(run.get("trapped", "")).strip().lower()
    if trapped not in ("true", "false", "unknown"):
        raise ValueError(
            "set_trapped needs the trapping state to declare — whether a file "
            "is already trapped is a claim only a person may make."
        )
    set_advanced_properties(source, output, trapped=trapped)
    return 1


def _write_xmp(source: str, output: str, run: _Run) -> int:
    from engine.metadata import set_metadata

    fields = {
        name: str(run.params[name])
        for name in ("title", "author", "subject", "keywords")
        if run.params.get(name) is not None
    }
    # With no fields the packet is still materialized from the document
    # information dictionary, which IS the fixup: `xmp_present` is about the
    # packet existing, not about what a profile wanted to put in it.
    set_metadata(source, output, **fields)
    return 1


def _set_pdf_version(source: str, output: str, run: _Run) -> int:
    from engine.reversion import set_pdf_version

    version = str(run.get("version", "")).strip()
    if not version:
        row = run.check("pdf_version")
        version = str(row.get("params", {}).get("max_version", "1.7"))
    set_pdf_version(source, output, version=version)
    return 1


def _convert_to_pdfx(source: str, output: str, run: _Run) -> int:
    from engine.prepress import convert_pdfx

    kwargs: dict = {"gs_path": run.gs_path, "version": int(run.get("version", 3))}
    for name in ("dest_profile", "condition", "identifier", "info", "trapped"):
        if run.params.get(name) is not None:
            kwargs[name] = str(run.params[name])
    convert_pdfx(source, output, **kwargs)
    return 1


def _convert_to_pdfa(source: str, output: str, run: _Run) -> int:
    from engine.pdfa import convert_pdfa

    convert_pdfa(source, output, level=str(run.get("level", "2b")), gs_path=run.gs_path)
    return 1


def _add_printer_marks(source: str, output: str, run: _Run) -> int:
    from engine.printer_marks import add_printer_marks

    kwargs: dict = {"font_dir": run.font_dir}
    marks = list(run.get("marks", []))
    if marks:
        kwargs["marks"] = marks
    for name, cast in (("style", str), ("weight", float), ("offset", float),
                       ("length", float)):
        if run.params.get(name) is not None:
            kwargs[name] = cast(run.params[name])
    add_printer_marks(source, output, **kwargs)
    return 1


_DOORS = {
    "remove_javascript": _remove_javascript,
    "remove_attachments": _remove_attachments,
    "remove_annotations": _remove_annotations,
    "embed_missing_fonts": _embed_missing_fonts,
    "convert_to_cmyk": _convert_to_cmyk,
    "convert_to_grayscale": _convert_to_grayscale,
    "spots_to_process": _spots_to_process,
    "alias_spot": _alias_spot,
    "downsample_images": _downsample_images,
    "fix_hairlines": _fix_hairlines,
    "flatten_transparency": _flatten_transparency,
    "set_trim_box": _set_trim_box,
    "grow_bleed_box": _grow_bleed_box,
    "set_document_title": _set_document_title,
    "set_trapped": _set_trapped,
    "write_xmp": _write_xmp,
    "set_pdf_version": _set_pdf_version,
    "convert_to_pdfx": _convert_to_pdfx,
    "convert_to_pdfa": _convert_to_pdfa,
    "add_printer_marks": _add_printer_marks,
}


def fixups_for_check(check_id: str) -> tuple:
    """Which fixups answer one check. Empty for a check whose repair is a
    route to the surface that owns the edit, or nothing at all."""
    return CHECK_FIXUPS.get(check_id, ())


def _wanted_fixups(profile: dict, checks) -> list[str]:
    carried = [entry["id"] for entry in profile["fixups"]]
    if checks is None:
        return [fid for fid in FIXUP_ORDER if fid in carried]
    asked = [str(c) for c in checks]
    unknown = [c for c in asked if c not in CHECK_FIXUPS and c not in FIXUP_IDS]
    if unknown:
        raise ValueError(
            f"preflight fixups: nothing repairs {', '.join(sorted(unknown))}."
        )
    # A caller may name a CHECK (what a row's Fix button knows) or a FIXUP
    # (what a profile names). One resolution, so both surfaces get the same
    # doors rather than a second mapping each.
    selected: set = set()
    for name in asked:
        if name in CHECK_FIXUPS:
            selected.update(CHECK_FIXUPS[name])
        if name in FIXUP_IDS:
            selected.add(name)
    return [fid for fid in FIXUP_ORDER if fid in carried and fid in selected]


def apply_fixups(file: str, output: str, profile=None, profile_path: str = "",
                 checks=None, report=None, gs_path: str = "gs", font_dir: str = "",
                 tesseract_path: str = "") -> dict:
    """Run the fixups a profile carries, in the canonical order.

    Args:
        file: Input PDF path.
        output: Output PDF path (may equal `file`).
        profile: A shipped profile id, or the rule itself as an object.
        profile_path: A profile file. Exactly one of the two.
        checks: Check ids (what a row's Fix control sends) or fixup ids, or
            None for every fixup the profile carries.
        report: The check this pass is answering, when the caller already has
            one. A panel and a sweep both run the report before they offer a
            fix, and total area coverage is a Ghostscript run per page — so
            the measurement is taken once and handed on rather than repeated.
            None runs it here.
        gs_path: Ghostscript, for the colour, downsample and standard stages.
        font_dir: The vendored faces, for flattening and printer marks.
        tesseract_path: Passed to `compress`, which accepts it for its MRC arm.

    Returns ``{output, order, applied, skipped, refused, before, after,
    report}``. `order` is the sequence that actually ran, which is the
    profile's set put into the engine's order — never the profile's own
    listing.

    An `applied` row is ``{fixup, changed}``, and carries `partial` when the
    door landed some of what it was asked for and not the rest: one
    ``{item, reasons, …}`` record per thing the output does NOT carry, keyed
    by `item` whatever the door works in, so one reader serves every door.
    `changed` never counts those, so a row with ``changed`` 0 and a `partial`
    list is a door that edited the file and finished none of what it named.
    """
    from engine.preflight import preflight

    resolved = resolve_profile(profile, profile_path)
    wanted = _wanted_fixups(resolved, checks)
    if not wanted:
        carried = [entry["id"] for entry in resolved["fixups"]]
        if not carried:
            raise ValueError(
                f"The preflight profile '{resolved['id']}' carries no fixups, so "
                "there is nothing for it to repair."
            )
        raise ValueError(
            "That profile does not carry a fixup for what was asked "
            f"({', '.join(str(c) for c in (checks or []))}). It carries: "
            f"{', '.join(carried)}."
        )

    params = {entry["id"]: dict(entry["params"]) for entry in resolved["fixups"]}
    before = report if isinstance(report, dict) else preflight(
        file, profile=resolved, gs_path=gs_path, font_dir=font_dir
    )

    output_path = Path(output)
    source = str(file)
    applied: list = []
    skipped: list = []
    refused: list = []
    for fixup_id in wanted:
        run = _Run(params.get(fixup_id, {}), before, gs_path, font_dir, tesseract_path)
        try:
            outcome = _door_result(_DOORS[fixup_id](source, str(output_path), run))
        except (ValueError, RuntimeError) as exc:
            refused.append({"fixup": fixup_id, "reason": str(exc)})
            continue
        if not outcome.wrote:
            skipped.append({"fixup": fixup_id, "reason": "nothing_to_repair"})
            continue
        row = {"fixup": fixup_id, "changed": int(outcome.changed)}
        if outcome.partial:
            row["partial"] = [dict(entry) for entry in outcome.partial]
        applied.append(row)
        # Every later door reads the file the previous one wrote.
        source = str(output_path)

    if not applied and refused:
        raise ValueError(refused[0]["reason"])
    if not applied:
        if Path(file).resolve() != output_path.resolve():
            # Nothing to repair, and the caller asked for a copy: an output
            # that does not exist would report a success that wrote no file.
            output_path.parent.mkdir(parents=True, exist_ok=True)
            output_path.write_bytes(Path(file).read_bytes())
        after = before
    else:
        # The re-check is not optional. A fixup report carrying the BEFORE
        # state is a report that lies about what it did.
        after = preflight(str(output_path), profile=resolved, gs_path=gs_path,
                          font_dir=font_dir)

    return {
        "output": str(output_path),
        "profile": before["profile"],
        "order": wanted,
        "applied": applied,
        "skipped": skipped,
        "refused": refused,
        "before": before["summary"],
        "after": after["summary"],
        "report": after,
    }
