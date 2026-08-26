"""The XFA `datasets` packet: resolve an AcroForm field name to its data
node, read the leaf value, and replace it WITHOUT re-serializing the packet.

Two rules from the normative texts shape this module.

XFA 3.3 ch. 2, "Connecting the PDF to the XFA Template" / "Field Names": in a
PDF-embedded XFA form each interactive field is global and its fully qualified
name IS an XFA-SOM expression naming the objects that must be entered in turn
to reach the field element, dot-separated; same-named siblings under one parent
are distinguished by a numeric index whose first value is 0. XFA 3.3 ch. 3,
"Scripting Object Model": the form's data hangs under `xfa.datasets.data`, and
case is significant. So a field named `form1[0].page_1[0].name[0]` addresses
`<xfa:data><form1><page_1><name>`, and an absent index means index 0.

The name addresses the FORM DOM, which is the template merged with the data,
so the datasets tree can legitimately be SHALLOWER than the name: a template
subform that binds to no data contributes a name step with no data node. A
strict walk therefore has a relaxed second pass in which a step may match a
descendant rather than a child. Two distinct relaxed matches make the binding
ambiguous, and an ambiguous binding resolves to nothing — writing into a
guessed node would put the value where no reader looks.

Edits are byte-range splices over the packet's own bytes: the datasets packets
in the wild carry a line-broken tag style (`<f1_01\\n/>`) that any DOM
round-trip rewrites wholesale, which would make every fill rewrite every leaf.
An edit that changes nothing writes nothing.
"""

from xml.parsers import expat

# The packet element that roots the data DOM (XFA 3.3 ch. 3, `xfa.datasets.data`).
_DATA_LOCAL = "data"
_DATASETS_LOCAL = "datasets"

MAX_PATH_STEPS = 64


class DatasetsError(Exception):
    """The packet cannot be read or edited — reported, never guessed past."""


def _local(name: str) -> str:
    """The local part of a possibly prefixed XML name."""
    return name.split(":", 1)[1] if ":" in name else name


class _Node:
    __slots__ = ("name", "parent", "children", "open_start", "open_end", "close_start", "text", "empty")

    def __init__(self, name, parent, open_start):
        self.name = name
        self.parent = parent
        self.children: list = []
        self.open_start = open_start
        self.open_end = -1
        self.close_start = -1
        self.text: list[str] = []
        self.empty = False


def _open_tag_end(data: bytes, start: int) -> tuple[int, bool]:
    """(index of the open tag's `>`, whether the tag is empty-element).

    Attribute values may contain `>` (`a="x>y"` is well-formed), so the scan
    tracks quote state rather than taking the first `>`.
    """
    i = start + 1
    quote = 0
    while i < len(data):
        c = data[i]
        if quote:
            if c == quote:
                quote = 0
        elif c in (0x22, 0x27):
            quote = c
        elif c == 0x3E:  # '>'
            return i, data[i - 1] == 0x2F  # '/'
        i += 1
    raise DatasetsError("unterminated XML tag in the datasets packet")


def _escape(value: str) -> str:
    # `"` and `'` are deliberately not escaped: the payload only ever lands in
    # element content, never in an attribute value. A reuse of this function in
    # an attribute context must add them.
    return value.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def _utf16_head(data: bytes) -> bool:
    """Whether the buffer looks like UTF-16 (BOM, or NULs among the first bytes).

    `_declared_encoding` byte-scans for an ASCII `encoding=`, which can never
    match a UTF-16 buffer whose declaration is itself UTF-16. Byte offsets and
    the UTF-8 payload encoding both assume a UTF-8 superset, so a UTF-16 packet
    is refused rather than mis-spliced.
    """
    if data[:2] in (b"\xff\xfe", b"\xfe\xff"):
        return True
    return b"\x00" in data[:200]


def _declared_encoding(data: bytes) -> str | None:
    """The XML declaration's encoding, lowercased, or None when absent."""
    head = data[:200]
    key = b"encoding="
    at = head.find(key)
    if at < 0:
        return None
    rest = head[at + len(key):]
    if not rest or rest[0] not in (0x22, 0x27):
        return None
    quote = rest[0]
    end = rest.find(bytes([quote]), 1)
    if end < 0:
        return None
    return rest[1:end].decode("ascii", "replace").lower()


class DatasetsPacket:
    """One parsed XFA packet buffer with byte spans for every element.

    The buffer is whatever carries the datasets element: the `datasets` packet
    stream of the array spelling, or the whole `xdp:xdp` stream of the single-
    stream spelling (ISO 32000-2 Annex K describes both). Locating the data
    root inside the parsed tree is the same work either way.
    """

    def __init__(self, data: bytes):
        if _utf16_head(data):
            raise DatasetsError("the datasets packet is encoded as utf-16")
        encoding = _declared_encoding(data)
        if encoding is not None and encoding not in ("utf-8", "utf8", "us-ascii", "ascii"):
            # Byte offsets are into THIS buffer, and a replacement value has to
            # be encoded the way the rest of the buffer is. Anything but a
            # UTF-8 superset is refused rather than mis-encoded.
            raise DatasetsError(f"the datasets packet is encoded as {encoding}")
        self.data = data
        self.root: _Node | None = None
        self._edits: list[tuple[int, int, bytes]] = []
        # An empty-element holder has no content region to splice into, so every
        # edit under it (its own value, and each child created beneath it) has to
        # compose into ONE rewrite of its tag span. Recording them as separate
        # replacements over that same span produced overlapping edits and a
        # malformed packet. Keyed by node identity, insertion-ordered.
        self._empty_edits: dict[int, dict] = {}
        self._parse()

    def _parse(self) -> None:
        parser = expat.ParserCreate()
        parser.buffer_text = True
        stack: list[_Node] = []
        root: list = [None]

        def start(name, _attrs):
            node = _Node(name, stack[-1] if stack else None, parser.CurrentByteIndex)
            node.open_end, node.empty = _open_tag_end(self.data, node.open_start)
            if stack:
                stack[-1].children.append(node)
            elif root[0] is None:
                root[0] = node
            stack.append(node)

        def end(_name):
            node = stack.pop()
            node.close_start = parser.CurrentByteIndex

        def chars(text):
            if stack:
                stack[-1].text.append(text)

        parser.StartElementHandler = start
        parser.EndElementHandler = end
        parser.CharacterDataHandler = chars
        try:
            parser.Parse(self.data, True)
        except expat.ExpatError as exc:
            raise DatasetsError(f"the datasets packet is not well-formed XML: {exc}") from None
        self.root = root[0]
        if self.root is None:
            raise DatasetsError("the datasets packet has no root element")

    # ── locating the data DOM root ──────────────────────────────────────

    def data_root(self) -> _Node | None:
        """The `<xfa:data>` element — `xfa.datasets.data` (XFA 3.3 ch. 3)."""
        if self.root is None:
            return None
        if _local(self.root.name) == _DATA_LOCAL:
            return self.root
        queue = [self.root]
        datasets = None
        while queue:
            node = queue.pop(0)
            if _local(node.name) == _DATASETS_LOCAL:
                datasets = node
                break
            queue.extend(node.children)
        if datasets is None:
            return None
        for child in datasets.children:
            if _local(child.name) == _DATA_LOCAL:
                return child
        return None

    # ── SOM resolution ──────────────────────────────────────────────────

    def resolve(self, field_name: str) -> _Node | None:
        """The data node an AcroForm fully qualified field name addresses.

        Strict first (every step a direct child at its occurrence index),
        then relaxed. Relaxed candidates are ranked by how far they departed
        from the written path — a skipped step or a skipped level each cost
        one — and the single cheapest wins. A tie is ambiguous and resolves to
        nothing: two readings of one name are not a binding.
        """
        root = self.data_root()
        if root is None:
            return None
        steps = parse_som_path(field_name)
        if not steps:
            return None
        node = _strict(root, steps, 0)
        if node is not None:
            return node
        return _cheapest(_candidates(root, steps))

    def get(self, field_name: str) -> str | None:
        """The leaf's text, or None when the field addresses no data value.

        A data GROUP has no value of its own: it holds other nodes, so its
        concatenated descendant text is not a field value and reporting it
        would invent one.
        """
        node = self.resolve(field_name)
        if node is None:
            return None
        if _only_values(node):
            values = _selected_values(node)
            return values[0] if values else ""
        if node.children:
            return None
        return "".join(node.text)

    def get_list(self, field_name: str) -> list[str] | None:
        """Every selected item of a list-box data node, or None.

        A single-value node reads as a one-item list: a list box that holds
        one selection is stored as a plain value node by most authors.
        """
        node = self.resolve(field_name)
        if node is None:
            return None
        if _only_values(node):
            return _selected_values(node)
        if node.children:
            return None
        text = "".join(node.text)
        return [text] if text else []

    def parent_of(self, field_name: str) -> tuple["_Node | None", str]:
        """(the node that would hold this field's value, the leaf's own name).

        The path minus its last step, resolved the same way — what a value
        with no data node of its own has to be attached to.
        """
        steps = parse_som_path(field_name)
        if not steps:
            return None, ""
        leaf = steps[-1][0]
        root = self.data_root()
        if root is None:
            return None, leaf
        if len(steps) == 1:
            return root, leaf
        parent = _strict(root, steps[:-1], 0)
        if parent is None:
            parent = _cheapest(_candidates(root, steps[:-1]))
        return parent, leaf

    def set(self, field_name: str, value, create: bool = False) -> bool:
        """Replace the leaf's content. Returns whether anything changed.

        False means the field addresses no writable data node — the caller
        decides whether that is a refusal or a benign absence; it is never
        silently treated as a write.

        ``create`` attaches a value node where the packet has none and the
        holding node resolves unambiguously: the datasets packets in the wild
        routinely omit nodes for fields that were never filled, and a fill
        that wrote `/V` while leaving the XFA resource without the value is
        exactly the inconsistency ISO 32000-2 Annex K forbids.
        """
        node = self.resolve(field_name)
        if node is None or (node.children and not _only_values(node)):
            if not (create and value and node is None):
                return False
            return self._create(field_name, value)
        if isinstance(value, list):
            # A multiple-selection list box holds one `<value>` child per
            # selected item — the shape the reference implementation emits, and
            # the only one that keeps the selections distinguishable.
            if _selected_values(node) == value:
                return False
            payload = b"".join(
                b"<value>" + _escape(str(v)).encode("utf-8") + b"</value>" for v in value
            )
        else:
            if "".join(node.text) == value:
                return False
            payload = _escape(value).encode("utf-8")
        if node.empty:
            # `<name\n/>` has no content region to splice into: the tag itself
            # becomes an open/close pair, and its own attributes travel.
            self._empty_entry(node)["content"] = payload
        else:
            self._edits.append((node.open_end + 1, node.close_start, payload))
        return True

    def _empty_entry(self, node: _Node) -> dict:
        """The single pending rewrite of an empty-element node's tag span."""
        entry = self._empty_edits.get(id(node))
        if entry is None:
            entry = {"node": node, "content": None, "appends": []}
            self._empty_edits[id(node)] = entry
        return entry

    def _create(self, field_name: str, value) -> bool:
        parent, leaf = self.parent_of(field_name)
        if parent is None or not leaf:
            return False
        inner = (
            b"".join(
                b"<value>" + _escape(str(v)).encode("utf-8") + b"</value>" for v in value
            )
            if isinstance(value, list)
            else _escape(value).encode("utf-8")
        )
        payload = (
            b"<" + leaf.encode("utf-8") + b">"
            + inner
            + b"</" + leaf.encode("utf-8") + b">"
        )
        if parent.empty:
            self._empty_entry(parent)["appends"].append(payload)
        else:
            self._edits.append((parent.close_start, parent.close_start, payload))
        return True

    def _composed_edits(self) -> list[tuple[int, int, bytes]]:
        """Every pending change as one non-overlapping (start, end, payload) list.

        Each empty-element holder contributes exactly one span replacement no
        matter how many values and created children landed under it.
        """
        edits = list(self._edits)
        for entry in self._empty_edits.values():
            node = entry["node"]
            inner = self.data[node.open_start + 1 : node.open_end - 1].rstrip()
            name = inner.split(None, 1)[0]
            body = entry["content"] or b""
            body += b"".join(entry["appends"])
            edits.append(
                (
                    node.open_start,
                    node.open_end + 1,
                    b"<" + inner + b">" + body + b"</" + name + b">",
                )
            )
        ordered = sorted(range(len(edits)), key=lambda i: (edits[i][0], edits[i][1], i))
        previous_end = -1
        for i in ordered:
            start, end, _payload = edits[i]
            if start < previous_end:
                raise DatasetsError("overlapping edits in the datasets packet")
            previous_end = end
        return [edits[i] for i in ordered]

    def bytes(self) -> bytes:
        """The packet with every recorded edit applied.

        With no edits this is the original object, so a fill that changes no
        data leaf cannot change the packet's bytes.
        """
        edits = self._composed_edits()
        if not edits:
            return self.data
        out = self.data
        for start, end, payload in reversed(edits):
            out = out[:start] + payload + out[end:]
        return out

    def changed(self) -> bool:
        return bool(self._edits) or bool(self._empty_edits)


def parse_som_path(field_name: str) -> list[tuple[str, int]]:
    """An AcroForm field name as SOM steps of (name, occurrence index).

    XFA 3.3 ch. 2 "Field Names": dot-separated object names with a 0-based
    numeric index on same-named siblings; ch. 3 "Scripting Object Model":
    an omitted index is 0. A leading `form`/`xfa.form`/`$form` names the form
    DOM root the expression starts at and is not itself a data node.
    """
    steps: list[tuple[str, int]] = []
    for part in _split_som(field_name)[:MAX_PATH_STEPS]:
        name, index = part, 0
        if name.endswith("]"):
            at = name.rfind("[")
            if at > 0:
                digits = name[at + 1 : -1]
                if digits.isdigit():
                    name, index = name[:at], int(digits)
        if not name:
            continue
        steps.append((name, index))
    while steps and steps[0][0] in ("xfa", "$xfa", "form", "$form", "datasets", "$data"):
        steps = steps[1:]
    return steps


def _split_som(expression: str) -> list[str]:
    """Split a SOM expression on its object separators.

    XFA 3.3 ch. 3, "SOM Expressions That Include Periods and Dashes": a period
    that is part of a NAME is escaped with a backslash, so a naive split cuts
    such a name in half (a real corpus field is named `f3_166\\.`). The dash
    needs no escape and carries no meaning here.
    """
    parts: list[str] = []
    current: list[str] = []
    escaped = False
    for ch in expression:
        if escaped:
            current.append(ch)
            escaped = False
        elif ch == "\\":
            escaped = True
        elif ch == ".":
            parts.append("".join(current))
            current = []
        else:
            current.append(ch)
    if escaped:
        current.append("\\")
    parts.append("".join(current))
    return parts


def _only_values(node: _Node) -> bool:
    """Whether every child is a `<value>` item — the list-box data shape."""
    return bool(node.children) and all(_local(c.name) == "value" for c in node.children)


def _selected_values(node: _Node) -> list[str]:
    return ["".join(c.text) for c in node.children if _local(c.name) == "value"]


def _children_named(node: _Node, name: str) -> list[_Node]:
    return [c for c in node.children if _local(c.name) == name]


def _strict(node: _Node, steps, i: int) -> _Node | None:
    if i >= len(steps):
        return node
    name, index = steps[i]
    matches = _children_named(node, name)
    if index >= len(matches):
        return None
    return _strict(matches[index], steps, i + 1)


def _candidates(root: _Node, steps) -> list[tuple[int, _Node]]:
    """(cost, node) for every relaxed reading of ``steps`` from ``root``."""
    out: list[tuple[int, _Node]] = []
    _relaxed(root, steps, 0, out, cost=0)
    return out


def _cheapest(candidates) -> _Node | None:
    """The single lowest-cost candidate, or None when the best is a tie."""
    if not candidates:
        return None
    best = min(c for c, _n in candidates)
    winners = {id(n): n for c, n in candidates if c == best}
    if len(winners) != 1:
        return None
    return next(iter(winners.values()))


def _relaxed(node: _Node, steps, i: int, out: list, seen=None, cost: int = 0) -> None:
    """Collect every relaxed reading of ``steps`` from ``node``, with its cost.

    The field name addresses the FORM DOM — the template merged with the data
    (XFA 3.3 ch. 6, data binding) — so a template subform that binds to no
    data contributes a name step the datasets tree does not have. Every wild
    hybrid whose datasets tree is flatter than its field names is this case:
    `topmostSubform[0].Page1[0].f1_01[0]` against `<topmostSubform><f1_01/>`.
    A step may therefore be SKIPPED, but never the last one — that step names
    the value itself. A data tree DEEPER than the name is matched the other
    way, by DESCENDING past a level the name does not mention. Each departure
    costs one, so the reading that follows the written path most closely wins.
    """
    if seen is None:
        seen = {}
    key = (id(node), i)
    if seen.get(key, 1 << 30) <= cost:
        return
    seen[key] = cost
    if i >= len(steps):
        out.append((cost, node))
        return
    name, index = steps[i]
    matches = _children_named(node, name)
    if index < len(matches):
        _relaxed(matches[index], steps, i + 1, out, seen, cost)
    elif index > 0 and matches:
        # An occurrence the data tree does not have. The members of an
        # exclusion group (XFA 3.3, `exclGroup`) are separate fields in the
        # PDF shadow — `c1_8[0]`, `c1_8[1]` — sharing ONE data node whose
        # value is the on-state of whichever member is selected, so the
        # surplus occurrences bind to the node that exists.
        _relaxed(matches[0], steps, i + 1, out, seen, cost + 1)
    if i < len(steps) - 1:
        _relaxed(node, steps, i + 1, out, seen, cost + 1)
    taken = {id(m) for m in matches}
    for child in node.children:
        if id(child) in taken:
            continue
        _relaxed(child, steps, i, out, seen, cost + 1)
