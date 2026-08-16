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
