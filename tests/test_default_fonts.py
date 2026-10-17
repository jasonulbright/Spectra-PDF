"""The font a default appearance string names (engine/default_fonts.py).

ISO 32000-2 12.7.4.3: the font a /DA selects is a resource name in /Font of
the interactive form's /DR. 12.5.6.6 (Table 177) reads a free text /DA that
way and 12.5.6.23 (Table 195) the /DA of a redaction with overlay text. One
name is one font: the engine's own /DA, and a /DA carried into another
document, keep their font under a new name when the name is taken.
"""

import json
import os

import pikepdf
import pytest

from engine.default_fonts import (
    appearance_fonts,
    bind_carried_fonts,
    default_fonts,
    hold_standard_font,
    interchangeable_key,
    rewrite_fonts,
)
from engine.merge import merge
from engine.redact_marks import list_redact_annotations, save_redaction_marks
from engine.split import split

N = pikepdf.Name


def _font(pdf, base="/Helvetica", encoding="/WinAnsiEncoding", embedded=False):
    font = pikepdf.Dictionary(Type=N("/Font"), Subtype=N("/Type1"), BaseFont=N(base))
    if encoding:
        font["/Encoding"] = N(encoding)
    if embedded:
        font["/FontDescriptor"] = pdf.make_indirect(pikepdf.Dictionary(Type=N("/FontDescriptor"), FontName=N(base)))
    return pdf.make_indirect(font)


def _document(path, fonts=None, annotations=(), field=None, pages=1):
    """`fonts`: name -> keyword arguments of `_font`. `annotations`: one
    (subtype, /DA, overlay) per annotation of each page. `field`: the font
    name the /DA of one text field selects."""
    pdf = pikepdf.new()
    table = pikepdf.Dictionary()
    for name, kw in (fonts or {}).items():
        table["/" + name] = _font(pdf, **kw)
    roots = []
    for index in range(pages):
        page = pdf.add_blank_page(page_size=(300, 300))
        entries = []
        for slot, (subtype, da, overlay) in enumerate(annotations):
            annot = pikepdf.Dictionary(
                Type=N("/Annot"), Subtype=N(subtype), F=4,
                Rect=pikepdf.Array([20, 40 * slot + 20, 140, 40 * slot + 50]),
                DA=pikepdf.String(da),
            )
            if overlay:
                annot["/OverlayText"] = pikepdf.String("REDACTED")
            entries.append(pdf.make_indirect(annot))
        if field and index == 0:
            widget = pdf.make_indirect(pikepdf.Dictionary(
                Type=N("/Annot"), Subtype=N("/Widget"), FT=N("/Tx"), T=pikepdf.String("name"),
                Rect=pikepdf.Array([20, 200, 200, 220]), F=4, DA=pikepdf.String(f"/{field} 10 Tf 0 g"),
            ))
            entries.append(widget)
            roots.append(widget)
        page.obj["/Annots"] = pikepdf.Array(entries)
    if fonts is not None:
        pdf.Root["/AcroForm"] = pdf.make_indirect(pikepdf.Dictionary(
            Fields=pikepdf.Array(roots), DR=pikepdf.Dictionary(Font=table),
        ))
    pdf.save(path)
    pdf.close()
    return path


def _reading(path):
    """(name -> base font, per page the /DA of each annotation that has one)."""
    with pikepdf.open(path) as pdf:
        fonts = default_fonts(pdf)
        table = {str(k)[1:]: str(v["/BaseFont"])[1:] for k, v in fonts.items()} if fonts is not None else {}
        appearances = [
            [bytes(a["/DA"]).decode("latin-1") for a in page.obj.get("/Annots", []) if a.get("/DA") is not None]
            for page in pdf.pages
        ]
        fields = len(pdf.Root["/AcroForm"].get("/Fields", [])) if "/AcroForm" in pdf.Root else None
    return table, appearances, fields


FREE_TEXT = ("/FreeText", "0 g /Helv 10 Tf", False)
REDACTION = ("/Redact", "/Helv 12 Tf 1 1 1 rg", True)
TIMES = {"base": "/Times-Roman", "encoding": None}
COURIER = {"base": "/Courier", "encoding": None}
STANDARD = {}


class TestTheRule:
    def test_interchangeable_fonts_are_simple_fonts_with_no_program_that_agree(self):
        pdf = pikepdf.new()
        key = interchangeable_key(_font(pdf))
        assert key == "/Type1 /Helvetica /WinAnsiEncoding"
        assert interchangeable_key(_font(pdf)) == key
        assert interchangeable_key(_font(pdf, encoding=None)) == "/Type1 /Helvetica "
        assert interchangeable_key(_font(pdf, encoding="/MacRomanEncoding")) != key
        assert interchangeable_key(_font(pdf, embedded=True)) is None
        differences = _font(pdf)
        differences["/Encoding"] = pikepdf.Dictionary(Differences=pikepdf.Array([65, N("/B")]))
        assert interchangeable_key(differences) is None
        composite = _font(pdf)
        composite["/Subtype"] = N("/Type0")
        assert interchangeable_key(composite) is None
        assert interchangeable_key(pikepdf.Array()) is None

    def test_reads_each_font_a_default_appearance_selects(self):
        assert appearance_fonts("0.1 0.2 0.3 rg /Helv 12 Tf") == ["Helv"]
        assert appearance_fonts("/F1 .5 Tf /F2 -3 Tf") == ["F1", "F2"]
        assert appearance_fonts("0 g") == []
        assert appearance_fonts("/Helv 12 TfX") == []

    def test_rewrites_every_renamed_name_in_one_pass(self):
        assert rewrite_fonts(
            "/Helv 10 Tf /Helv_1 8 Tf /HelvB 9 Tf", {"Helv": "Helv_1", "Helv_1": "Helv_1_1"},
        ) == "/Helv_1 10 Tf /Helv_1_1 8 Tf /HelvB 9 Tf"
        assert rewrite_fonts("/Helv 10 Tf", {"Helv": "Helv"}) == "/Helv 10 Tf"

    @pytest.mark.parametrize("direct", [False, True])
    def test_the_standard_face_takes_helv_or_the_first_name_that_can_hold_it(self, direct):
        pdf = pikepdf.new()
        assert hold_standard_font(pdf) == "Helv"
        assert len(pdf.Root["/AcroForm"]["/Fields"]) == 0
        assert hold_standard_font(pdf) == "Helv"
        other = pikepdf.new()
        form = pikepdf.Dictionary(Fields=pikepdf.Array(), DR=pikepdf.Dictionary(Font=pikepdf.Dictionary(
            Helv=_font(other, **TIMES), Helv_1=_font(other, **COURIER),
        )))
        other.Root["/AcroForm"] = form if direct else other.make_indirect(form)
        assert hold_standard_font(other) == "Helv_2"
        assert hold_standard_font(other) == "Helv_2"
        assert other.Root["/AcroForm"].is_indirect is not direct
        assert sorted(str(k) for k in other.Root["/AcroForm"]["/DR"]["/Font"].keys()) == ["/Helv", "/Helv_1", "/Helv_2"]


class TestRedactionMarks:
    REGION = {"page": 1, "rect": [20, 20, 200, 60], "overlay_text": "REDACTED", "font_size": 12}

    def test_a_mark_with_overlay_text_names_a_font_the_default_resources_hold(self, tmp_path):
        src, out = _document(str(tmp_path / "bare.pdf")), str(tmp_path / "out.pdf")
        save_redaction_marks(src, out, [self.REGION, {"page": 1, "rect": [20, 100, 200, 140]}])
        table, appearances, fields = _reading(out)
        assert table == {"Helv": "Helvetica"}
        assert fields == 0
        assert len(appearances[0]) == 1 and appearances[0][0].startswith("/Helv 12 Tf ")
        # The size and colour still read back from the string.
        marks = list_redact_annotations(out)["marks"]
        assert [m.get("font_size") for m in marks if m.get("overlay_text")] == [12]

    def test_a_mark_without_overlay_text_adds_no_form(self, tmp_path):
        src, out = _document(str(tmp_path / "bare.pdf")), str(tmp_path / "out.pdf")
        save_redaction_marks(src, out, [{"page": 1, "rect": [20, 100, 200, 140]}])
        with pikepdf.open(out) as pdf:
            assert "/AcroForm" not in pdf.Root

    def test_a_mark_takes_a_name_of_its_own_when_helv_is_another_font(self, tmp_path):
        src = _document(str(tmp_path / "form.pdf"), fonts={"Helv": TIMES}, field="Helv")
        out, again = str(tmp_path / "out.pdf"), str(tmp_path / "again.pdf")
        save_redaction_marks(src, out, [self.REGION])
        table, appearances, fields = _reading(out)
        assert table == {"Helv": "Times-Roman", "Helv_1": "Helvetica"}
        assert fields == 1
        # The field still names its own font; the mark follows it in /Annots.
        assert appearances[0][0] == "/Helv 10 Tf 0 g"
        assert appearances[0][1].startswith("/Helv_1 12 Tf ")
        # Saving the set again replaces the marks and reuses the name.
        save_redaction_marks(out, again, [self.REGION, dict(self.REGION, rect=[20, 100, 200, 140])])
        table, appearances, _ = _reading(again)
        assert table == {"Helv": "Times-Roman", "Helv_1": "Helvetica"}
        assert [a.split(" ")[0] for a in appearances[0]] == ["/Helv", "/Helv_1", "/Helv_1"]


class TestCarriedAnnotations:
    def test_binds_a_carried_font_under_its_name_or_a_new_one(self):
        src, dst = pikepdf.new(), pikepdf.new()
        src.Root["/AcroForm"] = src.make_indirect(pikepdf.Dictionary(
            Fields=pikepdf.Array(),
            DR=pikepdf.Dictionary(Font=pikepdf.Dictionary(Helv=_font(src, **COURIER), F2=_font(src, base="/Symbol", embedded=True))),
        ))
        dst.Root["/AcroForm"] = dst.make_indirect(pikepdf.Dictionary(
            Fields=pikepdf.Array(), DR=pikepdf.Dictionary(Font=pikepdf.Dictionary(Helv=_font(dst, **TIMES))),
        ))
        annots = [
            dst.make_indirect(pikepdf.Dictionary(Subtype=N("/FreeText"), DA=pikepdf.String("/Helv 9 Tf /F2 8 Tf"))),
            dst.make_indirect(pikepdf.Dictionary(Subtype=N("/Redact"), DA=pikepdf.String("/Helv 9 Tf"))),
            dst.make_indirect(pikepdf.Dictionary(Subtype=N("/Square"), DA=pikepdf.String("/Helv 9 Tf"))),
            dst.make_indirect(pikepdf.Dictionary(Subtype=N("/FreeText"), DA=pikepdf.String("/Missing 9 Tf"))),
        ]
        assert bind_carried_fonts(dst, src, annots) == 1
        fonts = dst.Root["/AcroForm"]["/DR"]["/Font"]
        assert {str(k): str(v["/BaseFont"]) for k, v in fonts.items()} == {
            "/Helv": "/Times-Roman", "/Helv_1": "/Courier", "/F2": "/Symbol",
        }
        # A redaction with no overlay text, another subtype and a name the
        # source did not hold stay as written.
        assert [bytes(a["/DA"]) for a in annots] == [b"/Helv_1 9 Tf /F2 8 Tf", b"/Helv 9 Tf", b"/Helv 9 Tf", b"/Missing 9 Tf"]
        # A second call finds each font under the name it has.
        assert bind_carried_fonts(dst, src, [dst.make_indirect(pikepdf.Dictionary(
            Subtype=N("/FreeText"), DA=pikepdf.String("/Helv 9 Tf /F2 8 Tf")))]) == 1
        assert len(fonts.keys()) == 3

    @pytest.mark.parametrize("first_field,second_field", [(None, None), ("Helv", "Helv"), ("Helv", None), (None, "Helv")])
    def test_a_merge_gives_the_second_document_its_font_under_a_new_name(self, tmp_path, first_field, second_field):
        first = _document(str(tmp_path / "first.pdf"), fonts={"Helv": TIMES}, annotations=[FREE_TEXT], field=first_field)
        second = _document(str(tmp_path / "second.pdf"), fonts={"Helv": COURIER}, annotations=[FREE_TEXT, REDACTION], field=second_field)
        out = str(tmp_path / "merged.pdf")
        merge([first, second], out)
        table, appearances, _ = _reading(out)
        assert sorted(table.values()) == ["Courier", "Times-Roman"]
        assert sorted(table) == ["Helv", "Helv_1"]
        name = {base: key for key, base in table.items()}
        assert appearances[0] == [f"0 g /{name['Times-Roman']} 10 Tf"] + ([f"/{name['Times-Roman']} 10 Tf 0 g"] if first_field else [])
        assert appearances[1] == [f"0 g /{name['Courier']} 10 Tf", f"/{name['Courier']} 12 Tf 1 1 1 rg"] + (
            [f"/{name['Courier']} 10 Tf 0 g"] if second_field else [])

    def test_a_merge_shares_the_name_of_interchangeable_fonts(self, tmp_path):
        first = _document(str(tmp_path / "first.pdf"), fonts={"Helv": STANDARD}, annotations=[FREE_TEXT])
        second = _document(str(tmp_path / "second.pdf"), fonts={"Helv": STANDARD}, annotations=[FREE_TEXT])
        out = str(tmp_path / "merged.pdf")
        merge([first, second], out)
        assert _reading(out)[:2] == ({"Helv": "Helvetica"}, [["0 g /Helv 10 Tf"], ["0 g /Helv 10 Tf"]])

    def test_a_merge_of_one_document_with_itself_keeps_one_embedded_font_under_one_name(self, tmp_path):
        doc = _document(str(tmp_path / "doc.pdf"), fonts={"Helv": {"base": "/ABCDEF+Sans", "embedded": True}}, annotations=[FREE_TEXT])
        other = _document(str(tmp_path / "other.pdf"), fonts={"Helv": {"base": "/ABCDEF+Sans", "embedded": True}}, annotations=[FREE_TEXT])
        out = str(tmp_path / "merged.pdf")
        merge([doc, other], out)
        table, appearances, _ = _reading(out)
        # Two files, two font programs: the second keeps its own.
        assert table == {"Helv": "ABCDEF+Sans", "Helv_1": "ABCDEF+Sans"}
        assert appearances == [["0 g /Helv 10 Tf"], ["0 g /Helv_1 10 Tf"]]

    def test_a_split_keeps_the_entry_with_no_field_in_the_form(self, tmp_path):
        src = _document(str(tmp_path / "src.pdf"), fonts={"Helv": COURIER}, annotations=[FREE_TEXT], pages=2)
        out_dir = str(tmp_path / "parts")
        os.makedirs(out_dir)
        result = split(src, output_dir=out_dir, mode="every_n", every_n=1)
        assert len(result["outputs"]) == 2
        for path in result["outputs"]:
            assert _reading(path)[:2] == ({"Helv": "Courier"}, [["0 g /Helv 10 Tf"]])


class TestFormRemoval:
    """An operation that removes the form keeps the font an annotation's /DA
    names: the annotation is no part of the form."""

    def _with_field(self, tmp_path, pages=1):
        return _document(str(tmp_path / "form.pdf"), fonts={"Helv": COURIER, "Other": TIMES},
                         annotations=[FREE_TEXT, REDACTION], field="Other", pages=pages)

    def _assert_holder(self, path, pages=1):
        table, appearances, fields = _reading(path)
        assert table == {"Helv": "Courier"}
        assert fields == 0
        assert appearances == [["0 g /Helv 10 Tf", "/Helv 12 Tf 1 1 1 rg"]] * pages

    def test_removing_the_form_fields(self, tmp_path):
        from engine.sanitize import _remove_form_fields

        for mode in ("remove", "flatten"):
            out = str(tmp_path / f"{mode}.pdf")
            with pikepdf.open(self._with_field(tmp_path)) as pdf:
                assert _remove_form_fields(pdf, mode) == 1
                pdf.save(out)
            self._assert_holder(out)

    def test_a_split_that_leaves_the_field_behind(self, tmp_path):
        out_dir = str(tmp_path / "parts")
        os.makedirs(out_dir)
        result = split(self._with_field(tmp_path, pages=2), output_dir=out_dir, mode="every_n", every_n=1)
        first, second = result["outputs"]
        table, appearances, fields = _reading(first)
        assert (table, fields) == ({"Helv": "Courier", "Other": "Times-Roman"}, 1)
        self._assert_holder(second)

    def test_a_form_with_no_annotation_font_leaves_nothing(self, tmp_path):
        from engine.sanitize import _remove_form_fields

        src = _document(str(tmp_path / "only-form.pdf"), fonts={"Helv": COURIER}, field="Helv")
        with pikepdf.open(src) as pdf:
            _remove_form_fields(pdf, "remove")
            assert "/AcroForm" not in pdf.Root


class TestNoFormStatus:
    """A form dictionary with an empty /Fields that only holds the font of a
    text box gives the document no form status in any reader."""

    @staticmethod
    def _text_box(path, holder):
        """A text box as a commit writes it: its appearance draws with the
        standard face, and `holder` adds the form dictionary that holds that
        face for the /DA."""
        pdf = pikepdf.new()
        page = pdf.add_blank_page(page_size=(300, 300))
        font = _font(pdf)
        ap = pdf.make_stream(b"BT /Helv 12 Tf 2 4 Td (Note) Tj ET")
        ap.stream_dict["/Type"] = N("/XObject")
        ap.stream_dict["/Subtype"] = N("/Form")
        ap.stream_dict["/BBox"] = pikepdf.Array([0, 0, 120, 20])
        ap.stream_dict["/Resources"] = pikepdf.Dictionary(Font=pikepdf.Dictionary(Helv=font))
        page.obj["/Annots"] = pikepdf.Array([pdf.make_indirect(pikepdf.Dictionary(
            Type=N("/Annot"), Subtype=N("/FreeText"), Rect=pikepdf.Array([20, 100, 140, 120]), F=4,
            DA=pikepdf.String("0 0 0 rg /Helv 12 Tf"), Contents=pikepdf.String("Note"),
            AP=pikepdf.Dictionary(N=ap),
        ))])
        if holder:
            pdf.Root["/AcroForm"] = pdf.make_indirect(pikepdf.Dictionary(
                Fields=pikepdf.Array(), DR=pikepdf.Dictionary(Font=pikepdf.Dictionary(Helv=font)),
            ))
        pdf.save(path)
        pdf.close()
        return path

    @pytest.fixture()
    def pair(self, tmp_path):
        return self._text_box(str(tmp_path / "plain.pdf"), False), self._text_box(str(tmp_path / "held.pdf"), True)

    def test_no_reader_reports_a_form(self, pair):
        from engine import accessibility, acroform, forms, incremental, preflight, sanitize, space_audit, standards_report, xfa
        from engine.default_fonts import is_font_holder
        from engine.document_health import document_health

        def opened(reader):
            def run(path):
                with pikepdf.open(path) as pdf:
                    return reader(pdf)
            return run

        def without_size(result):
            return {k: v for k, v in result.items() if k not in ("size_bytes", "file")}

        readers = {
            "form fields": lambda path: {k: v for k, v in forms.read_form_fields(path).items() if k != "file"},
            "XFA kind": opened(xfa.classify),
            "has XFA": opened(acroform.has_xfa),
            "has form fields": opened(acroform.has_form_fields),
            "live signatures": incremental.has_live_signatures,
            "signature policy": incremental.signature_policy,
            "hidden information": lambda path: without_size(sanitize.audit_hidden_information(path)),
            "preflight": lambda path: without_size(preflight.preflight(path)),
            "accessibility": lambda path: without_size(accessibility.check_accessibility(path)),
            "document health": lambda path: without_size(document_health(path)),
            "form space": lambda path: next(
                (c["bytes"], c["objects"]) for c in space_audit.audit_space_usage(path)["categories"] if c["id"] == "forms"),
        }
        plain, held = pair
        for name, reader in readers.items():
            assert reader(held) == reader(plain), name
        assert readers["form space"](held) == (0, 0)
        assert readers["has form fields"](held) is False
        with pikepdf.open(held) as pdf:
            assert standards_report._field_count(pdf) == 0
            assert is_font_holder(pdf.Root["/AcroForm"])

    def test_a_form_with_a_field_or_xfa_is_a_form(self, tmp_path):
        from engine.default_fonts import is_font_holder
        from engine import space_audit

        form = _document(str(tmp_path / "form.pdf"), fonts={"Helv": STANDARD}, field="Helv")
        with pikepdf.open(form) as pdf:
            assert not is_font_holder(pdf.Root["/AcroForm"])
            pdf.Root["/AcroForm"]["/Fields"] = pikepdf.Array()
            assert is_font_holder(pdf.Root["/AcroForm"])
            pdf.Root["/AcroForm"]["/XFA"] = pdf.make_stream(b"<xdp/>")
            assert not is_font_holder(pdf.Root["/AcroForm"])
        forms_bytes = next(c["bytes"] for c in space_audit.audit_space_usage(form)["categories"] if c["id"] == "forms")
        assert forms_bytes > 0

    @pytest.mark.usefixtures("srgb_profile")
    def test_a_pdfa_conversion_reports_the_same_losses(self, pair, gs_path, tmp_path):
        from engine.pdfa import convert_pdfa

        altered = []
        for index, path in enumerate(pair):
            result = convert_pdfa(file=path, output=str(tmp_path / f"archive-{index}.pdf"), level="2b", gs_path=gs_path)
            altered.append(result["altered"])
        assert altered[1] == altered[0]
        assert "form_fields_removed" not in json.dumps(altered[1])


class TestCreatedFields:
    """A field the engine creates selects the standard face by the same rule:
    a name of /DR that another font holds is not reused."""

    FIELDS = [
        {"name": "text", "type": "text", "page_index": 0, "rect": [20, 100, 200, 120]},
        {"name": "check", "type": "checkbox", "page_index": 0, "rect": [20, 130, 40, 150]},
        {"name": "pick", "type": "dropdown", "page_index": 0, "rect": [20, 160, 200, 180],
         "options": [{"label": "a"}, {"label": "b"}]},
        {"name": "radio", "type": "radio", "page_index": 0, "rect": [20, 190, 200, 210],
         "options": [{"label": "a"}, {"label": "b"}]},
    ]

    @staticmethod
    def _created(path):
        """Field name -> (/DA, per normal appearance stream: font name -> base font)."""
        out = {}
        with pikepdf.open(path) as pdf:
            for field in pdf.Root["/AcroForm"]["/Fields"]:
                name = str(field["/T"])
                widgets = list(field["/Kids"]) if "/Kids" in field else [field]
                drawn = {}
                for widget in widgets:
                    normal = widget.get("/AP", {}).get("/N")
                    streams = [normal] if isinstance(normal, pikepdf.Stream) else list((normal or {}).values())
                    for stream in streams:
                        for key, font in stream.get("/Resources", {}).get("/Font", {}).items():
                            drawn[str(key)[1:]] = str(font["/BaseFont"])[1:]
                            assert f"{key} ".encode() in stream.read_bytes() or str(field.get("/FT")) != "/Btn"
                out[name] = (bytes(field["/DA"]).decode("latin-1") if "/DA" in field else None, drawn)
        return out

    def test_a_field_takes_names_of_its_own_when_helv_and_zadb_are_other_fonts(self, tmp_path):
        from engine.form_authoring import add_form_fields

        # The form holds only fonts a carried annotation /DA names.
        src = _document(
            str(tmp_path / "held.pdf"),
            fonts={"Helv": TIMES, "ZaDb": COURIER},
            annotations=[("/FreeText", "0 g /Helv 10 Tf", False), ("/FreeText", "0 g /ZaDb 10 Tf", False)],
        )
        out, again = str(tmp_path / "out.pdf"), str(tmp_path / "again.pdf")
        add_form_fields(src, out, self.FIELDS)
        table, appearances, _ = _reading(out)
        assert table == {"Helv": "Times-Roman", "ZaDb": "Courier", "Helv_1": "Helvetica", "ZaDb_1": "ZapfDingbats"}
        # The carried annotations keep their /DA.
        assert appearances[0][:2] == ["0 g /Helv 10 Tf", "0 g /ZaDb 10 Tf"]
        created = self._created(out)
        assert created["text"] == ("/Helv_1 0 Tf 0 g", {"Helv_1": "Helvetica"})
        assert created["pick"] == ("/Helv_1 0 Tf 0 g", {"Helv_1": "Helvetica"})
        assert created["check"] == ("/ZaDb_1 0 Tf 0 g", {"ZaDb_1": "ZapfDingbats"})
        assert created["radio"] == ("/ZaDb_1 0 Tf 0 g", {"ZaDb_1": "ZapfDingbats"})
        # A second batch reuses the names.
        add_form_fields(out, again, [dict(self.FIELDS[0], name="more"), dict(self.FIELDS[1], name="tick")])
        table, _, _ = _reading(again)
        assert sorted(table) == ["Helv", "Helv_1", "ZaDb", "ZaDb_1"]
        created = self._created(again)
        assert created["more"][0] == "/Helv_1 0 Tf 0 g"
        assert created["tick"][0] == "/ZaDb_1 0 Tf 0 g"

    def test_a_field_reuses_helv_and_zadb_that_hold_the_standard_faces(self, tmp_path):
        from engine.form_authoring import add_form_fields

        src = _document(
            str(tmp_path / "held.pdf"),
            fonts={"Helv": STANDARD, "ZaDb": {"base": "/ZapfDingbats", "encoding": None}},
            annotations=[FREE_TEXT],
        )
        out = str(tmp_path / "out.pdf")
        add_form_fields(src, out, self.FIELDS)
        table, _, _ = _reading(out)
        assert table == {"Helv": "Helvetica", "ZaDb": "ZapfDingbats"}
        created = self._created(out)
        assert created["text"][0] == "/Helv 0 Tf 0 g"
        assert created["check"][0] == "/ZaDb 0 Tf 0 g"

    def test_an_embedded_font_under_helv_is_not_the_standard_face(self, tmp_path):
        from engine.form_authoring import add_form_fields

        src = _document(
            str(tmp_path / "held.pdf"),
            fonts={"Helv": {"embedded": True}},
            annotations=[FREE_TEXT],
        )
        out = str(tmp_path / "out.pdf")
        add_form_fields(src, out, [self.FIELDS[0]])
        assert self._created(out)["text"] == ("/Helv_1 0 Tf 0 g", {"Helv_1": "Helvetica"})
