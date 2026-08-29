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
from engine.inspect import unlock
from engine.merge import merge
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
    for op, name in ((rebuild, "rebuilt"), (compress, "compressed")):
        out = os.path.join(tmp_dir, f"{name}.pdf")
        with pytest.raises(ValueError, match="encryption"):
            op(encrypted_pdf, out)


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
