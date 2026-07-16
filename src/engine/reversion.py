"""PDF version conversion using pikepdf."""

from pathlib import Path

import pikepdf


def get_pdf_version(file: str) -> dict:
    """Read the current PDF version of a file.

    Args:
        file: Input PDF path.
    """
    with pikepdf.open(file) as pdf:
        # `pdf_version` is already a string like "1.7" — NOT a (major, minor)
        # tuple. Indexing it took the first two CHARACTERS, so this returned
        # "1.." for every file in existence: '1' + '.' + '.'. Shipped that way,
        # and visible in the Optimize pane's "Current version" the whole time;
        # nothing asserted the value, so nothing noticed.
        return {
            "file": file,
            "version": pdf.pdf_version,
            "pages": len(pdf.pages),
        }


def set_pdf_version(
    file: str,
    output: str,
    version: str = "1.7",
) -> dict:
    """Set the PDF version of a file.

    Args:
        file: Input PDF path.
        output: Output PDF path.
        version: Target PDF version ('1.4', '1.5', '1.6', '1.7', '2.0').
    """
    input_path = Path(file)
    output_path = Path(output)

    with pikepdf.open(file) as pdf:
        original_version = f"{pdf.pdf_version[0]}.{pdf.pdf_version[1]}"
        pdf.save(output_path, min_version=version)

    return {
        "output": str(output_path),
        "original_version": original_version,
        "target_version": version,
        "original_size": input_path.stat().st_size,
        "output_size": output_path.stat().st_size,
    }
