"""Search and redact ONE file, by path -- the headless half of disk scope.

Composes two doors that already exist and re-implements neither: the matcher
and its glyph-accurate rectangles come from ``search_text_regions``, and the
write is either the font-measured redactor (``redact``) or the ``/Redact``
interchange writer (``save_redaction_marks``). Nothing here decides where a
rectangle is or what counts as a match.

There is no review step in a headless run, so this redacts EVERY hit the
request finds. The count is reported so a caller can say so.

The folder scope is NOT reimplemented here: guided actions already walk a
source tree, mirror it and run per-file ops on the copy, from the CLI and from
a scheduled task alike, so this is registered as a step and inherits it.
"""

from pathlib import Path
import shutil

from engine.incremental import signature_policy, signed_edit_decision
from engine.redact import redact
from engine.redact_marks import save_redaction_marks
from engine.search_regions import MAX_HITS_DEFAULT, search_text_regions

# The region keys the two write doors accept, in the format's own vocabulary.
# A key outside this set is refused rather than dropped: a caller that spelled
# `overlayText` and had it silently ignored would ship boxes with no exemption
# code on them.
PROPERTY_KEYS = frozenset(
    {"fill", "overlay_text", "repeat_overlay", "align", "font_size", "text_color"}
)


def search_and_redact(
    file: str,
    output: str,
    query: str = "",
    terms=None,
    patterns=None,
    pages="all",
    regex: bool = False,
    case_sensitive: bool = False,
    whole_word: bool = False,
    expand: str = "match",
    max_hits: int = MAX_HITS_DEFAULT,
    marks_only: bool = False,
    allow_signed: bool = False,
    properties=None,
    font_dir: str = "",
) -> dict:
    """Redact every occurrence of `query` / `terms` / `patterns` in one file.

    Returns ``{output, hits, regions, pages, pages_without_text, truncated,
    marks_only}`` plus the write door's own report.

    `marks_only` writes `/Redact` annotations and removes nothing -- the
    interchange format, for a sweep whose output a person reviews and applies.
    `properties` carries the redaction appearance keys onto every region.

    A document whose own signatures forbid the edit REFUSES; one they merely
    make invalid refuses unless `allow_signed` says the caller accepted that.
    """
    edit_class = "annotate" if marks_only else "structural"
    decision = signed_edit_decision(signature_policy(file), edit_class)
    if decision["kind"] == "refuse":
        raise RuntimeError(
            "this document is certified to allow no changes, so redacting it "
            "would produce a file that reports as illegally modified"
        )
    if decision["kind"] == "warn" and not allow_signed:
        raise RuntimeError(
            "this document is signed and this edit invalidates its signatures "
            "-- the run must state that signed documents are included before "
            "it will touch one"
        )

    extra = dict(properties or {})
    unknown = sorted(set(extra) - PROPERTY_KEYS)
    if unknown:
        raise ValueError(f"unknown redaction property: {unknown[0]}")

    found = search_text_regions(
        file,
        query=query,
        pages=pages,
        regex=regex,
        case_sensitive=case_sensitive,
        whole_word=whole_word,
        terms=terms,
        patterns=patterns,
        expand=expand,
        max_hits=max_hits,
    )
    if found["error"]:
        raise ValueError(f"the search could not be compiled: {found['error']}")

    regions = [
        {"page": hit["page"], "rect": entry["rect"], **extra}
        for hit in found["hits"]
        for entry in hit["rects"]
    ]
    result = {
        "output": str(output),
        "hits": len(found["hits"]),
        "regions": len(regions),
        "pages": sorted({hit["page"] for hit in found["hits"]}),
        "pages_without_text": found["pages_without_text"],
        "truncated": found["truncated"],
        "marks_only": bool(marks_only),
    }

    if not regions:
        # A run that found nothing still owes its caller the output it named --
        # a step in the middle of an action sequence, or a CLI invocation whose
        # next command reads the file. In place there is nothing to write.
        if Path(file).resolve() != Path(output).resolve():
            Path(output).parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(file, output)
        return result

    if marks_only:
        written = save_redaction_marks(file, output, regions)
    else:
        written = redact(file, output, regions, font_dir)
    written.pop("output", None)
    result.update(written)
    return result
