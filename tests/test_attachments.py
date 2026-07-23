"""§ I.6 — embedded file attachments."""

import os

import pikepdf
import pytest

from engine.attachments import (
    add_attachment,
    extract_attachment,
    list_attachments,
    remove_attachment,
)


def _pdf(path: str) -> None:
    doc = pikepdf.new()
    doc.add_blank_page(page_size=(200, 200))
    doc.save(path)
    doc.close()


@pytest.fixture
def tmp_dir(tmp_path):
    return str(tmp_path)


class TestAttachments:
    def test_add_list_extract_remove(self, tmp_dir):
        src = os.path.join(tmp_dir, "s.pdf")
        _pdf(src)
        payload = os.path.join(tmp_dir, "data.txt")
        with open(payload, "wb") as f:
            f.write(b"hello attachment")

        out1 = os.path.join(tmp_dir, "o1.pdf")
        r = add_attachment(src, out1, payload, description="a note")
        assert r["name"] == "data.txt" and r["size"] == 16 and r["mime"] == "text/plain"

        listing = list_attachments(out1)
        assert listing["count"] == 1
        a = listing["attachments"][0]
        assert a["name"] == "data.txt" and a["size"] == 16 and a["description"] == "a note"

        extracted = os.path.join(tmp_dir, "back.txt")
        extract_attachment(out1, "data.txt", extracted)
        assert open(extracted, "rb").read() == b"hello attachment"

        out2 = os.path.join(tmp_dir, "o2.pdf")
        remove_attachment(out1, out2, "data.txt")
        assert list_attachments(out2)["count"] == 0

    def test_custom_name(self, tmp_dir):
        src = os.path.join(tmp_dir, "s.pdf")
        _pdf(src)
        payload = os.path.join(tmp_dir, "raw.bin")
        open(payload, "wb").write(b"\x00\x01\x02")
        out = os.path.join(tmp_dir, "o.pdf")
        add_attachment(src, out, payload, name="renamed.dat")
        assert [a["name"] for a in list_attachments(out)["attachments"]] == ["renamed.dat"]

    def test_duplicate_name_refused(self, tmp_dir):
        src = os.path.join(tmp_dir, "s.pdf")
        _pdf(src)
        payload = os.path.join(tmp_dir, "d.txt")
        open(payload, "wb").write(b"x")
        out = os.path.join(tmp_dir, "o.pdf")
        add_attachment(src, out, payload)
        with pytest.raises(ValueError, match="already exists"):
            add_attachment(out, out, payload)

    def test_missing_source_refused(self, tmp_dir):
        src = os.path.join(tmp_dir, "s.pdf")
        _pdf(src)
        with pytest.raises(ValueError, match="source file not found"):
            add_attachment(src, os.path.join(tmp_dir, "o.pdf"), os.path.join(tmp_dir, "nope.txt"))

    def test_extract_missing_refused(self, tmp_dir):
        src = os.path.join(tmp_dir, "s.pdf")
        _pdf(src)
        with pytest.raises(ValueError, match="no attachment"):
            extract_attachment(src, "ghost.txt", os.path.join(tmp_dir, "x"))

    def test_remove_missing_refused(self, tmp_dir):
        src = os.path.join(tmp_dir, "s.pdf")
        _pdf(src)
        with pytest.raises(ValueError, match="no attachment"):
            remove_attachment(src, os.path.join(tmp_dir, "o.pdf"), "ghost.txt")

    def test_in_place_add(self, tmp_dir):
        src = os.path.join(tmp_dir, "s.pdf")
        _pdf(src)
        payload = os.path.join(tmp_dir, "p.txt")
        open(payload, "wb").write(b"inplace")
        add_attachment(src, src, payload)
        assert list_attachments(src)["count"] == 1

    def test_no_attachments_empty(self, tmp_dir):
        src = os.path.join(tmp_dir, "s.pdf")
        _pdf(src)
        assert list_attachments(src) == {"attachments": [], "count": 0}
