"""The one document write, with a content-derived file identifier."""


def save_pdf(pdf, target, **kwargs) -> None:
    """Write `pdf` to `target` with a deterministic trailer `/ID`.

    qpdf seeds its default identifier from the wall clock in whole
    seconds, so two writes of identical input produce identical bytes
    only while they fall inside the same second and differ the moment
    they straddle a boundary. Deriving the identifier from the written
    bytes instead makes an operation's output a function of its input.

    An encrypted output keeps qpdf's default: the encryption key derives
    from the identifier, so an identifier derived from the encrypted
    bytes is not computable and qpdf refuses it.
    """
    if not kwargs.get("encryption"):
        kwargs["deterministic_id"] = True
    pdf.save(target, **kwargs)
