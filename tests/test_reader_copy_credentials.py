"""A reader copy of a working copy, as the engine sees it.

A long job reads a byte copy of the working copy instead of the working copy:
``<working folder>/r<pid>-<8 hex>/<same name>``. The engine finds a
document's credential by path, and finds a certificate-opened document's
grants in the recipient marker of the file's own folder. A certificate-opened
working copy is plaintext, so the copy is restricted only when the marker was
copied beside it or the credential was lent to it (``share_document``).
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys

import pikepdf
import pytest

from engine import credentials
from engine.encrypt import encrypt
from engine.office_export import export_document
from engine.pubkey_crypt import open_pubkey_document
from test_engine_workers import SRC_DIR, _request
from test_pubkey_crypt import _two_list_document, _working


def _reader_copy(work: str, *, marker: bool) -> str:
    folder = os.path.join(os.path.dirname(work), f"r{os.getpid()}-0123abcd")
    os.makedirs(folder)
    if marker:
        shutil.copyfile(
            os.path.join(os.path.dirname(work), credentials.RECIPIENT_MARKER),
            os.path.join(folder, credentials.RECIPIENT_MARKER),
        )
    copy = os.path.join(folder, os.path.basename(work))
    shutil.copyfile(work, copy)
    return copy


@pytest.fixture
def recipient_work(tmp_dir, sample_pdf):
    """A working copy opened with a certificate whose list grants printing at
    low resolution only. Returns (working copy, its open's answer)."""
    doc, pfx_print_only, _ = _two_list_document(tmp_dir, sample_pdf)
    folder = os.path.join(tmp_dir, "workfolder")
    os.makedirs(folder)
    work = _working(folder, doc)
    opened = open_pubkey_document(work, pfx_print_only, "test-pass")
    assert credentials.print_resolution(work) == "low"
    yield work, opened
    credentials.close_document(work)


def _export_refused(source: str, tmp_dir: str) -> None:
    output = os.path.join(tmp_dir, "export.txt")
    with pytest.raises(PermissionError) as refused:
        export_document(source, output, "txt")
    assert str(refused.value) == credentials.PERMISSIONS_HELD_BY_RECIPIENTS
    assert not os.path.exists(output)


def test_a_recipient_copy_with_no_marker_and_no_alias_reads_as_unrestricted(recipient_work):
    """The hazard: the plaintext bytes alone carry no grants."""
    work, _ = recipient_work
    copy = _reader_copy(work, marker=False)
    assert credentials.print_resolution(copy) == "high"
    credentials.require_permission(copy, "copy")
    assert credentials.document_permissions(copy)["opener"] == "none"


def test_the_copied_marker_enforces_the_grants(recipient_work, tmp_dir):
    work, opened = recipient_work
    copy = _reader_copy(work, marker=True)
    assert credentials.print_resolution(copy) == "low"
    assert credentials.document_permissions(copy)["permissions"] == opened["permissions"]
    _export_refused(copy, tmp_dir)


def test_the_lent_credential_enforces_the_grants_until_the_alias_closes(recipient_work, tmp_dir):
    work, opened = recipient_work
    copy = _reader_copy(work, marker=False)
    assert credentials.share_document(work, copy) == {"shared": True}
    assert credentials.print_resolution(copy) == "low"
    assert credentials.document_permissions(copy)["opener"] == "recipient"
    assert credentials.document_permissions(copy)["permissions"] == opened["permissions"]
    _export_refused(copy, tmp_dir)

    assert credentials.close_document(copy) == {"forgotten": True}
    assert credentials.print_resolution(copy) == "high"
    assert credentials.print_resolution(work) == "low", "closing the alias keeps the working copy's record"


def test_a_user_password_copy_opens_only_with_the_alias(sample_pdf, tmp_dir):
    folder = os.path.join(tmp_dir, "workfolder")
    os.makedirs(folder)
    work = os.path.join(folder, "doc.pdf")
    encrypt(sample_pdf, work, user_password="u", owner_password="o")
    assert credentials.open_document(work, "u")["opener"] == "user"
    try:
        copy = _reader_copy(work, marker=False)
        with pytest.raises(pikepdf.PasswordError):
            credentials.open_pdf(copy)
        assert credentials.share_document(work, copy) == {"shared": True}
        with credentials.open_pdf(copy) as pdf:
            assert len(pdf.pages) > 0
        assert credentials.close_document(copy) == {"forgotten": True}
        with pytest.raises(pikepdf.PasswordError):
            credentials.open_pdf(copy)
    finally:
        credentials.close_document(work)


class _JobWorker:
    """A job-role engine process, spoken to over its stdio as engine.rs does."""

    def __init__(self):
        self.proc = subprocess.Popen(
            [sys.executable, "-m", "engine", "--spectra-role=job", "--spectra-window=main"],
            cwd=SRC_DIR,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            env=dict(os.environ, PYTHONUTF8="1"),
        )
        self.next_id = 0

    def call(self, method, **params):
        self.next_id += 1
        self.proc.stdin.write((_request(self.next_id, method, **params) + "\n").encode("utf-8"))
        self.proc.stdin.flush()
        while True:
            line = self.proc.stdout.readline()
            assert line, "the worker exited without answering"
            reply = json.loads(line)
            if reply.get("id") == self.next_id:
                return reply

    def close(self):
        self.proc.stdin.close()
        assert self.proc.wait(timeout=60) == 0


def test_a_job_process_given_the_alias_frame_enforces_the_grants(recipient_work, tmp_dir):
    work, opened = recipient_work
    copy = _reader_copy(work, marker=False)
    output = os.path.join(tmp_dir, "export.txt")
    held = {"opener": "recipient", "permissions": opened["permissions"], "revision": None, "p": opened["p"]}
    worker = _JobWorker()
    try:
        assert worker.call("document_permissions", path=copy)["result"]["opener"] == "none"

        assert worker.call("open_document", path=work, password="", held=held)["result"]["registered"] is True
        assert worker.call("share_document", path=work, alias=copy)["result"] == {"shared": True}
        lent = worker.call("document_permissions", path=copy)["result"]
        assert lent["opener"] == "recipient" and lent["permissions"] == opened["permissions"]
        refused = worker.call("export_document", file=copy, output=output, fmt="txt")
        assert refused["error"]["message"] == credentials.PERMISSIONS_HELD_BY_RECIPIENTS
        assert not os.path.exists(output)

        assert worker.call("close_document", path=copy)["result"] == {"forgotten": True}
        assert worker.call("document_permissions", path=copy)["result"]["opener"] == "none"
        assert worker.call("document_permissions", path=work)["result"]["opener"] == "recipient"
    finally:
        worker.close()
