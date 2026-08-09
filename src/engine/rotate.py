"""PDF page rotation operations using pikepdf."""

import shutil
import tempfile
from pathlib import Path

import pikepdf
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
    same_file = input_path.resolve() == output_path.resolve()

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
            with tempfile.NamedTemporaryFile(suffix='.pdf', delete=False, dir=str(input_path.parent)) as tmp:
                tmp_path = tmp.name
            save_pdf(pdf, tmp_path)
        else:
            save_pdf(pdf, output_path)

    if same_file:
        shutil.move(tmp_path, str(output_path))

    return {
        "output": str(output_path),
        "pages_rotated": len(target_pages),
        "angle": angle,
    }
