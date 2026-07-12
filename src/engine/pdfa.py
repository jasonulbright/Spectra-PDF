"""PDF/A conversion via Ghostscript."""

import subprocess
from pathlib import Path
from .validate import validate_pdf


def convert_pdfa(
    file: str,
    output: str,
    level: str = "2b",
    gs_path: str = "gs",
) -> dict:
    """Convert a PDF to PDF/A format using Ghostscript.

    Interactive form fields do NOT survive this conversion (gs pdfwrite drops
    them) — and unlike compress/grayscale, they are deliberately NOT
    reattached here: our field appearance streams reference unembedded
    fonts, which PDF/A forbids, so reattaching would silently break the very
    conformance this op exists to produce. Archival conversion of a form is
    flatten-then-convert. (Boundary recorded in
    docs/architecture/16-phase2n-canvas-completeness.md § 2n.4(a).)

    Args:
        file: Input PDF path.
        output: Output PDF path.
        level: PDF/A conformance level ('1b', '2b', '3b').
        gs_path: Path to the Ghostscript executable.
    """
    # Pre-flight: validate PDF structure before passing to Ghostscript
    validate_pdf(file)

    pdfa_level = {"1b": "1", "2b": "2", "3b": "3"}.get(level, "2")

    input_path = Path(file)
    output_path = Path(output)

    # Ghostscript PDF/A conversion requires a PDFA_def.ps preamble
    pdfa_def = (
        f"[ /Title ({input_path.stem})\n"
        f"  /DOCINFO pdfmark\n"
    )

    cmd = [
        gs_path,
        "-dPDFA=" + pdfa_level,
        "-dBATCH",
        "-dNOPAUSE",
        "-dSAFER",
        "-dQUIET",
        "-sDEVICE=pdfwrite",
        "-dPDFACompatibilityPolicy=1",
        f"-sOutputFile={output_path}",
        str(input_path),
    ]

    result = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
    if result.returncode != 0:
        raise RuntimeError(f"Ghostscript PDF/A conversion failed: {result.stderr}")

    return {
        "output": str(output_path),
        "level": f"PDF/A-{level}",
        "original_size": input_path.stat().st_size,
        "output_size": output_path.stat().st_size,
    }
