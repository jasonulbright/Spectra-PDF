"""Which standard clause each shipped check decides, and on whose authority.

A check that fires is evidence about a clause only if the clause is named. This
table names it, and names the SOURCE of the citation with it, because the two
families of citation here do not carry the same weight.

TWO SOURCE KINDS, AND WHY THEY ARE NOT INTERCHANGEABLE

``held``   the clause text is in this repository's normative set (ISO 32000-2,
           ISO 14289-1/-2). The citation is the standard's own numbering.
``corpus`` the standard is NOT held. ISO 19005 (PDF/A) is cited by number and
           title only, taken from the conformance corpus' own organisation,
           which is arranged as that standard's table of contents. This is a
           RECORDED GAP, not a normative reading: a ``corpus`` citation says
           where the requirement is filed, never what its text says.

WHAT A COVERAGE LABEL CLAIMS

``full``    the check's condition IS the clause's requirement.
``partial`` the check decides a STRICT SUBSET of the requirement: it can miss a
            violation, and it can never flag a file the clause permits.

No citation may admit a FALSE ALARM. A check that fails a file its cited clause
allows is not a partial implementation of that clause — it is a different rule
wearing the clause's number, and `scripts/pdfa-scoreboard.py` reports one as a
defect rather than as coverage. That asymmetry is the whole discipline: an
incomplete check understates conformance, an over-broad one asserts a
non-conformance the standard does not state.

WHAT IS DELIBERATELY ABSENT

`output_intent` decides presence of an output intent with an embedded profile.
PDF/A requires one only where device colour spaces are used, so as configured
the check would fail conformant files that use none. It is therefore cited
against no PDF/A clause at all rather than cited as ``partial``.

`fonts_subset` requires subsetting. PDF/A does not; its font-subset clause
constrains subsets that exist. Same rule, opposite direction, so no citation.

`interactive_form` forbids form fields outright. PDF/A constrains forms rather
than forbidding them, so the check is not a subset of that clause either.

`live_transparency` was cited against the PDF/A-1 transparency clause and the
corpus removed the citation: it fails a file the suite passes, whose alpha
constants are `0.9999999` and `1.0000001` — one part in ten million from
opaque, and inside the real-number precision a PDF writer is held to. The
check is right for a press (it reports what the file says) and wrong as a
conformance verdict (it flags a file the clause permits), which is exactly the
false-alarm case no citation may admit. Recorded rather than quietly dropped:
the check is unchanged and the clause is uncovered.

`fonts_embedded` was cited against the font-embedding clauses of three parts
and the corpus removed all three the same way: it fails a passing file whose
one unembedded font is drawn only in text rendering mode 3, which puts no mark
on the page. The check reports every font a resource dictionary declares,
which is the fact a press wants; the clause is about fonts that render. Not a
defect in the check — no shipped profile is a PDF/A profile, so no shipped
verdict is wrong — but not a subset of the clause either, so it is not cited.
The same file shape occurs in ordinary work: a scanned page whose OCR text
layer is invisible and unembedded.

The unmapped checks are enumerated by `unmapped_preflight_checks()` rather than
left implicit — a coverage figure whose denominator hides its own gaps is the
thing this table exists to stop.
"""

from __future__ import annotations

from engine.accessibility import CHECK_SOURCES
from engine.preflight_profiles import CHECK_IDS

HELD = "held"
CORPUS = "corpus"

FULL = "full"
PARTIAL = "partial"


class Citation:
    """One check, one clause of one part, and what the pairing claims."""

    __slots__ = ("check", "part", "clause", "coverage", "source", "params", "condition")

    def __init__(self, check: str, part: str, clause: str, coverage: str,
                 source: str, params: dict, condition: str) -> None:
        self.check = check
        self.part = part
        self.clause = clause
        self.coverage = coverage
        self.source = source
        #: The check parameters under which the check decides this clause. A
        #: citation without them would be a claim about a check the profile
        #: could have configured to mean something else.
        self.params = params
        #: What the check actually decides, in one sentence. Not the clause's
        #: text — this repository does not hold ISO 19005 and may not
        #: paraphrase what it has not read.
        self.condition = condition

    def to_json(self) -> dict:
        return {
            "check": self.check,
            "part": self.part,
            "clause": self.clause,
            "coverage": self.coverage,
            "source": self.source,
            "params": dict(self.params),
            "condition": self.condition,
        }


def _c(check: str, part: str, clause: str, coverage: str, params: dict,
       condition: str) -> Citation:
    return Citation(check, part, clause, coverage, CORPUS, params, condition)


#: Preflight check → PDF/A clause. Every row here is a ``corpus`` citation:
#: ISO 19005 is not held (see `docs/README.md`), so the clause is named and its
#: text is not paraphrased.
PREFLIGHT_CLAUSES: tuple[Citation, ...] = (
    _c("embedded_files", "PDF/A-1b", "6.1.11", FULL, {"allow": False},
       "The document carries no embedded file."),
    _c("optional_content", "PDF/A-1b", "6.1.13", PARTIAL,
       {"allow_optional_content": False},
       "The document declares no optional content GROUP. A catalog carrying an "
       "optional-content dictionary that declares no group is not reported."),
    _c("document_javascript", "PDF/A-1b", "6.6.1", PARTIAL, {"allow_js": False},
       "The document carries no JavaScript action."),
    _c("xmp_present", "PDF/A-1b", "6.7.2", PARTIAL, {"require_xmp": True},
       "The document carries an XMP metadata stream."),

    _c("document_javascript", "PDF/A-2b", "6.5.1", PARTIAL, {"allow_js": False},
       "The document carries no JavaScript action."),
    _c("xmp_present", "PDF/A-2b", "6.6.2.3.1", PARTIAL, {"require_xmp": True},
       "The document carries an XMP metadata stream."),

    _c("document_javascript", "PDF/A-4", "6.6.1", PARTIAL, {"allow_js": False},
       "The document carries no JavaScript action."),
    _c("xmp_present", "PDF/A-4", "6.7.2.1", PARTIAL, {"require_xmp": True},
       "The document carries an XMP metadata stream."),
)

#: `CHECK_SOURCES` kinds that name a clause of ISO 14289-1 rather than a
#: practice this checker keeps under its own name. `ua_soft` is a `should`: it
#: is carried, and the coverage label says the check decides a subset, because
#: a recommendation a document declines to follow is not a violation.
_UA_KINDS = {"ua": FULL, "ua_soft": PARTIAL}


def _ua_clauses(citation: str) -> list[str]:
    """The ISO 14289-1 clause numbers in one `CHECK_SOURCES` sentence.

    A segment naming another standard (`32000-2 …`, `WCAG 2 …`) is dropped
    rather than renumbered: those clauses are real, and they are not PDF/UA-1's
    numbering, so counting them as PDF/UA coverage would inflate the figure
    with a different document's clauses.
    """
    out: list[str] = []
    for chunk in citation.replace(";", ",").split(","):
        text = chunk.strip()
        if not text or not text[0].isdigit():
            continue
        head = text.split()[0].rstrip(".")
        if head and all(part.isdigit() for part in head.split(".")):
            out.append(head)
    return out


def accessibility_clauses() -> tuple[Citation, ...]:
    """Accessibility check → PDF/UA-1 clause, derived from `CHECK_SOURCES`.

    Derived rather than re-authored: a second hand-written table would be a
    second answer waiting to drift from the one the checker itself reports.
    These are ``held`` citations — ISO 14289-1 is in the normative set.
    """
    rows: list[Citation] = []
    for check, (kind, citation) in CHECK_SOURCES.items():
        coverage = _UA_KINDS.get(kind)
        if not coverage:
            continue
        for clause in _ua_clauses(citation):
            rows.append(Citation(
                check, "PDF/UA-1", clause, coverage, HELD, {},
                "See the check's own sentence in engine/accessibility.py.",
            ))
    return tuple(rows)


def all_citations() -> tuple[Citation, ...]:
    return PREFLIGHT_CLAUSES + accessibility_clauses()


def cited_preflight_checks() -> frozenset:
    return frozenset(c.check for c in PREFLIGHT_CLAUSES)


def unmapped_preflight_checks() -> tuple[str, ...]:
    """Every preflight check that decides no PDF/A clause, in inventory order.

    Enumerated, never hidden: these are the checks a PDF/A coverage figure
    does not count, and a reader is owed the list rather than the difference.
    """
    cited = cited_preflight_checks()
    return tuple(cid for cid in CHECK_IDS if cid not in cited)


def unmapped_accessibility_checks() -> tuple[str, ...]:
    """Accessibility checks that cite no PDF/UA-1 clause — the `iso`, `wcag`
    and `practice` kinds, which are deliberately not conformance verdicts."""
    return tuple(sorted(
        check for check, (kind, _text) in CHECK_SOURCES.items()
        if kind not in _UA_KINDS
    ))


def measurement_profile(part: str) -> dict:
    """A preflight profile that runs ONLY the checks cited against `part`.

    NOT a PDF/A profile and never offered as one: it enables the cited checks
    with the parameters their citations state and disables everything else, so
    a scoring run measures the citations rather than a press opinion. The
    shipped profile set contains no PDF/A profile, and this function does not
    add one — it lives here so the scoreboard cannot invent its own parameters
    and grade the citations against a rule they never claimed.
    """
    cited = [c for c in PREFLIGHT_CLAUSES if c.part == part]
    if not cited:
        raise ValueError(f"No check cites a clause of {part}.")
    checks: dict = {cid: {"enabled": False} for cid in CHECK_IDS}
    for citation in cited:
        entry = dict(citation.params)
        entry["severity"] = "fail"
        checks[citation.check] = entry
    from engine.preflight_profiles import validate_profile

    return validate_profile({
        "schema": 1,
        "id": f"clause-scoring-{part.replace('/', '-').lower()}",
        "name": f"Clause scoring ({part})",
        "checks": checks,
        "fixups": [],
    })
