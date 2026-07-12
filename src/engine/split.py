"""PDF split operations using pikepdf."""

from pathlib import Path

import pikepdf

from engine.acroform import carry_pure_data_fields, prune_form_to_pages, refresh_sig_flags


def parse_ranges(range_str: str, max_page: int) -> list[int]:
    """Parse a page range string like '1-5,10-15' into a list of 0-based page indices."""
    pages: list[int] = []
    for part in range_str.split(","):
        part = part.strip()
        if "-" in part:
            start, end = part.split("-", 1)
            start_idx = int(start) - 1
            end_idx = min(int(end), max_page)
            pages.extend(range(start_idx, end_idx))
        else:
            pages.append(int(part) - 1)
    return [p for p in pages if 0 <= p < max_page]


def split(file: str, ranges: str, output_dir: str) -> dict:
    """Split a PDF by page ranges into separate files."""
    output_path = Path(output_dir)
    output_path.mkdir(parents=True, exist_ok=True)
    outputs: list[str] = []

    with pikepdf.open(file) as pdf:
        page_indices = parse_ranges(ranges, len(pdf.pages))
        # Prune form-field trees to the kept pages BEFORE copying — a
        # partially-selected multi-widget field would otherwise carry its
        # ENTIRE subtree, leaving phantom dead widgets for the excluded
        # pages' kids. This open is private; the file on disk is untouched.
        prune_form_to_pages(pdf, page_indices)
        result = pikepdf.Pdf.new()
        # Form-aware copy: registers the kept fields in the part's own
        # /AcroForm — a plain pages.append leaves every field orphaned
        # (rendered, dead). Widget-less pure-data fields and /SigFlags are
        # covered by the acroform helpers.
        result.add_pages_from(pdf, pages=page_indices)
        carry_pure_data_fields(result, pdf)
        refresh_sig_flags(result)

        out_file = output_path / f"split_{ranges.replace(',', '_')}.pdf"
        result.save(out_file)
        outputs.append(str(out_file))

    return {"outputs": outputs, "pages_extracted": len(page_indices)}
