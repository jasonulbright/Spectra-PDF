"""The `url` built-in pattern: precision and recall, measured on a corpus.

The Luhn precedent, applied to addresses. A pattern that fires on every token
with a dot in it teaches the user to stop reading the list, so the corpus below
carries LOOKALIKES beside the real addresses and both numbers are asserted at
1.0 — and printed, so a regression reads as a number rather than a boolean.
"""

from engine.text_match import (
    PATTERNS,
    _trim_url,
    _valid_url,
    email_target,
    pattern_spans,
    url_target,
)

# (sentence, the exact substrings that MUST be reported)
POSITIVES = [
    ("See https://example.com for details.", ["https://example.com"]),
    ("Read http://docs.example.org/guide/intro.html now.", ["http://docs.example.org/guide/intro.html"]),
    ("Mirror: ftp://files.example.net/pub/", ["ftp://files.example.net/pub/"]),
    ("Secure mirror ftps://files.example.net/pub", ["ftps://files.example.net/pub"]),
    ("Write to mailto:press@example.com today", ["mailto:press@example.com"]),
    ("Our site is www.example.co.uk.", ["www.example.co.uk"]),
    ("Query: https://example.com/s?q=pdf&page=2#top", ["https://example.com/s?q=pdf&page=2#top"]),
    ("(see http://example.com/a)", ["http://example.com/a"]),
    ("A page named https://example.com/a_(b) exists", ["https://example.com/a_(b)"]),
    ("Ends a sentence: https://example.com/report.", ["https://example.com/report"]),
    ("Comma list: www.a-one.com, www.b-two.org", ["www.a-one.com", "www.b-two.org"]),
    ("Port form http://example.com:8080/x", ["http://example.com:8080/x"]),
    ("Two on a line https://a.example and http://b.example", ["https://a.example", "http://b.example"]),
    ("Trailing quote \"https://example.com/x\" here", ["https://example.com/x"]),
]

# Text that must produce NO url hit. Every one of these is a real shape found
# in documents and every one of them has a dot in it.
NEGATIVES = [
    "e.g. the appendix",
    "See Fig.2 on the next page",
    "Version v1.0.25 shipped",
    "Attached: report.pdf and notes.docx",
    "The ratio was 3.14159 exactly",
    "Section 4.2.1 covers it",
    "Contact the team (no address given)",
    "Mr. Smith and Mrs. Jones attended",
    "example.com without a scheme is not linked",
    "an http:// with no host",
    "www. with nothing after it",
    "path/to/file.txt in the archive",
    "192.168.0.1 on the local network",
    "U.S.A. and U.K. delegates",
]


def _hits(text: str) -> list[str]:
    return [text[s:e] for s, e in pattern_spans("url", text)]


class TestPrecisionAndRecall:
    def test_corpus_precision_and_recall_are_one(self, capsys):
        true_positives = 0
        false_negatives = 0
        false_positives = 0
        for text, expected in POSITIVES:
            found = _hits(text)
            for want in expected:
                if want in found:
                    true_positives += 1
                else:
                    false_negatives += 1
            for got in found:
                if got not in expected:
                    false_positives += 1
        for text in NEGATIVES:
            false_positives += len(_hits(text))
        precision = true_positives / max(true_positives + false_positives, 1)
        recall = true_positives / max(true_positives + false_negatives, 1)
        with capsys.disabled():
            print(
                f"\nurl pattern over {len(POSITIVES)} positives / {len(NEGATIVES)} "
                f"lookalikes: precision {precision:.3f}, recall {recall:.3f} "
                f"(tp {true_positives}, fp {false_positives}, fn {false_negatives})"
            )
        assert precision == 1.0
        assert recall == 1.0

    def test_every_negative_is_named_when_it_fires(self):
        # A failure here should say WHICH lookalike started matching.
        for text in NEGATIVES:
            assert _hits(text) == [], text


class TestTrimming:
    def test_sentence_punctuation_is_dropped(self):
        for tail in (".", ",", ";", ":", "!", "?", "…", '"', "'"):
            raw = "https://example.com/a" + tail
            assert raw[: _trim_url(raw)] == "https://example.com/a", tail

    def test_unbalanced_closing_bracket_is_dropped(self):
        raw = "https://example.com/a)"
        assert raw[: _trim_url(raw)] == "https://example.com/a"

    def test_balanced_closing_bracket_is_kept(self):
        raw = "https://example.com/a_(b)"
        assert raw[: _trim_url(raw)] == raw

    def test_trailing_run_is_dropped_together(self):
        raw = "https://example.com/a).",
        assert raw[0][: _trim_url(raw[0])] == "https://example.com/a"


class TestValidation:
    def test_unknown_scheme_is_refused(self):
        assert not _valid_url("gopher://example.com/x")
        assert _hits("Try gopher://example.com/x") == []

    def test_single_label_host_is_refused(self):
        assert not _valid_url("http://localhost/x")

    def test_numeric_tld_is_refused(self):
        assert not _valid_url("http://example.123/x")

    def test_mailto_validates_its_address(self):
        assert _valid_url("mailto:a.b@example.org")
        assert not _valid_url("mailto:not-an-address")


class TestTargets:
    def test_www_gains_a_scheme(self):
        assert url_target("www.example.com") == "https://www.example.com"

    def test_absolute_url_is_unchanged(self):
        assert url_target("http://example.com/a") == "http://example.com/a"

    def test_email_becomes_mailto(self):
        assert email_target("a@example.com") == "mailto:a@example.com"


class TestRegistration:
    def test_url_is_a_built_in_pattern_with_a_validator_and_a_trim(self):
        definition = PATTERNS["url"]
        assert definition.validate is not None
        assert definition.trim is not None

    def test_email_pattern_still_finds_a_bare_address(self):
        # The url pattern must not have changed what `email` reports.
        text = "write to a.b@example.org please"
        spans = pattern_spans("email", text)
        assert [text[s:e] for s, e in spans] == ["a.b@example.org"]
