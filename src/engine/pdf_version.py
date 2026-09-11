"""Effective PDF version: catalog overrides only a lower header (Table 29)."""
import re

import pikepdf


def effective_version(pdf: pikepdf.Pdf) -> tuple[int, int]:
    def parse(value: str) -> tuple[int, int]:
        if re.fullmatch(r"(?:1\.[0-7]|2\.0)", value) is None:
            raise ValueError("The PDF version cannot be determined.")
        major, minor = value.split(".")
        return int(major), int(minor)

    header = parse(pdf.pdf_version)
    catalog = pdf.Root.get("/Version")
    if catalog is None:
        return header
    if not isinstance(catalog, pikepdf.Name):
        raise ValueError("The PDF version cannot be determined.")
    return max(header, parse(str(catalog)[1:]))
