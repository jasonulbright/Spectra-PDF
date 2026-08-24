"""The bundled ICC colour profiles, and the one place a profile is named.

The profiles ship as files in a resource directory (``resources/icc``, reached
as ``icc_dir`` the way ``font_dir`` and ``dictionary_dir`` travel). Three
consumers share them: the destination profile a CMYK conversion converts to,
the ``/DestOutputProfile`` a PDF/X output intent embeds, and the press profile
the output preview soft-proofs against.

**A bundled profile is named by its ICC description string and by nothing
else.** The distribution agreement the profiles ship under requires every
individual profile to be referenced by that string, so the file name on disk
is not a name — nothing here or above keys off it, and a directory is read by
opening each profile and asking it what it is called.

**The default destination is a SPECIFIC print characterization, and its
numbers are not the numbers a generic CMYK space produces.** Every profile in
the set describes one real press condition; there is no generic exchange space
among them, so whichever one is the default, a conversion that names no
profile lands on a named press rather than on an unnamed average. The default
is ``U.S. Web Coated (SWOP) v2`` because it is the profile most widely used as
an application default for commercial web offset work, so a document converted
without a choice lands where the largest number of print buyers already expect
it to. The choice is REPORTED, never silent: every conversion returns the
description string of the profile it used, the whole set is offered by name,
and a caller with a different press names it or supplies its own ``.icc``.

Profile identity for a PDF/X output intent is read off the profile too. ISO
32000-2 Table 401 lets ``/OutputConditionIdentifier`` name a production
condition kept in an industry registry, and requires ``/Info`` and
``/DestOutputProfile`` when it does not; ``/RegistryName`` names the registry
the identifier is defined in. So a profile that DECLARES its characterization
in its own ``targ`` tag is identified by what it declares, with the registry
named; a profile that declares none is identified by its description string
with no registry claimed. Neither case invents a registry name the profile
does not carry, and the profile is always embedded, so the entries the
standard conditions on a registered identifier are present either way.
"""

from __future__ import annotations

import os
import struct
from dataclasses import dataclass
from pathlib import Path

#: The launching binary's answer to "has the bundled profiles' licence been
#: accepted on this machine?", as an environment value. `1` is accepted;
#: anything else recorded is not.
#:
#: The engine is TOLD rather than left to look. The two shipped containers keep
#: the record in different places — the installer writes one beside the
#: executable, a portable copy writes its own under its data root — and the
#: binary that spawns this process is the one authority on which container it
#: is. A second resolver here would be a second answer.
#:
#: **An ABSENT variable means no shipped container launched this engine**: a
#: source-tree run, a pytest, a developer driving `__startup__.py` by hand.
#: Those read the profiles as they always have. Both shipped containers always
#: set it, so absence is unreachable in the product.
ASSENT_ENV = "SPECTRAPDF_ICC_ASSENT"

#: The destination profile a conversion resolves to when the caller names
#: none. See the module docstring for why this one.
DEFAULT_CMYK_DESCRIPTION = "U.S. Web Coated (SWOP) v2"

#: The registry ``/RegistryName`` names when a profile declares its own
#: characterization. The declaration is what earns the entry; a profile that
#: declares nothing gets no registry claim.
CHARACTERIZATION_REGISTRY = "http://www.color.org"

#: The CGATS data-format keyword a characterizationTarget tag opens with. It
#: marks the data, it is not part of the condition's name.
_TARGET_KEYWORD = "ICCHDAT"

#: ICC.1 clause 7.2 fixed header offsets: the profile/device class at 12, the
#: data colour space at 16, the 'acsp' file signature at 36, the tag count at
#: 128. Four-byte signatures at fixed positions, so reading them costs no
#: dependency.
_ICC_CLASS = slice(12, 16)
_ICC_SPACE = slice(16, 20)
_ICC_SIGNATURE = slice(36, 40)
ICC_HEADER_BYTES = 128

#: Profile classes that can describe an OUTPUT condition. A device link
#: ('link') carries a baked-in input space, an abstract profile ('abst')
#: transforms within one space and a named-colour profile ('nmcl') holds a
#: swatch list — none of the three names a destination a conversion can
#: target, whatever their data colour space says.
OUTPUT_CLASSES = frozenset({"prtr", "mntr", "scnr", "spac"})


# ── the refusals ───────────────────────────────────────────────────────────


def refuse_unknown_profile(name: str) -> None:
    raise ValueError(
        f'No colour profile named "{name}" is installed, and it is not a '
        "profile file this engine can open."
    )


def refuse_unaccepted_profiles() -> None:
    raise RuntimeError(
        "The bundled colour profiles are licensed separately and that licence "
        "has not been accepted on this computer, so no bundled profile can be "
        "opened. Accept the colour-profile licence to enable colour "
        "conversion, output intents and output preview, or name your own "
        "profile file instead."
    )


def refuse_no_profiles(directory: str) -> None:
    raise RuntimeError(
        f"No colour profiles are installed in {directory}, so there is no "
        "destination profile to convert to."
    )


# ── reading a profile ──────────────────────────────────────────────────────


@dataclass(frozen=True)
class BundledProfile:
    """One profile on disk, as every consumer needs it."""

    #: The ICC description string. The profile's only name.
    description: str
    path: str
    #: The four-character profile class and data colour space, verbatim.
    profile_class: str
    space: str
    #: The characterizationTarget the profile declares, empty when it declares
    #: none. Never guessed from the description.
    condition: str
    #: The profile's own `cprt` tag. It travels because the bytes are
    #: unmodified, and the bundling terms require it to.
    copyright: str


def header(data: bytes) -> tuple[str, str] | None:
    """(profile class, data colour space) or None when this is not a profile."""
    if len(data) < ICC_HEADER_BYTES or data[_ICC_SIGNATURE] != b"acsp":
        return None
    return (
        data[_ICC_CLASS].decode("latin-1", "replace").strip(),
        data[_ICC_SPACE].decode("latin-1", "replace").strip(),
    )


def _tags(data: bytes) -> dict:
    """signature → (offset, size) for every tag in the profile's tag table."""
    if len(data) < 132:
        return {}
    count = struct.unpack(">I", data[128:132])[0]
    # A corrupt count would index past the buffer; the table's own extent is
    # the bound, so an unreadable table yields no tags rather than an error.
    if count > (len(data) - 132) // 12:
        return {}
    found = {}
    for index in range(count):
        at = 132 + index * 12
        sig, offset, size = struct.unpack(">4sII", data[at:at + 12])
        if offset + size <= len(data):
            found[sig.decode("latin-1")] = (offset, size)
    return found


def _text_tag(data: bytes, entry) -> str:
    """The text of a `text`- or `desc`-typed tag, whichever it turns out to be.

    ICC v2 spells a description as textDescriptionType (an ASCII count then
    the string) and v4 as multiLocalizedUnicodeType; a plain textType carries
    the string straight after the type header. All three appear across the
    bundled set, so the type signature decides rather than the tag name.
    """
    offset, size = entry
    body = data[offset:offset + size]
    if len(body) < 8:
        return ""
    kind = body[0:4]
    if kind == b"text":
        return body[8:].split(b"\x00")[0].decode("latin-1", "replace").strip()
    if kind == b"desc":
        if len(body) < 12:
            return ""
        count = struct.unpack(">I", body[8:12])[0]
        return body[12:12 + count].split(b"\x00")[0].decode("latin-1", "replace").strip()
    if kind == b"mluc":
        if len(body) < 28:
            return ""
        records, size_of = struct.unpack(">II", body[8:16])
        if records < 1 or size_of < 12:
            return ""
        length, at = struct.unpack(">II", body[20:28])
        if at + length > len(body):
            return ""
        return body[at:at + length].decode("utf-16-be", "replace").strip("\x00").strip()
    return ""


def describe(data: bytes) -> tuple[str, str, str]:
    """(description, declared characterization, copyright) for profile bytes."""
    tags = _tags(data)
    description = _text_tag(data, tags["desc"]) if "desc" in tags else ""
    declared = _text_tag(data, tags["targ"]) if "targ" in tags else ""
    notice = _text_tag(data, tags["cprt"]) if "cprt" in tags else ""
    if declared.startswith(_TARGET_KEYWORD):
        declared = declared[len(_TARGET_KEYWORD):].strip()
    return description, declared, notice


def read_profile(path: Path) -> BundledProfile | None:
    """One profile file, or None when the file is not an ICC profile."""
    try:
        data = path.read_bytes()
    except OSError:
        return None
    found = header(data)
    if found is None:
        return None
    profile_class, space = found
    description, condition, notice = describe(data)
    if not description:
        return None
    return BundledProfile(
        description=description,
        path=str(path),
        profile_class=profile_class,
        space=space,
        condition=condition,
        copyright=notice,
    )


# ── the installed set ──────────────────────────────────────────────────────


def profile_dir(icc_dir: str = "") -> Path:
    """The directory the bundled profiles live in.

    A caller that knows the path passes it — the renderer and the CLI both
    resolve the resource tree themselves, exactly as they do for the fallback
    fonts and the spelling dictionaries. Without one, the two layouts this
    engine ever runs in are tried: beside the engine package in the installed
    resource tree, and under `resources/` in the source tree. Finding the real
    directory is not a degradation; a missing one refuses by name below.
    """
    if str(icc_dir).strip():
        return Path(str(icc_dir).strip())
    here = Path(__file__).resolve()
    for candidate in (here.parent.parent / "icc", here.parents[2] / "resources" / "icc"):
        if candidate.is_dir():
            return candidate
    return here.parent.parent / "icc"


def assent_recorded() -> bool:
    """Whether the bundled profiles' licence has been accepted. See `ASSENT_ENV`."""
    value = os.environ.get(ASSENT_ENV)
    if value is None:
        return True
    return value.strip() == "1"


_CACHE: dict = {}


def installed(icc_dir: str = "") -> dict:
    """description string → BundledProfile, for every profile installed.

    Cached per directory against its own listing, so a rebundled resource tree
    is picked up without a restart while a composite that asks per page does
    not re-read eight megabytes each time.

    The assent gate is the FIRST thing here, ahead of the listing and ahead of
    the cache, because this is the one door every bundled profile is read
    through — the destination of a conversion, a PDF/X `/DestOutputProfile`,
    and the press an output preview proofs against all arrive at it. Without
    acceptance the directory is not listed and no profile file is opened.
    """
    if not assent_recorded():
        refuse_unaccepted_profiles()
    directory = profile_dir(icc_dir)
    try:
        entries = sorted(
            (p, p.stat().st_size, int(p.stat().st_mtime_ns))
            for p in directory.glob("*.icc")
        )
    except OSError:
        entries = []
    stamp = tuple((str(p), size, mtime) for p, size, mtime in entries)
    cached = _CACHE.get(str(directory))
    if cached is not None and cached[0] == stamp:
        return cached[1]
    found = {}
    for path, _size, _mtime in entries:
        profile = read_profile(path)
        if profile is not None:
            found[profile.description] = profile
    _CACHE[str(directory)] = (stamp, found)
    return found


def cmyk_profiles(icc_dir: str = "") -> list:
    """Every installed profile that can be a CMYK destination, by description."""
    return [
        p for p in installed(icc_dir).values()
        if p.space == "CMYK" and p.profile_class in OUTPUT_CLASSES
    ]


def default_cmyk(icc_dir: str = ""):
    """The destination profile a caller who named none gets.

    The named default when it is installed; otherwise the first CMYK profile
    that is, so a resource tree built from a different manifest still converts
    to a profile it can name rather than to an unnamed space. No profiles at
    all is a refusal, never a silent fall-through to the producer's own idea
    of CMYK.
    """
    found = installed(icc_dir)
    chosen = found.get(DEFAULT_CMYK_DESCRIPTION)
    if chosen is not None and chosen.space == "CMYK":
        return chosen
    remaining = sorted(cmyk_profiles(icc_dir), key=lambda p: p.description)
    if not remaining:
        refuse_no_profiles(str(profile_dir(icc_dir)))
    return remaining[0]


def resolve(name: str, icc_dir: str = ""):
    """A profile named by its ICC description string, or a user's own file.

    Empty resolves to the default destination. A name that is neither an
    installed description string nor a readable profile file is refused by
    name — there is no third meaning it could silently take.

    **A profile the user supplies is theirs, and the bundling licence has
    nothing to say about it.** So without acceptance the file branch still
    resolves and only the bundled set is closed; the caller keeps a way to
    convert, which is what separates a named-disabled capability from a
    crippled one.
    """
    wanted = str(name).strip()
    if not wanted:
        return default_cmyk(icc_dir)
    if assent_recorded():
        found = installed(icc_dir).get(wanted)
        if found is not None:
            return found
    path = Path(wanted)
    if path.is_file():
        profile = read_profile(path)
        if profile is None:
            refuse_unknown_profile(wanted)
        return profile
    if not assent_recorded():
        refuse_unaccepted_profiles()
    refuse_unknown_profile(wanted)


# ── what a PDF/X output intent says about a profile ────────────────────────


def output_condition(profile) -> tuple[str, str, str]:
    """(identifier, human-readable condition, registry) for an output intent.

    The identifier is the characterization the profile DECLARES when it
    declares one, and its description string otherwise. The registry is named
    only in the first case: `/RegistryName` says where the identifier is
    defined, and a profile that declares no characterization defines it
    nowhere. See the module docstring for the clause this reads.
    """
    if profile is None:
        return "", "", ""
    if profile.condition:
        return profile.condition, profile.description, CHARACTERIZATION_REGISTRY
    return profile.description, profile.description, ""
