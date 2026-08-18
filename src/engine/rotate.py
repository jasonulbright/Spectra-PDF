"""PDF page rotation operations using pikepdf."""

from pathlib import Path

import pikepdf
from engine.inplace import is_same_file, staged_write
from engine.pdf_save import save_pdf


def rotate(file: str, pages: list[int] | str, angle: int, output: str) -> dict:
    """Rotate pages in a PDF by the specified angle.

    Args:
        file: Input PDF path.
        pages: List of 1-based page numbers, or 'all'.
        angle: Rotation angle (90, 180, 270).
        output: Output PDF path.
    """
    input_path = Path(file)
    output_path = Path(output)
    same_file = is_same_file(str(input_path), str(output_path))

    with pikepdf.open(file) as pdf:
        if pages == "all":
            target_pages = list(range(len(pdf.pages)))
        else:
            target_pages = [p - 1 for p in pages if 0 < p <= len(pdf.pages)]

        for idx in target_pages:
            page = pdf.pages[idx]
            current = int(page.get("/Rotate", 0))
            page["/Rotate"] = (current + angle) % 360

        if same_file:
            with staged_write(output_path) as staged:
                save_pdf(pdf, str(staged))
                pdf.close()
        else:
            save_pdf(pdf, output_path)

    return {
        "output": str(output_path),
        "pages_rotated": len(target_pages),
        "angle": angle,
    }
