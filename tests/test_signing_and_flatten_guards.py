"""Signer-certificate refusals, flatten stamping, and the signature verdict a
form fill reports when its rewrite stands over a signed original."""

import datetime
import os

import pikepdf
import pytest

from engine.forms import fill_form_fields
from engine.signatures import sign_pdf, verify_signatures


def _pki(tmp, not_before, not_after, digital_signature=True, non_repudiation=True):
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.hazmat.primitives.serialization import pkcs12
    from cryptography.x509.oid import NameOID

    def name(cn):
        return x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, cn)])

    ca_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    ca = (
        x509.CertificateBuilder().subject_name(name("CA")).issuer_name(name("CA"))
        .public_key(ca_key.public_key()).serial_number(1)
        .not_valid_before(datetime.datetime(2000, 1, 1))
        .not_valid_after(datetime.datetime(2100, 1, 1))
        .add_extension(x509.BasicConstraints(ca=True, path_length=None), critical=True)
        .sign(ca_key, hashes.SHA256())
    )
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    cert = (
        x509.CertificateBuilder().subject_name(name("Leaf")).issuer_name(name("CA"))
        .public_key(key.public_key()).serial_number(2)
        .not_valid_before(not_before).not_valid_after(not_after)
        .add_extension(x509.KeyUsage(
            digital_signature=digital_signature, content_commitment=non_repudiation,
            key_encipherment=not (digital_signature or non_repudiation),
            data_encipherment=False, key_agreement=False, key_cert_sign=False,
            crl_sign=False, encipher_only=False, decipher_only=False,
        ), critical=True)
        .sign(ca_key, hashes.SHA256())
    )
    path = os.path.join(tmp, "signer.pfx")
    with open(path, "wb") as f:
        f.write(pkcs12.serialize_key_and_certificates(
            b"s", key, cert, [ca], serialization.BestAvailableEncryption(b"pw")))
    return path


def _form(path, checkbox_ap=True, prefix=b""):
    pdf = pikepdf.new()
    page = pdf.add_blank_page(page_size=(400, 400))
    font = pdf.make_indirect(pikepdf.Dictionary(
        Type=pikepdf.Name.Font, Subtype=pikepdf.Name.Type1, BaseFont=pikepdf.Name.Helvetica))
    page.Contents = pdf.make_stream(prefix + b"0 0 1 rg 0 0 10 10 re f")
    text = pdf.make_indirect(pikepdf.Dictionary(
        Type=pikepdf.Name.Annot, Subtype=pikepdf.Name.Widget, FT=pikepdf.Name.Tx,
        T=pikepdf.String("name"), Rect=[50, 300, 250, 330], F=4,
        V=pikepdf.String("Ada"), DA=pikepdf.String("/Helv 10 Tf 0 g")))
    box = pikepdf.Dictionary(
        Type=pikepdf.Name.Annot, Subtype=pikepdf.Name.Widget, FT=pikepdf.Name.Btn,
        T=pikepdf.String("agree"), Rect=[50, 200, 70, 220], F=4,
        V=pikepdf.Name("/Yes"), AS=pikepdf.Name("/Yes"))
    if checkbox_ap:
        on = pdf.make_stream(b"0 0 20 20 re f", BBox=[0, 0, 20, 20])
        off = pdf.make_stream(b"", BBox=[0, 0, 20, 20])
        box.AP = pikepdf.Dictionary(N=pikepdf.Dictionary(Yes=on, Off=off))
    box = pdf.make_indirect(box)
    page.obj.Annots = pdf.make_indirect(pikepdf.Array([text, box]))
    pdf.Root.AcroForm = pdf.make_indirect(pikepdf.Dictionary(
        Fields=pikepdf.Array([text, box]), DA=pikepdf.String("/Helv 10 Tf 0 g"),
        DR=pikepdf.Dictionary(Font=pikepdf.Dictionary(Helv=font))))
    pdf.save(path)
    return path


@pytest.mark.parametrize("window, match", [
    ((datetime.datetime(2000, 1, 1), datetime.datetime(2001, 1, 1)), "expired"),
    ((datetime.datetime(2090, 1, 1), datetime.datetime(2100, 1, 1)), "not valid until"),
])
def test_a_certificate_outside_its_validity_period_refuses(tmp_path, window, match):
    pfx = _pki(str(tmp_path), *window)
    src = _form(str(tmp_path / "in.pdf"))
    out = str(tmp_path / "out.pdf")
    with pytest.raises(ValueError, match=match):
        sign_pdf(src, out, pfx_path=pfx, password="pw", pades=True)
    assert not os.path.exists(out)


def test_a_certificate_without_a_signing_key_usage_refuses(tmp_path):
    pfx = _pki(str(tmp_path), datetime.datetime(2000, 1, 1), datetime.datetime(2100, 1, 1),
               digital_signature=False, non_repudiation=False)
    src = _form(str(tmp_path / "in.pdf"))
    with pytest.raises(ValueError, match="key usage"):
        sign_pdf(src, str(tmp_path / "out.pdf"), pfx_path=pfx, password="pw")


@pytest.mark.parametrize("ds, nr", [(True, False), (False, True)])
def test_either_signing_key_usage_bit_is_enough(tmp_path, ds, nr):
    pfx = _pki(str(tmp_path), datetime.datetime(2000, 1, 1), datetime.datetime(2100, 1, 1),
               digital_signature=ds, non_repudiation=nr)
    src = _form(str(tmp_path / "in.pdf"))
    assert sign_pdf(src, str(tmp_path / "out.pdf"), pfx_path=pfx, password="pw")["valid"]


def test_a_fill_that_breaks_a_signature_says_so(tmp_path):
    pfx = _pki(str(tmp_path), datetime.datetime(2000, 1, 1), datetime.datetime(2100, 1, 1))
    src = _form(str(tmp_path / "in.pdf"))
    signed = str(tmp_path / "signed.pdf")
    sign_pdf(src, signed, pfx_path=pfx, password="pw")
    kept = fill_form_fields(signed, str(tmp_path / "kept.pdf"), {"name": "Bob"})
    assert kept.get("signatures_preserved") is True
    assert "signatures_invalidated" not in kept
    flat = fill_form_fields(signed, str(tmp_path / "flat.pdf"), {}, flatten=True)
    assert flat["signatures_invalidated"] is True
    assert flat["signatures_invalidated_reason"]
    unsigned = fill_form_fields(src, str(tmp_path / "plain.pdf"), {"name": "Bob"})
    assert "signatures_invalidated" not in unsigned


def test_flatten_closes_the_page_graphics_state_before_stamping(tmp_path):
    src = _form(str(tmp_path / "in.pdf"), prefix=b"q 0.1 0 0 0.1 0 0 cm q 0.5 g ")
    out = str(tmp_path / "out.pdf")
    fill_form_fields(src, out, {}, flatten=True)
    with pikepdf.open(out) as pdf:
        ops = pikepdf.parse_content_stream(pdf.pages[0])
    depth = 0
    for _operands, operator in ops:
        name = str(operator)
        if name == "q":
            depth += 1
        elif name == "Q":
            depth -= 1
        elif name == "Do":
            assert depth == 1, "a stamp drew inside the page's leftover state"
    assert depth == 0


def test_flatten_draws_a_text_field_that_has_no_appearance(tmp_path):
    src = _form(str(tmp_path / "in.pdf"))
    out = str(tmp_path / "out.pdf")
    fill_form_fields(src, out, {}, flatten=True)
    with pikepdf.open(out) as pdf:
        xobjects = pdf.pages[0].Resources.XObject
        drawn = [bytes(x.read_bytes()) for x in xobjects.values()]
    assert any(b"Ada" in d for d in drawn)


def test_flatten_refuses_a_checked_box_with_no_appearance_by_name(tmp_path):
    src = _form(str(tmp_path / "in.pdf"), checkbox_ap=False)
    out = str(tmp_path / "out.pdf")
    with pytest.raises(ValueError, match="agree"):
        fill_form_fields(src, out, {}, flatten=True)
    assert not os.path.exists(out)
