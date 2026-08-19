"""PDF compression via Ghostscript, plus the MRC door for scanned documents.

`quality="mrc"` is the ONE door to the MRC pass (`engine/mrc.py`): the panel,
the CLI subcommand, `batch --operation compress`, the guided-actions step,
watched folders and scheduled runs all reach `compress`, so routing MRC
through the same op means every one of those surfaces gains it with no new
dispatch. A second entry point is how a surface gets left behind — the repo's
own "fixed four times at four dispatchers" lesson, applied before the fact.
"""

import shutil
import tempfile
from pathlib import Path

from . import budget
from .acroform import reattach_forms_file
from .inplace import is_same_file, staged_write_if
from .validate import validate_pdf
from .widget_faces import (harvest_appearances, regenerate_appearances_file,
                           stage_appearances_file)


# Ghostscript quality presets map to -dPDFSETTINGS values
QUALITY_PRESETS = {
    "screen": "/screen",       # 72 dpi, smallest
    "ebook": "/ebook",         # 150 dpi, medium
    "printer": "/printer",     # 300 dpi, high
    "prepress": "/prepress",   # 300 dpi, highest
}


#: `quality` values that are NOT a Ghostscript preset.
MRC_QUALITY = "mrc"


def compress(
    file: str,
    output: str,
    quality: str = "ebook",
    dpi: int | None = None,
    gs_path: str = "",
    mrc_preset: str = "balanced",
    mrc_mask_codec: str = "",
    mrc_bg_div: int | None = None,
    mrc_fg_div: int | None = None,
    mrc_pdfa_safe: bool = False,
    mrc_verify_text: bool = False,
    mrc_lang: str = "eng",
    jbig2_path: str = "",
    tesseract_path: str = "",
    font_dir: str = "",
) -> dict:
    """Compress a PDF using Ghostscript, or MRC-layer its scanned pages.

    Args:
        file: Input PDF path.
        output: Output PDF path.
        quality: One of 'screen', 'ebook', 'printer', 'prepress', or 'mrc'.
        dpi: Custom DPI (72-600). When set, overrides quality preset.
        gs_path: Path to the Ghostscript executable.
        mrc_preset: 'archival', 'balanced' or 'smallest' (mrc only).
        mrc_mask_codec: force a stencil codec by name (mrc only) — naming one
            that is unavailable REFUSES instead of silently substituting.
        mrc_bg_div: background downsample divisor override (mrc only).
        mrc_fg_div: foreground downsample divisor override (mrc only).
        mrc_pdfa_safe: keep every filter inside PDF/A-1's set (mrc only).
        mrc_verify_text: recognise the source page and the MRC page and revert
            any page whose text did not survive (mrc only).
        mrc_lang: recognition language for that check (mrc only).
        jbig2_path: explicit path to the vendored JBIG2 encoder (mrc only).
        tesseract_path: explicit path to the vendored recognizer; REQUIRED
            when `mrc_verify_text` is on (mrc only).
        font_dir: The bundled fallback faces, for regenerating the appearance
            of a widget that carries none whose value is outside the form
            font's encoding. Without it such a field keeps the appearance the
            producer synthesizes; every other field is unaffected.

    The `mrc_*` arguments are ignored on the Ghostscript branch, and `dpi` is
    meaningless on the MRC branch (its whole point is that the stencil stays
    at the scan's own resolution) — asking for both refuses rather than
    quietly dropping one.
    """
    if str(quality).strip().lower() == MRC_QUALITY:
        from .mrc import mrc_compress

        if dpi is not None:
            raise ValueError(
                "MRC compression has no DPI setting — the text stays at the scan's own "
                "resolution, which is the point of it. Choose a preset instead."
            )
        return mrc_compress(
            file,
            output,
            preset=mrc_preset,
            mask_codec=mrc_mask_codec,
            bg_div=mrc_bg_div,
            fg_div=mrc_fg_div,
            pdfa_safe=bool(mrc_pdfa_safe),
            verify_text=bool(mrc_verify_text),
            lang=mrc_lang,
            tesseract_path=tesseract_path,
            gs_path=gs_path,
            jbig2_path=jbig2_path,
        )

    # Pre-flight: validate PDF structure before passing to Ghostscript
    info = validate_pdf(file)

    input_path = Path(file)
    output_path = Path(output)
    # In-place: gs must never write the file it is reading — stage beside the
    # output and rename over it after the form reattach (engine/inplace.py).
    same_file = is_same_file(file, output)
    original_size = input_path.stat().st_size

    scratch = Path(tempfile.mkdtemp(prefix="spectra-compress-"))
    try:
        # Widget appearances ride through this same pass as staged pages rather
        # than being flattened into the page and put back alongside it
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

            cmd.extend([f"-sOutputFile={str(gs_target).replace('%', '%%')}",  # % = gs template char (distill review)
                        str(staged if staged is not None else forms_input)])

            # The budget is DERIVED from the input, never the fixed 300 s that
            # a 50 MB scan died on. stdin isolation lives in budget.run — gs
            # must never inherit the RPC pipe (distill review).
            result = budget.gs(cmd, what="Ghostscript (compress)", path=input_path, pages=info["pages"])
            if result.returncode != 0:
                raise RuntimeError(f"Ghostscript failed: {result.stderr}")

            forms_source = harvest_appearances(gs_target, forms_input, scratch,
                                               boxes, info["pages"])

            # gs pdfwrite drops /AcroForm and every widget annotation — compressing a
            # filled form would silently destroy it. Transplant the fields back onto
            # the regenerated pages (no-op for non-form files), from the file
            # carrying the appearances the producer just recompressed. Against the
            # STAGED file when in-place — the original must still be readable here.
            reattach_forms_file(forms_source if forms_source is not None
                                else forms_input, gs_target)
    finally:
        shutil.rmtree(scratch, ignore_errors=True)

    return {
        "output": str(output_path),
        "original_size": original_size,
        "compressed_size": output_path.stat().st_size,
        "quality": quality,
        "dpi": dpi,
    }
