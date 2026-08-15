"""Bind EXISTING page content and annotations into the structure tree.

Every other structure door edits a tree that already covers the content it
names. This one is the opposite case, and the only capability in the
accessibility round that rewrites a content stream: text drawn inside no
marked-content section has **no MCID at all**, so binding it to a tag means
wrapping it in marked content first. That is autotag's per-segment machinery
(`autotag.py` — emit `BDC … EMC`, create the element, extend `/StructParents`
and the `/ParentTree`) aimed at ONE addressed run on a page that may already be
tagged.

Four rules, each of which is a bug if missed:

1. **MCIDs are allocated above the page's existing maximum**, and the page's
   `/StructParents` key is reused when it has one and allocated from
   `/ParentTreeNextKey` when it does not. Re-using an MCID silently retargets
   an existing tag.
2. **`Artifact` writes `/Artifact BMC … EMC` and creates no element.** An
   artifact is a positive statement that content is NOT content, which is
   exactly what `text_runs` reads back.
3. **A run inside a Form XObject is refused BY NAME**, never silently skipped:
   MCIDs are scoped to their content stream, and the same form drawn twice
   cannot carry a page-scoped id.
4. **The annotation half writes both directions** — an `/OBJR` inside the new
   element AND the annotation's `/StructParent` into the `/ParentTree`. One
   without the other is a tree that reads correctly and reverse-maps wrongly.

Run indexes are `list_text_runs`' own: the traversal here walks the page in the
same order and recurses at the same `Do` positions, so the numbering agrees by
construction rather than by a parallel implementation.

New elements are inserted in STREAM ORDER among their siblings rather than
appended, so a paragraph bound here reads where it is drawn instead of at the
end of the document. Reading order beyond that is the Reading Order panel's.
"""

from __future__ import annotations

from pathlib import Path

import pikepdf
from pikepdf import Array, Dictionary, Name

from engine.incremental import signature_policy, signed_edit_decision
from engine.inplace import finish_staged, is_same_file, staging_target
from engine.pdf_save import save_pdf
from engine.redact import IDENTITY, _resolve_resources
from engine.struct_audit import audit_tree
from engine.struct_tree import _elem_positions, _is_elem, _kids, _write_kids
from engine.text_metrics import _FontCache
from engine.text_runs import MAX_FORM_DEPTH, SHOW_OPS, _lookup_xobject, _walk_runs

# The roles this door will bind content to. Anything outside the standard set
# would produce a tree whose tag names mean nothing without a /RoleMap, which
# is a document-wide decision rather than a per-run one.
STANDARD_ROLES = frozenset(
    {
        "P", "H1", "H2", "H3", "H4", "H5", "H6", "H", "Span", "Quote", "Note",
        "Caption", "Figure", "Formula", "Lbl", "LBody", "LI", "L", "TH", "TD",
        "TR", "Table", "Div", "Sect", "Art", "Part", "BlockQuote", "TOC",
        "TOCI", "Index", "Code", "Link", "Annot", "Form", "Reference",
    }
)

# The role that creates no element. It is not in STANDARD_ROLES because it is
# not a structure type at all — it is the statement that this content has none.
ARTIFACT = "Artifact"

# Grouping roles a document's single root is, when it has one. A new element
# belongs INSIDE that container, not beside it.
_CONTAINERS = frozenset({"Document", "Part", "Art", "Sect", "Div"})


def _page_mcids(instructions) -> set:
    """Every MCID this page's OWN stream already uses.

    Form XObjects are deliberately not descended into: their marked content is
    numbered in their own stream and reaches the tree through `/MCR /Stm`, so
    it neither collides with nor bounds the page's numbering.
    """
    used: set = set()
    for instruction in instructions:
        if str(instruction.operator) != "BDC":
            continue
        operands = list(instruction.operands)
        if len(operands) < 2 or not isinstance(operands[1], pikepdf.Dictionary):
            continue
        value = operands[1].get("/MCID")
        if value is None:
            continue
        try:
            used.add(int(value))
        except (TypeError, ValueError):
            continue
    return used


class _Positions:
    """Where each run index sits, in the page's own instruction list.

    The walk mirrors `text_runs._walk_runs`: show operators number in stream
    order and a form XObject is recursed at its `Do` position, so a run index
    here names the same run it names there.
    """

    def __init__(self, pdf, page):
        self.at: dict = {}
        self.in_form: dict = {}
        self.instructions = list(pikepdf.parse_content_stream(page))
        resources = _resolve_resources(page)
        self._index = 0
        self._scan(self.instructions, resources, resources, 0, None, top=True)

    def _scan(self, instructions, resources, fallback, depth, form_name, top):
        for position, instruction in enumerate(instructions):
            operator = str(instruction.operator)
            operands = list(instruction.operands)
            if operator in SHOW_OPS:
                if top:
                    self.at[self._index] = position
                else:
                    self.in_form[self._index] = form_name
                self._index += 1
                continue
            if operator != "Do":
                continue
            name = str(operands[0]) if operands else None
            xobj = _lookup_xobject(name, resources, fallback)
            if xobj is None or str(xobj.get("/Subtype", "")) != "/Form":
                continue
            if depth >= MAX_FORM_DEPTH:
                continue
            form_resources = xobj.get("/Resources")
            self._scan(
                list(pikepdf.parse_content_stream(xobj)),
                form_resources if form_resources is not None else resources,
                resources,
                depth + 1,
                form_name or name,
                top=False,
            )

    @property
    def total(self) -> int:
        return self._index


def _number_tree_pairs(node, out: dict, seen: set) -> None:
    """Flatten a `/ParentTree` number tree to {key: value}."""
    try:
        og = node.objgen
        if og != (0, 0):
            if og in seen:
                return
            seen.add(og)
    except Exception:
        pass
    nums = node.get("/Nums")
    if nums is not None:
        for i in range(0, len(nums) - 1, 2):
            try:
                out[int(nums[i])] = nums[i + 1]
            except (TypeError, ValueError):
                continue
    kids = node.get("/Kids")
    if kids is not None:
        for kid in kids:
            _number_tree_pairs(kid, out, seen)


def _write_parent_tree(pdf, st, pairs: dict) -> None:
    """Write the pairs back as ONE flat `/Nums`.

    A number tree root may carry `/Nums` directly (ISO 32000 §7.9.7), so
    flattening is spec-correct and deterministic — and it is the only way to
    add a key to a tree whose leaves carry `/Limits` without re-balancing it.
    """
    nums = Array()
    for key in sorted(pairs):
        nums.append(int(key))
        nums.append(pairs[key])
    st[Name.ParentTree] = pdf.make_indirect(Dictionary(Nums=nums))


def _container(st):
    """(element, path) new tags belong under: the document's single root
    container, or the tree root itself when it has none.

    The PATH is what pairs the container with the audit's own numbering, which
    is `get_struct_tree`'s — so sibling order is read off the same addressing
    every other structure surface uses rather than by re-matching objects.
    """
    roots = [k for k in _kids(st) if _is_elem(k)]
    if len(roots) == 1:
        try:
            tag = str(roots[0].get("/S") or "").lstrip("/")
        except Exception:
            tag = ""
        if tag in _CONTAINERS:
            return roots[0], (0,)
    return st, ()


def _sibling_order(tree, container_path: tuple, page_no: int, mcid_run: dict) -> list:
    """For each direct element child of the container, the smallest run index
    its subtree covers on this page — or None where it covers none.

    This is what puts a newly bound paragraph where it is DRAWN rather than at
    the end of the tree.
    """
    by_path = {tuple(int(v) for v in n.path): n for n in tree["nodes"]}
    order: list = []
    position = 0
    while True:
        node = by_path.get((*container_path, position))
        if node is None:
            return order
        found = None
        for ref in [*node.mcids, *(r for d in node.descendants() for r in d.mcids)]:
            if ref.get("form") or ref.get("page") != page_no:
                continue
            run = mcid_run.get(ref["mcid"])
            if run is None:
                continue
            found = run if found is None else min(found, run)
        order.append(found)
        position += 1


def _insert_at(container, elem, before_index) -> None:
    """Insert `elem` among the container's element children at `before_index`
    (None = append)."""
    kids = _kids(container)
    positions = _elem_positions(kids)
    if before_index is None or before_index >= len(positions):
        kids.append(elem)
    else:
        kids.insert(positions[before_index], elem)
    _write_kids(container, kids)


def tag_page_content(
    file: str,
    output: str,
    page: int,
    targets=None,
    role: str = "P",
    allow_signed: bool = False,
) -> dict:
    """Bind untagged runs and annotations on one page into the structure tree.

    Args:
        file: Input PDF path.
        output: Output PDF path (may equal `file`).
        page: 1-based page number.
        targets: ``[{"run": <index from list_text_runs>} | {"annot": <index>}]``.
        role: The structure type to create, or "Artifact" — which declares the
            content decoration and creates no element at all.
        allow_signed: The signed-document decision, already taken by the caller.
    """
    wanted = str(role or "").strip().lstrip("/")
    if wanted != ARTIFACT and wanted not in STANDARD_ROLES:
        raise ValueError(
            f'"{wanted}" is not a structure type this can bind content to; use one of '
            "the standard types, or Artifact to declare the content decoration."
        )
    items = list(targets or [])
    if not items:
        raise ValueError("Name at least one run or annotation to tag.")

    decision = signed_edit_decision(signature_policy(file), "structural")
    if decision["kind"] == "refuse":
        raise RuntimeError(
            "this document is certified to allow no changes, so tagging page content "
            "would produce a file that reports as illegally modified"
        )
    if decision["kind"] == "warn" and not allow_signed:
        raise RuntimeError(
            "this document is signed and tagging page content invalidates its "
            "signatures -- the run must state that signed documents are included "
            "before it will touch one"
        )

    output_path = Path(output)
    same_file = is_same_file(file, output)
    with pikepdf.open(file) as pdf:
        total = len(pdf.pages)
        page_no = int(page)
        if not 1 <= page_no <= total:
            raise ValueError(f"page {page_no} is out of range (1-{len(pdf.pages)})")
        st = pdf.Root.get("/StructTreeRoot")
        if st is None:
            raise ValueError(
                "This document is untagged, so there is no structure tree to bind "
                "content into. Tag it first."
            )
        page_obj = pdf.pages[page_no - 1]

        runs: list = []
        _walk_runs(
            pdf,
            pikepdf.parse_content_stream(page_obj),
            _resolve_resources(page_obj),
            IDENTITY,
            0,
            None,
            runs,
            False,
            _FontCache(),
        )
        positions = _Positions(pdf, page_obj)
        if positions.total != len(runs):
            raise RuntimeError(
                "this page's text could not be addressed reliably, so nothing was "
                "tagged"
            )

        annots = page_obj.obj.get("/Annots")
        annot_list = list(annots) if annots is not None else []

        run_targets: list = []
        annot_targets: list = []
        for item in items:
            if "run" in item:
                index = int(item["run"])
                if not 0 <= index < len(runs):
                    raise ValueError(
                        f"text run {index} is not on page {page_no} (it has "
                        f"{len(runs)} runs)"
                    )
                if index in positions.in_form:
                    form = positions.in_form[index] or "(unnamed)"
                    raise ValueError(
                        f"text run {index} is drawn inside form XObject {form}, whose "
                        "marked content is numbered in its own stream and cannot take "
                        "a page-scoped tag."
                    )
                if runs[index].get("mcid") is not None:
                    raise ValueError(
                        f"text run {index} is already inside a tag; retagging bound "
                        "content is the Tags panel's edit."
                    )
                run_targets.append(index)
            elif "annot" in item:
                index = int(item["annot"])
                if not 0 <= index < len(annot_list):
                    raise ValueError(
                        f"annotation {index} is not on page {page_no} (it has "
                        f"{len(annot_list)} annotations)"
                    )
                annot = annot_list[index]
                if not isinstance(annot, pikepdf.Dictionary):
                    raise ValueError(f"annotation {index} on page {page_no} is not readable.")
                if annot.get("/StructParent") is not None:
                    raise ValueError(
                        f"annotation {index} on page {page_no} is already in the "
                        "structure tree."
                    )
                annot_targets.append((index, annot))
            else:
                raise ValueError('Each target names a "run" or an "annot".')

        if wanted == ARTIFACT and annot_targets:
            raise ValueError(
                "An annotation cannot be declared an artifact: the statement belongs "
                "to page content, and an annotation is an object."
            )

        # ── the content-stream rewrite ────────────────────────────────────
        used = _page_mcids(positions.instructions)
        next_mcid = (max(used) + 1) if used else 0
        assigned: dict = {}
        opened: dict = {}
        created: list = []
        for index in sorted(run_targets):
            if wanted == ARTIFACT:
                opened[positions.at[index]] = None
                created.append({"run": index, "mcid": None, "role": ARTIFACT})
                continue
            assigned[index] = next_mcid
            opened[positions.at[index]] = next_mcid
            next_mcid += 1

        rewritten: list = []
        for position, instruction in enumerate(positions.instructions):
            if position not in opened:
                rewritten.append(instruction)
                continue
            mcid = opened[position]
            if mcid is None:
                rewritten.append(([Name("/Artifact")], pikepdf.Operator("BMC")))
            else:
                rewritten.append(
                    (
                        [Name("/" + wanted), Dictionary(MCID=mcid)],
                        pikepdf.Operator("BDC"),
                    )
                )
            rewritten.append(instruction)
            rewritten.append(([], pikepdf.Operator("EMC")))
        if opened:
            page_obj.obj[Name.Contents] = pdf.make_stream(
                pikepdf.unparse_content_stream(rewritten)
            )

        # ── the tree ──────────────────────────────────────────────────────
        pairs: dict = {}
        parent_tree = st.get("/ParentTree")
        if parent_tree is not None:
            _number_tree_pairs(parent_tree, pairs, set())
        try:
            next_key = int(st.get("/ParentTreeNextKey") or 0)
        except (TypeError, ValueError):
            next_key = 0
        next_key = max([next_key, *(k + 1 for k in pairs)]) if pairs else next_key

        container, container_path = _container(st)
        mcid_run: dict = {}
        for run in runs:
            mcid = run.get("mcid")
            if mcid is None or run.get("nested"):
                continue
            index = int(run.get("index", 0))
            mcid_run[mcid] = min(mcid_run.get(mcid, index), index)
        # Read the sibling order BEFORE anything is inserted: the audit's paths
        # address the tree as it stands, and every insertion below shifts them.
        order = (
            _sibling_order(audit_tree(pdf), container_path, page_no, mcid_run)
            if assigned
            else []
        )

        if assigned:
            page_key = page_obj.obj.get("/StructParents")
            if page_key is None:
                page_key = next_key
                next_key += 1
                page_obj.obj[Name.StructParents] = int(page_key)
            page_key = int(page_key)
            slot = pairs.get(page_key)
            if slot is not None and not isinstance(slot, pikepdf.Array):
                # A page's /StructParents entry is an ARRAY indexed by MCID. A
                # producer that wrote something else left a mapping no reader
                # can index, and overwriting it in place would destroy whatever
                # it was; the page takes a fresh key instead and the old entry
                # is left exactly as it was found.
                page_key = next_key
                next_key += 1
                page_obj.obj[Name.StructParents] = int(page_key)
                slot = None
            entries = list(slot) if isinstance(slot, pikepdf.Array) else []
            for index in sorted(assigned):
                mcid = assigned[index]
                elem = pdf.make_indirect(
                    Dictionary(
                        Type=Name.StructElem,
                        S=Name("/" + wanted),
                        P=container,
                        Pg=page_obj.obj,
                        K=mcid,
                    )
                )
                # Stream order: after the last sibling whose content is drawn
                # before this run, and before the first one drawn after it.
                before = None
                for position, covers in enumerate(order):
                    if covers is not None and covers > index:
                        before = position
                        break
                _insert_at(container, elem, before)
                if before is None:
                    order.append(index)
                else:
                    order.insert(before, index)
                while len(entries) <= mcid:
                    entries.append(None)
                entries[mcid] = elem
                created.append({"run": index, "mcid": mcid, "role": wanted})
            pairs[page_key] = pdf.make_indirect(Array(entries))

        for index, annot in annot_targets:
            elem = pdf.make_indirect(
                Dictionary(
                    Type=Name.StructElem,
                    S=Name("/" + wanted),
                    P=container,
                    Pg=page_obj.obj,
                    K=Dictionary(Type=Name.OBJR, Obj=annot, Pg=page_obj.obj),
                )
            )
            _insert_at(container, elem, None)
            key = next_key
            next_key += 1
            # BOTH directions: the OBJR above names the annotation, and the
            # /StructParent below names the element. One without the other is
            # a tree that reads correctly and reverse-maps wrongly.
            annot[Name.StructParent] = int(key)
            pairs[key] = elem
            created.append({"annot": index, "role": wanted})

        _write_parent_tree(pdf, st, pairs)
        st[Name.ParentTreeNextKey] = int(next_key)
        if pdf.Root.get("/MarkInfo") is None:
            pdf.Root[Name.MarkInfo] = Dictionary(Marked=True)

        if same_file:
            staged = staging_target(output_path)
            save_pdf(pdf, staged)
        else:
            save_pdf(pdf, output_path)
    if same_file:
        finish_staged(staged, output_path)

    return {
        "output": str(output_path),
        "page": page_no,
        "role": wanted,
        "tagged": created,
    }
