"""The structure tree as the accessibility checker needs to read it.

`get_struct_tree` lists the tree for an editor: types, the four text
properties, and the content each element references. A conformance check needs
three things that listing does not carry:

  * **attribute dictionaries** — `/A` holds `/Scope`, `/Headers`, `/Summary`,
    `/ColSpan` and `/RowSpan`, singly or as an array, optionally paired with
    revision numbers and keyed by an owner (`/O /Table`). Producers also write
    those keys directly on the element, so both places are read and the
    attribute dictionaries win;
  * **resolved OBJR targets** — an `/OBJR` names an annotation, and "is this
    annotation tagged" is a question about which one;
  * **resolved roles and heading levels** — through `/RoleMap`, and for the
    generic `H` through nesting depth.

The last of those is `derived_nav`'s, and it is IMPORTED rather than rewritten:
two implementations of one levelling rule drift the moment nothing compares
them. Paths are `get_struct_tree`'s own numbering, so a finding addresses the
node the Tags panel selects.
"""

from __future__ import annotations

import pikepdf

from engine.derived_nav import (
    _GROUPING,
    _NUMBERED,
    MAX_LEVEL,
    _elem_tag,
    _resolve_role,
    _role_map,
)
from engine.struct_nesting import (
    CONTENT_MODEL as _CONTENT_MODEL,
    ROOT as _ROOT_ROLE,
    TRANSPARENT as _TRANSPARENT,
    effective_parent,
)
from engine.struct_tree import _is_elem, _kids, _MAX_DEPTH, _page_map, _page_no

# Table attributes, wherever they are spelled. The key is the PDF name; the
# value is how the audit reports it.
_TABLE_ATTRS = ("/Scope", "/Headers", "/Summary", "/ColSpan", "/RowSpan")

# The roles the table checks walk. `THead`/`TBody`/`TFoot` are row groups: a
# `TR` inside one is inside its table.
ROW_GROUPS = frozenset({"THead", "TBody", "TFoot"})
CELLS = frozenset({"TH", "TD"})


class Node:
    """One structure element, resolved."""

    __slots__ = (
        "path", "tag", "role", "level", "alt", "actual_text", "has_actual_text",
        "title", "lang", "attrs", "page", "mcids", "objrs", "children", "parent",
        "sid", "ns",
    )

    def __init__(self, path, tag, role, level):
        self.path = path
        self.tag = tag
        self.role = role
        self.level = level
        # The namespace name this element declares, or "" for the absent /NS
        # case, which ISO 32000-2 14.8.6.1 places in the default standard
        # structure namespace rather than in none.
        self.ns = ""
        # The element's own /ID, which is what a cell's /Headers array names.
        self.sid = None
        self.alt = ""
        self.actual_text = ""
        # `/ActualText` is a replacement, not a description (ISO 32000-2
        # 14.9.4), so the EMPTY string is a statement — the content's text
        # equivalent is nothing — and differs from the entry being absent.
        self.has_actual_text = False
        self.title = ""
        self.lang = ""
        self.attrs: dict = {}
        self.page = None
        self.mcids: list = []
        # Resolved annotation addresses: {"page": n, "index": i} per /OBJR,
        # with index None when the target is not on any page's /Annots.
        self.objrs: list = []
        self.children: list = []
        self.parent = None

    def descendants(self):
        for child in self.children:
            yield child
            yield from child.descendants()

    def has_content(self) -> bool:
        """Does this element or any descendant reference page content?"""
        if self.mcids or self.objrs:
            return True
        return any(n.mcids or n.objrs for n in self.descendants())

    def ancestors(self):
        node = self.parent
        while node is not None:
            yield node
            node = node.parent


def _present(elem, key: str) -> bool:
    try:
        return elem.get(key) is not None
    except Exception:
        return False


def _text(elem, key: str) -> str:
    value = elem.get(key)
    if value is None:
        return ""
    try:
        return str(value).strip()
    except Exception:
        return ""


def _attr_dicts(elem) -> list:
    """Every attribute dictionary on an element, in declaration order.

    `/A` is a dictionary, or an array which may interleave dictionaries with
    the revision integers that qualify them. Both shapes reduce to a list of
    dictionaries; a stream-valued attribute set is skipped rather than
    guessed at.
    """
    value = elem.get("/A")
    if value is None:
        return []
    out: list = []
    items = list(value) if isinstance(value, pikepdf.Array) else [value]
    for item in items:
        if isinstance(item, pikepdf.Dictionary) and not isinstance(item, pikepdf.Stream):
            out.append(item)
    return out


def _read_attrs(elem) -> dict:
    """The table attributes this element declares, from `/A` first and from
    direct keys second. A direct key is what several producers write and the
    spec does not forbid reading; an `/A` entry is the spec's own place, so it
    wins when both are present."""
    out: dict = {}
    for key in _TABLE_ATTRS:
        value = elem.get(key)
        if value is not None:
            out[key.lstrip("/")] = value
    for attrs in _attr_dicts(elem):
        for key in _TABLE_ATTRS:
            value = attrs.get(key)
            if value is not None:
                out[key.lstrip("/")] = value
    return out


def annots_of(pdf) -> tuple:
    """Every `/Annots` entry that resolves to an annotation, and the reads that
    did not complete.

    The one place this repository decides what an `/Annots` entry IS. Each
    entry is {"page": 1-based, "index": position, "obj": the dictionary}.

    A **null** entry references no object (ISO 32000-2 §7.3.9), so it is
    nothing to read rather than something left unread and it is skipped in
    silence. A **non-null** entry that is not a dictionary, a list that will
    not enumerate, and a `/Annots` that will not read at all are each named in
    the second return, because a reader that mistook them for a page with no
    annotations would report a clean claim over a page it never saw.
    """
    out: list = []
    unread: list = []
    for i, page in enumerate(pdf.pages):
        try:
            annots = page.obj.get("/Annots")
        except Exception as exc:
            unread.append({"page": i + 1, "reason": str(exc)})
            continue
        if annots is None:
            continue
        try:
            items = list(annots)
        except Exception as exc:
            unread.append({"page": i + 1, "reason": str(exc)})
            continue
        for j, annot in enumerate(items):
            if annot is None:
                continue
            if not isinstance(annot, pikepdf.Dictionary):
                unread.append(
                    {"page": i + 1, "reason": f"annotation {j} is not a dictionary"}
                )
                continue
            out.append({"page": i + 1, "index": j, "obj": annot})
    return out, unread


def _annot_index(entries: list) -> dict:
    """objgen → {"page": 1-based, "index": position in /Annots}."""
    out: dict = {}
    for entry in entries:
        try:
            og = entry["obj"].objgen
        except Exception:
            continue
        if og != (0, 0):
            out[og] = {"page": entry["page"], "index": entry["index"]}
    return out


def _namespace_of(elem) -> str:
    """The namespace name an element declares, through its `/NS` entry.

    `/NS` is an indirect reference to a namespace dictionary whose own `/NS`
    entry is the name (ISO 32000-2 Table 356). An absent entry is the default
    standard structure namespace, which is a namespace rather than a gap, so it
    reads as the empty string and the caller resolves the default.
    """
    value = elem.get("/NS")
    if value is None:
        return ""
    if not isinstance(value, pikepdf.Dictionary):
        raise ValueError("the /NS entry is not a namespace dictionary")
    name = value.get("/NS")
    if name is None:
        raise ValueError("the namespace dictionary declares no name")
    return str(name)


def _scope_of(value) -> str:
    # An absent attribute is no scope. Rendering it through `str` yields the
    # four characters "None", which every caller reads as a declared value —
    # so a TH carrying no /Scope answers as though it carried one.
    if value is None:
        return ""
    try:
        return str(value).lstrip("/")
    except Exception:
        return ""


def span_of(node: Node, key: str) -> tuple:
    """A cell's `/ColSpan` or `/RowSpan`, and whether that is a measurement.

    Returns (span, read). An absent value is the spec's own default of 1 and
    IS a measurement. A value that is not a positive integer is 1 with `read`
    false: the arithmetic still has a number to carry, so a malformed span is
    never a reason to report a regular table as ragged, but the caller can no
    longer present the width it computes as one it measured.
    """
    value = node.attrs.get(key)
    if value is None:
        return 1, True
    try:
        span = int(value)
    except (TypeError, ValueError):
        return 1, False
    if span < 1:
        return 1, False
    return span, True


def audit_tree(pdf, annots_entries: list | None = None) -> dict:
    """The resolved structure tree.

    Returns {"tagged", "nodes" (flat, tree order), "roots", "role_map",
    "annots" (objgen → address), "tagged_mcids" (page → set), "tagged_annots"
    (set of objgen), "truncated" (the elements whose children the walk did not
    reach), "ns_unread" (the elements whose `/NS` would not resolve)}.

    `annots_entries` is `annots_of`'s first return. A caller that has already
    read the annotations passes them so `/OBJR` targets resolve against the
    same list the caller addresses findings by; a caller that has not reads
    them here, through the same one reader.

    The walk is BOUNDED — by `_MAX_DEPTH` and by the visited-set cycle guard —
    so `nodes` is not always the whole tree. `truncated` names every element
    whose children were left unwalked, which is what stops a caller reading a
    partial walk as a complete answer.
    """
    st = pdf.Root.get("/StructTreeRoot")
    if st is None:
        return {
            "tagged": False, "nodes": [], "roots": [], "role_map": {},
            "tagged_mcids": {}, "tagged_annots": set(), "truncated": [],
            "ns_unread": [],
        }

    role_map = _role_map(st)
    pages_by_og = _page_map(pdf)
    annots = _annot_index(
        annots_entries if annots_entries is not None else annots_of(pdf)[0]
    )
    nodes: list = []
    roots: list = []
    tagged_mcids: dict = {}
    tagged_annots: set = set()
    truncated: list = []
    ns_unread: list = []
    visited: set = set()

    def content_of(elem, node: Node, own_page):
        for kid in _kids(elem):
            if _is_elem(kid):
                continue
            if isinstance(kid, int):
                if own_page is not None:
                    node.mcids.append({"page": own_page, "mcid": int(kid)})
                continue
            if not isinstance(kid, pikepdf.Dictionary):
                continue
            try:
                kind = str(kid.get("/Type")) if kid.get("/Type") is not None else ""
            except Exception:
                continue
            if kind == "/MCR" and kid.get("/MCID") is not None:
                # A /Stm reference is inside a form XObject, whose MCID
                # numbering is that stream's — recorded, but not against the
                # page's numbering, which is what the coverage check compares.
                page = _page_no(pages_by_og, kid.get("/Pg"), own_page)
                if page is not None:
                    node.mcids.append(
                        {
                            "page": page,
                            "mcid": int(kid.get("/MCID")),
                            "form": kid.get("/Stm") is not None,
                        }
                    )
            elif kind == "/OBJR":
                target = kid.get("/Obj")
                address = None
                if target is not None:
                    try:
                        address = annots.get(target.objgen)
                        if target.objgen != (0, 0):
                            tagged_annots.add(target.objgen)
                    except Exception:
                        address = None
                node.objrs.append(
                    address
                    if address is not None
                    else {"page": _page_no(pages_by_og, kid.get("/Pg"), own_page),
                          "index": None}
                )

    def walk(elem, path, parent, inherited_page, group_depth, depth, recurse=True):
        tag = _elem_tag(elem)
        role = _resolve_role(tag, role_map)
        level = None
        if role in _NUMBERED:
            level = _NUMBERED[role]
        elif role == "H":
            level = min(max(group_depth, 1), MAX_LEVEL)
        node = Node(path, tag, role, level)
        node.parent = parent
        node.alt = _text(elem, "/Alt")
        node.actual_text = _text(elem, "/ActualText")
        node.has_actual_text = _present(elem, "/ActualText")
        node.title = _text(elem, "/T")
        node.lang = _text(elem, "/Lang")
        node.attrs = _read_attrs(elem)
        try:
            raw_id = elem.get("/ID")
            node.sid = bytes(raw_id) if raw_id is not None else None
        except Exception:
            node.sid = None
        own_page = _page_no(pages_by_og, elem.get("/Pg"), inherited_page)
        node.page = own_page
        try:
            node.ns = _namespace_of(elem)
        except Exception as exc:
            # A namespace that will not resolve is not the default namespace:
            # which rule set governs the element is exactly what was not read.
            node.ns = None
            ns_unread.append({"path": [int(v) for v in path], "page": own_page,
                              "reason": str(exc)})
        content_of(elem, node, own_page)
        for ref in node.mcids:
            if ref.get("form"):
                continue
            tagged_mcids.setdefault(ref["page"], set()).add(ref["mcid"])
        nodes.append(node)

        if recurse and depth < _MAX_DEPTH:
            next_group = group_depth + 1 if role in _GROUPING else group_depth
            child_idx = 0
            for kid in _kids(elem):
                if not _is_elem(kid):
                    continue
                fresh = True
                try:
                    og = kid.objgen
                    if og != (0, 0):
                        fresh = og not in visited
                        visited.add(og)
                except Exception:
                    pass
                node.children.append(
                    walk(kid, [*path, child_idx], node, own_page, next_group,
                         depth + 1, recurse=fresh)
                )
                child_idx += 1
        elif any(_is_elem(kid) for kid in _kids(elem)):
            truncated.append(
                {
                    "path": [int(v) for v in path],
                    "page": own_page,
                    "reason": "depth" if depth >= _MAX_DEPTH else "shared",
                }
            )
        return node

    idx = 0
    for kid in _kids(st):
        if not _is_elem(kid):
            continue
        fresh = True
        try:
            og = kid.objgen
            if og != (0, 0):
                fresh = og not in visited
                visited.add(og)
        except Exception:
            pass
        roots.append(walk(kid, [idx], None, None, 0, 1, recurse=fresh))
        idx += 1

    return {
        "tagged": True,
        "nodes": nodes,
        "roots": roots,
        "role_map": role_map,
        "tagged_mcids": tagged_mcids,
        "tagged_annots": tagged_annots,
        "truncated": truncated,
        "ns_unread": ns_unread,
    }


class Edge:
    """One element and the parent its placement is judged against.

    The parent is the EFFECTIVE one: ISO 32000-2 Table 365 makes `Part`, `Div`
    and `NonStruct` inherit their parent's containment requirements, so the
    ancestor a rule addresses is the nearest one outside that set. `index` and
    `sibling_roles` are taken from the DIRECT parent, because the positional
    rules are stated over the parent element's own children.

    `content_roles` is the other direction: the roles this element CONTAINS,
    read through the same inherited-containment set, for the types whose own
    entry states a content model. It is `None` where no model applies and
    where the subtree was not read; the two are told apart by the role.
    """

    __slots__ = ("node", "role", "ns", "parent_role", "ancestor_roles", "index",
                 "sibling_roles", "content_roles")

    def __init__(self, node, role, ns, parent_role, ancestor_roles, index,
                 sibling_roles, content_roles=None):
        self.node = node
        self.role = role
        self.ns = ns
        self.parent_role = parent_role
        self.ancestor_roles = ancestor_roles
        self.index = index
        self.sibling_roles = sibling_roles
        self.content_roles = content_roles


def _content_roles(node, truncated: set):
    """The roles a content model reaches inside `node`, in document order.

    The mirror of `effective_parent`: ISO 32000-2 Table 365 makes `Part`, `Div`
    and `NonStruct` inherit their parent's containment, so a container's
    content is the same list read from either end. `None` when the walk met an
    element whose own children were not read — a sequence rule judged over a
    partial sequence would fail a document for the reader's limit.
    """
    if tuple(node.path) in truncated:
        return None
    roles: list = []
    stack = list(reversed(node.children))
    while stack:
        child = stack.pop()
        if child.role in _TRANSPARENT:
            if tuple(child.path) in truncated:
                return None
            stack.extend(reversed(child.children))
            continue
        roles.append(child.role)
    return roles


def nesting_edges(tree: dict) -> tuple:
    """Every element paired with the parent its placement is judged against.

    Reads the tree `audit_tree` already built — roles are the `/RoleMap`
    resolved ones it recorded, so there is one resolver rather than a second
    copy. Returns (edges, unread), where `unread` names the elements whose
    namespace did not resolve: an element whose governing rule set is unknown
    is not an element that passed.
    """
    edges: list = []
    unread = list(tree.get("ns_unread") or [])
    truncated = {tuple(t["path"]) for t in tree.get("truncated") or []}
    for node in tree.get("nodes") or []:
        if node.ns is None:
            continue
        effective = effective_parent(node)
        ancestors = frozenset(a.role for a in node.ancestors())
        siblings = node.parent.children if node.parent is not None else tree["roots"]
        try:
            index = siblings.index(node)
        except ValueError:
            index = -1
        edges.append(
            Edge(
                node,
                node.role,
                node.ns,
                effective.role if effective is not None else _ROOT_ROLE,
                ancestors,
                index,
                [child.role for child in siblings],
                _content_roles(node, truncated) if node.role in _CONTENT_MODEL else None,
            )
        )
    return edges, unread


def tables(nodes: list) -> list:
    """The `Table` elements, each with its rows resolved.

    A row belongs to a table through at most one row group, which is the
    nesting every real table uses and the only one the row check accepts.
    """
    out = []
    for node in nodes:
        if node.role != "Table":
            continue
        rows = [n for n in node.descendants() if n.role == "TR"]
        out.append({"table": node, "rows": rows})
    return out


def row_cells(row: Node) -> list:
    """A row's cells in order. A cell nested inside a non-cell child (a `Span`
    wrapper) still belongs to the row, so the search is over descendants and
    stops at the first cell on each branch."""
    out: list = []

    def collect(node: Node):
        for child in node.children:
            if child.role in CELLS:
                out.append(child)
            else:
                collect(child)

    collect(row)
    return out


def headers_referenced(nodes: list) -> set:
    """The set of `/Headers` ids any cell points at. `/Headers` names header
    cells by their `/ID`, so the check is whether a `TH` is REACHED, not
    whether the array is well-formed."""
    out: set = set()
    for node in nodes:
        value = node.attrs.get("Headers")
        if value is None:
            continue
        items = list(value) if isinstance(value, pikepdf.Array) else [value]
        for item in items:
            try:
                out.add(bytes(item))
            except Exception:
                continue
    return out


def scope(node: Node) -> str:
    return _scope_of(node.attrs.get("Scope"))
