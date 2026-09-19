"""Effective PDF version: catalog overrides only a lower header (Table 29)."""
import re
from dataclasses import dataclass, field
from typing import NoReturn

import pikepdf
from pikepdf import Array, Dictionary, Name, String

# ISO 32000-1 covers 1.0 through 1.7; this document covers 2.0 (Annex I.2).
# Nothing outside that set is a PDF version, so nothing outside it is parsed.
_CANONICAL = re.compile(r"(?:1\.[0-7]|2\.0)")

def _refuse_unreadable_version() -> NoReturn:
    # A literal raise is discoverable by the engine-message inventory. Moving
    # it into a constant silently drops its existing translation-table row.
    raise ValueError("The PDF version cannot be determined.") from None


def parse_version(value: str) -> tuple[int, int]:
    """A declared version as (major, minor).

    Strict: the canonical grammar and nothing else. No surrounding whitespace
    is stripped and no near-miss is coerced, because a value this cannot read
    is a fact the document does not state — not one to guess at.
    """
    if not isinstance(value, str) or _CANONICAL.fullmatch(value) is None:
        _refuse_unreadable_version()
    major, minor = value.split(".")
    return int(major), int(minor)


def _catalog_declaration(pdf: pikepdf.Pdf) -> str | None:
    """The catalog's own declaration, or None when it makes none.

    Table 29: the value shall be a name object, not a number, so anything
    else is unreadable rather than convertible.
    """
    raw = pdf.Root.get("/Version")
    if raw is None:
        return None
    if not isinstance(raw, pikepdf.Name):
        _refuse_unreadable_version()
    return str(raw)[1:]


def version_facts(pdf: pikepdf.Pdf) -> dict:
    """The document's version, and the two declarations it is derived from.

    Table 29: the catalog's version applies only when it is LATER than the
    header's; where the header is later, or the catalog says nothing, the
    header supplies its declared requirement. So the effective version is the
    later of the two, and both declarations stay available under their own
    labels — a physical header is a fact about the file, not about what the
    document claims to be.

    Raises the unreadable refusal when either declaration is present and
    cannot be read.
    """
    try:
        header = pdf.pdf_version
        header_version = parse_version(header)
        catalog = _catalog_declaration(pdf)
        effective = header_version if catalog is None else max(header_version, parse_version(catalog))
    except (ValueError, TypeError, RuntimeError, pikepdf.PdfError):
        _refuse_unreadable_version()
    return {
        "version": f"{effective[0]}.{effective[1]}",
        "header_version": header,
        "catalog_version": catalog,
    }


def effective_version(pdf: pikepdf.Pdf) -> tuple[int, int]:
    """The effective version as (major, minor), for comparing versions."""
    return parse_version(version_facts(pdf)["version"])


MAX_DECLARATIONS = 4096
_DECLARATION_ORDERED = ('/ExtensionLevel', '/ExtensionRevision')


def _refuse_declarations() -> NoReturn:
    raise ValueError("The version declarations cannot be preserved completely.")


def _declaration_identity(value, depth: int = 0) -> bytes:
    """A canonical identity for a developer-extension declaration's contents.

    Table 34 declarations are shallow name/number/string data. A stream or a
    graph deeper than that is not a declaration this can read, so it refuses
    instead of carrying something it cannot compare.
    """
    if depth > 8:
        _refuse_declarations()
    if isinstance(value, pikepdf.Stream):
        _refuse_declarations()
    if value is None:
        return b"null;"
    if isinstance(value, Dictionary):
        parts = [b"dict("]
        for key in sorted(value.keys()):
            parts.append(key.encode("utf-8", "surrogateescape") + b"="
                         + _declaration_identity(value[key], depth + 1))
        return b"".join(parts) + b");"
    if isinstance(value, Array):
        if len(value) > MAX_DECLARATIONS:
            _refuse_declarations()
        return b"array(" + b"".join(
            _declaration_identity(item, depth + 1) for item in value) + b");"
    if isinstance(value, String):
        return b"string(" + bytes(value) + b");"
    if isinstance(value, Name):
        return b"name(" + bytes(value) + b");"
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        _refuse_declarations()
    return b"number(" + repr(value).encode() + b");"


def _declaration_base(declaration) -> tuple[int, int]:
    base = declaration.get("/BaseVersion")
    if not isinstance(base, Name):
        _refuse_declarations()
    try:
        return parse_version(str(base)[1:])
    except ValueError:
        _refuse_declarations()


def _declaration_level(declaration) -> int:
    level = declaration.get("/ExtensionLevel")
    if isinstance(level, bool) or not isinstance(level, int):
        _refuse_declarations()
    return level


def _read_declaration(value):
    """One prefix's declaration, validated, with its comparable identity."""
    if isinstance(value, Array):
        # PDF 2.0 admits several declarations under one prefix; their ordering
        # is not defined, so they compose only by being the same declaration.
        if len(value) == 0 or len(value) > MAX_DECLARATIONS:
            _refuse_declarations()
        base = (1, 0)
        for item in value:
            if not isinstance(item, Dictionary) or isinstance(item, pikepdf.Stream):
                _refuse_declarations()
            _declaration_level(item)
            base = max(base, _declaration_base(item))
        return {"identity": _declaration_identity(value), "base": base,
                "level": None, "shape": "array", "value": value}
    if not isinstance(value, Dictionary) or isinstance(value, pikepdf.Stream):
        _refuse_declarations()
    return {"identity": _declaration_identity(value), "base": _declaration_base(value),
            "level": _declaration_level(value), "shape": "dictionary", "value": value}


def _compose_declaration(kept, incoming):
    """The stronger of two declarations for one prefix, or a refusal.

    A higher extension level supersedes a lower one only where the rest of the
    declaration, its base version included, is otherwise identical: anything
    else is two different extensions claiming one prefix.
    """
    if kept["identity"] == incoming["identity"]:
        return kept
    if kept["shape"] != "dictionary" or incoming["shape"] != "dictionary":
        _refuse_declarations()
    if kept["base"] != incoming["base"]:
        _refuse_declarations()
    for candidate in (kept, incoming):
        rest = Dictionary()
        for key, entry in candidate["value"].items():
            if key not in _DECLARATION_ORDERED:
                rest[key] = entry
        candidate["rest"] = _declaration_identity(rest)
    if kept["rest"] != incoming["rest"]:
        _refuse_declarations()
    if kept["level"] == incoming["level"]:
        _refuse_declarations()
    return kept if kept["level"] > incoming["level"] else incoming


@dataclass
class VersionCarry:
    """Composed version and extension requirements of every contribution.

    A destination built from copied pages starts at a fresh document's own
    header, which states nothing about the features that were copied into it.
    Each contribution's effective version and developer-extension declarations
    are composed here and declared before the destination is saved; a physical
    header older than a retained feature is not evidence that the feature is
    absent, so nothing is inferred from it.
    """

    required: tuple[int, int] | None = None
    declarations: dict = field(default_factory=dict)

    def require(self, version: tuple[int, int]) -> None:
        self.required = version if self.required is None else max(self.required, version)

    def contribute(self, src: pikepdf.Pdf) -> None:
        self.require(effective_version(src))
        extensions = src.Root.get("/Extensions")
        if extensions is None:
            return
        if not isinstance(extensions, Dictionary) or isinstance(extensions, pikepdf.Stream):
            _refuse_declarations()
        for prefix, value in extensions.items():
            if value is None:
                continue
            read = _read_declaration(value)
            read["pdf"] = src
            self.require(read["base"])
            kept = self.declarations.get(prefix)
            self.declarations[prefix] = read if kept is None else _compose_declaration(kept, read)

    def apply(self, dst: pikepdf.Pdf) -> None:
        if self.required is not None and self.required > effective_version(dst):
            dst.Root.Version = Name(f"/{self.required[0]}.{self.required[1]}")
        if not self.declarations:
            return
        extensions = Dictionary()
        for prefix, read in self.declarations.items():
            value = read["value"]
            if not value.is_indirect:
                container = Array(value) if read["shape"] == "array" else Dictionary(value)
                value = read["pdf"].make_indirect(container)
            extensions[prefix] = dst.copy_foreign(value)
        dst.Root.Extensions = dst.make_indirect(extensions)
