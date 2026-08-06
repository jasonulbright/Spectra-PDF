"""Incremental-append editing for SIGNED documents.

pikepdf/qpdf cannot write incremental updates — every save is a full
rewrite that coalesces the file and breaks any signature's /ByteRange.
pyHanko's IncrementalPdfFileWriter appends ONE revision containing exactly
the changed objects; that is already how signing and counter-signing
preserve prior signatures. This module generalizes the mechanism to
the ANNOTATE / FORM-FILL / ADD-PAGE tier without re-implementing any of
the app's emission machinery:

    transplant_incremental(original, modified, output)

reads the ORIGINAL (signed) file and a MODIFIED full rebuild of it — the
output of whichever rewrite pipeline already exists (the renderer's
pdf-lib page-tier commit, pikepdf form fill, XFDF import, link authoring)
— computes the SEMANTIC delta, and writes original-bytes + one appended
revision carrying the delta. The signed byte range is untouched by
construction; the module asserts the prefix property before replacing
anything.

Scope — what may differ between original and modified under the DocMDP P=3
ceiling, plus page addition as permitted by ISO 32000 incremental updates:

  - per-page /Annots membership, order, and annotation content (add,
    modify, remove — appearance streams included),
  - /AcroForm and field content (fill: /V, widget /AP//AS, NeedAppearances,
    /DA//DR additions),
  - page INSERTIONS (a wholly new page between preserved ones).

Anything else — page removal or reordering, content-stream or resource
drift, encryption changes — refuses with ``applied=False`` and a reason;
the caller falls back to the rewrite path it was already on. Document
metadata (/Info, XMP) is deliberately IGNORED rather than transplanted:
incidental Producer/ModDate churn from a rebuild must neither block the
transplant nor masquerade as a user edit.

Refusal is a RESULT, not an exception: every call site has a working
rewrite path as its fallback, and the difference between "not applicable"
and "broken" must stay visible to it.

Comparison notes: equality is a structural bisimulation over the two
object graphs (pair-memoized, so shared subtrees and cycles terminate;
streams compare raw-then-decoded; numbers compare numerically so 1 vs 1.0
never manufactures a difference). A pairing MISS between two annotations
only enlarges the delta (annotation replaced instead of kept) — it can
never corrupt output — so precision there is an optimization, while page
level mismatches refuse outright.
"""

import io
import os
import tempfile
from pathlib import Path

import pikepdf
from pyhanko.pdf_utils import generic
from pyhanko.pdf_utils.incremental_writer import IncrementalPdfFileWriter

from .docmdp import certification_of_file
from .validate import validate_pdf

MAX_FIELD_DEPTH = 32
_NUM_EPS = 1e-6

# Page-dict keys whose difference the transplant HANDLES (everything else
# differing at page level refuses). /Annots is the delta itself.
_PAGE_SKIP = frozenset({"/Annots"})
# Keys ignored when comparing stream dicts — encoding details of the same
# decoded bytes.
_STREAM_SKIP = frozenset({"/Length", "/Filter", "/DecodeParms"})


# ---------------------------------------------------------------------------
# Signedness
# ---------------------------------------------------------------------------

def _effective_ft(node, inherited, depth=0):
    if depth > MAX_FIELD_DEPTH or not isinstance(node, pikepdf.Dictionary):
        return inherited
    ft = node.get("/FT")
    return ft if ft is not None else inherited


def _tree_live_sig_count(node, inherited_ft, depth=0) -> int:
    """Terminal /FT /Sig fields WITH a /V in this subtree."""
    if depth > MAX_FIELD_DEPTH or not isinstance(node, pikepdf.Dictionary):
        return 0
    ft = _effective_ft(node, inherited_ft, depth)
    kids = node.get("/Kids")
    if kids is None or not isinstance(kids, pikepdf.Array) or len(kids) == 0:
        return 1 if ft == pikepdf.Name("/Sig") and node.get("/V") is not None else 0
    return sum(_tree_live_sig_count(k, ft, depth + 1) for k in kids)


def _live_sig_count(path: str) -> int:
    try:
        with pikepdf.open(path) as pdf:
            acro = pdf.Root.get("/AcroForm")
            if acro is None:
                return 0
            fields = acro.get("/Fields")
            if fields is None or not isinstance(fields, pikepdf.Array):
                return 0
            return sum(_tree_live_sig_count(f, None) for f in fields)
    except Exception:
        # An unreadable file cannot be transplanted; let the caller's
        # rewrite path surface whatever is actually wrong with it.
        return 0


def has_live_signatures(path: str) -> bool:
    """True when the document carries at least one FILLED signature field.

    Presence-only walk (no crypto) — this is the cheap gate deciding
    whether a rewrite must be re-expressed as an incremental append.
    """
    return _live_sig_count(path) > 0


def signature_policy(path: str) -> dict:
    """What this document's own signatures allow to be changed.

    ``{"signed": bool, "count": int, "certified": bool, "level": str|None}``.
    The same presence-only read as ``has_live_signatures`` plus the catalog's
    certification entry — no cryptography and no difference analysis, so it
    stays cheap enough to consult before every edit.

    ``level`` is None both for an uncertified document and for a certification
    recording a permission value outside the three defined levels; ``certified``
    is what distinguishes those, and an unrecognized level is treated by callers
    as an unknown one rather than as an absent one.
    """
    certification = certification_of_file(path)
    count = _live_sig_count(path)
    return {
        "signed": count > 0,
        "count": count,
        "certified": bool(certification["certified"]),
        "level": certification["level"],
    }


# ---------------------------------------------------------------------------
# Structural bisimulation over pikepdf objects
# ---------------------------------------------------------------------------

def _is_num(obj) -> bool:
    return isinstance(obj, (int, float)) or type(obj).__name__ == "Decimal"


def _bisim(a, b, memo: set, skip: frozenset = frozenset(), depth: int = 0) -> bool:
    if depth > 200:
        return False  # pathological nesting — refuse toward "different"
    a_ind = isinstance(a, pikepdf.Object) and a.is_indirect
    b_ind = isinstance(b, pikepdf.Object) and b.is_indirect
    if a_ind and b_ind:
        key = (a.objgen, b.objgen)
        if key in memo:
            return True  # coinductive: assume equal on revisit
        memo.add(key)

    if _is_num(a) and _is_num(b):
        return abs(float(a) - float(b)) <= _NUM_EPS

    a_is_stream = isinstance(a, pikepdf.Stream)
    b_is_stream = isinstance(b, pikepdf.Stream)
    if a_is_stream != b_is_stream:
        return False
    if a_is_stream:
        ka = {str(k) for k in a.stream_dict.keys()} - _STREAM_SKIP
        kb = {str(k) for k in b.stream_dict.keys()} - _STREAM_SKIP
        if ka != kb:
            return False
        for k in ka:
            if not _bisim(a.stream_dict.get(k), b.stream_dict.get(k), memo, depth=depth + 1):
                return False
        try:
            if a.read_raw_bytes() == b.read_raw_bytes():
                # Same filters guaranteed by the dict compare? /Filter is
                # skipped there, so equal raw bytes only prove equality
                # when filters match too — compare them explicitly.
                if a.stream_dict.get("/Filter") == b.stream_dict.get("/Filter"):
                    return True
            return a.read_bytes() == b.read_bytes()
        except Exception:
            return False

    a_is_dict = isinstance(a, pikepdf.Dictionary)
    b_is_dict = isinstance(b, pikepdf.Dictionary)
    if a_is_dict != b_is_dict:
        return False
    if a_is_dict:
        ka = {str(k) for k in a.keys()} - skip
        kb = {str(k) for k in b.keys()} - skip
        if ka != kb:
            return False
        for k in ka:
            # /P (page back-pointer) and /Parent chains cross into the page
            # tree; comparing them by structure would drag whole documents
            # into every annotation compare. Their consistency is implied
            # by the page-level walk, so compare them by KIND only.
            if k in ("/P", "/Parent"):
                if (a.get(k) is None) != (b.get(k) is None):
                    return False
                continue
            if not _bisim(a.get(k), b.get(k), memo, depth=depth + 1):
                return False
        return True

    a_is_arr = isinstance(a, pikepdf.Array)
    b_is_arr = isinstance(b, pikepdf.Array)
    if a_is_arr != b_is_arr:
        return False
    if a_is_arr:
        if len(a) != len(b):
            return False
        return all(_bisim(a[i], b[i], memo, depth=depth + 1) for i in range(len(a)))

    if isinstance(a, pikepdf.Name) or isinstance(b, pikepdf.Name):
        return isinstance(a, pikepdf.Name) and isinstance(b, pikepdf.Name) and str(a) == str(b)
    if isinstance(a, pikepdf.String) or isinstance(b, pikepdf.String):
        return (
            isinstance(a, pikepdf.String)
            and isinstance(b, pikepdf.String)
            and bytes(a) == bytes(b)
        )
    if a is None or b is None:
        return a is None and b is None
    if isinstance(a, bool) or isinstance(b, bool):
        return a is b
    return a == b


# ---------------------------------------------------------------------------
# pikepdf -> pyHanko materialization (for objects NEW to the original)
# ---------------------------------------------------------------------------

def _materialize(obj, writer: IncrementalPdfFileWriter, memo: dict, depth: int = 0):
    """Convert a pikepdf subtree from the MODIFIED file into writer objects.

    Indirect objects memoize by source objgen (shared subtrees stay shared;
    cycles — Popup /Parent — resolve through an allocated placeholder id).
    Streams carry their RAW encoded bytes with the original /Filter chain.
    """
    if depth > 200:
        raise ValueError("Object graph too deep to materialize")

    if isinstance(obj, pikepdf.Object) and obj.is_indirect:
        key = obj.objgen
        if key in memo:
            return memo[key]
        placeholder = writer.allocate_placeholder()
        memo[key] = placeholder
        built = _materialize_direct(obj, writer, memo, depth)
        writer.add_object(built, idnum=placeholder.idnum)
        return placeholder

    return _materialize_direct(obj, writer, memo, depth)


def _materialize_direct(obj, writer, memo, depth):
    if isinstance(obj, pikepdf.Stream):
        dict_data = {}
        for k in obj.stream_dict.keys():
            ks = str(k)
            if ks == "/Length":
                continue
            dict_data[generic.pdf_name(ks)] = _materialize(
                obj.stream_dict.get(ks), writer, memo, depth + 1
            )
        return generic.StreamObject(
            dict_data=dict_data, encoded_data=obj.read_raw_bytes()
        )
    if isinstance(obj, pikepdf.Dictionary):
        out = generic.DictionaryObject()
        for k in obj.keys():
            out[generic.pdf_name(str(k))] = _materialize(
                obj.get(k), writer, memo, depth + 1
            )
        return out
    if isinstance(obj, pikepdf.Array):
        return generic.ArrayObject(
            _materialize(item, writer, memo, depth + 1) for item in obj
        )
    if isinstance(obj, pikepdf.Name):
        return generic.pdf_name(str(obj))
    if isinstance(obj, pikepdf.String):
        return generic.pdf_string(bytes(obj))
    if isinstance(obj, bool):
        return generic.BooleanObject(obj)
    if isinstance(obj, int):
        return generic.NumberObject(obj)
    if _is_num(obj):
        return generic.FloatObject(float(obj))
    if obj is None:
        return generic.NullObject()
    raise ValueError(f"Unsupported object type for transplant: {type(obj)!r}")


def _writer_ref(objgen, writer):
    return generic.IndirectObject(objgen[0], objgen[1], writer)


class _TransplantRefusal(Exception):
    """A delta outside the append-safe tier — reported, never raised out."""


def _update_in_place(ref, orig_obj, mod_obj, writer, memo, depth: int = 0) -> bool:
    """Reconcile ONE existing original object toward its modified twin,
    preserving every reference that did not change.

    The naive alternative — clear + rewrite from a full materialization —
    is a correctness trap: a widget's /P (and a kid field's /Parent) would
    be materialized too, dragging a duplicate of the whole page graph into
    the appended revision. Instead: keys whose values are bisim-equal are
    LEFT UNTOUCHED (original nested refs intact); /P and /Parent are never
    written at all; a /Kids array whose members pair positionally recurses
    into per-kid reconciliation (radio groups: parent /V + kid /AS both
    land as small in-place updates); only genuinely-new values materialize.
    Returns whether anything changed (and marks the update if so).
    """
    if depth > MAX_FIELD_DEPTH:
        raise _TransplantRefusal("field nesting too deep to reconcile")
    live = ref.get_object()
    changed = False
    for k in list(mod_obj.keys()):
        ks = str(k)
        if ks in ("/P", "/Parent"):
            continue
        orig_val = orig_obj.get(ks)
        mod_val = mod_obj.get(ks)
        if orig_val is not None and _bisim(orig_val, mod_val, set()):
            continue
        if (
            ks == "/Kids"
            and orig_val is not None
            and isinstance(orig_val, pikepdf.Array)
            and isinstance(mod_val, pikepdf.Array)
            and len(orig_val) == len(mod_val)
            and all(
                isinstance(x, pikepdf.Object) and x.is_indirect for x in orig_val
            )
        ):
            for i in range(len(orig_val)):
                kid_ref = _writer_ref(orig_val[i].objgen, writer)
                if _update_in_place(
                    kid_ref, orig_val[i], mod_val[i], writer, memo, depth + 1
                ):
                    changed = True
            continue
        live[generic.pdf_name(ks)] = _materialize(mod_val, writer, memo)
        changed = True
    removed_keys = (
        {str(k) for k in orig_obj.keys()}
        - {str(k) for k in mod_obj.keys()}
        - {"/P", "/Parent"}
    )
    for ks in removed_keys:
        if generic.pdf_name(ks) in live:
            del live[generic.pdf_name(ks)]
            changed = True
    if changed:
        writer.mark_update(ref)
    return changed


# ---------------------------------------------------------------------------
# Delta computation + application
# ---------------------------------------------------------------------------

def _annot_nm(annot):
    try:
        nm = annot.get("/NM")
        return bytes(nm) if nm is not None else None
    except Exception:
        return None


def _is_widget(annot) -> bool:
    try:
        return annot.get("/Subtype") == pikepdf.Name("/Widget")
    except Exception:
        return False


def _widget_field_name(annot) -> str | None:
    """Fully-qualified field name of a widget (climbing /Parent /T chain).

    Widgets rarely carry /NM, and a fill changes their content — so the
    ONLY safe pairing key is field identity. Pairing a changed widget as
    remove+add would fork the object graph (/AcroForm still referencing
    the removed original), which is exactly what in-place reconciliation
    exists to prevent."""
    parts: list[str] = []
    node = annot
    for _ in range(MAX_FIELD_DEPTH):
        if not isinstance(node, pikepdf.Dictionary):
            break
        t = node.get("/T")
        if t is not None:
            parts.append(str(t))
        parent = node.get("/Parent")
        if parent is None:
            break
        node = parent
    if not parts:
        return None
    return ".".join(reversed(parts))


def _page_annots(page) -> list:
    annots = page.obj.get("/Annots")
    if annots is None or not isinstance(annots, pikepdf.Array):
        return []
    return list(annots)


def _match_pages(orig: pikepdf.Pdf, mod: pikepdf.Pdf):
    """Two-pointer in-order matching of original pages into the modified
    file (bisim excluding /Annots). Returns (pairs, insertions) where pairs
    is [(orig_ix, mod_ix)] covering EVERY original page in order, and
    insertions is [(after_orig_ix, mod_ix)] for pages new to the document
    (after_orig_ix = -1 inserts before everything). Raises ValueError when
    an original page has no match (removal/reorder/content drift)."""
    pairs: list[tuple[int, int]] = []
    insertions: list[tuple[int, int]] = []
    mod_ix = 0
    n_mod = len(mod.pages)
    for orig_ix in range(len(orig.pages)):
        found = None
        probe = mod_ix
        pending: list[int] = []
        while probe < n_mod:
            if _bisim(orig.pages[orig_ix].obj, mod.pages[probe].obj, set(), skip=_PAGE_SKIP):
                found = probe
                break
            pending.append(probe)
            probe += 1
        if found is None:
            raise ValueError(
                f"Page {orig_ix + 1} of the signed original has no structural "
                "match in the edited file (removed, reordered, or its content "
                "changed) — that edit cannot be appended without invalidating"
            )
        for p in pending:
            insertions.append((orig_ix - 1, p))
        pairs.append((orig_ix, found))
        mod_ix = found + 1
    for p in range(mod_ix, n_mod):
        insertions.append((len(orig.pages) - 1, p))
    return pairs, insertions


def _apply_annot_delta(
    writer, page_ref, orig_page, mod_page, memo_mat
) -> tuple[bool, int, int, int]:
    """Compute and apply one page's /Annots delta onto the writer.

    Returns (changed, added, updated, removed). Kept annotations stay as
    their ORIGINAL refs; /NM-matched changed ones reconcile IN PLACE via
    _update_in_place (so /AcroForm references to the same widget object
    stay valid and back-pointers are never duplicated); new ones
    materialize. Order follows the MODIFIED file (z-order is real)."""
    orig_annots = _page_annots(orig_page)
    mod_annots = _page_annots(mod_page)

    used: set[int] = set()
    by_nm: dict[bytes, list[int]] = {}
    by_field: dict[str, list[int]] = {}
    for i, a in enumerate(orig_annots):
        nm = _annot_nm(a)
        if nm is not None:
            by_nm.setdefault(nm, []).append(i)
        if _is_widget(a):
            fname = _widget_field_name(a)
            if fname is not None:
                by_field.setdefault(fname, []).append(i)

    added = updated = 0
    new_refs = []
    new_is_orig_ref = []
    for m in mod_annots:
        match = None
        for i, a in enumerate(orig_annots):
            if i in used:
                continue
            if _bisim(a, m, set()):
                match = ("keep", i)
                break
        if match is None and _is_widget(m):
            # Widgets pair by FIELD identity; their content is reconciled
            # by the /AcroForm pass on the very same objects — treating a
            # filled widget as remove+add would fork the object graph.
            fname = _widget_field_name(m)
            if fname is not None:
                for i in by_field.get(fname, []):
                    if i not in used:
                        match = ("keep", i)
                        break
        if match is None:
            nm = _annot_nm(m)
            if nm is not None:
                for i in by_nm.get(nm, []):
                    if i not in used:
                        match = ("update", i)
                        break
        if match is None:
            ref = _materialize(m, writer, memo_mat)
            if not isinstance(ref, generic.IndirectObject):
                ref = writer.add_object(ref)
            new_refs.append(ref)
            new_is_orig_ref.append(False)
            added += 1
            continue
        kind, i = match
        used.add(i)
        a = orig_annots[i]
        if not a.is_indirect:
            # A direct-in-array annotation has no ref to keep or update —
            # rewrite it as a fresh object with the modified content.
            ref = writer.add_object(_materialize_direct(m, writer, memo_mat, 0))
            new_refs.append(ref)
            new_is_orig_ref.append(False)
            if kind == "update":
                updated += 1
            continue
        ref = _writer_ref(a.objgen, writer)
        if kind == "update":
            if _update_in_place(ref, a, m, writer, memo_mat):
                updated += 1
        new_refs.append(ref)
        new_is_orig_ref.append(True)

    for i, a in enumerate(orig_annots):
        if i not in used and _is_widget(a):
            raise _TransplantRefusal(
                "the edit removed or rebuilt a form widget — beyond the "
                "annotate/fill tier for a signed document"
            )

    removed = len(orig_annots) - len(used)

    same_sequence = (
        removed == 0
        and added == 0
        and len(new_refs) == len(orig_annots)
        and all(new_is_orig_ref)
        and all(a.is_indirect for a in orig_annots)
        and [r.idnum for r in new_refs] == [a.objgen[0] for a in orig_annots]
    )
    changed = added > 0 or removed > 0 or updated > 0 or not same_sequence
    if not same_sequence:
        page_obj = page_ref.get_object()
        page_obj[generic.pdf_name("/Annots")] = generic.ArrayObject(new_refs)
        writer.mark_update(page_ref)
    return changed, added, updated, removed


def _acroform_delta(writer, orig: pikepdf.Pdf, mod: pikepdf.Pdf, memo_mat) -> int:
    """Transplant /AcroForm differences (fill: values, appearances, flags).

    Fields pair by fully-qualified /T (position-disambiguated for
    duplicates) and reconcile IN PLACE, so page /Annots references to the
    same widget objects stay intact. A field name present only in the
    MODIFIED file means the edit ADDED a form field — beyond the fill tier
    (and beyond what DocMDP permits) — so it refuses rather than half-
    registering. Returns updated-field count."""
    orig_acro = orig.Root.get("/AcroForm")
    mod_acro = mod.Root.get("/AcroForm")
    if mod_acro is None:
        return 0  # a fill never removes the form; nothing to do
    if orig_acro is not None and _bisim(orig_acro, mod_acro, set()):
        return 0
    if orig_acro is None:
        raise _TransplantRefusal(
            "the edit added a form where the signed original had none"
        )

    def walk(fields, prefix, out, depth=0):
        if depth > MAX_FIELD_DEPTH or fields is None:
            return
        if not isinstance(fields, pikepdf.Array):
            return
        for f in fields:
            if not isinstance(f, pikepdf.Dictionary):
                continue
            t = f.get("/T")
            name = (prefix + "." if prefix else "") + (str(t) if t is not None else "")
            out.setdefault(name, []).append(f)
            kids = f.get("/Kids")
            if kids is not None and isinstance(kids, pikepdf.Array) and len(kids) > 0:
                walk(kids, name, out, depth + 1)

    orig_fields: dict[str, list] = {}
    mod_fields: dict[str, list] = {}
    walk(orig_acro.get("/Fields"), "", orig_fields)
    walk(mod_acro.get("/Fields"), "", mod_fields)

    updated = 0
    for name, mods in mod_fields.items():
        origs = orig_fields.get(name, [])
        if len(mods) > len(origs):
            raise _TransplantRefusal(
                f"the edit added form field '{name}' — form structure "
                "changes cannot be appended to a signed document"
            )
        for pos, m in enumerate(mods):
            o = origs[pos]
            if _bisim(o, m, set()):
                continue
            if not o.is_indirect:
                raise _TransplantRefusal(
                    f"field '{name}' is stored inline and cannot be "
                    "reconciled in place"
                )
            ref = _writer_ref(o.objgen, writer)
            if _update_in_place(ref, o, m, writer, memo_mat):
                updated += 1

    # AcroForm-level keys (NeedAppearances, DA, DR) reconcile on the
    # /AcroForm dict itself. /Fields is excluded (its members were updated
    # in place; membership is settled above) — and so is /SigFlags: every
    # rebuild pipeline RE-DERIVES it on the assumption that page surgery
    # killed the signatures (acroform-carry drops the AppendOnly bit), but
    # the transplant's whole point is that they SURVIVE — the original's
    # value stands, or pyHanko's own diff analysis flags the revision as a
    # suspicious modification (live e2e catch: 3 -> 1).
    _ACRO_KEEP = frozenset({"/Fields", "/SigFlags"})
    if not _bisim(orig_acro, mod_acro, set(), skip=_ACRO_KEEP):
        if orig_acro.is_indirect:
            ref = _writer_ref(orig_acro.objgen, writer)
            live = ref.get_object()
            changed = False
            for k in list(mod_acro.keys()):
                ks = str(k)
                if ks in _ACRO_KEEP:
                    continue
                ov = orig_acro.get(ks)
                mv = mod_acro.get(ks)
                if ov is not None and _bisim(ov, mv, set()):
                    continue
                live[generic.pdf_name(ks)] = _materialize(mv, writer, memo_mat)
                changed = True
            gone = (
                {str(k) for k in orig_acro.keys()}
                - {str(k) for k in mod_acro.keys()}
                - _ACRO_KEEP
            )
            for ks in gone:
                if generic.pdf_name(ks) in live:
                    del live[generic.pdf_name(ks)]
                    changed = True
            if changed:
                writer.mark_update(ref)
                updated += 1
    return updated


def transplant_incremental(original: str, modified: str, output: str) -> dict:
    """Append ``modified``'s annotate/fill/add-page delta onto ``original``.

    Returns {"applied": bool, ...counts} — applied=False carries a
    ``reason`` and writes NOTHING. On success ``output`` (which may equal
    ``modified`` but never ``original``) receives original-bytes + one
    appended revision; the byte-prefix property is asserted before the
    file lands (stage-and-swap, the pikepdf in-place discipline).
    """
    validate_pdf(original)
    validate_pdf(modified)
    out_path = Path(output)
    if Path(original).resolve() == out_path.resolve():
        raise ValueError("Refusing to overwrite the signed original in place")

    if not has_live_signatures(original):
        return {"applied": False, "reason": "not-signed"}

    orig_bytes = Path(original).read_bytes()

    try:
        with pikepdf.open(original) as orig, pikepdf.open(modified) as mod:
            if orig.is_encrypted or mod.is_encrypted:
                return {"applied": False, "reason": "encrypted"}

            # Catalog-level guard: beyond /AcroForm (fill), /Pages (page
            # tree), and metadata (ignored — rebuild churn), the roots must
            # agree, or the edit exceeds the append-safe tier. /Version is
            # metadata too: a signing append writes it into the catalog
            # while rebuilds normalize it into the header — the original's
            # own bytes keep whichever it had (live catch: the e2e fixture,
            # signed by pyHanko, refused every transplant over exactly this).
            if not _bisim(
                orig.Root, mod.Root, set(),
                skip=frozenset(
                    {"/AcroForm", "/Pages", "/Metadata", "/PieceInfo", "/Version"}
                ),
            ):
                return {"applied": False, "reason": "catalog-changed"}

            try:
                pairs, insertions = _match_pages(orig, mod)
                if any(after_ix < 0 for after_ix, _ in insertions):
                    # pyHanko's insert_page has no before-first position on
                    # a non-empty tree; a page prepended to a signed doc
                    # falls back to the rewrite path (which invalidates —
                    # the same choice every structural edit makes).
                    return {"applied": False, "reason": "page-insert-at-start"}

                writer = IncrementalPdfFileWriter(io.BytesIO(orig_bytes))
                memo_mat: dict = {}

                pages_changed = added = updated = removed = 0
                for orig_ix, mod_ix in pairs:
                    page_ref = writer.find_page_for_modification(orig_ix)[0]
                    changed, a, u, r = _apply_annot_delta(
                        writer, page_ref, orig.pages[orig_ix],
                        mod.pages[mod_ix], memo_mat,
                    )
                    if changed:
                        pages_changed += 1
                    added += a
                    updated += u
                    removed += r

                fields_updated = _acroform_delta(writer, orig, mod, memo_mat)

                inserted = 0
                # Reverse order keeps each `after` index valid against the
                # original numbering while earlier insertions are pending.
                for after_ix, mod_ix in sorted(insertions, reverse=True):
                    page_obj = _materialize_direct(
                        mod.pages[mod_ix].obj, writer, memo_mat, 0
                    )
                    # insert_page owns /Parent; a stale one from the source
                    # would point into the MODIFIED file's tree.
                    if generic.pdf_name("/Parent") in page_obj:
                        del page_obj[generic.pdf_name("/Parent")]
                    writer.insert_page(page_obj, after=after_ix)
                    inserted += 1
            except (ValueError, _TransplantRefusal) as e:
                return {"applied": False, "reason": str(e)}

            if not (pages_changed or fields_updated or inserted):
                return {"applied": False, "reason": "no-delta"}

            buf = io.BytesIO()
            writer.write(buf)
            result = buf.getvalue()
    except (pikepdf.PdfError, OSError) as e:
        raise RuntimeError(f"Incremental transplant failed: {e}") from e

    # THE property this module exists for — and the cheap proof of it.
    if result[: len(orig_bytes)] != orig_bytes:
        raise RuntimeError(
            "Incremental write did not preserve the original bytes verbatim "
            "— refusing to emit a signature-breaking file"
        )
    # The appended revision must still parse as a healthy document.
    with pikepdf.open(io.BytesIO(result)):
        pass

    fd, tmp = tempfile.mkstemp(
        dir=str(out_path.parent), suffix=".transplant-tmp"
    )
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(result)
        os.replace(tmp, output)
    except BaseException:
        try:
            os.remove(tmp)
        except OSError:
            pass
        raise

    return {
        "applied": True,
        "pages_changed": pages_changed,
        "annots_added": added,
        "annots_updated": updated,
        "annots_removed": removed,
        "fields_updated": fields_updated,
        "pages_inserted": inserted,
        "bytes_appended": len(result) - len(orig_bytes),
    }


def finalize_preserving_signatures(original: str, rewritten_tmp: str) -> dict:
    """Call-site helper for in-place engine ops (fill, XFDF import, link
    authoring, comment deletion): the op has produced a full REWRITE at
    ``rewritten_tmp``; when ``original`` carries live signatures, replace
    that rewrite with an incremental transplant IN THE SAME TMP file. The
    caller's own atomic swap then lands whichever bytes won.

    Never raises for "not applicable" — the rewrite simply stands (that is
    today's behavior, and for unsigned files it is the right one).
    """
    try:
        if not has_live_signatures(original):
            return {"preserved": False, "reason": "not-signed"}
        result = transplant_incremental(original, rewritten_tmp, rewritten_tmp)
        if result.get("applied"):
            return {"preserved": True, **{k: v for k, v in result.items() if k != "applied"}}
        return {"preserved": False, "reason": result.get("reason", "unknown")}
    except RuntimeError as e:
        return {"preserved": False, "reason": str(e)}
