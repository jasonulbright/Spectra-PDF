"""The read-only document-health engine op.

Two things are gated here and they are not the same thing: that the op REPORTS
what the boundaries actually found, and that it CHANGES NOTHING. The second is
the load-bearing one — the ledger is observability, and an "observation" that
rewrote the user's working copy would be a silent edit nobody asked for.
"""

import hashlib
import os
import shutil
import zlib
from types import SimpleNamespace

import pikepdf
import pytest

from engine.document_health import _classify_warning, _document_facts, document_health

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


def _image_pdf(path, *, filter_name, nested):
    """One page reaching one image, directly or through a Form XObject."""
    pdf = pikepdf.Pdf.new()
    page = pdf.add_blank_page(page_size=(200, 200))
    image = pdf.make_stream(b"payload bytes")
    image["/Type"] = pikepdf.Name.XObject
    image["/Subtype"] = pikepdf.Name.Image
    image["/Width"] = 8
    image["/Height"] = 8
    image["/ColorSpace"] = pikepdf.Name.DeviceGray
    image["/BitsPerComponent"] = 8
    image["/Filter"] = pikepdf.Name(filter_name)
    image = pdf.make_indirect(image)
    if nested:
        form = pdf.make_stream(b"/Im0 Do")
        form["/Type"] = pikepdf.Name.XObject
        form["/Subtype"] = pikepdf.Name.Form
        form["/BBox"] = pikepdf.Array([0, 0, 8, 8])
        form["/Resources"] = pikepdf.Dictionary(XObject=pikepdf.Dictionary(Im0=image))
        page.obj["/Resources"] = pikepdf.Dictionary(
            XObject=pikepdf.Dictionary(Fm0=pdf.make_indirect(form))
        )
    else:
        page.obj["/Resources"] = pikepdf.Dictionary(
            XObject=pikepdf.Dictionary(Im0=image)
        )
    pdf.save(path)
    return path


def _xfa_pdf(path, *, dynamic, as_array):
    """A document carrying an XFA packet in either spelling."""
    pdf = pikepdf.Pdf.new()
    pdf.add_blank_page(page_size=(200, 200))
    packet = b"<xdp:xdp xmlns:xdp='http://ns.adobe.com/xdp/'/>"
    if as_array:
        entry = pikepdf.Array(
            [pikepdf.String("form"), pdf.make_indirect(pdf.make_stream(packet))]
        )
    else:
        entry = pdf.make_indirect(pdf.make_stream(packet))
    fields = pikepdf.Array(
        [] if dynamic else [pdf.make_indirect(pikepdf.Dictionary(T=pikepdf.String("f")))]
    )
    pdf.Root["/AcroForm"] = pdf.make_indirect(
        pikepdf.Dictionary(Fields=fields, XFA=entry)
    )
    if dynamic:
        pdf.Root["/NeedsRendering"] = True
    pdf.save(path)
    return path


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


def test_an_undecodable_image_filter_is_reported(tmp_dir):
    """The stream's BYTES are intact; only decoding them fails. A check that
    reads raw bytes reports this document as clean."""
    path = _image_pdf(
        os.path.join(tmp_dir, "direct.pdf"), filter_name="/NoSuchDecode", nested=False
    )
    report = document_health(path)
    unreadable = _codes(report, "page.imageUnreadable")
    assert len(unreadable) == 1
    assert unreadable[0]["page"] == 1
    assert unreadable[0]["params"]["name"] == "Im0"


def test_an_image_inside_a_form_xobject_is_reached(tmp_dir):
    path = _image_pdf(
        os.path.join(tmp_dir, "nested.pdf"), filter_name="/NoSuchDecode", nested=True
    )
    assert len(_codes(document_health(path), "page.imageUnreadable")) == 1


def test_the_committed_form_hosted_fixture_reports_its_image(tmp_dir):
    dst = os.path.join(tmp_dir, "form-hosted-image.pdf")
    shutil.copy(os.path.join(FIXTURES, "form-hosted-image.pdf"), dst)
    assert len(_codes(document_health(dst), "page.imageUnreadable")) == 1


def test_an_image_inside_an_annotation_appearance_is_reached(tmp_dir):
    path = os.path.join(tmp_dir, "annot.pdf")
    pdf = pikepdf.Pdf.new()
    page = pdf.add_blank_page(page_size=(200, 200))
    image = pdf.make_stream(b"payload bytes")
    image["/Subtype"] = pikepdf.Name.Image
    image["/Filter"] = pikepdf.Name("/NoSuchDecode")
    appearance = pdf.make_stream(b"/Im0 Do")
    appearance["/Subtype"] = pikepdf.Name.Form
    appearance["/BBox"] = pikepdf.Array([0, 0, 8, 8])
    appearance["/Resources"] = pikepdf.Dictionary(
        XObject=pikepdf.Dictionary(Im0=pdf.make_indirect(image))
    )
    page.obj["/Annots"] = pikepdf.Array(
        [
            pdf.make_indirect(
                pikepdf.Dictionary(
                    Type=pikepdf.Name.Annot,
                    Subtype=pikepdf.Name.Stamp,
                    Rect=pikepdf.Array([0, 0, 8, 8]),
                    AP=pikepdf.Dictionary(N=pdf.make_indirect(appearance)),
                )
            )
        ]
    )
    pdf.save(path)
    assert len(_codes(document_health(path), "page.imageUnreadable")) == 1


def test_a_pixel_codec_is_reported_as_not_decoded_never_as_checked(tmp_dir):
    """A JPEG's pixels are not decoded anywhere in this process. The ledger has
    to say so, and must not say the image failed to read."""
    path = _image_pdf(
        os.path.join(tmp_dir, "jpeg.pdf"), filter_name="/DCTDecode", nested=False
    )
    report = document_health(path)
    assert _codes(report, "page.imageUnreadable") == []
    note = _codes(report, "document.imagesNotDecoded")
    assert len(note) == 1
    assert note[0]["severity"] == "info"
    assert note[0]["params"]["count"] == 1
    # An unchecked image is not a damaged one: the note must not drag the
    # document's collection status.
    assert report["status"] == "collected"


def test_a_general_filter_image_carries_no_not_decoded_note(tmp_dir):
    path = os.path.join(tmp_dir, "flate.pdf")
    pdf = pikepdf.Pdf.new()
    page = pdf.add_blank_page(page_size=(200, 200))
    image = pdf.make_stream(zlib.compress(b"\x00" * 64))
    image["/Subtype"] = pikepdf.Name.Image
    image["/Filter"] = pikepdf.Name.FlateDecode
    page.obj["/Resources"] = pikepdf.Dictionary(
        XObject=pikepdf.Dictionary(Im0=pdf.make_indirect(image))
    )
    pdf.save(path)
    report = document_health(path)
    assert _codes(report, "document.imagesNotDecoded") == []
    assert _codes(report, "page.imageUnreadable") == []


def test_an_unreadable_acroform_is_undetermined_never_absent(tmp_dir):
    """A form that will not read is not the same answer as no form."""

    class Exploding:
        def get(self, _key):
            raise ValueError("broken AcroForm")

    pdf = SimpleNamespace(Root=SimpleNamespace(get=lambda _key: Exploding()))
    facts = _document_facts(pdf)
    assert [f["code"] for f in facts] == ["document.acroFormUnreadable"]
    assert facts[0]["kind"] == "undetermined"


def test_a_wrong_typed_acroform_is_undetermined(tmp_dir):
    path = os.path.join(tmp_dir, "bad-acroform.pdf")
    pdf = pikepdf.Pdf.new()
    pdf.add_blank_page(page_size=(200, 200))
    pdf.Root["/AcroForm"] = pikepdf.Name("/NotADictionary")
    pdf.save(path)
    report = document_health(path)
    assert _codes(report, "document.acroFormUnreadable")
    assert report["status"] == "undetermined"


def test_static_xfa_is_not_reported_as_skipped(tmp_dir):
    """Static hybrid XFA is filled through the PDF field objects, so nothing
    about it is skipped."""
    for as_array in (False, True):
        path = _xfa_pdf(
            os.path.join(tmp_dir, f"static-{as_array}.pdf"),
            dynamic=False,
            as_array=as_array,
        )
        report = document_health(path)
        assert _codes(report, "document.xfa") == []
        assert report["status"] == "collected"


def test_dynamic_xfa_is_reported_as_skipped(tmp_dir):
    for as_array in (False, True):
        path = _xfa_pdf(
            os.path.join(tmp_dir, f"dynamic-{as_array}.pdf"),
            dynamic=True,
            as_array=as_array,
        )
        assert _codes(document_health(path), "document.xfa")


def test_an_unknown_qpdf_warning_is_undetermined_never_a_repair():
    """qpdf named something this build cannot classify. Calling that a repair
    claims a repair qpdf never described."""
    assert _classify_warning("warning: a future qpdf warning") == "qpdf.unclassifiedWarning"
    assert _classify_warning("attempting to reconstruct cross-reference table") == (
        "xref.reconstructed"
    )


def test_an_unknown_warning_carries_no_path_and_no_sentence():
    from engine.document_health import _qpdf_facts

    sentence = 'WARNING: C:\\Users\\someone\\file.pdf (offset 1234): a novel complaint'
    facts = _qpdf_facts(SimpleNamespace(get_warnings=lambda: [sentence]))
    assert len(facts) == 1
    assert facts[0]["code"] == "qpdf.unclassifiedWarning"
    assert facts[0]["kind"] == "undetermined"
    marker = facts[0]["params"]["warning"]
    assert marker and marker not in sentence
    for value in facts[0]["params"].values():
        text = str(value)
        assert "someone" not in text and "novel complaint" not in text


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
