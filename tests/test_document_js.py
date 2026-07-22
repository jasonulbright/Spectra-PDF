"""Phase 9.S6 — document-level JavaScript editor (read + rewrite the
/Names /JavaScript name tree). The engine NEVER executes the JS."""

import os

import pikepdf
import pytest

from engine.document_js import list_document_js, set_document_js


def _blank(tmp_dir, name="in.pdf"):
    p = os.path.join(tmp_dir, name)
    pdf = pikepdf.new()
    pdf.add_blank_page(page_size=(200, 200))
    pdf.save(p)
    pdf.close()
    return p


def _add_js_string(path, out, name, js):
    """Author a /JavaScript action whose /JS is a PDF STRING (the other legal
    form) so the reader is exercised on both String and Stream."""
    with pikepdf.open(path) as pdf:
        action = pdf.make_indirect(
            pikepdf.Dictionary(S=pikepdf.Name("/JavaScript"), JS=pikepdf.String(js))
        )
        tree = pdf.make_indirect(pikepdf.Dictionary(Names=pikepdf.Array([name, action])))
        pdf.Root.Names = pikepdf.Dictionary(JavaScript=tree)
        pdf.save(out)


class TestDocumentJs:
    def test_empty_document_lists_nothing(self, tmp_dir):
        assert list_document_js(_blank(tmp_dir)) == {"scripts": [], "count": 0}

    def test_add_lists_back_sorted_with_unicode(self, tmp_dir):
        src = _blank(tmp_dir)
        out = os.path.join(tmp_dir, "out.pdf")
        set_document_js(
            src,
            out,
            [
                {"name": "Zeta", "js": "console.println(2);"},
                {"name": "Alpha", "js": 'app.alert("héllo");'},  # non-ASCII
            ],
        )
        r = list_document_js(out)
        assert r["count"] == 2
        # Name-tree order is sorted; the Unicode survives (UTF-16BE stream).
        assert [s["name"] for s in r["scripts"]] == ["Alpha", "Zeta"]
        assert r["scripts"][0]["js"] == 'app.alert("héllo");'

    def test_reads_js_stored_as_a_pdf_string(self, tmp_dir):
        # Real documents store /JS as a String OR a Stream — read both.
        src = _blank(tmp_dir)
        out = os.path.join(tmp_dir, "str.pdf")
        _add_js_string(src, out, "S1", "var x = 1;")
        r = list_document_js(out)
        assert r["scripts"] == [{"name": "S1", "js": "var x = 1;"}]

    def test_edit_then_remove_one(self, tmp_dir):
        src = _blank(tmp_dir)
        a = os.path.join(tmp_dir, "a.pdf")
        set_document_js(
            src, a, [{"name": "Init", "js": "old();"}, {"name": "Calc", "js": "c();"}]
        )
        b = os.path.join(tmp_dir, "b.pdf")
        set_document_js(a, b, [{"name": "Init", "js": "changed();"}])
        r = list_document_js(b)
        assert r["scripts"] == [{"name": "Init", "js": "changed();"}]

    def test_remove_all_drops_the_names_tree(self, tmp_dir):
        src = _blank(tmp_dir)
        a = os.path.join(tmp_dir, "a.pdf")
        set_document_js(src, a, [{"name": "Init", "js": "x();"}])
        b = os.path.join(tmp_dir, "b.pdf")
        set_document_js(a, b, [])
        assert list_document_js(b)["count"] == 0
        with pikepdf.open(b) as pdf:
            # /Names had only /JavaScript, so it is dropped entirely.
            assert "/Names" not in pdf.Root

    def test_preserves_other_names_entries(self, tmp_dir):
        # Editing /JavaScript must not disturb sibling /Names entries (/Dests…).
        src = _blank(tmp_dir)
        withdest = os.path.join(tmp_dir, "dest.pdf")
        with pikepdf.open(src) as pdf:
            dests = pdf.make_indirect(
                pikepdf.Dictionary(
                    Names=pikepdf.Array(
                        ["D1", pikepdf.Array([pdf.pages[0].obj, pikepdf.Name("/Fit")])]
                    )
                )
            )
            pdf.Root.Names = pikepdf.Dictionary(Dests=dests)
            pdf.save(withdest)
        out = os.path.join(tmp_dir, "out.pdf")
        set_document_js(withdest, out, [{"name": "Init", "js": "x();"}])
        with pikepdf.open(out) as pdf:
            assert "/Dests" in pdf.Root.Names
            assert "/JavaScript" in pdf.Root.Names

    def test_duplicate_names_refused(self, tmp_dir):
        with pytest.raises(ValueError, match="Duplicate"):
            set_document_js(
                _blank(tmp_dir),
                os.path.join(tmp_dir, "bad.pdf"),
                [{"name": "X", "js": "1"}, {"name": "X", "js": "2"}],
            )

    def test_empty_name_refused(self, tmp_dir):
        with pytest.raises(ValueError, match="non-empty name"):
            set_document_js(
                _blank(tmp_dir),
                os.path.join(tmp_dir, "bad.pdf"),
                [{"name": "  ", "js": "1"}],
            )

    def test_in_place_output_equals_input(self, tmp_dir):
        # The renderer routes through the undoable workspace flow, which passes
        # the working copy as BOTH file and output. pikepdf refuses to overwrite
        # the file it opened; the temp+replace path must handle it (e2e-caught).
        src = _blank(tmp_dir)
        set_document_js(src, src, [{"name": "Init", "js": "one();"}])
        assert list_document_js(src)["scripts"] == [{"name": "Init", "js": "one();"}]
        # And an in-place EDIT over the same path works too.
        set_document_js(src, src, [{"name": "Init", "js": "two();"}])
        assert list_document_js(src)["scripts"] == [{"name": "Init", "js": "two();"}]

    def test_broken_javascript_is_saved_verbatim_not_parsed(self, tmp_dir):
        # The editor stores text; it never parses/executes. A syntactically
        # broken script must round-trip byte-for-byte (the king validates at
        # run time — which is not us).
        src = _blank(tmp_dir)
        out = os.path.join(tmp_dir, "broken.pdf")
        broken = "function( { this is not valid javascript"
        set_document_js(src, out, [{"name": "Bad", "js": broken}])
        assert list_document_js(out)["scripts"][0]["js"] == broken
