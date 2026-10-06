"""A credential given to another engine process of the same window.

A window's own process opens a user-password or certificate-encrypted working
copy and keeps the credential. Its job and run processes are given that
credential as ``open_document(path, password, held=...)``: the grants the
window's open answered, recorded without opening, reading or writing any file,
so the process never holds the working copy open while another request of the
window replaces it, and never decrypts it in place.
"""

from __future__ import annotations

import hashlib
import os
import shutil

import pikepdf
import pytest

from engine import credentials
from engine.encrypt import encrypt
from engine.pubkey_crypt import RECIPIENT_SEALED, open_pubkey_document, pubkey_reattach
from test_pubkey_crypt import _two_list_document, _working


def _state(path: str):
    with open(path, "rb") as handle:
        return hashlib.sha256(handle.read()).hexdigest(), os.stat(path).st_mtime_ns


@pytest.fixture
def user_encrypted(sample_pdf, tmp_dir):
    path = os.path.join(tmp_dir, "doc.pdf")
    encrypt(sample_pdf, path, user_password="u", owner_password="o")
    return path


def test_a_user_open_answers_the_grants_another_process_is_given(user_encrypted):
    try:
        opened = credentials.open_document(user_encrypted, "u")
        assert opened["opener"] == "user"
        assert set(opened["permissions"]) == {name for name, _ in credentials._PERMISSION_KEYS}
        assert isinstance(opened["revision"], int) and isinstance(opened["p"], int)
    finally:
        credentials.close_document(user_encrypted)


def test_a_held_user_credential_is_recorded_without_touching_the_file(user_encrypted, monkeypatch):
    opened = credentials.open_document(user_encrypted, "u")
    credentials.close_document(user_encrypted)
    before = _state(user_encrypted)
    held = {"opener": "user", "permissions": opened["permissions"], "revision": opened["revision"], "p": opened["p"]}
    def refuse(*_args, **_kwargs):
        raise AssertionError("the held credential opened a document")

    with monkeypatch.context() as patched:
        patched.setattr(credentials, "open_pdf", refuse)
        patched.setattr(pikepdf, "open", refuse)
        assert credentials.open_document(user_encrypted, "u", held=held) == {
            "encrypted": True, "opener": "user", "registered": True,
        }
    try:
        assert _state(user_encrypted) == before
        assert credentials.document_permissions(user_encrypted)["permissions"] == opened["permissions"]
        with credentials.open_pdf(user_encrypted) as pdf:
            assert len(pdf.pages) > 0 and pdf.is_encrypted
    finally:
        credentials.close_document(user_encrypted)


def test_a_held_credential_needs_no_file_at_all(tmp_dir):
    missing = os.path.join(tmp_dir, "never-written.pdf")
    held = {"opener": "user", "permissions": {"print": True}, "revision": 6, "p": -4}
    try:
        assert credentials.open_document(missing, "u", held=held)["registered"] is True
        assert not os.path.exists(missing)
        assert credentials.document_permissions(missing)["permissions"]["print"] is True
        assert credentials.document_permissions(missing)["permissions"]["copy"] is False
    finally:
        credentials.close_document(missing)


def test_a_held_credential_lends_to_aliases_and_closes_with_them(user_encrypted, tmp_dir):
    stage = os.path.join(tmp_dir, "stage.pdf")
    shutil.copyfile(user_encrypted, stage)
    held = {"opener": "user", "permissions": {"print": True}, "revision": 6, "p": -4}
    credentials.open_document(user_encrypted, "u", held=held)
    assert credentials.share_document(user_encrypted, stage) == {"shared": True}
    with credentials.open_pdf(stage) as pdf:
        assert len(pdf.pages) > 0
    assert credentials.close_document(user_encrypted) == {"forgotten": True}
    assert credentials.close_document(stage) == {"forgotten": False}
    with pytest.raises(pikepdf.PasswordError):
        credentials.open_pdf(stage)


@pytest.mark.parametrize("held", [
    {"opener": "owner", "permissions": {}},
    {"opener": "none", "permissions": {}},
    {"opener": "user"},
    {"opener": "recipient", "permissions": "all"},
])
def test_only_a_user_or_recipient_credential_with_grants_is_held(tmp_dir, held):
    path = os.path.join(tmp_dir, "doc.pdf")
    with pytest.raises(ValueError):
        credentials.open_document(path, "x", held=held)
    assert not credentials.is_open_document(path)


def test_a_held_certificate_credential_writes_no_marker_and_reads_no_key(tmp_dir, sample_pdf):
    doc, pfx_p, _ = _two_list_document(tmp_dir, sample_pdf)
    folder = os.path.join(tmp_dir, "workfolder")
    os.makedirs(folder)
    work = _working(folder, doc)
    opened = open_pubkey_document(work, pfx_p, "test-pass")
    assert isinstance(opened["p"], int)
    files = [work, os.path.join(folder, RECIPIENT_SEALED), os.path.join(folder, credentials.RECIPIENT_MARKER)]
    before = [_state(path) for path in files]
    credentials._documents.clear()
    os.remove(pfx_p)
    try:
        held = {"opener": "recipient", "permissions": opened["permissions"], "revision": None, "p": opened["p"]}
        assert credentials.open_document(work, "", held=held)["opener"] == "recipient"
        assert [_state(path) for path in files] == before
        assert credentials.document_permissions(work)["permissions"] == opened["permissions"]
        with pytest.raises(PermissionError):
            credentials.require_permission(work, "modify")
    finally:
        credentials.close_document(work)


def test_a_reattach_answers_the_grants_too(tmp_dir, sample_pdf):
    doc, pfx_p, _ = _two_list_document(tmp_dir, sample_pdf)
    folder = os.path.join(tmp_dir, "workfolder")
    os.makedirs(folder)
    work = _working(folder, doc)
    opened = open_pubkey_document(work, pfx_p, "test-pass")
    credentials._documents.clear()
    try:
        again = pubkey_reattach(work, "", pfx_p, "test-pass")
        assert again["p"] == opened["p"] and again["permissions"] == opened["permissions"]
    finally:
        credentials.close_document(work)
