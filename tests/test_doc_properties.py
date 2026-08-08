"""Document-level properties: the initial view and the Advanced facts.

Every write is proven by REOPENING the saved file and reading it back — an
in-memory assertion would pass on a setter that never reached the bytes.
"""

import pikepdf
import pytest

from engine.doc_properties import (
    _PAGE_LAYOUTS,
    _PAGE_MODES,
    get_advanced_properties,
    get_initial_view,
    set_advanced_properties,
    set_initial_view,
)


def _pdf(path, n_pages=5, page_size=(612, 792)):
    doc = pikepdf.new()
    for _ in range(n_pages):
        doc.add_blank_page(page_size=page_size)
    doc.save(path)
    doc.close()
    return str(path)


@pytest.fixture
def sample(tmp_path):
    return _pdf(tmp_path / "sample.pdf")


class TestInitialViewDefaults:
    def test_a_virgin_file_reports_every_default(self, sample):
        view = get_initial_view(sample)
        assert view["page_layout"] == "default"
        assert view["page_mode"] == "default"
        assert view["open_page"] is None
        assert view["zoom"] == "default"
        assert view["zoom_percent"] is None
        assert view["direction"] == "L2R"
        assert view["open_action_replaceable"] is True
        assert view["pages"] == 5
        for key in (
            "hide_toolbar",
            "hide_menubar",
            "hide_window_ui",
            "fit_window",
            "center_window",
            "display_doc_title",
        ):
            assert view[key] is False, key


class TestPageLayoutAndMode:
    @pytest.mark.parametrize("value", sorted(_PAGE_LAYOUTS))
    def test_every_page_layout_round_trips(self, sample, value):
        set_initial_view(sample, sample, page_layout=value)
        assert get_initial_view(sample)["page_layout"] == value

    @pytest.mark.parametrize("value", sorted(_PAGE_MODES))
    def test_every_page_mode_round_trips(self, sample, value):
        set_initial_view(sample, sample, page_mode=value)
        assert get_initial_view(sample)["page_mode"] == value

    def test_default_removes_the_key_rather_than_writing_a_name(self, sample):
        set_initial_view(sample, sample, page_layout="two-page-right", page_mode="outlines")
        set_initial_view(sample, sample, page_layout="default", page_mode="default")
        with pikepdf.open(sample) as pdf:
            assert "/PageLayout" not in pdf.Root
            assert "/PageMode" not in pdf.Root

    def test_none_means_unchanged(self, sample):
        set_initial_view(sample, sample, page_layout="one-column", page_mode="thumbnails")
        set_initial_view(sample, sample, hide_toolbar=True)
        view = get_initial_view(sample)
        assert view["page_layout"] == "one-column"
        assert view["page_mode"] == "thumbnails"

    def test_an_unknown_layout_refuses(self, sample):
        with pytest.raises(ValueError, match="page_layout"):
            set_initial_view(sample, sample, page_layout="sideways")

    def test_an_unknown_mode_refuses(self, sample):
        with pytest.raises(ValueError, match="page_mode"):
            set_initial_view(sample, sample, page_mode="UseOutlines")


class TestOpenPageAndMagnification:
    @pytest.mark.parametrize(
        "zoom", ["default", "fit-page", "fit-width", "fit-height", "fit-visible"]
    )
    def test_every_fit_form_round_trips_with_its_page(self, sample, zoom):
        set_initial_view(sample, sample, open_page=3, zoom=zoom)
        view = get_initial_view(sample)
        assert view["open_page"] == 3
        assert view["zoom"] == zoom
        assert view["zoom_percent"] is None

    def test_a_percentage_round_trips_as_a_percentage(self, sample):
        set_initial_view(sample, sample, open_page=2, zoom="percent", zoom_percent=125)
        view = get_initial_view(sample)
        assert view["open_page"] == 2
        assert view["zoom"] == "percent"
        assert view["zoom_percent"] == pytest.approx(125.0)

    def test_the_destination_names_the_page_object_not_its_number(self, sample):
        set_initial_view(sample, sample, open_page=4, zoom="fit-page")
        with pikepdf.open(sample) as pdf:
            dest = pdf.Root["/OpenAction"]
            assert dest[0].objgen == pdf.pages[3].obj.objgen

    def test_page_zero_removes_the_open_action(self, sample):
        set_initial_view(sample, sample, open_page=3, zoom="fit-page")
        set_initial_view(sample, sample, open_page=0)
        with pikepdf.open(sample) as pdf:
            assert "/OpenAction" not in pdf.Root
        assert get_initial_view(sample)["open_page"] is None

    def test_a_page_beyond_the_document_refuses(self, sample):
        with pytest.raises(ValueError, match="out of range"):
            set_initial_view(sample, sample, open_page=99)

    def test_a_percentage_without_a_value_refuses(self, sample):
        with pytest.raises(ValueError, match="zoom_percent"):
            set_initial_view(sample, sample, open_page=1, zoom="percent")

    @pytest.mark.parametrize("percent", [0, 0.5, 6401])
    def test_a_percentage_outside_the_range_refuses(self, sample, percent):
        with pytest.raises(ValueError, match="between"):
            set_initial_view(sample, sample, open_page=1, zoom="percent", zoom_percent=percent)

    def test_an_unknown_zoom_refuses(self, sample):
        with pytest.raises(ValueError, match="zoom must be"):
            set_initial_view(sample, sample, open_page=1, zoom="fit-everything")


class TestOpenActionThatIsAScript:
    def _script_open_action(self, path):
        with pikepdf.open(path, allow_overwriting_input=True) as pdf:
            pdf.Root[pikepdf.Name.OpenAction] = pikepdf.Dictionary(
                S=pikepdf.Name("/JavaScript"), JS=pikepdf.String("app.alert('hi')")
            )
            pdf.save(path)

    def test_it_is_reported_as_not_replaceable(self, sample):
        self._script_open_action(sample)
        view = get_initial_view(sample)
        assert view["open_action_replaceable"] is False
        assert view["open_page"] is None

    def test_writing_a_destination_refuses_and_leaves_the_script(self, sample):
        self._script_open_action(sample)
        with pytest.raises(ValueError, match="script"):
            set_initial_view(sample, sample, open_page=2, zoom="fit-page")
        with pikepdf.open(sample) as pdf:
            assert str(pdf.Root["/OpenAction"]["/S"]) == "/JavaScript"

    def test_removing_it_refuses_too(self, sample):
        self._script_open_action(sample)
        with pytest.raises(ValueError, match="script"):
            set_initial_view(sample, sample, open_page=0)

    def test_a_goto_action_is_a_destination(self, sample):
        with pikepdf.open(sample, allow_overwriting_input=True) as pdf:
            pdf.Root[pikepdf.Name.OpenAction] = pikepdf.Dictionary(
                S=pikepdf.Name("/GoTo"),
                D=pikepdf.Array([pdf.pages[2].obj, pikepdf.Name.Fit]),
            )
            pdf.save(sample)
        view = get_initial_view(sample)
        assert view["open_page"] == 3
        assert view["zoom"] == "fit-page"
        assert view["open_action_replaceable"] is True

    def test_a_named_destination_resolves_through_the_name_tree(self, sample):
        with pikepdf.open(sample, allow_overwriting_input=True) as pdf:
            dest = pdf.make_indirect(
                pikepdf.Array([pdf.pages[1].obj, pikepdf.Name.XYZ, None, None, 2.0])
            )
            pdf.Root[pikepdf.Name.Names] = pikepdf.Dictionary(
                Dests=pikepdf.Dictionary(Names=pikepdf.Array([pikepdf.String("start"), dest]))
            )
            pdf.Root[pikepdf.Name.OpenAction] = pikepdf.String("start")
            pdf.save(sample)
        view = get_initial_view(sample)
        assert view["open_page"] == 2
        assert view["zoom"] == "percent"
        assert view["zoom_percent"] == pytest.approx(200.0)


class TestWindowOptionsAndDirection:
    OPTIONS = (
        "hide_toolbar",
        "hide_menubar",
        "hide_window_ui",
        "fit_window",
        "center_window",
        "display_doc_title",
    )

    @pytest.mark.parametrize("option", OPTIONS)
    def test_each_option_round_trips_true(self, sample, option):
        set_initial_view(sample, sample, **{option: True})
        assert get_initial_view(sample)[option] is True

    @pytest.mark.parametrize("option", OPTIONS)
    def test_false_deletes_the_key(self, sample, option):
        set_initial_view(sample, sample, **{option: True})
        set_initial_view(sample, sample, **{option: False})
        assert get_initial_view(sample)[option] is False
        with pikepdf.open(sample) as pdf:
            vp = pdf.Root.get("/ViewerPreferences")
            assert vp is None or ("/" + option) not in vp

    def test_a_file_with_no_preference_never_grows_an_empty_dict(self, sample):
        set_initial_view(sample, sample, hide_toolbar=False, direction="L2R")
        with pikepdf.open(sample) as pdf:
            assert "/ViewerPreferences" not in pdf.Root

    def test_clearing_the_last_option_removes_the_dict(self, sample):
        set_initial_view(sample, sample, hide_menubar=True)
        set_initial_view(sample, sample, hide_menubar=False)
        with pikepdf.open(sample) as pdf:
            assert "/ViewerPreferences" not in pdf.Root

    def test_direction_round_trips_and_defaults_delete(self, sample):
        set_initial_view(sample, sample, direction="R2L")
        assert get_initial_view(sample)["direction"] == "R2L"
        set_initial_view(sample, sample, direction="L2R")
        assert get_initial_view(sample)["direction"] == "L2R"
        with pikepdf.open(sample) as pdf:
            vp = pdf.Root.get("/ViewerPreferences")
            assert vp is None or "/Direction" not in vp

    def test_an_unknown_direction_refuses(self, sample):
        with pytest.raises(ValueError, match="direction"):
            set_initial_view(sample, sample, direction="rtl")

    def test_options_survive_a_later_unrelated_write(self, sample):
        set_initial_view(sample, sample, hide_toolbar=True, direction="R2L")
        set_initial_view(sample, sample, page_layout="single-page")
        view = get_initial_view(sample)
        assert view["hide_toolbar"] is True
        assert view["direction"] == "R2L"
        assert view["page_layout"] == "single-page"


class TestEverythingAtOnce:
    def test_one_write_carries_every_field_through_a_reopen(self, sample):
        set_initial_view(
            sample,
            sample,
            page_layout="two-column-right",
            page_mode="attachments",
            open_page=5,
            zoom="percent",
            zoom_percent=150,
            hide_toolbar=True,
            hide_menubar=True,
            hide_window_ui=True,
            fit_window=True,
            center_window=True,
            display_doc_title=True,
            direction="R2L",
        )
        view = get_initial_view(sample)
        assert view["page_layout"] == "two-column-right"
        assert view["page_mode"] == "attachments"
        assert view["open_page"] == 5
        assert view["zoom"] == "percent"
        assert view["zoom_percent"] == pytest.approx(150.0)
        assert view["direction"] == "R2L"
        assert all(
            view[k]
            for k in (
                "hide_toolbar",
                "hide_menubar",
                "hide_window_ui",
                "fit_window",
                "center_window",
                "display_doc_title",
            )
        )

    def test_output_to_a_different_file_leaves_the_input_alone(self, sample, tmp_path):
        out = str(tmp_path / "out.pdf")
        set_initial_view(sample, out, page_mode="outlines")
        assert get_initial_view(out)["page_mode"] == "outlines"
        assert get_initial_view(sample)["page_mode"] == "default"


class TestAdvanced:
    def test_the_read_reports_the_file_s_own_facts(self, sample):
        advanced = get_advanced_properties(sample)
        assert advanced["version"].startswith("1.")
        assert advanced["pages"] == 5
        assert advanced["bytes"] > 0
        assert advanced["tagged"] is False
        assert advanced["has_open_action"] is False
        assert advanced["search_index"] is None
        assert advanced["page_sizes"] == [{"width": 612.0, "height": 792.0, "count": 5}]

    def test_page_sizes_group_and_apply_rotation(self, tmp_path):
        path = str(tmp_path / "mixed.pdf")
        doc = pikepdf.new()
        doc.add_blank_page(page_size=(612, 792))
        doc.add_blank_page(page_size=(612, 792))
        rotated = doc.add_blank_page(page_size=(612, 792))
        rotated.obj[pikepdf.Name.Rotate] = 90
        doc.add_blank_page(page_size=(300, 300))
        doc.save(path)
        doc.close()
        sizes = get_advanced_properties(path)["page_sizes"]
        assert {(s["width"], s["height"]): s["count"] for s in sizes} == {
            (612.0, 792.0): 2,
            (792.0, 612.0): 1,
            (300.0, 300.0): 1,
        }

    def test_tagged_needs_both_the_flag_and_the_tree(self, tmp_path):
        path = str(tmp_path / "tagged.pdf")
        _pdf(path, 1)
        with pikepdf.open(path, allow_overwriting_input=True) as pdf:
            pdf.Root[pikepdf.Name.MarkInfo] = pikepdf.Dictionary(Marked=True)
            pdf.save(path)
        assert get_advanced_properties(path)["tagged"] is False
        with pikepdf.open(path, allow_overwriting_input=True) as pdf:
            pdf.Root[pikepdf.Name.StructTreeRoot] = pdf.make_indirect(
                pikepdf.Dictionary(Type=pikepdf.Name.StructTreeRoot)
            )
            pdf.save(path)
        assert get_advanced_properties(path)["tagged"] is True

    def test_linearized_is_reported_from_the_saved_shape(self, sample, tmp_path):
        assert get_advanced_properties(sample)["linearized"] is False
        linear = str(tmp_path / "linear.pdf")
        with pikepdf.open(sample) as pdf:
            pdf.save(linear, linearize=True)
        assert get_advanced_properties(linear)["linearized"] is True

    @pytest.mark.parametrize("value", ["true", "false", "unknown"])
    def test_trapped_round_trips(self, sample, value):
        set_advanced_properties(sample, sample, trapped=value)
        assert get_advanced_properties(sample)["trapped"] == value

    def test_trapped_lands_on_the_info_dictionary(self, sample):
        set_advanced_properties(sample, sample, trapped="true")
        with pikepdf.open(sample) as pdf:
            assert str(pdf.docinfo["/Trapped"]) == "/True"

    def test_an_unknown_trapped_value_refuses(self, sample):
        with pytest.raises(ValueError, match="trapped"):
            set_advanced_properties(sample, sample, trapped="maybe")

    def test_base_url_round_trips_and_empty_removes_it(self, sample):
        set_advanced_properties(sample, sample, base_url="https://example.invalid/docs/")
        assert get_advanced_properties(sample)["base_url"] == "https://example.invalid/docs/"
        set_advanced_properties(sample, sample, base_url="")
        assert get_advanced_properties(sample)["base_url"] == ""
        with pikepdf.open(sample) as pdf:
            assert "/URI" not in pdf.Root

    def test_none_means_unchanged(self, sample):
        set_advanced_properties(sample, sample, trapped="false", base_url="https://a.invalid/")
        set_advanced_properties(sample, sample, trapped="true")
        advanced = get_advanced_properties(sample)
        assert advanced["trapped"] == "true"
        assert advanced["base_url"] == "https://a.invalid/"

    def test_the_open_action_presence_follows_the_initial_view(self, sample):
        set_initial_view(sample, sample, open_page=1, zoom="fit-page")
        assert get_advanced_properties(sample)["has_open_action"] is True

    def test_a_recorded_search_index_is_reported(self, sample):
        with pikepdf.open(sample, allow_overwriting_input=True) as pdf:
            pdf.Root[pikepdf.Name.PieceInfo] = pikepdf.Dictionary(
                Producer=pikepdf.Dictionary(
                    Private=pikepdf.Dictionary(Index=pikepdf.String("manuals.pdx"))
                )
            )
            pdf.save(sample)
        assert get_advanced_properties(sample)["search_index"] == "manuals.pdx"

    def test_private_data_with_no_index_reports_none(self, sample):
        with pikepdf.open(sample, allow_overwriting_input=True) as pdf:
            pdf.Root[pikepdf.Name.PieceInfo] = pikepdf.Dictionary(
                Producer=pikepdf.Dictionary(Private=pikepdf.String("nothing here"))
            )
            pdf.save(sample)
        assert get_advanced_properties(sample)["search_index"] is None
