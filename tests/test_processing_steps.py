"""The GWG Processing Steps Test Suite v1.0 gate.

INTERNAL REGRESSION EVIDENCE ONLY. Passing here is not a Ghent Workgroup
certification and it is not an ISO 19593-1 conformance claim — that standard
is not held in this repository, and `src/engine/processing_steps.py` records
the gap and names what the reading IS sourced from. No result from this file
may be worded as certified or conforming.

What the gate can and cannot decide is set out in
`tests/processing-steps-expected.tsv`. Three surfaces are driven against the
committed table, per patch:

  * the Layers listing — the group and type each OCG declares;
  * the ink inventory — the spot colorants painted ONLY by processing-step
    content, which are the ones a plate list must not carry;
  * the preflight check — its status under the baseline profile.

The fourth expectation is about the table itself: our verdict must agree with
the suite's own on every row the table calls `applicable`, and the rows it
calls `not_applicable` must each name the rule that put them there.
"""

from __future__ import annotations

import pikepdf
import pytest

import processing_steps_corpus as corpus
from engine.layers import list_layers
from engine.preflight import preflight
from engine.processing_steps import (
    METADATA_KEY,
    classify,
    document_processing_steps,
    has_second_class_name,
    hide_processing_steps,
    prints_by_default,
    processing_step_ocgs,
)
from engine.separations import list_inks

TABLE = corpus.load_table()
HAS_CORPUS = corpus.corpus_present()

needs_corpus = pytest.mark.skipif(
    not HAS_CORPUS, reason=corpus.PROCESSING_STEPS_AXIS_SKIP
)

APPLICABLE = [row for row in TABLE if row.applicable]


def _ids(rows) -> list:
    return [row.id for row in rows]


# ── the table and the corpus agree about what exists ───────────────────────


def test_the_table_names_every_patch_the_corpus_holds() -> None:
    """A patch with no row is a failure, not a quietly ignored file: a suite
    revision must move the table with it or the gate stops meaning anything."""
    if not HAS_CORPUS:
        pytest.skip(corpus.PROCESSING_STEPS_AXIS_SKIP)
    assert sorted(row.patch for row in TABLE) == corpus.patch_files()


def test_every_row_carries_the_suites_verdict_class() -> None:
    """The suite's rule, read off the id: `G` accept, `E` reject, `W`
    compliant-but-notable. The table may not disagree with the file name it
    names — that is the one cell nobody has to take on trust."""
    expected = {"G": "good", "E": "error", "W": "warning"}
    for row in TABLE:
        assert row.verdict == expected[row.id[-1]], row.id


def test_every_not_applicable_row_names_the_rule_that_excluded_it() -> None:
    """A row excluded from the tally is never silently green."""
    for row in TABLE:
        if row.applicable:
            continue
        assert row.notes.strip(), row.id


def test_the_applicable_rows_are_a_real_share_of_the_suite() -> None:
    """A guard on the gate's own worth. If a change to what is decidable here
    moves this number, it moves deliberately."""
    assert len(APPLICABLE) == 24
    assert len(TABLE) == 40


# ── the surfaces ───────────────────────────────────────────────────────────


@needs_corpus
@pytest.mark.parametrize("row", list(TABLE), ids=_ids(list(TABLE)))
def test_layers_reports_the_declared_processing_steps(row) -> None:
    listing = list_layers(str(row.path))
    declared = tuple(
        (layer["processing_step"]["group"], layer["processing_step"]["type"])
        for layer in listing["layers"]
        if layer["processing_step"] is not None
    )
    assert declared == row.declared_steps
    assert listing["processing_step_count"] == len(row.declared_steps)


@needs_corpus
@pytest.mark.parametrize("row", list(TABLE), ids=_ids(list(TABLE)))
def test_the_ink_inventory_excludes_processing_step_colorants(row) -> None:
    excluded = list_inks(str(row.path))
    assert tuple(excluded["processing_step_inks"]) == row.excluded_inks
    names = {ink["name"] for ink in excluded["inks"]}
    assert names.isdisjoint(row.excluded_inks)

    # The toggle is the whole difference: asking for the processing steps puts
    # every excluded colorant back, and changes nothing else.
    shown = list_inks(str(row.path), show_processing_steps=True)
    assert shown["processing_step_inks"] == []
    assert {ink["name"] for ink in shown["inks"]} == names | set(row.excluded_inks)


@needs_corpus
@pytest.mark.parametrize("row", list(TABLE), ids=_ids(list(TABLE)))
def test_preflight_reports_the_expected_status(row) -> None:
    report = preflight(str(row.path))
    check = next(c for c in report["checks"] if c["id"] == "processing_steps")
    assert check["status"] == row.preflight


@needs_corpus
@pytest.mark.parametrize("row", APPLICABLE, ids=_ids(APPLICABLE))
def test_our_verdict_agrees_with_the_suites(row) -> None:
    """The agreement the table claims, re-derived rather than restated."""
    accepted = {"good": {"pass"}, "warning": {"pass", "warn"},
                "error": {"fail", "needs_review"}}[row.verdict]
    assert row.preflight in accepted


# ── the exclusion mechanism ────────────────────────────────────────────────


@needs_corpus
@pytest.mark.parametrize("row", list(TABLE), ids=_ids(list(TABLE)))
def test_hiding_the_steps_moves_exactly_the_declared_groups(row) -> None:
    """What the preview stages before the device runs: every processing-step
    group off in the default configuration, every artwork layer untouched."""
    with pikepdf.open(str(row.path)) as pdf:
        steps = processing_step_ocgs(pdf)
        moved = hide_processing_steps(pdf)
        assert moved == len(row.declared_steps)
        config = pdf.Root["/OCProperties"]["/D"]
        off = {el.objgen for el in config["/OFF"]}
        on = {el.objgen for el in config["/ON"]}
        assert set(steps) <= off
        assert on.isdisjoint(steps)
        for ocg in pdf.Root["/OCProperties"]["/OCGs"]:
            if ocg.objgen not in steps:
                assert ocg.objgen not in off


@needs_corpus
@pytest.mark.parametrize("row", list(TABLE), ids=_ids(list(TABLE)))
def test_the_report_row_matches_the_layers_listing(row) -> None:
    report = document_processing_steps(str(row.path))
    assert report["count"] == len(row.declared_steps)
    assert tuple((s["group"], s["type"]) for s in report["steps"]) == row.declared_steps
    # Every patch in the suite leaves its steps on and is compliant doing so.
    # If that ever stops being true of the corpus, the check's default —
    # which is off precisely because of it — has to be revisited.
    assert all(step["printing"] for step in report["steps"])


@needs_corpus
def test_the_raster_stages_a_copy_and_never_touches_the_document(tmp_path) -> None:
    """What `render_separations` hands the device when the switch is off.

    A staged COPY: the user's file keeps its own layer states, because which
    layers a document turns on is document state and the preview's exclusion
    is a view.
    """
    from engine.separations import _stage_without_processing_steps

    row = next(r for r in TABLE if r.declared_steps)
    before = row.path.read_bytes()
    staged = _stage_without_processing_steps(row.path, tmp_path)
    assert staged is not None and staged.name == "noprocsteps.pdf"
    assert row.path.read_bytes() == before

    with pikepdf.open(str(staged)) as pdf:
        steps = processing_step_ocgs(pdf)
        off = {el.objgen for el in pdf.Root["/OCProperties"]["/D"]["/OFF"]}
        assert set(steps) <= off


def test_a_document_declaring_no_steps_stages_nothing(tmp_path) -> None:
    """None, not an identical copy: staging a file to change nothing would
    put the coverage measurement on a second document for no reason."""
    from engine.separations import _stage_without_processing_steps

    plain = tmp_path / "plain.pdf"
    pdf = pikepdf.new()
    pdf.add_blank_page()
    pdf.save(str(plain))
    assert _stage_without_processing_steps(plain, tmp_path) is None


# ── the reading itself, without the corpus ─────────────────────────────────


def test_a_type_on_a_group_that_defines_none_is_an_error() -> None:
    assert classify("White", "NotAllowed") == "type_on_untyped_group"
    assert classify("White", "") == "standard"


def test_a_vendor_name_splits_on_its_registered_prefix() -> None:
    assert has_second_class_name("GWGS_Test Suite Custom Group")
    assert not has_second_class_name("NotAllowed")
    assert classify("Structural", "GWGS_Custom") == "custom"
    assert classify("Structural", "NotAllowed") == "unregistered"
    assert classify("GWGS_Custom Group", "") == "custom"
    assert classify("Whatever", "") == "unregistered"


def test_a_metadata_dictionary_naming_no_group_is_not_a_silent_pass() -> None:
    assert classify("", "") == "missing_group"


def test_an_absent_type_never_reads_as_a_type_spelled_none() -> None:
    """`str(None)` is `"None"`. A layer declaring no type and a layer
    declaring a type actually spelled `/None` are different documents."""
    pdf = pikepdf.new()
    pdf.add_blank_page()
    ocg = pdf.make_indirect(
        pikepdf.Dictionary(
            Type=pikepdf.Name.OCG,
            Name="Die line",
            **{METADATA_KEY.lstrip("/"): pikepdf.Dictionary(
                GTS_ProcStepsGroup=pikepdf.Name("/White"))},
        )
    )
    pdf.Root["/OCProperties"] = pikepdf.Dictionary(
        OCGs=pikepdf.Array([ocg]),
        D=pikepdf.Dictionary(ON=pikepdf.Array([ocg]), OFF=pikepdf.Array()),
    )
    steps = processing_step_ocgs(pdf)
    assert list(steps.values())[0]["type"] == ""
    assert list(steps.values())[0]["status"] == "standard"


def test_a_print_usage_of_off_takes_a_group_off_the_print() -> None:
    """The two ways a group stops printing are not the same thing: `/D /OFF`
    hides it everywhere, the usage entry takes it off the plate and leaves it
    on screen."""
    pdf = pikepdf.new()
    ocg = pdf.make_indirect(pikepdf.Dictionary(Type=pikepdf.Name.OCG, Name="Varnish"))
    assert prints_by_default(ocg, set())
    assert not prints_by_default(ocg, {ocg.objgen})
    ocg["/Usage"] = pikepdf.Dictionary(
        Print=pikepdf.Dictionary(Subtype=pikepdf.Name.Print,
                                 PrintState=pikepdf.Name("/OFF"))
    )
    assert not prints_by_default(ocg, set())
