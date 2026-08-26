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
"""

import pikepdf

NONE = "none"
STATIC = "static"
DYNAMIC = "dynamic"

# Packets that declare bindings to external data services. They are never
# read and never acted on: the app performs no network access, so a document
# that names a data source gets its data from the document alone.
NEVER_READ = ("connectionSet", "sourceSet")


def acroform(pdf: pikepdf.Pdf):
    try:
        return pdf.Root.get("/AcroForm")
    except Exception:
        return None


def xfa_entry(pdf: pikepdf.Pdf):
    """The `/AcroForm` `/XFA` value, or None."""
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
