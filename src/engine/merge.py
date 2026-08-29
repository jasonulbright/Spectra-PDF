"""PDF merge operations using pikepdf."""

from contextlib import ExitStack
from pathlib import Path

import pikepdf

from engine.acroform import (
    carry_doc_form_extras,
    carry_pure_data_fields,
    refresh_sig_flags,
    refuse_if_xfa,
)
from engine.pdf_save import encryption_profile, save_pdf


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
    protected_sources: list = []
    profiles: set = set()
    with ExitStack() as stack:
        for file_path in files:
            pdf = stack.enter_context(pikepdf.open(file_path))
            refuse_if_xfa(pdf, file_path, "merging")
            profile = encryption_profile(pdf)
            profiles.add(profile)
            if profile is not None:
                protected_sources.append(pdf)
            result = merged.add_pages_from(pdf)
            renamed.extend({"from": old, "to": new} for old, new in result.renamed_fields.items())
            pure_renames = carry_pure_data_fields(merged, pdf)
            renamed.extend(pure_renames)
            # /CO reconciliation must see EVERY rename this source suffered —
            # add_pages_from's report AND the pure-data carry's (a calc field
            # can be widget-less).
            source_renames = dict(result.renamed_fields)
            source_renames.update({r["from"]: r["to"] for r in pure_renames})
            carry_doc_form_extras(merged, pdf, source_renames)
            total_pages += result.pages_added
        refresh_sig_flags(merged)
        # One combined document can only carry one encryption, so a merge that
        # mixes protections has no faithful answer and refuses rather than
        # picking one. Where every input agrees, that agreement IS the answer.
        if len(profiles) > 1:
            raise ValueError(
                "These documents cannot be combined without changing their "
                "protection: they do not all carry the same encryption and "
                "permissions, and one combined document can only have one. "
                "Give them matching protection, or decrypt them first."
            )
        # Sources stay open through the save — qpdf resolves foreign copies
        # lazily, so a source closed before the destination is saved risks
        # reading freed data (the old per-file `with` closed each one early).
        save_pdf(
            merged,
            output_path,
            encryption_source=protected_sources[0] if protected_sources else None,
        )

    result_dict = {
        "output": str(output_path),
        "pages": total_pages,
        "size_bytes": output_path.stat().st_size,
    }
    if renamed:
        result_dict["fields_renamed"] = renamed
    return result_dict
