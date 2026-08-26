"""The PDF/A conformance-corpus axis, and the one place it is named.

The two public suites are fetched, never committed (`scripts/fetch-pdfa-corpus.py`
— neither upstream declares a licence), and the clause index the clause-map
tests read is derived from them by `scripts/pdfa-clause-index.py`. So the gate
runs on one of two axes and has to say which.

The presence probe tests for the FILES, not for the directory: the release
workflow creates empty resource directories, and an `isdir` check would pass
on a machine holding no corpus at all — the `gs_axis` lesson. The index is
part of the probe because a fetched corpus with no index is exactly as unusable
to these tests as no corpus.
"""

from __future__ import annotations

import json
import pathlib

REPO_ROOT = pathlib.Path(__file__).resolve().parents[1]
CORPUS = REPO_ROOT / "pdfa-corpus"
MANIFEST = CORPUS / "manifest.json"
INDEX = CORPUS / "clause-index.json"

#: The ONE reason a case is skipped. Named as an AXIS: what is absent is the
#: corpus, not a file the repository failed to ship.
PDFA_CORPUS_AXIS_SKIP = (
    "PDF/A-conformance-corpus axis: the conformance corpus is not fetched on "
    "this machine (scripts/fetch-pdfa-corpus.py, scripts/pdfa-clause-index.py)"
)


def corpus_present() -> bool:
    """True when the fetch manifest and the derived clause index are both on
    disk and the index carries clauses."""
    if not MANIFEST.is_file() or not INDEX.is_file():
        return False
    try:
        return bool(load_index()["clauses"])
    except (OSError, ValueError, KeyError):
        return False


def load_index() -> dict:
    with INDEX.open(encoding="utf-8") as handle:
        return json.load(handle)
