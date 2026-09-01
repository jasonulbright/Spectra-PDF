"""A whole-file rewrite of an encrypted document keeps its encryption.

qpdf decrypts on open and hands the caller a plain object graph, so a rewrite
that does not put the encryption back writes an unprotected copy of a
protected document — the permission bits the author set are gone from the
output and nothing says so. These tests pin both halves of the answer: the
rewrite preserves what it can, and refuses where it cannot.
"""

import io
import os
import re

import pikepdf
import pytest

from engine.compress import compress
from engine.encrypt import decrypt
from engine.grayscale import grayscale
from engine.inspect import unlock
from engine.merge import merge
from engine.pdf_save import (
    _descriptor,
    _effective_encrypt_metadata,
    encryption_profile,
    source_encryption,
)
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


def _write_metadata_policy(path, *, metadata: bool):
    """An R4 document carrying metadata, encrypted under the given policy."""
    pdf = pikepdf.new()
    pdf.add_blank_page(page_size=(612, 792))
    pdf.Root["/Metadata"] = pdf.make_stream(b"<x:xmpmeta xmlns:x='adobe:ns:meta/'/>")
    pdf.save(
        str(path),
        encryption=pikepdf.Encryption(
            owner="", user="", R=4, aes=True, allow=LOCKED, metadata=metadata
        ),
    )
    pdf.close()
    return str(path)


def _encrypt_metadata_of(path) -> bool:
    with pikepdf.open(str(path)) as pdf:
        return bool(pdf.trailer.Encrypt.get("/EncryptMetadata", True))


@pytest.mark.parametrize("policy", [True, False])
def test_merge_keeps_a_shared_metadata_policy(policy, tmp_dir):
    first = _write_metadata_policy(os.path.join(tmp_dir, f"m1-{policy}.pdf"), metadata=policy)
    second = _write_metadata_policy(os.path.join(tmp_dir, f"m2-{policy}.pdf"), metadata=policy)
    out = os.path.join(tmp_dir, f"m-out-{policy}.pdf")
    merge([first, second], out)
    assert_still_protected(out, revision=4)
    assert _encrypt_metadata_of(out) is policy


@pytest.mark.parametrize("order", ["clear-first", "encrypted-first"])
def test_merge_refuses_mixed_metadata_policies_in_either_order(order, tmp_dir):
    """Two documents identical but for whether their metadata is encrypted.
    Adopting either policy exposes or conceals metadata the other document's
    author decided about, and which one wins would be source order."""
    clear = _write_metadata_policy(os.path.join(tmp_dir, "clear.pdf"), metadata=False)
    sealed = _write_metadata_policy(os.path.join(tmp_dir, "sealed.pdf"), metadata=True)
    files = [clear, sealed] if order == "clear-first" else [sealed, clear]
    out = os.path.join(tmp_dir, f"mixed-{order}.pdf")
    with pytest.raises(ValueError, match="protection"):
        merge(files, out)
    assert not os.path.exists(out) or not os.path.getsize(out)


@pytest.mark.parametrize(
    "revision,entry,expected",
    [
        pytest.param(2, None, False, id="r2-has-no-switch"),
        pytest.param(3, None, False, id="r3-has-no-switch"),
        pytest.param(4, None, True, id="r4-absent-means-encrypted"),
        pytest.param(4, True, True, id="r4-stated-true"),
        pytest.param(4, False, False, id="r4-stated-false"),
        pytest.param(6, None, True, id="r6-absent-means-encrypted"),
        pytest.param(6, False, False, id="r6-stated-false"),
    ],
)
def test_the_effective_metadata_policy_defaults_to_encrypted_from_revision_4(
    revision, entry, expected
):
    """/EncryptMetadata is optional from R4 and its absence means the metadata
    IS encrypted, so a document that omits it and one that states True carry
    the same policy and must not refuse each other. R2/R3 have no switch."""
    enc = pikepdf.Dictionary() if entry is None else pikepdf.Dictionary(EncryptMetadata=entry)
    assert _effective_encrypt_metadata(enc, revision) is expected


_PERMISSION_NAMES = [
    "accessibility",
    "extract",
    "modify_annotation",
    "modify_assembly",
    "modify_form",
    "modify_other",
    "print_lowres",
    "print_highres",
]


def _permissions(**overrides):
    values = {name: True for name in _PERMISSION_NAMES}
    values.update(overrides)
    return pikepdf.Permissions(**values)


def _write_variant(path, *, revision=4, aes=True, metadata=True, allow=None):
    pdf = pikepdf.new()
    pdf.add_blank_page(page_size=(612, 792))
    pdf.Root["/Metadata"] = pdf.make_stream(b"<x:xmpmeta xmlns:x='adobe:ns:meta/'/>")
    pdf.save(
        str(path),
        encryption=pikepdf.Encryption(
            owner="",
            user="",
            R=revision,
            aes=aes,
            metadata=metadata,
            allow=_permissions() if allow is None else allow,
        ),
    )
    pdf.close()
    return str(path)


# Each pair differs in exactly one characteristic that `source_encryption`
# puts back. RC4 cannot leave metadata unencrypted, so the stream-method pair
# holds `metadata=False` on both sides rather than varying two things at once.
_VARIANTS = [
    pytest.param({"revision": 4}, {"revision": 6}, id="revision"),
    pytest.param(
        {"aes": True, "metadata": False}, {"aes": False, "metadata": False}, id="stream-method"
    ),
    pytest.param({"metadata": True}, {"metadata": False}, id="encrypt-metadata"),
    *(
        pytest.param({}, {"allow": _permissions(**{name: False})}, id=f"permission-{name}")
        for name in _PERMISSION_NAMES
    ),
]


def _recreated(pdf):
    """The protection `source_encryption` would write back, as a comparable."""
    enc = source_encryption(pdf)
    return (
        enc.R,
        enc.aes,
        enc.metadata,
        tuple(bool(getattr(enc.allow, name)) for name in _PERMISSION_NAMES),
    )


@pytest.mark.parametrize("base_kwargs,other_kwargs", _VARIANTS)
def test_every_characteristic_the_rewrite_recreates_separates_two_profiles(
    base_kwargs, other_kwargs, tmp_dir, request
):
    """`encryption_profile` decides whether two sources may share one output
    encryption, so everything `source_encryption` puts back has to separate
    them - a recreated characteristic left out of the comparison is taken
    from whichever source came first.

    Some permission bits qpdf normalizes away (a document cannot forbid
    low-resolution printing while allowing high, and from R4 the accessibility
    bit is not stored). Where the two documents came back carrying the same
    permissions, there is no characteristic to separate and nothing to
    compare; the profiles are then required to AGREE.
    """
    label = "".join(c if c.isalnum() else "-" for c in request.node.name)
    base = _write_variant(os.path.join(tmp_dir, f"base-{label}.pdf"), **base_kwargs)
    other = _write_variant(os.path.join(tmp_dir, f"other-{label}.pdf"), **other_kwargs)
    with pikepdf.open(base) as a, pikepdf.open(other) as b:
        assert source_encryption(a) is not None
        assert encryption_profile(a) == encryption_profile(a)
        # The oracle is the RECREATION, not a second reading of the source.
        # Re-deriving "what differs" here once re-implemented the very bug the
        # profile had (both read only the stream cipher), so the two agreed on
        # a document they were both wrong about. What the profile owes is that
        # it separates exactly the sources the rewrite would protect
        # differently, so ask the rewrite.
        differs = _recreated(a) != _recreated(b)
        if differs:
            assert encryption_profile(a) != encryption_profile(b)
        else:
            assert encryption_profile(a) == encryption_profile(b)


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


# ── crypt filters that differ per data class ──────────────────────────────
#
# ISO 32000-2 Table 20: from /V 4 an encryption dictionary names a crypt
# filter per data class — /StmF for streams, /StrF for strings, /EFF for
# embedded file streams (absent /EFF follows /StmF). Each may name a
# DIFFERENT filter, so one document can hold AES strings beside unencrypted
# streams. `pikepdf.Encryption` has one `aes` flag and writes all three the
# same, so a rewrite that reduced the source to one cipher silently rewrote
# the other two — including AES down to RC4, through the seam almost every
# engine operation saves through.
#
# pikepdf cannot WRITE such a document, so the fixtures below patch the
# encryption dictionary after the fact. /CF, /StmF, /StrF and /EFF take no
# part in the file encryption key (7.6.3.2 derives it from /O, /U, /P, the
# file identifier and /EncryptMetadata), so an equal-length substitution
# leaves the document openable with the same empty password. Where bytes are
# added, the encryption dictionary is the last object in the file, so only
# the `startxref` offset moves.


def _encrypted_bytes(**kwargs) -> bytes:
    pdf = pikepdf.new()
    pdf.add_blank_page(page_size=(612, 792))
    out = io.BytesIO()
    pdf.save(out, encryption=pikepdf.Encryption(owner="", user="", allow=LOCKED, **kwargs))
    pdf.close()
    return out.getvalue()


def _substitute(data: bytes, old: bytes, new: bytes) -> bytes:
    assert len(old) == len(new), "the substitution must not move any offset"
    assert data.count(old) == 1, f"{old!r} is not a unique anchor"
    return data.replace(old, new)


def _add_to_encrypt_dict(data: bytes, entry: bytes) -> bytes:
    start = data.index(b"/Filter /Standard")
    end = data.index(b" >>\nendobj", start)
    grown = data[:end] + b" " + entry + data[end:]
    offset = re.search(rb"startxref\n(\d+)\n", grown)
    moved = str(int(offset.group(1)) + len(entry) + 1).encode()
    return grown[: offset.start(1)] + moved + grown[offset.end(1) :]


def _write_bytes(path, data: bytes) -> str:
    with open(path, "wb") as handle:
        handle.write(data)
    return str(path)


_STANDARD_FILTERS = b"/StmF /StdCF /StrF /StdCF"

# Streams pass through unencrypted while strings are AES (the shape the
# downgrade probe caught, where the rewrite wrote RC4 over both), and the
# other direction, which no single-cipher reading tells from plain AES.
_MIXED = {
    "streams-clear": b"/StmF/Identity/StrF/StdCF",
    "strings-clear": b"/StmF/StdCF/StrF/Identity",
}


def _mixed_filter_pdf(path, direction: str) -> str:
    data = _encrypted_bytes(R=4, aes=True, metadata=False)
    return _write_bytes(path, _substitute(data, _STANDARD_FILTERS, _MIXED[direction]))


def _embedded_files_clear_pdf(path) -> str:
    """Streams and strings AES, embedded file streams passed through."""
    data = _add_to_encrypt_dict(_encrypted_bytes(R=4, aes=True), b"/EFF /Identity")
    return _write_bytes(path, data)


def _rc4_with_encrypted_metadata_pdf(path) -> str:
    """R4 under RC4 with its metadata encrypted.

    Legal, and the combination pikepdf refuses to write ("Cannot encrypt
    metadata unless AES encryption is enabled"). /CFM is not part of the key
    derivation, so writing the AES form and renaming the method produces it.
    """
    data = _encrypted_bytes(R=4, aes=True, metadata=True)
    return _write_bytes(path, _substitute(data, b"/CFM /AESV2", b"/CFM /V2   "))


@pytest.mark.parametrize("direction", sorted(_MIXED))
def test_a_rewrite_refuses_a_document_whose_ciphers_differ(direction, tmp_dir):
    src = _mixed_filter_pdf(os.path.join(tmp_dir, f"mixed-{direction}.pdf"), direction)
    out = os.path.join(tmp_dir, f"mixed-{direction}-out.pdf")
    with pytest.raises(ValueError, match="different ciphers"):
        repair(src, out)
    assert not os.path.exists(out)


def test_the_source_really_did_carry_two_ciphers(tmp_dir):
    """Without this the refusal above could be passing for the wrong reason."""
    for direction, expected in (
        ("streams-clear", ("none", "aes")),
        ("strings-clear", ("aes", "none")),
    ):
        src = _mixed_filter_pdf(os.path.join(tmp_dir, f"proof-{direction}.pdf"), direction)
        with pikepdf.open(src) as pdf:
            found = (
                str(pdf.encryption.stream_method).rsplit(".", 1)[-1],
                str(pdf.encryption.string_method).rsplit(".", 1)[-1],
            )
        assert found == expected


def test_a_rewrite_refuses_when_only_embedded_files_differ(tmp_dir):
    src = _embedded_files_clear_pdf(os.path.join(tmp_dir, "eff.pdf"))
    with pikepdf.open(src) as pdf:
        assert str(pdf.encryption.stream_method).endswith("aes")
        assert str(pdf.encryption.file_method).endswith("none")
    out = os.path.join(tmp_dir, "eff-out.pdf")
    with pytest.raises(ValueError, match="different ciphers"):
        repair(src, out)
    assert not os.path.exists(out)


def test_revision_4_rc4_with_encrypted_metadata_refuses_by_name(tmp_dir):
    """pikepdf rejects that combination with a raw ValueError of its own, in
    words no catalog carries and no user asked for. The refusal has to be
    ours, and has to happen before anything is written."""
    src = _rc4_with_encrypted_metadata_pdf(os.path.join(tmp_dir, "rc4-meta.pdf"))
    out = os.path.join(tmp_dir, "rc4-meta-out.pdf")
    with pytest.raises(ValueError) as caught:
        repair(src, out)
    assert "unless AES encryption is enabled" not in str(caught.value)
    assert "cannot be kept through this operation" in str(caught.value)
    assert "metadata" in str(caught.value)
    assert not os.path.exists(out)


@pytest.mark.parametrize("direction", sorted(_MIXED))
@pytest.mark.parametrize("order", ["mixed-first", "ordinary-first"])
def test_merge_separates_a_mixed_cipher_source_in_either_order(
    direction, order, tmp_dir
):
    """The mixed source and an ordinary AES source agree on revision, key
    length, metadata policy and every permission bit — they differ only in
    which cipher reaches one data class. Comparing one cipher made them
    equal, and the merge then took whichever protection came first."""
    label = f"{direction}-{order}"
    mixed = _mixed_filter_pdf(os.path.join(tmp_dir, f"mm-{label}.pdf"), direction)
    ordinary = _write_bytes(
        os.path.join(tmp_dir, f"mo-{label}.pdf"),
        _encrypted_bytes(R=4, aes=True, metadata=False),
    )
    with pikepdf.open(mixed) as a, pikepdf.open(ordinary) as b:
        assert encryption_profile(a) != encryption_profile(b)
    files = [mixed, ordinary] if order == "mixed-first" else [ordinary, mixed]
    out = os.path.join(tmp_dir, f"m-{label}-out.pdf")
    with pytest.raises(ValueError, match="protection"):
        merge(files, out)
    assert not os.path.exists(out)


@pytest.mark.parametrize("direction", sorted(_MIXED))
def test_merge_of_agreeing_mixed_cipher_sources_still_refuses(direction, tmp_dir):
    """Agreement is not reproducibility: two sources can carry the same
    protection and it still be one the writer cannot express."""
    first = _mixed_filter_pdf(os.path.join(tmp_dir, f"ma-{direction}.pdf"), direction)
    second = _mixed_filter_pdf(os.path.join(tmp_dir, f"mb-{direction}.pdf"), direction)
    out = os.path.join(tmp_dir, f"ma-{direction}-out.pdf")
    with pytest.raises(ValueError, match="different ciphers"):
        merge([first, second], out)
    assert not os.path.exists(out)


def test_the_descriptor_is_the_profile(tmp_dir):
    """One derivation, two consumers. A second reading is what drifted."""
    src = _write_bytes(
        os.path.join(tmp_dir, "descriptor.pdf"),
        _encrypted_bytes(R=4, aes=True, metadata=False),
    )
    with pikepdf.open(src) as pdf:
        profile = encryption_profile(pdf)
        assert profile == _descriptor(pdf)
        assert profile.stream_method == "aes"
        assert profile.string_method == "aes"
        assert profile.file_method == "aes"
        assert (profile.revision, profile.version, profile.bits) == (4, 4, 128)
        assert profile.encrypt_metadata is False
