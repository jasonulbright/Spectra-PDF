"""Version changes must tell the truth without damaging the destination."""
import os
from pathlib import Path

import pikepdf
import pytest

from engine import reversion
from engine.pdf_save import encryption_profile
from engine.pdf_version import effective_version


def source_pdf(path, header='1.3', catalog='/2.0'):
    objects = [
        b'<< /Type /Catalog /Pages 2 0 R ' + (b'/Version ' + catalog.encode() if catalog else b'') + b' >>',
        b'<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
        b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 700] /Resources <<>> >>',
    ]
    data = bytearray(f'%PDF-{header}\n'.encode())
    offsets = []
    for index, obj in enumerate(objects, 1):
        offsets.append(len(data))
        data.extend(f'{index} 0 obj\n'.encode() + obj + b'\nendobj\n')
    xref = len(data)
    data.extend(b'xref\n0 4\n0000000000 65535 f \n')
    for offset in offsets:
        data.extend(f'{offset:010d} 00000 n \n'.encode())
    data.extend(f'trailer\n<< /Root 1 0 R /Size 4 >>\nstartxref\n{xref}\n%%EOF\n'.encode())
    path.write_bytes(data)
    return bytes(data)


@pytest.mark.parametrize('header,catalog,expected', [
    ('1.3', '/2.0', '2.0'), ('2.0', '/1.3', '2.0'),
    ('1.7', '/1.7', '1.7'), ('1.3', None, '1.3'),
])
def test_get_labels_declarations(tmp_path, header, catalog, expected):
    source = tmp_path / 'input.pdf'
    before = source_pdf(source, header, catalog)
    facts = reversion.get_pdf_version(str(source))
    assert facts['version'] == expected
    assert facts['header_version'] == header
    assert facts['catalog_version'] == (catalog[1:] if catalog else None)
    assert source.read_bytes() == before


@pytest.mark.parametrize('destination', ['new', 'existing', 'inplace', 'hardlink'])
def test_unprovable_downgrade_never_publishes(tmp_path, destination):
    source = tmp_path / 'input.pdf'
    before = source_pdf(source)
    output = source if destination == 'inplace' else tmp_path / 'output.pdf'
    if destination == 'existing':
        output.write_bytes(b'keep existing destination')
    if destination == 'hardlink':
        os.link(source, output)
    previous = output.read_bytes() if output.exists() else None
    files = set(tmp_path.iterdir())
    with pytest.raises(ValueError, match='cannot be lowered'):
        reversion.set_pdf_version(str(source), str(output), '1.7')
    assert source.read_bytes() == before
    assert (output.read_bytes() if output.exists() else None) == previous
    assert set(tmp_path.iterdir()) == files


@pytest.mark.parametrize('target', ['', '1.7 ', '01.7', '1.7.0', '1.8', '2.1', 'garbage', None, 1.7])
def test_invalid_request_is_not_coerced(tmp_path, target):
    source, output = tmp_path / 'input.pdf', tmp_path / 'output.pdf'
    source_pdf(source)
    output.write_bytes(b'keep')
    with pytest.raises(ValueError, match='version cannot be determined'):
        reversion.set_pdf_version(str(source), str(output), target)
    assert output.read_bytes() == b'keep'


@pytest.mark.parametrize('same_path', [False, True])
def test_raise_reconciles_declarations_and_preserves_source(tmp_path, same_path):
    source = tmp_path / 'input.pdf'
    before = source_pdf(source, '1.3', '/1.4')
    output = source if same_path else tmp_path / 'output.pdf'
    result = reversion.set_pdf_version(str(source), str(output), '1.7')
    assert result['original_version'] == '1.4'
    assert result['original_header_version'] == '1.3'
    assert result['effective_version'] == result['target_version'] == '1.7'
    assert result['original_size'] == len(before)
    assert result['changed'] is True
    with pikepdf.open(output) as pdf:
        assert effective_version(pdf) == (1, 7)
    if not same_path:
        assert source.read_bytes() == before


def test_equal_version_copies_bytes_without_rewriting(tmp_path):
    source, output = tmp_path / 'input.pdf', tmp_path / 'output.pdf'
    before = source_pdf(source)
    result = reversion.set_pdf_version(str(source), str(output), '2.0')
    assert output.read_bytes() == source.read_bytes() == before
    assert result['changed'] is False
    assert result['header_version'] == '1.3'
    assert result['catalog_version'] == result['effective_version'] == '2.0'


def test_wrong_written_declaration_refuses_before_replacing(tmp_path, monkeypatch):
    source, output = tmp_path / 'input.pdf', tmp_path / 'output.pdf'
    source_pdf(source, '1.3', None)
    output.write_bytes(b'keep')
    real_save = reversion.save_pdf
    def wrong_save(pdf, path, **kwargs):
        pdf.Root.Version = pikepdf.Name('/2.0')
        real_save(pdf, path, **kwargs)
    monkeypatch.setattr(reversion, 'save_pdf', wrong_save)
    with pytest.raises(ValueError, match='does not declare the requested version'):
        reversion.set_pdf_version(str(source), str(output), '1.7')
    assert output.read_bytes() == b'keep'
    assert len(list(tmp_path.iterdir())) == 2


def test_wrong_written_metadata_refuses_before_replacing(tmp_path, monkeypatch):
    source, output = tmp_path / 'input.pdf', tmp_path / 'output.pdf'
    source_pdf(source, '1.3', None)
    output.write_bytes(b'keep')
    real_save = reversion.save_pdf
    def wrong_save(pdf, path, **kwargs):
        pdf.Root.Metadata = pdf.make_stream(b'<r xmlns:p="http://ns.adobe.com/pdf/1.3/" p:PDFVersion="1.3"/>')
        real_save(pdf, path, **kwargs)
    monkeypatch.setattr(reversion, 'save_pdf', wrong_save)
    with pytest.raises(ValueError, match='does not declare the requested version'):
        reversion.set_pdf_version(str(source), str(output), '1.7')
    assert output.read_bytes() == b'keep'


def test_interrupted_write_does_not_publish_or_leave_staging(tmp_path, monkeypatch):
    source, output = tmp_path / 'input.pdf', tmp_path / 'output.pdf'
    before = source_pdf(source, '1.3', None)
    output.write_bytes(b'keep')
    def interrupted(_pdf, path, **_kwargs):
        Path(path).write_bytes(b'partial')
        raise KeyboardInterrupt()
    monkeypatch.setattr(reversion, 'save_pdf', interrupted)
    with pytest.raises(KeyboardInterrupt):
        reversion.set_pdf_version(str(source), str(output), '1.7')
    assert output.read_bytes() == b'keep' and source.read_bytes() == before
    assert len(list(tmp_path.iterdir())) == 2


def test_raise_retains_actual_encryption_profile(tmp_path):
    source, output = tmp_path / 'encrypted.pdf', tmp_path / 'output.pdf'
    with pikepdf.new() as pdf:
        pdf.add_blank_page()
        pdf.save(source, min_version='1.6', encryption=pikepdf.Encryption(owner='', user='', R=4, aes=True))
    with pikepdf.open(source) as pdf:
        protection = encryption_profile(pdf)
    reversion.set_pdf_version(str(source), str(output), '2.0')
    with pikepdf.open(output) as pdf:
        assert pdf.is_encrypted and encryption_profile(pdf) == protection
        assert effective_version(pdf) == (2, 0)


def test_lost_encryption_refuses_before_publication(tmp_path, monkeypatch):
    source, output = tmp_path / 'encrypted.pdf', tmp_path / 'output.pdf'
    with pikepdf.new() as pdf:
        pdf.add_blank_page()
        pdf.save(source, encryption=pikepdf.Encryption(owner='', user='', R=4, aes=True))
    before = source.read_bytes()
    output.write_bytes(b'keep')
    monkeypatch.setattr(reversion, 'save_pdf', lambda pdf, path, **kwargs: pdf.save(path, encryption=False, **kwargs))
    with pytest.raises(ValueError, match='did not preserve.*encryption'):
        reversion.set_pdf_version(str(source), str(output), '2.0')
    assert output.read_bytes() == b'keep' and source.read_bytes() == before


def test_raise_signed_version_is_an_append(tmp_path):
    source = Path(__file__).resolve().parents[1] / 'e2e-tests/fixtures/signed.pdf'
    output = tmp_path / 'raised.pdf'
    before = source.read_bytes()
    result = reversion.set_pdf_version(str(source), str(output), '2.0')
    assert result['signatures_preserved'] is True
    assert result['changed'] is True
    assert output.read_bytes().startswith(before)
    with pikepdf.open(output) as pdf:
        assert effective_version(pdf) == (2, 0)


def test_signed_refusal_cannot_fall_back_to_rewrite(tmp_path, monkeypatch):
    from engine import incremental
    source, output = tmp_path / 'input.pdf', tmp_path / 'output.pdf'
    source_pdf(source, '1.3', None)
    output.write_bytes(b'keep')
    monkeypatch.setattr(incremental, 'finalize_preserving_signatures', lambda *_, **__: {'preserved': False, 'reason': 'catalog-changed'})
    with pytest.raises(ValueError, match='preserving.*signatures'):
        reversion.set_pdf_version(str(source), str(output), '1.7')
    assert output.read_bytes() == b'keep'


@pytest.mark.parametrize('kind', ['pdfa-attribute', 'pdfx-info', 'pdfua-element', 'malformed'])
def test_version_raise_does_not_invalidate_a_conformance_claim(tmp_path, kind):
    source, output = tmp_path / 'input.pdf', tmp_path / 'output.pdf'
    with pikepdf.new() as pdf:
        pdf.add_blank_page()
        if kind == 'pdfx-info':
            pdf.docinfo['/GTS_PDFXVersion'] = 'PDF/X-4'
        else:
            raw = {
                'pdfa-attribute': b'<r xmlns:a="http://www.aiim.org/pdfa/ns/id/" a:part="1"/>',
                'pdfua-element': b'<r xmlns:q="http://www.aiim.org/pdfua/ns/id/"><q:part>1</q:part></r>',
                'malformed': b'<broken',
            }[kind]
            pdf.Root.Metadata = pdf.make_stream(raw)
        pdf.save(source, force_version='1.4', fix_metadata_version=False)
    before = source.read_bytes()
    output.write_bytes(b'keep')
    with pytest.raises(ValueError, match='conformance declarations'):
        reversion.set_pdf_version(str(source), str(output), '2.0')
    assert output.read_bytes() == b'keep' and source.read_bytes() == before


def test_ordinary_xmp_and_extensions_survive_a_raise(tmp_path):
    source, output = tmp_path / 'input.pdf', tmp_path / 'output.pdf'
    raw = b'<r xmlns:d="urn:private"><d:note>Keep unknown content</d:note></r>'
    with pikepdf.new() as pdf:
        pdf.add_blank_page()
        pdf.Root.Metadata = pdf.make_stream(raw)
        pdf.Root.Extensions = pikepdf.Dictionary(TEST=pikepdf.Dictionary(BaseVersion=pikepdf.Name('/1.7'), ExtensionLevel=3))
        pdf.save(source, force_version='1.7', fix_metadata_version=False)
    reversion.set_pdf_version(str(source), str(output), '2.0')
    with pikepdf.open(output) as pdf:
        assert pdf.Root.Metadata.read_bytes() == raw
        assert pdf.Root.Extensions.TEST.ExtensionLevel == 3


@pytest.mark.parametrize('encoding', ['utf-8', 'utf-16'])
def test_metadata_version_changes_without_losing_unknown_xml(tmp_path, encoding):
    from lxml import etree
    source, output = tmp_path / 'input.pdf', tmp_path / 'output.pdf'
    text = f'''<?xml version="1.0" encoding="{encoding}"?><?custom keep?>
    <x:xmpmeta xmlns:x="adobe:ns:meta/" xmlns:r="http://www.w3.org/1999/02/22-rdf-syntax-ns#"
     xmlns:p="http://ns.adobe.com/pdf/1.3/" xmlns:private="urn:private" xmlns:value="urn:value">
     <r:RDF><r:Description p:PDFVersion="1.3" private:kind="value:unchanged">
       <!-- keep comment --><p:PDFVersion>1.3</p:PDFVersion><private:note>é and 中</private:note>
     </r:Description></r:RDF></x:xmpmeta><?custom after?>'''
    with pikepdf.new() as pdf:
        pdf.add_blank_page()
        pdf.Root.Metadata = pdf.make_stream(text.encode(encoding))
        pdf.save(source, force_version='1.3', fix_metadata_version=False)
    reversion.set_pdf_version(str(source), str(output), '1.7')
    with pikepdf.open(output) as pdf:
        raw = pdf.Root.Metadata.read_bytes()
    root = etree.fromstring(raw)
    assert root.xpath('//*[local-name()="PDFVersion"]/text()') == ['1.7']
    assert root.xpath('//@*[local-name()="PDFVersion"]') == ['1.7']
    assert root.xpath('//*[local-name()="note"]/text()') == ['é and 中']
    assert root.xpath('//@*[local-name()="kind"]') == ['value:unchanged']
    assert root.nsmap['value'] == 'urn:value'
    assert len(root.xpath('//comment()')) == 1
    assert len(root.getroottree().xpath('/processing-instruction("custom")')) == 2


def test_unreadable_version_fact_has_only_the_named_error():
    from engine.pdf_version import version_facts
    class Unreadable:
        def get(self, _key):
            raise ValueError('private/source/path.pdf: arbitrary parser details')
    class Document:
        pdf_version = '1.4'
        Root = Unreadable()
    with pytest.raises(ValueError) as error:
        version_facts(Document())
    assert str(error.value) == 'The PDF version cannot be determined.'


def test_bare_header_is_a_check_error_not_an_index_exception(tmp_path):
    from engine.check import check
    source = tmp_path / 'header.pdf'
    source.write_bytes(b'%PDF-')
    assert check(str(source))['valid'] is False


def test_readable_protection_is_not_reported_as_unencrypted(tmp_path):
    from engine.check import check
    source = tmp_path / 'protected.pdf'
    with pikepdf.new() as pdf:
        pdf.add_blank_page()
        pdf.save(source, encryption=pikepdf.Encryption(owner='owner', user=''))
    report = check(str(source))
    assert report['info']['encrypted'] is True
    assert report['info']['pdf_version']


@pytest.mark.parametrize('certified', [False, True])
def test_signed_version_metadata_is_not_silently_left_behind(tmp_path, certified):
    from test_pades import _build_pki
    from engine.signatures import sign_pdf
    source, signed, output = (tmp_path / name for name in ('base.pdf', 'signed.pdf', 'output.pdf'))
    with pikepdf.new() as pdf:
        pdf.add_blank_page()
        pdf.Root.Metadata = pdf.make_stream(b'<x:xmpmeta xmlns:x="adobe:ns:meta/"><r:RDF xmlns:r="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><r:Description xmlns:p="http://ns.adobe.com/pdf/1.3/" p:PDFVersion="1.7"/></r:RDF></x:xmpmeta>')
        pdf.Root.Metadata['/OwnerCatalog'] = pdf.Root
        pdf.save(source, min_version='1.7', fix_metadata_version=False)
    pki_dir = tmp_path / 'pki'
    pki_dir.mkdir()
    pki = _build_pki(str(pki_dir))
    sign_pdf(str(source), str(signed), pfx_path=pki['pfx'], password='pw', **({'certify': True} if certified else {}))
    before = signed.read_bytes()
    with pikepdf.open(signed) as pdf:
        assert b'1.7' in pdf.Root.Metadata.read_bytes()
        identity = pdf.Root.Metadata.objgen
    output.write_bytes(b'keep')
    if certified:
        with pytest.raises(ValueError, match='preserving.*signatures'):
            reversion.set_pdf_version(str(signed), str(output), '2.0')
        assert output.read_bytes() == b'keep' and signed.read_bytes() == before
        # The same certified document can still be copied without an edit.
        result = reversion.set_pdf_version(str(signed), str(output), reversion.get_pdf_version(str(signed))['version'])
        assert result['changed'] is False and result['signatures_preserved'] is True
        assert output.read_bytes() == before
        return
    reversion.set_pdf_version(str(signed), str(output), '2.0')
    assert output.read_bytes().startswith(before)
    with pikepdf.open(output) as pdf:
        from lxml import etree
        root = etree.fromstring(pdf.Root.Metadata.read_bytes())
        assert root.xpath('//*[local-name()="PDFVersion"]/text() | //@*[local-name()="PDFVersion"]') == ['2.0']
        assert pdf.Root.Metadata.objgen == identity
        assert pdf.Root.Metadata.OwnerCatalog.objgen == pdf.Root.objgen
