"""Incremental-append editing of SIGNED documents.

The property under test is singular: after an annotate/fill/add-page edit
lands through the transplant, the output STARTS WITH the signed original's
bytes verbatim (so the /ByteRange digest still verifies) AND the edit is
present. Structural edits refuse rather than half-append. The PKI reuses
test_pades' local CA fixture pattern.
"""

import os

import pikepdf
import pytest

from engine.incremental import (
    finalize_preserving_signatures,
    has_live_signatures,
    transplant_incremental,
)
from engine.signatures import sign_pdf, verify_signatures
from tests.test_pades import _build_pki


_PKI: dict | None = None


@pytest.fixture
def pki(tmp_path_factory):
    global _PKI
    if _PKI is None:
        _PKI = _build_pki(str(tmp_path_factory.mktemp("incr-pki")))
    return _PKI


@pytest.fixture
def tmp_dir(tmp_path):
    return str(tmp_path)


def _base_pdf(path, with_form=False, annots=0):
    pdf = pikepdf.new()
    page = pdf.add_blank_page(page_size=(612, 792))
    page.Contents = pdf.make_stream(b"0 g 10 10 100 100 re f")
    entries = []
    for i in range(annots):
        ap = pdf.make_stream(b"1 0 0 rg 0 0 40 40 re f")
        ap.stream_dict["/Type"] = pikepdf.Name("/XObject")
        ap.stream_dict["/Subtype"] = pikepdf.Name("/Form")
        ap.stream_dict["/BBox"] = pikepdf.Array([0, 0, 40, 40])
        entries.append(pdf.make_indirect(pikepdf.Dictionary(
            Type=pikepdf.Name("/Annot"), Subtype=pikepdf.Name("/Square"),
            Rect=pikepdf.Array([50 + 60 * i, 600, 90 + 60 * i, 640]),
            F=4, C=pikepdf.Array([1, 0, 0]),
            NM=pikepdf.String(f"base-annot-{i}"),
            AP=pikepdf.Dictionary(N=ap),
        )))
    if with_form:
        widget = pdf.make_indirect(pikepdf.Dictionary(
            Type=pikepdf.Name("/Annot"), Subtype=pikepdf.Name("/Widget"),
            FT=pikepdf.Name("/Tx"), T=pikepdf.String("name"),
            Rect=pikepdf.Array([50, 500, 250, 530]), F=4,
            V=pikepdf.String("old value"),
            DA=pikepdf.String("/Helv 0 Tf 0 g"),
        ))
        entries.append(widget)
        pdf.Root["/AcroForm"] = pdf.make_indirect(pikepdf.Dictionary(
            Fields=pikepdf.Array([widget]),
            DA=pikepdf.String("/Helv 0 Tf 0 g"),
        ))
    if entries:
        page.obj["/Annots"] = pikepdf.Array(entries)
    pdf.save(path)


def _signed(tmp_dir, pki, name="signed.pdf", **base_kw):
    src = os.path.join(tmp_dir, "base-" + name)
    _base_pdf(src, **base_kw)
    out = os.path.join(tmp_dir, name)
    sign_pdf(src, out, pfx_path=pki["pfx"], password="pw")
    return out


def _rewrite_with(signed_path, tmp_dir, mutate, name="modified.pdf"):
    """Full pikepdf REWRITE of the signed file + a mutation — exactly the
    shape every existing pipeline produces (and exactly what breaks the
    byte range when used directly)."""
    out = os.path.join(tmp_dir, name)
    with pikepdf.open(signed_path) as pdf:
        mutate(pdf)
        pdf.save(out)
    return out


def _add_square(pdf, nm="added-1", color=(0, 0, 1)):
    page = pdf.pages[0]
    ap = pdf.make_stream(b"0 0 1 rg 0 0 50 50 re f")
    ap.stream_dict["/Type"] = pikepdf.Name("/XObject")
    ap.stream_dict["/Subtype"] = pikepdf.Name("/Form")
    ap.stream_dict["/BBox"] = pikepdf.Array([0, 0, 50, 50])
    annot = pdf.make_indirect(pikepdf.Dictionary(
        Type=pikepdf.Name("/Annot"), Subtype=pikepdf.Name("/Square"),
        Rect=pikepdf.Array([200, 300, 250, 350]), F=4,
        C=pikepdf.Array(list(color)),
        NM=pikepdf.String(nm),
        AP=pikepdf.Dictionary(N=ap),
    ))
    annots = page.obj.get("/Annots")
    if annots is None:
        page.obj["/Annots"] = pikepdf.Array([annot])
    else:
        annots.append(annot)


def _assert_sig_still_valid(path, pki):
    r = verify_signatures(path, trust_roots=[pki["ca_pem"]])
    assert len(r["signatures"]) == 1
    sig = r["signatures"][0]
    assert sig["intact"], "signature byte range no longer verifies"
    assert sig["valid"], "signature cryptographically broken"
    assert sig["trusted"], "chain no longer validates against the CA"


class TestTransplant:
    def test_annotation_add_preserves_signature(self, tmp_dir, pki):
        signed = _signed(tmp_dir, pki)
        orig_bytes = open(signed, "rb").read()
        modified = _rewrite_with(signed, tmp_dir, _add_square)
        out = os.path.join(tmp_dir, "out.pdf")

        r = transplant_incremental(signed, modified, out)
        assert r["applied"] is True
        assert r["annots_added"] == 1
        # THE property: original bytes verbatim, revision appended.
        result = open(out, "rb").read()
        assert result[: len(orig_bytes)] == orig_bytes
        assert len(result) > len(orig_bytes)
        _assert_sig_still_valid(out, pki)
        with pikepdf.open(out) as pdf:
            nms = [bytes(a.get("/NM")) for a in pdf.pages[0].obj["/Annots"]
                   if a.get("/NM") is not None]
        assert b"added-1" in nms

    def test_remove_and_recolor_by_nm(self, tmp_dir, pki):
        signed = _signed(tmp_dir, pki, annots=2)

        def mutate(pdf):
            annots = pdf.pages[0].obj["/Annots"]
            keep = [a for a in annots
                    if a.get("/NM") is None or bytes(a["/NM"]) != b"base-annot-0"]
            for a in keep:
                if a.get("/NM") is not None and bytes(a["/NM"]) == b"base-annot-1":
                    a["/C"] = pikepdf.Array([0, 1, 0])  # recolor in place
            pdf.pages[0].obj["/Annots"] = pikepdf.Array(keep)

        modified = _rewrite_with(signed, tmp_dir, mutate)
        out = os.path.join(tmp_dir, "out.pdf")
        r = transplant_incremental(signed, modified, out)
        assert r["applied"] is True
        assert r["annots_removed"] == 1
        assert r["annots_updated"] == 1
        _assert_sig_still_valid(out, pki)
        with pikepdf.open(out) as pdf:
            annots = [a for a in pdf.pages[0].obj["/Annots"]
                      if a.get("/Subtype") == pikepdf.Name("/Square")]
            assert len(annots) == 1
            assert [float(v) for v in annots[0]["/C"]] == [0, 1, 0]

    def test_fill_updates_field_in_place(self, tmp_dir, pki):
        signed = _signed(tmp_dir, pki, with_form=True)

        def mutate(pdf):
            for f in pdf.Root.AcroForm.Fields:
                if f.get("/T") is not None and str(f["/T"]) == "name":
                    f["/V"] = pikepdf.String("NEW VALUE")
                    ap = pdf.make_stream(b"BT /Helv 10 Tf 2 5 Td (NEW VALUE) Tj ET")
                    ap.stream_dict["/Type"] = pikepdf.Name("/XObject")
                    ap.stream_dict["/Subtype"] = pikepdf.Name("/Form")
                    ap.stream_dict["/BBox"] = pikepdf.Array([0, 0, 200, 30])
                    f["/AP"] = pikepdf.Dictionary(N=ap)

        modified = _rewrite_with(signed, tmp_dir, mutate)
        out = os.path.join(tmp_dir, "out.pdf")
        r = transplant_incremental(signed, modified, out)
        assert r["applied"] is True
        assert r["fields_updated"] >= 1
        _assert_sig_still_valid(out, pki)
        with pikepdf.open(out) as pdf:
            field = [f for f in pdf.Root.AcroForm.Fields
                     if f.get("/T") is not None and str(f["/T"]) == "name"][0]
            assert str(field["/V"]) == "NEW VALUE"
            # The widget object was reconciled, not replaced: the page's
            # /Annots still reference the same object that /Fields does.
            page_annots = pdf.pages[0].obj["/Annots"]
            assert any(a.objgen == field.objgen for a in page_annots)

    def test_page_insert_appends(self, tmp_dir, pki):
        signed = _signed(tmp_dir, pki)

        def mutate(pdf):
            page = pdf.add_blank_page(page_size=(612, 792))
            page.Contents = pdf.make_stream(b"0 g 20 20 200 200 re f")

        modified = _rewrite_with(signed, tmp_dir, mutate)
        out = os.path.join(tmp_dir, "out.pdf")
        r = transplant_incremental(signed, modified, out)
        assert r["applied"] is True
        assert r["pages_inserted"] == 1
        _assert_sig_still_valid(out, pki)
        with pikepdf.open(out) as pdf:
            assert len(pdf.pages) == 2

    def test_page_removal_refuses(self, tmp_dir, pki):
        signed = _signed(tmp_dir, pki)

        def mutate(pdf):
            pdf.add_blank_page(page_size=(200, 200))
            del pdf.pages[0]

        modified = _rewrite_with(signed, tmp_dir, mutate)
        out = os.path.join(tmp_dir, "out.pdf")
        r = transplant_incremental(signed, modified, out)
        assert r["applied"] is False
        assert "no structural match" in r["reason"]
        assert not os.path.exists(out)

    def test_content_edit_refuses(self, tmp_dir, pki):
        signed = _signed(tmp_dir, pki)

        def mutate(pdf):
            pdf.pages[0].Contents = pdf.make_stream(b"0 g 0 0 300 300 re f")

        modified = _rewrite_with(signed, tmp_dir, mutate)
        out = os.path.join(tmp_dir, "out.pdf")
        r = transplant_incremental(signed, modified, out)
        assert r["applied"] is False

    def test_widget_removal_refuses(self, tmp_dir, pki):
        signed = _signed(tmp_dir, pki, with_form=True)

        def mutate(pdf):
            annots = pdf.pages[0].obj["/Annots"]
            keep = [a for a in annots
                    if a.get("/Subtype") != pikepdf.Name("/Widget")
                    or a.get("/FT") == pikepdf.Name("/Sig")]
            pdf.pages[0].obj["/Annots"] = pikepdf.Array(keep)

        modified = _rewrite_with(signed, tmp_dir, mutate)
        out = os.path.join(tmp_dir, "out.pdf")
        r = transplant_incremental(signed, modified, out)
        assert r["applied"] is False
        assert "widget" in r["reason"]

    def test_sigflags_never_reconciled_from_the_rebuild(self, tmp_dir, pki):
        # Live e2e catch #2: rebuild pipelines re-derive /SigFlags assuming
        # page surgery killed the signatures (the AppendOnly bit drops) —
        # but transplanted signatures SURVIVE, so the original's value must
        # stand or pyHanko's diff analysis flags the revision.
        signed = _signed(tmp_dir, pki)
        with pikepdf.open(signed) as pdf:
            original_flags = int(pdf.Root.AcroForm.SigFlags)
        assert original_flags == 3  # SignaturesExist | AppendOnly

        def mutate(pdf):
            pdf.Root.AcroForm["/SigFlags"] = 1  # what acroform-carry derives
            _add_square(pdf)

        modified = _rewrite_with(signed, tmp_dir, mutate)
        out = os.path.join(tmp_dir, "out.pdf")
        r = transplant_incremental(signed, modified, out)
        assert r["applied"] is True, r.get("reason")
        _assert_sig_still_valid(out, pki)
        with pikepdf.open(out) as pdf:
            assert int(pdf.Root.AcroForm.SigFlags) == original_flags

    def test_version_normalization_is_not_a_catalog_change(self, tmp_dir, pki):
        # Live e2e catch: pyHanko's signing append writes /Version into the
        # catalog; the renderer's pdf-lib rebuild normalizes it into the
        # HEADER — so every real-world transplant refused "catalog-changed"
        # while this suite (whose rewrites go through pikepdf, which
        # PRESERVES /Version) stayed green. Simulate the normalization.
        signed = _signed(tmp_dir, pki)

        def mutate(pdf):
            if "/Version" in pdf.Root:
                del pdf.Root["/Version"]
            _add_square(pdf)

        modified = _rewrite_with(signed, tmp_dir, mutate)
        out = os.path.join(tmp_dir, "out.pdf")
        r = transplant_incremental(signed, modified, out)
        assert r["applied"] is True, r.get("reason")
        _assert_sig_still_valid(out, pki)

    def test_unsigned_is_not_applicable(self, tmp_dir, pki):
        src = os.path.join(tmp_dir, "plain.pdf")
        _base_pdf(src)
        modified = _rewrite_with(src, tmp_dir, _add_square)
        out = os.path.join(tmp_dir, "out.pdf")
        r = transplant_incremental(src, modified, out)
        assert r == {"applied": False, "reason": "not-signed"}
        assert has_live_signatures(src) is False

    def test_refuses_overwriting_the_original(self, tmp_dir, pki):
        signed = _signed(tmp_dir, pki)
        modified = _rewrite_with(signed, tmp_dir, _add_square)
        with pytest.raises(ValueError, match="original"):
            transplant_incremental(signed, modified, signed)

    def test_finalize_helper_swaps_in_place(self, tmp_dir, pki):
        signed = _signed(tmp_dir, pki)
        orig_bytes = open(signed, "rb").read()
        rewritten = _rewrite_with(signed, tmp_dir, _add_square, name="staged.pdf")

        r = finalize_preserving_signatures(signed, rewritten)
        assert r["preserved"] is True
        result = open(rewritten, "rb").read()
        assert result[: len(orig_bytes)] == orig_bytes
        _assert_sig_still_valid(rewritten, pki)

    def test_finalize_helper_passthrough_unsigned(self, tmp_dir, pki):
        src = os.path.join(tmp_dir, "plain.pdf")
        _base_pdf(src)
        rewritten = _rewrite_with(src, tmp_dir, _add_square, name="staged.pdf")
        before = open(rewritten, "rb").read()
        r = finalize_preserving_signatures(src, rewritten)
        assert r["preserved"] is False
        assert open(rewritten, "rb").read() == before  # untouched


class TestWrappedOps:
    """The annotate/fill-tier engine ops, run against a SIGNED input —
    end-to-end through their own code, not the transplant primitive."""

    def test_fill_form_fields_preserves_signature(self, tmp_dir, pki):
        from engine.forms import fill_form_fields

        signed = _signed(tmp_dir, pki, with_form=True)
        orig_bytes = open(signed, "rb").read()
        out = os.path.join(tmp_dir, "filled.pdf")
        r = fill_form_fields(signed, out, {"name": "Ada Lovelace"})
        assert r["filled"] == 1
        assert r.get("signatures_preserved") is True
        result = open(out, "rb").read()
        assert result[: len(orig_bytes)] == orig_bytes
        _assert_sig_still_valid(out, pki)
        with pikepdf.open(out) as pdf:
            field = [f for f in pdf.Root.AcroForm.Fields
                     if f.get("/T") is not None and str(f["/T"]) == "name"][0]
            assert str(field["/V"]) == "Ada Lovelace"

    def test_fill_in_place_preserves_signature(self, tmp_dir, pki):
        from engine.forms import fill_form_fields

        signed = _signed(tmp_dir, pki, with_form=True)
        orig_bytes = open(signed, "rb").read()
        r = fill_form_fields(signed, signed, {"name": "In Place"})
        assert r.get("signatures_preserved") is True
        result = open(signed, "rb").read()
        assert result[: len(orig_bytes)] == orig_bytes
        _assert_sig_still_valid(signed, pki)

    def test_add_links_preserves_signature(self, tmp_dir, pki):
        from engine.links import add_links

        signed = _signed(tmp_dir, pki)
        orig_bytes = open(signed, "rb").read()
        r = add_links(signed, signed, [
            {"page": 1, "rect": [50, 50, 150, 70], "url": "https://example.com"},
        ])
        assert r["added"] == 1
        assert r.get("signatures_preserved") is True
        assert open(signed, "rb").read()[: len(orig_bytes)] == orig_bytes
        _assert_sig_still_valid(signed, pki)

    def test_delete_all_annotations_preserves_signature(self, tmp_dir, pki):
        from engine.annotations import delete_all_annotations

        signed = _signed(tmp_dir, pki, annots=2)
        orig_bytes = open(signed, "rb").read()
        r = delete_all_annotations(signed, signed)
        assert r["removed"] == 2
        assert r.get("signatures_preserved") is True
        assert open(signed, "rb").read()[: len(orig_bytes)] == orig_bytes
        _assert_sig_still_valid(signed, pki)
        with pikepdf.open(signed) as pdf:
            subtypes = [str(a.get("/Subtype"))
                        for a in pdf.pages[0].obj.get("/Annots", [])]
        assert "/Square" not in subtypes
        assert "/Widget" in subtypes  # the signature widget survives the sweep

    def test_xfdf_import_preserves_signature(self, tmp_dir, pki):
        from engine.xfdf import export_xfdf, import_xfdf

        # Author annotations on an UNSIGNED copy, export them, then import
        # onto the signed document.
        donor = os.path.join(tmp_dir, "donor.pdf")
        _base_pdf(donor, annots=2)
        xfdf_path = os.path.join(tmp_dir, "comments.xfdf")
        export_xfdf(donor, xfdf_path)

        signed = _signed(tmp_dir, pki)
        orig_bytes = open(signed, "rb").read()
        r = import_xfdf(signed, xfdf_path, signed)
        assert r["added"] == 2
        assert r.get("signatures_preserved") is True
        assert open(signed, "rb").read()[: len(orig_bytes)] == orig_bytes
        _assert_sig_still_valid(signed, pki)

    def test_verify_reports_signature_page(self, tmp_dir, pki):
        # The panel's jump-to-signature needs the widget's page.
        signed = _signed(tmp_dir, pki)
        r = verify_signatures(signed)
        assert r["signatures"][0]["page"] == 1

    def test_flatten_fill_keeps_rewrite(self, tmp_dir, pki):
        from engine.forms import fill_form_fields

        # Flatten removes widgets — the transplant refuses by design and
        # the rewrite stands (a flatten destroys what the signature covers).
        signed = _signed(tmp_dir, pki, with_form=True)
        out = os.path.join(tmp_dir, "flat.pdf")
        r = fill_form_fields(signed, out, {"name": "X"}, flatten=True)
        assert r["flattened"] is True
        assert "signatures_preserved" not in r
