"""The PKCS#11 token listing behind the signer's "Find certificates".

The listing opens every session WITHOUT a PIN and only reads certificate
objects, so a module stand-in is enough to pin what it reports: each token
with a present card, each labelled X.509 certificate on it, and nothing that
needs a login.
"""

from __future__ import annotations

import datetime
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))

pkcs11 = pytest.importorskip("pkcs11")

from cryptography import x509  # noqa: E402
from cryptography.hazmat.primitives import hashes, serialization  # noqa: E402
from cryptography.hazmat.primitives.asymmetric import ec  # noqa: E402
from cryptography.x509.oid import NameOID  # noqa: E402
from pkcs11 import Attribute, ObjectClass, TokenFlag  # noqa: E402

from engine import signatures  # noqa: E402


def _der(common_name: str) -> bytes:
    key = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, common_name)])
    now = datetime.datetime(2026, 1, 1, tzinfo=datetime.timezone.utc)
    cert = (
        x509.CertificateBuilder()
        .subject_name(name)
        .issuer_name(name)
        .public_key(key.public_key())
        .serial_number(1)
        .not_valid_before(now)
        .not_valid_after(now + datetime.timedelta(days=365))
        .sign(key, hashes.SHA256())
    )
    return cert.public_bytes(serialization.Encoding.DER)


class _Object(dict):
    pass


class _Session:
    def __init__(self, objects, opened):
        self._objects = objects
        self._opened = opened

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def get_objects(self, template):
        assert template == {Attribute.CLASS: ObjectClass.CERTIFICATE}
        return iter(self._objects)


class _Token:
    def __init__(self, label, objects, flags=TokenFlag(0), fails=False):
        self.label = label
        self.manufacturer_id = "Maker"
        self.model = "Model"
        self.flags = flags
        self._objects = objects
        self._fails = fails
        self.opened = []

    def open(self, **kwargs):
        self.opened.append(kwargs)
        if self._fails:
            raise RuntimeError("device removed")
        return _Session(self._objects, self.opened)


class _Slot:
    def __init__(self, token):
        self._token = token

    def get_token(self):
        return self._token


class _Lib:
    def __init__(self, slots):
        self._slots = slots
        self.asked = []

    def get_slots(self, token_present=False):
        self.asked.append(token_present)
        return self._slots


@pytest.fixture
def module_file(tmp_path):
    path = tmp_path / "opensc-pkcs11.so"
    path.write_bytes(b"")
    return str(path)


def test_lists_labelled_certificates_without_a_login(monkeypatch, module_file):
    signing = _Object({Attribute.LABEL: "Signing ", Attribute.VALUE: _der("Ada Lovelace")})
    unlabelled = _Object({Attribute.LABEL: "", Attribute.VALUE: _der("Nobody")})
    not_x509 = _Object({Attribute.LABEL: "Garbage", Attribute.VALUE: b"\x00\x01"})
    card = _Token("PIV Card   ", [signing, unlabelled, not_x509], TokenFlag.LOGIN_REQUIRED)
    broken = _Token("Gone", [], fails=True)
    lib = _Lib([_Slot(card), _Slot(broken)])
    monkeypatch.setattr(pkcs11, "lib", lambda path: lib)

    listing = signatures.list_pkcs11_certificates(module_file)

    assert lib.asked == [True]
    assert card.opened == [{}], "a session must open with no PIN and no write access"
    first, second = listing["tokens"]
    assert first["label"] == "PIV Card"
    assert first["login_required"] is True
    assert [c["label"] for c in first["certificates"]] == ["Signing"]
    assert "Ada Lovelace" in first["certificates"][0]["subject"]
    assert first["certificates"][0]["not_after"].startswith("2027-01-01")
    assert second == {
        "label": "Gone",
        "manufacturer": "Maker",
        "model": "Model",
        "login_required": False,
        "certificates": [],
    }


def test_a_missing_module_refuses_by_the_signers_own_message(tmp_path):
    with pytest.raises(ValueError, match="PKCS#11 module not found at the given path."):
        signatures.list_pkcs11_certificates(str(tmp_path / "absent.so"))
    with pytest.raises(ValueError, match="PKCS#11 module not found"):
        signatures.list_pkcs11_certificates("")


def test_a_module_that_will_not_load_is_named(monkeypatch, module_file):
    def refuse(path):
        raise RuntimeError("wrong ELF class")

    monkeypatch.setattr(pkcs11, "lib", refuse)
    with pytest.raises(ValueError, match="Could not open the PKCS#11 token: wrong ELF class"):
        signatures.list_pkcs11_certificates(module_file)


def test_the_listing_is_a_registered_engine_method():
    main = (Path(__file__).resolve().parent.parent / "src" / "engine" / "__main__.py").read_text(
        encoding="utf-8"
    )
    assert 'server.register("list_pkcs11_certificates", list_pkcs11_certificates)' in main
