"""The comment summary — the review model, and the document it produces.

The proof is a round trip over a built fixture, not an eyeball: the summary's
own text is extracted back out and every source body has to appear exactly
once, and the drawn geometry is compared against the matrix composition
computed by hand.

Font-dependent (the entries are authored text), like test_text_authoring.
"""

import os
import re

import pikepdf
import pytest
from pikepdf import Array, Dictionary, Name, String

from engine import bidi
from engine.comment_summary import (
    DEFAULT_LABELS,
    _anchor,
    _apply,
    _cells,
    build_model,
    list_comments,
    parse_pdf_date,
    summarize_comments,
)
from engine.text_authoring import add_text_box
from engine.extract_text import extract_text
from engine.print_layout import place_in_cell
from engine.watermark import _resolve_box, _resolve_rotate, _source_matrix

FONTS_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "resources", "fonts"
)

pytestmark = pytest.mark.skipif(
    not os.path.isfile(os.path.join(FONTS_DIR, "LiberationSans-Regular.ttf")),
    reason="bundled fonts not provisioned",
)

MODES = ("comments_only", "document_and_comments")
PLACEMENTS = ("auto", "beside", "beneath", "separate")

PARENT = "the parent comment"
REPLY = "a reply to it"
GROUPED = "group member, not a reply"
ORPHAN = "orphaned reply"
ATTACHED = "see attached"
REDACTED = "redact me"
ARABIC = "هذا تعليق عربي"
ARABIC_AUTHOR = "محمد"
BADRECT = "bad rect"

BODIES = (PARENT, REPLY, GROUPED, ORPHAN, ATTACHED, REDACTED, ARABIC, BADRECT)


def _annot(pdf, page, subtype, rect, **kw):
    d = Dictionary(Type=Name.Annot, Subtype=Name(subtype), Rect=Array(rect))
    for key, value in kw.items():
        d["/" + key] = value
    obj = pdf.make_indirect(d)
    target = pdf.pages[page]
    if target.obj.get("/Annots") is None:
        target.obj["/Annots"] = pdf.make_indirect(Array())
    target.obj["/Annots"].append(obj)
    return obj


def _fixture(path: str) -> str:
    """Eight markup annotations over a portrait page, a landscape page and a
    /Rotate 90 page: a parent with a reply and a group member, an orphaned
    /IRT, a popup, an Arabic body, an Arabic author name, a /FileAttachment, a
    /Redact, a /Rect that is a string, and one subtype outside the markup set.
    """
    pdf = pikepdf.new()
    pdf.add_blank_page(page_size=(612, 792))
    pdf.add_blank_page(page_size=(792, 612))
    pdf.add_blank_page(page_size=(612, 792))
    pdf.pages[2].obj["/Rotate"] = 90

    parent = _annot(
        pdf, 0, "/Text", [72, 700, 92, 720],
        Contents=String(PARENT), T=String("Aya Nakamura"), Subj=String("Clause 4"),
        M=String("D:20260814093000+02'00'"),
        CreationDate=String("D:20260814092500+02'00'"), NM=String("uuid-parent"),
    )
    reply = _annot(
        pdf, 0, "/Text", [92, 700, 112, 720],
        Contents=String(REPLY), T=String(ARABIC_AUTHOR),
        M=String("D:20260814101500Z"), NM=String("uuid-reply"),
        State=String("Accepted"), StateModel=String("Review"),
    )
    reply["/IRT"] = parent
    reply["/RT"] = Name("/R")

    grouped = _annot(
        pdf, 0, "/Square", [200, 600, 300, 660],
        Contents=String(GROUPED), T=String("Aya Nakamura"), NM=String("uuid-group"),
    )
    grouped["/IRT"] = parent
    grouped["/RT"] = Name("/Group")

    ghost = pdf.make_indirect(Dictionary(
        Type=Name.Annot, Subtype=Name("/Text"), Rect=Array([0, 0, 1, 1]),
        NM=String("uuid-ghost"),
    ))
    orphan = _annot(
        pdf, 1, "/Text", [400, 300, 420, 320],
        Contents=String(ORPHAN), T=String("Rui"), NM=String("uuid-orphan"),
    )
    orphan["/IRT"] = ghost

    _annot(pdf, 1, "/Popup", [500, 300, 640, 400], Open=False)
    _annot(
        pdf, 2, "/Highlight", [72, 100, 300, 130],
        Contents=String(ARABIC), T=String("Layla"), M=String("D:20260701120000+03'00'"),
    )
    bad = _annot(pdf, 2, "/Square", [0, 0, 10, 10], Contents=String(BADRECT))
    bad["/Rect"] = String("not-an-array")
    _annot(
        pdf, 1, "/FileAttachment", [100, 100, 120, 120],
        Contents=String(ATTACHED), T=String("Rui"),
    )
    _annot(pdf, 1, "/Redact", [150, 150, 250, 170],
           Contents=String(REDACTED), T=String("Rui"))
    _annot(pdf, 1, "/Screen", [300, 300, 320, 320])
    pdf.save(path)
    pdf.close()
    return path


@pytest.fixture
def fixture_pdf(tmp_dir):
    return _fixture(os.path.join(tmp_dir, "review.pdf"))


def _summary(src, tmp_dir, name="out.pdf", **kw):
    kw.setdefault("font_path", FONTS_DIR)
    return summarize_comments(src, os.path.join(tmp_dir, name), **kw)


def _flat(text: str) -> str:
    """Extracted text with its line structure collapsed. A 216-point column
    wraps, so a body or a furniture line arrives split across lines that carry
    no meaning of their own."""
    return re.sub(r"\s+", " ", text)


def _text(path: str) -> str:
    return _flat(extract_text(path)["text"])


def _as_authored(body: str, tmp_dir: str) -> str:
    """What the shipped text authoring makes of `body`, read back the same way
    the summary is read back.

    A right-to-left paragraph is DRAWN in visual order and a shaped ligature
    carries its cluster's characters in LOGICAL order inside a single code, so
    a plain extraction of Arabic is neither the source string nor its
    `visual_order`. What the summary owes is that its rendering of a body is
    the product's own rendering of that body — nothing about the reading is
    allowed to degrade because the text went through a summary.
    """
    if not bidi.has_strong_rtl(body):
        return _flat(body)
    blank = os.path.join(tmp_dir, "authored-in.pdf")
    drawn = os.path.join(tmp_dir, "authored-out.pdf")
    pdf = pikepdf.new()
    pdf.add_blank_page(page_size=(612, 792))
    pdf.save(blank)
    pdf.close()
    add_text_box(blank, drawn, 1, [72, 600, 540, 720], body, font_path=FONTS_DIR)
    return _text(drawn).strip()


def _appearances(text: str, body: str, tmp_dir: str) -> int:
    """How many times a source body shows up in the extracted summary."""
    return text.count(_as_authored(body, tmp_dir))


# ---------------------------------------------------------------------------
# The model
# ---------------------------------------------------------------------------

class TestListComments:
    def test_returns_every_review_field(self, fixture_pdf):
        model = list_comments(fixture_pdf)
        first = model["comments"][0]
        assert set(first) >= {
            "id", "page", "subtype", "rect", "contents", "author", "subject",
            "created", "modified", "state", "state_model", "name", "reply_to",
            "reply_type", "children", "orphan", "cycle",
        }
        assert first["contents"] == PARENT
        assert first["author"] == "Aya Nakamura"
        assert first["subject"] == "Clause 4"
        assert first["created"]["raw"] == "D:20260814092500+02'00'"
        assert first["modified"]["offset"] == 120
        assert first["name"] == "uuid-parent"

    def test_popup_never_appears_and_unmodelled_is_counted(self, fixture_pdf):
        model = list_comments(fixture_pdf)
        assert "Popup" not in {c["subtype"] for c in model["comments"]}
        assert "Screen" not in {c["subtype"] for c in model["comments"]}
        # 8 markup + the /Screen; the /Popup is neither found nor excluded.
        assert model["found"] == 9
        assert model["excluded"]["unmodelled"] == 1
        assert model["count"] == 8

    def test_reply_nests_and_group_does_not(self, fixture_pdf):
        model = list_comments(fixture_pdf)
        by_body = {c["contents"]: c for c in model["comments"]}
        assert by_body[REPLY]["reply_type"] == "reply"
        assert by_body[REPLY]["reply_to"] == by_body[PARENT]["id"]
        assert by_body[REPLY]["id"] in by_body[PARENT]["children"]
        assert by_body[GROUPED]["reply_type"] == "group"
        assert by_body[GROUPED]["id"] not in by_body[PARENT]["children"]

    def test_orphan_is_promoted_and_reported(self, fixture_pdf):
        model = list_comments(fixture_pdf)
        by_body = {c["contents"]: c for c in model["comments"]}
        assert by_body[ORPHAN]["orphan"] is True
        assert by_body[ORPHAN]["reply_to"] is None

    def test_cycle_is_promoted_and_reported(self, tmp_dir):
        src = os.path.join(tmp_dir, "cycle.pdf")
        pdf = pikepdf.new()
        pdf.add_blank_page(page_size=(612, 792))
        a = _annot(pdf, 0, "/Text", [10, 10, 30, 30], Contents=String("a"))
        b = _annot(pdf, 0, "/Text", [40, 10, 60, 30], Contents=String("b"))
        a["/IRT"] = b
        b["/IRT"] = a
        pdf.save(src)
        pdf.close()
        model = list_comments(src)
        assert len(model["comments"]) == 2
        assert all(c["cycle"] for c in model["comments"])
        assert all(c["reply_to"] is None for c in model["comments"])

    def test_cross_page_irt_resolves(self, tmp_dir):
        src = os.path.join(tmp_dir, "cross.pdf")
        pdf = pikepdf.new()
        pdf.add_blank_page(page_size=(612, 792))
        pdf.add_blank_page(page_size=(612, 792))
        parent = _annot(pdf, 0, "/Text", [10, 10, 30, 30], Contents=String("p"))
        child = _annot(pdf, 1, "/Text", [10, 10, 30, 30], Contents=String("c"))
        child["/IRT"] = parent
        pdf.save(src)
        pdf.close()
        model = list_comments(src)
        by_body = {c["contents"]: c for c in model["comments"]}
        assert by_body["c"]["reply_to"] == by_body["p"]["id"]
        assert by_body["c"]["orphan"] is False

    @pytest.mark.parametrize("sort", ["page", "author", "date", "type"])
    def test_sort_is_total_and_repeatable(self, fixture_pdf, sort):
        first = [c["id"] for c in list_comments(fixture_pdf, sort=sort)["comments"]]
        second = [c["id"] for c in list_comments(fixture_pdf, sort=sort)["comments"]]
        assert first == second
        assert len(first) == 8

    def test_sort_by_author_orders_top_level_entries(self, fixture_pdf):
        model = list_comments(fixture_pdf, sort="author")
        tops = [c for c in model["comments"] if c["reply_to"] is None
                or c["reply_type"] == "group"]
        authors = [c["author"].casefold() for c in tops]
        assert authors == sorted(authors)

    def test_filter_by_author(self, fixture_pdf):
        model = list_comments(fixture_pdf, filter={"authors": ["Rui"]})
        assert {c["author"] for c in model["comments"]} == {"Rui"}
        assert model["excluded"]["filtered"] == 5

    def test_filter_by_subtype_state_page_and_body(self, fixture_pdf):
        assert {c["subtype"] for c in list_comments(
            fixture_pdf, filter={"subtypes": ["Redact"]})["comments"]} == {"Redact"}
        assert [c["state"] for c in list_comments(
            fixture_pdf, filter={"states": ["Accepted"]})["comments"]] == ["Accepted"]
        assert {c["page"] for c in list_comments(
            fixture_pdf, filter={"pages": "3"})["comments"]} == {3}
        assert list_comments(
            fixture_pdf, filter={"has_body": False})["comments"] == []

    def test_filtering_a_parent_promotes_its_reply(self, fixture_pdf):
        model = list_comments(fixture_pdf, filter={"authors": [ARABIC_AUTHOR]})
        assert len(model["comments"]) == 1
        assert model["comments"][0]["orphan"] is True
        assert model["comments"][0]["reply_to"] is None

    def test_unknown_sort_refuses_by_name(self, fixture_pdf):
        with pytest.raises(ValueError, match="not a way to sort comments"):
            list_comments(fixture_pdf, sort="colour")

    def test_unknown_filter_key_refuses_by_name(self, fixture_pdf):
        with pytest.raises(ValueError, match="not a comment filter"):
            list_comments(fixture_pdf, filter={"colour": ["red"]})

    def test_unknown_subtype_refuses_by_name(self, fixture_pdf):
        with pytest.raises(ValueError, match="not a comment subtype"):
            list_comments(fixture_pdf, filter={"subtypes": ["Widget"]})

    def test_unreadable_annots_are_reported(self):
        """A page whose /Annots is not an array reports itself.

        Read straight off an in-memory document: qpdf DROPS a malformed
        /Annots on write, so a fixture that goes through a save can never
        carry the state this guard exists for. Iterating one yields nothing,
        which without the guard reports a clean page.
        """
        pdf = pikepdf.new()
        pdf.add_blank_page(page_size=(612, 792))
        pdf.add_blank_page(page_size=(612, 792))
        _annot(pdf, 1, "/Text", [10, 10, 30, 30], Contents=String("fine"))
        pdf.pages[0].obj["/Annots"] = String("not an array")
        model = build_model(pdf)
        assert [u["page"] for u in model["unreadable"]] == [1]
        assert model["count"] == 1
        pdf.close()


class TestPdfDates:
    def test_offset_is_read_as_recorded(self):
        assert parse_pdf_date("D:20260814093000+02'00'")["offset"] == 120
        assert parse_pdf_date("D:20260814101500Z")["offset"] == 0
        assert parse_pdf_date("D:20260814101500-05'30'")["offset"] == -330

    def test_absent_offset_is_not_read_as_utc(self):
        assert parse_pdf_date("D:20260814101500")["offset"] is None

    def test_trailing_apostrophe_and_bare_fields(self):
        assert parse_pdf_date("D:19981223195200-08'00")["offset"] == -480
        assert parse_pdf_date("D:2026")["month"] == 1

    def test_not_a_date_is_not_forced_into_one(self):
        assert parse_pdf_date("last Tuesday") is None
        assert parse_pdf_date("D:20261399000000") is None


# ---------------------------------------------------------------------------
# The document
# ---------------------------------------------------------------------------

class TestExactlyOnce:
    @pytest.mark.parametrize("mode", MODES)
    @pytest.mark.parametrize("placement", PLACEMENTS)
    @pytest.mark.parametrize("connectors", [True, False])
    def test_every_body_appears_exactly_once(self, fixture_pdf, tmp_dir, mode,
                                             placement, connectors):
        result = _summary(
            fixture_pdf, tmp_dir, f"{mode}-{placement}-{int(connectors)}.pdf",
            mode=mode, placement=placement, connectors=connectors,
        )
        text = _text(result["output"])
        for body in BODIES:
            assert _appearances(text, body, tmp_dir) == 1, body

    def test_author_date_and_page_reference_ride_along(self, fixture_pdf, tmp_dir):
        result = _summary(fixture_pdf, tmp_dir)
        text = _text(result["output"])
        assert "Aya Nakamura" in text
        assert "2026-08-14 09:30 UTC+02:00" in text
        assert "2026-08-14 10:15 UTC+00:00" in text
        assert "page 1" in text and "page 3" in text


class TestReconciliation:
    @pytest.mark.parametrize("mode", MODES)
    @pytest.mark.parametrize("placement", PLACEMENTS)
    def test_found_equals_written_plus_excluded(self, fixture_pdf, tmp_dir, mode,
                                                placement):
        result = _summary(
            fixture_pdf, tmp_dir, f"r-{mode}-{placement}.pdf",
            mode=mode, placement=placement,
        )
        assert result["found"] == 9
        assert result["written"] == 8
        assert result["excluded"]["unmodelled"] == 1
        assert result["excluded"]["filtered"] == 0
        assert result["reconciles"] is True
        assert (
            result["found"]
            == result["written"] + result["excluded"]["filtered"]
            + result["excluded"]["unmodelled"]
        )

    def test_malformed_rect_lands_in_the_no_position_bucket(self, fixture_pdf, tmp_dir):
        result = _summary(fixture_pdf, tmp_dir)
        assert result["excluded"]["no_position"] == 1
        assert BADRECT not in {m["comment"] for m in result["marks"]}
        text = _text(result["output"])
        assert DEFAULT_LABELS["noPosition"] in text

    def test_the_filtered_set_is_counted_and_printed(self, fixture_pdf, tmp_dir):
        result = _summary(
            fixture_pdf, tmp_dir, "filtered.pdf", filter={"authors": ["Rui"]},
        )
        assert result["written"] == 3
        assert result["excluded"]["filtered"] == 5
        assert result["reconciles"] is True
        assert "5" in _text(result["output"])

    def test_zero_entries_after_the_filter_refuses(self, fixture_pdf, tmp_dir):
        with pytest.raises(ValueError, match="no comments to summarize"):
            _summary(fixture_pdf, tmp_dir, "none.pdf",
                     filter={"authors": ["nobody at all"]})

    def test_a_page_the_lift_refuses_is_reported_not_fatal(self, tmp_dir):
        """A page with no usable box loses its image, not its comments.

        qpdf writes a /MediaBox back onto a page that has none, so the state a
        real damaged file carries is reproduced here as a box with no area —
        the same refusal, by the same name, from the same lift.
        """
        src = os.path.join(tmp_dir, "nobox.pdf")
        pdf = pikepdf.new()
        pdf.add_blank_page(page_size=(612, 792))
        _annot(pdf, 0, "/Text", [10, 10, 30, 30], Contents=String("still written"))
        pdf.pages[0].obj["/MediaBox"] = Array([0, 0, 0, 0])
        pdf.save(src)
        pdf.close()
        result = _summary(src, tmp_dir, "nobox-out.pdf")
        assert result["no_box_pages"] == [1]
        assert result["written"] == 1
        assert "still written" in _text(result["output"])


class TestRefusals:
    def test_unknown_mode_refuses_by_name(self, fixture_pdf, tmp_dir):
        with pytest.raises(ValueError, match="not a comment summary mode"):
            _summary(fixture_pdf, tmp_dir, mode="everything")

    def test_unknown_placement_refuses_by_name(self, fixture_pdf, tmp_dir):
        with pytest.raises(ValueError, match="not a comment column placement"):
            _summary(fixture_pdf, tmp_dir, placement="diagonal")

    def test_unknown_paper_refuses_by_name(self, fixture_pdf, tmp_dir):
        with pytest.raises(ValueError, match="not a paper size"):
            _summary(fixture_pdf, tmp_dir, paper="billboard")

    def test_a_column_that_cannot_fit_refuses(self, fixture_pdf, tmp_dir):
        with pytest.raises(ValueError, match="does not fit the sheet"):
            _summary(fixture_pdf, tmp_dir, gutter=600.0)


class TestGeometry:
    """The drawn endpoint against the composition computed by hand."""

    @pytest.mark.parametrize("placement", ["beside", "beneath"])
    def test_marks_equal_place_in_cell_of_the_source_matrix(self, fixture_pdf,
                                                            tmp_dir, placement):
        result = _summary(
            fixture_pdf, tmp_dir, f"g-{placement}.pdf", placement=placement,
        )
        model = list_comments(fixture_pdf)
        by_id = {c["id"]: c for c in model["comments"]}
        (_, _), cell, _ = _cells(placement, 612.0, 792.0, 216.0)
        with pikepdf.open(fixture_pdf) as pdf:
            for mark in result["marks"]:
                comment = by_id[mark["comment"]]
                page = pdf.pages[comment["page"] - 1]
                x0, y0, x1, y1 = _resolve_box(page)
                matrix, (disp_w, disp_h) = _source_matrix(
                    x0, y0, x1 - x0, y1 - y0, _resolve_rotate(page)
                )
                place, _ = place_in_cell(disp_w, disp_h, 0, cell, False)
                ax, ay = _anchor(comment["rect"], placement)
                want = _apply(place, *_apply(matrix, ax, ay))
                assert abs(mark["x"] - want[0]) < 1e-4
                assert abs(mark["y"] - want[1]) < 1e-4

    @pytest.mark.parametrize("placement", ["beside", "beneath"])
    def test_every_badge_falls_inside_the_placed_image(self, fixture_pdf, tmp_dir,
                                                       placement):
        result = _summary(
            fixture_pdf, tmp_dir, f"b-{placement}.pdf", placement=placement,
        )
        (_, _), cell, _ = _cells(placement, 612.0, 792.0, 216.0)
        cx, cy, cw, ch = cell
        for mark in result["marks"]:
            assert cx - 1 <= mark["x"] <= cx + cw + 1
            assert cy - 1 <= mark["y"] <= cy + ch + 1

    def test_one_badge_per_placed_comment(self, fixture_pdf, tmp_dir):
        result = _summary(fixture_pdf, tmp_dir, "badges.pdf")
        badges = [m["badge"] for m in result["marks"]]
        assert len(badges) == len(set(badges))
        # Seven top-level entries, one of which has no readable position.
        assert len(badges) == 6

    def test_the_crop_origin_is_folded_exactly_once(self, tmp_dir):
        """The badge on a cropped page sits where the crop-relative position
        says, not one crop origin away from it.

        The lifted form's own /Matrix already folds the crop origin. An
        imposition subtracts it again because its form comes from
        `Page.as_form_xobject`, whose /Matrix is the identity; doing that here
        moves every badge on a cropped page by the crop origin, silently and
        only on cropped pages. The second assertion is what makes the first
        one mean something: the wrong answer is a different number.
        """
        src = os.path.join(tmp_dir, "cropped.pdf")
        pdf = pikepdf.new()
        pdf.add_blank_page(page_size=(612, 792))
        pdf.pages[0].obj["/CropBox"] = Array([36, 36, 576, 756])
        _annot(pdf, 0, "/Square", [100, 200, 200, 260], Contents=String("here"))
        pdf.save(src)
        pdf.close()
        result = _summary(src, tmp_dir, "cropped-out.pdf", placement="beside")
        mark = result["marks"][0]

        _, cell, _ = _cells("beside", 612.0, 792.0, 216.0)
        matrix, (disp_w, disp_h) = _source_matrix(36.0, 36.0, 540.0, 720.0, 0)
        place, _ = place_in_cell(disp_w, disp_h, 0, cell, False)
        ax, ay = _anchor([100.0, 200.0, 200.0, 260.0], "beside")
        want_x, want_y = _apply(place, *_apply(matrix, ax, ay))
        assert abs(mark["x"] - want_x) < 1e-4
        assert abs(mark["y"] - want_y) < 1e-4

        a, b, c, d, e, f = place
        doubled = (e - a * 36.0 - c * 36.0, f - b * 36.0 - d * 36.0)
        wrong = _apply(
            [a, b, c, d, doubled[0], doubled[1]], *_apply(matrix, ax, ay)
        )
        assert abs(wrong[0] - want_x) > 1.0

    def test_a_non_printing_comment_still_draws_and_gets_a_badge(self, tmp_dir):
        """Two identical squares, one flagged to print and one not. Both are
        the review's own content, and both have to be on the page image — the
        press-plate flatten keeps only the printing one."""
        src = os.path.join(tmp_dir, "flags.pdf")
        pdf = pikepdf.new()
        pdf.add_blank_page(page_size=(612, 792))
        for index, flag in enumerate((4, 0)):
            appearance = pdf.make_stream(b"0 0 1 RG 2 w 1 1 98 58 re S")
            appearance.Type = Name("/XObject")
            appearance.Subtype = Name("/Form")
            appearance.BBox = Array([0, 0, 100, 60])
            _annot(
                pdf, 0, "/Square", [100, 200 + index * 100, 200, 260 + index * 100],
                Contents=String(f"square {index}"), F=flag,
                AP=Dictionary(N=pdf.make_indirect(appearance)),
            )
        pdf.save(src)
        pdf.close()
        result = _summary(src, tmp_dir, "flags-out.pdf", placement="beside")
        assert len(result["marks"]) == 2
        with pikepdf.open(result["output"]) as out:
            forms = out.pages[0].obj["/Resources"]["/XObject"]
            lifted = bytes(forms[Name("/Pg0")].read_bytes())
        # Both appearances are drawn into the lifted page, not one.
        assert lifted.count(b"/WmAp") == 2


class TestOverflow:
    def test_forty_comments_repeat_the_page_image_and_lose_nothing(self, tmp_dir):
        src = os.path.join(tmp_dir, "many.pdf")
        pdf = pikepdf.new()
        pdf.add_blank_page(page_size=(612, 792))
        for i in range(40):
            _annot(
                pdf, 0, "/Text", [50 + (i % 10) * 40, 100 + (i // 10) * 40,
                                  70 + (i % 10) * 40, 120 + (i // 10) * 40],
                Contents=String(f"comment number {i:02d} with a little body text"),
                T=String(f"Reviewer {i % 3}"),
            )
        pdf.save(src)
        pdf.close()
        result = _summary(src, tmp_dir, "many-out.pdf", placement="beside")
        assert result["written"] == 40
        assert result["reconciles"] is True
        assert result["sheets"] > 2  # the page overflowed its first sheet
        text = _text(result["output"])
        for i in range(40):
            assert text.count(f"comment number {i:02d} with a little body text") == 1
        with pikepdf.open(result["output"]) as out:
            imaged = sum(
                1 for page in out.pages
                if Name("/Pg0") in (page.obj.get("/Resources") or {}).get(
                    "/XObject", Dictionary()
                )
            )
        # Every continuation sheet repeats the page image; only the
        # reconciliation sheet carries none.
        assert imaged == len(out.pages) - 1


class TestLocale:
    def test_the_furniture_comes_only_from_the_passed_labels(self, fixture_pdf,
                                                             tmp_dir):
        sentinels = {key: f"ZZ{key}ZZ" for key in DEFAULT_LABELS}
        sentinels["entryHeader"] = "ZZentryHeaderZZ {{badge}} {{author}}"
        sentinels["entryMeta"] = "ZZentryMetaZZ {{date}} {{page}} {{type}}"
        sentinels["replyHeader"] = "ZZreplyHeaderZZ {{author}}"
        sentinels["replyMeta"] = "ZZreplyMetaZZ {{date}}"
        sentinels["pageHeading"] = "ZZpageHeadingZZ {{page}}"
        sentinels["types"] = {"Text": "ZZtypeTextZZ"}
        result = _summary(fixture_pdf, tmp_dir, "sentinel.pdf", labels=sentinels)
        text = _text(result["output"])
        assert "ZZentryHeaderZZ" in text
        assert "ZZtypeTextZZ" in text
        for english in ("Comment summary", "Reconciliation", "Reply", "Subject",
                        "Status", "Sorted by"):
            assert english not in text

    def test_the_two_fixture_offsets_render_as_two_offsets(self, fixture_pdf,
                                                           tmp_dir):
        result = _summary(fixture_pdf, tmp_dir, "offsets.pdf")
        text = _text(result["output"])
        assert "UTC+02:00" in text
        assert "UTC+00:00" in text
        assert "UTC+03:00" in text

    def test_a_date_with_no_offset_says_so(self, tmp_dir):
        src = os.path.join(tmp_dir, "nooffset.pdf")
        pdf = pikepdf.new()
        pdf.add_blank_page(page_size=(612, 792))
        _annot(pdf, 0, "/Text", [10, 10, 30, 30], Contents=String("no zone"),
               M=String("D:20260814101500"))
        pdf.save(src)
        pdf.close()
        result = _summary(src, tmp_dir, "nooffset-out.pdf")
        assert "time zone not recorded" in _text(result["output"])

    def test_the_callers_own_date_rendering_wins(self, tmp_dir):
        src = os.path.join(tmp_dir, "mapped.pdf")
        pdf = pikepdf.new()
        pdf.add_blank_page(page_size=(612, 792))
        _annot(pdf, 0, "/Text", [10, 10, 30, 30], Contents=String("mapped"),
               M=String("D:20260814101500Z"))
        pdf.save(src)
        pdf.close()
        result = _summary(
            src, tmp_dir, "mapped-out.pdf",
            dates={"D:20260814101500Z": "14 August 2026 (UTC)"},
        )
        assert "14 August 2026 (UTC)" in _text(result["output"])

    def test_digits_follow_the_readers_own_numerals(self, fixture_pdf, tmp_dir):
        result = _summary(
            fixture_pdf, tmp_dir, "digits.pdf", digits="٠١٢٣٤٥٦٧٨٩",
        )
        text = _text(result["output"])
        assert "١" in text

    def test_lang_and_direction_land_in_the_produced_file(self, fixture_pdf, tmp_dir):
        result = _summary(
            fixture_pdf, tmp_dir, "lang.pdf", lang="he", direction="rtl",
        )
        with pikepdf.open(result["output"]) as out:
            assert str(out.Root["/Lang"]) == "he"
            assert str(out.Root["/ViewerPreferences"]["/Direction"]) == "/R2L"


class TestRightToLeft:
    def test_the_arabic_body_and_author_survive(self, fixture_pdf, tmp_dir):
        result = _summary(fixture_pdf, tmp_dir, "rtl.pdf")
        text = _text(result["output"])
        assert _appearances(text, ARABIC, tmp_dir) == 1
        assert _appearances(text, ARABIC_AUTHOR, tmp_dir) == 1

    def test_an_unlayoutable_body_is_reported_and_the_run_continues(self, tmp_dir):
        src = os.path.join(tmp_dir, "refuse.pdf")
        pdf = pikepdf.new()
        pdf.add_blank_page(page_size=(612, 792))
        _annot(pdf, 0, "/Text", [10, 10, 30, 30], Contents=String("plain one"),
               T=String("Ada"))
        # An isolate that the reorder cannot put back is what refuses.
        _annot(pdf, 0, "/Text", [40, 10, 60, 30],
               Contents=String("⁦العربية"),
               T=String("Layla"))
        pdf.save(src)
        pdf.close()
        result = _summary(src, tmp_dir, "refuse-out.pdf")
        assert result["written"] == 2
        assert result["excluded"]["body_refused"] == 1
        text = _text(result["output"])
        assert "plain one" in text
        assert DEFAULT_LABELS["bodyRefused"] in text
