"""PDF grayscale conversion via Ghostscript."""

from pathlib import Path

from . import budget
from .acroform import reattach_forms_file
from .inplace import finish_staged, is_same_file, staging_target
from .validate import validate_pdf


def grayscale(
    file: str,
    output: str,
    gs_path: str = "gs",
) -> dict:
    """Convert a PDF to grayscale using Ghostscript.

    Args:
        file: Input PDF path.
        output: Output PDF path.
        gs_path: Path to the Ghostscript executable.
    """
    info = validate_pdf(file)

    input_path = Path(file)
    output_path = Path(output)
    # In-place: gs must never write the file it is reading (engine/inplace.py).
    same_file = is_same_file(file, output)
    original_size = input_path.stat().st_size
    gs_target = staging_target(output_path) if same_file else output_path

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
        str(input_path),
    ]

    # Derived budget, not a fixed 300 s (budget.run isolates stdin —
    # gs must never inherit the RPC pipe, the distill review's finding).
    result = budget.gs(
        cmd, what="Ghostscript (grayscale)", path=input_path, pages=info["pages"]
    )
    if result.returncode != 0:
        raise RuntimeError(f"Ghostscript grayscale conversion failed: {result.stderr}")

    # gs pdfwrite drops /AcroForm and every widget annotation — converting a
    # filled form would silently destroy it. Transplant the original's fields
    # back onto the regenerated pages (no-op for non-form files). Against the
    # STAGED file when in-place — the original must still be readable here.
    reattach_forms_file(input_path, gs_target)
    if same_file:
        finish_staged(gs_target, output_path)

    return {
        "output": str(output_path),
        "original_size": original_size,
        "output_size": output_path.stat().st_size,
    }
