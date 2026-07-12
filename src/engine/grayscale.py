"""PDF grayscale conversion via Ghostscript."""

import subprocess
from pathlib import Path

from .acroform import reattach_forms_file
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
    validate_pdf(file)

    input_path = Path(file)
    output_path = Path(output)

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
        f"-sOutputFile={output_path}",
        str(input_path),
    ]

    result = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
    if result.returncode != 0:
        raise RuntimeError(f"Ghostscript grayscale conversion failed: {result.stderr}")

    # gs pdfwrite drops /AcroForm and every widget annotation — converting a
    # filled form would silently destroy it. Transplant the original's fields
    # back onto the regenerated pages (no-op for non-form files).
    reattach_forms_file(input_path, output_path)

    return {
        "output": str(output_path),
        "original_size": input_path.stat().st_size,
        "output_size": output_path.stat().st_size,
    }
