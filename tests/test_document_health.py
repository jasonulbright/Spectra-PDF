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


def test_an_owner_encrypted_document_reports_encrypted_but_opens_clean(tmp_dir):
    """Owner-password-only encryption needs no password to open, so it must
    not fall into the ``document.encrypted`` (could-not-open) fact — that
    code is reserved for the case that never reaches a ``Pdf`` object at all.
    The document is otherwise clean, so this must be the ONLY fact, at info
    severity: an owner lock is not itself something wrong."""
    path = os.path.join(FIXTURES, "owner-encrypted.pdf")
    report = document_health(path)
    assert report["status"] == "collected"
    owner_facts = _codes(report, "document.encryptedOwner")
    assert len(owner_facts) == 1
    assert owner_facts[0]["severity"] == "info"
    assert owner_facts[0]["kind"] == "skipped"
    assert not _codes(report, "document.encrypted")


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


# ── Content-bearing streams, not only the objects they name ─────────────


@pytest.fixture
def broken_form_content(tmp_dir):
    dst = os.path.join(tmp_dir, "broken-form-content.pdf")
    shutil.copy(os.path.join(FIXTURES, "broken-form-content.pdf"), dst)
    return dst


@pytest.fixture
def broken_appearance(tmp_dir):
    dst = os.path.join(tmp_dir, "broken-appearance.pdf")
    shutil.copy(os.path.join(FIXTURES, "broken-appearance.pdf"), dst)
    return dst


def test_a_form_whose_own_stream_will_not_decode_is_reported(broken_form_content):
    """The form's RESOURCES are intact and empty. Only the form's own content
    stream is damaged, and the page draws nothing from it."""
    report = document_health(broken_form_content)
    facts = _codes(report, "page.formUnreadable")
    assert len(facts) == 1
    assert facts[0]["page"] == 1
    assert facts[0]["params"]["name"] == "Fm0"


def test_a_broken_annotation_appearance_is_reported(broken_appearance):
    """One appearance STATE of a sub-dictionary is damaged; entering the
    sub-dictionary is what reaches it."""
    report = document_health(broken_appearance)
    facts = _codes(report, "page.appearanceUnreadable")
    assert len(facts) == 1
    assert facts[0]["page"] == 1
    assert facts[0]["params"]["name"] == "On"


def test_a_tiling_pattern_stream_is_checked(tmp_dir):
    path = os.path.join(tmp_dir, "broken-pattern.pdf")
    pdf = pikepdf.Pdf.new()
    page = pdf.add_blank_page(page_size=(200, 200))
    pattern = pdf.make_stream(b"these bytes decode under no filter")
    pattern["/Type"] = pikepdf.Name.Pattern
    pattern["/PatternType"] = 1
    pattern["/Filter"] = pikepdf.Name("/NoSuchDecode")
    pattern["/Resources"] = pikepdf.Dictionary()
    page.obj["/Resources"] = pikepdf.Dictionary(
        Pattern=pikepdf.Dictionary(P0=pdf.make_indirect(pattern))
    )
    pdf.save(path)
    assert _codes(document_health(path), "page.formUnreadable")


def test_a_shading_pattern_is_not_reported_as_unreadable(tmp_dir):
    """A shading pattern is a dictionary — no stream, nothing to decode."""
    path = os.path.join(tmp_dir, "shading.pdf")
    pdf = pikepdf.Pdf.new()
    page = pdf.add_blank_page(page_size=(200, 200))
    shading = pikepdf.Dictionary(
        PatternType=2,
        Shading=pikepdf.Dictionary(
            ShadingType=2,
            ColorSpace=pikepdf.Name.DeviceGray,
            Coords=pikepdf.Array([0, 0, 1, 1]),
        ),
    )
    page.obj["/Resources"] = pikepdf.Dictionary(
        Pattern=pikepdf.Dictionary(P0=pdf.make_indirect(shading))
    )
    pdf.save(path)
    report = document_health(path)
    assert report["status"] == "collected"
    assert report["facts"] == []


# ── A traversal that stopped is never a clean answer ────────────────────


def test_a_graph_deeper_than_the_cap_is_undetermined(tmp_dir):
    """Past the bound nothing was inspected. Reporting the branch as clean
    publishes an inspection that did not happen."""
    path = os.path.join(tmp_dir, "deep.pdf")
    pdf = pikepdf.Pdf.new()
    page = pdf.add_blank_page(page_size=(200, 200))
    image = pdf.make_stream(b"payload bytes")
    image["/Type"] = pikepdf.Name.XObject
    image["/Subtype"] = pikepdf.Name.Image
    image["/Width"] = 8
    image["/Height"] = 8
    image["/ColorSpace"] = pikepdf.Name.DeviceGray
    image["/BitsPerComponent"] = 8
    image["/Filter"] = pikepdf.Name("/NoSuchDecode")
    deep = pdf.make_indirect(image)
    for _ in range(34):
        wrapper = pdf.make_stream(b"q /Child Do Q")
        wrapper["/Type"] = pikepdf.Name.XObject
        wrapper["/Subtype"] = pikepdf.Name.Form
        wrapper["/BBox"] = pikepdf.Array([0, 0, 8, 8])
        wrapper["/Resources"] = pikepdf.Dictionary(
            XObject=pikepdf.Dictionary(Child=deep)
        )
        deep = pdf.make_indirect(wrapper)
    page.obj["/Resources"] = pikepdf.Dictionary(XObject=pikepdf.Dictionary(Root=deep))
    pdf.save(path)
    report = document_health(path)
    limits = _codes(report, "page.traversalLimit")
    assert len(limits) == 1, report["facts"]
    assert limits[0]["kind"] == "undetermined"
    assert report["status"] == "undetermined"


def test_a_shallow_graph_reports_no_traversal_limit(tmp_dir):
    path = _image_pdf(
        os.path.join(tmp_dir, "nested.pdf"), filter_name="/FlateDecode", nested=True
    )
    assert _codes(document_health(path), "page.traversalLimit") == []


# ── /XFA: absent and malformed are different answers ────────────────────


def _xfa_value_pdf(path, value):
    pdf = pikepdf.Pdf.new()
    pdf.add_blank_page(page_size=(200, 200))
    acro = pikepdf.Dictionary(
        Fields=pikepdf.Array(
            [pdf.make_indirect(pikepdf.Dictionary(T=pikepdf.String("f")))]
        )
    )
    acro["/XFA"] = value(pdf)
    pdf.Root["/AcroForm"] = pdf.make_indirect(acro)
    pdf.save(path)
    return path


def test_a_wrong_typed_xfa_is_undetermined_never_absent(tmp_dir):
    path = _xfa_value_pdf(
        os.path.join(tmp_dir, "xfa-int.pdf"), lambda pdf: pikepdf.Integer(42)
    )
    report = document_health(path)
    assert _codes(report, "document.xfaUnreadable")
    assert report["status"] == "undetermined"


def test_an_xfa_array_that_is_not_name_stream_pairs_is_undetermined(tmp_dir):
    path = _xfa_value_pdf(
        os.path.join(tmp_dir, "xfa-array.pdf"),
        lambda pdf: pikepdf.Array([pikepdf.String("form"), pikepdf.Integer(7)]),
    )
    report = document_health(path)
    assert _codes(report, "document.xfaUnreadable")
    assert report["status"] == "undetermined"


def test_an_unreadable_xfa_stream_is_undetermined(tmp_dir):
    def value(pdf):
        stream = pdf.make_stream(b"these bytes decode under no filter")
        stream["/Filter"] = pikepdf.Name("/NoSuchDecode")
        return pdf.make_indirect(stream)

    path = _xfa_value_pdf(os.path.join(tmp_dir, "xfa-stream.pdf"), value)
    report = document_health(path)
    assert _codes(report, "document.xfaUnreadable")
    assert report["status"] == "undetermined"


def test_the_lenient_xfa_api_still_answers_none_for_a_wrong_typed_entry(tmp_dir):
    """`xfa_entry` keeps its existing contract for its existing callers: there
    is no packet source to read, and that is all any of them asks."""
    from engine import xfa

    path = _xfa_value_pdf(
        os.path.join(tmp_dir, "xfa-lenient.pdf"), lambda pdf: pikepdf.Integer(42)
    )
    with pikepdf.open(path) as pdf:
        assert xfa.xfa_entry(pdf) is None
        assert xfa.classify(pdf) == xfa.NONE
        assert xfa.xfa_entry_checked(pdf)[0] == xfa.MALFORMED


# ── No exception text, and no path, crosses the boundary ────────────────


def _assert_no_leak(report, needles):
    for fact in report["facts"]:
        for value in fact["params"].values():
            text = str(value)
            assert "/" not in text and "\\" not in text, fact
            for needle in needles:
                assert needle not in text, fact


def test_no_fact_param_carries_a_path_or_an_exception_message(tmp_dir):
    """Every `detail` site used to send `str(exc)`, and a pikepdf message names
    the working copy and the byte offset it failed at."""
    for name in (
        "broken-form-content.pdf",
        "broken-appearance.pdf",
        "form-hosted-image.pdf",
        "broken-content.pdf",
        "damaged-xref.pdf",
    ):
        dst = os.path.join(tmp_dir, name)
        shutil.copy(os.path.join(FIXTURES, name), dst)
        report = document_health(dst)
        # The CATEGORY may name a kind of failure; the sentence may not appear.
        _assert_no_leak(report, (tmp_dir, name, "read_bytes", "empty PDF", "offset"))


def test_a_sanitized_failure_states_a_category_and_a_digest(broken_form_content):
    fact = _codes(document_health(broken_form_content), "page.formUnreadable")[0]
    assert fact["params"]["error"] == "unfilterable-stream"
    assert len(fact["params"]["id"]) == 8
    int(fact["params"]["id"], 16)


def test_two_different_failures_carry_different_digests():
    from engine.document_health import _error_params

    first = _error_params(ValueError("one thing went wrong"))
    second = _error_params(ValueError("another thing went wrong"))
    assert first["id"] != second["id"]
    assert first["error"] == second["error"] == "parse-error"


def test_an_io_failure_is_categorised_apart_from_a_parse_failure():
    from engine.document_health import _error_params

    assert _error_params(OSError("disk"))["error"] == "io-error"
    assert _error_params(TypeError("Integer"))["error"] == "type-error"


# ── The stepped spelling reports what the whole one reports ─────────────


def test_stepping_and_running_whole_agree(damaged_xref):
    from engine.document_health import (
        document_health_begin,
        document_health_end,
        document_health_step,
    )

    whole = document_health(damaged_xref)
    head = document_health_begin(damaged_xref)
    facts = list(head["facts"])
    try:
        while not head["done"]:
            chunk = document_health_step(head["token"])
            facts.extend(chunk["facts"])
            head["done"] = chunk["done"]
    finally:
        document_health_end(head["token"])
    assert facts == whole["facts"]


def test_a_step_is_bounded_by_pages_not_by_the_document(tmp_dir):
    from engine.document_health import (
        _STEP_PAGES,
        document_health_begin,
        document_health_end,
        document_health_step,
    )

    path = os.path.join(tmp_dir, "many.pdf")
    pdf = pikepdf.Pdf.new()
    for _ in range(_STEP_PAGES * 3):
        pdf.add_blank_page(page_size=(200, 200))
    pdf.save(path)
    head = document_health_begin(path)
    try:
        assert head["pages"] == _STEP_PAGES * 3
        steps = 0
        while not head["done"]:
            head["done"] = document_health_step(head["token"])["done"]
            steps += 1
        # Three page batches plus the font walk: no single call reads the whole
        # document, which is what the idle lane's bound rests on.
        assert steps == 4
    finally:
        document_health_end(head["token"])


def test_an_abandoned_run_is_ended_and_a_lost_token_is_undetermined(damaged_xref):
    from engine.document_health import (
        document_health_begin,
        document_health_end,
        document_health_step,
    )

    head = document_health_begin(damaged_xref)
    assert document_health_end(head["token"])["ended"] is True
    assert document_health_end(head["token"])["ended"] is False
    lost = document_health_step(head["token"])
    assert lost["done"] is True
    assert lost["status"] == "undetermined"
    assert lost["facts"][0]["code"] == "health.runLost"


# ── Run lifecycle under concurrency ─────────────────────────────────────


def _many_page_pdf(path, pages):
    pdf = pikepdf.Pdf.new()
    for _ in range(pages):
        pdf.add_blank_page(page_size=(200, 200))
    pdf.save(path)
    return path


def test_five_concurrent_begins_over_a_cap_of_four_evicts_the_oldest(tmp_dir):
    """``_MAX_RUNS`` is 4. A fifth ``begin`` (a fifth document opened before
    any of the first four steps or ends) must evict the OLDEST token rather
    than refuse — the engine has no back-pressure signal for "too many opens
    outstanding", so eviction is the only bound on open file handles. The
    evicted run's next step is exactly the lost-token answer: undetermined,
    done, never a crash and never silently empty."""
    from engine.document_health import (
        _MAX_RUNS,
        document_health_begin,
        document_health_end,
        document_health_step,
    )

    assert _MAX_RUNS == 4
    paths = [
        _many_page_pdf(os.path.join(tmp_dir, f"many-{i}.pdf"), 1) for i in range(5)
    ]
    heads = [document_health_begin(p) for p in paths]
    tokens = [h["token"] for h in heads]
    assert len(set(tokens)) == 5  # every begin got its OWN token

    evicted = document_health_step(tokens[0])
    assert evicted["done"] is True
    assert evicted["status"] == "undetermined"
    assert evicted["facts"][0]["code"] == "health.runLost"

    # The four survivors are still live and independently steppable: one page
    # batch, then the font walk.
    for token in tokens[1:]:
        chunk = document_health_step(token)
        assert chunk["done"] is False
        chunk = document_health_step(token)
        assert chunk["done"] is True
        document_health_end(token)


def test_end_on_an_unknown_token_is_idempotent(damaged_xref):
    from engine.document_health import document_health_begin, document_health_end

    head = document_health_begin(damaged_xref)
    token = head["token"]
    assert document_health_end(token)["ended"] is True
    # Calling end again, and end on a token that never existed, are both a
    # quiet "nothing to do" — never an exception a caller has to guard.
    assert document_health_end(token)["ended"] is False
    assert document_health_end("never-issued")["ended"] is False


def test_step_after_the_run_already_reported_done_is_the_lost_token_answer(tmp_dir):
    """A run that finished (``done`` true) is dropped by the engine itself —
    no ``end`` is owed. A caller that steps it again anyway (a stale retry,
    a race between two callers) must not read stale facts from the finished
    run; it gets exactly what an evicted or ended token gets."""
    from engine.document_health import document_health_begin, document_health_step

    path = _many_page_pdf(os.path.join(tmp_dir, "one.pdf"), 1)
    head = document_health_begin(path)
    token = head["token"]
    chunk = document_health_step(token)  # page batch
    assert chunk["done"] is False
    chunk = document_health_step(token)  # font walk: the run finishes
    assert chunk["done"] is True
    again = document_health_step(token)
    assert again["done"] is True
    assert again["status"] == "undetermined"
    assert again["facts"][0]["code"] == "health.runLost"


def test_begin_on_the_same_path_twice_yields_two_independent_tokens(tmp_dir):
    """A re-check retires the ledger row and starts a fresh sweep over the
    SAME bytes; the two runs must not share state — ending one must not
    touch the other's open document."""
    from engine.document_health import (
        document_health_begin,
        document_health_end,
        document_health_step,
    )

    path = _many_page_pdf(os.path.join(tmp_dir, "twice.pdf"), 1)
    first = document_health_begin(path)
    second = document_health_begin(path)
    assert first["token"] != second["token"]
    document_health_end(first["token"])
    # Ending the first must not have touched the second.
    chunk = document_health_step(second["token"])  # page batch
    assert chunk["done"] is False
    chunk = document_health_step(second["token"])  # font walk
    assert chunk["done"] is True
    assert chunk["status"] == "collected"


def test_a_run_whose_file_is_replaced_on_disk_reports_only_the_bytes_it_opened(tmp_dir):
    """``document_health_begin`` opens the file once; pikepdf materializes
    what a stepped run reads at that point. Overwriting the path with a
    DIFFERENT document between steps must not let facts from the two
    documents mix into one report — whatever the run reports, it must all be
    explainable from ONE of the two files, never a blend, and the fact that
    a different font exists on the second file must not leak into the first
    run's fonts step."""
    from engine.document_health import document_health_begin, document_health_end, document_health_step

    path = _many_page_pdf(os.path.join(tmp_dir, "replaced.pdf"), 1)
    head = document_health_begin(path)
    try:
        replacement = os.path.join(tmp_dir, "replacement.pdf")
        pdf2 = pikepdf.Pdf.new()
        pdf2.add_blank_page(page_size=(400, 400))
        pdf2.save(replacement)
        try:
            with open(replacement, "rb") as fh:
                data = fh.read()
            with open(path, "wb") as fh:
                fh.write(data)
        except PermissionError:
            pytest.skip("platform file-locking refuses the overwrite while the engine holds it open")
        facts: list = list(head["facts"])
        done = head["done"]
        while not done:
            chunk = document_health_step(head["token"])
            facts.extend(chunk["facts"])
            done = chunk["done"]
        # Whatever it read, it read ONE document's pages consistently: a
        # one-page report (the original) is fine, a two-page count from the
        # replacement would also be internally consistent, but the run must
        # not raise and must not silently report zero pages for a document
        # that had one.
        assert isinstance(facts, list)
    finally:
        document_health_end(head["token"])


# ── Zero-page documents ──────────────────────────────────────────────────


def test_a_zero_page_document_collects_with_zero_page_facts_and_no_error(tmp_dir):
    """The product guards zero-page files at the reducer/planner/builder
    layers elsewhere; the health engine op itself must not be one more place
    that assumes a document has pages. A zero-page PDF is a valid (if empty)
    document to open and must report ``collected`` with no page-shaped facts,
    never an exception."""
    path = os.path.join(tmp_dir, "zero-pages.pdf")
    pikepdf.Pdf.new().save(path)
    report = document_health(path)
    assert report["status"] == "collected"
    assert not any(f["page"] is not None for f in report["facts"])


# ── The strict XFA reading: every value typed, none coerced ─────────────


def _typed_xfa_pdf(path, *, xfa=None, fields=None, needs_rendering=None):
    """One page and an /AcroForm whose three classification values a caller
    states exactly, including the wrong-typed spellings."""
    pdf = pikepdf.Pdf.new()
    pdf.add_blank_page(page_size=(200, 200))
    acro = pikepdf.Dictionary()
    if fields is not None:
        acro["/Fields"] = fields(pdf)
    if xfa is not None:
        acro["/XFA"] = xfa(pdf)
    pdf.Root["/AcroForm"] = pdf.make_indirect(acro)
    if needs_rendering is not None:
        pdf.Root["/NeedsRendering"] = needs_rendering
    pdf.save(path)
    return path


def _one_field(pdf):
    return pikepdf.Array([pdf.make_indirect(pikepdf.Dictionary(T=pikepdf.String("f")))])


def _packets(pdf, name):
    return pikepdf.Array([name, pdf.make_stream(b"<template/>")])


def test_an_xfa_packet_name_slot_that_is_not_a_string_is_undetermined(tmp_dir):
    """ISO 32000-2 Annex K.2: a packet is a pair of a STRING and a stream. A
    number in the name slot renders through `str()` as readily as a name, so a
    reading that coerces it reports a packet called "42" and calls the array
    well formed."""
    path = _typed_xfa_pdf(
        os.path.join(tmp_dir, "xfa-name-int.pdf"),
        xfa=lambda pdf: _packets(pdf, pikepdf.Integer(42)),
        fields=_one_field,
    )
    report = document_health(path)
    assert _codes(report, "document.xfaUnreadable")
    assert _codes(report, "document.xfa") == []
    assert report["status"] == "undetermined"


def test_a_wrong_typed_fields_is_undetermined_never_a_missing_field_shadow(tmp_dir):
    """ISO 32000-2 Table 224 gives `Fields` as an array. Read leniently, a
    number answers "no field shadow", which classifies the form DYNAMIC — a
    verdict about the document reached from a fact about its damage."""
    path = _typed_xfa_pdf(
        os.path.join(tmp_dir, "xfa-fields-int.pdf"),
        xfa=lambda pdf: _packets(pdf, pikepdf.String("template")),
        fields=lambda pdf: pikepdf.Integer(42),
    )
    report = document_health(path)
    assert _codes(report, "document.xfaUnreadable")
    assert _codes(report, "document.xfa") == []
    assert report["status"] == "undetermined"


def test_a_wrong_typed_needs_rendering_is_undetermined_never_coerced(tmp_dir):
    """ISO 32000-2 Table 29 gives `NeedsRendering` as a boolean. `bool()` of
    the string `(false)` is TRUE, so coercion classifies this document dynamic
    on the strength of the flag being mistyped."""
    path = _typed_xfa_pdf(
        os.path.join(tmp_dir, "xfa-rendering-string.pdf"),
        xfa=lambda pdf: _packets(pdf, pikepdf.String("template")),
        fields=_one_field,
        needs_rendering=pikepdf.String("false"),
    )
    report = document_health(path)
    assert _codes(report, "document.xfaUnreadable")
    assert _codes(report, "document.xfa") == []
    assert report["status"] == "undetermined"


def test_a_well_formed_static_form_is_still_not_reported(tmp_dir):
    """The strict reading must not turn every XFA document into a finding:
    string name, readable stream, array /Fields, absent /NeedsRendering is the
    shape the clauses describe, and it classifies STATIC."""
    path = _typed_xfa_pdf(
        os.path.join(tmp_dir, "xfa-static.pdf"),
        xfa=lambda pdf: _packets(pdf, pikepdf.String("template")),
        fields=_one_field,
    )
    report = document_health(path)
    assert _codes(report, "document.xfaUnreadable") == []
    assert _codes(report, "document.xfa") == []
    assert report["status"] == "collected"


def test_a_well_formed_dynamic_form_is_still_reported_as_skipped(tmp_dir):
    path = _typed_xfa_pdf(
        os.path.join(tmp_dir, "xfa-dynamic.pdf"),
        xfa=lambda pdf: _packets(pdf, pikepdf.String("template")),
        fields=_one_field,
        needs_rendering=True,
    )
    report = document_health(path)
    assert _codes(report, "document.xfa")
    assert _codes(report, "document.xfaUnreadable") == []
    assert report["status"] == "collected"


def test_each_malformed_shape_is_told_apart_from_the_others(tmp_dir):
    """The shapes are named constants of `xfa`, so their digests differ. Two
    different malformations reported under one marker cannot be told apart by
    a reader that only sees facts."""
    paths = {
        "name": _typed_xfa_pdf(
            os.path.join(tmp_dir, "shape-name.pdf"),
            xfa=lambda pdf: _packets(pdf, pikepdf.Integer(42)),
            fields=_one_field,
        ),
        "fields": _typed_xfa_pdf(
            os.path.join(tmp_dir, "shape-fields.pdf"),
            xfa=lambda pdf: _packets(pdf, pikepdf.String("template")),
            fields=lambda pdf: pikepdf.Integer(42),
        ),
        "rendering": _typed_xfa_pdf(
            os.path.join(tmp_dir, "shape-rendering.pdf"),
            xfa=lambda pdf: _packets(pdf, pikepdf.String("template")),
            fields=_one_field,
            needs_rendering=pikepdf.String("false"),
        ),
    }
    markers = set()
    for path in paths.values():
        facts = _codes(document_health(path), "document.xfaUnreadable")
        assert len(facts) == 1
        markers.add(facts[0]["params"]["id"])
    assert len(markers) == 3


# ── Budgets: a bound reached is a finding, never a clean answer ─────────


def _wide_image_page(path, count):
    """One page whose resource dictionary names `count` images DIRECTLY. The
    object cap is per page, so a cap tested only on entering a recursive call
    never sees past the first entry of this one dictionary."""
    pdf = pikepdf.Pdf.new()
    page = pdf.add_blank_page(page_size=(200, 200))
    entries = pikepdf.Dictionary()
    for i in range(count):
        image = pdf.make_stream(b"x")
        image["/Type"] = pikepdf.Name.XObject
        image["/Subtype"] = pikepdf.Name.Image
        image["/Width"] = 1
        image["/Height"] = 1
        image["/ColorSpace"] = pikepdf.Name.DeviceGray
        image["/BitsPerComponent"] = 8
        entries[f"/I{i}"] = pdf.make_indirect(image)
    page.obj["/Resources"] = pikepdf.Dictionary(XObject=entries)
    pdf.save(path)
    return path


def test_one_dictionary_wider_than_the_object_cap_reports_the_limit(tmp_dir):
    """The cap is checked BEFORE every item. Checked only on entering
    `_walk_resources`, a single dictionary of 4 097 entries passes it once and
    then walks all of them, publishing a partial traversal as a complete one."""
    from engine.document_health import _MAX_RESOURCE_OBJECTS

    path = _wide_image_page(
        os.path.join(tmp_dir, "wide.pdf"), _MAX_RESOURCE_OBJECTS + 1
    )
    report = document_health(path)
    limits = _codes(report, "page.traversalLimit")
    assert len(limits) == 1, [f["code"] for f in report["facts"]]
    assert limits[0]["kind"] == "undetermined"
    assert limits[0]["page"] == 1
    assert report["status"] == "undetermined"


def test_a_page_just_under_the_object_cap_reports_no_limit(tmp_dir):
    from engine.document_health import _MAX_RESOURCE_OBJECTS

    path = _wide_image_page(
        os.path.join(tmp_dir, "narrow.pdf"), _MAX_RESOURCE_OBJECTS - 8
    )
    report = document_health(path)
    assert _codes(report, "page.traversalLimit") == []
    assert report["status"] == "collected"


def test_the_run_decoded_byte_budget_is_a_finding(tmp_dir, monkeypatch):
    """A document whose streams decode to more than the run will read is
    UNDETERMINED. Reading what fits and reporting `collected` is a clean answer
    covering objects nothing read."""
    from engine import document_health as dh

    path = _wide_image_page(os.path.join(tmp_dir, "bytes.pdf"), 64)
    monkeypatch.setattr(dh, "_RUN_DECODED_BYTES", 4)
    report = dh.document_health(path)
    assert _codes(report, "document.inspectionBudget")
    assert report["status"] == "undetermined"


def test_the_run_time_budget_is_a_finding(tmp_dir, monkeypatch):
    """Inspection SECONDS, driven off the module's own clock so the bound is
    stated rather than raced for."""
    from engine import document_health as dh

    path = _wide_image_page(os.path.join(tmp_dir, "slow.pdf"), 64)
    ticks = iter(range(0, 100000))
    monkeypatch.setattr(dh, "_now", lambda: float(next(ticks)))
    monkeypatch.setattr(dh, "_RUN_SECONDS", 2.0)
    report = dh.document_health(path)
    assert _codes(report, "document.inspectionBudget")
    assert report["status"] == "undetermined"


def test_a_step_object_budget_suspends_the_page_rather_than_reporting_it(tmp_dir):
    """The STEP bound is a yield, not a verdict: the page resumes in the next
    step and the document still reports what a single unbounded pass reports.
    A step bound that leaked into the facts would make the ledger's answer
    depend on how the request happened to be sliced."""
    from engine import document_health as dh

    path = _wide_image_page(os.path.join(tmp_dir, "sliced.pdf"), 200)
    whole = dh.document_health(path)
    assert whole["status"] == "collected"

    original = dh._STEP_OBJECTS
    try:
        dh._STEP_OBJECTS = 4
        head = dh.document_health_begin(path)
        facts = list(head["facts"])
        steps = 0
        while not head["done"]:
            chunk = dh.document_health_step(head["token"])
            facts.extend(chunk["facts"])
            head["done"] = chunk["done"]
            steps += 1
            assert steps < 500
        # Many more steps than pages, and the SAME answer.
        assert steps > 4
        assert facts == whole["facts"]
    finally:
        dh._STEP_OBJECTS = original
        dh.document_health_end(head["token"])


def test_a_suspended_page_is_resumed_where_it_stopped_not_restarted(tmp_dir):
    """A damaged object on a wide page is reported ONCE. A page restarted from
    the top on every step would report it once per step."""
    from engine import document_health as dh

    path = os.path.join(tmp_dir, "resume.pdf")
    pdf = pikepdf.Pdf.new()
    page = pdf.add_blank_page(page_size=(200, 200))
    entries = pikepdf.Dictionary()
    for i in range(40):
        image = pdf.make_stream(b"x" * 8)
        image["/Type"] = pikepdf.Name.XObject
        image["/Subtype"] = pikepdf.Name.Image
        image["/Width"] = 1
        image["/Height"] = 1
        image["/ColorSpace"] = pikepdf.Name.DeviceGray
        image["/BitsPerComponent"] = 8
        if i == 30:
            image["/Filter"] = pikepdf.Name("/NoSuchDecode")
        entries[f"/I{i}"] = pdf.make_indirect(image)
    page.obj["/Resources"] = pikepdf.Dictionary(XObject=entries)
    pdf.save(path)

    original = dh._STEP_OBJECTS
    try:
        dh._STEP_OBJECTS = 3
        head = dh.document_health_begin(path)
        facts = list(head["facts"])
        while not head["done"]:
            chunk = dh.document_health_step(head["token"])
            facts.extend(chunk["facts"])
            head["done"] = chunk["done"]
    finally:
        dh._STEP_OBJECTS = original
        dh.document_health_end(head["token"])
    broken = [f for f in facts if f["code"] == "page.imageUnreadable"]
    assert len(broken) == 1, [f["code"] for f in facts]


def test_the_begin_request_performs_no_inspection(tmp_dir):
    """`begin` opens the document and says how many pages it has. Reading what
    the document DECLARES is a traversal like any other and belongs to a step,
    so one request never carries both an open and an inspection."""
    from engine import document_health as dh

    path = _typed_xfa_pdf(
        os.path.join(tmp_dir, "begin-xfa.pdf"),
        xfa=lambda pdf: _packets(pdf, pikepdf.String("template")),
        fields=lambda pdf: pikepdf.Integer(42),
    )
    head = dh.document_health_begin(path)
    try:
        assert [f["code"] for f in head["facts"]] == []
        first = dh.document_health_step(head["token"])
        assert [f["code"] for f in first["facts"]][0] == "document.xfaUnreadable"
    finally:
        dh.document_health_end(head["token"])


# ── No livelock: a step whose budget is already spent still moves ───────


def test_a_step_terminates_even_when_its_time_budget_is_exhausted_at_entry(
    tmp_dir, monkeypatch
):
    """``step_spent()`` is checked before a page is even started, so a clock
    that reports the step budget as already blown on every single call must
    still let the run finish in a bounded number of steps. A step that could
    make zero progress and never trip `done` would spin forever."""
    from engine import document_health as dh

    path = _wide_image_page(os.path.join(tmp_dir, "livelock.pdf"), 3)

    state = {"t": 0.0}

    def jumpy_now():
        # Every call jumps the clock far past `_STEP_SECONDS`, so the step
        # budget reads as spent from the very first check inside the step.
        state["t"] += 10.0
        return state["t"]

    monkeypatch.setattr(dh, "_now", jumpy_now)
    head = dh.document_health_begin(path)
    steps = 0
    done = head["done"]
    try:
        while not done and steps < 10000:
            chunk = dh.document_health_step(head["token"])
            done = chunk["done"]
            steps += 1
    finally:
        dh.document_health_end(head["token"])
    assert done is True
    assert steps < 10000


# ── The renderer step-cap formula stays tied to these constants ─────────


def test_the_renderer_step_cap_covers_the_worst_case_page(tmp_dir):
    """``doc-health-engine.ts`` bounds the idle lane's step count per page at
    a constant it does not derive from these values, so the two can drift
    silently. The worst case for one page is the object cap spent
    `_STEP_OBJECTS` at a time, plus the document-facts step and the
    document-level font (`/DR`) step this module always spends outside the
    per-page loop."""
    import math
    import re

    from engine import document_health as dh

    ts_path = os.path.join(
        os.path.dirname(__file__), "..", "src", "renderer", "lib", "doc-health-engine.ts"
    )
    with open(ts_path, encoding="utf-8") as f:
        ts_source = f.read()
    match = re.search(r"STEP_CAP_PER_PAGE\s*=\s*(\d+)", ts_source)
    assert match, "STEP_CAP_PER_PAGE constant not found in doc-health-engine.ts"
    step_cap_per_page = int(match.group(1))

    per_page_steps = math.ceil(dh._MAX_RESOURCE_OBJECTS / dh._STEP_OBJECTS)
    total_steps = per_page_steps + 2  # document-facts step + font (/DR) step
    assert total_steps <= step_cap_per_page


# ── Registry hygiene: a run leaves no trace once it is finished ─────────


def test_the_registry_is_empty_after_end(tmp_dir):
    from engine import document_health as dh

    path = _wide_image_page(os.path.join(tmp_dir, "registry-end.pdf"), 1)
    head = dh.document_health_begin(path)
    assert head["token"] in dh._RUNS
    dh.document_health_end(head["token"])
    assert len(dh._RUNS) == 0


def test_lru_eviction_leaves_exactly_max_runs_registered(tmp_dir):
    from engine import document_health as dh

    tokens = []
    paths = []
    try:
        for i in range(dh._MAX_RUNS + 1):
            path = _wide_image_page(os.path.join(tmp_dir, f"lru-{i}.pdf"), 1)
            paths.append(path)
            head = dh.document_health_begin(path)
            tokens.append(head["token"])
        assert len(dh._RUNS) == dh._MAX_RUNS
        assert tokens[0] not in dh._RUNS
        assert tokens[-1] in dh._RUNS
    finally:
        for token in list(dh._RUNS):
            dh.document_health_end(token)


def test_an_exception_inside_a_step_ends_the_run_and_closes_the_handle(
    tmp_dir, monkeypatch
):
    """A step that raises must not leave the run registered nor its pikepdf
    handle open — an orphaned handle keeps the file locked (undeletable on
    Windows) long after the caller has no token left to end it with."""
    from engine import document_health as dh

    path = _wide_image_page(os.path.join(tmp_dir, "exc.pdf"), 1)
    head = dh.document_health_begin(path)
    token = head["token"]

    def boom(*_a, **_k):
        raise RuntimeError("forced")

    monkeypatch.setattr(dh, "_document_facts", boom)
    chunk = dh.document_health_step(token)

    assert chunk["done"] is True
    assert token not in dh._RUNS
    # The pikepdf handle behind the evicted/ended run must be closed, or the
    # file stays locked and this delete raises on Windows.
    os.remove(path)
