"""PostScript/EPS → PDF conversion (distilling) via Ghostscript's
pdfwrite device.

The compress.py invocation template: bundled gs, pdfwrite, -dSAFER (the
input is an untrusted PROGRAM — PostScript is a full language), a DERIVED
time budget (engine/budget.py — a fixed one fails on exactly the big inputs
the op exists for), stderr surfaced on failure. Input honesty is a HEADER check
(`%!`), not an extension check: a PDF fed here would re-render (that's
Repair Tier 2's job), and arbitrary bytes refuse with the reason named.
A Windows spool stream arrives wrapped in a PJL envelope (UEL, `@PJL`
control lines, `@PJL ENTER LANGUAGE=POSTSCRIPT`) and may carry a UEL/@PJL
trailer; the envelope is parsed off before the header check and a stripped
copy is what reaches Ghostscript, so the distilled input is PostScript
rather than something gs merely tolerates. An envelope declaring another
language refuses by that name.
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


# Universal Exit Language: the escape sequence that opens and closes a PJL
# envelope around a spooled job.
UEL = b"\x1b%-12345X"

# The envelope is control text at both ends of the job; a scan window bounds
# the read so a multi-hundred-megabyte spool is never loaded to find a header.
_ENVELOPE_SCAN = 65536


def _read_prefix(path: Path) -> bytes:
    with open(path, "rb") as f:
        return f.read(_ENVELOPE_SCAN)


def _read_tail(path: Path) -> tuple[bytes, int]:
    """Return the last scan window of the file and the offset it starts at."""
    size = path.stat().st_size
    start = max(0, size - _ENVELOPE_SCAN)
    with open(path, "rb") as f:
        f.seek(start)
        return f.read(), start


def _parse_pjl_prologue(prefix: bytes) -> tuple[int, str | None]:
    """Measure a leading PJL envelope.

    Returns the offset at which the payload begins (0 when there is no
    envelope) and the language the envelope last declared, if any. UEL and
    `@PJL` lines may repeat and interleave; the first line that is neither
    ends the envelope.
    """
    pos = 0
    language: str | None = None
    seen = False
    while pos < len(prefix):
        if prefix.startswith(UEL, pos):
            pos += len(UEL)
            seen = True
            continue
        if prefix.startswith(b"@PJL", pos):
            seen = True
            end = prefix.find(b"\n", pos)
            if end == -1:
                # The envelope runs past the scan window, so no payload is
                # reachable: report no envelope and let the header check
                # refuse on what is actually there.
                return 0, language
            line = prefix[pos:end].rstrip(b"\r")
            upper = line.upper()
            at = upper.find(b"ENTER LANGUAGE")
            if at != -1:
                declared = line[at + len(b"ENTER LANGUAGE") :].lstrip(b" =").strip()
                if declared:
                    language = declared.decode("latin-1")
            pos = end + 1
            continue
        if seen and prefix[pos : pos + 1] in (b"\r", b"\n"):
            pos += 1
            continue
        break
    return (pos if seen else 0), language


def _pjl_trailer_start(data: bytes, payload_start: int) -> int:
    """Return the offset at which a trailing UEL/`@PJL` trailer begins.

    Everything from that UEL to end of file must be UEL, `@PJL` lines, or
    whitespace; otherwise the UEL is job content and nothing is cut.
    """
    floor = max(payload_start, len(data) - _ENVELOPE_SCAN)
    start = len(data)
    at = data.rfind(UEL, floor)
    while at != -1:
        rest = data[at:]
        pos = 0
        while pos < len(rest):
            if rest.startswith(UEL, pos):
                pos += len(UEL)
                continue
            if rest.startswith(b"@PJL", pos):
                end = rest.find(b"\n", pos)
                pos = len(rest) if end == -1 else end + 1
                continue
            if rest[pos : pos + 1] in (b"\r", b"\n", b" ", b"\t", b"\x00"):
                pos += 1
                continue
            break
        if pos >= len(rest):
            # An earlier UEL may open the same trailer (`UEL @PJL EOJ UEL`);
            # the cut belongs at the first one, or a control line survives
            # into the payload.
            start = at
        at = data.rfind(UEL, floor, at)
    return start


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

    prefix = _read_prefix(input_path)
    payload_start, declared_language = _parse_pjl_prologue(prefix)
    header = prefix[payload_start : payload_start + 256]
    if not header.startswith(b"%!"):
        if header.startswith(b"%PDF"):
            raise ValueError(
                "this is already a PDF — distilling converts PostScript; "
                "use Repair (Tier 2 rebuild) to re-render a PDF"
            )
        if declared_language and declared_language.upper() != "POSTSCRIPT":
            raise ValueError(
                "not a PostScript job (it declares "
                f"@PJL ENTER LANGUAGE={declared_language})"
            )
        if header.startswith(b"PK\x03\x04"):
            raise ValueError("not a PostScript job (the payload is a ZIP/XPS package)")
        if not header and payload_start:
            raise ValueError("not a PostScript job (the PJL envelope carries no payload)")
        if not header:
            raise ValueError("not a PostScript file (the file is empty)")
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
    # The bytes gs reads are the payload, never the envelope: a job is
    # distilled from the PostScript that was parsed, not from a wrapper an
    # interpreter might happen to tolerate. Only a job that actually carries
    # an envelope is rewritten, and the copy is chunked — a spool stream has
    # no size bound worth holding in memory.
    tail, tail_offset = _read_tail(input_path)
    payload_end = tail_offset + _pjl_trailer_start(tail, max(0, payload_start - tail_offset))
    gs_input = input_path
    stripped_tmp: str | None = None
    if payload_start or payload_end < tail_offset + len(tail):
        fd, stripped_tmp = tempfile.mkstemp(suffix=".ps", dir=str(output_path.parent))
        with os.fdopen(fd, "wb") as dst, open(input_path, "rb") as src:
            src.seek(payload_start)
            remaining = payload_end - payload_start
            while remaining > 0:
                chunk = src.read(min(remaining, 1 << 20))
                if not chunk:
                    break
                dst.write(chunk)
                remaining -= len(chunk)
        gs_input = Path(stripped_tmp)
    # '%' is a TEMPLATE character in -sOutputFile (%d splits per page into
    # renamed files while the literal name never appears — review-
    # reproduced with the dialog's own default naming); escape it so the
    # user's path is literal.
    cmd.extend([f"-sOutputFile={str(output_path).replace('%', '%%')}", str(gs_input)])

    # stdin=DEVNULL is LOAD-BEARING, not hygiene: without it gs inherits
    # the ENGINE'S JSON-RPC stdin pipe, and -dSAFER does not sandbox the
    # standard streams — a hostile PostScript program read the next RPC
    # request's bytes off the wire (review-PROVEN, exfiltrated via gs
    # stderr), which both leaks data and permanently hangs that request's
    # caller. EOF from DEVNULL closes the class.
    # The budget is DERIVED from the input (budget.run keeps the
    # stdin isolation the paragraph above is about).
    try:
        result = budget.gs(cmd, what="Ghostscript (distill)", path=gs_input)
    finally:
        if stripped_tmp is not None and os.path.exists(stripped_tmp):
            os.unlink(stripped_tmp)
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
