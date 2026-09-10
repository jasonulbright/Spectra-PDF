"""One field-copy map per source contribution, not per page.

The pinned pikepdf add_pages_from repairs forms once per page. qpdf's
transform_annotations exposes that same resource/default/appearance handling
as a batch: all selected annotations must share ONE invocation. Page and
annotation identities are separate; repeated pages get private annotations
while their widgets still address the same source field.
"""
from collections import Counter

import pikepdf
from pikepdf import Array, Dictionary, Name
# Reuse the pinned library's destination migration rather than implement a
# second name-tree/collision policy. Tests cover this private API boundary.
from pikepdf._page_copy import _migrate_named_destinations

from engine.acroform import (
    carry_doc_form_extras, carry_pure_data_fields,
    fq_field_name, prune_form_to_pages, refresh_sig_flags, refuse_if_xfa,
)

# Field and annotation dictionaries can be merged (ISO 32000-2 12.7.3.1).
# When that widget is repeated, keep the existing field object as the parent
# and move its annotation role into children. Unknown extension keys survive
# in both roles; field values never remain on the new child widgets.
_FIELD_KEYS = {
    '/FT', '/T', '/TU', '/TM', '/Ff', '/V', '/DV', '/Kids', '/DA', '/Q',
    '/MaxLen', '/DS', '/RV', '/Opt', '/TI', '/I', '/Lock', '/SV',
}
_ANNOT_KEYS = {
    '/Type', '/Subtype', '/Rect', '/Contents', '/P', '/NM', '/M', '/F',
    '/AP', '/AS', '/Border', '/C', '/StructParent', '/OC', '/AF', '/ca',
    '/CA', '/BM', '/Lang', '/ExData', '/H', '/MK', '/A', '/BS',
}
_FIELD_ACTIONS = {'/K', '/F', '/V', '/C'}


def _combined_field_ids(pdf):
    """Distinguish merged fields from widget-only children by tree role.

    qpdf's terminal-field list also exposes widget leaves with inherited /FT;
    treating those as independent fields would insert a spurious field level.
    An unnamed root is still a field by its registration, not by its name.
    """
    acro = pdf.Root.get('/AcroForm')
    pending = [(node, True) for node in acro.get('/Fields', [])] if acro is not None else []
    combined, seen = set(), set()
    while pending:
        node, root = pending.pop()
        if node.objgen in seen:
            continue
        seen.add(node.objgen)
        if node.get('/Subtype') == Name.Widget and (root or '/T' in node or '/FT' in node):
            combined.add(node.objgen)
        pending.extend((kid, False) for kid in node.get('/Kids', []))
    return combined


def _separate_widget(dst, field):
    widget = dst.make_indirect(Dictionary(field))
    for key in _FIELD_KEYS:
        if key in widget:
            del widget[key]
    for key in _ANNOT_KEYS:
        if key in field:
            del field[key]
    aa = field.get('/AA')
    if isinstance(aa, Dictionary):
        for obj, field_role in ((field, True), (widget, False)):
            actions = {k: v for k, v in aa.items() if (k in _FIELD_ACTIONS) == field_role}
            if actions:
                obj.AA = Dictionary(actions)
            elif '/AA' in obj:
                del obj['/AA']
    widget.Parent = field
    field.Kids = Array([widget])
    return widget


def copy_pages_with_forms(dst, src, pages=None):
    """Append a source selection with shared fields and private page widgets.

    The source is a private open: pruning changes its in-memory field forest,
    never its file. Keep it open until the destination is saved, as with qpdf's
    ordinary foreign copies. Each call is a distinct source contribution:
    reusing a filename in merge intentionally invokes independent rename maps.
    """
    refuse_if_xfa(src, 'PDF', 'merging')
    indices = list(range(len(src.pages))) if pages is None else list(pages)
    src_pages = [src.pages[i] for i in indices]
    start = len(dst.pages)

    # Read each page's annotations once so direct objects have stable site
    # identities too. Only indirect object identity can be shared across pages.
    by_page = {}
    originals = {}
    page_keys = []
    for page in src_pages:
        pg = page.obj.objgen
        if pg not in by_page:
            items = page.get('/Annots', Array())
            if not isinstance(items, Array):
                raise pikepdf.PdfError('Cannot copy a non-array page annotation list')
            keys = []
            for ordinal, annot in enumerate(items):
                if not isinstance(annot, Dictionary):
                    raise pikepdf.PdfError('Cannot copy a non-dictionary page annotation')
                key = ('object', annot.objgen) if annot.is_indirect else ('site', pg, ordinal)
                keys.append(key)
                originals.setdefault(key, annot)
            by_page[pg] = keys
        page_keys.append(by_page[pg])

    # Capture/validate annotations before asking the library's form helper to
    # inspect the source: its cache construction can normalize malformed lists.
    prune_form_to_pages(src, indices)
    src.acroform.invalidate_cache()

    # Raw copies are paired below with one complete form registration. Using
    # add_pages_from here would first split the very graph we need to preserve.
    for page in src_pages:
        dst.pages.append(page)
    before = len(dst.acroform.fields)
    renamed = {}
    if originals:
        copied, fields, _ = dst.acroform.transform_annotations(
            Array(list(originals.values())), from_qpdf=src, from_acroform=src.acroform)
        if len(copied) != len(originals):
            raise pikepdf.PdfError('Annotation copy did not preserve the selected annotation set')
        names = [fq_field_name(field) for field in fields]
        dst.acroform.add_and_rename_fields(fields)
        for old, field in zip(names, fields):
            new = fq_field_name(field)
            if old is not None and new is not None and old != new:
                renamed[old] = new
        mapping = dict(zip(originals, copied))
        counts = Counter(key for keys in page_keys for key in keys)
        field_ids = _combined_field_ids(dst)
        for key, annot in mapping.items():
            if counts[key] > 1 and annot.objgen in field_ids and annot.get('/Subtype') == Name.Widget:
                mapping[key] = _separate_widget(dst, annot)

        used = set()
        for offset, keys in enumerate(page_keys):
            page = dst.pages[start + offset]
            annots = []
            local = {}
            for key in keys:
                base = mapping[key]
                annot = base
                if key in used:
                    annot = dst.make_indirect(Dictionary(base))
                    parent = base.get('/Parent')
                    if base.get('/Subtype') == Name.Widget and isinstance(parent, Dictionary):
                        kids = parent.get('/Kids')
                        if isinstance(kids, Array):
                            kids.append(annot)
                used.add(key)
                annot.P = page.obj
                local[key] = annot
                annots.append(annot)
            # Keep popup/reply relationships inside the same page occurrence.
            for source_key, annot in zip(keys, annots):
                for relation in ('/Popup', '/IRT', '/Parent'):
                    if relation == '/Parent' and annot.get('/Subtype') == Name.Widget:
                        continue
                    target = originals[source_key].get(relation)
                    if isinstance(target, Dictionary) and target.is_indirect:
                        target_key = ('object', target.objgen)
                        if target_key in mapping:
                            annot[relation] = local.get(target_key, mapping[target_key])
            if annots:
                page.Annots = Array(annots)
            elif '/Annots' in page.obj:
                del page.obj['/Annots']

    # Pruning drops unselected widget children imported along a shared field.
    # Rebinding /P above ensures it cannot mistake a copied orphan page for a
    # selected one. Pure-data values and document-level behavior follow once.
    prune_form_to_pages(dst, range(len(dst.pages)))
    pure = carry_pure_data_fields(dst, src)
    renamed.update({r['from']: r['to'] for r in pure})
    refresh_sig_flags(dst)
    carry_doc_form_extras(dst, src, renamed)
    dst.acroform.invalidate_cache()
    added, dest_renames, dropped = _migrate_named_destinations(dst, src, src_pages, start)
    return pikepdf.PageCopyResult(
        pages_added=len(src_pages), forms='preserve',
        fields_added=len(dst.acroform.fields) - before, renamed_fields=renamed,
        named_dests_added=added, renamed_dests=dest_renames, dropped_dests=dropped,
    )
