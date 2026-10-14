"""One /DR /Font name is one font across every source of a page copy.

ISO 32000-2 12.7.4.3: the font a field /DA selects is a resource name in
/Font of the interactive form's /DR; 12.5.6.6 and 12.5.6.23 read a free text
/DA and a redaction overlay /DA the same way. A merge, a split and a
cross-document page copy keep every /DA on the font its own document held,
whatever the number of sources and their order.
"""

import itertools
import os

import pikepdf
import pytest
from pikepdf import Array, Dictionary, Name, String

from engine.default_fonts import appearance_fonts, default_fonts
from engine.merge import merge
from engine.page_copy import copy_pages_with_forms
from engine.split import split


def _font(pdf, face, embedded=False, direct=False):
    font = Dictionary(Type=Name.Font, Subtype=Name.Type1, BaseFont=Name("/" + face))
    if embedded:
        font["/FontDescriptor"] = pdf.make_indirect(
            Dictionary(Type=Name.FontDescriptor, FontName=Name("/" + face), Flags=32))
    return font if direct else pdf.make_indirect(font)


def _appearance(pdf, font=None):
    stream = pdf.make_stream(b"BT /F1 12 Tf 2 4 Td (x) Tj ET")
    stream.stream_dict.update(Dictionary(Type=Name.XObject, Subtype=Name.Form, BBox=Array([0, 0, 100, 20])))
    if font is not None:
        stream["/Resources"] = Dictionary(Font=Dictionary(F1=font))
    return stream


def _source(path, tag, face, *, field=None, free_text=False, redaction=False, embedded=False,
            direct=False, default_da=None, pure=None, pages=1, extra_fonts=None, name="F1"):
    """One document whose every /DA selects ``name`` = ``face``.

    ``field``: 'own' (/DA on the widget field), 'inherited' (/DA only as the
    form default), 'parent' (/DA on a parent, a widget kid per page), 'kid'
    (/DA on the kid, none on the parent), 'bare' (an appearance stream with
    no resources). ``pure``: 'own' or 'inherited', a field with no widget.
    Each holder is labelled ``<kind>-<tag>`` in /T or /Contents."""
    pdf = pikepdf.new()
    font = _font(pdf, face, embedded, direct)
    da = String(f"/{name} 10 Tf 0 g")
    fields = Array()
    parent = None
    if field in ("parent", "kid"):
        parent = pdf.make_indirect(Dictionary(FT=Name.Tx, T=String(f"field-{tag}"), Kids=Array()))
        if field == "parent":
            parent["/DA"] = da
        fields.append(parent)
    for index in range(pages):
        page = pdf.add_blank_page(page_size=(612, 792))
        entries = []
        if free_text:
            entries.append(pdf.make_indirect(Dictionary(
                Type=Name.Annot, Subtype=Name.FreeText, Rect=Array([100, 600, 200, 620]), F=4, DA=da,
                Contents=String(f"text-{tag}"), AP=Dictionary(N=_appearance(pdf, font)))))
        if redaction:
            entries.append(pdf.make_indirect(Dictionary(
                Type=Name.Annot, Subtype=Name.Redact, Rect=Array([100, 400, 200, 420]), F=4, DA=da,
                Contents=String(f"mark-{tag}"), OverlayText=String("X"))))
        if field is not None:
            widget = Dictionary(Type=Name.Annot, Subtype=Name.Widget, Rect=Array([100, 500, 300, 520]), F=4, P=page.obj,
                                AP=Dictionary(N=_appearance(pdf, None if field == "bare" else font)))
            if parent is not None:
                widget["/Parent"] = parent
                if field == "kid":
                    widget["/DA"] = da
                widget = pdf.make_indirect(widget)
                parent.Kids.append(widget)
            else:
                widget["/FT"] = Name.Tx
                widget["/T"] = String(f"field-{tag}" if pages == 1 else f"field-{tag}-{index}")
                if field in ("own", "bare"):
                    widget["/DA"] = da
                widget = pdf.make_indirect(widget)
                fields.append(widget)
            entries.append(widget)
        page.obj["/Annots"] = Array(entries)
    if pure is not None:
        data = Dictionary(FT=Name.Tx, T=String(f"pure-{tag}"), V=String("kept"))
        if pure == "own":
            data["/DA"] = da
        fields.append(pdf.make_indirect(data))
    table = Dictionary()
    table["/" + name] = font
    for other, other_face in (extra_fonts or {}).items():
        table["/" + other] = _font(pdf, other_face)
    form = Dictionary(Fields=fields, DR=Dictionary(Font=table))
    if default_da or field == "inherited" or pure == "inherited":
        form["/DA"] = String(default_da) if default_da else da
    pdf.Root["/AcroForm"] = pdf.make_indirect(form)
    pdf.save(path)
    return path


def _holders(pdf):
    """(label, /DA holder) for each field node and each free text or
    redaction annotation. A holder with no /DA takes its parent's."""
    seen = set()

    def walk(node, label, inherited):
        if node.objgen in seen:
            return
        seen.add(node.objgen)
        label = str(node.get("/T")) if node.get("/T") is not None else label
        da = node.get("/DA", inherited)
        kids = node.get("/Kids")
        if isinstance(kids, Array):
            for kid in kids:
                yield from walk(kid, label, da)
        else:
            yield label, da

    form = pdf.Root.get("/AcroForm")
    if form is not None:
        for root in form.get("/Fields", []):
            yield from walk(root, None, form.get("/DA"))
    for page in pdf.pages:
        for annot in page.obj.get("/Annots", []):
            if annot.get("/Subtype") in (Name.FreeText, Name.Redact):
                yield str(annot.get("/Contents")), annot.get("/DA")


def _faces(pdf):
    """label -> the base font its /DA selects through /DR, or a reason."""
    fonts = default_fonts(pdf)
    out = {}
    for label, da in _holders(pdf):
        if da is None:
            out.setdefault(label, set()).add("no /DA")
            continue
        names = appearance_fonts(bytes(da).decode("latin-1"))
        held = fonts.get("/" + names[0]) if fonts is not None and names else None
        out.setdefault(label, set()).add(str(held.BaseFont)[1:] if held is not None else f"missing {names}")
    return {label: sorted(found) for label, found in out.items()}


def _table(pdf):
    fonts = default_fonts(pdf)
    return {} if fonts is None else {str(k)[1:]: str(v.BaseFont)[1:] for k, v in fonts.items()}


def _expect(pdf, faces):
    """Each holder ``<kind>-<tag>`` selects the face of its tag."""
    found = _faces(pdf)
    assert found, "no /DA holder"
    for label, got in found.items():
        tag = label.split("-")[1]
        assert got == [faces[tag]], f"{label}: {got}, table {_table(pdf)}"
    return found


class TestFieldMerge:
    def test_three_fields_take_three_names(self, tmp_path):
        faces = {"x": "Helvetica", "y": "Times-Roman", "z": "Courier"}
        paths = [_source(str(tmp_path / f"{t}.pdf"), t, f, field="own") for t, f in faces.items()]
        out = str(tmp_path / "out.pdf")
        merge(paths, out)
        with pikepdf.open(out) as pdf:
            _expect(pdf, faces)
            assert _table(pdf) == {"F1": "Helvetica", "F1_1": "Times-Roman", "F1_2": "Courier"}

    def test_a_field_font_never_replaces_an_annotation_font(self, tmp_path):
        faces = {"a": "Helvetica", "c": "Courier", "b": "Times-Roman"}
        a = _source(str(tmp_path / "a.pdf"), "a", faces["a"], free_text=True)
        c = _source(str(tmp_path / "c.pdf"), "c", faces["c"], free_text=True, embedded=True)
        b = _source(str(tmp_path / "b.pdf"), "b", faces["b"], free_text=True, field="own")
        out = str(tmp_path / "out.pdf")
        merge([a, c, b], out)
        with pikepdf.open(out) as pdf:
            _expect(pdf, faces)
            assert _table(pdf) == {"F1": "Helvetica", "F1_1": "Courier", "F1_2": "Times-Roman"}

    @pytest.mark.parametrize("order", ["".join(p) for p in itertools.permutations("abcd")])
    def test_every_order_of_four_documents(self, tmp_path, order):
        faces = {"a": "Helvetica", "b": "Times-Roman", "c": "Courier", "d": "Symbol"}
        paths = {
            "a": _source(str(tmp_path / "a.pdf"), "a", faces["a"], free_text=True),
            "b": _source(str(tmp_path / "b.pdf"), "b", faces["b"], free_text=True, field="own", pure="own"),
            "c": _source(str(tmp_path / "c.pdf"), "c", faces["c"], free_text=True, redaction=True, embedded=True),
            "d": _source(str(tmp_path / "d.pdf"), "d", faces["d"], field="inherited", pure="inherited",
                         embedded=True),
        }
        out = str(tmp_path / "out.pdf")
        merge([paths[t] for t in order], out)
        with pikepdf.open(out) as pdf:
            found = _expect(pdf, faces)
            assert sorted(found) == [
                "field-b", "field-d", "mark-c", "pure-b", "pure-d", "text-a", "text-b", "text-c"]
            table = _table(pdf)
            assert sorted(table.values()) == sorted(faces.values())
            assert sorted(table) == ["F1", "F1_1", "F1_2", "F1_3"]

    @pytest.mark.parametrize("order", ["".join(p) for p in itertools.permutations("abcd")])
    def test_an_entry_is_never_replaced_or_moved(self, tmp_path, order):
        faces = {"a": "Helvetica", "b": "Times-Roman", "c": "Courier", "d": "Symbol"}
        kinds = {"a": dict(free_text=True), "b": dict(field="parent", pages=2),
                 "c": dict(field="kid", embedded=True), "d": dict(redaction=True, field="own")}
        dst = pikepdf.new()
        sources = []
        held = {}
        for tag in order:
            src = pikepdf.open(_source(str(tmp_path / f"{tag}.pdf"), tag, faces[tag], **kinds[tag]))
            sources.append(src)
            copy_pages_with_forms(dst, src)
            fonts = default_fonts(dst)
            now = {str(k): v.objgen for k, v in fonts.items()}
            for name, objgen in held.items():
                assert now[name] == objgen
            held = now
            _expect(dst, faces)
        assert len(held) == 4
        dst.save(str(tmp_path / "out.pdf"))
        with pikepdf.open(str(tmp_path / "out.pdf")) as pdf:
            _expect(pdf, faces)

    def test_interchangeable_fonts_share_one_name(self, tmp_path):
        faces = {"a": "Helvetica", "b": "Helvetica", "c": "Courier", "d": "Courier"}
        paths = [
            _source(str(tmp_path / "a.pdf"), "a", "Helvetica", field="own"),
            _source(str(tmp_path / "b.pdf"), "b", "Helvetica", free_text=True),
            _source(str(tmp_path / "c.pdf"), "c", "Courier", field="own", embedded=True),
            _source(str(tmp_path / "d.pdf"), "d", "Courier", field="own", embedded=True),
        ]
        out = str(tmp_path / "out.pdf")
        merge(paths, out)
        with pikepdf.open(out) as pdf:
            _expect(pdf, faces)
            assert _table(pdf) == {"F1": "Helvetica", "F1_1": "Courier", "F1_2": "Courier"}

    def test_a_font_no_default_appearance_names_travels_with_a_field(self, tmp_path):
        a = _source(str(tmp_path / "a.pdf"), "a", "Helvetica", field="own", extra_fonts={"F2": "Courier"})
        b = _source(str(tmp_path / "b.pdf"), "b", "Times-Roman", field="own", extra_fonts={"F2": "Symbol"})
        out = str(tmp_path / "out.pdf")
        merge([a, b], out)
        with pikepdf.open(out) as pdf:
            _expect(pdf, {"a": "Helvetica", "b": "Times-Roman"})
            assert _table(pdf) == {"F1": "Helvetica", "F2": "Courier", "F1_1": "Times-Roman", "F2_1": "Symbol"}

    def test_a_default_appearance_with_two_fonts(self, tmp_path):
        a = _source(str(tmp_path / "a.pdf"), "a", "Helvetica", field="own", extra_fonts={"F2": "Courier"})
        b = _source(str(tmp_path / "b.pdf"), "b", "Times-Roman", field="own", extra_fonts={"F2": "Symbol"})
        with pikepdf.open(b, allow_overwriting_input=True) as pdf:
            pdf.Root.AcroForm.Fields[0]["/DA"] = String("/F2 9 Tf /F1 10 Tf 0 g")
            pdf.save(b)
        out = str(tmp_path / "out.pdf")
        merge([a, b], out)
        with pikepdf.open(out) as pdf:
            by_name = {str(f.T): f for f in pdf.Root.AcroForm.Fields}
            assert str(by_name["field-b"].DA) == "/F2_1 9 Tf /F1_1 10 Tf 0 g"
            assert str(by_name["field-a"].DA) == "/F1 10 Tf 0 g"

    def test_a_direct_font_dictionary(self, tmp_path):
        faces = {"a": "Helvetica", "b": "Times-Roman", "c": "Courier"}
        paths = [_source(str(tmp_path / f"{t}.pdf"), t, f, field="own", free_text=True, direct=True)
                 for t, f in faces.items()]
        out = str(tmp_path / "out.pdf")
        merge(paths, out)
        with pikepdf.open(out) as pdf:
            _expect(pdf, faces)
            assert len(_table(pdf)) == 3

    def test_an_appearance_with_no_resources_keeps_its_font(self, tmp_path):
        a = _source(str(tmp_path / "a.pdf"), "a", "Helvetica", field="own")
        b = _source(str(tmp_path / "b.pdf"), "b", "Courier", field="bare")
        out = str(tmp_path / "out.pdf")
        merge([a, b], out)
        with pikepdf.open(out) as pdf:
            _expect(pdf, {"a": "Helvetica", "b": "Courier"})
            by_name = {str(f.T): f for f in pdf.Root.AcroForm.Fields}
            stream = by_name["field-b"].AP.N
            assert stream.Resources.Font.F1.BaseFont == Name.Courier
            assert b"/F1 12 Tf" in stream.read_bytes()
            assert by_name["field-a"].AP.N.Resources.Font.F1.BaseFont == Name.Helvetica

    def test_a_source_is_whole_after_the_copy(self, tmp_path):
        path = _source(str(tmp_path / "a.pdf"), "a", "Helvetica", field="own", free_text=True)
        with pikepdf.open(path) as src:
            dst = pikepdf.new()
            copy_pages_with_forms(dst, src)
            assert _table(src) == {"F1": "Helvetica"}


class TestSplitAndPageCopy:
    def test_split_keeps_each_part_on_its_font(self, tmp_path):
        path = _source(str(tmp_path / "s.pdf"), "s", "Courier", field="own", free_text=True, redaction=True,
                       embedded=True, pages=3)
        out_dir = tmp_path / "parts"
        out_dir.mkdir()
        split(path, output_dir=str(out_dir), mode="every_n", every_n=1)
        parts = sorted(os.listdir(out_dir))
        assert len(parts) == 3
        for part in parts:
            with pikepdf.open(str(out_dir / part)) as pdf:
                found = _faces(pdf)
                assert found and all(got == ["Courier"] for got in found.values()), found
                assert _table(pdf) == {"F1": "Courier"}

    def test_split_parts_merge_back_with_another_document(self, tmp_path):
        path = _source(str(tmp_path / "s.pdf"), "s", "Courier", field="own", free_text=True, embedded=True, pages=2)
        other = _source(str(tmp_path / "o.pdf"), "o", "Symbol", field="parent", free_text=True)
        out_dir = tmp_path / "parts"
        out_dir.mkdir()
        split(path, output_dir=str(out_dir), mode="every_n", every_n=1)
        parts = [str(out_dir / name) for name in sorted(os.listdir(out_dir))]
        out = str(tmp_path / "out.pdf")
        merge([parts[0], other, parts[1]], out)
        with pikepdf.open(out) as pdf:
            _expect(pdf, {"s": "Courier", "o": "Symbol"})
            assert sorted(_table(pdf).values()) == ["Courier", "Courier", "Symbol"]

    def test_two_copies_from_one_open_source_share_the_font(self, tmp_path):
        faces = {"s": "Courier", "o": "Symbol"}
        path = _source(str(tmp_path / "s.pdf"), "s", "Courier", field="own", free_text=True, embedded=True, pages=2)
        other = _source(str(tmp_path / "o.pdf"), "o", "Symbol", field="own", free_text=True, embedded=True)
        with pikepdf.open(path) as src, pikepdf.open(other) as mid:
            dst = pikepdf.new()
            copy_pages_with_forms(dst, src, pages=[0])
            copy_pages_with_forms(dst, mid)
            copy_pages_with_forms(dst, src, pages=[1])
            _expect(dst, faces)
            assert _table(dst) == {"F1": "Courier", "F1_1": "Symbol"}
            dst.save(str(tmp_path / "out.pdf"))
        with pikepdf.open(str(tmp_path / "out.pdf")) as pdf:
            _expect(pdf, faces)

    def test_a_page_copied_twice(self, tmp_path):
        faces = {"a": "Helvetica", "b": "Courier"}
        a = _source(str(tmp_path / "a.pdf"), "a", "Helvetica", field="own", free_text=True)
        b = _source(str(tmp_path / "b.pdf"), "b", "Courier", field="kid", free_text=True, redaction=True)
        with pikepdf.open(a) as first, pikepdf.open(b) as second:
            dst = pikepdf.new()
            copy_pages_with_forms(dst, first)
            copy_pages_with_forms(dst, second, pages=[0, 0])
            _expect(dst, faces)
            for page in dst.pages[1:]:
                for annot in page.obj.Annots:
                    da = annot.get("/DA")
                    if da is not None:
                        assert appearance_fonts(str(da)) == ["F1_1"]
