"""Delete pages from a PDF using pikepdf."""

import shutil
import tempfile
from pathlib import Path

import pikepdf

from engine.acroform import prune_form_to_pages


def delete(file: str, pages: list[int], output: str) -> dict:
    """Delete specified pages from a PDF.

    Args:
        file: Input PDF path.
        pages: List of 1-based page numbers to delete.
        output: Output PDF path.
    """
    input_path = Path(file)
    output_path = Path(output)
    same_file = input_path.resolve() == output_path.resolve()

    with pikepdf.open(file) as pdf:
        total = len(pdf.pages)
        indices = sorted(set(p - 1 for p in pages if 0 < p <= total), reverse=True)
        for idx in indices:
            del pdf.pages[idx]

        # In-place deletion keeps /AcroForm, but a field whose every widget
        # sat on deleted pages would linger as a phantom (fillable, visible
        # nowhere). Prune with every REMAINING page kept — dead widgets drop
        # because their /P no longer resolves to a surviving page.
        prune_form_to_pages(pdf, range(len(pdf.pages)))

        if same_file:
            with tempfile.NamedTemporaryFile(suffix='.pdf', delete=False, dir=str(input_path.parent)) as tmp:
                tmp_path = tmp.name
            pdf.save(tmp_path)
        else:
            pdf.save(output_path)

    if same_file:
        shutil.move(tmp_path, str(output_path))

    return {
        "output": str(output_path),
        "pages_deleted": len(indices),
        "pages_remaining": total - len(indices),
    }
