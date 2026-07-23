"""Cross-file text search over PDFs on disk (§ I.5 P4, part 2).

The in-app Find searches the OPEN documents' index; this searches PDFs that are
NOT open, by path, so a user can grep a whole folder. It runs in the engine (off
the render thread) so a big folder — or a pathological regex — can't freeze the
UI, and it honours the SAME three advanced modes as the in-app search: regex,
case-sensitivity, whole-word.

Matching model mirrors the in-app index: each page's extracted text has its
whitespace collapsed to single spaces (so a spaced query matches across the
line breaks pdfminer emits, and a literal query behaves like the in-app one). A
literal query is regex-escaped; a regex query is compiled verbatim; whole-word
wraps `\\b(?:…)\\b`; case-insensitive unless `case_sensitive`. An invalid regex
is reported as an error, never raised.

Bounded + honest: at most `max_files` files and `max_hits_per_file` matching
pages per file are returned, and any truncation or per-file extraction failure
(encrypted/corrupt) is reported rather than silently dropped.
"""

import re

from pdfminer.high_level import extract_pages
from pdfminer.layout import LTTextContainer

_WS = re.compile(r"\s+")
_SNIPPET_RADIUS = 40


def _collapse_ws(text: str) -> str:
    return _WS.sub(" ", text).strip()


def _compile(query: str, regex: bool, case_sensitive: bool, whole_word: bool):
    """(compiled pattern, error). A literal query is escaped; a regex is verbatim.
    Returns (None, None) for an empty query, (None, message) for a bad regex."""
    if regex:
        if query == "":
            return None, None
        pattern = query
    else:
        norm = _collapse_ws(query)
        if norm == "":
            return None, None
        pattern = re.escape(norm)
    if whole_word:
        pattern = r"\b(?:" + pattern + r")\b"
    flags = 0 if case_sensitive else re.IGNORECASE
    try:
        return re.compile(pattern, flags), None
    except re.error as exc:
        return None, str(exc)


def _page_texts(path: str):
    """Yield (1-based page number, whitespace-collapsed text) for each page."""
    for i, layout in enumerate(extract_pages(path)):
        parts = []
        for element in layout:
            if isinstance(element, LTTextContainer):
                parts.append(element.get_text())
        yield i + 1, _collapse_ws("".join(parts))


def _snippet(text: str, match: re.Match) -> str:
    start = max(0, match.start() - _SNIPPET_RADIUS)
    end = min(len(text), match.end() + _SNIPPET_RADIUS)
    return (
        ("…" if start > 0 else "")
        + text[start:end]
        + ("…" if end < len(text) else "")
    )


def _count_and_first(pattern: re.Pattern, text: str):
    """(non-empty-match count, first match or None) — zero-width matches are
    skipped (they aren't visible occurrences) and never loop."""
    count = 0
    first = None
    for m in pattern.finditer(text):
        if m.end() == m.start():
            continue  # zero-width (e.g. `a*`, `\b`) — not an occurrence
        count += 1
        if first is None:
            first = m
    return count, first


def search_in_files(
    paths: list[str],
    query: str,
    regex: bool = False,
    case_sensitive: bool = False,
    whole_word: bool = False,
    max_files: int = 1000,
    max_hits_per_file: int = 200,
) -> dict:
    """Search each PDF in `paths` for `query`, page by page.

    Returns {hits: [{path, page, count, snippet}], files_searched, files_total,
    truncated, errors: [{path, error}], error}. `error` is set (and `hits`
    empty) for an invalid regex.
    """
    pattern, error = _compile(query, regex, case_sensitive, whole_word)
    if error is not None:
        return {
            "hits": [],
            "files_searched": 0,
            "files_total": len(paths or []),
            "truncated": False,
            "errors": [],
            "error": error,
        }
    if pattern is None:  # empty query
        return {
            "hits": [],
            "files_searched": 0,
            "files_total": len(paths or []),
            "truncated": False,
            "errors": [],
            "error": None,
        }

    all_paths = list(paths or [])
    truncated = len(all_paths) > max_files
    scan = all_paths[:max_files]

    hits: list[dict] = []
    errors: list[dict] = []
    searched = 0
    for path in scan:
        searched += 1
        try:
            per_file = 0
            for page_no, text in _page_texts(path):
                if not text:
                    continue
                count, first = _count_and_first(pattern, text)
                if count == 0 or first is None:
                    continue
                hits.append(
                    {
                        "path": path,
                        "page": page_no,
                        "count": count,
                        "snippet": _snippet(text, first),
                    }
                )
                per_file += 1
                if per_file >= max_hits_per_file:
                    break
        except Exception as exc:  # encrypted / corrupt / unreadable — report, continue
            errors.append({"path": path, "error": str(exc)})

    return {
        "hits": hits,
        "files_searched": searched,
        "files_total": len(all_paths),
        "truncated": truncated,
        "errors": errors,
        "error": None,
    }
