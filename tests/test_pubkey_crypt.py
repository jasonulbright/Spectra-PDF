"""Second half: certificate-based (Adobe.PubSec) encryption.

Round-trips run against in-test identities (cryptography-generated cert +
PKCS#12 bundle — the signing suite's precedent for clock-independent
fixtures). pikepdf cannot read this handler at all, so the assertions that
matter are: the right key opens it, the wrong key is refused cleanly, the
permissions flags land, and the open funnel's classifier tells the three
states apart.
"""

import datetime
import os

import pikepdf
import pytest

from engine.inspect import check_encrypted
from engine.pubkey_crypt import (
    classify_encryption,
    decrypt_with_pfx,
    encrypt_with_certs,
)

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.hazmat.primitives.serialization import pkcs12


def _identity(tmp_dir: str, cn: str, password: bytes = b"test-pass"):
    """(cert_path, pfx_path) for a fresh self-signed identity."""
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    name = x509.Name([x509.NameAttribute(x509.NameOID.COMMON_NAME, cn)])
    now = datetime.datetime.now(datetime.timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(now)
        .not_valid_after(now + datetime.timedelta(days=36500))
        .add_extension(
            x509.KeyUsage(
                digital_signature=False, content_commitment=False,
                key_encipherment=True, data_encipherment=True,
                key_agreement=False, key_cert_sign=False, crl_sign=False,
                encipher_only=False, decipher_only=False,
            ),
            critical=False,
        )
        .sign(key, hashes.SHA256())
    )
    cert_path = os.path.join(tmp_dir, f"{cn}.cer")
    with open(cert_path, "wb") as f:
        f.write(cert.public_bytes(serialization.Encoding.DER))
    pfx_path = os.path.join(tmp_dir, f"{cn}.pfx")
    with open(pfx_path, "wb") as f:
        f.write(
            pkcs12.serialize_key_and_certificates(
                cn.encode(), key, cert, None,
                serialization.BestAvailableEncryption(password),
            )
        )
    return cert_path, pfx_path


class TestPubkeyEncryption:
    def test_round_trip_and_classification(self, tmp_dir, sample_pdf):
        cert, pfx = _identity(tmp_dir, "recipient-a")
        enc = os.path.join(tmp_dir, "locked.pdf")
        plain = os.path.join(tmp_dir, "plain.pdf")

        result = encrypt_with_certs(sample_pdf, enc, [cert])
        assert result["recipients"] == 1
        assert classify_encryption(enc) == "pubkey"
        assert check_encrypted(enc) == {"encrypted": True, "kind": "pubkey"}
        with pytest.raises(pikepdf.PdfError):
            pikepdf.open(enc)  # the handler pikepdf cannot read

        decrypt_with_pfx(enc, plain, pfx, "test-pass")
        assert classify_encryption(plain) == "none"
        with pikepdf.open(plain) as pdf:
            assert len(pdf.pages) == 5  # sample.pdf round-trips whole

    def test_multiple_recipients_either_key_opens(self, tmp_dir, sample_pdf):
        cert_a, pfx_a = _identity(tmp_dir, "first")
        cert_b, pfx_b = _identity(tmp_dir, "second")
        enc = os.path.join(tmp_dir, "locked.pdf")
        encrypt_with_certs(sample_pdf, enc, [cert_a, cert_b])
        for pfx in (pfx_a, pfx_b):
            out = os.path.join(tmp_dir, f"plain-{os.path.basename(pfx)}.pdf")
            decrypt_with_pfx(enc, out, pfx, "test-pass")
            assert classify_encryption(out) == "none"

    def test_wrong_key_refused_cleanly(self, tmp_dir, sample_pdf):
        cert, _ = _identity(tmp_dir, "recipient-a")
        _, wrong_pfx = _identity(tmp_dir, "intruder")
        enc = os.path.join(tmp_dir, "locked.pdf")
        encrypt_with_certs(sample_pdf, enc, [cert])
        with pytest.raises(ValueError, match="does not match any recipient"):
            decrypt_with_pfx(enc, os.path.join(tmp_dir, "no.pdf"), wrong_pfx, "test-pass")

    def test_wrong_pfx_password_refused(self, tmp_dir, sample_pdf):
        cert, pfx = _identity(tmp_dir, "recipient-a")
        enc = os.path.join(tmp_dir, "locked.pdf")
        encrypt_with_certs(sample_pdf, enc, [cert])
        with pytest.raises(ValueError, match="check the file and its password"):
            decrypt_with_pfx(enc, os.path.join(tmp_dir, "no.pdf"), pfx, "not-the-pass")

    def test_pem_certificate_accepted(self, tmp_dir, sample_pdf):
        cert_der, pfx = _identity(tmp_dir, "pem-recipient")
        with open(cert_der, "rb") as f:
            der = f.read()
        import base64
        pem_path = os.path.join(tmp_dir, "recipient.pem")
        b64 = base64.encodebytes(der).decode()
        with open(pem_path, "w") as f:
            f.write(f"-----BEGIN CERTIFICATE-----\n{b64}-----END CERTIFICATE-----\n")
        enc = os.path.join(tmp_dir, "locked.pdf")
        encrypt_with_certs(sample_pdf, enc, [pem_path])
        assert classify_encryption(enc) == "pubkey"
        decrypt_with_pfx(enc, os.path.join(tmp_dir, "plain.pdf"), pfx, "test-pass")

    def test_permissions_flags_land(self, tmp_dir, sample_pdf):
        cert, pfx = _identity(tmp_dir, "recipient-a")
        enc = os.path.join(tmp_dir, "locked.pdf")
        encrypt_with_certs(
            sample_pdf, enc, [cert],
            permissions={"print": False, "copy": False, "modify": True, "annotate": True},
        )
        from pyhanko.pdf_utils import crypt as pyhanko_crypt
        from pyhanko.pdf_utils.crypt.permissions import PubKeyPermissions
        from pyhanko.pdf_utils.reader import PdfFileReader

        with open(enc, "rb") as f:
            reader = PdfFileReader(f)
            cred = pyhanko_crypt.SimpleEnvelopeKeyDecrypter.load_pkcs12(pfx, b"test-pass")
            perms = reader.decrypt_pubkey(cred).permission_flags
            assert not (perms & PubKeyPermissions.ALLOW_PRINTING)
            assert not (perms & PubKeyPermissions.ALLOW_CONTENT_EXTRACTION)
            assert perms & PubKeyPermissions.ALLOW_MODIFICATION_GENERIC
            assert perms & PubKeyPermissions.ALLOW_FORM_FILLING
            assert perms & PubKeyPermissions.ALLOW_ASSISTIVE_TECHNOLOGY

    def test_not_pubkey_inputs_refused(self, tmp_dir, sample_pdf):
        _, pfx = _identity(tmp_dir, "recipient-a")
        with pytest.raises(ValueError, match="not certificate-encrypted"):
            decrypt_with_pfx(sample_pdf, os.path.join(tmp_dir, "no.pdf"), pfx, "test-pass")
        with pytest.raises(ValueError, match="At least one recipient"):
            encrypt_with_certs(sample_pdf, os.path.join(tmp_dir, "no.pdf"), [])

    def test_password_encryption_still_classifies(self, tmp_dir, sample_pdf):
        from engine.encrypt import encrypt as std_encrypt
        enc = os.path.join(tmp_dir, "pw.pdf")
        std_encrypt(sample_pdf, enc, user_password="u", owner_password="o")
        assert classify_encryption(enc) == "password"
        assert check_encrypted(enc) == {"encrypted": True, "kind": "password"}


def _two_list_document(tmp_dir, sample_pdf):
    """A document with two recipient lists (ISO 32000-2 7.6.5.2): the first
    grants only printing, the second everything. Returns (path, pfx_print,
    pfx_full)."""
    from asn1crypto import x509 as asn1_x509
    from pyhanko.pdf_utils.crypt.permissions import PubKeyPermissions
    from pyhanko.pdf_utils.crypt.pubkey import PubKeySecurityHandler
    from pyhanko.pdf_utils.reader import PdfFileReader
    from pyhanko.pdf_utils.writer import copy_into_new_writer

    cert_p, pfx_p = _identity(tmp_dir, "print-only")
    cert_f, pfx_f = _identity(tmp_dir, "full-access")

    def load(path):
        with open(path, "rb") as f:
            return asn1_x509.Certificate.load(f.read())

    print_only = (
        PubKeyPermissions.ALLOW_PRINTING
        | PubKeyPermissions.ALLOW_ASSISTIVE_TECHNOLOGY
        | PubKeyPermissions.TOLERATE_MISSING_PDF_MAC
    )
    handler = PubKeySecurityHandler.build_from_certs([load(cert_p)], perms=print_only)
    handler.add_recipients([load(cert_f)], perms=PubKeyPermissions.allow_everything())
    out = os.path.join(tmp_dir, "two-lists.pdf")
    with open(sample_pdf, "rb") as f:
        writer = copy_into_new_writer(PdfFileReader(f))
        writer._assign_security_handler(handler)
        with open(out, "wb") as o:
            writer.write(o)
    return out, pfx_p, pfx_f


def _working(tmp_dir, source, name="work.pdf"):
    import shutil

    work = os.path.join(tmp_dir, name)
    shutil.copyfile(source, work)
    return work


class TestCertificateOpen:
    """The open funnel's certificate open keeps the recipient's grants, and
    Save reseals under the original recipient lists."""

    def test_open_reports_the_first_matching_lists_grants(self, tmp_dir, sample_pdf):
        from engine.credentials import close_document, document_permissions
        from engine.pubkey_crypt import open_pubkey_document

        doc, pfx_p, _ = _two_list_document(tmp_dir, sample_pdf)
        work = _working(tmp_dir, doc)
        try:
            opened = open_pubkey_document(work, pfx_p, "test-pass")
            assert opened["opener"] == "recipient"
            p = opened["permissions"]
            assert p["print"] and not p["print_high"]
            assert not p["modify"] and not p["copy"] and not p["annotate"]
            assert not p["fill"] and not p["assemble"] and p["accessibility"]
            assert "print-only" in opened["recipient"]["subject"]
            assert document_permissions(work)["opener"] == "recipient"
            assert document_permissions(work)["permissions"] == p
        finally:
            close_document(work)

    def test_bit_2_grants_everything(self, tmp_dir, sample_pdf):
        from engine.credentials import close_document
        from engine.pubkey_crypt import open_pubkey_document

        doc, _, pfx_f = _two_list_document(tmp_dir, sample_pdf)
        work = _working(tmp_dir, doc)
        try:
            opened = open_pubkey_document(work, pfx_f, "test-pass")
            assert all(opened["permissions"].values())
        finally:
            close_document(work)

    def test_engine_enforces_recipient_grants(self, tmp_dir, sample_pdf):
        from engine.credentials import close_document, print_resolution, require_permission
        from engine.pubkey_crypt import open_pubkey_document

        doc, pfx_p, _ = _two_list_document(tmp_dir, sample_pdf)
        work = _working(tmp_dir, doc)
        try:
            open_pubkey_document(work, pfx_p, "test-pass")
            with pytest.raises(PermissionError):
                require_permission(work, "modify")
            require_permission(work, "print")
            assert print_resolution(work) == "low"
        finally:
            close_document(work)

    def test_reseal_keeps_every_recipient_and_its_grants(self, tmp_dir, sample_pdf):
        from engine.credentials import close_document
        from engine.pubkey_crypt import open_pubkey_document, pubkey_reseal

        doc, pfx_p, pfx_f = _two_list_document(tmp_dir, sample_pdf)
        work = _working(tmp_dir, doc)
        saved = os.path.join(tmp_dir, "saved.pdf")
        try:
            open_pubkey_document(work, pfx_f, "test-pass")
            with pikepdf.open(work, allow_overwriting_input=True) as pdf:
                del pdf.pages[0]
                pdf.save()
            pubkey_reseal(work, saved)
        finally:
            close_document(work)
        assert classify_encryption(saved) == "pubkey"
        for i, (pfx, full) in enumerate(((pfx_p, False), (pfx_f, True))):
            again = _working(tmp_dir, saved, f"again-{i}.pdf")
            try:
                opened = open_pubkey_document(again, pfx, "test-pass")
                assert opened["permissions"]["modify"] is full
                assert opened["permissions"]["print"] is True
                with pikepdf.open(again) as pdf:
                    assert len(pdf.pages) == 4
            finally:
                close_document(again)

    def test_reseal_refuses_without_a_certificate_open(self, tmp_dir, sample_pdf):
        from engine.pubkey_crypt import pubkey_reseal

        with pytest.raises(ValueError, match="not opened with a certificate"):
            pubkey_reseal(sample_pdf, os.path.join(tmp_dir, "out.pdf"))

    def test_reseal_refuses_the_working_copy_as_output(self, tmp_dir, sample_pdf):
        from engine.credentials import close_document
        from engine.pubkey_crypt import open_pubkey_document, pubkey_reseal

        doc, _, pfx_f = _two_list_document(tmp_dir, sample_pdf)
        work = _working(tmp_dir, doc)
        try:
            open_pubkey_document(work, pfx_f, "test-pass")
            with pytest.raises(ValueError, match="never the working copy"):
                pubkey_reseal(work, work)
        finally:
            close_document(work)

    def test_decrypt_needs_change_of_encryption(self, tmp_dir, sample_pdf):
        doc, pfx_p, pfx_f = _two_list_document(tmp_dir, sample_pdf)
        refused = os.path.join(tmp_dir, "no.pdf")
        with pytest.raises(PermissionError):
            decrypt_with_pfx(doc, refused, pfx_p, "test-pass")
        assert not os.path.exists(refused)
        allowed = os.path.join(tmp_dir, "yes.pdf")
        decrypt_with_pfx(doc, allowed, pfx_f, "test-pass")
        assert classify_encryption(allowed) == "none"

    def test_restricted_encrypt_withholds_bit_2(self, tmp_dir, sample_pdf):
        from engine.credentials import close_document
        from engine.pubkey_crypt import open_pubkey_document

        cert, pfx = _identity(tmp_dir, "recipient-a")
        enc = os.path.join(tmp_dir, "locked.pdf")
        encrypt_with_certs(sample_pdf, enc, [cert], permissions={"print": False})
        work = _working(tmp_dir, enc)
        try:
            opened = open_pubkey_document(work, pfx, "test-pass")
            assert opened["permissions"]["print"] is False
            assert opened["permissions"]["modify"] is True
        finally:
            close_document(work)

    def test_encryption_doors_need_change_of_encryption(self, tmp_dir, sample_pdf):
        from engine.credentials import close_document
        from engine.encrypt import encrypt as std_encrypt
        from engine.pubkey_crypt import open_pubkey_document

        doc, pfx_p, pfx_f = _two_list_document(tmp_dir, sample_pdf)
        cert, _ = _identity(tmp_dir, "new-recipient")
        restricted = _working(tmp_dir, doc, "restricted.pdf")
        full = _working(tmp_dir, doc, "full.pdf")
        try:
            open_pubkey_document(restricted, pfx_p, "test-pass")
            open_pubkey_document(full, pfx_f, "test-pass")
            with pytest.raises(PermissionError):
                std_encrypt(restricted, os.path.join(tmp_dir, "pw.pdf"), user_password="u")
            with pytest.raises(PermissionError):
                encrypt_with_certs(restricted, os.path.join(tmp_dir, "re.pdf"), [cert])
            encrypt_with_certs(full, os.path.join(tmp_dir, "re.pdf"), [cert])
        finally:
            close_document(restricted)
            close_document(full)


_CERT_REFUSAL = "encrypted to certificate recipients"


def _new_file_ops(work, sample, out):
    from engine.compress import compress
    from engine.grayscale import grayscale
    from engine.image_export import export_images
    from engine.merge import merge
    from engine.office_export import export_document
    from engine.optimize import optimize
    from engine.pdfa import convert_pdfa
    from engine.split import split
    from engine.trapping import export_postscript

    return {
        "split": lambda: split(work, ranges="1", output=os.path.join(out, "split.pdf")),
        "extract": lambda: split(work, ranges="1-2", output=os.path.join(out, "extract.pdf")),
        "merge": lambda: merge([work, sample], os.path.join(out, "merge.pdf")),
        "merge_alone": lambda: merge([work], os.path.join(out, "merge1.pdf")),
        "optimize": lambda: optimize(work, os.path.join(out, "optimize.pdf")),
        "compress": lambda: compress(work, os.path.join(out, "compress.pdf")),
        "pdfa": lambda: convert_pdfa(work, os.path.join(out, "pdfa.pdf")),
        "grayscale": lambda: grayscale(work, os.path.join(out, "gray.pdf"), drop_encryption=True),
        "office": lambda: export_document(work, os.path.join(out, "o.docx"), "docx"),
        "images": lambda: export_images(work, os.path.join(out, "img.png")),
        "print_to_file": lambda: export_postscript(work, os.path.join(out, "p.ps")),
    }


@pytest.mark.parametrize("op", [
    "split", "extract", "merge", "merge_alone", "optimize", "compress", "pdfa",
    "grayscale", "office", "images", "print_to_file",
])
def test_restricted_recipient_never_leaves_as_plaintext(tmp_dir, sample_pdf, op):
    from engine.credentials import close_document
    from engine.pubkey_crypt import open_pubkey_document

    doc, pfx_p, _ = _two_list_document(tmp_dir, sample_pdf)
    folder = os.path.join(tmp_dir, "workfolder")
    os.makedirs(folder)
    work = _working(folder, doc)
    out = os.path.join(tmp_dir, "out")
    os.makedirs(out)
    try:
        open_pubkey_document(work, pfx_p, "test-pass")
        with pytest.raises((ValueError, PermissionError, RuntimeError)) as refused:
            _new_file_ops(work, sample_pdf, out)[op]()
        expected = (
            "certificate recipient lists" if op in ("office", "images", "print_to_file")
            else "cannot be combined" if op == "merge"
            else _CERT_REFUSAL
        )
        assert expected in str(refused.value)
        assert os.listdir(out) == []
    finally:
        close_document(work)


def test_full_recipient_may_split(tmp_dir, sample_pdf):
    from engine.credentials import close_document
    from engine.pubkey_crypt import open_pubkey_document
    from engine.split import split

    doc, _, pfx_f = _two_list_document(tmp_dir, sample_pdf)
    folder = os.path.join(tmp_dir, "workfolder")
    os.makedirs(folder)
    work = _working(folder, doc)
    try:
        open_pubkey_document(work, pfx_f, "test-pass")
        split(work, ranges="1", output=os.path.join(tmp_dir, "split.pdf"))
    finally:
        close_document(work)


def test_in_place_edits_stay_allowed_inside_the_working_folder(tmp_dir, sample_pdf):
    from engine.credentials import close_document, open_pdf
    from engine.pdf_save import save_pdf
    from engine.pubkey_crypt import open_pubkey_document

    doc, pfx_p, _ = _two_list_document(tmp_dir, sample_pdf)
    folder = os.path.join(tmp_dir, "workfolder")
    os.makedirs(folder)
    work = _working(folder, doc)
    try:
        open_pubkey_document(work, pfx_p, "test-pass")
        with open_pdf(work) as pdf:
            save_pdf(pdf, os.path.join(folder, "stage.pdf"))
            with pytest.raises(ValueError, match=_CERT_REFUSAL):
                save_pdf(pdf, os.path.join(tmp_dir, "escaped.pdf"))
        assert not os.path.exists(os.path.join(tmp_dir, "escaped.pdf"))
    finally:
        close_document(work)


def test_grants_survive_an_engine_restart(tmp_dir, sample_pdf):
    from engine import credentials
    from engine.pubkey_crypt import open_pubkey_document, pubkey_reattach, pubkey_reseal

    doc, pfx_p, _ = _two_list_document(tmp_dir, sample_pdf)
    folder = os.path.join(tmp_dir, "workfolder")
    os.makedirs(folder)
    work = _working(folder, doc)
    source = _working(tmp_dir, doc, "users-file.pdf")
    open_pubkey_document(work, pfx_p, "test-pass")
    credentials._documents.clear()
    try:
        held = credentials.document_permissions(work)
        assert held["opener"] == "recipient" and held["permissions"]["modify"] is False
        with pytest.raises(PermissionError):
            credentials.require_permission(work, "modify")
        stage = os.path.join(folder, "stage.sealed")
        assert pubkey_reseal(work, stage) == {"output": None, "needs_certificate": True}
        assert not os.path.exists(stage)
        pubkey_reattach(work, source, pfx_p, "test-pass")
        assert pubkey_reseal(work, stage)["output"] == stage
        assert classify_encryption(stage) == "pubkey"
    finally:
        credentials.close_document(work)


def test_signed_document_needs_consent_to_reseal(tmp_dir, sample_pdf, monkeypatch):
    from engine import incremental
    from engine.credentials import close_document
    from engine.pubkey_crypt import open_pubkey_document, pubkey_reseal

    doc, _, pfx_f = _two_list_document(tmp_dir, sample_pdf)
    folder = os.path.join(tmp_dir, "workfolder")
    os.makedirs(folder)
    work = _working(folder, doc)
    stage = os.path.join(folder, "stage.sealed")
    monkeypatch.setattr(
        incremental, "signature_policy_of_pdf",
        lambda pdf: {"signed": True, "count": 2, "certified": False, "level": None, "locks": []},
    )
    try:
        open_pubkey_document(work, pfx_f, "test-pass")
        assert pubkey_reseal(work, stage) == {"output": None, "signatures": 2}
        assert not os.path.exists(stage)
        assert pubkey_reseal(work, stage, break_signatures=True)["output"] == stage
    finally:
        close_document(work)


@pytest.mark.skipif(os.name != "nt", reason="Windows DACL")
def test_working_folder_is_owner_only(tmp_dir, sample_pdf):
    import subprocess

    from engine.credentials import close_document
    from engine.pubkey_crypt import open_pubkey_document

    doc, _, pfx_f = _two_list_document(tmp_dir, sample_pdf)
    folder = os.path.join(tmp_dir, "workfolder")
    os.makedirs(folder)
    work = _working(folder, doc)
    try:
        open_pubkey_document(work, pfx_f, "test-pass")
        acl = subprocess.run(["icacls", work], capture_output=True, text=True).stdout
        entries = [line for line in acl.splitlines()[:-2] if ":" in line.split(work)[-1]]
        assert len(entries) == 1, acl
        assert "(I)" in entries[0]
    finally:
        close_document(work)


def _restricted_open(tmp_dir, sample_pdf):
    from engine.pubkey_crypt import open_pubkey_document

    doc, pfx_p, _ = _two_list_document(tmp_dir, sample_pdf)
    folder = os.path.join(tmp_dir, "workfolder")
    os.makedirs(folder)
    work = _working(folder, doc)
    open_pubkey_document(work, pfx_p, "test-pass")
    return work


def test_compare_text_needs_copy(tmp_dir, sample_pdf):
    from engine.compare import compare_text
    from engine.credentials import close_document

    work = _restricted_open(tmp_dir, sample_pdf)
    try:
        for a, b in ((work, sample_pdf), (sample_pdf, work)):
            with pytest.raises(PermissionError, match="certificate recipient lists"):
                compare_text(a, b)
    finally:
        close_document(work)


def test_search_in_files_withholds_restricted_open_documents_only(tmp_dir, sample_pdf):
    from engine.credentials import close_document
    from engine.search_in_files import search_in_files

    work = _restricted_open(tmp_dir, sample_pdf)
    try:
        result = search_in_files([work, sample_pdf], "e")
        assert all(hit["path"] != work for hit in result["hits"])
        assert [e["path"] for e in result["errors"]] == [work]
    finally:
        close_document(work)


def test_pages_copied_from_a_restricted_document_stay_in_its_folder(tmp_dir, sample_pdf):
    from engine.credentials import close_document, open_pdf
    from engine.pdf_save import save_pdf

    work = _restricted_open(tmp_dir, sample_pdf)
    escaped = os.path.join(tmp_dir, "escaped.pdf")
    try:
        with open_pdf(work) as source, pikepdf.Pdf.new() as fresh:
            fresh.pages.append(source.pages[0])
            with pytest.raises(ValueError, match=_CERT_REFUSAL):
                save_pdf(fresh, escaped)
        assert not os.path.exists(escaped)
        with pikepdf.Pdf.new() as unrelated:
            unrelated.add_blank_page()
            save_pdf(unrelated, os.path.join(tmp_dir, "unrelated.pdf"))
    finally:
        close_document(work)


def test_byte_copies_stay_in_the_working_folder(tmp_dir, sample_pdf):
    from engine.credentials import close_document, copy_document
    from engine.reversion import set_pdf_version

    work = _restricted_open(tmp_dir, sample_pdf)
    out = os.path.join(tmp_dir, "out")
    os.makedirs(out)
    try:
        with pytest.raises(ValueError, match=_CERT_REFUSAL):
            copy_document(work, os.path.join(out, "copy.pdf"))
        with pikepdf.open(work) as pdf:
            current = str(pdf.pdf_version)
        with pytest.raises(ValueError, match=_CERT_REFUSAL):
            set_pdf_version(work, os.path.join(out, "v.pdf"), current)
        with pytest.raises(ValueError, match=_CERT_REFUSAL):
            set_pdf_version(work, os.path.join(out, "v2.pdf"), "2.0")
        assert os.listdir(out) == []
    finally:
        close_document(work)


def test_unrelated_split_succeeds_while_a_restricted_document_is_open(tmp_dir, sample_pdf):
    from engine.credentials import close_document, open_recipient_folders
    from engine.split import split

    work = _restricted_open(tmp_dir, sample_pdf)
    try:
        assert open_recipient_folders() == set()
        split(sample_pdf, ranges="1", output=os.path.join(tmp_dir, "other.pdf"))
        assert os.path.exists(os.path.join(tmp_dir, "other.pdf"))
    finally:
        close_document(work)


def test_a_leaked_handle_does_not_bind_the_next_request(tmp_dir, sample_pdf):
    import io
    import json

    from engine.credentials import close_document, open_pdf
    from engine.ipc import JsonRpcServer
    from engine.pdf_save import save_pdf
    from engine.split import split

    work = _restricted_open(tmp_dir, sample_pdf)
    leaked = []

    def leak():
        pdf = open_pdf(work)
        leaked.append(pdf)
        with pytest.raises(ValueError, match=_CERT_REFUSAL):
            with pikepdf.Pdf.new() as fresh:
                fresh.pages.append(pdf.pages[0])
                save_pdf(fresh, os.path.join(tmp_dir, "escaped.pdf"))
        return {}

    server = JsonRpcServer()
    server.register("leak", leak)
    server.register("split", split)
    other = os.path.join(tmp_dir, "other.pdf")
    requests = "\n".join(json.dumps(r) for r in (
        {"jsonrpc": "2.0", "id": 1, "method": "leak", "params": {}},
        {"jsonrpc": "2.0", "id": 2, "method": "split",
         "params": {"file": sample_pdf, "ranges": "1", "output": other}},
    )) + "\n"
    out = io.StringIO()
    try:
        server.run(io.StringIO(requests), out)
        replies = [json.loads(line) for line in out.getvalue().splitlines()]
        assert all("error" not in r for r in replies), replies
        assert os.path.exists(other)
        assert not os.path.exists(os.path.join(tmp_dir, "escaped.pdf"))
    finally:
        for pdf in leaked:
            pdf.close()
        close_document(work)
