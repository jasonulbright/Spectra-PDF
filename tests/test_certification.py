"""Certification (DocMDP) signatures: authoring, reporting, and the policy.

A certification signature records in the catalog what may change in the
document after it was signed. The assertions here read the RAW
``/Perms /DocMDP`` dictionary rather than a library readback, so a library
change that stops writing the transform is caught rather than papered over.
"""

import os

import pikepdf
import pytest

from engine.docmdp import certification_of_file
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
