"""Optional-content authority for engine page copies (ISO 32000-2, 8.11).

qpdf owns the foreign object map, including groups reached through Forms and
annotations. This module composes the catalog authority over those SAME
objects. Default states compose independently; each alternate changes its
source while keeping other sources at their defaults, not a Cartesian product.
All validation and composition precedes the caller's final file publication.
"""
from dataclasses import dataclass, field
from decimal import Decimal

import pikepdf
from pikepdf import Array, Dictionary, Name, Stream, String
from engine.pdf_version import effective_version
from engine.pdf_tree import key_text, name_bytes, name_object

MAX_WORK = 200_000
MAX_BYTES = 64 * 1024 * 1024
MAX_DEPTH = 64
CONFIG_ARRAYS = ('/ON', '/OFF', '/Order', '/AS', '/RBGroups', '/Locked')
CONFIG_KEYS = set(CONFIG_ARRAYS) | {'/Name', '/Creator', '/BaseState', '/Intent', '/ListMode'}
SEMANTIC_TYPES = {'/Catalog', '/Page', '/Pages', '/Annot', '/StructTreeRoot', '/StructElem', '/OBJR', '/MCR', '/Action'}
ACTION_TYPES = {'/GoTo', '/GoToR', '/GoToE', '/Launch', '/Thread', '/URI', '/Sound', '/Movie',
                '/Hide', '/Named', '/SubmitForm', '/ResetForm', '/ImportData', '/JavaScript',
                '/SetOCGState', '/Rendition', '/Trans', '/GoTo3DView'}


def _refuse():
    raise ValueError('Optional-content configuration cannot be preserved completely.')


@dataclass
class Budget:
    work: int = MAX_WORK
    remaining_bytes: int = MAX_BYTES

    def spend(self, count=1, size=0, depth=0):
        self.work -= count
        self.remaining_bytes -= size
        if self.work < 0 or self.remaining_bytes < 0 or depth > MAX_DEPTH:
            _refuse()


def _ref(obj):
    return obj.objgen if isinstance(obj, pikepdf.Object) and obj.is_indirect else None


def _names(value, default, budget):
    if value is None:
        return set(default)
    if isinstance(value, Name):
        budget.spend(size=len(bytes(value)))
        return {key_text(value)}
    if not isinstance(value, Array):
        _refuse()
    result = set()
    for item in value:
        budget.spend()
        if not isinstance(item, Name):
            _refuse()
        result.add(key_text(item))
    return result


def _group_array(value, groups, budget):
    if value is None:
        return []
    if not isinstance(value, Array):
        _refuse()
    result = []
    for item in value:
        budget.spend()
        if item is None:
            continue
        key = _ref(item)
        if key not in groups or not isinstance(item, Dictionary) or item.get('/Type') != Name.OCG:
            _refuse()
        result.append(item)
    return result


def _membership(obj, groups, budget):
    kind = obj.get('/Type')
    if kind == Name.OCG:
        if _ref(obj) not in groups:
            _refuse()
        return
    if kind != Name.OCMD:
        _refuse()
    members = obj.get('/OCGs')
    if isinstance(members, Dictionary):
        members = Array([members])
    _group_array(members, groups, budget)
    policy = obj.get('/P')
    if policy is not None and policy not in (Name.AllOn, Name.AnyOn, Name.AnyOff, Name.AllOff):
        _refuse()

    def expression(value, depth):
        budget.spend(depth=depth)
        if not isinstance(value, Array) or len(value) < 2:
            _refuse()
        op = value[0]
        if op not in (Name.And, Name.Or, Name.Not) or op == Name.Not and len(value) != 2:
            _refuse()
        for child in list(value)[1:]:
            if isinstance(child, Array):
                expression(child, depth + 1)
            else:
                _group_array(Array([child]), groups, budget)
                if child is None:
                    _refuse()

    if obj.get('/VE') is not None:
        expression(obj.VE, 0)


def _usage(group, budget):
    usage = group.get('/Usage')
    if usage is None:
        return
    if not isinstance(usage, Dictionary):
        _refuse()
    for key, item in usage.items():
        budget.spend()
        if item is None:
            continue
        if key not in {'/CreatorInfo', '/Language', '/Export', '/Zoom', '/Print', '/View', '/User', '/PageElement'}:
            continue
        if not isinstance(item, Dictionary):
            _refuse()
        if key == '/CreatorInfo' and (not isinstance(item.get('/Creator'), String)
                                     or not isinstance(item.get('/Subtype'), Name)):
            _refuse()
        if key == '/Language':
            if not isinstance(item.get('/Lang'), String) or item.get('/Preferred') not in (None, Name.ON, Name.OFF):
                _refuse()
        state = {'/Export': '/ExportState', '/View': '/ViewState', '/Print': '/PrintState'}.get(key)
        if state and (key != '/Print' or item.get(state) is not None) and item.get(state) not in (Name.ON, Name.OFF):
            _refuse()
        if key == '/Print' and item.get('/Subtype') is not None and not isinstance(item.Subtype, Name):
            _refuse()
        if key == '/Zoom':
            if item.get('/min') is None and item.get('/max') is None:
                _refuse()
            for bound in ('/min', '/max'):
                value = item.get(bound)
                if value is not None and (isinstance(value, bool) or not isinstance(value, (int, float, Decimal))):
                    _refuse()
        if key == '/User':
            if item.get('/Type') not in (Name.Ind, Name.Ttl, Name.Org):
                _refuse()
            names = item.get('/Name')
            if not isinstance(names, String):
                if not isinstance(names, Array) or any(not isinstance(value, String) for value in names):
                    _refuse()
                budget.spend(len(names))
        if key == '/PageElement' and item.get('/Subtype') not in (Name.HF, Name.FG, Name.BG, Name.L):
            _refuse()


def _config(config, groups, budget, is_default):
    if not isinstance(config, Dictionary):
        _refuse()
    base = config.get('/BaseState')
    if base is None:
        base = Name.ON
    if base not in (Name.ON, Name.OFF, Name.Unchanged) or is_default and base == Name.Unchanged:
        _refuse()
    intents = _names(config.get('/Intent'), {'/View'}, budget)
    if is_default and intents != {'/View'}:
        _refuse()
    for key in ('/Name', '/Creator'):
        if config.get(key) is not None and not isinstance(config[key], String):
            _refuse()
    if config.get('/ListMode', Name.AllPages) not in (None, Name.AllPages, Name.VisiblePages):
        _refuse()
    on = {_ref(item) for item in _group_array(config.get('/ON'), groups, budget)}
    off = {_ref(item) for item in _group_array(config.get('/OFF'), groups, budget)}
    if on & off:
        _refuse()
    _group_array(config.get('/Locked'), groups, budget)
    radios = config.get('/RBGroups')
    if radios is not None:
        if not isinstance(radios, Array):
            _refuse()
        for row in radios:
            budget.spend()
            if row is not None:
                _group_array(row, groups, budget)

    def order(tree, depth):
        budget.spend(depth=depth)
        if not isinstance(tree, Array):
            _refuse()
        for item in tree:
            budget.spend()
            if item is None or isinstance(item, String):
                continue
            if isinstance(item, Array):
                order(item, depth + 1)
            else:
                _group_array(Array([item]), groups, budget)
    if config.get('/Order') is not None:
        order(config.Order, 0)
    applications = config.get('/AS')
    if applications is not None:
        if not isinstance(applications, Array):
            _refuse()
        for item in applications:
            budget.spend()
            if item is None:
                continue
            if not isinstance(item, Dictionary) or item.get('/Event') not in (Name.View, Name.Print, Name.Export):
                _refuse()
            category = item.get('/Category')
            if not isinstance(category, Array):
                _refuse()
            _names(category, set(), budget)
            # Table 101: absent OCGs affects NO groups, never all groups.
            _group_array(item.get('/OCGs'), groups, budget)
    if base == Name.OFF:
        off = set(groups) - on
    elif base == Name.ON:
        on = set(groups) - off
    return str(base), on, off, intents


def _walk(roots, budget, visitor, pure=False, seen=None):
    """Bound every edge, including cached references, before foreign copying."""
    stack = [(root, 0) for root in roots]
    if seen is None:
        seen = set()
    while stack:
        obj, depth = stack.pop()
        budget.spend(depth=depth)
        ref = _ref(obj)
        if ref is not None:
            if ref in seen:
                continue
            seen.add(ref)
        if isinstance(obj, String) and pure:
            budget.spend(size=len(bytes(obj)))
        elif isinstance(obj, (Dictionary, Stream)):
            visitor(obj)
            if pure:
                kind, action = obj.get('/Type'), obj.get('/S')
                if isinstance(kind, Name) and key_text(kind) in SEMANTIC_TYPES:
                    _refuse()
                if isinstance(action, Name) and key_text(action) in ACTION_TYPES:
                    _refuse()
            elif obj.get('/Type') in (Name.Catalog, Name.Page, Name.Pages):
                # Page/annotation back-pointers do not add rendered resources.
                continue
            if isinstance(obj, Stream) and pure:
                budget.spend(size=len(obj.read_raw_bytes()))
            for key, value in obj.items():
                budget.spend(size=len(key))
                stack.append((value, depth + 1))
        elif isinstance(obj, Array):
            if len(obj) > budget.work:
                _refuse()
            stack.extend((value, depth + 1) for value in obj)


@dataclass
class Source:
    pdf: object
    properties: object
    groups: dict
    default: object
    configs: list
    states: dict
    budget: Budget
    fixed_arrays: dict
    minimum_version: tuple
    copied: dict = field(default_factory=dict)


def read_optional_content(src, pages, budget):
    """Read before the page/form copier mutates its private source field tree."""
    properties = src.Root.get('/OCProperties')
    groups, configs, states = {}, [], {}
    default = None
    fixed_arrays = {}
    minimum_version = (1, 5)

    def protect_array(value, depth=0):
        if not isinstance(value, Array):
            return
        budget.spend(depth=depth)
        key = _ref(value)
        if key is not None:
            if key in fixed_arrays:
                return
            fixed_arrays[key] = value
        for child in value:
            budget.spend()
            protect_array(child, depth + 1)
    if properties is not None:
        minimum_version = max(minimum_version, effective_version(src))
        if not isinstance(properties, Dictionary) or not isinstance(properties.get('/OCGs'), Array):
            _refuse()
        for group in properties.OCGs:
            budget.spend()
            if group is None:
                continue
            if not isinstance(group, Dictionary) or not group.is_indirect or group.get('/Type') != Name.OCG:
                _refuse()
            if not isinstance(group.get('/Name'), String):
                _refuse()
            groups[group.objgen] = group
            _names(group.get('/Intent'), {'/View'}, budget)
            _usage(group, budget)
        default = properties.get('/D')
        states['default'] = _config(default, groups, budget, True)
        alternates = properties.get('/Configs')
        if alternates is not None:
            if not isinstance(alternates, Array):
                _refuse()
            for item in alternates:
                budget.spend()
                if item is not None:
                    states[len(configs)] = _config(item, groups, budget, False)
                    configs.append(item)
        for config in [default, *configs]:
            if config.get('/Locked') is not None:
                minimum_version = max(minimum_version, (1, 6))
            for application in config.get('/AS') or []:
                if application is not None:
                    protect_array(application.get('/OCGs'))
            for key in ('/Order', '/RBGroups'):
                for child in config.get(key) or []:
                    protect_array(child)

    def membership(obj):
        nonlocal minimum_version
        if obj.get('/Type') in (Name.OCG, Name.OCMD):
            _membership(obj, groups, budget)
        if obj.get('/Type') == Name.OCMD:
            if obj.get('/VE') is not None:
                minimum_version = max(minimum_version, (1, 6))
            protect_array(obj.get('/OCGs'))
            protect_array(obj.get('/VE'))
        if obj.get('/S') == Name.SetOCGState:
            protect_array(obj.get('/State'))
        if obj.get('/OC') is not None and (isinstance(obj, Stream) or obj.get('/Subtype') is not None):
            oc = obj.OC
            if not isinstance(oc, Dictionary):
                _refuse()
            _membership(oc, groups, budget)

    # Typed authority and opaque extension data are validated before qpdf can
    # recursively import them. Pure data may share/cycle, not clone page/action
    # roots under a layer configuration's arbitrary extension field.
    pure_seen = set()
    if properties is not None:
        _walk([properties], budget, membership, pure=True, seen=pure_seen)

    def rendered_membership(obj):
        membership(obj)
        if obj.get('/Type') in (Name.OCG, Name.OCMD):
            _walk([obj], budget, membership, pure=True, seen=pure_seen)
        if obj.get('/OC') is not None and (isinstance(obj, Stream) or obj.get('/Subtype') is not None):
            _walk([obj.OC], budget, membership, pure=True, seen=pure_seen)
    roots = []
    for page in pages:
        budget.spend()
        roots.extend([page.get('/Resources'), page.get('/Contents'), page.get('/Annots')])
    # Discovery inspects resource dictionaries, not image/font pixel programs.
    # The byte budget covers optional-content payloads we actually copy here;
    # it must not become an unrelated 64 MB limit on ordinary PDF images.
    _walk(roots, budget, rendered_membership)
    if properties is None:
        return None
    if any(group.get('/Usage') is not None and group.Usage.get('/User') is not None for group in groups.values()):
        minimum_version = max(minimum_version, (1, 6))
    return Source(src, properties, groups, default, configs, states, budget, fixed_arrays, minimum_version)


def _fixed_array_equal(original, replacement, source, depth=0):
    """A scoped group operand must not acquire another source's groups.

    An indirect array can simultaneously be a configuration authority and an
    OCMD/usage/radio/order/action operand. Expanding the former does not grant
    permission to expand the latter. Refuse when their one identity cannot
    satisfy both roles; opaque aliases to the authority may still follow it.
    """
    source.budget.spend(depth=depth)
    if isinstance(original, Array):
        return isinstance(replacement, Array) and len(original) == len(replacement) and all(
            _fixed_array_equal(a, b, source, depth + 1) for a, b in zip(original, replacement))
    if isinstance(original, Dictionary) and original.get('/Type') == Name.OCG:
        copied = source.copied.get(_ref(original))
        return copied is not None and _ref(copied) == _ref(replacement)
    return _equal(original, replacement, source.budget)


def _copy(dst, source, value, depth=0):
    source.budget.spend(depth=depth)
    if value is None or isinstance(value, (bool, int, float, Decimal)):
        return value
    if _ref(value):
        return dst.copy_foreign(value)
    if isinstance(value, String):
        source.budget.spend(size=len(bytes(value)))
        return String(bytes(value))
    if isinstance(value, Name):
        return name_object(name_bytes(value))
    if isinstance(value, Dictionary):
        copied = Dictionary()
        for key, item in value.items():
            copied[key] = _copy(dst, source, item, depth + 1)
        return copied
    if isinstance(value, Array):
        return Array([_copy(dst, source, item, depth + 1) for item in value])
    _refuse()


def _equal(a, b, budget, seen=None, *, pairs=None, mappings=None, depth=0):
    budget.spend(depth=depth)
    if seen is None:
        seen = set()
    if mappings:
        a = _replacement(a, mappings, budget)
        b = _replacement(b, mappings, budget)
    if _ref(a) is not None and _ref(a) == _ref(b):
        return True
    # Group identities are not interchangeable just because their names match.
    if isinstance(a, Dictionary) and a.get('/Type') in (Name.OCG, Name.OCMD):
        return _ref(a) == _ref(b)
    if type(a) is not type(b):
        # qpdf's Object proxy class is shared by names/dicts/arrays; the
        # explicit kind checks below carry the actual structural distinction.
        return False
    pair = (_ref(a), _ref(b))
    if pair[0] and pair[1]:
        if pair in seen:
            return True
        seen.add(pair)
    if isinstance(a, (Dictionary, Stream)):
        if isinstance(a, Stream) != isinstance(b, Stream) or not isinstance(b, (Dictionary, Stream)):
            return False
        if isinstance(a, Stream) and a.read_raw_bytes() != b.read_raw_bytes():
            return False
        equal = set(a.keys()) == set(b.keys()) and all(_equal(a[key], b[key], budget, seen,
            pairs=pairs, mappings=mappings, depth=depth + 1) for key in a.keys())
    elif isinstance(a, Array):
        equal = isinstance(b, Array) and len(a) == len(b) and all(_equal(x, y, budget, seen,
            pairs=pairs, mappings=mappings, depth=depth + 1) for x, y in zip(a, b))
    elif isinstance(a, String):
        equal = isinstance(b, String) and bytes(a) == bytes(b)
    else:
        equal = a == b
    if equal and pairs is not None and pair[0] and pair[1]:
        pairs.append((a, b))
    return equal


def _combined_config(dst, sources, owner, alternate, budget, equivalences):
    config = Dictionary()
    on, off = [], []
    order, applications, radios, locked = [], [], [], []
    modes, labels, extras = set(), {}, {}
    selected_state = sources[owner].states[alternate] if owner is not None else None
    base = selected_state[0] if selected_state and selected_state[0] == '/Unchanged' else '/ON'
    intent = selected_state[3] if selected_state else {'/View'}
    if owner is not None:
        for index, source in enumerate(sources):
            if index == owner:
                continue
            for group in source.groups.values():
                declared = _names(group.get('/Intent'), {'/View'}, budget)
                if bool(declared & {'/View'}) != ('/All' in intent or bool(declared & intent)):
                    _refuse()
    for index, source in enumerate(sources):
        own = index == owner
        original = source.configs[alternate] if own else source.default
        state = source.states[alternate] if own else source.states['default']
        budget.spend()
        modes.add(str(original.get('/ListMode') or Name.AllPages))
        for key, into in (('/ON', on), ('/OFF', off)):
            chosen = state[1] if key == '/ON' else state[2]
            budget.spend(len(source.groups))
            into.extend(source.copied[group] for group in source.groups if group in chosen)
        for key, into in (('/Order', order), ('/AS', applications), ('/RBGroups', radios), ('/Locked', locked)):
            value = original.get(key)
            if value is None and own and key in ('/Order', '/RBGroups'):
                value = source.default.get(key)
            if value is not None:
                for item in value:
                    budget.spend()
                    if item is not None:
                        into.append(_copy(dst, source, item))
        for key, value in original.items():
            if value is None or key in CONFIG_KEYS:
                continue
            copied = _copy(dst, source, value)
            if key in extras:
                equivalences.append((extras[key], copied))
            extras.setdefault(key, copied)
        for key in ('/Name', '/Creator'):
            if owner is not None and not own:
                continue
            value = original.get(key)
            if value is not None:
                labels.setdefault(key, []).append(_copy(dst, source, value))
    if len(modes) != 1:
        _refuse()
    config.BaseState = Name(base)
    config.Intent = _copy(dst, sources[owner], sources[owner].configs[alternate].get('/Intent')) if owner is not None \
        and sources[owner].configs[alternate].get('/Intent') is not None else Name.View
    config.ListMode = Name(next(iter(modes)))
    for key, values in (('/ON', on), ('/OFF', off), ('/Order', order), ('/AS', applications),
                        ('/RBGroups', radios), ('/Locked', locked)):
        config[key] = dst.make_indirect(Array(values))
    for key, values in labels.items():
        if all(_equal(values[0], value, budget) for value in values[1:]):
            config[key] = values[0]
    for key, value in extras.items():
        config[key] = value
    return dst.make_indirect(config)


def _replacement(value, mappings, budget):
    seen = set()
    while _ref(value) in mappings:
        key = _ref(value)
        budget.spend()
        if key in seen:
            _refuse()
        seen.add(key)
        value = mappings[key]
    return value


def _rewire(dst, mappings, budget):
    """Replace copied semantic aliases with the real composed root/arrays."""
    seen = set()
    stack = [(obj, 0) for obj in dst.objects]
    while stack:
        obj, depth = stack.pop()
        budget.spend(depth=depth)
        ref = _ref(obj)
        if ref and ref in seen:
            continue
        if ref:
            seen.add(ref)
        if isinstance(obj, (Dictionary, Stream)):
            entries = list(obj.items())
        elif isinstance(obj, Array):
            entries = list(enumerate(obj))
        else:
            continue
        for key, value in entries:
            budget.spend()
            mapped = mappings.get(_ref(value))
            if mapped is not None:
                obj[key] = _replacement(mapped, mappings, budget)
            else:
                stack.append((value, depth + 1))


@dataclass
class OptionalContentCarry:
    budget: Budget = field(default_factory=Budget)
    sources: list = field(default_factory=list)
    prior: object = None

    def add(self, dst, source):
        if source is None:
            return
        # `minimum_version` is this source's layer-feature requirement; the
        # caller composes it with every other contribution's requirement
        # through the shared version carry, which declares it once.
        self.sources.append(source)
        for item in self.sources:
            item.copied = {key: dst.copy_foreign(group) for key, group in item.groups.items()}
        # Preserve the original declarations byte-for-byte in the single-source
        # case, including opaque aliases and shared/cyclic extension data.
        if len(self.sources) == 1:
            root = source.properties
            if not root.is_indirect:
                root = source.pdf.make_indirect(Dictionary(root))
            dst.Root.OCProperties = dst.copy_foreign(root)
            self.prior = dst.Root.OCProperties
            return

        root = dst.make_indirect(Dictionary())
        equivalences = []
        default = _combined_config(dst, self.sources, None, None, self.budget, equivalences)
        alternates = []
        targets = []
        for index, item in enumerate(self.sources):
            own_targets = []
            for ordinal in range(len(item.configs)):
                result = _combined_config(dst, self.sources, index, ordinal, self.budget, equivalences)
                alternates.append(result)
                own_targets.append(result)
            targets.append(own_targets)
        root.OCGs = dst.make_indirect(Array([group for item in self.sources for group in item.copied.values()]))
        root.D = default
        root.Configs = dst.make_indirect(Array(alternates))
        mappings = {}

        def map_target(original, replacement):
            if _ref(original) is None:
                return
            key = original.objgen
            replacement = _replacement(replacement, mappings, self.budget)
            previous = mappings.get(key)
            if previous is not None:
                previous = _replacement(previous, mappings, self.budget)
                if _ref(previous) != _ref(replacement):
                    if not _equal(previous, replacement, self.budget, mappings=mappings):
                        _refuse()
                    # One original object serving two semantic roles must
                    # still be one actual object, not merely equal arrays.
                    # Canonicalize the new authority too, including references
                    # already emitted by earlier roles and source additions.
                    mappings[replacement.objgen] = previous
                replacement = previous
            if key != _ref(replacement):
                mappings[key] = replacement

        def pin(item, original, replacement):
            if _ref(original) is None:
                return
            if original.objgen in item.fixed_arrays and not _fixed_array_equal(original, replacement, item):
                _refuse()
            map_target(dst.copy_foreign(original), replacement)

        if self.prior is not None:
            map_target(self.prior, root)
            map_target(self.prior.get('/OCGs'), root.OCGs)
            map_target(self.prior.get('/Configs'), root.Configs)
            previous_configs = [self.prior.D, *(self.prior.get('/Configs') or [])]
            for original, replacement in zip(previous_configs, [default, *alternates]):
                map_target(original, replacement)
                for key in CONFIG_ARRAYS:
                    map_target(original.get(key), replacement[key])

        for index, item in enumerate(self.sources):
            pin(item, item.properties, root)
            pin(item, item.properties.get('/OCGs'), root.OCGs)
            pin(item, item.properties.get('/Configs'), root.Configs)
            for original, replacement in [(item.default, default), *zip(item.configs, targets[index])]:
                pin(item, original, replacement)
                for key in CONFIG_ARRAYS:
                    pin(item, original.get(key), replacement[key])
            for key, value in item.properties.items():
                if key in ('/OCGs', '/D', '/Configs') or value is None:
                    continue
                copied = _copy(dst, item, value)
                if key in root and root[key] is not None:
                    equivalences.append((root[key], copied))
                else:
                    root[key] = copied
        # Compare opaque data only after semantic bindings exist. References
        # to each source's root/default now name the same output authority.
        # Unify equivalent nested identities too: a source's opaque alias must
        # reach the data actually retained in the merged root/configuration.
        for retained, incoming in equivalences:
            pairs = []
            if not _equal(retained, incoming, self.budget, pairs=pairs, mappings=mappings):
                _refuse()
            for canonical, other in pairs:
                map_target(other, canonical)
        dst.Root.OCProperties = root
        _rewire(dst, mappings, self.budget)
        self.prior = root
