"""A whole-file rewrite of an encrypted document keeps its encryption.

qpdf decrypts on open and hands the caller a plain object graph, so a rewrite
that does not put the encryption back writes an unprotected copy of a
protected document — the permission bits the author set are gone from the
output and nothing says so. These tests pin both halves of the answer: the
rewrite preserves what it can, and refuses where it cannot.
"""

import os

import pikepdf
import pytest

from engine.compress import compress
from engine.encrypt import decrypt
from engine.grayscale import grayscale
from engine.inspect import unlock
from engine.merge import merge
from engine.prepress import convert_cmyk, convert_pdfx
from engine.print_layout import impose_poster
from engine.rebuild import rebuild
from engine.recover import recover
from engine.repair import repair
from engine.rotate import rotate
from engine.split import split


LOCKED = pikepdf.Permissions(
    accessibility=True,
    extract=False,
    modify_annotation=False,
    modify_assembly=False,
    modify_form=False,
    modify_other=False,
    print_lowres=False,
    print_highres=False,
)


def _write(path, *, owner="", revision=6, pages=2, allow=LOCKED):
    pdf = pikepdf.new()
    for _ in range(pages):
        pdf.add_blank_page(page_size=(612, 792))
    kwargs = dict(owner=owner, user="", R=revision, aes=revision >= 4, allow=allow)
    if revision < 4:
        kwargs["metadata"] = False
    pdf.save(str(path), encryption=pikepdf.Encryption(**kwargs))
    pdf.close()
    return str(path)


@pytest.fixture
def encrypted_pdf(tmp_dir):
    """Empty user password, empty owner password, everything but assistive
    reading forbidden. Opens without a prompt; the restrictions are real."""
    return _write(os.path.join(tmp_dir, "locked.pdf"))


@pytest.fixture
def owner_gated_pdf(tmp_dir):
    """Empty user password, permissions held by an owner password — the shape
    a rewrite cannot reproduce, because a password cannot be read back."""
    return _write(os.path.join(tmp_dir, "owner-gated.pdf"), owner="secret")


def assert_still_protected(path, revision=6):
    with pikepdf.open(str(path)) as pdf:
        assert pdf.is_encrypted, f"{path} came back decrypted"
        assert int(pdf.encryption.R) == revision
        assert pdf.allow.extract is False
        assert pdf.allow.print_highres is False
        assert pdf.allow.modify_other is False
        assert pdf.allow.accessibility is True


def assert_decrypted(path):
    with pikepdf.open(str(path)) as pdf:
        assert not pdf.is_encrypted


# ── preserved ─────────────────────────────────────────────────────────────


def test_repair_keeps_encryption(encrypted_pdf, tmp_dir):
    out = os.path.join(tmp_dir, "repaired.pdf")
    repair(encrypted_pdf, out)
    assert_still_protected(out)


def test_rotate_keeps_encryption(encrypted_pdf, tmp_dir):
    out = os.path.join(tmp_dir, "rotated.pdf")
    rotate(encrypted_pdf, [1], 90, out)
    assert_still_protected(out)


def test_merge_keeps_encryption_when_every_input_agrees(encrypted_pdf, tmp_dir):
    out = os.path.join(tmp_dir, "merged.pdf")
    second = _write(os.path.join(tmp_dir, "locked2.pdf"))
    merge([encrypted_pdf, second], out)
    assert_still_protected(out)


def test_split_parts_keep_encryption(encrypted_pdf, tmp_dir):
    outdir = os.path.join(tmp_dir, "parts")
    result = split(encrypted_pdf, "1", outdir)
    produced = result.get("outputs") or result.get("files")
    assert produced
    for part in produced:
        assert_still_protected(part)


def test_recover_keeps_encryption(encrypted_pdf, tmp_dir):
    out = os.path.join(tmp_dir, "recovered.pdf")
    recover(encrypted_pdf, out)
    assert_still_protected(out)


def test_poster_sheets_keep_encryption(encrypted_pdf, tmp_dir):
    out = os.path.join(tmp_dir, "poster.pdf")
    impose_poster(encrypted_pdf, out, 612, 792, 1.0, 0, False, False)
    assert_still_protected(out)


def test_revision_4_survives_as_revision_4(tmp_dir):
    src = _write(os.path.join(tmp_dir, "r4.pdf"), revision=4)
    out = os.path.join(tmp_dir, "r4-repaired.pdf")
    repair(src, out)
    assert_still_protected(out, revision=4)


# ── refused ───────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "run",
    [
        pytest.param(lambda src, out: repair(src, out), id="repair"),
        pytest.param(lambda src, out: rotate(src, [1], 90, out), id="rotate"),
        pytest.param(lambda src, out: merge([src, src], out), id="merge"),
    ],
)
def test_owner_gated_document_refuses_rather_than_decrypting(
    owner_gated_pdf, tmp_dir, run
):
    out = os.path.join(tmp_dir, "out.pdf")
    with pytest.raises(ValueError, match="owner password"):
        run(owner_gated_pdf, out)
    assert not os.path.exists(out) or not os.path.getsize(out)


def test_merge_refuses_to_pick_one_protection(encrypted_pdf, sample_pdf, tmp_dir):
    out = os.path.join(tmp_dir, "mixed.pdf")
    with pytest.raises(ValueError, match="protection"):
        merge([encrypted_pdf, sample_pdf], out)


def test_renderer_backed_rewrites_refuse(encrypted_pdf, tmp_dir):
    for op, name in ((rebuild, "rebuilt"), (compress, "compressed"), (grayscale, "gray")):
        out = os.path.join(tmp_dir, f"{name}.pdf")
        with pytest.raises(ValueError, match="encryption"):
            op(encrypted_pdf, out)


# The prepress conversions are renderer-backed rewrites too: Ghostscript reads
# the document and writes a new one, and it accepts an empty-user-password
# source without a word, so both once returned an unprotected copy of a
# protected document. The refusal runs before the profile is resolved, so
# neither Ghostscript nor the bundled profiles are needed to prove it.
@pytest.mark.parametrize(
    "run",
    [
        pytest.param(lambda src, out: convert_cmyk(src, out), id="convert_cmyk"),
        pytest.param(lambda src, out: convert_pdfx(src, out), id="convert_pdfx"),
    ],
)
def test_prepress_conversions_refuse(encrypted_pdf, tmp_dir, run):
    out = os.path.join(tmp_dir, "prepress.pdf")
    with pytest.raises(ValueError, match="encryption"):
        run(encrypted_pdf, out)
    assert not os.path.exists(out) or not os.path.getsize(out)


# ── the consent hatch ─────────────────────────────────────────────────────
#
# The three renderer-backed ops cannot carry the source's protection by
# construction, so the panel names that consequence and offers to proceed.
# `drop_encryption` is what the answer reaches; it is the ONLY thing that
# turns the refusal above into an unprotected output, and it reaches only the
# case the operation can actually perform.


@pytest.mark.parametrize(
    "op,size_key",
    [
        pytest.param(rebuild, "rebuilt_size", id="rebuild"),
        pytest.param(compress, "compressed_size", id="compress"),
        pytest.param(grayscale, "output_size", id="grayscale"),
    ],
)
def test_consent_writes_an_unprotected_copy(
    encrypted_pdf, tmp_dir, gs_path, op, size_key
):
    out = os.path.join(tmp_dir, "consented.pdf")
    result = op(encrypted_pdf, out, gs_path=gs_path, drop_encryption=True)
    assert result["encryption_removed"] is True
    assert result[size_key] > 0
    assert_decrypted(out)


def test_consent_does_not_reach_an_owner_gated_document(
    owner_gated_pdf, tmp_dir, gs_path
):
    for op, name in ((rebuild, "rebuilt"), (compress, "compressed"), (grayscale, "gray")):
        out = os.path.join(tmp_dir, f"{name}.pdf")
        with pytest.raises(ValueError, match="owner password"):
            op(owner_gated_pdf, out, gs_path=gs_path, drop_encryption=True)
        assert not os.path.exists(out) or not os.path.getsize(out)


@pytest.mark.parametrize(
    "op", [pytest.param(convert_cmyk, id="convert_cmyk"),
           pytest.param(convert_pdfx, id="convert_pdfx")]
)
def test_prepress_consent_writes_an_unprotected_copy(
    encrypted_pdf, tmp_dir, gs_path, icc_dir, op
):
    out = os.path.join(tmp_dir, "consented-prepress.pdf")
    result = op(encrypted_pdf, out, gs_path=gs_path, icc_dir=icc_dir,
                drop_encryption=True)
    assert result["encryption_removed"] is True
    assert result["output_size"] > 0
    assert_decrypted(out)


@pytest.mark.parametrize(
    "op", [pytest.param(convert_cmyk, id="convert_cmyk"),
           pytest.param(convert_pdfx, id="convert_pdfx")]
)
def test_prepress_consent_does_not_reach_an_owner_gated_document(
    owner_gated_pdf, tmp_dir, gs_path, icc_dir, op
):
    out = os.path.join(tmp_dir, "owner-gated-prepress.pdf")
    with pytest.raises(ValueError, match="owner password"):
        op(owner_gated_pdf, out, gs_path=gs_path, icc_dir=icc_dir,
           drop_encryption=True)
    assert not os.path.exists(out) or not os.path.getsize(out)


def test_prepress_unencrypted_input_reports_no_removal(
    sample_pdf, tmp_dir, gs_path, icc_dir
):
    out = os.path.join(tmp_dir, "plain-cmyk.pdf")
    result = convert_cmyk(sample_pdf, out, gs_path=gs_path, icc_dir=icc_dir)
    assert result["encryption_removed"] is False


def test_unencrypted_input_reports_no_removal(sample_pdf, tmp_dir, gs_path):
    out = os.path.join(tmp_dir, "plain-rebuilt.pdf")
    assert rebuild(sample_pdf, out, gs_path=gs_path)["encryption_removed"] is False


# ── deliberately unprotected ──────────────────────────────────────────────


def test_decrypt_still_decrypts(encrypted_pdf, tmp_dir):
    out = os.path.join(tmp_dir, "plain.pdf")
    decrypt(encrypted_pdf, out)
    assert_decrypted(out)


def test_unlock_still_decrypts(owner_gated_pdf):
    unlock(owner_gated_pdf, "secret")
    assert_decrypted(owner_gated_pdf)


def test_unencrypted_input_stays_unencrypted(sample_pdf, tmp_dir):
    out = os.path.join(tmp_dir, "plain-repair.pdf")
    repair(sample_pdf, out)
    assert_decrypted(out)


# ── The save seam is the only door ────────────────────────────────────────


def _pikepdf_saves(path):
    """Every `X.save(...)` in `path` whose receiver is a pikepdf document.

    Read from the SOURCE rather than from a list kept beside it: a list can go
    stale the moment someone adds a write, and this cannot.
    """
    import ast

    tree = ast.parse(path.read_text(encoding="utf-8"))
    constructors = {
        "pikepdf.open", "pikepdf.new",
        "pikepdf.Pdf.open", "pikepdf.Pdf.new",
        "Pdf.open", "Pdf.new",
    }
    found = set()
    for scope in ast.walk(tree):
        if not isinstance(scope, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        documents = set()
        for node in ast.walk(scope):
            if isinstance(node, ast.withitem):
                call = node.context_expr
                if (isinstance(call, ast.Call)
                        and ast.unparse(call.func) in constructors
                        and isinstance(node.optional_vars, ast.Name)):
                    documents.add(node.optional_vars.id)
            elif (isinstance(node, ast.Assign)
                    and isinstance(node.value, ast.Call)
                    and ast.unparse(node.value.func) in constructors):
                documents.update(
                    t.id for t in node.targets if isinstance(t, ast.Name)
                )
        for node in ast.walk(scope):
            if (isinstance(node, ast.Call)
                    and isinstance(node.func, ast.Attribute)
                    and node.func.attr == "save"
                    and isinstance(node.func.value, ast.Name)
                    and node.func.value.id in documents):
                found.add((path.name, scope.name, node.func.value.id))
    return found


# Each row writes an artifact that is NOT the user's document: a scratch file
# staged for the renderer, a new document built from nothing, or a rewrite of
# what the renderer just produced. Nothing else may write a PDF without going
# through `save_pdf`, which is where an encrypted source's protection is put
# back.
DIRECT_SAVE_ALLOWED = {
    # A new document built object by object; it has no source to carry.
    ("object_inspector.py", "_isolation_pdf", "out"),
    # Scratch input staged for Ghostscript, consumed and deleted.
    ("prepress.py", "_stage_carve_out", "pdf"),
    ("widget_faces.py", "regenerate_appearances_file", "pdf"),
    ("widget_faces.py", "stage_appearances_file", "pdf"),
    ("widget_faces.py", "harvest_appearances", "src"),
    # An extracted single page staged for the profile conversion.
    ("separations.py", "_carry_off_configuration", "pdf"),
    # A rewrite of the renderer's own output, which the renderer produced
    # unencrypted by construction.
    ("prepress.py", "_restore_carve_out", "converted"),
    ("prepress.py", "_rebase_appearances", "pdf"),
    ("widget_faces.py", "harvest_appearances", "converted"),
}


def test_no_engine_module_saves_a_document_outside_the_save_seam():
    """`Pdf.save` writes a DECRYPTED copy of an encrypted document — qpdf
    decrypts on open, and only `pdf_save.save_pdf` puts the protection back.
    A new direct save is either whitelisted here with its reason or it is a
    document silently losing its encryption."""
    import pathlib

    engine = pathlib.Path(__file__).resolve().parents[1] / "src" / "engine"
    found = set()
    for module in sorted(engine.glob("*.py")):
        if module.name == "pdf_save.py":
            continue  # the seam itself
        found |= _pikepdf_saves(module)
    assert found - DIRECT_SAVE_ALLOWED == set()
    # And the whitelist does not outlive the sites it names.
    assert DIRECT_SAVE_ALLOWED - found == set()
