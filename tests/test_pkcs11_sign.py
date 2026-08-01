"""F3: PKCS#11 token signing, exercised against a real SoftHSM2 stack.

The dev-only SoftHSM2 portable build lives at tests/softhsm2/ (gitignored,
fetched like the e2e msedgedriver); tests SKIP when it is absent, the
gs_path precedent. Provisioning runs through tests/pkcs11_softhsm.py — the
ctypes C_InitToken (the portable softhsm2-util cannot load its own module)
plus python-pkcs11 object creation — and the assertions drive the ENGINE's
sign_pdf with the pkcs11_* source, not raw pyHanko.
"""

import os

import pytest

from engine.signatures import sign_pdf, verify_signatures

SOFTHSM_DLL = os.path.join(
    os.path.dirname(__file__), "softhsm2", "SoftHSM2", "lib", "softhsm2-x64.dll"
)

pytestmark = pytest.mark.skipif(
    not os.path.isfile(SOFTHSM_DLL), reason="SoftHSM2 not staged in tests/softhsm2"
)


@pytest.fixture(scope="module")
def hsm(tmp_path_factory):
    """A provisioned throwaway token: (module_path, token_label, pin)."""
    from pkcs11_softhsm import init_token, provision_identity

    work = tmp_path_factory.mktemp("softhsm")
    tokens = work / "tokens"
    tokens.mkdir()
    conf = work / "softhsm2.conf"
    conf.write_text(f"directories.tokendir = {tokens}\nobjectstore.backend = file\n")
    os.environ["SOFTHSM2_CONF"] = str(conf)
    init_token(SOFTHSM_DLL, "010203", "1234", "spectra-test")
    provision_identity(SOFTHSM_DLL, "spectra-test", "1234")
    return SOFTHSM_DLL, "spectra-test", "1234"


class TestPkcs11Sign:
    def test_signs_and_self_verifies(self, hsm, tmp_dir, sample_pdf):
        module, token, pin = hsm
        out = os.path.join(tmp_dir, "signed.pdf")
        r = sign_pdf(
            sample_pdf, out,
            pkcs11_module=module, pkcs11_token=token, pkcs11_pin=pin,
            pkcs11_cert_label="spectra-cert", pkcs11_key_label="spectra-key",
            reason="F3 pytest",
        )
        assert r["valid"] and r["intact"]
        assert r["signer"] == "Spectra HSM Test Signer"
        v = verify_signatures(out)
        assert v["signed"] and v["signatures"][0]["intact"]

    def test_visible_stamp_through_token(self, hsm, tmp_dir, sample_pdf):
        module, token, pin = hsm
        out = os.path.join(tmp_dir, "visible.pdf")
        r = sign_pdf(
            sample_pdf, out,
            pkcs11_module=module, pkcs11_token=token, pkcs11_pin=pin,
            pkcs11_cert_label="spectra-cert", pkcs11_key_label="spectra-key",
            appearance={"page": 1, "rect": [100, 100, 300, 160]},
        )
        assert r["valid"] and r["intact"]

    def test_key_label_mismatch_is_an_honest_message(self, hsm, tmp_dir, sample_pdf):
        # Omitting the key label defaults it to the CERT label — right for
        # tokens labelling the pair identically, wrong here (labels differ);
        # the token's own complaint must surface as a message, not a traceback.
        module, token, pin = hsm
        with pytest.raises(ValueError, match="private key with label"):
            sign_pdf(
                sample_pdf, os.path.join(tmp_dir, "no.pdf"),
                pkcs11_module=module, pkcs11_token=token, pkcs11_pin=pin,
                pkcs11_cert_label="spectra-cert",
            )

    def test_wrong_pin_refused_without_leaking(self, hsm, tmp_dir, sample_pdf):
        module, token, _ = hsm
        with pytest.raises(ValueError) as exc:
            sign_pdf(
                sample_pdf, os.path.join(tmp_dir, "no.pdf"),
                pkcs11_module=module, pkcs11_token=token, pkcs11_pin="9999",
                pkcs11_cert_label="spectra-cert",
            )
        msg = str(exc.value)
        assert "9999" not in msg  # the PIN never appears in errors
        assert "PIN" in msg or "PKCS#11" in msg

    def test_unknown_token_and_missing_module(self, hsm, tmp_dir, sample_pdf):
        module, _, pin = hsm
        with pytest.raises(ValueError, match="No token"):
            sign_pdf(
                sample_pdf, os.path.join(tmp_dir, "no.pdf"),
                pkcs11_module=module, pkcs11_token="nope", pkcs11_pin=pin,
                pkcs11_cert_label="spectra-cert",
            )
        with pytest.raises(ValueError, match="module not found"):
            sign_pdf(
                sample_pdf, os.path.join(tmp_dir, "no.pdf"),
                pkcs11_module=os.path.join(tmp_dir, "missing.dll"),
                pkcs11_token="spectra-test", pkcs11_pin=pin,
                pkcs11_cert_label="spectra-cert",
            )

    def test_mixed_sources_refused(self, hsm, tmp_dir, sample_pdf):
        module, token, pin = hsm
        with pytest.raises(ValueError, match="ONE signer source"):
            sign_pdf(
                sample_pdf, os.path.join(tmp_dir, "no.pdf"),
                pfx_path="x.pfx",
                pkcs11_module=module, pkcs11_token=token, pkcs11_pin=pin,
                pkcs11_cert_label="spectra-cert",
            )
