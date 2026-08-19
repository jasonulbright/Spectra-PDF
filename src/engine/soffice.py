"""Run bundled LibreOffice conversions in either direction.

Every run uses an isolated profile that blocks untrusted remote references,
link refreshes, and unsigned macros. Inputs and outputs are validated because
LibreOffice may return zero for an invalid conversion. Timeouts scale with
input size, and profiles are never shared between concurrent conversions.
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import tempfile
import unicodedata
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

import pikepdf

from engine import budget
from engine.system_fonts import installed_families

# Allow for LibreOffice's cold profile build and a bridged second launch.
_BASE_SECONDS = 240.0
_PER_MB_SECONDS = 12.0


def _xcu_item(path: str, prop: str, typ: str, value: str) -> str:
    return (
        f'<item oor:path="{path}"><prop oor:name="{prop}" oor:op="fuse">'
        f'<value xsi:type="xs:{typ}">{value}</value></prop></item>\n'
    )


_SCRIPTING = "/org.openoffice.Office.Common/Security/Scripting"
_INET = "/org.openoffice.Inet/Settings"

# Keep document conversion offline and disable active content.
PROFILE_SETTINGS = (
    # Block remote resources referenced by untrusted documents.
    _xcu_item(_SCRIPTING, "BlockUntrustedRefererLinks", "boolean", "true")
    # Disable the separate link-refresh path.
    + _xcu_item(_SCRIPTING, "LinkUpdateMode", "int", "0")
    # 3 = Very High: unsigned macros never run.
    + _xcu_item(_SCRIPTING, "MacroSecurityLevel", "int", "3")
    # Use a proxy that cannot answer as a secondary outbound-request guard.
    + _xcu_item(_INET, "ooInetProxyType", "int", "1")
    + _xcu_item(_INET, "ooInetHTTPProxyName", "string", "127.0.0.1")
    + _xcu_item(_INET, "ooInetHTTPProxyPort", "int", "9")
    + _xcu_item(_INET, "ooInetHTTPSProxyName", "string", "127.0.0.1")
    + _xcu_item(_INET, "ooInetHTTPSProxyPort", "int", "9")
    + _xcu_item(_INET, "ooInetNoProxy", "string", "")
)

_XCU = (
    '<?xml version="1.0" encoding="UTF-8"?>\n'
    '<oor:items xmlns:oor="http://openoffice.org/2001/registry" '
    'xmlns:xs="http://www.w3.org/2001/XMLSchema" '
    'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">\n'
    f"{PROFILE_SETTINGS}"
    "</oor:items>\n"
)


def seed_profile(profile: Path) -> Path:
    """Write the offline/macro settings into a fresh user profile directory."""
    user = Path(profile) / "user"
    user.mkdir(parents=True, exist_ok=True)
    (user / "registrymodifications.xcu").write_text(_XCU, encoding="utf-8")
    return profile


def _kill_tree(pid: int) -> None:
    """Kill a process and its children. soffice.exe launches soffice.bin as a
    child, so a bare kill of the tracked pid leaves the worker running and its
    profile dir locked — taskkill /T terminates the whole tree (Windows-only,
    which this app is). Best-effort: a race where it already exited is fine."""
    try:
        subprocess.run(
            ["taskkill", "/F", "/T", "/PID", str(pid)],
            capture_output=True,
            stdin=subprocess.DEVNULL,
            timeout=15,
        )
    except (OSError, subprocess.SubprocessError):
        pass


def run_convert(
    soffice_path: str,
    convert_to: str,
    src: Path,
    out_dir: Path,
    want_ext: str,
) -> Path:
    """One `soffice --headless --convert-to` pass. Returns the produced file.

    LibreOffice names the output after the INPUT's stem with the filter's
    extension, into ``out_dir`` — it ignores any name we might want, so the
    caller renames the result to the user's chosen path.

    ``want_ext`` (".pdf", ".rtf", …) disambiguates the bridge case: an HTML
    intermediate and the new file share a stem in the same directory, so a
    stem-only match could grab the intermediate. Match on the expected
    extension and exclude the source file.
    """
    src = Path(src)
    out_dir = Path(out_dir)
    size = 0
    try:
        size = src.stat().st_size
    except OSError:
        pass
    allowed = budget.derive(base=_BASE_SECONDS, size_bytes=size, per_mb=_PER_MB_SECONDS)

    profile = Path(tempfile.mkdtemp(prefix="lo-profile-"))
    try:
        seed_profile(profile)
        cmd = [
            soffice_path,
            # Isolate the user profile so a running GUI instance can't block us,
            # so concurrent conversions don't collide, and so the offline seed
            # above is the one this run reads.
            f"-env:UserInstallation={profile.as_uri()}",
            "--headless",
            "--norestore",
            "--convert-to",
            convert_to,
            "--outdir",
            str(out_dir),
            str(src),
        ]
        # NOT subprocess.run(timeout=): on Windows soffice.exe is a launcher
        # stub that spawns the real soffice.bin as a CHILD, and run()'s timeout
        # kills only the parent handle — a hung import (a pathological or
        # crafted document) would orphan soffice.bin holding the profile dir
        # open, so the finally's rmtree silently fails and both leak. Track the
        # pid and kill the whole TREE on timeout (taskkill /T).
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            # soffice must never inherit the engine's JSON-RPC stdin (the
            # distill review's lesson — a subprocess reading the RPC pipe).
            stdin=subprocess.DEVNULL,
            text=True,
        )
        try:
            stdout, stderr = proc.communicate(timeout=allowed)
        except subprocess.TimeoutExpired:
            _kill_tree(proc.pid)
            proc.communicate()  # reap, and release the pipes
            raise budget.timed_out(
                "LibreOffice conversion", allowed, size_bytes=size
            ) from None
        if proc.returncode != 0:
            raise RuntimeError(
                f"LibreOffice conversion failed (exit {proc.returncode}): "
                f"{(stderr or '').strip() or (stdout or '').strip()}"
            )
        stem = src.stem
        src_resolved = src.resolve()
        produced = [
            p
            for p in out_dir.iterdir()
            if p.is_file()
            and p.stem == stem
            and p.suffix.lower() == want_ext.lower()
            and p.resolve() != src_resolved
        ]
        if not produced:
            raise RuntimeError(
                "LibreOffice reported success but wrote no output "
                f"(stderr: {(stderr or '').strip() or (stdout or '').strip() or 'none'})"
            )
        out = produced[0]
        # rc=0 is NOT a success signal (a zero-byte source measured rc=0 with a
        # real-looking output). Prove success by reading what was written.
        if out.stat().st_size == 0:
            raise RuntimeError(
                f"LibreOffice reported success but the file it wrote is empty ({out.name})"
            )
        return out
    finally:
        shutil.rmtree(profile, ignore_errors=True)


# --------------------------------------------------------------------------
# The IMPORT direction: an Office / text / web source becomes a PDF.
# --------------------------------------------------------------------------

# Measured working with a straight `--convert-to pdf` against the vendored
# 26.2.1.2 tree: docx, xlsx, pptx, odt, ods, rtf, txt, csv,
# html. The macro/template siblings listed beside each go through the SAME
# import filter as their measured base format — a `.docm` is a `.docx` with a
# macro part, and macros never run (MacroSecurityLevel 3).
#
# Deliberately ABSENT: images. LibreOffice's image import is not DPI-honest
# (a 200-dpi PNG, a 150-dpi JPEG and a 300-dpi TIFF all landed on one Letter
# page — measured), so images go through engine/create_pdf.py's own wrap.
OFFICE_SUFFIXES = (
    # Writer
    ".doc",
    ".docx",
    ".docm",
    ".dot",
    ".dotx",
    ".odt",
    ".ott",
    ".fodt",
    ".rtf",
    ".txt",
    # Calc
    ".xls",
    ".xlsx",
    ".xlsm",
    ".xlt",
    ".xltx",
    ".ods",
    ".ots",
    ".fods",
    ".csv",
    # Impress
    ".ppt",
    ".pptx",
    ".pptm",
    ".pot",
    ".potx",
    ".odp",
    ".otp",
    ".fodp",
    # Draw / web
    ".odg",
    ".otg",
    ".html",
    ".htm",
    ".xhtml",
)

_OOXML_SUFFIXES = (".docx", ".docm", ".dotx", ".xlsx", ".xlsm", ".xltx", ".pptx", ".pptm", ".potx")
_ODF_SUFFIXES = (".odt", ".ott", ".ods", ".ots", ".odp", ".otp", ".odg", ".otg")

# An OOXML package that is password-protected is not a ZIP at all — it is an
# OLE2 compound file wrapping an EncryptedPackage stream.
_OLE2_MAGIC = b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1"


def is_office_source(path: str | Path) -> bool:
    return Path(path).suffix.lower() in OFFICE_SUFFIXES


def accepted_office_suffixes() -> tuple[str, ...]:
    return OFFICE_SUFFIXES


def _is_encrypted(path: Path) -> bool:
    """Is this source password-protected? Headless soffice cannot prompt."""
    suffix = path.suffix.lower()
    try:
        with open(path, "rb") as fh:
            head = fh.read(8)
    except OSError:
        return False
    if suffix in _OOXML_SUFFIXES and head == _OLE2_MAGIC:
        return True
    if suffix in (*_OOXML_SUFFIXES, *_ODF_SUFFIXES) and head[:2] == b"PK":
        try:
            with zipfile.ZipFile(path) as zf:
                if "META-INF/manifest.xml" in zf.namelist():
                    manifest = zf.read("META-INF/manifest.xml")
                    return b"encryption-data" in manifest
        except (OSError, zipfile.BadZipFile, KeyError):
            return False
    # A legacy .doc/.xls/.ppt is ALWAYS OLE2, so the magic says nothing there;
    # soffice's own refusal (exit 1) is the honest signal for those.
    return False


def validate_source(path: str | Path) -> Path:
    """Every per-source refusal that can be decided WITHOUT running soffice."""
    src = Path(path)
    if not src.is_file():
        raise ValueError(f"input file not found: {src}")
    if src.stat().st_size == 0:
        # Measured: soffice returns 0 and writes a 1-page PDF from nothing.
        raise ValueError(f"the input file is empty: {src}")
    if not is_office_source(src):
        raise ValueError(
            f"LibreOffice cannot convert {src.suffix or 'a file with no extension'} "
            f"(accepted: {', '.join(OFFICE_SUFFIXES)})"
        )
    if _is_encrypted(src):
        raise ValueError(
            f"the document is password-protected and cannot be converted "
            f"without its password: {src}"
        )
    return src


_SUBSET_TAG = re.compile(r"^[A-Z]{6}\+")
# PostScript naming decorations a family name picks up on its way into a PDF:
# "Arial" is embedded as `ArialMT`, "Times New Roman" as `TimesNewRomanPSMT`.
# Stripped from BOTH sides of every comparison, so the rule cannot skew.
_PS_SUFFIXES = ("psmt", "ps", "mt")


def _normalise_face(name: str) -> str:
    """A face name reduced to what a comparison can honestly use.

    Subset tag off, style suffix off, PostScript decoration off, punctuation
    and case out — so a source that declares "Arial" matches an output that
    embeds `/BAAAAA+ArialMT` and does NOT match `/CAAAAA+DejaVuSans`.
    """
    name = _SUBSET_TAG.sub("", str(name).lstrip("/"))
    name = re.split(r"[-,]", name, maxsplit=1)[0]
    key = re.sub(r"[^a-z0-9]", "", name.lower())
    for suffix in _PS_SUFFIXES:
        if key.endswith(suffix) and len(key) > len(suffix) + 2:
            return key[: -len(suffix)]
    return key


def embedded_faces(pdf_path: str | Path) -> set[str]:
    """The normalised face names a produced PDF actually draws with."""
    faces: set[str] = set()
    with pikepdf.open(str(pdf_path)) as pdf:
        for page in pdf.pages:
            resources = page.get("/Resources") or {}
            for _key, font in (resources.get("/Font") or {}).items():
                base = font.get("/BaseFont")
                if base is not None:
                    faces.add(_normalise_face(str(base)))
                for descendant in font.get("/DescendantFonts") or []:
                    base = descendant.get("/BaseFont")
                    if base is not None:
                        faces.add(_normalise_face(str(base)))
    faces.discard("")
    return faces


# What each format's DRAWN text asks for. The distinction that makes this
# usable instead of noisy: a package's font TABLE (`word/fontTable.xml`, a
# pptx THEME, ODF's `<style:font-face>` declarations) lists faces the document
# may never put a glyph in — LibreOffice writes Arial, Symbol and Times New
# Roman into every `.docx` it exports — so reading those tables reported four
# substitutions on a clean conversion. These patterns read the RUN properties
# instead, which is where a face actually gets used.
_DOCX_DRAWN = re.compile(rb'w:(?:ascii|hAnsi|cs)="([^"]+)"')
# A default rFonts record contains slots for every writing system whether the
# document draws any text in them. Latin text inherits ascii/hAnsi; counting
# the dormant cs/eastAsia slots accuses clean conversions of substituting
# fonts they never asked LibreOffice to draw. Explicit run properties above
# still retain `cs`, so an actually selected complex-script face is reported.
_DOCX_DEFAULT_DRAWN = re.compile(rb'w:(?:ascii|hAnsi)="([^"]+)"')
_XLSX_DRAWN = re.compile(rb'<name val="([^"]+)"')
_PPTX_DRAWN = re.compile(rb'typeface="([^"]+)"')
# An RTF font table entry is `{\f0\froman Liberation Serif;}` —
# the name is what survives after the control words, so they are consumed
# explicitly. Capturing lazily straight after the `\f0` grabbed the control
# word itself ("froman Liberation Serif").
_RTF_DRAWN = re.compile(rb"\\f\d+(?:\\[a-zA-Z]+-?\d*[ ]?)*([^\\;{}]+);")

# The document's own runs, plus the ONE default the rest of it inherits.
# The WHOLE of `word/styles.xml` would drag in the CJK/CTL defaults
# LibreOffice writes into every export (Lucida Sans, Microsoft YaHei) —
# declared, never drawn.
_DOCX_DEFAULTS = re.compile(rb"<w:docDefaults>.*?</w:docDefaults>", re.S)
_XLSX_PARTS = ("xl/styles.xml",)

# ODF font names are references into `<style:font-face>` declarations, and
# styles carry three independent writing-system slots. LibreOffice populates
# the CJK and complex-script slots even in a Latin-only document, and writes a
# large catalogue of UNUSED named styles. A regex over every `font-name`
# therefore accuses a clean conversion of substituting fonts it never drew.
# Resolve only the style chain around actual body text, then select the slot
# that text's Unicode script uses.
_ODF_NS = {
    "office": "urn:oasis:names:tc:opendocument:xmlns:office:1.0",
    "style": "urn:oasis:names:tc:opendocument:xmlns:style:1.0",
    "svg": "urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0",
    "text": "urn:oasis:names:tc:opendocument:xmlns:text:1.0",
    "table": "urn:oasis:names:tc:opendocument:xmlns:table:1.0",
    "draw": "urn:oasis:names:tc:opendocument:xmlns:drawing:1.0",
    "presentation": "urn:oasis:names:tc:opendocument:xmlns:presentation:1.0",
}


def _oq(prefix: str, name: str) -> str:
    return f"{{{_ODF_NS[prefix]}}}{name}"


def _odf_font_slots(style: ET.Element) -> dict[str, str]:
    props = style.find(_oq("style", "text-properties"))
    if props is None:
        return {}
    return {
        slot: value
        for slot, attr in (
            ("latin", "font-name"),
            ("asian", "font-name-asian"),
            ("complex", "font-name-complex"),
        )
        if (value := props.get(_oq("style", attr)))
    }


def _odf_script_slot(char: str) -> str | None:
    """The ODF writing-system font slot used by one printable character."""
    if not char or unicodedata.category(char)[0] not in ("L", "M", "N"):
        return None
    code = ord(char)
    if (
        0x2E80 <= code <= 0xA4CF  # CJK, Yi, Hangul, Hiragana, Katakana
        or 0xAC00 <= code <= 0xD7AF
        or 0xF900 <= code <= 0xFAFF
        or 0xFF00 <= code <= 0xFFEF
        or 0x20000 <= code <= 0x323AF
    ):
        return "asian"
    if (
        0x0590 <= code <= 0x18AF  # Hebrew through Mongolian, including Indic
        or 0x1A00 <= code <= 0x1CFF
        or 0xA800 <= code <= 0xABFF
        or 0xFB1D <= code <= 0xFDFF
        or 0xFE70 <= code <= 0xFEFF
        or 0x10E60 <= code <= 0x10E7F
        or 0x1E800 <= code <= 0x1EEFF
    ):
        return "complex"
    return "latin"


def _odf_faces(blobs: list[bytes]) -> set[str]:
    """Faces inherited by text the ODF body actually draws."""
    roots = [ET.fromstring(blob) for blob in blobs]
    declarations: dict[str, str] = {}
    defaults: dict[str, dict[str, str]] = {}
    styles: dict[tuple[str, str], tuple[str | None, dict[str, str]]] = {}

    for root in roots:
        for face in root.iter(_oq("style", "font-face")):
            name = face.get(_oq("style", "name"))
            family = face.get(_oq("svg", "font-family"))
            if name and family:
                declarations[name] = family
        for style in root.iter(_oq("style", "default-style")):
            family = style.get(_oq("style", "family"))
            if family:
                defaults[family] = _odf_font_slots(style)
        for style in root.iter(_oq("style", "style")):
            family = style.get(_oq("style", "family"))
            name = style.get(_oq("style", "name"))
            if family and name:
                styles[(family, name)] = (
                    style.get(_oq("style", "parent-style-name")),
                    _odf_font_slots(style),
                )

    def resolve(family: str, name: str | None) -> dict[str, str]:
        resolved = dict(defaults.get(family, {}))
        chain: list[dict[str, str]] = []
        seen: set[str] = set()
        while name and name not in seen:
            seen.add(name)
            record = styles.get((family, name))
            if record is None:
                break
            name, slots = record
            chain.append(slots)
        for slots in reversed(chain):
            resolved.update(slots)
        return resolved

    body = None
    for root in roots:
        body = root.find(f".//{_oq('office', 'body')}")
        if body is not None:
            break
    if body is None:
        return set()

    used: set[str] = set()
    style_elements = {
        _oq("text", "p"): ("paragraph", _oq("text", "style-name")),
        _oq("text", "h"): ("paragraph", _oq("text", "style-name")),
        _oq("text", "span"): ("text", _oq("text", "style-name")),
        _oq("table", "table-cell"): ("table-cell", _oq("table", "style-name")),
        _oq("table", "covered-table-cell"): ("table-cell", _oq("table", "style-name")),
    }

    def record(text: str | None, slots: dict[str, str]) -> None:
        for char in text or "":
            slot = _odf_script_slot(char)
            if slot and (face := slots.get(slot) or slots.get("latin")):
                used.add(declarations.get(face, face))

    def walk(element: ET.Element, inherited: dict[str, str]) -> None:
        active = inherited
        style_info = style_elements.get(element.tag)
        if style_info is not None:
            family, attribute = style_info
            active = dict(inherited)
            active.update(resolve(family, element.get(attribute)))
        else:
            for prefix, family in (("draw", "graphic"), ("presentation", "presentation")):
                name = element.get(_oq(prefix, "style-name"))
                if name:
                    active = dict(inherited)
                    active.update(resolve(family, name))
                    break
        record(element.text, active)
        for child in element:
            walk(child, active)
            record(child.tail, active)

    walk(body, {})
    return used


def _unescape(value: str) -> str:
    for entity, char in (("&apos;", "'"), ("&quot;", '"'), ("&lt;", "<"),
                         ("&gt;", ">"), ("&amp;", "&")):
        value = value.replace(entity, char)
    return value.strip().strip("'\"")


def declared_faces(path: str | Path) -> set[str]:
    """The face names the SOURCE's drawn text asks for.

    LibreOffice reports nothing about substitution, so the report's
    `fonts_substituted` is DERIVED. A format this cannot read returns an empty
    set — reporting NO substitutions rather than false ones. Silence beats a
    wrong accusation, and a wrong accusation is what teaches a user to stop
    reading the notice.
    """
    src = Path(path)
    suffix = src.suffix.lower()
    names: set[str] = set()
    try:
        if suffix in _OOXML_SUFFIXES:
            with zipfile.ZipFile(src) as zf:
                members = zf.namelist()
                if suffix.startswith((".doc", ".dot")):
                    parts, pattern = ("word/document.xml",), _DOCX_DRAWN
                    if "word/styles.xml" in members:
                        block = _DOCX_DEFAULTS.search(zf.read("word/styles.xml"))
                        if block is not None:
                            names.update(
                                m.decode("utf-8", "replace")
                                for m in _DOCX_DEFAULT_DRAWN.findall(block.group())
                            )
                elif suffix.startswith((".xls", ".xlt")):
                    parts, pattern = _XLSX_PARTS, _XLSX_DRAWN
                else:
                    # Slides only. The THEME declares a minor font a deck may
                    # never draw with (measured: DejaVu Sans on a deck whose
                    # every run is Arial).
                    parts = tuple(
                        m for m in members
                        if m.startswith("ppt/slides/slide") and m.endswith(".xml")
                    )
                    pattern = _PPTX_DRAWN
                for member in parts:
                    if member in members:
                        names.update(
                            m.decode("utf-8", "replace") for m in pattern.findall(zf.read(member))
                        )
        elif suffix in _ODF_SUFFIXES:
            with zipfile.ZipFile(src) as zf:
                members = zf.namelist()
                names.update(
                    _odf_faces(
                        [zf.read(m) for m in ("content.xml", "styles.xml") if m in members]
                    )
                )
        elif suffix in (".fodt", ".fods", ".fodp"):
            names.update(_odf_faces([src.read_bytes()]))
        elif suffix == ".rtf":
            names.update(
                m.decode("utf-8", "replace") for m in _RTF_DRAWN.findall(src.read_bytes())
            )
    except (OSError, zipfile.BadZipFile, KeyError, UnicodeDecodeError, ET.ParseError):
        return set()
    return {n for n in (_unescape(name) for name in names) if n}


def substituted_faces(source: str | Path, produced_pdf: str | Path) -> list[str]:
    """Faces the source asked for that the converter did not have.

    A contract that reflows because Calibri became DejaVu is a common
    Office-conversion failure, so substitutions are reported. Two independent
    acquittals are used because each one can only remove
    an accusation and never add one: the face is in the produced PDF (so it was
    found, whatever else is true), or it is installed on this machine (so
    LibreOffice had it available, whether or not this document drew with it).
    """
    declared = declared_faces(source)
    if not declared:
        return []
    present = embedded_faces(produced_pdf)
    installed = {_normalise_face(family) for family in installed_families()}
    missing = []
    for name in sorted(declared):
        key = _normalise_face(name)
        if key and key not in present and key not in installed:
            missing.append(name)
    return missing


def to_pdf(source: str | Path, output: str | Path, soffice_path: str) -> dict:
    """Convert ONE Office / text / web source to a PDF at ``output``.

    Success is proven by opening the result and counting its pages — never by
    the exit code.
    """
    src = validate_source(source)
    out_path = Path(output)
    if out_path.is_dir():
        raise ValueError(f"output path is a directory, not a file: {output}")
    if out_path.exists() and os.path.samefile(src, out_path):
        raise ValueError("output path is the same file as the input")
    if not str(soffice_path).strip():
        raise RuntimeError("LibreOffice is not available (no soffice path)")
    if not Path(soffice_path).is_file():
        raise RuntimeError(f"LibreOffice is not available at {soffice_path}")

    work = Path(tempfile.mkdtemp(prefix="lo-topdf-"))
    try:
        produced = run_convert(soffice_path, "pdf", src, work, ".pdf")
        try:
            with pikepdf.open(str(produced)) as pdf:
                pages = len(pdf.pages)
        except Exception as exc:  # noqa: BLE001
            raise RuntimeError(
                f"LibreOffice produced a PDF that cannot be read: {exc}"
            ) from None
        if pages == 0:
            raise RuntimeError(
                "LibreOffice reported success but the PDF it wrote has no pages"
            )
        fonts = substituted_faces(src, produced)

        out_path.parent.mkdir(parents=True, exist_ok=True)
        if out_path.exists():
            # A read-only existing target must not break the move (the
            # mirror-output lesson).
            try:
                os.chmod(out_path, 0o666)
            except OSError:
                pass
        shutil.move(str(produced), str(out_path))
        result = {
            "output": str(out_path),
            "pages": pages,
            "converter": "libreoffice",
            "size_bytes": out_path.stat().st_size,
        }
        if fonts:
            result["fonts_substituted"] = fonts
        return result
    finally:
        shutil.rmtree(work, ignore_errors=True)
