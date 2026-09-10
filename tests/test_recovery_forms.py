"""Recovery preserves the registered form graph, not just its page widgets."""
import importlib

import pikepdf
import pytest

from engine.acroform import calculation_order_names, prune_form_to_pages, strip_signatures
from engine.forms import fill_form_fields, read_form_fields
from engine.recover import recover
from engine.repair import repair
from test_acroform_carry import _make_calc_form, _make_multi_page_form
from test_repair import _signed_source

recovery = importlib.import_module("engine.recover")


def values(path):
    return {f["name"]: f["value"] for f in read_form_fields(str(path))["fields"]}


def fail_page(monkeypatch, index):
    copy = recovery._copy_recovery_page
    seen = 0

    def injected(dest, page):
        nonlocal seen
        ordinal = seen
        seen += 1
        if ordinal == index:
            raise pikepdf.PdfError("injected unreadable page")
        return copy(dest, page)

    monkeypatch.setattr(recovery, "_copy_recovery_page", injected)


def test_recovery_keeps_values_shared_identity_and_fillability(tmp_path):
    src, out, filled = (tmp_path / name for name in ("source.pdf", "out.pdf", "filled.pdf"))
    _make_multi_page_form(str(src))
    original = src.read_bytes()
    result = recover(str(src), str(out))
    assert result["lost"] == 0 and result["recovered"] == 3
    assert values(out) == values(src)
    assert src.read_bytes() == original
    with pikepdf.open(out) as pdf:
        roots = {str(f.T): f for f in pdf.Root.AcroForm.Fields}
        field = roots["span"]
        assert len(field.Kids) == 2
        for page, kid in zip((pdf.pages[0], pdf.pages[2]), field.Kids):
            assert kid.Parent.objgen == field.objgen
            assert kid.P.objgen == page.obj.objgen
            assert kid.objgen in {a.objgen for a in page.Annots}
        assert "span+1" not in roots
        assert str(pdf.Root.AcroForm.DA) == "/Helv 0 Tf 0 g"
    fill_form_fields(str(out), str(filled), {"span": "changed", "ghost": "kept"})
    assert values(filled)["span"] == "changed"
    assert values(filled)["ghost"] == "kept"
    with pikepdf.open(filled) as pdf:
        for page in (pdf.pages[0], pdf.pages[2]):
            widgets = [a for a in page.Annots
                       if a.get("/Parent") is not None and str(a.Parent.get("/T")) == "span"]
            assert len(widgets) == 1
            assert str(widgets[0].Parent.V) == "changed"


@pytest.mark.parametrize("lost_index", [0, 2])
def test_partial_recovery_prunes_only_lost_widgets(tmp_path, monkeypatch, lost_index):
    src, out = tmp_path / "source.pdf", tmp_path / "out.pdf"
    _make_multi_page_form(str(src))
    original = src.read_bytes()
    fail_page(monkeypatch, lost_index)
    result = recover(str(src), str(out))
    assert result["recovered_pages"] == [i + 1 for i in range(3) if i != lost_index]
    assert result["lost"] == 1 and result["lost_pages"][0]["page"] == lost_index + 1
    assert src.read_bytes() == original
    expected = values(src)
    for name in (("title", "sigf") if lost_index == 0 else ("only2",)):
        expected.pop(name)
    assert values(out) == expected
    with pikepdf.open(out) as pdf:
        fields = {str(f.T): f for f in pdf.Root.AcroForm.Fields}
        assert len(fields["span"].Kids) == 1
        live_pages = {p.obj.objgen for p in pdf.pages}
        assert fields["span"].Kids[0].P.objgen in live_pages


@pytest.mark.parametrize("partial", [False, True])
def test_recovery_keeps_calculation_order_and_document_actions(tmp_path, monkeypatch, partial):
    src, out = tmp_path / "source.pdf", tmp_path / "out.pdf"
    _make_calc_form(str(src))
    if partial:
        fail_page(monkeypatch, 1)
    recover(str(src), str(out))
    with pikepdf.open(out) as pdf:
        assert calculation_order_names(pdf) == (["rate"] if partial else ["total", "rate", "grp.sub"])
        assert str(pdf.Root.AA.WC.JS) == "app.alert('closing');"


@pytest.mark.parametrize("packet_array", [False, True])
@pytest.mark.parametrize("shadow", [False, True])
def test_complete_recovery_keeps_xfa_and_rendering_policy(tmp_path, packet_array, shadow):
    src, out = tmp_path / "source.pdf", tmp_path / "out.pdf"
    _make_calc_form(str(src), with_xfa=True)
    packet = b'<xdp:xdp xmlns:xdp="http://ns.adobe.com/xdp/"><template/></xdp:xdp>'
    with pikepdf.open(src, allow_overwriting_input=True) as pdf:
        entry = pdf.make_stream(packet)
        pdf.Root.AcroForm.XFA = pikepdf.Array([pikepdf.String("xdp"), entry]) if packet_array else entry
        if not shadow:
            pdf.Root.AcroForm.Fields = pikepdf.Array()
            for page in pdf.pages:
                page.Annots = pikepdf.Array()
        pdf.Root.NeedsRendering = not shadow
        pdf.save(src)
    recover(str(src), str(out))
    with pikepdf.open(out) as pdf:
        xfa = pdf.Root.AcroForm.XFA
        assert (xfa[1] if packet_array else xfa).read_bytes() == packet
        assert pdf.Root.NeedsRendering is (not shadow)


def test_partial_xfa_recovery_refuses_without_touching_destination(tmp_path, monkeypatch):
    src, out = tmp_path / "source.pdf", tmp_path / "out.pdf"
    _make_calc_form(str(src), with_xfa=True)
    out.write_bytes(b"previous output")
    original = src.read_bytes()
    fail_page(monkeypatch, 1)
    with pytest.raises(ValueError, match="contains an XML form"):
        recover(str(src), str(out))
    assert src.read_bytes() == original and out.read_bytes() == b"previous output"


@pytest.mark.parametrize("xfa", [False, True])
def test_recovery_removes_and_reports_invalidated_signatures(tmp_path, xfa):
    src, out = tmp_path / "source.pdf", tmp_path / "out.pdf"
    _signed_source(str(src))
    if xfa:
        with pikepdf.open(src, allow_overwriting_input=True) as pdf:
            pdf.Root.AcroForm.XFA = pdf.make_stream(b"<xdp/>")
            pdf.save(src)
    result = recover(str(src), str(out))
    assert result["signatures_removed"] == 1
    with pikepdf.open(out) as pdf:
        assert not pdf.pages[0].get("/Annots")
        if xfa:
            assert pdf.Root.AcroForm.XFA.read_bytes() == b"<xdp/>"
            assert not pdf.Root.AcroForm.Fields
            assert pdf.Root.AcroForm.get("/SigFlags") is None
        else:
            assert pdf.Root.get("/AcroForm") is None


def test_pure_data_only_form_survives_recovery(tmp_path):
    src, out = tmp_path / "source.pdf", tmp_path / "out.pdf"
    _make_multi_page_form(str(src))
    with pikepdf.open(src, allow_overwriting_input=True) as pdf:
        pdf.Root.AcroForm.Fields = pikepdf.Array([pdf.Root.AcroForm.Fields[-1]])
        for page in pdf.pages:
            page.Annots = pikepdf.Array()
        pdf.save(src)
    recover(str(src), str(out))
    assert values(out) == {"ghost": "ghost"}


@pytest.mark.parametrize("operation", ["prune", "strip"])
def test_empty_shadow_fields_do_not_erase_xml_form(tmp_path, operation):
    src = tmp_path / "source.pdf"
    _signed_source(str(src))
    with pikepdf.open(src) as pdf:
        acro = pdf.Root.AcroForm
        acro.XFA = pdf.make_stream(b"<xdp/>")
        acro.CO = pikepdf.Array([acro.Fields[0]])
        acro.SigFlags = 3
        if operation == "prune":
            pdf.add_blank_page()
            del pdf.pages[0]
            prune_form_to_pages(pdf, range(len(pdf.pages)))
        else:
            assert strip_signatures(pdf) == 1
        assert pdf.Root.AcroForm.XFA.read_bytes() == b"<xdp/>"
        assert not pdf.Root.AcroForm.Fields
        assert not pdf.Root.AcroForm.get("/CO")
        assert pdf.Root.AcroForm.get("/SigFlags") is None


@pytest.mark.parametrize("operation", [repair, recover])
@pytest.mark.parametrize("widget_count", [1, 2])
@pytest.mark.parametrize("signed", [False, True])
def test_rewrite_handles_separate_signature_widgets(tmp_path, operation, widget_count, signed):
    src, out = tmp_path / "source.pdf", tmp_path / "out.pdf"
    _signed_source(str(src))
    with pikepdf.open(src, allow_overwriting_input=True) as pdf:
        field = pdf.Root.AcroForm.Fields[0]
        if not signed:
            del field["/V"]
        if widget_count == 2:
            pdf.add_blank_page()
        kids = []
        for page in pdf.pages:
            widget = pdf.make_indirect(pikepdf.Dictionary(
                Type=pikepdf.Name.Annot, Subtype=pikepdf.Name.Widget,
                Parent=field, P=page.obj, Rect=pikepdf.Array([0, 0, 100, 50]), F=4))
            page.Annots = pikepdf.Array([widget])
            kids.append(widget)
        for key in ("/Type", "/Subtype", "/Rect", "/P", "/F"):
            del field[key]
        field.Kids = pikepdf.Array(kids)
        # Exercise /FT inheritance through a non-terminal field as well.
        group = pdf.make_indirect(pikepdf.Dictionary(
            T=pikepdf.String("group"), FT=pikepdf.Name.Sig, Kids=pikepdf.Array([field])))
        field.Parent = group
        del field["/FT"]
        pdf.Root.AcroForm.Fields = pikepdf.Array([group])
        pdf.Root.AcroForm.CO = pikepdf.Array([field])
        pdf.save(src)
    original = src.read_bytes()
    result = operation(str(src), str(out))
    assert src.read_bytes() == original
    assert result["signatures_removed"] == int(signed)
    with pikepdf.open(out) as pdf:
        assert [len(p.get("/Annots", [])) for p in pdf.pages] == [int(not signed)] * widget_count
        if signed:
            assert pdf.Root.get("/AcroForm") is None
        else:
            assert len(pdf.Root.AcroForm.Fields[0].Kids[0].Kids) == widget_count


def test_no_pages_recovered_never_replaces_output(tmp_path, monkeypatch):
    src, out = tmp_path / "source.pdf", tmp_path / "out.pdf"
    _make_multi_page_form(str(src))
    out.write_bytes(b"previous output")

    def fail(*args):
        raise pikepdf.PdfError("injected page-copy failure")

    monkeypatch.setattr(recovery, "_copy_recovery_page", fail)
    with pytest.raises(RuntimeError, match="No pages could be recovered"):
        recover(str(src), str(out))
    assert out.read_bytes() == b"previous output"


def test_failed_append_does_not_leave_an_unreported_page():
    class Pages(list):
        def append(self, value):
            super().append(value)
            raise pikepdf.PdfError("injected post-append failure")

    class Dest:
        pages = Pages(["retained"])

    with pytest.raises(pikepdf.PdfError):
        recovery._copy_recovery_page(Dest, {"/MediaBox": [0, 0, 100, 100]})
    assert Dest.pages == ["retained"]


@pytest.mark.parametrize("iterator_fails", [False, True])
@pytest.mark.parametrize("xfa", [False, True])
def test_count_unavailable_recovery_is_honest(tmp_path, monkeypatch, iterator_fails, xfa):
    src, out = tmp_path / "source.pdf", tmp_path / "out.pdf"
    _make_multi_page_form(str(src))
    if xfa:
        with pikepdf.open(src, allow_overwriting_input=True) as pdf:
            pdf.Root.AcroForm.XFA = pdf.make_stream(b"<xdp/>")
            pdf.save(src)
    original = src.read_bytes()
    out.write_bytes(b"previous output")
    opened = pikepdf.open

    class Pages:
        def __init__(self, pages):
            self.pages = pages

        def __len__(self):
            raise pikepdf.PdfError("injected unavailable count")

        def __iter__(self):
            yield self.pages[0]
            if iterator_fails:
                raise pikepdf.PdfError("injected page-tree iterator failure")
            yield from list(self.pages)[1:]

    class Source:
        def __init__(self, pdf):
            self.pdf = pdf
            self.pages = Pages(pdf.pages)

        def __getattr__(self, name):
            return getattr(self.pdf, name)

        def __enter__(self):
            return self

        def __exit__(self, *args):
            self.pdf.close()

    with monkeypatch.context() as patch:
        patch.setattr(recovery.pikepdf, "open", lambda *a, **kw: Source(opened(*a, **kw)))
        if xfa and iterator_fails:
            with pytest.raises(ValueError, match="contains an XML form"):
                recover(str(src), str(out))
            assert src.read_bytes() == original and out.read_bytes() == b"previous output"
            return
        result = recover(str(src), str(out))
    if iterator_fails:
        assert result["enumeration_error"] == "injected page-tree iterator failure"
        assert result["page_count_known"] is False
        assert result["recovered_pages"] == [1]
        assert values(out) == {"title": "Hello", "span": "shared", "sigf": None, "ghost": "ghost"}
    else:
        assert result["page_count_known"] is True
        assert result["recovered_pages"] == [1, 2, 3]
        assert values(out) == values(src)
