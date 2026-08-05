"""Structure-tree read/edit (Tags + Reading Order panels)."""

import os

import pikepdf
import pytest
from pikepdf import Array, Dictionary, Name, String

from engine.struct_tree import (
    add_struct_node,
    delete_struct_node,
    get_struct_tree,
    move_struct_node,
    set_struct_props,
)


def _tagged_pdf(path: str) -> None:
    """Two pages; tree = Document → [H1(mcid 0 @p1), P(mcid 1 @p1),
    Figure(/Alt, mcid 2 @p1), Sect → [P(MCR mcid 0 @p2)]]; a /ParentTree
    mapping both pages' StructParents arrays."""
    p = pikepdf.new()
    pg1 = p.add_blank_page(page_size=(300, 400))
    pg2 = p.add_blank_page(page_size=(300, 400))

    def elem(**kw):
        return p.make_indirect(Dictionary(Type=Name.StructElem, **kw))

    doc = elem(S=Name.Document)
    h1 = elem(S=Name.H1, P=doc, Pg=pg1.obj, K=0)
    para = elem(S=Name.P, P=doc, Pg=pg1.obj, K=Array([1]))
    fig = elem(S=Name.Figure, P=doc, Pg=pg1.obj, K=Array([2]), Alt=String("A chart"))
    sect = elem(S=Name.Sect, P=doc)
    p2para = elem(
        S=Name.P, P=sect,
        K=Array([Dictionary(Type=Name.MCR, Pg=pg2.obj, MCID=0)]),
    )
    sect[Name.K] = Array([p2para])
    doc[Name.K] = Array([h1, para, fig, sect])

    st = p.make_indirect(Dictionary(Type=Name.StructTreeRoot))
    doc[Name.P] = st
    st[Name.K] = Array([doc])
    pt_arr1 = p.make_indirect(Array([h1, para, fig]))
    pt_arr2 = p.make_indirect(Array([p2para]))
    st[Name.ParentTree] = p.make_indirect(
        Dictionary(Nums=Array([0, pt_arr1, 1, pt_arr2]))
    )
    st[Name.ParentTreeNextKey] = 2
    pg1.obj[Name.StructParents] = 0
    pg2.obj[Name.StructParents] = 1
    p.Root[Name.StructTreeRoot] = st
    p.Root[Name.MarkInfo] = Dictionary(Marked=True)
    p.save(path)
    p.close()


def _plain_pdf(path: str) -> None:
    p = pikepdf.new()
    p.add_blank_page()
    p.save(path)
    p.close()


@pytest.fixture
def tmp_dir(tmp_path):
    return str(tmp_path)


def _types(nodes):
    return [n["type"] for n in nodes]


class TestGetStructTree:
    def test_full_listing(self, tmp_dir):
        src = os.path.join(tmp_dir, "s.pdf")
        _tagged_pdf(src)
        r = get_struct_tree(src)
        assert r["tagged"] is True
        assert r["count"] == 6
        assert _types(r["root"]) == ["Document"]
        doc = r["root"][0]
        assert doc["path"] == [0]
        assert _types(doc["children"]) == ["H1", "P", "Figure", "Sect"]
        assert doc["children"][0]["path"] == [0, 0]
        # Integer MCID inherits the element's /Pg page.
        assert doc["children"][0]["content"] == [{"page": 1, "mcid": 0}]
        assert doc["children"][2]["alt"] == "A chart"
        # The MCR child carries its own /Pg (page 2).
        p2 = doc["children"][3]["children"][0]
        assert p2["path"] == [0, 3, 0]
        assert p2["content"] == [{"page": 2, "mcid": 0}]

    def test_untagged(self, tmp_dir):
        src = os.path.join(tmp_dir, "p.pdf")
        _plain_pdf(src)
        r = get_struct_tree(src)
        assert r == {"tagged": False, "count": 0, "root": [], "role_map": {}}

    def test_single_nonarray_k_normalizes(self, tmp_dir):
        src = os.path.join(tmp_dir, "s.pdf")
        _tagged_pdf(src)
        # Rewrite the root's /K from a one-element array to the bare element.
        with pikepdf.open(src) as pdf:
            st = pdf.Root["/StructTreeRoot"]
            st[Name.K] = st["/K"][0]
            pdf.save(src + ".2.pdf")
        r = get_struct_tree(src + ".2.pdf")
        assert _types(r["root"]) == ["Document"]
        assert r["count"] == 6

    def test_cycle_listed_childless_not_skipped(self, tmp_dir):
        src = os.path.join(tmp_dir, "s.pdf")
        _tagged_pdf(src)
        with pikepdf.open(src) as pdf:
            st = pdf.Root["/StructTreeRoot"]
            doc = st["/K"][0]
            sect = doc["/K"][3]
            # Sect's second child points back at Document — a cycle.
            sect[Name.K] = Array([sect["/K"][0], doc])
            pdf.save(src + ".2.pdf")
        r = get_struct_tree(src + ".2.pdf")  # must terminate
        sect_kids = r["root"][0]["children"][3]["children"]
        assert _types(sect_kids) == ["P", "Document"]
        assert sect_kids[1]["children"] == []  # listed, but not descended into

    def test_role_map(self, tmp_dir):
        src = os.path.join(tmp_dir, "s.pdf")
        _tagged_pdf(src)
        with pikepdf.open(src) as pdf:
            pdf.Root["/StructTreeRoot"][Name.RoleMap] = Dictionary(Heading=Name.H1)
            pdf.save(src + ".2.pdf")
        r = get_struct_tree(src + ".2.pdf")
        assert r["role_map"] == {"Heading": "H1"}


class TestSetProps:
    def test_retag_and_title(self, tmp_dir):
        src = os.path.join(tmp_dir, "s.pdf")
        out = os.path.join(tmp_dir, "o.pdf")
        _tagged_pdf(src)
        set_struct_props(src, out, [0, 1], {"type": "H2", "title": "Second heading"})
        r = get_struct_tree(out)
        node = r["root"][0]["children"][1]
        assert node["type"] == "H2"
        assert node["title"] == "Second heading"

    def test_set_and_clear_alt(self, tmp_dir):
        src = os.path.join(tmp_dir, "s.pdf")
        out = os.path.join(tmp_dir, "o.pdf")
        out2 = os.path.join(tmp_dir, "o2.pdf")
        _tagged_pdf(src)
        set_struct_props(src, out, [0, 0], {"alt": "Chapter opener", "lang": "en-US"})
        node = get_struct_tree(out)["root"][0]["children"][0]
        assert node["alt"] == "Chapter opener"
        assert node["lang"] == "en-US"
        # Empty string clears — the key is deleted, not left as "".
        set_struct_props(out, out2, [0, 2], {"alt": ""})
        assert get_struct_tree(out2)["root"][0]["children"][2]["alt"] == ""
        with pikepdf.open(out2) as pdf:
            fig = pdf.Root["/StructTreeRoot"]["/K"][0]["/K"][2]
            assert "/Alt" not in fig

    def test_refusals(self, tmp_dir):
        src = os.path.join(tmp_dir, "s.pdf")
        _tagged_pdf(src)
        out = os.path.join(tmp_dir, "o.pdf")
        with pytest.raises(ValueError, match="type must not be empty"):
            set_struct_props(src, out, [0], {"type": "  "})
        with pytest.raises(ValueError, match="unknown properties"):
            set_struct_props(src, out, [0], {"bogus": "x"})
        with pytest.raises(ValueError, match="no properties"):
            set_struct_props(src, out, [0], {})
        with pytest.raises(ValueError, match="not the tree root"):
            set_struct_props(src, out, [], {"type": "P"})
        with pytest.raises(ValueError, match="out of range"):
            set_struct_props(src, out, [0, 9], {"type": "P"})


class TestMove:
    def test_swap_down_then_up(self, tmp_dir):
        src = os.path.join(tmp_dir, "s.pdf")
        out = os.path.join(tmp_dir, "o.pdf")
        out2 = os.path.join(tmp_dir, "o2.pdf")
        _tagged_pdf(src)
        move_struct_node(src, out, [0, 0], "down")
        assert _types(get_struct_tree(out)["root"][0]["children"]) == ["P", "H1", "Figure", "Sect"]
        move_struct_node(out, out2, [0, 1], "up")
        assert _types(get_struct_tree(out2)["root"][0]["children"]) == ["H1", "P", "Figure", "Sect"]

    def test_move_to_index(self, tmp_dir):
        src = os.path.join(tmp_dir, "s.pdf")
        out = os.path.join(tmp_dir, "o.pdf")
        out2 = os.path.join(tmp_dir, "o2.pdf")
        _tagged_pdf(src)
        # Sect [0,3] to the front — one atomic move past two siblings.
        move_struct_node(src, out, [0, 3], "to", index=0)
        assert _types(get_struct_tree(out)["root"][0]["children"]) == ["Sect", "H1", "P", "Figure"]
        # H1 (now [0,1]) to the end (index >= sibling count appends).
        move_struct_node(out, out2, [0, 1], "to", index=9)
        assert _types(get_struct_tree(out2)["root"][0]["children"]) == ["Sect", "P", "Figure", "H1"]

    def test_move_to_refusals(self, tmp_dir):
        src = os.path.join(tmp_dir, "s.pdf")
        _tagged_pdf(src)
        out = os.path.join(tmp_dir, "o.pdf")
        with pytest.raises(ValueError, match="needs an index"):
            move_struct_node(src, out, [0, 1], "to")
        with pytest.raises(ValueError, match="must not be negative"):
            move_struct_node(src, out, [0, 1], "to", index=-2)

    def test_boundary_refusals(self, tmp_dir):
        src = os.path.join(tmp_dir, "s.pdf")
        _tagged_pdf(src)
        out = os.path.join(tmp_dir, "o.pdf")
        with pytest.raises(ValueError, match="already first"):
            move_struct_node(src, out, [0, 0], "up")
        with pytest.raises(ValueError, match="already last"):
            move_struct_node(src, out, [0, 3], "down")
        with pytest.raises(ValueError, match="direction"):
            move_struct_node(src, out, [0, 0], "sideways")

    def test_indent_nests_under_previous_sibling(self, tmp_dir):
        src = os.path.join(tmp_dir, "s.pdf")
        out = os.path.join(tmp_dir, "o.pdf")
        _tagged_pdf(src)
        # P [0,1] nests under H1 [0,0].
        move_struct_node(src, out, [0, 1], "indent")
        r = get_struct_tree(out)
        kids = r["root"][0]["children"]
        assert _types(kids) == ["H1", "Figure", "Sect"]
        assert _types(kids[0]["children"]) == ["P"]
        # /P updated to the new parent.
        with pikepdf.open(out) as pdf:
            h1 = pdf.Root["/StructTreeRoot"]["/K"][0]["/K"][0]
            moved = [k for k in h1["/K"] if isinstance(k, pikepdf.Dictionary)][0]
            assert moved["/P"].objgen == h1.objgen

    def test_indent_first_refused(self, tmp_dir):
        src = os.path.join(tmp_dir, "s.pdf")
        _tagged_pdf(src)
        with pytest.raises(ValueError, match="no previous sibling"):
            move_struct_node(src, os.path.join(tmp_dir, "o.pdf"), [0, 0], "indent")

    def test_outdent_lifts_after_parent(self, tmp_dir):
        src = os.path.join(tmp_dir, "s.pdf")
        out = os.path.join(tmp_dir, "o.pdf")
        _tagged_pdf(src)
        # The Sect's P [0,3,0] becomes Document's child right after Sect.
        move_struct_node(src, out, [0, 3, 0], "outdent")
        r = get_struct_tree(out)
        kids = r["root"][0]["children"]
        assert _types(kids) == ["H1", "P", "Figure", "Sect", "P"]
        assert kids[3]["children"] == []
        with pikepdf.open(out) as pdf:
            doc = pdf.Root["/StructTreeRoot"]["/K"][0]
            lifted = doc["/K"][4]
            assert lifted["/P"].objgen == doc.objgen

    def test_outdent_top_level_refused(self, tmp_dir):
        src = os.path.join(tmp_dir, "s.pdf")
        _tagged_pdf(src)
        with pytest.raises(ValueError, match="already at the top level"):
            move_struct_node(src, os.path.join(tmp_dir, "o.pdf"), [0], "outdent")


class TestDelete:
    def test_delete_subtree_prunes_parent_tree(self, tmp_dir):
        src = os.path.join(tmp_dir, "s.pdf")
        out = os.path.join(tmp_dir, "o.pdf")
        _tagged_pdf(src)
        r = delete_struct_node(src, out, [0, 3])  # the Sect (and its P)
        assert r["removed"] == 2
        listing = get_struct_tree(out)
        assert listing["count"] == 4
        assert _types(listing["root"][0]["children"]) == ["H1", "P", "Figure"]
        with pikepdf.open(out) as pdf:
            assert len(pdf.pages) == 2  # content untouched
            nums = pdf.Root["/StructTreeRoot"]["/ParentTree"]["/Nums"]
            # Page 2's StructParents array entry is nulled, not left dangling.
            assert nums[3][0] is None

    def test_delete_middle_keeps_siblings(self, tmp_dir):
        src = os.path.join(tmp_dir, "s.pdf")
        out = os.path.join(tmp_dir, "o.pdf")
        _tagged_pdf(src)
        delete_struct_node(src, out, [0, 1])
        listing = get_struct_tree(out)
        assert _types(listing["root"][0]["children"]) == ["H1", "Figure", "Sect"]
        with pikepdf.open(out) as pdf:
            nums = pdf.Root["/StructTreeRoot"]["/ParentTree"]["/Nums"]
            arr = nums[1]
            assert arr[0] is not None and arr[1] is None and arr[2] is not None


class TestAdd:
    def test_add_at_index_and_end(self, tmp_dir):
        src = os.path.join(tmp_dir, "s.pdf")
        out = os.path.join(tmp_dir, "o.pdf")
        out2 = os.path.join(tmp_dir, "o2.pdf")
        _tagged_pdf(src)
        r = add_struct_node(src, out, [0], "H2", index=1)
        assert r["path"] == [0, 1]
        assert _types(get_struct_tree(out)["root"][0]["children"]) == [
            "H1", "H2", "P", "Figure", "Sect",
        ]
        r2 = add_struct_node(out, out2, [], "Part")
        assert r2["path"] == [1]
        assert _types(get_struct_tree(out2)["root"]) == ["Document", "Part"]

    def test_new_elem_shape(self, tmp_dir):
        src = os.path.join(tmp_dir, "s.pdf")
        out = os.path.join(tmp_dir, "o.pdf")
        _tagged_pdf(src)
        add_struct_node(src, out, [0, 3], "Div")
        with pikepdf.open(out) as pdf:
            sect = pdf.Root["/StructTreeRoot"]["/K"][0]["/K"][3]
            div = sect["/K"][1]
            assert str(div["/S"]) == "/Div"
            assert str(div["/Type"]) == "/StructElem"
            assert div["/P"].objgen == sect.objgen

    def test_refusals(self, tmp_dir):
        src = os.path.join(tmp_dir, "s.pdf")
        _tagged_pdf(src)
        out = os.path.join(tmp_dir, "o.pdf")
        with pytest.raises(ValueError, match="type must not be empty"):
            add_struct_node(src, out, [0], "")
        with pytest.raises(ValueError, match="must not be negative"):
            add_struct_node(src, out, [0], "P", index=-1)


class TestUntagged:
    def test_all_mutations_refuse(self, tmp_dir):
        src = os.path.join(tmp_dir, "p.pdf")
        _plain_pdf(src)
        out = os.path.join(tmp_dir, "o.pdf")
        for call in (
            lambda: set_struct_props(src, out, [0], {"type": "P"}),
            lambda: move_struct_node(src, out, [0], "up"),
            lambda: delete_struct_node(src, out, [0]),
            lambda: add_struct_node(src, out, [], "P"),
        ):
            with pytest.raises(ValueError, match="untagged"):
                call()


class TestSameFile:
    def test_in_place_edit(self, tmp_dir):
        src = os.path.join(tmp_dir, "s.pdf")
        _tagged_pdf(src)
        set_struct_props(src, src, [0, 0], {"type": "H3"})
        assert get_struct_tree(src)["root"][0]["children"][0]["type"] == "H3"
