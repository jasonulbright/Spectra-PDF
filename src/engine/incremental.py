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

Two independent questions decide whether a delta lands, and they are NOT
the same question (ISO 32000-2, 12.8.2.2.2: a validator verifies the byte
range digest FIRST, then verifies that the modifications are permitted by
the transform parameters):

  1. MECHANICS — can the delta be expressed as an append at all? That is
     what the delta computation below answers.
  2. PERMISSION — does the document's own certification allow a change of
     that kind? That is what the ceiling answers, from Table 257.

Nothing in the file format restricts what an incremental update may
contain; a page addition is APPENDABLE always and PERMITTED by DocMDP
never — Table 257's P=2 admits page-template instantiation as its only
page-adding change, and no template machinery exists here (recorded gap:
whether an arbitrary insertion could be expressed as an instantiation is
not decided by the clause text). Emitting a preserved byte range under a
certification that forbids the change would be a file our own verifier
calls a policy violation, so such deltas REFUSE and the caller's rewrite
stands.

Delta classes (what the computation reports, and what the ceiling judges):

  - ``annotations`` — per-page /Annots membership, order, and annotation
    content (add, modify, remove — appearance streams included),
  - ``form-fill`` — /AcroForm and field content (/V, widget /AP//AS,
    NeedAppearances, /DA//DR additions),
  - ``page-keys`` — a page's own /Rotate and box geometry,
  - ``page-structure`` — page insertion, removal and reordering.
  - ``format-version`` — a higher effective declaration required by the delta.

Ceiling, per ISO 32000-2 Table 257 (clause 12.8.2.2): an uncertified
(approval-signature-only) document has none — every class above is
carried. A certification at /P 1 permits no change and refuses every
class; /P 2 permits form filling and signing, so only ``form-fill``
survives; /P 3 adds annotation creation, deletion and modification, so
``annotations`` survives too. A certification whose /P is outside 1–3 is
an unknown policy and permits nothing. Field locks (FieldMDP) keep their
existing enforcement at the caller's decision table.

Anything else — content-stream or resource drift, encryption changes,
form structure changes — refuses with ``applied=False`` and a reason; the
caller falls back to the rewrite path it was already on. Document
metadata (/Info, XMP) is deliberately IGNORED rather than transplanted:
incidental Producer/ModDate churn from a rebuild must neither block the
transplant nor masquerade as a user edit.

Mechanical refusal is a RESULT: each caller has a rewrite fallback. A failed
policy read instead blocks both paths; the finalizer raises so its staging
owner discards the unpublished output.

Comparison notes: page content pairs structurally; owned page, field and
annotation identities are then bound BEFORE copying any delta. Graph edges
compare those identities, not the equal-looking contents of their targets.
Other values use structural bisimulation (pair-memoized for cycles; streams
compare raw-then-decoded; numbers compare numerically). Ambiguous ownership
refuses instead of importing another copy of a page or registered field.
"""

import io
import os
import tempfile
from pathlib import Path

import pikepdf
from pyhanko.pdf_utils import generic
from pyhanko.pdf_utils.incremental_writer import IncrementalPdfFileWriter
from pyhanko.pdf_utils.metadata.model import DocumentMetadata

from .docmdp import certification_of_pdf, POLICY_UNREADABLE, refuse_unreadable_policy
from .acroform import live_signature_fields
from .fieldmdp import locked_fields, locks_of_pdf
from .inplace import is_same_file
from .validate import validate_pdf
from .pdf_version import effective_version

MAX_FIELD_DEPTH = 32
_NUM_EPS = 1e-6

# Page-dict keys the transplant reconciles onto the original page object:
# /Rotate and the six page boundaries (ISO 32000-2 Table 31; boundary
# semantics in 14.11.2). Each is a wholly appendable single-key change.
_PAGE_CARRY = (
    "/Rotate", "/MediaBox", "/CropBox", "/BleedBox", "/TrimBox", "/ArtBox",
)
# Of those, the ones Table 31 marks inheritable (7.7.3.4): omitting one from a
# page dict does not remove its value, it exposes an ancestor's. /BleedBox,
# /TrimBox and /ArtBox are not inheritable and default to /CropBox.
_PAGE_INHERITABLE = frozenset({"/Rotate", "/MediaBox", "/CropBox"})
# The page-tree back-pointer: never copied from a source page, and written
# only by whichever code puts the page into a tree.
_PAGE_PARENT = frozenset({"/Parent"})
# Page-dict keys whose difference the transplant HANDLES (everything else
# differing at page level refuses). /Annots is the annotation delta itself;
# the carried keys are reconciled by _apply_page_key_delta.
_PAGE_SKIP = frozenset({"/Annots", *_PAGE_CARRY})
# Keys ignored when comparing stream dicts — encoding details of the same
# decoded bytes.
_STREAM_SKIP = frozenset({"/Length", "/Filter", "/DecodeParms"})

#: What a computed delta can consist of. Ordered so a refusal names the same
#: class for the same delta on every run.
DELTA_CLASSES = ("form-fill", "annotations", "page-keys", "page-structure", "format-version")

#: ISO 32000-2 Table 257 (clause 12.8.2.2): /P 1 permits no change; /P 2
#: permits filling in forms, instantiating page templates and signing; /P 3
#: permits everything /P 2 does plus annotation creation, deletion and
#: modification. Page-template instantiation is the only page-adding change
#: any level admits and no template machinery exists in this product, so
#: `page-structure` and `page-keys` appear in no row.
_CERTIFIED_PERMITS: dict[str, frozenset[str]] = {
    "none": frozenset(),
    "form-fill": frozenset({"form-fill"}),
    "annotate": frozenset({"form-fill", "annotations"}),
    "unknown": frozenset(),
}


# ---------------------------------------------------------------------------
# Signedness
# ---------------------------------------------------------------------------

def _effective_ft(node, inherited, depth=0):
    if depth > MAX_FIELD_DEPTH or not isinstance(node, pikepdf.Dictionary):
        return inherited
    ft = node.get("/FT")
    return ft if ft is not None else inherited


def _live_sig_count(path: str) -> int:
    try:
        with pikepdf.open(path) as pdf:
            return len(live_signature_fields(pdf, strict=True))
    except Exception:
        refuse_unreadable_policy()


def has_live_signatures(path: str) -> bool:
    """True when the document carries at least one FILLED signature field.

    Presence-only walk (no crypto) — this is the cheap gate deciding
    whether a rewrite must be re-expressed as an incremental append.
    """
    return _live_sig_count(path) > 0


def signature_policy(path: str) -> dict:
    """What this document's own signatures allow to be changed.

    ``{"signed": bool, "count": int, "certified": bool, "level": str|None,
    "locks": [{"action": str, "fields": [str]}]}``. The same presence-only read
    as ``has_live_signatures`` plus the catalog's certification entry and the
    live signatures' field locks — no cryptography and no difference analysis,
    so it stays cheap enough to consult before every edit.

    ``level`` is None both for an uncertified document and for a certification
    recording a permission value outside the three defined levels; ``certified``
    is what distinguishes those, and an unrecognized level is treated by callers
    as an unknown one rather than as an absent one.

    ``locks`` is per SIGNATURE, not per document: a certification and a later
    approval signature can disagree about the same field.
    An ``error`` marks any unreadable policy component and takes precedence
    over all partial facts. Absence of that error is required before editing.
    """
    try:
        with pikepdf.open(path) as pdf:
            return signature_policy_of_pdf(pdf)
    except Exception:
        return {"signed": False, "count": 0, "certified": False,
                "level": None, "locks": [], "error": POLICY_UNREADABLE}


def signature_policy_of_pdf(pdf) -> dict:
    """All policy facts from one open document; uncertainty outranks facts."""
    policy = {"signed": False, "count": 0, "certified": False,
              "level": None, "locks": []}
    try:
        count = len(live_signature_fields(pdf, strict=True))
        policy.update(signed=count > 0, count=count)
        certification = certification_of_pdf(pdf)
        policy.update(certified=certification["certified"], level=certification["level"])
        if certification.get("error") is not None:
            policy["error"] = POLICY_UNREADABLE
        policy["locks"] = locks_of_pdf(pdf, strict=True)
    except Exception:
        policy["error"] = POLICY_UNREADABLE
    return policy


# A structural edit appears in no row: page removal, reordering, content edits
# and flattening all fall outside the incremental-append tier, so they coalesce
# the file and break every byte range whatever a policy permits. That is a
# property of the edit, not of the certification.
_PERMITTED_CLASSES: dict = {
    "uncertified": ("form-fill", "annotate"),
    "form-fill": ("form-fill",),
    "annotate": ("form-fill", "annotate"),
    "unknown": (),
}

EDIT_CLASSES = ("form-fill", "annotate", "structural")


def _lock_refusal(policy: dict, edit_class: str, fields, typed=None) -> dict | None:
    """The field-lock verdict for a form fill, or None when no lock bites.

    A locked field's update is rejected by the difference analysis whether or
    not the document is certified, so the file an edit like this produces
    reports as illegally modified in every reader -- which is why this refuses
    rather than warns, the same posture as a no-changes certification.

    Targets the caller cannot name are still decidable against a lock covering
    ALL fields: whatever such a fill touches, that lock covers it.
    """
    if edit_class != "form-fill":
        return None
    locks = policy.get("locks") or []
    if not locks:
        return None
    if fields is None:
        if any(lock.get("action") == "all" for lock in locks):
            return {"kind": "refuse", "reason": "fields-locked", "fields": []}
        return None
    hit = locked_fields(locks, list(fields))
    if not hit:
        return None
    # Indirect only when NOTHING the caller named is itself locked: a fill that
    # also names a locked field is refused for that, and naming the calculation
    # as the cause would misdescribe it.
    named = list(typed) if typed is not None else []
    if named and not any(name in named for name in hit):
        return {"kind": "refuse", "reason": "fields-locked", "fields": hit,
                "indirect": True, "typed": named}
    return {"kind": "refuse", "reason": "fields-locked", "fields": hit}


def signed_edit_decision(policy: dict, edit_class: str, fields=None, typed=None) -> dict:
    """Whether an edit of this class may proceed against this document's policy.

    ``{"kind": "proceed"}`` or ``{"kind": "refuse"|"warn", "reason": <enum>}``.
    The reason is a stable name, never display text -- a headless caller reports
    it and a surface renders it. A ``fields-locked`` refusal also carries the
    field names it stopped.

    ``fields`` names what a form fill targets, or None when the caller cannot
    name them. With a calculating form that is the TRANSITIVE set — everything
    typed plus everything the document's ``/CO`` recomputes as a result —
    because filling an unlocked line item that changes a locked Total produces
    a file that reports as altered. ``typed`` names the caller's own half of
    that set, so a refusal caused only by the calculation can say so.

    A no-changes certification REFUSES rather than warns: the author's policy
    forbids every change, the signing machinery will not counter-sign such a
    file, and every edit produces a document that reports as illegally
    modified. It is decided FIRST because it refuses the whole edit rather than
    one field of it.

    The twin of this table lives in the renderer (``lib/signatures.ts``); the
    two are pinned case for case against ``tests/fixtures/signed-edit-corpus.json``.
    """
    if edit_class not in EDIT_CLASSES:
        raise ValueError('edit class must be "form-fill", "annotate" or "structural"')
    if policy.get("error") is not None:
        return {"kind": "refuse", "reason": POLICY_UNREADABLE}
    signed = bool(policy.get("signed"))
    certified = bool(policy.get("certified"))
    level = policy.get("level")
    if not signed and not certified:
        return {"kind": "proceed"}
    if certified and level == "none":
        return {"kind": "refuse", "reason": "certified-no-changes"}
    locked = _lock_refusal(policy, edit_class, fields, typed)
    if locked is not None:
        return locked
    if not certified:
        if edit_class in _PERMITTED_CLASSES["uncertified"]:
            return {"kind": "proceed"}
        return {"kind": "warn", "reason": "signed"}
    key = level if level in ("form-fill", "annotate") else "unknown"
    if edit_class in _PERMITTED_CLASSES[key]:
        return {"kind": "proceed"}
    return {"kind": "warn", "reason": "certified-" + key}


def _ceiling_refusal(certification: dict, classes) -> dict | None:
    """The certification's verdict on a computed delta, or None when it permits.

    Consulted on the DELTA, not on the caller's intent: a rebuild that renames
    nothing and moves nothing still carries whatever it carries, and Table 257
    judges the change rather than the gesture that produced it. An uncertified
    document has no ceiling — an approval signature records who signed what,
    not what may follow it, which is why every append verifies clean there.

    The reason names the certification level AND the class it forbids, so a
    caller reports which policy stopped which change without re-deriving
    either. It is a RESULT: the caller's rewrite path is still valid, and the
    difference between "the format cannot express this" and "the author
    forbade it" must stay visible to the surface that warns about it.
    """
    if certification.get("error") is not None:
        return {"applied": False, "blocked": True, "reason": POLICY_UNREADABLE}
    if not certification.get("certified"):
        return None
    level = certification.get("level")
    named = level if level in _CERTIFIED_PERMITS and level != "unknown" else "unknown"
    permitted = _CERTIFIED_PERMITS[named]
    forbidden = [c for c in DELTA_CLASSES if c in classes and c not in permitted]
    if not forbidden:
        return None
    return {
        "applied": False,
        "reason": f"certified-{named}-forbids-{forbidden[0]}",
        "certification_level": named,
        "delta_classes": [c for c in DELTA_CLASSES if c in classes],
        "forbidden_classes": forbidden,
    }


# ---------------------------------------------------------------------------
# Structural bisimulation over pikepdf objects
# ---------------------------------------------------------------------------

def _is_num(obj) -> bool:
    return isinstance(obj, (int, float)) or type(obj).__name__ == "Decimal"


def _requires_correspondence(obj) -> bool:
    """Document-owned objects cannot be imported as anonymous new subtrees."""
    return isinstance(obj, pikepdf.Dictionary) and (
        obj.get("/Type") in (pikepdf.Name.Page, pikepdf.Name.Pages, pikepdf.Name.Catalog)
        or obj.get("/FT") is not None or obj.get("/Subtype") == pikepdf.Name.Widget
    )


def _bisim(a, b, memo: set, skip: frozenset = frozenset(), depth: int = 0,
           identities=None) -> bool:
    if depth > 200:
        return False  # pathological nesting — refuse toward "different"
    a_ind = isinstance(a, pikepdf.Object) and a.is_indirect
    b_ind = isinstance(b, pikepdf.Object) and b.is_indirect
    # Owned objects (pages, annotations, fields) have a separate delta pass.
    # At an edge compare their proven identities, not recursively their pixels
    # or values: two blank pages are not interchangeable link destinations.
    if depth and identities is not None:
        if b_ind and b.objgen in identities:
            return a_ind and identities[b.objgen] == a.objgen
        if _requires_correspondence(b):
            return False  # an orphan cannot equal a live owner by its content
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
            if not _bisim(a.stream_dict.get(k), b.stream_dict.get(k), memo,
                          depth=depth + 1, identities=identities):
                return False
        try:
            if a.read_raw_bytes() == b.read_raw_bytes():
                # Raw bytes mean the same thing only under the SAME decoder,
                # including its parameters (e.g. TIFF/PNG predictors).
                if all(_bisim(a.stream_dict.get(k), b.stream_dict.get(k), set(),
                              depth=depth + 1, identities=identities)
                       for k in ("/Filter", "/DecodeParms")):
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
            if identities is None and k in ("/P", "/Parent"):
                if (a.get(k) is None) != (b.get(k) is None):
                    return False
                continue
            if not _bisim(a.get(k), b.get(k), memo, depth=depth + 1, identities=identities):
                return False
        return True

    a_is_arr = isinstance(a, pikepdf.Array)
    b_is_arr = isinstance(b, pikepdf.Array)
    if a_is_arr != b_is_arr:
        return False
    if a_is_arr:
        if len(a) != len(b):
            return False
        return all(_bisim(a[i], b[i], memo, depth=depth + 1, identities=identities)
                   for i in range(len(a)))

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
        if _requires_correspondence(obj):
            raise _TransplantRefusal("unmapped-document-object-reference")
        placeholder = writer.allocate_placeholder()
        memo[key] = placeholder
        built = _materialize_direct(obj, writer, memo, depth)
        writer.add_object(built, idnum=placeholder.idnum)
        return placeholder

    if _requires_correspondence(obj):
        raise _TransplantRefusal("unmapped-document-object-reference")
    return _materialize_direct(obj, writer, memo, depth)


def _materialize_direct(obj, writer, memo, depth, skip=frozenset()):
    """``skip`` drops keys of THIS object before the walk descends.

    A page dict's /Parent is the one entry that must never be followed: it
    reaches the modified file's page tree, and from there every page and every
    content stream in it, so a single inserted page would append a copy of the
    whole document as objects nothing references. Deleting the key after the
    fact does not undo the copy — it only hides it.
    """
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
            if str(k) in skip:
                continue
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


def _resolved(value):
    """A writer-side value with any indirect reference followed.

    ``DictionaryObject`` subclasses ``dict``, so ``.get`` hands back the RAW
    entry while ``[]`` resolves it — a walk that uses ``.get`` and then tests
    the result's type sees a reference where a dictionary is, and silently
    stops.
    """
    return value.get_object() if isinstance(value, generic.IndirectObject) else value


class _TransplantRefusal(Exception):
    """A delta outside the append-safe tier — reported, never raised out."""


class _ObjectMap(dict):
    """Copy cache plus the independently planned identities of owned objects."""

    def __init__(self):
        super().__init__()
        self.identities = {}
        self.reverse = {}
        self.field_pairs = []
        self.annot_pairs = {}
        self.original_owners = {}

    def bind(self, modified, ref, original=None):
        if not modified.is_indirect:
            return
        key = modified.objgen
        if key in self and self[key] != ref:
            raise _TransplantRefusal("ambiguous-object-correspondence")
        old = original.objgen if original is not None and original.is_indirect else None
        if old is not None and old in self.reverse and self.reverse[old] != key:
            raise _TransplantRefusal("forked-object-correspondence")
        self[key] = ref
        self.identities[key] = old
        if old is not None:
            self.reverse[old] = key

    def equal(self, original, modified, *, reference=False, skip=frozenset()):
        return _bisim(original, modified, set(), skip=skip,
                      depth=int(reference), identities=self.identities)


def _update_in_place(
    ref, orig_obj, mod_obj, writer, memo, depth: int = 0, only=None
) -> bool:
    """Reconcile ONE existing original object toward its modified twin,
    preserving every reference that did not change.

    The naive alternative — clear + rewrite from a full materialization —
    is a correctness trap: a widget's /P (and a kid field's /Parent) would
    be materialized too, dragging a duplicate of the whole page graph into
    the appended revision. Instead: keys whose values are bisim-equal are
    LEFT UNTOUCHED (original nested refs intact); ownership back-pointers are
    never rewritten. Each field/widget has its own planned update, and /Kids
    arrays use the mapped refs even when reordered. A Popup's /Parent is an
    annotation edge, not field/page ownership, and follows the ordinary delta.
    Only genuinely-new values materialize.
    Returns whether anything changed (and marks the update if so).

    ``only`` confines BOTH halves — the write pass and the removal sweep — to
    a named key set, which is how a page object is reconciled: its /Contents
    and /Resources must stay refused, so the whole-dict form of this call
    would be the wrong tool for it. ``mod_obj`` may then be a plain mapping
    carrying the values to reach (an inherited page attribute has no entry in
    the modified page's own dict, and the value that must land there is the
    effective one, not the absent one).
    """
    if depth > MAX_FIELD_DEPTH:
        raise _TransplantRefusal("field nesting too deep to reconcile")
    live = ref.get_object()
    changed = False
    for k in list(mod_obj.keys()):
        ks = str(k)
        if ks == "/P" and orig_obj.get(ks) is None:
            # /P is optional for most annotations. A rewrite may add the
            # pointer already implied by /Annots; keeping it absent is exact.
            value = mod_obj.get(ks)
            if (isinstance(value, pikepdf.Object) and value.is_indirect
                    and memo.identities.get(value.objgen) is not None
                    and memo.identities[value.objgen] == memo.original_owners.get(orig_obj.objgen)):
                continue
        if ks == "/P" or (ks == "/Parent" and mod_obj.get("/Subtype") != pikepdf.Name.Popup):
            if not memo.equal(orig_obj.get(ks), mod_obj.get(ks), reference=True):
                raise _TransplantRefusal("owned-object-backpointer-changed")
            continue
        if only is not None and ks not in only:
            continue
        orig_val = orig_obj.get(ks)
        mod_val = mod_obj.get(ks)
        if orig_val is not None and memo.equal(orig_val, mod_val, reference=True):
            continue
        # Child fields/widgets have their own mapped update pass. Re-listing
        # /Kids uses those references, including a reordered widget array;
        # positional recursion would update the wrong sibling after a reorder.
        live[generic.pdf_name(ks)] = _materialize(mod_val, writer, memo)
        changed = True
    removed_keys = (
        {str(k) for k in orig_obj.keys()}
        - {str(k) for k in mod_obj.keys()}
        - ({"/P"} if mod_obj.get("/Subtype") == pikepdf.Name.Popup else {"/P", "/Parent"})
    )
    if only is not None:
        removed_keys &= set(only)
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


def _inherited_page_key(page_obj, key: str):
    """The value a page would take for ``key`` from its ANCESTORS alone.

    Only meaningful for the keys Table 31 marks inheritable; for the rest the
    answer is always None, which is what makes deleting one of them from a
    page dict a complete expression of its removal.
    """
    if key not in _PAGE_INHERITABLE:
        return None
    node = page_obj.get("/Parent")
    for _ in range(MAX_FIELD_DEPTH):
        if not isinstance(node, pikepdf.Dictionary):
            return None
        value = node.get(key)
        if value is not None:
            return value
        node = node.get("/Parent")
    return None


def _effective_page_key(page_obj, key: str):
    """What ``key`` actually resolves to for this page (7.7.3.4).

    qpdf pushes every inheritable attribute down onto the pages when it opens a
    file, so through pikepdf this reduces to the page's own entry — measured,
    and deliberately not depended on: the climb is what the clause says, and a
    reader that stops flattening must not silently change the answer.
    """
    value = page_obj.get(key)
    if value is not None:
        return value
    return _inherited_page_key(page_obj, key)


def _writer_inherited_page_key(live_page, key: str):
    """The same climb over the WRITER's graph — the file as it actually is.

    The distinction is load-bearing: qpdf's flattening means the reader's model
    can show a value on a page the file keeps on an ancestor, so a removal
    judged against the reader alone would delete an entry that is not there and
    leave the ancestor's value standing.
    """
    if key not in _PAGE_INHERITABLE:
        return None
    node = _resolved(live_page.get(generic.pdf_name("/Parent")))
    for _ in range(MAX_FIELD_DEPTH):
        if not isinstance(node, generic.DictionaryObject):
            return None
        value = node.get(generic.pdf_name(key))
        if value is not None:
            return _resolved(value)
        node = _resolved(node.get(generic.pdf_name("/Parent")))
    return None


def _apply_page_key_delta(writer, page_ref, orig_page, mod_page, memo_mat) -> bool:
    """Reconcile one page's /Rotate and box geometry toward the modified twin.

    Compared by EFFECTIVE value, never by dict membership: a rebuild that
    materializes an inherited /MediaBox onto the page, or hoists one off it,
    changes the dict without changing the page, and either direction would
    otherwise manufacture a delta that is not there.

    Confined to the carried keys, so /Annots is never touched here: an
    annotation's /Rect is in default user space (ISO 32000-2 Table 166) while
    /Rotate is a display property of the page (Table 31), so a rotation moves
    content and annotations together and rewriting rects to "follow" it would
    both displace every annotation and reclassify the delta as annotation work,
    which Table 257 admits only at /P 3.

    Writing a value is always exact — an entry on the page overrides whatever
    it would have inherited. REMOVING one is not: it is expressible only when
    the page's own dict is where the value lives and no ancestor supplies
    another, because this module never rewrites page-tree nodes. Otherwise it
    refuses, rather than emit a page whose geometry is an ancestor's instead of
    the default the edit asked for.
    """
    orig_obj = orig_page.obj
    mod_obj = mod_page.obj
    live = page_ref.get_object()
    reach: dict[str, object] = {}
    changed_keys: set[str] = set()
    for key in _PAGE_CARRY:
        eff_orig = _effective_page_key(orig_obj, key)
        eff_mod = _effective_page_key(mod_obj, key)
        if _bisim(eff_orig, eff_mod, set()):
            continue
        changed_keys.add(key)
        if eff_mod is None:
            if (
                generic.pdf_name(key) not in live
                or _writer_inherited_page_key(live, key) is not None
            ):
                raise _TransplantRefusal(
                    f"page-key-removal-inherited-{key[1:].lower()}"
                )
            continue  # absent from `reach` — the removal sweep deletes it
        reach[key] = eff_mod
    if not changed_keys:
        return False
    return _update_in_place(
        page_ref, orig_obj, reach, writer, memo_mat, only=changed_keys
    )


def _plan_pages(orig: pikepdf.Pdf, mod: pikepdf.Pdf) -> dict:
    """Pair the original's pages with the modified file's and name the shape.

    Pairing is structural (bisim over the page dict, excluding /Annots and the
    carried geometry keys), positional first and then greedy, so an unchanged
    document pairs index-for-index and a permutation still finds every page.

    The plan is one of two kinds:

    ``in-order``   every original page survives, in order; the only difference
                   is pages the edit ADDED. This is the shipped shape, and its
                   emission path is unchanged.
    ``rebuild``    pages were removed, reordered, or both, so the page tree's
                   /Kids is rewritten wholesale.

    A page with no twin is ambiguous the moment the edit ALSO adds an unpaired
    page: a rewritten page and a delete-plus-insert are the same two facts, and
    nothing in the file distinguishes them. Content and resource drift is
    exactly that case, and it refuses — the DocMDP transform exists to detect
    that change, so carrying it would preserve a byte range over a document
    that says something else.
    """
    n_orig = len(orig.pages)
    n_mod = len(mod.pages)
    orig_objs = [orig.pages[i].obj for i in range(n_orig)]
    mod_objs = [mod.pages[j].obj for j in range(n_mod)]

    mod_of_orig: dict[int, int] = {}
    taken: set[int] = set()
    for i in range(min(n_orig, n_mod)):
        if _bisim(orig_objs[i], mod_objs[i], set(), skip=_PAGE_SKIP):
            mod_of_orig[i] = i
            taken.add(i)
    for i in range(n_orig):
        if i in mod_of_orig:
            continue
        for j in range(n_mod):
            if j in taken:
                continue
            if _bisim(orig_objs[i], mod_objs[j], set(), skip=_PAGE_SKIP):
                mod_of_orig[i] = j
                taken.add(j)
                break

    removed = [i for i in range(n_orig) if i not in mod_of_orig]
    fresh = [j for j in range(n_mod) if j not in taken]
    if removed and fresh:
        raise ValueError(
            f"Page {removed[0] + 1} of the signed original has no structural "
            "match in the edited file, which also adds unmatched pages — a "
            "rewritten page cannot be told apart from a delete plus an insert, "
            "so that edit cannot be appended without invalidating"
        )

    pairs = [(i, mod_of_orig[i]) for i in sorted(mod_of_orig)]
    reordered = [m for _, m in pairs] != sorted(m for _, m in pairs)
    classes: set[str] = set()
    if removed or fresh or reordered:
        classes.add("page-structure")

    if not removed and not reordered:
        insertions = [
            (sum(1 for _, m in pairs if m < j) - 1, j) for j in fresh
        ]
        return {
            "kind": "in-order", "pairs": pairs, "insertions": insertions,
            "removed": [], "reordered": False, "classes": classes,
        }

    orig_of_mod = {m: o for o, m in pairs}
    sequence = [
        ("keep", orig_of_mod[j]) if j in orig_of_mod else ("new", j)
        for j in range(n_mod)
    ]
    return {
        "kind": "rebuild", "pairs": pairs, "insertions": [],
        "sequence": sequence, "removed": removed, "reordered": reordered,
        "classes": classes,
    }


def _rewrite_page_tree(writer, orig: pikepdf.Pdf, mod: pikepdf.Pdf,
                       plan: dict, page_refs: dict, memo_mat) -> int:
    """Write the reordered/pruned page sequence as one /Kids replacement.

    An incremental update cannot delete an object, so a removal is expressed
    the only way the format offers: the surviving pages are re-listed and the
    dropped ones stop being reachable from the newest revision.

    Every original page must hang off ONE page-tree node. Flattening a deeper
    tree would orphan the intermediate nodes and with them the attributes
    their descendants inherit (7.7.3.4) — the page geometry would change
    silently — so a multi-parent tree refuses instead.
    """
    parents = set()
    for orig_ix in range(len(orig.pages)):
        parent = orig.pages[orig_ix].obj.get("/Parent")
        if not isinstance(parent, pikepdf.Object) or not parent.is_indirect:
            raise _TransplantRefusal("page-tree-parent-unresolvable")
        parents.add(parent.objgen)
    if len(parents) != 1:
        raise _TransplantRefusal("page-tree-multi-parent")

    parent_ref = _writer_ref(parents.pop(), writer)
    parent_obj = parent_ref.get_object()

    inserted = 0
    kids = []
    for kind, ix in plan["sequence"]:
        if kind == "keep":
            kids.append(page_refs[ix])
            continue
        ref = memo_mat[mod.pages[ix].obj.objgen]
        page_obj = ref.get_object()
        page_obj[generic.pdf_name("/Parent")] = parent_ref
        kids.append(ref)
        inserted += 1

    delta = len(kids) - len(orig.pages)
    parent_obj[generic.pdf_name("/Kids")] = generic.ArrayObject(kids)
    writer.mark_update(parent_ref)
    # /Count is the page count of a node's whole subtree, so a removal or an
    # insertion moves it at every level up to the catalog — an unmarked
    # ancestor would ship a count the newest revision contradicts.
    node = parent_obj
    while isinstance(node, generic.DictionaryObject):
        node[generic.pdf_name("/Count")] = generic.NumberObject(
            int(node[generic.pdf_name("/Count")]) + delta
        )
        writer.update_container(node)
        node = _resolved(node.get(generic.pdf_name("/Parent")))
    return inserted


def _field_index(acro):
    out = {}

    def walk(fields, prefix="", inherited_ft=None, depth=0, ancestors=frozenset()):
        if fields is None:
            return
        if depth > MAX_FIELD_DEPTH or not isinstance(fields, pikepdf.Array):
            raise _TransplantRefusal("field-tree-unresolvable")
        for node in fields:
            if not isinstance(node, pikepdf.Dictionary):
                raise _TransplantRefusal("field-tree-unresolvable")
            key = node.objgen if node.is_indirect else None
            if key is not None and key in ancestors:
                raise _TransplantRefusal("field-tree-cycle")
            t = node.get("/T")
            name = (prefix + "." if prefix else "") + (str(t) if t is not None else "")
            ft = _effective_ft(node, inherited_ft, depth)
            out.setdefault(name, []).append((node, ft))
            walk(node.get("/Kids"), name, ft, depth + 1,
                 ancestors | {key} if key is not None else ancestors)

    if isinstance(acro, pikepdf.Dictionary):
        walk(acro.get("/Fields"))
    return out


def _annotation_pages(pdf):
    owners = {}
    for page in pdf.pages:
        for annot in _page_annots(page):
            if not isinstance(annot, pikepdf.Dictionary):
                raise _TransplantRefusal("annotation-object-unresolvable")
            owner = annot.get("/P")
            if owner is not None and (
                not isinstance(owner, pikepdf.Dictionary) or not owner.is_indirect
                or owner.objgen != page.obj.objgen
            ):
                raise _TransplantRefusal("annotation-page-backpointer-mismatch")
            if annot.is_indirect:
                previous = owners.setdefault(annot.objgen, page.obj.objgen)
                if previous != page.obj.objgen:
                    raise _TransplantRefusal("annotation-has-multiple-pages")
    return owners


def _prepare_correspondence(writer, orig, mod, plan):
    """Bind every owned identity BEFORE recursively importing any delta.

    Surviving pages retain their actual writer refs. New pages enter the tree
    as empty shells first, so even forward/cyclic destinations can use them.
    Field and annotation pairing is a separate planning pass; shared owners
    and popup/reply edges cannot depend on page/annotation processing order.
    """
    memo = _ObjectMap()
    memo.bind(mod.Root, writer.root_ref, orig.Root)
    page_refs = {o: writer.find_page_for_modification(o)[0] for o, _ in plan["pairs"]}
    for o, m in plan["pairs"]:
        memo.bind(mod.pages[m].obj, page_refs[o], orig.pages[o].obj)
    fresh = sorted(set(range(len(mod.pages))) - {m for _, m in plan["pairs"]})
    if plan["kind"] == "in-order":
        for after, ix in sorted(plan["insertions"], reverse=True):
            ref = writer.insert_page(generic.DictionaryObject({
                generic.pdf_name("/Type"): generic.pdf_name("/Page"),
            }), after=after)
            memo.bind(mod.pages[ix].obj, ref)
    else:
        for ix in fresh:
            memo.bind(mod.pages[ix].obj, writer.add_object(generic.DictionaryObject({
                generic.pdf_name("/Type"): generic.pdf_name("/Page"),
            })))

    orig_owners, mod_owners = _annotation_pages(orig), _annotation_pages(mod)
    memo.original_owners = orig_owners
    orig_acro, mod_acro = orig.Root.get("/AcroForm"), mod.Root.get("/AcroForm")
    if isinstance(orig_acro, pikepdf.Dictionary) and isinstance(mod_acro, pikepdf.Dictionary):
        if orig_acro.is_indirect:
            memo.bind(mod_acro, _writer_ref(orig_acro.objgen, writer), orig_acro)
        originals = _field_index(orig_acro)
        for name, modified in _field_index(mod_acro).items():
            available = list(originals.get(name, []))
            for m, mft in modified:
                candidates = list(available)
                if len(candidates) > 1:
                    owner = mod_owners.get(m.objgen) if m.is_indirect else None
                    old_owner = memo.identities.get(owner)
                    candidates = [(o, ft) for o, ft in candidates
                                  if orig_owners.get(o.objgen) == old_owner]
                    if len(candidates) > 1:
                        candidates = [(o, ft) for o, ft in candidates if memo.equal(o, m, skip=frozenset({
                            "/AP", "/AS", "/V", "/DV", "/Kids", "/Parent", "/P",
                        }))]
                if not available:
                    continue  # the form delta emits its existing addition refusal
                if len(candidates) != 1:
                    raise _TransplantRefusal("ambiguous-field-widget-correspondence")
                o, oft = candidates[0]
                # Consume the chosen object, not an equal-looking sibling:
                # pikepdf dictionary equality is structural (and cyclic).
                del available[next(i for i, pair in enumerate(available) if pair[0] is o)]
                if oft != mft:
                    raise _TransplantRefusal("field-type-changed")
                memo.field_pairs.append((name, o, m, oft))
                if o.is_indirect:
                    memo.bind(m, _writer_ref(o.objgen, writer), o)

    for oix, mix in plan["pairs"]:
        original_annots, modified_annots = _page_annots(orig.pages[oix]), _page_annots(mod.pages[mix])
        used = set()
        pairs = []
        for m in modified_annots:
            found = None
            if m.is_indirect and m.objgen in memo.identities:
                wanted = memo.identities[m.objgen]
                found = next((i for i, o in enumerate(original_annots)
                              if i not in used and o.is_indirect and o.objgen == wanted), None)
                if found is None and _is_widget(m):
                    raise _TransplantRefusal("form-widget-page-changed")
            if found is None:
                exact = [i for i, o in enumerate(original_annots)
                         if i not in used and memo.equal(o, m)]
                if exact:
                    found = exact[0]
            if found is None:
                nm = _annot_nm(m)
                named = [i for i, o in enumerate(original_annots)
                         if i not in used and nm is not None and _annot_nm(o) == nm]
                if len(named) > 1:
                    raise _TransplantRefusal("ambiguous-annotation-name")
                if named:
                    found = named[0]
            pairs.append(found)
            if found is not None:
                used.add(found)
                o = original_annots[found]
                if o.is_indirect:
                    memo.bind(m, _writer_ref(o.objgen, writer), o)
        memo.annot_pairs[mod.pages[mix].obj.objgen] = pairs
    for page in mod.pages:
        for annot in _page_annots(page):
            if annot.is_indirect:
                memo.identities.setdefault(annot.objgen, None)
    return memo, page_refs, fresh


def _apply_annot_delta(
    writer, page_ref, orig_page, mod_page, memo_mat
) -> tuple[bool, int, int, int, set]:
    """Compute and apply one page's /Annots delta onto the writer.

    Returns (changed, added, updated, removed, classes). Kept annotations stay
    as their ORIGINAL refs; /NM-matched changed ones reconcile IN PLACE via
    _update_in_place (so /AcroForm references to the same widget object
    stay valid and back-pointers are never duplicated); new ones
    materialize. Order follows the MODIFIED file (z-order is real).

    A widget's presence in the array is a FORM fact, not an annotation one:
    Table 257 admits filling at /P 2 while annotations wait for /P 3, so a
    delta that only moves or adds widgets must not be reported as annotation
    work and refused a level too early."""
    orig_annots = _page_annots(orig_page)
    mod_annots = _page_annots(mod_page)

    used: set[int] = set()
    added = updated = 0
    classes: set[str] = set()
    new_refs = []
    new_is_orig_ref = []
    for m, i in zip(mod_annots, memo_mat.annot_pairs[mod_page.obj.objgen], strict=True):
        if i is None:
            ref = _materialize(m, writer, memo_mat)
            if not isinstance(ref, generic.IndirectObject):
                ref = writer.add_object(ref)
            new_refs.append(ref)
            new_is_orig_ref.append(False)
            added += 1
            classes.add("form-fill" if _is_widget(m) else "annotations")
            continue
        used.add(i)
        a = orig_annots[i]
        changed_body = not memo_mat.equal(a, m)
        if not a.is_indirect:
            # A direct-in-array annotation has no ref to keep or update —
            # rewrite it as a fresh object with the modified content.
            ref = writer.add_object(_materialize_direct(m, writer, memo_mat, 0))
            new_refs.append(ref)
            new_is_orig_ref.append(False)
            if changed_body:
                updated += 1
                classes.add("form-fill" if _is_widget(m) else "annotations")
            continue
        ref = _writer_ref(a.objgen, writer)
        if changed_body and not _is_widget(m):
            if _update_in_place(ref, a, m, writer, memo_mat):
                updated += 1
                classes.add("form-fill" if _is_widget(m) else "annotations")
        new_refs.append(ref)
        new_is_orig_ref.append(True)

    for i, a in enumerate(orig_annots):
        if i not in used and _is_widget(a):
            raise _TransplantRefusal(
                "the edit removed or rebuilt a form widget — beyond the "
                "annotate/fill tier for a signed document"
            )

    removed = len(orig_annots) - len(used)
    if removed:
        classes.add("annotations")  # widget removal refused above

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
        if not classes:
            # Membership and content both held; only the ORDER moved. Z-order
            # among widgets alone is form work, and anything else on the page
            # makes it annotation work.
            widgets_only = all(_is_widget(a) for a in orig_annots) and all(
                _is_widget(m) for m in mod_annots
            )
            classes.add("form-fill" if widgets_only else "annotations")
    return changed, added, updated, removed, classes


def _xfa_array_delta(orig_xfa, mod_xfa, writer, memo_mat):
    """A new `/XFA` array in which only the CHANGED packet streams are new.

    A fill on a static XFA form rewrites one packet — `datasets` — out of the
    eight or nine an authored form carries, and the template packet alone runs
    to hundreds of kilobytes. Materializing the whole array would append a
    copy of every packet to a signed document on every fill. The unchanged
    entries are re-listed by the ORIGINAL's own object references instead, so
    the appended revision carries the one stream that actually changed.

    Returns None when the arrays are not comparable entry-for-entry, leaving
    the caller's whole-value materialization to stand.
    """
    if not (isinstance(orig_xfa, pikepdf.Array) and isinstance(mod_xfa, pikepdf.Array)):
        return None
    if len(orig_xfa) != len(mod_xfa):
        return None
    out = generic.ArrayObject()
    for i in range(len(orig_xfa)):
        ov, mv = orig_xfa[i], mod_xfa[i]
        if _bisim(ov, mv, set()):
            if isinstance(ov, pikepdf.Object) and ov.is_indirect:
                out.append(_writer_ref(ov.objgen, writer))
            else:
                out.append(_materialize(mv, writer, memo_mat))
            continue
        out.append(_materialize(mv, writer, memo_mat))
    return out


def _acroform_delta(writer, orig: pikepdf.Pdf, mod: pikepdf.Pdf, memo_mat) -> int:
    """Transplant /AcroForm differences (fill: values, appearances, flags).

    Fields pair by fully-qualified /T; widget siblings are disambiguated by
    page ownership and stable attributes, never array position. They reconcile
    IN PLACE, so page /Annots references to the
    same widget objects stay intact. A field name present only in the
    MODIFIED file means the edit ADDED a form field — beyond the fill tier
    (and beyond what DocMDP permits) — so it refuses rather than half-
    registering. Returns updated-field count.

    A /AcroForm that the edit REMOVED outright is the maximal case of the
    field-removal refusal below, not an absent delta: this module runs only on
    a document whose live signatures were found through /AcroForm /Fields, so
    dropping the dictionary unregisters the very fields the preserved byte
    range signs, and ISO 32000-2 Table 257 (12.8.2.2) admits it at no
    certification level — /P 2 covers filling in forms, instantiating page
    templates and signing, and /P 3 adds only annotation work. Ignoring it
    would report success for a document that still carries the form."""
    orig_acro = orig.Root.get("/AcroForm")
    mod_acro = mod.Root.get("/AcroForm")
    if mod_acro is None:
        if orig_acro is None:
            return 0
        raise _TransplantRefusal("acroform-removed")
    if orig_acro is None:
        raise _TransplantRefusal(
            "the edit added a form where the signed original had none"
        )

    orig_fields = _field_index(orig_acro)
    mod_fields = _field_index(mod_acro)

    # The mirror of the addition refusal below, and the guard a page REMOVAL
    # needs: dropping a page drops its widgets, and a revision that re-lists
    # the surviving pages while /Fields still registers a field nothing draws
    # leaves a phantom the rewrite path does not.
    for name, origs in orig_fields.items():
        if len(origs) > len(mod_fields.get(name, [])):
            raise _TransplantRefusal(
                f"the edit removed form field '{name}' — form structure "
                "changes cannot be appended to a signed document"
            )

    updated = 0
    for name, mods in mod_fields.items():
        origs = orig_fields.get(name, [])
        if len(mods) > len(origs):
            raise _TransplantRefusal(
                f"the edit added form field '{name}' — form structure "
                "changes cannot be appended to a signed document"
            )
    for name, o, m, orig_ft in memo_mat.field_pairs:
        # A signature field that already carries a value is never part of
        # a fill delta: its /V and transform references belong to the signed
        # revision, not to the rewrite. Its separate widgets still have their
        # own field-pair entries and update without rewriting that /V.
        if orig_ft == pikepdf.Name("/Sig") and o.get("/V") is not None:
            continue
        if memo_mat.equal(o, m):
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
    if not memo_mat.equal(orig_acro, mod_acro, skip=_ACRO_KEEP):
        # A direct /AcroForm has no object to mark updated, and the only way to
        # reach it is to rewrite the catalog — which this module never does, so
        # the delta is inexpressible rather than absent. The twin of the inline
        # field refusal above.
        if not orig_acro.is_indirect:
            raise _TransplantRefusal("acroform-inline")
        ref = _writer_ref(orig_acro.objgen, writer)
        live = ref.get_object()
        changed = False
        for k in list(mod_acro.keys()):
            ks = str(k)
            if ks in _ACRO_KEEP:
                continue
            ov = orig_acro.get(ks)
            mv = mod_acro.get(ks)
            if ov is not None and memo_mat.equal(ov, mv, reference=True):
                continue
            if ks == "/XFA":
                value = _xfa_array_delta(ov, mv, writer, memo_mat)
                if value is not None:
                    live[generic.pdf_name(ks)] = value
                    changed = True
                    continue
                # None means the packet-wise delta does not apply — the
                # single-stream `xdp:xdp` spelling (Annex K) is not an Array.
                # Fall through to the whole-value materialization the delta's
                # contract promises; skipping the key dropped the datasets
                # update AND left /AcroForm unmarked, breaking the signature.
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


class _ClockFreeMeta(DocumentMetadata):
    """Document metadata that drops the writer's ``last_modified = 'now'``.

    ``BasePdfFileWriter._prep_dom_for_writing`` assigns ``'now'`` unconditionally
    at serialisation time, and the info-dict/XMP updaters turn that into a
    ``/ModDate`` derived from the run's clock. In an appended revision that is
    the run's clock reaching the emitted bytes: two writes of identical inputs
    a second apart differ. Dropping the assignment leaves the input document's
    own ``/ModDate`` in place, since the incremental writer carries the
    existing info dictionary forward.
    """

    def __setattr__(self, name, value):
        if name == "last_modified" and value == "now":
            value = None
        super().__setattr__(name, value)


def transplant_incremental(original: str, modified: str, output: str) -> dict:
    """Append ``modified``'s annotate/fill/geometry/page-tree delta onto
    ``original``.

    Returns {"applied": bool, ...counts} — applied=False carries a
    ``reason`` and writes NOTHING. On success ``output`` (which may equal
    ``modified`` but never ``original``) receives original-bytes + one
    appended revision (or exactly the original bytes when the semantic delta
    is empty); the byte-prefix property is asserted before the
    file lands (stage-and-swap, the pikepdf in-place discipline).

    A success also reports ``delta_classes``, and a ceiling refusal reports
    the certification level with the class it forbade: the two together are
    what lets a caller say which policy stopped which change instead of
    reporting a bare failure.
    """
    validate_pdf(original)
    validate_pdf(modified)
    out_path = Path(output)
    # Sameness is the filesystem's: a hard link is one physical file under two
    # spellings no resolution reconciles, and this refusal exists because the
    # original's bytes are read AFTER the output is written to.
    if is_same_file(original, output):
        raise ValueError("Refusing to overwrite the signed original in place")

    orig_bytes = Path(original).read_bytes()

    try:
        with pikepdf.open(io.BytesIO(orig_bytes)) as orig, pikepdf.open(modified) as mod:
            policy = signature_policy_of_pdf(orig)
            if policy.get("error"):
                return {"applied": False, "blocked": True, "reason": POLICY_UNREADABLE}
            if not policy["signed"]:
                return {"applied": False, "reason": "not-signed"}
            if orig.is_encrypted or mod.is_encrypted:
                return {"applied": False, "reason": "encrypted"}

            # Catalog-level guard: beyond /AcroForm (fill), /Pages (page
            # tree), and metadata (ignored — rebuild churn), the roots must
            # agree, or the edit exceeds the append-safe tier. A key skipped
            # here is DELEGATED, never excused: /AcroForm's own pass judges its
            # removal as well as its content, so the skip cannot turn a dropped
            # form into a silent success. /Version is compared by effective
            # header/catalog precedence below, not by storage location. A
            # higher requirement is a real classified delta, never metadata
            # churn to discard. Lower rebuild headers cannot downgrade the
            # signed original's interpretation.
            #
            # /Perms and /DSS are SIGNATURE INFRASTRUCTURE the original owns:
            # a certification's DocMDP entry and the long-term-validation
            # store. A page-tier rebuild carries neither, and the transplant
            # never writes either into the appended revision — so the
            # original's own bytes keep them, and comparing them would refuse
            # every edit of a certified or LTV-enabled document, which is the
            # opposite of preserving it.
            try:
                plan = _plan_pages(orig, mod)
                original_version = effective_version(orig)
                required_version = effective_version(mod)
                version_changed = required_version > original_version

                writer = IncrementalPdfFileWriter(io.BytesIO(orig_bytes))
                writer._meta = _ClockFreeMeta()
                if version_changed:
                    writer.ensure_output_version(required_version)
                memo_mat, page_refs, fresh_pages = _prepare_correspondence(writer, orig, mod, plan)
                if not memo_mat.equal(orig.Root, mod.Root, skip=frozenset({
                    "/AcroForm", "/Pages", "/Metadata", "/PieceInfo", "/Version", "/Perms", "/DSS",
                })):
                    return {"applied": False, "reason": "catalog-changed"}

                classes: set[str] = set(plan["classes"])
                if version_changed:
                    classes.add("format-version")
                pages_changed = added = updated = removed = keys_updated = 0
                for orig_ix, mod_ix in plan["pairs"]:
                    # Structural page matching establishes identity, but a
                    # retained page's unsupported keys also need edge-aware
                    # comparison. E.g. /AA retargeted between identical blank
                    # pages is a real change this tier must not discard.
                    if not memo_mat.equal(orig.pages[orig_ix].obj, mod.pages[mod_ix].obj,
                                          skip=_PAGE_SKIP | _PAGE_PARENT):
                        raise _TransplantRefusal("page-object-references-changed")
                    page_ref = page_refs[orig_ix]
                    changed, a, u, r, annot_classes = _apply_annot_delta(
                        writer, page_ref, orig.pages[orig_ix],
                        mod.pages[mod_ix], memo_mat,
                    )
                    if _apply_page_key_delta(
                        writer, page_ref, orig.pages[orig_ix],
                        mod.pages[mod_ix], memo_mat,
                    ):
                        keys_updated += 1
                        classes.add("page-keys")
                        changed = True
                    if changed:
                        pages_changed += 1
                    added += a
                    updated += u
                    removed += r
                    classes |= annot_classes

                fields_updated = _acroform_delta(writer, orig, mod, memo_mat)
                if fields_updated:
                    classes.add("form-fill")

                inserted = len(fresh_pages)
                for mod_ix in fresh_pages:
                    page_ref = memo_mat[mod.pages[mod_ix].obj.objgen]
                    page_ref.get_object().update(_materialize_direct(
                        mod.pages[mod_ix].obj, writer, memo_mat, 0, skip=_PAGE_PARENT,
                    ))
                if plan["kind"] == "rebuild":
                    inserted = _rewrite_page_tree(
                        writer, orig, mod, plan, page_refs, memo_mat
                    )
            except (ValueError, _TransplantRefusal) as e:
                return {"applied": False, "reason": str(e)}

            pages_removed = len(plan["removed"])
            unchanged = not (pages_changed or fields_updated or inserted or pages_removed
                             or plan["reordered"] or version_changed)

            # The ceiling, consulted on the FULL classified delta and before
            # any bytes exist: the writer holds the revision in memory only,
            # so a refusal here writes nothing and leaves the caller's rewrite
            # path the sole author of the file.
            refused = _ceiling_refusal(certification_of_pdf(orig), classes)
            if refused is not None:
                return refused

            if unchanged:
                # A semantically empty rebuild must not leave rewritten bytes
                # standing: they break signatures just as a changed rebuild
                # does. Restore the original verbatim, without a new revision.
                result = orig_bytes
            else:
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
        "page_keys_updated": keys_updated,
        "pages_inserted": inserted,
        "pages_removed": pages_removed,
        "pages_reordered": plan["reordered"],
        "delta_classes": [c for c in DELTA_CLASSES if c in classes],
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
        policy = signature_policy(original)
        if policy.get("error"):
            refuse_unreadable_policy()
        if not policy["signed"]:
            return {"preserved": False, "reason": "not-signed"}
        result = transplant_incremental(original, rewritten_tmp, rewritten_tmp)
        if result.get("blocked") or result.get("reason") == POLICY_UNREADABLE:
            refuse_unreadable_policy()
        if result.get("applied"):
            return {"preserved": True, **{k: v for k, v in result.items() if k != "applied"}}
        return {"preserved": False, "reason": result.get("reason", "unknown")}
    except RuntimeError:
        # A reader/transport failure is not a mechanical refusal authorizing
        # the ordinary rewrite. The staging owner must discard the output.
        refuse_unreadable_policy()
