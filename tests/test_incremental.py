"""Incremental-append editing of SIGNED documents.

Two properties are under test, and they are separate questions (ISO 32000-2,
12.8.2.2.2 validates them in that order):

  MECHANICS   after an edit lands through the transplant, the output STARTS
              WITH the signed original's bytes verbatim (so the /ByteRange
              digest still verifies) AND the edit is present. Edits that
              cannot be expressed as an append refuse rather than half-apply.
  PERMISSION  a delta the document's own certification forbids REFUSES, so no
              output ever carries a preserved byte range under a policy that
              calls the change illegal.

``TestVerdictMatrix`` is the second property as a table: every (signature
situation x delta class) cell asserts the transplant's own verdict AND what
``verify_signatures`` says about the file it produced. The PKI reuses
test_pades' local CA fixture pattern.
"""

import os
import re

import pikepdf
import pytest

import engine.incremental as incremental
from engine.incremental import (
    DELTA_CLASSES,
    _ceiling_refusal,
    finalize_preserving_signatures,
    has_live_signatures,
    transplant_incremental,
)
from engine.signatures import sign_pdf, verify_signatures
# Sibling helper, imported BARE like every other one in this suite
# (`derived_nav_builders`, `outline_builders`, `hairline_builders`).
# A `tests.` prefix resolves against whichever regular `tests` package is
# on sys.path FIRST, and an installed dependency that ships one — spylls
# 0.1.7 does — shadows this directory outright, which broke collection.
from test_pades import _build_pki


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


def _base_pdf(path, with_form=False, annots=0, form_direct=False):
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
        # `form_direct` stores /AcroForm as a direct dictionary in the catalog.
        # ISO 32000-2 Table 29 types the entry as a dictionary and attaches no
        # "shall be an indirect reference" to it (the qualifier /Outlines and
        # /Threads carry), so a direct one is a conforming file the transplant
        # has no object to mark updated for.
        acro = pikepdf.Dictionary(
            Fields=pikepdf.Array([widget]),
            DA=pikepdf.String("/Helv 0 Tf 0 g"),
        )
        pdf.Root["/AcroForm"] = acro if form_direct else pdf.make_indirect(acro)
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


# ---------------------------------------------------------------------------
# The verdict matrix: (signature situation x delta class), measured twice —
# once as the transplant's own verdict, once as what the OUTPUT verifies as.
# ---------------------------------------------------------------------------

#: Ceiling fixtures. The names carry the wire level names
#: `certification_of_file` reports, so a refusal reason reads back against the
#: row that produced it.
_SITUATIONS = {
    "approval": {},
    "certified-none": {"certify": True, "certify_level": "none"},
    "certified-form-fill": {"certify": True, "certify_level": "form-fill"},
    "certified-annotate": {"certify": True, "certify_level": "annotate"},
}


def _matrix_base(path):
    """Three distinguishable pages; page 1 carries an annotation AND the form.

    Every page draws a different rectangle, so a reorder is observable in the
    output rather than merely reported, and pairing cannot succeed by accident.
    """
    pdf = pikepdf.new()
    for i in range(3):
        page = pdf.add_blank_page(page_size=(612, 792))
        page.Contents = pdf.make_stream(
            f"0 g 10 {10 + 20 * i} 100 100 re f".encode()
        )
        page.obj["/Resources"] = pikepdf.Dictionary(
            ProcSet=pikepdf.Array([pikepdf.Name("/PDF")])
        )
    ap = pdf.make_stream(b"1 0 0 rg 0 0 40 40 re f")
    ap.stream_dict["/Type"] = pikepdf.Name("/XObject")
    ap.stream_dict["/Subtype"] = pikepdf.Name("/Form")
    ap.stream_dict["/BBox"] = pikepdf.Array([0, 0, 40, 40])
    square = pdf.make_indirect(pikepdf.Dictionary(
        Type=pikepdf.Name("/Annot"), Subtype=pikepdf.Name("/Square"),
        Rect=pikepdf.Array([400, 600, 440, 640]), F=4,
        NM=pikepdf.String("base-square"), AP=pikepdf.Dictionary(N=ap),
    ))
    widget = pdf.make_indirect(pikepdf.Dictionary(
        Type=pikepdf.Name("/Annot"), Subtype=pikepdf.Name("/Widget"),
        FT=pikepdf.Name("/Tx"), T=pikepdf.String("name"),
        Rect=pikepdf.Array([50, 500, 250, 530]), F=4,
        V=pikepdf.String("old value"), DA=pikepdf.String("/Helv 0 Tf 0 g"),
    ))
    pdf.pages[0].obj["/Annots"] = pikepdf.Array([square, widget])
    pdf.Root["/AcroForm"] = pdf.make_indirect(pikepdf.Dictionary(
        Fields=pikepdf.Array([widget]), DA=pikepdf.String("/Helv 0 Tf 0 g"),
    ))
    pdf.save(str(path))


@pytest.fixture(scope="module")
def matrix_pki(tmp_path_factory):
    global _PKI
    if _PKI is None:
        _PKI = _build_pki(str(tmp_path_factory.mktemp("incr-pki")))
    return _PKI


@pytest.fixture(scope="module")
def matrix_docs(tmp_path_factory, matrix_pki):
    """One signed fixture per certification situation, built once.

    Read-only for every test: each transplant writes to its own tmp output, so
    the four signings are amortized across the whole matrix.
    """
    root = tmp_path_factory.mktemp("incr-matrix")
    base = root / "base.pdf"
    _matrix_base(base)
    out = {}
    for label, kw in _SITUATIONS.items():
        signed = root / f"signed-{label}.pdf"
        sign_pdf(str(base), str(signed), pfx_path=matrix_pki["pfx"],
                 password="pw", **kw)
        out[label] = str(signed)
    return out


def _m_annot_add(pdf):
    ap = pdf.make_stream(b"0 0 1 rg 0 0 50 50 re f")
    ap.stream_dict["/Type"] = pikepdf.Name("/XObject")
    ap.stream_dict["/Subtype"] = pikepdf.Name("/Form")
    ap.stream_dict["/BBox"] = pikepdf.Array([0, 0, 50, 50])
    existing = list(pdf.pages[0].obj.get("/Annots") or [])
    pdf.pages[0].obj["/Annots"] = pikepdf.Array(existing + [pdf.make_indirect(
        pikepdf.Dictionary(
            Type=pikepdf.Name("/Annot"), Subtype=pikepdf.Name("/Square"),
            Rect=pikepdf.Array([200, 300, 250, 350]), F=4,
            NM=pikepdf.String("matrix-add"), AP=pikepdf.Dictionary(N=ap),
        ))])


def _m_form_fill(pdf):
    for f in pdf.Root.AcroForm.Fields:
        if f.get("/T") is not None and str(f["/T"]) == "name":
            f["/V"] = pikepdf.String("filled by the matrix")
    pdf.Root.AcroForm["/NeedAppearances"] = True


def _m_insert_end(pdf):
    page = pdf.add_blank_page(page_size=(612, 792))
    page.Contents = pdf.make_stream(b"0 g 20 20 200 200 re f")


def _m_insert_start(pdf):
    page = pdf.add_blank_page(page_size=(612, 792))
    page.Contents = pdf.make_stream(b"0 g 30 30 200 200 re f")
    p = pdf.pages[3]
    del pdf.pages[3]
    pdf.pages.insert(0, p)


def _m_page_remove(pdf):
    del pdf.pages[1]


def _m_page_reorder(pdf):
    p = pdf.pages[1]
    del pdf.pages[1]
    pdf.pages.insert(2, p)


def _m_page_rotate(pdf):
    pdf.pages[1].obj["/Rotate"] = 90


def _m_page_crop(pdf):
    pdf.pages[1].obj["/CropBox"] = pikepdf.Array([50, 50, 562, 742])


def _m_content_edit(pdf):
    pdf.pages[1].Contents = pdf.make_stream(b"0 g 200 200 300 300 re f")


def _m_resource_swap(pdf):
    font = pdf.make_indirect(pikepdf.Dictionary(
        Type=pikepdf.Name("/Font"), Subtype=pikepdf.Name("/Type1"),
        BaseFont=pikepdf.Name("/Helvetica"),
    ))
    pdf.pages[1].obj["/Resources"] = pikepdf.Dictionary(
        ProcSet=pikepdf.Array([pikepdf.Name("/PDF"), pikepdf.Name("/Text")]),
        Font=pikepdf.Dictionary(F1=font),
    )


#: delta name -> (mutation, its class, the modification level the OUTPUT
#: reports when the delta is carried).
_DELTAS = {
    "annot-add": (_m_annot_add, "annotations", "ANNOTATIONS"),
    "form-fill": (_m_form_fill, "form-fill", "FORM_FILLING"),
    "page-insert-end": (_m_insert_end, "page-structure", "OTHER"),
    "page-insert-start": (_m_insert_start, "page-structure", "OTHER"),
    "page-remove": (_m_page_remove, "page-structure", "OTHER"),
    "page-reorder": (_m_page_reorder, "page-structure", "OTHER"),
    "page-rotate": (_m_page_rotate, "page-keys", "OTHER"),
    "page-crop": (_m_page_crop, "page-keys", "OTHER"),
}

#: Deltas no signature situation can carry: the page they touch has no twin,
#: which is what content and resource drift LOOKS like and what the DocMDP
#: transform exists to detect.
_UNAPPENDABLE = {
    "content-edit": _m_content_edit,
    "resource-swap": _m_resource_swap,
}


def _verdict(path, pki):
    sig = verify_signatures(path, trust_roots=[pki["ca_pem"]])["signatures"][0]
    return {
        "intact": sig["intact"],
        "modification_level": sig["modification_level"],
        "policy_ok": sig["policy_ok"],
        "policy_judged": sig["policy_judged"],
    }


def _permits(situation: str, delta_class: str) -> bool:
    """Table 257 as the TEST's own reading, spelled out rather than imported
    from the module under test — a table that agrees with itself proves
    nothing."""
    if situation == "approval":
        return True
    if situation == "certified-none":
        return False
    if situation == "certified-form-fill":
        return delta_class == "form-fill"
    if situation == "certified-annotate":
        return delta_class in ("form-fill", "annotations")
    raise AssertionError(f"unknown situation {situation}")


class TestVerdictMatrix:
    @pytest.mark.parametrize("situation", sorted(_SITUATIONS))
    @pytest.mark.parametrize("delta", sorted(_DELTAS))
    def test_cell(self, situation, delta, matrix_docs, matrix_pki, tmp_dir):
        mutate, delta_class, expect_level = _DELTAS[delta]
        signed = matrix_docs[situation]
        orig_bytes = open(signed, "rb").read()
        modified = _rewrite_with(signed, tmp_dir, mutate)
        out = os.path.join(tmp_dir, "out.pdf")

        r = transplant_incremental(signed, modified, out)

        if not _permits(situation, delta_class):
            level = situation[len("certified-"):]
            assert r["applied"] is False
            assert r["reason"] == f"certified-{level}-forbids-{delta_class}"
            assert r["certification_level"] == level
            assert delta_class in r["forbidden_classes"]
            assert not os.path.exists(out), "a refusal wrote a file"
            return

        assert r["applied"] is True, r.get("reason")
        assert r["delta_classes"] == [delta_class], r["delta_classes"]
        result = open(out, "rb").read()
        assert result[: len(orig_bytes)] == orig_bytes
        v = _verdict(out, matrix_pki)
        assert v["intact"] is True
        assert v["policy_judged"] is True
        assert v["modification_level"] == expect_level, v
        assert v["policy_ok"] is True, (
            "the transplant emitted a file its own verifier calls a policy "
            f"violation: {v}"
        )

    @pytest.mark.parametrize("situation", sorted(_SITUATIONS))
    @pytest.mark.parametrize("delta", sorted(_UNAPPENDABLE))
    def test_unappendable_cell(self, situation, delta, matrix_docs, tmp_dir):
        modified = _rewrite_with(
            matrix_docs[situation], tmp_dir, _UNAPPENDABLE[delta]
        )
        out = os.path.join(tmp_dir, "out.pdf")
        r = transplant_incremental(matrix_docs[situation], modified, out)
        assert r["applied"] is False
        assert "no structural match" in r["reason"]
        assert not os.path.exists(out)

    def test_no_delta_is_not_a_ceiling_refusal(self, matrix_docs, tmp_dir):
        # A certification that forbids everything still has nothing to forbid
        # when the rebuild changed nothing — the two must not be conflated.
        signed = matrix_docs["certified-none"]
        modified = _rewrite_with(signed, tmp_dir, lambda pdf: None)
        out = os.path.join(tmp_dir, "out.pdf")
        r = transplant_incremental(signed, modified, out)
        assert r == {"applied": False, "reason": "no-delta"}


class TestCeilingTable:
    """The ceiling as a pure function, including the level no fixture can be
    signed at."""

    def test_uncertified_has_no_ceiling(self):
        certification = {"certified": False, "level": None}
        assert _ceiling_refusal(certification, set(DELTA_CLASSES)) is None

    def test_unreadable_permission_value_permits_nothing(self):
        # certification_of_pdf reports certified=True with level None for a /P
        # outside 1-3: an unknown policy is not an absent one.
        certification = {"certified": True, "level": None, "level_value": 9}
        for cls in DELTA_CLASSES:
            r = _ceiling_refusal(certification, {cls})
            assert r["reason"] == f"certified-unknown-forbids-{cls}"
            assert r["certification_level"] == "unknown"

    def test_mixture_names_one_class_but_reports_all(self):
        certification = {"certified": True, "level": "annotate"}
        r = _ceiling_refusal(
            certification, {"annotations", "page-keys", "page-structure"}
        )
        assert r["reason"] == "certified-annotate-forbids-page-keys"
        assert r["forbidden_classes"] == ["page-keys", "page-structure"]
        assert r["delta_classes"] == ["annotations", "page-keys", "page-structure"]

    def test_permitted_mixture_passes(self):
        certification = {"certified": True, "level": "annotate"}
        assert _ceiling_refusal(
            certification, {"annotations", "form-fill"}
        ) is None

    def test_empty_delta_never_refuses(self):
        assert _ceiling_refusal({"certified": True, "level": "none"}, set()) is None


class TestPageKeys:
    """The widened page-key reach: /Rotate and the six boundaries."""

    def test_every_carried_key_lands_at_once(self, matrix_docs, matrix_pki, tmp_dir):
        signed = matrix_docs["approval"]
        orig_bytes = open(signed, "rb").read()

        def mutate(pdf):
            page = pdf.pages[2].obj
            page["/Rotate"] = 270
            page["/MediaBox"] = pikepdf.Array([0, 0, 595, 842])
            page["/CropBox"] = pikepdf.Array([10, 10, 585, 832])
            page["/BleedBox"] = pikepdf.Array([5, 5, 590, 837])
            page["/TrimBox"] = pikepdf.Array([15, 15, 580, 827])
            page["/ArtBox"] = pikepdf.Array([20, 20, 575, 822])

        modified = _rewrite_with(signed, tmp_dir, mutate)
        out = os.path.join(tmp_dir, "out.pdf")
        r = transplant_incremental(signed, modified, out)
        assert r["applied"] is True, r.get("reason")
        assert r["page_keys_updated"] == 1
        assert r["delta_classes"] == ["page-keys"]
        assert open(out, "rb").read()[: len(orig_bytes)] == orig_bytes
        _assert_sig_still_valid(out, matrix_pki)
        with pikepdf.open(out) as pdf:
            page = pdf.pages[2].obj
            assert int(page["/Rotate"]) == 270
            assert [float(v) for v in page["/MediaBox"]] == [0, 0, 595, 842]
            assert [float(v) for v in page["/ArtBox"]] == [20, 20, 575, 822]

    def test_materializing_an_inherited_value_is_not_a_delta(self, tmp_dir, pki):
        # A rebuild that copies the page tree's own /MediaBox down onto each
        # page changes the dict without changing the page (7.7.3.4). Comparing
        # dict membership would manufacture a delta out of that.
        src = os.path.join(tmp_dir, "inherited-base.pdf")
        pdf = pikepdf.new()
        page = pdf.add_blank_page(page_size=(612, 792))
        page.Contents = pdf.make_stream(b"0 g 10 10 100 100 re f")
        del page.obj["/MediaBox"]
        pdf.Root.Pages["/MediaBox"] = pikepdf.Array([0, 0, 612, 792])
        pdf.save(src)
        signed = os.path.join(tmp_dir, "inherited-signed.pdf")
        sign_pdf(src, signed, pfx_path=pki["pfx"], password="pw")

        def mutate(p):
            p.pages[0].obj["/MediaBox"] = pikepdf.Array([0, 0, 612, 792])

        modified = _rewrite_with(signed, tmp_dir, mutate)
        out = os.path.join(tmp_dir, "out.pdf")
        r = transplant_incremental(signed, modified, out)
        assert r == {"applied": False, "reason": "no-delta"}

    def test_removing_an_uninherited_box_is_expressible(self, tmp_dir, pki):
        src = os.path.join(tmp_dir, "cropped-base.pdf")
        pdf = pikepdf.new()
        page = pdf.add_blank_page(page_size=(612, 792))
        page.Contents = pdf.make_stream(b"0 g 10 10 100 100 re f")
        page.obj["/CropBox"] = pikepdf.Array([20, 20, 592, 772])
        pdf.save(src)
        signed = os.path.join(tmp_dir, "cropped-signed.pdf")
        sign_pdf(src, signed, pfx_path=pki["pfx"], password="pw")

        def mutate(p):
            del p.pages[0].obj["/CropBox"]

        modified = _rewrite_with(signed, tmp_dir, mutate)
        out = os.path.join(tmp_dir, "out.pdf")
        r = transplant_incremental(signed, modified, out)
        assert r["applied"] is True, r.get("reason")
        assert r["delta_classes"] == ["page-keys"]
        _assert_sig_still_valid(out, pki)
        with pikepdf.open(out) as result:
            assert "/CropBox" not in result.pages[0].obj

    @staticmethod
    def _override_fixture(tmp_dir, pki, name):
        """A page whose own /CropBox overrides an ancestor's."""
        src = os.path.join(tmp_dir, f"{name}-base.pdf")
        pdf = pikepdf.new()
        page = pdf.add_blank_page(page_size=(612, 792))
        page.Contents = pdf.make_stream(b"0 g 10 10 100 100 re f")
        page.obj["/CropBox"] = pikepdf.Array([20, 20, 592, 772])
        pdf.Root.Pages["/CropBox"] = pikepdf.Array([40, 40, 572, 752])
        pdf.save(src)
        signed = os.path.join(tmp_dir, f"{name}-signed.pdf")
        sign_pdf(src, signed, pfx_path=pki["pfx"], password="pw")
        return signed

    def test_removing_a_box_an_ancestor_still_supplies_refuses(
        self, tmp_dir, pki
    ):
        # Deleting the page's own entry would expose the node's rectangle, not
        # the /MediaBox default the edit reached. Expressing it would take a
        # rewrite of the page-tree node, which this module does not do.
        # qpdf's flattening hides the node's entry from the READER, so this is
        # exactly the case a reader-only judgement gets wrong.
        signed = self._override_fixture(tmp_dir, pki, "inh-crop")

        def mutate(p):
            del p.pages[0].obj["/CropBox"]

        modified = _rewrite_with(signed, tmp_dir, mutate)
        out = os.path.join(tmp_dir, "out.pdf")
        r = transplant_incremental(signed, modified, out)
        assert r == {
            "applied": False, "reason": "page-key-removal-inherited-cropbox",
        }
        assert not os.path.exists(out)

    def test_removing_a_box_the_page_never_owned_refuses(self, tmp_dir, pki):
        # The value lives on the node in the FILE; the reader shows it on the
        # page. Deleting the page's entry would be a no-op the result would
        # nonetheless report as applied.
        src = os.path.join(tmp_dir, "node-crop-base.pdf")
        pdf = pikepdf.new()
        page = pdf.add_blank_page(page_size=(612, 792))
        page.Contents = pdf.make_stream(b"0 g 10 10 100 100 re f")
        pdf.Root.Pages["/CropBox"] = pikepdf.Array([30, 30, 582, 762])
        pdf.save(src)
        signed = os.path.join(tmp_dir, "node-crop-signed.pdf")
        sign_pdf(src, signed, pfx_path=pki["pfx"], password="pw")

        def mutate(p):
            del p.pages[0].obj["/CropBox"]

        modified = _rewrite_with(signed, tmp_dir, mutate)
        out = os.path.join(tmp_dir, "out.pdf")
        r = transplant_incremental(signed, modified, out)
        assert r == {
            "applied": False, "reason": "page-key-removal-inherited-cropbox",
        }
        assert not os.path.exists(out)


class TestRotationLeavesAnnotationsProjected:
    """What a rotation that lands as an APPEND does to the page's annotations.

    Annotation rectangles are in default user space (ISO 32000-2 Table 166,
    /Rect), and /Rotate is a display-time property of the page (Table 31), so
    a rotation moves the page's content and its annotations together: the
    rects that describe them do not change, and neither does an appearance
    stream's own /Matrix. That is the file-level invariant the renderer's
    display-space re-projection stands on — it re-projects a normalized rect
    for the VIEW and inverts the rotation again when it bakes, so the bytes
    a rotate-only edit produces carry the same rects as before it (proven on
    the renderer side by tests/workspace-commit.test.ts's
    "rotate-after-annotate anchors the same page content as annotate-only").

    The append path must therefore leave /Annots alone entirely. If it ever
    rewrote annotations to "follow" a rotation, the incremental result and
    the rewrite result would disagree about where every annotation sits, and
    the delta would also be classified as annotation work — which the
    certification ceiling judges at a different level (Table 257: annotation
    creation, deletion and modification arrive only at /P 3).
    """

    @staticmethod
    def _fixture(tmp_dir, pki, name="rot"):
        """One page, one square, one freetext whose /AP N carries a /Matrix."""
        src = os.path.join(tmp_dir, f"{name}-base.pdf")
        pdf = pikepdf.new()
        page = pdf.add_blank_page(page_size=(612, 792))
        page.Contents = pdf.make_stream(b"0 g 10 10 100 100 re f")

        square_ap = pdf.make_stream(b"1 0 0 rg 0 0 40 40 re f")
        square_ap.stream_dict["/Type"] = pikepdf.Name("/XObject")
        square_ap.stream_dict["/Subtype"] = pikepdf.Name("/Form")
        square_ap.stream_dict["/BBox"] = pikepdf.Array([0, 0, 40, 40])
        square = pdf.make_indirect(pikepdf.Dictionary(
            Type=pikepdf.Name("/Annot"), Subtype=pikepdf.Name("/Square"),
            Rect=pikepdf.Array([400, 600, 440, 640]), F=4,
            NM=pikepdf.String("rot-square"),
            AP=pikepdf.Dictionary(N=square_ap),
        ))

        # The counter-rotated appearance the freetext builder emits: /Matrix
        # maps the form's own space into the page's (8.10.2), which is how a
        # freetext stays upright on a rotated page.
        free_ap = pdf.make_stream(b"BT /Helv 12 Tf 0 0 Td (hi) Tj ET")
        free_ap.stream_dict["/Type"] = pikepdf.Name("/XObject")
        free_ap.stream_dict["/Subtype"] = pikepdf.Name("/Form")
        free_ap.stream_dict["/BBox"] = pikepdf.Array([0, 0, 120, 40])
        free_ap.stream_dict["/Matrix"] = pikepdf.Array([0, 1, -1, 0, 40, 0])
        freetext = pdf.make_indirect(pikepdf.Dictionary(
            Type=pikepdf.Name("/Annot"), Subtype=pikepdf.Name("/FreeText"),
            Rect=pikepdf.Array([100, 200, 220, 240]), F=4,
            NM=pikepdf.String("rot-freetext"),
            DA=pikepdf.String("/Helv 12 Tf 0 g"),
            Contents=pikepdf.String("hi"),
            AP=pikepdf.Dictionary(N=free_ap),
        ))
        page.obj["/Annots"] = pikepdf.Array([square, freetext])
        pdf.save(src)
        signed = os.path.join(tmp_dir, f"{name}-signed.pdf")
        sign_pdf(src, signed, pfx_path=pki["pfx"], password="pw")
        return signed

    @staticmethod
    def _authored(pdf):
        """The two authored annotations — signing adds its own widget to the
        page, and that one is the signature's business, not this test's."""
        return [
            a for a in pdf.pages[0].obj["/Annots"] if a.get("/NM") is not None
        ]

    @classmethod
    def _annot_geometry(cls, path):
        with pikepdf.open(path) as pdf:
            out = []
            for a in cls._authored(pdf):
                ap = a["/AP"]["/N"]
                out.append((
                    str(a["/NM"]),
                    [float(v) for v in a["/Rect"]],
                    (
                        [float(v) for v in ap.stream_dict["/Matrix"]]
                        if "/Matrix" in ap.stream_dict else None
                    ),
                    ap.read_bytes(),
                ))
            return out

    @classmethod
    def _annot_objgens(cls, path):
        with pikepdf.open(path) as pdf:
            return [a.objgen for a in cls._authored(pdf)]

    @pytest.mark.parametrize("degrees", [90, 180, 270])
    def test_an_appended_rotation_moves_no_annotation(self, tmp_dir, pki, degrees):
        signed = self._fixture(tmp_dir, pki, f"rot{degrees}")
        orig_bytes = open(signed, "rb").read()
        before = self._annot_geometry(signed)
        before_objgens = self._annot_objgens(signed)

        def mutate(p):
            p.pages[0].obj["/Rotate"] = degrees

        modified = _rewrite_with(signed, tmp_dir, mutate)
        out = os.path.join(tmp_dir, "out.pdf")
        r = transplant_incremental(signed, modified, out)

        assert r["applied"] is True, r.get("reason")
        assert r["delta_classes"] == ["page-keys"], r["delta_classes"]
        assert r["page_keys_updated"] == 1
        assert (r["annots_added"], r["annots_updated"], r["annots_removed"]) == (0, 0, 0)
        result = open(out, "rb").read()
        assert result[: len(orig_bytes)] == orig_bytes
        _assert_sig_still_valid(out, pki)
        v = _verdict(out, pki)
        assert v["policy_ok"] is True, v

        with pikepdf.open(out) as pdf:
            assert int(pdf.pages[0].obj["/Rotate"]) == degrees
        assert self._annot_geometry(out) == before
        assert self._annot_objgens(out) == before_objgens

        # Stronger than equality: the appended revision does not re-issue the
        # annotation objects at all, so nothing about them can have drifted.
        appended = result[len(orig_bytes):]
        for num, gen in before_objgens:
            assert re.search(
                rb"(?<![0-9])%d %d obj" % (num, gen), appended
            ) is None, f"the rotation re-wrote annotation object {num}"

    def test_the_append_and_the_rewrite_place_annotations_identically(
        self, tmp_dir, pki
    ):
        # The two paths are alternatives for the same edit; a user who keeps a
        # signature must not get a different-looking page for it.
        signed = self._fixture(tmp_dir, pki, "rot-vs")

        def mutate(p):
            p.pages[0].obj["/Rotate"] = 90

        modified = _rewrite_with(signed, tmp_dir, mutate)
        out = os.path.join(tmp_dir, "out.pdf")
        assert transplant_incremental(signed, modified, out)["applied"] is True
        assert self._annot_geometry(out) == self._annot_geometry(modified)
        with pikepdf.open(out) as a, pikepdf.open(modified) as b:
            assert int(a.pages[0].obj["/Rotate"]) == int(b.pages[0].obj["/Rotate"])

    def test_a_rotation_that_did_move_a_rect_is_annotation_work_too(
        self, tmp_dir, pki
    ):
        # The classification is read off the DELTA, not off the gesture: were a
        # rebuild ever to bake re-projected rects into the file, that is an
        # annotation modification and Table 257 judges it at /P 3, so it must
        # not travel under the page-keys class alone.
        signed = self._fixture(tmp_dir, pki, "rot-moved")

        def mutate(p):
            p.pages[0].obj["/Rotate"] = 90
            for a in p.pages[0].obj["/Annots"]:
                if a.get("/NM") is not None and str(a["/NM"]) == "rot-square":
                    a["/Rect"] = pikepdf.Array([600, 400, 640, 440])

        modified = _rewrite_with(signed, tmp_dir, mutate)
        out = os.path.join(tmp_dir, "out.pdf")
        r = transplant_incremental(signed, modified, out)
        assert r["applied"] is True, r.get("reason")
        assert r["delta_classes"] == ["annotations", "page-keys"]
        assert r["annots_updated"] == 1
        _assert_sig_still_valid(out, pki)

    def test_a_certified_annotate_document_refuses_the_rotation(
        self, matrix_docs, tmp_dir
    ):
        # The ceiling still stands over the widened reach: /P 3 permits
        # annotation work and form filling, and page geometry appears in no
        # row of Table 257, so the rotation falls back to the rewrite.
        signed = matrix_docs["certified-annotate"]

        def mutate(p):
            p.pages[0].obj["/Rotate"] = 90

        modified = _rewrite_with(signed, tmp_dir, mutate)
        out = os.path.join(tmp_dir, "out.pdf")
        r = transplant_incremental(signed, modified, out)
        assert r["applied"] is False
        assert r["reason"] == "certified-annotate-forbids-page-keys"
        assert not os.path.exists(out)


class TestPageTree:
    """Removal, reordering and insert-anywhere on an approval-signed document."""

    def _order(self, path):
        with pikepdf.open(path) as pdf:
            return [
                bytes(p.obj["/Contents"].read_bytes()).decode("latin-1")
                for p in pdf.pages
            ]

    def test_remove_drops_exactly_one_page(self, matrix_docs, matrix_pki, tmp_dir):
        signed = matrix_docs["approval"]
        before = self._order(signed)
        modified = _rewrite_with(signed, tmp_dir, _m_page_remove)
        out = os.path.join(tmp_dir, "out.pdf")
        r = transplant_incremental(signed, modified, out)
        assert r["applied"] is True, r.get("reason")
        assert r["pages_removed"] == 1
        assert r["pages_inserted"] == 0
        assert self._order(out) == [before[0], before[2]]
        with pikepdf.open(out) as pdf:
            assert int(pdf.Root.Pages["/Count"]) == 2
        _assert_sig_still_valid(out, matrix_pki)

    def test_reorder_permutes_without_touching_pages(
        self, matrix_docs, matrix_pki, tmp_dir
    ):
        signed = matrix_docs["approval"]
        before = self._order(signed)
        modified = _rewrite_with(signed, tmp_dir, _m_page_reorder)
        out = os.path.join(tmp_dir, "out.pdf")
        r = transplant_incremental(signed, modified, out)
        assert r["applied"] is True, r.get("reason")
        assert r["pages_reordered"] is True
        assert r["pages_removed"] == 0 and r["pages_inserted"] == 0
        assert self._order(out) == [before[0], before[2], before[1]]
        _assert_sig_still_valid(out, matrix_pki)

    def test_insert_before_the_first_page(self, matrix_docs, matrix_pki, tmp_dir):
        # The old refusal read pyHanko's "there are no pages yet" branch as a
        # missing slot; measured, `after=-1` prepends into the root's /Kids.
        signed = matrix_docs["approval"]
        before = self._order(signed)
        modified = _rewrite_with(signed, tmp_dir, _m_insert_start)
        out = os.path.join(tmp_dir, "out.pdf")
        r = transplant_incremental(signed, modified, out)
        assert r["applied"] is True, r.get("reason")
        assert r["pages_inserted"] == 1
        assert self._order(out) == ["0 g 30 30 200 200 re f"] + before
        with pikepdf.open(out) as pdf:
            assert int(pdf.Root.Pages["/Count"]) == 4
        _assert_sig_still_valid(out, matrix_pki)

    def test_remove_plus_insert_is_ambiguous_and_refuses(
        self, matrix_docs, tmp_dir
    ):
        def mutate(pdf):
            del pdf.pages[1]
            page = pdf.add_blank_page(page_size=(612, 792))
            page.Contents = pdf.make_stream(b"0 g 40 40 200 200 re f")

        modified = _rewrite_with(matrix_docs["approval"], tmp_dir, mutate)
        out = os.path.join(tmp_dir, "out.pdf")
        r = transplant_incremental(matrix_docs["approval"], modified, out)
        assert r["applied"] is False
        assert "no structural match" in r["reason"]
        assert not os.path.exists(out)

    def test_removing_a_page_that_carries_a_widget_refuses(
        self, matrix_docs, tmp_dir
    ):
        # Page 1 of the fixture owns the form. Re-listing the survivors while
        # /AcroForm still registers the field would leave a phantom.
        def mutate(pdf):
            del pdf.pages[0]
            acro = pdf.Root["/AcroForm"]
            acro["/Fields"] = pikepdf.Array([
                f for f in acro["/Fields"]
                if f.get("/T") is None or str(f["/T"]) != "name"
            ])

        modified = _rewrite_with(matrix_docs["approval"], tmp_dir, mutate)
        out = os.path.join(tmp_dir, "out.pdf")
        r = transplant_incremental(matrix_docs["approval"], modified, out)
        assert r["applied"] is False
        assert "removed form field" in r["reason"]

    def test_an_inserted_page_costs_the_same_whatever_it_joins(self, tmp_dir, pki):
        """The revision carries the new page — not the source's page tree.

        A page dict's /Parent reaches the rewrite's whole tree, so following it
        appended an unreachable copy of every page and content stream in the
        document. The cost of one insertion must not depend on how many pages
        the signed document already has.
        """
        def measure(page_count, tag):
            src = os.path.join(tmp_dir, f"{tag}-base.pdf")
            pdf = pikepdf.new()
            for i in range(page_count):
                page = pdf.add_blank_page(page_size=(612, 792))
                page.Contents = pdf.make_stream(
                    (f"0 g 10 {10 + i} 100 100 re f" + " " * 400).encode()
                )
            pdf.save(src)
            signed = os.path.join(tmp_dir, f"{tag}-signed.pdf")
            sign_pdf(src, signed, pfx_path=pki["pfx"], password="pw")
            with pikepdf.open(signed) as before:
                objects_before = int(before.trailer["/Size"])
            modified = _rewrite_with(
                signed, tmp_dir, _m_insert_end, name=f"{tag}-mod.pdf"
            )
            out = os.path.join(tmp_dir, f"{tag}-out.pdf")
            r = transplant_incremental(signed, modified, out)
            assert r["applied"] is True, r.get("reason")
            with pikepdf.open(out) as after:
                objects_after = int(after.trailer["/Size"])
            return objects_after - objects_before, r["bytes_appended"]

        small_objects, small_bytes = measure(2, "cost-small")
        large_objects, large_bytes = measure(10, "cost-large")
        assert small_objects == large_objects, (
            "the insertion's object cost scales with the document — the source "
            f"page tree is travelling ({small_objects} vs {large_objects})"
        )
        assert large_bytes - small_bytes < 400, (
            f"appended bytes scale with the document ({small_bytes} vs "
            f"{large_bytes}) — only the cross-reference table may grow"
        )

    def test_one_intermediate_node_carries_the_removal(self, tmp_dir, pki):
        # All pages under a single branch: the branch's /Kids is rewritten and
        # /Count moves at BOTH levels — an unadjusted root would report a page
        # count the newest revision contradicts.
        src = os.path.join(tmp_dir, "branch-base.pdf")
        pdf = pikepdf.new()
        for i in range(3):
            page = pdf.add_blank_page(page_size=(612, 792))
            page.Contents = pdf.make_stream(
                f"0 g 10 {10 + 20 * i} 80 80 re f".encode()
            )
        root = pdf.Root.Pages
        kids = list(root["/Kids"])
        branch = pdf.make_indirect(pikepdf.Dictionary(
            Type=pikepdf.Name("/Pages"), Parent=root,
            Kids=pikepdf.Array(kids), Count=3,
        ))
        for kid in kids:
            kid["/Parent"] = branch
        root["/Kids"] = pikepdf.Array([branch])
        pdf.save(src)
        signed = os.path.join(tmp_dir, "branch-signed.pdf")
        sign_pdf(src, signed, pfx_path=pki["pfx"], password="pw")

        before = self._order(signed)
        modified = _rewrite_with(signed, tmp_dir, _m_page_remove)
        out = os.path.join(tmp_dir, "out.pdf")
        r = transplant_incremental(signed, modified, out)
        assert r["applied"] is True, r.get("reason")
        assert r["pages_removed"] == 1
        assert self._order(out) == [before[0], before[2]]
        with pikepdf.open(out) as result:
            assert int(result.Root.Pages["/Count"]) == 2
            assert int(result.Root.Pages["/Kids"][0]["/Count"]) == 2
        _assert_sig_still_valid(out, pki)

    def test_a_multi_parent_page_tree_refuses(self, tmp_dir, pki):
        # Flattening a deeper tree onto one /Kids would orphan the nodes whose
        # attributes the pages inherit (7.7.3.4).
        src = os.path.join(tmp_dir, "nested-base.pdf")
        pdf = pikepdf.new()
        for i in range(3):
            page = pdf.add_blank_page(page_size=(612, 792))
            page.Contents = pdf.make_stream(
                f"0 g 10 {10 + 20 * i} 90 90 re f".encode()
            )
        root = pdf.Root.Pages
        kids = list(root["/Kids"])
        branch = pdf.make_indirect(pikepdf.Dictionary(
            Type=pikepdf.Name("/Pages"), Parent=root,
            Kids=pikepdf.Array(kids[1:]), Count=2,
        ))
        for kid in kids[1:]:
            kid["/Parent"] = branch
        root["/Kids"] = pikepdf.Array([kids[0], branch])
        pdf.save(src)
        signed = os.path.join(tmp_dir, "nested-signed.pdf")
        sign_pdf(src, signed, pfx_path=pki["pfx"], password="pw")

        modified = _rewrite_with(signed, tmp_dir, _m_page_remove)
        out = os.path.join(tmp_dir, "out.pdf")
        r = transplant_incremental(signed, modified, out)
        assert r["applied"] is False
        assert r["reason"] == "page-tree-multi-parent"
        assert not os.path.exists(out)


class TestPageIdentityMapping:
    """The append path's page ORDER is the rewrite's, page for page.

    The durable-identity mapping is published renderer-side off the commit
    plan (``lib/workspace-commit.ts`` — ``authoredPageIds`` is the plan's page
    ids in written order, and the dispatched ``authored`` record is taken from
    the plan whether the transplant applied, refused, or threw). That mapping
    is only true of the file that lands if the appended revision presents the
    SAME page sequence as the rewrite the plan built. Nothing renderer-side can
    check that; it is pinned here, on the engine that has to hold it.

    A drift — one page kept that the rewrite dropped, one pair transposed —
    would silently re-bind a positional id to a different physical page, which
    is exactly what generation-tagging exists to make impossible.
    """

    def _order(self, path):
        with pikepdf.open(path) as pdf:
            return [
                bytes(p.obj["/Contents"].read_bytes()).decode("latin-1")
                for p in pdf.pages
            ]

    def _remove_and_reorder(pdf):
        # Page 0 carries the form's widget and its removal refuses on its own
        # terms; page 1 is the free one, and the survivors then transpose.
        del pdf.pages[1]
        p = pdf.pages[1]
        del pdf.pages[1]
        pdf.pages.insert(0, p)

    @pytest.mark.parametrize("mutate", [
        _m_page_remove,
        _m_page_reorder,
        _m_insert_end,
        _m_insert_start,
        _remove_and_reorder,
    ], ids=["remove", "reorder", "insert-end", "insert-start",
            "remove-and-reorder"])
    def test_the_appended_order_is_the_rewrites_order(
        self, mutate, matrix_docs, matrix_pki, tmp_dir
    ):
        signed = matrix_docs["approval"]
        modified = _rewrite_with(signed, tmp_dir, mutate)
        out = os.path.join(tmp_dir, "out.pdf")
        r = transplant_incremental(signed, modified, out)
        assert r["applied"] is True, r.get("reason")
        assert self._order(out) == self._order(modified)
        _assert_sig_still_valid(out, matrix_pki)

    def test_a_refusal_leaves_the_rewrite_the_sole_author(
        self, matrix_docs, tmp_dir
    ):
        # The other half of the mapping's validity: a refused append writes
        # NOTHING, so the plan's own rewrite is what the mapping describes.
        signed = matrix_docs["certified-annotate"]
        modified = _rewrite_with(signed, tmp_dir, _m_page_remove)
        out = os.path.join(tmp_dir, "out.pdf")
        r = transplant_incremental(signed, modified, out)
        assert r["applied"] is False
        assert not os.path.exists(out)


class TestAcroFormDelta:
    """Every /AcroForm difference is judged HERE, and none is ignored.

    The catalog guard excludes /AcroForm from its comparison, so this pass is
    the only thing standing between a form difference and a success report. The
    cases below are the ones where one side of the comparison is missing —
    where "absent" reads as "nothing to do" unless something says otherwise.
    """

    def test_removing_the_form_refuses(self, tmp_dir, pki):
        # The reported shape: a rebuild that drops /AcroForm AND adds an
        # annotation reported applied=True, kept the original's form, and
        # applied the annotation — half of the edit, announced as all of it.
        signed = _signed(tmp_dir, pki, with_form=True, annots=1)

        def mutate(pdf):
            del pdf.Root["/AcroForm"]
            _add_square(pdf, nm="acroform-gone", color=(0, 1, 0))

        modified = _rewrite_with(signed, tmp_dir, mutate)
        out = os.path.join(tmp_dir, "out.pdf")
        r = transplant_incremental(signed, modified, out)
        assert r["applied"] is False
        assert r["reason"] == "acroform-removed"
        assert not os.path.exists(out)

    def test_removing_the_form_alone_refuses(self, tmp_dir, pki):
        """The removal is the delta, not a passenger on one.

        Without another change to carry it the pre-fix answer was `no-delta` —
        a refusal, but one that describes the edit as empty when it is not.
        """
        signed = _signed(tmp_dir, pki, with_form=True)

        def mutate(pdf):
            del pdf.Root["/AcroForm"]

        modified = _rewrite_with(signed, tmp_dir, mutate)
        out = os.path.join(tmp_dir, "out.pdf")
        r = transplant_incremental(signed, modified, out)
        assert r["applied"] is False
        assert r["reason"] == "acroform-removed"

    def test_a_form_that_survives_still_applies(self, tmp_dir, pki):
        # The control the refusal is measured against: the same fixture and the
        # same annotation, with the form left alone.
        signed = _signed(tmp_dir, pki, with_form=True, annots=1)

        def mutate(pdf):
            _add_square(pdf, nm="acroform-kept", color=(0, 1, 0))

        modified = _rewrite_with(signed, tmp_dir, mutate)
        out = os.path.join(tmp_dir, "out.pdf")
        r = transplant_incremental(signed, modified, out)
        assert r["applied"] is True, r.get("reason")
        _assert_sig_still_valid(out, pki)
        with pikepdf.open(out) as pdf:
            assert pdf.Root.get("/AcroForm") is not None

    def test_a_direct_acroform_delta_refuses(self, tmp_dir, pki):
        """An /AcroForm-level change to a DIRECT form dictionary.

        In-place reconciliation needs an object to mark updated; a direct
        /AcroForm lives inside the catalog, which this module never rewrites.
        Pre-fix the whole reconciliation was skipped and the annotation landed
        alone.
        """
        signed = _signed(tmp_dir, pki, with_form=True, form_direct=True)
        with pikepdf.open(signed) as pdf:
            assert not pdf.Root["/AcroForm"].is_indirect, "fixture is not direct"

        def mutate(pdf):
            pdf.Root["/AcroForm"]["/NeedAppearances"] = True
            _add_square(pdf, nm="direct-form", color=(1, 0, 1))

        modified = _rewrite_with(signed, tmp_dir, mutate)
        out = os.path.join(tmp_dir, "out.pdf")
        r = transplant_incremental(signed, modified, out)
        assert r["applied"] is False
        assert r["reason"] == "acroform-inline"
        assert not os.path.exists(out)

    def test_an_indirect_form_takes_the_same_key_change(self, tmp_dir, pki):
        # Control for the refusal above: only the indirection differs.
        signed = _signed(tmp_dir, pki, with_form=True)

        def mutate(pdf):
            pdf.Root["/AcroForm"]["/NeedAppearances"] = True
            _add_square(pdf, nm="indirect-form", color=(1, 0, 1))

        modified = _rewrite_with(signed, tmp_dir, mutate)
        out = os.path.join(tmp_dir, "out.pdf")
        r = transplant_incremental(signed, modified, out)
        assert r["applied"] is True, r.get("reason")
        assert r["fields_updated"] == 1
        _assert_sig_still_valid(out, pki)
        with pikepdf.open(out) as pdf:
            assert bool(pdf.Root["/AcroForm"]["/NeedAppearances"]) is True

    def test_a_direct_form_with_no_form_delta_still_applies(self, tmp_dir, pki):
        # The direct fixture is not refused for being direct — only for a
        # difference it cannot express.
        signed = _signed(tmp_dir, pki, with_form=True, form_direct=True)

        def mutate(pdf):
            _add_square(pdf, nm="direct-untouched", color=(1, 1, 0))

        modified = _rewrite_with(signed, tmp_dir, mutate)
        out = os.path.join(tmp_dir, "out.pdf")
        r = transplant_incremental(signed, modified, out)
        assert r["applied"] is True, r.get("reason")
        _assert_sig_still_valid(out, pki)

    def test_removing_an_acroform_level_key_is_expressed(self, tmp_dir, pki):
        # The sibling that is NOT a refusal: an indirect /AcroForm can lose a
        # key in the appended revision, so the removal lands rather than being
        # ignored or refused.
        signed = _signed(tmp_dir, pki, with_form=True)

        def mutate(pdf):
            del pdf.Root["/AcroForm"]["/DA"]

        modified = _rewrite_with(signed, tmp_dir, mutate)
        out = os.path.join(tmp_dir, "out.pdf")
        r = transplant_incremental(signed, modified, out)
        assert r["applied"] is True, r.get("reason")
        assert r["fields_updated"] == 1
        _assert_sig_still_valid(out, pki)
        with pikepdf.open(out) as pdf:
            assert pdf.Root["/AcroForm"].get("/DA") is None

    def test_removing_a_field_while_its_widget_stays_refuses(self, tmp_dir, pki):
        # The bounded case of the same change: /Fields loses one entry and the
        # page keeps drawing its widget.
        signed = _signed(tmp_dir, pki, with_form=True)

        def mutate(pdf):
            acro = pdf.Root["/AcroForm"]
            acro["/Fields"] = pikepdf.Array([
                f for f in acro["/Fields"]
                if f.get("/T") is None or str(f["/T"]) != "name"
            ])

        modified = _rewrite_with(signed, tmp_dir, mutate)
        out = os.path.join(tmp_dir, "out.pdf")
        r = transplant_incremental(signed, modified, out)
        assert r["applied"] is False
        assert "removed form field" in r["reason"]


class TestRevertProofs:
    """Each feature, switched off, must give the pre-feature answer back — with
    values the passing tests above never use, so a proof cannot be a copy."""

    @staticmethod
    def _ignore_acroform_refusal(monkeypatch, reason: str):
        """Restore the pre-fix "missing on one side = nothing to do" answer.

        Faithful for both reverted reasons because each is raised before the
        pass has written anything and with no field-level count to discard:
        `acroform-removed` is the function's first statement after the lookup,
        and `acroform-inline` is reached only for fixtures whose sole
        difference is an /AcroForm-level key.
        """
        real = incremental._acroform_delta

        def shim(writer, orig, mod, memo_mat):
            try:
                return real(writer, orig, mod, memo_mat)
            except incremental._TransplantRefusal as e:
                if str(e) == reason:
                    return 0
                raise

        monkeypatch.setattr(incremental, "_acroform_delta", shim)

    def test_without_the_ceiling_a_no_changes_document_is_violated(
        self, matrix_docs, matrix_pki, tmp_dir, monkeypatch
    ):
        monkeypatch.setattr(
            incremental, "_CERTIFIED_PERMITS",
            {k: frozenset(DELTA_CLASSES)
             for k in ("none", "form-fill", "annotate", "unknown")},
        )

        def mutate(pdf):
            ap = pdf.make_stream(b"0 1 0 rg 0 0 30 30 re f")
            ap.stream_dict["/Type"] = pikepdf.Name("/XObject")
            ap.stream_dict["/Subtype"] = pikepdf.Name("/Form")
            ap.stream_dict["/BBox"] = pikepdf.Array([0, 0, 30, 30])
            existing = list(pdf.pages[2].obj.get("/Annots") or [])
            pdf.pages[2].obj["/Annots"] = pikepdf.Array(
                existing + [pdf.make_indirect(pikepdf.Dictionary(
                    Type=pikepdf.Name("/Annot"), Subtype=pikepdf.Name("/Circle"),
                    Rect=pikepdf.Array([100, 100, 130, 130]), F=4,
                    NM=pikepdf.String("revert-circle"),
                    AP=pikepdf.Dictionary(N=ap),
                ))]
            )

        signed = matrix_docs["certified-none"]
        modified = _rewrite_with(signed, tmp_dir, mutate)
        out = os.path.join(tmp_dir, "out.pdf")
        r = transplant_incremental(signed, modified, out)
        assert r["applied"] is True, "the revert did not reach the ceiling"
        v = _verdict(out, matrix_pki)
        assert v["intact"] is True, "the mechanics were never the problem"
        assert v["policy_ok"] is False, (
            "without the ceiling this file should be the policy violation the "
            "feature exists to stop"
        )

    def test_without_the_widened_skip_a_rotation_refuses(
        self, matrix_docs, tmp_dir, monkeypatch
    ):
        monkeypatch.setattr(incremental, "_PAGE_SKIP", frozenset({"/Annots"}))

        def mutate(pdf):
            pdf.pages[0].obj["/Rotate"] = 180

        modified = _rewrite_with(matrix_docs["approval"], tmp_dir, mutate)
        out = os.path.join(tmp_dir, "out.pdf")
        r = transplant_incremental(matrix_docs["approval"], modified, out)
        assert r["applied"] is False
        assert "no structural match" in r["reason"]

    def test_without_the_kids_rewrite_a_removal_does_not_land(
        self, matrix_docs, tmp_dir, monkeypatch
    ):
        monkeypatch.setattr(
            incremental, "_rewrite_page_tree",
            lambda writer, orig, mod, plan, page_refs, memo: 0,
        )

        def mutate(pdf):
            del pdf.pages[2]

        modified = _rewrite_with(matrix_docs["approval"], tmp_dir, mutate)
        out = os.path.join(tmp_dir, "out.pdf")
        r = transplant_incremental(matrix_docs["approval"], modified, out)
        assert r["applied"] is True
        with pikepdf.open(out) as pdf:
            assert len(pdf.pages) == 3, (
                "the /Kids rewrite is what carries a removal; without it the "
                "revision claims a page it never dropped"
            )

    def test_without_the_removal_refusal_the_form_survives_the_edit(
        self, tmp_dir, pki, monkeypatch
    ):
        self._ignore_acroform_refusal(monkeypatch, "acroform-removed")
        signed = _signed(tmp_dir, pki, with_form=True, annots=2)

        def mutate(pdf):
            del pdf.Root["/AcroForm"]
            _add_square(pdf, nm="revert-form-gone", color=(0.5, 0, 0.5))

        modified = _rewrite_with(signed, tmp_dir, mutate)
        out = os.path.join(tmp_dir, "out.pdf")
        r = transplant_incremental(signed, modified, out)
        assert r["applied"] is True, "the revert did not reach the refusal"
        with pikepdf.open(out) as pdf:
            assert pdf.Root.get("/AcroForm") is not None, (
                "without the refusal this file should be the half-applied "
                "document the fix exists to stop"
            )
            names = {
                str(a.get("/NM")) for a in pdf.pages[0].obj["/Annots"]
                if a.get("/NM") is not None
            }
        assert "revert-form-gone" in names, (
            "the other half of the same edit landed — success was reported for "
            "a document carrying only one of its two changes"
        )

    def test_without_the_inline_refusal_a_direct_form_change_vanishes(
        self, tmp_dir, pki, monkeypatch
    ):
        self._ignore_acroform_refusal(monkeypatch, "acroform-inline")
        signed = _signed(tmp_dir, pki, with_form=True, annots=2, form_direct=True)

        def mutate(pdf):
            pdf.Root["/AcroForm"]["/NeedAppearances"] = True
            _add_square(pdf, nm="revert-direct-form", color=(0, 0.5, 0.5))

        modified = _rewrite_with(signed, tmp_dir, mutate)
        out = os.path.join(tmp_dir, "out.pdf")
        r = transplant_incremental(signed, modified, out)
        assert r["applied"] is True, "the revert did not reach the refusal"
        with pikepdf.open(out) as pdf:
            assert pdf.Root["/AcroForm"].get("/NeedAppearances") is None, (
                "without the refusal the form half of the edit is dropped and "
                "the annotation half is reported as the whole"
            )


class TestEmissionDeterminism:
    """The shipped emission path, pinned.

    A cross-version byte pin cannot live here — it needs the pre-change module,
    which `o5b-byte-identity.local.py` loads out of git and compares against
    (measured: identical for annotate / fill / insert-at-end / insert-in-middle
    / annotation-removal on an approval document). What pytest CAN hold is the
    property that made that comparison meaningful: the writer's only
    run-to-run difference is the trailer's second /ID string, which pyHanko
    re-mints on every write.
    """

    _ID = re.compile(rb"(/ID \[ <[0-9a-fA-F]+> )<[0-9a-fA-F]+>")

    def _normalized(self, path):
        return self._ID.sub(rb"\1<ID>", open(path, "rb").read())

    @pytest.mark.parametrize("delta", ["annot-add", "form-fill", "page-insert-end"])
    def test_two_runs_differ_only_in_the_document_id(
        self, delta, matrix_docs, tmp_dir
    ):
        signed = matrix_docs["approval"]
        modified = _rewrite_with(signed, tmp_dir, _DELTAS[delta][0])
        a = os.path.join(tmp_dir, "a.pdf")
        b = os.path.join(tmp_dir, "b.pdf")
        assert transplant_incremental(signed, modified, a)["applied"] is True
        assert transplant_incremental(signed, modified, b)["applied"] is True
        assert open(a, "rb").read() != open(b, "rb").read()
        assert self._normalized(a) == self._normalized(b)


class TestHardLinkAliases:
    """Both same-file refusals answer the FILESYSTEM, not the string.

    A hard link is one physical file under two spellings that resolve
    differently, so a resolved-path comparison lets an alias through the very
    guard that exists to keep the input's bytes intact.
    """

    @staticmethod
    def _hardlink(src, dst):
        try:
            os.link(src, dst)
        except (OSError, NotImplementedError, AttributeError) as exc:
            pytest.skip(f"hard links unavailable on this filesystem: {exc}")
        if not os.path.samefile(src, dst):
            pytest.skip("the filesystem did not produce a real hard link")

    def test_transplant_refuses_an_aliased_original(self, tmp_dir, pki):
        signed = _signed(tmp_dir, pki)
        modified = _rewrite_with(signed, tmp_dir, _add_square)
        alias = os.path.join(tmp_dir, "alias-out.pdf")
        self._hardlink(signed, alias)
        assert os.path.realpath(alias) != os.path.realpath(signed)
        with pytest.raises(ValueError, match="original"):
            transplant_incremental(signed, modified, alias)

    def test_transplant_alias_refusal_is_the_guard_not_luck(
        self, tmp_dir, pki, monkeypatch
    ):
        # Revert proof: with a resolved-spelling predicate back in place, the
        # alias walks straight through the refusal.
        monkeypatch.setattr(
            incremental, "is_same_file",
            lambda a, b: os.path.abspath(a) == os.path.abspath(b),
        )
        signed = _signed(tmp_dir, pki)
        modified = _rewrite_with(signed, tmp_dir, _add_square)
        alias = os.path.join(tmp_dir, "alias-out.pdf")
        self._hardlink(signed, alias)
        r = transplant_incremental(signed, modified, alias)
        assert r["applied"] is True, (
            "the reverted predicate should let the alias through — if it does "
            "not, this test is no longer proving the guard"
        )

    def test_sign_refuses_an_aliased_output(self, tmp_dir, pki):
        from engine import signatures

        src = os.path.join(tmp_dir, "plain.pdf")
        _base_pdf(src)
        alias = os.path.join(tmp_dir, "plain-alias.pdf")
        self._hardlink(src, alias)
        with pytest.raises(ValueError, match="different file"):
            signatures.sign_pdf(src, alias, pfx_path=pki["pfx"], password="pw")

    def test_sign_alias_refusal_is_the_guard_not_luck(
        self, tmp_dir, pki, monkeypatch
    ):
        from engine import signatures

        monkeypatch.setattr(
            signatures, "is_same_file",
            lambda a, b: os.path.abspath(a) == os.path.abspath(b),
        )
        src = os.path.join(tmp_dir, "plain.pdf")
        _base_pdf(src)
        alias = os.path.join(tmp_dir, "plain-alias.pdf")
        self._hardlink(src, alias)
        signatures.sign_pdf(src, alias, pfx_path=pki["pfx"], password="pw")
        assert has_live_signatures(alias), (
            "the reverted predicate should have signed straight over the alias"
        )
