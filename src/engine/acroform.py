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
precedent); this module covers exactly what
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

Document-level form behavior:

- ``carry_doc_form_extras`` — /CO (calculation order) is RECONCILED, not
  blind-carried: each entry resolves to its fully-qualified field name
  source-side, follows ``add_pages_from``'s rename report, and re-binds to
  the destination's copied field object; entries whose field did not
  survive drop out. The document catalog's /AA (document-action scripts)
  is document-scoped, not page-scoped — it carries whole, first source
  with one wins (the /DA//Q first-contributor rule).
- ``prune_form_to_pages`` reconciles an in-place /CO the same way after
  pruning (delete's path).
- ``reattach_acroform`` (the 1:1 gs-regeneration path) carries /CO, the
  catalog /AA, AND /XFA verbatim — page identity is preserved there, so
  the XFA packet still agrees with the pages.
- ``refuse_if_xfa`` — page SURGERY (merge/split/delete, the renderer's
  commit rebuild) REFUSES XFA documents outright: the XFA template lays
  out its own pages, so a restructured PDF page tree and a carried-verbatim
  XFA packet describe two different documents (a reader that honors XFA
  shows an unedited layout, causing silent cross-reader divergence). A stated
  refusal avoids both silent /XFA loss and a carried lie. Fill's pure-AcroForm
  posture
  (/XFA stripped by pdf-lib, detected and stated) is a separate,
  unchanged boundary.

Field-level keys (incl. per-field /AA) travel with the field objects
untouched, as always.
"""

from pathlib import Path

import pikepdf
from pikepdf import Array, Dictionary, Name
from engine.pdf_save import save_pdf

MAX_FIELD_DEPTH = 32


def has_xfa(pdf: pikepdf.Pdf) -> bool:
    """Whether the document carries an XFA form packet."""
    acro = pdf.Root.get("/AcroForm")
    try:
        return acro is not None and acro.get("/XFA") is not None
    except Exception:
        return False


def refuse_if_xfa(pdf: pikepdf.Pdf, path, operation: str) -> None:
    """Refuse page surgery on an XFA document (module docstring rationale)."""
    if has_xfa(pdf):
        raise ValueError(
            f"{Path(str(path)).name} contains an XML form (XFA). Page "
            f"operations would detach the form from its pages, so {operation} "
            "is not available for this document. Fill the form, or flatten "
            "it with another tool first."
        )


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
    _reconcile_co_in_place(pdf)


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


def fq_field_name(node) -> str | None:
    """Fully-qualified field name: /T segments joined with '.', climbing
    /Parent. None when no segment carries a /T (nameless — nothing stable to
    reconcile on)."""
    parts: list[str] = []
    seen: set = set()
    depth = 0
    while isinstance(node, Dictionary) and depth <= MAX_FIELD_DEPTH:
        try:
            og = node.objgen if node.is_indirect else None
        except Exception:
            og = None
        if og is not None:
            if og in seen:
                return None  # cyclic /Parent chain — refuse to name it
            seen.add(og)
        t = node.get("/T")
        if t is not None:
            parts.append(str(t))
        node = node.get("/Parent")
        depth += 1
    if not parts:
        return None
    return ".".join(reversed(parts))


def _forest_names(pdf: pikepdf.Pdf) -> dict:
    """FQ name → field object for every node of the /Fields forest (interior
    nodes included — /CO may legally reference any field with a /C action)."""
    out: dict = {}
    fields = _fields_of(pdf)
    if fields is None:
        return out

    def walk(node, prefix: str, depth: int) -> None:
        if depth > MAX_FIELD_DEPTH or not isinstance(node, Dictionary):
            return
        t = node.get("/T")
        name = prefix if t is None else (f"{prefix}.{t}" if prefix else str(t))
        if name:
            out.setdefault(name, node)
        kids = node.get("/Kids")
        if kids is not None and isinstance(kids, Array):
            for kid in kids:
                walk(kid, name, depth + 1)

    for f in fields:
        walk(f, "", 0)
    return out


def form_field_forest(pdf: pikepdf.Pdf) -> dict:
    """Fully-qualified name → field object for every node of the form, interior
    nodes included — a name that scopes a subtree is a legal target for anything
    that addresses fields by name."""
    return dict(_forest_names(pdf))


def _apply_renames(name: str, renamed: dict) -> str:
    """Map a source-side FQ name through add_pages_from's rename report. The
    report renames ROOT names, so a renamed root rewrites every descendant's
    prefix."""
    for old, new in renamed.items():
        if name == old:
            return new
        if name.startswith(old + "."):
            return new + name[len(old):]
    return name


def carry_doc_form_extras(dst: pikepdf.Pdf, src: pikepdf.Pdf, renamed: dict) -> None:
    """Carry document-level form behavior after an ``add_pages_from`` copy:
    /CO reconciled by FQ name (module docstring), catalog /AA first-wins.
    Call per source, in input order, with that source's rename report."""
    src_acro = src.Root.get("/AcroForm")
    if src_acro is not None:
        co = src_acro.get("/CO")
        if co is not None and isinstance(co, Array) and len(co) > 0:
            dst_names = _forest_names(dst)
            resolved = []
            for entry in co:
                name = fq_field_name(entry)
                if name is None:
                    continue
                target = dst_names.get(_apply_renames(name, renamed))
                if target is not None:
                    resolved.append(target)
            if resolved:
                dst_acro = dst.Root.get("/AcroForm")
                if dst_acro is not None:
                    existing = dst_acro.get("/CO")
                    if existing is not None and isinstance(existing, Array):
                        existing.extend(resolved)
                    else:
                        dst_acro["/CO"] = Array(resolved)
    if dst.Root.get("/AA") is None:
        src_aa = src.Root.get("/AA")
        if src_aa is not None and isinstance(src_aa, Dictionary):
            handle = src_aa if src_aa.is_indirect else src.make_indirect(src_aa)
            dst.Root["/AA"] = dst.copy_foreign(handle)


def _reconcile_co_in_place(pdf: pikepdf.Pdf) -> None:
    """Drop /CO entries whose field no longer sits under the (pruned) /Fields
    forest; remove an emptied /CO."""
    acro = pdf.Root.get("/AcroForm")
    if acro is None:
        return
    co = acro.get("/CO")
    if co is None or not isinstance(co, Array):
        return
    live = _forest_names(pdf)
    keep = []
    for entry in co:
        name = fq_field_name(entry)
        if name is not None and live.get(name) is not None:
            keep.append(entry)
    if not keep:
        del acro["/CO"]
    elif len(keep) != len(co):
        acro["/CO"] = Array(keep)


def adopt_orphan_widget_fields(pdf: pikepdf.Pdf) -> int:
    """Register orphan field-keyed widgets in /AcroForm (distill forms).

    gs pdfwrite honours /ANN pdfmarks — Distiller's form syntax — well enough
    to land Widget annotations with their /T //FT //V intact on the page, but
    it never writes the document /AcroForm (probe-verified against bundled
    10.07.1), leaving every distilled field an orphan: rendered, dead. The
    widgets ARE the fields (Distiller pdfmark forms are flat — no /Parent
    trees arrive this way), so adoption is: collect page widgets carrying
    BOTH /T and /FT that no /Fields forest already reaches, append them to
    /AcroForm /Fields (created on demand with the standard Helv /DR + /DA),
    and set /NeedAppearances when any adopted field lacks an /AP — readers
    regenerate, and this app's own fill builds real appearances on first
    edit. Widgets with /T but no /FT stay orphans (an untyped field cannot
    be honestly registered). Same-named widgets adopt as one logical field
    per the spec's shared-/V rule — exactly Distiller's semantics.

    Returns the number of widgets adopted (0 = untouched document).
    """
    registered: set = set()
    fields = _fields_of(pdf)
    if fields is not None:
        def collect(node, depth: int) -> None:
            if depth > MAX_FIELD_DEPTH or not isinstance(node, Dictionary):
                return
            try:
                if node.is_indirect:
                    registered.add(node.objgen)
            except Exception:
                pass
            kids = node.get("/Kids")
            if kids is not None and isinstance(kids, Array):
                for kid in kids:
                    collect(kid, depth + 1)

        for f in fields:
            collect(f, 0)

    adopted = []
    needs_appearances = False
    for page in pdf.pages:
        annots = page.obj.get("/Annots")
        if annots is None:
            continue
        try:
            entries = list(annots)
        except Exception:
            continue
        for a in entries:
            if not _is_widget(a) or not isinstance(a, Dictionary):
                continue
            if a.get("/T") is None or a.get("/FT") is None:
                continue
            try:
                if a.is_indirect and a.objgen in registered:
                    continue
            except Exception:
                continue
            handle = a if a.is_indirect else pdf.make_indirect(a)
            adopted.append(handle)
            if handle.get("/AP") is None:
                needs_appearances = True

    if not adopted:
        return 0

    acro = pdf.Root.get("/AcroForm")
    if acro is None:
        helv = pdf.make_indirect(
            Dictionary(
                Type=Name.Font,
                Subtype=Name.Type1,
                BaseFont=Name.Helvetica,
                Encoding=Name.WinAnsiEncoding,
            )
        )
        acro = pdf.make_indirect(
            Dictionary(
                Fields=Array([]),
                DA=pikepdf.String("/Helv 0 Tf 0 g"),
                DR=Dictionary(Font=Dictionary(Helv=helv)),
            )
        )
        pdf.Root["/AcroForm"] = acro
    dst_fields = acro.get("/Fields")
    if dst_fields is None or not isinstance(dst_fields, Array):
        dst_fields = Array([])
        acro["/Fields"] = dst_fields
    for handle in adopted:
        dst_fields.append(handle)
    if needs_appearances:
        acro["/NeedAppearances"] = True
    return len(adopted)


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
    # /CO and /XFA ride the 1:1 path verbatim: copy_foreign caches per
    # source, so /CO's field refs resolve to the SAME copied field objects the
    # roots walk produced, and page identity is preserved so the XFA packet
    # still agrees with the pages (page SURGERY refuses XFA instead — module
    # docstring).
    for key in ("/DA", "/Q", "/DR", "/NeedAppearances", "/SigFlags", "/CO", "/XFA"):
        v = acro_src.get(key)
        if v is None:
            continue
        if isinstance(v, (Dictionary, Array, pikepdf.Stream)):
            handle = v if v.is_indirect else original.make_indirect(v)
            acro_new[key] = regenerated.copy_foreign(handle)
        else:
            acro_new[key] = v  # scalars (String/int/bool) copy by value
    regenerated.Root["/AcroForm"] = regenerated.make_indirect(acro_new)
    # The catalog's /AA (document-action scripts) is document-scoped and gs
    # drops it with everything else — carry it whole.
    src_aa = original.Root.get("/AA")
    if src_aa is not None and isinstance(src_aa, Dictionary) and regenerated.Root.get("/AA") is None:
        handle = src_aa if src_aa.is_indirect else original.make_indirect(src_aa)
        regenerated.Root["/AA"] = regenerated.copy_foreign(handle)
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
            save_pdf(regen, regenerated_path)
            return True
