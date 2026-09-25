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


def _annotated(path):
    pdf = pikepdf.new()
    page = pdf.add_blank_page(page_size=(400, 400))
    note = pdf.make_indirect(pikepdf.Dictionary(
        Type=pikepdf.Name.Annot, Subtype=pikepdf.Name.Text,
        Rect=[20, 20, 40, 40], Contents=pikepdf.String("note")))
    page.obj.Annots = pdf.make_indirect(pikepdf.Array([note]))
    pdf.save(path)
    return path


def _signed(tmp_path, level):
    pfx = _pki(str(tmp_path), datetime.datetime(2000, 1, 1), datetime.datetime(2100, 1, 1))
    src = _annotated(str(tmp_path / "annotated.pdf"))
    out = str(tmp_path / f"signed-{level}.pdf")
    kw = {"certify": True, "certify_level": level} if level else {}
    sign_pdf(src, out, pfx_path=pfx, password="pw", **kw)
    return src, out


def _door(name, src, signed, out):
    if name == "annotations":
        from engine.annotations import delete_all_annotations
        return delete_all_annotations(signed, out)
    if name == "links":
        from engine.links import add_links
        return add_links(signed, out, [{"page": 1, "rect": [100, 100, 200, 120],
                                         "url": "https://example.com"}])
    if name == "redact_marks":
        from engine.redact_marks import save_redaction_marks
        return save_redaction_marks(signed, out, [{"page": 1, "rect": [100, 100, 200, 120]}])
    from engine.xfdf import export_xfdf, import_xfdf
    xfdf = out + ".xfdf"
    export_xfdf(src, xfdf)
    return import_xfdf(signed, xfdf, out)


@pytest.mark.parametrize("door", ["annotations", "links", "redact_marks", "xfdf"])
def test_each_annotation_door_says_when_it_breaks_a_signature(tmp_path, door):
    src, signed = _signed(tmp_path, "none")
    result = _door(door, src, signed, str(tmp_path / "out.pdf"))
    assert result["signatures_invalidated"] is True
    assert result["signatures_invalidated_reason"].startswith("certified-none-forbids-")
    assert "signatures_preserved" not in result
    assert verify_signatures(str(tmp_path / "out.pdf"))["signatures"][0]["intact"] is False


@pytest.mark.parametrize("door", ["annotations", "links", "redact_marks", "xfdf"])
def test_each_annotation_door_keeps_an_approval_signature(tmp_path, door):
    src, signed = _signed(tmp_path, None)
    result = _door(door, src, signed, str(tmp_path / "out.pdf"))
    assert result.get("signatures_preserved") is True
    assert "signatures_invalidated" not in result


def _text_form(path, **extra):
    pdf = pikepdf.new()
    page = pdf.add_blank_page(page_size=(400, 400))
    font = pdf.make_indirect(pikepdf.Dictionary(
        Type=pikepdf.Name.Font, Subtype=pikepdf.Name.Type1, BaseFont=pikepdf.Name.Helvetica))
    field = pdf.make_indirect(pikepdf.Dictionary(
        Type=pikepdf.Name.Annot, Subtype=pikepdf.Name.Widget, FT=pikepdf.Name.Tx,
        T=pikepdf.String("f"), Rect=[20, 350, 220, 370], F=4,
        DA=pikepdf.String("/Helv 10 Tf 0 g"), **extra))
    page.obj.Annots = pdf.make_indirect(pikepdf.Array([field]))
    pdf.Root.AcroForm = pdf.make_indirect(pikepdf.Dictionary(
        Fields=pikepdf.Array([field]), DA=pikepdf.String("/Helv 10 Tf 0 g"),
        DR=pikepdf.Dictionary(Font=pikepdf.Dictionary(Helv=font))))
    pdf.save(path)
    return path


def _shown(path):
    with pikepdf.open(path) as pdf:
        field = pdf.Root.AcroForm.Fields[0]
        facts = {"has_rv": "/RV" in field, "value": str(field.get("/V"))}
        return facts, field.AP.N.read_bytes()


def test_a_comb_field_draws_one_character_per_cell(tmp_path):
    src = _text_form(str(tmp_path / "in.pdf"), Ff=1 << 24, MaxLen=5)
    out = str(tmp_path / "out.pdf")
    fill_form_fields(src, out, {"f": "ABCDE"})
    _field, stream = _shown(out)
    assert stream.count(b"Tj") == 5
    assert b"(ABCDE)" not in stream


def test_a_value_longer_than_maxlen_refuses(tmp_path):
    src = _text_form(str(tmp_path / "in.pdf"), MaxLen=3)
    out = str(tmp_path / "out.pdf")
    with pytest.raises(ValueError, match="maximum of 3"):
        fill_form_fields(src, out, {"f": "ABCD"})
    assert not os.path.exists(out)


def test_filling_a_rich_text_field_drops_the_stale_rich_value(tmp_path):
    src = _text_form(str(tmp_path / "in.pdf"), Ff=1 << 25,
                     RV=pikepdf.String("<body><p>old</p></body>"))
    out = str(tmp_path / "out.pdf")
    fill_form_fields(src, out, {"f": "new"})
    facts, stream = _shown(out)
    assert not facts["has_rv"]
    assert facts["value"] == "new" and b"(new)" in stream


def _chain(tmp, include_intermediate):
    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa
    from cryptography.hazmat.primitives.serialization import pkcs12
    from cryptography.x509.oid import NameOID

    def name(cn):
        return x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, cn)])

    def cert(subject, issuer, key, signing_key, ca):
        b = (x509.CertificateBuilder().subject_name(name(subject)).issuer_name(name(issuer))
             .public_key(key.public_key()).serial_number(x509.random_serial_number())
             .not_valid_before(datetime.datetime(2000, 1, 1))
             .not_valid_after(datetime.datetime(2100, 1, 1))
             .add_extension(x509.BasicConstraints(ca=ca, path_length=None), critical=True)
             .add_extension(x509.KeyUsage(
                 digital_signature=not ca, content_commitment=not ca, key_encipherment=False,
                 data_encipherment=False, key_agreement=False, key_cert_sign=ca,
                 crl_sign=ca, encipher_only=False, decipher_only=False), critical=True))
        return b.sign(signing_key, hashes.SHA256())

    keys = [rsa.generate_private_key(public_exponent=65537, key_size=2048) for _ in range(3)]
    root = cert("Root", "Root", keys[0], keys[0], True)
    inter = cert("Inter", "Root", keys[1], keys[0], True)
    leaf = cert("Leaf", "Inter", keys[2], keys[1], False)
    root_pem = os.path.join(tmp, "root.pem")
    with open(root_pem, "wb") as f:
        f.write(root.public_bytes(serialization.Encoding.PEM))
    bundle = [inter, root] if include_intermediate else [root]
    pfx = os.path.join(tmp, "chain.pfx")
    with open(pfx, "wb") as f:
        f.write(pkcs12.serialize_key_and_certificates(
            b"l", keys[2], leaf, bundle, serialization.BestAvailableEncryption(b"pw")))
    return pfx, root_pem


def test_a_missing_intermediate_refuses_by_name_not_as_a_policy(tmp_path):
    pfx, root = _chain(str(tmp_path), include_intermediate=False)
    src = _form(str(tmp_path / "in.pdf"))
    out = str(tmp_path / "out.pdf")
    with pytest.raises(ValueError, match="chain could not be built"):
        sign_pdf(src, out, pfx_path=pfx, password="pw", pades=True,
                 embed_revocation=True, trust_roots=[root])
    assert not os.path.exists(out)


def test_embedded_validation_material_is_reported_as_written(tmp_path):
    pfx, root = _chain(str(tmp_path), include_intermediate=True)
    src = _form(str(tmp_path / "in.pdf"))
    out = str(tmp_path / "out.pdf")
    result = sign_pdf(src, out, pfx_path=pfx, password="pw", pades=True,
                      embed_revocation=True, trust_roots=[root])
    # These certificates name no revocation source, so none can be embedded.
    assert result["validation_material"] == {"certs": 3, "crls": 0, "ocsps": 0}
    plain = sign_pdf(src, str(tmp_path / "plain.pdf"), pfx_path=pfx, password="pw", pades=True)
    assert "validation_material" not in plain
