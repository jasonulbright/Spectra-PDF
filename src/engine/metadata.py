"""PDF metadata editing and stripping using pikepdf."""

from pathlib import Path

import pikepdf

from .inplace import finish_staged, is_same_file, staging_target
from engine.pdf_save import save_pdf


def _rebrand_xmptk(path: Path) -> None:
    """Replace pikepdf's xmptk attribute. Same byte length to preserve linearization."""
    data = path.read_bytes()
    patched = data.replace(b'xmptk="pikepdf"', b'xmptk="SpecPDF"')
    if patched != data:
        path.write_bytes(patched)


def get_metadata(file: str) -> dict:
    """Read metadata from a PDF.

    Args:
        file: Input PDF path.
    """
    with pikepdf.open(file) as pdf:
        with pdf.open_metadata() as meta:
            return {
                "file": file,
                "title": meta.get("dc:title", ""),
                "author": meta.get("dc:creator", ""),
                "subject": meta.get("dc:description", ""),
                "keywords": meta.get("pdf:Keywords", ""),
                "creator": meta.get("xmp:CreatorTool", ""),
                "producer": meta.get("pdf:Producer", ""),
                "pages": len(pdf.pages),
            }


def set_metadata(
    file: str,
    output: str,
    title: str | None = None,
    author: str | None = None,
    subject: str | None = None,
    keywords: str | None = None,
) -> dict:
    """Update metadata on a PDF.

    Args:
        file: Input PDF path.
        output: Output PDF path.
        title: Document title (None = don't change).
        author: Author name (None = don't change).
        subject: Subject/description (None = don't change).
        keywords: Keywords string (None = don't change).
    """
    with pikepdf.open(file) as pdf:
        with pdf.open_metadata() as meta:
            if title is not None:
                meta["dc:title"] = title
            if author is not None:
                meta["dc:creator"] = [author]
            if subject is not None:
                meta["dc:description"] = subject
            if keywords is not None:
                meta["pdf:Keywords"] = keywords

        output_path = Path(output)
        # pikepdf cannot save over its own open input (engine/inplace.py).
        if is_same_file(file, output):
            staged = staging_target(output_path)
            save_pdf(pdf, staged)
            finish_staged(staged, output_path)
        else:
            save_pdf(pdf, output_path)

    return {
        "output": str(output_path),
        "updated_fields": [
            k for k, v in {"title": title, "author": author, "subject": subject, "keywords": keywords}.items()
            if v is not None
        ],
    }


def strip_metadata(file: str, output: str) -> dict:
    """Remove all metadata from a PDF.

    Args:
        file: Input PDF path.
        output: Output PDF path.
    """
    output_path = Path(output)
    # pikepdf cannot save over its own open input (engine/inplace.py).
    same_file = is_same_file(file, output)

    with pikepdf.open(file) as pdf:
        with pdf.open_metadata(
            set_pikepdf_as_editor=False, update_docinfo=False
        ) as meta:
            meta.clear()
        if pikepdf.Name.Info in pdf.trailer:
            del pdf.trailer[pikepdf.Name.Info]
        if same_file:
            staged = staging_target(output_path)
            save_pdf(pdf, staged)
        else:
            save_pdf(pdf, output_path)

    if same_file:
        _rebrand_xmptk(staged)
        finish_staged(staged, output_path)
    else:
        _rebrand_xmptk(output_path)

    return {
        "output": str(output_path),
        "stripped": True,
    }
