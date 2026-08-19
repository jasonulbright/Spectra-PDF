"""PostScript/EPS → PDF conversion (distilling) via Ghostscript's
pdfwrite device.

The compress.py invocation template: bundled gs, pdfwrite, -dSAFER (the
input is an untrusted PROGRAM — PostScript is a full language), a DERIVED
time budget (engine/budget.py — a fixed one fails on exactly the big inputs
the op exists for), stderr surfaced on failure. Input honesty is a HEADER check
(`%!`), not an extension check: a PDF fed here would re-render (that's
Repair Tier 2's job), and arbitrary bytes refuse with the reason named.
The output is post-validated by opening it with pikepdf — a zero exit
from gs is not proof of a well-formed PDF.
"""

import os
import tempfile
from pathlib import Path

import pikepdf

from engine import budget
from engine.acroform import adopt_orphan_widget_fields
from engine.pdf_save import save_pdf

# Reuses compress.py's preset vocabulary; 'default' emits no
# -dPDFSETTINGS, leaving Ghostscript's own defaults in place.
PRESETS = {
    "screen": "/screen",       # 72 dpi
    "ebook": "/ebook",         # 150 dpi
    "printer": "/printer",     # 300 dpi
    "prepress": "/prepress",   # 300 dpi + color preservation
}


def _read_header(path: Path) -> bytes:
    with open(path, "rb") as f:
        return f.read(256)


def distill(file: str, output: str, preset: str = "printer", gs_path: str = "") -> dict:
    """Convert a PostScript or EPS file to PDF.

    Args:
        file: Input .ps/.eps path (validated by header, not extension).
        output: Output PDF path (overwritten if present).
        preset: 'screen' | 'ebook' | 'printer' | 'prepress' | 'default'.
        gs_path: Path to the Ghostscript executable.
    """
    input_path = Path(file)
    output_path = Path(output)
    if not input_path.is_file():
        raise ValueError(f"input file not found: {file}")
    # Resolve so the argv token can never start with '-' (a relative name
    # like `-r.ps` parses as a gs SWITCH — worst case a silently blank
    # output that passes post-validation; review-reproduced), and so the
    # same-file comparison below is honest.
    input_path = input_path.resolve()
    if input_path == output_path.resolve():
        # ".ps in, .pdf out" is the contract; writing onto the source
        # destroys it AND mis-reports input_size (review-reproduced).
        raise ValueError("output must be a different file from the input")

    header = _read_header(input_path)
    if not header.startswith(b"%!"):
        if header.startswith(b"%PDF"):
            raise ValueError(
                "this is already a PDF — distilling converts PostScript; "
                "use Repair (Tier 2 rebuild) to re-render a PDF"
            )
        raise ValueError("not a PostScript file (missing the '%!' header)")
    # An EPS declares itself in the first comment line; its page is the
    # bounding box, not a paper size.
    is_eps = b"EPSF" in header.split(b"\n", 1)[0]

    if preset != "default" and preset not in PRESETS:
        raise ValueError(
            f"unknown preset {preset!r} (screen, ebook, printer, prepress, default)"
        )

    cmd = [
        gs_path,
        "-sDEVICE=pdfwrite",
        "-dCompatibilityLevel=1.5",
        "-dNOPAUSE",
        "-dQUIET",
        "-dBATCH",
        "-dSAFER",
    ]
    if preset != "default":
        cmd.append(f"-dPDFSETTINGS={PRESETS[preset]}")
    if is_eps:
        cmd.append("-dEPSCrop")
    # '%' is a TEMPLATE character in -sOutputFile (%d splits per page into
    # renamed files while the literal name never appears — review-
    # reproduced with the dialog's own default naming); escape it so the
    # user's path is literal.
    cmd.extend([f"-sOutputFile={str(output_path).replace('%', '%%')}", str(input_path)])

    # stdin=DEVNULL is LOAD-BEARING, not hygiene: without it gs inherits
    # the ENGINE'S JSON-RPC stdin pipe, and -dSAFER does not sandbox the
    # standard streams — a hostile PostScript program read the next RPC
    # request's bytes off the wire (review-PROVEN, exfiltrated via gs
    # stderr), which both leaks data and permanently hangs that request's
    # caller. EOF from DEVNULL closes the class.
    # The budget is DERIVED from the input (budget.run keeps the
    # stdin isolation the paragraph above is about).
    result = budget.gs(cmd, what="Ghostscript (distill)", path=input_path)
    if result.returncode != 0:
        raise RuntimeError(f"Ghostscript failed: {result.stderr.strip() or 'no diagnostics'}")

    # Post-validate: the result must be a PDF pikepdf can open. In the same
    # pass, register any form-field pdfmarks: gs lands /ANN Widget
    # pdfmarks on the page with their field keys intact but never
    # writes /AcroForm — without adoption a distilled form renders dead.
    adopted = 0
    adopted_tmp: str | None = None
    try:
        with pikepdf.open(output_path) as pdf:
            pages = len(pdf.pages)
            if pages > 0:
                adopted = adopt_orphan_widget_fields(pdf)
                if adopted:
                    fd, adopted_tmp = tempfile.mkstemp(
                        suffix=".pdf", dir=str(output_path.parent)
                    )
                    os.close(fd)
                    save_pdf(pdf, adopted_tmp)
        # The replace happens after the reading handle closes — Windows
        # refuses to replace a file the process still holds open.
        if adopted_tmp is not None:
            os.replace(adopted_tmp, output_path)
            adopted_tmp = None
    except RuntimeError:
        raise
    except Exception as exc:
        raise RuntimeError(f"Ghostscript produced an unreadable PDF: {exc}") from exc
    finally:
        if adopted_tmp is not None and os.path.exists(adopted_tmp):
            os.unlink(adopted_tmp)
    if pages == 0:
        raise RuntimeError("Ghostscript produced a PDF with no pages")

    result_dict = {
        "output": str(output_path),
        "pages": pages,
        "preset": preset,
        "input_size": input_path.stat().st_size,
        "output_size": output_path.stat().st_size,
        "eps": is_eps,
    }
    if adopted:
        result_dict["form_fields_adopted"] = adopted
    return result_dict
