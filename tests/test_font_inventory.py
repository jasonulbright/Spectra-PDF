"""Every font a document uses — the Properties dialog's Fonts tab.

The fixtures are hand-built rather than produced by a font toolchain: what is
under test is the ENUMERATION (which resource dictionaries are reached, how a
font's type/encoding/embedded status is read, how entries are grouped), and a
descriptor's `/FontFile2` key answers "is the program in the file" whatever
bytes the stream holds. The substitution face is resolved against a stand-in
fonts directory, so the test needs no provisioned resources.
"""

import pikepdf
import pytest
from pikepdf import Array, Dictionary, Name, Stream, String

from engine.font_inventory import list_document_fonts

# The Liberation face names `font_fallback._FACE_FILES` resolves against. Empty
# files: only the NAME is chosen here, never opened.
_FACE_NAMES = [
    "LiberationSans-Regular.ttf",
    "LiberationSans-Bold.ttf",
    "LiberationSerif-Regular.ttf",
    "LiberationMono-Regular.ttf",
]


@pytest.fixture
def font_dir(tmp_path):
    directory = tmp_path / "fonts"
    directory.mkdir()
    for name in _FACE_NAMES:
        (directory / name).write_bytes(b"")
    return str(directory)


def _type1(base="Helvetica", encoding="WinAnsiEncoding", embedded=False, flags=32):
    font = Dictionary(Type=Name.Font, Subtype=Name.Type1, BaseFont=Name("/" + base))
    if encoding:
        font[Name.Encoding] = Name("/" + encoding)
    descriptor = Dictionary(Type=Name.FontDescriptor, FontName=Name("/" + base), Flags=flags)
    font[Name.FontDescriptor] = descriptor
    return font, descriptor


def _truetype(base="Arial", embedded=False):
    font = Dictionary(
        Type=Name.Font, Subtype=Name.TrueType, BaseFont=Name("/" + base),
        Encoding=Name.WinAnsiEncoding,
    )
    descriptor = Dictionary(Type=Name.FontDescriptor, FontName=Name("/" + base), Flags=32)
    font[Name.FontDescriptor] = descriptor
    return font, descriptor


def _type0(pdf, base="ABCDEF+NotoSans", cid_type="CIDFontType2", embedded=True):
    descriptor = Dictionary(Type=Name.FontDescriptor, FontName=Name("/" + base), Flags=4)
    if embedded:
        key = Name.FontFile2 if cid_type == "CIDFontType2" else Name.FontFile3
        descriptor[key] = pdf.make_indirect(Stream(pdf, b"\x00stub"))
    descendant = Dictionary(
        Type=Name.Font,
        Subtype=Name("/" + cid_type),
        BaseFont=Name("/" + base),
        FontDescriptor=pdf.make_indirect(descriptor),
        CIDSystemInfo=Dictionary(Registry=String("Adobe"), Ordering=String("Identity"), Supplement=0),
    )
    return Dictionary(
        Type=Name.Font,
        Subtype=Name.Type0,
        BaseFont=Name("/" + base),
        Encoding=Name("/Identity-H"),
        DescendantFonts=Array([pdf.make_indirect(descendant)]),
    )


def _type3(pdf):
    proc = pdf.make_indirect(Stream(pdf, b"0 0 0 0 0 0 d1"))
    return Dictionary(
        Type=Name.Font,
        Subtype=Name.Type3,
        FontBBox=Array([0, 0, 100, 100]),
        FontMatrix=Array([0.001, 0, 0, 0.001, 0, 0]),
        CharProcs=Dictionary(square=proc),
        Encoding=Dictionary(Type=Name.Encoding, Differences=Array([97, Name("/square")])),
        FirstChar=97,
        LastChar=97,
        Widths=Array([100]),
    )


def _by_name(result, name):
    for font in result["fonts"]:
        if font["name"] == name:
            return font
    raise AssertionError(f"{name!r} not listed: {[f['name'] for f in result['fonts']]}")


@pytest.fixture
def every_type(tmp_path):
    """One page carrying every font class the tab can report."""
    path = str(tmp_path / "fonts.pdf")
    pdf = pikepdf.new()
    page = pdf.add_blank_page(page_size=(300, 300))

    helvetica, _ = _type1("Helvetica")
    times, times_desc = _type1("GHIJKL+TimesNewRoman", flags=2)
    times_desc[Name.FontFile] = pdf.make_indirect(Stream(pdf, b"stub-type1"))
    arial, arial_desc = _truetype("Arial")
    arial_desc[Name.FontFile2] = pdf.make_indirect(Stream(pdf, b"stub-truetype"))
    courier, _ = _truetype("CourierNewPS-BoldMT")

    page.obj[Name.Resources] = Dictionary(
        Font=Dictionary(
            F1=pdf.make_indirect(helvetica),
            F2=pdf.make_indirect(times),
            F3=pdf.make_indirect(arial),
            F4=pdf.make_indirect(courier),
            F5=pdf.make_indirect(_type0(pdf)),
            F6=pdf.make_indirect(_type0(pdf, base="MNOPQR+SourceHan", cid_type="CIDFontType0")),
            F7=pdf.make_indirect(_type3(pdf)),
            F8=pdf.make_indirect(_type0(pdf, base="MyGothic", embedded=False)),
        )
    )
    pdf.save(path)
    pdf.close()
    return path


class TestTypesAndStatus:
    def test_every_font_is_listed_once(self, every_type, font_dir):
        result = list_document_fonts(every_type, font_dir)
        assert result["count"] == 8
        assert len(result["fonts"]) == 8

    def test_a_simple_type1_reports_its_type_and_encoding(self, every_type, font_dir):
        font = _by_name(list_document_fonts(every_type, font_dir), "Helvetica")
        assert font["type"] == "Type1"
        assert font["encoding"] == "WinAnsiEncoding"
        assert font["embedded"] is False
        assert font["subset"] is False

    def test_a_truetype_with_a_fontfile2_is_embedded(self, every_type, font_dir):
        font = _by_name(list_document_fonts(every_type, font_dir), "Arial")
        assert font["type"] == "TrueType"
        assert font["embedded"] is True
        assert font["substitute"] is None

    def test_a_subset_prefix_is_stripped_for_display_and_flagged(self, every_type, font_dir):
        font = _by_name(list_document_fonts(every_type, font_dir), "TimesNewRoman")
        assert font["raw_name"] == "GHIJKL+TimesNewRoman"
        assert font["subset"] is True
        assert font["embedded"] is True

    def test_a_type0_reports_its_descendant_s_cid_type(self, every_type, font_dir):
        result = list_document_fonts(every_type, font_dir)
        assert _by_name(result, "NotoSans")["type"] == "CIDFontType2"
        assert _by_name(result, "SourceHan")["type"] == "CIDFontType0"

    def test_a_type0_program_is_found_on_the_descendant_descriptor(self, every_type, font_dir):
        font = _by_name(list_document_fonts(every_type, font_dir), "NotoSans")
        assert font["embedded"] is True
        assert font["encoding"] == "Identity-H"

    def test_a_type0_without_a_program_is_not_embedded(self, every_type, font_dir):
        font = _by_name(list_document_fonts(every_type, font_dir), "MyGothic")
        assert font["embedded"] is False
        assert font["substitute"] == "LiberationSans-Regular.ttf"

    def test_a_type3_is_embedded_by_construction_and_reports_a_custom_encoding(
        self, every_type, font_dir
    ):
        result = list_document_fonts(every_type, font_dir)
        type3 = [f for f in result["fonts"] if f["type"] == "Type3"]
        assert len(type3) == 1
        assert type3[0]["embedded"] is True
        assert type3[0]["encoding"] == "Custom"
        assert type3[0]["name"] == ""


class TestSubstitution:
    def test_a_serif_font_substitutes_the_serif_face(self, tmp_path, font_dir):
        path = str(tmp_path / "serif.pdf")
        pdf = pikepdf.new()
        page = pdf.add_blank_page(page_size=(300, 300))
        font, _ = _type1("Times-Roman", flags=2)
        page.obj[Name.Resources] = Dictionary(Font=Dictionary(F1=pdf.make_indirect(font)))
        pdf.save(path)
        pdf.close()
        font = _by_name(list_document_fonts(path, font_dir), "Times-Roman")
        assert font["substitute"] == "LiberationSerif-Regular.ttf"

    def test_a_bold_name_substitutes_the_bold_face(self, tmp_path, font_dir):
        path = str(tmp_path / "bold.pdf")
        pdf = pikepdf.new()
        page = pdf.add_blank_page(page_size=(300, 300))
        font, _ = _type1("Arial-BoldMT")
        page.obj[Name.Resources] = Dictionary(Font=Dictionary(F1=pdf.make_indirect(font)))
        pdf.save(path)
        pdf.close()
        entry = _by_name(list_document_fonts(path, font_dir), "Arial-BoldMT")
        assert entry["substitute"] == "LiberationSans-Bold.ttf"

    def test_a_missing_style_face_degrades_to_the_family_regular(self, every_type, font_dir):
        # The stand-in directory has no LiberationMono-Bold; face identity beats
        # weight, so a mono bold lands on the mono regular, never a sans bold.
        font = _by_name(list_document_fonts(every_type, font_dir), "CourierNewPS-BoldMT")
        assert font["substitute"] == "LiberationMono-Regular.ttf"

    def test_no_fonts_directory_reports_the_substitution_as_unknown(self, every_type):
        font = _by_name(list_document_fonts(every_type), "Helvetica")
        assert font["embedded"] is False
        assert font["substitute"] is None


class TestWhereFontsHide:
    def test_a_form_xobject_s_own_resources_are_walked(self, tmp_path, font_dir):
        path = str(tmp_path / "form.pdf")
        pdf = pikepdf.new()
        page = pdf.add_blank_page(page_size=(300, 300))
        inner, _ = _type1("Helvetica")
        form = Stream(pdf, b"BT /F1 12 Tf ET")
        form[Name.Type] = Name.XObject
        form[Name.Subtype] = Name.Form
        form[Name.BBox] = Array([0, 0, 100, 100])
        form[Name.Resources] = Dictionary(Font=Dictionary(F1=pdf.make_indirect(inner)))
        page.obj[Name.Resources] = Dictionary(XObject=Dictionary(Fm0=pdf.make_indirect(form)))
        pdf.save(path)
        pdf.close()
        assert _by_name(list_document_fonts(path, font_dir), "Helvetica")["type"] == "Type1"

    def test_an_annotation_appearance_stream_s_resources_are_walked(self, tmp_path, font_dir):
        path = str(tmp_path / "annot.pdf")
        pdf = pikepdf.new()
        page = pdf.add_blank_page(page_size=(300, 300))
        inner, _ = _type1("Helvetica")
        appearance = Stream(pdf, b"BT /F1 12 Tf (x) Tj ET")
        appearance[Name.Type] = Name.XObject
        appearance[Name.Subtype] = Name.Form
        appearance[Name.BBox] = Array([0, 0, 50, 20])
        appearance[Name.Resources] = Dictionary(Font=Dictionary(F1=pdf.make_indirect(inner)))
        page.obj[Name.Annots] = Array([
            pdf.make_indirect(Dictionary(
                Type=Name.Annot,
                Subtype=Name.FreeText,
                Rect=Array([0, 0, 50, 20]),
                AP=Dictionary(N=pdf.make_indirect(appearance)),
            ))
        ])
        page.obj[Name.Resources] = Dictionary()
        pdf.save(path)
        pdf.close()
        result = list_document_fonts(path, font_dir)
        assert result["count"] == 1
        assert result["fonts"][0]["name"] == "Helvetica"

    def test_the_acroform_default_resources_are_walked_and_belong_to_no_page(
        self, tmp_path, font_dir
    ):
        path = str(tmp_path / "acroform.pdf")
        pdf = pikepdf.new()
        page = pdf.add_blank_page(page_size=(300, 300))
        page.obj[Name.Resources] = Dictionary()
        inner, _ = _type1("Helvetica")
        pdf.Root[Name.AcroForm] = Dictionary(
            Fields=Array([]),
            DR=Dictionary(Font=Dictionary(Helv=pdf.make_indirect(inner))),
        )
        pdf.save(path)
        pdf.close()
        font = _by_name(list_document_fonts(path, font_dir), "Helvetica")
        assert font["pages"] == []
        assert font["page_count"] == 0

    def test_a_type3_glyph_procedure_s_resources_are_walked(self, tmp_path, font_dir):
        path = str(tmp_path / "type3-nested.pdf")
        pdf = pikepdf.new()
        page = pdf.add_blank_page(page_size=(300, 300))
        nested, _ = _type1("Helvetica")
        type3 = _type3(pdf)
        proc = Stream(pdf, b"0 0 0 0 0 0 d1 BT /F1 8 Tf ET")
        proc[Name.Resources] = Dictionary(Font=Dictionary(F1=pdf.make_indirect(nested)))
        type3[Name.CharProcs] = Dictionary(square=pdf.make_indirect(proc))
        page.obj[Name.Resources] = Dictionary(Font=Dictionary(T3=pdf.make_indirect(type3)))
        pdf.save(path)
        pdf.close()
        result = list_document_fonts(path, font_dir)
        assert {f["type"] for f in result["fonts"]} == {"Type3", "Type1"}


class TestGroupingAndPages:
    def test_one_font_used_on_many_pages_is_one_entry_with_the_page_list(
        self, tmp_path, font_dir
    ):
        path = str(tmp_path / "shared.pdf")
        pdf = pikepdf.new()
        font, _ = _type1("Helvetica")
        shared = pdf.make_indirect(font)
        for _ in range(4):
            page = pdf.add_blank_page(page_size=(300, 300))
            page.obj[Name.Resources] = Dictionary(Font=Dictionary(F1=shared))
        pdf.save(path)
        pdf.close()
        result = list_document_fonts(path, font_dir)
        assert result["count"] == 1
        assert result["fonts"][0]["pages"] == [1, 2, 3, 4]
        assert result["fonts"][0]["page_count"] == 4

    def test_the_same_font_named_twice_on_one_page_is_one_entry(self, tmp_path, font_dir):
        path = str(tmp_path / "twice.pdf")
        pdf = pikepdf.new()
        page = pdf.add_blank_page(page_size=(300, 300))
        first, _ = _type1("Helvetica")
        second, _ = _type1("Helvetica")
        page.obj[Name.Resources] = Dictionary(
            Font=Dictionary(F1=pdf.make_indirect(first), F2=pdf.make_indirect(second))
        )
        pdf.save(path)
        pdf.close()
        assert list_document_fonts(path, font_dir)["count"] == 1

    def test_the_same_name_with_different_encodings_stays_two_entries(self, tmp_path, font_dir):
        path = str(tmp_path / "encodings.pdf")
        pdf = pikepdf.new()
        page = pdf.add_blank_page(page_size=(300, 300))
        winansi, _ = _type1("Helvetica", encoding="WinAnsiEncoding")
        macroman, _ = _type1("Helvetica", encoding="MacRomanEncoding")
        page.obj[Name.Resources] = Dictionary(
            Font=Dictionary(F1=pdf.make_indirect(winansi), F2=pdf.make_indirect(macroman))
        )
        pdf.save(path)
        pdf.close()
        result = list_document_fonts(path, font_dir)
        assert result["count"] == 2
        assert {f["encoding"] for f in result["fonts"]} == {"WinAnsiEncoding", "MacRomanEncoding"}

    def test_entries_are_sorted_by_display_name(self, every_type, font_dir):
        names = [f["name"].lower() for f in list_document_fonts(every_type, font_dir)["fonts"]]
        assert names == sorted(names)

    def test_a_document_with_no_fonts_lists_none(self, tmp_path, font_dir):
        path = str(tmp_path / "empty.pdf")
        pdf = pikepdf.new()
        pdf.add_blank_page(page_size=(300, 300))
        pdf.save(path)
        pdf.close()
        assert list_document_fonts(path, font_dir) == {"file": path, "fonts": [], "count": 0}


class TestType3Policy:
    """A Type 3 font's glyph programs are content streams under `/CharProcs`
    (ISO 32000-2, 9.6.4), so it is embedded by construction — and without that
    required dictionary the question has no answer at all.

    The tab and the structural checker read one function, so a Type 3 cannot
    be embedded in one report and not embedded in the other.
    """

    def _document(self, tmp_path, char_procs) -> str:
        path = str(tmp_path / f"type3-{'drawn' if char_procs else 'empty'}.pdf")
        pdf = pikepdf.new()
        page = pdf.add_blank_page(page_size=(300, 300))
        font = _type3(pdf)
        if char_procs is None:
            del font[Name.CharProcs]
        page.obj[Name.Resources] = Dictionary(Font=Dictionary(T3=pdf.make_indirect(font)))
        pdf.save(path)
        pdf.close()
        return path

    def test_glyph_procedures_present_reads_as_embedded(self, tmp_path, font_dir):
        result = list_document_fonts(self._document(tmp_path, True), font_dir)
        assert result["fonts"][0]["embedded"] is True
        assert result["fonts"][0]["substitute"] is None

    def test_no_glyph_procedures_reads_as_unknown_and_offers_no_substitute(
        self, tmp_path, font_dir
    ):
        """A substitution is only knowable once the program is known to be
        missing, and no installed face draws a Type 3's glyphs in any case."""
        result = list_document_fonts(self._document(tmp_path, None), font_dir)
        assert result["fonts"][0]["embedded"] is None
        assert result["fonts"][0]["substitute"] is None

    def test_the_tab_and_the_checker_give_one_answer(self, tmp_path, font_dir):
        from engine.check import check

        path = self._document(tmp_path, None)
        assert list_document_fonts(path, font_dir)["fonts"][0]["embedded"] is None
        info = check(file=path)["info"]
        assert info["fonts_embedded"] == 0
        assert info["fonts_not_embedded"] == 0
        assert info["fonts_unreadable"] == 1


class TestEncodingNames:
    def test_a_differences_dictionary_reads_as_custom(self, tmp_path, font_dir):
        path = str(tmp_path / "diffs.pdf")
        pdf = pikepdf.new()
        page = pdf.add_blank_page(page_size=(300, 300))
        font, _ = _type1("Helvetica", encoding=None)
        font[Name.Encoding] = Dictionary(
            Type=Name.Encoding,
            BaseEncoding=Name.WinAnsiEncoding,
            Differences=Array([65, Name("/bullet")]),
        )
        page.obj[Name.Resources] = Dictionary(Font=Dictionary(F1=pdf.make_indirect(font)))
        pdf.save(path)
        pdf.close()
        assert _by_name(list_document_fonts(path, font_dir), "Helvetica")["encoding"] == "Custom"

    def test_no_encoding_key_reads_as_built_in(self, tmp_path, font_dir):
        path = str(tmp_path / "builtin.pdf")
        pdf = pikepdf.new()
        page = pdf.add_blank_page(page_size=(300, 300))
        font, _ = _type1("Symbol", encoding=None, flags=4)
        page.obj[Name.Resources] = Dictionary(Font=Dictionary(F1=pdf.make_indirect(font)))
        pdf.save(path)
        pdf.close()
        assert _by_name(list_document_fonts(path, font_dir), "Symbol")["encoding"] == "Built-in"
