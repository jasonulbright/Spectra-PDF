"""Transplanted references must name the live page/annotation/field objects."""
import pikepdf
import pytest

from engine.incremental import transplant_incremental
from engine.links import add_links
from engine.signatures import sign_pdf
from test_incremental import _base_pdf, _rewrite_with, _assert_sig_still_valid
from test_incremental_boundaries import boundary_pki


def _graph_signed(tmp_path, pki, prepare=lambda pdf: None, *, identical=False):
    source = tmp_path / "graph-source.pdf"
    _base_pdf(str(source), with_form=True)
    with pikepdf.open(source, allow_overwriting_input=True) as pdf:
        for index in range(2):
            page = pdf.add_blank_page(page_size=(612, 792))
            page.Contents = pdf.make_stream(b"" if identical else f"{index} g".encode())
        prepare(pdf)
        pdf.save(source)
    signed = tmp_path / "graph-signed.pdf"
    sign_pdf(str(source), str(signed), pfx_path=pki["pfx"], password="pw")
    return signed


def _annot(pdf, page, name, subtype="Link", **entries):
    annot = pdf.make_indirect(pikepdf.Dictionary(
        Type=pikepdf.Name.Annot, Subtype=pikepdf.Name("/" + subtype),
        NM=pikepdf.String(name), Rect=pikepdf.Array([20, 100, 100, 120]),
        P=page.obj, **entries,
    ))
    if page.obj.get("/Annots") is None:
        page.Annots = pikepdf.Array()
    page.Annots.append(annot)
    return annot


def _by_name(pdf):
    return {str(a.NM): a for p in pdf.pages for a in p.obj.get("/Annots", [])
            if a.get("/NM") is not None}


def _transplant(tmp_path, signed, mutate):
    modified = _rewrite_with(str(signed), str(tmp_path), mutate)
    output = tmp_path / "graph-output.pdf"
    result = transplant_incremental(str(signed), modified, str(output))
    assert result["applied"], result
    assert output.read_bytes().startswith(signed.read_bytes())
    return output


@pytest.mark.parametrize("source,target", [(0, 0), (0, 2), (2, 0)])
def test_public_links_use_live_pages(tmp_path, boundary_pki, source, target):
    signed = _graph_signed(tmp_path, boundary_pki)
    output = tmp_path / "public-linked.pdf"
    result = add_links(str(signed), str(output), [{
        "page": source + 1, "rect": [20, 100, 100, 120],
        "target": {"kind": "goto", "page": target + 1},
    }])
    assert result["signatures_preserved"], result
    with pikepdf.open(output) as pdf:
        link = next(a for a in pdf.pages[source].Annots if a.Subtype == pikepdf.Name.Link)
        assert link.A.D[0].objgen == pdf.pages[target].obj.objgen
        assert len([o for o in pdf.objects if isinstance(o, pikepdf.Dictionary)
                    and o.get("/Type") == pikepdf.Name.Page]) == len(pdf.pages)
    _assert_sig_still_valid(str(output), boundary_pki)


@pytest.mark.parametrize("position", [None, 0, 1, 3])
def test_all_page_edges_including_forward_insertions(tmp_path, boundary_pki, position):
    signed = _graph_signed(tmp_path, boundary_pki)

    def mutate(pdf):
        if position is not None:
            for n in range(2):
                page = pdf.add_blank_page(page_size=(300 + n, 400))
                page.Contents = pdf.make_stream(f"0 {n} m".encode())
                pdf.pages.insert(position + n, page)
                del pdf.pages[-1]
        for i, page in enumerate(pdf.pages):
            for j, target in enumerate(pdf.pages):
                _annot(pdf, page, f"{i}-{j}", Dest=pikepdf.Array([target.obj, pikepdf.Name.Fit]))

    output = _transplant(tmp_path, signed, mutate)
    with pikepdf.open(output) as pdf:
        for i, page in enumerate(pdf.pages):
            for link in page.Annots:
                if link.Subtype != pikepdf.Name.Link:
                    continue
                source, target = map(int, str(link.NM).split("-"))
                assert source == i
                assert link.P.objgen == page.obj.objgen
                assert link.Dest[0].objgen == pdf.pages[target].obj.objgen
        assert len([o for o in pdf.objects if isinstance(o, pikepdf.Dictionary)
                    and o.get("/Type") == pikepdf.Name.Page]) == len(pdf.pages)
    _assert_sig_still_valid(str(output), boundary_pki)


@pytest.mark.parametrize("action", [False, True])
def test_retarget_between_identical_pages_is_not_equal_content(tmp_path, boundary_pki, action):
    def prepare(pdf):
        destination = pikepdf.Array([pdf.pages[1].obj, pikepdf.Name.Fit])
        link = _annot(pdf, pdf.pages[0], "retarget")
        if action:
            link.A = pdf.make_indirect(pikepdf.Dictionary(S=pikepdf.Name.GoTo, D=destination))
        else:
            link.Dest = destination
        pdf.Root.Names = pikepdf.Dictionary(Dests=pikepdf.Dictionary(
            Names=pikepdf.Array([pikepdf.String("stable"), destination]),
        ))

    signed = _graph_signed(tmp_path, boundary_pki, prepare, identical=True)

    def mutate(pdf):
        link = _by_name(pdf)["retarget"]
        (link.A.D if action else link.Dest)[0] = pdf.pages[2].obj
        _annot(pdf, pdf.pages[1], "on-named-page")

    output = _transplant(tmp_path, signed, mutate)
    with pikepdf.open(output) as pdf:
        link = _by_name(pdf)["retarget"]
        assert (link.A.D if action else link.Dest)[0].objgen == pdf.pages[2].obj.objgen
        assert pdf.Root.Names.Dests.Names[1][0].objgen == pdf.pages[1].obj.objgen


@pytest.mark.parametrize("remove", [False, True])
def test_reordered_pages_keep_the_actual_targets(tmp_path, boundary_pki, remove):
    signed = _graph_signed(tmp_path, boundary_pki)

    def mutate(pdf):
        order = [2, 0] if remove else [2, 0, 1]
        pages = [pdf.pages[i] for i in order]
        # A page-list copy forks pages without fixing signature widgets' /P.
        # This fixture reorders the existing tree, with no malformed owners.
        pdf.Root.Pages.Kids = pikepdf.Array([page.obj for page in pages])
        pdf.Root.Pages.Count = len(pages)
        for i, page in enumerate(pages):
            _annot(pdf, page, str(i), Dest=pikepdf.Array([pages[1-i].obj, pikepdf.Name.Fit]))

    output = _transplant(tmp_path, signed, mutate)
    with pikepdf.open(output) as pdf:
        for i, page in enumerate(pdf.pages):
            link = _by_name(pdf)[str(i)]
            assert link.P.objgen == page.obj.objgen
            assert link.Dest[0].objgen == pdf.pages[1-i].obj.objgen


@pytest.mark.parametrize("reverse", [False, True])
def test_popup_reply_and_field_edges_are_not_copied(tmp_path, boundary_pki, reverse):
    def prepare(pdf):
        _annot(pdf, pdf.pages[0], "parent", "Text", Contents=pikepdf.String("old"))

    signed = _graph_signed(tmp_path, boundary_pki, prepare)

    def mutate(pdf):
        parent = _by_name(pdf)["parent"]
        popup = _annot(pdf, pdf.pages[0], "popup", "Popup", Parent=parent)
        parent.Popup = popup
        parent.Contents = pikepdf.String("new")
        reply = _annot(pdf, pdf.pages[0], "reply", "Text", IRT=parent)
        reply.Popup = popup
        field = pdf.Root.AcroForm.Fields[0]
        field.V = pikepdf.String("changed")
        _annot(pdf, pdf.pages[2], "hide", A=pikepdf.Dictionary(
            S=pikepdf.Name.Hide, T=pikepdf.Array([parent, reply, field]),
        ))
        pdf.Root.AcroForm.CO = pikepdf.Array([field])
        if reverse:
            pdf.pages[0].Annots = pikepdf.Array(list(pdf.pages[0].Annots)[::-1])

    output = _transplant(tmp_path, signed, mutate)
    with pikepdf.open(output) as pdf:
        annots = _by_name(pdf)
        assert annots["parent"].Popup.objgen == annots["popup"].objgen
        assert annots["popup"].Parent.objgen == annots["parent"].objgen
        assert annots["reply"].IRT.objgen == annots["parent"].objgen
        assert annots["reply"].Popup.objgen == annots["popup"].objgen
        assert str(annots["parent"].Contents) == "new"
        field = pdf.Root.AcroForm.Fields[0]
        assert str(field.V) == "changed"
        assert field.objgen in [a.objgen for a in pdf.pages[0].Annots]
        assert [o.objgen for o in annots["hide"].A.T] == [
            annots["parent"].objgen, annots["reply"].objgen, field.objgen,
        ]
        assert pdf.Root.AcroForm.CO[0].objgen == field.objgen


@pytest.mark.parametrize("same_page", [False, True])
def test_reordered_widget_siblings_share_the_registered_field(tmp_path, boundary_pki, same_page):
    def prepare(pdf):
        field = pdf.Root.AcroForm.Fields[0]
        del pdf.pages[0].Annots[0]
        for key in ("/Type", "/Subtype", "/Rect", "/F"):
            del field[key]
        widgets = [_annot(pdf, pdf.pages[0 if same_page else i], f"widget-{i}", "Widget", Parent=field)
                   for i in range(2)]
        for i, widget in enumerate(widgets):
            widget.Rect = pikepdf.Array([i * 100, 100, i * 100 + 50, 120])
        field.Kids = pikepdf.Array(widgets)

    signed = _graph_signed(tmp_path, boundary_pki, prepare)

    def mutate(pdf):
        field = pdf.Root.AcroForm.Fields[0]
        field.V = pikepdf.String("filled")
        field.Kids = pikepdf.Array(list(field.Kids)[::-1])
        for widget in field.Kids:
            widget.AS = pikepdf.Name("/" + str(widget.NM))
        _annot(pdf, pdf.pages[2], "field-target", A=pikepdf.Dictionary(S=pikepdf.Name.Hide, T=field))

    output = _transplant(tmp_path, signed, mutate)
    with pikepdf.open(output) as pdf:
        field = pdf.Root.AcroForm.Fields[0]
        assert str(field.V) == "filled"
        assert [str(k.NM) for k in field.Kids] == ["widget-1", "widget-0"]
        annots = _by_name(pdf)
        for widget in field.Kids:
            assert widget.objgen == annots[str(widget.NM)].objgen
            assert widget.Parent.objgen == field.objgen
            assert str(widget.AS) == "/" + str(widget.NM)
        assert annots["field-target"].A.T.objgen == field.objgen


@pytest.mark.parametrize("orphan", ["page", "pages", "catalog", "field"])
@pytest.mark.parametrize("existing", [False, True])
def test_unmapped_document_target_refuses_without_writing(tmp_path, boundary_pki, orphan, existing):
    def target_of(pdf):
        return {"page": pdf.pages[1].obj, "pages": pdf.Root.Pages,
                "catalog": pdf.Root, "field": pdf.Root.AcroForm.Fields[0]}[orphan]

    def prepare(pdf):
        if existing:
            _annot(pdf, pdf.pages[0], "orphan", Dest=pikepdf.Array([target_of(pdf), pikepdf.Name.Fit]))

    signed = _graph_signed(tmp_path, boundary_pki, prepare)

    def mutate(pdf):
        copied = pdf.make_indirect(pikepdf.Dictionary(target_of(pdf)))
        link = _by_name(pdf)["orphan"] if existing else _annot(pdf, pdf.pages[0], "orphan")
        link.Dest = pikepdf.Array([copied, pikepdf.Name.Fit])

    modified = _rewrite_with(str(signed), str(tmp_path), mutate)
    output = tmp_path / "not-replaced.pdf"
    output.write_bytes(b"existing output")
    before = signed.read_bytes()
    result = transplant_incremental(str(signed), modified, str(output))
    assert result["applied"] is False, result
    assert result["reason"] == "unmapped-document-object-reference", result
    assert output.read_bytes() == b"existing output"
    assert signed.read_bytes() == before


def test_page_action_retarget_is_not_silently_discarded(tmp_path, boundary_pki):
    def prepare(pdf):
        pdf.pages[0].AA = pikepdf.Dictionary(O=pikepdf.Dictionary(
            S=pikepdf.Name.GoTo, D=pikepdf.Array([pdf.pages[1].obj, pikepdf.Name.Fit]),
        ))

    signed = _graph_signed(tmp_path, boundary_pki, prepare, identical=True)

    def mutate(pdf):
        pdf.pages[0].AA.O.D[0] = pdf.pages[2].obj

    modified = _rewrite_with(str(signed), str(tmp_path), mutate)
    output = tmp_path / "page-action.pdf"
    output.write_bytes(b"untouched")
    result = transplant_incremental(str(signed), modified, str(output))
    assert not result["applied"] and result["reason"] == "page-object-references-changed", result
    assert output.read_bytes() == b"untouched"


def test_optional_owner_normalization_keeps_live_annotation(tmp_path, boundary_pki):
    def prepare(pdf):
        link = _annot(pdf, pdf.pages[0], "optional", Dest=pikepdf.Array([pdf.pages[1].obj, pikepdf.Name.Fit]))
        del link["/P"]

    signed = _graph_signed(tmp_path, boundary_pki, prepare)

    def mutate(pdf):
        link = _by_name(pdf)["optional"]
        link.P = pdf.pages[0].obj
        link.Dest[0] = pdf.pages[2].obj

    output = _transplant(tmp_path, signed, mutate)
    with pikepdf.open(output) as pdf:
        assert _by_name(pdf)["optional"].Dest[0].objgen == pdf.pages[2].obj.objgen


def test_popup_parent_retarget_is_an_annotation_edge(tmp_path, boundary_pki):
    def prepare(pdf):
        first = _annot(pdf, pdf.pages[0], "first", "Text")
        _annot(pdf, pdf.pages[0], "second", "Text")
        first.Popup = _annot(pdf, pdf.pages[0], "popup", "Popup", Parent=first)

    signed = _graph_signed(tmp_path, boundary_pki, prepare)

    def mutate(pdf):
        annots = _by_name(pdf)
        del annots["first"]["/Popup"]
        annots["second"].Popup = annots["popup"]
        annots["popup"].Parent = annots["second"]

    output = _transplant(tmp_path, signed, mutate)
    with pikepdf.open(output) as pdf:
        annots = _by_name(pdf)
        assert "/Popup" not in annots["first"]
        assert annots["second"].Popup.objgen == annots["popup"].objgen
        assert annots["popup"].Parent.objgen == annots["second"].objgen


@pytest.mark.parametrize("fork", [False, True])
def test_bad_widget_ownership_refuses_atomically(tmp_path, boundary_pki, fork):
    signed = _graph_signed(tmp_path, boundary_pki)

    def mutate(pdf):
        field = pdf.Root.AcroForm.Fields[0]
        if fork:
            pdf.pages[0].Annots[0] = pdf.make_indirect(pikepdf.Dictionary(field))
        else:
            field.P = pdf.pages[2].obj

    modified = _rewrite_with(str(signed), str(tmp_path), mutate)
    output = tmp_path / "bad-widget.pdf"
    output.write_bytes(b"untouched")
    result = transplant_incremental(str(signed), modified, str(output))
    assert result["applied"] is False, result
    assert output.read_bytes() == b"untouched"


def test_ambiguous_widget_siblings_refuse_instead_of_pairing_positionally(tmp_path, boundary_pki):
    def prepare(pdf):
        field = pdf.Root.AcroForm.Fields[0]
        del pdf.pages[0].Annots[0]
        for key in ("/Type", "/Subtype", "/Rect", "/F"):
            del field[key]
        widgets = [_annot(pdf, pdf.pages[0], str(i), "Widget", Parent=field) for i in range(2)]
        for widget in widgets:
            del widget["/NM"]
        field.Kids = pikepdf.Array(widgets)

    signed = _graph_signed(tmp_path, boundary_pki, prepare)

    def mutate(pdf):
        field = pdf.Root.AcroForm.Fields[0]
        field.Kids = pikepdf.Array(list(field.Kids)[::-1])
        field.Kids[0].AS = pikepdf.Name.Yes

    modified = _rewrite_with(str(signed), str(tmp_path), mutate)
    output = tmp_path / "ambiguous.pdf"
    output.write_bytes(b"untouched")
    result = transplant_incremental(str(signed), modified, str(output))
    assert not result["applied"] and result["reason"] == "ambiguous-field-widget-correspondence", result
    assert output.read_bytes() == b"untouched"


def test_equal_looking_widgets_on_distinct_pages_pair_by_owner(tmp_path, boundary_pki):
    def prepare(pdf):
        field = pdf.Root.AcroForm.Fields[0]
        del pdf.pages[0].Annots[0]
        for key in ("/Type", "/Subtype", "/Rect", "/F"):
            del field[key]
        widgets = [_annot(pdf, pdf.pages[i], str(i), "Widget", Parent=field) for i in (1, 2)]
        for widget in widgets:
            del widget["/NM"]
        field.Kids = pikepdf.Array(widgets)

    signed = _graph_signed(tmp_path, boundary_pki, prepare, identical=True)

    def mutate(pdf):
        field = pdf.Root.AcroForm.Fields[0]
        field.Kids = pikepdf.Array(list(field.Kids)[::-1])
        field.Kids[0].AS = pikepdf.Name.Yes

    output = _transplant(tmp_path, signed, mutate)
    with pikepdf.open(output) as pdf:
        first, second = pdf.Root.AcroForm.Fields[0].Kids
        assert first.objgen == pdf.pages[2].Annots[0].objgen
        assert second.objgen == pdf.pages[1].Annots[0].objgen
        assert first.AS == pikepdf.Name.Yes
        assert "/AS" not in second
