"""PostScript/EPS → PDF conversion via Ghostscript (Phase 8 — the
Distiller job, done by the tool that is its documented work-alike).

The compress.py invocation template: bundled gs, pdfwrite, -dSAFER (the
input is an untrusted PROGRAM — PostScript is a full language), 300s
timeout, stderr surfaced on failure. Input honesty is a HEADER check
(`%!`), not an extension check: a PDF fed here would re-render (that's
Repair Tier 2's job), and arbitrary bytes refuse with the reason named.
The output is post-validated by opening it with pikepdf — a zero exit
from gs is not proof of a well-formed PDF.
"""

import subprocess
from pathlib import Path

import pikepdf

# Reuses compress.py's preset vocabulary; 'default' emits no
# -dPDFSETTINGS (Ghostscript's own defaults — Distiller's "Standard").
PRESETS = {
    "screen": "/screen",       # 72 dpi — Distiller "Smallest File Size"
    "ebook": "/ebook",         # 150 dpi — "eBook"
    "printer": "/printer",     # 300 dpi — "Print Quality"
    "prepress": "/prepress",   # 300 dpi + color preservation — "Press Quality"
}


def _read_header(path: Path) -> bytes:
    with open(path, "rb") as f:
        return f.read(256)


def distill(file: str, output: str, preset: str = "printer", gs_path: str = "gs") -> dict:
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
    result = subprocess.run(
        cmd, capture_output=True, text=True, timeout=300, stdin=subprocess.DEVNULL
    )
    if result.returncode != 0:
        raise RuntimeError(f"Ghostscript failed: {result.stderr.strip() or 'no diagnostics'}")

    # Post-validate: the result must be a PDF pikepdf can open.
    try:
        with pikepdf.open(output_path) as pdf:
            pages = len(pdf.pages)
    except Exception as exc:
        raise RuntimeError(f"Ghostscript produced an unreadable PDF: {exc}") from exc
    if pages == 0:
        raise RuntimeError("Ghostscript produced a PDF with no pages")

    return {
        "output": str(output_path),
        "pages": pages,
        "preset": preset,
        "input_size": input_path.stat().st_size,
        "output_size": output_path.stat().st_size,
        "eps": is_eps,
    }
