"""Renderer-written edits of a document opened with its user password.

The renderer's builder (page tier, canvas annotations, field creation) runs
on the plaintext `sealed_plaintext` hands it; `sealed_reseal` writes the
builder's output under the working copy's own protection. Each test stands in
for one builder output with the pikepdf edit it makes, and proves the edit
lands, the /Encrypt and /P are the owner's, both passwords reopen, and the
page objects the builder wrote are the ones the file holds."""

import base64
import io
import os

import pikepdf
import pytest

from engine.credentials import PERMISSIONS_HELD, close_document, open_document
from engine.sealed_edit import SealedEditMisuse, sealed_plaintext, sealed_reseal

USER = "reader-pw-5e2"
OWNER = "owner-pw-8a1"


def _allow(**overrides):
    base = dict(
        accessibility=True, extract=False, modify_annotation=True, modify_assembly=False,
        modify_form=True, modify_other=True, print_lowres=True, print_highres=False,
    )
    base.update(overrides)
    return pikepdf.Permissions(**base)


def _make(tmp_dir, allow, name="sealed.pdf", page_label="page", document_id=None):
    path = os.path.join(tmp_dir, name)
    pdf = pikepdf.new()
    for i in range(3):
        pdf.add_blank_page(page_size=(612, 792))
        pdf.pages[i].Contents = pdf.make_stream(
            f"BT /F1 12 Tf 72 700 Td ({page_label} {i + 1}) Tj ET".encode()
        )
    pdf.Root.Outlines = pdf.make_indirect(pikepdf.Dictionary(Type=pikepdf.Name.Outlines, Count=0))
    pdf.Root.StructTreeRoot = pdf.make_indirect(pikepdf.Dictionary(Type=pikepdf.Name.StructTreeRoot))
    pdf.Root.OutputIntents = pikepdf.Array([pdf.make_indirect(pikepdf.Dictionary(
        Type=pikepdf.Name.OutputIntent, S=pikepdf.Name.GTS_PDFX, OutputConditionIdentifier="CGATS TR 001"))])
    if document_id is not None:
        identifier = document_id.ljust(16, b"\0")[:16]
        pdf.trailer.ID = pikepdf.Array([pikepdf.String(identifier), pikepdf.String(identifier)])
    pdf.save(path, encryption=pikepdf.Encryption(user=USER, owner=OWNER, R=6, allow=allow))
    pdf.close()
    return path


@pytest.fixture
def sealed(tmp_dir):
    path = _make(tmp_dir, _allow(), document_id=b"sealed.pdf")
    assert open_document(path, USER)["opener"] == "user"
    yield path
    close_document(path)


def _plain(path, capability):
    return pikepdf.open(io.BytesIO(base64.b64decode(sealed_plaintext(path, capability)["data"])))


def _b64(pdf):
    out = io.BytesIO()
    pdf.save(out)
    return base64.b64encode(out.getvalue()).decode("ascii")


def _encrypt_facts(path, password):
    with pikepdf.open(path, password=password) as pdf:
        enc = pdf.trailer.Encrypt
        return int(enc.P), int(enc.R), bytes(enc.O), bytes(enc.U), pdf.owner_password_matched


def _assert_protection_kept(original_facts, output):
    user = _encrypt_facts(output, USER)
    owner = _encrypt_facts(output, OWNER)
    assert user[:4] == original_facts[:4]
    assert user[4] is False and owner[4] is True
    with pytest.raises(pikepdf.PasswordError):
        pikepdf.open(output)


def _page_objects(pdf):
    return [
        (page.obj.get("/Rotate", 0), page.MediaBox.unparse(), page.Contents.read_bytes(),
         [a.get("/Subtype") for a in page.obj.get("/Annots", [])])
        for page in pdf.pages
    ]


def test_page_tier_edit_keeps_the_protection_and_the_carries(sealed, tmp_dir):
    facts = _encrypt_facts(sealed, USER)
    built = _plain(sealed, "pageTier")
    built.pages[0].Rotate = 90
    del built.pages[1]
    built.pages.append(built.pages[0])
    expected = _page_objects(built)
    output = os.path.join(tmp_dir, "sealed.pdf.commit-tmp")
    result = sealed_reseal(sealed, _b64(built), output, "pageTier")
    assert result["pages"] == 3
    _assert_protection_kept(facts, output)
    # The staged file reopens by path through the lent credential.
    from engine.credentials import open_pdf

    with open_pdf(output) as staged:
        assert staged.is_encrypted
    with pikepdf.open(output, password=USER) as out:
        assert _page_objects(out) == expected
        assert "/StructTreeRoot" in out.Root and "/Outlines" in out.Root
        assert str(out.Root.OutputIntents[0].OutputConditionIdentifier) == "CGATS TR 001"


def test_annotation_edit_keeps_the_protection(sealed, tmp_dir):
    facts = _encrypt_facts(sealed, USER)
    built = _plain(sealed, "commentTier")
    ap = built.make_stream(b"1 0 0 RG 0 0 m 10 10 l S", BBox=[0, 0, 10, 10], Subtype=pikepdf.Name.Form)
    annot = built.make_indirect(pikepdf.Dictionary(
        Type=pikepdf.Name.Annot, Subtype=pikepdf.Name.Ink, Rect=[100, 100, 110, 110],
        Contents=pikepdf.String("a secret note"), InkList=[[100, 100, 110, 110]],
        AP=pikepdf.Dictionary(N=ap),
    ))
    built.pages[2].Annots = built.make_indirect(pikepdf.Array([annot]))
    output = os.path.join(tmp_dir, "annot.pdf")
    sealed_reseal(sealed, _b64(built), output, "commentTier")
    _assert_protection_kept(facts, output)
    raw = open(output, "rb").read()
    assert b"a secret note" not in raw
    with pikepdf.open(output, password=USER) as out:
        annot = out.pages[2].Annots[0]
        assert str(annot.Contents) == "a secret note"
        assert annot.AP.N.read_bytes() == b"1 0 0 RG 0 0 m 10 10 l S"


def test_field_creation_keeps_the_protection(sealed, tmp_dir):
    facts = _encrypt_facts(sealed, USER)
    built = _plain(sealed, ["formAuthoring"])
    widget = built.make_indirect(pikepdf.Dictionary(
        Type=pikepdf.Name.Annot, Subtype=pikepdf.Name.Widget, FT=pikepdf.Name.Tx,
        T=pikepdf.String("name"), Rect=[72, 72, 272, 92], P=built.pages[0].obj,
    ))
    built.pages[0].Annots = built.make_indirect(pikepdf.Array([widget]))
    built.Root.AcroForm = built.make_indirect(pikepdf.Dictionary(Fields=pikepdf.Array([widget])))
    output = os.path.join(tmp_dir, "form.pdf")
    sealed_reseal(sealed, _b64(built), output, ["formAuthoring"])
    _assert_protection_kept(facts, output)
    with pikepdf.open(output, password=OWNER) as out:
        field = out.Root.AcroForm.Fields[0]
        assert str(field.T) == "name"
        assert field.objgen == out.pages[0].Annots[0].objgen


def test_a_denied_permission_refuses_both_doors(tmp_dir):
    path = _make(tmp_dir, _allow(modify_annotation=False), "noannot.pdf")
    open_document(path, USER)
    try:
        with pytest.raises(PermissionError, match="held by an owner password"):
            sealed_plaintext(path, "commentTier")
        with pytest.raises(PermissionError, match="held by an owner password"):
            sealed_reseal(path, "", os.path.join(tmp_dir, "x.pdf"), "formAuthoring")
        # Page structure needs assemble or modify; modify is set here.
        assert sealed_plaintext(path, "pageTier")["data"]
    finally:
        close_document(path)
    assert PERMISSIONS_HELD.startswith("This document's permissions")


def test_page_structure_refused_without_assemble_and_modify(tmp_dir):
    path = _make(tmp_dir, _allow(modify_other=False, modify_assembly=False), "nopages.pdf")
    open_document(path, USER)
    try:
        with pytest.raises(PermissionError):
            sealed_plaintext(path, "pageTier")
    finally:
        close_document(path)


def test_a_zero_page_result_is_refused_and_nothing_written(sealed, tmp_dir):
    built = _plain(sealed, "pageTier")
    while len(built.pages):
        del built.pages[0]
    output = os.path.join(tmp_dir, "empty.pdf")
    with pytest.raises(ValueError, match="no pages"):
        sealed_reseal(sealed, _b64(built), output, "pageTier")
    assert not os.path.exists(output)


def test_doors_serve_only_user_opened_documents(tmp_dir):
    path = os.path.join(tmp_dir, "plain.pdf")
    pdf = pikepdf.new()
    pdf.add_blank_page()
    pdf.save(path)
    pdf.close()
    with pytest.raises(SealedEditMisuse):
        sealed_plaintext(path, "pageTier")
    owner = _make(tmp_dir, _allow(), "owner.pdf")
    open_document(owner, OWNER)
    try:
        with pytest.raises(SealedEditMisuse):
            sealed_plaintext(owner, "pageTier")
    finally:
        close_document(owner)


def test_doors_are_registered_and_kept_out_of_the_queue():
    import pathlib

    main = pathlib.Path(__file__).resolve().parent.parent / "src" / "engine" / "__main__.py"
    text = main.read_text(encoding="utf-8")
    assert 'server.register("sealed_plaintext", sealed_plaintext)' in text
    assert 'server.register("sealed_reseal", sealed_reseal)' in text
    _assert_sealed_doors_bypass_the_queue(main.parent.parent / "renderer")


def _strip_ts_comments(text: str) -> str:
    """Comments removed; string, template and regex-free code kept verbatim.
    Template `${}` nesting is tracked so a comment inside an interpolation
    is still removed and a quote inside one does not end the template."""
    out: list[str] = []
    i, n = 0, len(text)
    stack: list[str] = []  # "`" for template text, "{" for braces
    while i < n:
        c = text[i]
        if stack and stack[-1] == "`":
            if c == "\\":
                out.append(text[i:i + 2]); i += 2; continue
            if c == "`":
                stack.pop(); out.append(c); i += 1; continue
            if text.startswith("${", i):
                stack.append("{"); out.append("${"); i += 2; continue
            out.append(c); i += 1; continue
        if text.startswith("//", i):
            end = text.find("\n", i)
            i = n if end < 0 else end
            continue
        if text.startswith("/*", i):
            end = text.find("*/", i + 2)
            i = n if end < 0 else end + 2
            out.append(" ")
            continue
        if c in "'\"":
            j = i + 1
            while j < n and text[j] != c and text[j] != "\n":
                j += 2 if text[j] == "\\" else 1
            out.append(text[i:j + 1]); i = j + 1; continue
        if c == "`":
            stack.append("`"); out.append(c); i += 1; continue
        if c == "{" and stack:
            stack.append("{")
        elif c == "}" and stack and stack[-1] == "{":
            stack.pop()
        out.append(c); i += 1
    return "".join(out)


def test_comment_stripping_keeps_string_and_template_literals():
    source = (
        "const a = '/* not a comment */'; // gone\n"
        'const b = "http://x"; /* gone */ const c = `a // b ${d /* gone */} /* e */`;\n'
    )
    assert _strip_ts_comments(source) == (
        "const a = '/* not a comment */'; \n"
        'const b = "http://x";   const c = `a // b ${d  } /* e */`;\n'
    )


def _assert_sealed_doors_bypass_the_queue(renderer) -> None:
    import re

    engine = _strip_ts_comments((renderer / "hooks" / "useEngine.ts").read_text(encoding="utf-8"))
    raw = re.search(r"const rawCall = useCallback\((.*?)\[dispatch\]\);", engine, flags=re.S)
    assert raw, "rawCall definition not found"
    assert "dispatch(method, params, options)" in raw.group(1)
    for queued in ("track(", "runCommitGate(", "withFileLock("):
        assert queued not in raw.group(1), queued
    assert re.search(r"return \{[^}]*\bcallRaw: rawCall\b", engine)

    app = _strip_ts_comments((renderer / "App.tsx").read_text(encoding="utf-8"))
    for binding in (r"\bsealed:\s*([\w.]+)", r"\bcallStaged:\s*([\w.]+)", r"\bsetSealedReader\(\s*([\w.]+)\s*\)"):
        bound = re.findall(binding, app)
        assert bound, binding
        assert "callRaw" in bound and set(bound) <= {"callRaw", "null"}, (binding, bound)

    for path in renderer.rglob("*.ts*"):
        if path.name == "sealed-edit.ts":
            continue
        source = _strip_ts_comments(path.read_text(encoding="utf-8"))
        assert not re.search(r"""\bcall\(\s*['"]sealed_""", source), path


def test_reseal_refuses_the_working_copy_as_its_output(sealed):
    built = _plain(sealed, "pageTier")
    before = open(sealed, "rb").read()
    with pytest.raises(SealedEditMisuse):
        sealed_reseal(sealed, _b64(built), sealed, "pageTier")
    assert open(sealed, "rb").read() == before


def test_plaintext_of_given_bytes_uses_the_document_credential(sealed):
    raw = base64.b64encode(open(sealed, "rb").read()).decode("ascii")
    reply = sealed_plaintext(sealed, "commentTier", data=raw)
    with pikepdf.open(io.BytesIO(base64.b64decode(reply["data"]))) as plain:
        assert not plain.is_encrypted
        assert len(plain.pages) == 3


def test_plaintext_refuses_another_documents_bytes_even_with_the_same_password(sealed, tmp_dir):
    # The first document grants page edits; the second withholds them. A shared
    # user password must not let the first document's /P authorize the second.
    other = _make(
        tmp_dir,
        _allow(modify_other=False, modify_assembly=False),
        "restricted.pdf",
        page_label="restricted",
        document_id=b"restricted.pdf",
    )
    with pikepdf.open(sealed, password=USER) as allowed:
        with pikepdf.open(other, password=USER) as restricted:
            assert bytes(allowed.trailer.ID[0]) != bytes(restricted.trailer.ID[0])
    raw = base64.b64encode(open(other, "rb").read()).decode("ascii")

    with pytest.raises(SealedEditMisuse, match="same document"):
        sealed_plaintext(sealed, "pageTier", data=raw)


def test_plaintext_checks_the_supplied_documents_permissions_when_ids_collide(sealed, tmp_dir):
    other = _make(
        tmp_dir,
        _allow(modify_other=False, modify_assembly=False),
        "restricted.pdf",
        page_label="restricted",
        document_id=b"sealed.pdf",
    )
    raw = base64.b64encode(open(other, "rb").read()).decode("ascii")

    with pytest.raises(PermissionError, match="held by an owner password"):
        sealed_plaintext(sealed, "pageTier", data=raw)


def test_plaintext_accepts_a_resealed_stage_of_the_same_document(sealed, tmp_dir):
    built = _plain(sealed, "pageTier")
    built.pages[0].Rotate = 90
    stage = os.path.join(tmp_dir, "sealed-stage.pdf")
    sealed_reseal(sealed, _b64(built), stage, "pageTier")
    raw = base64.b64encode(open(stage, "rb").read()).decode("ascii")

    reply = sealed_plaintext(sealed, "pageTier", data=raw)
    with pikepdf.open(io.BytesIO(base64.b64decode(reply["data"]))) as plain:
        assert int(plain.pages[0].Rotate) == 90
