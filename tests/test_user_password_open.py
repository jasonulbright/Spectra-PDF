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
from engine.credentials import close_document, document_permissions, open_document
from engine.grayscale import grayscale
from engine.inspect import get_page_count, unlock
from engine.ipc import JsonRpcServer
from engine.merge import merge
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


def test_wrong_password_still_reports_incorrect(protected):
    with pytest.raises(pikepdf.PasswordError):
        open_document(protected, "wrong")
    with pytest.raises(pikepdf.PasswordError):
        get_page_count(protected)


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


def test_a_save_to_another_path_keeps_the_protection(user_opened, tmp_dir):
    out = os.path.join(tmp_dir, "rotated.pdf")
    rotate(user_opened, [2], 90, out)
    assert _facts(out, USER)["P"] == _facts(user_opened, USER)["P"]
    assert _facts(out, OWNER)["owner"] is True


def test_no_response_payload_carries_a_password(protected):
    server = JsonRpcServer()
    for name, handler in (("open_document", open_document),
                          ("document_permissions", document_permissions),
                          ("close_document", close_document),
                          ("unlock", unlock),
                          ("get_page_count", get_page_count)):
        server.register(name, handler)
    requests = [
        ("open_document", {"path": protected, "password": "wrong"}),
        ("open_document", {"path": protected, "password": USER}),
        ("document_permissions", {"path": protected}),
        ("get_page_count", {"file": protected}),
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
]


@pytest.mark.parametrize("run", REFUSING_DOORS)
def test_a_new_document_from_a_user_opened_source_refuses(user_opened, tmp_dir, run):
    out_dir = os.path.join(tmp_dir, "out")
    os.makedirs(out_dir)
    out = os.path.join(out_dir, "out.pdf")
    with pytest.raises(ValueError, match="held by an owner password"):
        run(user_opened, out, out_dir)
    assert [n for n in os.listdir(out_dir) if os.path.getsize(os.path.join(out_dir, n))] == []
