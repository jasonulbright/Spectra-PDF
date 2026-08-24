"""The Ghent PDF Output Suite 5.0 gate.

INTERNAL REGRESSION EVIDENCE ONLY. Passing here is not a Ghent Workgroup
conformance certification, and no result from this file may be worded as one.

What this gate can and cannot decide is set out in `tests/ghent-expected.tsv`:
the suite's verdict is visual, so pytest drives the machine-decidable half —
the app's own surfaces reading each patch (ink inventory, overprint state,
colour family, optional content, image construct, output intent) and the real
separation pipeline rasterizing the assembled pages into plates. The visual
half belongs to a human with the reference page.

Every run records the settings it ran under (`ghent-corpus/run-settings.json`).
The suite's own documentation states that application and device settings
affect results, so a result without its settings is not evidence.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

import pikepdf
import pytest

import ghent_corpus as corpus
import gs_axis
from engine import gs_capability
from engine.layers import list_layers
from engine.overprint import list_overprint
from engine.separations import list_inks, render_separations
from engine.soft_proof import read_output_intent

TABLE = corpus.load_table()
HAS_CORPUS = corpus.corpus_present()

needs_corpus = pytest.mark.skipif(not HAS_CORPUS, reason=corpus.CORPUS_AXIS_SKIP)
needs_gs = pytest.mark.skipif(not gs_axis.GS_PATH, reason=gs_axis.PRESENT_AXIS_SKIP)


# ── the settings every result is read against ─────────────────────────────


@pytest.fixture(scope="session", autouse=True)
def run_settings():
    """Record what this run ran under, beside the corpus it ran against."""
    if not HAS_CORPUS:
        return {}
    answer = gs_capability.resolve()
    manifest = json.loads(corpus.MANIFEST.read_text(encoding="utf-8"))
    record = {
        "suite": manifest.get("suite", ""),
        "fetched": manifest.get("fetched", ""),
        "archives": {
            source["key"]: source["archive_sha256"] for source in manifest["sources"]
        },
        "python": sys.version,
        "pikepdf": pikepdf.__version__,
        "ghostscript": {"available": answer.available, "version": answer.version},
        "rows": len(TABLE),
        "applicable": sum(1 for row in TABLE if row.applicable),
        "not_applicable": [row.id for row in TABLE if not row.applicable],
        "evidence": (
            "internal regression evidence only — not a GWG conformance "
            "certification"
        ),
    }
    (corpus.CORPUS / "run-settings.json").write_text(
        json.dumps(record, indent=2) + "\n", encoding="utf-8"
    )
    return record


# ── the table and the corpus agree ────────────────────────────────────────


def test_table_parses_and_states_a_disposition():
    assert TABLE, "the expected-results table is empty"
    for row in TABLE:
        assert row.status in {"applicable", "not_applicable"}, row.id
        assert row.tests and row.expected and row.surface, row.id
        assert row.category in corpus.CATEGORY_DIRS, row.id


def test_not_applicable_rows_carry_their_reason():
    """A row excluded from the tally says why, in its own notes, or it is
    silently green — the thing the F24/F25 discipline exists to prevent."""
    for row in TABLE:
        if row.applicable:
            continue
        assert len(row.notes) > 40, f"{row.id} is not_applicable without a reason"


@needs_corpus
def test_every_table_row_has_its_patch():
    missing = [row.patch for row in TABLE if not row.path.is_file()]
    assert not missing, f"patches the table names and the corpus lacks: {missing}"


@needs_corpus
def test_every_corpus_patch_has_a_table_row():
    """A suite revision moves the table with it, deliberately."""
    named = {row.patch for row in TABLE}
    found = set(corpus.patch_files())
    assert not (found - named), f"patches with no expected-results row: {sorted(found - named)}"


# ── the per-patch checks ──────────────────────────────────────────────────


def _spot_names(path: Path) -> list:
    return [e["name"] for e in list_inks(str(path))["inks"] if e["kind"] == "spot"]


def _declared_opms(path: Path) -> set:
    found = set()
    with pikepdf.open(path) as pdf:
        for obj in pdf.objects:
            try:
                if "/OPM" in obj:
                    found.add(int(obj["/OPM"]))
            except Exception:
                continue
    return found


def _image_facts(path: Path) -> tuple:
    """(decode filters used by image XObjects, the bit depths they carry)."""
    filters: set = set()
    depths: set = set()
    with pikepdf.open(path) as pdf:
        for obj in pdf.objects:
            try:
                if obj.get("/Subtype") != "/Image":
                    continue
                depths.add(int(obj.get("/BitsPerComponent", 8)))
                entry = obj.get("/Filter")
            except Exception:
                continue
            names = entry if isinstance(entry, pikepdf.Array) else [entry]
            for name in names:
                if name is not None:
                    filters.add(str(name).lstrip("/"))
    return filters, depths


def _check(token: str, path: Path) -> None:
    kind, _, argument = token.partition(":")
    if kind == "inks":
        expected = argument.split("|")
        assert _spot_names(path) == expected
    elif kind == "family":
        assert argument in list_inks(str(path))["color_families"]
    elif kind == "overprint":
        report = list_overprint(str(path))
        assert report["paints"], "no overprinting paint was found"
        assert not report["unreadable"], report["unreadable"]
    elif kind == "opm":
        assert int(argument) in _declared_opms(path)
    elif kind == "ocgs":
        assert list_layers(str(path))["count"] > 0
    elif kind == "filter":
        filters, _ = _image_facts(path)
        assert argument in filters
    elif kind == "bpc16":
        _, depths = _image_facts(path)
        assert 16 in depths
    elif kind == "outputintent":
        intent = read_output_intent(str(path))
        assert intent["present"] and intent["embedded"]
    else:
        raise AssertionError(f"the table names a check nothing implements: {token}")


_APPLICABLE = [row for row in TABLE if row.applicable]
_NOT_APPLICABLE = [row for row in TABLE if not row.applicable]


@needs_corpus
@pytest.mark.parametrize("row", _APPLICABLE, ids=[r.id for r in _APPLICABLE])
def test_patch_preconditions(row):
    """The app's own surfaces read the patch as its documentation describes it.

    A failure here means the documented outcome is not even reachable: the
    plate the patch prints on, the overprint it relies on, or the construct it
    is built from did not survive the read.
    """
    assert row.checks, f"{row.id} claims to be applicable and checks nothing"
    for token in row.checks:
        _check(token, row.path)


@needs_corpus
@pytest.mark.parametrize("row", _NOT_APPLICABLE, ids=[r.id for r in _NOT_APPLICABLE])
def test_not_applicable_patch_is_still_present(row):
    """Excluded from the pass tally, never dropped from the corpus: the row
    returns the moment the missing capability exists."""
    assert row.path.is_file()


# ── the assembled pages, through the real separation pipeline ─────────────


PROCESS = ["Cyan", "Magenta", "Yellow", "Black"]


@needs_corpus
def test_assembled_pages_are_six():
    with pikepdf.open(corpus.ASSEMBLED) as pdf:
        assert len(pdf.pages) == corpus.ASSEMBLED_PAGES


@needs_corpus
def test_assembled_ink_inventory_is_whole():
    """No page of the suite may cloud the inventory: an unreadable resource
    branch would mean a plate list the app has not earned."""
    inventory = list_inks(str(corpus.ASSEMBLED))
    assert not inventory["unknown"], inventory["unknown"]
    names = [entry["name"] for entry in inventory["inks"]]
    for spot in ("GWG Green", "PANTONE 265 C"):
        assert spot in names
    for ink in PROCESS:
        assert ink in names


@needs_corpus
def test_assembled_overprint_walk_reads_every_page():
    report = list_overprint(str(corpus.ASSEMBLED))
    assert not report["unreadable"], report["unreadable"]
    assert report["paints"], "the suite is built on overprint and none was found"


@needs_corpus
@needs_gs
@pytest.mark.parametrize("page", range(1, corpus.ASSEMBLED_PAGES + 1))
def test_assembled_page_separates_to_its_own_plates(page):
    """Every assembled page rasterizes to one plate per ink it carries — the
    Output Preview path, not an engine-only shortcut."""
    result = render_separations(
        str(corpus.ASSEMBLED), page=page, dpi=72, gs_path=gs_axis.GS_PATH,
        reuse=False,
    )
    plates = [plate["name"] for plate in result["plates"]]
    assert plates[:4] == PROCESS
    for plate in result["plates"]:
        assert Path(plate["file"]).is_file()
    expected_spots = [
        entry["name"]
        for entry in list_inks(str(corpus.ASSEMBLED), pages=[page])["inks"]
        if entry["kind"] == "spot"
    ]
    assert [name for name in plates if name not in PROCESS] == expected_spots


@needs_corpus
@needs_gs
def test_overprint_simulation_changes_the_spot_page():
    """The suite's core claim is that overprint is visible. Rendering the spot
    page with the simulation off must not produce the same plates as with it
    on, or the setting the whole suite turns on does nothing."""
    page = next(
        number
        for number in range(1, corpus.ASSEMBLED_PAGES + 1)
        if any(
            entry["kind"] == "spot"
            for entry in list_inks(str(corpus.ASSEMBLED), pages=[number])["inks"]
        )
    )
    on = render_separations(
        str(corpus.ASSEMBLED), page=page, dpi=72, gs_path=gs_axis.GS_PATH,
        overprint=True, reuse=False,
    )
    off = render_separations(
        str(corpus.ASSEMBLED), page=page, dpi=72, gs_path=gs_axis.GS_PATH,
        overprint=False, reuse=False,
    )
    same = [
        a["name"]
        for a, b in zip(on["plates"], off["plates"])
        if Path(a["file"]).read_bytes() == Path(b["file"]).read_bytes()
    ]
    assert len(same) < len(on["plates"]), "overprint simulation changed no plate"


@needs_corpus
def test_reference_page_ships_beside_the_assembled_pages():
    """The visual verdict is a human's, and it needs the reference the suite
    supplies. A gate that quietly lost it would leave that half unprovable."""
    with pikepdf.open(corpus.REFERENCE) as pdf:
        assert len(pdf.pages) >= 1
