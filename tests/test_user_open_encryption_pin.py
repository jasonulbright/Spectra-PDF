"""A copy opened with its user password keeps its encryption.

A job or run process is given a user-password credential as
``open_document(path, password)``. That call decrypts the working copy in place
when the password is the OWNER password (``credentials._open_document``), so
the frame is read-only only while a user-opened copy's encryption cannot
change. Every method that changes or removes encryption must therefore refuse
on such a copy and leave its bytes unchanged.
"""

from __future__ import annotations

import hashlib
import os

import pikepdf
import pytest

from engine import credentials
from engine.credentials import PERMISSIONS_HELD
from engine.encrypt import decrypt, encrypt, grant_accessibility_permission
from engine.inspect import unlock


def _digest(path: str) -> str:
    with open(path, "rb") as handle:
        return hashlib.sha256(handle.read()).hexdigest()


@pytest.fixture
def user_opened(sample_pdf, tmp_dir):
    path = os.path.join(tmp_dir, "doc.pdf")
    # Assistive reading withheld, so granting it is a real change; revision 3
    # is the newest that still carries that bit (qpdf reads it as granted from
    # revision 4 on).
    with pikepdf.open(sample_pdf) as pdf:
        pdf.save(path, encryption=pikepdf.Encryption(
            user="u", owner="o", R=3, aes=False, metadata=False,
            allow=pikepdf.Permissions(accessibility=False),
        ))
    opened = credentials.open_document(path, "u")
    assert opened["opener"] == "user"
    yield path
    credentials.close_document(path)


CHANGES = {
    "encrypt": lambda path, out: encrypt(path, out, user_password="x", owner_password="y"),
    "encrypt_in_place": lambda path, out: encrypt(path, path, user_password="x", owner_password="y"),
    "decrypt_with_user_password": lambda path, out: decrypt(path, out, password="u"),
    "decrypt_in_place": lambda path, out: decrypt(path, path, password="u"),
    "grant_accessibility_permission": lambda path, out: grant_accessibility_permission(path, out),
    "unlock": lambda path, out: unlock(path, "u"),
}


@pytest.mark.parametrize("change", sorted(CHANGES))
def test_every_encryption_change_refuses_on_a_user_opened_copy(user_opened, tmp_dir, change):
    before = _digest(user_opened)
    out = os.path.join(tmp_dir, "out.pdf")
    with pytest.raises(Exception) as refused:
        CHANGES[change](user_opened, out)
    assert PERMISSIONS_HELD in str(refused.value), refused.value
    assert _digest(user_opened) == before
    assert not os.path.exists(out)
    assert credentials.document_permissions(user_opened)["opener"] == "user"


def test_the_user_password_frame_registers_without_writing(user_opened):
    before = _digest(user_opened)
    replayed = credentials.open_document(user_opened, "u")
    assert replayed["opener"] == "user"
    assert replayed["encryption_kept"] is True
    assert _digest(user_opened) == before
