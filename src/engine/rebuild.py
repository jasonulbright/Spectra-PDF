"""Tier 2: Deep PDF rebuild via Ghostscript round-trip.

Re-renders every page through the GS interpreter into a fresh PDF.
Fixes font embedding issues, colorspace problems, corrupt content streams.
Slower than Tier 1, may lose interactive elements (form fields, JS actions).
"""

from pathlib import Path

from . import budget
from .inplace import staged_write
from .pdf_save import refuse_encrypted_source


def _source_page_count(file: str):
    """The page count QPDF's own reconstruction reads, or None when it cannot
    read the page tree at all.

    Ghostscript's xref repair gives up on damage QPDF reconstructs (an xref
    /Prev chain that loops) and writes the pages it did reach with a zero
    exit status, so a short output is a silent page loss unless it
    is measured against this count.
    """
    import pikepdf
    try:
        pdf = pikepdf.open(file, suppress_warnings=True)
    except Exception:
        return None
    with pdf:
        try:
            return len(pdf.pages)
        except Exception:
            return None


def rebuild(
    file: str,
    output: str,
    gs_path: str = "",
    drop_encryption: bool = False,
) -> dict:
    """Rebuild a PDF by round-tripping through Ghostscript pdfwrite.

    Every page is re-rendered through the GS interpreter, producing a
    completely fresh PDF. This fixes everything that Tier 1 cannot:
    broken fonts, invalid colorspaces, corrupt content streams, etc.

    Args:
        file: Input PDF path.
        output: Output PDF path.
        gs_path: Path to the Ghostscript executable.
        drop_encryption: The user was told the rebuild cannot keep the
            document's protection and chose to proceed. The output is
            unprotected and says so as `encryption_removed`.
    """
    input_path = Path(file)
    output_path = Path(output)

    if not input_path.exists():
        raise FileNotFoundError(f"File not found: {file}")

    # The rebuild runs in a renderer subprocess that reads the document and
    # writes a new one, so the source's encryption cannot ride through.
    encryption_removed = refuse_encrypted_source(
        file, drop_encryption=drop_encryption
    )

    original_size = input_path.stat().st_size
    source_pages = _source_page_count(file)

    # Staged beside the output and swapped in only on success: a failed or
    # refused run leaves whatever file the output path already named intact.
    with staged_write(output_path) as staged:
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
            f"-sOutputFile={str(staged).replace('%', '%%')}",  # % is a gs filename template char
            str(input_path),
        ]

        # Derived budget, not a fixed 600 s (budget.run isolates stdin).
        # base=600: rebuild re-renders every page through the interpreter, and
        # 600 s was its own floor before the derived budget (the rule — the
        # floor never drops).
        result = budget.gs(cmd, what="Ghostscript (rebuild)", path=input_path, base=600.0)
        if result.returncode != 0:
            stderr = result.stderr.strip()
            raise RuntimeError(f"Ghostscript rebuild failed: {stderr}")

        output_size = staged.stat().st_size

        # Verify the output is valid by opening with pikepdf
        import pikepdf
        with pikepdf.open(str(staged)) as pdf:
            page_count = len(pdf.pages)

        if source_pages is not None and page_count < source_pages:
            raise RuntimeError(
                f"The rebuild kept {page_count} of the document's {source_pages} pages, "
                "so it was not saved. Use Repair (Tier 1) or Recover (Tier 3) instead."
            )

    return {
        "output": str(output_path),
        "pages": page_count,
        "original_size": original_size,
        "rebuilt_size": output_size,
        "tier": "rebuild",
        "encryption_removed": encryption_removed,
    }
