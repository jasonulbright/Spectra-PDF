"""Tests for the outline (bookmarks) engine handlers."""

import os

import pytest

from engine.outline import get_outline, set_outline


def test_get_outline_empty(sample_pdf):
    result = get_outline(sample_pdf)
    assert result["outline"] == []
    assert result["count"] == 0
    assert result["truncated"] is False


def test_set_and_get_round_trip(sample_pdf, tmp_dir):
    out = os.path.join(tmp_dir, "out.pdf")
    tree = [
        {"title": "Cover", "page": 1, "children": []},
        {
            "title": "Chapter 1",
            "page": 2,
            "children": [
                {"title": "Section 1.1", "page": 3, "children": []},
                {"title": "Section 1.2", "page": 4, "children": []},
            ],
        },
        {"title": "No target", "page": None, "children": []},
    ]
    result = set_outline(sample_pdf, tree, out)
    assert result["count"] == 5

    read = get_outline(out)
    assert read["count"] == 5
    assert [i["title"] for i in read["outline"]] == ["Cover", "Chapter 1", "No target"]
    chapter = read["outline"][1]
    assert chapter["page"] == 2
    assert [c["title"] for c in chapter["children"]] == ["Section 1.1", "Section 1.2"]
    assert chapter["children"][0]["page"] == 3
    assert read["outline"][2]["page"] is None


def test_set_outline_in_place(sample_pdf, tmp_dir):
    import shutil

    working = os.path.join(tmp_dir, "working.pdf")
    shutil.copy(sample_pdf, working)
    set_outline(working, [{"title": "A", "page": 1, "children": []}], working)
    assert get_outline(working)["count"] == 1


def test_set_outline_clears(sample_pdf, tmp_dir):
    out = os.path.join(tmp_dir, "out.pdf")
    set_outline(sample_pdf, [{"title": "A", "page": 1, "children": []}], out)
    set_outline(out, [], out)
    assert get_outline(out)["count"] == 0


def test_set_outline_rejects_out_of_range(sample_pdf, tmp_dir):
    out = os.path.join(tmp_dir, "out.pdf")
    with pytest.raises(ValueError, match="targets page 99"):
        set_outline(sample_pdf, [{"title": "Bad", "page": 99, "children": []}], out)


def test_untitled_fallback(sample_pdf, tmp_dir):
    out = os.path.join(tmp_dir, "out.pdf")
    set_outline(sample_pdf, [{"title": "  ", "page": 1, "children": []}], out)
    assert get_outline(out)["outline"][0]["title"] == "Untitled"


# ── Phase 2l: action preservation on get→set round trips ────────────────────


def _make_action_outline(path: str) -> None:
    """An outline with a page link, a URI action, a GoToR action, and a
    JavaScript action — the non-page-resolvable kinds that used to be dropped
    (round-tripped as title-only) by set_outline."""
    import pikepdf
    from pikepdf import OutlineItem

    pdf = pikepdf.new()
    pdf.add_blank_page(page_size=(200, 200))
    pdf.add_blank_page(page_size=(200, 200))
    with pdf.open_outline() as ol:
        ol.root.append(OutlineItem("Page link", 1))
        ol.root.append(
            OutlineItem(
                "Website",
                action=pikepdf.Dictionary(
                    S=pikepdf.Name.URI, URI=pikepdf.String("https://example.com/x?q=1")
                ),
            )
        )
        ol.root.append(
            OutlineItem(
                "Other doc",
                action=pikepdf.Dictionary(
                    S=pikepdf.Name.GoToR,
                    F=pikepdf.String("other.pdf"),
                    D=pikepdf.Array([0, pikepdf.Name.Fit]),
                ),
            )
        )
        ol.root.append(
            OutlineItem(
                "Script",
                action=pikepdf.Dictionary(
                    S=pikepdf.Name.JavaScript, JS=pikepdf.String("app.alert('hi')")
                ),
            )
        )
    pdf.save(path)
    pdf.close()


def test_actions_survive_round_trip(tmp_dir):
    import pikepdf

    src = os.path.join(tmp_dir, "actions.pdf")
    out = os.path.join(tmp_dir, "actions_out.pdf")
    _make_action_outline(src)

    r1 = get_outline(src)
    # Non-page items carry a serialized action payload now, not just null page.
    by_title = {i["title"]: i for i in r1["outline"]}
    assert by_title["Website"]["page"] is None and "action" in by_title["Website"]
    assert by_title["Other doc"]["page"] is None and "action" in by_title["Other doc"]
    assert by_title["Script"]["page"] is None and "action" in by_title["Script"]
    assert "action" not in by_title["Page link"]

    set_outline(src, r1["outline"], out)
    r2 = get_outline(out)
    assert r2["outline"] == r1["outline"]  # stable round trip

    # Independent raw check: the rebuilt file carries the REAL actions.
    with pikepdf.open(out) as pdf:
        first = pdf.Root.Outlines.First
        website = first.Next
        assert str(website.A.S) == "/URI"
        assert str(website.A.URI) == "https://example.com/x?q=1"
        gotor = website.Next
        assert str(gotor.A.S) == "/GoToR"
        assert str(gotor.A.F) == "other.pdf"
        assert [str(v) for v in gotor.A.D] == ["0", "/Fit"]
        script = gotor.Next
        assert str(script.A.S) == "/JavaScript"
        assert str(script.A.JS) == "app.alert('hi')"


def test_edit_preserves_sibling_actions(tmp_dir):
    # The realistic GUI flow: read, retitle ONE item, write back — the other
    # items' actions must survive untouched.
    src = os.path.join(tmp_dir, "actions.pdf")
    out = os.path.join(tmp_dir, "edited.pdf")
    _make_action_outline(src)
    tree = get_outline(src)["outline"]
    tree[0]["title"] = "Renamed page link"
    set_outline(src, tree, out)
    r = get_outline(out)
    assert r["outline"][0]["title"] == "Renamed page link"
    assert "action" in r["outline"][1]  # URI kept
    assert r["outline"][1]["action"] == tree[1]["action"]


def test_named_dest_string_round_trips(tmp_dir):
    # A named destination that does NOT resolve to a page (no /Names tree)
    # round-trips through the `dest` payload instead of being dropped.
    import pikepdf
    from pikepdf import OutlineItem

    src = os.path.join(tmp_dir, "named.pdf")
    out = os.path.join(tmp_dir, "named_out.pdf")
    pdf = pikepdf.new()
    pdf.add_blank_page(page_size=(200, 200))
    with pdf.open_outline() as ol:
        ol.root.append(OutlineItem("Named", destination=pikepdf.String("chapter-3")))
    pdf.save(src)
    pdf.close()

    r1 = get_outline(src)
    assert r1["outline"][0]["page"] is None
    assert r1["outline"][0].get("dest") == {"s": "chapter-3"}
    set_outline(src, r1["outline"], out)
    with pikepdf.open(out) as pdf2:
        assert str(pdf2.Root.Outlines.First.Dest) == "chapter-3"


def test_malformed_action_payload_rejected(sample_pdf, tmp_dir):
    out = os.path.join(tmp_dir, "out.pdf")
    with pytest.raises(ValueError, match="action payload"):
        set_outline(
            sample_pdf,
            [{"title": "Bad", "page": None, "children": [], "action": {"s": "not a dict"}}],
            out,
        )


def test_deserialize_depth_capped(sample_pdf, tmp_dir):
    # Review: a hand-built over-deep action payload gets a clean ValueError,
    # not a RecursionError (symmetric with the serialize side's cap).
    out = os.path.join(tmp_dir, "out.pdf")
    deep: dict = {"d": {"/S": {"n": "/URI"}}}
    for _ in range(50):
        deep = {"a": [deep]}
    with pytest.raises(ValueError, match="nested too deeply|action payload"):
        set_outline(
            sample_pdf,
            [{"title": "Deep", "page": None, "children": [], "action": deep}],
            out,
        )
    assert not os.path.exists(out)


def test_stream_action_flags_lossy(tmp_dir):
    # The promised action_lossy test: a spec-legal /JS held as a STREAM can't
    # round-trip through the JSON payload — the item must be flagged, never
    # silently dropped or crashed on.
    import pikepdf
    from pikepdf import OutlineItem

    src = os.path.join(tmp_dir, "jsstream.pdf")
    pdf = pikepdf.new()
    pdf.add_blank_page(page_size=(200, 200))
    js_stream = pdf.make_stream(b"app.alert('hi')")
    with pdf.open_outline() as ol:
        ol.root.append(
            OutlineItem(
                "Scripted",
                action=pikepdf.Dictionary(S=pikepdf.Name.JavaScript, JS=js_stream),
            )
        )
    pdf.save(src)
    pdf.close()

    r = get_outline(src)
    item = r["outline"][0]
    assert item["page"] is None
    assert item.get("action_lossy") is True
    assert "action" not in item
