"""The soft proof: plate coverage back through a press profile.

`separations.composite_separations` multiplies each ink's display colour
down. That is an ink preview and it is not colour management: 100 % of each
of Cyan, Magenta and Yellow multiplies to (0, 0, 0), where a press profile
puts the same overprint near (68, 68, 70). This module supplies the managed
alternative — the plate coverages become a CMYK accumulation buffer and one
LittleCMS transform takes that buffer to sRGB.

Four profile sources, in precedence order: the document's own
`/OutputIntents` `/DestOutputProfile`, a user-picked `.icc`, a bundled press
profile named by its ICC description string, and none. None is the multiply
model, byte for byte — and it is the only source that means "no proof". A
bundled press this engine cannot produce REFUSES BY NAME; it never resolves
to the same record as none.

Two switches, one intent and one flag. Simulating paper white is
ABSOLUTE_COLORIMETRIC — the media white point is held rather than mapped
onto the display's, so unpainted paper renders as the dim tone the profile
says it is. Simulating black ink CLEARS black-point compensation, so the
darkest ink the press can lay down arrives at its own value instead of at
display black. **Under absolute colorimetric the flag changes nothing on any
patch**: the intent already carries both endpoints of the medium, so there
is no black point left to compensate. A request for absolute WITH
compensation is therefore normalized to absolute without it, and the
returned record reports the normalized pair rather than the request.

Every refusal here is REPORTED rather than raised. A proof that cannot be
produced falls back to the multiply composite with the reason carried beside
it in the same return, so a request the engine did not honour can never look
honoured.

The separation device ignores the destination profile — plates are
byte-identical across profiles — so a page carrying colour that is not
already device CMYK must be colour-managed to the profile BEFORE it is
separated, or the ink amounts on the plates come from the conversion's own
default destination rather than from the press being proofed.
`staging_applies` is that test, and it reads the colour families the ink
inventory's own walk reached.
"""

from __future__ import annotations

import hashlib
import io
import tempfile
from dataclasses import dataclass
from pathlib import Path

import pikepdf

from . import icc_profiles
from .color_spaces import build_function

#: The plate names the separation device gives the process inks, in the
#: channel order of a CMYK buffer.
PROCESS_CHANNELS = ("Cyan", "Magenta", "Yellow", "Black")

#: Where a profile source may come from. `none` is the multiply model, and
#: `bundled` carries a press profile's ICC description string.
PROFILE_SOURCES = ("none", "document", "file", "bundled")

#: Colour families a page can carry and still be separated exactly as it
#: stands: the plates then ARE the document's own ink numbers.
_DEVICE_CMYK_FAMILIES = frozenset({"DeviceCMYK", "Separation", "DeviceN"})

#: Tint samples per spot colorant. A plate is 8-bit, so one entry per plate
#: value evaluates the tint transform at every tint the plate can carry.
TINT_STEPS = 256

_PROFILE_DIR_NAME = "simulation-profiles"

#: How far a colorant space nested in another's alternate is followed.
_MAX_ALTERNATE_DEPTH = 4


# ── the refusals ───────────────────────────────────────────────────────────
#
# Each is a raising function paired with a wrapper that returns the sentence.
# The raise is what the engine-message sweep enumerates, so the refusal and
# the report make one claim in one wording; the wrapper is what the soft
# proof actually calls, because a proof that cannot be produced falls back to
# the multiply composite with the reason stated rather than failing the call.


def refuse_unreadable_profile(detail: str) -> None:
    raise ValueError(
        f"that file is not a colour profile this engine can read: {detail}"
    )


def unreadable_profile_message(detail: str) -> str:
    try:
        refuse_unreadable_profile(detail)
    except ValueError as exc:
        return str(exc)
    return ""


def refuse_non_printing_profile(space: str) -> None:
    raise ValueError(f"that profile describes a {space} device, not a printing press")


def non_printing_profile_message(space: str) -> str:
    try:
        refuse_non_printing_profile(space)
    except ValueError as exc:
        return str(exc)
    return ""


def refuse_intent_without_profile(identifier: str) -> None:
    raise ValueError(
        f"this document's output intent names {identifier} but embeds no "
        "profile, so there is nothing to proof against"
    )


def intent_without_profile_message(identifier: str) -> str:
    try:
        refuse_intent_without_profile(identifier)
    except ValueError as exc:
        return str(exc)
    return ""


def refuse_undescribable_alternate(name: str, alternate: str) -> None:
    raise ValueError(
        f"the colorant {name} converts to {alternate}, which is not a space "
        "this proof can describe"
    )


def undescribable_alternate_message(name: str, alternate: str) -> str:
    try:
        refuse_undescribable_alternate(name, alternate)
    except ValueError as exc:
        return str(exc)
    return ""


def refuse_no_process_plate() -> None:
    raise ValueError(
        "no process plate is showing, so there is nothing for the press "
        "profile to describe"
    )


def no_process_plate_message() -> str:
    try:
        refuse_no_process_plate()
    except ValueError as exc:
        return str(exc)
    return ""


# ── the request and the record ─────────────────────────────────────────────


@dataclass(frozen=True)
class Request:
    """What the panel asked for."""

    source: str
    profile: str
    paper_white: bool
    black_ink: bool


@dataclass(frozen=True)
class Profile:
    """A resolved press profile, as a file every consumer can read.

    `path` is a real file because Ghostscript reads the profile for the
    staged separation; `digest` is the content hash, so two sources naming
    the same profile share one plate cache entry.
    """

    source: str
    name: str
    path: str
    digest: str


def read_request(raw) -> Request | None:
    """The panel's request, or None when nothing was asked for."""
    if not isinstance(raw, dict):
        return None
    source = str(raw.get("source") or "none")
    if source not in PROFILE_SOURCES:
        source = "none"
    return Request(
        source=source,
        profile=str(raw.get("profile") or ""),
        paper_white=bool(raw.get("paper_white")),
        black_ink=bool(raw.get("black_ink")),
    )


def normalized_pair(paper_white: bool, black_ink: bool) -> tuple[str, bool]:
    """The rendering intent and the black-point-compensation flag a request
    resolves to.

    Absolute colorimetric carries both endpoints of the medium, so
    compensation is a no-op under it on every patch. It is cleared rather
    than passed through, and the caller reports the cleared pair.
    """
    if paper_white:
        return "absolute", False
    return "relative", not black_ink


def empty_record() -> dict:
    """The record a composite returns when no proof was asked for."""
    return {
        "source": "none",
        "name": "",
        "intent": "",
        "black_point_compensation": False,
        "refusal": "",
        "assumed": [],
    }


def refused_record(refusal: str) -> dict:
    record = empty_record()
    record["refusal"] = refusal
    return record


# ── profiles on disk ───────────────────────────────────────────────────────


def profile_cache_dir() -> Path:
    root = Path(tempfile.gettempdir()) / "spectrapdf" / _PROFILE_DIR_NAME
    root.mkdir(parents=True, exist_ok=True)
    return root


def materialize(raw: bytes) -> Path:
    """A profile's bytes as a file, addressed by their own hash.

    Ghostscript reads the profile by path for the staged separation, and two
    sources carrying the same profile must land on one path so they share one
    plate cache entry.
    """
    digest = hashlib.sha256(raw).hexdigest()[:32]
    dest = profile_cache_dir() / f"{digest}.icc"
    if not dest.is_file() or dest.stat().st_size != len(raw):
        dest.write_bytes(raw)
    return dest


def describe_profile(raw: bytes) -> tuple[str, str, str]:
    """(description, colour space, refusal) for profile bytes."""
    from PIL import ImageCms

    try:
        handle = ImageCms.getOpenProfile(io.BytesIO(raw))
        description = ImageCms.getProfileDescription(handle).strip()
        space = str(handle.profile.xcolor_space).strip()
    except Exception as exc:  # noqa: BLE001 - any read failure is one refusal
        return "", "", unreadable_profile_message(str(exc))
    return description, space, ""


def bundled_presses(icc_dir: str = "") -> list:
    """Every bundled press profile, by ICC description string.

    The list IS the picker's content: a proof names the press it proofed
    against, so the set has to be offerable by name rather than reduced to one
    anonymous "bundled" entry.
    """
    return sorted(icc_profiles.cmyk_profiles(icc_dir), key=lambda p: p.description)


def bundled_profile(name: str = "", icc_dir: str = "") -> tuple[bytes, str, str]:
    """(bytes, description, refusal) for a bundled press profile.

    `name` is a profile's ICC description string; empty takes the default
    press. **A missing or unreadable profile is a REFUSAL, never empty bytes
    with an empty name.** This used to swallow every failure and return
    `(b"", "")`, which the caller could only read as "no bundled press
    exists" — so a broken resource tree and a deliberate no-proof request
    arrived at the panel looking identical, and the proof silently became the
    multiply model.
    """
    try:
        profile = icc_profiles.resolve(name, icc_dir)
        raw = Path(profile.path).read_bytes()
    except (ValueError, RuntimeError) as exc:
        return b"", "", str(exc)
    except OSError as exc:
        return b"", "", unreadable_profile_message(str(exc))
    description, _space, refusal = describe_profile(raw)
    if refusal:
        return b"", "", refusal
    return raw, description or profile.description, ""


def read_output_intent(file: str) -> dict:
    """The document's own output intent, as the proof needs it.

    `embedded` is the bytes of `/DestOutputProfile`. An intent that names a
    registered characterization by identifier alone embeds nothing, and that
    is a different answer from having no intent at all: the first names a
    press this engine holds no profile for, the second names no press.
    """
    present = False
    identifier = ""
    raw = b""
    try:
        with pikepdf.open(file) as pdf:
            intents = pdf.Root.get("/OutputIntents")
            if intents is not None:
                for intent in intents:
                    present = True
                    if not identifier:
                        value = intent.get("/OutputConditionIdentifier")
                        identifier = str(value) if value is not None else ""
                    stream = intent.get("/DestOutputProfile")
                    if stream is not None and not raw:
                        raw = bytes(stream.read_bytes())
                        value = intent.get("/OutputConditionIdentifier")
                        identifier = str(value) if value is not None else identifier
    except Exception:  # noqa: BLE001 - an unreadable intent offers no profile
        return {"present": present, "identifier": identifier, "embedded": b""}
    return {"present": present, "identifier": identifier, "embedded": raw}


def resolve_profile(
    request: Request | None,
    *,
    intent: dict | None = None,
    icc_dir: str = "",
) -> tuple[Profile | None, str]:
    """(the profile to proof through, the refusal). Both empty means none."""
    if request is None or request.source == "none":
        return None, ""

    if request.source == "document":
        found = intent if intent is not None else {}
        raw = bytes(found.get("embedded") or b"")
        if not raw:
            return None, intent_without_profile_message(str(found.get("identifier") or ""))
    elif request.source == "file":
        path = Path(request.profile)
        try:
            raw = path.read_bytes()
        except OSError as exc:
            return None, unreadable_profile_message(str(exc))
    else:
        raw, _description, refusal = bundled_profile(request.profile, icc_dir)
        if refusal:
            return None, refusal

    description, space, refusal = describe_profile(raw)
    if refusal:
        return None, refusal
    if space != "CMYK":
        return None, non_printing_profile_message(space or "colourless")

    stored = materialize(raw)
    return (
        Profile(
            source=request.source,
            name=description or stored.name,
            path=str(stored),
            digest=hashlib.sha256(raw).hexdigest()[:32],
        ),
        "",
    )


# ── the transform ──────────────────────────────────────────────────────────


def build_transform(profile_path: str, intent_name: str, bpc: bool):
    """(transform, refusal) for a CMYK buffer to sRGB."""
    from PIL import ImageCms

    intents = {
        "relative": ImageCms.Intent.RELATIVE_COLORIMETRIC,
        "absolute": ImageCms.Intent.ABSOLUTE_COLORIMETRIC,
    }
    intent = intents[intent_name]
    flags = ImageCms.Flags.BLACKPOINTCOMPENSATION if bpc else ImageCms.Flags.NONE
    try:
        handle = ImageCms.getOpenProfile(profile_path)
        if not handle.profile.is_intent_supported(intent, 0):
            return None, unreadable_profile_message(
                f"it carries no {intent_name} colorimetric table"
            )
        return (
            ImageCms.buildTransform(
                handle,
                ImageCms.createProfile("sRGB"),
                "CMYK",
                "RGB",
                renderingIntent=intent,
                flags=flags,
            ),
            "",
        )
    except Exception as exc:  # noqa: BLE001 - any build failure is one refusal
        return None, unreadable_profile_message(str(exc))


def to_srgb(buffer, transform):
    """A CMYK buffer in 0…1 as sRGB in 0…1, through one transform."""
    import numpy as np
    from PIL import Image, ImageCms

    source = Image.fromarray(
        np.clip(buffer * 255.0 + 0.5, 0.0, 255.0).astype(np.uint8), mode="CMYK"
    )
    return np.asarray(ImageCms.applyTransform(source, transform)).astype(np.float32) / 255.0


# ── spot colorants ─────────────────────────────────────────────────────────


def _alternate_components(cs) -> tuple[str, int]:
    """The alternate space's family label and component count."""
    try:
        alt = cs[2]
    except Exception:  # noqa: BLE001 - a malformed space describes nothing
        return "", 0
    if isinstance(alt, pikepdf.Array) and len(alt) > 0:
        family = str(alt[0]).lstrip("/")
        if family == "ICCBased":
            try:
                return family, int(alt[1].get("/N"))
            except Exception:  # noqa: BLE001
                return family, 0
        if family in ("CalRGB", "Lab"):
            return family, 3
        if family == "CalGray":
            return family, 1
        return family, {"DeviceCMYK": 4, "DeviceRGB": 3, "DeviceGray": 1}.get(family, 0)
    family = str(alt).lstrip("/")
    return family, {"DeviceCMYK": 4, "DeviceRGB": 3, "DeviceGray": 1}.get(family, 0)


def _alternate_icc(cs) -> bytes:
    """An ICCBased alternate's own profile bytes, when it has readable ones."""
    try:
        alt = cs[2]
        if isinstance(alt, pikepdf.Array) and str(alt[0]).lstrip("/") == "ICCBased":
            return bytes(alt[1].read_bytes())
    except Exception:  # noqa: BLE001
        return b""
    return b""


def _tint_lut(fn, count: int) -> list[list[float]] | None:
    """The tint transform sampled at every tint an 8-bit plate can carry."""
    if fn is None or count <= 0:
        return None
    out: list[list[float]] = []
    for step in range(TINT_STEPS):
        try:
            value = fn([step / (TINT_STEPS - 1)])
        except Exception:  # noqa: BLE001 - an unevaluable transform describes nothing
            return None
        if value is None or len(value) < count:
            return None
        out.append([float(v) for v in value[:count]])
    return out


def _separation_entry(cs) -> dict | None:
    family, count = _alternate_components(cs)
    if not family:
        return None
    try:
        fn = build_function(cs[3])
    except Exception:  # noqa: BLE001
        fn = None
    lut = _tint_lut(fn, count)
    entry = {"family": family, "components": count, "lut": lut}
    icc = _alternate_icc(cs)
    if icc:
        entry["icc"] = hashlib.sha256(icc).hexdigest()[:32]
        materialize(icc)
    return entry


def _devicen_entry(cs, index: int, total: int) -> dict | None:
    """One DeviceN component evaluated as its own colorant.

    `/Attributes /Colorants` names each component's own Separation space when
    the document supplies one; without it the component is evaluated through
    the DeviceN tint transform alone, at full tint with every sibling at zero.
    """
    try:
        attrs = cs[4] if len(cs) >= 5 else None
        colorants = attrs.get("/Colorants") if attrs is not None else None
    except Exception:  # noqa: BLE001
        colorants = None
    if colorants is not None:
        try:
            own = colorants.get(pikepdf.Name("/" + str(cs[1][index]).lstrip("/")))
        except Exception:  # noqa: BLE001
            own = None
        if own is not None:
            entry = _separation_entry(own)
            if entry is not None and entry["lut"] is not None:
                return entry

    family, count = _alternate_components(cs)
    if not family:
        return None
    try:
        fn = build_function(cs[3])
    except Exception:  # noqa: BLE001
        fn = None
    if fn is None or count <= 0:
        return {"family": family, "components": count, "lut": None}
    out: list[list[float]] = []
    for step in range(TINT_STEPS):
        comps = [0.0] * total
        comps[index] = step / (TINT_STEPS - 1)
        try:
            value = fn(comps)
        except Exception:  # noqa: BLE001
            return {"family": family, "components": count, "lut": None}
        if value is None or len(value) < count:
            return {"family": family, "components": count, "lut": None}
        out.append([float(v) for v in value[:count]])
    entry = {"family": family, "components": count, "lut": out}
    icc = _alternate_icc(cs)
    if icc:
        entry["icc"] = hashlib.sha256(icc).hexdigest()[:32]
        materialize(icc)
    return entry


def page_alternates(file: str, page: int) -> dict:
    """Each colorant on one page as the space the DOCUMENT says it approximates.

    A `/Separation` colorant has no ICC description of its own: what the
    document supplies is a tint transform into an alternate space, and that
    is what the document itself declares the spot approximates. The proof
    reads it here, once per plate set, because it is a property of the
    document rather than of the profile.
    """
    from .preflight import walk_page_resources

    found: dict[str, dict] = {}

    def record(name: str, entry: dict | None) -> None:
        if entry is None:
            return
        prior = found.get(name)
        if prior is None or (prior.get("lut") is None and entry.get("lut") is not None):
            found[name] = entry

    def on_colorspace(cs, _category, depth: int = 0) -> None:
        if not isinstance(cs, pikepdf.Array) or len(cs) < 4:
            return
        family = str(cs[0]).lstrip("/")
        if family == "Separation":
            record(str(cs[1]).lstrip("/"), _separation_entry(cs))
        elif family == "DeviceN":
            try:
                names = [str(n).lstrip("/") for n in cs[1]]
            except Exception:  # noqa: BLE001
                return
            for index, name in enumerate(names):
                record(name, _devicen_entry(cs, index, len(names)))
        else:
            return
        if depth < _MAX_ALTERNATE_DEPTH:
            try:
                alternate = cs[2]
            except Exception:  # noqa: BLE001
                return
            if isinstance(alternate, pikepdf.Array):
                on_colorspace(alternate, _category, depth + 1)

    try:
        with pikepdf.open(file) as pdf:
            if 1 <= page <= len(pdf.pages):
                walk_page_resources(pdf.pages[page - 1], on_colorspace=on_colorspace)
    except Exception:  # noqa: BLE001 - an unreadable page describes no colorant
        return found
    return found


#: The mode a one-channel device space is read through. There is no bundled
#: grey profile and PIL builds none, so a DeviceGray tint is proofed as the
#: sRGB colour with all three components equal — the assumption a viewer
#: without a CMM makes, and it is NAMED back to the caller like every other
#: assumption here rather than taken silently.
_GRAY_AS_RGB = "GRAY"
_GRAY_ASSUMPTION = "sRGB grey"


def _source_profile(entry: dict):
    """(profile handle, PIL mode, what was assumed, refusal) for one alternate.

    A device space carries no ICC description, so a proof of it has to assume
    one. The assumption is named back to the caller rather than taken
    silently.
    """
    from PIL import ImageCms

    modes = {1: "L", 3: "RGB", 4: "CMYK"}
    family = str(entry.get("family") or "")
    icc = str(entry.get("icc") or "")
    mode = modes.get(int(entry.get("components") or 0))
    if icc and mode is not None:
        path = profile_cache_dir() / f"{icc}.icc"
        if path.is_file():
            try:
                return ImageCms.getOpenProfile(str(path)), mode, "", ""
            except Exception:  # noqa: BLE001 - fall through to the device assumption
                pass
    if family == "ICCBased":
        # An embedded profile that will not open still describes how many
        # components the space has, and the device space of that width is
        # the assumption a viewer without a CMM makes.
        family = {"L": "DeviceGray", "RGB": "DeviceRGB", "CMYK": "DeviceCMYK"}.get(mode or "", "")
    if family in ("DeviceRGB", "CalRGB"):
        return ImageCms.createProfile("sRGB"), "RGB", "sRGB", ""
    if family in ("DeviceGray", "CalGray"):
        return ImageCms.createProfile("sRGB"), _GRAY_AS_RGB, _GRAY_ASSUMPTION, ""
    if family == "Lab":
        return ImageCms.createProfile("LAB"), "LAB", "", ""
    if family == "DeviceCMYK":
        return None, "CMYK", "", ""
    return None, "", "", ""


def _lut_to_cmyk(entry: dict, profile_path: str):
    """(a 256×4 CMYK table, what was assumed, refusal) for one colorant."""
    import numpy as np
    from PIL import Image, ImageCms

    lut = entry.get("lut")
    if lut is None:
        return None, "", ""
    table = np.clip(np.asarray(lut, dtype=np.float32), 0.0, 1.0)
    family = str(entry.get("family") or "")
    if family == "DeviceCMYK" or (family == "ICCBased" and table.shape[1] == 4
                                  and not entry.get("icc")):
        return table, "", ""

    handle, mode, assumed, refusal = _source_profile(entry)
    if refusal:
        return None, "", refusal
    if handle is None or not mode:
        if mode == "CMYK":
            return table, "", ""
        return None, "", ""

    if mode == "LAB":
        # PIL's 8-bit LAB encoding: L over 0…255 for 0…100, and a/b offset by
        # 128. A PDF /Lab component arrives in its own range already.
        raw = np.empty((TINT_STEPS, 3), dtype=np.float32)
        raw[:, 0] = np.clip(table[:, 0] * 255.0 / 100.0, 0.0, 255.0)
        raw[:, 1] = np.clip(table[:, 1] + 128.0, 0.0, 255.0)
        raw[:, 2] = np.clip(table[:, 2] + 128.0, 0.0, 255.0)
        source = Image.fromarray(raw.astype(np.uint8).reshape(1, TINT_STEPS, 3), mode="LAB")
    elif mode == _GRAY_AS_RGB:
        # One channel replicated across three: the transform is built for RGB
        # because that is the profile the grey is being read through.
        grey = (table[:, 0] * 255.0 + 0.5).astype(np.uint8)
        source = Image.fromarray(
            np.repeat(grey, 3).reshape(1, TINT_STEPS, 3), mode="RGB")
    elif mode == "L":
        # A one-component space carrying its OWN embedded profile: read
        # through that profile, not through the sRGB-grey assumption.
        source = Image.fromarray(
            (table[:, 0] * 255.0 + 0.5).astype(np.uint8).reshape(1, TINT_STEPS), mode="L"
        )
    else:
        channels = {"RGB": 3, "CMYK": 4}[mode]
        source = Image.fromarray(
            (table[:, :channels] * 255.0 + 0.5).astype(np.uint8).reshape(1, TINT_STEPS, channels),
            mode=mode,
        )
    try:
        transform = ImageCms.buildTransform(
            handle,
            ImageCms.getOpenProfile(profile_path),
            "RGB" if mode == _GRAY_AS_RGB else mode,
            "CMYK",
            renderingIntent=ImageCms.Intent.RELATIVE_COLORIMETRIC,
        )
        converted = np.asarray(ImageCms.applyTransform(source, transform))
    except Exception as exc:  # noqa: BLE001
        return None, "", unreadable_profile_message(str(exc))
    return converted.reshape(TINT_STEPS, 4).astype(np.float32) / 255.0, assumed, ""


def spot_tables(names, alternates: dict, profile_path: str):
    """(name → 256×4 CMYK table, what was assumed, the refusal).

    A colorant whose alternate is itself a `/Separation` or `/DeviceN` — or
    one the document describes no reachable transform for — is refused by
    name: there is no space the proof could describe it in, and rendering it
    through the multiply model beside managed inks would put two colour
    models in one image.
    """
    tables: dict = {}
    assumed: list[str] = []
    for name in names:
        entry = alternates.get(name)
        if entry is None:
            return {}, [], undescribable_alternate_message(name, "an unreadable space")
        family = str(entry.get("family") or "")
        if family in ("Separation", "DeviceN"):
            return {}, [], undescribable_alternate_message(name, family)
        table, assumption, refusal = _lut_to_cmyk(entry, profile_path)
        if refusal:
            return {}, [], refusal
        if table is None:
            # A family the transform never produced values for is not a
            # family this can name: it is a space that would not read.
            label = family if entry.get("lut") is not None and family else "an unreadable space"
            return {}, [], undescribable_alternate_message(name, label)
        tables[name] = table
        if assumption and assumption not in assumed:
            assumed.append(assumption)
    return tables, assumed, ""


# ── the staged separation ──────────────────────────────────────────────────


def staging_applies(families) -> bool:
    """Does this page need colour-managing before it is separated?

    The separation device ignores the destination profile, so a page already
    made of device CMYK, spot and DeviceN colour separates to the document's
    own ink numbers whatever profile is chosen — and staging it would put a
    Ghostscript rewrite between the document and its own plates for nothing.
    Anything else on the page reached the plates through Ghostscript's
    compiled-in default CMYK, which is not the press being proofed.
    """
    return any(str(f) not in _DEVICE_CMYK_FAMILIES for f in (families or ()))
