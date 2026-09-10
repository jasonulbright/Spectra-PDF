"""Field-level locking (``/FieldMDP``): the wire vocabulary, and the catalog read.

A signature can record which FORM FIELDS may no longer change after it was
applied. The policy rides the signature FIELD as a ``/Lock`` dictionary and the
SIGNATURE as a ``/Reference`` entry whose ``/TransformMethod`` is ``/FieldMDP``;
the two carry the same ``/Action`` and ``/Fields``. This is a different
transform from ``/DocMDP`` with its own rules: it is per signature rather than
per document, it binds with no certification present, and several signatures can
each lock a different set.

The wire carries action NAMES; the PDF names never cross the IPC boundary.

The read here is structural: a catalog walk with no cryptography, cheap enough
for the edit tier to consult before every edit.
"""

import pikepdf

from .acroform import live_signature_fields
from .docmdp import refuse_unreadable_policy

# PDF /Action → wire name. A mapping table, not a computation: an action this
# build does not know must report as unreadable rather than as the nearest one.
ACTION_BY_NAME: dict[str, str] = {"/All": "all", "/Include": "include", "/Exclude": "exclude"}
NAME_BY_ACTION: dict[str, str] = {name: action for action, name in ACTION_BY_NAME.items()}
ACTION_NAMES: tuple[str, ...] = ("all", "include", "exclude")
# The two actions whose meaning depends on a field list. ``all`` ignores one.
LIST_ACTIONS: tuple[str, ...] = ("include", "exclude")


def validated_lock(lock, lock_fields, present=None, own_name: str | None = None) -> dict | None:
    """A lock request as the wire dict ``{"action", "fields"}``, or None.

    Every refusal is a request that would otherwise lock something other than
    what was asked for: an empty list means opposite things under the two list
    actions, a list under ``all`` is discarded by the format, a name the
    document does not carry locks nothing (``include``) or everything but a typo
    (``exclude``), and a field that names ITSELF constrains nothing the
    signature does not already fix.

    ``present`` is the set of names the request may choose from; None skips the
    membership check, which is what an unreadable document gets — reporting
    every name as missing would blame the request for the file's problem.
    """
    names = [str(n).strip() for n in (lock_fields or []) if str(n).strip()]
    if lock is None:
        if names:
            raise ValueError(
                "Field names to lock apply only to a field lock. Choose what the "
                "signature locks, or leave the names unset."
            )
        return None
    if lock not in ACTION_NAMES:
        raise ValueError(f'Unknown field lock "{lock}". Choose all, include, or exclude.')
    if lock == "all" and names:
        raise ValueError("A field lock covering every form field takes no field names.")
    if lock in LIST_ACTIONS and not names:
        raise ValueError(f'A field lock of type "{lock}" needs at least one field name.')
    if own_name and own_name in names:
        raise ValueError(
            f'Signature field "{own_name}" cannot lock itself. A field lock names the '
            "form fields that may no longer change, not the field being signed."
        )
    if names and present is not None:
        missing = [n for n in names if n not in present]
        if missing:
            raise ValueError(
                f'This document has no form field named "{missing[0]}", so that '
                "field cannot be locked."
            )
    return {"action": lock, "fields": names}


def lock_dictionary(pdf, spec: dict):
    """``spec`` as the ``/Lock`` (``/SigFieldLock``) dictionary a signature field
    carries. ``all`` writes no ``/Fields``: the format ignores one there."""
    import pikepdf

    entries = {"Type": pikepdf.Name("/SigFieldLock"), "Action": pikepdf.Name(NAME_BY_ACTION[spec["action"]])}
    if spec["action"] in LIST_ACTIONS:
        entries["Fields"] = pikepdf.Array([pikepdf.String(n) for n in spec["fields"]])
    return pdf.make_indirect(pikepdf.Dictionary(**entries))


def is_locked(lock: dict, field_name: str) -> bool:
    """Whether ``lock`` covers ``field_name``.

    A scoped name covers its whole subtree — locking a parent locks every field
    beneath it — which is the format's rule and the one the validating library
    applies, so the two must not answer differently.
    """
    action = lock.get("action")
    if action == "all":
        return True
    if action not in LIST_ACTIONS:
        return False
    listed = action == "include"
    for scoped in lock.get("fields") or ():
        if field_name == scoped or field_name.startswith(scoped + "."):
            return listed
    return not listed


def locked_fields(locks: list, field_names) -> list[str]:
    """The given field names that at least one lock covers, in the order given
    and without duplicates."""
    out: list[str] = []
    for name in field_names:
        if name in out:
            continue
        if any(is_locked(lock, name) for lock in locks):
            out.append(name)
    return out


def _spec_of_params(params) -> dict | None:
    if not isinstance(params, pikepdf.Dictionary):
        return None
    action = ACTION_BY_NAME.get(str(params.get("/Action") or ""))
    if action is None:
        return None
    if action == "all":
        return {"action": action, "fields": []}
    listed = params.get("/Fields")
    if not isinstance(listed, pikepdf.Array):
        return None
    return {"action": action, "fields": [str(f) for f in listed]}


def lock_of_field_dict(field) -> dict | None:
    """The ``/Lock`` seed value a signature field carries, or None.

    On an UNSIGNED field this constrains nothing yet; it is what whoever signs
    that field will be bound by, which is why signing honours it with no request
    and why a request to replace it is refused rather than silently applied.
    """
    if not isinstance(field, pikepdf.Dictionary):
        return None
    return _spec_of_params(field.get("/Lock"))


def lock_of_signature_value(value) -> dict | None:
    """The lock a signature dictionary's ``/Reference`` declares, or None.

    ``{"action": name, "fields": [str]}``. A reference whose transform
    parameters cannot be read reports None: an unreadable lock is not a lock
    this build can adjudicate, and guessing at one would either invent a
    constraint or discard a real one.
    """
    if not isinstance(value, pikepdf.Dictionary):
        return None
    refs = value.get("/Reference")
    if not isinstance(refs, pikepdf.Array):
        return None
    for ref in refs:
        if not isinstance(ref, pikepdf.Dictionary):
            continue
        if ref.get("/TransformMethod") != pikepdf.Name("/FieldMDP"):
            continue
        spec = _spec_of_params(ref.get("/TransformParams"))
        if spec is not None:
            return spec
    return None


def locks_of_pdf(pdf, *, strict=False) -> list[dict]:
    """Live locks; edit callers use strict mode, never the lenient display read."""
    out: list[dict] = []
    try:
        fields = live_signature_fields(pdf, strict=strict)
    except Exception:
        if strict:
            refuse_unreadable_policy()
        return out
    for field in fields:
        if strict:
            value = field.get("/V")
            refs = value.get("/Reference")
            if refs is None:
                continue
            if not isinstance(refs, pikepdf.Array):
                refuse_unreadable_policy()
            for ref in refs:
                if not isinstance(ref, pikepdf.Dictionary) or not isinstance(ref.get("/TransformMethod"), pikepdf.Name):
                    refuse_unreadable_policy()
                if ref.TransformMethod not in (pikepdf.Name.FieldMDP, pikepdf.Name.DocMDP):
                    refuse_unreadable_policy()
                if ref.TransformMethod != pikepdf.Name.FieldMDP:
                    continue
                params = ref.get("/TransformParams")
                if not isinstance(params, pikepdf.Dictionary) or not isinstance(params.get("/Action"), pikepdf.Name):
                    refuse_unreadable_policy()
                spec = _spec_of_params(params)
                if spec is None:
                    refuse_unreadable_policy()
                if spec["action"] in LIST_ACTIONS and any(
                    not isinstance(name, pikepdf.String) or not str(name)
                    for name in params.Fields
                ):
                    refuse_unreadable_policy()
                # Every reference contributes. Choosing only the first could
                # discard a later restrictive lock in a damaged signature.
                out.append(spec)
            continue
        lock = lock_of_signature_value(field.get("/V"))
        if lock is not None:
            out.append(lock)
    return out


def locks_of_file(file: str, *, strict=False) -> list[dict]:
    """Path wrapper. Strict edit reads raise on uncertainty; the default
    lenient inspection read cannot establish permission to edit."""
    try:
        with pikepdf.open(file) as pdf:
            return locks_of_pdf(pdf, strict=strict)
    except Exception:
        if strict:
            refuse_unreadable_policy()
        return []
