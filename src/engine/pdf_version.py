"""Effective PDF version: catalog overrides only a lower header (Table 29)."""
import re
from typing import NoReturn

import pikepdf

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
