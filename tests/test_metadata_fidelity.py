"""Metadata reads preserve ordinary Info-only documents and refuse false facts."""
import pikepdf
import pytest
from engine.metadata import get_metadata, set_metadata, strip_metadata
from engine.doc_properties import set_document_title


def source(tmp_path):
    path = tmp_path / 'source.pdf'
    with pikepdf.new() as pdf:
        pdf.add_blank_page()
        pdf.docinfo['/Title'] = 'Visible title'
        pdf.docinfo['/Author'] = 'Original author'
        pdf.docinfo['/CreationDate'] = 'D:20200101000000Z'
        pdf.docinfo['/Private'] = 'Keep private Info'
        pdf.save(path, fix_metadata_version=False)
    return path


def test_info_only_title_and_author_are_not_reported_absent(tmp_path):
    path = source(tmp_path); before = path.read_bytes()
    result = get_metadata(str(path))
    assert result['title'] == 'Visible title'
    assert result['author'] == 'Original author'
    assert path.read_bytes() == before


@pytest.mark.parametrize('writer', [set_metadata, set_document_title])
def test_one_field_edit_does_not_rewrite_unrelated_info(tmp_path, writer):
    path = source(tmp_path); output = tmp_path / 'output.pdf'
    writer(str(path), str(output), title='Changed title')
    with pikepdf.open(output) as pdf:
        assert str(pdf.docinfo.Title) == 'Changed title'
        assert str(pdf.docinfo.Author) == 'Original author'
        assert str(pdf.docinfo.CreationDate) == 'D:20200101000000Z'
        assert str(pdf.docinfo.Private) == 'Keep private Info'
    assert get_metadata(str(output))['author'] == 'Original author'


@pytest.mark.parametrize('kind', ['malformed-xml', 'wrong-stream-type', 'wrong-info-type'])
def test_malformed_declared_metadata_cannot_become_an_empty_baseline(tmp_path, kind):
    path = source(tmp_path)
    with pikepdf.open(path, allow_overwriting_input=True) as pdf:
        if kind == 'malformed-xml': pdf.Root.Metadata = pdf.make_stream(b'not xml')
        elif kind == 'wrong-stream-type': pdf.Root.Metadata = 42
        else: pdf.docinfo.Title = 42
        pdf.save(path, fix_metadata_version=False)
    with pikepdf.open(path) as pdf:
        if kind == 'malformed-xml': assert pdf.Root.Metadata.read_bytes() == b'not xml'
        elif kind == 'wrong-stream-type': assert pdf.Root.Metadata == 42
        else: assert pdf.docinfo.Title == 42
    before = path.read_bytes(); output = tmp_path / 'existing.pdf'; output.write_bytes(b'unchanged output')
    with pytest.raises(ValueError, match='metadata cannot be read'):
        get_metadata(str(path))
    with pytest.raises(ValueError, match='metadata cannot be read'):
        set_metadata(str(path), str(output), author='Changed')
    assert path.read_bytes() == before; assert output.read_bytes() == b'unchanged output'


def test_explicit_strip_can_remove_unreadable_metadata_without_guessing_it(tmp_path):
    path = source(tmp_path); output = tmp_path / 'stripped.pdf'
    with pikepdf.open(path, allow_overwriting_input=True) as pdf:
        pdf.Root.Metadata = pdf.make_stream(b'not xml'); pdf.save(path, fix_metadata_version=False)
    strip_metadata(str(path), str(output))
    result = get_metadata(str(output))
    assert result['title'] == result['author'] == ''


def test_xmp_precedence_and_author_sequence_survive_an_unrelated_edit(tmp_path):
    path = source(tmp_path); output = tmp_path / 'copy.pdf'
    with pikepdf.open(path, allow_overwriting_input=True) as pdf:
        with pdf.open_metadata(update_docinfo=False) as meta:
            meta['dc:title'] = 'XMP title'
            meta['dc:creator'] = ['First author', 'Second author']
        pdf.save(path, fix_metadata_version=False)
    before = get_metadata(str(path))
    assert before['title'] == 'XMP title'
    assert before['author'] == ['First author', 'Second author']
    set_metadata(str(path), str(output), subject='New subject')
    after = get_metadata(str(output))
    assert after['author'] == before['author'] and after['title'] == before['title']
    with pikepdf.open(output) as pdf:
        assert str(pdf.docinfo.Title) == 'Visible title'
        assert str(pdf.docinfo.Author) == 'Original author'


@pytest.mark.parametrize('key, xmp_key, empty', [('title', 'dc:title', ''), ('author', 'dc:creator', [])])
def test_explicit_empty_xmp_is_not_absence(tmp_path, key, xmp_key, empty):
    path = source(tmp_path)
    with pikepdf.open(path, allow_overwriting_input=True) as pdf:
        with pdf.open_metadata(update_docinfo=False) as meta:
            meta[xmp_key] = empty
        pdf.save(path, fix_metadata_version=False)
    assert get_metadata(str(path))[key] == empty


def xmp_source(tmp_path, body):
    path = source(tmp_path)
    data = ('<x:xmpmeta xmlns:x="adobe:ns:meta/" '
            'xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" '
            'xmlns:dc="http://purl.org/dc/elements/1.1/">'
            '<rdf:RDF><rdf:Description rdf:about="">' + body +
            '</rdf:Description></rdf:RDF></x:xmpmeta>').encode()
    with pikepdf.open(path, allow_overwriting_input=True) as pdf:
        pdf.Root.Metadata = pdf.make_stream(data)
        pdf.Root.Metadata.Private = 'Retain stream declaration'
        pdf.save(path, fix_metadata_version=False)
    return path


@pytest.mark.parametrize('writer', [set_metadata, set_document_title])
def test_language_default_is_read_and_other_languages_survive_an_edit(tmp_path, writer):
    from lxml import etree
    path = xmp_source(tmp_path, '<dc:title><rdf:Alt>'
        '<rdf:li xml:lang="fr">Titre</rdf:li><rdf:li xml:lang="x-default">Default</rdf:li>'
        '</rdf:Alt></dc:title>')
    assert get_metadata(str(path))['title'] == 'Default'
    output = tmp_path / 'output.pdf'
    writer(str(path), str(output), title='Changed')
    with pikepdf.open(output) as pdf:
        root = etree.fromstring(pdf.Root.Metadata.read_bytes())
        items = root.findall('.//{http://www.w3.org/1999/02/22-rdf-syntax-ns#}li')
        assert {item.get('{http://www.w3.org/XML/1998/namespace}lang'): item.text for item in items} == {
            'fr': 'Titre', 'x-default': 'Changed'}
        assert str(pdf.Root.Metadata.Private) == 'Retain stream declaration'
    assert get_metadata(str(output))['title'] == 'Changed'


@pytest.mark.parametrize('body', [
    '<dc:title>First</dc:title><dc:title>Second</dc:title>',
    '<dc:title rdf:resource="https://example.invalid/value"/>',
    '<dc:title><rdf:Alt><rdf:li xml:lang="x-default">One</rdf:li>'
        '<rdf:li xml:lang="x-default">Two</rdf:li></rdf:Alt></dc:title>',
    '<dc:creator><rdf:Seq><rdf:li rdf:resource="https://example.invalid/author"/></rdf:Seq></dc:creator>',
    '<dc:title><rdf:Bag><rdf:li>Wrong shape</rdf:li></rdf:Bag></dc:title>',
])
def test_ambiguous_or_structured_properties_refuse_without_publication(tmp_path, body):
    path = xmp_source(tmp_path, body); before = path.read_bytes()
    output = tmp_path / 'output.pdf'; output.write_bytes(b'keep output')
    with pytest.raises(ValueError, match='metadata cannot be read'):
        get_metadata(str(path))
    with pytest.raises(ValueError, match='metadata cannot be read'):
        set_metadata(str(path), str(output), title='Changed')
    with pytest.raises(ValueError, match='metadata cannot be read'):
        set_document_title(str(path), str(output), title='Changed', display=True)
    assert path.read_bytes() == before and output.read_bytes() == b'keep output'


@pytest.mark.parametrize('field, element', [('title', 'dc:title'), ('keywords', 'pdf:Keywords')])
def test_comment_separated_character_data_reads_and_replaces_whole_value(tmp_path, field, element):
    body = f'<{element} xmlns:pdf="http://ns.adobe.com/pdf/1.3/">Ti<!-- note -->tle</{element}>'
    path = xmp_source(tmp_path, body)
    assert get_metadata(str(path))[field] == 'Title'
    output = tmp_path / 'output.pdf'
    set_metadata(str(path), str(output), **{field: 'Replacement'})
    assert get_metadata(str(output))[field] == 'Replacement'


def test_display_only_change_preserves_unreadable_metadata_bytes(tmp_path):
    path = source(tmp_path); output = tmp_path / 'output.pdf'
    with pikepdf.open(path, allow_overwriting_input=True) as pdf:
        pdf.Root.Metadata = pdf.make_stream(b'not xml')
        pdf.save(path, fix_metadata_version=False)
    set_document_title(str(path), str(output), display=True)
    with pikepdf.open(output) as pdf:
        assert pdf.Root.Metadata.read_bytes() == b'not xml'
        assert pdf.Root.ViewerPreferences.DisplayDocTitle is True


@pytest.mark.parametrize('operation', [set_metadata, strip_metadata])
def test_failure_does_not_publish_partial_metadata_output(tmp_path, monkeypatch, operation):
    from engine import metadata
    path = source(tmp_path); output = tmp_path / 'existing.pdf'; output.write_bytes(b'original destination')
    def fail(pdf, destination, **kwargs):
        destination.write_bytes(b'partial output')
        raise RuntimeError('injected save failure')
    monkeypatch.setattr(metadata, 'save_pdf', fail)
    with pytest.raises(RuntimeError, match='injected'):
        operation(str(path), str(output))
    assert output.read_bytes() == b'original destination'
