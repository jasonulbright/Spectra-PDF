"""PDF page rotation operations using pikepdf."""

from pathlib import Path

import pikepdf
from engine.inplace import staged_write
from engine.pdf_save import save_pdf


def rotate(file: str, pages: list[int] | str, angle: int, output: str) -> dict:
    """Rotate pages in a PDF by the specified angle.

    Args:
        file: Input PDF path.
        pages: List of 1-based page numbers, or 'all'.
        angle: Rotation angle, a multiple of 90 (ISO 32000-2 Table 31 /Rotate).
        output: Output PDF path.
    """
    from engine.incremental import finalize_preserving_signatures, signature_outcome

    if isinstance(angle, bool) or not isinstance(angle, (int, float)) or angle % 90:
        raise ValueError(f"the rotation angle must be a multiple of 90 degrees, got {angle!r}")
    angle = int(angle)
    input_path = Path(file)
    output_path = Path(output)

    with pikepdf.open(file) as pdf:
        if pages == "all":
            target_pages = list(range(len(pdf.pages)))
        else:
            target_pages = [p - 1 for p in pages if 0 < p <= len(pdf.pages)]

        for idx in target_pages:
            page = pdf.pages[idx]
            current = int(page.get("/Rotate", 0))
            page["/Rotate"] = (current + angle) % 360

        # A signed input lands as its original bytes plus one revision where
        # the transplant accepts the delta; otherwise the result reports the
        # invalidation. No destination is replaced before the write completes.
        with staged_write(output_path) as staged:
            save_pdf(pdf, str(staged))
            pdf.close()
            preserved = finalize_preserving_signatures(str(input_path), str(staged))

    return {
        "output": str(output_path),
        "pages_rotated": len(target_pages),
        "angle": angle,
        **signature_outcome(preserved),
    }
