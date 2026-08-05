"""Label vocabularies that refine a detected field's default type.

The lists are the UNION of every shipped interface language, not the language
the interface is currently running in: the document decides what its own labels
say, so a French form opened in an English interface must still detect its
signature line. Under-detection is the direction that leaves the user drawing
the field by hand, which is why the union is matched rather than one locale's
list.

Matching folds to NFKD, drops combining marks and casefolds, so an accented
label matches its unaccented spelling. A term written in a script with no word
separators matches as a SUBSTRING; every other term matches as a whole token,
because a token match is what keeps `Datum` out of `Datumsangaben`.
"""

from __future__ import annotations

import re
import unicodedata

SIGNATURE_TERMS: tuple[str, ...] = (
    # en
    "signature",
    "signed",
    "sign here",
    "signatory",
    # es
    "firma",
    "firmado",
    "firmar",
    # fr
    "signe",
    "signature du",
    # de
    "unterschrift",
    "unterzeichnet",
    "unterzeichner",
    # it
    "firmato",
    # pt-BR
    "assinatura",
    "assinado",
    "assinar",
    # ja
    "署名",
    "サイン",
    # zh-CN
    "签名",
    "签字",
)

DATE_TERMS: tuple[str, ...] = (
    # en
    "date",
    "dated",
    "date of birth",
    # es
    "fecha",
    # fr
    "date de",
    # de
    "datum",
    "geburtsdatum",
    # it
    "data",
    # pt-BR
    "data de",
    # ja
    "日付",
    "年月日",
    # zh-CN
    "日期",
)

_SEPARATORS = re.compile(r"[^0-9A-Za-zÀ-￿]+")


def fold(text: str) -> str:
    """Casefolded, mark-stripped NFKD form of `text`."""
    decomposed = unicodedata.normalize("NFKD", text or "")
    stripped = "".join(ch for ch in decomposed if not unicodedata.combining(ch))
    return stripped.casefold()


def _tokens(folded: str) -> list[str]:
    return [t for t in _SEPARATORS.split(folded) if t]


def _is_wordless(term: str) -> bool:
    """True for a term written in a script that separates no words."""
    return not any(ch.isascii() and ch.isalnum() for ch in term)


def matches(label: str, terms: tuple[str, ...]) -> bool:
    """Does `label` carry any of `terms`?"""
    if not label:
        return False
    folded = fold(label)
    tokens = _tokens(folded)
    joined = " ".join(tokens)
    for term in terms:
        folded_term = fold(term)
        if _is_wordless(folded_term):
            if folded_term in folded:
                return True
            continue
        term_tokens = _tokens(folded_term)
        if not term_tokens:
            continue
        if len(term_tokens) == 1:
            if term_tokens[0] in tokens:
                return True
            continue
        phrase = " ".join(term_tokens)
        if re.search(rf"(?:^| ){re.escape(phrase)}(?: |$)", joined):
            return True
    return False


def is_signature_label(label: str) -> bool:
    return matches(label, SIGNATURE_TERMS)


def is_date_label(label: str) -> bool:
    return matches(label, DATE_TERMS)
