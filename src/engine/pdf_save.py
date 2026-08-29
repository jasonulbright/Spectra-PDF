"""The one document write, with a content-derived file identifier."""

import pikepdf

_SENTINEL = object()


def _standard_encrypt_dict(pdf):
    """The document's `/Encrypt` dict, or None when it is not encrypted."""
    if not getattr(pdf, "is_encrypted", False):
        return None
    try:
        return pdf.trailer.get("/Encrypt")
    except Exception:
        return None


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

    filter_name = enc.get("/Filter")
    if filter_name is not None and str(filter_name) != "/Standard":
        raise ValueError(
            "This document's encryption cannot be kept through this operation: it "
            "is encrypted to certificate recipients, whose list cannot be "
            "rewritten. Decrypt the document first if you want an unprotected copy."
        )

    if not pdf.owner_password_matched:
        raise ValueError(
            "This document's encryption cannot be kept through this operation: its "
            "permissions are held by an owner password, which cannot be read back "
            "out of the file. Open it with that password, or decrypt the document "
            "first if you want an unprotected copy."
        )

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
    kwargs = dict(
        owner="",
        user="",
        R=revision,
        aes=revision >= 5 or str(info.stream_method).endswith("aes"),
        allow=allow,
    )
    # R2/R3 have no metadata-encryption switch at all, and pikepdf refuses the
    # default rather than ignoring it.
    if revision < 4:
        kwargs["metadata"] = False
    else:
        encrypt_metadata = enc.get("/EncryptMetadata")
        if encrypt_metadata is not None:
            kwargs["metadata"] = bool(encrypt_metadata)
    return pikepdf.Encryption(**kwargs)


def encryption_profile(pdf):
    """A hashable summary of `pdf`'s protection, for comparing two sources."""
    enc = _standard_encrypt_dict(pdf)
    if enc is None:
        return None
    info = pdf.encryption
    return (
        int(info.R),
        str(info.stream_method),
        bool(pdf.allow.accessibility),
        bool(pdf.allow.extract),
        bool(pdf.allow.modify_annotation),
        bool(pdf.allow.modify_assembly),
        bool(pdf.allow.modify_form),
        bool(pdf.allow.modify_other),
        bool(pdf.allow.print_lowres),
        bool(pdf.allow.print_highres),
    )


def refuse_encrypted_source(file) -> None:
    """Refuse an encrypted document.

    For a rewrite that runs OUTSIDE pikepdf — a renderer subprocess reads the
    document and writes a new one — where the output cannot carry the source's
    protection by construction. Silently handing back an unprotected copy is
    the failure this prevents.
    """
    try:
        with pikepdf.open(file) as pdf:
            encrypted = _standard_encrypt_dict(pdf) is not None
    except pikepdf.PasswordError:
        raise
    except Exception:
        return
    if encrypted:
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
    pdf.save(target, **kwargs)
