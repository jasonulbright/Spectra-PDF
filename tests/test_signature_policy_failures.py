"""Unknown policy is never evidence that an edit is permitted."""
from decimal import Decimal

import pikepdf
import pytest

import engine.incremental as inc
from engine.docmdp import certification_of_pdf, POLICY_UNREADABLE
from engine.fieldmdp import locks_of_pdf
from engine.forms import fill_form_fields
from engine.links import add_links
from engine.annotations import delete_all_annotations
from engine.xfdf import import_xfdf
from test_incremental_boundaries import boundary_pki, signed_layout
from test_incremental import _rewrite_with, _add_square


@pytest.mark.parametrize("value", [True, pikepdf.String("2"), pikepdf.Name.Two, Decimal("1.5"),
                                  pikepdf.Array([2]), pikepdf.Dictionary()])
def test_wrong_permission_type_is_unreadable(value):
    with pikepdf.new() as pdf:
        pdf.Root.Perms = pikepdf.Dictionary(DocMDP=pikepdf.Dictionary(Reference=pikepdf.Array([
            pikepdf.Dictionary(TransformMethod=pikepdf.Name.DocMDP,
                               TransformParams=pikepdf.Dictionary(P=value)),
        ])))
        assert certification_of_pdf(pdf)["error"] == POLICY_UNREADABLE
        policy = inc.signature_policy_of_pdf(pdf)
        assert inc.signed_edit_decision(policy, "annotate")["kind"] == "refuse"


@pytest.mark.parametrize("value,expected", [(1, "none"), (2, "form-fill"), (3, "annotate"),
                                          (Decimal("2.0"), "form-fill"), (99, None), (None, "form-fill")])
def test_permissions_and_default_are_read_without_guessing(value, expected):
    with pikepdf.new() as pdf:
        params = pikepdf.Dictionary() if value is None else pikepdf.Dictionary(P=value)
        pdf.Root.Perms = pikepdf.Dictionary(DocMDP=pikepdf.Dictionary(Reference=pikepdf.Array([
            pikepdf.Dictionary(TransformMethod=pikepdf.Name.DocMDP, TransformParams=params),
        ])))
        result = certification_of_pdf(pdf)
        assert result["certified"] and result["error"] is None, result
        assert result["level"] == expected


@pytest.mark.parametrize("shape", ["perms", "docmdp", "refs", "ref", "method", "params", "duplicate"])
def test_malformed_catalog_policy_is_not_absent(shape):
    with pikepdf.new() as pdf:
        ref = pikepdf.Dictionary(TransformMethod=pikepdf.Name.DocMDP,
                                TransformParams=pikepdf.Dictionary(P=1))
        pdf.Root.Perms = pikepdf.Dictionary(DocMDP=pikepdf.Dictionary(Reference=pikepdf.Array([ref])))
        if shape == "perms": pdf.Root.Perms = 42
        elif shape == "docmdp": pdf.Root.Perms.DocMDP = 42
        elif shape == "refs": pdf.Root.Perms.DocMDP.Reference = 42
        elif shape == "ref": pdf.Root.Perms.DocMDP.Reference[0] = 42
        elif shape == "method": del ref["/TransformMethod"]
        elif shape == "params": ref.TransformParams = 42
        else: pdf.Root.Perms.DocMDP.Reference.append(ref)
        assert certification_of_pdf(pdf)["error"], shape


@pytest.mark.parametrize("shape", ["acro", "fields", "node", "kids", "cycle", "depth", "ft", "value"])
def test_presence_walk_failure_is_not_unsigned(shape):
    with pikepdf.new() as pdf:
        field = pdf.make_indirect(pikepdf.Dictionary(FT=pikepdf.Name.Sig))
        pdf.Root.AcroForm = pikepdf.Dictionary(Fields=pikepdf.Array([field]))
        if shape == "acro": pdf.Root.AcroForm = 42
        elif shape == "fields": pdf.Root.AcroForm.Fields = 42
        elif shape == "node": pdf.Root.AcroForm.Fields[0] = 42
        elif shape == "kids": field.Kids = 42
        elif shape == "cycle": field.Kids = pikepdf.Array([field])
        elif shape == "depth":
            for _ in range(34):
                kid = pdf.make_indirect(pikepdf.Dictionary())
                field.Kids = pikepdf.Array([kid])
                field = kid
        elif shape == "ft": field.FT = pikepdf.String("Sig")
        else: field.V = 42
        policy = inc.signature_policy_of_pdf(pdf)
        assert policy["error"] == POLICY_UNREADABLE, shape
        for edit in inc.EDIT_CLASSES:
            assert inc.signed_edit_decision(policy, edit)["reason"] == POLICY_UNREADABLE


@pytest.mark.parametrize("shape", ["refs", "ref", "method", "unknown-method", "params", "action", "string-action", "fields", "name"])
def test_unreadable_field_lock_never_becomes_no_locks(shape):
    with pikepdf.new() as pdf:
        params = pikepdf.Dictionary(Action=pikepdf.Name.Include, Fields=pikepdf.Array([pikepdf.String("name")]))
        ref = pdf.make_indirect(pikepdf.Dictionary(TransformMethod=pikepdf.Name.FieldMDP, TransformParams=params))
        value = pdf.make_indirect(pikepdf.Dictionary(Reference=pikepdf.Array([ref])))
        field = pdf.make_indirect(pikepdf.Dictionary(FT=pikepdf.Name.Sig, V=value))
        pdf.Root.AcroForm = pikepdf.Dictionary(Fields=pikepdf.Array([field]))
        if shape == "refs": value.Reference = 42
        elif shape == "ref": value.Reference[0] = 42
        elif shape == "method": del ref["/TransformMethod"]
        elif shape == "unknown-method": ref.TransformMethod = pikepdf.Name.Unknown
        elif shape == "params": ref.TransformParams = 42
        elif shape == "action": params.Action = pikepdf.Name.Invalid
        elif shape == "string-action": params.Action = pikepdf.String("/Include")
        elif shape == "fields": params.Fields = 42
        else: params.Fields[0] = 42
        with pytest.raises(ValueError, match="signature policy could not be read"):
            locks_of_pdf(pdf, strict=True)
        assert inc.signature_policy_of_pdf(pdf)["error"] == POLICY_UNREADABLE


def test_document_open_failure_is_explicit(tmp_path):
    path = str(tmp_path / "missing.pdf")
    assert inc.signature_policy(path)["error"] == POLICY_UNREADABLE
    with pytest.raises(ValueError, match="signature policy could not be read"):
        inc.has_live_signatures(path)


@pytest.mark.parametrize("operation", ["fill", "links", "comments", "xfdf"])
@pytest.mark.parametrize("same_file", [False, True])
def test_late_policy_failure_cannot_replace_any_destination(tmp_path, boundary_pki, monkeypatch, operation, same_file):
    signed = signed_layout(tmp_path, boundary_pki)
    before = signed.read_bytes()
    output = signed if same_file else tmp_path / "existing.pdf"
    if not same_file: output.write_bytes(b"previous destination")
    previous = output.read_bytes()
    # The finalizer's second read fails AFTER the rewrite has been saved.
    monkeypatch.setattr(inc, "signature_policy", lambda _: {"error": POLICY_UNREADABLE})
    with pytest.raises(ValueError, match="signature policy could not be read"):
        if operation == "fill": fill_form_fields(str(signed), str(output), {"name": "new"})
        elif operation == "links": add_links(str(signed), str(output), [{
            "page": 1, "rect": [0, 100, 100, 120], "target": {"kind": "goto", "page": 1},
        }])
        elif operation == "comments": delete_all_annotations(str(signed), str(output))
        else:
            xfdf = tmp_path / "review.xfdf"
            xfdf.write_text('<xfdf xmlns="http://ns.adobe.com/xfdf/"><annots><square page="0" rect="0,0,10,10"/></annots></xfdf>')
            import_xfdf(str(signed), str(xfdf), str(output))
    assert signed.read_bytes() == before
    assert output.read_bytes() == previous


def test_transplant_refusal_has_no_rewrite_fallback(tmp_path, boundary_pki, monkeypatch):
    signed = signed_layout(tmp_path, boundary_pki)
    modified = _rewrite_with(str(signed), str(tmp_path), _add_square)
    monkeypatch.setattr(inc, "certification_of_pdf", lambda _: {
        "certified": False, "level": None, "error": POLICY_UNREADABLE,
    })
    result = inc.transplant_incremental(str(signed), modified, modified)
    assert result == {"applied": False, "blocked": True, "reason": POLICY_UNREADABLE}
    with pytest.raises(ValueError, match="signature policy could not be read"):
        inc.finalize_preserving_signatures(str(signed), modified)


def test_transplant_runtime_failure_cannot_publish_rewrite(tmp_path, boundary_pki, monkeypatch):
    signed = signed_layout(tmp_path, boundary_pki)
    before = signed.read_bytes()
    output = tmp_path / "existing.pdf"
    output.write_bytes(b"previous destination")

    def failed(*_args):
        raise RuntimeError("reader failed after policy precheck")

    monkeypatch.setattr(inc, "transplant_incremental", failed)
    with pytest.raises(ValueError, match="signature policy could not be read"):
        add_links(str(signed), str(output), [{
            "page": 1, "rect": [0, 100, 100, 120], "target": {"kind": "goto", "page": 1},
        }])
    assert signed.read_bytes() == before
    assert output.read_bytes() == b"previous destination"
