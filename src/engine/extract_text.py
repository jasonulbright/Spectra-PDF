"""Text extraction from PDF using pikepdf and pdfminer.six."""

from pathlib import Path

from pdfminer.high_level import extract_text as pdfminer_extract


def extract_text(file: str, pages: list[int] | str = "all", output: str | None = None) -> dict:
    """Extract text from a PDF.

    Args:
        file: Input PDF path.
        pages: List of 1-based page numbers, or 'all'.
        output: optional destination path; the extracted text is written there
            as UTF-8 with no BOM and the path is reported back.
    """
    page_numbers = None
    if pages != "all":
        # pdfminer uses 0-based page indices
        page_numbers = set(p - 1 for p in pages)

    text = pdfminer_extract(file, page_numbers=page_numbers)

    result = {
        "file": file,
        "text": text,
        "length": len(text),
        "pages_extracted": "all" if page_numbers is None else len(page_numbers),
    }
    if output is not None and str(output).strip():
        out_path = Path(output)
        if out_path.is_dir():
            raise ValueError(f"output path is a directory, not a file: {output}")
        out_path.parent.mkdir(parents=True, exist_ok=True)
        # No BOM and no newline translation: the file is a transcription, and a
        # BOM would be read back as a character by every consumer that does not
        # strip one.
        out_path.write_text(text, encoding="utf-8", newline="")
        result["output"] = str(out_path)
    return result
