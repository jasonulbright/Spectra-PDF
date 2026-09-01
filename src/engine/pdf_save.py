"""The one document write, with a content-derived file identifier."""

import re
from xml.etree import ElementTree

import pikepdf

_SENTINEL = object()

ABSENT = "absent"
UNREADABLE = "unreadable"

_PDFA_ID_NS = "http://www.aiim.org/pdfa/ns/id/"

_XML_DECL_ENCODING = re.compile(
    rb"""<\?xml[^>]*?\bencoding\s*=\s*["']([A-Za-z0-9._-]+)["']"""
)

_BOMS = (
    (b"\x00\x00\xfe\xff", "utf-32-be"),
    (b"\xff\xfe\x00\x00", "utf-32-le"),
    (b"\xef\xbb\xbf", "utf-8-sig"),
    (b"\xfe\xff", "utf-16-be"),
    (b"\xff\xfe", "utf-16-le"),
)

_PDFAID_PART_TEXT = re.compile(
    r"""[\w.-]+:part\s*=\s*["'](\d+)["']|<[\w.-]+:part>\s*(\d+)\s*</[\w.-]+:part>"""
)


def _decode_xmp(raw: bytes):
    """The XMP packet as text, or None when its encoding cannot be settled.

    An XMP packet is not ASCII by construction: ISO 16684-1 admits UTF-8,
    UTF-16 and UTF-32, and the wide encodings carry a byte order mark. A byte
    regex run over UTF-16 matches nothing, which reads as "no claim" — the
    same answer an unmarked file gives, and the reason this returns None for
    an undecidable packet rather than an empty string.
    """
    for bom, encoding in _BOMS:
        if raw.startswith(bom):
            try:
                return raw.decode(encoding)
            except (UnicodeDecodeError, LookupError):
                return None
    declared = _XML_DECL_ENCODING.search(raw[:512])
    if declared is not None:
        try:
            return raw.decode(declared.group(1).decode("ascii"))
        except (UnicodeDecodeError, LookupError, AttributeError):
            return None
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        return None


_XML_PROLOG = re.compile(r"^\s*<\?xml\b[^>]*\?>")


def _parseable(text: str) -> str:
    """`text` with its XML declaration removed.

    The declaration names an encoding, and the encoding has already been
    applied by the time the packet is text; a parser handed both refuses the
    contradiction rather than ignoring it.
    """
    return _XML_PROLOG.sub("", text, count=1)


def _part_from_tree(text: str):
    """The `pdfaid:part` in the packet's XML, `UNREADABLE`, or None.

    Namespace-qualified rather than prefix-matched: the prefix is the
    document's to choose, and a packet that binds the PDF/A identification
    namespace to any other prefix still declares a part. None means the
    packet did not parse or carries no part; `UNREADABLE` means it carries
    one that is not a number, which is a claim nobody can act on.
    """
    try:
        root = ElementTree.fromstring(_parseable(text))
    except (ElementTree.ParseError, ValueError):
        return None
    qualified = f"{{{_PDFA_ID_NS}}}part"
    for node in root.iter():
        value = node.get(qualified)
        if value is None and node.tag == qualified:
            value = node.text or ""
        if value is None:
            continue
        try:
            return int(value.strip())
        except ValueError:
            return UNREADABLE
    return None


def pdfa_claim(pdf):
    """The document's PDF/A part claim: an int, `ABSENT`, or `UNREADABLE`.

    `UNREADABLE` is a metadata stream that exists and could not be read to a
    verdict — undecodable bytes, or XML that no parse and no scan resolves.
    Callers that relax a constraint on the strength of "not PDF/A" must treat
    it as a claim, not as its absence.
    """
    try:
        meta = pdf.Root.get("/Metadata")
        if meta is None:
            return ABSENT
        raw = bytes(meta.read_bytes())
    except Exception:
        return UNREADABLE
    text = _decode_xmp(raw)
    if text is None:
        return UNREADABLE
    part = _part_from_tree(text)
    if part is not None:
        return part
    match = _PDFAID_PART_TEXT.search(text)
    if match is None:
        # A packet that parsed and declares no part is a document that is not
        # PDF/A; one that did neither cannot be reasoned about.
        return ABSENT if _parses(text) else UNREADABLE
    try:
        return int(match.group(1) or match.group(2))
    except (TypeError, ValueError):
        return UNREADABLE


def _parses(text: str) -> bool:
    try:
        ElementTree.fromstring(_parseable(text))
    except (ElementTree.ParseError, ValueError):
        return False
    return True


def declared_pdfa_part(pdf):
    """The PDF/A part the document claims in its XMP, or None."""
    claim = pdfa_claim(pdf)
    return claim if isinstance(claim, int) else None


def _conformance_object_stream_mode(pdf, requested):
    """The object-stream mode a PDF/A claim permits.

    A PDF/A-1 file is a PDF 1.4 file: object streams and the cross-reference
    stream they force do not exist below PDF 1.5, and generating them turns a
    conformant input into a non-conformant output with no other change to it.
    Later parts are built on PDF 1.7/2.0 and permit both.

    Metadata that cannot be read to a verdict is treated as PDF/A-1: the cost
    of disabling object streams on a file that turns out not to be PDF/A is
    size, and the cost of the opposite is a conformance claim broken by a
    write that changed nothing else.
    """
    claim = pdfa_claim(pdf)
    if claim != 1 and claim != UNREADABLE:
        return requested
    if requested in (None, pikepdf.ObjectStreamMode.disable):
        return requested
    return pikepdf.ObjectStreamMode.disable


def _standard_encrypt_dict(pdf):
    """The document's `/Encrypt` dict, or None when it is not encrypted."""
    if not getattr(pdf, "is_encrypted", False):
        return None
    try:
        return pdf.trailer.get("/Encrypt")
    except Exception:
        return None


def _effective_encrypt_metadata(enc, revision: int) -> bool:
    """Whether `enc` encrypts the document's metadata, as a decided boolean.

    R2/R3 have no metadata-encryption switch, so metadata is never encrypted
    there. From R4 the switch is optional and its absence means True.

    Both the re-encryption and the compatibility profile read the policy from
    here: a source whose metadata is exposed and one whose metadata is
    encrypted must not compare equal, or a merge adopts whichever came first.
    """
    if revision < 4:
        return False
    value = enc.get("/EncryptMetadata")
    if value is None:
        return True
    return bool(value)


def _encryption_reproducibility(pdf):
    """`(certificate, owner_gated)` for `pdf`, or None when it is unencrypted.

    `certificate` — the recipient list cannot be reauthored. `owner_gated` —
    the owner password is not empty, so it cannot be read back out of the
    file. Either one makes the source's own protection unreproducible; the
    facts are returned rather than raised so a caller that must read them
    inside a `try` can refuse outside it.
    """
    enc = _standard_encrypt_dict(pdf)
    if enc is None:
        return None
    filter_name = enc.get("/Filter")
    certificate = filter_name is not None and str(filter_name) != "/Standard"
    return certificate, not pdf.owner_password_matched


def _refuse_unreproducible_encryption(certificate: bool, owner_gated: bool) -> None:
    """Refuse where the source's protection cannot be reauthored at all.

    Consent cannot reach these two: no answer the user gives supplies a
    password nobody holds or a recipient list nobody can rewrite.
    """
    if certificate:
        raise ValueError(
            "This document's encryption cannot be kept through this operation: it "
            "is encrypted to certificate recipients, whose list cannot be "
            "rewritten. Decrypt the document first if you want an unprotected copy."
        )
    if owner_gated:
        raise ValueError(
            "This document's encryption cannot be kept through this operation: its "
            "permissions are held by an owner password, which cannot be read back "
            "out of the file. Open it with that password, or decrypt the document "
            "first if you want an unprotected copy."
        )


def source_encryption(pdf):
    """The `pikepdf.Encryption` that re-applies `pdf`'s own protection.

    None when the document is not encrypted. qpdf decrypts transparently on
    open, so a rewrite that does not pass this back writes a DECRYPTED copy:
    the permission bits the author set are gone from the output and nothing
    says so.

    The passwords themselves cannot be read back out of a document, so a
    faithful re-encryption is only possible where they are empty. An
    owner-password-gated document therefore refuses rather than replacing
    that password with one nobody chose, and a document encrypted to
    certificates refuses because its recipient list cannot be reauthored.

    The refusals name no operation: the operation would have to reach the
    message as an English fragment interpolated into a translated sentence,
    and the caller is what the user just asked for anyway.
    """
    enc = _standard_encrypt_dict(pdf)
    if enc is None:
        return None

    _refuse_unreproducible_encryption(*_encryption_reproducibility(pdf))

    info = pdf.encryption
    revision = int(info.R)
    allow = pikepdf.Permissions(
        accessibility=bool(pdf.allow.accessibility),
        extract=bool(pdf.allow.extract),
        modify_annotation=bool(pdf.allow.modify_annotation),
        modify_assembly=bool(pdf.allow.modify_assembly),
        modify_form=bool(pdf.allow.modify_form),
        modify_other=bool(pdf.allow.modify_other),
        print_lowres=bool(pdf.allow.print_lowres),
        print_highres=bool(pdf.allow.print_highres),
    )
    return pikepdf.Encryption(
        owner="",
        user="",
        R=revision,
        aes=revision >= 5 or str(info.stream_method).endswith("aes"),
        allow=allow,
        metadata=_effective_encrypt_metadata(enc, revision),
    )


def encryption_profile(pdf):
    """A hashable summary of `pdf`'s protection, for comparing two sources.

    Every characteristic `source_encryption` recreates appears here. Two
    sources that compare equal are ones whose protection the same
    `pikepdf.Encryption` reproduces, so an operation that can carry only one
    protection may adopt either; a characteristic recreated but not compared
    would be silently taken from whichever source is reached first.
    """
    enc = _standard_encrypt_dict(pdf)
    if enc is None:
        return None
    info = pdf.encryption
    revision = int(info.R)
    return (
        revision,
        str(info.stream_method),
        _effective_encrypt_metadata(enc, revision),
        bool(pdf.allow.accessibility),
        bool(pdf.allow.extract),
        bool(pdf.allow.modify_annotation),
        bool(pdf.allow.modify_assembly),
        bool(pdf.allow.modify_form),
        bool(pdf.allow.modify_other),
        bool(pdf.allow.print_lowres),
        bool(pdf.allow.print_highres),
    )


def refuse_encrypted_source(file, *, drop_encryption: bool = False) -> bool:
    """Refuse an encrypted document, or drop its protection by consent.

    For a rewrite that runs OUTSIDE pikepdf — a renderer subprocess reads the
    document and writes a new one — where the output cannot carry the source's
    protection by construction. Silently handing back an unprotected copy is
    the failure this prevents.

    `drop_encryption` is the CONSENT hatch: the caller has told the user that
    the operation cannot keep the document's protection and the user chose to
    proceed anyway. It reaches only the case the operation can actually
    perform — an unreproducible source (certificate recipients, a non-empty
    owner password) refuses whatever the answer was, because no consent
    supplies the password it would need.

    Returns True when protection was dropped by consent, for the caller to
    report in its result.
    """
    try:
        with pikepdf.open(file) as pdf:
            state = _encryption_reproducibility(pdf)
    except pikepdf.PasswordError:
        raise
    except Exception:
        return False
    if state is None:
        return False
    # Outside the try: the refusals below are the answer, not a read failure.
    _refuse_unreproducible_encryption(*state)
    if drop_encryption:
        return True
    raise ValueError(
        "This document's encryption cannot be kept through this operation, "
        "which will not hand back an unprotected copy of a protected document. "
        "Decrypt it first if that is what you want."
    )


def save_pdf(
    pdf,
    target,
    *,
    encryption_source=_SENTINEL,
    drop_encryption: bool = False,
    **kwargs,
) -> None:
    """Write `pdf` to `target` with a deterministic trailer `/ID`.

    qpdf seeds its default identifier from the wall clock in whole
    seconds, so two writes of identical input produce identical bytes
    only while they fall inside the same second and differ the moment
    they straddle a boundary. Deriving the identifier from the written
    bytes instead makes an operation's output a function of its input.

    A requested object-stream mode is constrained by what the document's own
    PDF/A claim permits (see `_conformance_object_stream_mode`).

    An encrypted output keeps qpdf's default: the encryption key derives
    from the identifier, so an identifier derived from the encrypted
    bytes is not computable and qpdf refuses it.

    Args:
        encryption_source: The document whose encryption the output carries,
            where the graph being written is a NEW document rather than the
            one that was opened (merge, split). Defaults to `pdf` itself.
        drop_encryption: Write an unprotected output from a protected source.
            Only for an operation whose whole purpose is removing protection,
            or one whose output is by construction not the source document.
    """
    if "encryption" not in kwargs and not drop_encryption:
        source = pdf if encryption_source is _SENTINEL else encryption_source
        if source is not None:
            encryption = source_encryption(source)
            if encryption is not None:
                kwargs["encryption"] = encryption
    if not kwargs.get("encryption"):
        kwargs["deterministic_id"] = True
    if "object_stream_mode" in kwargs:
        mode = _conformance_object_stream_mode(pdf, kwargs["object_stream_mode"])
        if mode is None:
            kwargs.pop("object_stream_mode")
        else:
            kwargs["object_stream_mode"] = mode
    pdf.save(target, **kwargs)
