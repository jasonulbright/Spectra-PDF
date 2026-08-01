"""9.T3 — right-to-left paragraph reflow, end to end.

The fixtures here build RTL pages the way a real producer does: text shaped
by HarfBuzz and drawn LEFT TO RIGHT in visual order, embedded Identity-H with
a ToUnicode back to the plain letters. That is the only shape a PDF can take
— the pen only moves one way — and it is precisely why the listing has to
normalize to logical order before anything can be edited.
"""

import io
import os
import re

import pikepdf
import pytest
from fontTools import subset as ft_subset
from fontTools.ttLib import TTFont
from pikepdf import Array, Dictionary, Name

from engine import bidi, shaping
from engine.text_paragraphs import list_text_paragraphs, replace_paragraph_text

FONTS = os.path.join(os.path.dirname(__file__), "..", "resources", "fonts")
ARABIC_FACE = os.path.join(FONTS, "IBMPlexSansArabic-Regular.ttf")
HEBREW_FACE = os.path.join(FONTS, "NotoSansHebrew-Regular.ttf")

AR_HELLO = "مرحبا بالعالم"
AR_LONG = "مرحبا بالعالم لغة عربية جميلة ونص طويل يحتاج الى اكثر من سطر واحد"
HE_HELLO = "שלום עולם"
MIXED = "قال PDF ثم توقف"

pytestmark = pytest.mark.skipif(
    not os.path.isfile(ARABIC_FACE),
    reason="RTL faces not provisioned (scripts/sync-edit-fonts.ps1)",
)


def _embed(pdf, face_path, gids, gid_text):
    """Identity-H CIDFontType2 subset retaining the shaped glyph ids."""
    options = ft_subset.Options()
    options.retain_gids = True
    options.notdef_outline = True
    # A producer has no use for either once the glyphs are chosen — dropping
    # them is what makes re-shaping in the document's own font impossible.
    options.drop_tables += ["GSUB", "GPOS"]
    subsetter = ft_subset.Subsetter(options=options)
    font = TTFont(face_path)
    order = font.getGlyphOrder()
    subsetter.populate(glyphs=sorted({order[g] for g in gids}))
    subsetter.subset(font)
    buf = io.BytesIO()
    font.save(buf)
    data = buf.getvalue()
    sub = TTFont(io.BytesIO(data))
    upem = sub["head"].unitsPerEm
    widths = {
        g: round(sub["hmtx"][order[g]][0] * 1000.0 / upem, 2)
        for g in sorted(set(gids))
        if order[g] in sub.getGlyphOrder()
    }
    prog = pdf.make_stream(data)
    prog["/Length1"] = len(data)
    descriptor = pdf.make_indirect(Dictionary(
        Type=Name("/FontDescriptor"), FontName=Name("/AAAAAA+Probe"), Flags=4,
        FontBBox=Array([-1000, -500, 2000, 1200]), ItalicAngle=0,
        Ascent=900, Descent=-200, CapHeight=700, StemV=80, FontFile2=prog,
    ))
    w = []
    for g in sorted(widths):
        w += [g, Array([widths[g]])]
    descendant = pdf.make_indirect(Dictionary(
        Type=Name("/Font"), Subtype=Name("/CIDFontType2"), BaseFont=Name("/AAAAAA+Probe"),
        CIDSystemInfo=Dictionary(Registry=b"Adobe", Ordering=b"Identity", Supplement=0),
        FontDescriptor=descriptor, DW=1000, W=Array(w), CIDToGIDMap=Name("/Identity"),
    ))
    entries = "\n".join(
        f"<{g:04x}> <{t.encode('utf-16-be').hex()}>" for g, t in sorted(gid_text.items())
    )
    tou = (
        "/CIDInit /ProcSet findresource begin\n12 dict begin\nbegincmap\n"
        "/CMapName /Adobe-Identity-UCS def\n/CMapType 2 def\n"
        "1 begincodespacerange\n<0000> <ffff>\nendcodespacerange\n"
        f"{len(gid_text)} beginbfchar\n{entries}\nendbfchar\nendcmap\n"
        "CMapName currentdict /CMap defineresource pop\nend\nend\n"
    )
    return pdf.make_indirect(Dictionary(
        Type=Name("/Font"), Subtype=Name("/Type0"), BaseFont=Name("/AAAAAA+Probe"),
        Encoding=Name("/Identity-H"), DescendantFonts=Array([descendant]),
        ToUnicode=pdf.make_stream(tou.encode("ascii")),
    ))


def _shape_line(face_path, text):
    """[(glyph name, tounicode text)] for ONE line, the way a real producer
    builds it: run the bidi algorithm first, then shape each directional run
    on its own. Shaping the whole mixed string in one direction — which
    HarfBuzz will happily do, since it does not implement bidi — would draw
    an embedded Latin word backwards, and no producer emits that."""
    _lvl, levels = bidi.resolve(text, 1)
    order = bidi.visual_order(text, 1)[1]
    out = []
    i = 0
    while i < len(order):
        lvl = levels[order[i]]
        j = i
        while j < len(order) and levels[order[j]] == lvl:
            j += 1
        idx = order[i:j]
        rtl = bool(lvl % 2)
        chunk = "".join(text[k] for k in (reversed(idx) if rtl else idx))
        run = shaping.shape(face_path, chunk, rtl=rtl)
        out.extend(run.clusters)
        i = j
    return out


def build_rtl_pdf(path, lines, face_path=ARABIC_FACE, size=16.0, x=72.0,
                  y0=720.0, leading=22.0):
    """A page whose `lines` are shaped and drawn in VISUAL order."""
    pdf = pikepdf.new()
    page = pdf.add_blank_page(page_size=(612, 792))
    gid_of = {n: i for i, n in enumerate(TTFont(face_path, lazy=True).getGlyphOrder())}
    all_gids, gid_text, shaped_lines = set(), {}, []
    for text in lines:
        run = _shape_line(face_path, text)
        shaped_lines.append(run)
        for name, cluster in run:
            g = gid_of[name]
            all_gids.add(g)
            if cluster:
                gid_text[g] = cluster
            else:
                gid_text.setdefault(g, "")
    font_dict = _embed(pdf, face_path, all_gids, gid_text)
    ops = ["BT", "/PF1 %g Tf" % size]
    for i, run in enumerate(shaped_lines):
        hexes = "".join(f"{gid_of[n]:04x}" for n, _t in run)
        ops.append(f"1 0 0 1 {x} {y0 - i * leading} Tm")
        ops.append(f"<{hexes}> Tj")
    ops.append("ET")
    page.Contents = pdf.make_stream(("\n".join(ops)).encode("ascii"))
    page.Resources = Dictionary(Font=Dictionary(PF1=font_dict))
    pdf.save(path)
    pdf.close()
    return path


def _subseq(haystack, needle) -> bool:
    """Whether `needle` appears as a contiguous run inside `haystack`."""
    n = len(needle)
    return any(haystack[i : i + n] == needle for i in range(len(haystack) - n + 1))


def _paras(path):
    return list_text_paragraphs(path, 1)["paragraphs"]


def _apply(src, out, para, new_text, **kw):
    kw.setdefault("convert", True)
    kw.setdefault("font_path", FONTS)
    return replace_paragraph_text(
        src, out, 1, para["index"], new_text,
        [{"start": 0, "end": len(new_text), "run": para["runs"][0]}],
        para["runs"], para["text"], **kw,
    )


# ── the listing half ──────────────────────────────────────────────────────


class TestLogicalListing:
    def test_arabic_lists_in_logical_order(self, tmp_dir):
        src = build_rtl_pdf(os.path.join(tmp_dir, "ar.pdf"), [AR_HELLO])
        para = _paras(src)[0]
        assert para["text"] == AR_HELLO
        assert para["editable"] is True
        assert para["rtl"] is True and para["bidi"] is True

    def test_the_page_really_is_drawn_the_other_way(self, tmp_dir):
        # Guards the fixture, not the code: if the producer emitted logical
        # order, every normalization test below would pass trivially.
        src = build_rtl_pdf(os.path.join(tmp_dir, "ar.pdf"), [AR_HELLO])
        runs = list_text_paragraphs(src, 1)["runs"]
        drawn = "".join(r["text"] for r in runs)
        assert drawn != AR_HELLO
        _lvl, order = bidi.visual_order(AR_HELLO, 1)
        assert drawn == "".join(AR_HELLO[i] for i in order)

    def test_lines_join_in_reading_order(self, tmp_dir):
        src = build_rtl_pdf(os.path.join(tmp_dir, "ar2.pdf"), [AR_HELLO, "لغة عربية"])
        para = _paras(src)[0]
        assert para["text"] == AR_HELLO + " لغة عربية"

    def test_mixed_direction_keeps_the_latin_run_readable(self, tmp_dir):
        src = build_rtl_pdf(os.path.join(tmp_dir, "mix.pdf"), [MIXED])
        para = _paras(src)[0]
        assert para["text"] == MIXED
        assert "PDF" in para["text"]  # not "FDP"

    def test_hebrew_lists_logical(self, tmp_dir):
        src = build_rtl_pdf(os.path.join(tmp_dir, "he.pdf"), [HE_HELLO],
                            face_path=HEBREW_FACE)
        para = _paras(src)[0]
        assert para["text"] == HE_HELLO
        assert para["rtl"] is True

    def test_rtl_paragraph_defaults_to_right_alignment(self, tmp_dir):
        src = build_rtl_pdf(os.path.join(tmp_dir, "ar.pdf"), [AR_HELLO])
        assert _paras(src)[0]["alignment"] == "right"


# ── the reflow half ───────────────────────────────────────────────────────


class TestReflow:
    def test_edit_round_trips(self, tmp_dir):
        src = build_rtl_pdf(os.path.join(tmp_dir, "ar.pdf"), [AR_HELLO])
        out = os.path.join(tmp_dir, "o.pdf")
        new_text = AR_HELLO + " نص جديد"
        _apply(src, out, _paras(src)[0], new_text)
        assert _paras(out)[0]["text"] == new_text

    def test_unchanged_text_round_trips(self, tmp_dir):
        # The baseline the whole feature rests on: list, commit unchanged,
        # re-list. Anything that does not survive this cannot survive an edit.
        src = build_rtl_pdf(os.path.join(tmp_dir, "ar.pdf"), [AR_HELLO, "لغة عربية"])
        out = os.path.join(tmp_dir, "o.pdf")
        para = _paras(src)[0]
        _apply(src, out, para, para["text"])
        assert _paras(out)[0]["text"] == para["text"]

    def test_growth_rewraps_and_still_round_trips(self, tmp_dir):
        src = build_rtl_pdf(os.path.join(tmp_dir, "ar.pdf"), [AR_HELLO])
        out = os.path.join(tmp_dir, "o.pdf")
        _apply(src, out, _paras(src)[0], AR_LONG)
        relisted = _paras(out)
        assert relisted[0]["text"] == AR_LONG
        assert relisted[0]["line_count"] > 1  # it really did wrap

    def test_mixed_direction_edit_round_trips(self, tmp_dir):
        src = build_rtl_pdf(os.path.join(tmp_dir, "mix.pdf"), [MIXED])
        out = os.path.join(tmp_dir, "o.pdf")
        new_text = MIXED + " عند الصفحة 42"
        _apply(src, out, _paras(src)[0], new_text)
        assert _paras(out)[0]["text"] == new_text

    def test_hebrew_edit_round_trips(self, tmp_dir):
        src = build_rtl_pdf(os.path.join(tmp_dir, "he.pdf"), [HE_HELLO],
                            face_path=HEBREW_FACE)
        out = os.path.join(tmp_dir, "o.pdf")
        new_text = HE_HELLO + " ועוד"
        _apply(src, out, _paras(src)[0], new_text)
        assert _paras(out)[0]["text"] == new_text

    def test_arabic_is_emitted_JOINED_not_as_isolated_letters(self, tmp_dir):
        # The reason shaping is not optional, asserted at the byte level:
        # an isolated-form emission would decode back to the same letters, so
        # a round-trip check alone cannot see the difference. These are the
        # actual glyph ids written into the content stream.
        src = build_rtl_pdf(os.path.join(tmp_dir, "ar.pdf"), [AR_HELLO])
        out = os.path.join(tmp_dir, "o.pdf")
        _apply(src, out, _paras(src)[0], AR_HELLO)
        gid_of = {n: i for i, n in enumerate(TTFont(ARABIC_FACE, lazy=True).getGlyphOrder())}
        joined = shaping.shape(ARABIC_FACE, "مرحبا").glyph_names
        isolated = tuple(
            shaping.shape(ARABIC_FACE, ch).glyph_names[0] for ch in reversed("مرحبا")
        )
        assert joined != isolated  # the premise: joining changes the glyphs
        with pikepdf.open(out) as pdf:
            content = pdf.pages[0].Contents.read_bytes().decode("latin-1")
        codes = [int(h, 16) for h in re.findall(r"<([0-9a-fA-F]{4})>", content)]
        assert _subseq(codes, [gid_of[n] for n in joined])
        assert not _subseq(codes, [gid_of[n] for n in isolated])

    def test_following_content_in_the_SAME_stream_is_resynced(self, tmp_dir):
        # The 7.5 correctness property, exercised in the one direction it had
        # never seen: the re-emission removes the paragraph's shows and
        # re-anchors everything after the divergence against a parallel walk
        # of the original stream. A reordered, re-shaped, re-fonted paragraph
        # is the most it can be asked to resync past.
        src = os.path.join(tmp_dir, "ar.pdf")
        build_rtl_pdf(src, [AR_HELLO])
        with pikepdf.open(src, allow_overwriting_input=True) as pdf:
            page = pdf.pages[0]
            helv = pdf.make_indirect(Dictionary(
                Type=Name("/Font"), Subtype=Name("/Type1"),
                BaseFont=Name("/Helvetica"), Encoding=Name("/WinAnsiEncoding"),
            ))
            page.Resources["/Font"]["/HV"] = helv
            body = page.Contents.read_bytes()
            page.Contents = pdf.make_stream(
                body + b"\nBT /HV 12 Tf 1 0 0 1 72 400 Tm (Trailing latin) Tj ET"
            )
            pdf.save(os.path.join(tmp_dir, "both.pdf"))
        both = os.path.join(tmp_dir, "both.pdf")
        out = os.path.join(tmp_dir, "o.pdf")
        paras = _paras(both)
        target = next(p for p in paras if p["rtl"])
        replace_paragraph_text(
            both, out, 1, target["index"], AR_HELLO + " ونص",
            [{"start": 0, "end": len(AR_HELLO + " ونص"), "run": target["runs"][0]}],
            target["runs"], target["text"], convert=True, font_path=FONTS,
        )
        after = _paras(out)
        assert any(p["text"] == AR_HELLO + " ونص" for p in after)
        latin = next(p for p in after if p["text"] == "Trailing latin")
        # Unmoved and unrestyled: same baseline, same left edge, same size.
        before = next(p for p in paras if p["text"] == "Trailing latin")
        assert latin["box"] == pytest.approx(before["box"], abs=0.01)
        assert latin["font_size"] == pytest.approx(before["font_size"])

    def test_size_restyle_survives_the_reorder(self, tmp_dir):
        src = build_rtl_pdf(os.path.join(tmp_dir, "ar.pdf"), [AR_HELLO])
        out = os.path.join(tmp_dir, "o.pdf")
        _apply(src, out, _paras(src)[0], AR_HELLO, size=24.0)
        relisted = _paras(out)[0]
        assert relisted["text"] == AR_HELLO
        assert relisted["font_size"] == pytest.approx(24.0, abs=0.51)

    def test_colour_restyle_survives_the_reorder(self, tmp_dir):
        src = build_rtl_pdf(os.path.join(tmp_dir, "ar.pdf"), [AR_HELLO])
        out = os.path.join(tmp_dir, "o.pdf")
        _apply(src, out, _paras(src)[0], AR_HELLO, color=[1.0, 0.0, 0.0])
        relisted = _paras(out)[0]
        assert relisted["text"] == AR_HELLO
        assert relisted["color"] == "#ff0000"


# ── the shaping module ────────────────────────────────────────────────────


class TestShaping:
    def test_requires_shaping_is_about_the_script_not_the_direction(self):
        assert shaping.requires_shaping("مرحبا")
        assert not shaping.requires_shaping(HE_HELLO)  # Hebrew does not join
        assert not shaping.requires_shaping("hello")
        assert not shaping.requires_shaping("")

    def test_shaping_picks_contextual_forms(self):
        run = shaping.shape(ARABIC_FACE, "بب")
        assert len(run.glyphs) == 2
        # Initial and final forms of the same letter are different glyphs.
        assert run.glyph_names[0] != run.glyph_names[1]

    def test_every_cluster_has_exactly_one_carrier(self):
        run = shaping.shape(ARABIC_FACE, AR_HELLO)
        carriers = [t for _n, t in run.clusters if t]
        assert "".join(carriers) != ""
        # Every source character is spelled exactly once.
        assert sorted("".join(carriers)) == sorted(AR_HELLO)

    def test_a_face_without_the_script_refuses(self):
        with pytest.raises(ValueError):
            shaping.shape(HEBREW_FACE, "مرحبا")

    def test_advance_is_per_thousand_em(self):
        run = shaping.shape(ARABIC_FACE, "م")
        assert 100.0 < run.advance_1000 < 2000.0
