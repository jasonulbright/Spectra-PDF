"""Certification (DocMDP) signatures: authoring, reporting, and the policy.

A certification signature records in the catalog what may change in the
document after it was signed. The assertions here read the RAW
``/Perms /DocMDP`` dictionary rather than a library readback, so a library
change that stops writing the transform is caught rather than papered over.
"""

import io
import os

import pikepdf
import pytest
from pyhanko.pdf_utils import generic
from pyhanko.pdf_utils.incremental_writer import IncrementalPdfFileWriter
from pyhanko.pdf_utils.reader import PdfFileReader
from pyhanko.sign.diff_analysis import DEFAULT_DIFF_POLICY
from pyhanko.sign.validation import validate_pdf_signature
from pyhanko_certvalidator import ValidationContext

from engine.docmdp import certification_of_file
from engine.docmdp_policy import DIFF_POLICY
from engine.incremental import transplant_incremental
from engine.signatures import sign_pdf, verify_signatures
from tests.test_pades import _build_pki


_PKI: dict | None = None


@pytest.fixture
def pki(tmp_path_factory):
    global _PKI
    if _PKI is None:
        _PKI = _build_pki(str(tmp_path_factory.mktemp("cert-pki")))
    return _PKI


@pytest.fixture
def tmp_dir(tmp_path):
    return str(tmp_path)


def _base_pdf(path, pages=2, with_form=True, empty_sig_field=False):
    pdf = pikepdf.new()
    font = pdf.make_indirect(pikepdf.Dictionary(
        Type=pikepdf.Name("/Font"), Subtype=pikepdf.Name("/Type1"),
        BaseFont=pikepdf.Name("/Helvetica"), Encoding=pikepdf.Name("/WinAnsiEncoding"),
    ))
    for n in range(pages):
        page = pdf.add_blank_page(page_size=(612, 792))
        page.Contents = pdf.make_stream(
            f"BT /F1 12 Tf 72 700 Td (Page {n + 1}.) Tj ET".encode()
        )
        page.Resources = pikepdf.Dictionary(Font=pikepdf.Dictionary(F1=font))
    entries = []
    if with_form:
        entries.append(pdf.make_indirect(pikepdf.Dictionary(
            Type=pikepdf.Name("/Annot"), Subtype=pikepdf.Name("/Widget"),
            FT=pikepdf.Name("/Tx"), T=pikepdf.String("name"),
            Rect=pikepdf.Array([50, 500, 250, 530]), F=4,
            V=pikepdf.String(""), DA=pikepdf.String("/Helv 10 Tf 0 g"),
        )))
    if empty_sig_field:
        entries.append(pdf.make_indirect(pikepdf.Dictionary(
            Type=pikepdf.Name("/Annot"), Subtype=pikepdf.Name("/Widget"),
            FT=pikepdf.Name("/Sig"), T=pikepdf.String("Approval"),
            Rect=pikepdf.Array([300, 500, 500, 560]), F=4,
        )))
    if entries:
        pdf.pages[0].obj["/Annots"] = pdf.make_indirect(pikepdf.Array(entries))
        pdf.Root["/AcroForm"] = pdf.make_indirect(pikepdf.Dictionary(
            Fields=pikepdf.Array(entries),
            DA=pikepdf.String("/Helv 10 Tf 0 g"),
            DR=pikepdf.Dictionary(Font=pikepdf.Dictionary(Helv=font)),
        ))
    pdf.save(path)
    return path


def _certify(tmp_dir, pki, level, name="certified.pdf", src=None, **sign_kw):
    if src is None:
        src = _base_pdf(os.path.join(tmp_dir, "base-" + name))
    out = os.path.join(tmp_dir, name)
    result = sign_pdf(
        src, out, pfx_path=pki["pfx"], password="pw",
        certify=True, certify_level=level, **sign_kw,
    )
    return out, result


def _raw_docmdp_p(path):
    """The ``/P`` written into the certification signature's own transform."""
    with pikepdf.open(path) as pdf:
        perms = pdf.Root["/Perms"]
        sig = perms["/DocMDP"]
        ref = sig["/Reference"][0]
        assert ref["/TransformMethod"] == pikepdf.Name("/DocMDP")
        return int(ref["/TransformParams"]["/P"])


# ── authoring ──────────────────────────────────────────────────────────────

@pytest.mark.parametrize("level,expected_p", [("none", 1), ("form-fill", 2), ("annotate", 3)])
def test_certify_writes_the_transform_for_each_level(tmp_dir, pki, level, expected_p):
    out, result = _certify(tmp_dir, pki, level, name=f"cert-{expected_p}.pdf")
    assert _raw_docmdp_p(out) == expected_p
    assert result["certified"] is True
    assert result["certification_level"] == level
    assert result["valid"] and result["intact"]


def test_certify_defaults_to_form_fill(tmp_dir, pki):
    out, result = _certify(tmp_dir, pki, None)
    assert _raw_docmdp_p(out) == 2
    assert result["certification_level"] == "form-fill"


def test_approval_signature_writes_no_certification(tmp_dir, pki):
    src = _base_pdf(os.path.join(tmp_dir, "base.pdf"))
    out = os.path.join(tmp_dir, "approval.pdf")
    result = sign_pdf(src, out, pfx_path=pki["pfx"], password="pw")
    assert result["certified"] is False
    assert result["certification_level"] is None
    with pikepdf.open(out) as pdf:
        assert pdf.Root.get("/Perms") is None


# ── orthogonality with the existing placement / profile options ────────────

def test_certify_composes_with_a_visible_stamp(tmp_dir, pki):
    out, result = _certify(
        tmp_dir, pki, "annotate", name="cert-visible.pdf",
        appearance={"page": 1, "rect": [72, 100, 300, 160]},
    )
    assert _raw_docmdp_p(out) == 3
    assert result["valid"] and result["intact"]


def test_certify_composes_with_an_existing_empty_field(tmp_dir, pki):
    src = _base_pdf(os.path.join(tmp_dir, "with-field.pdf"), empty_sig_field=True)
    out, result = _certify(
        tmp_dir, pki, "none", name="cert-field.pdf", src=src, existing_field="Approval",
    )
    assert _raw_docmdp_p(out) == 1
    assert result["field"] == "Approval"
    assert result["valid"] and result["intact"]


def test_certify_composes_with_pades(tmp_dir, pki):
    out, result = _certify(tmp_dir, pki, "form-fill", name="cert-pades.pdf", pades=True)
    assert _raw_docmdp_p(out) == 2
    assert result["valid"] and result["intact"]
    verdict = verify_signatures(out)
    assert verdict["signatures"][0]["pades"] is True


# ── the two spec rules ─────────────────────────────────────────────────────

def test_certifying_an_already_signed_document_refuses(tmp_dir, pki):
    src = _base_pdf(os.path.join(tmp_dir, "base.pdf"))
    approval = os.path.join(tmp_dir, "approval.pdf")
    sign_pdf(src, approval, pfx_path=pki["pfx"], password="pw")
    out = os.path.join(tmp_dir, "never.pdf")
    with pytest.raises(ValueError, match="must be the first signature"):
        sign_pdf(approval, out, pfx_path=pki["pfx"], password="pw", certify=True)
    assert not os.path.exists(out)


def test_certifying_an_already_certified_document_refuses(tmp_dir, pki):
    certified, _ = _certify(tmp_dir, pki, "form-fill")
    out = os.path.join(tmp_dir, "never.pdf")
    with pytest.raises(ValueError, match="already certified"):
        sign_pdf(certified, out, pfx_path=pki["pfx"], password="pw", certify=True)
    assert not os.path.exists(out)


def test_approval_signing_a_no_changes_certification_refuses(tmp_dir, pki):
    certified, _ = _certify(tmp_dir, pki, "none", name="cert-none.pdf")
    out = os.path.join(tmp_dir, "never.pdf")
    with pytest.raises(ValueError, match="no changes allowed"):
        sign_pdf(certified, out, pfx_path=pki["pfx"], password="pw")
    assert not os.path.exists(out)


@pytest.mark.parametrize("level", ["form-fill", "annotate"])
def test_approval_signing_a_permissive_certification_succeeds(tmp_dir, pki, level):
    certified, _ = _certify(tmp_dir, pki, level, name=f"cert-{level}.pdf")
    out = os.path.join(tmp_dir, f"counter-{level}.pdf")
    result = sign_pdf(certified, out, pfx_path=pki["pfx"], password="pw")
    assert result["valid"] and result["intact"]
    assert result["signature_count"] == 2
    # The counter-signature is an approval one; the document stays certified
    # at the author's level.
    assert result["certified"] is True
    assert certification_of_file(out)["level"] == level


# ── the named refusals ─────────────────────────────────────────────────────

def test_level_without_certify_refuses(tmp_dir, pki):
    src = _base_pdf(os.path.join(tmp_dir, "base.pdf"))
    out = os.path.join(tmp_dir, "never.pdf")
    with pytest.raises(ValueError, match="applies only to a certification signature"):
        sign_pdf(src, out, pfx_path=pki["pfx"], password="pw", certify_level="annotate")
    assert not os.path.exists(out)


def test_unknown_level_refuses_and_lists_the_choices(tmp_dir, pki):
    src = _base_pdf(os.path.join(tmp_dir, "base.pdf"))
    out = os.path.join(tmp_dir, "never.pdf")
    with pytest.raises(ValueError, match="none, form-fill, or annotate"):
        sign_pdf(src, out, pfx_path=pki["pfx"], password="pw",
                 certify=True, certify_level="no-changes")
    assert not os.path.exists(out)


# ── the catalog read ───────────────────────────────────────────────────────

def test_unknown_permission_value_reports_the_value_without_a_level(tmp_dir, pki):
    certified, _ = _certify(tmp_dir, pki, "annotate", name="cert-p7.pdf")
    mangled = os.path.join(tmp_dir, "p7.pdf")
    with pikepdf.open(certified, allow_overwriting_input=False) as pdf:
        pdf.Root["/Perms"]["/DocMDP"]["/Reference"][0]["/TransformParams"]["/P"] = 7
        pdf.save(mangled)
    state = certification_of_file(mangled)
    assert state["certified"] is True
    assert state["level"] is None
    assert state["level_value"] == 7


def test_malformed_certification_reports_an_error_not_a_silent_absence(tmp_dir, pki):
    certified, _ = _certify(tmp_dir, pki, "form-fill", name="cert-broken.pdf")
    broken = os.path.join(tmp_dir, "broken.pdf")
    with pikepdf.open(certified) as pdf:
        del pdf.Root["/Perms"]["/DocMDP"]["/Reference"]
        pdf.save(broken)
    state = certification_of_file(broken)
    assert state["certified"] is False
    assert state["error"]


def test_an_uncertified_document_reports_no_error(tmp_dir):
    src = _base_pdf(os.path.join(tmp_dir, "plain.pdf"))
    state = certification_of_file(src)
    assert state == {"certified": False, "level": None, "level_value": None, "error": None}


# ── the reported shape ─────────────────────────────────────────────────────

# The per-signature keys the report carried before certification existed. The
# set comparison below is what catches an accidental REMOVAL — every consumer
# of this door reads these by name.
_PRIOR_SIGNATURE_KEYS = {
    "coverage", "covers_whole_document", "digest_algorithm", "field", "intact",
    "modified_after_signing", "pades", "page", "signer", "signing_time",
    "subfilter", "timestamp_time", "timestamp_valid", "timestamped", "trusted",
    "valid",
}
_CERTIFICATION_SIGNATURE_KEYS = {
    "certification_level", "policy_ok", "policy_judged", "modification_level",
}


def test_an_unsigned_document_reports_the_certification_block(tmp_dir):
    src = _base_pdf(os.path.join(tmp_dir, "plain.pdf"))
    verdict = verify_signatures(src)
    assert verdict["signed"] is False
    assert verdict["certification"] == {
        "certified": False, "level": None, "level_value": None,
        "field": None, "error": None,
    }
    assert verdict["summary"]["certified"] is False
    assert verdict["summary"]["any_policy_violation"] is False


def test_an_approval_signature_reports_no_certification_and_keeps_its_keys(tmp_dir, pki):
    src = _base_pdf(os.path.join(tmp_dir, "base.pdf"))
    out = os.path.join(tmp_dir, "approval.pdf")
    sign_pdf(src, out, pfx_path=pki["pfx"], password="pw")
    verdict = verify_signatures(out)
    assert verdict["certification"]["certified"] is False
    assert verdict["certification"]["field"] is None
    assert all(s["certification_level"] is None for s in verdict["signatures"])
    keys = set(verdict["signatures"][0])
    assert _PRIOR_SIGNATURE_KEYS - {"page"} <= keys
    assert keys - _PRIOR_SIGNATURE_KEYS == _CERTIFICATION_SIGNATURE_KEYS
    # No policy is in force, so there is nothing to violate and nothing unmade.
    assert verdict["signatures"][0]["policy_judged"] is True
    assert verdict["signatures"][0]["policy_ok"] is True


@pytest.mark.parametrize("level,value", [("none", 1), ("form-fill", 2), ("annotate", 3)])
def test_a_certified_document_names_its_level_and_its_author_signature(
    tmp_dir, pki, level, value
):
    out, _ = _certify(tmp_dir, pki, level, name=f"report-{value}.pdf")
    verdict = verify_signatures(out)
    assert verdict["certification"]["certified"] is True
    assert verdict["certification"]["level"] == level
    assert verdict["certification"]["level_value"] == value
    assert verdict["certification"]["field"] == verdict["signatures"][0]["field"]
    assert verdict["signatures"][0]["certification_level"] == level
    assert verdict["summary"]["certified"] is True


def test_a_counter_signature_is_distinguishable_from_the_author_signature(tmp_dir, pki):
    certified, _ = _certify(tmp_dir, pki, "form-fill", name="cert-counter.pdf")
    out = os.path.join(tmp_dir, "countersigned.pdf")
    sign_pdf(certified, out, pfx_path=pki["pfx"], password="pw")
    verdict = verify_signatures(out)
    levels = [s["certification_level"] for s in verdict["signatures"]]
    assert levels.count("form-fill") == 1
    assert levels.count(None) == 1
    assert verdict["certification"]["field"] == verdict["signatures"][0]["field"]


def test_an_unrecognized_permission_value_is_reported_unjudged(tmp_dir, pki):
    certified, _ = _certify(tmp_dir, pki, "form-fill", name="cert-odd.pdf")
    mangled = os.path.join(tmp_dir, "odd.pdf")
    with pikepdf.open(certified) as pdf:
        pdf.Root["/Perms"]["/DocMDP"]["/Reference"][0]["/TransformParams"]["/P"] = 7
        pdf.save(mangled)
    verdict = verify_signatures(mangled)
    assert verdict["certification"]["level"] is None
    assert verdict["certification"]["level_value"] == 7
    assert verdict["signatures"][0]["policy_judged"] is False
    assert verdict["signatures"][0]["policy_ok"] is None


def test_a_malformed_certification_reports_an_error_and_does_not_raise(tmp_dir, pki):
    certified, _ = _certify(tmp_dir, pki, "form-fill", name="cert-bad.pdf")
    broken = os.path.join(tmp_dir, "bad.pdf")
    with pikepdf.open(certified) as pdf:
        del pdf.Root["/Perms"]["/DocMDP"]["/Reference"]
        pdf.save(broken)
    verdict = verify_signatures(broken)
    assert verdict["certification"]["certified"] is False
    assert verdict["certification"]["error"]
    assert verdict["signed"] is True


# ── the difference policy ──────────────────────────────────────────────────

def _rows_under(path, policy):
    """``(field, docmdp_ok, modification_level)`` per signature, judged by the
    given difference policy."""
    ctx = ValidationContext(trust_roots=[], allow_fetching=False)
    rows = []
    with open(path, "rb") as fh:
        reader = PdfFileReader(fh)
        for esig in reader.embedded_regular_signatures:
            status = validate_pdf_signature(
                esig, signer_validation_context=ctx, ts_validation_context=ctx,
                diff_policy=policy,
            )
            level = status.modification_level
            rows.append((esig.field_name, status.docmdp_ok, level.name if level else None))
    return rows


def _rewritten(src, dst, mutate):
    """A full pikepdf rewrite carrying one edit — what every pipeline emits,
    and what the transplant re-expresses as an appended revision."""
    with pikepdf.open(src) as pdf:
        mutate(pdf)
        pdf.save(dst)
    return dst


def _add_square(pdf):
    annot = pdf.make_indirect(pikepdf.Dictionary(
        Type=pikepdf.Name("/Annot"), Subtype=pikepdf.Name("/Square"),
        Rect=pikepdf.Array([100, 300, 200, 360]), F=4,
        C=pikepdf.Array([1, 0, 0]),
    ))
    annots = pdf.pages[0].obj.get("/Annots")
    if annots is None:
        pdf.pages[0].obj["/Annots"] = pdf.make_indirect(pikepdf.Array([annot]))
    else:
        annots.append(annot)


def _fill_field(pdf):
    for field in pdf.Root["/AcroForm"]["/Fields"]:
        if field.get("/FT") == pikepdf.Name("/Tx"):
            field["/V"] = pikepdf.String("filled")


def _edited(tmp_dir, certified, kind, tag):
    """The certified document plus one edit, landed as an appended revision."""
    modified = _rewritten(
        certified, os.path.join(tmp_dir, f"mod-{tag}.pdf"),
        _add_square if kind == "annotate" else _fill_field,
    )
    out = os.path.join(tmp_dir, f"edited-{tag}.pdf")
    result = transplant_incremental(certified, modified, out)
    assert result["applied"], result
    return out


_EXPECTED_UNDER_OURS = {
    ("none", "fill"): (False, "FORM_FILLING"),
    ("none", "annotate"): (False, "ANNOTATIONS"),
    ("form-fill", "fill"): (True, "FORM_FILLING"),
    ("form-fill", "annotate"): (False, "ANNOTATIONS"),
    ("annotate", "fill"): (True, "FORM_FILLING"),
    ("annotate", "annotate"): (True, "ANNOTATIONS"),
}

# The bundled policy models form filling but not annotations, so it reports a
# permitted annotation as an illegal modification. Recorded here so a change
# that quietly restores it fails rather than passes.
_EXPECTED_UNDER_BUNDLED = {
    ("none", "fill"): (False, "FORM_FILLING"),
    ("none", "annotate"): (False, "OTHER"),
    ("form-fill", "fill"): (True, "FORM_FILLING"),
    ("form-fill", "annotate"): (False, "OTHER"),
    ("annotate", "fill"): (True, "FORM_FILLING"),
    ("annotate", "annotate"): (False, "OTHER"),
}


@pytest.mark.parametrize("level", ["none", "form-fill", "annotate"])
@pytest.mark.parametrize("edit", ["fill", "annotate"])
def test_the_edit_matrix_under_the_shipped_policy(tmp_dir, pki, level, edit):
    certified, _ = _certify(tmp_dir, pki, level, name=f"m-{level}.pdf")
    out = _edited(tmp_dir, certified, edit, f"{level}-{edit}")
    _field, ok, modification = _rows_under(out, DIFF_POLICY)[0]
    assert (ok, modification) == _EXPECTED_UNDER_OURS[(level, edit)]


@pytest.mark.parametrize("level", ["none", "form-fill", "annotate"])
@pytest.mark.parametrize("edit", ["fill", "annotate"])
def test_the_edit_matrix_under_the_bundled_policy(tmp_dir, pki, level, edit):
    certified, _ = _certify(tmp_dir, pki, level, name=f"b-{level}.pdf")
    out = _edited(tmp_dir, certified, edit, f"b-{level}-{edit}")
    _field, ok, modification = _rows_under(out, DEFAULT_DIFF_POLICY)[0]
    assert (ok, modification) == _EXPECTED_UNDER_BUNDLED[(level, edit)]


def test_a_permitted_annotation_reports_within_policy_through_the_engine_door(tmp_dir, pki):
    certified, _ = _certify(tmp_dir, pki, "annotate", name="door.pdf")
    out = _edited(tmp_dir, certified, "annotate", "door")
    verdict = verify_signatures(out)
    assert verdict["signatures"][0]["policy_judged"] is True
    assert verdict["signatures"][0]["policy_ok"] is True
    assert verdict["signatures"][0]["modification_level"] == "ANNOTATIONS"
    assert verdict["summary"]["any_policy_violation"] is False


def test_a_forbidden_annotation_reports_a_violation_through_the_engine_door(tmp_dir, pki):
    certified, _ = _certify(tmp_dir, pki, "form-fill", name="door2.pdf")
    out = _edited(tmp_dir, certified, "annotate", "door2")
    verdict = verify_signatures(out)
    assert verdict["signatures"][0]["policy_judged"] is True
    assert verdict["signatures"][0]["policy_ok"] is False
    assert verdict["summary"]["any_policy_violation"] is True


# ── where the annotation rule must NOT reach ───────────────────────────────

def _appended(path, out, mutate):
    """One incremental revision written by the library's own writer."""
    with open(path, "rb") as fh:
        writer = IncrementalPdfFileWriter(fh)
        mutate(writer)
        buf = io.BytesIO()
        writer.write(buf)
    with open(out, "wb") as fh:
        fh.write(buf.getvalue())
    return out


def _first_page(writer):
    page_ref, _ = writer.find_page_for_modification(0)
    return page_ref.get_object()


def _append_to_annots(writer, page, ref):
    value = page.get(generic.pdf_name("/Annots"))
    if value is None:
        page[generic.pdf_name("/Annots")] = generic.ArrayObject([ref])
        writer.update_container(page)
        return
    array = value.get_object()
    array.append(ref)
    writer.update_container(array)


def test_a_content_stream_swap_is_never_cleared(tmp_dir, pki):
    certified, _ = _certify(tmp_dir, pki, "annotate", name="content.pdf")

    def swap(writer):
        page = _first_page(writer)
        stream = generic.StreamObject(
            stream_data=b"BT /F1 12 Tf 72 700 Td (Replaced.) Tj ET"
        )
        page[generic.pdf_name("/Contents")] = writer.add_object(stream)
        writer.update_container(page)

    out = _appended(certified, os.path.join(tmp_dir, "content-swapped.pdf"), swap)
    _field, ok, modification = _rows_under(out, DIFF_POLICY)[0]
    assert modification == "OTHER"
    assert ok is False


def test_a_widget_added_to_a_page_is_not_cleared_by_the_annotation_rule(tmp_dir, pki):
    certified, _ = _certify(tmp_dir, pki, "annotate", name="widget.pdf")

    def add_widget(writer):
        page = _first_page(writer)
        widget = generic.DictionaryObject({
            generic.pdf_name("/Type"): generic.pdf_name("/Annot"),
            generic.pdf_name("/Subtype"): generic.pdf_name("/Widget"),
            generic.pdf_name("/FT"): generic.pdf_name("/Tx"),
            generic.pdf_name("/T"): generic.TextStringObject("smuggled"),
            generic.pdf_name("/Rect"): generic.ArrayObject(
                [generic.NumberObject(x) for x in (10, 10, 100, 40)]
            ),
            generic.pdf_name("/F"): generic.NumberObject(4),
        })
        _append_to_annots(writer, page, writer.add_object(widget))

    out = _appended(certified, os.path.join(tmp_dir, "widget-added.pdf"), add_widget)
    _field, ok, modification = _rows_under(out, DIFF_POLICY)[0]
    assert modification == "OTHER"
    assert ok is False


def test_a_plain_annotation_added_the_same_way_is_cleared(tmp_dir, pki):
    certified, _ = _certify(tmp_dir, pki, "annotate", name="square.pdf")

    def add_square(writer):
        page = _first_page(writer)
        annot = generic.DictionaryObject({
            generic.pdf_name("/Type"): generic.pdf_name("/Annot"),
            generic.pdf_name("/Subtype"): generic.pdf_name("/Square"),
            generic.pdf_name("/Rect"): generic.ArrayObject(
                [generic.NumberObject(x) for x in (100, 300, 200, 360)]
            ),
            generic.pdf_name("/F"): generic.NumberObject(4),
        })
        _append_to_annots(writer, page, writer.add_object(annot))

    out = _appended(certified, os.path.join(tmp_dir, "square-added.pdf"), add_square)
    _field, ok, modification = _rows_under(out, DIFF_POLICY)[0]
    assert modification == "ANNOTATIONS"
    assert ok is True


def test_an_unregistered_widget_smuggled_beside_a_plain_annotation_is_still_caught(
    tmp_dir, pki
):
    certified, _ = _certify(tmp_dir, pki, "annotate", name="smuggle.pdf")

    def add_both(writer):
        page = _first_page(writer)
        for subtype, extra in (
            ("/Square", {}),
            ("/Widget", {"/FT": generic.pdf_name("/Tx"),
                         "/T": generic.TextStringObject("smuggled")}),
        ):
            entries = {
                generic.pdf_name("/Type"): generic.pdf_name("/Annot"),
                generic.pdf_name("/Subtype"): generic.pdf_name(subtype),
                generic.pdf_name("/Rect"): generic.ArrayObject(
                    [generic.NumberObject(x) for x in (100, 300, 200, 360)]
                ),
                generic.pdf_name("/F"): generic.NumberObject(4),
            }
            for key, value in extra.items():
                entries[generic.pdf_name(key)] = value
            _append_to_annots(writer, page, writer.add_object(
                generic.DictionaryObject(entries)
            ))

    out = _appended(certified, os.path.join(tmp_dir, "smuggled.pdf"), add_both)
    _field, ok, modification = _rows_under(out, DIFF_POLICY)[0]
    assert modification == "OTHER"
    assert ok is False


def test_a_counter_signature_does_not_make_a_permitted_comment_a_violation(tmp_dir, pki):
    certified, _ = _certify(tmp_dir, pki, "annotate", name="cs-base.pdf")
    countersigned = os.path.join(tmp_dir, "cs.pdf")
    sign_pdf(certified, countersigned, pfx_path=pki["pfx"], password="pw")
    out = _edited(tmp_dir, countersigned, "annotate", "cs")
    verdict = verify_signatures(out)
    assert verdict["summary"]["any_policy_violation"] is False
    assert all(s["policy_judged"] and s["policy_ok"] for s in verdict["signatures"])
    assert [s["modification_level"] for s in verdict["signatures"]] == [
        "ANNOTATIONS", "ANNOTATIONS",
    ]


def test_a_rebuild_that_drops_the_certification_entry_still_transplants(tmp_dir, pki):
    """The page-tier rebuild carries no ``/Perms``; the transplant writes the
    original bytes verbatim, so the certification survives by construction.
    Comparing that catalog key would refuse every edit of a certified document
    and fall back to the rewrite, which destroys the very thing it protects."""
    certified, _ = _certify(tmp_dir, pki, "annotate", name="carry.pdf")

    def drop_perms_and_annotate(pdf):
        del pdf.Root["/Perms"]
        _add_square(pdf)

    modified = _rewritten(
        certified, os.path.join(tmp_dir, "mod-carry.pdf"), drop_perms_and_annotate
    )
    out = os.path.join(tmp_dir, "carried.pdf")
    assert transplant_incremental(certified, modified, out)["applied"] is True
    verdict = verify_signatures(out)
    assert verdict["certification"]["level"] == "annotate"
    assert verdict["signatures"][0]["intact"] is True
    assert verdict["signatures"][0]["policy_ok"] is True


# ── a widget held under the field's /Kids ─────────────────────────────────

def _kids_form_pdf(path):
    """A text field whose widget is a separate ``/Kids`` entry — the shape a
    merged field-widget test never exercises."""
    pdf = pikepdf.new()
    font = pdf.make_indirect(pikepdf.Dictionary(
        Type=pikepdf.Name("/Font"), Subtype=pikepdf.Name("/Type1"),
        BaseFont=pikepdf.Name("/Helvetica"), Encoding=pikepdf.Name("/WinAnsiEncoding"),
    ))
    page = pdf.add_blank_page(page_size=(400, 400))
    pdf.add_blank_page(page_size=(400, 400))
    widget = pdf.make_indirect(pikepdf.Dictionary(
        Type=pikepdf.Name("/Annot"), Subtype=pikepdf.Name("/Widget"),
        Rect=pikepdf.Array([40, 300, 260, 324]), F=4,
    ))
    field = pdf.make_indirect(pikepdf.Dictionary(
        FT=pikepdf.Name("/Tx"), T=pikepdf.String("applicant"),
        DA=pikepdf.String("/Helv 10 Tf 0 g"), Kids=pikepdf.Array([widget]),
    ))
    widget["/Parent"] = field
    page.obj["/Annots"] = pdf.make_indirect(pikepdf.Array([widget]))
    pdf.Root["/AcroForm"] = pdf.make_indirect(pikepdf.Dictionary(
        Fields=pikepdf.Array([field]), DA=pikepdf.String("/Helv 10 Tf 0 g"),
        DR=pikepdf.Dictionary(Font=pikepdf.Dictionary(Helv=font)),
    ))
    pdf.save(path)
    return path


@pytest.mark.parametrize("level,expected_ok", [("none", False), ("form-fill", True),
                                               ("annotate", True)])
def test_filling_a_kids_widget_is_judged_as_form_filling(tmp_dir, pki, level, expected_ok):
    from engine.forms import fill_form_fields

    src = _kids_form_pdf(os.path.join(tmp_dir, f"kids-{level}.pdf"))
    certified, _ = _certify(tmp_dir, pki, level, name=f"kids-cert-{level}.pdf", src=src)
    out = os.path.join(tmp_dir, f"kids-filled-{level}.pdf")
    fill_form_fields(certified, out, {"applicant": "filled"})
    _field, ok, modification = _rows_under(out, DIFF_POLICY)[0]
    assert modification == "FORM_FILLING"
    assert ok is expected_ok


def test_a_kids_widget_moved_while_filling_is_not_cleared(tmp_dir, pki):
    src = _kids_form_pdf(os.path.join(tmp_dir, "kids-move.pdf"))
    certified, _ = _certify(tmp_dir, pki, "annotate", name="kids-move-cert.pdf", src=src)

    def fill_and_move(pdf):
        field = pdf.Root["/AcroForm"]["/Fields"][0]
        field["/V"] = pikepdf.String("filled")
        widget = field["/Kids"][0]
        widget["/Rect"] = pikepdf.Array([10, 10, 230, 34])
        widget["/AP"] = pikepdf.Dictionary(N=pdf.make_stream(b"1 0 0 rg 0 0 10 10 re f"))

    modified = _rewritten(certified, os.path.join(tmp_dir, "kids-moved.pdf"), fill_and_move)
    out = os.path.join(tmp_dir, "kids-moved-out.pdf")
    assert transplant_incremental(certified, modified, out)["applied"] is True
    _field, ok, modification = _rows_under(out, DIFF_POLICY)[0]
    assert modification == "OTHER"
    assert ok is False


def test_a_kids_widget_appearance_rewritten_without_a_fill_is_not_cleared(tmp_dir, pki):
    src = _kids_form_pdf(os.path.join(tmp_dir, "kids-noval.pdf"))
    certified, _ = _certify(tmp_dir, pki, "annotate", name="kids-noval-cert.pdf", src=src)

    def restyle_only(pdf):
        widget = pdf.Root["/AcroForm"]["/Fields"][0]["/Kids"][0]
        widget["/AP"] = pikepdf.Dictionary(N=pdf.make_stream(b"0 0 1 rg 0 0 40 40 re f"))

    modified = _rewritten(certified, os.path.join(tmp_dir, "kids-restyled.pdf"), restyle_only)
    out = os.path.join(tmp_dir, "kids-restyled-out.pdf")
    assert transplant_incremental(certified, modified, out)["applied"] is True
    _field, ok, modification = _rows_under(out, DIFF_POLICY)[0]
    assert modification == "OTHER"
    assert ok is False


def test_adding_a_signature_field_alone_stays_at_the_form_level(tmp_dir, pki):
    """Counter-signing a form-filling certification must not be re-levelled by
    the annotation rule."""
    certified, _ = _certify(tmp_dir, pki, "form-fill", name="cs2-base.pdf")
    out = os.path.join(tmp_dir, "cs2.pdf")
    sign_pdf(certified, out, pfx_path=pki["pfx"], password="pw")
    rows = _rows_under(out, DIFF_POLICY)
    author = next(r for r in rows if r[0] == "Signature1")
    assert author[1] is True
    assert author[2] == "FORM_FILLING"
