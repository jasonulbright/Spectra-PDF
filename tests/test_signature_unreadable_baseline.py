"""A malformed baseline affects policy analysis, not the signed digest."""
from pathlib import Path

import pikepdf
import pytest
from pyhanko.pdf_utils import generic
from pyhanko.pdf_utils.incremental_writer import IncrementalPdfFileWriter

from engine.signatures import sign_pdf, verify_signatures
from test_pades import _build_pki


@pytest.fixture(scope='module')
def pki(tmp_path_factory):
    return _build_pki(str(tmp_path_factory.mktemp('unreadable-baseline-pki')))


@pytest.mark.parametrize('malformed', [False, True])
@pytest.mark.parametrize('certified', [False, True])
def test_signed_name_field_keeps_cryptographic_verdict(tmp_path, pki, malformed, certified):
    pdf = pikepdf.new()
    page = pdf.add_blank_page()
    field = pdf.make_indirect(pikepdf.Dictionary(FT=pikepdf.Name.Tx,
        T=pikepdf.Name('/entry') if malformed else pikepdf.String('entry'),
        Type=pikepdf.Name.Annot, Subtype=pikepdf.Name.Widget, Rect=[0, 0, 100, 20],
        V=pikepdf.String('old'), P=page.obj))
    page.Annots = pikepdf.Array([field])
    pdf.Root.AcroForm = pikepdf.Dictionary(Fields=pikepdf.Array([field]))
    source, signed, revised = [tmp_path / name for name in ['source.pdf', 'signed.pdf', 'revised.pdf']]
    pdf.save(source)
    kwargs = {'certify': True, 'certify_level': 'annotate'} if certified else {}
    sign_pdf(str(source), str(signed), pfx_path=pki['pfx'], password='pw', **kwargs)
    before = verify_signatures(str(signed))['signatures'][0]
    assert before['valid'] and before['intact'], before
    # Append an allowed metadata change without rewriting any signed byte.
    with signed.open('rb') as original, revised.open('wb') as output:
        writer = IncrementalPdfFileWriter(original)
        writer.set_info(writer.add_object(generic.DictionaryObject({
            generic.pdf_name('/Title'): generic.pdf_string('new title'),
        })))
        writer.write(output)
    assert revised.read_bytes().startswith(signed.read_bytes())
    result = verify_signatures(str(revised))['signatures'][0]
    assert result['valid'] and result['intact'], result
    assert result['modified_after_signing']
    if malformed:
        assert result['policy_judged'] is False and result['policy_ok'] is None
        assert 'Names must be strings' in result['error']
    else:
        assert result['policy_ok'] is True


def test_a_broken_digest_is_still_invalid(tmp_path, pki):
    pdf = pikepdf.new()
    page = pdf.add_blank_page()
    page.Contents = pdf.make_stream(b'q Q')
    source, signed = tmp_path / 'source.pdf', tmp_path / 'signed.pdf'
    pdf.save(source)
    sign_pdf(str(source), str(signed), pfx_path=pki['pfx'], password='pw')
    raw = signed.read_bytes()
    # Same-length change to signed bytes keeps the PDF readable.
    assert b'/MediaBox' in raw
    altered = raw.replace(b'/MediaBox', b'/CropBox ', 1)
    damaged = tmp_path / 'damaged.pdf'
    damaged.write_bytes(altered)
    result = verify_signatures(str(damaged))['signatures'][0]
    assert not result['intact']
