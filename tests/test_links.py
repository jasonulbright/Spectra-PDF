"""Link-region management."""

import os

import pikepdf
import pytest
from pikepdf import Array, Dictionary, Name, String

from engine.links import (
    add_links,
    delete_link,
    list_links,
    list_named_destinations,
    set_link_appearance,
    set_link_rect,
    set_link_target,
    set_link_url,
)


def _pdf(path: str) -> None:
    p = pikepdf.new()
    pg1 = p.add_blank_page(page_size=(300, 400))
    pg2 = p.add_blank_page(page_size=(300, 400))
    uri = p.make_indirect(Dictionary(
        Type=Name.Annot, Subtype=Name.Link, Rect=[10, 10, 100, 30],
        A=Dictionary(Type=Name.Action, S=Name.URI, URI=String("https://example.com"))))
    goto = p.make_indirect(Dictionary(
        Type=Name.Annot, Subtype=Name.Link, Rect=[10, 50, 100, 70], Dest=Array([pg2.obj, Name.Fit])))
    # A non-link annotation must be ignored by the link manager.
    note = p.make_indirect(Dictionary(Type=Name.Annot, Subtype=Name.Text, Rect=[0, 0, 10, 10]))
    pg1.obj["/Annots"] = Array([uri, goto, note])
    p.save(path)
    p.close()


@pytest.fixture
def tmp_dir(tmp_path):
    return str(tmp_path)


class TestLinks:
    def test_list_uri_and_internal(self, tmp_dir):
        src = os.path.join(tmp_dir, "s.pdf")
        _pdf(src)
        r = list_links(src)
        assert r["count"] == 2  # the /Text note is ignored
        assert r["links"][0]["page"] == 1
        assert r["links"][0]["index"] == 0
        assert r["links"][0]["kind"] == "uri"
        assert r["links"][0]["target"] == "https://example.com"
        assert r["links"][0]["rect"] == [10.0, 10.0, 100.0, 30.0]
        assert r["links"][0]["target_spec"] == {"kind": "uri", "url": "https://example.com"}
        # No /Border and no /BS is the format's 1-unit solid default; reporting
        # 0 would call a link invisible that every reader boxes.
        assert r["links"][0]["appearance"] == {
            "width": 1.0, "style": "solid", "color": None, "highlight": "invert",
        }
        assert r["links"][1]["kind"] == "internal"
        assert r["links"][1]["target"] == "Page 2"
        assert r["links"][1]["target_spec"] == {"kind": "goto", "page": 2, "view": {"mode": "fit"}}

    def test_set_url_retargets(self, tmp_dir):
        src = os.path.join(tmp_dir, "s.pdf")
        out = os.path.join(tmp_dir, "o.pdf")
        _pdf(src)
        # Retarget the internal (index 1) link to a URL.
        set_link_url(src, out, page=1, index=1, url="https://new.example")
        r = list_links(out)
        assert r["links"][1]["kind"] == "uri"
        assert r["links"][1]["target"] == "https://new.example"
        with pikepdf.open(out) as pdf:
            assert "/Dest" not in pdf.pages[0].obj["/Annots"][1]  # dest cleared

    def test_empty_url_refused(self, tmp_dir):
        src = os.path.join(tmp_dir, "s.pdf")
        _pdf(src)
        with pytest.raises(ValueError, match="url must not be empty"):
            set_link_url(src, os.path.join(tmp_dir, "o.pdf"), page=1, index=0, url="  ")

    def test_delete_link(self, tmp_dir):
        src = os.path.join(tmp_dir, "s.pdf")
        out = os.path.join(tmp_dir, "o.pdf")
        _pdf(src)
        delete_link(src, out, page=1, index=0)  # remove the URI link
        r = list_links(out)
        assert r["count"] == 1
        assert r["links"][0]["kind"] == "internal"
        # The non-link /Text annotation survives.
        with pikepdf.open(out) as pdf:
            subs = {str(a.get("/Subtype")) for a in pdf.pages[0].obj["/Annots"]}
            assert "/Text" in subs

    def test_out_of_range_refused(self, tmp_dir):
        src = os.path.join(tmp_dir, "s.pdf")
        _pdf(src)
        with pytest.raises(ValueError, match="out of range"):
            delete_link(src, os.path.join(tmp_dir, "o.pdf"), page=1, index=9)

    def test_no_links(self, tmp_dir):
        src = os.path.join(tmp_dir, "s.pdf")
        p = pikepdf.new()
        p.add_blank_page(page_size=(200, 200))
        p.save(src)
        p.close()
        assert list_links(src) == {"links": [], "count": 0}

    def test_in_place_delete(self, tmp_dir):
        src = os.path.join(tmp_dir, "s.pdf")
        _pdf(src)
        delete_link(src, src, page=1, index=0)
        assert list_links(src)["count"] == 1


class TestAddLinks:
    """Authoring link regions from a text selection (the N-cluster create half)."""

    def test_adds_one_link_per_quad_and_keeps_existing(self, tmp_dir):
        src = os.path.join(tmp_dir, "s.pdf")
        out = os.path.join(tmp_dir, "o.pdf")
        _pdf(src)
        r = add_links(src, out, links=[
            {"page": 1, "rect": [20, 200, 120, 216], "url": "https://a.example"},
            {"page": 1, "rect": [20, 180, 90, 196], "url": "https://a.example"},
        ])
        assert r["added"] == 2
        listing = list_links(out)
        # The two pre-existing links survive alongside the two new ones.
        assert listing["count"] == 4
        new = [x for x in listing["links"] if x["target"] == "https://a.example"]
        assert len(new) == 2
        assert all(x["kind"] == "uri" for x in new)
        with pikepdf.open(out) as pdf:
            def uri_of(a):
                act = a.get("/A")
                return str(act.get("/URI")) if act is not None and act.get("/URI") is not None else None

            added = [a for a in pdf.pages[0].obj["/Annots"] if uri_of(a) == "https://a.example"]
            assert len(added) == 2
            # Invisible border — a ring around linked text is not what the
            # gesture asked for.
            assert [int(v) for v in added[0]["/Border"]] == [0, 0, 0]

    def test_adds_to_a_page_with_no_annots(self, tmp_dir):
        src = os.path.join(tmp_dir, "s.pdf")
        out = os.path.join(tmp_dir, "o.pdf")
        _pdf(src)
        add_links(src, out, links=[{"page": 2, "rect": [10, 10, 50, 30], "url": "https://b.example"}])
        with pikepdf.open(out) as pdf:
            assert len(pdf.pages[1].obj["/Annots"]) == 1

    def test_normalizes_an_inverted_rect(self, tmp_dir):
        src = os.path.join(tmp_dir, "s.pdf")
        out = os.path.join(tmp_dir, "o.pdf")
        _pdf(src)
        add_links(src, out, links=[{"page": 1, "rect": [120, 216, 20, 200], "url": "https://c.example"}])
        with pikepdf.open(out) as pdf:
            rect = [float(v) for v in pdf.pages[0].obj["/Annots"][3]["/Rect"]]
            assert rect == [20.0, 200.0, 120.0, 216.0]

    def test_refusals(self, tmp_dir):
        src = os.path.join(tmp_dir, "s.pdf")
        out = os.path.join(tmp_dir, "o.pdf")
        _pdf(src)
        with pytest.raises(ValueError, match="no links to add"):
            add_links(src, out, links=[])
        with pytest.raises(ValueError, match="out of range"):
            add_links(src, out, links=[{"page": 9, "rect": [0, 0, 10, 10], "url": "https://x"}])
        with pytest.raises(ValueError, match="url must not be empty"):
            add_links(src, out, links=[{"page": 1, "rect": [0, 0, 10, 10], "url": "  "}])
        with pytest.raises(ValueError, match="positive width and height"):
            add_links(src, out, links=[{"page": 1, "rect": [10, 10, 10, 30], "url": "https://x"}])

    def test_in_place(self, tmp_dir):
        src = os.path.join(tmp_dir, "s.pdf")
        _pdf(src)
        add_links(src, src, links=[{"page": 1, "rect": [10, 10, 60, 30], "url": "https://d.example"}])
        assert list_links(src)["count"] == 3


def _blank(path: str, pages: int = 3) -> None:
    p = pikepdf.new()
    for _ in range(pages):
        p.add_blank_page(page_size=(300, 400))
    p.save(path)
    p.close()


def _authored(tmp_dir, target=None, appearance=None):
    """Author one link with the given target/appearance and read it back."""
    src = os.path.join(tmp_dir, "t.pdf")
    out = os.path.join(tmp_dir, "t-out.pdf")
    if not os.path.exists(src):
        _blank(src)
    spec = {"page": 1, "rect": [10, 20, 110, 60]}
    if target is not None:
        spec["target"] = target
    else:
        spec["url"] = "https://round.example"
    if appearance is not None:
        spec["appearance"] = appearance
    add_links(src, out, links=[spec])
    return out, list_links(out)["links"][0]


class TestTargetRoundTrip:
    """Every authored target kind survives a write and reads back as itself."""

    def test_uri(self, tmp_dir):
        _, link = _authored(tmp_dir, {"kind": "uri", "url": "https://x.example/a?b=1"})
        assert link["target_spec"] == {"kind": "uri", "url": "https://x.example/a?b=1"}
        assert link["kind"] == "uri"

    def test_goto_defaults_to_inherit(self, tmp_dir):
        out, link = _authored(tmp_dir, {"kind": "goto", "page": 3})
        assert link["target_spec"] == {"kind": "goto", "page": 3, "view": {"mode": "inherit"}}
        assert link["kind"] == "internal"
        assert link["target"] == "Page 3"
        # Inherit IS [pg /XYZ null null null] — the page at the reader's zoom.
        with pikepdf.open(out) as pdf:
            dest = pdf.pages[0].obj["/Annots"][0]["/A"]["/D"]
            assert str(dest[1]) == "/XYZ"
            assert [dest[2], dest[3], dest[4]] == [None, None, None]

    @pytest.mark.parametrize(
        "view",
        [
            {"mode": "fit"},
            {"mode": "fitb"},
            {"mode": "fith", "top": 700.0},
            {"mode": "fitbh", "top": 12.5},
            {"mode": "fitv", "left": 33.0},
            {"mode": "fitbv", "left": 0.0},
            {"mode": "fitr", "left": 10.0, "bottom": 20.0, "right": 200.0, "top": 300.0},
            {"mode": "xyz", "left": 5.0, "top": 700.0, "zoom": 2.0},
            {"mode": "xyz", "left": None, "top": 700.0, "zoom": None},
        ],
    )
    def test_goto_every_view_mode(self, tmp_dir, view):
        _, link = _authored(tmp_dir, {"kind": "goto", "page": 2, "view": view})
        assert link["target_spec"] == {"kind": "goto", "page": 2, "view": view}

    def test_named(self, tmp_dir):
        src = os.path.join(tmp_dir, "named.pdf")
        out = os.path.join(tmp_dir, "named-out.pdf")
        p = pikepdf.new()
        p.add_blank_page(page_size=(300, 400))
        second = p.add_blank_page(page_size=(300, 400))
        p.Root["/Names"] = p.make_indirect(Dictionary(
            Dests=p.make_indirect(Dictionary(
                Names=Array([String("Chapter1"), Array([second.obj, Name.Fit])])))))
        p.save(src)
        p.close()
        assert list_named_destinations(src) == {
            "destinations": [{"name": "Chapter1", "page": 2}], "count": 1,
        }
        add_links(src, out, links=[
            {"page": 1, "rect": [0, 0, 50, 50], "target": {"kind": "named", "name": "Chapter1"}}])
        link = list_links(out)["links"][0]
        assert link["target_spec"] == {"kind": "named", "name": "Chapter1"}
        assert link["kind"] == "named"
        # A named target is a /Dest, not an action — and the two never coexist.
        with pikepdf.open(out) as pdf:
            annot = pdf.pages[0].obj["/Annots"][0]
            assert str(annot["/Dest"]) == "Chapter1"
            assert "/A" not in annot

    def test_named_refuses_an_unknown_name(self, tmp_dir):
        src = os.path.join(tmp_dir, "s.pdf")
        _blank(src)
        with pytest.raises(ValueError, match="no destination named Nowhere"):
            add_links(src, os.path.join(tmp_dir, "o.pdf"), links=[
                {"page": 1, "rect": [0, 0, 50, 50], "target": {"kind": "named", "name": "Nowhere"}}])

    def test_legacy_dests_dictionary(self, tmp_dir):
        src = os.path.join(tmp_dir, "legacy.pdf")
        p = pikepdf.new()
        p.add_blank_page(page_size=(300, 400))
        third = p.add_blank_page(page_size=(300, 400))
        p.Root["/Dests"] = p.make_indirect(Dictionary(Intro=Array([third.obj, Name.Fit])))
        p.save(src)
        p.close()
        assert list_named_destinations(src)["destinations"] == [{"name": "Intro", "page": 2}]

    def test_file_target_with_a_page(self, tmp_dir):
        out, link = _authored(tmp_dir, {
            "kind": "file", "path": "reports/q3.pdf", "page": 4,
            "view": {"mode": "fith", "top": 500.0}, "new_window": True,
        })
        assert link["target_spec"] == {
            "kind": "file", "path": "reports/q3.pdf", "page": 4,
            "view": {"mode": "fith", "top": 500.0}, "new_window": True,
        }
        assert link["kind"] == "file"
        assert link["target"] == "reports/q3.pdf page 4"
        with pikepdf.open(out) as pdf:
            action = pdf.pages[0].obj["/Annots"][0]["/A"]
            assert str(action["/S"]) == "/GoToR"
            assert str(action["/F"]) == "reports/q3.pdf"
            # A REMOTE destination names a page INDEX — there is no page tree
            # here to reference, so 4 is written as 3.
            assert int(action["/D"][0]) == 3

    def test_file_target_without_a_page(self, tmp_dir):
        out, link = _authored(tmp_dir, {"kind": "file", "path": r"C:\docs\appendix.pdf"})
        assert link["target_spec"]["kind"] == "file"
        assert link["target_spec"]["path"] == r"C:\docs\appendix.pdf"
        assert link["target_spec"]["page"] is None
        assert link["target"] == r"C:\docs\appendix.pdf"
        with pikepdf.open(out) as pdf:
            assert "/D" not in pdf.pages[0].obj["/Annots"][0]["/A"]

    def test_a_windows_path_survives_verbatim(self, tmp_dir):
        # Nothing rewrites the path: guessing at a base a consumer resolves
        # against is how a link ends up pointing at a file nobody wrote.
        _, link = _authored(tmp_dir, {"kind": "file", "path": r"..\shared\Plan 2026.pdf"})
        assert link["target_spec"]["path"] == r"..\shared\Plan 2026.pdf"

    def test_launch_is_read_never_authored(self, tmp_dir):
        src = os.path.join(tmp_dir, "launch.pdf")
        p = pikepdf.new()
        pg = p.add_blank_page(page_size=(300, 400))
        pg.obj["/Annots"] = Array([p.make_indirect(Dictionary(
            Type=Name.Annot, Subtype=Name.Link, Rect=[0, 0, 10, 10],
            A=Dictionary(Type=Name.Action, S=Name("/Launch"), F=String("run.exe"))))])
        p.save(src)
        p.close()
        link = list_links(src)["links"][0]
        assert link["target_spec"] == {"kind": "launch", "path": "run.exe"}
        assert link["kind"] == "launch"
        with pytest.raises(ValueError, match="unknown link target launch"):
            add_links(src, os.path.join(tmp_dir, "o.pdf"), links=[
                {"page": 1, "rect": [0, 0, 50, 50], "target": {"kind": "launch", "path": "run.exe"}}])

    def test_a_link_with_no_target_reads_as_none(self, tmp_dir):
        src = os.path.join(tmp_dir, "bare.pdf")
        p = pikepdf.new()
        pg = p.add_blank_page(page_size=(300, 400))
        pg.obj["/Annots"] = Array([p.make_indirect(Dictionary(
            Type=Name.Annot, Subtype=Name.Link, Rect=[0, 0, 10, 10]))])
        p.save(src)
        p.close()
        assert list_links(src)["links"][0]["target_spec"] == {"kind": "none"}

    def test_target_refusals(self, tmp_dir):
        src = os.path.join(tmp_dir, "s.pdf")
        _blank(src)
        out = os.path.join(tmp_dir, "o.pdf")

        def author(target):
            add_links(src, out, links=[{"page": 1, "rect": [0, 0, 50, 50], "target": target}])

        with pytest.raises(ValueError, match="unknown link target ranch"):
            author({"kind": "ranch"})
        with pytest.raises(ValueError, match="unknown link target \\(none\\)"):
            author({})
        with pytest.raises(ValueError, match="page 9 is out of range"):
            author({"kind": "goto", "page": 9})
        with pytest.raises(ValueError, match="a link to a page needs a page number"):
            author({"kind": "goto"})
        with pytest.raises(ValueError, match="unknown link view mode sideways"):
            author({"kind": "goto", "page": 1, "view": {"mode": "sideways"}})
        with pytest.raises(ValueError, match="a link to a file needs a path"):
            author({"kind": "file", "path": "  "})
        with pytest.raises(ValueError, match="a named destination link needs a name"):
            author({"kind": "named", "name": ""})

    def test_a_bad_target_lands_nothing(self, tmp_dir):
        # Validation runs over the whole batch before anything is written.
        src = os.path.join(tmp_dir, "s.pdf")
        out = os.path.join(tmp_dir, "o.pdf")
        _blank(src)
        with pytest.raises(ValueError, match="page 9 is out of range"):
            add_links(src, out, links=[
                {"page": 1, "rect": [0, 0, 50, 50], "url": "https://ok.example"},
                {"page": 1, "rect": [0, 0, 50, 50], "target": {"kind": "goto", "page": 9}},
            ])
        assert not os.path.exists(out)


class TestAppearanceRoundTrip:
    def test_the_default_is_invisible_and_unchanged(self, tmp_dir):
        out, link = _authored(tmp_dir)
        assert link["appearance"] == {
            "width": 0.0, "style": "solid", "color": None, "highlight": "invert",
        }
        # The byte shape every link this app has written already carries.
        with pikepdf.open(out) as pdf:
            annot = pdf.pages[0].obj["/Annots"][0]
            assert [int(v) for v in annot["/Border"]] == [0, 0, 0]
            assert "/BS" not in annot and "/C" not in annot and "/H" not in annot

    @pytest.mark.parametrize("style", ["solid", "dashed", "underline"])
    def test_every_authored_style(self, tmp_dir, style):
        out, link = _authored(tmp_dir, appearance={
            "width": 2, "style": style, "color": [1.0, 0.0, 0.5], "highlight": "outline",
        })
        assert link["appearance"]["width"] == 2.0
        assert link["appearance"]["style"] == style
        assert link["appearance"]["color"] == [1.0, 0.0, 0.5]
        assert link["appearance"]["highlight"] == "outline"
        with pikepdf.open(out) as pdf:
            annot = pdf.pages[0].obj["/Annots"][0]
            # /Border and /BS state the SAME width; disagreeing is the defect.
            assert float(annot["/Border"][2]) == 2.0
            assert float(annot["/BS"]["/W"]) == 2.0
            assert str(annot["/H"]) == "/O"

    def test_dashes_default_and_survive(self, tmp_dir):
        out, link = _authored(tmp_dir, appearance={"width": 1, "style": "dashed"})
        with pikepdf.open(out) as pdf:
            assert [float(v) for v in pdf.pages[0].obj["/Annots"][0]["/BS"]["/D"]] == [3.0]
        assert link["appearance"].get("dashes") == [3.0]
        _, link2 = _authored(tmp_dir, appearance={"width": 1, "style": "dashed", "dashes": [4, 2]})
        assert link2["appearance"]["dashes"] == [4.0, 2.0]

    def test_invert_highlight_writes_nothing(self, tmp_dir):
        out, _ = _authored(tmp_dir, appearance={"width": 1, "highlight": "invert"})
        with pikepdf.open(out) as pdf:
            assert "/H" not in pdf.pages[0].obj["/Annots"][0]

    @pytest.mark.parametrize("mode", ["none", "invert", "outline", "push"])
    def test_every_highlight_mode(self, tmp_dir, mode):
        _, link = _authored(tmp_dir, appearance={"width": 1, "highlight": mode})
        assert link["appearance"]["highlight"] == mode

    def test_beveled_and_inset_are_read_not_authored(self, tmp_dir):
        src = os.path.join(tmp_dir, "beveled.pdf")
        p = pikepdf.new()
        pg = p.add_blank_page(page_size=(300, 400))
        pg.obj["/Annots"] = Array([p.make_indirect(Dictionary(
            Type=Name.Annot, Subtype=Name.Link, Rect=[0, 0, 10, 10],
            BS=Dictionary(W=3, S=Name("/B")),
            A=Dictionary(Type=Name.Action, S=Name.URI, URI=String("https://b.example"))))])
        p.save(src)
        p.close()
        assert list_links(src)["links"][0]["appearance"]["style"] == "beveled"
        with pytest.raises(ValueError, match="style must be solid, dashed or underline"):
            set_link_appearance(src, os.path.join(tmp_dir, "o.pdf"), page=1, index=0,
                                appearance={"width": 3, "style": "beveled"})

    def test_legacy_border_dash_array_reads_as_dashed(self, tmp_dir):
        src = os.path.join(tmp_dir, "legacyborder.pdf")
        p = pikepdf.new()
        pg = p.add_blank_page(page_size=(300, 400))
        pg.obj["/Annots"] = Array([p.make_indirect(Dictionary(
            Type=Name.Annot, Subtype=Name.Link, Rect=[0, 0, 10, 10],
            Border=Array([0, 0, 2, Array([5, 3])])))])
        p.save(src)
        p.close()
        appearance = list_links(src)["links"][0]["appearance"]
        assert appearance["width"] == 2.0
        assert appearance["style"] == "dashed"
        assert appearance["dashes"] == [5.0, 3.0]

    def test_appearance_refusals(self, tmp_dir):
        src = os.path.join(tmp_dir, "s.pdf")
        out = os.path.join(tmp_dir, "o.pdf")
        _blank(src)

        def author(appearance):
            add_links(src, out, links=[
                {"page": 1, "rect": [0, 0, 50, 50], "url": "https://x.example",
                 "appearance": appearance}])

        with pytest.raises(ValueError, match="width must not be negative"):
            author({"width": -1})
        with pytest.raises(ValueError, match="width must be a number"):
            author({"width": "thick"})
        with pytest.raises(ValueError, match="style must be solid, dashed or underline"):
            author({"width": 1, "style": "wavy"})
        with pytest.raises(ValueError, match="colour must be three numbers"):
            author({"width": 1, "color": [1, 0]})
        with pytest.raises(ValueError, match="colour must be three numbers"):
            author({"width": 1, "color": [1, 0, 2]})
        with pytest.raises(ValueError, match="highlight must be none, invert"):
            author({"width": 1, "highlight": "glow"})


class TestEditExisting:
    def test_set_target_replaces_a_uri_with_a_goto(self, tmp_dir):
        src = os.path.join(tmp_dir, "s.pdf")
        out = os.path.join(tmp_dir, "o.pdf")
        _pdf(src)
        result = set_link_target(src, out, page=1, index=0,
                                 target={"kind": "goto", "page": 2, "view": {"mode": "fit"}})
        assert result["target"] == {"kind": "goto", "page": 2, "view": {"mode": "fit"}}
        assert list_links(out)["links"][0]["target_spec"]["kind"] == "goto"

    def test_set_target_to_a_uri_clears_a_destination(self, tmp_dir):
        src = os.path.join(tmp_dir, "s.pdf")
        out = os.path.join(tmp_dir, "o.pdf")
        _pdf(src)
        # Index 1 is the /Dest link; the retarget must remove that /Dest, not
        # leave a link carrying two targets that disagree.
        set_link_target(src, out, page=1, index=1, target={"kind": "uri", "url": "https://n.example"})
        with pikepdf.open(out) as pdf:
            annot = pdf.pages[0].obj["/Annots"][1]
            assert "/Dest" not in annot
            assert str(annot["/A"]["/URI"]) == "https://n.example"

    def test_set_url_still_reports_its_url(self, tmp_dir):
        src = os.path.join(tmp_dir, "s.pdf")
        out = os.path.join(tmp_dir, "o.pdf")
        _pdf(src)
        result = set_link_url(src, out, page=1, index=0, url="https://kept.example")
        assert result["url"] == "https://kept.example"
        assert "target" not in result

    def test_set_appearance_is_total(self, tmp_dir):
        src = os.path.join(tmp_dir, "s.pdf")
        out = os.path.join(tmp_dir, "o.pdf")
        _pdf(src)
        set_link_appearance(src, out, page=1, index=0,
                            appearance={"width": 3, "style": "dashed", "color": [0, 0, 1]})
        again = os.path.join(tmp_dir, "o2.pdf")
        result = set_link_appearance(out, again, page=1, index=0, appearance={"width": 0})
        assert result["appearance"] == {
            "width": 0.0, "style": "solid", "color": None, "highlight": "invert",
        }
        with pikepdf.open(again) as pdf:
            annot = pdf.pages[0].obj["/Annots"][0]
            assert "/BS" not in annot and "/C" not in annot

    def test_set_rect_moves_a_link(self, tmp_dir):
        src = os.path.join(tmp_dir, "s.pdf")
        out = os.path.join(tmp_dir, "o.pdf")
        _pdf(src)
        set_link_rect(src, out, page=1, index=0, rect=[200, 300, 120, 250])
        assert list_links(out)["links"][0]["rect"] == [120.0, 250.0, 200.0, 300.0]
        with pytest.raises(ValueError, match="positive width and height"):
            set_link_rect(src, out, page=1, index=0, rect=[10, 10, 10, 40])

    def test_edits_refuse_a_missing_link(self, tmp_dir):
        src = os.path.join(tmp_dir, "s.pdf")
        out = os.path.join(tmp_dir, "o.pdf")
        _pdf(src)
        with pytest.raises(ValueError, match="link index 7 is out of range"):
            set_link_target(src, out, page=1, index=7, target={"kind": "uri", "url": "https://x"})
        with pytest.raises(ValueError, match="page 9 is out of range"):
            set_link_appearance(src, out, page=9, index=0, appearance={"width": 1})
