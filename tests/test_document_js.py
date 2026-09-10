"""Document-level JavaScript editor (read + rewrite the
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

    def test_malformed_js_tree_degrades_gracefully(self, tmp_dir):
        # regression: a hostile/corrupt `/Names << /JavaScript 42 >>`
        # (a scalar where a name tree belongs) must read as "no scripts", not
        # raise a raw TypeError out of pikepdf.NameTree.
        src = _blank(tmp_dir)
        bad = os.path.join(tmp_dir, "bad.pdf")
        with pikepdf.open(src) as pdf:
            pdf.Root.Names = pikepdf.Dictionary(JavaScript=42)
            pdf.save(bad)
        assert list_document_js(bad) == {"scripts": [], "count": 0}

    def test_reads_a_bom_less_utf8_js_stream(self, tmp_dir):
        # regression: some producers write /JS as UTF-8 WITHOUT a BOM;
        # decoding it as Latin-1/PDFDocEncoding mojibakes non-ASCII text, and a
        # later save would bake that corruption in. Strict-UTF-8-first recovers.
        src = _blank(tmp_dir)
        out = os.path.join(tmp_dir, "utf8.pdf")
        js = 'app.alert("café déjà vu");'
        with pikepdf.open(src) as pdf:
            action = pdf.make_indirect(
                pikepdf.Dictionary(
                    S=pikepdf.Name("/JavaScript"),
                    JS=pdf.make_stream(js.encode("utf-8")),  # no BOM
                )
            )
            tree = pdf.make_indirect(pikepdf.Dictionary(Names=pikepdf.Array(["S1", action])))
            pdf.Root.Names = pikepdf.Dictionary(JavaScript=tree)
            pdf.save(out)
        assert list_document_js(out)["scripts"] == [{"name": "S1", "js": js}]

    def test_in_place_output_equals_input(self, tmp_dir):
        # The renderer routes through the undoable workspace flow, which passes
        # the working copy as BOTH file and output. pikepdf refuses to overwrite
        # the file it opened; the temp+replace path must handle it (e2e regression).
        src = _blank(tmp_dir)
        set_document_js(src, src, [{"name": "Init", "js": "one();"}])
        assert list_document_js(src)["scripts"] == [{"name": "Init", "js": "one();"}]
        # And an in-place EDIT over the same path works too.
        set_document_js(src, src, [{"name": "Init", "js": "two();"}])
        assert list_document_js(src)["scripts"] == [{"name": "Init", "js": "two();"}]

    def test_broken_javascript_is_saved_verbatim_not_parsed(self, tmp_dir):
        # The editor stores text without parsing or executing it, so a
        # syntactically broken script must round-trip byte-for-byte.
        src = _blank(tmp_dir)
        out = os.path.join(tmp_dir, "broken.pdf")
        broken = "function( { this is not valid javascript"
        set_document_js(src, out, [{"name": "Bad", "js": broken}])
        assert list_document_js(out)["scripts"][0]["js"] == broken


def _editable_fixture(tmp_path, mutate=None):
    source = tmp_path / 'scripts.pdf'
    with pikepdf.new() as pdf:
        pdf.add_blank_page()
        action = pdf.make_indirect(pikepdf.Dictionary(S=pikepdf.Name.JavaScript, JS=pikepdf.String('// original')))
        tree = pdf.make_indirect(pikepdf.Dictionary(Names=pikepdf.Array(['Script', action])))
        pdf.Root.Names = pikepdf.Dictionary(JavaScript=tree)
        if mutate:
            mutate(pdf, tree, action)
        pdf.save(source)
    return source


@pytest.mark.parametrize('kind', ['names-scalar', 'tree-scalar', 'odd', 'both', 'key-scalar', 'duplicate',
    'unsorted', 'action-scalar', 'missing-js', 'wrong-js', 'next', 'wrong-type', 'wrong-action', 'opaque',
    'bad-utf16', 'bad-stream', 'bad-filter', 'root-limits', 'child-limits', 'wrong-limits', 'direct-child',
    'cycle', 'decoded-collision', 'oversize'])
def test_strict_editor_never_authorizes_partial_or_lossy_replacement(tmp_path, kind):
    def mutate(pdf, tree, action):
        if kind == 'names-scalar': pdf.Root.Names = 42
        elif kind == 'tree-scalar': pdf.Root.Names.JavaScript = 42
        elif kind == 'odd': tree.Names.append(pikepdf.String('dangling'))
        elif kind == 'both': tree.Kids = pikepdf.Array()
        elif kind == 'key-scalar': tree.Names[0] = 42
        elif kind == 'duplicate': tree.Names.extend(['Script', action])
        elif kind == 'unsorted': tree.Names.extend(['A', action])
        elif kind == 'action-scalar': tree.Names[1] = 42
        elif kind == 'missing-js': del action['/JS']
        elif kind == 'wrong-js': action.JS = 42
        elif kind == 'next': action.Next = pikepdf.Dictionary(S=pikepdf.Name.JavaScript, JS='// second')
        elif kind == 'wrong-type': action.Type = pikepdf.Name.Other
        elif kind == 'wrong-action': action.S = pikepdf.Name.URI
        elif kind == 'opaque': action.PrivateData = 'must survive'
        elif kind == 'bad-utf16': action.JS = pikepdf.String(b'\xfe\xff\xd8\x00')
        elif kind == 'bad-stream': action.JS = pdf.make_stream(b'\xfe\xff\x00')
        elif kind == 'bad-filter':
            action.JS = pdf.make_stream(b'broken'); action.JS.Filter = pikepdf.Name.FlateDecode
        elif kind == 'root-limits': tree.Limits = pikepdf.Array(['Script', 'Script'])
        elif kind in ('child-limits', 'wrong-limits', 'direct-child'):
            leaf = pikepdf.Dictionary(Names=tree.Names, Limits=pikepdf.Array(['Script', 'Script']))
            if kind == 'child-limits': del leaf['/Limits']
            if kind == 'wrong-limits': leaf.Limits = pikepdf.Array(['Other', 'Script'])
            del tree['/Names']; tree.Kids = pikepdf.Array([leaf if kind == 'direct-child' else pdf.make_indirect(leaf)])
        elif kind == 'cycle': del tree['/Names']; tree.Kids = pikepdf.Array([tree])
        elif kind == 'decoded-collision': tree.Names.extend([pikepdf.String(b'\xfe\xff' + 'Script'.encode('utf-16-be')), action])
        elif kind == 'oversize': action.JS = pdf.make_stream(b'\xfe\xff' + b'\x00x' * 1000001)
    source = _editable_fixture(tmp_path, mutate); before = source.read_bytes()
    assert list_document_js(str(source), for_edit=True) == {'scripts': [], 'count': 0, 'complete': False}
    assert source.read_bytes() == before


def test_strict_complete_nested_tree_and_empty_controls(tmp_path):
    def nested(pdf, tree, action):
        tree.Kids = pikepdf.Array([pdf.make_indirect(pikepdf.Dictionary(Names=tree.Names, Limits=pikepdf.Array(['Script', 'Script'])))])
        del tree['/Names']; action.Type = pikepdf.Name.Action
    source = _editable_fixture(tmp_path, nested)
    assert list_document_js(str(source), for_edit=True) == {'scripts': [{'name': 'Script', 'js': '// original'}], 'count': 1, 'complete': True}
    set_document_js(str(source), str(source), [])
    assert list_document_js(str(source), for_edit=True) == {'scripts': [], 'count': 0, 'complete': True}


@pytest.mark.parametrize('bad', [42, {}, [{'name': 2, 'js': ''}], [{'name': 'x', 'js': 1}],
    [{'name': 'x', 'js': 'x' * 1000001}]])
def test_invalid_writer_preserves_existing_source_and_destination(tmp_path, bad):
    source = _editable_fixture(tmp_path); dest = tmp_path / 'dest.pdf'; dest.write_bytes(b'existing destination')
    before = source.read_bytes()
    with pytest.raises(ValueError): set_document_js(str(source), str(dest), bad)
    assert source.read_bytes() == before; assert dest.read_bytes() == b'existing destination'


def test_whitespace_name_and_unicode_stream_round_trip_without_identity_change(tmp_path):
    source = _editable_fixture(tmp_path); out = tmp_path / 'out.pdf'
    scripts = [{'name': ' Script ', 'js': '// café — 你好 😀'}, {'name': 'Script', 'js': 'function( { invalid is still text'}]
    set_document_js(str(source), str(out), scripts)
    assert list_document_js(str(out), for_edit=True) == {'scripts': scripts, 'count': 2, 'complete': True}


def test_strict_read_budget_also_applies_to_writer(tmp_path):
    source = _editable_fixture(tmp_path); before = source.read_bytes()
    with pytest.raises(ValueError, match='limits'):
        set_document_js(str(source), str(source), [{'name': 'A', 'js': 'a' * 500000}, {'name': 'B', 'js': 'b' * 500000}])
    assert source.read_bytes() == before
