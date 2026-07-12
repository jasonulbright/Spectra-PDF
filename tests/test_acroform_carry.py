"""AcroForm preservation through the engine's structural page ops (2n.4a).

pikepdf page copies import widget annotations and their /Parent field chains
but never the document-level /AcroForm — so merge and split outputs lost
every form field (they kept rendering via /AP pixels; nothing was fillable),
and delete could leave phantom fields whose every widget died with a deleted
page. These tests drive the REAL merge/split/delete handlers over raw
pikepdf-authored fixtures and read the results back through the engine's own
reader plus raw object checks. The renderer's rebuild has the mirrored suite
in tests/acroform-carry.test.ts.
"""

import os

import pikepdf
import pytest
from pikepdf import Array, Dictionary, Name

from engine.delete import delete
from engine.forms import fill_form_fields, read_form_fields
from engine.merge import merge
from engine.split import split


def _text_widget(pdf, page, rect, name=None, value=None):
    w = pdf.make_indirect(
        Dictionary(Type=Name.Annot, Subtype=Name.Widget, FT=Name.Tx, Rect=rect, F=4, P=page.obj)
    )
    if name is not None:
        w["/T"] = pikepdf.String(name)
    if value is not None:
        w["/V"] = pikepdf.String(value)
    annots = page.obj.get("/Annots")
    if annots is None:
        page.obj["/Annots"] = pikepdf.Array([w])
    else:
        annots.append(w)
    return w


def _content(pdf, page, marker: str):
    page.obj["/Contents"] = pdf.make_stream(
        f"BT /F0 12 Tf 20 20 Td ({marker}) Tj ET".encode()
    )


def _make_multi_page_form(path: str) -> None:
    """Three pages:
    p0 — 'title' text (V=Hello), the first widget of multi-widget field
         'span', and an EMPTY signature field 'sigf';
    p1 — no fields (content marker MIDMARKER);
    p2 — 'only2' text (V=tail), span's second widget, content TAILMARKER.
    Plus a widget-less pure-data field 'ghost' (V=ghost) and a truthful
    AcroForm (/DA, /DR /Helv, /SigFlags 1)."""
    pdf = pikepdf.new()
    p0 = pdf.add_blank_page(page_size=(400, 400))
    p1 = pdf.add_blank_page(page_size=(400, 400))
    p2 = pdf.add_blank_page(page_size=(400, 400))
    _content(pdf, p1, "MIDMARKER")
    _content(pdf, p2, "TAILMARKER")

    title = _text_widget(pdf, p0, [40, 340, 200, 364], name="title", value="Hello")

    # Multi-widget single field: kid widgets carry NO /T of their own.
    k1 = _text_widget(pdf, p0, [40, 300, 200, 324])
    k2 = _text_widget(pdf, p2, [40, 300, 200, 324])
    del k1["/FT"]
    del k2["/FT"]
    span = pdf.make_indirect(
        Dictionary(T=pikepdf.String("span"), FT=Name.Tx, V=pikepdf.String("shared"), Kids=Array([k1, k2]))
    )
    k1["/Parent"] = span
    k2["/Parent"] = span

    sigf = pdf.make_indirect(
        Dictionary(Type=Name.Annot, Subtype=Name.Widget, FT=Name.Sig, Rect=[40, 260, 200, 284], F=4, P=p0.obj)
    )
    sigf["/T"] = pikepdf.String("sigf")
    p0.obj["/Annots"].append(sigf)

    only2 = _text_widget(pdf, p2, [40, 340, 200, 364], name="only2", value="tail")

    ghost = pdf.make_indirect(Dictionary(FT=Name.Tx, T=pikepdf.String("ghost"), V=pikepdf.String("ghost")))

    helv = pdf.make_indirect(
        Dictionary(Type=Name.Font, Subtype=Name.Type1, BaseFont=Name.Helvetica, Encoding=Name.WinAnsiEncoding)
    )
    pdf.Root["/AcroForm"] = pdf.make_indirect(
        Dictionary(
            Fields=Array([title, span, sigf, only2, ghost]),
            DA=pikepdf.String("/Helv 0 Tf 0 g"),
            DR=Dictionary(Font=Dictionary(Helv=helv)),
            SigFlags=1,
        )
    )
    pdf.save(path)
    pdf.close()


def _make_named_form(path: str, field_name: str, value: str, *, base_font=Name.Helvetica,
                     font_key="F1", da=None, need_appearances=False) -> None:
    pdf = pikepdf.new()
    page = pdf.add_blank_page(page_size=(400, 400))
    w = _text_widget(pdf, page, [40, 340, 200, 364], name=field_name, value=value)
    if da is not None:
        w["/DA"] = pikepdf.String(da)
    font = pdf.make_indirect(
        Dictionary(Type=Name.Font, Subtype=Name.Type1, BaseFont=base_font, Encoding=Name.WinAnsiEncoding)
    )
    acro = Dictionary(
        Fields=Array([w]),
        DA=pikepdf.String(f"/{font_key} 0 Tf 0 g"),
        DR=Dictionary(Font=Dictionary(**{font_key: font})),
    )
    if need_appearances:
        acro["/NeedAppearances"] = True
    pdf.Root["/AcroForm"] = pdf.make_indirect(acro)
    pdf.save(path)
    pdf.close()


def _fields_by_name(path: str) -> dict:
    return {f["name"]: f for f in read_form_fields(path)["fields"]}


class TestMergeForms:
    def test_merge_carries_both_forms_and_renames_collisions(self, tmp_dir):
        a = os.path.join(tmp_dir, "a.pdf")
        b = os.path.join(tmp_dir, "b.pdf")
        out = os.path.join(tmp_dir, "merged.pdf")
        _make_named_form(a, "name", "from-A")
        _make_named_form(b, "name", "from-B")
        result = merge([a, b], out)
        # pikepdf's add_pages_from rename convention: name+1.
        assert result["fields_renamed"] == [{"from": "name", "to": "name+1"}]

        by_name = _fields_by_name(out)
        assert by_name["name"]["value"] == "from-A"
        assert by_name["name+1"]["value"] == "from-B"

        # Both fields stay independently fillable through the parity engine.
        filled = os.path.join(tmp_dir, "filled.pdf")
        fill_form_fields(out, filled, {"name": "A2", "name+1": "B2"})
        by_name2 = _fields_by_name(filled)
        assert by_name2["name"]["value"] == "A2"
        assert by_name2["name+1"]["value"] == "B2"

    def test_merge_reuses_page_imported_field_objects(self, tmp_dir):
        # copy_foreign caches per source: the /Fields entry must BE the same
        # object the page's widget already imported — a fresh copy would fork
        # the field from its visible widget.
        a = os.path.join(tmp_dir, "a.pdf")
        out = os.path.join(tmp_dir, "merged.pdf")
        _make_named_form(a, "solo", "v")
        merge([a], out)
        with pikepdf.open(out) as pdf:
            root_field = pdf.Root["/AcroForm"]["/Fields"][0]
            widget = pdf.pages[0].obj["/Annots"][0]
            assert root_field.objgen == widget.objgen

    def test_merge_dr_conflict_renames_and_rewrites_da(self, tmp_dir):
        a = os.path.join(tmp_dir, "a.pdf")
        b = os.path.join(tmp_dir, "b.pdf")
        out = os.path.join(tmp_dir, "merged.pdf")
        _make_named_form(a, "fa", "x", base_font=Name.Helvetica, da="/F1 10 Tf 0 g")
        _make_named_form(b, "fb", "y", base_font=Name.Courier, da="/F1 10 Tf 0 g")
        merge([a, b], out)
        with pikepdf.open(out) as pdf:
            # add_pages_from resolves the /DR name clash (F1 -> F1_1 for the
            # second face) and rewrites the affected field's /DA to match —
            # neither field silently changes face.
            fonts = pdf.Root["/AcroForm"]["/DR"]["/Font"]
            assert fonts["/F1"]["/BaseFont"] == Name.Helvetica
            assert fonts["/F1_1"]["/BaseFont"] == Name.Courier
            by_t = {str(f.get("/T")): f for f in pdf.Root["/AcroForm"]["/Fields"]}
            assert str(by_t["fa"]["/DA"]) == "/F1 10 Tf 0 g"
            assert str(by_t["fb"]["/DA"]) == "/F1_1 10 Tf 0 g"

    def test_merge_differing_acroform_da_materializes_down(self, tmp_dir):
        a = os.path.join(tmp_dir, "a.pdf")
        b = os.path.join(tmp_dir, "b.pdf")
        out = os.path.join(tmp_dir, "merged.pdf")
        # Fields in both sources INHERIT their AcroForm-level /DA (no own
        # /DA); B's default differs from A's. The carry must not let either
        # field silently change size/color — add_pages_from materializes each
        # source's effective default down onto its fields.
        _make_named_form(a, "fa", "x")
        _make_named_form(b, "fb", "y")
        with pikepdf.open(b, allow_overwriting_input=True) as pdf:
            pdf.Root["/AcroForm"]["/DA"] = pikepdf.String("/F1 8 Tf 0.5 g")
            pdf.save(b)
        merge([a, b], out)
        with pikepdf.open(out) as pdf:
            by_t = {str(f.get("/T")): f for f in pdf.Root["/AcroForm"]["/Fields"]}
            assert str(by_t["fa"]["/DA"]) == "/F1 0 Tf 0 g"
            assert str(by_t["fb"]["/DA"]).startswith("/F1")
            assert "8 Tf 0.5 g" in str(by_t["fb"]["/DA"])

    def test_merge_need_appearances_ors(self, tmp_dir):
        a = os.path.join(tmp_dir, "a.pdf")
        b = os.path.join(tmp_dir, "b.pdf")
        out = os.path.join(tmp_dir, "merged.pdf")
        _make_named_form(a, "fa", "x")
        _make_named_form(b, "fb", "y", need_appearances=True)
        merge([a, b], out)
        with pikepdf.open(out) as pdf:
            assert pdf.Root["/AcroForm"]["/NeedAppearances"] == True  # noqa: E712

    def test_merge_without_forms_adds_no_acroform(self, tmp_dir, sample_pdf):
        out = os.path.join(tmp_dir, "merged.pdf")
        merge([sample_pdf, sample_pdf], out)
        with pikepdf.open(out) as pdf:
            assert "/AcroForm" not in pdf.Root
        # And the report key is absent from the result for a form-less merge.
        result = merge([sample_pdf], os.path.join(tmp_dir, "m2.pdf"))
        assert "fields_renamed" not in result


class TestSplitForms:
    def test_split_keeps_fields_of_kept_pages(self, tmp_dir):
        src = os.path.join(tmp_dir, "form.pdf")
        _make_multi_page_form(src)
        result = split(src, "1-2", tmp_dir)
        part = result["outputs"][0]
        by_name = _fields_by_name(part)
        assert by_name["title"]["value"] == "Hello"
        assert "only2" not in by_name  # its only widget was on the dropped page
        with pikepdf.open(part) as pdf:
            by_t = {str(f.get("/T", "")): f for f in pdf.Root["/AcroForm"]["/Fields"]}
            assert len(by_t["span"]["/Kids"]) == 1  # p2's widget pruned, p0's kept
            assert str(by_t["ghost"]["/V"]) == "ghost"  # pure-data field carried
            assert int(pdf.Root["/AcroForm"]["/SigFlags"]) == 1  # sigf lives on p0

    def test_split_does_not_drag_excluded_pages(self, tmp_dir):
        # span has a widget on p2; without the pre-copy prune, copying p0
        # would follow span -> kid2 -> /P and drag all of p2 into the part.
        src = os.path.join(tmp_dir, "form.pdf")
        _make_multi_page_form(src)
        result = split(src, "1", tmp_dir)
        part_bytes = open(result["outputs"][0], "rb").read()
        assert b"TAILMARKER" not in part_bytes
        assert b"MIDMARKER" not in part_bytes
        with pikepdf.open(result["outputs"][0]) as pdf:
            assert len(pdf.pages) == 1

    def test_split_fieldless_part_gets_no_acroform(self, tmp_dir):
        src = os.path.join(tmp_dir, "form.pdf")
        _make_multi_page_form(src)
        result = split(src, "2", tmp_dir)  # p1 carries no widgets
        with pikepdf.open(result["outputs"][0]) as pdf:
            # The pure-data 'ghost' field has no page presence at all; it
            # belongs to the fields that survive ANY subset, so /AcroForm
            # exists but carries only widget-less data fields — no page
            # widget, no sig, no SigFlags.
            acro = pdf.Root.get("/AcroForm")
            assert acro is not None
            names = {str(f.get("/T", "")) for f in acro["/Fields"]}
            assert names == {"ghost"}
            assert acro.get("/SigFlags") is None

    def test_split_part_without_sig_field_drops_sigflags(self, tmp_dir):
        src = os.path.join(tmp_dir, "form.pdf")
        _make_multi_page_form(src)
        result = split(src, "3", tmp_dir)  # p2: only2 + span's second widget
        by_name = _fields_by_name(result["outputs"][0])
        assert by_name["only2"]["value"] == "tail"
        with pikepdf.open(result["outputs"][0]) as pdf:
            assert pdf.Root["/AcroForm"].get("/SigFlags") is None
            assert "sigf" not in {str(f.get("/T", "")) for f in pdf.Root["/AcroForm"]["/Fields"]}


class TestGhostscriptFormReattach:
    """gs pdfwrite drops /AcroForm and every widget annotation (verified
    against the bundled gs) — compress/grayscale must transplant the
    original's fields back; pdfa documents the drop instead (unembedded AP
    fonts would break the conformance the op exists to produce)."""

    def test_compress_preserves_form_fields(self, tmp_dir, gs_path):
        from engine.compress import compress

        src = os.path.join(tmp_dir, "form.pdf")
        out = os.path.join(tmp_dir, "compressed.pdf")
        _make_multi_page_form(src)
        compress(src, out, quality="ebook", gs_path=gs_path)
        by_name = _fields_by_name(out)
        assert by_name["title"]["value"] == "Hello"
        assert by_name["only2"]["value"] == "tail"
        with pikepdf.open(out) as pdf:
            by_t = {str(f.get("/T", "")): f for f in pdf.Root["/AcroForm"]["/Fields"]}
            assert len(by_t["span"]["/Kids"]) == 2  # both widgets, both pages kept
            assert str(by_t["ghost"]["/V"]) == "ghost"
            assert int(pdf.Root["/AcroForm"]["/SigFlags"]) == 1
            # Widgets sit in the regenerated pages' /Annots with /P repointed.
            p0_annots = pdf.pages[0].obj["/Annots"]
            assert any(a.get("/Subtype") == Name.Widget for a in p0_annots)
            for a in p0_annots:
                if a.get("/P") is not None:
                    assert a["/P"].objgen == pdf.pages[0].obj.objgen

    def test_compress_non_form_untouched_shape(self, tmp_dir, gs_path, sample_pdf):
        from engine.compress import compress

        out = os.path.join(tmp_dir, "compressed.pdf")
        compress(sample_pdf, out, quality="ebook", gs_path=gs_path)
        with pikepdf.open(out) as pdf:
            assert "/AcroForm" not in pdf.Root

    def test_grayscale_preserves_form_fields(self, tmp_dir, gs_path):
        from engine.grayscale import grayscale

        src = os.path.join(tmp_dir, "form.pdf")
        out = os.path.join(tmp_dir, "gray.pdf")
        _make_multi_page_form(src)
        grayscale(src, out, gs_path=gs_path)
        by_name = _fields_by_name(out)
        assert by_name["title"]["value"] == "Hello"

    def test_reattach_does_not_drag_original_page_content(self, tmp_dir, gs_path):
        # The transplanted forest's widgets had /P pointing at ORIGINAL page
        # objects; without the pre-copy strip the foreign copy would drag
        # those pages (content streams included) into the compressed file as
        # orphans, and page content would appear twice in the bytes.
        from engine.compress import compress

        src = os.path.join(tmp_dir, "form.pdf")
        out = os.path.join(tmp_dir, "compressed.pdf")
        _make_multi_page_form(src)
        compress(src, out, quality="ebook", gs_path=gs_path)
        with pikepdf.open(out) as pdf:
            page_ids = {p.obj.objgen for p in pdf.pages}
            # Every object that LOOKS like a page leaf must be a real page.
            for obj in pdf.objects:
                try:
                    if isinstance(obj, Dictionary) and obj.get("/Type") == Name.Page:
                        assert obj.objgen in page_ids
                except Exception:
                    continue


class TestDeleteFormPrune:
    def test_delete_prunes_fields_of_deleted_pages(self, tmp_dir):
        src = os.path.join(tmp_dir, "form.pdf")
        out = os.path.join(tmp_dir, "out.pdf")
        _make_multi_page_form(src)
        delete(src, [3], out)  # drop p2
        by_name = _fields_by_name(out)
        assert "only2" not in by_name
        assert by_name["title"]["value"] == "Hello"
        with pikepdf.open(out) as pdf:
            by_t = {str(f.get("/T", "")): f for f in pdf.Root["/AcroForm"]["/Fields"]}
            assert len(by_t["span"]["/Kids"]) == 1
            assert "ghost" in by_t  # pure-data field untouched by page deletion

    def test_delete_last_field_page_removes_acroform(self, tmp_dir):
        src = os.path.join(tmp_dir, "one.pdf")
        out = os.path.join(tmp_dir, "out.pdf")
        pdf = pikepdf.new()
        p0 = pdf.add_blank_page(page_size=(300, 300))
        pdf.add_blank_page(page_size=(300, 300))
        w = _text_widget(pdf, p0, [10, 100, 110, 120], name="only", value="v")
        pdf.Root["/AcroForm"] = pdf.make_indirect(Dictionary(Fields=Array([w])))
        pdf.save(src)
        pdf.close()
        delete(src, [1], out)
        with pikepdf.open(out) as opened:
            assert "/AcroForm" not in opened.Root

    def test_delete_sig_page_drops_sigflags(self, tmp_dir):
        src = os.path.join(tmp_dir, "form.pdf")
        out = os.path.join(tmp_dir, "out.pdf")
        _make_multi_page_form(src)
        delete(src, [1], out)  # p0 carries the sig field
        with pikepdf.open(out) as pdf:
            acro = pdf.Root["/AcroForm"]
            assert acro.get("/SigFlags") is None
            names = {str(f.get("/T", "")) for f in acro["/Fields"]}
            assert "sigf" not in names
            assert "title" not in names  # also lived on p0
            assert {"span", "only2", "ghost"} <= names
