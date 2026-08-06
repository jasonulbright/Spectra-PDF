"""In-RIP trapping presets, and the truth about `/Trapped`.

Ghostscript ships no trapping engine: `currenttrapparams` is undefined, the
Trapping ProcSet is never installed, `<< /Trapping true >> setpagedevice` is
silently swallowed, and `ps2write` drops the dictionary from its output. What
it does ship is the VOCABULARY — `Resource/Init/gs_trap.ps` pins the sixteen
in-RIP trapping parameters with their types and their initial values, so a
preset can be authored against the real names rather than invented ones.

Three capabilities, and the surface is only honest with all three:

`validate_trap_preset` authors a preset over those sixteen fields.

`emit_trapping_setup` writes the presets into a PostScript file's own page
setup, which is where a RIP that implements in-RIP trapping reads them. This
is what makes a preset act rather than merely exist; without it the panel
would be a settings dialog with no consumer.

`assign_presets` records the per-page assignment on the document and is what
decides the `/Trapped` DocInfo key: `/Unknown` unless someone asserts
otherwise, and never `/True` on this path, because **no trap network is
generated here**. Producing one is a trapping engine; what is produced is
parameters for a downstream consumer.
"""

from __future__ import annotations

import re
from pathlib import Path

import pikepdf
from pikepdf import Array, Dictionary, Name, String

from .page_images import _save
from .validate import validate_pdf

# The sixteen in-RIP trapping parameters, their types, their defaults and the
# ranges a value is validated against. Names and defaults are the bundled
# `gs_trap.ps` verbatim; the enumerated placements and the bounds are the
# PostScript language definition's.
#
# The names are a WIRE VOCABULARY and are never translated: a RIP reads them,
# not a person.
TRAP_FIELDS: dict[str, dict] = {
    "BlackColorLimit": {"type": "number", "default": 1.0, "min": 0.0, "max": 1.0},
    "BlackDensityLimit": {"type": "number", "default": 1.0, "min": 0.0, "max": 10.0},
    "BlackWidth": {"type": "number", "default": 1.0, "min": 0.0, "max": 100.0},
    "ColorantZoneDetails": {"type": "colorants", "default": {}},
    "Enabled": {"type": "boolean", "default": True},
    "HalftoneName": {"type": "name", "default": None},
    "ImageInternalTrapping": {"type": "boolean", "default": False},
    "ImagemaskTrapping": {"type": "boolean", "default": True},
    "ImageResolution": {"type": "integer", "default": 1, "min": 1, "max": 10000},
    "ImageToObjectTrapping": {"type": "boolean", "default": True},
    "ImageTrapPlacement": {
        "type": "choice", "default": "Center",
        "choices": ("Center", "Choke", "Neutral", "Spread"),
    },
    "SlidingTrapLimit": {"type": "number", "default": 1.0, "min": 0.0, "max": 1.0},
    "StepLimit": {"type": "number", "default": 1.0, "min": 0.0, "max": 1.0},
    "TrapColorScaling": {"type": "number", "default": 0.0, "min": 0.0, "max": 1.0},
    "TrapSetName": {"type": "text", "default": None},
    "TrapWidth": {"type": "number", "default": 1.0, "min": 0.0, "max": 100.0},
}

# A per-colorant override may set any field except the override table itself.
_COLORANT_FIELDS = tuple(name for name in TRAP_FIELDS if name != "ColorantZoneDetails")

# The three values PDF/X allows for the DocInfo key, and the only one this
# path is entitled to claim by itself.
TRAPPED_VALUES = ("True", "False", "Unknown")
DEFAULT_TRAPPED = "Unknown"

# Where the assignment is recorded on the document.
_ASSIGNMENT_KEY = "/SpectraTrapPresets"

# The trapping resource type number `gs_trap.ps` defines, and the one PLRM's
# in-RIP trapping names.
_TRAPPING_TYPE = 1001


def trap_preset_defaults() -> dict:
    """The sixteen fields, their types, ranges and initial values.

    The panel builds its rows from this rather than from a second copy, so a
    field cannot exist in one place and not the other.
    """
    fields = []
    for name, spec in TRAP_FIELDS.items():
        row = {"name": name, "type": spec["type"], "default": spec["default"]}
        for key in ("min", "max", "choices"):
            if key in spec:
                row[key] = list(spec[key]) if key == "choices" else spec[key]
        fields.append(row)
    return {
        "fields": fields,
        "trapped_values": list(TRAPPED_VALUES),
        "default_trapped": DEFAULT_TRAPPED,
        "colorant_fields": list(_COLORANT_FIELDS),
    }


def _number(field: str, value, spec: dict) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        raise ValueError(f"{field} must be a number.") from None
    low, high = spec["min"], spec["max"]
    if not (low <= number <= high):
        raise ValueError(f"{field} must be between {low} and {high}.")
    return number


def _integer(field: str, value, spec: dict) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError):
        raise ValueError(f"{field} must be a whole number.") from None
    low, high = spec["min"], spec["max"]
    if not (low <= number <= high):
        raise ValueError(f"{field} must be between {low} and {high}.")
    return number


def _validate_field(field: str, value, spec: dict):
    kind = spec["type"]
    if kind == "number":
        return _number(field, value, spec)
    if kind == "integer":
        return _integer(field, value, spec)
    if kind == "boolean":
        if not isinstance(value, bool):
            raise ValueError(f"{field} must be true or false.")
        return value
    if kind == "choice":
        text = str(value)
        if text not in spec["choices"]:
            choices = ", ".join(spec["choices"])
            raise ValueError(f"{field} must be one of {choices}.")
        return text
    if kind in ("name", "text"):
        if value is None:
            return None
        text = str(value)
        return text if text else None
    raise ValueError(f"{field} is not an In-RIP trapping parameter.")


def _validate_colorants(value) -> dict:
    if value is None:
        return {}
    if not isinstance(value, dict):
        raise ValueError("ColorantZoneDetails must name a colorant per entry.")
    out: dict[str, dict] = {}
    for colorant, overrides in value.items():
        name = str(colorant)
        if not name:
            raise ValueError("ColorantZoneDetails must name a colorant per entry.")
        if not isinstance(overrides, dict):
            raise ValueError(f"The overrides for {name} must be trapping parameters.")
        row: dict = {}
        for field, entry in overrides.items():
            field = str(field)
            if field not in _COLORANT_FIELDS:
                raise ValueError(f"{field} is not an In-RIP trapping parameter.")
            row[field] = _validate_field(field, entry, TRAP_FIELDS[field])
        out[name] = row
    return out


def validate_trap_preset(preset: dict | None = None, name: str = "") -> dict:
    """One preset, every field present and in range.

    Args:
        preset: The fields to set. Anything omitted takes its initial value.
        name: The preset's own name, for the panel's list.

    A field the vocabulary does not have is a refusal rather than an ignored
    key: a parameter a RIP will never read is a setting the user believes they
    made.
    """
    supplied = dict(preset or {})
    unknown = [str(key) for key in supplied if str(key) not in TRAP_FIELDS]
    if unknown:
        raise ValueError(f"{unknown[0]} is not an In-RIP trapping parameter.")
    values: dict = {}
    for field, spec in TRAP_FIELDS.items():
        if field == "ColorantZoneDetails":
            values[field] = _validate_colorants(supplied.get(field, spec["default"]))
            continue
        if field in supplied:
            values[field] = _validate_field(field, supplied[field], spec)
        else:
            values[field] = spec["default"]
    return {"name": str(name), "fields": values}


# ── the PostScript emission ────────────────────────────────────────────────


def _ps_number(value: float) -> str:
    text = f"{float(value):.6f}".rstrip("0").rstrip(".")
    return text if text else "0"


def _ps_string(text: str) -> str:
    escaped = str(text).replace("\\", "\\\\").replace("(", "\\(").replace(")", "\\)")
    return f"({escaped})"


# A PostScript name written literally must contain no whitespace and no
# delimiter. Anything else is built from a string with `cvn`, which is exact
# for every colorant name a document can carry.
_PLAIN_NAME = re.compile(r"^[A-Za-z0-9_.\-+]+$")


def _ps_name(text: str) -> str:
    return f"/{text}" if _PLAIN_NAME.match(str(text)) else f"{_ps_string(text)} cvn"


def _ps_value(field: str, value) -> str:
    spec = TRAP_FIELDS[field]
    kind = spec["type"]
    if kind == "boolean":
        return "true" if value else "false"
    if kind == "integer":
        return str(int(value))
    if kind == "number":
        return _ps_number(value)
    if kind == "choice":
        return f"/{value}"
    if kind == "name":
        return "null" if value is None else _ps_name(value)
    if kind == "text":
        return "null" if value is None else _ps_string(value)
    raise ValueError(f"{field} is not an In-RIP trapping parameter.")


def _ps_params(fields: dict, indent: str) -> list[str]:
    lines = []
    for field in TRAP_FIELDS:
        if field == "ColorantZoneDetails":
            zones = fields.get(field) or {}
            if not zones:
                lines.append(f"{indent}/ColorantZoneDetails << >>")
                continue
            lines.append(f"{indent}/ColorantZoneDetails <<")
            for colorant, overrides in zones.items():
                inner = " ".join(
                    f"/{key} {_ps_value(key, overrides[key])}" for key in sorted(overrides)
                )
                lines.append(f"{indent}  {_ps_name(colorant)} << {inner} >>")
            lines.append(f"{indent}>>")
            continue
        lines.append(f"{indent}/{field} {_ps_value(field, fields[field])}")
    return lines


def trapping_setup_block(preset: dict) -> str:
    """The PostScript a RIP reads the preset out of.

    `setpagedevice` is the documented in-RIP trapping door and is emitted
    plainly. `settrapparams` is NOT: it exists only where the Trapping ProcSet
    is installed, so it is guarded by a `resourcestatus` check. A RIP without
    in-RIP trapping then skips the parameters instead of erroring the job,
    which is the difference between a preset a device ignores and a preset
    that stops the press.
    """
    fields = preset["fields"]
    lines = [
        "%%BeginFeature: *Trapping True",
        f"<< /Trapping true /TrappingType {_TRAPPING_TYPE} >> setpagedevice",
        "/Trapping /ProcSet resourcestatus {",
        "  pop pop /Trapping /ProcSet findresource begin",
        "  <<",
        *_ps_params(fields, "    "),
        "  >> settrapparams",
        "  end",
        "} if",
        "%%EndFeature",
    ]
    return "\n".join(lines)


_PAGE_COMMENT = re.compile(rb"^%%Page:\s*(\S+)\s+(\d+)\s*$")


def _normalized_assignments(assignments, total: int | None) -> list[dict]:
    out: list[dict] = []
    for entry in assignments or []:
        first = int(entry.get("first", 1))
        last = int(entry.get("last", first))
        if first > last:
            first, last = last, first
        if first < 1 or (total is not None and last > total):
            page_range = f"{first}-{last}" if first != last else f"{first}"
            raise ValueError(f"Pages {page_range} are not in this document.")
        out.append({
            "first": first,
            "last": last,
            "preset": validate_trap_preset(entry.get("preset"), entry.get("name", "")),
        })
    return out


def _preset_for(assignments: list[dict], page: int):
    for entry in assignments:
        if entry["first"] <= page <= entry["last"]:
            return entry["preset"]
    return None


def emit_trapping_setup(file: str, output: str = "", assignments=None) -> dict:
    """Write each assignment's trapping setup into the PostScript's page setup.

    Args:
        file: A DSC-conformant PostScript file.
        output: Where to write. Empty rewrites `file` in place.
        assignments: [{first, last, name, preset}] — the page ranges and what
            each one traps with.

    The block lands inside the page's own `%%BeginPageSetup … %%EndPageSetup`,
    immediately before the closing comment, which is where DSC puts page-level
    device setup and where the page's own content has not started yet.
    """
    source = Path(file)
    if not source.is_file():
        raise ValueError(f"input file not found: {file}")
    data = source.read_bytes()
    if not data.startswith(b"%!"):
        raise ValueError(
            "This PostScript file has no page structure to attach trapping setup to."
        )
    lines = data.split(b"\n")
    pages = [index for index, line in enumerate(lines)
             if _PAGE_COMMENT.match(line.rstrip(b"\r"))]
    if not pages:
        raise ValueError(
            "This PostScript file has no page structure to attach trapping setup to."
        )
    plan = _normalized_assignments(assignments, len(pages))

    out: list[bytes] = []
    page_number = 0
    pending: bytes | None = None
    attached = 0
    for line in lines:
        stripped = line.rstrip(b"\r")
        if _PAGE_COMMENT.match(stripped):
            page_number += 1
            preset = _preset_for(plan, page_number)
            pending = (
                trapping_setup_block(preset).encode("ascii") if preset is not None else None
            )
        elif stripped == b"%%EndPageSetup" and pending is not None:
            out.extend(pending.split(b"\n"))
            attached += 1
            pending = None
        out.append(line)

    target = Path(output) if output else source
    target.write_bytes(b"\n".join(out))
    return {
        "output": str(target),
        "pages": len(pages),
        "attached": attached,
        "assignments": [
            {"first": e["first"], "last": e["last"], "name": e["preset"]["name"]}
            for e in plan
        ],
    }


# ── PostScript output, the consumer the presets are written for ────────────


def export_postscript(
    file: str,
    output: str,
    gs_path: str = "gs",
    level: int = 3,
    pages: str = "",
    trapping: bool = True,
) -> dict:
    """Write the document as DSC-conformant PostScript, with its trapping
    setup attached.

    Args:
        file: Input PDF path.
        output: Output .ps path.
        gs_path: Path to the Ghostscript executable.
        level: PostScript language level, 2 or 3. In-RIP trapping is a
            LanguageLevel 3 facility.
        pages: Ghostscript page list, or empty for the whole document.
        trapping: False writes the PostScript without the trapping setup, for
            a consumer that must not see it.

    The trapping half is what the presets exist for: a preset a RIP never
    reads is a settings dialog with no consumer, and this is the door the
    parameters reach one through.
    """
    from . import budget

    validate_pdf(file)
    level = int(level)
    if level not in (2, 3):
        raise ValueError("PostScript language level must be 2 or 3.")
    source = Path(file)
    target = Path(output)
    cmd = [
        gs_path, "-dNOPAUSE", "-dBATCH", "-dSAFER", "-q",
        "-sDEVICE=ps2write", f"-dLanguageLevel={level}",
    ]
    if pages:
        cmd.append(f"-sPageList={pages}")
    cmd += [f"-sOutputFile={str(target).replace('%', '%%')}", str(source)]
    result = budget.gs(cmd, what="Ghostscript (PostScript export)", path=source)
    if result.returncode != 0 or not target.is_file():
        detail = (result.stderr or result.stdout or "").strip()
        raise RuntimeError(f"Ghostscript PostScript export failed: {detail}")

    carried = list_trap_presets(file)
    attached = 0
    if trapping and carried["assignments"]:
        if level != 3:
            raise ValueError(
                "In-RIP trapping is a LanguageLevel 3 facility and cannot be "
                "written into LanguageLevel 2 PostScript."
            )
        emitted = emit_trapping_setup(
            str(target), assignments=carried["assignments"]
        )
        attached = emitted["attached"]
    return {
        "output": str(target),
        "level": level,
        "trapping_pages": attached,
        "trapped": carried["trapped"],
        "output_size": target.stat().st_size,
    }


# ── the document assignment, and `/Trapped` ────────────────────────────────


def _to_pdf(value):
    if isinstance(value, bool):
        return value
    if isinstance(value, (int, float)):
        return value
    if isinstance(value, dict):
        return Dictionary(**{key: _to_pdf(entry) for key, entry in value.items()})
    if value is None:
        return None
    return String(str(value))


def _from_pdf(value):
    if isinstance(value, Dictionary):
        return {str(key).lstrip("/"): _from_pdf(value[key]) for key in value.keys()}
    if isinstance(value, String):
        return str(value)
    if isinstance(value, bool):
        return value
    try:
        number = float(value)
    except (TypeError, ValueError):
        return str(value)
    return int(number) if number.is_integer() and abs(number) < 1e15 else number


def _stored_fields(preset: dict) -> Dictionary:
    stored = Dictionary()
    for field, value in preset["fields"].items():
        if value is None:
            continue
        stored[Name("/" + field)] = _to_pdf(value)
    return stored


def assign_presets(
    file: str,
    output: str,
    assignments=None,
    trapped: str = DEFAULT_TRAPPED,
) -> dict:
    """Record which preset traps which pages, and state `/Trapped` honestly.

    Args:
        file: Input PDF path.
        output: Output PDF path.
        assignments: [{first, last, name, preset}] — validated before anything
            is written.
        trapped: The DocInfo `/Trapped` value: Unknown, False, or True.

    `/True` asserts the document carries a trap network. Nothing on this path
    generates one, so `/True` is only ever the caller's own assertion about
    work done elsewhere, and `/Unknown` is what an unasserted document gets.
    """
    validate_pdf(file)
    claim = str(trapped).strip().lstrip("/").capitalize()
    if claim not in TRAPPED_VALUES:
        allowed = ", ".join(TRAPPED_VALUES)
        raise ValueError(f"Trapped must be one of {allowed}.")

    with pikepdf.open(file) as pdf:
        plan = _normalized_assignments(assignments, len(pdf.pages))
        records = Array()
        for entry in plan:
            records.append(Dictionary(
                First=entry["first"],
                Last=entry["last"],
                Name=String(entry["preset"]["name"]),
                Params=_stored_fields(entry["preset"]),
            ))
        if records:
            pdf.Root[Name(_ASSIGNMENT_KEY)] = pdf.make_indirect(records)
        elif Name(_ASSIGNMENT_KEY) in pdf.Root:
            del pdf.Root[Name(_ASSIGNMENT_KEY)]
        pdf.docinfo[Name("/Trapped")] = Name("/" + claim)
        # Same-file output takes temp-and-rename: pikepdf refuses to save over
        # the file it is reading, and the panel's apply routes the working file
        # back onto itself.
        _save(pdf, Path(file), Path(output))
    return {
        "output": str(output),
        "trapped": claim,
        "assignments": [
            {"first": e["first"], "last": e["last"], "name": e["preset"]["name"]}
            for e in plan
        ],
    }


def list_trap_presets(file: str) -> dict:
    """The presets a document carries, its `/Trapped` value, and the inks any
    per-colorant override names that the document does not use.

    A preset naming an absent ink is a WARNING and never a refusal: a preset is
    written to be reused across documents, and one that refuses the moment a
    job lacks a spot is a preset nobody can keep.
    """
    validate_pdf(file)
    from .separations import list_inks

    known = {entry["name"] for entry in list_inks(file)["inks"]}
    assignments: list[dict] = []
    with pikepdf.open(file) as pdf:
        total = len(pdf.pages)
        records = pdf.Root.get(Name(_ASSIGNMENT_KEY))
        trapped = str(pdf.docinfo.get(Name("/Trapped"), "")).lstrip("/")
        for record in list(records or []):
            fields = _from_pdf(record.get("/Params", Dictionary()))
            merged = {name: spec["default"] for name, spec in TRAP_FIELDS.items()}
            merged.update(fields)
            # The shape is exactly what `assign_presets` and
            # `emit_trapping_setup` take, so a document's own assignment can
            # be handed straight back to either without a translation step.
            assignments.append({
                "first": int(record.get("/First", 1)),
                "last": int(record.get("/Last", 1)),
                "name": str(record.get("/Name", "")),
                "preset": merged,
            })
    unused: list[str] = []
    for entry in assignments:
        zones = entry["preset"].get("ColorantZoneDetails") or {}
        for colorant in zones:
            if colorant not in known and colorant not in unused:
                unused.append(colorant)
    return {
        "assignments": assignments,
        "trapped": trapped or DEFAULT_TRAPPED,
        "pages": total,
        "unused_colorants": unused,
    }
