"""F10 — persistent redaction marks as real /Redact annotations.

Save replaces the file's /Redact set (idempotent); list feeds the canvas
re-seed; APPLY consumes overlapping marks through the redaction engine's
own fail-closed annotation sweep. Payload geometry is the redaction apply's
exact shape, so the two flows cannot disagree.
"""

import os

import pikepdf
import pytest

from engine.redact import redact
from engine.redact_marks import list_redact_annotations, save_redaction_marks


@pytest.fixture
def tmp_dir(tmp_path):
    return str(tmp_path)


def _pdf(path, pages=2):
    pdf = pikepdf.new()
    for _ in range(pages):
        page = pdf.add_blank_page(page_size=(300, 400))
        page.Contents = pdf.make_stream(b"0 g 10 10 50 50 re f")
        page.obj["/Resources"] = pikepdf.Dictionary()
    pdf.save(path)


def _redacts(path):
    out = []
    with pikepdf.open(path) as pdf:
        for i, page in enumerate(pdf.pages):
            for a in page.obj.get("/Annots") or []:
                if a.get("/Subtype") == pikepdf.Name("/Redact"):
                    out.append((i + 1, [float(v) for v in a["/Rect"]]))
    return out


class TestSaveAndList:
    def test_round_trip(self, tmp_dir):
        src = os.path.join(tmp_dir, "s.pdf")
        _pdf(src)
        r = save_redaction_marks(src, src, [
            {"page": 1, "rect": [20, 30, 120, 90]},
            {"page": 2, "rect": [50, 50, 100, 100]},
        ])
        assert r["saved"] == 2
        assert r["removed_previous"] == 0
        listed = list_redact_annotations(src)
        assert listed["count"] == 2
        assert listed["marks"][0] == {"page": 1, "rect": [20, 30, 120, 90]}
        assert listed["marks"][1]["page"] == 2
        # The mark never prints as if it were content, and carries the
        # format's applied-fill and a visible AP for other viewers.
        with pikepdf.open(src) as pdf:
            a = pdf.pages[0].obj["/Annots"][0]
            assert int(a.get("/F", -1)) == 0
            assert a.get("/AP") is not None
            assert [float(v) for v in a["/IC"]] == [0, 0, 0]

    def test_save_replaces_existing_set(self, tmp_dir):
        src = os.path.join(tmp_dir, "s.pdf")
        _pdf(src)
        save_redaction_marks(src, src, [{"page": 1, "rect": [10, 10, 40, 40]}])
        r = save_redaction_marks(src, src, [{"page": 2, "rect": [60, 60, 90, 90]}])
        assert r["removed_previous"] == 1
        listed = list_redact_annotations(src)
        assert listed["count"] == 1
        assert listed["marks"][0]["page"] == 2

    def test_save_empty_clears(self, tmp_dir):
        src = os.path.join(tmp_dir, "s.pdf")
        _pdf(src)
        save_redaction_marks(src, src, [{"page": 1, "rect": [10, 10, 40, 40]}])
        r = save_redaction_marks(src, src, [])
        assert r == {"output": src, "saved": 0, "removed_previous": 1}
        assert list_redact_annotations(src)["count"] == 0

    def test_other_annotations_survive_the_replace(self, tmp_dir):
        src = os.path.join(tmp_dir, "s.pdf")
        _pdf(src)
        with pikepdf.open(src, allow_overwriting_input=True) as pdf:
            square = pdf.make_indirect(pikepdf.Dictionary(
                Type=pikepdf.Name("/Annot"), Subtype=pikepdf.Name("/Square"),
                Rect=pikepdf.Array([200, 200, 250, 250]), F=4,
            ))
            pdf.pages[0].obj["/Annots"] = pikepdf.Array([square])
            pdf.save(src)
        save_redaction_marks(src, src, [{"page": 1, "rect": [10, 10, 40, 40]}])
        with pikepdf.open(src) as pdf:
            subtypes = sorted(str(a["/Subtype"]) for a in pdf.pages[0].obj["/Annots"])
        assert subtypes == ["/Redact", "/Square"]

    @pytest.mark.parametrize("bad,match", [
        ([{"page": 9, "rect": [0, 0, 10, 10]}], "out of range"),
        ([{"page": 1, "rect": [0, 0, 10]}], "rect"),
        ([{"page": 1, "rect": [10, 10, 10, 40]}], "positive"),
    ])
    def test_refusals(self, tmp_dir, bad, match):
        src = os.path.join(tmp_dir, "s.pdf")
        _pdf(src)
        with pytest.raises(ValueError, match=match):
            save_redaction_marks(src, src, bad)

    def test_apply_consumes_overlapping_marks(self, tmp_dir):
        # The interplay that makes persistence safe: applying a redaction
        # sweeps every annotation overlapping the region (fail-closed), so
        # an applied mark cannot outlive its own application — while a mark
        # elsewhere survives untouched.
        src = os.path.join(tmp_dir, "s.pdf")
        out = os.path.join(tmp_dir, "o.pdf")
        _pdf(src, pages=1)
        save_redaction_marks(src, src, [
            {"page": 1, "rect": [10, 10, 60, 60]},     # will be applied
            {"page": 1, "rect": [200, 300, 250, 350]}, # stays pending
        ])
        redact(file=src, output=out, regions=[{"page": 1, "rect": [10, 10, 60, 60]}])
        remaining = _redacts(out)
        assert remaining == [(1, [200, 300, 250, 350])]

    def test_signed_document_marks_preserve_signature(self, tmp_dir):
        from tests.test_incremental import _base_pdf, _assert_sig_still_valid, _PKI
        from tests.test_pades import _build_pki
        from engine.signatures import sign_pdf

        pki = _PKI or _build_pki(tmp_dir)
        base = os.path.join(tmp_dir, "b.pdf")
        _base_pdf(base)
        signed = os.path.join(tmp_dir, "signed.pdf")
        sign_pdf(base, signed, pfx_path=pki["pfx"], password="pw")
        orig = open(signed, "rb").read()

        r = save_redaction_marks(signed, signed, [{"page": 1, "rect": [30, 30, 90, 90]}])
        assert r.get("signatures_preserved") is True
        assert open(signed, "rb").read()[: len(orig)] == orig
        _assert_sig_still_valid(signed, pki)
        assert list_redact_annotations(signed)["count"] == 1
