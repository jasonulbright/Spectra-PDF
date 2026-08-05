"""The fonts installed on this machine.

Text editing has offered Keep-original plus three bundled families since
7.4. The bundled faces ensure a metric-compatible replacement is available
offline; they are not the whole user-facing font choice. This module lists
the usable installed fonts.

Two things decide whether a face belongs in it, and both are read off the
font itself rather than assumed:

  - **Embedding permission.** OS/2 `fsType` is the foundry's statement of
    what may be done with the file. A face marked Restricted License must
    not be embedded at all; one marked no-subsetting or bitmap-only cannot
    be embedded the way this engine embeds (always a subset, always
    outlines). Those are EXCLUDED, and the count of them is reported — a
    user whose font is missing gets an answer instead of a mystery, and a
    disabled entry that refuses on click is worse than an absent one.
  - **Usability.** A face whose name table cannot be read, or which carries
    no outlines, is no use as a replacement font and is skipped silently.

Enumeration is by DIRECTORY, not by registry: both the machine-wide font
directory and the per-user one are ordinary folders, the per-user one is
where a font installed without admin rights lands, and a directory listing
cannot go stale against a registry entry pointing at a file that has been
removed.
"""

import os
from functools import lru_cache

# fsType bits (OS/2). Bit 0 has no meaning on its own; fsType == 0 is
# "Installable Embedding", the permissive default.
_FS_RESTRICTED = 0x0002  # Restricted License — must not be embedded
_FS_PREVIEW_PRINT = 0x0004  # embeddable, read-only use intended
_FS_EDITABLE = 0x0008  # embeddable, editing intended
_FS_NO_SUBSET = 0x0100  # must be embedded whole — this engine always subsets
_FS_BITMAP_ONLY = 0x0200  # outlines must not be embedded

_EXTENSIONS = (".ttf", ".otf", ".ttc", ".otc")


def _font_dirs() -> list[str]:
    dirs: list[str] = []
    windir = os.environ.get("WINDIR") or os.environ.get("SystemRoot")
    if windir:
        dirs.append(os.path.join(windir, "Fonts"))
    local = os.environ.get("LOCALAPPDATA")
    if local:
        # Where a font installed "for me only" lands — no admin rights
        # needed, and invisible to anything that only looks at WINDIR.
        dirs.append(os.path.join(local, "Microsoft", "Windows", "Fonts"))
    return [d for d in dirs if os.path.isdir(d)]


def embedding_refusal(fs_type: int) -> str | None:
    """Why this `fsType` cannot be embedded by this engine, or None.

    Preview-and-print (without the editable bit) is ALLOWED: it permits
    embedding, and its restriction is on what the recipient may do with the
    document — which is not something a producer can enforce and not
    something this engine claims to. What is refused is the case where the
    foundry has said no to embedding at all, and the two cases where it has
    said yes only in a shape this engine does not produce."""
    if fs_type & _FS_RESTRICTED:
        return "the font's licence does not permit embedding"
    if fs_type & _FS_BITMAP_ONLY:
        return "the font permits embedding bitmaps only"
    if fs_type & _FS_NO_SUBSET:
        return "the font does not permit subsetting"
    return None


def _name(tt, *ids: int) -> str:
    """The first readable name-table string among `ids`. `getDebugName`
    lives on the NAME TABLE, not on the font — reading it off the font
    silently raises AttributeError, which a bare `except` then turns into
    "no fonts installed" (caught the first time this ran)."""
    try:
        table = tt["name"]
    except Exception:
        return ""
    for name_id in ids:
        try:
            record = table.getDebugName(name_id)
        except Exception:
            record = None
        if record:
            return str(record)
    return ""


def read_face(path: str, font_number: int = 0) -> dict | None:
    """One face's descriptor, or None when it is unusable. Never raises: a
    machine's font folder routinely holds a file some parser dislikes, and
    one bad file must not empty the list."""
    from fontTools.ttLib import TTFont

    try:
        tt = TTFont(path, fontNumber=font_number, lazy=True)
    except Exception:
        return None
    try:
        try:
            fs_type = int(tt["OS/2"].fsType)
        except Exception:
            fs_type = 0  # no OS/2 table: no stated restriction
        family = _name(tt, 16, 1)  # typographic family, else legacy family
        subfamily = _name(tt, 17, 2) or "Regular"
        full = _name(tt, 4) or (f"{family} {subfamily}".strip())
        if not family:
            return None
        try:
            selection = int(tt["OS/2"].fsSelection)
            bold = bool(selection & 0x20)
            italic = bool(selection & 0x01)
        except Exception:
            lower = subfamily.lower()
            bold = "bold" in lower
            italic = "italic" in lower or "oblique" in lower
        # A face with neither outline table is a bitmap-only or broken file.
        if "glyf" not in tt and "CFF " not in tt and "CFF2" not in tt:
            return None
        return {
            "path": os.path.abspath(path),
            "index": font_number,
            "family": family,
            "style": subfamily,
            "name": full,
            "bold": bold,
            "italic": italic,
            "fs_type": fs_type,
            "refusal": embedding_refusal(fs_type),
        }
    except Exception:
        return None
    finally:
        try:
            tt.close()
        except Exception:
            pass


def _collection_count(path: str) -> int:
    from fontTools.ttLib import TTCollection

    try:
        with TTCollection(path, lazy=True) as coll:
            return len(coll.fonts)
    except Exception:
        return 1


@lru_cache(maxsize=1)
def _scan() -> tuple:
    faces: list[dict] = []
    seen: set[str] = set()
    for directory in _font_dirs():
        try:
            entries = sorted(os.listdir(directory))
        except OSError:
            continue
        for entry in entries:
            if not entry.lower().endswith(_EXTENSIONS):
                continue
            path = os.path.join(directory, entry)
            key = os.path.normcase(os.path.abspath(path))
            if key in seen:
                continue
            seen.add(key)
            count = _collection_count(path) if entry.lower().endswith((".ttc", ".otc")) else 1
            for i in range(count):
                face = read_face(path, i)
                if face is not None:
                    faces.append(face)
    faces.sort(key=lambda f: (f["family"].lower(), f["style"].lower()))
    return tuple(faces)


def list_system_fonts(refresh: bool = False) -> dict:
    """Every installed face this engine can embed.

    `families` groups the usable faces so a picker can offer a family and
    resolve the weight/slant within it. `restricted` counts what the
    foundry's own `fsType` excluded, so the UI can SAY that rather than
    leave a user hunting for a font that is simply not offerable."""
    if refresh:
        _scan.cache_clear()
    faces = _scan()
    usable = [f for f in faces if f["refusal"] is None]
    restricted = len(faces) - len(usable)
    families: dict[str, list] = {}
    for face in usable:
        families.setdefault(face["family"], []).append(
            {
                "path": face["path"],
                "index": face["index"],
                "style": face["style"],
                "name": face["name"],
                "bold": face["bold"],
                "italic": face["italic"],
            }
        )
    return {
        "fonts": [{k: v for k, v in f.items() if k != "fs_type"} for f in usable],
        "families": [
            {"family": name, "faces": faces_in}
            for name, faces_in in sorted(families.items(), key=lambda kv: kv[0].lower())
        ],
        "count": len(usable),
        "restricted": restricted,
    }


def installed_families() -> set[str]:
    """Every family name installed on this machine, RESTRICTED ONES INCLUDED.

    Deliberately not `list_system_fonts`: that filters by whether THIS engine
    may embed a face, which is a different question from whether the machine
    has it. LibreOffice renders with a Restricted-License face perfectly well,
    so excluding those here would make the substitution report accuse
    the converter of dropping a font it actually used.
    """
    return {face["family"] for face in _scan() if face.get("family")}


def resolve_face(path: str, index: int = 0) -> str:
    """Validate a caller-supplied face path and hand back its absolute form.

    The editing ops take a font FILE now, so this is the one gate: the file
    must exist, parse as a font, and be one the foundry permits embedding.
    A refusal names the reason — a user who picked a licence-restricted
    font is told that, not handed a generic failure."""
    if not path or not os.path.isfile(path):
        raise ValueError(f"font file not found: {path}")
    face = read_face(path, int(index or 0))
    if face is None:
        raise ValueError(f"not a usable font file: {os.path.basename(path)}")
    if face["refusal"]:
        raise ValueError(f"{face['name']}: {face['refusal']}")
    return face["path"]
