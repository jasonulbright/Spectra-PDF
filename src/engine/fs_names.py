"""Turning author-controlled text into a filename the filesystem accepts.

Every consumer that writes a file whose NAME comes from inside a document —
a portfolio member, a bookmark title — shares this rule, so a name that lands
on one path lands the same way on the other.
"""

from pathlib import Path

# Characters Windows refuses in a name, plus both path separators. A name is
# never a path here: a separator that survived would redirect the write.
ILLEGAL_NAME_CHARS = '<>:"/\\|?*'

# Names the DOS device namespace still reserves. A file called `CON` or
# `NUL.pdf` cannot be created on Windows at all, whatever the directory.
_RESERVED_STEMS = frozenset(
    {"CON", "PRN", "AUX", "NUL"}
    | {f"COM{d}" for d in range(1, 10)}
    | {f"LPT{d}" for d in range(1, 10)}
)

# Leaves room under the 255-byte component limit for an extension and a
# de-duplication suffix.
MAX_NAME_LEN = 120


def safe_file_name(raw: str, fallback: str = "untitled") -> str:
    """`raw` reduced to a single path component the filesystem will accept.

    Trailing dots and surrounding whitespace go: Windows strips them when the
    file is created, so a name that ends in one is not the name that lands.
    """
    cleaned = "".join(
        "_" if (ch in ILLEGAL_NAME_CHARS or ord(ch) < 0x20) else ch for ch in (raw or "")
    ).strip()
    while cleaned.endswith("."):
        cleaned = cleaned[:-1].rstrip()
    cleaned = cleaned[:MAX_NAME_LEN].strip()
    if not cleaned:
        return fallback
    if Path(cleaned).stem.upper() in _RESERVED_STEMS:
        cleaned = cleaned + "_"
    return cleaned


def unique_path(directory: Path, name: str) -> Path:
    """`directory / name`, suffixed ``(2)``, ``(3)``… until nothing is there."""
    target = directory / name
    stem, suffix = target.stem, target.suffix
    n = 2
    while target.exists():
        target = directory / f"{stem} ({n}){suffix}"
        n += 1
    return target


def unique_name(name: str, used: set) -> str:
    """`name`, suffixed until its lowercased form is not already in `used`.

    The caller owns `used`; this only reports the name to take.
    """
    if name.lower() not in used:
        return name
    stem, suffix = Path(name).stem, Path(name).suffix
    n = 2
    while f"{stem} ({n}){suffix}".lower() in used:
        n += 1
    return f"{stem} ({n}){suffix}"
