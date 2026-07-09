"""Text comparison between two PDFs.

Extracts text per page (pdfminer, the same path as extract_text), then diffs
the two documents' line lists with Python's stdlib ``difflib`` — no new
dependency, and the text already lives on the Python side. Output is a
unified-diff-style row list (context / add / remove / gap) with each row
attributed to its source page, plus a summary (similarity, counts, page
counts). Read-only: neither file is modified.

Deliberately stdlib difflib rather than the roadmap's suggested
`diff-match-patch` / `similar` crate — see
docs/architecture/09-phase2g-compare.md. The visual (pixel) diff is a
separate deferred slice.
"""

import difflib

import pikepdf
from pdfminer.high_level import extract_text as pdfminer_extract

# Bound the row payload for pathological diffs. Counts/similarity in the
# summary stay exact past this — only the row detail is truncated.
MAX_ROWS = 5000


def _page_count(file: str) -> int:
    with pikepdf.open(file) as pdf:
        return len(pdf.pages)


def _extract_lines(file: str) -> tuple[list[str], list[int], int]:
    """(lines, page_of_line, page_count). Each line is strip()-normalized;
    blank lines are dropped (pdfminer's layout output is whitespace-noisy and
    content comparison shouldn't flag spacing). page_of_line[i] is the 1-based
    page line i came from."""
    count = _page_count(file)
    lines: list[str] = []
    page_of: list[int] = []
    for i in range(count):
        text = pdfminer_extract(file, page_numbers={i})
        for raw in text.split("\n"):
            line = raw.strip()
            if not line:
                continue
            lines.append(line)
            page_of.append(i + 1)
    return lines, page_of, count


def compare_text(file_a: str, file_b: str, context: int = 3) -> dict:
    """Diff the extracted text of two PDFs.

    Args:
        file_a: First (baseline) PDF path.
        file_b: Second (changed) PDF path.
        context: Unchanged lines of context to keep around each change; longer
            equal runs collapse to a single gap marker.
    """
    lines_a, page_a, count_a = _extract_lines(file_a)
    lines_b, page_b, count_b = _extract_lines(file_b)

    matcher = difflib.SequenceMatcher(a=lines_a, b=lines_b, autojunk=False)
    rows: list[dict] = []
    added = 0
    removed = 0
    truncated = False

    def emit(row: dict) -> None:
        nonlocal truncated
        if len(rows) >= MAX_ROWS:
            truncated = True
            return
        rows.append(row)

    for tag, i1, i2, j1, j2 in matcher.get_opcodes():
        if tag == "equal":
            n = i2 - i1
            if n <= 2 * context + 1:
                for k in range(i1, i2):
                    emit({"type": "context", "text": lines_a[k], "page": page_a[k]})
            else:
                for k in range(i1, i1 + context):
                    emit({"type": "context", "text": lines_a[k], "page": page_a[k]})
                emit({"type": "gap", "count": n - 2 * context})
                for k in range(i2 - context, i2):
                    emit({"type": "context", "text": lines_a[k], "page": page_a[k]})
        elif tag == "delete":
            for k in range(i1, i2):
                removed += 1
                emit({"type": "remove", "text": lines_a[k], "page": page_a[k]})
        elif tag == "insert":
            for k in range(j1, j2):
                added += 1
                emit({"type": "add", "text": lines_b[k], "page": page_b[k]})
        elif tag == "replace":
            for k in range(i1, i2):
                removed += 1
                emit({"type": "remove", "text": lines_a[k], "page": page_a[k]})
            for k in range(j1, j2):
                added += 1
                emit({"type": "add", "text": lines_b[k], "page": page_b[k]})

    return {
        "summary": {
            "identical": added == 0 and removed == 0,
            "similarity": round(matcher.ratio(), 4),
            "lines_added": added,
            "lines_removed": removed,
            "pages_a": count_a,
            "pages_b": count_b,
            "truncated": truncated,
        },
        "rows": rows,
    }
