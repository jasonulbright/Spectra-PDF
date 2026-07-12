"""PDF merge operations using pikepdf."""

from contextlib import ExitStack
from pathlib import Path

import pikepdf

from engine.acroform import carry_pure_data_fields, refresh_sig_flags


def merge(files: list[str], output: str) -> dict:
    """Merge multiple PDF files into one.

    Pages copy via ``add_pages_from`` (form-aware), so every input's AcroForm
    fields stay registered and fillable — a plain ``pages.extend`` imports the
    field OBJECTS but not their registration, killing every form (pikepdf's
    own PageCopyWarning flags exactly this). Cross-file field-name collisions
    rename deterministically (``name+1``) and are reported as
    ``fields_renamed``; widget-less pure-data fields (which page-driven
    copying can't discover) and /SigFlags are handled by the acroform
    helpers.
    """
    output_path = Path(output)
    merged = pikepdf.Pdf.new()

    total_pages = 0
    renamed: list[dict] = []
    with ExitStack() as stack:
        for file_path in files:
            pdf = stack.enter_context(pikepdf.open(file_path))
            result = merged.add_pages_from(pdf)
            renamed.extend({"from": old, "to": new} for old, new in result.renamed_fields.items())
            renamed.extend(carry_pure_data_fields(merged, pdf))
            total_pages += result.pages_added
        refresh_sig_flags(merged)
        # Sources stay open through the save — qpdf resolves foreign copies
        # lazily, so a source closed before the destination is saved risks
        # reading freed data (the old per-file `with` closed each one early).
        merged.save(output_path)

    result_dict = {
        "output": str(output_path),
        "pages": total_pages,
        "size_bytes": output_path.stat().st_size,
    }
    if renamed:
        result_dict["fields_renamed"] = renamed
    return result_dict
