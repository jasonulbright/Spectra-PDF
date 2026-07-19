"""Tests for Add Text — authoring a new text object (Phase 9.A2).

gs-independent but font-dependent: gated on the vendored fallback family
(scripts/sync-edit-fonts.ps1), like test_font_fallback."""

import os

import pikepdf
import pytest

from engine.extract_text import extract_text
from engine.text_authoring import add_text_box
from engine.text_paragraphs import list_text_paragraphs
from engine.text_runs import list_text_runs

FONTS_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "resources", "fonts"
)

pytestmark = pytest.mark.skipif(
    not os.path.isfile(os.path.join(FONTS_DIR, "LiberationSans-Regular.ttf")),
    reason="bundled fonts not provisioned",
)


def _blank(tmp_dir, name="blank.pdf"):
    src = os.path.join(tmp_dir, name)
    pdf = pikepdf.new()
    pdf.add_blank_page(page_size=(612, 792))
    pdf.save(src)
    pdf.close()
    return src


class TestAddText:
    def test_authored_text_lists_as_an_editable_run(self, tmp_dir):
        src = _blank(tmp_dir)
        out = os.path.join(tmp_dir, "o.pdf")
        add_text_box(src, out, 1, [72, 680, 400, 720], "Hello authored world", font_path=FONTS_DIR)
        # Searchable...
        assert "Hello authored world" in extract_text(out)["text"]
        # ...and re-editable by the shipped run editor (no special case).
        runs = list_text_runs(out, 1)["runs"]
        run = next(r for r in runs if "Hello authored world" in r["text"])
        assert run["editable"] is True
        # Positioned at the box's left edge, near its top.
        assert run["rect"][0] == pytest.approx(72, abs=1.0)
        assert run["rect"][1] == pytest.approx(720 - 12, abs=3.0)

    def test_wraps_to_multiple_lines_in_a_narrow_box(self, tmp_dir):
        src = _blank(tmp_dir)
        out = os.path.join(tmp_dir, "o.pdf")
        r = add_text_box(
            src, out, 1, [72, 600, 180, 720],  # 108pt-wide box
            "one two three four five six seven eight nine ten",
            size=12, font_path=FONTS_DIR,
        )
        assert r["lines"] > 1
        # The authored text groups as one editable paragraph on re-list.
        paras = list_text_paragraphs(out, 1)["paragraphs"]
        assert any("one two three" in p["text"] for p in paras)

    def test_family_serif_embeds_a_serif_face(self, tmp_dir):
        src = _blank(tmp_dir)
        out = os.path.join(tmp_dir, "o.pdf")
        add_text_box(src, out, 1, [72, 680, 400, 720], "Serif please", font_path=FONTS_DIR, family="serif")
        with pikepdf.open(out) as pdf:
            fonts = pdf.pages[0]["/Resources"]["/Font"]
            names = [str(fonts[k].get("/BaseFont")) for k in fonts.keys()]
        assert any("LiberationSerif" in n for n in names)

    def test_color_is_applied(self, tmp_dir):
        src = _blank(tmp_dir)
        out = os.path.join(tmp_dir, "o.pdf")
        add_text_box(
            src, out, 1, [72, 680, 400, 720], "Red text", color=[1.0, 0.0, 0.0], font_path=FONTS_DIR
        )
        with pikepdf.open(out) as pdf:
            contents = pdf.pages[0].obj.get("/Contents")
            if isinstance(contents, pikepdf.Array):
                content = b"".join(bytes(s.read_bytes()) for s in contents)
            else:
                content = contents.read_bytes()
        assert b"1 0 0 rg" in content

    def test_empty_text_refuses(self, tmp_dir):
        src = _blank(tmp_dir)
        out = os.path.join(tmp_dir, "o.pdf")
        with pytest.raises(ValueError, match="no text"):
            add_text_box(src, out, 1, [72, 680, 400, 720], "   ", font_path=FONTS_DIR)

    def test_does_not_disturb_existing_content(self, tmp_dir):
        # Author onto a page that already has text — the original survives.
        src = os.path.join(tmp_dir, "has.pdf")
        pdf = pikepdf.new()
        page = pdf.add_blank_page(page_size=(612, 792))
        page.obj["/Resources"] = pikepdf.Dictionary(
            Font=pikepdf.Dictionary(
                F1=pdf.make_indirect(
                    pikepdf.Dictionary(
                        Type=pikepdf.Name("/Font"),
                        Subtype=pikepdf.Name("/Type1"),
                        BaseFont=pikepdf.Name("/Helvetica"),
                        Encoding=pikepdf.Name("/WinAnsiEncoding"),
                    )
                )
            )
        )
        page.Contents = pdf.make_stream(b"BT /F1 12 Tf 72 700 Td (Original here) Tj ET")
        pdf.save(src)
        pdf.close()
        out = os.path.join(tmp_dir, "o.pdf")
        add_text_box(src, out, 1, [72, 500, 400, 540], "Added below", font_path=FONTS_DIR)
        text = extract_text(out)["text"]
        assert "Original here" in text
        assert "Added below" in text

    def test_page_out_of_range_refuses(self, tmp_dir):
        src = _blank(tmp_dir)
        out = os.path.join(tmp_dir, "o.pdf")
        with pytest.raises(ValueError, match="out of range"):
            add_text_box(src, out, 5, [72, 680, 400, 720], "x", font_path=FONTS_DIR)

    def test_honours_hard_line_breaks(self, tmp_dir):
        # A WIDE box would keep these on ONE line; the explicit newline must
        # force the break (the entry control is a textarea — collapsing user
        # breaks would silently discard formatting).
        src = _blank(tmp_dir)
        out = os.path.join(tmp_dir, "o.pdf")
        r = add_text_box(
            src, out, 1, [72, 600, 540, 720],  # 468pt-wide box — no wrap needed
            "First line here\nSecond line here",
            size=12, font_path=FONTS_DIR,
        )
        assert r["lines"] == 2
        text = extract_text(out)["text"]
        assert "First line here" in text
        assert "Second line here" in text

    def test_keeps_wrapped_text_on_the_page(self, tmp_dir):
        # A short box at the page's very bottom + enough text to wrap several
        # lines would descend below y=0 (invisible) without the on-page shift;
        # the block is moved up so every baseline stays on the sheet.
        src = _blank(tmp_dir)
        out = os.path.join(tmp_dir, "o.pdf")
        add_text_box(
            src, out, 1, [72, 8, 300, 40],  # ~32pt-tall box hugging the bottom
            "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda "
            "mu nu xi omicron pi rho sigma tau upsilon phi chi psi omega",
            size=18, font_path=FONTS_DIR,
        )
        runs = list_text_runs(out, 1)["runs"]
        added = [r for r in runs if any(w in r["text"] for w in ("alpha", "omega", "sigma"))]
        assert added, "authored runs not found"
        # Every authored baseline sits on the page (small descender slack). The
        # un-shifted last baseline would be tens of points below zero.
        assert min(r["rect"][1] for r in added) >= -10

    def test_shields_against_a_dangling_ctm_in_prior_content(self, tmp_dir):
        # A page whose content leaves an UNBALANCED `cm` (2x scale, no closing
        # Q) would, without the q/Q shield, transform our appended object by it
        # — the text would land at double scale + offset. The envelope around
        # the original restores the page-initial CTM first, so our rect/Tm land
        # where asked. (Without the shield this run's x reads ~144, not ~72.)
        src = os.path.join(tmp_dir, "dangling.pdf")
        pdf = pikepdf.new()
        page = pdf.add_blank_page(page_size=(612, 792))
        page.Contents = pdf.make_stream(b"q 2 0 0 2 0 0 cm")  # note: no closing Q
        pdf.save(src)
        pdf.close()
        out = os.path.join(tmp_dir, "o.pdf")
        add_text_box(src, out, 1, [72, 680, 400, 720], "Anchored here", font_path=FONTS_DIR)
        runs = list_text_runs(out, 1)["runs"]
        run = next(r for r in runs if "Anchored here" in r["text"])
        assert run["rect"][0] == pytest.approx(72, abs=2.0)
        assert run["rect"][1] == pytest.approx(720 - 12, abs=3.0)
