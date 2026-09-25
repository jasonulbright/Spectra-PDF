"""PDF inspection — page count, dimensions, info, encryption check."""

import math
import os
import tempfile
from pathlib import Path

import pikepdf
from engine.pdf_save import save_pdf


def check_encrypted(file: str) -> dict:
    """Check if a PDF requires credentials to open, and which kind.

    ``kind`` is "password" (standard security handler) or "pubkey"
    (certificate-encrypted, Adobe.PubSec) — the open funnel routes the
    prompt on it. pikepdf raises a generic PdfError for Adobe.PubSec,
    so the classification lives in pubkey_crypt.classify_encryption.
    """
    from engine.pubkey_crypt import classify_encryption

    kind = classify_encryption(file)
    if kind == "none":
        return {"encrypted": False}
    return {"encrypted": True, "kind": kind}


def unlock(file: str, password: str) -> dict:
    """Open an encrypted PDF with password and save decrypted to same path."""
    file_path = Path(file)
    fd, tmp_path = tempfile.mkstemp(suffix=".pdf", dir=file_path.parent)
    os.close(fd)
    try:
        with pikepdf.open(file, password=password) as pdf:
            # Removing the protection IS the operation.
            save_pdf(pdf, tmp_path, drop_encryption=True)
        os.replace(tmp_path, file)
    except Exception:
        if os.path.exists(tmp_path):
            os.unlink(tmp_path)
        raise
    return {"unlocked": True}


def _box_size(box) -> tuple[float | None, float | None]:
    """Width and height of a page box, rounded for display, or None for a
    dimension that does not read. A real too large for a double reads as
    infinity and two of them subtract to NaN; neither is a size, and neither
    can be encoded in a response. The page count stays answerable."""
    w = float(box[2]) - float(box[0])
    h = float(box[3]) - float(box[1])
    return (
        round(w, 1) if math.isfinite(w) else None,
        round(h, 1) if math.isfinite(h) else None,
    )


def get_page_count(file: str) -> dict:
    """Return page count and page dimensions for a PDF."""
    with pikepdf.open(file) as pdf:
        page_sizes = []
        for page in pdf.pages:
            w, h = _box_size(page.trimbox or page.mediabox)
            page_sizes.append({"width": w, "height": h})
        return {
            "file": file,
            "pages": len(pdf.pages),
            "page_sizes": page_sizes,
        }


def get_page_info(file: str, page: int) -> dict:
    """Return details for a single page (1-based)."""
    with pikepdf.open(file) as pdf:
        if page < 1 or page > len(pdf.pages):
            raise ValueError(f"Page {page} out of range (1-{len(pdf.pages)})")
        p = pdf.pages[page - 1]
        w, h = _box_size(p.trimbox or p.mediabox)
        rotation = int(p.get("/Rotate", 0))
        return {
            "page": page,
            "width": w,
            "height": h,
            "rotation": rotation,
        }
