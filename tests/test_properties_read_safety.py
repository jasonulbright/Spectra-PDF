"""Real malformed-property reads must not authorize default-valued edits."""
import pikepdf
import pytest

from engine.doc_properties import get_advanced_properties, get_initial_view


def _document(tmp_path, install):
    path = tmp_path / 'facts.pdf'
    with pikepdf.new() as pdf:
        pdf.add_blank_page(page_size=(300, 400))
        install(pdf)
        pdf.save(path)
    return path


@pytest.mark.parametrize('key', ['PageLayout', 'PageMode'])
@pytest.mark.parametrize('value', ['Unknown', 'string', 'number'])
def test_unreadable_view_enum_does_not_become_default(tmp_path, key, value):
    val = pikepdf.Name('/NotAView') if value == 'Unknown' else pikepdf.String('SinglePage') if value == 'string' else 42
    path = _document(tmp_path, lambda pdf: pdf.Root.__setitem__('/' + key, val))
    before = path.read_bytes()
    with pytest.raises(ValueError, match='initial view'):
        get_initial_view(str(path))
    assert path.read_bytes() == before


@pytest.mark.parametrize('key', ['HideToolbar', 'HideMenubar', 'HideWindowUI', 'FitWindow', 'CenterWindow', 'DisplayDocTitle'])
@pytest.mark.parametrize('value', [pikepdf.String('false'), 0, 1, pikepdf.Array([])])
def test_viewer_boolean_has_a_boolean_type(tmp_path, key, value):
    path = _document(tmp_path, lambda pdf: setattr(pdf.Root, 'ViewerPreferences', pikepdf.Dictionary({'/' + key: value})))
    with pytest.raises(ValueError, match='initial view'):
        get_initial_view(str(path))


@pytest.mark.parametrize('install', [
    lambda pdf: setattr(pdf.Root, 'MarkInfo', 42),
    lambda pdf: setattr(pdf.Root, 'MarkInfo', pikepdf.Dictionary(Marked=pikepdf.String('false'))),
    lambda pdf: setattr(pdf.Root, 'StructTreeRoot', 42),
    lambda pdf: setattr(pdf.Root, 'URI', pikepdf.Array([])),
    lambda pdf: setattr(pdf.Root, 'URI', pikepdf.Dictionary(Base=42)),
    lambda pdf: setattr(pdf.Root, 'PieceInfo', 42),
    lambda pdf: pdf.docinfo.__setitem__('/Trapped', pikepdf.String('True')),
    lambda pdf: pdf.docinfo.__setitem__('/Trapped', pikepdf.Name('/NotKnown')),
])
def test_unreadable_advanced_facts_do_not_become_absence(tmp_path, install):
    path = _document(tmp_path, install)
    before = path.read_bytes()
    with pytest.raises(ValueError, match='advanced properties'):
        get_advanced_properties(str(path))
    assert path.read_bytes() == before


def test_legitimate_absence_and_explicit_false_are_facts(tmp_path):
    path = _document(tmp_path, lambda pdf: None)
    advanced, view = get_advanced_properties(str(path)), get_initial_view(str(path))
    assert advanced['tagged'] is False and advanced['search_index'] is None
    assert advanced['has_open_action'] is False and advanced['trapped'] == 'unknown'
    assert view['page_layout'] == 'default' and view['open_page'] is None
    path = _document(tmp_path, lambda pdf: setattr(pdf.Root, 'ViewerPreferences', pikepdf.Dictionary(HideToolbar=False)))
    assert get_initial_view(str(path))['hide_toolbar'] is False


def test_physical_page_size_uses_crop_intersection_user_unit_and_inherited_rotation(tmp_path):
    def install(pdf):
        pdf.pages[0].CropBox = pikepdf.Array([-50, 10, 350, 390])
        pdf.pages[0].UserUnit = 2
        pdf.Root.Pages.Rotate = 90
        if '/Rotate' in pdf.pages[0].obj:
            del pdf.pages[0].obj['/Rotate']
    path = _document(tmp_path, install)
    assert get_advanced_properties(str(path))['page_sizes'] == [{'width': 760, 'height': 600, 'count': 1}]


@pytest.mark.parametrize('value', [0, -1, pikepdf.String('2'), True])
def test_invalid_physical_page_unit_is_unknown_not_default(tmp_path, value):
    path = _document(tmp_path, lambda pdf: setattr(pdf.pages[0], 'UserUnit', value))
    with pytest.raises(ValueError, match='advanced properties'):
        get_advanced_properties(str(path))
