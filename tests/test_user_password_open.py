"""A document with distinct user and owner passwords opened with the USER
password stays encrypted (ISO 32000-2 7.6.4.1): its working copy keeps the
/Encrypt, /O, /U and /P the owner set, every later read supplies the stored
password, and removing the protection needs the owner password."""

import json
import os

import pikepdf
import pytest

from engine import credentials
from engine.compress import compress
from engine.create_pdf import create_pdf
from engine.credentials import (
    close_document,
    document_permissions,
    open_document,
    open_document_attempt,
    share_document,
)
from engine.grayscale import grayscale
from engine.inspect import get_page_count, unlock
from engine.ipc import JsonRpcServer
from engine.merge import merge
from engine.pdfa import convert_pdfa
from engine.prepress import convert_cmyk, convert_pdfx
from engine.print_layout import impose_poster
from engine.rebuild import rebuild
from engine.recover import recover
from engine.rotate import rotate
from engine.split import split

USER = "reader-pw-7c1"
OWNER = "owner-pw-9d4"

ALLOW = pikepdf.Permissions(
    accessibility=True,
    extract=False,
    modify_annotation=True,
    modify_assembly=False,
    modify_form=True,
    modify_other=True,
    print_lowres=False,
    print_highres=False,
)


def _facts(path, password):
    with pikepdf.open(path, password=password) as pdf:
        enc = pdf.trailer.Encrypt
        return {
            "P": int(enc.P),
            "R": int(enc.R),
            "O": bytes(enc.O),
            "U": bytes(enc.U),
            "owner": pdf.owner_password_matched,
        }


@pytest.fixture
def protected(tmp_dir):
    path = os.path.join(tmp_dir, "protected.pdf")
    pdf = pikepdf.new()
    for _ in range(3):
        pdf.add_blank_page(page_size=(612, 792))
    pdf.save(path, encryption=pikepdf.Encryption(user=USER, owner=OWNER, R=6, allow=ALLOW))
    pdf.close()
    yield path
    close_document(path)


@pytest.fixture
def user_opened(protected):
    result = open_document(protected, USER)
    assert result == {"encrypted": True, "opener": "user", "encryption_kept": True}
    return protected


# -- the four acceptance tests ------------------------------------------------


def test_user_password_open_keeps_the_owner_protection(protected):
    before_bytes = open(protected, "rb").read()
    before = _facts(protected, USER)
    open_document(protected, USER)
    assert open(protected, "rb").read() == before_bytes
    assert get_page_count(protected)["pages"] == 3

    rotate(protected, [1], 90, protected)
    after_user = _facts(protected, USER)
    after_owner = _facts(protected, OWNER)
    for key in ("P", "R", "O", "U"):
        assert after_user[key] == before[key]
    assert after_user["owner"] is False and after_owner["owner"] is True
    with pikepdf.open(protected, password=USER) as pdf:
        assert int(pdf.pages[0].obj.get("/Rotate", 0)) == 90
    with pytest.raises(pikepdf.PasswordError):
        pikepdf.open(protected)


def test_owner_password_open_is_unchanged(protected):
    assert open_document(protected, OWNER) == {
        "encrypted": True, "opener": "owner", "encryption_kept": False,
    }
    with pikepdf.open(protected) as pdf:
        assert not pdf.is_encrypted
    assert document_permissions(protected)["opener"] == "owner"


def test_removing_protection_needs_the_owner_password(user_opened):
    before = open(user_opened, "rb").read()
    with pytest.raises(RuntimeError, match="held by an owner password"):
        unlock(user_opened, USER)
    assert open(user_opened, "rb").read() == before
    assert unlock(user_opened, OWNER) == {"unlocked": True}
    with pikepdf.open(user_opened) as pdf:
        assert not pdf.is_encrypted
    assert document_permissions(user_opened)["opener"] == "owner"


def test_a_failed_owner_unlock_keeps_the_user_credential(user_opened, monkeypatch):
    import engine.inspect

    def refuse(path, password):
        raise OSError("disk full")

    monkeypatch.setattr(engine.inspect, "_decrypt_in_place", refuse)
    before = open(user_opened, "rb").read()
    with pytest.raises(OSError):
        unlock(user_opened, OWNER)
    assert open(user_opened, "rb").read() == before
    assert document_permissions(user_opened)["opener"] == "user"
    assert get_page_count(user_opened)["pages"] == 3


def test_wrong_password_still_reports_incorrect(protected):
    with pytest.raises(pikepdf.PasswordError):
        open_document(protected, "wrong")
    with pytest.raises(pikepdf.PasswordError):
        get_page_count(protected)


def test_open_document_attempt_returns_wrong_password_as_status(protected):
    before = open(protected, "rb").read()
    assert open_document_attempt(protected, "wrong") == {"status": "wrong_password"}
    assert open(protected, "rb").read() == before

    opened = open_document_attempt(protected, USER)
    assert opened == {
        "status": "opened",
        "document": {"encrypted": True, "opener": "user", "encryption_kept": True},
    }
    main = os.path.join(os.path.dirname(__file__), "..", "src", "engine", "__main__.py")
    registration = 'server.register("open_document_attempt", open_document_attempt)'
    assert registration in open(main, encoding="utf-8").read()


# -- the store ----------------------------------------------------------------


def test_permissions_are_decoded_for_the_user_opener(user_opened):
    info = document_permissions(user_opened)
    assert info["opener"] == "user"
    assert info["revision"] == 6
    assert info["permissions"] == {
        "print": False, "print_high": False, "modify": True, "copy": False,
        "annotate": True, "fill": True, "accessibility": True, "assemble": False,
    }


def test_close_forgets_the_password(user_opened):
    assert close_document(user_opened) == {"forgotten": True}
    with pytest.raises(pikepdf.PasswordError):
        get_page_count(user_opened)


def test_an_unknown_encrypted_path_still_needs_its_password(user_opened, tmp_dir):
    copy = os.path.join(tmp_dir, "copy.pdf")
    with open(user_opened, "rb") as src, open(copy, "wb") as dst:
        dst.write(src.read())
    with pytest.raises(pikepdf.PasswordError):
        get_page_count(copy)


def test_a_staged_copy_borrows_the_credential_and_keeps_the_protection(user_opened, tmp_dir):
    stage = os.path.join(tmp_dir, "protected.pdf.operation-stage.pdf")
    with open(user_opened, "rb") as src, open(stage, "wb") as dst:
        dst.write(src.read())
    assert share_document(user_opened, stage) == {"shared": True}
    try:
        rotate(stage, [1], 90, stage)
        assert _facts(stage, USER)["P"] == _facts(user_opened, USER)["P"]
        assert _facts(stage, OWNER)["owner"] is True
    finally:
        assert close_document(stage) == {"forgotten": True}
    with pytest.raises(pikepdf.PasswordError):
        get_page_count(stage)
    assert get_page_count(user_opened)["pages"] == 3


def test_sharing_an_unknown_document_shares_nothing(protected, tmp_dir):
    assert share_document(protected, os.path.join(tmp_dir, "alias.pdf")) == {"shared": False}


def test_a_save_to_another_path_keeps_the_protection(user_opened, tmp_dir):
    out = os.path.join(tmp_dir, "rotated.pdf")
    rotate(user_opened, [2], 90, out)
    assert _facts(out, USER)["P"] == _facts(user_opened, USER)["P"]
    assert _facts(out, OWNER)["owner"] is True


def test_no_response_payload_carries_a_password(protected):
    server = JsonRpcServer()
    for name, handler in (("open_document", open_document),
                          ("open_document_attempt", open_document_attempt),
                          ("document_permissions", document_permissions),
                          ("close_document", close_document),
                          ("share_document", share_document),
                          ("unlock", unlock),
                          ("get_page_count", get_page_count)):
        server.register(name, handler)
    requests = [
        ("open_document", {"path": protected, "password": "wrong"}),
        ("open_document", {"path": protected, "password": USER}),
        ("open_document_attempt", {"path": protected, "password": "wrong"}),
        ("open_document_attempt", {"path": protected, "password": USER}),
        ("document_permissions", {"path": protected}),
        ("get_page_count", {"file": protected}),
        ("share_document", {"path": protected, "alias": protected + ".stage.pdf"}),
        ("close_document", {"path": protected + ".stage.pdf"}),
        ("unlock", {"file": protected, "password": USER}),
        ("close_document", {"path": protected}),
        ("open_document", {"path": protected, "password": OWNER}),
        ("document_permissions", {"path": protected}),
    ]
    for index, (method, params) in enumerate(requests):
        line = json.dumps(server._handle({"jsonrpc": "2.0", "id": index,
                                          "method": method, "params": params}))
        assert USER not in line and OWNER not in line, (method, line)
    assert USER not in repr(credentials._documents)
    assert OWNER not in repr(credentials._documents)


# -- doors that build a new document refuse by name ---------------------------


REFUSING_DOORS = [
    pytest.param(lambda src, out, d: merge([src, src], out), id="merge"),
    pytest.param(lambda src, out, d: split(src, "1,2-3", d), id="split"),
    pytest.param(lambda src, out, d: recover(src, out), id="recover"),
    pytest.param(lambda src, out, d: impose_poster(src, out, 612, 792, 1.0, 0, False, False),
                 id="impose_poster"),
    pytest.param(lambda src, out, d: rebuild(src, out, drop_encryption=True), id="rebuild"),
    pytest.param(lambda src, out, d: compress(src, out, drop_encryption=True), id="compress"),
    pytest.param(lambda src, out, d: grayscale(src, out, drop_encryption=True), id="grayscale"),
    pytest.param(lambda src, out, d: convert_cmyk(src, out, drop_encryption=True),
                 id="convert_cmyk"),
    pytest.param(lambda src, out, d: convert_pdfx(src, out, drop_encryption=True),
                 id="convert_pdfx"),
    pytest.param(lambda src, out, d: create_pdf([{"path": src, "pages": "1"}], out),
                 id="create_pdf_range"),
    pytest.param(lambda src, out, d: create_pdf([{"path": src}], out), id="create_pdf"),
    pytest.param(lambda src, out, d: convert_pdfa(src, out), id="convert_pdfa"),
]


@pytest.mark.parametrize("run", REFUSING_DOORS)
def test_a_new_document_from_a_user_opened_source_refuses(user_opened, tmp_dir, run):
    out_dir = os.path.join(tmp_dir, "out")
    os.makedirs(out_dir)
    out = os.path.join(out_dir, "out.pdf")
    with pytest.raises(ValueError, match="held by an owner password"):
        run(user_opened, out, out_dir)
    assert [n for n in os.listdir(out_dir) if os.path.getsize(os.path.join(out_dir, n))] == []



def test_pdfa_conversion_refuses_an_owner_gated_document_that_opens_without_a_password(tmp_dir):
    path = os.path.join(tmp_dir, "gated.pdf")
    pdf = pikepdf.new()
    pdf.add_blank_page(page_size=(612, 792))
    pdf.save(path, encryption=pikepdf.Encryption(user="", owner=OWNER, R=6, allow=ALLOW))
    pdf.close()
    out = os.path.join(tmp_dir, "pdfa.pdf")
    with pytest.raises(ValueError, match="held by an owner password"):
        convert_pdfa(path, out)
    assert not os.path.exists(out)


# -- doors that read a user-opened copy with the stored password --------------


TEXT_CONTENT = (b"BT /F1 24 Tf 72 700 Td (Hello reader) Tj ET "
                b"q /GS0 gs 1 0 0 rg 100 100 200 200 re f Q")


def _allow(**granted):
    names = ("accessibility", "extract", "modify_annotation", "modify_assembly",
             "modify_form", "modify_other", "print_lowres", "print_highres")
    return pikepdf.Permissions(**{n: granted.get(n, False) for n in names})


def _text_protected(folder, name, allow, password=USER):
    """A one-page document with text and a half-transparent fill, protected
    with `password` as its user password and opened with it."""
    path = os.path.join(folder, name)
    pdf = pikepdf.new()
    page = pdf.add_blank_page(page_size=(612, 792))
    font = pdf.make_indirect(pikepdf.Dictionary(
        Type=pikepdf.Name.Font, Subtype=pikepdf.Name.Type1, BaseFont=pikepdf.Name.Helvetica))
    page.Resources = pikepdf.Dictionary(
        Font=pikepdf.Dictionary(F1=font),
        ExtGState=pikepdf.Dictionary(GS0=pikepdf.Dictionary(ca=0.5, CA=0.5)))
    page.Contents = pdf.make_stream(TEXT_CONTENT)
    pdf.save(path, encryption=pikepdf.Encryption(user=password, owner=OWNER, R=6, allow=allow))
    pdf.close()
    assert open_document(path, password)["opener"] == "user"
    return path


@pytest.fixture
def readable(tmp_dir):
    path = _text_protected(tmp_dir, "readable.pdf",
                           _allow(extract=True, print_lowres=True, print_highres=True))
    yield path
    close_document(path)


@pytest.fixture
def copy_denied(tmp_dir):
    path = _text_protected(tmp_dir, "denied.pdf", _allow())
    yield path
    close_document(path)


def test_pdfminer_extracts_a_user_opened_copy(readable):
    from engine.extract_text import extract_text

    assert "Hello reader" in extract_text(readable)["text"]


def _extraction_doors(folder):
    from engine.extract_text import extract_text
    from engine.image_export import export_images
    from engine.office_export import export_document
    from engine.page_images import extract_page_image
    from engine.trapping import export_postscript

    out = lambda name: os.path.join(folder, name)
    return [
        lambda src: extract_text(src),
        lambda src: extract_text(src, "all", out("t.txt")),
        lambda src: export_document(src, out("e.txt"), "txt"),
        lambda src: export_images(src, out("i.png"), "png", 72, gs_path="gs-not-reached"),
        lambda src: extract_page_image(src, 1, 0, out("x")),
        lambda src: export_postscript(src, out("p.ps"), "gs-not-reached"),
    ]


@pytest.mark.parametrize("door", range(6))
@pytest.mark.parametrize("opened", [True, False])
def test_extraction_refuses_when_copy_is_denied(tmp_dir, door, opened):
    """Table 22 bit 5, for a user-password open and for a document read
    headless with the empty user password (CLI, folder export)."""
    user = USER if opened else ""
    path = _text_protected(tmp_dir, "denied.pdf", _allow(print_lowres=True, print_highres=True), password=user)
    if not opened:
        close_document(path)
    folder = os.path.join(tmp_dir, "out")
    os.makedirs(folder)
    try:
        with pytest.raises(PermissionError, match="held by an owner password"):
            _extraction_doors(folder)[door](path)
        assert os.listdir(folder) == []
    finally:
        close_document(path)


def test_extraction_follows_the_copy_permission(readable):
    from engine.extract_text import extract_text

    credentials.require_permission(readable, "copy")
    assert "Hello reader" in extract_text(readable)["text"]


def test_xfdf_export_refuses_when_copy_is_denied(tmp_dir):
    from engine.xfdf import export_xfdf

    source = os.path.join(tmp_dir, "comments.pdf")
    output = os.path.join(tmp_dir, "comments.xfdf")
    pdf = pikepdf.new()
    page = pdf.add_blank_page()
    annotation = pdf.make_indirect(pikepdf.Dictionary(
        Type=pikepdf.Name.Annot,
        Subtype=pikepdf.Name.Text,
        Rect=pikepdf.Array([10, 10, 30, 30]),
        Contents=pikepdf.String("private review note"),
    ))
    page.obj["/Annots"] = pdf.make_indirect(pikepdf.Array([annotation]))
    pdf.save(source, encryption=pikepdf.Encryption(
        user=USER, owner=OWNER, R=6, allow=_allow()))
    pdf.close()
    assert open_document(source, USER)["opener"] == "user"
    try:
        with pytest.raises(PermissionError, match="held by an owner password"):
            export_xfdf(source, output)
        assert not os.path.exists(output)
    finally:
        close_document(source)


def test_every_pdfminer_door_reads_a_user_opened_copy(readable, tmp_dir):
    from engine.compare import compare_text
    from engine.search_in_files import search_in_files
    from engine.text_export import export_text

    out = os.path.join(tmp_dir, "text.txt")
    export_text(readable, out)
    with open(out, encoding="utf-8") as handle:
        assert "Hello reader" in handle.read()
    rows = compare_text(readable, readable)["rows"]
    assert any("Hello reader" in row.get("text", "") for row in rows)
    found = search_in_files([readable], "reader")
    assert found["hits"] and not found["errors"]


def test_without_the_credential_pdfminer_still_refuses(readable, tmp_dir):
    from pdfminer.pdfdocument import PDFPasswordIncorrect

    from engine.extract_text import extract_text

    copy = os.path.join(tmp_dir, "unlent.pdf")
    with open(readable, "rb") as src, open(copy, "wb") as dst:
        dst.write(src.read())
    with pytest.raises(PDFPasswordIncorrect):
        extract_text(copy)


def test_health_reports_on_a_user_opened_copy(readable, tmp_dir):
    from engine.document_health import document_health

    assert document_health(readable)["status"] == "collected"
    scratch = os.path.join(tmp_dir, "health-scratch.pdf")
    with open(readable, "rb") as src, open(scratch, "wb") as dst:
        dst.write(src.read())
    report = document_health(scratch, password=USER)
    assert report["status"] == "collected"
    assert not [f for f in report["facts"] if f.get("code") == "document.encrypted"]


def test_a_saved_scratch_copy_borrows_the_credential_until_the_original_closes(readable, tmp_dir):
    from engine.pdf_save import save_pdf

    scratch = os.path.join(tmp_dir, "scratch.pdf")
    with credentials.open_pdf(readable) as pdf:
        save_pdf(pdf, scratch)
    assert get_page_count(scratch)["pages"] == 1
    close_document(readable)
    with pytest.raises(pikepdf.PasswordError):
        get_page_count(scratch)


def test_a_byte_copy_and_a_lent_copy_read_with_the_credential(readable, tmp_dir):
    copied = os.path.join(tmp_dir, "copied.pdf")
    credentials.copy_document(readable, copied)
    assert get_page_count(copied)["pages"] == 1
    close_document(copied)
    with pytest.raises(pikepdf.PasswordError):
        get_page_count(copied)
    with credentials.lent(readable, copied):
        assert get_page_count(copied)["pages"] == 1
    with pytest.raises(pikepdf.PasswordError):
        get_page_count(copied)


def test_a_version_copy_of_a_user_opened_document_reads_back(readable, tmp_dir):
    from engine.reversion import set_pdf_version

    out = os.path.join(tmp_dir, "same-version.pdf")
    with credentials.open_pdf(readable) as pdf:
        current = str(pdf.pdf_version)
    set_pdf_version(readable, out, current)
    assert _facts(out, OWNER)["owner"] is True


def test_signing_a_user_opened_document_keeps_the_protection(tmp_dir):
    from test_pades import _build_pki

    from engine.signatures import sign_pdf, verify_signatures

    path = _text_protected(tmp_dir, "sign.pdf", _allow(modify_form=True, modify_annotation=True))
    try:
        pki = _build_pki(tmp_dir)
        signed = sign_pdf(path, path, pfx_path=pki["pfx"], password="pw", allow_in_place=True)
        assert signed["valid"] and signed["intact"]
        assert verify_signatures(path)["signature_count"] == 1
        assert _facts(path, OWNER)["owner"] is True
    finally:
        close_document(path)


def test_a_comment_summary_of_a_user_opened_document_refuses(tmp_dir):
    from engine.comment_summary import summarize_comments
    from engine.pdf_save import save_pdf

    path = _text_protected(tmp_dir, "comments.pdf", _allow(extract=True))
    try:
        staged = path + ".tmp"
        with credentials.open_pdf(path) as pdf:
            note = pdf.make_indirect(pikepdf.Dictionary(
                Type=pikepdf.Name.Annot, Subtype=pikepdf.Name.Text,
                Rect=[72, 72, 92, 92], Contents=pikepdf.String("note")))
            pdf.pages[0].Annots = pdf.make_indirect(pikepdf.Array([note]))
            save_pdf(pdf, staged)
        os.replace(staged, path)
        out = os.path.join(tmp_dir, "summary.pdf")
        with pytest.raises(ValueError, match="held by an owner password"):
            summarize_comments(path, out)
        assert not os.path.exists(out)
    finally:
        close_document(path)


# -- Ghostscript --------------------------------------------------------------


@pytest.mark.parametrize("password", [
    "reader-pw", "a b", 'q"x', '"lead', "a\\b", "a\\", "a\\\\", 'a\\"b', "t\tx",
    "#hash", "it's", "per%cent", "ünï€", " lead", "trail ", "@at", "-dx",
])
def test_the_argfile_line_round_trips_through_ghostscript(gs_path, tmp_dir, password):
    import subprocess

    from engine.credentials import gs_password_argv

    path = os.path.join(tmp_dir, "gs-pw.pdf")
    pdf = pikepdf.new()
    pdf.add_blank_page(page_size=(72, 72))
    pdf.save(path, encryption=pikepdf.Encryption(user=password, owner=OWNER, R=6))
    pdf.close()
    open_document(path, password)
    try:
        out = os.path.join(tmp_dir, "gs-pw.png")
        cmd = [gs_path, "-q", "-dNOPAUSE", "-dBATCH", "-dSAFER", "-sDEVICE=png16m",
               "-r10", f"-sOutputFile={out}", path]
        with gs_password_argv(cmd, path) as argv:
            subprocess.run(argv, capture_output=True, stdin=subprocess.DEVNULL, check=False)
        assert os.path.isfile(out)
    finally:
        close_document(path)


@pytest.mark.parametrize("password", ["a b\\", '"x\\', 'q\\"x\\', "line\nbreak"])
def test_a_password_with_no_argfile_spelling_refuses_by_name(password):
    from engine.credentials import GhostscriptPasswordUnsupported, gs_password_line

    with pytest.raises(GhostscriptPasswordUnsupported, match="cannot be handed to Ghostscript"):
        gs_password_line(password)


def _spy_subprocess(monkeypatch):
    """Record every argv handed to `subprocess.run` / `Popen` while still
    running the real process, and check each argument file while it exists."""
    import subprocess

    seen: list[list[str]] = []
    real_run, real_popen = subprocess.run, subprocess.Popen

    def run(args, *a, **k):
        seen.append([str(x) for x in args])
        for arg in seen[-1]:
            if arg.startswith("@"):
                with open(arg[1:], encoding="utf-8") as handle:
                    assert USER in handle.read()
        return real_run(args, *a, **k)

    class Popen(real_popen):
        def __init__(self, args, *a, **k):
            seen.append([str(x) for x in args])
            super().__init__(args, *a, **k)

    monkeypatch.setattr(subprocess, "run", run)
    monkeypatch.setattr(subprocess, "Popen", Popen)
    return seen


def _assert_no_password_in(seen):
    assert seen
    for argv in seen:
        assert not any(USER in arg for arg in argv), argv
        for arg in argv:
            if arg.startswith("@"):
                assert not os.path.exists(arg[1:]), "the argument file outlives the run"


def test_gs_doors_read_a_user_opened_copy_without_the_password_in_argv(
        readable, tmp_dir, gs_path, monkeypatch):
    from engine.flattener import flatten_transparency
    from engine.image_export import export_images
    from engine.object_inspector import inspect_point
    from engine.separations import render_separations

    seen = _spy_subprocess(monkeypatch)
    images = export_images(readable, os.path.join(tmp_dir, "img.png"), dpi=36, gs_path=gs_path)
    assert images["outputs"] and all(os.path.getsize(p) for p in images["outputs"])
    plates = render_separations(readable, page=1, dpi=72, gs_path=gs_path, reuse=False)
    assert plates["plates"]
    point = inspect_point(readable, page=1, x=150, y=150, plates=plates["plates"],
                          plates_dir=plates["dir"], gs_path=gs_path)
    assert point["objects"]
    flat = os.path.join(tmp_dir, "flat.pdf")
    flatten_transparency(readable, flat, gs_path=gs_path)
    assert _facts(flat, OWNER)["owner"] is True
    _assert_no_password_in(seen)
    assert any(arg.startswith("@") for argv in seen for arg in argv)


def _preview(path, gs_path):
    from engine.printer import print_preview

    return print_preview(path, gs_path=gs_path, dpi=36, max_pages=1,
                         sheet_width=612, sheet_height=792)


def test_print_preview_renders_a_user_opened_copy(readable, gs_path, monkeypatch):
    seen = _spy_subprocess(monkeypatch)
    result = _preview(readable, gs_path)
    assert result["pages"] and all(os.path.isfile(p) for p in result["pages"])
    assert not any(stage.startswith("rasterize") for stage in result["prepass"])
    _assert_no_password_in(seen)


def test_low_resolution_print_spools_page_images(tmp_dir, gs_path, monkeypatch):
    path = _text_protected(tmp_dir, "lowres.pdf", _allow(print_lowres=True))
    try:
        assert credentials.print_resolution(path) == "low"
        seen = _spy_subprocess(monkeypatch)
        result = _preview(path, gs_path)
        assert "rasterize@150dpi" in result["prepass"]
        assert result["pages"]
        _assert_no_password_in(seen)
    finally:
        close_document(path)


def test_print_is_refused_by_name_when_the_owner_withholds_it(copy_denied, gs_path):
    with pytest.raises(PermissionError, match="held by an owner password"):
        _preview(copy_denied, gs_path)


def test_print_resolution_reads_the_permissions_of_a_document_opened_without_a_prompt(tmp_dir):
    path = os.path.join(tmp_dir, "noprint.pdf")
    pdf = pikepdf.new()
    pdf.add_blank_page(page_size=(612, 792))
    pdf.save(path, encryption=pikepdf.Encryption(
        user="", owner=OWNER, R=6, allow=pikepdf.Permissions(print_lowres=False, print_highres=False)))
    pdf.close()
    assert credentials.print_resolution(path) == "none"
    with pytest.raises(PermissionError, match="held by an owner password"):
        from engine.printer import print_preview
        print_preview(path, dpi=36, max_pages=1, sheet_width=612, sheet_height=792)


def test_print_resolution_follows_the_owner_permissions(tmp_dir):
    high = _text_protected(tmp_dir, "high.pdf", _allow(print_lowres=True, print_highres=True))
    none = _text_protected(tmp_dir, "none.pdf", _allow())
    try:
        assert credentials.print_resolution(high) == "high"
        assert credentials.print_resolution(none) == "none"
        assert credentials.print_resolution(os.path.join(tmp_dir, "unknown.pdf")) == "high"
    finally:
        close_document(high)
        close_document(none)


def test_signing_refuses_where_neither_fill_nor_annotate_is_permitted(tmp_dir):
    from test_pades import _build_pki

    from engine.signatures import sign_pdf

    path = _text_protected(tmp_dir, "nosign.pdf", _allow(modify_form=False, modify_annotation=False))
    try:
        before = open(path, "rb").read()
        pki = _build_pki(tmp_dir)
        with pytest.raises(PermissionError, match="held by an owner password"):
            sign_pdf(path, path, pfx_path=pki["pfx"], password="pw", allow_in_place=True)
        assert open(path, "rb").read() == before
    finally:
        close_document(path)


def test_share_refuses_an_alias_holding_another_document(tmp_dir, user_opened):
    other = os.path.join(tmp_dir, "other.pdf")
    pdf = pikepdf.new()
    pdf.add_blank_page()
    pdf.save(other, encryption=pikepdf.Encryption(user="other-user", owner="other-owner", R=6))
    pdf.close()
    open_document(other, "other-user")
    try:
        with pytest.raises(credentials.CredentialConflict):
            share_document(user_opened, other)
        assert get_page_count(other)["pages"] == 1
    finally:
        close_document(other)


def test_a_wrong_password_keeps_the_open_document_record(user_opened):
    assert open_document_attempt(user_opened, "not-the-password") == {"status": "wrong_password"}
    assert document_permissions(user_opened)["opener"] == "user"
    with pytest.raises(pikepdf.PasswordError):
        open_document(user_opened, "not-the-password")
    assert document_permissions(user_opened)["opener"] == "user"
    assert get_page_count(user_opened)["pages"] == 3


def test_engine_start_removes_stale_gs_argfile_folders(monkeypatch, tmp_dir):
    import tempfile
    import time

    monkeypatch.setattr(tempfile, "gettempdir", lambda: tmp_dir)
    stale = os.path.join(tmp_dir, "spectrapdf-gs-stale")
    legacy_active = os.path.join(tmp_dir, "spectrapdf-gs-legacy-active")
    fresh = os.path.join(tmp_dir, "spectrapdf-gs-fresh")
    for folder in (stale, legacy_active, fresh):
        os.makedirs(folder)
        with open(os.path.join(folder, "args"), "w") as handle:
            handle.write('"-sPDFPassword=secret"\n')
    too_old = time.time() - 4 * 3600
    within_legacy_budget = time.time() - 2 * 3600
    os.utime(stale, (too_old, too_old))
    os.utime(legacy_active, (within_legacy_budget, within_legacy_budget))
    assert credentials.remove_stale_gs_argfiles() == 1
    assert not os.path.exists(stale)
    assert os.path.exists(legacy_active) and os.path.exists(fresh)
    main = open(os.path.join(os.path.dirname(credentials.__file__), "__main__.py"), encoding="utf-8").read()
    assert "    remove_stale_gs_argfiles()\n    server = JsonRpcServer()" in main


def test_engine_start_keeps_an_old_argfile_folder_owned_by_a_live_engine(monkeypatch, tmp_dir):
    import tempfile
    import time

    monkeypatch.setattr(tempfile, "gettempdir", lambda: tmp_dir)
    active = os.path.join(tmp_dir, "spectrapdf-gs-active")
    os.makedirs(active)
    with open(os.path.join(active, "args"), "w") as handle:
        handle.write('"-sPDFPassword=secret"\n')
    with open(os.path.join(active, ".owner-pid"), "w") as handle:
        handle.write(str(os.getpid()))
    old = time.time() - 3600
    os.utime(active, (old, old))

    assert credentials.remove_stale_gs_argfiles() == 0
    assert os.path.exists(os.path.join(active, "args"))


def test_engine_start_removes_an_old_argfile_folder_after_its_owner_exits(monkeypatch, tmp_dir):
    import tempfile
    import time

    monkeypatch.setattr(tempfile, "gettempdir", lambda: tmp_dir)
    monkeypatch.setattr(credentials, "_gs_process_is_running", lambda _pid: False)
    stale = os.path.join(tmp_dir, "spectrapdf-gs-dead-owner")
    os.makedirs(stale)
    with open(os.path.join(stale, "args"), "w") as handle:
        handle.write('"-sPDFPassword=secret"\n')
    with open(os.path.join(stale, ".owner-pid"), "w") as handle:
        handle.write("4242")
    old = time.time() - 3600
    os.utime(stale, (old, old))

    assert credentials.remove_stale_gs_argfiles() == 1
    assert not os.path.exists(stale)


def test_gs_owner_process_liveness_tracks_a_real_child():
    import subprocess
    import sys

    child = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
    try:
        assert credentials._gs_process_is_running(child.pid)
    finally:
        child.terminate()
        child.wait(timeout=10)
    assert not credentials._gs_process_is_running(child.pid)


def _dacl(path: str) -> str:
    import subprocess

    result = subprocess.run(
        ["powershell", "-NoProfile", "-NonInteractive", "-Command",
         "(Get-Acl -LiteralPath $env:SPECTRA_ACL_PATH).Sddl"],
        capture_output=True, text=True, check=True, stdin=subprocess.DEVNULL,
        env={**os.environ, "SPECTRA_ACL_PATH": path},
    )
    sddl = result.stdout.strip()
    return sddl[sddl.index("D:"):].split("S:")[0]


@pytest.mark.skipif(os.name != "nt", reason="Windows DACL")
def test_the_gs_argfile_is_readable_by_its_owner_only(user_opened, monkeypatch, tmp_dir):
    import re
    import tempfile

    from engine.credentials import gs_password_argv

    # A permissive parent proves the folder inherits nothing from it.
    monkeypatch.setattr(tempfile, "gettempdir", lambda: tmp_dir)
    with gs_password_argv(["gs", user_opened], user_opened) as argv:
        argfile = argv[1][1:]
        folder = os.path.dirname(argfile)
        assert os.path.dirname(folder) == tmp_dir
        folder_dacl, file_dacl = _dacl(folder), _dacl(argfile)
    sid = credentials._process_user_sid()
    assert sid.startswith("S-1-5-")
    assert folder_dacl.startswith("D:P"), folder_dacl
    for dacl in (folder_dacl, file_dacl):
        aces = re.findall(r"\(([^)]*)\)", dacl)
        assert aces, dacl
        assert all(ace.split(";")[5] == sid and ace.split(";")[0] == "A" for ace in aces), dacl


def test_engine_start_removes_a_folder_left_by_the_same_users_prior_run(monkeypatch, tmp_dir):
    import tempfile
    import time

    monkeypatch.setattr(tempfile, "gettempdir", lambda: tmp_dir)
    folder = credentials._make_gs_folder()
    with open(os.path.join(folder, ".owner-pid"), "x", encoding="ascii") as handle:
        handle.write("4242")
    with open(os.path.join(folder, "args"), "x", encoding="utf-8") as handle:
        handle.write('"-sPDFPassword=secret"\n')
    old = time.time() - 3600
    os.utime(folder, (old, old))
    monkeypatch.setattr(credentials, "_gs_process_is_running", lambda _pid: False)

    assert credentials.remove_stale_gs_argfiles() == 1
    assert not os.path.exists(folder)


def test_the_gs_argfile_is_removed_when_the_run_raises(user_opened):
    from engine.credentials import gs_password_argv

    with pytest.raises(RuntimeError, match="gs failed"):
        with gs_password_argv(["gs", user_opened], user_opened) as argv:
            folder = os.path.dirname(argv[1][1:])
            assert os.path.isfile(argv[1][1:])
            raise RuntimeError("gs failed")
    assert not os.path.exists(folder)


def test_the_gs_argv_carries_the_argfile_and_never_the_password(user_opened):
    from engine.credentials import gs_password_argv

    cmd = ["gs", "-dSAFER", user_opened]
    with gs_password_argv(cmd, user_opened) as argv:
        assert argv[0] == "gs" and argv[2:] == cmd[1:] and argv[1].startswith("@")
        assert not any(USER in arg for arg in argv)
        with open(argv[1][1:], encoding="utf-8") as handle:
            assert USER in handle.read()
        folder = os.path.dirname(argv[1][1:])
    assert not os.path.exists(folder)
