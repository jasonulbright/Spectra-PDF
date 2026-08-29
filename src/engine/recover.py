"""Tier 3: Salvage recovery from severely damaged PDFs.

Attempts per-page extraction from a corrupt PDF. Salvageable pages are
assembled into a new clean PDF. Reports which pages were recovered and
which were lost.
"""

import pikepdf
from pathlib import Path
from engine.pdf_save import save_pdf


def recover(file: str, output: str) -> dict:
    """Recover salvageable pages from a severely damaged PDF.

    Opens the damaged PDF with pikepdf's recovery mode and attempts to
    extract each page individually. Pages that can be read are assembled
    into a new clean PDF. Pages that raise exceptions are reported as lost.

    Args:
        file: Input PDF path.
        output: Output PDF path.
    """
    input_path = Path(file)
    output_path = Path(output)

    if not input_path.exists():
        raise FileNotFoundError(f"File not found: {file}")

    original_size = input_path.stat().st_size

    # Try to open the damaged file -- pikepdf will attempt recovery
    try:
        source = pikepdf.open(file, suppress_warnings=False)
    except pikepdf.PasswordError:
        raise ValueError("PDF is encrypted -- decrypt before recovery")
    except Exception as e:
        raise RuntimeError(
            f"Cannot open file for recovery: {e}. "
            "File may be completely unreadable."
        )

    total_pages = 0
    recovered_pages = []
    lost_pages = []

    with source:
        try:
            total_pages = len(source.pages)
        except Exception:
            # If we can't even get the page count, try to iterate
            # and count as we go
            pass

        # Create a new clean PDF to assemble recovered pages into
        dest = pikepdf.new()

        if total_pages > 0:
            for i in range(total_pages):
                page_num = i + 1
                try:
                    page = source.pages[i]
                    # Validate the page is actually readable
                    _ = page.get("/MediaBox")
                    dest.pages.append(page)
                    recovered_pages.append(page_num)
                except Exception as e:
                    lost_pages.append({
                        "page": page_num,
                        "error": str(e),
                    })
        else:
            # Page count unknown -- iterate the page tree to count and salvage.
            page_num = 0
            try:
                for page in source.pages:
                    page_num += 1
                    try:
                        _ = page.get("/MediaBox")
                        dest.pages.append(page)
                        recovered_pages.append(page_num)
                    except Exception as e:
                        lost_pages.append({
                            "page": page_num,
                            "error": str(e),
                        })
            except Exception:
                pass  # Iterator itself failed -- we got what we could
            total_pages = page_num

        if len(recovered_pages) == 0:
            dest.close()
            raise RuntimeError(
                "No pages could be recovered. File is completely unreadable."
            )

        save_pdf(
            dest,
            str(output_path),
            encryption_source=source,
            compress_streams=True,
            object_stream_mode=pikepdf.ObjectStreamMode.generate,
        )
        dest.close()

    output_size = output_path.stat().st_size

    return {
        "output": str(output_path),
        "total_pages": total_pages,
        "recovered": len(recovered_pages),
        "recovered_pages": recovered_pages,
        "lost": len(lost_pages),
        "lost_pages": lost_pages,
        "original_size": original_size,
        "recovered_size": output_size,
        "tier": "recover",
    }
