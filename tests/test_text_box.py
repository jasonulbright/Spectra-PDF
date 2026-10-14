"""Tests for `text_box_appearance`: the text of an annotation appearance laid
out, shaped and drawn in bundled faces.

Font-dependent: gated on the bundled face files themselves."""

import base64
import io
import json
import os
import random
import re

import pikepdf
import pytest

from engine import bidi
from engine import font_fallback as ff
from engine.text_box import _Faces, _drawn, text_box_appearance

FONTS_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "resources", "fonts"
)
_FACES = (
    "LiberationSans-Regular.ttf", "LiberationSans-Bold.ttf", "LiberationSerif-Regular.ttf",
    "NotoSansCJKsc-Regular.otf", "NotoSansHebrew-Regular.ttf", "IBMPlexSansArabic-Regular.ttf",
)

pytestmark = pytest.mark.skipif(
    not all(os.path.isfile(os.path.join(FONTS_DIR, name)) for name in _FACES),
    reason="bundled fonts not provisioned",
)

POLISH = "Zażółć gęślą jaźń"
HEBREW = "שלום עולם"
ARABIC = "مرحبا بالعالم"


def _draw(blocks, draw=True):
    return text_box_appearance(blocks, FONTS_DIR, draw)


def _fonts(answer):
    """name -> (BaseFont, {code: text}) of the fonts the answer carries."""
    out = {}
    with pikepdf.open(io.BytesIO(base64.b64decode(answer["pdf"]))) as pdf:
        for name, font in pdf.pages[0].obj["/Resources"]["/Font"].items():
            cmap = bytes(font["/ToUnicode"].read_bytes()).decode("ascii")
            codes = {
                int(code, 16): bytes.fromhex(text).decode("utf-16-be")
                for code, text in re.findall(r"<([0-9a-f]{4})> <([0-9a-f]*)>", cmap)
            }
            descendant = font["/DescendantFonts"][0]
            assert str(descendant["/BaseFont"]) == str(font["/BaseFont"])
            assert str(descendant["/FontDescriptor"]["/FontName"]) == str(font["/BaseFont"])
            out[name.lstrip("/")] = (str(font["/BaseFont"]), codes)
    return out


def _shown(block, fonts):
    """The text each line of a block shows, in the order the content shows it."""
    lines = []
    codes = {}
    for token in re.finditer(r"/([^\s/<>\[\]]+) [\d.]+ Tf|<([0-9a-f]*)>|( Tm )", block["content"]):
        if token.group(3):
            lines.append("")
        elif token.group(1):
            codes = fonts[token.group(1)][1]
        else:
            data = token.group(2)
            lines[-1] += "".join(codes[int(data[i:i + 4], 16)] for i in range(0, len(data), 4))
    return lines


def test_draws_text_outside_winansi_in_a_subset_of_the_family_face():
    answer = _draw([{"text": POLISH, "size": 12, "family": "sans"}])
    block = answer["blocks"][0]
    fonts = _fonts(answer)
    assert block["lines"] == [POLISH]
    assert block["fonts"] == ["LiberationSans"]
    assert block["rtl"] is False and block["align"] == "left"
    assert re.fullmatch(r"/[A-Z]{6}\+LiberationSans", fonts["LiberationSans"][0])
    assert _shown(block, fonts) == [POLISH]
    assert block["content"].startswith("BT 1 0 0 1 0 -12 Tm /LiberationSans 12 Tf <")
    assert block["content"].endswith(" ET")
    assert block["widths"][0] > 60


def test_family_and_style_pick_the_face():
    answer = _draw([
        {"text": "Bold żółć", "family": "serif", "bold": True, "italic": True},
        {"text": "mono żółć", "family": "mono"},
    ])
    fonts = _fonts(answer)
    assert fonts[answer["blocks"][0]["fonts"][0]][0].endswith("+LiberationSerif-BoldItalic")
    assert fonts[answer["blocks"][1]["fonts"][0]][0].endswith("+LiberationMono")


def test_wraps_at_the_width_by_the_face_advances_and_keeps_hard_lines_and_spaces():
    text = "one two three four five six seven\n\n  lead   gap"
    wide = _draw([{"text": text, "size": 10}])["blocks"][0]
    assert wide["lines"] == ["one two three four five six seven", "", "  lead   gap"]
    narrow = _draw([{"text": text, "size": 10, "width": 60}])["blocks"][0]
    assert len(narrow["lines"]) > 4
    assert all(width <= 60.0001 for width in narrow["widths"])
    assert " ".join(line for line in narrow["lines"] if line).split() == text.split()
    assert "" in narrow["lines"]
    assert narrow["lines"][-1].startswith("  lead") or "  lead" in narrow["lines"]
    # A word wider than the line is cut by character.
    cut = _draw([{"text": "Wwwwwwwwwwwwwwwwwwwwwww", "size": 12, "width": 40}])["blocks"][0]
    assert len(cut["lines"]) > 1 and "".join(cut["lines"]) == "Wwwwwwwwwwwwwwwwwwwwwww"


def test_cjk_breaks_between_characters():
    block = _draw([{"text": "中文测试中文测试中文测试", "size": 12, "width": 50}])["blocks"][0]
    assert len(block["lines"]) == 3
    assert block["fonts"] == ["NotoSansCJKsc"]


def test_one_face_for_the_whole_block_when_one_holds_it_else_a_face_per_run():
    answer = _draw([
        {"text": "Latin 中文"}, {"text": POLISH + " 中文"}, {"text": "Zażółć中文 שלום"},
    ])
    fonts = _fonts(answer)
    whole, per_word, in_word = answer["blocks"]
    assert whole["fonts"] == ["NotoSansCJKsc"]
    assert per_word["fonts"][0].startswith("LiberationSans") and len(per_word["fonts"]) == 2
    assert _shown(per_word, fonts) == [POLISH + " 中文"]
    assert len(in_word["fonts"]) == 2
    assert sorted("".join(_shown(in_word, fonts))) == sorted("Zażółć中文 שלום")


def test_hebrew_is_right_to_left_right_aligned_and_shown_in_visual_order():
    text = HEBREW + " abc"
    answer = _draw([{"text": text, "size": 12, "width": 200}])
    block = answer["blocks"][0]
    fonts = _fonts(answer)
    assert block["rtl"] is True and block["align"] == "right"
    assert block["lines"] == [text]
    _level, order = bidi.visual_order(text)
    assert _shown(block, fonts) == ["".join(text[i] for i in order)]
    x = float(re.search(r"1 0 0 1 ([\d.]+) -12 Tm", block["content"]).group(1))
    assert abs(x - (200 - block["widths"][0])) < 0.001
    # An alignment the caller states stands.
    left = _draw([{"text": text, "width": 200, "align": "left"}])["blocks"][0]
    assert left["align"] == "left" and " 0 -12 Tm" in left["content"]


def test_arabic_is_shaped_and_a_ligature_is_one_code_that_spells_its_letters():
    text = ARABIC + " سلام"
    answer = _draw([{"text": text, "size": 12}])
    block = answer["blocks"][0]
    name, codes = _fonts(answer)["IBMPlexSansArabic"]
    assert block["fonts"] == ["IBMPlexSansArabic"]
    assert "لا" in codes.values()
    shown = "".join(_shown(block, _fonts(answer)))
    assert sorted(shown) == sorted(text)
    # Joined forms: more than one code spells the same letter.
    assert len([code for code, spelt in codes.items() if spelt == "ل"]) > 1


def test_directional_marks_order_the_line_and_draw_nothing():
    marked = _draw([{"text": "abc ‏שלום‏!"}])["blocks"][0]
    assert marked["lines"] == ["abc ‏שלום‏!"]
    assert "200f" not in marked["content"]
    only_marks = _draw([{"text": "‎‏"}])
    assert only_marks["blocks"][0]["content"] == "" and only_marks["blocks"][0]["fonts"] == []


def test_refuses_the_characters_no_bundled_face_holds_and_draws_the_other_blocks():
    answer = _draw([{"text": "नमस्ते"}, {"text": "ok"}, {"text": "a \U0001F600 b"}])
    assert answer["blocks"][0] == {"refused": "".join(sorted(set("नमस्ते")))}
    assert answer["blocks"][1]["lines"] == ["ok"]
    assert answer["blocks"][2] == {"refused": "\U0001F600"}


def test_blocks_of_one_group_share_their_fonts_and_a_subset_names_what_it_holds():
    answer = _draw([
        {"text": "Tytuł", "bold": True, "group": 1}, {"text": "Drzwi żółte", "group": 1},
        {"text": "Okna żółte", "group": 1}, {"text": "Drzwi żółte"},
    ])
    fonts = _fonts(answer)
    names = [block["fonts"] for block in answer["blocks"]]
    assert names[1] == names[2] and names[0] != names[1] and names[3] != names[1]
    again = _fonts(_draw([{"text": "Drzwi żółte"}]))
    assert fonts[names[3][0]][0] == again["LiberationSans"][0]
    assert fonts[names[3][0]][0] != fonts[names[1][0]][0]


def test_measures_without_drawing_and_answers_the_same_lines():
    blocks = [{"text": POLISH + " " + HEBREW + " " + ARABIC, "size": 11, "width": 90}]
    measured = _draw(blocks, draw=False)
    drawn = _draw(blocks)
    assert "pdf" not in measured and "content" not in measured["blocks"][0]
    for key in ("lines", "widths", "rtl", "align"):
        assert measured["blocks"][0][key] == drawn["blocks"][0][key]
    assert len(drawn["blocks"][0]["lines"]) > 1


def test_the_same_request_gives_the_same_bytes():
    blocks = [{"text": POLISH + " 中文 " + ARABIC, "width": 120}]
    assert _draw(blocks) == _draw(blocks)


def test_refuses_a_malformed_request():
    for bad in (
        [{"text": 5}], [{"text": "a", "size": 0}], [{"text": "a", "size": True}], [{"text": "a", "width": -1}],
        [{"text": "a", "align": "justify"}], [{"text": "a", "family": "fantasy"}], [{"text": "a", "bold": 1}], ["a"],
    ):
        with pytest.raises(ValueError):
            _draw(bad)
    with pytest.raises(ValueError):
        text_box_appearance("a", FONTS_DIR)



def test_measuring_subsets_no_font_and_reads_no_program(monkeypatch):
    from engine import font_fallback, text_box

    def never(*_args, **_kwargs):
        raise AssertionError("a layout request built a font")

    monkeypatch.setattr(font_fallback, "_subset_font", never)
    monkeypatch.setattr(font_fallback.ft_subset, "Subsetter", never)
    monkeypatch.setattr(text_box, "build_fallback_font", never)
    monkeypatch.setattr(text_box, "build_shaped_font", never)
    monkeypatch.setattr(text_box.pikepdf, "new", never)
    blocks = [
        {"text": POLISH, "size": 11, "width": 50},
        {"text": "中文测试 mixed " + HEBREW, "size": 9, "width": 70},
        {"text": ARABIC + " سلام", "size": 14, "width": 40, "bold": True},
        {"text": "é é 中"},
    ]
    measured = _draw(blocks, draw=False)
    assert [len(block["lines"]) > 0 for block in measured["blocks"]] == [True] * 4
    monkeypatch.undo()
    drawn = _draw(blocks)
    for a, b in zip(measured["blocks"], drawn["blocks"]):
        for key in ("lines", "widths", "rtl", "align"):
            assert a[key] == b[key]


def test_the_widths_of_a_line_are_the_widths_the_subset_writes():
    answer = _draw([{"text": POLISH + " 中文", "size": 10}])
    block = answer["blocks"][0]
    total = 0.0
    with pikepdf.open(io.BytesIO(base64.b64decode(answer["pdf"]))) as pdf:
        held = pdf.pages[0].obj["/Resources"]["/Font"]
        codes = {}
        widths = {}
        for token in re.finditer(r"/([^\s/<>\[\]]+) [\d.]+ Tf|<([0-9a-f]*)>", block["content"]):
            if token.group(1):
                descendant = held["/" + token.group(1)]["/DescendantFonts"][0]
                widths = {}
                entries = list(descendant["/W"])
                i = 0
                while i < len(entries):
                    first = int(entries[i])
                    if isinstance(entries[i + 1], pikepdf.Array):
                        for offset, value in enumerate(entries[i + 1]):
                            widths[first + offset] = float(value)
                        i += 2
                    else:
                        for code in range(first, int(entries[i + 1]) + 1):
                            widths[code] = float(entries[i + 2])
                        i += 3
                codes = widths
            else:
                data = token.group(2)
                total += sum(codes[int(data[i:i + 4], 16)] for i in range(0, len(data), 4))
    assert abs(total / 1000.0 * 10 - block["widths"][0]) < 0.01


def test_one_glyph_with_two_spellings_takes_two_codes_of_one_subset():
    for text in ("é é 中", "가 가 中", "fi ﬁ 中", "한 한", "éé中"):
        answer = _draw([{"text": text, "size": 12}])
        block = answer["blocks"][0]
        fonts = _fonts(answer)
        assert "refused" not in block
        assert _shown(block, fonts) == [text]
        assert len(block["fonts"]) == 1
        assert fonts[block["fonts"][0]][0].endswith("+NotoSansCJKsc")
        assert _read_back(answer, block) == text


def _read_back(answer, block):
    """The text a reader outside this engine extracts from a block."""
    from pdfminer.high_level import extract_text

    with pikepdf.open(io.BytesIO(base64.b64decode(answer["pdf"]))) as pdf:
        page = pdf.pages[0]
        page.obj["/MediaBox"] = pikepdf.Array([0, 0, 4000, 200])
        page.obj["/Contents"] = pdf.make_stream(("1 0 0 1 10 100 cm " + block["content"]).encode("ascii"))
        buffer = io.BytesIO()
        pdf.save(buffer)
    buffer.seek(0)
    return extract_text(buffer).rstrip("\n\x0c")


def _inside_a_line(text):
    """What a line draws of `text`: a soft hyphen draws nothing inside one."""
    return text.replace("\u00ad", "")


# Characters of one glyph: the first five rows in the CJK face (CFF
# outlines, CID-keyed), the last in Liberation Serif Italic (TrueType).
_ONE_GLYPH = (
    ("\u0020\u00a0", "中", {}),
    ("\u002d\u00ad\u2011", "中", {}),
    ("\u2012\u2013", "中", {}),
    ("\u2003\u3000", "中", {}),
    ("\u2026\u22ef", "中", {}),
    ("\ufb01\uf001", "", {"family": "serif", "italic": True}),
)


@pytest.mark.parametrize("shaped", (False, True))
@pytest.mark.parametrize("characters, lead, style", _ONE_GLYPH)
def test_characters_of_one_glyph_read_back_as_written(characters, lead, style, shaped):
    face = "NotoSansCJKsc-Regular.otf" if lead else "LiberationSerif-Italic.ttf"
    names = ff.face_glyph_names(os.path.join(FONTS_DIR, face))
    assert len({names[ord(ch)] for ch in characters}) == 1
    body = "x" + "y".join(characters) + "z" + "".join(reversed(characters)) + "w"
    text = " ".join(part for part in (lead, "e\u0301" if shaped else "", body) if part)
    request = [{"text": text, "size": 12, **style}]
    assert "".join(_draw(request, draw=False)["blocks"][0]["lines"]) == text
    answer = _draw(request)
    block = answer["blocks"][0]
    fonts = _fonts(answer)
    assert len(block["fonts"]) == 1
    assert _shown(block, fonts) == [_inside_a_line(text)]
    codes = fonts[block["fonts"][0]][1]
    # An unbroken soft hyphen has no code: it is not drawn and must not
    # participate in the one-glyph spelling aliases this test checks.
    drawn_characters = characters.replace("\u00ad", "")
    assert len({code for code, spells in codes.items() if spells in drawn_characters}) == len(drawn_characters)
    assert _read_back(answer, block) == _inside_a_line(text)


def test_a_shaped_run_beside_two_characters_of_one_glyph_is_drawn():
    text = "中 e\u0301 \u00a0x"
    assert "refused" not in _draw([{"text": text}], draw=False)["blocks"][0]
    answer = _draw([{"text": text}])
    assert _read_back(answer, answer["blocks"][0]) == text


def test_the_shared_samples_are_laid_out_drawn_and_read_back():
    """The samples the edit gate is tested on (`text-box-gate-agreement`):
    the layout refuses exactly the ones marked refused, and every other one
    is drawn and read back."""
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "support", "text-box-samples.json")
    with open(path, encoding="utf-8") as source:
        samples = json.load(source)["samples"]
    blocks = [{"text": sample["text"], "size": 12} for sample in samples]
    laid = _draw(blocks, draw=False)["blocks"]
    answer = _draw(blocks)
    for sample, before, block in zip(samples, laid, answer["blocks"]):
        text = sample["text"]
        assert ("refused" in before) == (sample["read"] == "refused"), ascii(text)
        assert before == {key: block[key] for key in before}, ascii(text)
        if "refused" in before:
            continue
        back = _read_back(answer, block)
        if sample["read"] == "exact":
            assert back == _inside_a_line(text), ascii(text)
        else:
            assert sorted(back.replace(" ", "")) == sorted(_inside_a_line(text).replace(" ", "")), ascii(text)


def _points_of(face):
    return [point for point in ff.face_glyph_names(os.path.join(FONTS_DIR, face)) if not 0xD800 <= point <= 0xDFFF]


def _one_glyph_points(face):
    by_glyph = {}
    for point, name in ff.face_glyph_names(os.path.join(FONTS_DIR, face)).items():
        by_glyph.setdefault(name, []).append(point)
    return [point for points in by_glyph.values() if len(points) > 1 for point in points]


_LADDERS = [(family, bold, italic) for family in ("sans", "serif", "mono") for bold in (False, True) for italic in (False, True)]
_STRINGS_PER_LADDER = 250
_BLOCKS_PER_CALL = 125


@pytest.mark.parametrize("family, bold, italic", _LADDERS)
def test_a_text_the_layout_answers_is_always_drawn(family, bold, italic):
    """Layout without drawing is what the edit gate stands on: for random
    texts over every character a ladder admits, the drawing call answers
    what the layout call answered and shows every character."""
    style = ff.style_key(bold, italic)
    rng = random.Random(f"text-box-{family}-{style}")
    faces = _Faces(FONTS_DIR, family, style)
    files = [ff._FACE_FILES[family][style], ff._CJK_FACES[style], ff._RTL_FACES["hebrew"][style], ff._RTL_FACES["arabic"][style]]
    pool = sorted({point for name in files for point in _points_of(name)})
    keen = sorted(
        {point for name in files for point in _one_glyph_points(name)}
        | set(range(0x0300, 0x0370)) | set(range(0x05B0, 0x05EB)) | set(range(0x0621, 0x0653))
        | set(range(0x1100, 0x1200)) | set(range(0xFB00, 0xFB07)) | {0x200C, 0x200D, 0x200E, 0x200F, 0x00E9, 0x0065, 0x0066, 0x0069}
    )

    def character():
        while True:
            ch = chr(rng.choice(keen if rng.random() < 0.5 else pool))
            if ch in "\n\r\t" or (rng.random() < 0.98 and _drawn(ch) and faces.face_for(ch) is None):
                continue
            return ch

    def text():
        words = ["".join(character() for _ in range(rng.randint(1, 5))) for _ in range(rng.randint(1, 4))]
        return rng.choice((" ", " ", " ", "\u00a0", "\n")).join(words)

    texts = [text() for _ in range(_STRINGS_PER_LADDER)]
    answered = 0
    for start in range(0, len(texts), _BLOCKS_PER_CALL):
        blocks = [
            {"text": body, "size": 10, "family": family, "bold": bold, "italic": italic, "group": "g"}
            for body in texts[start:start + _BLOCKS_PER_CALL]
        ]
        laid = _draw(blocks, draw=False)["blocks"]
        drawn = _draw(blocks)
        fonts = _fonts(drawn) if "pdf" in drawn else {}
        for request, before, after in zip(blocks, laid, drawn["blocks"]):
            assert before == {key: after[key] for key in before}, ascii(request["text"])
            if "refused" in before:
                continue
            answered += 1
            # A shaped cluster spells the joiners it holds; outside one they draw nothing.
            shown = sorted(_drawn("".join(_shown(after, fonts))).replace(" ", "")) if after["content"] else []
            assert shown == sorted(_inside_a_line(_drawn(request["text"])).replace(" ", "")), ascii(request["text"])
    assert answered > _STRINGS_PER_LADDER * 0.8


def test_a_white_space_character_other_than_the_space_needs_a_glyph():
    answer = _draw([{"text": "a   b"}, {"text": "a 　 b"}])
    assert answer["blocks"][0] == {"refused": " "}
    assert answer["blocks"][1]["lines"] == ["a 　 b"]


def test_a_character_is_refused_alone_or_never():
    # The refusal of a block is the union of the refusals of its characters.
    text = "Zażółć 中文 " + HEBREW + " " + ARABIC + " नम \U0001F600 ก"
    whole = _draw([{"text": text}])["blocks"][0]["refused"]
    alone = [ch for ch in sorted(set(text)) if "refused" in _draw([{"text": ch}], draw=False)["blocks"][0]]
    assert whole == "".join(alone)


def test_answers_the_face_files_of_the_folder_and_refuses_when_it_holds_none(tmp_path):
    answer = text_box_appearance([], FONTS_DIR, False, True)
    assert answer["blocks"] == [] and set(_FACES) <= set(answer["faces"])
    assert answer["faces"] == sorted(answer["faces"])
    empty = text_box_appearance([{"text": "żółć"}, {"text": "abc"}], str(tmp_path), True, True)
    assert empty["faces"] == []
    assert empty["blocks"][0] == {"refused": "".join(sorted("żółć"))}
    assert empty["blocks"][1] == {"refused": "abc"}
    missing = text_box_appearance([{"text": "żółć"}], str(tmp_path / "none"), False, True)
    assert missing["faces"] == [] and "refused" in missing["blocks"][0]


def test_any_positive_size_is_laid_out():
    block = _draw([{"text": "Ab", "size": 4000}], draw=False)["blocks"][0]
    assert block["lines"] == ["Ab"] and block["widths"][0] > 4000
    for bad in (float("inf"), float("nan")):
        with pytest.raises(ValueError):
            _draw([{"text": "a", "size": bad}])


# ── the font file is a new document ───────────────────────────────────────


def test_the_font_file_is_new_and_unprotected_and_no_document_is_opened(monkeypatch, tmp_path):
    """The method takes text and a fonts folder. It opens no PDF, reads no
    file outside the fonts folder, and writes its one file through the
    engine's save seam with nothing to carry: no encryption, no credential,
    no path."""
    import builtins

    import engine.text_box as text_box
    from engine import credentials, pdf_save

    def refuse(*args, **kwargs):
        raise AssertionError("a document is opened")

    read: list = []
    real_open = builtins.open

    def recording(file, *args, **kwargs):
        if isinstance(file, (str, os.PathLike)):
            read.append(os.path.realpath(os.fspath(file)))
        return real_open(file, *args, **kwargs)

    saves: list = []
    real_save = pdf_save.save_pdf

    def seam(pdf, target, **kwargs):
        saves.append((kwargs, isinstance(target, io.BytesIO), getattr(pdf, "_spectra_credential", None),
                      getattr(pdf, "_spectra_preserve_encryption", False), pdf.is_encrypted))
        return real_save(pdf, target, **kwargs)

    blocks = [{"text": POLISH + " 中"}, {"text": ARABIC}]
    monkeypatch.setattr(pikepdf, "open", refuse)
    monkeypatch.setattr(credentials, "open_pdf", refuse)
    monkeypatch.setattr(builtins, "open", recording)
    monkeypatch.setattr(text_box, "save_pdf", seam)
    ff._face_facts.cache_clear()
    try:
        answer = text_box_appearance(blocks, FONTS_DIR, True, True)
    finally:
        monkeypatch.undo()
    assert saves == [({}, True, None, False, False)]
    folder = os.path.realpath(FONTS_DIR)
    assert read and all(os.path.dirname(path) == folder for path in read)
    data = base64.b64decode(answer["pdf"])
    assert b"/Encrypt" not in data
    with pikepdf.open(io.BytesIO(data)) as pdf:
        assert pdf.is_encrypted is False
        assert "/Encrypt" not in pdf.trailer and "/Info" not in pdf.trailer
        assert set(pdf.Root.keys()) == {"/Type", "/Pages"}
        assert len(pdf.pages) == 1 and set(pdf.pages[0].obj["/Resources"].keys()) == {"/Font"}
    # The same request gives the same file: the identifier comes from the bytes.
    assert text_box_appearance(blocks, FONTS_DIR)["pdf"] == answer["pdf"]


# ── a subset a face cannot carry ──────────────────────────────────────────


def _synthetic_face(folder, cff2):
    """A face file of the sans ladder with CFF or CFF2 outlines: `A` and the
    Greek capital alpha share a glyph, the hyphen and the soft hyphen share
    one, and `f i` is a ligature."""
    from fontTools.fontBuilder import FontBuilder
    from fontTools.pens.t2CharStringPen import T2CharStringPen

    order = [".notdef", "space", "A", "f", "i", "f_i", "hyphen"]
    builder = FontBuilder(1000, isTTF=False)
    builder.setupGlyphOrder(order)
    builder.setupCharacterMap({0x20: "space", 0x41: "A", 0x391: "A", 0x66: "f", 0x69: "i", 0x2D: "hyphen", 0xAD: "hyphen"})
    strings = {}
    for name in order:
        pen = T2CharStringPen(None if cff2 else 600, None, CFF2=cff2)
        if name not in (".notdef", "space"):
            pen.moveTo((50, 0))
            pen.lineTo((550, 0))
            pen.lineTo((300, 700))
            pen.closePath()
        strings[name] = pen.getCharString()
    if cff2:
        builder.setupCFF2(strings)
    else:
        builder.setupCFF("Synthetic-Regular", {"FullName": "Synthetic"}, strings, {})
    builder.setupHorizontalMetrics({name: (600, 50) for name in order})
    builder.setupHorizontalHeader(ascent=800, descent=-200)
    builder.setupNameTable({"familyName": "Synthetic", "styleName": "Regular"})
    builder.setupOS2(sTypoAscender=800, sTypoDescender=-200, usWinAscent=800, usWinDescent=200)
    builder.setupPost()
    builder.addOpenTypeFeatures(
        "languagesystem DFLT dflt; languagesystem latn dflt; feature liga { sub f i by f_i; } liga;"
    )
    path = os.path.join(str(folder), ff._FACE_FILES["sans"]["regular"])
    builder.save(path)
    return path


def test_a_cff2_face_refuses_two_spellings_of_a_glyph_beside_a_shaped_word(tmp_path):
    face = _synthetic_face(tmp_path, cff2=True)
    assert ff.face_outlines(face) == ("cff2", 7)
    blocks = [
        {"text": "fi A \u0391", "group": 1},
        {"text": "A i", "group": 1},
        {"text": "A \u0391", "group": 2},
        {"text": "fi A", "group": 3},
    ]
    laid = text_box_appearance(blocks, str(tmp_path), False)["blocks"]
    drawn = text_box_appearance(blocks, str(tmp_path), True)
    # The face of group 1 cannot be built: each of its blocks names the
    # characters of the shared glyph that it holds.
    assert laid[0] == drawn["blocks"][0] == {"refused": "A\u0391"}
    assert laid[1] == drawn["blocks"][1] == {"refused": "A"}
    for before, after in zip(laid[2:], drawn["blocks"][2:]):
        assert "refused" not in before and before == {key: after[key] for key in before}
        assert after["content"] and after["fonts"]
    assert "pdf" in drawn


def test_a_cff_face_carries_two_spellings_of_a_glyph_beside_a_shaped_word(tmp_path):
    _synthetic_face(tmp_path, cff2=False)
    answer = text_box_appearance([{"text": "fi A \u0391"}], str(tmp_path), True)
    assert text_box_appearance([{"text": "fi A \u0391"}], str(tmp_path), False)["blocks"][0]["lines"] == ["fi A \u0391"]
    assert _shown(answer["blocks"][0], _fonts(answer)) == ["fi A \u0391"]


@pytest.mark.parametrize("cff2", (True, False))
def test_layout_and_draw_agree_on_every_text_of_a_synthetic_face(tmp_path, cff2):
    _synthetic_face(tmp_path, cff2)
    rng = random.Random(f"synthetic-{cff2}")
    texts = ["".join(rng.choice("A\u0391fi-\u00ad  ") for _ in range(rng.randint(1, 9))) for _ in range(120)]
    refused = 0
    for group in (None, "shared"):
        blocks = [{"text": text, "size": 10, "width": 40, **({"group": group} if group else {})} for text in texts]
        laid = text_box_appearance(blocks, str(tmp_path), False)["blocks"]
        drawn = text_box_appearance(blocks, str(tmp_path), True)["blocks"]
        for text, before, after in zip(texts, laid, drawn):
            assert before == {key: after[key] for key in before}, ascii(text)
            refused += "refused" in before
    assert refused > 0 if cff2 else refused == 0


def test_an_error_of_a_font_builder_is_the_refusal_of_its_blocks(monkeypatch):
    import engine.text_box as text_box

    def failing(real):
        def build(pdf, face, text, *args, **kwargs):
            if set(text) & set(HEBREW.replace(" ", "")):
                raise RuntimeError("no free glyph")
            return real(pdf, face, text, *args, **kwargs)
        return build

    monkeypatch.setattr(text_box, "build_fallback_font", failing(text_box.build_fallback_font))
    monkeypatch.setattr(text_box, "build_shaped_font", failing(text_box.build_shaped_font))
    answer = _draw([{"text": HEBREW}, {"text": POLISH}, {"text": "x " + HEBREW}])
    assert answer["blocks"][0] == {"refused": "".join(sorted(set(HEBREW.replace(" ", ""))))}
    assert answer["blocks"][1]["lines"] == [POLISH] and answer["blocks"][1]["content"]
    assert "refused" in answer["blocks"][2]


# ── the soft hyphen ───────────────────────────────────────────────────────

_SHY = "\u00ad"


def _mono(text, width=None, draw=True):
    request = {"text": text, "size": 10, "family": "mono"}
    if width is not None:
        request["width"] = width
    return _draw([request], draw=draw)


def test_a_soft_hyphen_inside_a_line_draws_nothing_and_takes_no_advance():
    answer = _mono(f"ex{_SHY}tra ż")
    block = answer["blocks"][0]
    assert block["lines"] == [f"ex{_SHY}tra ż"] and "hyphens" not in block
    assert _shown(block, _fonts(answer)) == ["extra ż"]
    assert block["widths"] == _mono("extra ż")["blocks"][0]["widths"]
    assert _read_back(answer, block) == "extra ż"


def test_a_line_that_breaks_at_a_soft_hyphen_ends_with_a_drawn_hyphen():
    text = f"ab{_SHY}cd{_SHY}ef"
    # One character of the mono face is 6 points at size 10.
    answer = _mono(text, width=33)
    block = answer["blocks"][0]
    assert block == {**_mono(text, width=33, draw=False)["blocks"][0], "content": block["content"], "fonts": block["fonts"]}
    assert block["lines"] == [f"ab{_SHY}cd{_SHY}", "ef"] and "".join(block["lines"]) == text
    assert block["hyphens"] == [0]
    assert _shown(block, _fonts(answer)) == ["abcd-", "ef"]
    assert [round(width, 2) for width in block["widths"]] == [30.0, 12.0]


def test_a_line_ends_at_an_earlier_break_when_the_hyphen_does_not_fit():
    text = f"ab{_SHY}cd{_SHY}ef"
    # `abcd` fits in 27 points and `abcd` with its hyphen does not.
    answer = _mono(text, width=27)
    block = answer["blocks"][0]
    assert block["lines"] == [f"ab{_SHY}", f"cd{_SHY}ef"]
    assert block["hyphens"] == [0]
    assert _shown(block, _fonts(answer)) == ["ab-", "cdef"]
    assert all(width <= 27 for width in block["widths"])


def test_a_soft_hyphen_before_a_space_or_a_line_end_draws_nothing():
    answer = _mono(f"abc{_SHY} def{_SHY}\nghi{_SHY}", width=20)
    block = answer["blocks"][0]
    assert block["lines"] == [f"abc{_SHY}", f"def{_SHY}", f"ghi{_SHY}"]
    assert "hyphens" not in block
    assert _shown(block, _fonts(answer)) == ["abc", "def", "ghi"]


def test_a_soft_hyphen_in_right_to_left_text_follows_the_same_rule():
    first, second = HEBREW.split(" ")
    text = first + _SHY + second
    # This face has the Hebrew letters and ASCII hyphen, but no U+00AD cmap
    # entry. The invisible break marker must not make another face take over.
    face = os.path.join(FONTS_DIR, "NotoSansHebrew-Regular.ttf")
    whole = text_box_appearance([{"text": text, "size": 12}], face)
    assert whole["blocks"][0]["lines"] == [text]
    assert _SHY not in "".join(_shown(whole["blocks"][0], _fonts(whole)))
    plain = text_box_appearance([{"text": first + second, "size": 12}], face)["blocks"][0]
    assert whole["blocks"][0]["widths"] == plain["widths"]
    assert whole["blocks"][0]["fonts"] == plain["fonts"] == ["NotoSansHebrew"]
    answer = text_box_appearance([{"text": text, "size": 12, "width": plain["widths"][0] - 1}], face)
    block = answer["blocks"][0]
    assert block["lines"] == [first + _SHY, second] and block["hyphens"] == [0] and block["rtl"] is True
    assert block["fonts"] == ["NotoSansHebrew"]
    shown = _shown(block, _fonts(answer))
    # The line is shown in visual order: the hyphen ends the line on its left.
    assert shown[0][0] == "-" and sorted(shown[0][1:]) == sorted(first)
    assert sorted(shown[1]) == sorted(second)


def test_a_joining_word_keeps_whole_word_shaping_unless_a_soft_hyphen_breaks_it():
    first, second = "مرحبا", "بالعالم"
    text = first + _SHY + second
    whole = _draw([{"text": text, "size": 10}])
    plain = _draw([{"text": first + second, "size": 10}])
    whole_block, plain_block = whole["blocks"][0], plain["blocks"][0]
    assert whole_block["lines"] == [text]
    assert whole_block["widths"] == plain_block["widths"]
    assert whole_block["fonts"] == plain_block["fonts"]
    assert _shown(whole_block, _fonts(whole)) == _shown(plain_block, _fonts(plain))

    broken = _draw([{"text": text, "size": 10, "width": 30}])
    block = broken["blocks"][0]
    assert block["lines"] == [first + _SHY, second]
    assert block["hyphens"] == [0]
    shown = _shown(block, _fonts(broken))
    assert shown[0].count("-") == 1
    assert sorted(shown[0].replace("-", "")) == sorted(first)
    assert sorted(shown[1]) == sorted(second)
