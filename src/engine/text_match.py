"""One matcher semantics for every text search surface (F15 slice C).

Three matchers already existed and were already documented as mirrors of each
other: `normalize.compileMatcher` (renderer, sync + worker) and
`search_in_files._compile` (engine). `search_regions` is a FOURTH call site,
not a fourth semantics — so the compile half moved here and both engine
callers import it, while the renderer's copy is pinned against this one by a
shared corpus (`tests/fixtures/matcher-corpus.json`, asserted by BOTH
`tests/test_text_match.py` and `tests/matcher-corpus.test.ts`).

That corpus is the S1 lesson applied before it happens rather than after: the
GUI and the CLI running different forms implementations was found by a user.
Two divergences it caught while being written, both fixed here:

  * **Whole-word was ASCII-only in the renderer and Unicode-aware in the
    engine.** `\\b` in JavaScript is defined over `[A-Za-z0-9_]`, so a
    whole-word search for `café` matched in Python and found NOTHING in the
    find bar. Both sides now spell the boundary explicitly — `(?<!\\w)…(?!\\w)`
    here, `(?<![\\p{L}\\p{N}\\p{Pc}])…(?![\\p{L}\\p{N}\\p{Pc}])` with the `u`
    flag there — and those two classes are the same set (measured: Python's
    `\\w` is L* ∪ N* ∪ Pc, and a combining mark is NOT in it on either side).
  * **`\\b` anchored on the query's own first character**, so a whole-word
    search for `-foo` required a WORD character before the hyphen: `x-foo`
    matched and ` -foo` did not, which is the opposite of what "whole word"
    means. The lookaround form says what was meant — not preceded, and not
    followed, by a word character.

The built-in pattern set (§ 5 of the brief) lives here too, because a pattern
is a query by another name. Each one is VALIDATED where its format carries a
checksum: a "credit card" pattern that fires on every 16-digit number teaches
the user to ignore it, which is worse than not shipping it.
"""

from __future__ import annotations

import calendar
import re
import unicodedata
from typing import Callable, NamedTuple, Optional

_WS = re.compile(r"\s+")
_SOFT_HYPHEN = "\u00ad"
_SNIPPET_RADIUS = 40


def collapse_ws(text: str) -> str:
    """Whitespace collapsed to single spaces, then trimmed.

    `search_in_files`' normalization, unchanged: pdfminer emits a line break
    wherever the layout has one, so a spaced query has to match across it.
    """
    return _WS.sub(" ", text).strip()


def normalize_index_text(text: str) -> str:
    """The RENDERER index's normalization, character for character.

    NFKC + soft-hyphen strip + whitespace collapse + trim — `normalize.ts`'s
    `normalizeIndexText`. `search_regions` builds its page text this way (and
    normalizes its literal queries the same way) so that a hit the find bar
    shows is a hit Search & Redact can mark, and vice versa. Case is
    PRESERVED: case-insensitivity is a match-time flag, never a pre-lowercased
    corpus, because the corpus also has to serve case-sensitive and regex
    searches.
    """
    return _WS.sub(" ", unicodedata.normalize("NFKC", text).replace(_SOFT_HYPHEN, "")).strip()


def word_bounded(pattern: str) -> str:
    """`pattern` restricted to whole-word occurrences.

    NOT `\\b(?:…)\\b`: `\\b` is a boundary between a word and a non-word
    character, so it takes its meaning from whatever character the QUERY
    happens to start with — a query beginning with punctuation ends up
    requiring a word character on the far side of it. "Whole word" means
    "no word character immediately outside", which is what this says.
    """
    return r"(?<!\w)(?:" + pattern + r")(?!\w)"


def compile_matcher(
    query: str,
    regex: bool = False,
    case_sensitive: bool = False,
    whole_word: bool = False,
    normalizer: Callable[[str], str] = collapse_ws,
):
    """(compiled pattern, error). A literal query is normalized then escaped;
    a regex is taken verbatim (normalizing it would corrupt the pattern).
    Returns (None, None) for an empty query, (None, message) for a bad regex —
    an invalid regex is REPORTED, never raised, because the user is typing it.
    """
    if regex:
        if query == "":
            return None, None
        pattern = query
    else:
        norm = normalizer(query)
        if norm == "":
            return None, None
        pattern = re.escape(norm)
    if whole_word:
        pattern = word_bounded(pattern)
    flags = 0 if case_sensitive else re.IGNORECASE
    try:
        return re.compile(pattern, flags), None
    except re.error as exc:
        return None, str(exc)


def compile_terms(
    terms: list[str],
    regex: bool = False,
    case_sensitive: bool = False,
    whole_word: bool = False,
    normalizer: Callable[[str], str] = collapse_ws,
):
    """A WORD LIST as one matcher: the terms OR-ed into a single alternation.

    One pattern rather than N passes so the hit ORDER is the page's, not the
    list's — a result list sorted by which term the user happened to type
    first would read as noise. Empty/whitespace terms are dropped (a trailing
    newline in a pasted list must not become "match everything").
    """
    parts: list[str] = []
    for term in terms or []:
        if regex:
            if term == "":
                continue
            parts.append(term)
        else:
            norm = normalizer(term)
            if norm == "":
                continue
            parts.append(re.escape(norm))
    if not parts:
        return None, None
    pattern = "|".join(f"(?:{p})" for p in parts)
    if whole_word:
        pattern = word_bounded(pattern)
    flags = 0 if case_sensitive else re.IGNORECASE
    try:
        return re.compile(pattern, flags), None
    except re.error as exc:
        return None, str(exc)


def snippet(text: str, start: int, end: int, radius: int = _SNIPPET_RADIUS) -> str:
    """Context around a match, with ellipses where it was cut."""
    lo = max(0, start - radius)
    hi = min(len(text), end + radius)
    return ("…" if lo > 0 else "") + text[lo:hi] + ("…" if hi < len(text) else "")


def finditer_nonempty(pattern: "re.Pattern", text: str):
    """Non-empty matches only, never looping. A zero-width match (`a*`, `\\b`)
    is not a visible occurrence, and it is also how a naive scanner hangs."""
    for m in pattern.finditer(text):
        if m.end() > m.start():
            yield m


# ── built-in patterns ─────────────────────────────────────────────────────


def _digits(text: str) -> str:
    return "".join(ch for ch in text if ch.isdigit())


def luhn(digits: str) -> bool:
    """The Luhn check digit — what makes `credit_card` a pattern rather than
    "any long number". Rejected without it: every order number, every ISBN,
    every phone number written without separators."""
    if not digits or not digits.isdigit():
        return False
    total = 0
    parity = len(digits) % 2
    for i, ch in enumerate(digits):
        d = ord(ch) - 48
        if i % 2 == parity:
            d *= 2
            if d > 9:
                d -= 9
        total += d
    return total % 10 == 0


def _mod97(text: str) -> int:
    """ISO 7064 mod-97-10 over an IBAN's rearranged, letter-expanded form.
    Computed incrementally so a 34-character account never needs a bignum."""
    remainder = 0
    for ch in text:
        if ch.isdigit():
            remainder = (remainder * 10 + (ord(ch) - 48)) % 97
        else:
            remainder = (remainder * 100 + (ord(ch.upper()) - 55)) % 97
    return remainder


def _valid_iban(raw: str) -> bool:
    compact = re.sub(r"[\s\-]", "", raw).upper()
    if not (15 <= len(compact) <= 34):
        return False
    if not re.fullmatch(r"[A-Z]{2}\d{2}[A-Z0-9]+", compact):
        return False
    return _mod97(compact[4:] + compact[:4]) == 1


def _valid_ssn(raw: str) -> bool:
    """The SSA's own issuance rules. `000-12-3456` is not a social security
    number; a pattern that says it is has taught the user to stop reading."""
    d = _digits(raw)
    if len(d) != 9:
        return False
    area, group, serial = d[:3], d[3:5], d[5:]
    if area in ("000", "666") or area[0] == "9":
        return False
    return group != "00" and serial != "0000"


def _valid_nanp_or_e164(raw: str) -> bool:
    if raw.strip().startswith("+"):
        d = _digits(raw)
        if not (7 <= len(d) <= 15):
            return False
        if d.startswith("1") and len(d) == 11:
            return _valid_nanp(d[1:])
        return True
    d = _digits(raw)
    if len(d) == 11 and d[0] == "1":
        d = d[1:]
    return len(d) == 10 and _valid_nanp(d)


def _valid_nanp(ten: str) -> bool:
    # NXX-NXX-XXXX: neither the area code nor the exchange may begin with
    # 0 or 1, and N11 area codes are service codes, not subscribers.
    if len(ten) != 10:
        return False
    if ten[0] in "01" or ten[3] in "01":
        return False
    return not (ten[1] == "1" and ten[2] == "1")


def _valid_email(raw: str) -> bool:
    if raw.count("@") != 1:
        return False
    local, _, domain = raw.partition("@")
    if not local or len(local) > 64 or ".." in local or local[0] == "." or local[-1] == ".":
        return False
    if ".." in domain or domain[0] in ".-" or domain[-1] in ".-":
        return False
    tld = domain.rsplit(".", 1)[-1] if "." in domain else ""
    return len(tld) >= 2 and tld.isalpha()


def _valid_check_mod11(raw: str, length: int = 10) -> bool:
    """The NHS number's modulus-11 check digit (weights 10…2, check = 11 − r,
    where 11 means 0 and 10 means the number is invalid)."""
    d = _digits(raw)
    if len(d) != length:
        return False
    total = sum((ord(d[i]) - 48) * (length - i) for i in range(length - 1))
    check = 11 - (total % 11)
    if check == 11:
        check = 0
    if check == 10:
        return False
    return check == ord(d[-1]) - 48


def _valid_sin(raw: str) -> bool:
    # Luhn only. Canada's unissued leading digits (0, 8) would narrow this
    # further, and narrowing a SEARCH is the dangerous direction: an unmatched
    # identifier is an unredacted one, while an over-matched one costs a
    # checkbox the user leaves unticked.
    d = _digits(raw)
    return len(d) == 9 and luhn(d)


# Long-form month names for every SHIPPED locale, matched as a UNION rather
# than by the active UI language. A date pattern that knew only the app's
# language would silently miss `12 février 2026` in a French document opened
# in an English app — a shortfall the user cannot see, on a tool whose whole
# job is finding every occurrence. Over-matching a DATE costs a checkbox the
# user leaves unticked; under-matching costs an unredacted date.
MONTH_NAMES: dict[str, list[str]] = {
    "en": ["January", "February", "March", "April", "May", "June", "July",
           "August", "September", "October", "November", "December"],
    "es": ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio",
           "agosto", "septiembre", "octubre", "noviembre", "diciembre"],
    "fr": ["janvier", "février", "mars", "avril", "mai", "juin", "juillet",
           "août", "septembre", "octobre", "novembre", "décembre"],
    "de": ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli",
           "August", "September", "Oktober", "November", "Dezember"],
    "it": ["gennaio", "febbraio", "marzo", "aprile", "maggio", "giugno",
           "luglio", "agosto", "settembre", "ottobre", "novembre", "dicembre"],
    "pt-BR": ["janeiro", "fevereiro", "março", "abril", "maio", "junho",
              "julho", "agosto", "setembro", "outubro", "novembro", "dezembro"],
}

# Three-letter English abbreviations are the other everyday long form. Spelled
# as an explicit table rather than sliced off the full names: "Sept" is a
# fourth-letter exception, and an off-by-one in a month table is the kind of
# defect that shows up as one unredacted date in September.
_MONTH_ABBR: dict[str, int] = {
    "jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6,
    "jul": 7, "aug": 8, "sep": 9, "sept": 9, "oct": 10, "nov": 11, "dec": 12,
}


def _month_index() -> dict[str, int]:
    """Lowercased month name → 1-based month, across every shipped locale."""
    index: dict[str, int] = {}
    for names in MONTH_NAMES.values():
        for i, name in enumerate(names):
            index[name.lower()] = i + 1
    index.update(_MONTH_ABBR)
    return index


MONTH_INDEX = _month_index()

_MONTH_ALT = "|".join(
    re.escape(name)
    for name in sorted(MONTH_INDEX.keys(), key=len, reverse=True)
)


def _real_day(year: int, month: int, day: int) -> bool:
    if not (1 <= month <= 12) or year < 1:
        return False
    return 1 <= day <= calendar.monthrange(year, month)[1]


def _expand_year(value: int) -> int:
    # A two-digit year is a real year; which century it names is not something
    # a redaction tool may decide, so both readings are accepted and the
    # calendar check runs against whichever is a real day.
    return value if value > 99 else (2000 + value if value <= 68 else 1900 + value)


def _valid_date(raw: str) -> bool:
    text = raw.strip()
    iso = re.fullmatch(r"(\d{4})-(\d{1,2})-(\d{1,2})", text)
    if iso:
        return _real_day(int(iso.group(1)), int(iso.group(2)), int(iso.group(3)))
    cjk = re.fullmatch(r"(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日", text)
    if cjk:
        return _real_day(int(cjk.group(1)), int(cjk.group(2)), int(cjk.group(3)))
    numeric = re.fullmatch(r"(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2,4})", text)
    if numeric:
        a, b, y = int(numeric.group(1)), int(numeric.group(2)), _expand_year(int(numeric.group(3)))
        # dd/mm and mm/dd are BOTH real conventions and the document does not
        # say which; either reading being a real day makes this a date.
        return _real_day(y, b, a) or _real_day(y, a, b)
    named = re.fullmatch(
        rf"(\d{{1,2}})(?:st|nd|rd|th)?[\s.]+(?:de\s+)?({_MONTH_ALT})[\s.,]+(?:de\s+)?(\d{{4}})",
        text,
        re.IGNORECASE,
    )
    if named:
        month = MONTH_INDEX.get(named.group(2).lower())
        return month is not None and _real_day(int(named.group(3)), month, int(named.group(1)))
    named2 = re.fullmatch(
        rf"({_MONTH_ALT})\.?\s+(\d{{1,2}})(?:st|nd|rd|th)?,?\s+(\d{{4}})",
        text,
        re.IGNORECASE,
    )
    if named2:
        month = MONTH_INDEX.get(named2.group(1).lower())
        return month is not None and _real_day(int(named2.group(3)), month, int(named2.group(2)))
    return False


class PatternDef(NamedTuple):
    """One built-in pattern.

    `group` is which capture the HIT is: an SSN written bare needs the words
    around it as evidence that nine digits are a social security number, but
    the redaction mark must cover the number and not the label. Matching wide
    and reporting narrow is how both are true at once.
    """

    id: str
    regex: str
    validate: Optional[Callable[[str], bool]]
    group: int = 0


_DATE_ALT = (
    r"(?<!\d)\d{4}-\d{1,2}-\d{1,2}(?!\d)"
    r"|\d{4}\s*年\s*\d{1,2}\s*月\s*\d{1,2}\s*日"
    r"|(?<![\d/.\-])\d{1,2}[/.\-]\d{1,2}[/.\-]\d{2,4}(?![\d/.\-])"
    rf"|\d{{1,2}}(?:st|nd|rd|th)?[\s.]+(?:de\s+)?(?:{_MONTH_ALT})[\s.,]+(?:de\s+)?\d{{4}}"
    rf"|(?:{_MONTH_ALT})\.?\s+\d{{1,2}}(?:st|nd|rd|th)?,?\s+\d{{4}}"
)

PATTERNS: dict[str, PatternDef] = {
    "phone": PatternDef(
        "phone",
        r"(?<![\d/.\-])(?:\+\d{1,3}[-. ]?)?(?:\(\d{3}\)|\d{3})[-. ]\d{3}[-. ]\d{4}(?![\d/.\-])"
        r"|(?<![\d/.\-])\+\d{7,15}(?![\d/.\-])"
        r"|(?<![\d/.\-])\(\d{3}\)\s*\d{3}[-. ]?\d{4}(?![\d/.\-])",
        _valid_nanp_or_e164,
    ),
    "email": PatternDef(
        "email",
        r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9\-]+(?:\.[A-Za-z0-9\-]+)+",
        _valid_email,
    ),
    "credit_card": PatternDef(
        "credit_card",
        r"(?<![\d\-])\d(?:[ \-]?\d){11,18}(?![\d\-])",
        lambda raw: 13 <= len(_digits(raw)) <= 19 and luhn(_digits(raw)),
    ),
    "ssn": PatternDef(
        "ssn",
        r"(?<!\d)(\d{3}[-. ]\d{2}[-. ]\d{4})(?!\d)"
        r"|(?i:\bssn\b|\bsocial\s+security(?:\s+(?:number|no\.?|#))?)\s*[:#]?\s*(?<!\d)(\d{9})(?!\d)",
        _valid_ssn,
        group=-1,  # whichever alternative captured
    ),
    "date": PatternDef("date", _DATE_ALT, _valid_date),
    "iban": PatternDef(
        "iban",
        r"(?<![A-Z0-9])[A-Z]{2}\d{2}[ \-]?(?:[A-Z0-9]{4}[ \-]?){2,7}[A-Z0-9]{1,4}(?![A-Z0-9])",
        _valid_iban,
    ),
    "nhs_uk": PatternDef(
        "nhs_uk",
        r"(?<!\d)\d{3}[ \-]?\d{3}[ \-]?\d{4}(?!\d)",
        lambda raw: _valid_check_mod11(raw, 10),
    ),
    "sin_ca": PatternDef(
        "sin_ca",
        r"(?<!\d)\d{3}[ \-]?\d{3}[ \-]?\d{3}(?!\d)",
        _valid_sin,
    ),
}

PATTERN_IDS: list[str] = list(PATTERNS.keys())

_COMPILED: dict[str, "re.Pattern"] = {}


def compiled_pattern(pattern_id: str) -> "re.Pattern":
    if pattern_id not in PATTERNS:
        # ONE f-string, not a concatenation: the engine-message sweep templates
        # a raise by reading its literal, and a message glued together from a
        # join() is invisible to it — which would mean this refusal reaching
        # the user untranslated in seven of the eight shipped languages.
        known = ", ".join(PATTERN_IDS)
        raise ValueError(
            f"unknown pattern {pattern_id!r} — the built-in patterns are: {known}"
        )
    if pattern_id not in _COMPILED:
        _COMPILED[pattern_id] = re.compile(PATTERNS[pattern_id].regex, re.IGNORECASE)
    return _COMPILED[pattern_id]


def pattern_spans(pattern_id: str, text: str) -> list[tuple[int, int]]:
    """Validated (start, end) spans of one built-in pattern over `text`.

    Every span is checked against the format's OWN rule where it has one —
    Luhn, mod-97, the SSA's issuance rules, a real calendar day. A pattern
    that fires on every 16-digit number is a pattern the user learns to
    ignore, and a redaction list nobody reads is worse than no list.
    """
    definition = PATTERNS[pattern_id]
    compiled = compiled_pattern(pattern_id)
    spans: list[tuple[int, int]] = []
    for m in finditer_nonempty(compiled, text):
        if definition.group == -1:
            start = end = None
            for index in range(1, (m.re.groups or 0) + 1):
                if m.group(index) is not None:
                    start, end = m.span(index)
                    break
            if start is None:
                start, end = m.span(0)
        elif definition.group:
            if m.group(definition.group) is None:
                continue
            start, end = m.span(definition.group)
        else:
            start, end = m.span(0)
        if definition.validate is not None and not definition.validate(text[start:end]):
            continue
        spans.append((start, end))
    return spans
