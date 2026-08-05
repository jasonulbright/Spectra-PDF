"""The shared matcher and the built-in pattern set.

Two jobs. First, the CORPUS pin: `tests/fixtures/matcher-corpus.json` is read
here and by `tests/matcher-corpus.test.ts`, so the engine's matcher and the
renderer's cannot drift without one of the two going red. Second, the pattern
set's VALIDATION — each pattern that carries a checksum is pinned against a
positive and a negative corpus, because a pattern that fires on every 16-digit
number is a pattern the user learns to ignore.
"""

import json
import pathlib

import pytest

from engine.text_match import (
    PATTERN_IDS,
    PATTERNS,
    compile_matcher,
    compile_terms,
    finditer_nonempty,
    luhn,
    normalize_index_text,
    pattern_spans,
)

CORPUS = json.loads(
    (pathlib.Path(__file__).parent / "fixtures" / "matcher-corpus.json").read_text(
        encoding="utf-8"
    )
)


def _spans(case) -> list:
    pattern, error = compile_matcher(
        case["query"],
        bool(case.get("regex")),
        bool(case.get("caseSensitive")),
        bool(case.get("wholeWord")),
        normalizer=normalize_index_text,
    )
    assert error is None, f"{case['name']}: {error}"
    if pattern is None:
        return []
    return [[m.start(), m.end()] for m in finditer_nonempty(pattern, case["text"])]


class TestSharedMatcherCorpus:
    @pytest.mark.parametrize("case", CORPUS["cases"], ids=lambda c: c["name"])
    def test_case(self, case):
        assert _spans(case) == case["spans"]

    def test_the_corpus_covers_every_mode(self):
        """A corpus that never exercises a mode pins nothing about it."""
        cases = CORPUS["cases"]
        assert any(c.get("regex") for c in cases)
        assert any(c.get("wholeWord") for c in cases)
        assert any(c.get("caseSensitive") for c in cases)
        assert any(c.get("regex") and c.get("wholeWord") for c in cases)


class TestNormalization:
    def test_soft_hyphen_and_fullwidth_and_whitespace(self):
        assert normalize_index_text("Ｐ­ＤＦ   file\n") == "PDF file"

    def test_case_is_preserved(self):
        # Case-insensitivity is a match-time flag; a pre-lowercased corpus
        # could not serve a case-sensitive search.
        assert normalize_index_text("MiXeD") == "MiXeD"


class TestWordList:
    def test_terms_are_or_ed_into_one_matcher_in_page_order(self):
        pattern, error = compile_terms(["Smith", "Oak"])
        assert error is None
        text = "John Smith lives at 12 Oak Street"
        assert [m.group(0) for m in finditer_nonempty(pattern, text)] == ["Smith", "Oak"]

    def test_blank_terms_are_dropped_not_matched(self):
        # A pasted list ends with a newline; an empty alternative would make
        # the matcher match everywhere.
        pattern, error = compile_terms(["Smith", "", "   "])
        assert error is None
        assert [m.group(0) for m in finditer_nonempty(pattern, "a Smith b")] == ["Smith"]

    def test_an_all_blank_list_compiles_to_nothing(self):
        pattern, error = compile_terms(["", "  "])
        assert pattern is None and error is None

    def test_whole_word_wraps_the_whole_alternation(self):
        pattern, _ = compile_terms(["cat", "dog"], whole_word=True)
        assert [m.group(0) for m in finditer_nonempty(pattern, "cat catalog dog")] == [
            "cat",
            "dog",
        ]


class TestInvalidRegexIsReported:
    def test_bad_regex_returns_an_error_rather_than_raising(self):
        pattern, error = compile_matcher("(unclosed", regex=True)
        assert pattern is None
        assert error


class TestPatterns:
    def test_every_advertised_id_exists(self):
        assert set(PATTERN_IDS) == set(PATTERNS)
        assert PATTERN_IDS == [
            "phone", "email", "credit_card", "ssn", "date", "iban", "nhs_uk", "sin_ca",
        ]

    # ── credit_card: Luhn is what makes it a pattern ──────────────────────
    def test_luhn_accepts_the_standard_test_numbers(self):
        for number in ("4111111111111111", "5500005555555559", "378282246310005"):
            assert luhn(number), number

    def test_credit_card_rejects_a_16_digit_non_card(self):
        # The whole point of the checksum: 1234567890123456 fails Luhn.
        assert pattern_spans("credit_card", "ref 1234567890123456 end") == []

    def test_credit_card_finds_a_separated_card(self):
        text = "card 4111 1111 1111 1111 on file"
        spans = pattern_spans("credit_card", text)
        assert len(spans) == 1
        assert text[spans[0][0] : spans[0][1]] == "4111 1111 1111 1111"

    # ── iban: mod-97 ──────────────────────────────────────────────────────
    def test_iban_accepts_a_real_one_and_rejects_a_mangled_one(self):
        good = "GB82 WEST 1234 5698 7654 32"
        assert pattern_spans("iban", f"pay {good} today")
        bad = "GB82 WEST 1234 5698 7654 33"
        assert pattern_spans("iban", f"pay {bad} today") == []

    # ── ssn: the SSA's issuance rules ─────────────────────────────────────
    @pytest.mark.parametrize("value", ["000-12-3456", "666-12-3456", "900-12-3456",
                                       "123-00-4567", "123-45-0000"])
    def test_ssn_rejects_the_never_issued_ranges(self, value):
        assert pattern_spans("ssn", f"ssn {value}") == []

    def test_ssn_accepts_a_valid_dashed_number(self):
        text = "SSN 123-45-6789 on file"
        spans = pattern_spans("ssn", text)
        assert [text[a:b] for a, b in spans] == ["123-45-6789"]

    def test_a_bare_nine_digit_number_needs_its_label_and_the_hit_is_the_number(self):
        """Nine digits alone are an order number as often as an SSN. The label
        is the evidence; the MARK is the number, which is why the pattern
        matches wide and reports the capture."""
        assert pattern_spans("ssn", "order 123456789 shipped") == []
        text = "Social Security Number: 123456789"
        spans = pattern_spans("ssn", text)
        assert [text[a:b] for a, b in spans] == ["123456789"]

    # ── date: a real calendar day, in any shipped locale ──────────────────
    @pytest.mark.parametrize(
        "value",
        ["2026-08-05", "05/08/2026", "5 August 2026", "August 5, 2026",
         "12 février 2026", "5. März 2026", "5 de agosto de 2026",
         "2026年8月5日"],
    )
    def test_date_matches_the_shipped_locales_long_forms(self, value):
        spans = pattern_spans("date", f"dated {value} herein")
        assert spans, value

    @pytest.mark.parametrize("value", ["2026-02-30", "31/02/2026", "32 August 2026"])
    def test_date_rejects_a_day_the_calendar_does_not_have(self, value):
        assert pattern_spans("date", f"dated {value} herein") == []

    def test_an_ambiguous_numeric_date_is_accepted_under_either_reading(self):
        # 05/08 is a real day as dd/mm and as mm/dd; the document does not say
        # which, and a redaction tool may not decide for it.
        assert pattern_spans("date", "05/08/2026")
        # 25/13 is a real day under neither.
        assert pattern_spans("date", "25/13/2026") == []

    # ── phone ─────────────────────────────────────────────────────────────
    def test_phone_matches_nanp_and_e164_and_rejects_a_bad_area_code(self):
        # A bare 7-digit local number is not a complete NANP number and is
        # indistinguishable from an order reference; it is not offered.
        assert pattern_spans("phone", "call 555-0100 x") == []
        text = "call (415) 555-0100 or +442071838750"
        found = [text[a:b] for a, b in pattern_spans("phone", text)]
        assert "(415) 555-0100" in found
        assert "+442071838750" in found
        assert pattern_spans("phone", "call 015-555-0100") == []

    # ── email ─────────────────────────────────────────────────────────────
    def test_email_needs_a_tld_ish_suffix(self):
        text = "write to jane.doe@example.co.uk please"
        assert [text[a:b] for a, b in pattern_spans("email", text)] == [
            "jane.doe@example.co.uk"
        ]
        assert pattern_spans("email", "write to jane@localhost") == []

    # ── national identifiers ──────────────────────────────────────────────
    def test_nhs_number_check_digit(self):
        assert pattern_spans("nhs_uk", "NHS 943 476 5919")
        assert pattern_spans("nhs_uk", "NHS 943 476 5918") == []

    def test_sin_check_digit(self):
        assert pattern_spans("sin_ca", "SIN 046 454 286")
        assert pattern_spans("sin_ca", "SIN 046 454 287") == []

    def test_an_unknown_pattern_id_refuses_by_name(self):
        from engine.text_match import compiled_pattern

        with pytest.raises(ValueError) as exc:
            compiled_pattern("passport")
        assert "passport" in str(exc.value)
        for known in PATTERN_IDS:
            assert known in str(exc.value)
