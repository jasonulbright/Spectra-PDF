"""The preflight fixup pass — the canonical order, the doors, and the refusals.

Every fixup is pinned the same way: apply → re-check → the check no longer
fails → the document still opens and `engine/check.py` reports zero errors.
The last clause is the one that matters, because a fixup that clears a row by
breaking the file has not repaired anything.

The Ghostscript-backed fixups (colour conversion, downsampling, flattening and
the two standard conversions) carry a skip guard rather than a stub: a
substituted result would pin what the substitute does, not what the fixup does.
"""

import json
import os
import pathlib

import pikepdf
import pytest

from engine.check import check as structural_check
from engine.preflight import preflight
from engine.preflight_fixups import (
    AUTHORED_FIXUPS,
    CHECK_FIXUPS,
    FIXUP_ORDER,
    apply_fixups,
    fixups_for_check,
)
from engine.preflight_profiles import FIXUP_IDS
import preflight_builders as builders

REPO = pathlib.Path(__file__).resolve().parents[1]
GS = os.path.join(REPO, "resources", "ghostscript", "gswin64c.exe")
needs_gs = pytest.mark.skipif(
    not os.path.isfile(GS), reason="the bundled Ghostscript is not provisioned"
)


def _profile(fixups, **checks) -> dict:
    """A throwaway rule for one assertion. Total area coverage is off unless a
    test asks for it: its cost is one Ghostscript run per page."""
    resolved = {"ink_coverage_max": {"enabled": False}}
    resolved.update(checks)
    return {
        "schema": 1,
        "id": "test_fixups",
        "name": "Test",
        "checks": resolved,
        "fixups": fixups,
    }


def _status(report, check_id: str) -> str:
    return next(c for c in report["checks"] if c["id"] == check_id)["status"]


def _apply(tmp_path, kind, fixups, *, checks=None, **check_rules):
    source = builders.build(kind, str(tmp_path))
    output = str(tmp_path / "fixed.pdf")
    return source, apply_fixups(
        source, output, profile=_profile(fixups, **check_rules), checks=checks
    )


class TestTheTable:
    def test_every_fixup_the_profiles_may_name_has_a_door(self):
        assert set(FIXUP_ORDER) == set(FIXUP_IDS)

    def test_the_order_names_each_fixup_once(self):
        assert len(FIXUP_ORDER) == len(set(FIXUP_ORDER)) == 20

    def test_hairlines_run_before_flattening(self):
        # A hairline inside a region the flattener rasterizes becomes pixels at
        # the flatten resolution, where nothing can reach it again.
        assert FIXUP_ORDER.index("fix_hairlines") < FIXUP_ORDER.index(
            "flatten_transparency"
        )

    def test_printer_marks_run_after_the_standard_conversion(self):
        # `gs pdfwrite` regenerates every object, so marks added before it lose
        # the record that makes them removable again.
        for standard in ("convert_to_pdfx", "convert_to_pdfa"):
            assert FIXUP_ORDER.index(standard) < FIXUP_ORDER.index("add_printer_marks")

    def test_embedding_runs_before_every_ghostscript_stage(self):
        for later in ("convert_to_cmyk", "convert_to_grayscale", "downsample_images",
                      "flatten_transparency", "convert_to_pdfx", "convert_to_pdfa"):
            assert FIXUP_ORDER.index("embed_missing_fonts") < FIXUP_ORDER.index(later)

    def test_boxes_run_before_marks(self):
        for box in ("set_trim_box", "grow_bleed_box"):
            assert FIXUP_ORDER.index(box) < FIXUP_ORDER.index("add_printer_marks")

    def test_every_check_fixup_is_a_real_fixup(self):
        for check_id, fixups in CHECK_FIXUPS.items():
            assert fixups, check_id
            for fixup in fixups:
                assert fixup in FIXUP_IDS, (check_id, fixup)

    def test_authored_fixups_are_fixups(self):
        assert set(AUTHORED_FIXUPS) <= set(FIXUP_IDS)

    def test_a_check_with_no_fixup_answers_empty(self):
        # A route to the surface that owns the edit is not a fixup, and the
        # panel asks this rather than keeping a second list.
        assert fixups_for_check("ink_coverage_max") == ()
        assert fixups_for_check("not_a_check") == ()


class TestTheOrderIsTheEnginesNotTheProfiles:
    def test_a_profile_listing_backwards_still_runs_forwards(self, tmp_path):
        source, result = _apply(
            tmp_path,
            "has_document_js",
            [
                {"id": "write_xmp", "params": {}},
                {"id": "remove_javascript", "params": {}},
            ],
            document_javascript={"allow_js": False},
            xmp_present={"require_xmp": True},
        )
        assert result["order"] == ["remove_javascript", "write_xmp"]
        assert [entry["fixup"] for entry in result["applied"]] == [
            "remove_javascript",
            "write_xmp",
        ]

    def test_the_result_reports_both_summaries(self, tmp_path):
        _source, result = _apply(
            tmp_path,
            "has_attachment",
            [{"id": "remove_attachments", "params": {}}],
            embedded_files={"allow": False},
        )
        assert result["before"]["failed"] >= 1
        assert result["after"]["failed"] < result["before"]["failed"]
        assert _status(result["report"], "embedded_files") == "pass"


class TestRefusals:
    def test_a_profile_with_no_fixups_names_itself(self, tmp_path):
        source = builders.build("baseline", str(tmp_path))
        with pytest.raises(ValueError, match="carries no fixups"):
            apply_fixups(source, str(tmp_path / "out.pdf"), profile=_profile([]))

    def test_a_subset_the_profile_does_not_carry_names_what_was_asked(self, tmp_path):
        source = builders.build("baseline", str(tmp_path))
        with pytest.raises(ValueError, match="does not carry a fixup"):
            apply_fixups(
                source,
                str(tmp_path / "out.pdf"),
                profile=_profile([{"id": "write_xmp", "params": {}}]),
                checks=["trim_box"],
            )

    def test_a_name_nothing_repairs_is_refused(self, tmp_path):
        source = builders.build("baseline", str(tmp_path))
        with pytest.raises(ValueError, match="nothing repairs"):
            apply_fixups(
                source,
                str(tmp_path / "out.pdf"),
                profile=_profile([{"id": "write_xmp", "params": {}}]),
                checks=["not_a_check_at_all"],
            )

    def test_an_authored_fixup_with_no_value_refuses_by_name(self, tmp_path):
        source = builders.build("no_title", str(tmp_path))
        with pytest.raises(ValueError, match="needs the title to write"):
            apply_fixups(
                source,
                str(tmp_path / "out.pdf"),
                profile=_profile([{"id": "set_document_title", "params": {}}]),
                checks=["title_present"],
            )

    def test_a_trapping_claim_no_machine_may_make_refuses(self, tmp_path):
        source = builders.build("trapped_absent", str(tmp_path))
        with pytest.raises(ValueError, match="only a person may make"):
            apply_fixups(
                source,
                str(tmp_path / "out.pdf"),
                profile=_profile([{"id": "set_trapped", "params": {}}]),
                checks=["trapped_declared"],
            )

    def test_growing_a_bleed_with_no_room_names_the_page(self, tmp_path):
        # `trim_equals_media` has a trim box flush with the sheet, so there is
        # nowhere for a bleed to go. The fixup states it rather than clamping.
        source = builders.build("trim_equals_media", str(tmp_path))
        with pytest.raises(ValueError, match="between its trim and the edge"):
            apply_fixups(
                source,
                str(tmp_path / "out.pdf"),
                profile=_profile([{"id": "grow_bleed_box", "params": {"bleed_pt": 9}}]),
                checks=["bleed_sufficient"],
            )

    def test_an_unknown_page_box_refuses_by_name(self, tmp_path):
        source = builders.build("no_trim_box", str(tmp_path))
        with pytest.raises(ValueError, match="no page box called"):
            apply_fixups(
                source,
                str(tmp_path / "out.pdf"),
                profile=_profile(
                    [{"id": "set_trim_box", "params": {"from_box": "margin"}}]
                ),
                checks=["trim_box"],
            )


class TestRoundTrip:
    """apply → re-check → the check no longer fails, and the file still reads."""

    def _round_trip(self, tmp_path, kind, fixups, check_id, **rules):
        source, result = _apply(tmp_path, kind, fixups, checks=[check_id], **rules)
        assert _status(result["report"], check_id) in ("pass", "not_applicable")
        assert structural_check(result["output"])["summary"]["errors"] == 0
        return source, result

    def test_remove_javascript(self, tmp_path):
        self._round_trip(
            tmp_path, "has_document_js",
            [{"id": "remove_javascript", "params": {}}],
            "document_javascript", document_javascript={"allow_js": False},
        )

    def test_remove_attachments(self, tmp_path):
        self._round_trip(
            tmp_path, "has_attachment",
            [{"id": "remove_attachments", "params": {}}],
            "embedded_files", embedded_files={"allow": False},
        )

    def test_remove_printing_annotations(self, tmp_path):
        self._round_trip(
            tmp_path, "printing_annotation",
            [{"id": "remove_annotations", "params": {"printing_only": True}}],
            "printing_annotations",
        )

    def test_set_trim_box(self, tmp_path):
        _source, result = self._round_trip(
            tmp_path, "no_trim_box",
            [{"id": "set_trim_box", "params": {"from_box": "crop"}}],
            "trim_box",
        )
        with pikepdf.open(result["output"]) as pdf:
            assert "/TrimBox" in pdf.pages[0].obj

    def test_grow_bleed_box(self, tmp_path):
        self._round_trip(
            tmp_path, "bleed_box_at_trim",
            [{"id": "grow_bleed_box", "params": {"bleed_pt": 8.5}}],
            "bleed_sufficient",
        )

    def test_set_document_title(self, tmp_path):
        _source, result = self._round_trip(
            tmp_path, "no_title",
            [{"id": "set_document_title", "params": {"title": "Spring catalogue"}}],
            "title_present", title_present={"require_title": True},
        )
        with pikepdf.open(result["output"]) as pdf:
            assert str(pdf.docinfo["/Title"]) == "Spring catalogue"

    def test_set_trapped(self, tmp_path):
        self._round_trip(
            tmp_path, "trapped_absent",
            [{"id": "set_trapped", "params": {"trapped": "false"}}],
            "trapped_declared", trapped_declared={"require_declared": True},
        )

    def test_write_xmp(self, tmp_path):
        self._round_trip(
            tmp_path, "no_xmp",
            [{"id": "write_xmp", "params": {}}],
            "xmp_present", xmp_present={"require_xmp": True},
        )

    def test_set_pdf_version(self, tmp_path):
        self._round_trip(
            tmp_path, "version_too_new",
            [{"id": "set_pdf_version", "params": {"version": "1.7"}}],
            "pdf_version",
        )

    def test_fix_hairlines(self, tmp_path):
        self._round_trip(
            tmp_path, "hairline_015",
            [{"id": "fix_hairlines", "params": {
                "threshold_pt": 0.25, "replacement_pt": 0.25,
            }}],
            "hairlines_absent",
        )

    def test_spots_to_process_converts_only_the_overflow(self, tmp_path):
        _source, result = self._round_trip(
            tmp_path, "six_spots",
            [{"id": "spots_to_process", "params": {}}],
            "spot_ink_count", spot_ink_count={"max_spots": 2},
        )
        assert result["applied"][0]["changed"] == 4

    @needs_gs
    def test_convert_to_cmyk(self, tmp_path):
        source = builders.build("rgb_content", str(tmp_path))
        result = apply_fixups(
            source,
            str(tmp_path / "fixed.pdf"),
            profile=_profile([{"id": "convert_to_cmyk", "params": {}}]),
            checks=["colour_family"],
            gs_path=GS,
        )
        assert _status(result["report"], "colour_family") in ("pass", "not_applicable")


class TestNoOtherCheckRegressed:
    def test_removing_annotations_leaves_every_other_verdict_alone(self, tmp_path):
        source = builders.build("printing_annotation", str(tmp_path))
        rule = _profile([{"id": "remove_annotations", "params": {}}])
        before = preflight(source, profile=rule)
        result = apply_fixups(source, str(tmp_path / "fixed.pdf"), profile=rule,
                              checks=["printing_annotations"])
        after = {c["id"]: c["status"] for c in result["report"]["checks"]}
        for row in before["checks"]:
            if row["id"] == "printing_annotations":
                continue
            # A fixup that clears its own row by disturbing another has not
            # repaired the document; it has moved the failure.
            assert after[row["id"]] == row["status"], row["id"]


class TestNothingToRepair:
    def test_a_clean_document_still_lands_a_copy(self, tmp_path):
        source = builders.build("baseline", str(tmp_path))
        output = str(tmp_path / "copy.pdf")
        result = apply_fixups(
            source, output,
            profile=_profile([{"id": "remove_attachments", "params": {}}]),
        )
        assert result["applied"] == []
        assert result["skipped"][0]["fixup"] == "remove_attachments"
        # An output that does not exist would report a success that wrote no
        # file.
        assert os.path.isfile(output)
        assert json.dumps(result["before"]) == json.dumps(result["after"])
