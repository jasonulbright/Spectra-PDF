"""Effective output-intent authority for engine page copies (ISO 32000-2, 14.11.5).

A page's effective output intent is its own ``/OutputIntents`` where it has one
and the document's catalog array otherwise. A page copied into a fresh catalog
keeps only the first of those, so the document-default case has to be carried
here. Profiles are carried as the source's own objects: no profile URI is
resolved and no colour transformation is performed.

Composition is recomputed from every accumulated contribution on each call, so
a later contribution can change an earlier one's placement without leaving a
condition behind.
"""
from dataclasses import dataclass, field

import pikepdf
from pikepdf import Array, Dictionary, Name, Stream, String

MAX_WORK = 200_000
MAX_DEPTH = 64
# ISO 32000-2 Table 31: a page-level entry is a PDF 2.0 feature.
PAGE_LEVEL_VERSION = (2, 0)
_STRING_KEYS = ('/OutputConditionIdentifier', '/OutputCondition', '/RegistryName', '/Info')


def _refuse():
    raise ValueError('The output intent configuration cannot be preserved completely.')


@dataclass
class Budget:
    work: int = MAX_WORK

    def spend(self, count=1, depth=0):
        self.work -= count
        if self.work < 0 or depth > MAX_DEPTH:
            _refuse()


def _identity(obj, budget, seen=None, depth=0):
    """A canonical byte identity for a bounded object graph.

    Indirect objects are keyed by visit order rather than by object number, so
    two equal graphs in different documents produce the same identity while a
    shared or cyclic edge stays distinguishable from a duplicated one.
    """
    budget.spend(depth=depth)
    if seen is None:
        seen = {}
    if isinstance(obj, pikepdf.Object) and obj.is_indirect:
        key = obj.objgen
        if key in seen:
            return b'R%d;' % seen[key]
        seen[key] = len(seen)
    if obj is None:
        return b'null;'
    if isinstance(obj, Stream):
        raw = obj.read_raw_bytes()
        budget.spend(1 + len(raw) // 4096)
        return b'stream(' + _identity(obj.stream_dict, budget, seen, depth + 1) + b',' + raw + b');'
    if isinstance(obj, Dictionary):
        parts = [b'dict(']
        for key in sorted(str(k) for k in obj.keys()):
            budget.spend()
            parts.append(key.encode() + b'=' + _identity(obj[key], budget, seen, depth + 1))
        return b''.join(parts) + b');'
    if isinstance(obj, Array):
        budget.spend(len(obj))
        return b'array(' + b''.join(_identity(item, budget, seen, depth + 1) for item in obj) + b');'
    if isinstance(obj, String):
        return b'string(' + bytes(obj) + b');'
    if isinstance(obj, Name):
        return b'name(' + str(obj).encode() + b');'
    return b'other(' + repr(obj).encode() + b');'


def _validate(intents, budget):
    """Refuse a malformed array rather than carry an unreadable condition."""
    if not isinstance(intents, Array) or isinstance(intents, Stream):
        _refuse()
    if len(intents) == 0:
        _refuse()
    for intent in intents:
        budget.spend()
        if not isinstance(intent, Dictionary) or isinstance(intent, Stream):
            _refuse()
        kind = intent.get('/Type')
        if kind is not None and kind != Name.OutputIntent:
            _refuse()
        if not isinstance(intent.get('/S'), Name):
            _refuse()
        for key in _STRING_KEYS:
            value = intent.get(key)
            if value is not None and not isinstance(value, String):
                _refuse()
        profile = intent.get('/DestOutputProfile')
        if profile is not None and not isinstance(profile, Stream):
            _refuse()
        reference = intent.get('/DestOutputProfileRef')
        if reference is not None and (not isinstance(reference, Dictionary) or isinstance(reference, Stream)):
            _refuse()


@dataclass
class Source:
    """One page-copy contribution's effective output-condition requirement."""
    pdf: object
    default: object
    identity: bytes
    start: int
    relying: list


def read_output_intents(src, pages, start, budget):
    """Read the source's document default and which selected pages rely on it.

    Runs before the copier mutates the source's private field tree, for the
    same reason the optional-content read does.
    """
    default = src.Root.get('/OutputIntents')
    identity = b''
    if default is not None:
        _validate(default, budget)
        identity = _identity(default, budget)
    relying = []
    for offset, page in enumerate(pages):
        budget.spend()
        own = page.get('/OutputIntents')
        if own is None:
            relying.append(start + offset)
        else:
            _validate(own, budget)
    return Source(pdf=src, default=default, identity=identity, start=start, relying=relying)


@dataclass
class OutputIntentCarry:
    budget: Budget = field(default_factory=Budget)
    sources: list = field(default_factory=list)
    materialized: set = field(default_factory=set)
    page_level_required: bool = False

    def add(self, dst, source):
        """Recompose the destination's effective conditions.

        A single agreed requirement is the catalog default. Where the
        contributions disagree — including one that requires no condition at
        all, which no catalog default can express — every requirement is
        placed on the pages that hold it, so no page acquires another source's
        condition.
        """
        self.sources.append(source)
        contributors = [item for item in self.sources if item.relying]
        identities = {item.identity for item in contributors}
        agreed = contributors and len(identities) == 1 and contributors[0].default is not None
        for index in sorted(self.materialized):
            page = dst.pages[index]
            if '/OutputIntents' in page.obj:
                del page.obj['/OutputIntents']
        self.materialized.clear()
        self.page_level_required = False
        if '/OutputIntents' in dst.Root:
            del dst.Root['/OutputIntents']
        if agreed:
            dst.Root.OutputIntents = self._copy(dst, contributors[0])
            return
        for item in contributors:
            if item.default is None:
                continue
            copied = self._copy(dst, item)
            for index in item.relying:
                self.budget.spend()
                dst.pages[index].OutputIntents = copied
                self.materialized.add(index)
                self.page_level_required = True

    def _copy(self, dst, item):
        """The source's own array object, so profile identity is not forked."""
        array = item.default
        if not array.is_indirect:
            array = item.pdf.make_indirect(Array(array))
        return dst.copy_foreign(array)
