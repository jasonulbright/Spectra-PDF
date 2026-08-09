"""Tier 1: Light PDF repair via pikepdf/QPDF rewrite.

Fixes broken xref tables, stream length mismatches, page tree corruption.
Rewrites object numbering and cross-references. Fast, non-destructive --
preserves annotations, bookmarks, metadata.
"""

import pikepdf
from pathlib import Path
from engine.pdf_save import save_pdf


def repair(file: str, output: str) -> dict:
    """Repair a PDF by rewriting it through pikepdf (QPDF backend).

    pikepdf.open() with recovery mode reconstructs the xref table and
    object graph. Saving to a new file rewrites all objects with correct
    cross-references, stream lengths, and page tree structure.

    Args:
        file: Input PDF path.
        output: Output PDF path.
    """
    input_path = Path(file)
    output_path = Path(output)

    if not input_path.exists():
        raise FileNotFoundError(f"File not found: {file}")

    original_size = input_path.stat().st_size
    issues_found = []

    # Open with recovery mode -- pikepdf/QPDF will attempt to
    # reconstruct broken xref tables and fix structural issues
    # allow_overwriting_input=True lets us save back to the same file
    try:
        pdf = pikepdf.open(
            file, suppress_warnings=False, allow_overwriting_input=True
        )
    except pikepdf.PasswordError:
        raise ValueError("PDF is encrypted -- decrypt before repairing")
    except Exception as e:
        # If normal open fails, the file is damaged. Try harder.
        issues_found.append(f"Initial open failed: {e}")
        try:
            pdf = pikepdf.open(
                file, suppress_warnings=False, allow_overwriting_input=True
            )
        except Exception as e2:
            raise RuntimeError(
                f"PDF is too damaged for Tier 1 repair: {e2}. "
                "Try 'rebuild' (Tier 2) or 'recover' (Tier 3)."
            )

    with pdf:
        page_count = len(pdf.pages)

        # Validate page tree is accessible
        for i, page in enumerate(pdf.pages):
            try:
                _ = page.get("/MediaBox")
            except Exception as e:
                issues_found.append(f"Page {i + 1} has damaged MediaBox: {e}")

        # Check for common structural issues
        if pdf.is_linearized:
            issues_found.append("Linearization data present (will be rewritten)")

        # Save with full rewrite -- this is the actual repair step.
        # QPDF rewrites all objects, fixing xref, stream lengths, etc.
        save_pdf(
            pdf,
            str(output_path),
            linearize=False,  # Clean output, no web-optimization artifacts
            object_stream_mode=pikepdf.ObjectStreamMode.generate,
            compress_streams=True,
            recompress_flate=True,
        )

    output_size = output_path.stat().st_size

    return {
        "output": str(output_path),
        "pages": page_count,
        "original_size": original_size,
        "repaired_size": output_size,
        "issues_found": issues_found,
        "tier": "repair",
    }
