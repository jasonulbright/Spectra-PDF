"""DocMDP certification levels: the wire vocabulary, and the catalog read.

A certified (author) signature records, in the catalog's ``/Perms /DocMDP``
entry, what may change in the document after it was signed. The permitted
change set is a ``/TransformParams /P`` integer, and the ordering is inverted
relative to the reader's expectation — ``/P 1`` is the MOST restrictive level
and ``/P 3`` the most permissive — so the wire carries level NAMES and the
integer never crosses the IPC boundary in either direction.

The read here is structural: a catalog walk with no cryptography, cheap enough
for the edit tier to consult before every edit.
"""

import pikepdf

# /P → wire name. Mapping tables, not a computation: an unknown /P must report
# as an unknown level rather than round to the nearest known one.
LEVEL_BY_VALUE: dict[int, str] = {1: "none", 2: "form-fill", 3: "annotate"}
VALUE_BY_LEVEL: dict[str, int] = {name: value for value, name in LEVEL_BY_VALUE.items()}
LEVEL_NAMES: tuple[str, ...] = ("none", "form-fill", "annotate")


def _not_certified() -> dict:
    return {"certified": False, "level": None, "level_value": None, "error": None}


def certification_of_pdf(pdf) -> dict:
    """The certification a already-open pikepdf document asserts.

    Returns ``{certified, level, level_value, error}``. A ``/DocMDP`` whose
    transform cannot be read reports ``certified`` false WITH an ``error`` —
    never a silent "not certified", which would present an unreadable policy
    as an absent one. A ``/P`` outside 1–3 reports ``certified`` true with a
    null ``level`` and the value verbatim: an unknown level is not guessed.
    """
    try:
        perms = pdf.Root.get("/Perms")
    except Exception:
        return {**_not_certified(), "error": "The document catalog could not be read."}
    if not isinstance(perms, pikepdf.Dictionary):
        return _not_certified()
    docmdp = perms.get("/DocMDP")
    if not isinstance(docmdp, pikepdf.Dictionary):
        return _not_certified()
    refs = docmdp.get("/Reference")
    if not isinstance(refs, pikepdf.Array):
        return {
            **_not_certified(),
            "error": "The certification signature carries no transform reference.",
        }
    for ref in refs:
        if not isinstance(ref, pikepdf.Dictionary):
            continue
        if ref.get("/TransformMethod") != pikepdf.Name("/DocMDP"):
            continue
        params = ref.get("/TransformParams")
        if not isinstance(params, pikepdf.Dictionary) or "/P" not in params:
            continue
        try:
            value = int(params["/P"])
        except (TypeError, ValueError):
            continue
        return {
            "certified": True,
            "level": LEVEL_BY_VALUE.get(value),
            "level_value": value,
            "error": None,
        }
    return {
        **_not_certified(),
        "error": "The certification signature carries no readable permission level.",
    }


def certification_of_file(file: str) -> dict:
    """``certification_of_pdf`` over a path. An unreadable file reports the
    not-certified shape with an error, so a caller consulting the policy before
    an edit never has to distinguish a raise from a verdict."""
    try:
        with pikepdf.open(file) as pdf:
            return certification_of_pdf(pdf)
    except Exception:
        return {**_not_certified(), "error": "The document could not be opened."}
