"""PDF pre-flight validation — defense-in-depth before Ghostscript.

pikepdf (backed by qpdf) performs structural validation on open:
header, xref table, object streams, page tree. This module gates
GS operations so malformed PDFs never reach the interpreter.
"""

import pikepdf
from engine.credentials import open_pdf

# Configurable limits to prevent resource exhaustion
MAX_PAGES = 50_000
MAX_FILE_SIZE_MB = 2_000  # 2 GB


def validate_pdf(path: str) -> dict:
    """Validate PDF structure via pikepdf. Returns info dict on success, raises on failure.

    Checks performed:
    1. pikepdf.open() — validates header, xref, trailer, object streams
    2. Page count within limits
    3. File size within limits
    4. Page tree is accessible (not just header-valid)
    """
    import os

    file_size = os.path.getsize(path)
    if file_size > MAX_FILE_SIZE_MB * 1024 * 1024:
        raise ValueError(f"File exceeds {MAX_FILE_SIZE_MB} MB limit ({file_size / 1024 / 1024:.0f} MB)")

    # pikepdf.open validates: PDF header magic, xref table, trailer,
    # object stream integrity, cross-reference consistency
    with open_pdf(path) as pdf:
        page_count = len(pdf.pages)

        if page_count > MAX_PAGES:
            raise ValueError(f"Page count {page_count} exceeds {MAX_PAGES} limit")

        # Walk the page tree to verify it's structurally sound
        # (catches corrupted page trees that pass header checks)
        for i, page in enumerate(pdf.pages):
            if i >= 3:
                break  # Spot-check first few pages, don't scan entire document
            _ = page.get("/MediaBox")

    return {
        "pages": page_count,
        "size_bytes": file_size,
    }
