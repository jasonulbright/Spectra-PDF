"""Renderer-authored edits of a document opened with its user password.

The page tier, the canvas annotation builder and field creation are written
by the renderer with pdf-lib, which reads no encrypted file and writes no
encryption. For a document opened with its USER password the working copy
stays encrypted (ISO 32000-2 7.6.4.1), and the owner password needed to
author a protection is not held. These doors bracket the renderer's own
builder: `sealed_plaintext` hands it the document's decrypted bytes, and
`sealed_reseal` grafts the builder's output into the working copy's own
object graph and writes it with that copy's /Encrypt (qpdf copies /Encrypt,
/O, /U, /P and the key-bearing /ID[0]), so both passwords still open it and
the /P bits are unchanged.

The decrypted bytes travel only in the response and the request; nothing
here writes them to a file.
"""

import base64
import io
import os

import pikepdf

from engine.credentials import (
    PERMISSIONS_HELD,
    _decoded_permissions,
    open_pdf,
    opened_with_user_password,
)
from engine.inplace import is_same_file
from engine.pdf_save import save_pdf

#: What each renderer write class needs from /P (ISO 32000-2 Table 22):
#: bit 11 assembles pages even where bit 4 is clear; creating a field needs
#: bits 4 and 6 together.
_CAPABILITIES = {
    "pageTier": lambda p: p.get("assemble") or p.get("modify"),
    "commentTier": lambda p: p.get("annotate"),
    "formAuthoring": lambda p: p.get("modify") and p.get("annotate"),
}


class SealedEditMisuse(RuntimeError):
    """A sealed-edit door called for a document it does not serve."""


def _require(path: str, capabilities) -> list[str]:
    from engine.credentials import document_permissions

    if not opened_with_user_password(path):
        raise SealedEditMisuse("sealed edits serve documents opened with their user password only")
    names = [capabilities] if isinstance(capabilities, str) else list(capabilities or [])
    if not names or any(name not in _CAPABILITIES for name in names):
        raise SealedEditMisuse("unknown sealed edit capability")
    permissions = document_permissions(path)["permissions"]
    for name in names:
        if not _CAPABILITIES[name](permissions):
            raise PermissionError(PERMISSIONS_HELD)
    return names


def _first_document_id(pdf) -> bytes | None:
    ids = pdf.trailer.get("/ID")
    if not isinstance(ids, pikepdf.Array) or len(ids) < 1:
        return None
    first = ids[0]
    if not isinstance(first, pikepdf.String):
        return None
    return bytes(first)


def sealed_plaintext(path: str, capabilities, data: str | None = None) -> dict:
    """The decrypted bytes of the user-opened working copy at `path`, for the
    renderer's builder, base64 in `data`.

    `data` (base64) names other encrypted bytes of the same document, such as
    a staged rewrite not yet published, to decrypt with `path`'s credential
    instead of the file. Its first trailer /ID must match the working copy so
    another file encrypted with the same password cannot inherit its /P
    permissions. Refused unless the document's /P bits allow every one of
    `capabilities` ("pageTier", "commentTier", "formAuthoring")."""
    names = _require(path, capabilities)
    if data is None:
        source = path
        pdf_context = open_pdf(source)
    else:
        source = io.BytesIO(base64.b64decode(data, validate=True))
        with open_pdf(path) as working:
            expected_id = _first_document_id(working)
        if expected_id is None:
            raise SealedEditMisuse(
                "the supplied bytes cannot be matched to a document without a first trailer ID"
            )
        pdf_context = open_pdf(source, document=path)
    with pdf_context as pdf:
        if data is not None:
            if not pdf.is_encrypted or _first_document_id(pdf) != expected_id:
                raise SealedEditMisuse("the supplied bytes do not identify the same document")
            permissions = _decoded_permissions(pdf)
            for name in names:
                if not _CAPABILITIES[name](permissions):
                    raise PermissionError(PERMISSIONS_HELD)
        out = io.BytesIO()
        # Plaintext for the builder only; save_pdf would keep the encryption.
        pdf.save(out, encryption=False, deterministic_id=True)
    return {"data": base64.b64encode(out.getvalue()).decode("ascii")}


def _graft(target, built) -> None:
    """Make `target`'s catalog and page tree the builder's.

    qpdf never copies a page tree as a foreign object, and copies a page that
    another object references as a plain duplicate unless the page itself was
    copied first. The pages are therefore appended first, and every other
    catalog entry after them, so /AcroForm widgets, structure /Pg, outline
    and link destinations resolve to the pages the file holds."""
    old = len(target.pages)
    for page in built.pages:
        target.pages.append(page)
    for _ in range(old):
        del target.pages[0]
    root = target.Root
    for key in [k for k in root.keys() if k not in ("/Pages", "/Type") and k not in built.Root]:
        del root[key]
    for key, value in built.Root.items():
        if key in ("/Pages", "/Type"):
            continue
        root[key] = _foreign(target, built, value)


def _foreign(target, built, value):
    """`value` of `built` as an object of `target`. copy_foreign takes only
    an indirect object, so a direct container is made indirect first; its
    nested references are copied with it."""
    if isinstance(value, (pikepdf.Dictionary, pikepdf.Array, pikepdf.Stream)):
        if not value.is_indirect:
            value = built.make_indirect(value)
        return target.copy_foreign(value)
    return value


def sealed_reseal(path: str, data: str, output: str, capabilities) -> dict:
    """Write the builder's plaintext output `data` (base64) to `output` under
    the protection of the user-opened working copy at `path`.

    The /P check is on the declared `capabilities`, not on a diff of `data`
    against the working copy: the caller is the renderer that already holds
    the password and the decrypted bytes, the same trust boundary as every
    other engine request, so a diff would add no protection. The renderer
    gates each edit by /P before it reaches the page tier.

    The working copy's catalog and document information are replaced by the
    builder's; every object only the old graph reached is dropped by the
    writer. `output` is lent the credential, so the staged file reopens by
    path. A result with no pages is refused and nothing is written."""
    _require(path, capabilities)
    if os.path.exists(output) and is_same_file(path, output):
        raise SealedEditMisuse("the sealed edit output must be a stage, never the working copy")
    plain = base64.b64decode(data, validate=True)
    with pikepdf.open(io.BytesIO(plain)) as built:
        if built.is_encrypted:
            raise SealedEditMisuse("the builder output is already encrypted")
        if len(built.pages) == 0:
            raise ValueError("the edit leaves the document with no pages, so it was not written")
        with open_pdf(path) as target:
            if not getattr(target, "_spectra_preserve_encryption", False):
                raise SealedEditMisuse("sealed edits serve documents opened with their user password only")
            _graft(target, built)
            if "/Info" in built.trailer:
                target.trailer.Info = _foreign(target, built, built.trailer.Info)
            elif "/Info" in target.trailer:
                del target.trailer.Info
            pages = len(target.pages)
            save_pdf(target, output, min_version=built.pdf_version)
    return {"output": output, "pages": pages}
