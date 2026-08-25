"""The GWG Processing Steps Test Suite corpus axis, and the one place it is
named.

The suite is fetched, never committed (`scripts/fetch-processing-steps-suite.py`),
so the gate runs on one of two axes and has to say which. The skip tests for
the FILES the table names, not for the directory: the release workflow creates
empty resource directories, and an `isdir` check would pass on a machine
holding no corpus at all — exactly the `gs_axis` lesson.

A corpus that is present but disagrees with the committed table is NOT a skip.
A patch the table names and the corpus does not hold is a failure, and so is a
patch the corpus holds and the table does not name: a suite revision must move
the table with it, deliberately, or the gate stops meaning anything.
"""

from __future__ import annotations

import csv
import pathlib
from dataclasses import dataclass, field

REPO_ROOT = pathlib.Path(__file__).resolve().parents[1]
CORPUS = REPO_ROOT / "processing-steps-corpus"
MANIFEST = CORPUS / "manifest.json"
TABLE = pathlib.Path(__file__).resolve().parent / "processing-steps-expected.tsv"

SUITE_ROOT = CORPUS / "suite" / "Processing Steps Test Suite V1.0"
PATCH_ROOT = SUITE_ROOT / "Patches"

#: The suite's own documentation, which every `verdict` cell is paraphrased
#: from. Never parsed — named so the gate can refuse a corpus that arrived
#: without the document the table's authority rests on.
DOCUMENTATION = SUITE_ROOT / "Processing Steps Test Suite.pdf"

#: The ONE reason a case is skipped. Named as an AXIS: what is absent is the
#: corpus, not a file the repository failed to ship.
PROCESSING_STEPS_AXIS_SKIP = (
    "Processing-steps-corpus axis: the GWG Processing Steps Test Suite v1.0 "
    "is not fetched on this machine (scripts/fetch-processing-steps-suite.py)"
)


@dataclass(frozen=True)
class Row:
    """One patch's documented expectation, as the table records it."""

    id: str
    patch: str
    verdict: str
    status: str
    steps: str
    preflight: str
    ps_inks: str
    notes: str = ""

    @property
    def applicable(self) -> bool:
        return self.status == "applicable"

    @property
    def path(self) -> pathlib.Path:
        return PATCH_ROOT / self.patch

    @property
    def declared_steps(self) -> tuple:
        """`steps` as (group, type) pairs, in /OCGs order."""
        out = []
        for token in self.steps.split(";"):
            if not token:
                continue
            group, _, step_type = token.partition("/")
            out.append((group, step_type))
        return tuple(out)

    @property
    def excluded_inks(self) -> tuple:
        return tuple(n for n in self.ps_inks.split(",") if n)


@dataclass
class Table:
    rows: list = field(default_factory=list)

    def __iter__(self):
        return iter(self.rows)

    def __len__(self):
        return len(self.rows)


def load_table() -> Table:
    """The committed expectations. Read whatever the corpus does or does not
    hold — a table that only parses where the files exist could not report a
    missing patch."""
    rows = []
    with TABLE.open(encoding="utf-8", newline="") as handle:
        for record in csv.reader(handle, delimiter="\t"):
            if not record or record[0].startswith("#") or record[0] == "id":
                continue
            fields = list(record) + [""] * (8 - len(record))
            rows.append(
                Row(
                    id=fields[0],
                    patch=fields[1],
                    verdict=fields[2],
                    status=fields[3],
                    steps=fields[4],
                    preflight=fields[5],
                    ps_inks=fields[6],
                    notes=fields[7],
                )
            )
    return Table(rows)


def corpus_present() -> bool:
    """True when the manifest, the documentation and every file the table
    names are on disk."""
    if not MANIFEST.is_file() or not DOCUMENTATION.is_file():
        return False
    return all(row.path.is_file() for row in load_table())


def patch_files() -> list:
    """Every patch PDF the fetched corpus holds, by file name."""
    if not PATCH_ROOT.is_dir():
        return []
    return sorted(p.name for p in PATCH_ROOT.glob("*.pdf"))
