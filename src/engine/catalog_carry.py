"""Document-catalog state that a page-copy contribution carries.

``carry_catalog_jumps`` handles presentation keys, named destinations and
jumps on the copied pages; ``StructCarry`` the structure tree; ``DocCarry``
outlines, page labels, embedded files, articles, document JavaScript, /AA,
/OpenAction, /Lang, /ViewerPreferences and metadata.

Called once per ``copy_pages_with_forms`` contribution, after the pages are
appended. Presentation keys follow first-definer order (see
``_carry_presentation``; ISO 32000-2 7.7.2 Table 29 /PageLayout, /PageMode; 12.6.4.8 Table 206 /URI
/Base). A /PageMode that opens the outline or attachments panel is removed
when the destination has no outline item or embedded file to show
(``settle_page_mode``). Named destinations (7.7.4 legacy /Dests dictionary, 7.9.6 /Names
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
from lxml import etree
from pikepdf import Array, Dictionary, Name, Stream, String

_MAX_DEPTH = 64
_MAX_ACTION_STEPS = 100_000
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


def _carry_named(dst: pikepdf.Pdf, src: pikepdf.Pdf, resolve, struct_map=None):
    """Returns ({(kind, source key): final key}, added, renamed, dropped)."""
    carried: dict = {}
    renamed: dict = {}
    dropped: list = []

    def target(value):
        arr = _dest_array(value)
        return (None, None) if arr is None else (resolve(arr[0]), arr)

    def entry(label, value, page, arr):
        view = [dst.copy_foreign(v) if getattr(v, "is_indirect", False) else v for v in list(arr)[1:]]
        out = Dictionary(D=Array([page, *view]))
        # A PDF 2.0 /SD (12.3.2.1) addresses a structure element: it follows
        # the element when the element carried; otherwise the entry keeps /D
        # and the lost /SD is reported.
        if isinstance(value, Dictionary) and '/SD' in value:
            sd = value.SD
            new = None
            if struct_map and isinstance(sd, Array) and len(sd) > 0 and isinstance(sd[0], Dictionary):
                new = struct_map.get(sd[0].objgen)
            if new is None:
                dropped.append(label + ' /SD')
            else:
                out.SD = Array([new, *[copy_value(dst, v) for v in list(sd)[1:]]])
        return dst.make_indirect(out)

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
        self.dst = dst
        self.memo: dict = {}
        self.active: set = set()
        self.steps = 0
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
        place in execution order. Every other action type is kept.

        Each indirect action settles once per contribution and every referrer
        shares that result; an action reached again through its own /Next is
        left as it is, so a cyclic or diamond-shaped /Next graph settles in
        one visit per action."""
        if depth > _MAX_DEPTH or not isinstance(action, Dictionary):
            return action
        key = action.objgen if action.is_indirect else None
        if key is not None:
            if key in self.memo:
                return self.memo[key]
            if key in self.active:
                return action
            self.active.add(key)
        self.steps += 1
        if self.steps > _MAX_ACTION_STEPS:
            raise ValueError('The action chains are too large to carry')
        result = self._settle(action, depth)
        if key is not None:
            self.active.discard(key)
            self.memo[key] = result
        return result

    def _settle(self, action, depth):
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
            if rest and isinstance(head, Dictionary):
                # The head may also be reached directly from another chain,
                # which must not gain these successors.
                own = head.get('/Next')
                own = list(own) if isinstance(own, Array) else [own] if own is not None else []
                head = self.dst.make_indirect(Dictionary(head))
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
    added, renamed, dropped, _ = carry_catalog_jumps(dst, src, src_pages, start)
    settle_page_mode(dst)
    return added, renamed, dropped


def settle_page_mode(dst: pikepdf.Pdf) -> None:
    """Remove a /PageMode whose panel the destination cannot fill (Table 29):
    /UseOutlines without an outline item, /UseAttachments without embedded
    files. A later contribution may then define the key."""
    mode = dst.Root.get('/PageMode')
    if mode == Name.UseOutlines:
        outlines = dst.Root.get('/Outlines')
        backed = isinstance(outlines, Dictionary) and '/First' in outlines
    elif mode == Name.UseAttachments:
        names = dst.Root.get('/Names')
        backed = isinstance(names, Dictionary) and isinstance(names.get('/EmbeddedFiles'), Dictionary)
    else:
        backed = True
    if not backed:
        del dst.Root['/PageMode']


def carry_catalog_jumps(dst: pikepdf.Pdf, src: pikepdf.Pdf, src_pages: list, start: int, struct_map=None):
    """carry_catalog without the /PageMode settlement, also returning the
    jump settler for this contribution's copied pages, so later carries
    (outlines) settle their jumps against the same name map."""
    _carry_presentation(dst, src)
    copied = [dst.pages[start + i].obj for i in range(len(src_pages))]
    page_map = {}
    for page, new in zip(src_pages, copied):
        page_map.setdefault(page.obj.objgen, new)
    resolve = _page_resolver(src, page_map)
    carried, added, renamed, dropped = _carry_named(dst, src, resolve, struct_map)
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
    return added, renamed, dropped, jumps


# -- structure tree (ISO 32000-2 14.7, 14.8) ------------------------------
_STRUCT_MAX_DEPTH = 256
_MAX_NODES = 500_000
_MAX_SLOTS = 4_000_000
_RESERVED = {'/Type', '/S', '/P', '/K', '/Pg', '/Ref', '/ID', '/C', '/NS'}


def _is_elem(obj) -> bool:
    if not isinstance(obj, Dictionary):
        return False
    kind = obj.get('/Type')
    if kind is not None and kind != Name.StructElem:
        return False
    return isinstance(obj.get('/S'), Name)


def _reaches_structure(value, budget: list, depth: int = 0) -> bool:
    """Whether a payload value leads into a structure graph; a foreign copy of
    such a value would import the source tree."""
    budget[0] -= 1
    if budget[0] < 0 or depth > 64:
        return True
    if isinstance(value, Stream):
        value = value.stream_dict
    if isinstance(value, Dictionary):
        if value.get('/Type') in (Name.StructElem, Name.StructTreeRoot) or _is_elem(value) and '/P' in value:
            return True
        return any(_reaches_structure(v, budget, depth + 1) for k, v in value.items() if k != '/Parent')
    if isinstance(value, Array):
        return any(_reaches_structure(v, budget, depth + 1) for v in value)
    return False


def copy_value(dst: pikepdf.Pdf, value):
    """Copy a source value into dst. An indirect object goes through the
    foreign copy map, so a copied page resolves to its copy and an uncopied
    page to null; direct containers are rebuilt around that."""
    if getattr(value, 'is_indirect', False):
        return dst.copy_foreign(value)
    if isinstance(value, Array):
        return Array([copy_value(dst, v) for v in value])
    if isinstance(value, Dictionary):
        return Dictionary({k: copy_value(dst, v) for k, v in value.items()})
    if isinstance(value, String):
        return String(bytes(value))
    if isinstance(value, Name):
        return Name(str(value))
    return value


def _sig(value, budget: list, depth: int = 0) -> str:
    """Canonical text of a data value, independent of object numbers."""
    budget[0] -= 1
    if budget[0] < 0 or depth > 64:
        return '?'
    if isinstance(value, Stream):
        return 'stream(%s,%s)' % (_sig(value.stream_dict, budget, depth + 1), bytes(value.read_bytes()).hex())
    if isinstance(value, Dictionary):
        return '{' + ','.join('%s:%s' % (k, _sig(value[k], budget, depth + 1))
                              for k in sorted(value.keys()) if k != '/Length') + '}'
    if isinstance(value, Array):
        return '[' + ','.join(_sig(v, budget, depth + 1) for v in value) + ']'
    if isinstance(value, String):
        return 's' + bytes(value).hex()
    return repr(value)


def _names_map(value) -> dict:
    out = {}
    if isinstance(value, Dictionary):
        for key in value.keys():
            target = value.get(key)
            if isinstance(target, Name):
                out[key] = str(target)
    return out


def _chain(rolemap: dict, name: str) -> tuple:
    seq = [name]
    while seq[-1] in rolemap and len(seq) < 64:
        nxt = rolemap[seq[-1]]
        if nxt in seq:
            seq.append('cycle:' + nxt)
            break
        seq.append(nxt)
    return tuple(seq)


def _kids(value) -> list:
    if value is None:
        return []
    return list(value) if isinstance(value, Array) else [value]


class _Source:
    """One pass over a source tree: element order, static content flags."""

    def __init__(self, root: Dictionary, copies=lambda pg: 0):
        self.root = root
        self.static: dict = {}
        self.reach: dict = {}
        self.names: set = set()
        self.nodes = 0
        self.copies = copies
        for top in _kids(root.get('/K')):
            if _is_elem(top):
                self._scan(top, None, 0, set())

    def _scan(self, elem, pg, depth, active) -> bool:
        """Records whether the subtree has content, and in ``reach`` the most
        copies any page holding that content has in this contribution."""
        self.nodes += 1
        if depth > _STRUCT_MAX_DEPTH or self.nodes > _MAX_NODES:
            raise ValueError('The structure tree is too deep or too large to carry')
        key = elem.objgen
        if key in self.static:
            return self.static[key]
        if key in active:
            return False
        active.add(key)
        if '/NS' not in elem:
            self.names.add(str(elem.S))
        own = elem.get('/Pg')
        if isinstance(own, Dictionary):
            pg = own.objgen
        content = False
        reach = 0
        for kid in _kids(elem.get('/K')):
            if isinstance(kid, int) and not isinstance(kid, bool):
                content = True
                reach = max(reach, self.copies(pg))
            elif isinstance(kid, Dictionary) and kid.get('/Type') in (Name.MCR, Name.OBJR):
                content = True
                kpg = kid.get('/Pg')
                count = self.copies(kpg.objgen if isinstance(kpg, Dictionary) else pg)
                reach = max(reach, min(count, 1) if '/Stm' in kid else count)
            elif _is_elem(kid):
                content = self._scan(kid, pg, depth + 1, active) or content
                reach = max(reach, self.reach.get(kid.objgen, 0))
        active.discard(key)
        self.static[key] = content
        self.reach[key] = reach
        return content


class StructCarry:
    """Tagged-PDF structure carried through page-copy contributions; one
    instance holds the destination state every contribution shares.

    Each contribution's structure tree (ISO 32000-2 14.7) is rebuilt under one
    destination /StructTreeRoot against the copied pages; the tree is never
    foreign-copied as a graph, because every element reaches its parent and the
    root, and one foreign copy would import the whole source tree with its stale
    /ParentTree. An element survives when its subtree still reaches content on a
    copied page (marked-content sequence, marked-content reference or object
    reference, 14.7.5); an element with no content anywhere survives only when
    the contribution copies every source page. Content on a page that is copied
    more than once is tagged per occurrence: each later occurrence gets its own
    projection of the elements that reach it, because a /ParentTree entry maps a
    (page, MCID) pair to exactly one element (14.7.5.4). A marked-content
    reference into a shared form XObject (/Stm) binds once, on the first
    occurrence; the stream carries one /StructParents key.

    The /ParentTree is renumbered from scratch in output order. Every copied page,
    annotation and form XObject loses its source /StructParents or /StructParent
    key first, so an untagged source never leaves dangling keys.

    Role and class names are meaningful only inside their own document (14.7.3,
    14.7.6.2). A name whose resolved role chain differs between the destination
    and a later contribution is renamed on one side: the side that maps it is
    renamed, so an unmapped (standard) name keeps its spelling; when both map it,
    the incoming side is renamed. Elements with an explicit namespace (/NS,
    14.7.4) resolve through that namespace's own /RoleMapNS and are not renamed.

    /MarkInfo /Marked is true only when every contribution declares it (14.7.1,
    14.8.2.1); /Suspects and /UserProperties are true when any contribution
    declares them.
    """

    def __init__(self):
        self.root = None
        self.nums: dict = {}
        self.slots = 0
        self.next_key = 0
        self.meaning: dict = {}
        self.by_type: dict = {}
        self.class_sig: dict = {}
        self.ids: dict = {}
        self.assigned_streams: set = set()
        self.new_elems: set = set()
        self.marked = []
        self.suspects = False
        self.user_properties = False
        self.any_info = False
        self.contribution = 0
        self.detached: dict = {}

    # -- destination root -------------------------------------------------
    def _dst_root(self, dst):
        if self.root is None:
            self.root = dst.make_indirect(Dictionary(Type=Name.StructTreeRoot, K=Array()))
            dst.Root.StructTreeRoot = self.root
        return self.root

    def _fresh(self, base: str, taken) -> str:
        i = self.contribution
        while f'{base}_{i}' in taken:
            i += 1
        return f'{base}_{i}'

    # -- sweeping -----------------------------------------------------------
    def _sweep(self, copied_pages):
        seen = set()
        budget = [_MAX_NODES]

        def forms(resources, depth):
            if depth > 32 or not isinstance(resources, Dictionary):
                return
            xobjects = resources.get('/XObject')
            if not isinstance(xobjects, Dictionary):
                return
            for key in xobjects.keys():
                xobj = xobjects.get(key)
                if not isinstance(xobj, Stream) or xobj.objgen in seen:
                    continue
                budget[0] -= 1
                if budget[0] < 0:
                    return
                seen.add(xobj.objgen)
                if xobj.objgen not in self.assigned_streams:
                    for k in ('/StructParents', '/StructParent'):
                        if k in xobj.stream_dict:
                            del xobj.stream_dict[k]
                if xobj.stream_dict.get('/Subtype') == Name.Form:
                    forms(xobj.stream_dict.get('/Resources'), depth + 1)

        for page in copied_pages:
            if '/StructParents' in page:
                del page['/StructParents']
            annots = page.get('/Annots')
            if isinstance(annots, Array):
                for annot in annots:
                    if isinstance(annot, Dictionary) and '/StructParent' in annot:
                        del annot['/StructParent']
            forms(page.get('/Resources'), 0)

    # -- names --------------------------------------------------------------
    def _rename_dst(self, name: str, fresh: str):
        self.meaning[fresh] = self.meaning.pop(name)
        for elem in self.by_type.pop(name, []):
            elem.S = Name('/' + fresh)
        self.by_type.setdefault(fresh, [])
        rolemap = self.root.get('/RoleMap') if self.root is not None else None
        if isinstance(rolemap, Dictionary):
            entries = _names_map(rolemap)
            rebuilt = Dictionary()
            for key, target in entries.items():
                key = '/' + fresh if key == '/' + name else key
                target = '/' + fresh if target == '/' + name else target
                rebuilt[key] = Name(target)
            self.root.RoleMap = rebuilt

    def _decide_roles(self, src_root, names: set) -> dict:
        src_map = {k[1:]: v[1:] for k, v in _names_map(src_root.get('/RoleMap')).items()}
        pool = set(names) | set(src_map) | set(src_map.values())
        renames = {}
        for name in sorted(pool):
            ours = _chain(src_map, name)
            theirs = self.meaning.get(name)
            if theirs is None or theirs == ours:
                continue
            if len(ours) == 1 and len(theirs) > 1:
                self._rename_dst(name, self._fresh(name, set(self.meaning) | pool))
            else:
                renames[name] = self._fresh(name, set(self.meaning) | pool | set(renames.values()))
        final = lambda n: renames.get(n, n)  # noqa: E731
        for name in pool:
            self.meaning.setdefault(final(name), _chain(src_map, name))
        if src_map:
            rolemap = self.root.get('/RoleMap')
            if not isinstance(rolemap, Dictionary):
                rolemap = Dictionary()
            for key, target in src_map.items():
                rolemap['/' + final(key)] = Name('/' + final(target))
            self.root.RoleMap = rolemap
        return renames

    def _decide_classes(self, dst, src_root) -> dict:
        classmap = src_root.get('/ClassMap')
        renames = {}
        if not isinstance(classmap, Dictionary):
            return renames
        out = self.root.get('/ClassMap')
        if not isinstance(out, Dictionary):
            out = Dictionary()
        for key in sorted(classmap.keys()):
            value = classmap.get(key)
            if _reaches_structure(value, [10000]):
                continue
            sig = _sig(value, [10000])
            name = key[1:]
            if name in self.class_sig and self.class_sig[name] != sig:
                fresh = self._fresh(name, set(self.class_sig) | {k[1:] for k in classmap.keys()})
                renames[name] = fresh
                name = fresh
            if name not in self.class_sig:
                self.class_sig[name] = sig
                out['/' + name] = copy_value(dst, value)
        self.root.ClassMap = out
        return renames

    # -- one contribution ---------------------------------------------------
    def add(self, dst, src, src_pages, start, annot_occurrences) -> dict:
        """Carry the source tree for pages dst.pages[start:]. Returns the
        first-occurrence map {source element objgen: destination element}."""
        self.contribution += 1
        copied = [dst.pages[start + i].obj for i in range(len(src_pages))]
        self._sweep(copied)
        occurrences: dict = {}
        for page, new in zip(src_pages, copied):
            occurrences.setdefault(page.obj.objgen, []).append(new)
        whole = {p.obj.objgen for p in src.pages} <= set(occurrences)

        info = src.Root.get('/MarkInfo')
        if isinstance(info, Dictionary):
            self.any_info = True
            self.suspects |= info.get('/Suspects') is True
            self.user_properties |= info.get('/UserProperties') is True
        self.marked.append(isinstance(info, Dictionary) and info.get('/Marked') is True)

        src_root = src.Root.get('/StructTreeRoot')
        first_map: dict = {}
        if isinstance(src_root, Dictionary):
            first_map = self._carry_tree(dst, src_root, occurrences, whole, annot_occurrences)
        self._write_mark_info(dst)
        return first_map

    def _carry_tree(self, dst, src_root, occurrences, whole, annot_occurrences):
        scan = _Source(src_root, lambda pg: len(occurrences.get(pg, ())))
        root = self._dst_root(dst)
        role_renames = self._decide_roles(src_root, scan.names)
        class_renames = self._decide_classes(dst, src_root)
        self._carry_root_arrays(dst, src_root)
        passes = max((len(v) for v in occurrences.values()), default=1)
        maps = [dict() for _ in range(passes)]
        refs = []
        page_mcids: dict = {}
        stream_mcids: dict = {}
        objrs: list = []

        def occ(pg, o):
            pages = occurrences.get(pg)
            return pages[o] if pages is not None and len(pages) > o else None

        def build(elem, pg, o, depth, active):
            if depth > _STRUCT_MAX_DEPTH or elem.objgen in active or elem.objgen in maps[o]:
                return None
            if o > 0 and scan.reach.get(elem.objgen, 0) <= o:
                return None
            active.add(elem.objgen)
            own_pg = elem.get('/Pg')
            if isinstance(own_pg, Dictionary):
                pg = own_pg.objgen
            kids, elems, records = [], [], []
            for kid in _kids(elem.get('/K')):
                if isinstance(kid, int) and not isinstance(kid, bool):
                    page = occ(pg, o)
                    if page is not None and kid >= 0:
                        kids.append(kid)
                        records.append(('mcid', page, kid))
                elif isinstance(kid, Dictionary) and kid.get('/Type') == Name.MCR:
                    item = self._mcr(dst, kid, pg, o, occ)
                    if item is not None:
                        kids.append(item[0])
                        records.append(item[1])
                elif isinstance(kid, Dictionary) and kid.get('/Type') == Name.OBJR:
                    item = self._objr(dst, kid, pg, o, occ, annot_occurrences)
                    if item is not None:
                        kids.append(item[0])
                        records.append(item[1])
                elif _is_elem(kid):
                    child = build(kid, pg, o, depth + 1, active)
                    if child is not None:
                        kids.append(child)
                        elems.append(child)
            active.discard(elem.objgen)
            if not kids and (scan.static.get(elem.objgen) or o > 0 or not whole):
                return None
            new = dst.make_indirect(Dictionary())
            self._payload(dst, elem, new, pg, o, occ, role_renames, class_renames)
            for child in elems:
                child.P = new
            if kids:
                new.K = kids[0] if len(kids) == 1 else Array(kids)
            for record in records:
                if record[0] == 'mcid':
                    page_mcids.setdefault(record[1].objgen, (record[1], {}))[1][record[2]] = new
                elif record[0] == 'stm':
                    stream_mcids.setdefault(record[1].objgen, (record[1], {}))[1][record[2]] = new
                else:
                    objrs.append((record[1], new))
            if '/Ref' in elem:
                refs.append((new, elem.get('/Ref'), o))
            maps[o][elem.objgen] = new
            self.new_elems.add(new.objgen)
            return new

        top_level = root.K if isinstance(root.get('/K'), Array) else Array(_kids(root.get('/K')))
        for o in range(passes):
            for top in _kids(src_root.get('/K')):
                if _is_elem(top):
                    new = build(top, None, o, 0, set())
                    if new is not None:
                        new.P = root
                        top_level.append(new)
        root.K = top_level

        for new, value, o in refs:
            targets = [maps[o].get(t.objgen) or maps[0].get(t.objgen)
                       for t in _kids(value) if isinstance(t, Dictionary)]
            targets = [t for t in targets if t is not None]
            if targets:
                new.Ref = Array(targets)

        # 14.7.5.4 indexes the per-stream array by MCID with no sparse form,
        # so the array is dense up to the highest MCID in use. The slot
        # budget bounds that fill across the whole output.
        for owner, mcids in list(page_mcids.values()) + list(stream_mcids.values()):
            key = self.next_key
            self.next_key += 1
            top = max(mcids)
            self.slots += top + 1
            if self.slots > _MAX_SLOTS:
                raise ValueError('The structure tree is too deep or too large to carry')
            self.nums[key] = dst.make_indirect(Array([mcids.get(i) for i in range(top + 1)]))
            if isinstance(owner, Stream):
                owner.stream_dict.StructParents = key
                self.assigned_streams.add(owner.objgen)
            else:
                owner.StructParents = key
        for target, new in objrs:
            key = self.next_key
            self.next_key += 1
            self.nums[key] = new
            if isinstance(target, Stream):
                target.stream_dict.StructParent = key
                self.assigned_streams.add(target.objgen)
            else:
                target.StructParent = key
        flat = Array()
        for key in sorted(self.nums):
            flat.append(key)
            flat.append(self.nums[key])
        root.ParentTree = dst.make_indirect(Dictionary(Nums=flat))
        root.ParentTreeNextKey = self.next_key
        self._write_ids(dst)
        return maps[0]

    def _mcr(self, dst, kid, pg, o, occ):
        own = kid.get('/Pg')
        kpg = own.objgen if isinstance(own, Dictionary) else pg
        mcid = kid.get('/MCID')
        if not isinstance(mcid, int) or isinstance(mcid, bool) or mcid < 0:
            return None
        stm = kid.get('/Stm')
        if stm is not None:
            page = occ(kpg, 0)
            if o != 0 or page is None or not isinstance(stm, Stream):
                return None
            copied = dst.copy_foreign(stm)
            mcr = Dictionary(Type=Name.MCR, MCID=mcid, Stm=copied)
            if '/StmOwn' in kid:
                mcr.StmOwn = copy_value(dst, kid.StmOwn)
            if isinstance(own, Dictionary):
                mcr.Pg = page
            return mcr, ('stm', copied, mcid)
        page = occ(kpg, o)
        if page is None:
            return None
        mcr = Dictionary(Type=Name.MCR, MCID=mcid)
        if isinstance(own, Dictionary):
            mcr.Pg = page
        return mcr, ('mcid', page, mcid)

    def _objr(self, dst, kid, pg, o, occ, annot_occurrences):
        own = kid.get('/Pg')
        kpg = own.objgen if isinstance(own, Dictionary) else pg
        obj = kid.get('/Obj')
        if not isinstance(obj, (Dictionary, Stream)) or not obj.is_indirect:
            return None
        target = None
        copies = annot_occurrences.get(obj.objgen)
        if copies is not None:
            target = copies[o] if len(copies) > o else None
        elif isinstance(obj, Stream) and o == 0 and occ(kpg, 0) is not None:
            target = dst.copy_foreign(obj)
        if target is None:
            return None
        objr = Dictionary(Type=Name.OBJR, Obj=target)
        page = occ(kpg, o)
        if isinstance(own, Dictionary) and page is not None:
            objr.Pg = page
        return objr, ('objr', target)

    def _payload(self, dst, elem, new, pg, o, occ, role_renames, class_renames):
        if '/Type' in elem:
            new.Type = Name.StructElem
        s = str(elem.S)[1:]
        if '/NS' in elem:
            new.S = elem.S
            ns = elem.get('/NS')
            if isinstance(ns, Dictionary) and ns.is_indirect:
                new.NS = dst.copy_foreign(ns)
        else:
            s = role_renames.get(s, s)
            new.S = Name('/' + s)
            self.by_type.setdefault(s, []).append(new)
        own = elem.get('/Pg')
        if isinstance(own, Dictionary):
            page = occ(own.objgen, o)
            if page is not None:
                new.Pg = page
        ident = elem.get('/ID')
        if isinstance(ident, String):
            key = _unique(self.ids.keys(), bytes(ident), _suffixed)
            self.ids[key] = new
            new.ID = String(key)
        classes = elem.get('/C')
        if classes is not None:
            new.C = self._classes(classes, class_renames)
        for key in elem.keys():
            if key in _RESERVED:
                continue
            value = elem.get(key)
            if _reaches_structure(value, [10000]):
                continue
            new[key] = copy_value(dst, value)

    @staticmethod
    def _classes(value, renames):
        def one(item):
            if isinstance(item, Name):
                return Name('/' + renames.get(str(item)[1:], str(item)[1:]))
            return item
        if isinstance(value, Array):
            return Array([one(v) for v in value])
        return one(value)

    def _carry_root_arrays(self, dst, src_root):
        for key in ('/Namespaces', '/PronunciationLexicon', '/AF'):
            values = src_root.get(key)
            if values is None:
                continue
            out = self.root.get(key)
            out = list(out) if isinstance(out, Array) else []
            have = {v.objgen for v in out if getattr(v, 'is_indirect', False)}
            for value in _kids(values):
                if getattr(value, 'is_indirect', False) and not _reaches_structure(value, [10000]):
                    copied = dst.copy_foreign(value)
                    if copied.objgen not in have:
                        have.add(copied.objgen)
                        out.append(copied)
            if out:
                self.root[key] = Array(out)

    def _write_ids(self, dst):
        if not self.ids:
            return
        flat = Array()
        for key in sorted(self.ids):
            flat.append(String(key))
            flat.append(self.ids[key])
        self.root.IDTree = dst.make_indirect(Dictionary(Names=flat))

    def _write_mark_info(self, dst):
        if not self.any_info and self.root is None:
            return
        info = Dictionary(Marked=all(self.marked))
        if self.suspects:
            info.Suspects = True
        if self.user_properties:
            info.UserProperties = True
        dst.Root.MarkInfo = info

    # -- structure destinations (12.3.2.1 /SD) ------------------------------
    def settle_sd(self, dst, value):
        """The /SD array re-pointed at a carried element, or None when its
        element did not carry. A foreign-copied action reaches a detached
        copy of the source element; that copy is resolved back through the
        foreign copy map."""
        if not isinstance(value, Array) or len(value) == 0 or not isinstance(value[0], Dictionary):
            return None
        first = value[0]
        if first.objgen in self.new_elems:
            return value
        mapped = self.detached.get(first.objgen)
        return None if mapped is None else Array([mapped, *list(value)[1:]])

    def register_sources(self, dst, src, first_map):
        """Record where the foreign copy map sends each source element that
        an action names, so a detached copy made by an annotation or action
        copy resolves to the carried element."""
        for objgen in _sd_targets(src) if first_map else ():
            new = first_map.get(objgen)
            if new is not None:
                self.detached[dst.copy_foreign(src.get_object(objgen)).objgen] = new


def _sd_targets(src) -> set:
    """Structure elements that /SD entries of the source's actions name."""
    out = set()
    seen = set()

    def action(value, depth):
        if depth > 64 or not isinstance(value, Dictionary):
            return
        if value.is_indirect:
            if value.objgen in seen:
                return
            seen.add(value.objgen)
        sd = value.get('/SD')
        if isinstance(sd, Array) and len(sd) > 0 and isinstance(sd[0], Dictionary) and sd[0].is_indirect:
            out.add(sd[0].objgen)
        for nxt in _kids(value.get('/Next')):
            action(nxt, depth + 1)

    for page in src.pages:
        annots = page.obj.get('/Annots')
        if not isinstance(annots, Array):
            continue
        for annot in annots:
            if not isinstance(annot, Dictionary):
                continue
            action(annot.get('/A'), 0)
            aa = annot.get('/AA')
            if isinstance(aa, Dictionary):
                for key in aa.keys():
                    action(aa.get(key), 0)
    budget = [100000]
    outline = src.Root.get('/Outlines')

    def items(node, depth):
        if depth > 128 or not isinstance(node, Dictionary):
            return
        cursor = node.get('/First')
        while isinstance(cursor, Dictionary) and budget[0] > 0:
            budget[0] -= 1
            if cursor.objgen in seen:
                return
            seen.add(cursor.objgen)
            action(cursor.get('/A'), 0)
            items(cursor, depth + 1)
            cursor = cursor.get('/Next')

    items(outline, 0)
    return out


def settle_actions_sd(carry: StructCarry, dst, action, depth: int = 0, seen=None):
    """Re-point or remove /SD in an action chain already in dst."""
    if seen is None:
        seen = set()
    if depth > 64 or not isinstance(action, Dictionary):
        return
    if action.is_indirect:
        if action.objgen in seen:
            return
        seen.add(action.objgen)
    if '/SD' in action:
        settled = carry.settle_sd(dst, action.SD)
        if settled is None:
            del action['/SD']
        else:
            action.SD = settled
    for nxt in _kids(action.get('/Next')):
        settle_actions_sd(carry, dst, nxt, depth + 1, seen)


# -- document-level entries ----------------------------------------------
_OUTLINE_MAX_DEPTH = 128
_MAX_ITEMS = 100_000
_CLAIM_NS = ('http://www.aiim.org/pdfa/ns/id/', 'http://www.aiim.org/pdfua/ns/id/')


class DocCarry:
    """Document-level catalog entries carried by page-copy contributions; one
    instance holds the destination state every contribution shares.

    Outlines (ISO 32000-2 12.3.3): each contribution's top-level items are
    appended after the destination's, in source order, with their subtrees. An
    item's jump is re-pointed to the copied page; an item whose jump targets an
    uncopied page keeps its title, children and styling and loses only that jump
    (the /Dest, or the dangling GoTo actions of its /A chain). /SE is re-pointed
    to the carried structure element or removed. /Count is recomputed from the
    carried children (Table 152).

    Page labels (12.4.2): every output page resolves to the label its source page
    had; a page from an unlabelled source takes a decimal label equal to its
    output position, which is what a processor shows for a document without
    labels. The number tree is rewritten over the output order after each
    contribution.

    Embedded files (7.11.4, 7.9.6): every contribution's /EmbeddedFiles entries
    are merged into one name tree; a name already present is suffixed as
    ``name.1``, ``name.2``, ... . Document-level associated files (/AF, 14.13)
    are the union of the contributions' arrays. /Collection (12.3.5) is
    first-definer, with its initial document (/D) re-pointed through the rename.

    Articles (12.4.3): see ``_carry_threads``.

    Document behaviour (/Names /JavaScript, /AA, /OpenAction): see
    ``_carry_behavior``.

    /Lang (14.9.2) and /ViewerPreferences (12.2) are first-definer, except
    /PrintPageRange, which is rebuilt over the whole output (see
    ``_carry_print_range``).

    Document metadata (14.3.2) and the document information dictionary (14.3.3)
    come from one source, the first that has either, so the two stay consistent.
    A PDF/A or PDF/UA identification in that packet is removed when any
    contribution does not declare the same identification: the combined document
    cannot claim a conformance one of its parts never had.
    """

    def __init__(self):
        self.labels: list = []
        self.any_labels = False
        self.info_donor = False
        self.claims: list = []
        self.contribution = 0
        self.printable: list = []
        self.any_range = False

    def add(self, dst, src, src_pages, start, jumps, struct, first_map):
        self.contribution += 1
        _carry_outlines(dst, src, jumps, struct, first_map)
        self._carry_labels(dst, src, src_pages, start)
        _carry_embedded(dst, src)
        _carry_threads(dst, src, src_pages, start)
        _carry_behavior(dst, src, jumps, struct)
        _carry_lang(dst, src)
        _carry_viewer_preferences(dst, src)
        self._carry_print_range(dst, src, src_pages, start)
        self._carry_metadata(dst, src)

    def _carry_print_range(self, dst, src, src_pages, start):
        """/PrintPageRange (Table 147, one-based pairs) over the whole output.
        A source with a range contributes the copied pages it selects; a
        source without one contributes all its copied pages, its default. The
        entry exists once any source defines a range; when it selects no
        output page it is an empty array, zero sub-ranges."""
        selection = _print_selection(src, src_pages)
        self.any_range |= selection is not None
        del self.printable[start:]
        self.printable.extend([True] * (start - len(self.printable)))
        self.printable.extend(selection if selection is not None else [True] * len(src_pages))
        if not self.any_range:
            return
        rebuilt = []
        for position, printable in enumerate(self.printable, 1):
            if not printable:
                continue
            if rebuilt and position == rebuilt[-1] + 1:
                rebuilt[-1] = position
            else:
                rebuilt.extend([position, position])
        prefs = dst.Root.get('/ViewerPreferences')
        if not isinstance(prefs, Dictionary):
            dst.Root.ViewerPreferences = Dictionary()
            prefs = dst.Root.ViewerPreferences
        prefs.PrintPageRange = Array(rebuilt)

    # -- page labels ----------------------------------------------------------
    def _carry_labels(self, dst, src, src_pages, start):
        specs = _expand_labels(src)
        if specs is not None:
            self.any_labels = True
        while len(self.labels) < start:
            self.labels.append(None)
        del self.labels[start:]
        index = {p.obj.objgen: i for i, p in enumerate(src.pages)}
        for page in src_pages:
            i = index.get(page.obj.objgen)
            spec = specs[i] if specs is not None and i is not None else None
            self.labels.append(None if spec is None else (self.contribution, i, spec))
        if not self.any_labels:
            return
        nums = Array()
        prev = None
        for pos, entry in enumerate(self.labels):
            if entry is None:
                if prev is not None or pos == 0:
                    nums.append(pos)
                    nums.append(Dictionary(S=Name.D, St=pos + 1))
                prev = None
                continue
            contribution, i, (style, prefix, value) = entry
            continues = (prev is not None and prev[0] == contribution and prev[1] + 1 == i
                         and prev[2][0] == style and prev[2][1] == prefix and prev[2][2] + 1 == value)
            if not continues:
                label = Dictionary(St=value)
                if style is not None:
                    label.S = Name(style)
                if prefix is not None:
                    label.P = String(prefix)
                nums.append(pos)
                nums.append(label)
            prev = entry
        dst.Root.PageLabels = dst.make_indirect(Dictionary(Nums=nums))

    # -- metadata -------------------------------------------------------------
    def _carry_metadata(self, dst, src):
        claim = _claims(src)
        self.claims.append(claim)
        if not self.info_donor:
            meta = src.Root.get('/Metadata')
            info = src.trailer.get('/Info')
            has_info = isinstance(info, Dictionary) and len(info.keys()) > 0
            if isinstance(meta, pikepdf.Stream) or has_info:
                self.info_donor = True
                if isinstance(meta, pikepdf.Stream):
                    dst.Root.Metadata = dst.copy_foreign(meta)
                if has_info:
                    carried = copy_value(dst, info)
                    dst.trailer.Info = dst.make_indirect(Dictionary(carried) if not carried.is_indirect else carried)
        if len(set(self.claims)) > 1:
            _strip_claims(dst)


# -- outlines -----------------------------------------------------------------
def _carry_outlines(dst, src, jumps, struct, first_map):
    root = src.Root.get('/Outlines')
    if not isinstance(root, Dictionary) or not isinstance(root.get('/First'), Dictionary):
        return
    seen: set = set()
    budget = [_MAX_ITEMS]

    def parse(parent, depth):
        items = []
        cursor = parent.get('/First')
        while isinstance(cursor, Dictionary) and depth <= _OUTLINE_MAX_DEPTH and budget[0] > 0:
            budget[0] -= 1
            if cursor.objgen in seen:
                break
            seen.add(cursor.objgen)
            count = cursor.get('/Count')
            items.append((cursor, parse(cursor, depth + 1), not (isinstance(count, int) and count < 0)))
            cursor = cursor.get('/Next')
        return items

    tree = parse(root, 0)
    if not tree:
        return
    out_root = dst.Root.get('/Outlines')
    if not isinstance(out_root, Dictionary):
        out_root = dst.make_indirect(Dictionary(Type=Name.Outlines))
        dst.Root.Outlines = out_root
    settled: dict = {}

    def build(item, children, parent):
        new = dst.make_indirect(Dictionary())
        for key in item.keys():
            if key in ('/Parent', '/Prev', '/Next', '/First', '/Last', '/Count', '/Dest', '/A', '/SE'):
                continue
            new[key] = copy_value(dst, item.get(key))
        if '/Title' not in new:
            new.Title = String('')
        action = item.get('/A')
        if isinstance(action, Dictionary):
            copied = copy_value(dst, action)
            # Settling rewrites a shared chain in place and may replace its
            # head, so a second item naming the same action takes the first
            # settlement's result, including None.
            shared = copied.objgen if copied.is_indirect else None
            if shared is not None and shared in settled:
                copied = settled[shared]
            else:
                settle_actions_sd(struct, dst, copied)
                copied = jumps.settle(copied)
                if shared is not None:
                    settled[shared] = copied
            if copied is not None:
                new.A = copied
        elif '/Dest' in item:
            dest = copy_value(dst, item.get('/Dest'))
            keep, replacement = jumps.fix(dest)
            if keep:
                new.Dest = dest if replacement is None else replacement
        se = item.get('/SE')
        if isinstance(se, Dictionary) and se.objgen in first_map:
            new.SE = first_map[se.objgen]
        new.Parent = parent
        return new

    def wire(parent, nodes):
        """Append nodes under parent; returns the visible-descendant count."""
        built = []
        for item, children, is_open in nodes:
            new = build(item, children, parent)
            visible = wire(new, children)
            if children:
                new.Count = visible if is_open else -visible
            built.append((new, is_open, visible))
        last = parent.get('/Last') if built else None
        for new, _, _ in built:
            if isinstance(last, Dictionary):
                last.Next = new
                new.Prev = last
            else:
                parent.First = new
            last = new
        if built:
            parent.Last = last
        return sum(1 + (visible if is_open else 0) for _, is_open, visible in built)

    added = wire(out_root, tree)
    prior = out_root.get('/Count')
    out_root.Count = (prior if isinstance(prior, int) and prior > 0 else 0) + added


# -- page labels --------------------------------------------------------------
def _expand_labels(src):
    """(style, prefix bytes, value) per source page, or None without labels."""
    root = src.Root.get('/PageLabels')
    if not isinstance(root, Dictionary):
        return None
    entries = []
    seen: set = set()

    def walk(node, depth):
        if depth > 64 or not isinstance(node, Dictionary):
            return
        if node.is_indirect:
            if node.objgen in seen:
                return
            seen.add(node.objgen)
        nums = node.get('/Nums')
        if isinstance(nums, Array):
            for i in range(0, len(nums) - 1, 2):
                key, label = nums[i], nums[i + 1]
                if isinstance(key, int) and not isinstance(key, bool) and key >= 0 and isinstance(label, Dictionary):
                    style = label.get('/S')
                    prefix = label.get('/P')
                    st = label.get('/St')
                    entries.append((key,
                                    str(style) if isinstance(style, Name) else None,
                                    bytes(prefix) if isinstance(prefix, String) else None,
                                    st if isinstance(st, int) and not isinstance(st, bool) and st >= 1 else 1))
        kids = node.get('/Kids')
        if isinstance(kids, Array):
            for kid in kids:
                walk(kid, depth + 1)

    walk(root, 0)
    if not entries:
        return None
    entries.sort(key=lambda e: e[0])
    specs = []
    j = -1
    for p in range(len(src.pages)):
        while j + 1 < len(entries) and entries[j + 1][0] <= p:
            j += 1
        if j < 0:
            specs.append(None)
        else:
            start, style, prefix, st = entries[j]
            specs.append((style, prefix, st + p - start))
    return specs


# -- embedded files -----------------------------------------------------------
def _carry_embedded(dst, src):
    names = src.Root.get('/Names')
    tree = names.get('/EmbeddedFiles') if isinstance(names, Dictionary) else None
    renamed = {}
    if isinstance(tree, Dictionary):
        entries: list = []
        _tree_entries(tree, entries, set())
        if entries:
            out_names = dst.Root.get('/Names')
            if not isinstance(out_names, Dictionary):
                out_names = dst.make_indirect(Dictionary())
                dst.Root.Names = out_names
            existing: list = []
            _tree_entries(out_names.get('/EmbeddedFiles'), existing, set())
            merged = dict(existing)
            for key, value in entries:
                final = _unique(merged.keys(), key, _suffixed)
                merged[final] = copy_value(dst, value)
                renamed[key] = final
            flat = Array()
            for key in sorted(merged):
                flat.append(String(key))
                flat.append(merged[key])
            out_names.EmbeddedFiles = dst.make_indirect(Dictionary(Names=flat))
    af = src.Root.get('/AF')
    if isinstance(af, Array):
        out = list(dst.Root.AF) if isinstance(dst.Root.get('/AF'), Array) else []
        have = {v.objgen for v in out if getattr(v, 'is_indirect', False)}
        for spec in af:
            copied = copy_value(dst, spec)
            if not (getattr(copied, 'is_indirect', False) and copied.objgen in have):
                out.append(copied)
        if out:
            dst.Root.AF = Array(out)
    collection = src.Root.get('/Collection')
    if isinstance(collection, Dictionary) and '/Collection' not in dst.Root:
        copied = copy_value(dst, collection)
        initial = collection.get('/D')
        if isinstance(initial, String):
            final = renamed.get(bytes(initial))
            if final is None:
                del copied['/D']
            else:
                copied.D = String(final)
        dst.Root.Collection = copied if copied.is_indirect else dst.make_indirect(copied)


# -- articles -------------------------------------------------------------------
_MAX_BEADS = 100_000


def _carry_threads(dst, src, src_pages, start):
    """Articles (ISO 32000-2 12.4.3, Tables 159-160). Each source /Threads
    entry whose closed /N ring has a bead on a copied page becomes a new
    destination thread listed after the existing ones: the copied beads, in
    ring order, form a new closed /N-/V ring, the first carries /T, and each
    /P is the bead's copied page. Beads on uncopied pages leave the ring. A
    thread with no copied bead, or whose ring does not close, is not listed.
    A page copied more than once contributes its beads at its first copy."""
    threads = src.Root.get('/Threads')
    if not isinstance(threads, Array):
        return
    beads = {}
    first = set()
    for offset, page in enumerate(src_pages):
        if page.obj.objgen in first:
            continue
        first.add(page.obj.objgen)
        copy = dst.pages[start + offset].obj
        src_b, dst_b = page.obj.get('/B'), copy.get('/B')
        if not isinstance(src_b, Array) or not isinstance(dst_b, Array) or len(src_b) != len(dst_b):
            continue
        for old, new in zip(src_b, dst_b):
            if isinstance(old, Dictionary) and old.is_indirect and isinstance(new, Dictionary) and new.is_indirect:
                beads.setdefault(old.objgen, (new, copy))
    out = list(dst.Root.Threads) if isinstance(dst.Root.get('/Threads'), Array) else []
    for thread in threads:
        if not isinstance(thread, Dictionary):
            continue
        ring, seen, cursor, closed = [], set(), thread.get('/F'), False
        while isinstance(cursor, Dictionary) and cursor.is_indirect and cursor.objgen not in seen:
            if len(seen) >= _MAX_BEADS:
                break
            seen.add(cursor.objgen)
            ring.append(cursor)
            cursor = cursor.get('/N')
            closed = isinstance(cursor, Dictionary) and cursor.objgen == ring[0].objgen
        kept = [beads[b.objgen] for b in ring if b.objgen in beads]
        if not closed or not kept:
            continue
        new = dst.make_indirect(Dictionary({k: copy_value(dst, v) for k, v in thread.items() if k != '/F'}))
        new.Type = Name.Thread
        new.F = kept[0][0]
        for i, (bead, page) in enumerate(kept):
            bead.N = kept[(i + 1) % len(kept)][0]
            bead.V = kept[i - 1][0]
            bead.P = page
            if i == 0 or '/T' in bead:
                bead.T = new
        out.append(new)
    if out:
        dst.Root.Threads = Array(out)


# -- document behaviour ---------------------------------------------------------
def _copy_action(dst, value, fresh: dict, depth: int = 0):
    """Copy a source value, giving every indirect action a new object per
    contribution. The foreign copy map returns one object per source object
    for the life of dst, so an action a previous contribution of the same
    open already settled would come back with that contribution's pruning."""
    if depth > _MAX_DEPTH:
        return copy_value(dst, value)
    if isinstance(value, Dictionary) and value.is_indirect and '/S' in value:
        if value.objgen in fresh:
            return fresh[value.objgen]
        new = dst.make_indirect(Dictionary())
        fresh[value.objgen] = new
        for key, item in value.items():
            new[key] = _copy_action(dst, item, fresh, depth + 1)
        return new
    if isinstance(value, Dictionary) and not value.is_indirect:
        return Dictionary({k: _copy_action(dst, v, fresh, depth + 1) for k, v in value.items()})
    if isinstance(value, Array) and not value.is_indirect:
        return Array([_copy_action(dst, v, fresh, depth + 1) for v in value])
    return copy_value(dst, value)


def _chain_members(action) -> set:
    """objgen of every indirect action reachable through /Next."""
    out: set = set()
    stack = [action]
    while stack and len(out) < _MAX_ACTION_STEPS:
        item = stack.pop()
        if not isinstance(item, Dictionary):
            continue
        if item.is_indirect:
            if item.objgen in out:
                continue
            out.add(item.objgen)
        stack.extend(_kids(item.get('/Next')))
    return out


def _carry_behavior(dst, src, jumps, struct):
    """Document JavaScript (7.9.6 /Names /JavaScript), document events (/AA,
    12.6.3 Table 200) and the opening action (/OpenAction, 7.7.2 Table 29).

    Every action chain loses only its GoTo actions whose destination targets
    an uncopied page (``_Jumps.settle``); a script entry, trigger or opening
    action is omitted only when nothing in its chain survives. A named or
    explicit /OpenAction destination is re-pointed to the copied page, or
    omitted when its page was not copied.

    Across contributions: script names merge into one name tree, a name
    already present suffixed as ``name.1``, ``name.2``, ... so every script
    still runs at open. A document event already defined runs the earlier
    contribution's chain first, then this contribution's, through /Next
    (12.6.2). /OpenAction is first-definer: one document opens once.
    """
    memo: dict = {}
    fresh: dict = {}

    def settle(value):
        copied = _copy_action(dst, value, fresh)
        shared = copied.objgen if getattr(copied, 'is_indirect', False) else None
        if shared is not None and shared in memo:
            return memo[shared]
        settle_actions_sd(struct, dst, copied)
        result = jumps.settle(copied)
        if shared is not None:
            memo[shared] = result
        return result

    names = src.Root.get('/Names')
    tree = names.get('/JavaScript') if isinstance(names, Dictionary) else None
    if isinstance(tree, Dictionary):
        entries: list = []
        _tree_entries(tree, entries, set())
        kept = [(key, action) for key, action in ((k, settle(v)) for k, v in entries) if action is not None]
        if kept:
            out_names = dst.Root.get('/Names')
            if not isinstance(out_names, Dictionary):
                out_names = dst.make_indirect(Dictionary())
                dst.Root.Names = out_names
            existing: list = []
            _tree_entries(out_names.get('/JavaScript'), existing, set())
            merged = dict(existing)
            for key, action in kept:
                merged[_unique(merged.keys(), key, _suffixed)] = action
            flat = Array()
            for key in sorted(merged):
                flat.append(String(key))
                flat.append(merged[key])
            out_names.JavaScript = dst.make_indirect(Dictionary(Names=flat))

    aa = src.Root.get('/AA')
    if isinstance(aa, Dictionary):
        out = dst.Root.get('/AA')
        out = Dictionary(out) if isinstance(out, Dictionary) else Dictionary()
        for trigger in list(aa.keys()):
            action = settle(aa.get(trigger))
            if not isinstance(action, Dictionary):
                continue
            prior = out.get(trigger)
            if action.is_indirect and action.objgen in _chain_members(prior):
                continue
            if isinstance(prior, Dictionary):
                head = Dictionary(prior)
                own = prior.get('/Next')
                own = list(own) if isinstance(own, Array) else [own] if own is not None else []
                head.Next = Array(own + [action])
                out[trigger] = head
            else:
                out[trigger] = action
        if len(out.keys()) > 0:
            dst.Root.AA = out

    opening = src.Root.get('/OpenAction')
    if opening is None or '/OpenAction' in dst.Root:
        return
    if isinstance(opening, Dictionary):
        action = settle(opening)
        if action is not None:
            dst.Root.OpenAction = action
        return
    dest = copy_value(dst, opening)
    keep, replacement = jumps.fix(dest)
    if keep and isinstance(dest, (Array, String, Name)):
        dst.Root.OpenAction = dest if replacement is None else replacement


# -- language and viewer preferences -----------------------------------------
def _carry_lang(dst, src):
    lang = src.Root.get('/Lang')
    if '/Lang' not in dst.Root and isinstance(lang, String):
        dst.Root.Lang = String(bytes(lang))


def _carry_viewer_preferences(dst, src):
    prefs = src.Root.get('/ViewerPreferences')
    if '/ViewerPreferences' in dst.Root or not isinstance(prefs, Dictionary):
        return
    dst.Root.ViewerPreferences = Dictionary(
        {k: copy_value(dst, v) for k, v in prefs.items() if k != '/PrintPageRange'})


def _print_selection(src, src_pages):
    """Per copied page, whether the source's /PrintPageRange selects it, or
    None when the source defines no usable range."""
    prefs = src.Root.get('/ViewerPreferences')
    ranges = prefs.get('/PrintPageRange') if isinstance(prefs, Dictionary) else None
    if not isinstance(ranges, Array) or len(ranges) % 2 != 0:
        return None
    values = list(ranges)
    limits = []
    for i in range(0, len(values), 2):
        a, b = values[i], values[i + 1]
        if not (isinstance(a, int) and isinstance(b, int) and 1 <= a <= b):
            return None
        limits.append((a, b))
    index = {p.obj.objgen: i + 1 for i, p in enumerate(src.pages)}
    return [any(a <= index[page.obj.objgen] <= b for a, b in limits) for page in src_pages]


# -- metadata claims ----------------------------------------------------------
def _claims(src) -> tuple:
    """The PDF/A and PDF/UA identification properties in the source packet,
    as a sorted tuple; ('unreadable',) for a packet that does not parse."""
    meta = src.Root.get('/Metadata')
    if not isinstance(meta, pikepdf.Stream):
        return ()
    try:
        root = _parse(bytes(meta.read_bytes()))
    except Exception:
        return ('unreadable',)
    found = []
    for node in root.iter():
        for ns in _CLAIM_NS:
            for attr, value in node.attrib.items():
                if attr.startswith('{' + ns + '}'):
                    found.append((attr, value.strip()))
            if isinstance(node.tag, str) and node.tag.startswith('{' + ns + '}'):
                found.append((node.tag, (node.text or '').strip()))
    return tuple(sorted(found))


def _parse(data: bytes):
    parser = etree.XMLParser(resolve_entities=False, load_dtd=False, no_network=True, huge_tree=False)
    return etree.fromstring(data, parser)


def _strip_claims(dst):
    meta = dst.Root.get('/Metadata')
    if not isinstance(meta, pikepdf.Stream):
        return
    try:
        root = _parse(bytes(meta.read_bytes()))
    except Exception:
        del dst.Root['/Metadata']
        return
    changed = False
    for node in list(root.iter()):
        if not isinstance(node.tag, str):
            continue
        for attr in list(node.attrib):
            if any(attr.startswith('{' + ns + '}') for ns in _CLAIM_NS):
                del node.attrib[attr]
                changed = True
        if any(node.tag.startswith('{' + ns + '}') for ns in _CLAIM_NS) and node.getparent() is not None:
            node.getparent().remove(node)
            changed = True
    if not changed:
        return
    etree.cleanup_namespaces(root)
    stream = dst.make_stream(etree.tostring(root.getroottree(), encoding='utf-8', xml_declaration=True))
    for key, value in meta.stream_dict.items():
        if key not in ('/Length', '/Filter', '/DecodeParms', '/DP', '/DL'):
            stream[key] = value
    stream.Type = Name.Metadata
    stream.Subtype = Name.XML
    dst.Root.Metadata = stream
