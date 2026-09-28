"""Tier 1: Light PDF repair via pikepdf/QPDF rewrite.

Fixes broken xref tables, stream length mismatches, page tree corruption.
Rewrites object numbering and cross-references. Fast, non-destructive --
preserves annotations, bookmarks, metadata.
"""

import pikepdf
from engine.credentials import open_pdf
from pathlib import Path
from engine.acroform import strip_signatures
from engine.pdf_save import save_pdf

# QPDF warnings that describe input every reader accepts as written. QPDF
# labels the first class itself; the second is a Flate stream with bytes after
# its end marker, which decodes completely. Neither makes a file damaged.
_BENIGN_WARNINGS = (
    "a common error handled correctly by qpdf and most other applications",
    "input stream is complete but output may still be valid",
)


def _is_damage(warning: str) -> bool:
    return not any(marker in warning for marker in _BENIGN_WARNINGS)


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
    # Structural damage only: linearization data and stripped signatures are
    # rewrite side effects, not defects in the source.
    damage_found = []

    # QPDF reconstructs a damaged xref, stream lengths and object streams at
    # open and while objects resolve; each reconstruction is a warning, and the
    # warnings are the only record of what the rewrite repaired.
    try:
        pdf = open_pdf(
            file, suppress_warnings=True, allow_overwriting_input=True
        )
    except pikepdf.PasswordError:
        raise ValueError("PDF is encrypted -- decrypt before repairing")
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
                damage_found.append(issues_found[-1])

        # Check for common structural issues
        if pdf.is_linearized:
            issues_found.append("Linearization data present (will be rewritten)")

        signatures_removed = strip_signatures(pdf)
        if signatures_removed:
            issues_found.append(
                f"Removed {signatures_removed} signature(s) the rewrite invalidates"
            )

        # Save with full rewrite -- this is the actual repair step.
        # QPDF rewrites all objects, fixing xref, stream lengths, etc.
        save_pdf(
            pdf,
            str(output_path),
            linearize=False,  # Clean output, no web-optimization artifacts
            object_stream_mode=pikepdf.ObjectStreamMode.preserve,
            compress_streams=True,
            recompress_flate=True,
        )
        for warning in pdf.get_warnings():
            text = str(warning).strip()
            if text and text not in issues_found:
                issues_found.append(text)
            if text and _is_damage(text) and text not in damage_found:
                damage_found.append(text)

    output_size = output_path.stat().st_size

    return {
        "output": str(output_path),
        "pages": page_count,
        "original_size": original_size,
        "repaired_size": output_size,
        "issues_found": issues_found,
        "signatures_removed": signatures_removed,
        "damaged": bool(damage_found),
        "damage": damage_found,
        "tier": "repair",
    }
