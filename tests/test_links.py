"""§ I.2 N1 — link-region management."""

import os

import pikepdf
import pytest
from pikepdf import Array, Dictionary, Name, String

from engine.links import delete_link, list_links, set_link_url


def _pdf(path: str) -> None:
    p = pikepdf.new()
    pg1 = p.add_blank_page(page_size=(300, 400))
    pg2 = p.add_blank_page(page_size=(300, 400))
    uri = p.make_indirect(Dictionary(
        Type=Name.Annot, Subtype=Name.Link, Rect=[10, 10, 100, 30],
        A=Dictionary(Type=Name.Action, S=Name.URI, URI=String("https://example.com"))))
    goto = p.make_indirect(Dictionary(
        Type=Name.Annot, Subtype=Name.Link, Rect=[10, 50, 100, 70], Dest=Array([pg2.obj, Name.Fit])))
    # A non-link annotation must be ignored by the link manager.
    note = p.make_indirect(Dictionary(Type=Name.Annot, Subtype=Name.Text, Rect=[0, 0, 10, 10]))
    pg1.obj["/Annots"] = Array([uri, goto, note])
    p.save(path)
    p.close()


@pytest.fixture
def tmp_dir(tmp_path):
    return str(tmp_path)


class TestLinks:
    def test_list_uri_and_internal(self, tmp_dir):
        src = os.path.join(tmp_dir, "s.pdf")
        _pdf(src)
        r = list_links(src)
        assert r["count"] == 2  # the /Text note is ignored
        assert r["links"][0] == {
            "page": 1, "index": 0, "kind": "uri", "target": "https://example.com",
            "rect": [10.0, 10.0, 100.0, 30.0],
        }
        assert r["links"][1]["kind"] == "internal"
        assert r["links"][1]["target"] == "Page 2"

    def test_set_url_retargets(self, tmp_dir):
        src = os.path.join(tmp_dir, "s.pdf")
        out = os.path.join(tmp_dir, "o.pdf")
        _pdf(src)
        # Retarget the internal (index 1) link to a URL.
        set_link_url(src, out, page=1, index=1, url="https://new.example")
        r = list_links(out)
        assert r["links"][1]["kind"] == "uri"
        assert r["links"][1]["target"] == "https://new.example"
        with pikepdf.open(out) as pdf:
            assert "/Dest" not in pdf.pages[0].obj["/Annots"][1]  # dest cleared

    def test_empty_url_refused(self, tmp_dir):
        src = os.path.join(tmp_dir, "s.pdf")
        _pdf(src)
        with pytest.raises(ValueError, match="url must not be empty"):
            set_link_url(src, os.path.join(tmp_dir, "o.pdf"), page=1, index=0, url="  ")

    def test_delete_link(self, tmp_dir):
        src = os.path.join(tmp_dir, "s.pdf")
        out = os.path.join(tmp_dir, "o.pdf")
        _pdf(src)
        delete_link(src, out, page=1, index=0)  # remove the URI link
        r = list_links(out)
        assert r["count"] == 1
        assert r["links"][0]["kind"] == "internal"
        # The non-link /Text annotation survives.
        with pikepdf.open(out) as pdf:
            subs = {str(a.get("/Subtype")) for a in pdf.pages[0].obj["/Annots"]}
            assert "/Text" in subs

    def test_out_of_range_refused(self, tmp_dir):
        src = os.path.join(tmp_dir, "s.pdf")
        _pdf(src)
        with pytest.raises(ValueError, match="out of range"):
            delete_link(src, os.path.join(tmp_dir, "o.pdf"), page=1, index=9)

    def test_no_links(self, tmp_dir):
        src = os.path.join(tmp_dir, "s.pdf")
        p = pikepdf.new()
        p.add_blank_page(page_size=(200, 200))
        p.save(src)
        p.close()
        assert list_links(src) == {"links": [], "count": 0}

    def test_in_place_delete(self, tmp_dir):
        src = os.path.join(tmp_dir, "s.pdf")
        _pdf(src)
        delete_link(src, src, page=1, index=0)
        assert list_links(src)["count"] == 1
