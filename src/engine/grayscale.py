"""PDF grayscale conversion via Ghostscript."""

import shutil
import tempfile
from pathlib import Path

from . import budget
from .acroform import reattach_forms_file
from .inplace import is_same_file, staged_write_if
from .validate import validate_pdf
from .widget_faces import (harvest_appearances, regenerate_appearances_file,
                           stage_appearances_file)


def grayscale(
    file: str,
    output: str,
    gs_path: str = "",
    font_dir: str = "",
) -> dict:
    """Convert a PDF to grayscale using Ghostscript.

    Args:
        file: Input PDF path.
        output: Output PDF path.
        gs_path: Path to the Ghostscript executable.
        font_dir: The bundled fallback faces, for regenerating the appearance
            of a widget that carries none whose value is outside the form
            font's encoding. Without it such a field keeps the appearance the
            producer synthesizes; every other field is unaffected.
    """
    info = validate_pdf(file)

    input_path = Path(file)
    output_path = Path(output)
    # In-place: gs must never write the file it is reading (engine/inplace.py).
    same_file = is_same_file(file, output)
    original_size = input_path.stat().st_size

    scratch = Path(tempfile.mkdtemp(prefix="spectra-grayscale-"))
    try:
        # Widget appearances ride through this same pass as staged pages rather
        # than being flattened into the page and put back unconverted
        # (engine/widget_faces.py). Nothing is staged for a document with no
        # form field, which leaves the producer's input the original file.
        # A widget carrying no appearance is given one first, so the producer
        # has none to synthesize and flatten; everything downstream that reads
        # content reads that copy, or the reattach restores a bare widget.
        forms_input = regenerate_appearances_file(input_path, scratch,
                                                  font_dir) or input_path
        staged, boxes = stage_appearances_file(forms_input, scratch)
        with staged_write_if(same_file, output_path) as gs_target:
            cmd = [
                gs_path,
                "-sDEVICE=pdfwrite",
                "-dCompatibilityLevel=1.5",
                "-sColorConversionStrategy=Gray",
                "-dProcessColorModel=/DeviceGray",
                "-dNOPAUSE",
                "-dQUIET",
                "-dBATCH",
                "-dSAFER",
                f"-sOutputFile={str(gs_target).replace('%', '%%')}",  # % is a gs filename template char (distill review)
                str(staged if staged is not None else forms_input),
            ]

            # Derived budget, not a fixed 300 s (budget.run isolates stdin —
            # gs must never inherit the RPC pipe, the distill review's finding).
            result = budget.gs(
                cmd, what="Ghostscript (grayscale)", path=input_path, pages=info["pages"]
            )
            if result.returncode != 0:
                raise RuntimeError(f"Ghostscript grayscale conversion failed: {result.stderr}")

            forms_source = harvest_appearances(gs_target, forms_input, scratch,
                                               boxes, info["pages"])

            # gs pdfwrite drops /AcroForm and every widget annotation — converting a
            # filled form would silently destroy it. Transplant the fields back onto
            # the regenerated pages (no-op for non-form files), from the file
            # carrying the appearances the producer just converted. Against the
            # STAGED file when in-place — the original must still be readable here.
            reattach_forms_file(forms_source if forms_source is not None
                                else forms_input, gs_target)
    finally:
        shutil.rmtree(scratch, ignore_errors=True)

    return {
        "output": str(output_path),
        "original_size": original_size,
        "output_size": output_path.stat().st_size,
    }
