"""Independent signed-field layouts and semantic-delta boundary checks."""
from pathlib import Path
import zlib

import pikepdf
import pytest

from engine.incremental import (
    finalize_preserving_signatures, has_live_signatures, signature_policy,
    signed_edit_decision, transplant_incremental,
)
from engine.signatures import sign_pdf, verify_signatures
from engine.acroform import live_signature_fields
from engine.fieldmdp import locks_of_pdf
from engine.forms import fill_form_fields
from test_incremental import _base_pdf, _add_square, _rewrite_with, _assert_sig_still_valid
from test_pades import _build_pki


@pytest.fixture(scope="module")
def boundary_pki(tmp_path_factory):
    return _build_pki(str(tmp_path_factory.mktemp("boundary-pki")))


def signed_layout(tmp_path, pki, *, separate=True, nested=False, lock=None):
    source = tmp_path / "source.pdf"
    _base_pdf(str(source), with_form=True)
    with pikepdf.open(source, allow_overwriting_input=True) as pdf:
        sig = pdf.make_indirect(pikepdf.Dictionary(
            FT=pikepdf.Name.Sig, T=pikepdf.String("approval"),
        ))
        widget = pdf.make_indirect(pikepdf.Dictionary()) if separate else sig
        widget.update(pikepdf.Dictionary(
            Type=pikepdf.Name.Annot, Subtype=pikepdf.Name.Widget,
            Rect=pikepdf.Array([20, 20, 100, 60]), F=4, P=pdf.pages[0].obj,
        ))
        if separate:
            sig.Kids = pikepdf.Array([widget])
            widget.Parent = sig
        root = sig
        if nested:
            root = pdf.make_indirect(pikepdf.Dictionary(
                T=pikepdf.String("group"), FT=pikepdf.Name.Sig,
                Kids=pikepdf.Array([sig]),
            ))
            del sig["/FT"]
            sig.Parent = root
        pdf.Root.AcroForm.Fields.append(root)
        pdf.pages[0].Annots.append(widget)
        pdf.save(source)
    signed = tmp_path / "signed.pdf"
    kwargs = {"lock": lock, "lock_fields": ["name"]} if lock else {}
    sign_pdf(str(source), str(signed), pfx_path=pki["pfx"], password="pw",
             existing_field="group.approval" if nested else "approval", **kwargs)
    _assert_sig_still_valid(str(signed), pki)
    return signed


@pytest.mark.parametrize("separate,nested", [(False, False), (True, False), (True, True)])
def test_signed_field_with_widget_children_is_detected(tmp_path, boundary_pki, separate, nested):
    signed = signed_layout(tmp_path, boundary_pki, separate=separate, nested=nested)
    policy = signature_policy(str(signed))
    assert policy["signed"] is True and policy["count"] == 1, policy
    assert has_live_signatures(str(signed))
    modified = _rewrite_with(str(signed), str(tmp_path), _add_square)
    result = finalize_preserving_signatures(str(signed), modified)
    assert result["preserved"] is True, result
    assert Path(modified).read_bytes().startswith(signed.read_bytes())
    _assert_sig_still_valid(modified, boundary_pki)


@pytest.mark.parametrize("nested", [False, True])
def test_separate_signature_widget_keeps_its_field_lock(tmp_path, boundary_pki, nested):
    signed = signed_layout(tmp_path, boundary_pki, nested=nested, lock="include")
    policy = signature_policy(str(signed))
    assert policy["locks"] == [{"action": "include", "fields": ["name"]}], policy
    assert signed_edit_decision(policy, "form-fill", ["name"])["kind"] == "refuse"
    assert signed_edit_decision(policy, "form-fill", ["elsewhere"])["kind"] == "proceed"
    output = tmp_path / "locked-fill.pdf"
    output.write_bytes(b"previous output")
    with pytest.raises(ValueError, match="field is read-only: name"):
        fill_form_fields(str(signed), str(output), {"name": "changed"})
    assert output.read_bytes() == b"previous output"
    _assert_sig_still_valid(str(signed), boundary_pki)


@pytest.mark.parametrize("action,entries", [("all", []), ("include", ["Total"]), ("exclude", ["Name"])])
@pytest.mark.parametrize("flatten", [False, True])
def test_engine_fill_enforces_locks_on_calculated_and_flattened_fields(
    tmp_path, boundary_pki, action, entries, flatten,
):
    from test_field_lock import _base_pdf as lock_base
    source = tmp_path / "calculated.pdf"
    lock_base(str(source))
    with pikepdf.open(source, allow_overwriting_input=True) as pdf:
        name, total = pdf.Root.AcroForm.Fields
        name.V = pikepdf.String("2")
        total.V = pikepdf.String("2")
        total.AA = pikepdf.Dictionary(C=pikepdf.Dictionary(
            S=pikepdf.Name.JavaScript, JS=pikepdf.String('AFSimple_Calculate("SUM", ["Name"]);'),
        ))
        pdf.Root.AcroForm.CO = pikepdf.Array([total])
        pdf.save(source)
    signed = tmp_path / "calculated-signed.pdf"
    sign_pdf(str(source), str(signed), pfx_path=boundary_pki["pfx"], password="pw",
             lock=action, lock_fields=entries)
    original_bytes = signed.read_bytes()
    output = tmp_path / "calculated-output.pdf"
    output.write_bytes(b"previous output")
    with pytest.raises(ValueError, match="field is read-only:"):
        fill_form_fields(str(signed), str(output), {} if flatten else {"Name": "9"}, flatten=flatten)
    assert signed.read_bytes() == original_bytes
    assert output.read_bytes() == b"previous output"


@pytest.mark.parametrize("action,entries", [("include", ["Total"]), ("exclude", ["Name"])])
def test_unlocked_field_still_fills_and_preserves_signature(tmp_path, boundary_pki, action, entries):
    from test_field_lock import _base_pdf as lock_base
    source = tmp_path / "unlocked-source.pdf"
    lock_base(str(source))
    signed = tmp_path / "unlocked-signed.pdf"
    sign_pdf(str(source), str(signed), pfx_path=boundary_pki["pfx"], password="pw",
             lock=action, lock_fields=entries)
    output = tmp_path / "unlocked-output.pdf"
    result = fill_form_fields(str(signed), str(output), {"Name": "allowed"})
    assert result["signatures_preserved"] is True, result
    assert output.read_bytes().startswith(signed.read_bytes())
    verified = verify_signatures(str(output), trust_roots=[boundary_pki["ca_pem"]])
    assert verified["summary"]["all_valid"] is True
    assert verified["summary"]["any_lock_violation"] is False
    with pikepdf.open(output) as pdf:
        name = next(field for field in pdf.Root.AcroForm.Fields if str(field.T) == "Name")
        assert str(name.V) == "allowed"


def test_noop_finalization_keeps_signed_bytes(tmp_path, boundary_pki):
    signed = signed_layout(tmp_path, boundary_pki, separate=False)
    modified = _rewrite_with(str(signed), str(tmp_path), lambda pdf: None)
    assert Path(modified).read_bytes() != signed.read_bytes()
    result = finalize_preserving_signatures(str(signed), modified)
    assert result["preserved"] is True, result
    assert Path(modified).read_bytes() == signed.read_bytes()
    _assert_sig_still_valid(modified, boundary_pki)


def test_predictor_only_content_change_is_not_discarded(tmp_path, boundary_pki):
    source = tmp_path / "predictor-source.pdf"
    _base_pdf(str(source))
    with pikepdf.open(source, allow_overwriting_input=True) as pdf:
        image = pdf.make_stream(zlib.compress(bytes([10, 20, 30])))
        image.stream_dict.update(pikepdf.Dictionary(
            Type=pikepdf.Name.XObject, Subtype=pikepdf.Name.Image,
            Width=3, Height=1, BitsPerComponent=8, ColorSpace=pikepdf.Name.DeviceGray,
            Filter=pikepdf.Name.FlateDecode,
            DecodeParms=pikepdf.Dictionary(Predictor=1, Columns=3),
        ))
        pdf.pages[0].Resources = pikepdf.Dictionary(XObject=pikepdf.Dictionary(Im=image))
        pdf.pages[0].Contents = pdf.make_stream(b"q 300 0 0 100 0 0 cm /Im Do Q")
        pdf.save(source, compress_streams=False)
    signed = tmp_path / "predictor-signed.pdf"
    sign_pdf(str(source), str(signed), pfx_path=boundary_pki["pfx"], password="pw")

    def mutate(pdf):
        pdf.pages[0].Resources.XObject.Im.DecodeParms.Predictor = 2
        _add_square(pdf)

    modified = _rewrite_with(str(signed), str(tmp_path), mutate)
    with pikepdf.open(signed) as original, pikepdf.open(modified) as edited:
        a = original.pages[0].Resources.XObject.Im
        b = edited.pages[0].Resources.XObject.Im
        assert a.read_raw_bytes() == b.read_raw_bytes()
        assert a.read_bytes() != b.read_bytes()
    output = tmp_path / "predictor-output.pdf"
    output.write_bytes(b"existing destination")
    result = transplant_incremental(str(signed), modified, str(output))
    assert result["applied"] is False, result
    assert output.read_bytes() == b"existing destination"


@pytest.mark.parametrize("count", [0, 1, 3])
def test_signature_presence_counts_fields_not_widgets(count):
    with pikepdf.new() as pdf:
        signature = pdf.make_indirect(pikepdf.Dictionary(
            T=pikepdf.String("approval"),
            V=pikepdf.Dictionary(Reference=pikepdf.Array([pikepdf.Dictionary(
                TransformMethod=pikepdf.Name.FieldMDP,
                TransformParams=pikepdf.Dictionary(Action=pikepdf.Name.All),
            )])),
        ))
        signature.Kids = pikepdf.Array([
            pdf.make_indirect(pikepdf.Dictionary(Subtype=pikepdf.Name.Widget, Parent=signature))
            for _ in range(count)
        ])
        root = pdf.make_indirect(pikepdf.Dictionary(FT=pikepdf.Name.Sig, Kids=pikepdf.Array([signature])))
        # Repeated references/cycles in a damaged tree must neither multiply
        # signatures nor hang the presence-only walk.
        root.Kids.append(root)
        pdf.Root.AcroForm = pikepdf.Dictionary(Fields=pikepdf.Array([root, root]))
        assert len(live_signature_fields(pdf)) == 1
        assert locks_of_pdf(pdf) == [{"action": "all", "fields": []}]
        del signature["/V"]
        assert live_signature_fields(pdf) == []
        assert locks_of_pdf(pdf) == []


def test_different_stream_encodings_with_identical_decoded_bytes_still_match():
    from engine.incremental import _bisim
    with pikepdf.new() as pdf:
        plain = pdf.make_stream(bytes([10, 30, 60]))
        predicted = pdf.make_stream(zlib.compress(bytes([10, 20, 30])))
        predicted.Filter = pikepdf.Name.FlateDecode
        predicted.DecodeParms = pikepdf.Dictionary(Predictor=2, Columns=3)
        assert plain.read_raw_bytes() != predicted.read_raw_bytes()
        assert plain.read_bytes() == predicted.read_bytes()
        assert _bisim(plain, predicted, set())
