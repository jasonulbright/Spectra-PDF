"""Opening-view edits own only the requested destination, not other actions."""
import pikepdf
import pytest

from engine import doc_properties as properties


def document(tmp_path, install):
    source = tmp_path / 'source.pdf'
    with pikepdf.new() as pdf:
        pdf.add_blank_page(page_size=(300, 400))
        pdf.add_blank_page(page_size=(300, 400))
        install(pdf)
        pdf.save(source)
    return source


def test_action_reference_allowance_is_cumulative_and_refuses_atomically(tmp_path):
    def install(pdf):
        leaf = pdf.make_indirect(pikepdf.Dictionary(S=pikepdf.Name.Named, N=pikepdf.Name.NextPage))
        middle = [pdf.make_indirect(pikepdf.Dictionary(S=pikepdf.Name.Named,
                  N=pikepdf.Name.PrevPage, Next=pikepdf.Array([leaf] * 200))) for _ in range(60)]
        pdf.Root.OpenAction = pdf.make_indirect(pikepdf.Dictionary(S=pikepdf.Name.GoTo,
            D=pikepdf.Array([pdf.pages[0].obj, pikepdf.Name.Fit]), Next=pikepdf.Array(middle)))
    source = document(tmp_path, install)
    output = tmp_path / 'exists.pdf'
    before = source.read_bytes(); output.write_bytes(b'keep-existing-output')
    with pytest.raises(ValueError, match='without losing behavior'):
        properties.set_initial_view(str(source), str(output), open_page=2)
    assert source.read_bytes() == before
    assert output.read_bytes() == b'keep-existing-output'


def test_direct_action_nodes_do_not_alias_recycled_python_wrapper_ids(tmp_path):
    def install(pdf):
        branches = []
        for number in range(100):
            leaf = pikepdf.Dictionary(S=pikepdf.Name.URI, URI=pikepdf.String(f'https://example.invalid/{number}'))
            branches.append(pikepdf.Dictionary(S=pikepdf.Name.Named, N=pikepdf.Name.NextPage, Next=leaf))
        pdf.Root.OpenAction = pikepdf.Dictionary(S=pikepdf.Name.GoTo,
            D=pikepdf.Array([pdf.pages[0].obj, pikepdf.Name.Fit]), Next=pikepdf.Array(branches))
    source = document(tmp_path, install)
    properties.set_initial_view(str(source), str(source), open_page=2)
    with pikepdf.open(source) as pdf:
        assert [str(branch.Next.URI) for branch in pdf.Root.OpenAction.Next] == [f'https://example.invalid/{n}' for n in range(100)]


@pytest.mark.parametrize('tail', [
    ['/XYZ', 42, 350, 1.25], ['/XYZ', None, 120, 0.0025],
    ['/FitR', 10, 20, 200, 300], ['/FitBH', 220], ['/FitBV', 25],
])
def test_page_only_edit_preserves_exact_destination_tail(tmp_path, tail):
    def install(pdf):
        pdf.Root.OpenAction = pikepdf.Array([pdf.pages[0].obj, pikepdf.Name(tail[0]), *tail[1:]])
    source = document(tmp_path, install)
    before = source.read_bytes()
    output = tmp_path / 'output.pdf'
    properties.set_initial_view(str(source), str(output), open_page=2)
    with pikepdf.open(output) as pdf:
        dest = pdf.Root.OpenAction
        assert dest[0].objgen == pdf.pages[1].obj.objgen
        assert str(dest[1]) == tail[0]
        assert [None if value is None else float(value) for value in list(dest)[2:]] == tail[1:]
    assert source.read_bytes() == before


def test_shared_cyclic_action_graph_is_owned_without_changing_external_links(tmp_path):
    def install(pdf):
        first = pdf.make_indirect(pikepdf.Dictionary(S=pikepdf.Name.GoTo,
            D=pikepdf.Array([pdf.pages[0].obj, pikepdf.Name.Fit])))
        second = pdf.make_indirect(pikepdf.Dictionary(S=pikepdf.Name.Named, N=pikepdf.Name.NextPage))
        first.Next = pikepdf.Array([second, second])
        second.Next = first
        pdf.Root.OpenAction = first
        pdf.pages[0].Annots = pikepdf.Array([pdf.make_indirect(pikepdf.Dictionary(
            Type=pikepdf.Name.Annot, Subtype=pikepdf.Name.Link,
            Rect=pikepdf.Array([0, 0, 100, 50]), A=first))])
    source = document(tmp_path, install)
    properties.set_initial_view(str(source), str(source), open_page=2)
    with pikepdf.open(source) as pdf:
        opening, external = pdf.Root.OpenAction, pdf.pages[0].Annots[0].A
        assert opening.objgen != external.objgen
        assert opening.D[0].objgen == pdf.pages[1].obj.objgen
        assert external.D[0].objgen == pdf.pages[0].obj.objgen
        assert opening.Next[0].objgen == opening.Next[1].objgen
        assert opening.Next[0].Next.objgen == opening.objgen
        assert external.Next[0].Next.objgen == external.objgen


def test_removing_an_action_with_a_chain_refuses_without_touching_either_file(tmp_path):
    def install(pdf):
        pdf.Root.OpenAction = pikepdf.Dictionary(S=pikepdf.Name.GoTo,
            D=pikepdf.Array([pdf.pages[0].obj, pikepdf.Name.Fit]),
            Next=pikepdf.Dictionary(S=pikepdf.Name.Named, N=pikepdf.Name.NextPage))
    source = document(tmp_path, install)
    before = source.read_bytes()
    output = tmp_path / 'existing.pdf'
    output.write_bytes(b'previous output')
    with pytest.raises(ValueError, match='without losing behavior'):
        properties.set_initial_view(str(source), str(output), open_page=0)
    assert source.read_bytes() == before
    assert output.read_bytes() == b'previous output'


def test_string_destination_keeps_leading_slash_identity(tmp_path):
    def install(pdf):
        pdf.Root.Names = pikepdf.Dictionary(Dests=pikepdf.Dictionary(Names=pikepdf.Array([
            pikepdf.String('/chapter'), pikepdf.Array([pdf.pages[1].obj, pikepdf.Name.Fit]),
            pikepdf.String('chapter'), pikepdf.Array([pdf.pages[0].obj, pikepdf.Name.Fit]),
        ])))
        pdf.Root.OpenAction = pikepdf.Dictionary(S=pikepdf.Name.GoTo, D=pikepdf.String('/chapter'))
    source = document(tmp_path, install)
    assert properties.get_initial_view(str(source))['open_page'] == 2


def test_zoom_only_change_preserves_existing_page_and_coordinates(tmp_path):
    source = document(tmp_path, lambda pdf: setattr(pdf.Root, 'OpenAction',
        pikepdf.Array([pdf.pages[1].obj, pikepdf.Name.XYZ, 42, 350, 1.25])))
    properties.set_initial_view(str(source), str(source), zoom='percent', zoom_percent=175)
    with pikepdf.open(source) as pdf:
        dest = pdf.Root.OpenAction
        assert dest[0].objgen == pdf.pages[1].obj.objgen
        assert [float(v) for v in list(dest)[2:]] == [42, 350, 1.75]


@pytest.mark.parametrize('subtype', ['GoToR', 'GoToE', 'URI', 'JavaScript'])
def test_nonlocal_actions_are_not_interpreted_as_local_pages(tmp_path, subtype):
    source = document(tmp_path, lambda pdf: setattr(pdf.Root, 'OpenAction',
        pikepdf.Dictionary(S=pikepdf.Name('/' + subtype),
            D=pikepdf.Array([pdf.pages[1].obj, pikepdf.Name.Fit]))))
    view = properties.get_initial_view(str(source))
    assert view['open_page'] is None and view['open_action_replaceable'] is False


@pytest.mark.parametrize('changes', [
    {'open_page': True}, {'open_page': 1.5}, {'open_page': '2'},
    {'hide_toolbar': 'false'}, {'hide_toolbar': 0},
    {'zoom': 'percent', 'zoom_percent': True},
    {'zoom': 'percent', 'zoom_percent': float('nan')},
])
def test_invalid_edit_types_refuse_atomically(tmp_path, changes):
    source = document(tmp_path, lambda pdf: None)
    before = source.read_bytes()
    with pytest.raises(ValueError):
        properties.set_initial_view(str(source), str(source), **changes)
    assert source.read_bytes() == before


@pytest.mark.parametrize('remove', [False, True])
def test_base_url_change_preserves_other_uri_entries(tmp_path, remove):
    source = document(tmp_path, lambda pdf: setattr(pdf.Root, 'URI',
        pikepdf.Dictionary(Base=pikepdf.String('https://old.invalid/'), Private=42)))
    properties.set_advanced_properties(str(source), str(source), base_url='' if remove else 'https://new.invalid/')
    with pikepdf.open(source) as pdf:
        assert pdf.Root.URI.Private == 42
        assert ('/Base' not in pdf.Root.URI) if remove else str(pdf.Root.URI.Base) == 'https://new.invalid/'


@pytest.mark.parametrize('same_file', [False, True])
def test_failed_save_never_replaces_existing_destination(tmp_path, monkeypatch, same_file):
    source = document(tmp_path, lambda pdf: None)
    output = source if same_file else tmp_path / 'existing.pdf'
    if not same_file:
        output.write_bytes(b'previous output')
    before = output.read_bytes()
    def fail_after_write(pdf, path):
        path.write_bytes(b'incomplete')
        raise RuntimeError('injected save failure')
    monkeypatch.setattr(properties, 'save_pdf', fail_after_write)
    with pytest.raises(RuntimeError, match='injected'):
        properties.set_initial_view(str(source), str(output), page_mode='thumbnails')
    assert output.read_bytes() == before


def test_valid_replacement_character_is_not_confused_with_a_lossy_decode(tmp_path):
    source = document(tmp_path, lambda pdf: setattr(pdf.Root, 'URI',
        pikepdf.Dictionary(Base=pikepdf.String(b'\xfe\xff' + 'https://example.invalid/\ufffd'.encode('utf-16-be')))))
    assert properties.get_advanced_properties(str(source))['base_url'].endswith('\ufffd')
