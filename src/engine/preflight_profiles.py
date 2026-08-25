"""Preflight profiles — the rule a verdict was measured against.

A preflight verdict is meaningless without its rule, so the profile is not a
filter over a fixed report: it IS the report's premise. Every check row carries
the parameters it resolved to, which is what makes a saved report legible a
year later by someone who does not have the profile.

Two rules govern the schema.

**Severity is the profile's; the verdict is the document's.** A check decides
`clean` or `dirty`; the profile decides whether dirty reads as `fail` or
`warn`. One check implementation, nine shipped opinions — which is why
``ink_coverage_max`` can be a hard stop on newsprint and a note on an office
profile without two code paths.

**Validation lives here and nowhere else.** A second validator on the other
side of the bridge would be a second answer waiting to drift, and a profile is
resolved by the command line and a scheduled run with no renderer present at
all. The shipped profiles are constants for the same reason: a print shop's
overnight sweep must resolve ``sheetfed_offset`` with the app closed.

The nine shipped ids are RESERVED. A user profile claiming one is refused, so
"reset to the shipped rule" is always available and a derived profile always
records what it was derived from.
"""

from __future__ import annotations

import json
from pathlib import Path

#: The profile document version. A file naming another one is refused rather
#: than read optimistically — a schema this module cannot read is a rule it
#: would apply wrongly.
SCHEMA = 1

FAIL = "fail"
WARN = "warn"
#: What a profile may set a check's severity to. `pass` is not a severity: a
#: check that must never fail is DISABLED, which the report states.
SEVERITIES = (FAIL, WARN)

# The category order the report and both emitters render in.
CATEGORIES = (
    "document",
    "pages",
    "colour",
    "fonts",
    "images",
    "content",
    "metadata",
)

#: id → category, in report order. The renderer mirrors this list; the parity
#: gate reads the mirror as source text — a check the engine reports and the
#: panel cannot name would render nameless.
CHECK_INVENTORY = (
    ("pdf_version", "document"),
    ("print_permitted", "document"),
    ("structurally_sound", "document"),
    ("output_intent", "document"),
    ("pdfx_claim", "document"),
    ("trapped_declared", "document"),
    ("embedded_files", "document"),
    ("page_size_consistent", "pages"),
    ("page_size_expected", "pages"),
    ("trim_box", "pages"),
    ("bleed_sufficient", "pages"),
    ("page_count", "pages"),
    ("colour_family", "colour"),
    ("grayscale_only", "colour"),
    ("device_independent_colour", "colour"),
    ("spot_ink_count", "colour"),
    ("spot_ink_names", "colour"),
    ("ink_coverage_max", "colour"),
    ("overprint", "colour"),
    ("fonts_embedded", "fonts"),
    ("fonts_subset", "fonts"),
    ("type3_fonts", "fonts"),
    ("min_type_size", "fonts"),
    ("small_text_k_only", "fonts"),
    ("image_min_dpi_contone", "images"),
    ("image_min_dpi_bitonal", "images"),
    ("image_max_dpi", "images"),
    ("image_compression", "images"),
    ("image_colour_space", "images"),
    ("live_transparency", "content"),
    ("hairlines_absent", "content"),
    ("optional_content", "content"),
    ("processing_steps", "content"),
    ("printing_annotations", "content"),
    ("interactive_form", "content"),
    ("title_present", "metadata"),
    ("document_javascript", "metadata"),
    ("xmp_present", "metadata"),
)

CHECK_IDS = tuple(cid for cid, _cat in CHECK_INVENTORY)


class _P:
    """One settable parameter: its kind, its default, and its bound.

    `positive` means the value must be greater than zero; without it zero is
    the "unset" value for every numeric parameter that has one (an unset
    expected page size, an unset maximum resolution), and the check reports
    `not_applicable` rather than measuring against nothing.
    """

    __slots__ = ("kind", "default", "positive")

    def __init__(self, kind: str, default, positive: bool = False):
        self.kind = kind
        self.default = default
        self.positive = positive


#: Every parameter a profile may set, per check, BEYOND the universal
#: `enabled` and `severity`. A parameter absent from a profile resolves to the
#: default here, and a parameter NOT in this table is refused by name — a typo
#: must never silently disable a rule.
CHECK_PARAMS: dict[str, dict[str, _P]] = {
    "pdf_version": {
        "max_version": _P("str", "1.7"),
        "min_version": _P("str", ""),
    },
    "print_permitted": {},
    "structurally_sound": {},
    "output_intent": {
        # Off by default. A great many perfectly printable documents carry no
        # output intent because their producer never wrote one; requiring it
        # outside the standards profiles would train people to ignore the
        # panel, which costs more than the check is worth.
        "required": _P("bool", False),
        "allowed_identifiers": _P("strings", ()),
        "require_embedded_profile": _P("bool", False),
    },
    "pdfx_claim": {"expected": _P("str", "")},
    "trapped_declared": {
        "require_declared": _P("bool", False),
        "accept": _P("strings", ("true", "false")),
    },
    "embedded_files": {"allow": _P("bool", True)},
    "page_size_consistent": {"tolerance_pt": _P("float", 1.0, positive=True)},
    "page_size_expected": {
        "width_pt": _P("float", 0.0),
        "height_pt": _P("float", 0.0),
        "tolerance_pt": _P("float", 1.0, positive=True),
        "allow_landscape": _P("bool", True),
    },
    "trim_box": {},
    # 3 mm = 8.504 pt, rounded to the figure printer_marks already defaults to.
    "bleed_sufficient": {"min_bleed_pt": _P("float", 8.5, positive=True)},
    "page_count": {
        "min_pages": _P("int", 0),
        "max_pages": _P("int", 0),
        "multiple_of": _P("int", 0),
    },
    "colour_family": {"forbidden_families": _P("strings", ("DeviceRGB", "CalRGB"))},
    "grayscale_only": {"require_grayscale": _P("bool", False)},
    "device_independent_colour": {"forbidden_families": _P("strings", ())},
    "spot_ink_count": {"max_spots": _P("int", 2)},
    "spot_ink_names": {
        "allowed_names": _P("strings", ()),
        "allow_unlisted": _P("bool", True),
    },
    "ink_coverage_max": {
        "max_tac_pct": _P("float", 300.0, positive=True),
        "sample_dpi": _P("int", 150, positive=True),
        "over_area_pct": _P("float", 0.0),
        # The budget, not a sample. Pages beyond it report needs_review BY
        # NAME; nothing is ever estimated from the pages that did run. The
        # name is not `max_pages`: that already means "the most pages this
        # job may have" on the page-count check, and one name meaning two
        # things renders one of them wrongly.
        "max_pages_measured": _P("int", 32, positive=True),
    },
    "overprint": {
        "flag_any": _P("bool", False),
        "flag_white_text": _P("bool", True),
        "flag_white_fill": _P("bool", True),
    },
    "fonts_embedded": {},
    "fonts_subset": {"require_subset": _P("bool", False)},
    "type3_fonts": {"allow_type3": _P("bool", True)},
    "min_type_size": {
        "min_size_pt": _P("float", 4.0, positive=True),
        "min_size_pt_reversed": _P("float", 6.0, positive=True),
    },
    "small_text_k_only": {
        "max_inks": _P("int", 1),
        "applies_below_pt": _P("float", 12.0, positive=True),
    },
    "image_min_dpi_contone": {"min_dpi": _P("int", 300, positive=True)},
    "image_min_dpi_bitonal": {"min_dpi": _P("int", 1200, positive=True)},
    "image_max_dpi": {"max_dpi": _P("int", 0)},
    "image_compression": {"forbidden_filters": _P("strings", ())},
    "image_colour_space": {"forbidden_families": _P("strings", ("DeviceRGB", "CalRGB"))},
    "live_transparency": {},
    "hairlines_absent": {
        "threshold_pt": _P("float", 0.25, positive=True),
        "include_annotations": _P("bool", True),
    },
    "optional_content": {"allow_optional_content": _P("bool", True)},
    # Processing steps (die lines, creases, varnish, white, legend) are a
    # packaging and label construct, so every parameter here is off by
    # default: a commercial-print job that declares none must not be told it
    # is missing something, and a job that declares them is asked only the
    # question a machine can answer without the standard's own text —
    # whether a step declared non-printing is actually excluded from the
    # print. See `engine/processing_steps.py` for what is and is not
    # decidable here.
    # `forbid_printing` is OFF by default and that is a finding, not an
    # oversight: every one of the 40 patches in the standard's own test
    # corpus leaves its processing-step groups on in the default
    # configuration and every one of them is compliant. Requiring the file to
    # additionally declare the groups off the print (`/Usage /Print
    # /PrintState /OFF`) is a house rule a profile opts into, never a defect
    # this inventory pronounces on its own.
    "processing_steps": {
        "require_steps_declared": _P("bool", False),
        "forbid_printing": _P("bool", False),
        "allow_custom": _P("bool", True),
    },
    "printing_annotations": {
        "forbidden_subtypes": _P("strings", ()),
        "printing_only": _P("bool", True),
    },
    "interactive_form": {"allow_forms": _P("bool", True)},
    "title_present": {"require_title": _P("bool", False)},
    "document_javascript": {"allow_js": _P("bool", True)},
    "xmp_present": {"require_xmp": _P("bool", False)},
}

#: The severity a check reports at when the profile does not say. Every check
#: whose finding is a convention rather than a rule defaults to `warn`; § 13's
#: box-check ruling is why `trim_box` is one of them.
CHECK_SEVERITY: dict[str, str] = {cid: FAIL for cid in CHECK_IDS}
CHECK_SEVERITY.update(
    {
        "page_size_consistent": WARN,
        "trim_box": WARN,
        "bleed_sufficient": WARN,
        "spot_ink_count": WARN,
        "fonts_subset": WARN,
        "type3_fonts": WARN,
        "min_type_size": WARN,
        "small_text_k_only": WARN,
        "live_transparency": WARN,
        "hairlines_absent": WARN,
        "printing_annotations": WARN,
        "title_present": WARN,
        "image_max_dpi": WARN,
    }
)

#: The fixup ids a profile may name. The DOOR each one opens is
#: `engine/preflight_fixups.py`'s answer; the NAMES live here because a profile
#: is what names them and validation is what refuses an unknown one.
FIXUP_IDS = (
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

#: Fixup pairs that cannot both run. Naming both refuses at VALIDATION, never
#: mid-run: a colour conversion that has already rewritten the file cannot be
#: told afterwards that its opposite was also asked for.
FIXUP_EXCLUSIONS = (
    ("convert_to_cmyk", "convert_to_grayscale"),
    ("convert_to_pdfx", "convert_to_pdfa"),
)


def _coerce(check_id: str, name: str, spec: _P, raw):
    """One parameter value, refused by name rather than coerced silently."""
    if spec.kind == "bool":
        if not isinstance(raw, bool):
            raise ValueError(
                f"preflight profile: {check_id}.{name} must be true or false, "
                f"got {raw!r}"
            )
        return raw
    if spec.kind == "str":
        if not isinstance(raw, str):
            raise ValueError(f"preflight profile: {check_id}.{name} must be text, got {raw!r}")
        return raw
    if spec.kind == "strings":
        if isinstance(raw, str) or not isinstance(raw, (list, tuple)):
            raise ValueError(
                f"preflight profile: {check_id}.{name} must be a list of text values, "
                f"got {raw!r}"
            )
        out = []
        for item in raw:
            if not isinstance(item, str):
                raise ValueError(
                    f"preflight profile: {check_id}.{name} must be a list of text "
                    f"values, got {item!r} in it"
                )
            out.append(item)
        return tuple(out)
    if isinstance(raw, bool) or not isinstance(raw, (int, float)):
        raise ValueError(f"preflight profile: {check_id}.{name} must be a number, got {raw!r}")
    value = int(raw) if spec.kind == "int" else float(raw)
    bound = "greater than zero" if spec.positive else "zero or greater"
    if (spec.positive and value <= 0) or (not spec.positive and value < 0):
        raise ValueError(
            f"preflight profile: {check_id}.{name} is {value}, which must be {bound}."
        )
    return value


def _validate_check_entry(check_id: str, entry) -> dict:
    if not isinstance(entry, dict):
        raise ValueError(
            f"preflight profile: the entry for check '{check_id}' must be an object, "
            f"got {entry!r}"
        )
    spec = CHECK_PARAMS[check_id]
    out: dict = {}
    for name, raw in entry.items():
        if name == "enabled":
            if not isinstance(raw, bool):
                raise ValueError(
                    f"preflight profile: {check_id}.enabled must be true or false, "
                    f"got {raw!r}"
                )
            out["enabled"] = raw
            continue
        if name == "severity":
            if raw not in SEVERITIES:
                raise ValueError(
                    f"preflight profile: {check_id}.severity is {raw!r}; it must be "
                    f"one of {', '.join(SEVERITIES)}."
                )
            out["severity"] = raw
            continue
        if name not in spec:
            known = ", ".join(sorted(spec)) or "none"
            raise ValueError(
                f"preflight profile: check '{check_id}' has no parameter "
                f"'{name}' (it takes: {known})."
            )
        out[name] = _coerce(check_id, name, spec[name], raw)
    return out


def _validate_fixups(fixups) -> list:
    if not isinstance(fixups, (list, tuple)):
        raise ValueError(f"preflight profile: 'fixups' must be a list, got {fixups!r}")
    out: list = []
    named: list[str] = []
    for entry in fixups:
        if isinstance(entry, str):
            entry = {"id": entry}
        if not isinstance(entry, dict) or not isinstance(entry.get("id"), str):
            raise ValueError(f"preflight profile: a fixup entry must name an id, got {entry!r}")
        fid = entry["id"]
        if fid not in FIXUP_IDS:
            raise ValueError(
                f"preflight profile: '{fid}' is not a fixup this app performs "
                f"(it knows: {', '.join(FIXUP_IDS)})."
            )
        params = entry.get("params", {})
        if not isinstance(params, dict):
            raise ValueError(
                f"preflight profile: the parameters of fixup '{fid}' must be an "
                f"object, got {params!r}"
            )
        named.append(fid)
        out.append({"id": fid, "params": dict(params)})
    for first, second in FIXUP_EXCLUSIONS:
        if first in named and second in named:
            raise ValueError(
                f"preflight profile: '{first}' and '{second}' cannot both run — "
                "each undoes what the other did. Name one."
            )
    return out


def _validate_fixup_agreement(profile: dict) -> None:
    """A fixup that would create the failure it is meant to clear.

    Downsampling below the profile's own contone minimum leaves a document
    that fails the very check the fixup was selected for, so the disagreement
    is refused before a run starts rather than discovered inside one.
    """
    downsample = next(
        (f for f in profile["fixups"] if f["id"] == "downsample_images"), None
    )
    if downsample is None:
        return
    raw = downsample["params"].get("dpi")
    if isinstance(raw, bool) or not isinstance(raw, (int, float)):
        return
    minimum = profile["checks"].get("image_min_dpi_contone", {}).get(
        "min_dpi", CHECK_PARAMS["image_min_dpi_contone"]["min_dpi"].default
    )
    if float(raw) < float(minimum):
        raise ValueError(
            f"preflight profile: downsample_images.dpi is {int(raw)} but "
            f"image_min_dpi_contone.min_dpi is {int(minimum)} — the fixup would "
            "create the failure it is meant to clear."
        )


def validate_profile(profile, *, allow_shipped_id: bool = False) -> dict:
    """Read one profile document, or refuse by name.

    Returns a NORMALIZED copy: unknown keys are refused, every parameter is
    coerced to its declared kind and bound, and the fixup set is checked
    against the two exclusions and the downsample agreement. Nothing is
    defaulted silently — an absent check simply runs at the inventory default,
    which the report then states.
    """
    if not isinstance(profile, dict):
        raise ValueError(f"preflight profile: expected an object, got {profile!r}")
    schema = profile.get("schema", SCHEMA)
    if schema != SCHEMA:
        raise ValueError(
            f"preflight profile: schema {schema!r} is not one this app reads "
            f"(it reads schema {SCHEMA})."
        )
    pid = profile.get("id", "")
    if not isinstance(pid, str) or not pid.strip():
        raise ValueError("preflight profile: 'id' must be a non-empty name.")
    pid = pid.strip()
    if not allow_shipped_id and pid in SHIPPED_PROFILES:
        raise ValueError(
            f"preflight profile: '{pid}' is a profile this app ships and cannot be "
            "replaced. Save it under a different id."
        )
    name = profile.get("name", "")
    if not isinstance(name, str):
        raise ValueError(f"preflight profile: 'name' must be text, got {name!r}")
    based_on = profile.get("based_on", "")
    if not isinstance(based_on, str):
        raise ValueError(f"preflight profile: 'based_on' must be text, got {based_on!r}")

    raw_checks = profile.get("checks", {})
    if not isinstance(raw_checks, dict):
        raise ValueError(f"preflight profile: 'checks' must be an object, got {raw_checks!r}")
    checks: dict = {}
    for check_id, entry in raw_checks.items():
        if check_id not in CHECK_PARAMS:
            raise ValueError(
                f"preflight profile: '{check_id}' is not a check this app runs. "
                "A typo here would silently disable a rule."
            )
        checks[check_id] = _validate_check_entry(check_id, entry)

    out = {
        "schema": SCHEMA,
        "id": pid,
        "name": name,
        "checks": checks,
        "fixups": _validate_fixups(profile.get("fixups", [])),
    }
    for optional in ("name_key", "description_key", "based_on"):
        value = profile.get(optional)
        if isinstance(value, str) and value:
            out[optional] = value
    _validate_fixup_agreement(out)
    return out


def resolved_params(profile: dict, check_id: str) -> dict:
    """Every parameter of one check, resolved against the profile.

    The report carries this verbatim on the check row: the artifact has to
    state the rule it was measured against, not merely the outcome.
    """
    entry = profile.get("checks", {}).get(check_id, {})
    out: dict = {}
    for name, spec in CHECK_PARAMS[check_id].items():
        value = entry.get(name, spec.default)
        out[name] = list(value) if isinstance(value, tuple) else value
    return out


def check_enabled(profile: dict, check_id: str) -> bool:
    return bool(profile.get("checks", {}).get(check_id, {}).get("enabled", True))


def check_severity(profile: dict, check_id: str) -> str:
    return str(
        profile.get("checks", {}).get(check_id, {}).get(
            "severity", CHECK_SEVERITY[check_id]
        )
    )


def load_profile_file(path: str) -> dict:
    """A user profile from disk, validated. Refuses loudly and reads nothing
    partial — the `symbol-set-io` rule, applied to a rule set."""
    try:
        raw = json.loads(Path(path).read_text(encoding="utf8"))
    except OSError as exc:
        raise ValueError(f"The preflight profile could not be read: {exc}") from exc
    except json.JSONDecodeError as exc:
        raise ValueError(
            f"The preflight profile is not valid JSON: {exc}"
        ) from exc
    return validate_profile(raw)


def resolve_profile(profile=None, profile_path: str = "") -> dict:
    """The profile a run measures against — a shipped id, a file, or the
    default. Naming both a id and a path refuses: two rules is no rule."""
    if profile is not None and profile_path:
        raise ValueError(
            "Give either a preflight profile id or a profile file, not both."
        )
    if profile_path:
        return load_profile_file(profile_path)
    if profile is None or profile == "":
        return SHIPPED_PROFILES[DEFAULT_PROFILE_ID]
    if isinstance(profile, dict):
        # A rule handed in as an object is the caller's own, for this run, and
        # outlives nothing. The reserved-id refusal governs profiles SAVED to
        # disk, where overwriting a shipped rule is what would make "reset to
        # the shipped rule" impossible.
        return validate_profile(profile, allow_shipped_id=True)
    pid = str(profile)
    shipped = SHIPPED_PROFILES.get(pid)
    if shipped is None:
        raise ValueError(
            f"There is no preflight profile called '{pid}' "
            f"(this app ships: {', '.join(SHIPPED_PROFILE_IDS)})."
        )
    return shipped


# ── the nine shipped profiles ─────────────────────────────────────────────
#
# Every number is sourced, because a number with no source is a number nobody
# can argue with later.
#
# 300 % total area coverage is the commercial sheetfed and heatset-web figure
# the standard characterization data sets are built around; 240 % is the
# newsprint figure; 280 % for digital is the conservative toner/inkjet figure
# — a dry-toner press lays down less before it stops fusing.
#
# 8.5 pt bleed is 3 mm, and is already printer_marks' own default. 36 pt
# (0.5 in) for large format is finishing practice on stock whose trim
# tolerance is an order of magnitude looser.
#
# 300 dpi contone and 1200 dpi bitonal are the 2×-halftone-screen and
# imagesetter figures. 100 dpi for large format is a viewing-distance figure,
# not a quality concession.
#
# 0.25 pt is already hairlines.DEFAULT_THRESHOLD_PT. The looser newsprint and
# large-format numbers reflect dot gain on absorbent and wide stock.
#
# PDF/X-1a and X-3 are PDF 1.3 and X-4 is PDF 1.6 — the mapping
# prepress._PDFX_VERSIONS already encodes. X-3 differs from X-1a in permitting
# device-independent colour, which is one check's parameter and nothing else;
# X-4 additionally permits live transparency and optional content.


def _press(
    *,
    pid: str,
    name: str,
    tac: float,
    contone: int,
    bitonal: int,
    max_dpi: int,
    bleed: float,
    hairline: float,
    max_spots: int,
    spot_severity: str,
    rgb_severity: str,
    transparency: str,
    version: str,
    tac_pages: int = 32,
) -> dict:
    """One general press profile. The nine differ in their NUMBERS, not in
    their shape, so the shape is written once and a diff between two profiles
    is a diff between two presses."""
    checks: dict = {
        "pdf_version": {"severity": FAIL, "max_version": version},
        "trim_box": {"severity": WARN},
        "bleed_sufficient": {"severity": WARN, "min_bleed_pt": bleed},
        "ink_coverage_max": {
            "severity": FAIL,
            "max_tac_pct": tac,
            "max_pages_measured": tac_pages,
        },
        "spot_ink_count": {"severity": spot_severity, "max_spots": max_spots},
        "colour_family": {"severity": rgb_severity},
        "image_colour_space": {"severity": rgb_severity},
        "image_min_dpi_contone": {"severity": FAIL, "min_dpi": contone},
        "image_min_dpi_bitonal": {"severity": FAIL, "min_dpi": bitonal},
        "image_max_dpi": {"severity": WARN, "max_dpi": max_dpi},
        "hairlines_absent": {"severity": WARN, "threshold_pt": hairline},
    }
    if transparency == "pass":
        checks["live_transparency"] = {"enabled": False}
    else:
        checks["live_transparency"] = {"severity": transparency}
    fixups = [
        {"id": "embed_missing_fonts", "params": {"sources": ["system"]}},
        {"id": "fix_hairlines", "params": {
            "threshold_pt": hairline, "replacement_pt": hairline,
            "include_annotations": True,
        }},
        {"id": "set_trim_box", "params": {"from_box": "crop"}},
        {"id": "grow_bleed_box", "params": {"bleed_pt": bleed}},
    ]
    if rgb_severity == FAIL:
        fixups.insert(1, {"id": "convert_to_cmyk", "params": {
            "render_intent": "relative", "dest_profile": "",
        }})
    if max_dpi:
        fixups.append({"id": "downsample_images", "params": {"dpi": max_dpi}})
    if transparency != "pass":
        # The flatten runs at the profile's OWN contone minimum, never at the
        # flattener's default: a region raster at 150 dpi under a 300 dpi
        # minimum clears one check by raising another.
        fixups.append({"id": "flatten_transparency", "params": {"dpi": contone}})
    return {
        "schema": SCHEMA,
        "id": pid,
        "name": name,
        "name_key": f"profile.preflight.{pid}",
        "description_key": f"profile.preflight.{pid}.desc",
        "checks": checks,
        "fixups": fixups,
    }


def _pdfx(*, pid: str, name: str, claim: str, version: str, gs_version: int,
          device_independent: bool, transparency_allowed: bool,
          optional_content_allowed: bool, forbid_jpx: bool) -> dict:
    """One PDF/X profile. What the standard requires, not what a press
    prefers: the intent, the claim, the trim box and the metadata are rules,
    which is why the box check is a `fail` here and a `warn` everywhere else."""
    checks: dict = {
        "pdf_version": {"severity": FAIL, "max_version": version},
        "output_intent": {
            "severity": FAIL, "required": True, "require_embedded_profile": True,
        },
        "pdfx_claim": {"severity": FAIL, "expected": claim},
        "trapped_declared": {"severity": WARN, "require_declared": True},
        "embedded_files": {"severity": FAIL, "allow": False},
        "trim_box": {"severity": FAIL},
        "bleed_sufficient": {"severity": WARN, "min_bleed_pt": 8.5},
        "ink_coverage_max": {"severity": FAIL, "max_tac_pct": 300.0},
        "spot_ink_count": {"enabled": False},
        "colour_family": {"severity": FAIL},
        "image_colour_space": {"severity": FAIL},
        "device_independent_colour": (
            {"enabled": False}
            if device_independent
            else {
                "severity": FAIL,
                "forbidden_families": ["ICCBased", "Lab", "CalRGB", "CalGray"],
            }
        ),
        "image_min_dpi_contone": {"severity": FAIL, "min_dpi": 300},
        "image_min_dpi_bitonal": {"severity": FAIL, "min_dpi": 1200},
        "image_compression": (
            {"severity": FAIL, "forbidden_filters": ["/JPXDecode"]}
            if forbid_jpx
            else {"enabled": False}
        ),
        "live_transparency": (
            {"enabled": False} if transparency_allowed else {"severity": FAIL}
        ),
        "optional_content": (
            {"enabled": False}
            if optional_content_allowed
            else {"severity": FAIL, "allow_optional_content": False}
        ),
        "printing_annotations": {"severity": FAIL, "printing_only": True},
        "interactive_form": {"severity": FAIL, "allow_forms": False},
        "document_javascript": {"severity": FAIL, "allow_js": False},
        "title_present": {"severity": FAIL, "require_title": True},
        "xmp_present": {"severity": FAIL, "require_xmp": True},
        "hairlines_absent": {"severity": WARN},
    }
    fixups = [
        {"id": "remove_javascript", "params": {}},
        {"id": "remove_attachments", "params": {}},
        {"id": "embed_missing_fonts", "params": {"sources": ["system"]}},
        {"id": "convert_to_cmyk", "params": {
            "render_intent": "relative", "dest_profile": "",
        }},
        {"id": "fix_hairlines", "params": {
            "threshold_pt": 0.25, "replacement_pt": 0.25,
            "include_annotations": True,
        }},
        {"id": "set_trim_box", "params": {"from_box": "crop"}},
        {"id": "write_xmp", "params": {}},
        {"id": "convert_to_pdfx", "params": {"version": gs_version}},
    ]
    if not transparency_allowed:
        fixups.insert(5, {"id": "flatten_transparency", "params": {"dpi": 300}})
    return {
        "schema": SCHEMA,
        "id": pid,
        "name": name,
        "name_key": f"profile.preflight.{pid}",
        "description_key": f"profile.preflight.{pid}.desc",
        "checks": checks,
        "fixups": fixups,
    }


#: Office print exists because "will this print on the machine down the hall"
#: is a real question with a different answer, and a profile set with no
#: non-press member would make the feature look like it is only for presses.
_OFFICE_PRINT = {
    "schema": SCHEMA,
    "id": "office_print",
    "name": "Office print",
    "name_key": "profile.preflight.office_print",
    "description_key": "profile.preflight.office_print.desc",
    "checks": {
        "pdf_version": {"enabled": False},
        "trim_box": {"enabled": False},
        "bleed_sufficient": {"enabled": False},
        "ink_coverage_max": {"enabled": False},
        "spot_ink_count": {"enabled": False},
        "colour_family": {"enabled": False},
        "image_colour_space": {"enabled": False},
        "overprint": {"enabled": False},
        "hairlines_absent": {"enabled": False},
        "small_text_k_only": {"enabled": False},
        "live_transparency": {"enabled": False},
        "image_min_dpi_contone": {"severity": WARN, "min_dpi": 150},
        "image_min_dpi_bitonal": {"severity": WARN, "min_dpi": 300},
        "image_max_dpi": {"enabled": False},
    },
    "fixups": [
        {"id": "embed_missing_fonts", "params": {"sources": ["system"]}},
    ],
}


SHIPPED_PROFILES: dict[str, dict] = {}
for _profile in (
    _press(
        pid="sheetfed_offset", name="Sheetfed offset (CMYK)", tac=300.0,
        contone=300, bitonal=1200, max_dpi=450, bleed=8.5, hairline=0.25,
        max_spots=2, spot_severity=WARN, rgb_severity=FAIL,
        transparency=WARN, version="1.7",
    ),
    _press(
        pid="web_offset_heatset", name="Web offset, heatset", tac=300.0,
        contone=250, bitonal=1000, max_dpi=400, bleed=8.5, hairline=0.30,
        max_spots=2, spot_severity=WARN, rgb_severity=FAIL,
        transparency=WARN, version="1.7",
    ),
    _press(
        pid="newsprint", name="Newsprint", tac=240.0,
        contone=200, bitonal=800, max_dpi=300, bleed=8.5, hairline=0.40,
        max_spots=1, spot_severity=WARN, rgb_severity=FAIL,
        transparency=WARN, version="1.7",
    ),
    _press(
        pid="digital_printing", name="Digital printing", tac=280.0,
        contone=200, bitonal=600, max_dpi=400, bleed=8.5, hairline=0.25,
        max_spots=0, spot_severity=FAIL, rgb_severity=WARN,
        transparency="pass", version="1.7",
    ),
    _press(
        pid="large_format", name="Large format", tac=300.0,
        contone=100, bitonal=300, max_dpi=200, bleed=36.0, hairline=0.50,
        max_spots=2, spot_severity=WARN, rgb_severity=WARN,
        transparency="pass", version="1.7",
    ),
    _pdfx(
        pid="pdfx_1a", name="PDF/X-1a:2001", claim="PDF/X-1a:2001",
        version="1.3", gs_version=1, device_independent=False,
        transparency_allowed=False, optional_content_allowed=False,
        forbid_jpx=True,
    ),
    _pdfx(
        pid="pdfx_3", name="PDF/X-3:2002", claim="PDF/X-3:2002",
        version="1.3", gs_version=3, device_independent=True,
        transparency_allowed=False, optional_content_allowed=False,
        forbid_jpx=True,
    ),
    _pdfx(
        pid="pdfx_4", name="PDF/X-4", claim="PDF/X-4",
        version="1.6", gs_version=4, device_independent=True,
        transparency_allowed=True, optional_content_allowed=True,
        forbid_jpx=False,
    ),
    _OFFICE_PRINT,
):
    SHIPPED_PROFILES[_profile["id"]] = validate_profile(
        _profile, allow_shipped_id=True
    )

#: Picker order: the general presses, then the standards, then the office one.
SHIPPED_PROFILE_IDS = tuple(SHIPPED_PROFILES)

#: The strictest profile that fails nothing a general document legitimately
#: does.
DEFAULT_PROFILE_ID = "sheetfed_offset"


def list_preflight_profiles() -> dict:
    """The shipped profiles, in picker order, for a surface that has to offer
    them without knowing how one is built."""
    return {
        "schema": SCHEMA,
        "default": DEFAULT_PROFILE_ID,
        "profiles": [SHIPPED_PROFILES[pid] for pid in SHIPPED_PROFILE_IDS],
        "checks": [{"id": cid, "category": cat} for cid, cat in CHECK_INVENTORY],
        "categories": list(CATEGORIES),
        "fixups": list(FIXUP_IDS),
    }
