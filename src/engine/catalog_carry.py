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
destination page tree) are removed: the link's /Dest, or each GoTo action in
an /A or /AA chain whose own destination targets such a page; the rest of the
chain survives. The raw page copy leaves
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


def _page_resolver(src: pikepdf.Pdf, page_map: dict):
    """Map a destination's first element to the copied page, or None.

    A page object resolves through the contribution's page map. An integer
    is not a valid local page reference (ISO 32000-2 12.3.2.2) but viewers
    read it as a zero-based page index of the document holding it, so it is
    taken as an index into THIS contribution's source; left as an integer it
    would address a page of an earlier contribution after a merge.
    """
    def resolve(first):
        if isinstance(first, Dictionary):
            return page_map.get(first.objgen)
        if isinstance(first, int) and not isinstance(first, bool) and 0 <= first < len(src.pages):
            return page_map.get(src.pages[first].obj.objgen)
        return None
    return resolve


def _suffixed(key: bytes, i: int) -> bytes:
    # A UTF-16BE text string (BOM FE FF) takes the suffix as UTF-16BE code
    # units; appending single bytes would leave an odd-length, invalid text.
    if key.startswith(b'\xfe\xff'):
        return key + ('.%d' % i).encode('utf-16-be')
    return key + b'.%d' % i


def _text(key: bytes) -> str:
    return str(String(key))


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


def _carry_named(dst: pikepdf.Pdf, src: pikepdf.Pdf, resolve):
    """Returns ({(kind, source key): final key}, added, renamed, dropped)."""
    carried: dict = {}
    renamed: dict = {}
    dropped: list = []

    def target(value):
        arr = _dest_array(value)
        return (None, None) if arr is None else (resolve(arr[0]), arr)

    def entry(label, value, page, arr):
        view = [dst.copy_foreign(v) if getattr(v, "is_indirect", False) else v for v in list(arr)[1:]]
        # A PDF 2.0 /SD (12.3.2.1) addresses a structure element. Page copy
        # carries no structure tree, so the element is never in the
        # destination: the entry keeps /D and the lost /SD is reported.
        if isinstance(value, Dictionary) and '/SD' in value:
            dropped.append(label + ' /SD')
        return dst.make_indirect(Dictionary(D=Array([page, *view])))

    existing = dict(_string_entries(dst))
    string_added = False
    for key, value in _string_entries(src):
        if ('s', key) in carried:
            continue
        page, arr = target(value)
        if page is None:
            dropped.append(_text(key))
            continue
        final = _unique(existing.keys(), key, _suffixed)
        existing[final] = entry(_text(key), value, page, arr)
        carried[('s', key)] = final
        string_added = True
        if final != key:
            renamed[_text(key)] = _text(final)
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
        legacy[final] = entry(key, value, page, arr)
        carried[('n', key)] = final
        if final != key:
            renamed[key] = final
    return carried, len(carried), renamed, dropped


class _Jumps:
    """Re-points or classifies destination values on the copied pages."""

    def __init__(self, dst: pikepdf.Pdf, carried: dict, resolve, src_keys: set):
        self.pages = {page.obj.objgen for page in dst.pages}
        self.carried = carried
        self.resolve = resolve
        self.src_keys = src_keys

    def fix(self, value):
        """(keep, replacement or None). A name that the source never defined
        is left as it is: it named nothing before the copy either."""
        if isinstance(value, String):
            if ('s', bytes(value)) not in self.src_keys:
                return True, None
            final = self.carried.get(('s', bytes(value)))
            return (False, None) if final is None else (True, String(final))
        if isinstance(value, Name):
            if ('n', str(value)) not in self.src_keys:
                return True, None
            final = self.carried.get(('n', str(value)))
            return (False, None) if final is None else (True, Name(final))
        if isinstance(value, Array) and len(value) > 0:
            first = value[0]
            if isinstance(first, Dictionary):
                # Copied link arrays already hold destination pages; qpdf's
                # foreign copy writes null for a page it did not copy.
                return first.objgen in self.pages, None
            page = self.resolve(first)
            if page is None:
                return False, None
            return True, Array([page, *list(value)[1:]])
        return True, None

    def settle(self, action, depth: int = 0):
        """The action with dangling GoTo actions removed from its chain, or
        None when nothing survives. Only a GoTo whose own destination targets
        an uncopied page is removed; its surviving /Next successors take its
        place in execution order. Every other action type is kept."""
        if depth > _MAX_DEPTH or not isinstance(action, Dictionary):
            return action
        nxt = action.get('/Next')
        chain = list(nxt) if isinstance(nxt, Array) else [nxt] if nxt is not None else []
        settled = [self.settle(sub, depth + 1) for sub in chain]
        survivors = [r for r in settled if r is not None]
        dangling = False
        if action.get('/S') == Name.GoTo and '/D' in action:
            keep, replacement = self.fix(action.D)
            if not keep:
                dangling = True
            elif replacement is not None:
                action.D = replacement
        if dangling:
            if not survivors:
                return None
            head, rest = survivors[0], survivors[1:]
            if rest:
                own = head.get('/Next')
                own = list(own) if isinstance(own, Array) else [own] if own is not None else []
                head.Next = Array(own + rest)
            return head
        if chain and any(a is None or a is not b for a, b in zip(settled, chain)):
            if not survivors:
                del action['/Next']
            elif len(survivors) == 1 and not isinstance(nxt, Array):
                action.Next = survivors[0]
            else:
                action.Next = Array(survivors)
        return action


def carry_catalog(dst: pikepdf.Pdf, src: pikepdf.Pdf, src_pages: list, start: int):
    """Carry presentation keys and named destinations for one contribution
    and settle every jump on its copied pages. Returns
    (named destinations added, {source name: final name}, [dropped names])."""
    _carry_presentation(dst, src)
    copied = [dst.pages[start + i].obj for i in range(len(src_pages))]
    page_map = {}
    for page, new in zip(src_pages, copied):
        page_map.setdefault(page.obj.objgen, new)
    resolve = _page_resolver(src, page_map)
    carried, added, renamed, dropped = _carry_named(dst, src, resolve)
    src_keys = {('s', k) for k, _ in _string_entries(src)} | {('n', k) for k, _ in _name_entries(src)}
    jumps = _Jumps(dst, carried, resolve, src_keys)
    for page in copied:
        annots = page.get('/Annots')
        owners = [page] + [a for a in annots if isinstance(a, Dictionary)] if isinstance(annots, Array) else [page]
        for owner in owners:
            if owner is not page and '/Dest' in owner:
                keep, replacement = jumps.fix(owner.Dest)
                if not keep:
                    del owner['/Dest']
                elif replacement is not None:
                    owner.Dest = replacement
            if owner is not page and '/A' in owner:
                settled = jumps.settle(owner.A)
                if settled is None:
                    del owner['/A']
                else:
                    owner.A = settled
            aa = owner.get('/AA')
            if isinstance(aa, Dictionary):
                for trigger in list(aa.keys()):
                    settled = jumps.settle(aa[trigger])
                    if settled is None:
                        del aa[trigger]
                    else:
                        aa[trigger] = settled
    return added, renamed, dropped
