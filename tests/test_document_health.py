"""The read-only document-health engine op.

Two things are gated here and they are not the same thing: that the op REPORTS
what the boundaries actually found, and that it CHANGES NOTHING. The second is
the load-bearing one — the ledger is observability, and an "observation" that
rewrote the user's working copy would be a silent edit nobody asked for.
"""

import hashlib
import os
import shutil

import pikepdf
import pytest

from engine.document_health import document_health

FIXTURES = os.path.join(os.path.dirname(__file__), "fixtures", "health")


def _codes(report, code):
    return [f for f in report["facts"] if f["code"] == code]


@pytest.fixture
def damaged_xref(tmp_dir):
    """The damaged-xref fixture, copied so a test can prove it is untouched
    without risking the committed file."""
    dst = os.path.join(tmp_dir, "damaged-xref.pdf")
    shutil.copy(os.path.join(FIXTURES, "damaged-xref.pdf"), dst)
    return dst


@pytest.fixture
def broken_content(tmp_dir):
    dst = os.path.join(tmp_dir, "broken-content.pdf")
    shutil.copy(os.path.join(FIXTURES, "broken-content.pdf"), dst)
    return dst


def test_reports_xref_reconstruction_at_the_qpdf_boundary(damaged_xref):
    report = document_health(damaged_xref)
    recovered = _codes(report, "xref.reconstructed")
    assert len(recovered) == 1
    fact = recovered[0]
    assert fact["boundary"] == "qpdf"
    assert fact["kind"] == "recovered"
    assert fact["severity"] == "warning"
    # A document-level fact names no page.
    assert fact["page"] is None


def test_one_recovery_is_one_fact(damaged_xref):
    """qpdf emits three sentences for one reconstruction. Reporting them
    one-for-one would read as three separate defects."""
    report = document_health(damaged_xref)
    qpdf_facts = [f for f in report["facts"] if f["boundary"] == "qpdf"]
    assert len(qpdf_facts) == 1


def test_reports_the_non_embedded_font_at_the_engine_boundary(damaged_xref):
    report = document_health(damaged_xref)
    fonts = _codes(report, "font.notEmbedded")
    assert len(fonts) == 1
    assert fonts[0]["boundary"] == "engine"
    assert fonts[0]["kind"] == "font"
    assert fonts[0]["params"]["font"] == "Helvetica"
    # 1-based at the engine; the renderer converts to an index.
    assert fonts[0]["page"] == 1


def test_reports_an_undecodable_content_stream(broken_content):
    report = document_health(broken_content)
    skipped = _codes(report, "page.contentUnreadable")
    assert len(skipped) == 1
    assert skipped[0]["kind"] == "skipped"
    assert skipped[0]["page"] == 1


def test_never_writes_the_file(damaged_xref, broken_content):
    """The whole point: an observation that mutates is not an observation."""
    for path in (damaged_xref, broken_content):
        before = open(path, "rb").read()
        before_mtime = os.stat(path).st_mtime_ns
        document_health(path)
        after = open(path, "rb").read()
        assert hashlib.sha256(after).hexdigest() == hashlib.sha256(before).hexdigest()
        assert after == before
        assert os.stat(path).st_mtime_ns == before_mtime


def test_clean_document_reports_nothing(sample_pdf):
    report = document_health(sample_pdf)
    assert report["status"] == "collected"
    assert report["facts"] == []


def test_unreadable_document_is_undetermined_never_clean(tmp_dir):
    """A file that will not open must not answer the same way a clean one
    does. It is a RESULT, not a refusal — a raise here would be
    indistinguishable, to a ledger that stores only facts, from nothing to
    report."""
    path = os.path.join(tmp_dir, "not-a-pdf.pdf")
    with open(path, "wb") as fh:
        fh.write(b"%PDF-1.7\nnot really\n")
    report = document_health(path)
    assert report["status"] == "undetermined"
    assert any(f["kind"] == "undetermined" for f in report["facts"])


def test_encrypted_document_is_undetermined(tmp_dir, sample_pdf):
    path = os.path.join(tmp_dir, "locked.pdf")
    with pikepdf.open(sample_pdf) as pdf:
        pdf.save(path, encryption=pikepdf.Encryption(user="secret", owner="secret"))
    report = document_health(path)
    assert report["status"] == "undetermined"
    assert _codes(report, "document.encrypted")


def test_missing_file_raises(tmp_dir):
    with pytest.raises(FileNotFoundError):
        document_health(os.path.join(tmp_dir, "nope.pdf"))


def test_every_fact_carries_the_ledger_contract(damaged_xref):
    """The renderer parses these rows; the contract they must satisfy is
    stated here rather than only in the type that reads them."""
    for fact in document_health(damaged_xref)["facts"]:
        assert set(fact) == {"kind", "severity", "boundary", "code", "page", "params"}
        assert fact["kind"] in {"recovered", "font", "skipped", "undetermined"}
        assert fact["severity"] in {"info", "warning"}
        assert fact["boundary"] in {"qpdf", "engine"}
        assert fact["code"]
        assert fact["page"] is None or fact["page"] >= 1
        assert isinstance(fact["params"], dict)
