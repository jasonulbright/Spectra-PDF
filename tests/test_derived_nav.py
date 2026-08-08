"""Bookmarks derived from the structure tree."""

import os

import pikepdf
import pytest

from engine.derived_nav import (
    outline_from_structure,
    preview_structure_outline,
)
from engine.outline import get_outline, set_outline

from derived_nav_builders import (
    attach,
    blank_pdf,
    draw_marked,
    elem,
    simple_headed_doc,
    struct_root,
    untagged_text_doc,
    wire_parent_tree,
)


@pytest.fixture
def headed(tmp_dir):
    path = os.path.join(tmp_dir, "headed.pdf")
    titles = simple_headed_doc(path)
    return path, titles


class TestPreview:
    def test_counts_headings_without_writing(self, headed):
        path, titles = headed
        before = os.path.getsize(path)
        result = preview_structure_outline(path)
        assert result["tagged"] is True
        assert result["headings"] == len(titles)
        assert result["existing"] == 0
        assert os.path.getsize(path) == before

    def test_untagged_reports_untagged_rather_than_raising(self, sample_pdf):
        result = preview_structure_outline(sample_pdf)
        assert result["tagged"] is False
        assert result["headings"] == 0
        assert result["outline"] == []

    def test_depth_limits_what_is_offered(self, headed):
        path, _titles = headed
        assert preview_structure_outline(path, max_level=1)["headings"] == 1
        assert preview_structure_outline(path, max_level=2)["headings"] == 2

    def test_bad_depth_refuses_by_name(self, headed):
        path, _titles = headed
        with pytest.raises(ValueError, match="heading depth"):
            preview_structure_outline(path, max_level=9)


class TestNesting:
    def test_levels_nest_by_tag(self, headed, tmp_dir):
        path, titles = headed
        out = os.path.join(tmp_dir, "out.pdf")
        outline_from_structure(path, out)
        tree = get_outline(out)["outline"]
        assert [n["title"] for n in tree] == [titles[0]]
        assert [n["title"] for n in tree[0]["children"]] == [titles[1]]
        assert [n["title"] for n in tree[0]["children"][0]["children"]] == [titles[2]]

    def test_a_document_starting_at_h3_grows_no_phantom_ancestors(self, tmp_dir):
        path = os.path.join(tmp_dir, "h3.pdf")
        titles = simple_headed_doc(path, tags=("H3", "H3"))
        out = os.path.join(tmp_dir, "out.pdf")
        outline_from_structure(path, out)
        tree = get_outline(out)["outline"]
        assert [n["title"] for n in tree] == titles
        assert all(n["children"] == [] for n in tree)

    def test_generic_h_takes_its_level_from_section_nesting(self, tmp_dir):
        path = os.path.join(tmp_dir, "generic.pdf")
        pdf = blank_pdf(1)
        page = pdf.pages[0]
        draw_marked(pdf, page, [(0, "Outer", 520, 20), (1, "Inner", 480, 14)])
        root = struct_root(pdf)
        outer_sect = elem(pdf, "Sect", root)
        outer_h = elem(pdf, "H", outer_sect, page=page, mcid=0)
        inner_sect = elem(pdf, "Sect", outer_sect)
        inner_h = elem(pdf, "H", inner_sect, page=page, mcid=1)
        attach(inner_sect, [inner_h])
        attach(outer_sect, [outer_h, inner_sect])
        attach(root, [outer_sect])
        wire_parent_tree(pdf, root, [(page, [outer_h, inner_h])])
        pdf.save(path)

        out = os.path.join(tmp_dir, "out.pdf")
        outline_from_structure(path, out)
        tree = get_outline(out)["outline"]
        assert [n["title"] for n in tree] == ["Outer"]
        assert [n["title"] for n in tree[0]["children"]] == ["Inner"]

    def test_role_map_resolves_a_private_tag(self, tmp_dir):
        path = os.path.join(tmp_dir, "rolemap.pdf")
        pdf = blank_pdf(1)
        page = pdf.pages[0]
        draw_marked(pdf, page, [(0, "Mapped", 520, 20)])
        root = struct_root(pdf)
        root[pikepdf.Name.RoleMap] = pikepdf.Dictionary(Heading1=pikepdf.Name("/H1"))
        node = elem(pdf, "Heading1", root, page=page, mcid=0)
        attach(root, [node])
        wire_parent_tree(pdf, root, [(page, [node])])
        pdf.save(path)

        assert preview_structure_outline(path)["headings"] == 1


class TestTitleLadder:
    def test_actual_text_wins_over_content(self, tmp_dir):
        path = os.path.join(tmp_dir, "actual.pdf")
        pdf = blank_pdf(1)
        page = pdf.pages[0]
        draw_marked(pdf, page, [(0, "Drawn", 520, 20)])
        root = struct_root(pdf)
        node = elem(pdf, "H1", root, page=page, mcid=0, ActualText="Declared")
        attach(root, [node])
        wire_parent_tree(pdf, root, [(page, [node])])
        pdf.save(path)
        assert preview_structure_outline(path)["outline"][0]["title"] == "Declared"

    def test_alt_is_used_when_there_is_no_actual_text(self, tmp_dir):
        path = os.path.join(tmp_dir, "alt.pdf")
        pdf = blank_pdf(1)
        page = pdf.pages[0]
        draw_marked(pdf, page, [(0, "Drawn", 520, 20)])
        root = struct_root(pdf)
        node = elem(pdf, "H1", root, page=page, mcid=0, Alt="Described")
        attach(root, [node])
        wire_parent_tree(pdf, root, [(page, [node])])
        pdf.save(path)
        assert preview_structure_outline(path)["outline"][0]["title"] == "Described"

    def test_text_in_a_child_span_is_found(self, tmp_dir):
        path = os.path.join(tmp_dir, "span.pdf")
        pdf = blank_pdf(1)
        page = pdf.pages[0]
        draw_marked(pdf, page, [(0, "Nested title", 520, 20)])
        root = struct_root(pdf)
        heading = elem(pdf, "H1", root, page=page)
        span = elem(pdf, "Span", heading, page=page, mcid=0)
        attach(heading, [span])
        attach(root, [heading])
        wire_parent_tree(pdf, root, [(page, [span])])
        pdf.save(path)
        assert preview_structure_outline(path)["outline"][0]["title"] == "Nested title"

    def test_a_heading_with_no_text_is_reported_not_written(self, tmp_dir):
        path = os.path.join(tmp_dir, "empty.pdf")
        pdf = blank_pdf(1)
        page = pdf.pages[0]
        draw_marked(pdf, page, [(0, "Real", 520, 20)])
        root = struct_root(pdf)
        good = elem(pdf, "H1", root, page=page, mcid=0)
        bad = elem(pdf, "H2", root, page=page)  # references no content at all
        attach(root, [good, bad])
        wire_parent_tree(pdf, root, [(page, [good, bad])])
        pdf.save(path)

        preview = preview_structure_outline(path)
        assert preview["headings"] == 1
        assert [s["tag"] for s in preview["skipped"]] == ["H2"]
        assert "Untitled" not in [n["title"] for n in preview["outline"]]


class TestDestination:
    def test_the_destination_carries_the_heading_position(self, headed, tmp_dir):
        path, _titles = headed
        out = os.path.join(tmp_dir, "out.pdf")
        outline_from_structure(path, out)
        top = get_outline(out)["outline"][0]
        assert top["page"] == 1
        # The first heading is drawn at y=500 with a 20pt face, so the top of
        # its EM box is 520 — the view lands ON the heading, not on the page.
        assert top["left"] == pytest.approx(50.0, abs=0.5)
        assert top["top"] == pytest.approx(520.0, abs=1.0)

    def test_the_written_destination_is_an_explicit_xyz_array(self, headed, tmp_dir):
        path, _titles = headed
        out = os.path.join(tmp_dir, "out.pdf")
        outline_from_structure(path, out)
        with pikepdf.open(out) as pdf:
            with pdf.open_outline() as outline:
                dest = outline.root[0].destination
        assert str(dest[1]) == "/XYZ"
        assert dest[4] is None  # zoom stays unchanged, not pinned to 0


class TestOutlinePositionRoundTrip:
    def test_a_get_edit_set_cycle_keeps_the_position(self, headed, tmp_dir):
        # The live defect this fixes: the panel reads, the user renames one
        # bookmark, the panel writes the WHOLE tree back — and every position
        # in the document used to be flattened to a plain page destination.
        path, _titles = headed
        built = os.path.join(tmp_dir, "built.pdf")
        outline_from_structure(path, built)
        tree = get_outline(built)["outline"]
        tree[0]["title"] = "Renamed"
        again = os.path.join(tmp_dir, "again.pdf")
        set_outline(built, tree, again)
        after = get_outline(again)["outline"][0]
        assert after["title"] == "Renamed"
        assert after["top"] == pytest.approx(tree[0]["top"])
        assert after["left"] == pytest.approx(tree[0]["left"])

    def test_a_bookmark_with_no_position_still_writes_a_page_destination(
        self, sample_pdf, tmp_dir
    ):
        out = os.path.join(tmp_dir, "plain.pdf")
        set_outline(sample_pdf, [{"title": "Plain", "page": 2, "children": []}], out)
        node = get_outline(out)["outline"][0]
        assert node["page"] == 2
        assert "top" not in node


class TestModes:
    def test_replace_discards_the_existing_tree(self, headed, tmp_dir):
        path, titles = headed
        seeded = os.path.join(tmp_dir, "seeded.pdf")
        set_outline(path, [{"title": "Old", "page": 1, "children": []}], seeded)
        out = os.path.join(tmp_dir, "out.pdf")
        result = outline_from_structure(seeded, out, mode="replace")
        assert result["mode"] == "replace"
        assert [n["title"] for n in get_outline(out)["outline"]] == [titles[0]]

    def test_append_keeps_the_existing_tree_in_front(self, headed, tmp_dir):
        path, titles = headed
        seeded = os.path.join(tmp_dir, "seeded.pdf")
        set_outline(path, [{"title": "Old", "page": 1, "children": []}], seeded)
        out = os.path.join(tmp_dir, "out.pdf")
        result = outline_from_structure(seeded, out, mode="append")
        assert result["mode"] == "append"
        assert [n["title"] for n in get_outline(out)["outline"]] == ["Old", titles[0]]

    def test_an_unknown_mode_refuses_by_name(self, headed, tmp_dir):
        path, _titles = headed
        with pytest.raises(ValueError, match="replace"):
            outline_from_structure(path, os.path.join(tmp_dir, "x.pdf"), mode="merge")

    def test_in_place_output_is_supported(self, headed, tmp_dir):
        path, titles = headed
        outline_from_structure(path, path)
        assert [n["title"] for n in get_outline(path)["outline"]] == [titles[0]]


class TestUntagged:
    def test_untagged_refuses_by_name(self, sample_pdf, tmp_dir):
        with pytest.raises(ValueError, match="not tagged"):
            outline_from_structure(sample_pdf, os.path.join(tmp_dir, "x.pdf"))

    def test_the_chain_tags_first_and_says_so(self, tmp_dir):
        source = untagged_text_doc(os.path.join(tmp_dir, "plain.pdf"))
        out = os.path.join(tmp_dir, "chained.pdf")
        result = outline_from_structure(source, out, tag_if_untagged=True)
        assert result["source"] == "autotag"
        assert result["added"] >= 1
        with pikepdf.open(out) as pdf:
            # The tags the headings were read from are the tags the file keeps.
            assert pdf.Root.get("/StructTreeRoot") is not None

    def test_a_tagged_document_reports_the_structure_path(self, headed, tmp_dir):
        path, _titles = headed
        out = os.path.join(tmp_dir, "out.pdf")
        result = outline_from_structure(path, out, tag_if_untagged=True)
        assert result["source"] == "structure"

    def test_a_tagged_document_with_no_headings_refuses(self, tmp_dir):
        path = os.path.join(tmp_dir, "noheads.pdf")
        pdf = blank_pdf(1)
        page = pdf.pages[0]
        draw_marked(pdf, page, [(0, "Body", 520, 12)])
        root = struct_root(pdf)
        node = elem(pdf, "P", root, page=page, mcid=0)
        attach(root, [node])
        wire_parent_tree(pdf, root, [(page, [node])])
        pdf.save(path)
        with pytest.raises(ValueError, match="No headings"):
            outline_from_structure(path, os.path.join(tmp_dir, "x.pdf"))


class TestMarkedContentWalk:
    def test_runs_report_the_marked_content_id_they_sit_in(self, headed):
        from engine.redact import IDENTITY, _resolve_resources
        from engine.text_metrics import _FontCache
        from engine.text_runs import _walk_runs

        path, titles = headed
        with pikepdf.open(path) as pdf:
            page = pdf.pages[0]
            runs: list[dict] = []
            _walk_runs(
                pdf,
                pikepdf.parse_content_stream(page),
                _resolve_resources(page),
                IDENTITY,
                0,
                None,
                runs,
                False,
                _FontCache(),
            )
        assert [r["mcid"] for r in runs] == list(range(len(titles)))

    def test_a_run_outside_marked_content_reports_none(self, tmp_dir):
        from engine.redact import IDENTITY, _resolve_resources
        from engine.text_metrics import _FontCache
        from engine.text_runs import _walk_runs

        source = untagged_text_doc(os.path.join(tmp_dir, "plain.pdf"))
        with pikepdf.open(source) as pdf:
            page = pdf.pages[0]
            runs: list[dict] = []
            _walk_runs(
                pdf,
                pikepdf.parse_content_stream(page),
                _resolve_resources(page),
                IDENTITY,
                0,
                None,
                runs,
                False,
                _FontCache(),
            )
        assert runs
        assert all(r["mcid"] is None for r in runs)
