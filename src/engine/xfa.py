"""XFA form classification and packet access.

ISO 32000-2 Table 29 gives the document catalog's `NeedsRendering`: a boolean,
deprecated in PDF 2.0, saying that a document containing XFA forms shall have
its page content regenerated when it is first opened; its default is false.
XFA 3.3 ch. 2 "Connecting the PDF to the XFA Template" states the same rule
from the other side — only dynamic templates carry what regenerating the page
content requires, so a foreground (static) XFA form must leave the flag false.
The two together are the classifier: `NeedsRendering` true, or an XFA form with
no AcroForm field shadow to fill, is DYNAMIC; anything else with `/XFA` is
STATIC. The template packet's own markup is not consulted — flow markers,
break elements and script events are present in static templates too, so a
regex over the template names a document dynamic that is not.

ISO 32000-2 Annex K gives the two `/XFA` spellings: an array of alternating
name strings and streams, or a single stream holding one `xdp:xdp` element.
Both appear in the wild and both are handled here.

THE ARRAY IS ONE SEGMENTED RESOURCE, NOT A LIST OF DOCUMENTS. Per Annex K.2
the packets jointly constitute the resource; each names and carries one whole
element, and the clause exempts the outermost two, which hold only the start
and end tag of the wrapper. Those two are therefore fragments by contract:
neither is a document on its own, so a reading that parses each stream in
isolation refuses the exact sequence the clause's own example prints. The
streams are read in array order and parsed as the resource they compose,
which makes the two spellings equivalent by construction rather than by two
code paths that agree only as long as someone keeps checking. Separate bounded
parses check packet boundaries in the original wrapper's namespace context.

Two readings live here and they answer different questions. `classify` and
`xfa_entry` are LENIENT: their callers act on the packets or do nothing, so a
value of the wrong type and an absent key are the same answer to them.
`inspect` is STRICT: it validates every value the classification rests on
against the type its clause gives it — `/XFA` per Table 224 and Annex K.2,
`/Fields` per Table 224, `/NeedsRendering` per Table 29 — and answers a named
UNDETERMINED rather than a class, because a document whose declaration does not
hold those types has a form nothing here can read, which is neither "no form"
nor "dynamic".
"""

from typing import Callable, NamedTuple

from lxml import etree
import pikepdf

NONE = "none"
STATIC = "static"
DYNAMIC = "dynamic"
# A form whose declared shape this build cannot read. Not a class of form: the
# answer to "which class" is that the document does not readably say one.
UNDETERMINED = "undetermined"

# What `xfa_entry_checked` distinguishes that `xfa_entry` cannot. `xfa_entry`
# answers one question — "is there a packet source to read?" — and every
# caller of it acts on the packets or does nothing, so a malformed value and an
# absent key are the same answer THERE. They are not the same answer to an
# observer: a document that declares `/XFA` and holds something else in it has
# a form nothing here can read, which is undetermined, not "no form".
ABSENT = "absent"
PRESENT = "present"
MALFORMED = "malformed"

# Packets that declare bindings to external data services. They are never
# read and never acted on: the app performs no network access, so a document
# that names a data source gets its data from the document alone.
NEVER_READ = ("connectionSet", "sourceSet")


# The named shapes `inspect` refuses on. Each is a CONSTANT of this module —
# never text from an exception and never text from the document — so a caller
# may transmit one without carrying a path, an offset, or a sentence.
SHAPE_ACROFORM_UNREADABLE = "acroform-unreadable"
SHAPE_ACROFORM_TYPE = "acroform-type"
SHAPE_XFA_UNREADABLE = "xfa-unreadable"
SHAPE_XFA_TYPE = "xfa-type"
SHAPE_XFA_ARRAY_LENGTH = "xfa-array-length"
SHAPE_PACKET_NAME_TYPE = "xfa-packet-name-type"
SHAPE_PACKET_STREAM_TYPE = "xfa-packet-stream-type"
SHAPE_PACKET_UNREADABLE = "xfa-packet-unreadable"
SHAPE_PACKET_XML = "xfa-packet-xml"
SHAPE_XDP_ROOT = "xfa-xdp-root"
# A declared packet name that does not name the element its stream holds, or a
# packet sequence whose wrapper fragments do not bracket the middle packets.
# Held apart from a name of the wrong TYPE: one is a mistyped slot, the other
# is a resource whose parts do not describe each other.
SHAPE_PACKET_NAME_MISMATCH = "xfa-packet-name-mismatch"
# A packet whose bytes are not exactly the one element it declares: a fragment,
# two elements, or an element with text beside it. Held apart from a name
# mismatch, which is a whole element under the wrong name.
SHAPE_PACKET_BOUNDARY = "xfa-packet-boundary"
# The ceilings. Each is its own answer, because "too much of it" is not
# "malformed" and a caller that reports them alike cannot tell a hostile
# resource from a broken one.
SHAPE_RESOURCE_BYTES = "xfa-resource-bytes"
SHAPE_RESOURCE_PACKETS = "xfa-resource-packets"
SHAPE_RESOURCE_NAMES = "xfa-resource-names"
SHAPE_RESOURCE_ELEMENTS = "xfa-resource-elements"
SHAPE_FIELDS_COUNT = "acroform-fields-count"
SHAPE_FIELDS_TYPE = "acroform-fields-type"
SHAPE_FIELD_ENTRY_TYPE = "acroform-field-entry-type"
SHAPE_FIELD_ENTRY_REFERENCE = "acroform-field-entry-reference"
SHAPE_NEEDS_RENDERING_TYPE = "needs-rendering-type"

# The ceilings are on the WHOLE resource, not on one packet: a thousand packets
# just under a per-packet ceiling is not a bounded read, and the resource is
# what gets parsed.
#
# Bytes alone bound nothing that is not made of bytes. A resource can be a
# million empty packets, or a handful of packets with megabyte NAMES, or four
# bytes per element repeated until the tree costs two orders of magnitude more
# native memory than the markup did. Each of those is counted here, and each
# refusal says which count it was. The numbers are this engine's judgment of
# what a real document needs, not anything a standard states; a document past
# one of them is answered UNDETERMINED rather than read.
_MAX_RESOURCE_BYTES = 64 * 1024 * 1024
_MAX_RESOURCE_PACKETS = 4096
_MAX_RESOURCE_NAME_BYTES = 64 * 1024
# Elements, counted as the parse builds them, across every parse of one read.
# The byte ceiling permits about sixteen million four-byte elements, and a tree
# of those costs far more than the bytes it came from — so this, not the byte
# count, is what bounds the parse's own allocation.
_MAX_RESOURCE_ELEMENTS = 250_000
# Boundary validation reuses the wrapper. Charge all parser input, including
# repeated comments/whitespace, so a large wrapper cannot amplify a small array.
_MAX_PARSE_BYTES = 128 * 1024 * 1024
# `/Fields` entries walked by the strict reading. A caller with a budget
# charges each one; a caller without one still gets a bound.
_MAX_FIELD_ITEMS = 100_000
# Fed to the parser in pieces, so a ceiling reached part way through a resource
# stops the parse there instead of after the whole tree exists.
_PARSE_CHUNK_BYTES = 64 * 1024

# The XML Data Package namespace the resource's root element belongs to.
XDP_NAMESPACE = "http://ns.adobe.com/xdp/"
# The XFA template namespace family. It is versioned (2.4, 3.3, …) and the
# version is not what identifies a calculation, so the family prefix is what
# is matched and the version travels with the document.
TEMPLATE_NAMESPACE_PREFIX = "http://www.xfa.org/schema/xfa-template/"
# The template elements that author logic this engine will not run.
AUTHORED_LOGIC_ELEMENTS = ("calculate", "validate")


class InspectionInterrupted(Exception):
    """A caller-owned resource limit interrupted strict inspection."""


class _PacketShapeError(Exception):
    """The packet is not safe, bounded XML; never crosses the engine API."""


class _ResourceTooLarge(Exception):
    """The resource exceeded the cumulative byte ceiling."""


class _TooManyElements(Exception):
    """The parse reached the cumulative element ceiling and was stopped."""


class _Counters:
    """What one read has spent. Cumulative across every packet and every parse
    the read performs, because a per-packet allowance is no allowance."""

    __slots__ = ("packets", "name_bytes", "body_bytes", "parse_bytes", "elements", "fields")

    def __init__(self) -> None:
        self.packets = 0
        self.name_bytes = 0
        self.body_bytes = 0
        self.parse_bytes = 0
        self.elements = 0
        self.fields = 0


class AuthoredLogicUnreadable(ValueError):
    """`has_authored_logic` could not read the resource, so it says so.

    A form whose template will not read has not been shown to author no
    calculations; it has not been read. Returning false there is the answer to
    a question nobody asked. Carries the module's own `shape` constant as its
    single argument — never text from the document.
    """


class Inspection(NamedTuple):
    """What a STRICT reading of one document's XFA declaration answers.

    ``form_class`` is ``NONE``/``STATIC``/``DYNAMIC`` only when every value the
    classification rests on held the type its clause gives it. Otherwise it is
    ``UNDETERMINED`` and ``shape`` names which value did not.
    """

    form_class: str
    shape: str
    entry: object


def _bad(shape: str, entry=None) -> Inspection:
    return Inspection(UNDETERMINED, shape, entry)


def _resource_root(data: bytes, counters: _Counters | None = None):
    """Parse a resource without a document type or entity grammar.

    Fed in pieces through a pull parser so the element count is charged AS the
    tree is built: a ceiling checked after `fromstring` returns is a ceiling
    on a tree that already exists, which bounds nothing.
    """
    if len(data) > _MAX_RESOURCE_BYTES:
        raise _ResourceTooLarge
    if counters is not None:
        counters.parse_bytes += len(data)
        if counters.parse_bytes > _MAX_PARSE_BYTES:
            raise _ResourceTooLarge
    if not data.strip():
        raise _PacketShapeError
    parser = etree.XMLPullParser(
        events=("start", "comment", "pi"),
        resolve_entities=False,
        load_dtd=False,
        no_network=True,
        recover=False,
        huge_tree=False,
    )

    def drain() -> None:
        for _event, _element in parser.read_events():
            if counters is None:
                continue
            counters.elements += 1
            if counters.elements > _MAX_RESOURCE_ELEMENTS:
                raise _TooManyElements

    for offset in range(0, len(data), _PARSE_CHUNK_BYTES):
        parser.feed(data[offset:offset + _PARSE_CHUNK_BYTES])
        drain()
    root = parser.close()
    drain()
    # Inspect parsed metadata rather than byte-searching for an ASCII spelling:
    # a valid XFA resource may be UTF-16, where every markup character is
    # encoded with an adjacent NUL. Entity resolution and network reads were
    # already disabled above, so reaching this refusal never executes its
    # grammar.
    if root.getroottree().docinfo.doctype:
        raise _PacketShapeError
    # With no DTD loaded, an undefined entity reference is already a syntax
    # error; a reference that survived parsing is refused rather than read.
    for node in root.iter():
        if isinstance(node, etree._Entity):
            raise _PacketShapeError
    return root


def _element_names(element) -> tuple[str, str]:
    """`(local name, qualified name)` as the document spells them."""
    tag = element.tag
    local = tag.split("}")[-1] if isinstance(tag, str) else ""
    prefix = element.prefix
    return local, (f"{prefix}:{local}" if prefix else local)


def _names_element(element, declared: str) -> bool:
    """Whether `declared` names `element`.

    Annex K.2 makes the string slot the element's name. Which SPELLING of the
    name it takes, the clause settles only by example, and its example is not
    uniform: the wrapper slot reads `xdp:xdp` while the datasets slot reads
    `datasets` for an element spelled `xfa:datasets`. Both the local and the
    qualified spelling therefore name the element, and demanding the qualified
    one would refuse a resource written exactly as the clause prints it.
    """
    return declared in _element_names(element)


def _wrapper_spellings(root) -> tuple[frozenset, frozenset]:
    """The names the opening and closing fragments may carry."""
    opens = frozenset(_element_names(root))
    return opens, frozenset(f"/{name}" for name in opens)


def _one_element_of(data: bytes, prologue: bytes, epilogue: bytes, counters):
    """The single element a middle packet holds, read in wrapper context.

    The packet is parsed BETWEEN the resource's own opening and closing
    fragments, so a prefix the wrapper declares is in scope — Annex K.2's
    example relies on exactly that, and a packet parsed alone would fail on an
    undeclared prefix that the resource does declare.

    Returns the element, or raises `_PacketShapeError` when the packet is not
    exactly one element: a fragment that needs its neighbours to close, two
    elements where the clause allows one, or text sitting beside the element.
    Checking this per packet is the point — after concatenation the boundaries
    are gone, and two packets that between them spell two well-named elements
    look no different from two packets that each spell one.
    """
    root = _resource_root(prologue + data + epilogue, counters)
    children = [child for child in root if isinstance(child.tag, str)]
    if len(children) != 1:
        raise _PacketShapeError
    child = children[0]
    if (root.text or "").strip() or any((node.tail or "").strip() for node in root):
        raise _PacketShapeError
    return child


def _packet_names_match(root, names: tuple[str, ...]) -> bool:
    """Whether the declared packet names describe the resource that was read.

    One packet names the whole element. Otherwise the first and last are the
    wrapper's begin and end tags per Annex K.2's exception, and what lies
    between them names the root's element children in order.
    """
    if not names:
        return True
    if len(names) == 1:
        return _names_element(root, names[0])
    opens, closes = _wrapper_spellings(root)
    if names[0] not in opens or names[-1] not in closes:
        return False
    children = [child for child in root if isinstance(child.tag, str)]
    middles = names[1:-1]
    if len(children) != len(middles):
        return False
    return all(_names_element(child, name) for child, name in zip(children, middles))


def _packet_boundaries_hold(root, names, parts, counters) -> str:
    """`""` when every middle packet is exactly the element it declares.

    Only the split spelling has boundaries to check, and only its middles: the
    first and last packets are the fragments the clause exempts, and what makes
    them well formed is that the resource they bracket parsed at all.
    """
    if len(names) < 2:
        return ""
    prologue, epilogue = parts[0], parts[-1]
    try:
        wrapper = _resource_root(prologue + epilogue, counters)
        if (wrapper.tag != root.tag or any(isinstance(child.tag, str) for child in wrapper)
                or (wrapper.text or '').strip()
                or any((node.tail or '').strip() for node in wrapper)):
            return SHAPE_PACKET_BOUNDARY
    except _TooManyElements:
        return SHAPE_RESOURCE_ELEMENTS
    except _ResourceTooLarge:
        return SHAPE_RESOURCE_BYTES
    except (etree.XMLSyntaxError, _PacketShapeError):
        return SHAPE_PACKET_BOUNDARY
    for name, data in zip(names[1:-1], parts[1:-1]):
        try:
            element = _one_element_of(data, prologue, epilogue, counters)
        except _TooManyElements:
            return SHAPE_RESOURCE_ELEMENTS
        except _ResourceTooLarge:
            return SHAPE_RESOURCE_BYTES
        except (etree.XMLSyntaxError, _PacketShapeError):
            return SHAPE_PACKET_BOUNDARY
        if not _names_element(element, name):
            return SHAPE_PACKET_NAME_MISMATCH
    return ""


class XfaResource(NamedTuple):
    """One read of a document's XFA resource.

    ``root`` is the parsed `xdp:xdp` element; ``names`` are the packet names
    the array declared, in order, and empty for the single-stream spelling.
    ``counters`` is what the read spent, so a later walk of the same tree
    spends from the same allowance.
    """

    root: object
    names: tuple[str, ...]
    counters: object


def _read_resource(
    entry,
    read_stream: Callable[[object], bytes] | None,
    take_item: Callable[[], None] | None,
) -> tuple[str, object]:
    """`(shape, XfaResource)` for a `/XFA` value; shape is "" when it read.

    ONE reading, shared by the strict classification and the authored-logic
    question, because both need the same thing: the resource the document
    declares, bounded, with no grammar and no network. Every stream is READ
    here, because a filter chain that will not unfilter fails at the read and
    nowhere earlier, and every read and item is charged to the caller's own
    accounting so a budgeted traversal keeps its budget.
    """
    reader = read_stream or (lambda stream: stream.read_bytes())
    charge = take_item or (lambda: None)
    counters = _Counters()
    parts: list[bytes] = []

    if isinstance(entry, pikepdf.Stream):
        try:
            charge()
            data = reader(entry)
        except InspectionInterrupted:
            raise
        except Exception:
            return SHAPE_PACKET_UNREADABLE, None
        if not isinstance(data, (bytes, bytearray)):
            return SHAPE_PACKET_UNREADABLE, None
        # A decode is a native allocation of its own, so its size is charged
        # like any other: nothing here claims the read was bounded because the
        # object it came from was small.
        if len(data) > _MAX_RESOURCE_BYTES:
            return SHAPE_RESOURCE_BYTES, None
        counters.body_bytes = len(data)
        data = bytes(data)
        names: tuple[str, ...] = ()
    elif isinstance(entry, pikepdf.Array):
        try:
            length = len(entry)
        except Exception:
            return SHAPE_XFA_UNREADABLE, None
        if length == 0 or length % 2 != 0:
            return SHAPE_XFA_ARRAY_LENGTH, None
        declared: list[str] = []
        # The resource is assembled in array order, and every count is checked
        # AS it grows: a ceiling tested after the loop is a ceiling on work
        # already done.
        buffer = bytearray()
        for i in range(0, length, 2):
            counters.packets += 1
            if counters.packets > _MAX_RESOURCE_PACKETS:
                return SHAPE_RESOURCE_PACKETS, None
            try:
                charge()
                name, stream = entry[i], entry[i + 1]
            except InspectionInterrupted:
                raise
            except Exception:
                return SHAPE_XFA_UNREADABLE, None
            # The name slot is validated, never coerced: `str()` renders a
            # number as readily as a name, so a slot holding one reads back as
            # a packet called "42" and the array passes for well formed.
            if not isinstance(name, pikepdf.String):
                return SHAPE_PACKET_NAME_TYPE, None
            if not isinstance(stream, pikepdf.Stream):
                return SHAPE_PACKET_STREAM_TYPE, None
            spelled = str(name)
            counters.name_bytes += len(spelled.encode("utf-8", "replace"))
            if counters.name_bytes > _MAX_RESOURCE_NAME_BYTES:
                return SHAPE_RESOURCE_NAMES, None
            try:
                part = reader(stream)
            except InspectionInterrupted:
                raise
            except Exception:
                return SHAPE_PACKET_UNREADABLE, None
            if not isinstance(part, (bytes, bytearray)):
                return SHAPE_PACKET_UNREADABLE, None
            counters.body_bytes += len(part)
            if counters.body_bytes > _MAX_RESOURCE_BYTES:
                return SHAPE_RESOURCE_BYTES, None
            parts.append(bytes(part))
            buffer.extend(part)
            declared.append(spelled)
        data = bytes(buffer)
        names = tuple(declared)
    else:
        return SHAPE_XFA_TYPE, None

    try:
        root = _resource_root(data, counters)
    except _ResourceTooLarge:
        return SHAPE_RESOURCE_BYTES, None
    except _TooManyElements:
        return SHAPE_RESOURCE_ELEMENTS, None
    except (etree.XMLSyntaxError, _PacketShapeError):
        return SHAPE_PACKET_XML, None
    except Exception:
        return SHAPE_PACKET_UNREADABLE, None

    # The root is the XDP element, identified by namespace as well as name: a
    # local name alone is any producer's `xdp` in any namespace, and the
    # resource this reads is the XML Data Package's.
    local, _qualified = _element_names(root)
    if local != "xdp" or root.tag != f"{{{XDP_NAMESPACE}}}xdp":
        return SHAPE_XDP_ROOT, None
    if not _packet_names_match(root, names):
        return SHAPE_PACKET_NAME_MISMATCH, None
    boundary = _packet_boundaries_hold(root, names, parts, counters)
    if boundary:
        return boundary, None
    return "", XfaResource(root, names, counters)


def _checked_entry(
    acro,
    read_stream: Callable[[object], bytes] | None = None,
    take_item: Callable[[], None] | None = None,
) -> tuple[str, object, object]:
    """`(shape, entry, resource)` for `/XFA`; shape is "" when it read.

    Validated against ISO 32000-2 Table 224, which gives `XFA` as "stream or
    array", and Annex K.2, which gives the array spelling exactly: a packet is
    a pair of a string and a stream, the string naming the XML element and the
    stream holding that element's complete text, with the first and last
    carrying the wrapper's begin and end tag instead. Both slots of every pair
    are therefore typed, a slot count that is not even is not a sequence of
    pairs at all, and what the pairs COMPOSE is one resource.
    """
    try:
        entry = acro.get("/XFA")
    except Exception:
        return SHAPE_XFA_UNREADABLE, None, None
    if entry is None:
        return "", None, None
    shape, resource = _read_resource(entry, read_stream, take_item)
    return shape, entry, resource


def inspect(
    pdf: pikepdf.Pdf,
    *,
    read_stream: Callable[[object], bytes] | None = None,
    take_item: Callable[[], None] | None = None,
) -> Inspection:
    """Classify this document's form, refusing on any value of the wrong type.

    The one strict reading. Three values decide the class and each carries a
    type in the standard:

    * `/XFA` — ISO 32000-2 Table 224, "stream or array"; the array spelling's
      packet pairs are Annex K.2's string-and-stream.
    * `/Fields` — ISO 32000-2 Table 224, "array".
    * `/NeedsRendering` — ISO 32000-2 Table 29, "boolean", default false.

    A value of any other type makes the class UNDETERMINED, and it is never
    coerced: `bool()` of the string `(false)` is true, so coercing here would
    classify a document dynamic on the strength of a mistyped flag.
    """
    try:
        acro = pdf.Root.get("/AcroForm")
    except Exception:
        return _bad(SHAPE_ACROFORM_UNREADABLE)
    if acro is None:
        return Inspection(NONE, "", None)
    if not isinstance(acro, pikepdf.Dictionary):
        return _bad(SHAPE_ACROFORM_TYPE)

    shape, entry, _resource = _checked_entry(acro, read_stream, take_item)
    if shape:
        return _bad(shape, entry)
    if entry is None:
        return Inspection(NONE, "", None)

    try:
        rendering = pdf.Root.get("/NeedsRendering")
    except Exception:
        return _bad(SHAPE_NEEDS_RENDERING_TYPE, entry)
    if rendering is not None and not isinstance(rendering, bool):
        return _bad(SHAPE_NEEDS_RENDERING_TYPE, entry)
    # `/Fields` IS VALIDATED EVEN WHEN `NeedsRendering` SETTLES THE CLASS.
    # Table 29's flag decides dynamic on its own, so it would be enough to
    # answer here and stop — and that is the shortcut this does not take. This
    # is the strict reading: its contract is that a class it returns rests
    # entirely on values that held the types their clauses give them, and a
    # document whose `/Fields` is a string has a form declaration this build
    # cannot read whatever the flag says. Answering DYNAMIC there would report
    # a readable form on the strength of a value nobody could read. The
    # LENIENT `classify` keeps the shortcut, because its callers act on the
    # packets and a mistyped `/Fields` changes nothing they do.
    try:
        fields = acro.get("/Fields")
    except Exception:
        return _bad(SHAPE_FIELDS_TYPE, entry)
    if fields is None:
        shadow = False
    elif isinstance(fields, pikepdf.Array):
        try:
            shadow = len(fields) > 0
            walked = 0
            for field in fields:
                walked += 1
                # Bounded whether or not the caller has a budget: a field
                # array is as long as a producer made it.
                if walked > _MAX_FIELD_ITEMS:
                    return _bad(SHAPE_FIELDS_COUNT, entry)
                if take_item is not None:
                    take_item()
                if not isinstance(field, pikepdf.Dictionary):
                    return _bad(SHAPE_FIELD_ENTRY_TYPE, entry)
                if getattr(field, "objgen", (0, 0)) == (0, 0):
                    return _bad(SHAPE_FIELD_ENTRY_REFERENCE, entry)
        except InspectionInterrupted:
            raise
        except Exception:
            return _bad(SHAPE_FIELDS_TYPE, entry)
    else:
        return _bad(SHAPE_FIELDS_TYPE, entry)

    if rendering is True:
        return Inspection(DYNAMIC, "", entry)
    # An XFA form whose fields exist only in the XML has nothing to fill
    # through the PDF field objects Annex K requires a fillable form to carry,
    # so it is dynamic for every purpose this engine has.
    return Inspection(STATIC if shadow else DYNAMIC, "", entry)


def acroform(pdf: pikepdf.Pdf):
    try:
        return pdf.Root.get("/AcroForm")
    except Exception:
        return None


def xfa_entry(pdf: pikepdf.Pdf):
    """The `/AcroForm` `/XFA` value, or None. LENIENT.

    Answers one question — "is there a packet source to read?" — for the
    callers that act on the packets or do nothing. An observer asking what the
    document DECLARES reads `inspect` instead.
    """
    acro = acroform(pdf)
    if not isinstance(acro, pikepdf.Dictionary):
        return None
    try:
        entry = acro.get("/XFA")
    except Exception:
        return None
    if isinstance(entry, (pikepdf.Array, pikepdf.Stream)):
        return entry
    return None


def xfa_entry_checked(pdf: pikepdf.Pdf) -> tuple[str, object]:
    """`(state, entry)` where state separates absent from unreadable.

    ISO 32000-2 Annex K gives `/XFA` exactly two spellings: a stream, or an
    array of alternating name/stream pairs. Anything else — a number, an array
    whose odd slots are not streams, a stream whose bytes will not decode — is
    MALFORMED: the key is present and this build cannot read what it holds.

    Every packet stream is read here, because a chain that will not unfilter
    fails at the read and nowhere earlier.
    """
    acro = acroform(pdf)
    if not isinstance(acro, pikepdf.Dictionary):
        return ABSENT, None
    try:
        entry = acro.get("/XFA")
    except Exception:
        return MALFORMED, None
    if entry is None:
        return ABSENT, None
    if isinstance(entry, pikepdf.Stream):
        try:
            entry.read_bytes()
        except Exception:
            return MALFORMED, entry
        return PRESENT, entry
    if not isinstance(entry, pikepdf.Array):
        return MALFORMED, entry
    if len(entry) == 0 or len(entry) % 2 != 0:
        return MALFORMED, entry
    for i in range(0, len(entry), 2):
        stream = entry[i + 1]
        if not isinstance(stream, pikepdf.Stream):
            return MALFORMED, entry
        try:
            stream.read_bytes()
        except Exception:
            return MALFORMED, entry
    return PRESENT, entry


def packets(entry) -> list[tuple[str, object]]:
    """(name, stream) pairs from either `/XFA` spelling.

    The array spelling also carries preamble/postamble entries whose names are
    the `xdp:xdp` open and close tags; they are returned like any other pair
    and selected by name, never by position.
    """
    if isinstance(entry, pikepdf.Stream):
        return [("xdp:xdp", entry)]
    if not isinstance(entry, pikepdf.Array):
        return []
    out: list[tuple[str, object]] = []
    for i in range(0, len(entry) - 1, 2):
        name, stream = entry[i], entry[i + 1]
        if isinstance(stream, pikepdf.Stream):
            out.append((str(name), stream))
    return out


def _has_field_shadow(pdf: pikepdf.Pdf) -> bool:
    acro = acroform(pdf)
    if not isinstance(acro, pikepdf.Dictionary):
        return False
    try:
        fields = acro.get("/Fields")
    except Exception:
        return False
    return isinstance(fields, pikepdf.Array) and len(fields) > 0


def needs_rendering(pdf: pikepdf.Pdf) -> bool:
    """Catalog `NeedsRendering` (ISO 32000-2 Table 29); absent means false."""
    try:
        value = pdf.Root.get("/NeedsRendering")
    except Exception:
        return False
    return bool(value) if value is not None else False


def classify(pdf: pikepdf.Pdf) -> str:
    """`none`, `static` or `dynamic` for this document's form."""
    if xfa_entry(pdf) is None:
        return NONE
    if needs_rendering(pdf):
        return DYNAMIC
    if not _has_field_shadow(pdf):
        # An XFA form whose fields exist only in the XML has nothing to fill
        # through the PDF field objects Annex K requires a fillable form to
        # carry, so it is dynamic for every purpose this engine has.
        return DYNAMIC
    return STATIC


def datasets_stream(pdf: pikepdf.Pdf):
    """The stream carrying the datasets packet, or None.

    For the single-stream spelling the whole `xdp:xdp` stream is returned:
    the datasets element is located inside it by the parser, and an edit is a
    byte splice either way.
    """
    entry = xfa_entry(pdf)
    if entry is None:
        return None
    found = packets(entry)
    for name, stream in found:
        if name == "datasets":
            return stream
    # A wrapper in a segmented array is only its opening fragment, not an
    # alternate datasets document. Only the single whole-resource spelling
    # may be parsed to locate an embedded datasets element.
    if len(found) == 1 and found[0][0] == "xdp:xdp":
        return found[0][1]
    return None


def has_authored_logic(
    pdf: pikepdf.Pdf,
    *,
    read_stream: Callable[[object], bytes] | None = None,
    take_item: Callable[[], None] | None = None,
) -> bool:
    """Whether the template authors calculations or validations.

    XFA calculations are FormCalc or XFA-scoped JavaScript running against the
    XFA object model; this engine has neither, and executing the AcroForm
    scripting host against them would compute numbers no other reader
    computes. The presence is REPORTED so the refusal is by name.

    Identity is the element's, not a spelling of it. The elements are found by
    namespace and local name through the same bounded reader the strict
    classification uses, because the question "does this template author
    logic" has one answer per resource however the resource is spelled: a
    prefix the author chose, a UTF-16 encoding, and a split wrapper sequence
    are three spellings of one document, and a search for the bytes
    `<calculate` answers it correctly for exactly one of them.

    Raises `AuthoredLogicUnreadable` when the resource will not read. A
    template nobody parsed has not been shown to author nothing.

    THE ENTRANCE IS STRICT, not `xfa_entry`. The lenient entrance answers "is
    there a packet source to read?", and it answers None for a `/XFA` holding
    a number and for an `/AcroForm` that is not a dictionary — which is the
    right answer for a caller that reads packets or does nothing, and the
    wrong one here: returning false for those says the template authors no
    logic, about a declaration nobody could read. Presence and unreadability
    are different answers, so this asks the reading that separates them.
    """
    try:
        acro = pdf.Root.get("/AcroForm")
    except Exception:
        raise AuthoredLogicUnreadable(SHAPE_ACROFORM_UNREADABLE) from None
    if acro is None:
        return False
    if not isinstance(acro, pikepdf.Dictionary):
        raise AuthoredLogicUnreadable(SHAPE_ACROFORM_TYPE)
    shape, entry, resource = _checked_entry(acro, read_stream, take_item)
    if shape:
        raise AuthoredLogicUnreadable(shape)
    if entry is None:
        return False
    for element in resource.root.iter():
        tag = element.tag
        if not isinstance(tag, str) or not tag.startswith("{"):
            continue
        namespace, _, local = tag[1:].partition("}")
        if local in AUTHORED_LOGIC_ELEMENTS and namespace.startswith(
            TEMPLATE_NAMESPACE_PREFIX
        ):
            return True
    return False
