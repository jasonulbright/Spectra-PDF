"""Header/catalog precedence, independent of pikepdf's header-only property."""
import pikepdf
import pytest

from engine.pdf_version import effective_version


@pytest.mark.parametrize('header,catalog,expected', [
    ('1.3', None, (1, 3)), ('1.3', '/1.7', (1, 7)),
    ('1.7', '/2.0', (2, 0)), ('2.0', '/1.7', (2, 0)),
])
def test_effective_precedence(tmp_path, header, catalog, expected):
    path = tmp_path / 'input.pdf'
    with pikepdf.new() as pdf:
        pdf.add_blank_page()
        if catalog is not None:
            pdf.Root.Version = pikepdf.Name(catalog)
        pdf.save(path, force_version=header)
    # qpdf may adjust declarations during save. Set the catalog in the loaded
    # object so this control proves the precise declared pair being evaluated.
    with pikepdf.open(path) as pdf:
        if catalog is not None:
            pdf.Root.Version = pikepdf.Name(catalog)
        assert pdf.pdf_version == header
        assert effective_version(pdf) == expected


@pytest.mark.parametrize('value', [pikepdf.String('2.0'), 2, pikepdf.Name('/2.1'), pikepdf.Name('/garbage')])
def test_unreadable_catalog_version_refuses(value):
    with pikepdf.new() as pdf:
        pdf.Root.Version = value
        with pytest.raises(ValueError, match='The PDF version cannot be determined'):
            effective_version(pdf)
