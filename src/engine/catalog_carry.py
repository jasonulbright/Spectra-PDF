"""Document-catalog state that a page-copy contribution carries.

Called once per ``copy_pages_with_forms`` contribution, after the pages are
appended. Presentation keys follow first-definer order (see
``_carry_presentation``; ISO 32000-2 7.7.2 Table 29 /PageLayout, /PageMode; 12.6.4.8 Table 206 /URI
/Base). Named destinations (7.7.4 legacy /Dests dictionary, 7.9.6 /Names
/Dests name tree) are carried for every entry whose target page was copied
in this contribution, whether or not a link on a copied page names it: a
name is also an external entry point (``file.pdf#name``). A name already
present in the destination from an earlier contribution is made unique as
``name.1``, ``name.2``, ..., and the copied links are re-pointed to it.

Jumps on copied pages whose target page was not copied (a named destination
that did not carry, or an explicit array whose page is not in the
destination page tree) are removed: the link's /Dest, or the whole /A or /AA
trigger action whose GoTo chain reaches such a page. The raw page copy leaves
such a jump as a dangling name or a null page reference that navigates
nowhere. GoToR, GoToE, JavaScript and every other action type
are not destinations in this document and are never touched.
"""
from __future__ import annotations

import pikepdf
from pikepdf import Array, Dictionary, Name, String

_MAX_DEPTH = 64
_PRESENTATION = ('/PageLayout', '/PageMode')


def _carry_presentation(dst: pikepdf.Pdf, src: pikepdf.Pdf) -> None:
    """Fill each presentation key the destination does not yet define.

    Invariant: /PageLayout, /PageMode and /URI (/Base) each take the value of
    the FIRST contribution, in source order, that defines that key. A later
    source's different value is a conflict resolved by that order and never
    overwrites; a source that lacks a key never removes it.
    """
    for key in _PRESENTATION:
        value = src.Root.get(key)
        if key not in dst.Root and isinstance(value, Name):
            dst.Root[key] = Name(str(value))
    uri = src.Root.get('/URI')
    base = uri.get('/Base') if isinstance(uri, Dictionary) else None
    if '/URI' not in dst.Root and isinstance(base, String):
        dst.Root.URI = Dictionary(Base=String(bytes(base)))


def _tree_entries(node, out: list, seen: set, depth: int = 0) -> None:
    if depth > _MAX_DEPTH or not isinstance(node, Dictionary):
        return
    if node.is_indirect:
        if node.objgen in seen:
            return
        seen.add(node.objgen)
    names = node.get('/Names')
    if isinstance(names, Array):
        for i in range(0, len(names) - 1, 2):
            key = names[i]
            if isinstance(key, String):
                out.append((bytes(key), names[i + 1]))
    kids = node.get('/Kids')
    if isinstance(kids, Array):
        for kid in kids:
            _tree_entries(kid, out, seen, depth + 1)


def _string_entries(pdf: pikepdf.Pdf) -> list:
    out: list = []
    names = pdf.Root.get('/Names')
    if isinstance(names, Dictionary):
        _tree_entries(names.get('/Dests'), out, set())
    return out


def _name_entries(pdf: pikepdf.Pdf) -> list:
    legacy = pdf.Root.get('/Dests')
    if not isinstance(legacy, Dictionary):
        return []
    return [(key, legacy[key]) for key in legacy.keys()]


def _dest_array(value):
    if isinstance(value, Dictionary):
        value = value.get('/D')
    return value if isinstance(value, Array) and len(value) > 0 else None


def _unique(taken: set, key, suffix):
    if key not in taken:
        return key
    i = 1
    while suffix(key, i) in taken:
        i += 1
    return suffix(key, i)


def _write_string_tree(dst: pikepdf.Pdf, entries: dict) -> None:
    # One sorted leaf: name-tree keys are ordered by byte value (7.9.6).
    flat = Array()
    for key in sorted(entries):
        flat.append(String(key))
        flat.append(entries[key])
    names = dst.Root.get('/Names')
    if not isinstance(names, Dictionary):
        names = dst.make_indirect(Dictionary())
        dst.Root.Names = names
    names.Dests = dst.make_indirect(Dictionary(Names=flat))


def _carry_named(dst: pikepdf.Pdf, src: pikepdf.Pdf, page_map: dict):
    """Returns ({(kind, source key): final key}, added, renamed, dropped)."""
    carried: dict = {}
    renamed: dict = {}
    dropped: list = []

    def target(value):
        arr = _dest_array(value)
        if arr is None or not isinstance(arr[0], Dictionary):
            return None, None
        return page_map.get(arr[0].objgen), arr

    def entry(page, arr):
        view = [dst.copy_foreign(v) if getattr(v, "is_indirect", False) else v for v in list(arr)[1:]]
        return dst.make_indirect(Dictionary(D=Array([page, *view])))

    existing = dict(_string_entries(dst))
    string_added = False
    for key, value in _string_entries(src):
        if ('s', key) in carried:
            continue
        page, arr = target(value)
        if page is None:
            dropped.append(key.decode('latin-1'))
            continue
        final = _unique(existing.keys(), key, lambda k, i: k + b'.%d' % i)
        existing[final] = entry(page, arr)
        carried[('s', key)] = final
        string_added = True
        if final != key:
            renamed[key.decode('latin-1')] = final.decode('latin-1')
    if string_added:
        _write_string_tree(dst, existing)

    legacy = None
    for key, value in _name_entries(src):
        if ('n', key) in carried:
            continue
        page, arr = target(value)
        if page is None:
            dropped.append(key)
            continue
        if legacy is None:
            legacy = dst.Root.get('/Dests')
            if not isinstance(legacy, Dictionary):
                legacy = dst.make_indirect(Dictionary())
                dst.Root.Dests = legacy
        final = _unique(set(legacy.keys()), key, lambda k, i: f'{k}.{i}')
        legacy[final] = entry(page, arr)
        carried[('n', key)] = final
        if final != key:
            renamed[key] = final
    return carried, len(carried), renamed, dropped


class _Jumps:
    """Re-points or classifies destination values on the copied pages."""

    def __init__(self, dst: pikepdf.Pdf, carried: dict):
        self.pages = {page.obj.objgen for page in dst.pages}
        self.carried = carried

    def fix(self, value):
        """(keep, replacement or None). A name that the source never defined
        is left as it is: it named nothing before the copy either."""
        if isinstance(value, String):
            final = self.carried.get(('s', bytes(value)))
            return (False, None) if final is None else (True, String(final))
        if isinstance(value, Name):
            final = self.carried.get(('n', str(value)))
            return (False, None) if final is None else (True, Name(final))
        if isinstance(value, Array) and len(value) > 0:
            first = value[0]
            if isinstance(first, Dictionary):
                return first.objgen in self.pages, None
            # qpdf's foreign copy writes null for a page it did not copy.
            return isinstance(first, int), None
        return True, None

    def names_undefined(self, value, src_keys: set) -> bool:
        if isinstance(value, String):
            return ('s', bytes(value)) not in src_keys
        if isinstance(value, Name):
            return ('n', str(value)) not in src_keys
        return False

    def action_ok(self, action, src_keys: set, depth: int = 0) -> bool:
        """False when a GoTo in the chain jumps to a page that was not copied;
        re-points carried names in place otherwise."""
        if depth > _MAX_DEPTH or not isinstance(action, Dictionary):
            return True
        if action.get('/S') == Name.GoTo and '/D' in action:
            d = action.D
            if not self.names_undefined(d, src_keys):
                keep, replacement = self.fix(d)
                if not keep:
                    return False
                if replacement is not None:
                    action.D = replacement
        nxt = action.get('/Next')
        chain = nxt if isinstance(nxt, Array) else [nxt] if nxt is not None else []
        return all(self.action_ok(sub, src_keys, depth + 1) for sub in chain)


def carry_catalog(dst: pikepdf.Pdf, src: pikepdf.Pdf, src_pages: list, start: int):
    """Carry presentation keys and named destinations for one contribution
    and settle every jump on its copied pages. Returns
    (named destinations added, {source name: final name}, [dropped names])."""
    _carry_presentation(dst, src)
    copied = [dst.pages[start + i].obj for i in range(len(src_pages))]
    page_map = {}
    for page, new in zip(src_pages, copied):
        page_map.setdefault(page.obj.objgen, new)
    carried, added, renamed, dropped = _carry_named(dst, src, page_map)
    src_keys = {('s', k) for k, _ in _string_entries(src)} | {('n', k) for k, _ in _name_entries(src)}
    jumps = _Jumps(dst, carried)
    for page in copied:
        annots = page.get('/Annots')
        owners = [page] + [a for a in annots if isinstance(a, Dictionary)] if isinstance(annots, Array) else [page]
        for owner in owners:
            if owner is not page and '/Dest' in owner and not jumps.names_undefined(owner.Dest, src_keys):
                keep, replacement = jumps.fix(owner.Dest)
                if not keep:
                    del owner['/Dest']
                elif replacement is not None:
                    owner.Dest = replacement
            if owner is not page and '/A' in owner and not jumps.action_ok(owner.A, src_keys):
                del owner['/A']
            aa = owner.get('/AA')
            if isinstance(aa, Dictionary):
                for trigger in list(aa.keys()):
                    if not jumps.action_ok(aa[trigger], src_keys):
                        del aa[trigger]
    return added, renamed, dropped
