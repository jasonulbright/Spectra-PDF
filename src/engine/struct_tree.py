"""Logical structure tree — the Tags + Reading Order panels.

A tagged PDF carries its logical structure in the catalog's /StructTreeRoot: a
tree of structure elements (/S type, optional /T title, /Alt alternative text,
/ActualText, /Lang) whose leaves reference the page content they tag — integer
MCIDs (marked-content ids scoped to a page's content stream), /MCR
marked-content references, and /OBJR object references (annotations).
Assistive technology reads the document in TREE ORDER, which is why reordering
elements here is the reading-order edit.

Nodes are addressed by PATH: the sequence of struct-element child indexes from
the root (content items are skipped in the numbering — a path names elements,
not leaves). Paths are positional, like the layer/link index convention: every
mutation takes a path computed from the current tree and the panel refetches
after each edit, so a path never outlives the tree it was read from.

Mutations:
- set_struct_props — retag (/S) and set/clear /T, /Alt, /ActualText, /Lang.
  /Alt on a Figure is THE accessibility fix this panel exists for.
- move_struct_node — up/down swap the element with its adjacent sibling
  element; indent nests it under its previous sibling; outdent makes it the
  next sibling of its parent. The four compose to reach any tree shape.
- delete_struct_node — removes the element AND its descendant tags; the page
  content stays and merely becomes untagged.
  References to every removed element are nulled out of the /ParentTree so the
  reverse mapping never dangles.
- add_struct_node — creates an empty container element
  to retag/populate by moving existing elements into it.

Untagged documents (no /StructTreeRoot) list as tagged=False and every
mutation refuses cleanly — creating a tree from nothing is autotagging's job
(a separate capability), not a tree editor's.

NOTE (known gap): the renderer's page-tier commit rebuilds documents
via pdf-lib into a fresh catalog, which does not carry /StructTreeRoot — page
moves/deletes on a tagged file drop its tags today, tags edited here survive
every ENGINE path (pikepdf edits the tree in place). Same family as the
AcroForm carry; its own future arc.
"""

import shutil
import tempfile
from pathlib import Path

import pikepdf
from pikepdf import Array, Dictionary, Name, String
from engine.pdf_save import save_pdf

# Deep enough for any real document's nesting; combined with the visited-set
# cycle guard it bounds walks over malformed self-referential trees.
_MAX_DEPTH = 64

# The optional text properties set_struct_props manages, prop key → PDF key.
_TEXT_PROPS = {
    "title": "/T",
    "alt": "/Alt",
    "actual_text": "/ActualText",
    "lang": "/Lang",
}


def _root(pdf):
    st = pdf.Root.get("/StructTreeRoot")
    if st is None:
        raise ValueError("document has no structure tree (it is untagged)")
    return st


def _kids(node) -> list:
    """/K normalized to a list — it may be absent, a single item, or an array."""
    k = node.get("/K")
    if k is None:
        return []
    if isinstance(k, pikepdf.Array):
        return list(k)
    return [k]


def _is_elem(obj) -> bool:
    """A structure element among /K entries: a dictionary that is not a
    marked-content or object reference. /S is required by spec but /Type is
    optional, so the reference types are what get excluded, not non-/S dicts."""
    if not isinstance(obj, pikepdf.Dictionary):
        return False
    t = obj.get("/Type")
    if t is not None and str(t) in ("/MCR", "/OBJR"):
        return False
    return obj.get("/S") is not None or t is not None and str(t) == "/StructElem"


def _elem_positions(kids: list) -> list[int]:
    """K-array positions of the struct-element children, in order."""
    return [i for i, k in enumerate(kids) if _is_elem(k)]


def _walk_path(pdf, path: list) -> list:
    """Elements along `path` from the root; [] resolves to just the root
    container. Raises on any out-of-range step."""
    st = _root(pdf)
    chain = [st]
    node = st
    for depth, raw in enumerate(path):
        idx = int(raw)
        kids = _kids(node)
        positions = _elem_positions(kids)
        if not (0 <= idx < len(positions)):
            raise ValueError(
                f"path {list(path)} is out of range at step {depth} "
                f"(index {idx}, node has {len(positions)} child tags)"
            )
        node = kids[positions[idx]]
        chain.append(node)
    return chain


def _page_map(pdf) -> dict:
    return {page.obj.objgen: i for i, page in enumerate(pdf.pages)}


def _page_no(pages_by_og, ref, inherited):
    """1-based page for a /Pg reference, else the inherited page, else None."""
    if ref is not None:
        try:
            idx = pages_by_og.get(ref.objgen)
            if idx is not None:
                return idx + 1
        except Exception:
            pass
    return inherited


def _str_or_empty(node, key: str) -> str:
    v = node.get(key)
    if v is None:
        return ""
    try:
        return str(v)
    except Exception:
        return ""


def get_struct_tree(file: str) -> dict:
    """The full structure tree: nodes with path addressing, tag types, the
    text-alternative properties, and each node's DIRECT content references
    ({page, mcid} / {page, kind: 'objr'}) so the renderer can preview content
    and derive per-page reading order without a second engine call."""
    with pikepdf.open(file) as pdf:
        st = pdf.Root.get("/StructTreeRoot")
        if st is None:
            return {"tagged": False, "count": 0, "root": [], "role_map": {}}

        pages_by_og = _page_map(pdf)
        count = 0
        visited: set = set()

        def node_json(elem, path, inherited_page, depth, recurse=True):
            nonlocal count
            count += 1
            own_page = _page_no(pages_by_og, elem.get("/Pg"), inherited_page)
            content = []
            children = []
            if recurse and depth < _MAX_DEPTH:
                child_idx = 0
                for k in _kids(elem):
                    if _is_elem(k):
                        # A repeated element (a cycle, or an illegal shared
                        # child) is LISTED childless rather than skipped —
                        # skipping would renumber siblings and make listing
                        # paths disagree with the mutation walk's.
                        fresh = True
                        try:
                            og = k.objgen
                            if og != (0, 0):
                                fresh = og not in visited
                                visited.add(og)
                        except Exception:
                            pass
                        children.append(
                            node_json(k, [*path, child_idx], own_page, depth + 1, recurse=fresh)
                        )
                        child_idx += 1
                    elif isinstance(k, int):
                        if own_page is not None:
                            content.append({"page": own_page, "mcid": int(k)})
                    elif isinstance(k, pikepdf.Dictionary):
                        t = str(k.get("/Type")) if k.get("/Type") is not None else ""
                        pg = _page_no(pages_by_og, k.get("/Pg"), own_page)
                        if t == "/MCR" and k.get("/MCID") is not None and pg is not None:
                            content.append({"page": pg, "mcid": int(k.get("/MCID"))})
                        elif t == "/OBJR":
                            content.append({"page": pg, "kind": "objr"})
            return {
                "path": path,
                "type": _str_or_empty(elem, "/S").lstrip("/"),
                "title": _str_or_empty(elem, "/T"),
                "alt": _str_or_empty(elem, "/Alt"),
                "actual_text": _str_or_empty(elem, "/ActualText"),
                "lang": _str_or_empty(elem, "/Lang"),
                "content": content,
                "children": children,
            }

        root_nodes = []
        idx = 0
        for k in _kids(st):
            if not _is_elem(k):
                continue
            fresh = True
            try:
                og = k.objgen
                if og != (0, 0):
                    fresh = og not in visited
                    visited.add(og)
            except Exception:
                pass
            root_nodes.append(node_json(k, [idx], None, 1, recurse=fresh))
            idx += 1

        role_map = {}
        rm = st.get("/RoleMap")
        if rm is not None and isinstance(rm, pikepdf.Dictionary):
            for key, value in rm.items():
                try:
                    role_map[str(key).lstrip("/")] = str(value).lstrip("/")
                except Exception:
                    continue

        return {"tagged": True, "count": count, "root": root_nodes, "role_map": role_map}


def set_struct_props(file: str, output: str, path: list, props: dict) -> dict:
    """Set the tag type and/or text-alternative properties of one element.
    `props` keys: type (non-empty), title/alt/actual_text/lang (empty clears)."""
    if not path:
        raise ValueError("path must name an element, not the tree root")
    if not props:
        raise ValueError("no properties to set")
    unknown = set(props) - {"type", *_TEXT_PROPS}
    if unknown:
        raise ValueError(f"unknown properties: {sorted(unknown)}")
    input_path, output_path = Path(file), Path(output)
    same_file = input_path.resolve() == output_path.resolve()
    with pikepdf.open(file) as pdf:
        elem = _walk_path(pdf, path)[-1]
        if "type" in props:
            new_type = str(props["type"]).strip().lstrip("/")
            if not new_type:
                raise ValueError("type must not be empty")
            elem[Name.S] = Name("/" + new_type)
        for prop, pdf_key in _TEXT_PROPS.items():
            if prop not in props:
                continue
            value = str(props[prop])
            if value:
                elem[Name(pdf_key)] = String(value)
            elif pdf_key in elem:
                del elem[Name(pdf_key)]
        _save(pdf, input_path, output_path, same_file)
    return {"output": str(output_path), "path": list(path)}


def _write_kids(node, kids: list) -> None:
    node[Name.K] = Array(kids)


def move_struct_node(file: str, output: str, path: list, direction: str, index=None) -> dict:
    """Reorder or renest one element: up/down swap with the adjacent sibling
    tag, indent nests under the previous sibling, outdent lifts it to be the
    parent's next sibling, and `to` (with `index`) moves it to sibling
    position `index` in ONE atomic step — the Reading Order panel's move,
    where the page-order neighbor may be a non-adjacent sibling."""
    if not path:
        raise ValueError("path must name an element, not the tree root")
    if direction not in ("up", "down", "indent", "outdent", "to"):
        raise ValueError("direction must be one of up, down, indent, outdent, to")
    if direction == "to" and index is None:
        raise ValueError("direction 'to' needs an index")
    input_path, output_path = Path(file), Path(output)
    same_file = input_path.resolve() == output_path.resolve()
    with pikepdf.open(file) as pdf:
        chain = _walk_path(pdf, path)
        elem = chain[-1]
        parent = chain[-2]  # the StructTreeRoot for a top-level element
        kids = _kids(parent)
        positions = _elem_positions(kids)
        child_idx = int(path[-1])
        pos = positions[child_idx]

        if direction in ("up", "down"):
            other_idx = child_idx - 1 if direction == "up" else child_idx + 1
            if not (0 <= other_idx < len(positions)):
                which = "first" if direction == "up" else "last"
                raise ValueError(f"the tag is already {which} among its siblings")
            other_pos = positions[other_idx]
            kids[pos], kids[other_pos] = kids[other_pos], kids[pos]
            _write_kids(parent, kids)
        elif direction == "to":
            target = int(index)
            if target < 0:
                raise ValueError("index must not be negative")
            del kids[pos]
            remaining = _elem_positions(kids)
            if target >= len(remaining):
                kids.append(elem)
            else:
                kids.insert(remaining[target], elem)
            _write_kids(parent, kids)
        elif direction == "indent":
            if child_idx == 0:
                raise ValueError("no previous sibling tag to nest under")
            new_parent = kids[positions[child_idx - 1]]
            del kids[pos]
            _write_kids(parent, kids)
            np_kids = _kids(new_parent)
            np_kids.append(elem)
            _write_kids(new_parent, np_kids)
            elem[Name.P] = new_parent
        else:  # outdent
            if len(chain) < 3:
                raise ValueError("the tag is already at the top level")
            grandparent = chain[-3]
            del kids[pos]
            _write_kids(parent, kids)
            # The parent's own K-position comes from the PATH (path[-2] is its
            # child index in the grandparent) — deterministic, unlike an objgen
            # re-scan, which a direct-object parent would ambiguate.
            gp_kids = _kids(grandparent)
            parent_pos = _elem_positions(gp_kids)[int(path[-2])]
            gp_kids.insert(parent_pos + 1, elem)
            _write_kids(grandparent, gp_kids)
            elem[Name.P] = grandparent
        _save(pdf, input_path, output_path, same_file)
    return {"output": str(output_path), "path": list(path), "direction": direction}


def _collect_elem_objgens(elem, out: set) -> None:
    try:
        og = elem.objgen
        if og != (0, 0):
            if og in out:
                return
            out.add(og)
    except Exception:
        pass
    for k in _kids(elem):
        if _is_elem(k):
            _collect_elem_objgens(k, out)


def _prune_parent_tree(node, dead: set, visited: set) -> None:
    """Null out references to deleted elements in a /ParentTree number-tree
    node (arrays keep their index alignment — /StructParents indexes by MCID)."""
    try:
        og = node.objgen
        if og != (0, 0):
            if og in visited:
                return
            visited.add(og)
    except Exception:
        pass
    nums = node.get("/Nums")
    if nums is not None:
        for i in range(1, len(nums), 2):
            value = nums[i]
            if isinstance(value, pikepdf.Array):
                for j, ref in enumerate(value):
                    try:
                        if isinstance(ref, pikepdf.Dictionary) and ref.objgen in dead:
                            value[j] = None
                    except Exception:
                        continue
            else:
                try:
                    if isinstance(value, pikepdf.Dictionary) and value.objgen in dead:
                        nums[i] = None
                except Exception:
                    continue
    pt_kids = node.get("/Kids")
    if pt_kids is not None:
        for kid in pt_kids:
            _prune_parent_tree(kid, dead, visited)


def delete_struct_node(file: str, output: str, path: list) -> dict:
    """Delete one element and its descendant tags. The tagged page content
    stays — it merely becomes untagged."""
    if not path:
        raise ValueError("path must name an element, not the tree root")
    input_path, output_path = Path(file), Path(output)
    same_file = input_path.resolve() == output_path.resolve()
    with pikepdf.open(file) as pdf:
        chain = _walk_path(pdf, path)
        elem = chain[-1]
        parent = chain[-2]
        kids = _kids(parent)
        positions = _elem_positions(kids)
        pos = positions[int(path[-1])]

        dead: set = set()
        _collect_elem_objgens(elem, dead)
        del kids[pos]
        _write_kids(parent, kids)

        st = _root(pdf)
        pt = st.get("/ParentTree")
        if pt is not None and dead:
            _prune_parent_tree(pt, dead, set())
        _save(pdf, input_path, output_path, same_file)
    return {"output": str(output_path), "path": list(path), "removed": len(dead) or 1}


def add_struct_node(file: str, output: str, parent_path: list, stype: str, index=None) -> dict:
    """Create an empty element under `parent_path`
    ([] = the tree root) at child position `index` (default: last)."""
    new_type = str(stype).strip().lstrip("/")
    if not new_type:
        raise ValueError("type must not be empty")
    input_path, output_path = Path(file), Path(output)
    same_file = input_path.resolve() == output_path.resolve()
    with pikepdf.open(file) as pdf:
        parent = _walk_path(pdf, parent_path)[-1]
        elem = pdf.make_indirect(
            Dictionary(Type=Name.StructElem, S=Name("/" + new_type), P=parent)
        )
        kids = _kids(parent)
        positions = _elem_positions(kids)
        if index is None or int(index) >= len(positions):
            kids.append(elem)
            new_idx = len(positions)
        else:
            idx = int(index)
            if idx < 0:
                raise ValueError("index must not be negative")
            kids.insert(positions[idx], elem)
            new_idx = idx
        _write_kids(parent, kids)
        _save(pdf, input_path, output_path, same_file)
    return {"output": str(output_path), "path": [*list(parent_path), new_idx], "type": new_type}


def _save(pdf, input_path: Path, output_path: Path, same_file: bool) -> None:
    if same_file:
        with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False, dir=str(input_path.parent)) as tmp:
            tmp_path = tmp.name
        save_pdf(pdf, tmp_path)
        shutil.move(tmp_path, str(output_path))
    else:
        save_pdf(pdf, output_path)
