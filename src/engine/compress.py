"""PDF compression via Ghostscript."""

import subprocess
from pathlib import Path

from .acroform import reattach_forms_file
from .validate import validate_pdf


# Ghostscript quality presets map to -dPDFSETTINGS values
QUALITY_PRESETS = {
    "screen": "/screen",       # 72 dpi, smallest
    "ebook": "/ebook",         # 150 dpi, medium
    "printer": "/printer",     # 300 dpi, high
    "prepress": "/prepress",   # 300 dpi, highest
}


def compress(
    file: str,
    output: str,
    quality: str = "ebook",
    dpi: int | None = None,
    gs_path: str = "gs",
) -> dict:
    """Compress a PDF using Ghostscript.

    Args:
        file: Input PDF path.
        output: Output PDF path.
        quality: One of 'screen', 'ebook', 'printer', 'prepress'.
        dpi: Custom DPI (72-600). When set, overrides quality preset.
        gs_path: Path to the Ghostscript executable.
    """
    # Pre-flight: validate PDF structure before passing to Ghostscript
    validate_pdf(file)

    input_path = Path(file)
    output_path = Path(output)

    cmd = [
        gs_path,
        "-sDEVICE=pdfwrite",
        "-dCompatibilityLevel=1.5",
        "-dNOPAUSE",
        "-dQUIET",
        "-dBATCH",
        "-dSAFER",
    ]

    if dpi is not None:
        # Custom DPI: explicit downsample flags instead of preset
        cmd.extend([
            "-dDownsampleColorImages=true",
            f"-dColorImageResolution={dpi}",
            "-dDownsampleGrayImages=true",
            f"-dGrayImageResolution={dpi}",
            "-dDownsampleMonoImages=true",
            f"-dMonoImageResolution={dpi}",
        ])
    else:
        # Named preset
        preset = QUALITY_PRESETS.get(quality, "/ebook")
        cmd.append(f"-dPDFSETTINGS={preset}")

    cmd.extend([f"-sOutputFile={output_path}", str(input_path)])

    result = subprocess.run(cmd, capture_output=True, text=True, timeout=300)
    if result.returncode != 0:
        raise RuntimeError(f"Ghostscript failed: {result.stderr}")

    # gs pdfwrite drops /AcroForm and every widget annotation — compressing a
    # filled form would silently destroy it. Transplant the original's fields
    # back onto the regenerated pages (no-op for non-form files).
    reattach_forms_file(input_path, output_path)

    return {
        "output": str(output_path),
        "original_size": input_path.stat().st_size,
        "compressed_size": output_path.stat().st_size,
        "quality": quality,
        "dpi": dpi,
    }
