"""PDF encryption and decryption using pikepdf."""

from pathlib import Path

import pikepdf

from .inplace import finish_staged, is_same_file, staging_target
from engine.pdf_save import save_pdf


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
        # pikepdf cannot save over its own open input (engine/inplace.py).
        if is_same_file(file, output):
            staged = staging_target(output_path)
            save_pdf(pdf, staged, encryption=pikepdf.Encryption(**enc_kwargs))
            finish_staged(staged, output_path)
        else:
            save_pdf(pdf, output_path, encryption=pikepdf.Encryption(**enc_kwargs))

    return {
        "output": str(output_path),
        "encryption": "AES-256",
        "has_user_password": bool(user_password),
        "restricted": permissions is not None,
    }


def decrypt(file: str, output: str, password: str = "") -> dict:
    """Decrypt a PDF.

    Args:
        file: Input PDF path.
        output: Output PDF path.
        password: Password to unlock the document.
    """
    with pikepdf.open(file, password=password) as pdf:
        output_path = Path(output)
        # pikepdf cannot save over its own open input (engine/inplace.py).
        if is_same_file(file, output):
            staged = staging_target(output_path)
            save_pdf(pdf, staged)
            finish_staged(staged, output_path)
        else:
            save_pdf(pdf, output_path)

    return {
        "output": str(output_path),
        "decrypted": True,
    }
