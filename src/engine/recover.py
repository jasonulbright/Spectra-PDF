"""Tier 3: Salvage recovery from severely damaged PDFs.

Attempts per-page extraction from a corrupt PDF. Salvageable pages are
assembled into a new clean PDF. Reports which pages were recovered and
which were lost.
"""

import pikepdf
from pathlib import Path
from engine.acroform import (
    prune_form_to_pages,
    refuse_if_xfa,
    strip_signatures,
)
from engine.pdf_save import save_pdf


def _copy_recovery_page(dest, page):
    """Probe/copy one page; form registration follows after salvage settles.

    Unlike an ordinary split, recovery may not be able to enumerate the source
    page tree. Keep the observed page objects instead of asking add_pages_from
    to resolve indices through that broken tree a second time. The completion
    below carries the single source's complete form through qpdf's same
    foreign-object cache, keeping shared widgets and their field one graph.
    """
    _ = page.get("/MediaBox")
    before = len(dest.pages)
    try:
        dest.pages.append(page)
    except Exception:
        # A failed append must not leave an unreported page in the output.
        while len(dest.pages) > before:
            del dest.pages[-1]
        raise
    return dest.pages[-1]


def _carry_recovered_forms(source, dest, file, complete):
    """Register forms once, then prune widgets belonging to lost pages.

    No second traversal of the damaged source page tree is needed; pruning
    uses the rebuilt tree and qpdf's existing source-to-destination mapping.
    """
    if not complete:
        refuse_if_xfa(source, file, "deleting pages")
    acro = source.Root.get("/AcroForm")
    if acro is None:
        return
    # This is ONE source and its pages were copied exactly once. copy_foreign
    # therefore resolves field roots to the same objects already imported via
    # the widgets. Calling fix_copied_annotations per page creates private
    # field copies and splits a shared field into independent names instead.
    handle = acro if acro.is_indirect else source.make_indirect(acro)
    dest.Root.AcroForm = dest.copy_foreign(handle)
    prune_form_to_pages(dest, range(len(dest.pages)))
    # XFA packet arrays/streams, pure-data fields, inherited defaults and /CO
    # travel with the whole form. /CO is pruned by the same field-forest helper.
    if acro.get("/XFA") is not None and "/NeedsRendering" in source.Root:
        dest.Root.NeedsRendering = source.Root.NeedsRendering
    aa = source.Root.get("/AA")
    if aa is not None:
        handle = aa if aa.is_indirect else source.make_indirect(aa)
        dest.Root.AA = dest.copy_foreign(handle)


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

    with source, pikepdf.new() as dest:
        try:
            total_pages = len(source.pages)
        except Exception:
            # If we can't even get the page count, try to iterate
            # and count as we go
            pass

        enumeration_complete = True
        enumeration_error = None

        if total_pages > 0:
            for i in range(total_pages):
                page_num = i + 1
                try:
                    page = source.pages[i]
                    _copy_recovery_page(dest, page)
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
                        _copy_recovery_page(dest, page)
                        recovered_pages.append(page_num)
                    except Exception as e:
                        lost_pages.append({
                            "page": page_num,
                            "error": str(e),
                        })
            except Exception as e:
                enumeration_complete = False
                enumeration_error = str(e)
            total_pages = page_num

        if len(recovered_pages) == 0:
            raise RuntimeError(
                "No pages could be recovered. File is completely unreadable."
            )

        _carry_recovered_forms(source, dest, file,
                               enumeration_complete and not lost_pages)
        signatures_removed = strip_signatures(dest)

        save_pdf(
            dest,
            str(output_path),
            encryption_source=source,
            compress_streams=True,
            object_stream_mode=pikepdf.ObjectStreamMode.preserve,
        )

    output_size = output_path.stat().st_size

    return {
        "output": str(output_path),
        "total_pages": total_pages,
        # On an interrupted traversal this count is only the observed prefix,
        # not proof of the original document's size or of zero lost pages.
        "page_count_known": enumeration_complete,
        "enumeration_error": enumeration_error,
        "recovered": len(recovered_pages),
        "recovered_pages": recovered_pages,
        "lost": len(lost_pages),
        "lost_pages": lost_pages,
        "original_size": original_size,
        "recovered_size": output_size,
        "signatures_removed": signatures_removed,
        "tier": "recover",
    }
