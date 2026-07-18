"""Tier 2: Deep PDF rebuild via Ghostscript round-trip.

Re-renders every page through the GS interpreter into a fresh PDF.
Fixes font embedding issues, colorspace problems, corrupt content streams.
Slower than Tier 1, may lose interactive elements (form fields, JS actions).
"""

import subprocess
from pathlib import Path


def rebuild(
    file: str,
    output: str,
    gs_path: str = "gs",
) -> dict:
    """Rebuild a PDF by round-tripping through Ghostscript pdfwrite.

    Every page is re-rendered through the GS interpreter, producing a
    completely fresh PDF. This fixes everything that Tier 1 cannot:
    broken fonts, invalid colorspaces, corrupt content streams, etc.

    Args:
        file: Input PDF path.
        output: Output PDF path.
        gs_path: Path to the Ghostscript executable.
    """
    input_path = Path(file)
    output_path = Path(output)

    if not input_path.exists():
        raise FileNotFoundError(f"File not found: {file}")

    original_size = input_path.stat().st_size

    cmd = [
        gs_path,
        "-sDEVICE=pdfwrite",
        "-dCompatibilityLevel=1.7",
        "-dNOPAUSE",
        "-dQUIET",
        "-dBATCH",
        "-dSAFER",
        # Preserve as much fidelity as possible
        "-dPDFSETTINGS=/prepress",
        "-dAutoRotatePages=/None",
        "-dPreserveAnnots=true",
        f"-sOutputFile={str(output_path).replace('%', '%%')}",  # % is a gs filename template char (distill review)
        str(input_path),
    ]

    result = subprocess.run(cmd, capture_output=True, text=True, timeout=600, stdin=subprocess.DEVNULL)  # stdin isolation (distill review)
    if result.returncode != 0:
        stderr = result.stderr.strip()
        raise RuntimeError(f"Ghostscript rebuild failed: {stderr}")

    output_size = output_path.stat().st_size

    # Verify the output is valid by opening with pikepdf
    import pikepdf
    with pikepdf.open(str(output_path)) as pdf:
        page_count = len(pdf.pages)

    return {
        "output": str(output_path),
        "pages": page_count,
        "original_size": original_size,
        "rebuilt_size": output_size,
        "tier": "rebuild",
    }
