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
  - RESIDUE. The words a mark took off a page can also be spelled where no
    page draws them: bookmark titles, article thread information, named
    destinations, page label prefixes, the information dictionary, the XMP
    packet, the text of annotations that stay, form field names and values,
    embedded file names and descriptions, and JavaScript. A merge or split
    copies several of those into new files. `removed_terms` reads, before the
    page walk, the text under the marks through the Search & Redact walk and
    the redactor's own intersection test; `find_residue` lists every place
    that still spells it; `remove_redaction_residue` removes the places the
    user chose. Text is replaced in place, a name-tree key is renamed to a
    neutral id with every reference retargeted, and a field whose value
    changed gets a new appearance. Matching uses the Search & Redact
    normalization (NFKC, which expands ligatures; soft-hyphen strip;
    whitespace collapse) and its case-insensitive flag, on decoded strings,
    so UTF-16 and PDFDocEncoding strings match alike.
"""

from __future__ import annotations

import re
import unicodedata

import pikepdf
from pikepdf import Name
from lxml import etree

from engine.credentials import open_pdf
from engine.inplace import is_same_file, staged_write
from engine.pdf_fonts import bounded_read
from engine.pdf_save import save_pdf
from engine.text_match import compile_terms, normalize_index_text

_CONTENT_DESCRIPTIONS = ("/Alt", "/ActualText", "/E")
MAX_STRUCTURE_ELEMENTS = 100_000
MAX_METADATA_BYTES = 8 * 1024 * 1024
MAX_METADATA_ELEMENTS = 100_000


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
        if len(out) > MAX_STRUCTURE_ELEMENTS:
            raise ValueError("The document structure is too complex to redact safely.")
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
        if len(out) > MAX_STRUCTURE_ELEMENTS:
            raise ValueError("The document structure is too complex to redact safely.")
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

    elements = _elements(root)
    parents: dict = {}
    for element in elements:
        kids = element.get("/K")
        if kids is None:
            continue
        items = list(kids) if isinstance(kids, pikepdf.Array) else [kids]
        kept: list = []
        changed = False
        for item in items:
            if isinstance(item, pikepdf.Dictionary) and item.get("/Type") not in (Name("/OBJR"), Name("/MCR")):
                parents.setdefault(_key(item) or id(item), []).append(element)
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

    # Descriptions apply to the whole enclosed subtree, including content
    # owned by descendants (ISO 32000-2 14.9.3-14.9.5). Follow both directions
    # of the structure links so a missing or stale /P cannot retain a trace.
    pending = list(touched_elements.values())
    cleared: set = set()
    while pending:
        element = pending.pop()
        if not isinstance(element, pikepdf.Dictionary):
            continue
        ident = _key(element) or id(element)
        if ident in cleared:
            continue
        cleared.add(ident)
        if len(cleared) > MAX_STRUCTURE_ELEMENTS:
            raise ValueError("The document structure is too complex to redact safely.")
        for key in _CONTENT_DESCRIPTIONS:
            if key in element:
                del element[key]
        pending.extend(parents.get(ident, []))
        parent = element.get("/P")
        if parent is not None:
            pending.append(parent)


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


# ISO 32000-2 resource holders besides the page tree: form XObjects (8.10.2,
# Table 93), tiling patterns (8.7.3.1), Type 3 fonts (9.6.4, Table 110),
# annotation appearances (7.8.3), named pages in the Templates name tree
# (7.7.4 Table 32, 12.7.7) under /Resources; the interactive form dictionary's
# default resources under /DR (12.7.3, Table 224). Holders are often direct
# objects (an /AcroForm inlined in the catalog), so the walk descends into
# every direct child of every indirect object. 12.7.7 requires a template to
# be typed /Template, but files in circulation type it /Page; page-tree
# membership is therefore decided by object identity, never by /Type.
_RESOURCE_KEYS = ("/Resources", "/DR")


def _page_tree_ids(pdf) -> set:
    ids: set = set()
    for page in pdf.pages:
        node = page.obj
        depth = 0
        while node is not None and depth < 64:
            key = _key(node)
            if key is None or key in ids:
                break
            ids.add(key)
            node = node.get("/Parent")
            depth += 1
    return ids


def _resource_holders(pdf, originals: set):
    found = []
    stack = [obj for obj in pdf.objects
             if isinstance(obj, (pikepdf.Dictionary, pikepdf.Stream, pikepdf.Array))]
    stack.append(pdf.trailer)
    while stack:
        obj = stack.pop()
        if isinstance(obj, (pikepdf.Dictionary, pikepdf.Stream)):
            for key in list(obj.keys()):
                try:
                    value = obj.get(key)
                except Exception:
                    continue
                if key in _RESOURCE_KEYS and _mentions(value, originals):
                    found.append((obj, key))
                if isinstance(value, (pikepdf.Dictionary, pikepdf.Array)) and _key(value) is None:
                    stack.append(value)
        elif isinstance(obj, pikepdf.Array):
            for item in obj:
                if isinstance(item, (pikepdf.Dictionary, pikepdf.Array)) and _key(item) is None:
                    stack.append(item)
    return found


def _drawn_by(obj, key):
    """The instructions a holder's own content runs, or None when it has no
    readable content of its own."""
    if key != "/Resources":
        return None
    try:
        if isinstance(obj, pikepdf.Stream):
            return list(pikepdf.parse_content_stream(obj))
        if obj.get("/Subtype") == Name("/Type3"):
            instructions = []
            for glyph in (obj.get("/CharProcs") or pikepdf.Dictionary()).values():
                instructions.extend(pikepdf.parse_content_stream(glyph))
            return instructions
        contents = obj.get("/Contents")
        if contents is None:
            return None
        parts = contents if isinstance(contents, pikepdf.Array) else [contents]
        instructions = []
        for part in parts:
            instructions.extend(pikepdf.parse_content_stream(part))
        return instructions
    except Exception:
        return None


def _clean_content_owners(pdf, originals: set) -> None:
    """The same for every other holder of a resource dictionary. A holder with
    content of its own (a stream, a Type 3 font, a named page) keeps what that
    content draws; every other holder (the form's default resources, content
    that cannot be read) loses the originals outright, because a listing alone
    keeps the unredacted object in the saved file."""
    page_tree = _page_tree_ids(pdf)
    for obj, key in _resource_holders(pdf, originals):
        if key == "/Resources" and _key(obj) in page_tree:
            continue
        instructions = _drawn_by(obj, key)
        if instructions is None:
            obj[key] = _without_originals(obj[key], originals)
        else:
            obj[key] = _own_pruned_copy(obj[key], instructions)


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

_THUMBNAILS = "{http://ns.adobe.com/xap/1.0/}Thumbnails"


def _without_thumbnails(body: bytes) -> bytes | None:
    parser = etree.XMLPullParser(
        events=("start",), resolve_entities=False, load_dtd=False,
        no_network=True, recover=False, huge_tree=False,
    )
    count = 0
    for offset in range(0, len(body), 4096):
        parser.feed(body[offset:offset + 4096])
        count += sum(1 for _ in parser.read_events())
        if count > MAX_METADATA_ELEMENTS:
            raise ValueError
    root = parser.close()
    tree = root.getroottree()
    if tree.docinfo.doctype or root.tag == _THUMBNAILS:
        raise ValueError
    changed = False
    for node in list(root.iter()):
        if isinstance(node, etree._Entity):
            raise ValueError
        if node.tag == _THUMBNAILS:
            node.getparent().remove(node)
            changed = True
        if _THUMBNAILS in node.attrib:
            del node.attrib[_THUMBNAILS]
            changed = True
    return etree.tostring(tree, encoding="utf-8", xml_declaration=True) if changed else None


def strip_document_derivatives(pdf) -> None:
    if "/PieceInfo" in pdf.Root:
        del pdf.Root["/PieceInfo"]
    metadata = pdf.Root.get("/Metadata")
    if isinstance(metadata, pikepdf.Stream):
        try:
            body, _too_large = bounded_read(metadata, MAX_METADATA_BYTES)
            if body is None:
                raise ValueError
            stripped = _without_thumbnails(body)
        except Exception:
            del pdf.Root["/Metadata"]
            return
        if stripped is not None:
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


# ── residue: the removed text, spelled outside page content ──────────────


KINDS = (
    "outline",
    "thread",
    "dest_name",
    "page_label",
    "metadata",
    "annotation",
    "field",
    "embedded_file",
    "javascript",
)

# A single covered word shorter than this ("Name:", "SSN", "of") is a label
# or a function word far more often than the secret, and a term matches it
# everywhere; the phrase it sits in is still a term.
MIN_WORD_ALNUM = 4
# Characters of an unspaced script (Han, kana, Thai) carry a word each far
# more often; one character alone matches everywhere, two is the floor.
MIN_UNSPACED_CHARS = 2
MAX_TERMS = 1000
MAX_REPORT = 500
MAX_TREE_DEPTH = 64
MAX_TREE_ENTRIES = 100_000
MAX_OUTLINE_ITEMS = 100_000
MAX_WALK_OBJECTS = 1_000_000
MAX_TEXT_STREAM_BYTES = 8 * 1024 * 1024
# ASCII, so every standard font can draw it in a regenerated field appearance.
REPLACEMENT = "***"
SNIPPET_CHARS = 200

_STRING_KEYS_ANNOT = ("/Contents", "/T", "/Subj", "/RC", "/TU")
# A field's name (/T) and export name (/TM) are how scripts, /CO, submit and
# reset lists and parent-qualified names find it: reported, never rewritten.
_FIELD_NAME_KEYS = ("/T", "/TM")
_STRING_KEYS_FIELD = ("/TU", "/V", "/DV")
# Info keys that hold dates or names, not text a person wrote.
_INFO_SKIP = frozenset({"/CreationDate", "/ModDate", "/Trapped"})
# XMP properties that hold identifiers or format facts, by lower-cased local
# name; a name ending in "id" (stEvt:instanceID, xmpMM:DocumentID) is one too.
_XMP_SKIP = frozenset({"about", "format", "renditionclass", "part", "conformance",
                       "pdfversion"})
# An XMP Date (ISO 8601 profile, XMP Part 1 8.2.1.2) as a whole value.
_XMP_DATE = re.compile(
    r"\s*\d{4}(-\d{2}(-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})?)?)?)?\s*")


def _xmp_skipped(name: str, value: str) -> bool:
    lname = name.lower()
    return (lname.endswith("date") or lname.endswith("id") or lname in _XMP_SKIP
            or lname == "when" or bool(_XMP_DATE.fullmatch(value)))
_STRING_KEYS_FILESPEC = ("/F", "/UF", "/Desc")


# ── what the marks removed ────────────────────────────────────────────────


def removed_terms(pdf, by_page: dict) -> list[str]:
    """The words each marked page loses whole, as terms. A word counts only
    when every glyph of it is under a mark by the redactor's own per-glyph
    test, so a glyph a mark clipped off a neighbouring word adds nothing.
    Each run of consecutive whole words is a phrase term; inside a phrase of
    several words, a single word is a term by itself only with
    `MIN_WORD_ALNUM` letters or digits, or any digit. `by_page` maps a
    1-based page number to region specs carrying a normalized `rect`."""
    from engine.redact import _intersects_any
    from engine.search_regions import _collect_runs, _page_text, _slice_rect

    terms: list[str] = []
    seen: set = set()
    for page_no, specs in by_page.items():
        regions = [spec["rect"] for spec in specs]
        try:
            runs, _listing = _collect_runs(pdf, pdf.pages[page_no - 1])
        except Exception:
            continue
        by_index = {run.index: run for run in runs}
        text, origin = _page_text(runs)
        box_cache: dict = {}

        def covered(unit) -> bool:
            if unit is None:
                return False
            key = (unit.run, unit.item)
            if key not in box_cache:
                run = by_index.get(unit.run)
                if run is None:
                    box_cache[key] = False
                else:
                    rect = run.full_rect if unit.item < 0 else _slice_rect(run, unit.item, unit.item)
                    box = (min(rect[0], rect[2]), min(rect[1], rect[3]),
                           max(rect[0], rect[2]), max(rect[1], rect[3]))
                    box_cache[key] = _intersects_any(box, regions)
            return box_cache[key]

        # Units: every character of an unspaced script is its own unit (no
        # word segmenter ships with the engine), every other run of
        # non-space characters is one word. `gap` says whitespace preceded it.
        units = []  # (text, lost whole, unspaced, gap)
        start = None
        gap = False

        def close(first: int, stop: int, spaced_gap: bool) -> None:
            chunk_start = first
            for i in range(first, stop + 1):
                boundary = i == stop or unspaced_script(text[i]) or (
                    i > first and unspaced_script(text[i - 1]))
                if boundary and i > chunk_start:
                    owned = [origin[k] for k in range(chunk_start, i) if origin[k] is not None]
                    units.append((text[chunk_start:i], bool(owned) and all(covered(u) for u in owned),
                                  unspaced_script(text[chunk_start]),
                                  spaced_gap if chunk_start == first else False))
                    chunk_start = i

        for index in range(len(text) + 1):
            if index < len(text) and not text[index].isspace():
                if start is None:
                    start = index
                continue
            if start is not None:
                close(start, index, gap)
                start = None
            gap = True

        def add(term: str) -> bool:
            term = normalize_index_text(term)
            folded = term.casefold()
            if folded not in seen:
                seen.add(folded)
                terms.append(term)
            return len(terms) >= MAX_TERMS

        phrase: list = []
        for unit in units + [("", False, False, True)]:
            if unit[1]:
                phrase.append(unit)
                continue
            if phrase:
                joined = "".join((" " if i and u[3] else "") + u[0] for i, u in enumerate(phrase))
                words = _phrase_words(phrase)
                if any(_word_is_term(w) for w in words):
                    if add(joined):
                        return terms
                if len(words) > 1:
                    for word in words:
                        if _word_is_term(word) and add(_word_core(word)):
                            return terms
                phrase = []
    return terms


def unspaced_script(ch: str) -> bool:
    """A script written without spaces between words: Han, kana, Thai, Lao,
    Khmer, Myanmar. Hangul is written with spaces and is not one."""
    cp = ord(ch)
    return (0x3400 <= cp <= 0x4DBF or 0x4E00 <= cp <= 0x9FFF or 0xF900 <= cp <= 0xFAFF
            or 0x20000 <= cp <= 0x3134F or 0x3040 <= cp <= 0x30FF or 0x31F0 <= cp <= 0x31FF
            or 0xFF66 <= cp <= 0xFF9F or 0x0E00 <= cp <= 0x0EFF or 0x1780 <= cp <= 0x17FF
            or 0x1000 <= cp <= 0x109F)


def _phrase_words(phrase: list) -> list[str]:
    """A phrase's units regrouped into words: spaced units stand alone, and
    touching unspaced characters form one word."""
    words: list[str] = []
    for index, (chunk, _whole, unspaced, gap) in enumerate(phrase):
        if words and not gap and unspaced and phrase[index - 1][2]:
            words[-1] += chunk
        else:
            words.append(chunk)
    return words


def _word_core(word: str) -> str:
    return word.strip("".join(c for c in set(word) if not c.isalnum()))


def _word_is_term(word: str) -> bool:
    """A lone word is a term only when it is unlikely to be a function word
    or a label: `MIN_WORD_ALNUM` letters or digits, any digit, or at least
    `MIN_UNSPACED_CHARS` characters of an unspaced script."""
    core = _word_core(word)
    if not core:
        return False
    if any(c.isdigit() for c in core):
        return True
    unspaced = sum(1 for c in core if unspaced_script(c))
    if unspaced:
        return unspaced >= MIN_UNSPACED_CHARS
    return sum(1 for c in core if c.isalnum()) >= MIN_WORD_ALNUM


# ── matching ──────────────────────────────────────────────────────────────


class Matcher:
    def __init__(self, terms):
        parts = []
        for term in terms or []:
            if not isinstance(term, str):
                continue
            norm = normalize_index_text(term)
            if not norm:
                continue
            # A word boundary means nothing inside an unspaced script, so the
            # lookaround is kept only on a side that is not one.
            left = "" if unspaced_script(norm[0]) else r"(?<!\w)"
            right = "" if unspaced_script(norm[-1]) else r"(?!\w)"
            parts.append(left + re.escape(norm) + right)
        self.pattern = re.compile("|".join(parts), re.IGNORECASE) if parts else None

    def __bool__(self) -> bool:
        return self.pattern is not None

    def _normalized(self, text: str):
        chars: list[str] = []
        origin: list[int] = []
        in_space = True
        for index, ch in enumerate(text):
            if ch == "­":
                continue
            for expanded in unicodedata.normalize("NFKC", ch):
                if expanded.isspace() or expanded in ("​", "﻿"):
                    if not in_space:
                        chars.append(" ")
                        origin.append(index)
                        in_space = True
                    continue
                in_space = False
                chars.append(expanded)
                origin.append(index)
        return "".join(chars), origin

    def spans(self, text: str) -> list[tuple[int, int]]:
        if self.pattern is None or not text:
            return []
        norm, origin = self._normalized(text)
        out = []
        for match in self.pattern.finditer(norm):
            if match.end() <= match.start():
                continue
            out.append((origin[match.start()], origin[match.end() - 1] + 1))
        return out

    def hits(self, text: str) -> bool:
        return bool(self.spans(text))

    def scrub(self, text: str) -> str:
        spans = self.spans(text)
        if not spans:
            return text
        merged: list[list[int]] = []
        for s, e in sorted(spans):
            if merged and s <= merged[-1][1]:
                merged[-1][1] = max(merged[-1][1], e)
            else:
                merged.append([s, e])
        out = text
        for s, e in reversed(merged):
            out = out[:s] + REPLACEMENT + out[e:]
        return out


# ── text access ───────────────────────────────────────────────────────────


def _as_text(value) -> str | None:
    if isinstance(value, pikepdf.String):
        try:
            return str(value)
        except Exception:
            return None
    if isinstance(value, pikepdf.Name):
        return str(value)[1:]
    return None


def _stream_text(stream) -> tuple[str, str] | None:
    """(text, encoding) of a text stream, or None when unreadable."""
    try:
        body, too_large = bounded_read(stream, MAX_TEXT_STREAM_BYTES)
    except Exception:
        return None
    if body is None or too_large:
        return None
    body = bytes(body)
    if body.startswith(b"\xfe\xff"):
        return body[2:].decode("utf-16-be", errors="replace"), "utf-16"
    if body.startswith(b"\xef\xbb\xbf"):
        return body[3:].decode("utf-8", errors="replace"), "utf-8"
    return body.decode("latin-1"), "latin-1"


def _write_stream_text(stream, text: str, encoding: str) -> None:
    if encoding == "latin-1":
        try:
            stream.write(text.encode("latin-1"))
            return
        except UnicodeEncodeError:
            encoding = "utf-16"
    if encoding == "utf-8":
        stream.write(b"\xef\xbb\xbf" + text.encode("utf-8"))
    else:
        stream.write(b"\xfe\xff" + text.encode("utf-16-be"))


def _snippet(text: str) -> str:
    return text if len(text) <= SNIPPET_CHARS else text[:SNIPPET_CHARS] + "…"


class _Pass:
    """One read or one scrub over the file: every location calls `visit`."""

    def __init__(self, matcher: Matcher, kinds=None, fix: bool = False):
        self.matcher = matcher
        self.kinds = set(KINDS if kinds is None else kinds)
        self.fix = fix
        self.found: list[dict] = []
        self.counts: dict = {}
        self.renamed_destinations = 0
        self.changed = 0
        self.truncated = False
        self.fields_changed: list = []

    def wants(self, kind: str) -> bool:
        return not self.fix or kind in self.kinds

    def note(self, kind: str, where: str, text: str) -> None:
        occurrences = max(len(self.matcher.spans(text)), 1)
        self.counts[kind] = self.counts.get(kind, 0) + occurrences
        if len(self.found) >= MAX_REPORT:
            self.truncated = True
            return
        self.found.append({"kind": kind, "where": where, "text": _snippet(text)})

    def string_key(self, kind: str, where: str, holder, key: str, report_only: bool = False) -> bool:
        """Report or scrub one string-valued key. True when it matched."""
        try:
            value = holder.get(key)
        except (TypeError, ValueError):
            return False
        if isinstance(value, pikepdf.Stream):
            decoded = _stream_text(value)
            if decoded is None:
                return False
            text, encoding = decoded
            if not self.matcher.hits(text):
                return False
            self.note(kind, where, text)
            if self.fix and kind in self.kinds and not report_only:
                _write_stream_text(value, self.matcher.scrub(text), encoding)
                self.changed += 1
            return True
        text = _as_text(value) if isinstance(value, pikepdf.String) else None
        if text is None or not self.matcher.hits(text):
            return False
        self.note(kind, where, text)
        if self.fix and kind in self.kinds and not report_only:
            holder[key] = pikepdf.String(self.matcher.scrub(text))
            self.changed += 1
        return True


# ── name trees ────────────────────────────────────────────────────────────


def _tree_entries(root) -> list[tuple[str, object, object]]:
    """(decoded key, key object, value) of every leaf entry, cycle-safe."""
    out: list = []
    seen: set = set()
    stack = [(root, 0)]
    while stack:
        node, depth = stack.pop()
        if not isinstance(node, pikepdf.Dictionary) or depth > MAX_TREE_DEPTH:
            continue
        try:
            if node.is_indirect:
                if tuple(node.objgen) in seen:
                    continue
                seen.add(tuple(node.objgen))
        except Exception:
            pass
        names = node.get("/Names")
        if isinstance(names, pikepdf.Array):
            for i in range(0, len(names) - 1, 2):
                text = _as_text(names[i])
                if text is not None:
                    out.append((text, names[i], names[i + 1]))
                if len(out) >= MAX_TREE_ENTRIES:
                    return out
        kids = node.get("/Kids")
        if isinstance(kids, pikepdf.Array):
            for kid in reversed(list(kids)):
                stack.append((kid, depth + 1))
    return out


def _rewrite_tree(pdf, root, entries: list[tuple[str, object]]) -> None:
    """Replace a name tree's content with ONE sorted leaf (§7.9.6 orders keys
    by their bytes)."""
    def sort_key(pair):
        key = pair[0]
        try:
            return bytes(key)
        except Exception:
            return str(key).encode("utf-8", "replace")

    flat = pikepdf.Array()
    for key, value in sorted(entries, key=sort_key):
        flat.append(key)
        flat.append(value)
    for stale in ("/Kids", "/Limits"):
        if stale in root:
            del root[stale]
    root["/Names"] = flat


def _neutral(prefix: str, taken: set) -> str:
    n = 1
    while f"{prefix}{n}" in taken:
        n += 1
    name = f"{prefix}{n}"
    taken.add(name)
    return name


def _renamed_tree(pass_: _Pass, pdf, root, kind: str, prefix: str, on_value=None) -> dict:
    """Report every key that spells a term, and on a scrub rename it to a
    neutral id. Returns old decoded key -> new key string."""
    entries = _tree_entries(root)
    taken = {key for key, _k, _v in entries}
    renames: dict = {}
    for key, _key_obj, value in entries:
        if on_value is not None:
            on_value(key, value)
        if pass_.matcher.hits(key):
            pass_.note(kind, key, key)
            if pass_.fix and kind in pass_.kinds:
                renames[key] = _neutral(prefix, taken)
    if renames:
        rebuilt = [
            (pikepdf.String(renames.get(key, key)) if key in renames else key_obj, value)
            for key, key_obj, value in entries
        ]
        _rewrite_tree(pdf, root, rebuilt)
        pass_.changed += len(renames)
    return renames


# ── locations ─────────────────────────────────────────────────────────────


def _outlines(pass_: _Pass, pdf) -> None:
    root = pdf.Root.get("/Outlines")
    if not isinstance(root, pikepdf.Dictionary):
        return
    seen: set = set()
    stack = [(root.get("/First"), "")]
    count = 0
    while stack and count < MAX_OUTLINE_ITEMS:
        item, path = stack.pop()
        while isinstance(item, pikepdf.Dictionary) and count < MAX_OUTLINE_ITEMS:
            try:
                key = tuple(item.objgen) if item.is_indirect else id(item)
            except Exception:
                key = id(item)
            if key in seen:
                break
            seen.add(key)
            count += 1
            title = _as_text(item.get("/Title")) or ""
            where = f"{path} > {title}" if path else title
            pass_.string_key("outline", where, item, "/Title")
            child = item.get("/First")
            if child is not None:
                stack.append((child, where))
            item = item.get("/Next")


def _threads(pass_: _Pass, pdf) -> None:
    threads = pdf.Root.get("/Threads")
    if not isinstance(threads, pikepdf.Array):
        return
    for index, thread in enumerate(threads):
        info = thread.get("/I") if isinstance(thread, pikepdf.Dictionary) else None
        if not isinstance(info, pikepdf.Dictionary):
            continue
        for key in list(info.keys()):
            pass_.string_key("thread", f"{index + 1} {key[1:]}", info, key)


def _page_labels(pass_: _Pass, pdf) -> None:
    root = pdf.Root.get("/PageLabels")
    seen: set = set()
    stack = [(root, 0)]
    while stack:
        node, depth = stack.pop()
        if not isinstance(node, pikepdf.Dictionary) or depth > MAX_TREE_DEPTH:
            continue
        try:
            if node.is_indirect:
                if tuple(node.objgen) in seen:
                    continue
                seen.add(tuple(node.objgen))
        except Exception:
            pass
        nums = node.get("/Nums")
        if isinstance(nums, pikepdf.Array):
            for i in range(0, len(nums) - 1, 2):
                label = nums[i + 1]
                if isinstance(label, pikepdf.Dictionary):
                    try:
                        start = int(nums[i]) + 1
                    except (TypeError, ValueError):
                        start = 0
                    pass_.string_key("page_label", str(start), label, "/P")
        kids = node.get("/Kids")
        if isinstance(kids, pikepdf.Array):
            for kid in kids:
                stack.append((kid, depth + 1))


def _info(pass_: _Pass, pdf) -> None:
    info = pdf.trailer.get("/Info")
    if not isinstance(info, pikepdf.Dictionary):
        return
    for key in list(info.keys()):
        if key not in _INFO_SKIP:
            pass_.string_key("metadata", key[1:], info, key)


def _xmp_parse(body: bytes):
    parser = etree.XMLParser(resolve_entities=False, load_dtd=False, no_network=True,
                             recover=False, huge_tree=False)
    root = etree.fromstring(body, parser)
    tree = root.getroottree()
    if tree.docinfo.doctype:
        raise ValueError
    count = 0
    for node in root.iter():
        count += 1
        if count > MAX_METADATA_ELEMENTS or isinstance(node, etree._Entity):
            raise ValueError
    return tree


def _local(tag) -> str:
    return etree.QName(tag).localname if isinstance(tag, str) else ""


def _xmp(pass_: _Pass, pdf) -> None:
    metadata = pdf.Root.get("/Metadata")
    if not isinstance(metadata, pikepdf.Stream):
        return
    try:
        body, too_large = bounded_read(metadata, MAX_METADATA_BYTES)
        if body is None or too_large:
            return
        tree = _xmp_parse(bytes(body))
    except Exception:
        return
    changed = False
    for node in tree.getroot().iter():
        if not isinstance(node.tag, str):
            continue
        where = _local(node.tag)
        parent = node.getparent()
        while where in ("li", "Alt", "Seq", "Bag") and parent is not None:
            where = _local(parent.tag)
            parent = parent.getparent()
        if node.text and not _xmp_skipped(where, node.text) and pass_.matcher.hits(node.text):
            pass_.note("metadata", where, node.text)
            if pass_.fix and "metadata" in pass_.kinds:
                node.text = pass_.matcher.scrub(node.text)
                changed = True
        for attr, value in list(node.attrib.items()):
            name = _local(attr)
            if _xmp_skipped(name, value):
                continue
            if pass_.matcher.hits(value):
                pass_.note("metadata", name, value)
                if pass_.fix and "metadata" in pass_.kinds:
                    node.attrib[attr] = pass_.matcher.scrub(value)
                    changed = True
    if changed:
        metadata.write(etree.tostring(tree, encoding="utf-8", xml_declaration=True))
        pass_.changed += 1


def _filespec(pass_: _Pass, where: str, spec) -> None:
    if not isinstance(spec, pikepdf.Dictionary):
        return
    for key in _STRING_KEYS_FILESPEC:
        pass_.string_key("embedded_file", where, spec, key)


def _annotations(pass_: _Pass, pdf) -> None:
    for number, page in enumerate(pdf.pages, start=1):
        annots = page.obj.get("/Annots")
        if not isinstance(annots, pikepdf.Array):
            continue
        for annot in annots:
            if not isinstance(annot, pikepdf.Dictionary):
                continue
            subtype = annot.get("/Subtype")
            if subtype == Name.Widget:
                if "/Contents" in annot:
                    pass_.string_key("annotation", str(number), annot, "/Contents")
                continue
            for key in _STRING_KEYS_ANNOT:
                pass_.string_key("annotation", str(number), annot, key)
            if subtype == Name.FileAttachment:
                _filespec(pass_, str(number), annot.get("/FS"))


def _fields(pass_: _Pass, pdf) -> None:
    acro = pdf.Root.get("/AcroForm")
    if not isinstance(acro, pikepdf.Dictionary):
        return
    seen: set = set()
    stack = [(field, "", 0) for field in reversed(list(acro.get("/Fields") or []))]
    while stack:
        field, parent, depth = stack.pop()
        if not isinstance(field, pikepdf.Dictionary) or depth > MAX_TREE_DEPTH:
            continue
        try:
            key = tuple(field.objgen) if field.is_indirect else id(field)
        except Exception:
            key = id(field)
        if key in seen:
            continue
        seen.add(key)
        partial = _as_text(field.get("/T"))
        name = f"{parent}.{partial}" if parent and partial else (partial or parent)
        value_hit = False
        for k in _FIELD_NAME_KEYS:
            pass_.string_key("field_name", name or "", field, k, report_only=True)
        for k in _STRING_KEYS_FIELD:
            hit = pass_.string_key("field", name or "", field, k)
            if hit and k in ("/V", "/DV"):
                value_hit = True
        opt = field.get("/Opt")
        if isinstance(opt, pikepdf.Array):
            for entry in opt:
                if isinstance(entry, pikepdf.Array):
                    for i in range(len(entry)):
                        text = _as_text(entry[i]) if isinstance(entry[i], pikepdf.String) else None
                        if text is not None and pass_.matcher.hits(text):
                            pass_.note("field", name or "", text)
                            if pass_.fix and "field" in pass_.kinds:
                                entry[i] = pikepdf.String(pass_.matcher.scrub(text))
                                pass_.changed += 1
                                value_hit = True
            for i in range(len(opt)):
                text = _as_text(opt[i]) if isinstance(opt[i], pikepdf.String) else None
                if text is not None and pass_.matcher.hits(text):
                    pass_.note("field", name or "", text)
                    if pass_.fix and "field" in pass_.kinds:
                        opt[i] = pikepdf.String(pass_.matcher.scrub(text))
                        pass_.changed += 1
                        value_hit = True
        if value_hit and pass_.fix and "field" in pass_.kinds:
            pass_.fields_changed.append(field)
        kids = field.get("/Kids")
        if isinstance(kids, pikepdf.Array):
            for kid in reversed(list(kids)):
                stack.append((kid, name or "", depth + 1))


def _widgets_of(field) -> list:
    kids = field.get("/Kids")
    if isinstance(kids, pikepdf.Array):
        own = [kid for kid in kids if isinstance(kid, pikepdf.Dictionary) and "/T" not in kid]
        if own:
            return own
    return [field] if field.get("/Subtype") == Name.Widget or "/Rect" in field else []


def _redraw_fields(pass_: _Pass, pdf, font_dir: str) -> None:
    """A changed value keeps drawing the old text through its widget's /AP
    until the appearance is rebuilt from the new value. Only text and choice
    fields draw their value or options; a button draws its authored /AP
    states, which neither /Opt nor /TU feeds, so its appearance stays."""
    if not pass_.fields_changed:
        return
    for field in pass_.fields_changed:
        for widget in _widgets_of(field):
            if "/AP" in widget and field.get("/FT") in (Name.Tx, Name.Ch):
                del widget["/AP"]
    from engine.forms import regenerate_missing_appearances

    regenerate_missing_appearances(pdf, font_dir)


def _dest_name_holders(pdf):
    """(name tree root or None, old-style /Dests dictionary or None)."""
    names = pdf.Root.get("/Names")
    tree = names.get("/Dests") if isinstance(names, pikepdf.Dictionary) else None
    old = pdf.Root.get("/Dests")
    return (tree if isinstance(tree, pikepdf.Dictionary) else None,
            old if isinstance(old, pikepdf.Dictionary) else None)


def _dest_names(pass_: _Pass, pdf) -> dict:
    tree, old = _dest_name_holders(pdf)
    renames: dict = {}
    if tree is not None:
        renames.update(_renamed_tree(pass_, pdf, tree, "dest_name", "dest"))
        pass_.renamed_destinations += len(renames)
    if old is not None:
        keys = [str(k)[1:] for k in old.keys()]
        taken = set(keys) | set(renames.values())
        for key in keys:
            if pass_.matcher.hits(key):
                pass_.note("dest_name", key, key)
                if pass_.fix and "dest_name" in pass_.kinds:
                    new = renames.get(key) or _neutral("dest", taken)
                    old[Name("/" + new)] = old[Name("/" + key)]
                    del old[Name("/" + key)]
                    renames[key] = new
                    pass_.renamed_destinations += 1
                    pass_.changed += 1
    return renames


def _embedded_files(pass_: _Pass, pdf) -> None:
    names = pdf.Root.get("/Names")
    tree = names.get("/EmbeddedFiles") if isinstance(names, pikepdf.Dictionary) else None
    if not isinstance(tree, pikepdf.Dictionary):
        return
    _renamed_tree(pass_, pdf, tree, "embedded_file", "file",
                  on_value=lambda key, spec: _filespec(pass_, key, spec))


def _script_hits(pass_: _Pass, action) -> str | None:
    """The script text of a JavaScript action that spells a term."""
    if not isinstance(action, pikepdf.Dictionary) or action.get("/S") != Name.JavaScript:
        return None
    try:
        code = action.get("/JS")
    except (TypeError, ValueError):
        return None
    if isinstance(code, pikepdf.Stream):
        decoded = _stream_text(code)
        text = decoded[0] if decoded else None
    else:
        text = _as_text(code) if isinstance(code, pikepdf.String) else None
    return text if text is not None and pass_.matcher.hits(text) else None


def _javascript(pass_: _Pass, pdf) -> None:
    """Document-level scripts. Code is never edited: a script that spells a
    term is reported, and removal takes out the whole entry."""
    names = pdf.Root.get("/Names")
    tree = names.get("/JavaScript") if isinstance(names, pikepdf.Dictionary) else None
    if not isinstance(tree, pikepdf.Dictionary):
        return
    entries = _tree_entries(tree)
    kept = []
    for key, key_obj, action in entries:
        text = _script_hits(pass_, action)
        if text is None:
            kept.append((key_obj, action))
            continue
        pass_.note("javascript", key, text)
        if not (pass_.fix and "javascript" in pass_.kinds):
            kept.append((key_obj, action))
    if len(kept) != len(entries):
        _rewrite_tree(pdf, tree, kept)
        pass_.changed += len(entries) - len(kept)


def _kept_chain(pass_: _Pass, item, fix: bool, depth: int = 0, seen=None) -> list:
    """The actions of one chain level (a dict or a /Next array) that stay,
    in execution order. A matching action is reported; on removal its own
    /Next successors take its place, so the actions after it still run."""
    seen = set() if seen is None else seen
    if depth > MAX_TREE_DEPTH:
        return [item] if isinstance(item, pikepdf.Dictionary) else list(item or [])
    items = [item] if isinstance(item, pikepdf.Dictionary) else (
        list(item) if isinstance(item, pikepdf.Array) else [])
    out: list = []
    for action in items:
        if not isinstance(action, pikepdf.Dictionary):
            out.append(action)
            continue
        key = tuple(action.objgen) if action.is_indirect else None
        if key is not None and key in seen:
            out.append(action)
            continue
        if key is not None:
            seen.add(key)
        try:
            successor = action.get("/Next")
        except (TypeError, ValueError):
            successor = None
        rest = _kept_chain(pass_, successor, fix, depth + 1, seen) if successor is not None else []
        text = _script_hits(pass_, action)
        if text is not None:
            pass_.note("javascript", "action", text)
            if fix:
                pass_.changed += 1
                out.extend(rest)
                continue
        if fix and successor is not None:
            _set_next(action, rest)
        out.append(action)
    return out


def _set_next(action, actions: list) -> None:
    if not actions:
        if "/Next" in action:
            del action["/Next"]
    elif len(actions) == 1:
        action["/Next"] = actions[0]
    else:
        action["/Next"] = pikepdf.Array(actions)


def _splice_slot(pass_: _Pass, holder, key: str, fix: bool) -> None:
    """One action slot: the kept chain's first action takes the slot, and the
    rest run after that action's own successors."""
    try:
        action = holder.get(key)
    except (TypeError, ValueError):
        return
    if not isinstance(action, pikepdf.Dictionary) or action.get("/S") is None:
        return
    removed_here = _script_hits(pass_, action) is not None
    kept = _kept_chain(pass_, action, fix)
    if not fix or not removed_here:
        return
    if not kept:
        del holder[key]
        return
    first = kept[0]
    if len(kept) > 1:
        own = first.get("/Next")
        own_list = [own] if isinstance(own, pikepdf.Dictionary) else list(own or [])
        _set_next(first, own_list + kept[1:])
    holder[key] = first


def _drop_scripts(pass_: _Pass, holder) -> None:
    """Action slots of `holder` (/A, /OpenAction, each /AA trigger) whose
    chain holds a JavaScript action that spells a term: reported, and on
    removal that action leaves its chain whole."""
    fix = pass_.fix and "javascript" in pass_.kinds
    for key in ("/A", "/OpenAction"):
        _splice_slot(pass_, holder, key, fix)
    try:
        triggers = holder.get("/AA")
    except (TypeError, ValueError):
        triggers = None
    if isinstance(triggers, pikepdf.Dictionary):
        for key in list(triggers.keys()):
            _splice_slot(pass_, triggers, key, fix)


def _entries(holder) -> list:
    """(key, value) pairs, including a key whose bytes are not UTF-8."""
    try:
        return list(holder.items())
    except Exception:
        pass
    out = []
    for key in list(holder.keys()):
        try:
            out.append((key, holder[key]))
        except Exception:
            continue
    return out


def _walk_dicts(pdf):
    """Every dictionary in the file, direct or indirect, each once."""
    seen: set = set()
    count = 0
    for obj in pdf.objects:
        stack = [obj]
        while stack:
            item = stack.pop()
            count += 1
            if count > MAX_WALK_OBJECTS:
                return
            if not isinstance(item, (pikepdf.Dictionary, pikepdf.Stream, pikepdf.Array)):
                continue
            # Direct objects form a tree, so only an indirect one can be met
            # twice; each is walked from its own `pdf.objects` entry.
            if item is not obj and getattr(item, "is_indirect", False):
                continue
            if item is obj:
                if tuple(obj.objgen) in seen:
                    continue
                seen.add(tuple(obj.objgen))
            if isinstance(item, pikepdf.Array):
                stack.extend(list(item))
                continue
            if isinstance(item, pikepdf.Dictionary):
                yield item
            for _key, value in _entries(item):
                stack.append(value)


def _actions_and_links(pass_: _Pass, pdf, renames: dict) -> None:
    """JavaScript actions outside the name tree, and every reference to a
    renamed destination (§12.3.2.3: a /Dest or a GoTo /D names it by string
    or name)."""

    def retarget(holder, key):
        value = holder.get(key)
        text = _as_text(value) if isinstance(value, (pikepdf.String, pikepdf.Name)) else None
        if text is None or text not in renames:
            return
        holder[key] = Name("/" + renames[text]) if isinstance(value, pikepdf.Name) else pikepdf.String(renames[text])

    for d in list(_walk_dicts(pdf)):
        _drop_scripts(pass_, d)
        if renames:
            if "/Dest" in d:
                retarget(d, "/Dest")
            if d.get("/S") == Name.GoTo and "/D" in d:
                retarget(d, "/D")


def _run(pass_: _Pass, pdf, font_dir: str = "") -> None:
    _outlines(pass_, pdf)
    _threads(pass_, pdf)
    renames = _dest_names(pass_, pdf)
    _page_labels(pass_, pdf)
    _info(pass_, pdf)
    _xmp(pass_, pdf)
    _annotations(pass_, pdf)
    _fields(pass_, pdf)
    _embedded_files(pass_, pdf)
    _javascript(pass_, pdf)
    _actions_and_links(pass_, pdf, renames)
    if pass_.fix:
        _redraw_fields(pass_, pdf, font_dir)


# Found and reported, never removed: see `_FIELD_NAME_KEYS`.
REPORT_ONLY_KINDS = ("field_name",)


def residue_kinds(value) -> list:
    """A caller's removal choice as kinds: "all", a list or a comma list of
    kinds, or nothing (report only)."""
    if value is None or value == "" or value == []:
        return []
    if value == "all":
        return list(KINDS)
    items = value.split(",") if isinstance(value, str) else list(value)
    kinds = [str(item).strip() for item in items if str(item).strip()]
    unknown = sorted(set(kinds) - set(KINDS))
    if unknown:
        raise ValueError(f"unknown residue kind: {unknown[0]}")
    return kinds


def find_residue(pdf, terms) -> dict:
    """Every place outside page content that still spells a term.
    `residue` is capped at `MAX_REPORT` rows; `residue_counts` counts every
    occurrence per kind, so a caller removes by kind, never by row."""
    matcher = Matcher(terms)
    if not matcher:
        return {"residue": [], "residue_truncated": False, "residue_counts": {},
                "residue_report_only": {}}
    pass_ = _Pass(matcher)
    _run(pass_, pdf)
    counts = {k: n for k, n in pass_.counts.items() if k not in REPORT_ONLY_KINDS}
    report_only = {k: n for k, n in pass_.counts.items() if k in REPORT_ONLY_KINDS}
    return {"residue": pass_.found, "residue_truncated": pass_.truncated,
            "residue_counts": counts, "residue_report_only": report_only}


def scrub_residue(pdf, terms, kinds=None, font_dir: str = "") -> dict:
    """Remove the occurrences in `kinds` (all kinds when None). Returns
    `residue_removed` (values changed) and `renamed_destinations`: a renamed
    named destination is retargeted inside this file, but a link from another
    document or a `#nameddest=` URL that names it no longer resolves."""
    unknown = sorted(set(kinds or ()) - set(KINDS))
    if unknown:
        raise ValueError(f"unknown residue kind: {unknown[0]}")
    matcher = Matcher(terms)
    if not matcher:
        return {"residue_removed": 0, "renamed_destinations": 0}
    pass_ = _Pass(matcher, kinds, fix=True)
    _run(pass_, pdf, font_dir)
    return {"residue_removed": pass_.changed, "renamed_destinations": pass_.renamed_destinations}


def remove_redaction_residue(
    file: str, output: str, terms, kinds=None, font_dir: str = ""
) -> dict:
    """Engine op: remove the text a redaction took off the pages from the
    places `kinds` names, then report what still spells it.

    `terms` are not checked against the redaction that produced them: the op
    only replaces whole-word occurrences with `REPLACEMENT` in the chosen
    places, which any caller able to write the file can do anyway. The
    signed-document decision is the caller's, taken exactly as for the
    `redact` it follows: the window's operation gate classes this op as a
    structural rewrite, and the command line and folder runs reach it only
    through `redact` / `search_and_redact`, after their own signature check."""
    from pathlib import Path

    if not isinstance(terms, list) or not all(isinstance(t, str) for t in terms):
        raise ValueError("terms must be a list of strings")
    output_path = Path(output)
    same_file = is_same_file(str(file), str(output_path))
    with open_pdf(file) as pdf:
        changed = scrub_residue(pdf, terms, residue_kinds(kinds) if kinds is not None else None, font_dir)
        remaining = find_residue(pdf, terms)
        if same_file:
            with staged_write(output_path) as staged:
                save_pdf(pdf, str(staged))
                pdf.close()
        else:
            save_pdf(pdf, output_path)
    return {"output": str(output_path), **changed, **remaining}
