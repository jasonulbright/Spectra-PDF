"""Rung 4 — XFDF annotation interchange: export, import, the review thread,
and the round trip."""

import xml.etree.ElementTree as ET

import pikepdf
import pytest

from engine.xfdf import export_xfdf, import_xfdf


def _annot(pdf: pikepdf.Pdf, subtype: str, rect, **extra) -> pikepdf.Object:
    a = pikepdf.Dictionary(
        Type=pikepdf.Name("/Annot"),
        Subtype=pikepdf.Name(subtype),
        Rect=pikepdf.Array(rect),
    )
    for k, v in extra.items():
        a["/" + k] = v
    obj = pdf.make_indirect(a)
    page = pdf.pages[0]
    if page.obj.get("/Annots") is None:
        page.obj["/Annots"] = pdf.make_indirect(pikepdf.Array())
    page.obj["/Annots"].append(obj)
    return obj


def _rich_pdf(path: str) -> None:
    pdf = pikepdf.new()
    pdf.add_blank_page(page_size=(300, 300))
    _annot(
        pdf,
        "/Square",
        [10, 10, 100, 80],
        C=pikepdf.Array([1, 0, 0]),
        IC=pikepdf.Array([0, 0, 1]),
        BS=pikepdf.Dictionary(W=4),
        CA=0.5,
        Contents=pikepdf.String("a box"),
        T=pikepdf.String("Ada"),
        NM=pikepdf.String("sq-1"),
        F=4,
    )
    _annot(
        pdf,
        "/Line",
        [10, 100, 150, 140],
        L=pikepdf.Array([12, 105, 145, 138]),
        LE=pikepdf.Array([pikepdf.Name("/None"), pikepdf.Name("/OpenArrow")]),
        C=pikepdf.Array([0, 0, 0]),
    )
    _annot(
        pdf,
        "/Polygon",
        [10, 150, 120, 250],
        Vertices=pikepdf.Array([20, 160, 100, 160, 60, 240]),
        BE=pikepdf.Dictionary(S=pikepdf.Name("/C"), I=2),
        IT=pikepdf.Name("/PolygonCloud"),
    )
    _annot(
        pdf,
        "/Highlight",
        [150, 20, 250, 40],
        QuadPoints=pikepdf.Array([150, 40, 250, 40, 150, 20, 250, 20]),
        C=pikepdf.Array([1, 1, 0]),
    )
    _annot(
        pdf,
        "/Ink",
        [150, 60, 250, 120],
        InkList=pikepdf.Array(
            [pikepdf.Array([155, 65, 200, 100]), pikepdf.Array([210, 70, 245, 115])]
        ),
    )
    parent = _annot(
        pdf,
        "/Text",
        [150, 150, 170, 170],
        Contents=pikepdf.String("please fix"),
        NM=pikepdf.String("note-parent"),
        T=pikepdf.String("Ada"),
    )
    reply = _annot(
        pdf,
        "/Text",
        [150, 180, 170, 200],
        Contents=pikepdf.String("done"),
        NM=pikepdf.String("note-reply"),
        T=pikepdf.String("Grace"),
        State=pikepdf.String("Completed"),
        StateModel=pikepdf.String("Review"),
    )
    reply["/IRT"] = parent
    pdf.save(path)
    pdf.close()


def _elements(xfdf_path: str) -> list[ET.Element]:
    root = ET.parse(xfdf_path).getroot()
    annots = next(c for c in root if c.tag.endswith("annots"))
    return list(annots)


def test_export_covers_geometry_style_and_thread(tmp_path):
    src = str(tmp_path / "rich.pdf")
    out = str(tmp_path / "rich.xfdf")
    _rich_pdf(src)
    report = export_xfdf(src, out)
    assert report["count"] == 7
    els = {e.tag.rsplit("}", 1)[-1]: e for e in _elements(out)}
    assert els["square"].get("color") == "#FF0000"
    assert els["square"].get("interior-color") == "#0000FF"
    assert els["square"].get("width") == "4"
    assert els["square"].get("opacity") == "0.5"
    assert els["square"].get("title") == "Ada"
    assert els["square"].get("flags") == "print"
    assert next(c for c in els["square"] if c.tag.endswith("contents")).text == "a box"
    assert els["line"].get("start") == "12,105"
    assert els["line"].get("end") == "145,138"
    assert els["line"].get("tail") == "OpenArrow"
    assert els["polygon"].get("style") == "cloudy"
    assert els["polygon"].get("intensity") == "2"
    verts = next(c for c in els["polygon"] if c.tag.endswith("vertices")).text
    assert verts == "20,160;100,160;60,240"
    assert els["highlight"].get("coords") == "150,40,250,40,150,20,250,20"
    gestures = [
        g.text
        for c in els["ink"]
        if c.tag.endswith("inklist")
        for g in c
    ]
    assert gestures == ["155,65;200,100", "210,70;245,115"]
    # The review thread.
    texts = [e for e in _elements(out) if e.tag.endswith("text")]
    reply = next(t for t in texts if t.get("name") == "note-reply")
    assert reply.get("inreplyto") == "note-parent"
    assert reply.get("state") == "Completed"
    assert reply.get("statemodel") == "Review"


def test_import_rebuilds_dicts_and_resolves_replies(tmp_path):
    src = str(tmp_path / "rich.pdf")
    xfdf = str(tmp_path / "rich.xfdf")
    _rich_pdf(src)
    export_xfdf(src, xfdf)

    bare = str(tmp_path / "bare.pdf")
    pdf = pikepdf.new()
    pdf.add_blank_page(page_size=(300, 300))
    pdf.save(bare)
    pdf.close()

    out = str(tmp_path / "imported.pdf")
    report = import_xfdf(bare, xfdf, out)
    assert report["added"] == 7
    assert report["skipped"] == []
    assert "unresolved_replies" not in report

    with pikepdf.open(out) as result:
        annots = list(result.pages[0].obj["/Annots"])
        by_sub: dict[str, list] = {}
        for a in annots:
            by_sub.setdefault(str(a.get("/Subtype")), []).append(a)
        sq = by_sub["/Square"][0]
        assert [round(float(v), 3) for v in sq.get("/C")] == [1, 0, 0]
        assert [round(float(v), 3) for v in sq.get("/IC")] == [0, 0, 1]
        assert float(sq.get("/BS").get("/W")) == 4
        assert round(float(sq.get("/CA")), 3) == 0.5
        assert str(sq.get("/Contents")) == "a box"
        line = by_sub["/Line"][0]
        assert [float(v) for v in line.get("/L")] == [12, 105, 145, 138]
        assert str(line.get("/LE")[1]) == "/OpenArrow"
        poly = by_sub["/Polygon"][0]
        assert str(poly.get("/BE").get("/S")) == "/C"
        assert str(poly.get("/IT")) == "/PolygonCloud"
        assert [float(v) for v in poly.get("/Vertices")] == [20, 160, 100, 160, 60, 240]
        hl = by_sub["/Highlight"][0]
        assert len(hl.get("/QuadPoints")) == 8
        ink = by_sub["/Ink"][0]
        assert len(ink.get("/InkList")) == 2
        texts = by_sub["/Text"]
        reply = next(t for t in texts if str(t.get("/NM")) == "note-reply")
        assert str(reply.get("/State")) == "Completed"
        assert str(reply.get("/StateModel")) == "Review"
        assert str(reply.get("/IRT").get("/NM")) == "note-parent"


def test_round_trip_is_stable(tmp_path):
    src = str(tmp_path / "rich.pdf")
    _rich_pdf(src)
    x1 = str(tmp_path / "one.xfdf")
    export_xfdf(src, x1)
    bare = str(tmp_path / "bare.pdf")
    pdf = pikepdf.new()
    pdf.add_blank_page(page_size=(300, 300))
    pdf.save(bare)
    pdf.close()
    mid = str(tmp_path / "mid.pdf")
    import_xfdf(bare, x1, mid)
    x2 = str(tmp_path / "two.xfdf")
    r2 = export_xfdf(mid, x2)
    assert r2["count"] == 7
    a1 = {(e.tag, e.get("name"), e.get("color"), e.get("state")) for e in _elements(x1)}
    a2 = {(e.tag, e.get("name"), e.get("color"), e.get("state")) for e in _elements(x2)}
    assert a1 == a2


def test_import_skips_are_reported(tmp_path):
    bare = str(tmp_path / "bare.pdf")
    pdf = pikepdf.new()
    pdf.add_blank_page(page_size=(200, 200))
    pdf.save(bare)
    pdf.close()
    xfdf = tmp_path / "odd.xfdf"
    xfdf.write_text(
        '<?xml version="1.0"?><xfdf xmlns="http://ns.adobe.com/xfdf/">'
        "<annots>"
        '<widget page="0" rect="1,1,2,2"/>'
        '<square page="9" rect="1,1,2,2"/>'
        '<square page="0" rect="5,5,50,50"/>'
        "</annots></xfdf>",
        encoding="utf-8",
    )
    out = str(tmp_path / "out.pdf")
    report = import_xfdf(bare, str(xfdf), out)
    assert report["added"] == 1
    reasons = {s["reason"] for s in report["skipped"]}
    assert "unsupported element" in reasons
    assert any("out of range" in r for r in reasons)


def test_import_in_place(tmp_path):
    """output == input must stage-and-swap (pikepdf can't save over its own
    open input — the CLI in-place bug class)."""
    src = str(tmp_path / "rich.pdf")
    xfdf = str(tmp_path / "rich.xfdf")
    _rich_pdf(src)
    export_xfdf(src, xfdf)
    target = str(tmp_path / "target.pdf")
    pdf = pikepdf.new()
    pdf.add_blank_page(page_size=(300, 300))
    pdf.save(target)
    pdf.close()
    report = import_xfdf(target, xfdf, target)
    assert report["added"] == 7
    with pikepdf.open(target) as result:
        assert len(result.pages[0].obj["/Annots"]) == 7


def _thread_and_group(path: str) -> None:
    """One page carrying BOTH structures against one target: a reply
    (`/RT /R`) and a group member (`/RT /Group`) that both point at the same
    parent. The interchange has to bring back two distinct relationships, not
    two copies of one."""
    pdf = pikepdf.new()
    pdf.add_blank_page(page_size=(400, 400))
    parent = _annot(
        pdf, "/Text", [10, 10, 30, 30],
        Contents=pikepdf.String("the parent"), T=pikepdf.String("Ada"),
        NM=pikepdf.String("p-1"),
    )
    reply = _annot(
        pdf, "/Text", [40, 10, 60, 30],
        Contents=pikepdf.String("a reply"), T=pikepdf.String("Grace"),
        NM=pikepdf.String("r-1"),
    )
    reply["/IRT"] = parent
    reply["/RT"] = pikepdf.Name("/R")
    member = _annot(
        pdf, "/Square", [100, 100, 200, 200],
        Contents=pikepdf.String("a group member"), T=pikepdf.String("Ada"),
        NM=pikepdf.String("g-1"),
    )
    member["/IRT"] = parent
    member["/RT"] = pikepdf.Name("/Group")
    pdf.save(path)
    pdf.close()


def _bare(path: str, pages: int = 1, size=(400, 400)) -> None:
    pdf = pikepdf.new()
    for _ in range(pages):
        pdf.add_blank_page(page_size=size)
    pdf.save(path)
    pdf.close()


def test_group_and_reply_survive_the_round_trip_as_two_structures(tmp_path):
    src = str(tmp_path / "threaded.pdf")
    xfdf = str(tmp_path / "threaded.xfdf")
    _thread_and_group(src)

    report = export_xfdf(src, xfdf)
    assert report["relationships"] == {"R": 1, "Group": 1}
    els = {e.get("name"): e for e in _elements(xfdf)}
    assert els["r-1"].get("inreplyto") == "p-1"
    assert els["r-1"].get("replyType") == "R"
    assert els["g-1"].get("inreplyto") == "p-1"
    assert els["g-1"].get("replyType") == "Group"
    assert els["p-1"].get("inreplyto") is None
    assert els["p-1"].get("replyType") is None

    bare = str(tmp_path / "bare.pdf")
    _bare(bare)
    out = str(tmp_path / "back.pdf")
    back = import_xfdf(bare, xfdf, out)
    assert back["added"] == 3
    assert back["relationships"] == {"R": 1, "Group": 1}
    assert "unresolved_replies" not in back

    with pikepdf.open(out) as result:
        by_nm = {str(a.get("/NM")): a for a in result.pages[0].obj["/Annots"]}
        assert str(by_nm["r-1"]["/IRT"]["/NM"]) == "p-1"
        assert str(by_nm["g-1"]["/IRT"]["/NM"]) == "p-1"
        assert str(by_nm["r-1"]["/RT"]) == "/R"
        assert str(by_nm["g-1"]["/RT"]) == "/Group"
        assert str(by_nm["r-1"]["/RT"]) != str(by_nm["g-1"]["/RT"])
        assert by_nm["p-1"].get("/IRT") is None
        assert by_nm["p-1"].get("/RT") is None

    # Closed, not merely non-throwing: exporting the rebuilt document
    # reproduces the same three (name, target, relationship) triples.
    again = str(tmp_path / "again.xfdf")
    export_xfdf(out, again)
    triples = {
        (e.get("name"), e.get("inreplyto"), e.get("replyType"))
        for e in _elements(again)
    }
    assert triples == {
        ("p-1", None, None),
        ("r-1", "p-1", "R"),
        ("g-1", "p-1", "Group"),
    }


def test_import_makes_the_default_relationship_explicit(tmp_path):
    """An XFDF with no replyType means the format's default. The imported file
    says so, so the next reader never has to supply it."""
    bare = str(tmp_path / "bare.pdf")
    _bare(bare)
    xfdf = tmp_path / "plain.xfdf"
    xfdf.write_text(
        '<?xml version="1.0"?><xfdf xmlns="http://ns.adobe.com/xfdf/"><annots>'
        '<text page="0" rect="1,1,20,20" name="a"/>'
        '<text page="0" rect="30,1,50,20" name="b" inreplyto="a"/>'
        "</annots></xfdf>",
        encoding="utf-8",
    )
    out = str(tmp_path / "out.pdf")
    report = import_xfdf(bare, str(xfdf), out)
    assert report["relationships"] == {"R": 1}
    with pikepdf.open(out) as result:
        by_nm = {str(a.get("/NM")): a for a in result.pages[0].obj["/Annots"]}
        assert str(by_nm["b"]["/RT"]) == "/R"


def test_relationship_outside_the_defined_pair_is_transcribed_both_ways(tmp_path):
    src = str(tmp_path / "odd.pdf")
    pdf = pikepdf.new()
    pdf.add_blank_page(page_size=(400, 400))
    parent = _annot(pdf, "/Text", [10, 10, 30, 30], NM=pikepdf.String("p"))
    child = _annot(pdf, "/Text", [40, 10, 60, 30], NM=pikepdf.String("c"))
    child["/IRT"] = parent
    child["/RT"] = pikepdf.Name("/Custom")
    pdf.save(src)
    pdf.close()

    xfdf = str(tmp_path / "odd.xfdf")
    report = export_xfdf(src, xfdf)
    assert report["relationships"] == {"Custom": 1}
    els = {e.get("name"): e for e in _elements(xfdf)}
    assert els["c"].get("replyType") == "Custom"

    bare = str(tmp_path / "bare.pdf")
    _bare(bare)
    out = str(tmp_path / "back.pdf")
    import_xfdf(bare, xfdf, out)
    with pikepdf.open(out) as result:
        by_nm = {str(a.get("/NM")): a for a in result.pages[0].obj["/Annots"]}
        assert str(by_nm["c"]["/RT"]) == "/Custom"


def test_reply_type_without_a_target_is_dropped_and_counted(tmp_path):
    src = str(tmp_path / "dangling.pdf")
    pdf = pikepdf.new()
    pdf.add_blank_page(page_size=(400, 400))
    lone = _annot(pdf, "/Text", [10, 10, 30, 30], NM=pikepdf.String("lone"))
    lone["/RT"] = pikepdf.Name("/Group")
    pdf.save(src)
    pdf.close()

    xfdf = str(tmp_path / "dangling.xfdf")
    report = export_xfdf(src, xfdf)
    assert report["dangling_reply_type"] == 1
    assert report["relationships"] == {}
    assert _elements(xfdf)[0].get("replyType") is None

    bare = str(tmp_path / "bare.pdf")
    _bare(bare)
    stray = tmp_path / "stray.xfdf"
    stray.write_text(
        '<?xml version="1.0"?><xfdf xmlns="http://ns.adobe.com/xfdf/"><annots>'
        '<text page="0" rect="1,1,20,20" name="a" replyType="Group"/>'
        "</annots></xfdf>",
        encoding="utf-8",
    )
    out = str(tmp_path / "out.pdf")
    back = import_xfdf(bare, str(stray), out)
    assert back["dangling_reply_type"] == 1
    with pikepdf.open(out) as result:
        assert result.pages[0].obj["/Annots"][0].get("/RT") is None


def test_export_refuses_when_the_target_has_no_name(tmp_path):
    src = str(tmp_path / "unnamed.pdf")
    pdf = pikepdf.new()
    pdf.add_blank_page(page_size=(400, 400))
    parent = _annot(pdf, "/Text", [10, 10, 30, 30])
    child = _annot(pdf, "/Text", [40, 10, 60, 30], NM=pikepdf.String("c"))
    child["/IRT"] = parent
    child["/RT"] = pikepdf.Name("/Group")
    pdf.save(src)
    pdf.close()
    with pytest.raises(ValueError, match="has no name"):
        export_xfdf(src, str(tmp_path / "unnamed.xfdf"))


def test_export_refuses_an_unreadable_relationship(tmp_path):
    src = str(tmp_path / "broken.pdf")
    pdf = pikepdf.new()
    pdf.add_blank_page(page_size=(400, 400))
    parent = _annot(pdf, "/Text", [10, 10, 30, 30], NM=pikepdf.String("p"))
    child = _annot(pdf, "/Text", [40, 10, 60, 30], NM=pikepdf.String("c"))
    child["/IRT"] = parent
    child["/RT"] = pikepdf.String("Group")  # a string, where the format says name
    pdf.save(src)
    pdf.close()
    with pytest.raises(ValueError, match="cannot be read"):
        export_xfdf(src, str(tmp_path / "broken.xfdf"))


def test_import_refuses_a_reply_type_it_cannot_carry(tmp_path):
    bare = str(tmp_path / "bare.pdf")
    _bare(bare)
    xfdf = tmp_path / "bad.xfdf"
    xfdf.write_text(
        '<?xml version="1.0"?><xfdf xmlns="http://ns.adobe.com/xfdf/"><annots>'
        '<text page="0" rect="1,1,20,20" name="a"/>'
        '<text page="0" rect="30,1,50,20" name="b" inreplyto="a" replyType="a b"/>'
        "</annots></xfdf>",
        encoding="utf-8",
    )
    with pytest.raises(ValueError, match="not a reply relationship"):
        import_xfdf(bare, str(xfdf), str(tmp_path / "out.pdf"))


def test_import_accepts_the_lowercase_spelling_producers_write(tmp_path):
    bare = str(tmp_path / "bare.pdf")
    _bare(bare)
    xfdf = tmp_path / "lower.xfdf"
    xfdf.write_text(
        '<?xml version="1.0"?><xfdf xmlns="http://ns.adobe.com/xfdf/"><annots>'
        '<square page="0" rect="1,1,20,20" name="a"/>'
        '<circle page="0" rect="30,1,50,20" name="b" inreplyto="a" replyType="group"/>'
        "</annots></xfdf>",
        encoding="utf-8",
    )
    out = str(tmp_path / "out.pdf")
    report = import_xfdf(bare, str(xfdf), out)
    assert report["relationships"] == {"Group": 1}
    with pikepdf.open(out) as result:
        by_nm = {str(a.get("/NM")): a for a in result.pages[0].obj["/Annots"]}
        assert str(by_nm["b"]["/RT"]) == "/Group"


def test_a_name_ambiguous_across_pages_does_not_bind(tmp_path):
    """/NM is unique only within a page and an /IRT pair is required to be on
    one page, so a name that names two annotations resolves to neither rather
    than to whichever the walk reached first."""
    bare = str(tmp_path / "bare.pdf")
    _bare(bare, pages=3)
    xfdf = tmp_path / "collide.xfdf"
    xfdf.write_text(
        '<?xml version="1.0"?><xfdf xmlns="http://ns.adobe.com/xfdf/"><annots>'
        '<text page="0" rect="1,1,20,20" name="dup"/>'
        '<text page="1" rect="1,1,20,20" name="dup"/>'
        '<text page="2" rect="30,1,50,20" name="reply" inreplyto="dup"/>'
        "</annots></xfdf>",
        encoding="utf-8",
    )
    out = str(tmp_path / "out.pdf")
    report = import_xfdf(bare, str(xfdf), out)
    assert report["added"] == 3
    assert report["unresolved_replies"] == 1
    assert report["relationships"] == {}
    with pikepdf.open(out) as result:
        reply = next(
            a for a in result.pages[2].obj["/Annots"] if str(a.get("/NM")) == "reply"
        )
        assert reply.get("/IRT") is None
        assert reply.get("/RT") is None


def test_a_reply_binds_to_its_own_page_when_the_name_repeats(tmp_path):
    bare = str(tmp_path / "bare.pdf")
    _bare(bare, pages=2)
    xfdf = tmp_path / "scoped.xfdf"
    xfdf.write_text(
        '<?xml version="1.0"?><xfdf xmlns="http://ns.adobe.com/xfdf/"><annots>'
        '<text page="0" rect="1,1,20,20" name="dup"><contents>page one</contents></text>'
        '<text page="1" rect="1,1,20,20" name="dup"><contents>page two</contents></text>'
        '<text page="1" rect="30,1,50,20" name="reply" inreplyto="dup" replyType="Group"/>'
        "</annots></xfdf>",
        encoding="utf-8",
    )
    out = str(tmp_path / "out.pdf")
    report = import_xfdf(bare, str(xfdf), out)
    assert report["relationships"] == {"Group": 1}
    with pikepdf.open(out) as result:
        reply = next(
            a for a in result.pages[1].obj["/Annots"] if str(a.get("/NM")) == "reply"
        )
        assert str(reply["/IRT"]["/Contents"]) == "page two"


def test_export_empty_document(tmp_path):
    bare = str(tmp_path / "bare.pdf")
    pdf = pikepdf.new()
    pdf.add_blank_page(page_size=(200, 200))
    pdf.save(bare)
    pdf.close()
    out = str(tmp_path / "empty.xfdf")
    report = export_xfdf(bare, out)
    assert report["count"] == 0
    assert _elements(out) == []


def _eight_comments(path: str) -> None:
    """Eight markup annotations across three pages, two of which XFDF has no
    element for and one of which carries a /Rect that is not a rectangle. A
    /Popup rides along: it is not a comment and must count as neither."""
    pdf = pikepdf.new()
    for size in ((612, 792), (792, 612), (612, 792)):
        pdf.add_blank_page(page_size=size)

    def annot(page, subtype, rect, **kw):
        d = pikepdf.Dictionary(
            Type=pikepdf.Name("/Annot"),
            Subtype=pikepdf.Name(subtype),
            Rect=pikepdf.Array(rect),
        )
        for k, v in kw.items():
            d["/" + k] = v
        obj = pdf.make_indirect(d)
        p = pdf.pages[page]
        if p.obj.get("/Annots") is None:
            p.obj["/Annots"] = pdf.make_indirect(pikepdf.Array())
        p.obj["/Annots"].append(obj)
        return obj

    parent = annot(0, "/Text", [72, 700, 92, 720], NM=pikepdf.String("uuid-parent"))
    reply = annot(0, "/Text", [92, 700, 112, 720], NM=pikepdf.String("uuid-reply"))
    reply["/IRT"] = parent
    reply["/RT"] = pikepdf.Name("/R")
    grouped = annot(0, "/Square", [200, 600, 300, 660], NM=pikepdf.String("uuid-group"))
    grouped["/IRT"] = parent
    grouped["/RT"] = pikepdf.Name("/Group")
    annot(1, "/Text", [400, 300, 420, 320], NM=pikepdf.String("uuid-orphan"))
    annot(1, "/Popup", [500, 300, 640, 400], Open=False)
    annot(
        2, "/Highlight", [72, 100, 300, 130],
        QuadPoints=pikepdf.Array([72, 130, 300, 130, 72, 100, 300, 100]),
    )
    bad = annot(2, "/Square", [0, 0, 10, 10])
    bad["/Rect"] = pikepdf.String("not-an-array")
    annot(1, "/FileAttachment", [100, 100, 120, 120])
    annot(1, "/Redact", [150, 150, 250, 170])
    pdf.save(path)
    pdf.close()


def test_one_malformed_rect_costs_that_comment_and_no_other(tmp_path):
    """The export used to raise out of the whole document on a single /Rect
    that would not read, leaving no file at all."""
    src = str(tmp_path / "eight.pdf")
    out = tmp_path / "eight.xfdf"
    _eight_comments(src)

    report = export_xfdf(src, str(out))

    assert out.exists()
    assert report["found"] == 8
    assert report["count"] == 5
    assert len(_elements(str(out))) == 5
    bad = [s for s in report["skipped"] if "rect" in s["reason"]]
    assert bad == [
        {"page": 2, "subtype": "Square", "element": "square",
         "reason": "the annotation rect cannot be read"}
    ]
    # The comments that read are all present, the thread among them intact.
    assert report["by_type"] == {"text": 3, "square": 1, "highlight": 1}
    assert report["relationships"] == {"R": 1, "Group": 1}


def test_a_subtype_xfdf_cannot_carry_is_reported_not_dropped(tmp_path):
    """/FileAttachment, /Sound and /Redact are markup annotations with no XFDF
    element. They used to vanish with the report saying only how many elements
    were written."""
    src = str(tmp_path / "eight.pdf")
    _eight_comments(src)
    report = export_xfdf(src, str(tmp_path / "eight.xfdf"))

    unmapped = sorted(
        (s["page"], s["subtype"])
        for s in report["skipped"]
        if s["reason"] == "XFDF has no element for this subtype"
    )
    assert unmapped == [(1, "FileAttachment"), (1, "Redact")]
    # The population is the markup set: a popup is not a comment, so it is
    # neither exported nor reported as a loss.
    assert report["found"] == 8
    assert all(s["subtype"] != "Popup" for s in report["skipped"])


def test_a_malformed_border_width_thins_one_comment_instead_of_failing(tmp_path):
    src = str(tmp_path / "width.pdf")
    pdf = pikepdf.new()
    pdf.add_blank_page(page_size=(400, 400))
    circle = _annot(pdf, "/Circle", [10, 10, 60, 60], Contents=pikepdf.String("hi"))
    circle["/BS"] = pikepdf.Dictionary(W=pikepdf.Name("/Thick"))
    pdf.save(src)
    pdf.close()

    out = tmp_path / "width.xfdf"
    report = export_xfdf(src, str(out))

    assert report["count"] == 1
    assert report["found"] == 1
    assert report["skipped"] == []
    assert report["partial"] == [
        {"page": 0, "subtype": "Circle", "element": "circle",
         "attribute": "width", "reason": "the value cannot be read"}
    ]
    el = _elements(str(out))[0]
    assert el.get("width") is None
    assert el.get("rect") == "10,10,60,60"


def test_an_annotation_with_no_rect_is_skipped_rather_than_placed_nowhere(tmp_path):
    """Rect is required of every annotation, and it is what puts an XFDF
    element on a page — an element without one is what our own import
    refuses."""
    src = str(tmp_path / "norect.pdf")
    pdf = pikepdf.new()
    pdf.add_blank_page(page_size=(400, 400))
    a = _annot(pdf, "/Square", [10, 10, 60, 60], NM=pikepdf.String("no-rect"))
    del a["/Rect"]
    pdf.save(src)
    pdf.close()

    out = tmp_path / "norect.xfdf"
    report = export_xfdf(src, str(out))

    assert report["count"] == 0
    assert report["found"] == 1
    assert report["skipped"] == [
        {"page": 0, "subtype": "Square", "name": "no-rect", "element": "square",
         "reason": "the annotation has no rect"}
    ]
    assert _elements(str(out)) == []


def test_unreadable_ink_geometry_skips_the_comment_not_the_export(tmp_path):
    """An ink gesture whose points will not read exports as an empty box that a
    re-import turns into an invisible annotation, so the comment is skipped."""
    src = str(tmp_path / "ink.pdf")
    pdf = pikepdf.new()
    pdf.add_blank_page(page_size=(400, 400))
    _annot(pdf, "/Square", [10, 10, 60, 60], NM=pikepdf.String("intact"))
    ink = _annot(pdf, "/Ink", [100, 100, 200, 200], NM=pikepdf.String("broken"))
    ink["/InkList"] = pikepdf.Array([pikepdf.String("not-points")])
    pdf.save(src)
    pdf.close()

    out = tmp_path / "ink.xfdf"
    report = export_xfdf(src, str(out))

    assert report["count"] == 1
    assert report["found"] == 2
    assert report["skipped"] == [
        {"page": 0, "subtype": "Ink", "name": "broken", "element": "ink",
         "reason": "the /InkList geometry cannot be read"}
    ]
    assert [e.tag.rsplit("}", 1)[-1] for e in _elements(str(out))] == ["square"]


def test_widgets_and_links_are_not_comments_and_are_not_reported_as_losses(tmp_path):
    src = str(tmp_path / "chrome.pdf")
    pdf = pikepdf.new()
    pdf.add_blank_page(page_size=(400, 400))
    widget = _annot(
        pdf, "/Widget", [10, 10, 60, 60],
        FT=pikepdf.Name("/Tx"), T=pikepdf.String("field-1"),
    )
    pdf.Root["/AcroForm"] = pdf.make_indirect(
        pikepdf.Dictionary(Fields=pikepdf.Array([widget]))
    )
    _annot(pdf, "/Link", [70, 10, 120, 60])
    _annot(pdf, "/Square", [130, 10, 180, 60])
    pdf.save(src)
    pdf.close()

    report = export_xfdf(src, str(tmp_path / "chrome.xfdf"))
    assert report["found"] == 1
    assert report["count"] == 1
    assert report["skipped"] == []


def test_import_missing_annots_section(tmp_path):
    bare = str(tmp_path / "bare.pdf")
    pdf = pikepdf.new()
    pdf.add_blank_page(page_size=(200, 200))
    pdf.save(bare)
    pdf.close()
    xfdf = tmp_path / "fields-only.xfdf"
    xfdf.write_text(
        '<?xml version="1.0"?><xfdf xmlns="http://ns.adobe.com/xfdf/"><fields/></xfdf>',
        encoding="utf-8",
    )
    with pytest.raises(ValueError):
        import_xfdf(bare, str(xfdf), str(tmp_path / "out.pdf"))
