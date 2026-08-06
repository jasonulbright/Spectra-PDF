"""Field-level locking (/FieldMDP): authoring, reporting, and enforcement.

A lock records which FORM FIELDS may no longer change after a signature. It is
a different transform from the document-level certification: per signature, and
binding with no certification present.

The assertions read the RAW ``/Lock`` dictionary and the signature's own
``/Reference`` rather than a library readback wherever the format is what is
being pinned, so a library change that stops writing the transform is caught
rather than papered over.
"""

import os

import pikepdf
import pytest
from pyhanko.pdf_utils import generic
from pyhanko.pdf_utils.incremental_writer import IncrementalPdfFileWriter
from pyhanko.pdf_utils.reader import PdfFileReader
from pyhanko.sign import fields
from pyhanko.sign.diff_analysis import DEFAULT_DIFF_POLICY
from pyhanko.sign.diff_analysis.policy_api import SuspiciousModification
from pyhanko.sign.fields import FieldMDPAction, FieldMDPSpec
from pyhanko.sign.validation import validate_pdf_signature
from pyhanko_certvalidator import ValidationContext

from engine.docmdp_policy import DIFF_POLICY, LockedFieldModification
from engine.fieldmdp import is_locked, locked_fields, locks_of_file
from engine.incremental import signature_policy, transplant_incremental
from engine.signatures import sign_pdf, verify_signatures
from tests.test_pades import _build_pki


_PKI: dict | None = None


@pytest.fixture
def pki(tmp_path_factory):
    global _PKI
    if _PKI is None:
        _PKI = _build_pki(str(tmp_path_factory.mktemp("lock-pki")))
    return _PKI


@pytest.fixture
def tmp_dir(tmp_path):
    return str(tmp_path)


def _base_pdf(path, empty_sig_field=False):
    """Two text fields, so an include lock and an exclude lock name different
    halves of the same document."""
    pdf = pikepdf.new()
    font = pdf.make_indirect(pikepdf.Dictionary(
        Type=pikepdf.Name("/Font"), Subtype=pikepdf.Name("/Type1"),
        BaseFont=pikepdf.Name("/Helvetica"), Encoding=pikepdf.Name("/WinAnsiEncoding"),
    ))
    page = pdf.add_blank_page(page_size=(612, 792))
    page.Contents = pdf.make_stream(b"BT /F1 12 Tf 72 700 Td (Body.) Tj ET")
    page.Resources = pikepdf.Dictionary(Font=pikepdf.Dictionary(F1=font))
    entries = []
    for index, name in enumerate(("Name", "Total")):
        entries.append(pdf.make_indirect(pikepdf.Dictionary(
            Type=pikepdf.Name("/Annot"), Subtype=pikepdf.Name("/Widget"),
            FT=pikepdf.Name("/Tx"), T=pikepdf.String(name),
            Rect=pikepdf.Array([50, 500 - index * 40, 250, 530 - index * 40]), F=4,
            V=pikepdf.String(""), DA=pikepdf.String("/Helv 10 Tf 0 g"),
        )))
    if empty_sig_field:
        entries.append(pdf.make_indirect(pikepdf.Dictionary(
            Type=pikepdf.Name("/Annot"), Subtype=pikepdf.Name("/Widget"),
            FT=pikepdf.Name("/Sig"), T=pikepdf.String("Approval"),
            Rect=pikepdf.Array([300, 500, 500, 560]), F=4,
        )))
    pdf.pages[0].obj["/Annots"] = pdf.make_indirect(pikepdf.Array(entries))
    pdf.Root["/AcroForm"] = pdf.make_indirect(pikepdf.Dictionary(
        Fields=pikepdf.Array(entries),
        DA=pikepdf.String("/Helv 10 Tf 0 g"),
        DR=pikepdf.Dictionary(Font=pikepdf.Dictionary(Helv=font)),
    ))
    pdf.save(path)
    return path


def _signed(tmp_dir, pki, name="locked.pdf", src=None, **sign_kw):
    if src is None:
        src = _base_pdf(os.path.join(tmp_dir, "base-" + name))
    out = os.path.join(tmp_dir, name)
    result = sign_pdf(src, out, pfx_path=pki["pfx"], password="pw", **sign_kw)
    return out, result


def _flatten(dictionary):
    """A pikepdf dictionary's own entries as plain strings and lists, so an
    assertion outlives the document context it was read from."""
    if dictionary is None:
        return None
    out = {}
    for key in dictionary.keys():
        value = dictionary[key]
        out[str(key)] = (
            [str(v) for v in value] if isinstance(value, pikepdf.Array) else str(value)
        )
    return out


def _raw_lock(path, field_name="Signature1"):
    """The ``/Lock`` dictionary on the signature field, as written."""
    with pikepdf.open(path) as pdf:
        for field in pdf.Root["/AcroForm"]["/Fields"]:
            if str(field.get("/T") or "") == field_name:
                return _flatten(field.get("/Lock"))
    return None


def _raw_transform(path, field_name="Signature1"):
    """The ``/FieldMDP`` transform parameters on the signature itself."""
    with pikepdf.open(path) as pdf:
        for field in pdf.Root["/AcroForm"]["/Fields"]:
            if str(field.get("/T") or "") != field_name:
                continue
            for ref in field["/V"]["/Reference"]:
                if ref.get("/TransformMethod") == pikepdf.Name("/FieldMDP"):
                    return _flatten(ref["/TransformParams"])
    return None


# ── authoring ──────────────────────────────────────────────────────────────

@pytest.mark.parametrize(
    "action,names,expected_action",
    [("all", None, "/All"), ("include", ["Total"], "/Include"), ("exclude", ["Total"], "/Exclude")],
)
def test_each_action_writes_the_lock_and_the_transform(
    tmp_dir, pki, action, names, expected_action
):
    out, result = _signed(
        tmp_dir, pki, name=f"lock-{action}.pdf", lock=action, lock_fields=names
    )
    lock = _raw_lock(out)
    assert lock["/Type"] == "/SigFieldLock"
    assert lock["/Action"] == expected_action
    params = _raw_transform(out)
    assert params["/Action"] == expected_action
    assert params["/V"] == "/1.2"
    if names is None:
        assert "/Fields" not in lock
    else:
        assert lock["/Fields"] == names
    assert result["lock"] == action
    assert result["lock_fields"] == (names or [])
    assert result["valid"] and result["intact"]


def test_a_signature_with_no_lock_writes_none(tmp_dir, pki):
    out, result = _signed(tmp_dir, pki, name="plain.pdf")
    assert _raw_lock(out) is None
    assert result["lock"] is None
    assert result["lock_fields"] == []
    assert locks_of_file(out) == []


def test_lock_composes_with_a_visible_stamp(tmp_dir, pki):
    out, result = _signed(
        tmp_dir, pki, name="lock-visible.pdf", lock="include", lock_fields=["Name"],
        appearance={"page": 1, "rect": [72, 100, 300, 160]},
    )
    assert result["lock"] == "include"
    assert locks_of_file(out) == [{"action": "include", "fields": ["Name"]}]


def test_lock_composes_with_an_existing_empty_field(tmp_dir, pki):
    src = _base_pdf(os.path.join(tmp_dir, "with-field.pdf"), empty_sig_field=True)
    out, result = _signed(
        tmp_dir, pki, name="lock-field.pdf", src=src, existing_field="Approval",
        lock="include", lock_fields=["Name"],
    )
    assert result["field"] == "Approval"
    assert _raw_lock(out, "Approval")["/Action"] == "/Include"
    assert result["valid"] and result["intact"]


def test_lock_composes_with_a_certification(tmp_dir, pki):
    out, result = _signed(
        tmp_dir, pki, name="cert-lock.pdf", certify=True, certify_level="form-fill",
        lock="include", lock_fields=["Total"],
    )
    assert result["certified"] is True
    assert result["certification_level"] == "form-fill"
    assert result["lock"] == "include"
    # ONE signature, TWO transform references.
    with pikepdf.open(out) as pdf:
        methods = {
            str(ref["/TransformMethod"])
            for ref in pdf.Root["/Perms"]["/DocMDP"]["/Reference"]
        }
    assert methods == {"/DocMDP", "/FieldMDP"}


def test_a_seeded_field_lock_applies_with_no_request(tmp_dir, pki):
    """A form's author can bind whoever signs; the signer need not ask, and the
    result reports what was WRITTEN rather than what was requested."""
    src = _base_pdf(os.path.join(tmp_dir, "seed-base.pdf"))
    seeded = os.path.join(tmp_dir, "seeded.pdf")
    with open(src, "rb") as fh:
        writer = IncrementalPdfFileWriter(fh)
        fields.append_signature_field(writer, sig_field_spec=fields.SigFieldSpec(
            "Approval", on_page=0, box=(300, 500, 500, 560),
            field_mdp_spec=FieldMDPSpec(action=FieldMDPAction.INCLUDE, fields=["Total"]),
        ))
        with open(seeded, "wb") as out_fh:
            writer.write(out_fh)
    out, result = _signed(tmp_dir, pki, name="seed-signed.pdf", src=seeded,
                          existing_field="Approval")
    assert result["lock"] == "include"
    assert result["lock_fields"] == ["Total"]


# ── refusals ───────────────────────────────────────────────────────────────

def test_field_names_without_a_lock_refuse(tmp_dir, pki):
    src = _base_pdf(os.path.join(tmp_dir, "base.pdf"))
    out = os.path.join(tmp_dir, "never.pdf")
    with pytest.raises(ValueError, match="apply only to a field lock"):
        sign_pdf(src, out, pfx_path=pki["pfx"], password="pw", lock_fields=["Name"])
    assert not os.path.exists(out)


def test_unknown_action_refuses_and_lists_the_choices(tmp_dir, pki):
    src = _base_pdf(os.path.join(tmp_dir, "base.pdf"))
    out = os.path.join(tmp_dir, "never.pdf")
    with pytest.raises(ValueError, match="all, include, or exclude"):
        sign_pdf(src, out, pfx_path=pki["pfx"], password="pw", lock="everything")
    assert not os.path.exists(out)


def test_all_with_field_names_refuses(tmp_dir, pki):
    """The format discards the list under /All, so accepting one would silently
    lock something other than what was chosen."""
    src = _base_pdf(os.path.join(tmp_dir, "base.pdf"))
    out = os.path.join(tmp_dir, "never.pdf")
    with pytest.raises(ValueError, match="takes no field names"):
        sign_pdf(src, out, pfx_path=pki["pfx"], password="pw",
                 lock="all", lock_fields=["Name"])
    assert not os.path.exists(out)


@pytest.mark.parametrize("action", ["include", "exclude"])
def test_a_list_action_with_no_names_refuses(tmp_dir, pki, action):
    """An empty list means opposite things under the two actions."""
    src = _base_pdf(os.path.join(tmp_dir, "base.pdf"))
    out = os.path.join(tmp_dir, "never.pdf")
    with pytest.raises(ValueError, match="at least one field name"):
        sign_pdf(src, out, pfx_path=pki["pfx"], password="pw", lock=action)
    assert not os.path.exists(out)


def test_a_field_the_document_does_not_carry_refuses(tmp_dir, pki):
    src = _base_pdf(os.path.join(tmp_dir, "base.pdf"))
    out = os.path.join(tmp_dir, "never.pdf")
    with pytest.raises(ValueError, match="no form field named"):
        sign_pdf(src, out, pfx_path=pki["pfx"], password="pw",
                 lock="include", lock_fields=["Nope"])
    assert not os.path.exists(out)


def test_replacing_a_fields_own_lock_refuses(tmp_dir, pki):
    src = _base_pdf(os.path.join(tmp_dir, "conflict-base.pdf"))
    seeded = os.path.join(tmp_dir, "conflict.pdf")
    with open(src, "rb") as fh:
        writer = IncrementalPdfFileWriter(fh)
        fields.append_signature_field(writer, sig_field_spec=fields.SigFieldSpec(
            "Approval", on_page=0, box=(300, 500, 500, 560),
            field_mdp_spec=FieldMDPSpec(action=FieldMDPAction.INCLUDE, fields=["Total"]),
        ))
        with open(seeded, "wb") as out_fh:
            writer.write(out_fh)
    out = os.path.join(tmp_dir, "never.pdf")
    with pytest.raises(ValueError, match="already locks form fields"):
        sign_pdf(seeded, out, pfx_path=pki["pfx"], password="pw",
                 existing_field="Approval", lock="all")
    assert not os.path.exists(out)


# ── the structural read ────────────────────────────────────────────────────

def test_an_unsigned_fields_lock_is_not_reported_as_binding(tmp_dir):
    """A /Lock on an EMPTY signature field constrains whoever signs it later;
    it binds nothing yet."""
    src = _base_pdf(os.path.join(tmp_dir, "seed-only-base.pdf"))
    seeded = os.path.join(tmp_dir, "seed-only.pdf")
    with open(src, "rb") as fh:
        writer = IncrementalPdfFileWriter(fh)
        fields.append_signature_field(writer, sig_field_spec=fields.SigFieldSpec(
            "Approval", on_page=0, box=(300, 500, 500, 560),
            field_mdp_spec=FieldMDPSpec(action=FieldMDPAction.ALL),
        ))
        with open(seeded, "wb") as out_fh:
            writer.write(out_fh)
    assert locks_of_file(seeded) == []
    assert signature_policy(seeded)["locks"] == []


def test_signature_policy_reports_the_locks(tmp_dir, pki):
    out, _ = _signed(tmp_dir, pki, name="policy.pdf", lock="exclude", lock_fields=["Name"])
    policy = signature_policy(out)
    assert policy["signed"] is True
    assert policy["locks"] == [{"action": "exclude", "fields": ["Name"]}]


def test_an_unreadable_file_reports_no_locks(tmp_dir):
    missing = os.path.join(tmp_dir, "nope.pdf")
    assert locks_of_file(missing) == []


@pytest.mark.parametrize(
    "lock,name,expected",
    [
        ({"action": "all", "fields": []}, "Anything", True),
        ({"action": "include", "fields": ["Total"]}, "Total", True),
        ({"action": "include", "fields": ["Total"]}, "Name", False),
        ({"action": "exclude", "fields": ["Total"]}, "Total", False),
        ({"action": "exclude", "fields": ["Total"]}, "Name", True),
        # A scoped name covers its whole subtree, both ways round.
        ({"action": "include", "fields": ["Buyer"]}, "Buyer.Name", True),
        ({"action": "exclude", "fields": ["Buyer"]}, "Buyer.Name", False),
        ({"action": "include", "fields": ["Buyer"]}, "BuyerName", False),
    ],
)
def test_is_locked_matches_the_formats_rule(lock, name, expected):
    assert is_locked(lock, name) is expected


def test_locked_fields_dedupes_and_keeps_the_given_order():
    locks = [{"action": "include", "fields": ["Total"]}]
    assert locked_fields(locks, ["Total", "Name", "Total"]) == ["Total"]


# ── enforcement ────────────────────────────────────────────────────────────

def _rewritten(src, dst, mutate):
    with pikepdf.open(src) as pdf:
        mutate(pdf)
        pdf.save(dst)
    return dst


def _fill(field_name):
    def mutate(pdf):
        for field in pdf.Root["/AcroForm"]["/Fields"]:
            if str(field.get("/T") or "") == field_name:
                field["/V"] = pikepdf.String("filled")
    return mutate


def _add_square(pdf):
    annot = pdf.make_indirect(pikepdf.Dictionary(
        Type=pikepdf.Name("/Annot"), Subtype=pikepdf.Name("/Square"),
        Rect=pikepdf.Array([100, 300, 200, 360]), F=4,
        C=pikepdf.Array([1, 0, 0]),
    ))
    pdf.pages[0].obj["/Annots"].append(annot)


def _edited(tmp_dir, signed, mutate, tag):
    modified = _rewritten(signed, os.path.join(tmp_dir, f"mod-{tag}.pdf"), mutate)
    out = os.path.join(tmp_dir, f"edited-{tag}.pdf")
    result = transplant_incremental(signed, modified, out)
    assert result["applied"], result
    return out


def _verdict(path, policy):
    ctx = ValidationContext(trust_roots=[], allow_fetching=False)
    with open(path, "rb") as fh:
        reader = PdfFileReader(fh)
        esig = reader.embedded_regular_signatures[0]
        status = validate_pdf_signature(
            esig, signer_validation_context=ctx, ts_validation_context=ctx,
            diff_policy=policy,
        )
        level = status.modification_level
        return status.docmdp_ok, (level.name if level is not None else None), status


# The measured grid. The lock rows are IDENTICAL under both policies: the
# locked-field check is the standard policy's own, and the two rules this build
# composes on top neither extend nor weaken it. The annotate rows differ for
# the reason the certification work already recorded — the bundled policy
# models no annotations — and a lock governs form fields only either way.
_GRID = [
    ("all", None, "Name", False, "OTHER", False, "OTHER"),
    ("all", None, "Total", False, "OTHER", False, "OTHER"),
    ("include", ["Total"], "Total", False, "OTHER", False, "OTHER"),
    ("include", ["Total"], "Name", True, "FORM_FILLING", True, "FORM_FILLING"),
    ("exclude", ["Total"], "Total", True, "FORM_FILLING", True, "FORM_FILLING"),
    ("exclude", ["Total"], "Name", False, "OTHER", False, "OTHER"),
]


@pytest.mark.parametrize(
    "action,names,filled,ours_ok,ours_level,bundled_ok,bundled_level",
    _GRID,
    ids=[f"{row[0]}-fill-{row[2]}" for row in _GRID],
)
def test_the_verdict_grid_under_both_policies(
    tmp_dir, pki, action, names, filled, ours_ok, ours_level, bundled_ok, bundled_level
):
    tag = f"{action}-{filled}"
    signed, _ = _signed(tmp_dir, pki, name=f"grid-{tag}.pdf", lock=action, lock_fields=names)
    edited = _edited(tmp_dir, signed, _fill(filled), tag)
    assert _verdict(edited, DIFF_POLICY)[:2] == (ours_ok, ours_level)
    assert _verdict(edited, DEFAULT_DIFF_POLICY)[:2] == (bundled_ok, bundled_level)


def test_an_annotation_is_untouched_by_a_lock(tmp_dir, pki):
    signed, _ = _signed(tmp_dir, pki, name="lock-annot.pdf", lock="all")
    edited = _edited(tmp_dir, signed, _add_square, "annot")
    assert _verdict(edited, DIFF_POLICY)[:2] == (True, "ANNOTATIONS")


def test_a_locked_field_change_is_reported_by_name(tmp_dir, pki):
    signed, _ = _signed(tmp_dir, pki, name="named.pdf", lock="include", lock_fields=["Total"])
    edited = _edited(tmp_dir, signed, _fill("Total"), "named")
    _, _, status = _verdict(edited, DIFF_POLICY)
    assert isinstance(status.diff_result, LockedFieldModification)
    assert status.diff_result.fields == ["Total"]
    verdict = verify_signatures(edited)
    assert verdict["signatures"][0]["lock"] == {"action": "include", "fields": ["Total"]}
    assert verdict["signatures"][0]["lock_violation"] == {"fields": ["Total"]}
    assert verdict["summary"]["any_lock_violation"] is True


def test_a_change_to_an_unlocked_field_reports_no_violation(tmp_dir, pki):
    signed, _ = _signed(tmp_dir, pki, name="clean.pdf", lock="include", lock_fields=["Total"])
    edited = _edited(tmp_dir, signed, _fill("Name"), "clean")
    verdict = verify_signatures(edited)
    assert verdict["signatures"][0]["lock_violation"] is None
    assert verdict["summary"]["any_lock_violation"] is False


def test_an_unlocked_document_reports_the_shape_unchanged(tmp_dir, pki):
    out, _ = _signed(tmp_dir, pki, name="nolock.pdf")
    verdict = verify_signatures(out)
    assert verdict["signatures"][0]["lock"] is None
    assert verdict["signatures"][0]["lock_violation"] is None
    assert verdict["summary"]["any_lock_violation"] is False


def test_a_suspicious_change_that_is_not_a_lock_violation_keeps_its_verdict(tmp_dir, pki):
    """Only a locked-field update is relabelled; anything else the policy
    refuses propagates as it did."""
    signed, _ = _signed(tmp_dir, pki, name="other.pdf", lock="include", lock_fields=["Total"])
    out = os.path.join(tmp_dir, "edited-other.pdf")
    with open(signed, "rb") as fh:
        writer = IncrementalPdfFileWriter(fh)
        writer.root["/SpectraProbe"] = generic.NameObject("/Unexplained")
        writer.update_root()
        with open(out, "wb") as out_fh:
            writer.write(out_fh)
    _, level, status = _verdict(out, DIFF_POLICY)
    assert level == "OTHER"
    assert isinstance(status.diff_result, SuspiciousModification)
    assert not isinstance(status.diff_result, LockedFieldModification)


# ── the transplant regression ──────────────────────────────────────────────

def test_editing_a_lock_signed_document_keeps_the_signatures_coverage(tmp_dir, pki):
    """A /FieldMDP reference's /Data points at the document CATALOG, so a signed
    signature field compares unequal to itself after any edit anywhere in the
    file. Rewriting it into the appended revision drops the signature's coverage
    below a whole revision and makes every later verdict unjudgeable."""
    signed, _ = _signed(tmp_dir, pki, name="coverage.pdf", lock="include", lock_fields=["Total"])
    edited = _edited(tmp_dir, signed, _fill("Name"), "coverage")
    with open(edited, "rb") as fh:
        reader = PdfFileReader(fh)
        esig = reader.embedded_regular_signatures[0]
        assert esig.evaluate_signature_coverage().name == "ENTIRE_REVISION"


def test_the_edit_does_not_rewrite_the_signature_field(tmp_dir, pki):
    signed, _ = _signed(tmp_dir, pki, name="untouched.pdf", lock="all")
    modified = _rewritten(
        signed, os.path.join(tmp_dir, "mod-untouched.pdf"), _fill("Name")
    )
    out = os.path.join(tmp_dir, "edited-untouched.pdf")
    result = transplant_incremental(signed, modified, out)
    assert result["applied"] is True
    assert result["fields_updated"] == 1
