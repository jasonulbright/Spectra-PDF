"""§ I.6 — PDF portfolios (/Collection over /EmbeddedFiles)."""

import os

import pikepdf
import pytest

from engine.attachments import add_attachment, list_attachments
from engine.portfolio import (
    create_portfolio,
    extract_member_to_dir,
    get_portfolio,
    make_portfolio,
    update_portfolio_member,
)


def _pdf(path: str) -> None:
    doc = pikepdf.new()
    doc.add_blank_page(page_size=(200, 200))
    doc.save(path)
    doc.close()


def _file(path: str, data: bytes) -> str:
    with open(path, "wb") as f:
        f.write(data)
    return path


@pytest.fixture
def tmp_dir(tmp_path):
    return str(tmp_path)


class TestPortfolio:
    def test_create_get_round_trip(self, tmp_dir):
        a = _file(os.path.join(tmp_dir, "notes.txt"), b"hello portfolio")
        b = os.path.join(tmp_dir, "inner.pdf")
        _pdf(b)
        out = os.path.join(tmp_dir, "folio.pdf")

        r = create_portfolio(out, [a, b], title="Q3 Bundle")
        assert r["count"] == 2
        assert [m["name"] for m in r["members"]] == ["notes.txt", "inner.pdf"]

        g = get_portfolio(out)
        assert g["is_portfolio"] is True
        assert g["view"] == "details"
        assert g["count"] == 2
        by_name = {m["name"]: m for m in g["members"]}
        assert by_name["notes.txt"]["size"] == 15
        assert by_name["notes.txt"]["mime"] == "text/plain"

        with pikepdf.open(out) as pdf:
            assert len(pdf.pages) == 1  # the generated cover sheet
            assert str(pdf.docinfo["/Title"]) == "Q3 Bundle"
            cover = pdf.pages[0].Contents.read_bytes()
            assert b"PDF Portfolio" in cover
            assert b"Contains 2 embedded files." in cover

    def test_create_title_defaults_to_stem_and_allows_unicode(self, tmp_dir):
        a = _file(os.path.join(tmp_dir, "a.txt"), b"x")
        out = os.path.join(tmp_dir, "bundle.pdf")
        create_portfolio(out, [a])
        with pikepdf.open(out) as pdf:
            assert str(pdf.docinfo["/Title"]) == "bundle"

        out2 = os.path.join(tmp_dir, "u.pdf")
        create_portfolio(out2, [a], title="Résumé — 提出書類")
        with pikepdf.open(out2) as pdf:
            assert str(pdf.docinfo["/Title"]) == "Résumé — 提出書類"

    def test_create_duplicate_basenames_suffixed(self, tmp_dir):
        d1 = os.path.join(tmp_dir, "d1")
        d2 = os.path.join(tmp_dir, "d2")
        os.makedirs(d1)
        os.makedirs(d2)
        a = _file(os.path.join(d1, "report.txt"), b"one")
        b = _file(os.path.join(d2, "report.txt"), b"two!")
        out = os.path.join(tmp_dir, "folio.pdf")
        r = create_portfolio(out, [a, b])
        assert [m["name"] for m in r["members"]] == ["report.txt", "report (2).txt"]
        by_name = {m["name"]: m["size"] for m in get_portfolio(out)["members"]}
        assert by_name == {"report.txt": 3, "report (2).txt": 4}

    def test_create_refusals(self, tmp_dir):
        out = os.path.join(tmp_dir, "folio.pdf")
        with pytest.raises(ValueError, match="at least one member"):
            create_portfolio(out, [])
        with pytest.raises(ValueError, match="member source not found"):
            create_portfolio(out, [os.path.join(tmp_dir, "nope.txt")])
        a = _file(os.path.join(tmp_dir, "a.txt"), b"x")
        _file(out, b"occupied")
        with pytest.raises(ValueError, match="cannot be one of its own members"):
            create_portfolio(out, [a, out])

    def test_make_portfolio_converts_existing_doc(self, tmp_dir):
        src = os.path.join(tmp_dir, "plain.pdf")
        _pdf(src)
        payload = _file(os.path.join(tmp_dir, "data.txt"), b"kept")
        add_attachment(src, src, payload)

        out = os.path.join(tmp_dir, "as-folio.pdf")
        r = make_portfolio(src, out)
        assert r["count"] == 1  # the existing attachment became a member
        g = get_portfolio(out)
        assert g["is_portfolio"] is True
        assert [m["name"] for m in g["members"]] == ["data.txt"]
        # The original document's pages are untouched.
        with pikepdf.open(out) as pdf:
            assert len(pdf.pages) == 1

    def test_make_portfolio_in_place_and_already_refused(self, tmp_dir):
        src = os.path.join(tmp_dir, "plain.pdf")
        _pdf(src)
        make_portfolio(src, src)
        assert get_portfolio(src)["is_portfolio"] is True
        with pytest.raises(ValueError, match="already a portfolio"):
            make_portfolio(src, src)

    def test_update_member_replaces_bytes_keeps_description(self, tmp_dir):
        src = os.path.join(tmp_dir, "s.pdf")
        _pdf(src)
        payload = _file(os.path.join(tmp_dir, "d.txt"), b"v1")
        add_attachment(src, src, payload, description="original note")

        newer = _file(os.path.join(tmp_dir, "d2.txt"), b"version two")
        update_portfolio_member(src, src, "d.txt", newer)
        a = list_attachments(src)["attachments"][0]
        assert a["name"] == "d.txt"
        assert a["size"] == 11
        assert a["description"] == "original note"

        update_portfolio_member(src, src, "d.txt", payload, description="new note")
        a = list_attachments(src)["attachments"][0]
        assert a["size"] == 2
        assert a["description"] == "new note"

    def test_update_member_refusals(self, tmp_dir):
        src = os.path.join(tmp_dir, "s.pdf")
        _pdf(src)
        payload = _file(os.path.join(tmp_dir, "p.txt"), b"x")
        with pytest.raises(ValueError, match="no member named"):
            update_portfolio_member(src, src, "ghost.txt", payload)
        add_attachment(src, src, payload)
        with pytest.raises(ValueError, match="source file not found"):
            update_portfolio_member(src, src, "p.txt", os.path.join(tmp_dir, "nope"))

    def test_extract_member_to_dir_creates_and_sanitizes(self, tmp_dir):
        src = os.path.join(tmp_dir, "s.pdf")
        _pdf(src)
        payload = _file(os.path.join(tmp_dir, "raw.bin"), b"\x01\x02\x03\x04")
        add_attachment(src, src, payload, name='we:ird*na"me.bin')

        dest = os.path.join(tmp_dir, "nested", "members")
        r = extract_member_to_dir(src, 'we:ird*na"me.bin', dest)
        assert os.path.basename(r["output"]) == "we_ird_na_me.bin"
        assert open(r["output"], "rb").read() == b"\x01\x02\x03\x04"

        # A second extract of the same member does not clobber the first.
        r2 = extract_member_to_dir(src, 'we:ird*na"me.bin', dest)
        assert os.path.basename(r2["output"]) == "we_ird_na_me (2).bin"

    def test_extract_member_missing_refused(self, tmp_dir):
        src = os.path.join(tmp_dir, "s.pdf")
        _pdf(src)
        with pytest.raises(ValueError, match="no member named"):
            extract_member_to_dir(src, "ghost", tmp_dir)

    def test_get_on_plain_pdf(self, tmp_dir):
        src = os.path.join(tmp_dir, "s.pdf")
        _pdf(src)
        g = get_portfolio(src)
        assert g == {"is_portfolio": False, "view": "", "members": [], "count": 0}

    def test_portfolio_with_zero_members_is_valid(self, tmp_dir):
        src = os.path.join(tmp_dir, "s.pdf")
        _pdf(src)
        make_portfolio(src, src)
        g = get_portfolio(src)
        assert g["is_portfolio"] is True and g["count"] == 0
