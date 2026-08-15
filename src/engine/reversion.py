"""PDF version conversion using pikepdf."""

from pathlib import Path

import pikepdf
from engine.pdf_save import save_pdf


def _version_tuple(text: str) -> tuple:
    """`"1.7"` as (1, 7), for comparing a target against what a file carries.
    An unreadable header sorts lowest, so a target is never forced against a
    number nobody could read."""
    try:
        parts = str(text).strip().split(".")
        return tuple(int(part) for part in parts[:2])
    except (TypeError, ValueError):
        return ()


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
        # Same string-indexed-as-a-tuple bug as get_pdf_version had, in its
        # sibling twenty lines away — fixed there and missed here on the first
        # pass. It reported "1.." as the BEFORE version in the Optimize pane's
        # "PDF 1.. → PDF 1.7" and in the CLI's JSON. The conversion itself was
        # always correct; only the number it told you about was wrong.
        original_version = pdf.pdf_version
        # `min_version` only ever RAISES the header: asking a 2.0 document for
        # 1.7 left it at 2.0 and reported success. A version this op is told to
        # set is set, so a target BELOW the current one is forced — which is
        # what makes the preflight fixup for `pdf_version` able to clear its
        # own check on a document whose producer wrote a newer header than the
        # RIP will read.
        if _version_tuple(version) < _version_tuple(original_version):
            save_pdf(pdf, output_path, force_version=version)
        else:
            save_pdf(pdf, output_path, min_version=version)

    return {
        "output": str(output_path),
        "original_version": original_version,
        "target_version": version,
        "original_size": input_path.stat().st_size,
        "output_size": output_path.stat().st_size,
    }
