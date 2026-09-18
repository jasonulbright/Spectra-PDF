"""The document-wide half of applying a redaction.

The page walk rewrites what each redacted page draws. What it cannot see from a
page is everything else in the file that still holds, points at or describes
the content it removed — and ISO 32000-2 §12.5.6.23 requires a redactor to
remove every trace of that content and to account for every place content can
live in a document. This module is that pass, run once after every page:

  - STRUCTURE. A structure element that names a replaced image or form as its
    whole content (an OBJR, §14.7.5.3) or holds a marked-content reference into
    a replaced form (an MCR's /Stm, §14.7.5.2) keeps the ORIGINAL reachable, and
    so its bytes in the saved file. Each such reference is rebound to the
    redacted copy, or removed when the object went whole — unless the original
    is still drawn somewhere, in which case it stays and every copy gives up
    the /StructParent key that is the original's. An OBJR to an annotation the
    page pass removed goes, with nothing to rebind to. An element whose content
    was redacted — found through the parent tree, or through its own /K where
    the file has no parent tree — also loses /Alt, /ActualText and /E: a
    description of a picture or a replacement for text says what was under the
    mark.
  - SHARED RESOURCES. One resource dictionary is often shared by every page —
    by reference, or inherited from a /Pages node — and by the forms on them.
    Wherever it still lists an original a redacted page replaced, its owner
    (a page, a form, a pattern, a Type 3 font) takes its own copy pruned to
    what that owner draws; one that draws the original keeps it, because it
    shows it outside every mark. Otherwise the original stays in the saved
    file with nothing drawing it.
  - FORM FIELDS. A widget under a mark is removed with its annotation (the page
    pass). A field left with no widget at all loses its value, default value
    and option list and leaves the field tree. The XFA packet is dropped from a
    form that lost a field: its datasets carry every value in one XML stream.
  - JBIG2. A redacted image re-encodes its JBIG2 stencil and stops using the
    shared symbol dictionary (/JBIG2Globals), but the dictionary itself holds
    symbol bitmaps, and a symbol whose only instances were under the mark —
    a signature's strokes, a handwritten note — would outlive it there. Every
    other image that uses that dictionary is converted to CCITT group 4 (the
    same bitmap, proved by decoding it back), so the dictionary drops out.
  - DERIVATIVES. The catalog's /PieceInfo can hold an authoring application's
    private copy of the whole document; the document XMP can hold
    xmp:Thumbnails, a raster of a page as it was. Both go.
  - FONTS. A font keeps the glyph program of every character it drew, and its
    tables name those characters. Every font whose use shrank is cut to what
    the remaining text draws (`redact_fonts`).
"""

from __future__ import annotations

import re

import pikepdf
from pikepdf import Name

_CONTENT_DESCRIPTIONS = ("/Alt", "/ActualText", "/E")


def _key(obj):
    try:
        if obj.is_indirect:
            return tuple(obj.objgen)
    except Exception:
        pass
    return None


def reachable_from_pages(pdf) -> set:
    """Every indirect object the page tree draws or shows — contents,
    resources (through forms, patterns and soft masks), annotations and their
    appearances — without walking up into the page tree or across to the
    structure tree and the form tree."""
    seen: set = set()
    stack = []
    for page in pdf.pages:
        for key in ("/Contents", "/Resources", "/Annots", "/Group"):
            value = page.obj.get(key)
            if value is not None:
                stack.append(value)
        node = page.obj
        depth = 0
        while "/Resources" not in node and "/Parent" in node and depth < 64:
            node = node["/Parent"]
            depth += 1
            if "/Resources" in node:
                stack.append(node["/Resources"])
    skip = {"/Parent", "/P", "/StructParent", "/StructParents", "/Popup", "/IRT"}
    while stack:
        obj = stack.pop()
        key = _key(obj)
        if key is not None:
            if key in seen:
                continue
            seen.add(key)
        if isinstance(obj, (pikepdf.Dictionary, pikepdf.Stream)):
            for name in list(obj.keys()):
                if name in skip:
                    continue
                try:
                    stack.append(obj[name])
                except Exception:
                    continue
        elif isinstance(obj, pikepdf.Array):
            for item in obj:
                stack.append(item)
    return seen


# ── structure ─────────────────────────────────────────────────────────────


def _elements(root):
    """Every structure element under the root."""
    out = []
    seen: set = set()
    stack = [root]
    while stack:
        node = stack.pop()
        key = _key(node)
        if key is not None:
            if key in seen:
                continue
            seen.add(key)
        if not isinstance(node, pikepdf.Dictionary):
            continue
        out.append(node)
        kids = node.get("/K")
        if kids is None:
            continue
        items = list(kids) if isinstance(kids, pikepdf.Array) else [kids]
        for item in items:
            if isinstance(item, pikepdf.Dictionary):
                kind = item.get("/Type")
                if kind in (Name("/MCR"), Name("/OBJR")):
                    continue
                stack.append(item)
    return out


def _elements_on_pages(root):
    """`(element, page key)` for every structure element: its own /Pg, which
    ISO 32000-2 Table 355 requires where /K holds MCIDs, or the nearest
    ancestor's for a file that leaves it out."""
    out = []
    seen: set = set()
    stack = [(root, None)]
    while stack:
        node, page = stack.pop()
        key = _key(node)
        if key is not None:
            if key in seen:
                continue
            seen.add(key)
        if not isinstance(node, pikepdf.Dictionary):
            continue
        own = node.get("/Pg")
        if own is not None:
            page = _key(own)
        out.append((node, page))
        kids = node.get("/K")
        if kids is None:
            continue
        for item in list(kids) if isinstance(kids, pikepdf.Array) else [kids]:
            if isinstance(item, pikepdf.Dictionary) and item.get("/Type") not in (Name("/MCR"), Name("/OBJR")):
                stack.append((item, page))
    return out


def _content_ids(element, page) -> list:
    """`(stream key, MCID)` for each marked-content sequence the element owns
    directly: an integer kid is on the element's page, an MCR names its own
    page and, for content inside a form, the form's stream (/Stm)."""
    kids = element.get("/K")
    if kids is None:
        return []
    out = []
    for item in list(kids) if isinstance(kids, pikepdf.Array) else [kids]:
        if isinstance(item, pikepdf.Dictionary):
            if item.get("/Type") != Name("/MCR"):
                continue
            stream = item.get("/Stm")
            owner = _key(stream) if stream is not None else (_key(item.get("/Pg")) if item.get("/Pg") is not None else page)
            try:
                out.append((owner, int(item.get("/MCID"))))
            except (TypeError, ValueError):
                continue
        else:
            try:
                out.append((page, int(item)))
            except (TypeError, ValueError):
                continue
    return out


def _number_tree(node, out: dict, depth: int = 0) -> None:
    if node is None or depth > 32:
        return
    nums = node.get("/Nums")
    if nums is not None:
        values = list(nums)
        for index in range(0, len(values) - 1, 2):
            try:
                out[int(values[index])] = values[index + 1]
            except (TypeError, ValueError):
                continue
    for kid in node.get("/Kids", []) or []:
        _number_tree(kid, out, depth + 1)


def rebind_structure(pdf, run, live: set) -> None:
    root = pdf.Root.get("/StructTreeRoot")
    if root is None:
        return
    touched_elements: dict = {}
    parent_tree: dict = {}
    _number_tree(root.get("/ParentTree"), parent_tree)
    for struct_parents, mcid in run.touched_mcids:
        entry = parent_tree.get(struct_parents)
        if isinstance(entry, pikepdf.Array) and 0 <= mcid < len(entry):
            element = entry[mcid]
            if isinstance(element, pikepdf.Dictionary):
                touched_elements[_key(element) or id(element)] = element
    for struct_parent in run.touched_struct_parents:
        element = parent_tree.get(struct_parent)
        if isinstance(element, pikepdf.Dictionary):
            touched_elements[_key(element) or id(element)] = element
    # The parent tree is how a reader goes from content to structure; a file
    # without one (or with a stale one) still links each element to its
    # content through /K, which is the direction this reads.
    if run.touched_stream_mcids:
        for element, page in _elements_on_pages(root):
            if any(ident in run.touched_stream_mcids for ident in _content_ids(element, page)):
                touched_elements[_key(element) or id(element)] = element

    owners: dict = {}
    for original, copies in run.copies_of.items():
        owners[original] = None if original in live else (copies[0] if copies else None)

    for element in _elements(root):
        kids = element.get("/K")
        if kids is None:
            continue
        items = list(kids) if isinstance(kids, pikepdf.Array) else [kids]
        kept: list = []
        changed = False
        for item in items:
            if isinstance(item, pikepdf.Dictionary) and item.get("/Type") in (Name("/OBJR"), Name("/MCR")):
                slot = "/Obj" if item.get("/Type") == Name("/OBJR") else "/Stm"
                target = item.get(slot)
                target_key = _key(target) if target is not None else None
                if target_key is not None and target_key in run.removed_annotations:
                    # An annotation under a mark is gone from its page; the
                    # emptied object stays reachable only through this.
                    touched_elements[_key(element) or id(element)] = element
                    changed = True
                    continue
                if target_key is not None and (target_key in run.copies_of or target_key in run.removed_originals):
                    if target_key in live:
                        kept.append(item)
                        continue
                    touched_elements[_key(element) or id(element)] = element
                    replacement = owners.get(target_key)
                    if replacement is not None:
                        item[slot] = replacement
                        kept.append(item)
                    changed = True
                    continue
            kept.append(item)
        if changed:
            if not kept:
                del element["/K"]
            elif len(kept) == 1 and not isinstance(kids, pikepdf.Array):
                element["/K"] = kept[0]
            else:
                element["/K"] = pikepdf.Array(kept)

    for original, copies in run.copies_of.items():
        owner = owners.get(original)
        for copy in copies:
            if copy is owner:
                continue
            if "/StructParent" in copy:
                del copy["/StructParent"]

    for element in touched_elements.values():
        for key in _CONTENT_DESCRIPTIONS:
            if key in element:
                del element[key]


# ── shared resources on /Pages nodes ──────────────────────────────────────


def _mentions(resources, originals: set) -> bool:
    if not isinstance(resources, pikepdf.Dictionary):
        return False
    for category in resources.keys():
        table = resources[category]
        if not isinstance(table, pikepdf.Dictionary):
            continue
        for name in table.keys():
            if _key(table[name]) in originals:
                return True
    return False


_PRUNED_CATEGORIES = ("/XObject", "/Pattern", "/ExtGState", "/Shading", "/Properties")


def _resources_holder(page):
    """The dictionary a page's resources come from: its own, or the nearest
    /Pages node's it inherits."""
    node = page.obj
    depth = 0
    while "/Resources" not in node and "/Parent" in node and depth < 64:
        node = node["/Parent"]
        depth += 1
    return node if "/Resources" in node else None


def clean_shared_resources(pdf, originals: set) -> None:
    """Take every replaced or removed original out of the resource lists of
    the pages that do not draw it.

    One resource dictionary is often shared by every page — by reference, or
    inherited from a /Pages node — and lists every page's pictures. A page the
    marks never reached still LISTS the original a redacted page replaced, and
    a listing keeps the object, unredacted, in the saved file although no page
    shows it. Each page whose dictionary lists one takes its own copy (the
    shared one may serve other pages), pruned to what that page draws; a page
    that does draw the original keeps it, because it shows it outside every
    mark."""
    if not originals:
        return
    emptied: dict = {}
    for page in pdf.pages:
        holder = _resources_holder(page)
        if holder is None or not _mentions(holder["/Resources"], originals):
            continue
        source = holder["/Resources"]
        own = pikepdf.Dictionary()
        for category in source.keys():
            value = source[category]
            if category in _PRUNED_CATEGORIES and isinstance(value, pikepdf.Dictionary):
                table = pikepdf.Dictionary()
                for name in value.keys():
                    table[name] = value[name]
                value = table
            own[category] = value
        page.obj["/Resources"] = own
        page.remove_unreferenced_resources()
        if _key(holder) != _key(page.obj):
            emptied[_key(holder) or id(holder)] = holder
    for node in emptied.values():
        if not any(_resources_holder(p) is not None and _key(_resources_holder(p)) == _key(node) for p in pdf.pages):
            del node["/Resources"]
    _clean_content_owners(pdf, originals)


def _own_pruned_copy(resources, instructions):
    from engine.redact import _prune_to_references

    own = pikepdf.Dictionary()
    for category in resources.keys():
        value = resources[category]
        if category in _PRUNED_CATEGORIES and isinstance(value, pikepdf.Dictionary):
            table = pikepdf.Dictionary()
            for name in value.keys():
                table[name] = value[name]
            value = table
        own[category] = value
    _prune_to_references(own, instructions)
    return own


def _clean_content_owners(pdf, originals: set) -> None:
    """The same for every other owner of a resource dictionary: a form, a
    tiling pattern, a Type 3 font. A form that shares the page's dictionary is
    the common shape — it lists the page's pictures and draws one of them."""
    owners = []
    for obj in pdf.objects:
        if not isinstance(obj, (pikepdf.Dictionary, pikepdf.Stream)):
            continue
        try:
            resources = obj.get("/Resources")
        except Exception:
            continue
        if not _mentions(resources, originals) or obj.get("/Type") == Name("/Page"):
            continue
        owners.append(obj)
    for obj in owners:
        try:
            if isinstance(obj, pikepdf.Stream):
                instructions = list(pikepdf.parse_content_stream(obj))
            elif obj.get("/Subtype") == Name("/Type3"):
                instructions = []
                for glyph in (obj.get("/CharProcs") or pikepdf.Dictionary()).values():
                    instructions.extend(pikepdf.parse_content_stream(glyph))
            else:
                continue
        except Exception:
            # Content that cannot be read cannot show what it draws; the
            # originals leave its list rather than stay on its word.
            obj["/Resources"] = _without_originals(obj["/Resources"], originals)
            continue
        obj["/Resources"] = _own_pruned_copy(obj["/Resources"], instructions)


def _without_originals(resources, originals: set):
    own = pikepdf.Dictionary()
    for category in resources.keys():
        value = resources[category]
        if isinstance(value, pikepdf.Dictionary):
            table = pikepdf.Dictionary()
            for name in value.keys():
                if _key(value[name]) not in originals:
                    table[name] = value[name]
            value = table
        own[category] = value
    return own


# ── form fields ───────────────────────────────────────────────────────────

_FIELD_CONTENT = ("/V", "/DV", "/Opt", "/RV", "/AP", "/MK", "/TU", "/TM")


def prune_fields(pdf, removed_widgets: set) -> bool:
    """Take out of the field tree every field whose widgets were all removed.
    Returns whether any field changed."""
    acroform = pdf.Root.get("/AcroForm")
    if acroform is None or not removed_widgets:
        return False
    changed = False

    def widgets_of(field):
        if field.get("/Subtype") == Name("/Widget"):
            return [field]
        out = []
        for kid in field.get("/Kids", []) or []:
            if kid.get("/Subtype") == Name("/Widget") and kid.get("/T") is None:
                out.append(kid)
        return out

    def visit(container, key, depth=0):
        nonlocal changed
        if depth > 32:
            return
        entries = container.get(key)
        if entries is None:
            return
        kept = []
        for entry in list(entries):
            if not isinstance(entry, pikepdf.Dictionary):
                kept.append(entry)
                continue
            widgets = widgets_of(entry)
            is_terminal = bool(widgets) or entry.get("/FT") is not None and not entry.get("/Kids")
            if widgets:
                survivors = [w for w in widgets if _key(w) not in removed_widgets]
                if len(survivors) < len(widgets):
                    changed = True
                    if not survivors:
                        for name in _FIELD_CONTENT:
                            if name in entry:
                                del entry[name]
                        continue
                    if entry.get("/Subtype") != Name("/Widget"):
                        entry["/Kids"] = pikepdf.Array(
                            [k for k in entry.get("/Kids") if _key(k) not in removed_widgets]
                        )
                kept.append(entry)
                continue
            if not is_terminal and entry.get("/Kids") is not None:
                visit(entry, "/Kids", depth + 1)
                if not list(entry.get("/Kids", [])):
                    changed = True
                    for name in _FIELD_CONTENT:
                        if name in entry:
                            del entry[name]
                    continue
            kept.append(entry)
        if len(kept) != len(list(entries)):
            container[key] = pikepdf.Array(kept)

    visit(acroform, "/Fields")
    if changed and "/XFA" in acroform:
        del acroform["/XFA"]
    return changed


# ── JBIG2 symbol dictionaries ─────────────────────────────────────────────


def reachable_from_trailer(pdf) -> set:
    """Every indirect object the saved file will hold: the writer keeps what
    the trailer reaches and nothing else."""
    seen: set = set()
    stack: list = [pdf.trailer]
    while stack:
        obj = stack.pop()
        key = _key(obj)
        if key is not None:
            if key in seen:
                continue
            seen.add(key)
        if isinstance(obj, (pikepdf.Dictionary, pikepdf.Stream)):
            for name in list(obj.keys()):
                try:
                    stack.append(obj[name])
                except Exception:
                    continue
        elif isinstance(obj, pikepdf.Array):
            stack.extend(obj)
    return seen


def _jbig2_globals_of(obj):
    from engine import image_redact

    filters = image_redact._filter_names(obj)
    if not filters or filters[-1] not in image_redact.JBIG2_FILTERS:
        return None
    parms = image_redact._parms_for(obj, len(filters))
    return parms.get("/JBIG2Globals") if isinstance(parms, pikepdf.Dictionary) else None


def convert_jbig2_sharers(pdf, run) -> None:
    """Re-encode, in place, every image the saved file keeps that still reads
    a symbol dictionary a redacted image used, so the dictionary drops out."""
    from engine import image_redact

    if not run.context.jbig2_globals:
        return
    kept = reachable_from_trailer(pdf)
    targets = []
    for obj in pdf.objects:
        if not isinstance(obj, pikepdf.Stream) or _key(obj) not in kept:
            continue
        if obj.get("/Subtype") != Name("/Image"):
            continue
        globals_stream = _jbig2_globals_of(obj)
        if globals_stream is None or _key(globals_stream) not in run.context.jbig2_globals:
            continue
        try:
            depth = int(obj.get("/BitsPerComponent", 1))
        except (TypeError, ValueError):
            depth = 0
        if depth != 1:
            image_redact.refuse("JBIG2 data under an image that is not one bit per pixel")
        targets.append(obj)
    if not targets:
        return
    decoded = image_redact.jbig2_bits([image_redact.jbig2_source(obj) for obj in targets], run.context)
    for obj, bits in zip(targets, decoded):
        width, height = image_redact.dimensions(obj)
        data, parms = image_redact.encode_g4(bytes(bits), width, height)
        obj.write(data, filter=Name("/CCITTFaxDecode"), decode_parms=pikepdf.Dictionary(parms))


# ── document derivatives ──────────────────────────────────────────────────

_THUMBNAILS = re.compile(rb"<(?P<p>[A-Za-z_][\w.-]*):Thumbnails\b.*?</(?P=p):Thumbnails\s*>", re.S)


def strip_document_derivatives(pdf) -> None:
    if "/PieceInfo" in pdf.Root:
        del pdf.Root["/PieceInfo"]
    metadata = pdf.Root.get("/Metadata")
    if isinstance(metadata, pikepdf.Stream):
        try:
            body = bytes(metadata.read_bytes())
        except Exception:
            del pdf.Root["/Metadata"]
            return
        stripped = _THUMBNAILS.sub(b"", body)
        if stripped != body:
            metadata.write(stripped)


def finish(pdf, run) -> None:
    """Every document-wide step, in the order their inputs require: the
    structure pass reads liveness after the shared resources are cleaned, the
    JBIG2 conversion reads what the file keeps after both, and the font cut
    counts what the file still draws once nothing else will leave it."""
    from engine import redact_fonts

    clean_shared_resources(pdf, set(run.copies_of) | set(run.removed_originals))
    live = reachable_from_pages(pdf)
    rebind_structure(pdf, run, live)
    prune_fields(pdf, run.removed_widgets)
    convert_jbig2_sharers(pdf, run)
    strip_document_derivatives(pdf)
    redact_fonts.prune(pdf, getattr(run, "fonts", None))
