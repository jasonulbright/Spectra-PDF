"""PDF encryption and decryption using pikepdf."""

from pathlib import Path

import pikepdf

from .inplace import is_same_file, staged_write
from engine.pdf_save import save_pdf


def _save(pdf, file: str, output_path: Path, encryption=None) -> None:
    """A same-file write stages beside the document and swaps the directory
    entry, so a write that dies leaves the input whole. The Pdf is closed
    inside the block because the destination cannot be replaced while it is
    held open."""
    kwargs = {} if encryption is None else {"encryption": encryption}
    if is_same_file(file, str(output_path)):
        with staged_write(output_path) as staged:
            save_pdf(pdf, staged, **kwargs)
            pdf.close()
    else:
        save_pdf(pdf, output_path, **kwargs)


# User-facing permission categories → pikepdf.Permissions flags. Accessibility
# (assistive-tech text extraction) is never blocked: preventing a screen reader
# from reading the document is an accessibility failure, not a permission choice.
def _build_permissions(perms: dict | None):
    if perms is None:
        return None  # omit → pikepdf default (everything allowed)

    def allow(key: str) -> bool:
        return bool(perms.get(key, True))

    can_print = allow("print")
    return pikepdf.Permissions(
        accessibility=True,
        extract=allow("copy"),
        modify_annotation=allow("annotate"),
        modify_form=allow("annotate"),
        modify_assembly=allow("modify"),
        modify_other=allow("modify"),
        print_lowres=can_print,
        print_highres=can_print,
    )


def encrypt(
    file: str,
    output: str,
    user_password: str = "",
    owner_password: str = "",
    permissions: dict | None = None,
) -> dict:
    """Encrypt a PDF with AES-256.

    Args:
        file: Input PDF path.
        output: Output PDF path.
        user_password: Password to open the document (empty = no password to view).
        owner_password: Password to modify/print (empty = same as user_password).
        permissions: Owner-permission matrix — a dict of booleans keyed
            {print, copy, modify, annotate} (missing keys default to allowed).
            Omit for "everything allowed". Restrictions are only enforceable
            when an OWNER password gates them, so the caller should set one.
    """
    if not owner_password:
        owner_password = user_password

    allow = _build_permissions(permissions)
    enc_kwargs = dict(owner=owner_password, user=user_password, aes=True, R=6)
    if allow is not None:
        enc_kwargs["allow"] = allow

    with pikepdf.open(file) as pdf:
        output_path = Path(output)
        _save(pdf, file, output_path, encryption=pikepdf.Encryption(**enc_kwargs))

    return {
        "output": str(output_path),
        "encryption": "AES-256",
        "has_user_password": bool(user_password),
        "restricted": permissions is not None,
    }


def grant_accessibility_permission(file: str, output: str) -> dict:
    """Re-save an encrypted document with assistive-technology reading allowed.

    The accessibility permission is a bit in the encryption dictionary, so
    granting it means writing the encryption again — every other permission the
    document declares is carried across unchanged, and so is its revision and
    its cipher: the document is not silently strengthened, weakened, or
    decrypted.

    The passwords cannot be carried across because they cannot be read back, so
    the door only proceeds where they are EMPTY — which `owner_password_matched`
    against the empty password is exactly the test for. A document whose
    restrictions are gated by an owner password refuses and says so, rather than
    replacing that password with one nobody chose or dropping the encryption
    altogether.
    """
    output_path = Path(output)
    with pikepdf.open(file) as pdf:
        if not pdf.is_encrypted:
            raise ValueError(
                "This document is not encrypted, so nothing is stopping assistive "
                "technology from reading it."
            )
        if pdf.allow.accessibility:
            raise ValueError(
                "This document already allows assistive technology to read it."
            )
        if not pdf.owner_password_matched:
            raise RuntimeError(
                "This document's permissions are held by an owner password, which is "
                "needed to change them. Open it with that password first."
            )
        info = pdf.encryption
        revision = int(info.R)
        allow = pikepdf.Permissions(
            accessibility=True,
            extract=bool(pdf.allow.extract),
            modify_annotation=bool(pdf.allow.modify_annotation),
            modify_assembly=bool(pdf.allow.modify_assembly),
            modify_form=bool(pdf.allow.modify_form),
            modify_other=bool(pdf.allow.modify_other),
            print_lowres=bool(pdf.allow.print_lowres),
            print_highres=bool(pdf.allow.print_highres),
        )
        enc_kwargs = dict(
            owner="",
            user="",
            R=revision,
            aes=revision >= 5 or str(info.stream_method).endswith("aes"),
            allow=allow,
        )
        # R2/R3 have no metadata-encryption switch at all, and pikepdf refuses
        # the default rather than ignoring it.
        if revision < 4:
            enc_kwargs["metadata"] = False
        encryption = pikepdf.Encryption(**enc_kwargs)
        _save(pdf, file, output_path, encryption=encryption)
    return {"output": str(output_path), "revision": revision}


def decrypt(file: str, output: str, password: str = "") -> dict:
    """Decrypt a PDF.

    Args:
        file: Input PDF path.
        output: Output PDF path.
        password: Password to unlock the document.
    """
    with pikepdf.open(file, password=password) as pdf:
        output_path = Path(output)
        _save(pdf, file, output_path)

    return {
        "output": str(output_path),
        "decrypted": True,
    }
