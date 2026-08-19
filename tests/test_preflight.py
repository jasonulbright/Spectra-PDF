"""Preflight — 37 parameterized print-production checks, and the nine profiles.

Every check is pinned TWICE: once on a document that fails it and once on a
document that must not. The second half is what keeps the checker from crying
wolf, and a false failure on a conforming press file is what this inventory
would be turned off over.

`TestUnreadableIsNotAPass` is O15's regression guard, carried forward whole: a
walk that could not read part of a document has not established the document
is clean, and every one of its cases used to report `pass`.
"""

import json
import os
import pathlib
import subprocess

import pytest

from engine.preflight import preflight
from engine.preflight_profiles import (
    CHECK_IDS,
    CHECK_INVENTORY,
    CHECK_PARAMS,
    DEFAULT_PROFILE_ID,
    FIXUP_IDS,
    SHIPPED_PROFILES,
    load_profile_file,
    validate_profile,
)
import preflight_builders as builders

import gs_axis

REPO = pathlib.Path(__file__).resolve().parents[1]
GS = gs_axis.GS_PATH


def _statuses(report) -> dict:
    return {c["id"]: c["status"] for c in report["checks"]}


def _row(report, cid: str) -> dict:
    return next(c for c in report["checks"] if c["id"] == cid)


def _profile(**checks) -> dict:
    """A throwaway rule for one assertion. Handing a profile in as an object
    is the caller's own rule for this run; it is saved nowhere.

    Total area coverage is off unless a test asks for it: its cost is one
    Ghostscript run per page, and it has a class of its own.
    """
    resolved = {"ink_coverage_max": {"enabled": False}}
    resolved.update(checks)
    return {"schema": 1, "id": "test_profile", "name": "Test", "checks": resolved}


def _run(tmp_dir, kind, **checks):
    return preflight(builders.build(kind, tmp_dir), profile=_profile(**checks))


# ── the inventory ─────────────────────────────────────────────────────────


class TestInventory:
    def test_the_report_carries_every_check_in_category_order(self, tmp_dir):
        report = _run(tmp_dir, "baseline")
        assert [c["id"] for c in report["checks"]] == list(CHECK_IDS)
        nested = [c["id"] for cat in report["categories"] for c in cat["checks"]]
        assert nested == list(CHECK_IDS)
        assert len(CHECK_IDS) == 37

    def test_every_row_states_the_rule_it_was_measured_against(self, tmp_dir):
        report = _run(tmp_dir, "baseline")
        for row in report["checks"]:
            assert set(row["params"]) == set(CHECK_PARAMS[row["id"]])

    def test_the_summary_counts_every_row_once(self, tmp_dir):
        summary = _run(tmp_dir, "baseline")["summary"]
        assert (summary["passed"] + summary["failed"] + summary["warnings"]
                + summary["needs_review"] + summary["not_applicable"]) == summary["total"]
        assert summary["applicable"] == summary["total"] - summary["not_applicable"]

    def test_not_applicable_is_excluded_from_the_pass_tally(self, tmp_dir):
        report = _run(tmp_dir, "baseline")
        counted = sum(1 for c in report["checks"] if c["status"] == "pass")
        assert report["summary"]["passed"] == counted
        assert report["summary"]["not_applicable"] > 0

    def test_the_profile_is_named_on_the_report(self, tmp_dir):
        report = preflight(builders.build("baseline", tmp_dir))
        assert report["profile"]["id"] == DEFAULT_PROFILE_ID


# ── one fixture per check, and the twin that must not fail ────────────────


#: fixture that fails · check id · the profile that makes the check apply ·
#: fixture that must NOT fail it.
CASES = [
    ("version_too_new", "pdf_version", {}, "baseline"),
    ("print_denied", "print_permitted", {}, "baseline"),
    ("damaged_xref", "structurally_sound", {}, "baseline"),
    ("no_output_intent", "output_intent", {"output_intent": {"required": True}},
     "with_output_intent"),
    ("wrong_pdfx_claim", "pdfx_claim",
     {"pdfx_claim": {"expected": "PDF/X-1a:2001"}}, "right_pdfx_claim"),
    ("trapped_absent", "trapped_declared",
     {"trapped_declared": {"require_declared": True}}, "trapped_declared"),
    ("has_attachment", "embedded_files", {"embedded_files": {"allow": False}},
     "baseline"),
    ("mixed_page_sizes", "page_size_consistent", {}, "baseline"),
    ("wrong_page_size", "page_size_expected",
     {"page_size_expected": {"width_pt": 612.0, "height_pt": 792.0}}, "baseline"),
    ("no_trim_box", "trim_box", {}, "trim_equals_media"),
    ("bleed_too_small", "bleed_sufficient", {}, "baseline"),
    ("page_count_odd", "page_count", {"page_count": {"multiple_of": 2}},
     "mixed_page_sizes"),
    ("rgb_content", "colour_family", {}, "baseline"),
    ("rgb_content", "grayscale_only", {"grayscale_only": {"require_grayscale": True}},
     "gray_content"),
    ("lab_colour", "device_independent_colour",
     {"device_independent_colour": {"forbidden_families": ["Lab"]}}, "baseline"),
    ("six_spots", "spot_ink_count", {}, "spot_named_all"),
    ("unlisted_spot", "spot_ink_names",
     {"spot_ink_names": {"allowed_names": ["Pantone 300 C"], "allow_unlisted": False}},
     "baseline"),
    ("overprint_white_text", "overprint", {}, "overprint_black_text"),
    ("font_not_embedded", "fonts_embedded", {}, "baseline"),
    ("font_full_not_subset", "fonts_subset",
     {"fonts_subset": {"require_subset": True}}, "baseline"),
    ("type3_font", "type3_fonts", {"type3_fonts": {"allow_type3": False}},
     "type3_in_annotation_appearance"),
    ("type_2pt", "min_type_size", {}, "type_12pt"),
    ("rich_black_small_text", "small_text_k_only", {}, "k_only_small_text"),
    ("image_72dpi", "image_min_dpi_contone", {}, "image_400dpi"),
    ("bitonal_300dpi", "image_min_dpi_bitonal", {}, "baseline"),
    ("image_1200dpi", "image_max_dpi", {"image_max_dpi": {"max_dpi": 450}},
     "image_400dpi"),
    ("jpeg2000_image", "image_compression",
     {"image_compression": {"forbidden_filters": ["/JPXDecode"]}}, "image_400dpi"),
    ("rgb_image_only", "image_colour_space", {}, "baseline"),
    ("live_transparency", "live_transparency", {}, "baseline"),
    ("hairline_015", "hairlines_absent", {}, "baseline"),
    ("has_layers", "optional_content",
     {"optional_content": {"allow_optional_content": False}}, "baseline"),
    ("printing_annotation", "printing_annotations", {}, "hidden_annotation"),
    ("has_form_fields", "interactive_form", {"interactive_form": {"allow_forms": False}},
     "baseline"),
    ("no_title", "title_present", {"title_present": {"require_title": True}}, "titled"),
    ("has_document_js", "document_javascript",
     {"document_javascript": {"allow_js": False}}, "baseline"),
    ("no_xmp", "xmp_present", {"xmp_present": {"require_xmp": True}}, "with_xmp"),
]


def _build(tmp_dir, kind: str) -> str:
    if kind == "damaged_xref":
        return builders.build_damaged(tmp_dir)
    return builders.build(kind, tmp_dir)


class TestEveryCheckFires:
    @pytest.mark.parametrize("kind,cid,rule,_twin", CASES,
                             ids=[c[0] + "-" + c[1] for c in CASES])
    def test_the_failing_document_is_named(self, tmp_dir, kind, cid, rule, _twin):
        report = preflight(_build(tmp_dir, kind), profile=_profile(**rule))
        row = _row(report, cid)
        assert row["status"] in ("fail", "warn"), row
        assert row["findings"], "a dirty verdict must name what produced it"
        assert all(f["detail_key"] for f in row["findings"])

    @pytest.mark.parametrize("_kind,cid,rule,twin", CASES,
                             ids=[c[3] + "-" + c[1] for c in CASES])
    def test_the_twin_does_not_cry_wolf(self, tmp_dir, _kind, cid, rule, twin):
        report = preflight(_build(tmp_dir, twin), profile=_profile(**rule))
        assert _row(report, cid)["status"] not in ("fail", "warn")


class TestTheTwinsThatEarnedTheirOwnName:
    """Each of these was a real way to fail a conforming document."""

    def test_a_separation_named_all_is_not_a_plate(self, tmp_dir):
        report = _run(tmp_dir, "spot_named_all")
        assert _row(report, "spot_ink_count")["status"] == "not_applicable"

    def test_overprinting_black_is_correct_practice(self, tmp_dir):
        assert _row(_run(tmp_dir, "overprint_black_text"), "overprint")["status"] == "pass"

    def test_overprinting_an_ordinary_ink_is_not_a_finding(self, tmp_dir):
        assert _row(_run(tmp_dir, "overprint_ordinary"), "overprint")["status"] == "pass"

    def test_flag_any_reports_the_overprint_the_default_lets_through(self, tmp_dir):
        report = _run(tmp_dir, "overprint_ordinary", overprint={"flag_any": True})
        assert _row(report, "overprint")["status"] == "fail"

    def test_a_trim_box_equal_to_the_media_box_is_a_trim_box(self, tmp_dir):
        assert _row(_run(tmp_dir, "trim_equals_media"), "trim_box")["status"] == "pass"

    def test_a_clipped_placement_has_no_resolution_the_page_shows(self, tmp_dir):
        row = _row(_run(tmp_dir, "image_clipped_out"), "image_min_dpi_contone")
        assert row["status"] == "not_applicable"

    def test_a_rotated_placement_is_measured_by_its_column_norms(self, tmp_dir):
        """A bbox-derived dpi under-reports and would fail a conforming image."""
        row = _row(_run(tmp_dir, "rotated_placement"), "image_min_dpi_contone")
        assert row["status"] == "pass"

    def test_a_non_printing_note_never_reaches_the_plate(self, tmp_dir):
        row = _row(_run(tmp_dir, "hidden_annotation"), "printing_annotations")
        assert row["status"] == "pass"

    def test_a_type3_inside_an_appearance_is_not_page_content(self, tmp_dir):
        report = _run(tmp_dir, "type3_in_annotation_appearance",
                      type3_fonts={"allow_type3": False})
        assert _row(report, "type3_fonts")["status"] == "pass"

    def test_an_unreadable_colorant_branch_reviews_rather_than_counts(self, tmp_dir):
        from separation_builders import unreadable_colorspace_table_pdf

        src = unreadable_colorspace_table_pdf(os.path.join(tmp_dir, "u.pdf"))
        row = _row(preflight(src), "spot_ink_count")
        assert row["status"] == "needs_review"


# ── addressing ────────────────────────────────────────────────────────────


class TestAddressing:
    def test_a_page_finding_names_its_page(self, tmp_dir):
        row = _row(_run(tmp_dir, "no_trim_box"), "trim_box")
        assert row["findings"][0]["address"] == {"kind": "page", "page": 1}

    def test_a_content_finding_carries_a_rectangle(self, tmp_dir):
        row = _row(_run(tmp_dir, "hairline_015"), "hairlines_absent")
        finding = row["findings"][0]
        assert finding["address"]["kind"] == "content"
        assert len(finding["rect"]) == 4

    def test_an_object_finding_names_the_thing_it_is_about(self, tmp_dir):
        report = _run(tmp_dir, "has_form_fields",
                      interactive_form={"allow_forms": False})
        finding = _row(report, "interactive_form")["findings"][0]
        assert finding["address"]["kind"] == "object"
        assert finding["address"]["field"] == "name"

    def test_an_ink_finding_addresses_the_ink_by_name(self, tmp_dir):
        report = _run(
            tmp_dir, "unlisted_spot",
            spot_ink_names={"allowed_names": ["Pantone 300 C"], "allow_unlisted": False},
        )
        finding = _row(report, "spot_ink_names")["findings"][0]
        assert finding["address"] == {"kind": "object", "ink": "HouseGreen"}

    def test_a_finding_never_carries_a_rendered_sentence(self, tmp_dir):
        report = _run(tmp_dir, "rgb_content")
        for row in report["checks"]:
            for finding in row["findings"]:
                assert "detail" not in finding
                assert set(finding) <= {"address", "detail_key", "preview", "rect",
                                        "values"}


# ── not_applicable, in its two kinds ──────────────────────────────────────


class TestNotApplicable:
    def test_nothing_to_check_and_told_not_to_look_are_different_sentences(self, tmp_dir):
        empty = _run(tmp_dir, "baseline")
        nothing = _row(empty, "image_min_dpi_contone")
        assert nothing["status"] == "not_applicable"
        assert nothing["findings"] == []

        off = _run(tmp_dir, "baseline", image_min_dpi_contone={"enabled": False})
        told = _row(off, "image_min_dpi_contone")
        assert told["status"] == "not_applicable"
        assert [f["detail_key"] for f in told["findings"]] == ["check_disabled"]
        assert told["data"]["na_reason"] == "disabled"

    def test_a_disabled_check_is_never_a_pass(self, tmp_dir):
        report = _run(tmp_dir, "rgb_content", colour_family={"enabled": False})
        assert _row(report, "colour_family")["status"] == "not_applicable"
        assert report["summary"]["passed"] < report["summary"]["total"]


# ── severity is the profile's ─────────────────────────────────────────────


class TestSeverityIsTheProfiles:
    def test_one_document_and_two_profiles_give_two_answers(self, tmp_dir):
        src = builders.build("rgb_content", tmp_dir)
        strict = preflight(src, profile=_profile(colour_family={"severity": "fail"}))
        soft = preflight(src, profile=_profile(colour_family={"severity": "warn"}))
        assert _row(strict, "colour_family")["status"] == "fail"
        assert _row(soft, "colour_family")["status"] == "warn"
        assert (_row(strict, "colour_family")["findings"]
                == _row(soft, "colour_family")["findings"])

    def test_a_parameter_moves_the_verdict(self, tmp_dir):
        src = builders.build("image_72dpi", tmp_dir)
        assert _row(preflight(src, profile=_profile(
            image_min_dpi_contone={"min_dpi": 300})), "image_min_dpi_contone",
        )["status"] == "fail"
        assert _row(preflight(src, profile=_profile(
            image_min_dpi_contone={"min_dpi": 50})), "image_min_dpi_contone",
        )["status"] == "pass"


# ── total area coverage ───────────────────────────────────────────────────


@gs_axis.requires_gs
class TestTotalAreaCoverage:
    def test_the_per_pixel_maximum_is_what_is_reported(self, tmp_dir):
        src = builders.build("tac_360", tmp_dir)
        row = _row(preflight(src, gs_path=GS), "ink_coverage_max")
        assert row["status"] == "fail"
        measured = row["findings"][0]["values"]["max_tac"]
        # The device's own average would report 200 % here. The per-pixel
        # maximum is the only figure a press limit can be read against.
        assert measured > 340

    def test_a_document_under_the_limit_passes(self, tmp_dir):
        src = builders.build("tac_under", tmp_dir)
        assert _row(preflight(src, gs_path=GS), "ink_coverage_max")["status"] == "pass"

    def test_pages_beyond_the_budget_are_reviewed_by_name_never_sampled(self, tmp_dir):
        src = builders.build("page_count_odd", tmp_dir)
        report = preflight(src, gs_path=GS,
                           profile=_profile(ink_coverage_max={"max_pages_measured": 1}))
        row = _row(report, "ink_coverage_max")
        assert row["status"] == "needs_review"
        budget = [f for f in row["findings"]
                  if f["detail_key"] == "tac_budget_exceeded"]
        assert budget and budget[0]["values"]["pages"] == 2


class TestTotalAreaCoverageWithoutGhostscript:
    def test_a_missing_tool_reviews_rather_than_refuses(self, tmp_dir):
        src = builders.build("tac_360", tmp_dir)
        row = _row(preflight(src, gs_path="no-such-ghostscript"), "ink_coverage_max")
        assert row["status"] == "needs_review"
        assert row["findings"][0]["detail_key"] == "tac_not_measured"


# ── the profiles ──────────────────────────────────────────────────────────


class TestProfiles:
    def test_nine_profiles_ship_and_all_of_them_validate(self):
        assert len(SHIPPED_PROFILES) == 9
        for profile in SHIPPED_PROFILES.values():
            validate_profile(profile, allow_shipped_id=True)

    def test_every_check_a_profile_names_is_in_the_inventory(self):
        for profile in SHIPPED_PROFILES.values():
            for cid in profile["checks"]:
                assert cid in CHECK_PARAMS, f"{profile['id']} names {cid}"

    def test_every_fixup_a_profile_names_is_one_this_app_performs(self):
        for profile in SHIPPED_PROFILES.values():
            for fixup in profile["fixups"]:
                assert fixup["id"] in FIXUP_IDS

    def test_the_numbers_are_pinned_as_data(self):
        """A silent change to any of these is a change to what the product
        claims about a press."""
        pinned = {
            "sheetfed_offset": (300.0, 300, 1200, 450, 8.5, 0.25, 2, "1.7"),
            "web_offset_heatset": (300.0, 250, 1000, 400, 8.5, 0.30, 2, "1.7"),
            "newsprint": (240.0, 200, 800, 300, 8.5, 0.40, 1, "1.7"),
            "digital_printing": (280.0, 200, 600, 400, 8.5, 0.25, 0, "1.7"),
            "large_format": (300.0, 100, 300, 200, 36.0, 0.50, 2, "1.7"),
        }
        for pid, expected in pinned.items():
            checks = SHIPPED_PROFILES[pid]["checks"]
            assert (
                checks["ink_coverage_max"]["max_tac_pct"],
                checks["image_min_dpi_contone"]["min_dpi"],
                checks["image_min_dpi_bitonal"]["min_dpi"],
                checks["image_max_dpi"]["max_dpi"],
                checks["bleed_sufficient"]["min_bleed_pt"],
                checks["hairlines_absent"]["threshold_pt"],
                checks["spot_ink_count"]["max_spots"],
                checks["pdf_version"]["max_version"],
            ) == expected

    def test_the_standards_profiles_carry_the_versions_the_converter_encodes(self):
        from engine.prepress import _PDFX_VERSIONS

        assert SHIPPED_PROFILES["pdfx_1a"]["checks"]["pdf_version"]["max_version"] == \
            _PDFX_VERSIONS[1]
        assert SHIPPED_PROFILES["pdfx_3"]["checks"]["pdf_version"]["max_version"] == \
            _PDFX_VERSIONS[3]
        assert SHIPPED_PROFILES["pdfx_4"]["checks"]["pdf_version"]["max_version"] == \
            _PDFX_VERSIONS[4]

    def test_x3_differs_from_x1a_in_exactly_one_check(self):
        one_a = SHIPPED_PROFILES["pdfx_1a"]["checks"]
        three = SHIPPED_PROFILES["pdfx_3"]["checks"]
        differing = {
            cid for cid in set(one_a) | set(three)
            if one_a.get(cid) != three.get(cid)
        }
        assert differing == {"pdfx_claim", "device_independent_colour"}

    def test_x4_permits_transparency_and_optional_content(self):
        checks = SHIPPED_PROFILES["pdfx_4"]["checks"]
        assert checks["live_transparency"]["enabled"] is False
        assert checks["optional_content"]["enabled"] is False

    def test_the_flatten_fixup_runs_at_the_profiles_own_contone_minimum(self):
        """A region raster at the flattener's default dpi under a 300 dpi
        minimum clears one check by raising another."""
        for pid in ("sheetfed_offset", "web_offset_heatset", "newsprint"):
            profile = SHIPPED_PROFILES[pid]
            flatten = next(f for f in profile["fixups"]
                           if f["id"] == "flatten_transparency")
            assert flatten["params"]["dpi"] == \
                profile["checks"]["image_min_dpi_contone"]["min_dpi"]

    def test_the_bleed_figure_is_the_trees_own(self):
        from engine.printer_marks import _DEFAULT_BLEED_PT

        assert SHIPPED_PROFILES["sheetfed_offset"]["checks"]["bleed_sufficient"][
            "min_bleed_pt"] == _DEFAULT_BLEED_PT

    def test_the_hairline_figure_is_the_trees_own(self):
        from engine.hairlines import DEFAULT_THRESHOLD_PT

        assert SHIPPED_PROFILES["sheetfed_offset"]["checks"]["hairlines_absent"][
            "threshold_pt"] == DEFAULT_THRESHOLD_PT

    def test_the_box_checks_are_a_warning_outside_the_standards(self):
        """A great many printable documents carry no trim box because their
        producer never wrote one. A failure there trains people to ignore the
        panel."""
        for pid in ("sheetfed_offset", "web_offset_heatset", "newsprint",
                    "digital_printing", "large_format"):
            assert SHIPPED_PROFILES[pid]["checks"]["trim_box"]["severity"] == "warn"
        for pid in ("pdfx_1a", "pdfx_3", "pdfx_4"):
            assert SHIPPED_PROFILES[pid]["checks"]["trim_box"]["severity"] == "fail"


class TestProfileRoundTrip:
    def test_export_then_import_is_identity(self, tmp_dir):
        derived = validate_profile({
            "schema": 1, "id": "house", "name": "House rule",
            "based_on": "sheetfed_offset",
            "checks": {"ink_coverage_max": {"severity": "warn", "max_tac_pct": 280.0}},
            "fixups": [{"id": "fix_hairlines", "params": {"replacement_pt": 0.3}}],
        })
        path = os.path.join(tmp_dir, "house.json")
        with open(path, "w", encoding="utf8") as handle:
            json.dump(derived, handle)
        assert load_profile_file(path) == derived

    def test_a_profile_file_drives_a_run(self, tmp_dir):
        path = os.path.join(tmp_dir, "house.json")
        with open(path, "w", encoding="utf8") as handle:
            json.dump({"schema": 1, "id": "house", "name": "House",
                       "checks": {"colour_family": {"severity": "warn"}}}, handle)
        src = builders.build("rgb_content", tmp_dir)
        report = preflight(src, profile_path=path)
        assert report["profile"]["id"] == "house"
        assert _row(report, "colour_family")["status"] == "warn"


class TestProfileRefusals:
    def test_an_unknown_schema_names_the_one_it_reads(self):
        with pytest.raises(ValueError, match="schema 1"):
            validate_profile({"schema": 9, "id": "x"})

    def test_an_unknown_check_id_is_named(self):
        with pytest.raises(ValueError, match="colour_famly"):
            validate_profile({"id": "x", "checks": {"colour_famly": {}}})

    def test_an_unknown_parameter_names_the_check_and_the_parameter(self):
        with pytest.raises(ValueError, match="min_dpo"):
            validate_profile({"id": "x",
                              "checks": {"image_min_dpi_contone": {"min_dpo": 300}}})

    def test_a_parameter_out_of_range_names_the_value_and_the_bound(self):
        with pytest.raises(ValueError, match="greater than zero"):
            validate_profile({"id": "x",
                              "checks": {"ink_coverage_max": {"max_tac_pct": 0}}})

    def test_a_severity_outside_fail_and_warn_refuses(self):
        with pytest.raises(ValueError, match="severity"):
            validate_profile({"id": "x", "checks": {"trim_box": {"severity": "pass"}}})

    def test_an_unknown_fixup_id_is_named(self):
        with pytest.raises(ValueError, match="make_it_nice"):
            validate_profile({"id": "x", "fixups": [{"id": "make_it_nice"}]})

    def test_naming_both_colour_conversions_refuses(self):
        with pytest.raises(ValueError, match="cannot both run"):
            validate_profile({"id": "x", "fixups": [
                {"id": "convert_to_cmyk"}, {"id": "convert_to_grayscale"}]})

    def test_naming_both_standard_conversions_refuses(self):
        with pytest.raises(ValueError, match="cannot both run"):
            validate_profile({"id": "x", "fixups": [
                {"id": "convert_to_pdfx"}, {"id": "convert_to_pdfa"}]})

    def test_a_downsample_below_the_profiles_own_minimum_refuses(self):
        with pytest.raises(ValueError, match="create the failure it is meant to clear"):
            validate_profile({
                "id": "x",
                "checks": {"image_min_dpi_contone": {"min_dpi": 300}},
                "fixups": [{"id": "downsample_images", "params": {"dpi": 150}}],
            })

    def test_a_user_profile_may_not_claim_a_shipped_id(self):
        with pytest.raises(ValueError, match="cannot be replaced"):
            validate_profile({"id": "sheetfed_offset", "name": "Mine"})

    def test_naming_both_a_profile_and_a_file_refuses(self, tmp_dir):
        src = builders.build("baseline", tmp_dir)
        with pytest.raises(ValueError, match="not both"):
            preflight(src, profile="sheetfed_offset", profile_path="x.json")

    def test_an_unknown_profile_id_names_the_shipped_ones(self, tmp_dir):
        src = builders.build("baseline", tmp_dir)
        with pytest.raises(ValueError, match="sheetfed_offset"):
            preflight(src, profile="no_such_press")

    def test_a_profile_file_that_is_not_json_refuses_and_imports_nothing(self, tmp_dir):
        path = os.path.join(tmp_dir, "bad.json")
        with open(path, "w", encoding="utf8") as handle:
            handle.write("{not json")
        with pytest.raises(ValueError, match="not valid JSON"):
            load_profile_file(path)


# ── O15's guard, carried forward ──────────────────────────────────────────


class TestUnreadableIsNotAPass:
    """A check that could not look everywhere reports `needs_review`.

    Every case here used to report `pass`: the walk swallowed the branch, the
    fact it was carrying never arrived, and the absence was rendered as a
    clean document. A positive finding is still certain, so `warn` and `fail`
    stand whatever else could not be read.
    """

    def test_an_unreadable_colorspace_table_cannot_pass_the_colour_check(self, tmp_dir):
        report = _run(tmp_dir, "unreadable_colorspace")
        assert _statuses(report)["colour_family"] == "needs_review"
        assert report["unreadable"], "the skipped branch must be named"

    def test_an_unreadable_font_cannot_pass_the_embedding_check(self, tmp_dir):
        assert _statuses(_run(tmp_dir, "unreadable_font"))["fonts_embedded"] == \
            "needs_review"

    def test_an_unreadable_graphics_state_cannot_pass_the_transparency_check(self, tmp_dir):
        assert _statuses(_run(tmp_dir, "unreadable_extgstate"))["live_transparency"] == \
            "needs_review"

    def test_an_unreadable_xobject_clouds_every_check_it_could_have_carried(self, tmp_dir):
        statuses = _statuses(_run(tmp_dir, "unreadable_xobject"))
        # A form XObject can hold a font, a colorant and a transparency group.
        assert statuses["fonts_embedded"] == "needs_review"
        assert statuses["colour_family"] == "needs_review"
        assert statuses["live_transparency"] == "needs_review"

    def test_an_unparseable_page_cannot_pass_the_hairline_check(self, tmp_dir):
        assert _statuses(_run(tmp_dir, "unparseable_page"))["hairlines_absent"] == \
            "needs_review"

    def test_a_positive_finding_still_stands(self, tmp_dir):
        """RGB found is RGB found — an unreadable branch elsewhere never
        downgrades a finding into a question."""
        statuses = _statuses(_run(tmp_dir, "rgb_and_unreadable_xobject"))
        assert statuses["colour_family"] == "fail"
        assert statuses["fonts_embedded"] == "fail"

    def test_a_readable_document_reviews_nothing(self, tmp_dir):
        report = _run(tmp_dir, "baseline")
        assert report["summary"]["needs_review"] == 0
        assert report["unreadable"] == []

    def test_one_broken_table_never_sinks_the_walk(self, tmp_dir):
        """The enumeration used to run unguarded: a table that is not a
        dictionary raised out of the walk and took the whole report with it."""
        report = _run(tmp_dir, "unreadable_colorspace")
        assert report["summary"]["total"] == 37

    def test_a_font_only_inside_a_form_is_still_found(self, tmp_dir):
        assert _statuses(_run(tmp_dir, "font_inside_form"))["fonts_embedded"] == "fail"

    def test_a_font_only_inside_a_type3_glyph_procedure_is_still_found(self, tmp_dir):
        """A per-page walk stops at the Type 3 font dictionary and never
        enters its glyph procedures, so this document reported a PASS over a
        face that carries no program."""
        assert _statuses(_run(tmp_dir, "font_inside_type3_glyph"))["fonts_embedded"] \
            == "fail"

    def test_a_font_only_in_the_form_default_resources_is_still_found(self, tmp_dir):
        """`/AcroForm /DR` hangs off the catalog, so no page walk reaches it
        and this document reported as carrying no fonts at all."""
        assert _statuses(_run(tmp_dir, "font_inside_form_default_resources"))[
            "fonts_embedded"] == "fail"

    def test_a_disabled_check_is_not_promoted_to_review(self, tmp_dir):
        report = _run(tmp_dir, "unreadable_colorspace",
                      colour_family={"enabled": False})
        assert _row(report, "colour_family")["status"] == "not_applicable"


# ── the flat list, for a reader with no catalog ───────────────────────────


class TestShippedShapeStillReadable:
    def test_the_flat_list_is_the_categorized_one(self, tmp_dir):
        report = _run(tmp_dir, "baseline")
        flat = [(c["id"], c["status"]) for c in report["checks"]]
        nested = [(c["id"], c["status"])
                  for cat in report["categories"] for c in cat["checks"]]
        assert flat == nested

    def test_every_row_carries_an_english_name_and_sentence(self, tmp_dir):
        for row in _run(tmp_dir, "baseline")["checks"]:
            assert row["label"] and row["detail"]


# ── the corpus gate ───────────────────────────────────────────────────────


class TestCorpusGate:
    """Every PDF already in the tree, with its verdict pinned per profile.

    A verdict that moves on a document nobody edited is a regression, and this
    is what catches a check that starts crying wolf. Regenerate with
    `f25-corpus-build.local.py` and review the diff.

    Total area coverage is disabled here and pinned separately over
    constructed fixtures: running Ghostscript over every page of every
    document would make this the slowest thing in the repo, and the guard the
    corpus provides is about verdict DRIFT, which the other 36 checks give.
    """

    CORPUS = REPO / "tests" / "fixtures" / "preflight-corpus.json"

    def _pinned(self):
        assert self.CORPUS.exists(), "run f25-corpus-build.local.py"
        return json.loads(self.CORPUS.read_text(encoding="utf8"))

    def test_the_corpus_is_pinned(self):
        pinned = self._pinned()
        assert pinned["documents"], "the corpus found no PDFs to pin"
        assert set(pinned["profiles"]) == set(SHIPPED_PROFILES)

    def test_no_document_in_the_tree_moved_under_the_default_profile(self):
        pinned = self._pinned()
        moved = []
        for entry in pinned["documents"]:
            path = REPO / entry["path"]
            if not path.exists():
                continue
            try:
                report = preflight(str(path), profile=_corpus_profile(DEFAULT_PROFILE_ID))
            except Exception as exc:  # noqa: BLE001
                if "refused" not in entry:
                    moved.append({"path": entry["path"], "error": str(exc)})
                continue
            if "refused" in entry:
                moved.append({"path": entry["path"], "now_opens": True})
                continue
            now = {c["id"]: c["status"] for c in report["checks"]}
            if now != entry["verdicts"]:
                moved.append({
                    "path": entry["path"],
                    "diff": {k: (entry["verdicts"].get(k), now.get(k))
                             for k in set(now) | set(entry["verdicts"])
                             if now.get(k) != entry["verdicts"].get(k)},
                })
        assert moved == [], json.dumps(moved, indent=2)

    def test_no_summary_moved_under_the_other_eight_profiles(self):
        pinned = self._pinned()
        moved = []
        for entry in pinned["documents"]:
            path = REPO / entry["path"]
            if not path.exists() or "refused" in entry:
                continue
            for pid, expected in entry["summaries"].items():
                report = preflight(str(path), profile=_corpus_profile(pid))
                now = [report["summary"][k] for k in
                       ("passed", "failed", "warnings", "needs_review",
                        "not_applicable")]
                if now != expected:
                    moved.append({"path": entry["path"], "profile": pid,
                                  "was": expected, "now": now})
        assert moved == [], json.dumps(moved, indent=2)

    def test_the_corpus_is_the_git_index_not_a_glob(self):
        """A scratch probe folder is not a document anybody edits, and pinning
        one would make the gate fail on a fresh checkout that never had it."""
        listed = subprocess.run(
            ["git", "ls-files", "-z", "*.pdf", "*.PDF"],
            cwd=str(REPO), capture_output=True, check=True,
        ).stdout.decode("utf8")
        tracked = {name for name in listed.split("\0") if name}
        assert {e["path"] for e in self._pinned()["documents"]} == tracked


def _corpus_profile(pid: str) -> dict:
    """A shipped profile with the coverage measurement switched off — the one
    check whose cost is a Ghostscript run per page."""
    profile = json.loads(json.dumps(SHIPPED_PROFILES[pid]))
    profile["checks"].setdefault("ink_coverage_max", {})["enabled"] = False
    return profile


class TestCategoryShape:
    def test_every_category_counts_passed_over_applicable(self, tmp_dir):
        report = _run(tmp_dir, "baseline")
        for category in report["categories"]:
            rows = category["checks"]
            assert category["applicable"] == sum(
                1 for r in rows if r["status"] != "not_applicable")
            assert category["passed"] == sum(1 for r in rows if r["status"] == "pass")
            assert category["passed"] <= category["applicable"]

    def test_the_categories_are_the_inventorys(self, tmp_dir):
        report = _run(tmp_dir, "baseline")
        by_id = dict(CHECK_INVENTORY)
        for category in report["categories"]:
            for row in category["checks"]:
                assert by_id[row["id"]] == category["id"]
