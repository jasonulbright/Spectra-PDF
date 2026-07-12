"""AcroForm helpers for structural page operations.

pikepdf's raw page copies (``pages.append``/``extend``) import widget
annotations and their /Parent field chains but never the document-level
/AcroForm — merge and split outputs lost every form field (still rendering
via /AP pixels; nothing fillable, every /V orphaned), and delete could leave
phantom fields whose every widget died with a deleted page. pikepdf itself
flags the copy hazard (PageCopyWarning) and, since 10.x, ships the fix:
``Pdf.add_pages_from`` — form-aware page copy that registers fields,
auto-renames colliding fully-qualified names (``name+1``), merges /DR with
per-field /DA rewrites on resource collisions, materializes inherited
AcroForm-level /DA down onto fields, and carries /NeedAppearances. merge and
split now build on that (hand-rolling what upstream maintains would be the
same mistake class as hand-rolling ByteRange handling — see the pyHanko
precedent in 10-phase2h-signatures.md); this module covers exactly what
upstream does NOT:

- ``prune_form_to_pages`` — prune field trees to kept pages, in place. Used
  by split BEFORE the copy (add_pages_from carries a partially-selected
  field as its ENTIRE subtree, leaving phantom dead widgets for the excluded
  pages' kids — pruning first yields clean trees and an empty
  ``partial_fields``) and by delete AFTER page removal (with every remaining
  page kept, so widgets of deleted pages drop out).
- ``carry_pure_data_fields`` — widget-less pure-data fields (a /V with no
  page presence) are dropped by add_pages_from because it discovers fields
  through page widgets; dropping them would silently discard their /V, so
  they are carried explicitly. The renderer's rebuild keeps them for the
  same reason (lib/acroform-carry.ts — one semantic, two object models).
- ``refresh_sig_flags`` — /SigFlags is not recomputed upstream; bit 1
  (SignaturesExist) is re-derived from the surviving fields, and bit 2 is
  dropped — its precondition, an unbroken signature, cannot survive page
  surgery.

Deliberate boundary (matching the renderer): document-level form scripts
(/CO, doc /AA) do not survive these operations — carrying blind references
through page surgery is worse than dropping them. Field-level keys (incl.
per-field /AA) travel with the field objects untouched.

Design: docs/architecture/16-phase2n-canvas-completeness.md § 2n.4(a).
"""

import pikepdf
from pikepdf import Array, Dictionary, Name

MAX_FIELD_DEPTH = 32


def _fields_of(pdf: pikepdf.Pdf):
    acro = pdf.Root.get("/AcroForm")
    if acro is None:
        return None
    fields = acro.get("/Fields")
    if fields is None or not isinstance(fields, Array):
        return None
    return fields


def _is_widget(obj) -> bool:
    try:
        return obj.get("/Subtype") == Name.Widget
    except Exception:
        return False


def _kept_sets(pdf: pikepdf.Pdf, kept_indices) -> tuple[set, set]:
    """(page objgens, annot-entry objgens) for the kept pages."""
    page_ids: set = set()
    annot_ids: set = set()
    for i in kept_indices:
        page = pdf.pages[i].obj
        page_ids.add(page.objgen)
        annots = page.get("/Annots")
        if annots is None:
            continue
        try:
            for a in annots:
                if a.is_indirect:
                    annot_ids.add(a.objgen)
        except Exception:
            continue
    return page_ids, annot_ids


def _widget_kept(widget, page_ids: set, annot_ids: set) -> bool:
    """A widget is kept iff its /P is a kept page or it appears in a kept
    page's /Annots (union — visible-anywhere wins; /P is optional)."""
    p = widget.get("/P")
    if p is not None:
        try:
            if p.objgen in page_ids:
                return True
        except Exception:
            pass
    try:
        return widget.is_indirect and widget.objgen in annot_ids
    except Exception:
        return False


def _survive_node(node, page_ids: set, annot_ids: set, depth: int) -> bool:
    """Prunes /Kids in place; returns whether this node survives."""
    if depth > MAX_FIELD_DEPTH:
        return False  # malformed/cyclic — fail toward dropping
    if not isinstance(node, Dictionary):
        return False
    kids = node.get("/Kids")
    if kids is not None and isinstance(kids, Array) and len(kids) > 0:
        keep = [k for k in kids if _survive_node(k, page_ids, annot_ids, depth + 1)]
        if keep and len(keep) != len(kids):
            node["/Kids"] = Array(keep)
        return len(keep) > 0
    if _is_widget(node):
        return _widget_kept(node, page_ids, annot_ids)
    return True  # widget-less pure-data terminal — keep (its /V has no visual to lose)


def _tree_has_sig(node, inherited_ft, depth: int) -> bool:
    """/FT /Sig anywhere in this subtree, with spec inheritance (/FT may live
    on an ancestor)."""
    if depth > MAX_FIELD_DEPTH or not isinstance(node, Dictionary):
        return False
    ft = node.get("/FT")
    if ft is None:
        ft = inherited_ft
    kids = node.get("/Kids")
    if kids is None or not isinstance(kids, Array) or len(kids) == 0:
        return ft == Name.Sig
    return any(_tree_has_sig(kid, ft, depth + 1) for kid in kids)


def _subtree_has_widget(node, depth: int) -> bool:
    if depth > MAX_FIELD_DEPTH or not isinstance(node, Dictionary):
        return False
    if _is_widget(node):
        return True
    kids = node.get("/Kids")
    if kids is None or not isinstance(kids, Array):
        return False
    return any(_subtree_has_widget(kid, depth + 1) for kid in kids)


def prune_form_to_pages(pdf: pikepdf.Pdf, kept_indices) -> None:
    """Prune /AcroForm field trees (in place) to the given kept pages.

    Used two ways: on a private source open BEFORE copying a page subset out
    of it (split), and on a document AFTER in-place page deletion (delete,
    with every remaining page kept — dead widgets drop because their /P no
    longer resolves to a live page). If no field survives, /AcroForm is
    removed outright; otherwise /SigFlags is re-derived (and dropped when the
    last signature field went away).
    """
    fields = _fields_of(pdf)
    if fields is None or len(fields) == 0:
        return
    page_ids, annot_ids = _kept_sets(pdf, kept_indices)
    keep = [f for f in fields if _survive_node(f, page_ids, annot_ids, 0)]
    acro = pdf.Root.get("/AcroForm")
    if not keep:
        del pdf.Root["/AcroForm"]
        return
    if len(keep) != len(fields):
        acro["/Fields"] = Array(keep)
    if acro.get("/SigFlags") is not None:
        if any(_tree_has_sig(f, None, 0) for f in keep):
            acro["/SigFlags"] = 1
        else:
            del acro["/SigFlags"]


def carry_pure_data_fields(dst: pikepdf.Pdf, src: pikepdf.Pdf) -> list[dict]:
    """Copy ``src``'s widget-less pure-data fields into ``dst``'s /AcroForm.

    ``add_pages_from`` discovers fields through page widgets, so a field with
    no page presence at all never travels — and its /V would be silently
    lost. Call AFTER add_pages_from, with ``src`` still open (foreign copies
    resolve lazily; the caller keeps sources open through the save). Name
    collisions with fields already in ``dst`` rename with the same ``+N``
    convention add_pages_from uses. Returns [{"from", "to"}, ...] renames.
    """
    fields = _fields_of(src)
    if fields is None:
        return []
    pure = [f for f in fields if isinstance(f, Dictionary) and not _subtree_has_widget(f, 0)]
    if not pure:
        return []

    acro = dst.Root.get("/AcroForm")
    if acro is None:
        acro = dst.make_indirect(Dictionary(Fields=Array([])))
        dst.Root["/AcroForm"] = acro
    dst_fields = acro.get("/Fields")
    if dst_fields is None or not isinstance(dst_fields, Array):
        dst_fields = Array([])
        acro["/Fields"] = dst_fields

    taken = set()
    for f in dst_fields:
        try:
            t = f.get("/T")
        except Exception:
            continue
        if t is not None:
            taken.add(str(t))

    renamed: list[dict] = []
    for f in pure:
        handle = f if f.is_indirect else src.make_indirect(f)  # copy_foreign needs indirect
        copied = dst.copy_foreign(handle)
        t = copied.get("/T")
        if t is not None:
            name = str(t)
            if name in taken:
                n = 1
                while f"{name}+{n}" in taken:
                    n += 1
                new_name = f"{name}+{n}"
                copied["/T"] = pikepdf.String(new_name)
                renamed.append({"from": name, "to": new_name})
                taken.add(new_name)
            else:
                taken.add(name)
        dst_fields.append(copied)
    return renamed


def refresh_sig_flags(pdf: pikepdf.Pdf) -> None:
    """Recompute /SigFlags bit 1 (SignaturesExist) from the fields actually
    present; drop the key entirely when no signature field remains. Bit 2
    (AppendOnly) never survives — see the module docstring."""
    acro = pdf.Root.get("/AcroForm")
    if acro is None:
        return
    fields = acro.get("/Fields")
    has_sig = (
        fields is not None
        and isinstance(fields, Array)
        and any(_tree_has_sig(f, None, 0) for f in fields)
    )
    if has_sig:
        acro["/SigFlags"] = 1
    elif acro.get("/SigFlags") is not None:
        del acro["/SigFlags"]


def _strip_p(node, depth: int = 0) -> None:
    if depth > MAX_FIELD_DEPTH or not isinstance(node, Dictionary):
        return
    if node.get("/P") is not None:
        del node["/P"]
    kids = node.get("/Kids")
    if kids is not None and isinstance(kids, Array):
        for kid in kids:
            _strip_p(kid, depth + 1)


def reattach_acroform(original: pikepdf.Pdf, regenerated: pikepdf.Pdf) -> bool:
    """Transplant ``original``'s form fields into a Ghostscript-regenerated
    copy of the SAME document.

    gs pdfwrite re-renders content and drops BOTH /AcroForm and every widget
    annotation (verified against the bundled gs) — so compress/grayscale on a
    filled form silently destroyed it. Pages correspond 1:1 (pdfwrite never
    changes the count for a valid input; a mismatch raises rather than
    guessing where fields belong). ``original`` must be a PRIVATE open: /P is
    stripped from the source forest before copying so the foreign copy cannot
    drag original page objects — content streams included — into the
    regenerated output, then re-pointed at the regenerated pages. (A widget
    /A action holding a page destination could still drag one page in;
    actions are rare on form widgets and faithfully carried.) Orphan widgets
    (in /Annots, not under /Fields) are re-transplanted as orphans, never
    registered. /XFA and document-level scripts follow the module-docstring
    boundary. Returns True when fields were reattached.
    """
    fields = _fields_of(original)
    if fields is None or len(fields) == 0:
        return False
    if len(original.pages) != len(regenerated.pages):
        raise ValueError(
            "The regenerated file's page count differs from the original; "
            "cannot reattach its form fields."
        )

    # Per-page widget lists, captured before any mutation.
    page_widgets: list[list] = []
    for p in original.pages:
        annots = p.obj.get("/Annots")
        ws = []
        if annots is not None:
            try:
                ws = [a for a in annots if _is_widget(a)]
            except Exception:
                ws = []
        page_widgets.append(ws)

    for f in fields:
        _strip_p(f)
    for ws in page_widgets:
        for w in ws:
            _strip_p(w)  # covers orphan widgets not reachable from /Fields

    copied_roots = []
    for f in fields:
        handle = f if f.is_indirect else original.make_indirect(f)
        copied_roots.append(regenerated.copy_foreign(handle))

    # Transplant widgets onto the regenerated pages. copy_foreign caches per
    # source, so a field's widget resolves to the instance already copied
    # through its root — the /Fields tree and page /Annots stay one graph.
    for i, ws in enumerate(page_widgets):
        if not ws:
            continue
        page_obj = regenerated.pages[i].obj
        annots = page_obj.get("/Annots")
        if annots is None or not isinstance(annots, Array):
            annots = Array([])
            page_obj["/Annots"] = annots
        for w in ws:
            handle = w if w.is_indirect else original.make_indirect(w)
            copied = regenerated.copy_foreign(handle)
            copied["/P"] = page_obj
            annots.append(copied)

    acro_src = original.Root["/AcroForm"]
    acro_new = Dictionary(Fields=Array(copied_roots))
    for key in ("/DA", "/Q", "/DR", "/NeedAppearances", "/SigFlags"):
        v = acro_src.get(key)
        if v is None:
            continue
        if isinstance(v, (Dictionary, Array)):
            handle = v if v.is_indirect else original.make_indirect(v)
            acro_new[key] = regenerated.copy_foreign(handle)
        else:
            acro_new[key] = v  # scalars (String/int/bool) copy by value
    regenerated.Root["/AcroForm"] = regenerated.make_indirect(acro_new)
    return True


def reattach_forms_file(original_path, regenerated_path) -> bool:
    """File-level wrapper for :func:`reattach_acroform`: reattach
    ``original_path``'s form fields onto the Ghostscript output at
    ``regenerated_path``, saving it in place. Returns True when the file was
    rewritten (i.e. the original actually had fields)."""
    with pikepdf.open(original_path) as orig:
        fields = _fields_of(orig)
        if fields is None or len(fields) == 0:
            return False
        with pikepdf.open(regenerated_path, allow_overwriting_input=True) as regen:
            if not reattach_acroform(orig, regen):
                return False
            regen.save(regenerated_path)
            return True
