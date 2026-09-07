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
SHAPE_FIELDS_TYPE = "acroform-fields-type"
SHAPE_FIELD_ENTRY_TYPE = "acroform-field-entry-type"
SHAPE_FIELD_ENTRY_REFERENCE = "acroform-field-entry-reference"
SHAPE_NEEDS_RENDERING_TYPE = "needs-rendering-type"

_MAX_STRICT_PACKET_BYTES = 64 * 1024 * 1024


class InspectionInterrupted(Exception):
    """A caller-owned resource limit interrupted strict inspection."""


class _PacketShapeError(Exception):
    """The packet is not safe, bounded XML; never crosses the engine API."""


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


def _packet_root(data: bytes):
    """Parse one packet without allowing a document type or entity grammar."""
    if len(data) > _MAX_STRICT_PACKET_BYTES:
        raise _PacketShapeError
    parser = etree.XMLParser(
        resolve_entities=False,
        load_dtd=False,
        no_network=True,
        recover=False,
        huge_tree=False,
    )
    root = etree.fromstring(data, parser=parser)
    # Inspect parsed metadata rather than byte-searching for an ASCII spelling:
    # a valid XFA packet may be UTF-16, where every markup character is encoded
    # with an adjacent NUL. Entity resolution and network reads were already
    # disabled above, so reaching this refusal never executes its grammar.
    if root.getroottree().docinfo.doctype:
        raise _PacketShapeError
    return root


def _checked_entry(
    acro,
    read_stream: Callable[[object], bytes] | None = None,
    take_item: Callable[[], None] | None = None,
) -> tuple[str, object]:
    """`(shape, entry)` for `/XFA`; shape is "" when the value is well formed.

    Validated against ISO 32000-2 Table 224, which gives `XFA` as "stream or
    array", and Annex K.2, which gives the array spelling exactly: a packet is
    a pair of a string and a stream, the string naming the XML element and the
    stream holding that element's complete text. Both slots of every pair are
    therefore typed, and a slot count that is not even is not a sequence of
    pairs at all.

    Every packet stream is READ here, because a filter chain that will not
    unfilter fails at the read and nowhere earlier.
    """
    try:
        entry = acro.get("/XFA")
    except Exception:
        return SHAPE_XFA_UNREADABLE, None
    if entry is None:
        return "", None
    reader = read_stream or (lambda stream: stream.read_bytes())
    charge = take_item or (lambda: None)
    if isinstance(entry, pikepdf.Stream):
        try:
            charge()
            data = reader(entry)
        except InspectionInterrupted:
            raise
        except Exception:
            return SHAPE_PACKET_UNREADABLE, entry
        try:
            root = _packet_root(data)
        except (etree.XMLSyntaxError, _PacketShapeError):
            return SHAPE_PACKET_XML, entry
        if str(root.tag).split("}")[-1].split(":")[-1] != "xdp":
            return SHAPE_XDP_ROOT, entry
        return "", entry
    if not isinstance(entry, pikepdf.Array):
        return SHAPE_XFA_TYPE, entry
    try:
        length = len(entry)
    except Exception:
        return SHAPE_XFA_UNREADABLE, entry
    if length == 0 or length % 2 != 0:
        return SHAPE_XFA_ARRAY_LENGTH, entry
    for i in range(0, length, 2):
        try:
            charge()
            name, stream = entry[i], entry[i + 1]
        except InspectionInterrupted:
            raise
        except Exception:
            return SHAPE_XFA_UNREADABLE, entry
        # The name slot is validated, never coerced: `str()` renders a number
        # as readily as a name, so a slot holding one reads back as a packet
        # called "42" and the array passes for well formed.
        if not isinstance(name, pikepdf.String):
            return SHAPE_PACKET_NAME_TYPE, entry
        if not isinstance(stream, pikepdf.Stream):
            return SHAPE_PACKET_STREAM_TYPE, entry
        try:
            _packet_root(reader(stream))
        except InspectionInterrupted:
            raise
        except (etree.XMLSyntaxError, _PacketShapeError):
            return SHAPE_PACKET_XML, entry
        except Exception:
            return SHAPE_PACKET_UNREADABLE, entry
    return "", entry


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

    shape, entry = _checked_entry(acro, read_stream, take_item)
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
    if rendering is True:
        return Inspection(DYNAMIC, "", entry)

    try:
        fields = acro.get("/Fields")
    except Exception:
        return _bad(SHAPE_FIELDS_TYPE, entry)
    if fields is None:
        shadow = False
    elif isinstance(fields, pikepdf.Array):
        try:
            shadow = len(fields) > 0
            for field in fields:
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
    for name, stream in found:
        if name == "xdp:xdp":
            return stream
    return None


def has_authored_logic(pdf: pikepdf.Pdf) -> bool:
    """Whether the template packet authors calculations or validations.

    XFA calculations are FormCalc or XFA-scoped JavaScript running against the
    XFA object model; this engine has neither, and executing the AcroForm
    scripting host against them would compute numbers no other reader
    computes. The presence is REPORTED so the refusal is by name.
    """
    entry = xfa_entry(pdf)
    if entry is None:
        return False
    for name, stream in packets(entry):
        if name not in ("template", "xdp:xdp"):
            continue
        try:
            body = stream.read_bytes()
        except Exception:
            continue
        if b"<calculate" in body or b"<validate" in body:
            return True
    return False
