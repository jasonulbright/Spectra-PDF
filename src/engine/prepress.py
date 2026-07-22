"""ICC-managed colour conversion for prepress (Phase 9.S5).

Converts a document's colour to DeviceCMYK for print — the industry editor's
"Convert Colors → Device CMYK". Ghostscript drives the conversion through its
built-in ICC engine (LittleCMS + its compiled-in default CMYK profile), so the
transform is colour-managed even though no external profile is bundled: an RGB
red (`1 0 0 rg`) comes out as CMYK (`0 0.996 1 0 k`), not a naive component
copy.

SCOPE — the colour conversion itself. A user-chosen destination ICC profile,
an embedded PDF/X output intent, and soft-proofing are distinct prepress
capabilities recorded as follow-ons in roadmap § I (they need profile
provisioning + PDF/X conformance); this slice ships the conversion, complete by
its own name.
"""

import subprocess
from pathlib import Path

from .acroform import reattach_forms_file
from .validate import validate_pdf

# Ghostscript render intent for the colour transform. Relative colorimetric
# (1) is the prepress default — it maps in-gamut colours exactly and clips the
# rest, which is what a print house expects; perceptual (0) would shift every
# colour to compress the gamut. 0=perceptual 1=relative 2=saturation 3=absolute.
_RENDER_INTENTS = {"perceptual": 0, "relative": 1, "saturation": 2, "absolute": 3}


def convert_cmyk(
    file: str,
    output: str,
    render_intent: str = "relative",
    gs_path: str = "gs",
) -> dict:
    """Convert a PDF's colour to DeviceCMYK using Ghostscript's ICC engine.

    Args:
        file: Input PDF path.
        output: Output PDF path.
        render_intent: perceptual | relative | saturation | absolute (the ICC
            rendering intent; default relative colorimetric — the prepress norm).
        gs_path: Path to the Ghostscript executable.
    """
    validate_pdf(file)
    intent = _RENDER_INTENTS.get(str(render_intent).strip().lower())
    if intent is None:
        raise ValueError(
            "render_intent must be perceptual, relative, saturation, or absolute."
        )

    input_path = Path(file)
    output_path = Path(output)

    cmd = [
        gs_path,
        "-sDEVICE=pdfwrite",
        "-dCompatibilityLevel=1.5",
        "-sColorConversionStrategy=CMYK",
        "-dProcessColorModel=/DeviceCMYK",
        # Honour the chosen rendering intent for the ICC transform. NB: we do
        # NOT pass -dOverrideICC — that would REPLACE a source object's own
        # embedded ICC profile with gs's default, discarding the accurate source
        # colour description; honouring embedded profiles is the point of a
        # colour-managed conversion.
        f"-dRenderIntent={intent}",
        "-dNOPAUSE",
        "-dQUIET",
        "-dBATCH",
        "-dSAFER",
        # % is a gs filename template char (distill review).
        f"-sOutputFile={str(output_path).replace('%', '%%')}",
        str(input_path),
    ]

    # stdin isolation: gs must never inherit the RPC pipe (distill review).
    result = subprocess.run(
        cmd, capture_output=True, text=True, timeout=300, stdin=subprocess.DEVNULL
    )
    if result.returncode != 0:
        raise RuntimeError(f"Ghostscript CMYK conversion failed: {result.stderr}")

    # gs pdfwrite drops /AcroForm and every widget annotation — converting a
    # filled form would silently destroy it. Transplant the original's fields
    # back onto the regenerated pages (no-op for non-form files) — the same
    # reattach grayscale/compress do.
    reattach_forms_file(input_path, output_path)

    return {
        "output": str(output_path),
        "render_intent": str(render_intent).strip().lower(),
        "original_size": input_path.stat().st_size,
        "output_size": output_path.stat().st_size,
    }
