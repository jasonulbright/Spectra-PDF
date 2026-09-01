"""The one document write, with a content-derived file identifier."""

import re
from typing import NamedTuple
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


_PERMISSION_NAMES = (
    "accessibility",
    "extract",
    "modify_annotation",
    "modify_assembly",
    "modify_form",
    "modify_other",
    "print_lowres",
    "print_highres",
)

_AES_METHODS = ("aes", "aesv3")


class EncryptionDescriptor(NamedTuple):
    """Everything about a document's protection that a rewrite must reproduce.

    One derivation, consumed by both the re-encryption and the compatibility
    comparison. A characteristic derived twice drifts: a comparison that read
    only the stream cipher once let a document whose strings use a different
    cipher merge with one whose strings do not, and the output took whichever
    source came first.
    """

    revision: int
    version: int
    bits: int
    stream_method: str
    string_method: str
    file_method: str
    encrypt_metadata: bool
    permissions: tuple


def _method_name(method) -> str:
    return str(method).rsplit(".", 1)[-1]


def _descriptor(pdf):
    """`pdf`'s `EncryptionDescriptor`, or None when it is not encrypted.

    ISO 32000-2 Table 20: `/CF`, `/StmF`, `/StrF` and `/EFF` are meaningful
    only when `/V` is 4 or 5, so below that there are no crypt filters to read
    and the document is RC4 by construction (7.6.3.1). qpdf reports "none" for
    all three there, which is the same word it reports for a `/V` 4 document
    whose default filter is `/Identity` — two very different documents. The
    sub-4 case is canonicalized to "rc4" so the word "none" always means
    "passed through unencrypted".

    `/EFF` absent means embedded file streams follow `/StmF`; qpdf resolves
    that default before reporting `file_method`.
    """
    enc = _standard_encrypt_dict(pdf)
    if enc is None:
        return None
    info = pdf.encryption
    revision = int(info.R)
    version = int(info.V)
    methods = (
        _method_name(info.stream_method),
        _method_name(info.string_method),
        _method_name(info.file_method),
    )
    if version < 4:
        methods = ("rc4", "rc4", "rc4")
    return EncryptionDescriptor(
        revision=revision,
        version=version,
        bits=int(info.bits),
        stream_method=methods[0],
        string_method=methods[1],
        file_method=methods[2],
        encrypt_metadata=_effective_encrypt_metadata(enc, revision),
        permissions=tuple(bool(getattr(pdf.allow, name)) for name in _PERMISSION_NAMES),
    )


def _reproducible_shape(revision: int, aes: bool):
    """The `(version, bits, method)` `pikepdf.Encryption(R=…, aes=…)` writes.

    None where that combination is not one pikepdf will write at all. The
    table is the whole expressive range of the writer: one cipher for streams,
    strings and embedded files, at the key length its revision fixes.

    R5 is an extension ISO 32000-2 never adopted and pikepdf warns about
    writing, but it writes it faithfully; refusing a document whose protection
    is reproducible exactly would cost the user their permissions for nothing.
    """
    if revision == 2:
        return None if aes else (1, 40, "rc4")
    if revision == 3:
        return None if aes else (2, 128, "rc4")
    if revision == 4:
        return (4, 128, "aes" if aes else "rc4")
    if revision in (5, 6):
        return (5, 256, "aesv3") if aes else None
    return None


def _refuse_unrepresentable_encryption(descriptor: EncryptionDescriptor) -> bool:
    """The `aes` flag that reproduces `descriptor`, or a refusal by name.

    The writer takes one cipher and one revision; a document is free to be
    more specific than that. Every way it can be — a different crypt filter
    per data class, a key length its revision does not fix, a revision the
    writer will not emit, an encrypted-metadata policy the cipher cannot
    carry — is checked here, BEFORE the output is opened, so a document whose
    protection cannot be written back leaves no file behind at all.
    """
    if not (
        descriptor.stream_method
        == descriptor.string_method
        == descriptor.file_method
    ):
        raise ValueError(
            "This document's encryption cannot be kept through this operation: it "
            "protects its streams, strings and embedded files with different "
            "ciphers, and a rewritten copy can carry only one cipher for all "
            "three. Decrypt the document first if you want an unprotected copy."
        )
    aes = descriptor.stream_method in _AES_METHODS
    shape = _reproducible_shape(descriptor.revision, aes)
    if shape != (descriptor.version, descriptor.bits, descriptor.stream_method):
        raise ValueError(
            "This document's encryption cannot be kept through this operation: its "
            "encryption version, cipher and key length are a combination that "
            "cannot be written back exactly, and a rewritten copy would change "
            "the strength of its protection. Decrypt the document first if you "
            "want an unprotected copy."
        )
    if descriptor.encrypt_metadata and not aes:
        raise ValueError(
            "This document's encryption cannot be kept through this operation: it "
            "encrypts its metadata under a cipher that cannot be written back "
            "with that setting, and a rewritten copy would expose metadata this "
            "document keeps encrypted. Decrypt the document first if you want an "
            "unprotected copy."
        )
    return aes


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
    descriptor = _descriptor(pdf)
    if descriptor is None:
        return None

    _refuse_unreproducible_encryption(*_encryption_reproducibility(pdf))
    aes = _refuse_unrepresentable_encryption(descriptor)

    return pikepdf.Encryption(
        owner="",
        user="",
        R=descriptor.revision,
        aes=aes,
        allow=pikepdf.Permissions(
            **dict(zip(_PERMISSION_NAMES, descriptor.permissions))
        ),
        metadata=descriptor.encrypt_metadata,
    )


def encryption_profile(pdf):
    """A hashable summary of `pdf`'s protection, for comparing two sources.

    The descriptor IS the summary: it is exactly the set of characteristics
    `source_encryption` reproduces, so two sources that compare equal are ones
    the same `pikepdf.Encryption` reproduces and an operation that can carry
    only one protection may adopt either. Deriving a second, narrower summary
    here is what once let a difference the rewrite recreates be taken from
    whichever source was reached first.
    """
    return _descriptor(pdf)


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
