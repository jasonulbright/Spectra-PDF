"""The Ghent PDF Output Suite corpus axis, and the one place it is named.

The suite is fetched, never committed (`scripts/fetch-ghent-suite.py`), so the
gate runs on one of two axes and has to say which. The skip tests for the FILES
the table names, not for the directory: the release workflow creates empty
resource directories, and an `isdir` check would pass on a machine holding no
corpus at all — exactly the `gs_axis` lesson.

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
CORPUS = REPO_ROOT / "ghent-corpus"
MANIFEST = CORPUS / "manifest.json"
TABLE = pathlib.Path(__file__).resolve().parent / "ghent-expected.tsv"

PATCH_ROOT = CORPUS / "patches" / "Ghent_PDF_Output_Suite_V50_Patches" / "Categories"
PAGE_ROOT = CORPUS / "testpages" / "Ghent_PDF_Output_Suite_V50_Testpages"

#: The six assembled PDF/X-4 pages, and the reference page they are read
#: against by eye. The suite's own visual verdict lives here, not in pytest.
ASSEMBLED = PAGE_ROOT / "Ghent_PDF-Output-Test-V50_ALL_X4.pdf"
REFERENCE = PAGE_ROOT / "Ghent_PDF-Output-Test-V50_ALL_REFERENCE.pdf"
ASSEMBLED_PAGES = 6

#: Category directory name by the table's category column.
CATEGORY_DIRS = {"CMYK": "1-CMYK", "SPOT": "2-SPOT", "CMS": "3-ICC-CMS"}

#: The ONE reason a case is skipped. Named as an AXIS: what is absent is the
#: corpus, not a file the repository failed to ship.
CORPUS_AXIS_SKIP = (
    "Ghent-corpus axis: the Ghent PDF Output Suite 5.0 is not fetched on this "
    "machine (scripts/fetch-ghent-suite.py)"
)


@dataclass(frozen=True)
class Row:
    """One patch's documented expectation, as the table records it."""

    id: str
    category: str
    patch: str
    tests: str
    expected: str
    surface: str
    status: str
    checks: tuple = ()
    notes: str = ""

    @property
    def applicable(self) -> bool:
        return self.status == "applicable"

    @property
    def path(self) -> pathlib.Path:
        return PATCH_ROOT / CATEGORY_DIRS[self.category] / "Patches" / self.patch


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
            fields = list(record) + [""] * (9 - len(record))
            checks = tuple(t for t in fields[7].split(",") if t)
            rows.append(
                Row(
                    id=fields[0],
                    category=fields[1],
                    patch=fields[2],
                    tests=fields[3],
                    expected=fields[4],
                    surface=fields[5],
                    status=fields[6],
                    checks=checks,
                    notes=fields[8],
                )
            )
    return Table(rows)


def corpus_present() -> bool:
    """True when the manifest and every file the table names are on disk."""
    if not MANIFEST.is_file() or not ASSEMBLED.is_file() or not REFERENCE.is_file():
        return False
    return all(row.path.is_file() for row in load_table())


def patch_files() -> list:
    """Every patch PDF the fetched corpus holds, by file name."""
    if not PATCH_ROOT.is_dir():
        return []
    return sorted(p.name for p in PATCH_ROOT.rglob("Patches/*.pdf"))
