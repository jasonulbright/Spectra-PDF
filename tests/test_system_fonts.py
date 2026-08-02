"""9.T6 — the machine's installed fonts as an editing choice."""

import os

import pikepdf
import pytest

from engine.system_fonts import (
    embedding_refusal,
    list_system_fonts,
    read_face,
    resolve_face,
)
from engine.text_authoring import add_text_box
from engine.text_paragraphs import list_text_paragraphs, replace_paragraph_text

FONTS_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "resources", "fonts"
)
LIBERATION = os.path.join(FONTS_DIR, "LiberationSans-Regular.ttf")

pytestmark = pytest.mark.skipif(
    not os.path.isfile(LIBERATION), reason="bundled fonts not provisioned"
)


def _blank(tmp_dir, name="blank.pdf"):
    path = os.path.join(tmp_dir, name)
    pdf = pikepdf.new()
    pdf.add_blank_page(page_size=(612, 792))
    pdf.save(path)
    pdf.close()
    return path


class TestEmbeddingPermission:
    """The foundry's own `fsType` decides what may be offered — read off the
    font, never assumed."""

    def test_installable_and_editable_are_offerable(self):
        assert embedding_refusal(0x0000) is None  # Installable Embedding
        assert embedding_refusal(0x0008) is None  # Editable

    def test_preview_and_print_is_offerable(self):
        # It PERMITS embedding; its restriction is on what the recipient may
        # do with the document, which no producer can enforce and this
        # engine does not claim to.
        assert embedding_refusal(0x0004) is None

    def test_restricted_licence_is_refused_by_name(self):
        assert "licence" in (embedding_refusal(0x0002) or "")

    def test_no_subsetting_and_bitmap_only_are_refused(self):
        # This engine ALWAYS subsets and always embeds outlines, so both are
        # permissions for a shape it does not produce.
        assert "subsetting" in (embedding_refusal(0x0100) or "")
        assert "bitmaps" in (embedding_refusal(0x0200) or "")

    def test_the_bits_compose(self):
        # Restricted wins over anything permissive set alongside it.
        assert embedding_refusal(0x0002 | 0x0008) is not None


class TestReadFace:
    def test_reads_a_bundled_face(self):
        face = read_face(LIBERATION)
        assert face is not None
        assert "Liberation" in face["family"]
        assert face["refusal"] is None
        assert face["bold"] is False and face["italic"] is False
        assert os.path.isabs(face["path"])

    def test_bold_and_italic_come_off_the_font(self):
        bold = os.path.join(FONTS_DIR, "LiberationSans-Bold.ttf")
        italic = os.path.join(FONTS_DIR, "LiberationSans-Italic.ttf")
        if not (os.path.isfile(bold) and os.path.isfile(italic)):
            pytest.skip("bundled styles not provisioned")
        assert read_face(bold)["bold"] is True
        assert read_face(italic)["italic"] is True

    def test_a_file_that_is_not_a_font_returns_None(self, tmp_dir):
        junk = os.path.join(tmp_dir, "notafont.ttf")
        with open(junk, "wb") as fh:
            fh.write(b"this is not a font")
        # None, never an exception: a machine's font folder routinely holds
        # a file some parser dislikes, and one bad file must not empty the
        # whole list.
        assert read_face(junk) is None


class TestListSystemFonts:
    def test_lists_the_machine_and_groups_by_family(self):
        res = list_system_fonts()
        assert res["count"] > 0, "no installed fonts found"
        assert len(res["families"]) > 0
        # Every listed face is offerable — the refusals are excluded, not
        # shown greyed out.
        assert all(f["refusal"] is None for f in res["fonts"])
        # Families group their faces.
        by_name = {f["family"]: f for f in res["families"]}
        any_family = next(iter(by_name.values()))
        assert any_family["faces"]
        assert all("path" in face for face in any_family["faces"])

    def test_restricted_fonts_are_counted_not_hidden(self):
        res = list_system_fonts()
        # A user whose font is missing gets a number to explain it. (Zero is
        # a legitimate machine state, so this pins the FIELD, not a value.)
        assert isinstance(res["restricted"], int) and res["restricted"] >= 0
        assert res["count"] + res["restricted"] >= res["count"]

    def test_families_are_sorted_and_stable(self):
        first = list_system_fonts()
        second = list_system_fonts()
        names = [f["family"] for f in first["families"]]
        assert names == sorted(names, key=str.lower)
        assert names == [f["family"] for f in second["families"]]


class TestResolveFace:
    def test_resolves_a_real_face_to_an_absolute_path(self):
        assert os.path.isabs(resolve_face(LIBERATION))

    def test_a_missing_file_refuses_by_name(self):
        with pytest.raises(ValueError, match="not found"):
            resolve_face(os.path.join(FONTS_DIR, "NoSuchFont.ttf"))

    def test_a_non_font_refuses_by_name(self, tmp_dir):
        junk = os.path.join(tmp_dir, "j.ttf")
        with open(junk, "wb") as fh:
            fh.write(b"nope")
        with pytest.raises(ValueError, match="not a usable font"):
            resolve_face(junk)


class TestEditingWithAnInstalledFont:
    """The point of the enumeration: an installed face is a first-class
    choice everywhere the three bundled families were."""

    def _an_installed_face(self):
        res = list_system_fonts()
        if not res["fonts"]:
            pytest.skip("no installed fonts")
        # A face whose file name differs from the bundled ones, so the
        # embedded BaseFont proves WHICH face was used.
        return res["fonts"][0]["path"]

    def test_add_text_embeds_the_chosen_face(self, tmp_dir):
        face = self._an_installed_face()
        src = _blank(tmp_dir)
        out = os.path.join(tmp_dir, "o.pdf")
        add_text_box(
            src, out, 1, [72, 640, 520, 720], "Installed font please",
            size=20.0, font_path=FONTS_DIR, family=face,
        )
        stem = os.path.splitext(os.path.basename(face))[0]
        with pikepdf.open(out) as pdf:
            fonts = pdf.pages[0]["/Resources"]["/Font"]
            names = [str(fonts[k].get("/BaseFont")) for k in fonts.keys()]
        assert any(stem.lower() in n.lower() for n in names), names
        # …and it re-lists as ordinary editable text, no special case.
        assert [p["text"] for p in list_text_paragraphs(out, 1)["paragraphs"]] == [
            "Installed font please"
        ]

    def test_paragraph_restyle_to_an_installed_face(self, tmp_dir):
        face = self._an_installed_face()
        src = _blank(tmp_dir)
        staged = os.path.join(tmp_dir, "staged.pdf")
        add_text_box(src, staged, 1, [72, 640, 520, 720], "Restyle me",
                     size=18.0, font_path=FONTS_DIR)
        out = os.path.join(tmp_dir, "o.pdf")
        para = list_text_paragraphs(staged, 1)["paragraphs"][0]
        replace_paragraph_text(
            staged, out, 1, para["index"], "Restyle me",
            [{"start": 0, "end": 10, "run": para["runs"][0]}],
            para["runs"], para["text"], font_path=FONTS_DIR, family=face,
        )
        assert [p["text"] for p in list_text_paragraphs(out, 1)["paragraphs"]] == [
            "Restyle me"
        ]

    def test_a_bogus_family_still_refuses_by_name(self, tmp_dir):
        src = _blank(tmp_dir)
        out = os.path.join(tmp_dir, "o.pdf")
        with pytest.raises(ValueError, match="serif, sans, mono"):
            add_text_box(src, out, 1, [72, 640, 520, 720], "x",
                         font_path=FONTS_DIR, family="comic-sans-please")

    def test_the_three_bundled_families_are_untouched(self, tmp_dir):
        # The T6 branch is gated on an ABSOLUTE PATH, so the shipped
        # selectors take exactly the shipped ladder.
        src = _blank(tmp_dir)
        out = os.path.join(tmp_dir, "o.pdf")
        add_text_box(src, out, 1, [72, 640, 520, 720], "Serif please",
                     font_path=FONTS_DIR, family="serif")
        with pikepdf.open(out) as pdf:
            fonts = pdf.pages[0]["/Resources"]["/Font"]
            names = [str(fonts[k].get("/BaseFont")) for k in fonts.keys()]
        assert any("LiberationSerif" in n for n in names)
