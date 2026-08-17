"""Tests for the spell checker.

Three layers, each with its own failure mode:

* the TOKENIZER, which decides what is even a spelling question. Pure, so
  every rule is pinned here rather than inferred from a document walk.
* the DICTIONARIES, gated per language against `spelling_words.py`. A word
  list that rejects its own everyday vocabulary paints the whole document red,
  so "ordinary words accepted, planted misspellings rejected" is the shipping
  condition for a tag, checked for all 36 rather than sampled.
* the DOCUMENT WALK and its refusals, over hand-built fixtures.
"""

import hashlib
import json
import os
import shutil
import unicodedata

import pikepdf
import pytest
from pikepdf import Dictionary, Name

from engine.spelling import (
    VoikkoDictionary,
    add_user_dictionary,
    check_spelling,
    check_word,
    document_language,
    list_dictionaries,
    load_dictionary,
    resolved_tag,
    spelling_suggestions,
    suggest_word,
    tokenize,
)

from spelling_words import WORDS

DICT_DIR = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "resources", "dictionaries"
)


#: The Finnish tag ships a morphological analyser instead of a word list, so
#: its provisioning question is a different set of files.
VOIKKO_TAG = "fi"
VOIKKO_FILES = (
    "libvoikko-1.dll",
    "libvoikko.py",
    os.path.join("5", "mor-standard", "index.txt"),
    os.path.join("5", "mor-standard", "mor.vfst"),
)


def _provisioned(tag: str) -> bool:
    """The FILES, never the directory. `release.yml` creates an empty
    resources/dictionaries stub for the Tauri build script, and an
    `isdir` guard is satisfied by that stub — which is exactly the state
    neither a provisioned box nor a bare checkout ever reaches."""
    if tag == VOIKKO_TAG:
        return all(os.path.isfile(os.path.join(DICT_DIR, tag, name)) for name in VOIKKO_FILES)
    base = os.path.join(DICT_DIR, tag, tag)
    return os.path.isfile(base + ".aff") and os.path.isfile(base + ".dic")


def _require(tag: str) -> str:
    if not _provisioned(tag):
        pytest.skip(f"{tag} dictionary not provisioned")
    return DICT_DIR


SHIPPED_TAGS = sorted(WORDS)


# ═══════════════════════════════ tokenizer ═════════════════════════════════


class TestTokenize:
    def words(self, text: str, **kw) -> list[str]:
        return [t["word"] for t in tokenize(text, **kw)]

    def test_plain_words_split_on_punctuation_and_space(self):
        assert self.words("The quick, brown fox!") == ["The", "quick", "brown", "fox"]

    def test_apostrophe_between_letters_stays_inside_the_word(self):
        assert self.words("don't") == ["don't"]
        assert self.words("l’étoile") == ["l’étoile"]

    def test_apostrophe_at_an_edge_is_punctuation(self):
        assert self.words("'quoted'") == ["quoted"]

    def test_hyphen_between_letters_stays_inside_the_word(self):
        assert self.words("well-known") == ["well-known"]

    def test_trailing_hyphen_is_not_part_of_the_word(self):
        assert self.words("well- known") == ["well", "known"]

    def test_a_token_with_a_digit_is_not_a_spelling_question(self):
        assert self.words("H2O costs 20 dollars") == ["costs", "dollars"]

    def test_digits_can_be_opted_back_in(self):
        assert "H2O" in self.words(
            "H2O water", ignore_with_digits=False, ignore_uppercase=False
        )

    def test_acronyms_are_skipped_by_default(self):
        assert self.words("The PDF and ISO rules") == ["The", "and", "rules"]

    def test_acronyms_can_be_opted_back_in(self):
        assert "PDF" in self.words("The PDF rules", ignore_uppercase=False)

    def test_a_single_capital_letter_is_not_an_acronym(self):
        assert self.words("A house", ignore_uppercase=True) == ["A", "house"]

    def test_urls_are_skipped_whole(self):
        assert self.words("see https://exampl.com/pth now") == ["see", "now"]

    def test_www_hosts_are_skipped_whole(self):
        assert self.words("see www.exampl.co.uk today") == ["see", "today"]

    def test_email_addresses_are_skipped_whole(self):
        assert self.words("mail jsmth@exampl.com please") == ["mail", "please"]

    def test_file_names_are_skipped_whole(self):
        assert self.words("open report.pdf now") == ["open", "now"]

    def test_dotted_versions_are_skipped_whole(self):
        assert self.words("build v1.0.25 shipped") == ["build", "shipped"]

    def test_abbreviations_with_internal_dots_are_skipped(self):
        assert self.words("see e.g. this") == ["see", "this"]

    def test_a_sentence_boundary_is_not_a_dotted_run(self):
        assert self.words("End. Next one") == ["End", "Next", "one"]

    def test_offsets_are_code_points_not_utf16_units(self):
        # The astral clef is ONE code point; a UTF-16 offset would report the
        # following word two positions late and retarget every fix after it.
        text = "𝄞 hello"
        token = tokenize(text)[0]
        assert token["word"] == "hello"
        assert token["start"] == 2
        assert list(text)[token["start"] : token["end"]] == list("hello")

    def test_offsets_address_the_word_they_name(self):
        for token in tokenize("alpha beta-gamma don't"):
            text = "alpha beta-gamma don't"
            assert "".join(list(text)[token["start"] : token["end"]]) == token["word"]

    def test_empty_text_yields_nothing(self):
        assert tokenize("") == []

    def test_punctuation_only_text_yields_nothing(self):
        assert tokenize("--- ... ,,,") == []


# ═══════════════════════════ the shipped set ═══════════════════════════════


class TestShippedDictionaries:
    def test_every_tag_with_a_word_list_is_on_disk(self):
        if not _provisioned("en_US"):
            pytest.skip("dictionaries not provisioned")
        listed = {d["tag"] for d in list_dictionaries(DICT_DIR)["dictionaries"]}
        assert set(SHIPPED_TAGS) <= listed

    def test_every_tag_on_disk_has_a_word_list(self):
        if not _provisioned("en_US"):
            pytest.skip("dictionaries not provisioned")
        listed = {d["tag"] for d in list_dictionaries(DICT_DIR)["dictionaries"]}
        assert listed <= set(SHIPPED_TAGS)

    def test_listing_reports_a_bcp47_tag_for_every_dictionary(self):
        if not _provisioned("en_US"):
            pytest.skip("dictionaries not provisioned")
        for entry in list_dictionaries(DICT_DIR)["dictionaries"]:
            assert entry["bcp47"] == entry["tag"].replace("_", "-")
            assert entry["origin"] == "bundled"

    @pytest.mark.parametrize("tag", SHIPPED_TAGS)
    def test_ordinary_words_are_accepted(self, tag):
        _require(tag)
        dictionary = load_dictionary(tag, DICT_DIR)
        rejected = [w for w in WORDS[tag]["good"] if not check_word(dictionary, w, set())]
        assert rejected == []

    @pytest.mark.parametrize("tag", SHIPPED_TAGS)
    def test_planted_misspellings_are_rejected(self, tag):
        _require(tag)
        dictionary = load_dictionary(tag, DICT_DIR)
        accepted = [w for w in WORDS[tag]["bad"] if check_word(dictionary, w, set())]
        assert accepted == []

    def test_hungarian_loads_despite_an_uncompilable_replacement_pattern(self):
        # spylls compiles REP patterns as regular expressions; hunspell's REP
        # table is not one. A `ph:` field in this word list contains `[`, and
        # without the tolerance adapter the whole language fails to load.
        _require("hu_HU")
        dictionary = load_dictionary("hu_HU", DICT_DIR)
        assert check_word(dictionary, "iskola", set())

    def test_a_flag_directive_is_not_read_as_an_alias_index(self):
        # spylls expands the AF alias table inside its shared flag parser, so a
        # `FLAG num` dictionary that also carries AF has every all-digit
        # DIRECTIVE value read as an alias index — and the singular parser then
        # picks an arbitrary member of that alias's set, which varies with the
        # process hash seed. Korean is such a dictionary: the misread
        # FORBIDDENWORD is a flag most of its own stems hold.
        _require("ko_KR")
        load_dictionary("ko_KR", DICT_DIR)
        from spylls.hunspell import Dictionary

        aff = Dictionary.from_files(os.path.join(DICT_DIR, "ko_KR", "ko_KR")).aff
        assert aff.FORBIDDENWORD == "15"
        assert aff.ONLYINCOMPOUND == "1"

    def test_a_decomposed_word_list_answers_a_composed_document(self):
        # The Korean list stores stems as conjoining jamo while a document
        # carries precomposed syllables; the .aff's ICONV table is the bridge.
        _require("ko_KR")
        dictionary = load_dictionary("ko_KR", DICT_DIR)
        composed = "사람"
        assert check_word(dictionary, composed, set())
        assert check_word(dictionary, unicodedata.normalize("NFD", composed), set())

    def test_a_decomposed_word_list_suggests_for_a_composed_word(self):
        # The candidates are built by editing the characters of the list's own
        # TRY set — decomposed jamo — so a composed misspelling generates
        # nothing at all unless it is offered decomposed first.
        _require("ko_KR")
        result = spelling_suggestions("한구국", "ko_KR", DICT_DIR)
        assert result["correct"] is False
        assert "한국" in result["suggestions"]

    def test_a_suggestion_is_written_the_way_the_word_was(self):
        # The suggestion is replacement text for the document, so it must not
        # arrive decomposed because the word list happens to be.
        _require("ko_KR")
        suggestions = spelling_suggestions("한구국", "ko_KR", DICT_DIR)["suggestions"]
        assert suggestions
        for suggestion in suggestions:
            assert suggestion == unicodedata.normalize("NFC", suggestion)


# ═════════════════════ the morphological dictionary ════════════════════════
#
# Finnish is checked by a transducer rather than a word list. What is pinned
# here is the SEAM: the adapter answers the same two questions the Hunspell
# path answers, the vendored library is the only one that can ever be loaded,
# and a Voikko tree outside the shipped directory is not a dictionary.


class TestFinnishMorphology:
    def test_the_finnish_tag_resolves_and_loads_as_an_analyser(self):
        _require(VOIKKO_TAG)
        assert resolved_tag("fi", DICT_DIR) == VOIKKO_TAG
        assert resolved_tag("fi-FI", DICT_DIR) == VOIKKO_TAG
        assert isinstance(load_dictionary("fi", DICT_DIR), VoikkoDictionary)

    def test_a_generated_form_no_word_list_could_hold_is_accepted(self):
        # Both shapes the analyser exists for: an inflection nine morphemes
        # deep, and a compound built at will. A frequency list holds neither.
        _require(VOIKKO_TAG)
        dictionary = load_dictionary("fi", DICT_DIR)
        assert dictionary.lookup("juoksentelisinkohan")
        assert dictionary.lookup("kissoillammekaan")
        assert not dictionary.lookup("juoksentelisinkohaan")

    def test_the_adapter_answers_an_empty_word_without_asking(self):
        _require(VOIKKO_TAG)
        dictionary = load_dictionary("fi", DICT_DIR)
        assert dictionary.lookup("") is False
        assert dictionary.suggest("") == []

    def test_a_correction_may_be_a_SPLIT_and_is_offered_as_one(self):
        # Voikko corrects a run-together pair by splitting it, so a replacement
        # is not always one token. Every fix site replaces a code-point RANGE
        # with a string, so a space in the replacement is ordinary; dropping
        # these would leave the whole class of error with no correct answer.
        _require(VOIKKO_TAG)
        result = spelling_suggestions("menenkotiin", "fi", DICT_DIR, limit=10)
        assert result["correct"] is False
        assert "menen kotiin" in result["suggestions"]

    def test_a_decomposed_word_is_accepted_and_answered_decomposed(self):
        # The analyser folds normalization itself and always answers composed,
        # so without the adapter's declared domain a document written in NFD
        # would be corrected with NFC replacement text.
        _require(VOIKKO_TAG)
        dictionary = load_dictionary("fi", DICT_DIR)
        composed = "työpöytä"
        assert check_word(dictionary, composed, set())
        assert check_word(dictionary, unicodedata.normalize("NFD", composed), set())
        suggestions = spelling_suggestions(
            unicodedata.normalize("NFD", "hyvvää"), "fi", DICT_DIR
        )["suggestions"]
        assert suggestions
        for suggestion in suggestions:
            assert suggestion == unicodedata.normalize("NFD", suggestion)

    def test_a_tree_without_the_vendored_library_refuses_rather_than_finding_one(self, tmp_dir):
        # The binding's own loader falls back to a BARE `libvoikko-1.dll`,
        # which Windows resolves against the system search path. A morphology
        # tree with no library beside it is exactly the state that fallback
        # would rescue, so it must refuse instead — otherwise a machine with
        # Voikko installed would silently spell-check against that copy.
        tree = os.path.join(tmp_dir, "fi", "5", "mor-standard")
        os.makedirs(tree)
        with open(os.path.join(tree, "index.txt"), "w", encoding="utf-8") as f:
            f.write("Voikko-Dictionary-Format: 5\nLanguage: fi-x-standard\n")
        with pytest.raises(ValueError, match="incomplete"):
            load_dictionary("fi", tmp_dir)

    def test_a_voikko_tree_in_the_user_directory_is_not_a_dictionary(self, tmp_dir):
        # One engine per shipped tree: the analyser is a vendored native
        # library, and nothing dropped into the user directory can be the one
        # the app links. User additions ride the custom-word list instead.
        user_dir = os.path.join(tmp_dir, "user")
        tree = os.path.join(user_dir, "zz_mor", "5", "mor-standard")
        os.makedirs(tree)
        with open(os.path.join(tree, "index.txt"), "w", encoding="utf-8") as f:
            f.write("Voikko-Dictionary-Format: 5\nLanguage: zz\n")
        assert list_dictionaries(None, user_dir)["dictionaries"] == []
        with pytest.raises(ValueError, match="No spelling dictionary for"):
            resolved_tag("zz_mor", None, user_dir)

    def test_a_word_list_wins_over_a_voikko_tree_in_the_same_directory(self, tmp_dir):
        # The refusal above is enforced by the tag scan, which never yields a
        # user Voikko tree. A directory holding BOTH shapes still reaches the
        # loader, so the loader keeps the same precedence rather than reading
        # the tree that the scan already declined to offer.
        user_dir = os.path.join(tmp_dir, "user")
        tag_dir = os.path.join(user_dir, "zz_ZZ")
        os.makedirs(os.path.join(tag_dir, "5", "mor-standard"))
        with open(os.path.join(tag_dir, "5", "mor-standard", "index.txt"), "w", encoding="utf-8") as f:
            f.write("Voikko-Dictionary-Format: 5\n")
        with open(os.path.join(tag_dir, "zz_ZZ.aff"), "w", encoding="utf-8") as f:
            f.write("SET UTF-8\n")
        with open(os.path.join(tag_dir, "zz_ZZ.dic"), "w", encoding="utf-8") as f:
            f.write("1\nwibble\n")
        dictionary = load_dictionary("zz_ZZ", None, user_dir)
        assert not isinstance(dictionary, VoikkoDictionary)
        assert check_word(dictionary, "wibble", set())

    def test_a_user_pair_cannot_take_the_finnish_tag(self, tmp_dir):
        # The bundled-tag collision check reads the same widened listing, so
        # the analyser's tag is claimed against user pairs like any other.
        _require(VOIKKO_TAG)
        aff = os.path.join(tmp_dir, "fi.aff")
        dic = os.path.join(tmp_dir, "fi.dic")
        with open(aff, "w", encoding="utf-8") as f:
            f.write("SET UTF-8\n")
        with open(dic, "w", encoding="utf-8") as f:
            f.write("1\nwibble\n")
        user_dir = os.path.join(tmp_dir, "user")
        os.makedirs(user_dir)
        with pytest.raises(ValueError, match="already ships with the app"):
            add_user_dictionary(aff, dic, user_dir, DICT_DIR)


# ═════════════════════════ resolution and lookup ═══════════════════════════


class TestResolution:
    def test_an_exact_tag_resolves_to_itself(self):
        _require("en_GB")
        assert resolved_tag("en_GB", DICT_DIR) == "en_GB"

    def test_a_bcp47_spelling_resolves(self):
        _require("en_GB")
        assert resolved_tag("en-GB", DICT_DIR) == "en_GB"

    def test_a_bare_base_language_resolves_to_a_region(self):
        _require("en_US")
        assert resolved_tag("en", DICT_DIR).startswith("en_")

    def test_an_unknown_language_refuses_by_name(self):
        _require("en_US")
        with pytest.raises(ValueError, match="No spelling dictionary for"):
            resolved_tag("zz_ZZ", DICT_DIR)


class TestLookup:
    def test_a_custom_word_is_accepted_without_touching_the_dictionary(self):
        _require("en_US")
        dictionary = load_dictionary("en_US", DICT_DIR)
        assert not check_word(dictionary, "Zorblat", set())
        assert check_word(dictionary, "Zorblat", {"Zorblat", "zorblat"})

    def test_a_custom_word_matches_case_insensitively(self):
        _require("en_US")
        dictionary = load_dictionary("en_US", DICT_DIR)
        assert check_word(dictionary, "Zorblat", {"zorblat"})

    def test_suggestions_lead_with_the_intended_word(self):
        _require("en_US")
        dictionary = load_dictionary("en_US", DICT_DIR)
        assert suggest_word(dictionary, "recieve")[0] == "receive"
        assert suggest_word(dictionary, "seperate")[0] == "separate"

    def test_suggestions_honour_the_cap(self):
        _require("en_US")
        dictionary = load_dictionary("en_US", DICT_DIR)
        assert len(suggest_word(dictionary, "helo", limit=3)) <= 3

    def test_a_correct_word_asks_for_no_suggestions(self):
        _require("en_US")
        result = spelling_suggestions("receive", "en_US", DICT_DIR)
        assert result["correct"] is True
        assert result["suggestions"] == []

    def test_a_custom_word_is_correct_at_the_door_too(self):
        _require("en_US")
        result = spelling_suggestions("Spectra", "en_US", DICT_DIR, custom_words=["Spectra"])
        assert result["correct"] is True

    def test_an_empty_word_refuses_by_name(self):
        _require("en_US")
        with pytest.raises(ValueError, match="No word to suggest for"):
            spelling_suggestions("   ", "en_US", DICT_DIR)


# ═════════════════════════════ document walk ═══════════════════════════════


def _helv(pdf):
    return pdf.make_indirect(
        Dictionary(
            Type=Name("/Font"),
            Subtype=Name("/Type1"),
            BaseFont=Name("/Helvetica"),
            Encoding=Name("/WinAnsiEncoding"),
        )
    )


def _build(tmp_dir, content: bytes, name="spell.pdf", lang: str | None = None) -> str:
    src = os.path.join(tmp_dir, name)
    pdf = pikepdf.new()
    page = pdf.add_blank_page(page_size=(612, 792))
    page.obj["/Resources"] = Dictionary(Font=Dictionary(F1=_helv(pdf)))
    page.Contents = pdf.make_stream(content)
    if lang:
        pdf.Root["/Lang"] = pikepdf.String(lang)
    pdf.save(src)
    pdf.close()
    return src


MISSPELLED = b"BT /F1 12 Tf 72 700 Td (The documnt is seperate) Tj ET"
CORRECT = b"BT /F1 12 Tf 72 700 Td (The document is separate) Tj ET"


class TestDocumentWalk:
    def test_page_text_misspellings_are_found_with_their_offsets(self, tmp_dir):
        _require("en_US")
        src = _build(tmp_dir, MISSPELLED)
        result = check_spelling(src, DICT_DIR, "en_US", sources=["text"])
        words = [i["word"] for i in result["issues"]]
        assert words == ["documnt", "seperate"]
        for issue in result["issues"]:
            text = issue["paragraph_text"]
            assert "".join(list(text)[issue["start"] : issue["end"]]) == issue["word"]

    def test_a_page_text_hit_carries_the_paragraph_fingerprint(self, tmp_dir):
        _require("en_US")
        src = _build(tmp_dir, MISSPELLED)
        issue = check_spelling(src, DICT_DIR, "en_US", sources=["text"])["issues"][0]
        assert issue["source"] == "text"
        assert issue["page"] == 1
        assert issue["paragraph"] == 0
        assert issue["runs"] == [0]

    def test_a_clean_document_reports_nothing(self, tmp_dir):
        _require("en_US")
        src = _build(tmp_dir, CORRECT)
        result = check_spelling(src, DICT_DIR, "en_US", sources=["text"])
        assert result["issues"] == []
        assert result["checked"]["paragraphs"] == 1
        assert result["words"] == 4

    def test_custom_words_silence_a_hit(self, tmp_dir):
        _require("en_US")
        src = _build(tmp_dir, MISSPELLED)
        result = check_spelling(
            src, DICT_DIR, "en_US", sources=["text"], custom_words=["documnt", "seperate"]
        )
        assert result["issues"] == []

    def test_comments_are_walked(self, tmp_dir):
        _require("en_US")
        src = _build(tmp_dir, CORRECT)
        with pikepdf.open(src, allow_overwriting_input=True) as pdf:
            page = pdf.pages[0]
            page.obj["/Annots"] = pikepdf.Array(
                [
                    pdf.make_indirect(
                        Dictionary(
                            Type=Name("/Annot"),
                            Subtype=Name("/Text"),
                            Rect=pikepdf.Array([10, 10, 30, 30]),
                            Contents=pikepdf.String("this is definately wrong"),
                        )
                    )
                ]
            )
            pdf.save()
        result = check_spelling(src, DICT_DIR, "en_US", sources=["comments"])
        assert [i["word"] for i in result["issues"]] == ["definately"]
        assert result["issues"][0]["annotation"] == 0
        assert result["issues"][0]["subtype"] == "Text"

    def test_form_field_values_are_walked(self, tmp_dir):
        _require("en_US")
        src = _build(tmp_dir, CORRECT)
        with pikepdf.open(src, allow_overwriting_input=True) as pdf:
            field = pdf.make_indirect(
                Dictionary(
                    Type=Name("/Annot"),
                    Subtype=Name("/Widget"),
                    FT=Name("/Tx"),
                    T=pikepdf.String("Notes"),
                    V=pikepdf.String("acomodation booked"),
                    Rect=pikepdf.Array([10, 10, 200, 30]),
                )
            )
            pdf.pages[0].obj["/Annots"] = pikepdf.Array([field])
            field["/P"] = pdf.pages[0].obj
            pdf.Root["/AcroForm"] = pdf.make_indirect(
                Dictionary(Fields=pikepdf.Array([field]))
            )
            pdf.save()
        result = check_spelling(src, DICT_DIR, "en_US", sources=["fields"])
        assert [i["word"] for i in result["issues"]] == ["acomodation"]
        assert result["issues"][0]["field"] == "Notes"

    def test_sources_can_be_narrowed(self, tmp_dir):
        _require("en_US")
        src = _build(tmp_dir, MISSPELLED)
        with pikepdf.open(src, allow_overwriting_input=True) as pdf:
            pdf.pages[0].obj["/Annots"] = pikepdf.Array(
                [
                    pdf.make_indirect(
                        Dictionary(
                            Type=Name("/Annot"),
                            Subtype=Name("/Text"),
                            Rect=pikepdf.Array([10, 10, 30, 30]),
                            Contents=pikepdf.String("definately"),
                        )
                    )
                ]
            )
            pdf.save()
        assert check_spelling(src, DICT_DIR, "en_US")["counts"]["text"] == 2
        narrowed = check_spelling(src, DICT_DIR, "en_US", sources=["comments"])
        assert narrowed["counts"]["text"] == 0
        assert narrowed["counts"]["comments"] == 1

    def test_a_scope_with_nothing_in_it_refuses_by_name(self, tmp_dir):
        _require("en_US")
        src = _build(tmp_dir, MISSPELLED)
        with pytest.raises(ValueError, match="nothing to spell-check"):
            check_spelling(src, DICT_DIR, "en_US", sources=["comments"])

    def test_an_unknown_source_refuses_by_name(self, tmp_dir):
        _require("en_US")
        src = _build(tmp_dir, MISSPELLED)
        with pytest.raises(ValueError, match="unknown spell-check source"):
            check_spelling(src, DICT_DIR, "en_US", sources=["footnotes"])

    def test_a_page_out_of_range_refuses_by_name(self, tmp_dir):
        _require("en_US")
        src = _build(tmp_dir, MISSPELLED)
        with pytest.raises(ValueError, match="out of range"):
            check_spelling(src, DICT_DIR, "en_US", pages=[9])

    def test_a_document_with_no_text_refuses_by_name(self, tmp_dir):
        _require("en_US")
        src = _build(tmp_dir, b"0 0 1 RG 10 10 m 100 100 l S")
        with pytest.raises(ValueError, match="nothing to spell-check"):
            check_spelling(src, DICT_DIR, "en_US")

    def test_an_unknown_language_refuses_by_name(self, tmp_dir):
        _require("en_US")
        src = _build(tmp_dir, MISSPELLED)
        with pytest.raises(ValueError, match="No spelling dictionary for"):
            check_spelling(src, DICT_DIR, "zz_ZZ")

    def test_the_walk_reports_which_dictionary_it_used(self, tmp_dir):
        _require("en_GB")
        src = _build(tmp_dir, CORRECT)
        result = check_spelling(src, DICT_DIR, "en-GB", sources=["text"])
        assert result["tag"] == "en_GB"
        assert result["bcp47"] == "en-GB"

    def test_the_document_language_is_reported_and_defaulted_to(self, tmp_dir):
        _require("en_GB")
        src = _build(tmp_dir, CORRECT, lang="en-GB")
        assert document_language(src)["language"] == "en-GB"
        result = check_spelling(src, DICT_DIR, sources=["text"])
        assert result["document_language"] == "en-GB"
        assert result["tag"] == "en_GB"

    def test_a_document_stating_no_language_falls_back(self, tmp_dir):
        _require("en_US")
        src = _build(tmp_dir, CORRECT)
        assert document_language(src)["language"] is None
        assert check_spelling(src, DICT_DIR, sources=["text"])["tag"].startswith("en_")

    def test_the_issue_cap_is_reported_rather_than_silently_applied(self, tmp_dir):
        _require("en_US")
        src = _build(tmp_dir, MISSPELLED)
        result = check_spelling(src, DICT_DIR, "en_US", sources=["text"], max_issues=1)
        assert len(result["issues"]) == 1
        assert result["truncated"] is True


# ═════════════════════════ user dictionaries ═══════════════════════════════


class TestUserDictionaries:
    def _pair(self, tmp_dir, name="zz_ZZ"):
        aff = os.path.join(tmp_dir, f"{name}.aff")
        dic = os.path.join(tmp_dir, f"{name}.dic")
        with open(aff, "w", encoding="utf-8") as f:
            f.write("SET UTF-8\n")
        with open(dic, "w", encoding="utf-8") as f:
            f.write("2\nwibble\nwobble\n")
        return aff, dic

    def test_a_user_pair_is_copied_in_and_then_resolves(self, tmp_dir):
        aff, dic = self._pair(tmp_dir)
        user_dir = os.path.join(tmp_dir, "user")
        os.makedirs(user_dir)
        added = add_user_dictionary(aff, dic, user_dir)
        assert added["tag"] == "zz_ZZ"
        assert added["origin"] == "user"
        dictionary = load_dictionary("zz_ZZ", None, user_dir)
        assert check_word(dictionary, "wibble", set())

    def test_the_copy_survives_the_source_going_away(self, tmp_dir):
        aff, dic = self._pair(tmp_dir)
        user_dir = os.path.join(tmp_dir, "user")
        os.makedirs(user_dir)
        add_user_dictionary(aff, dic, user_dir)
        os.remove(aff)
        os.remove(dic)
        assert check_word(load_dictionary("zz_ZZ", None, user_dir), "wobble", set())

    def test_a_user_dictionary_is_listed_with_its_origin(self, tmp_dir):
        aff, dic = self._pair(tmp_dir)
        user_dir = os.path.join(tmp_dir, "user")
        os.makedirs(user_dir)
        add_user_dictionary(aff, dic, user_dir)
        listed = list_dictionaries(None, user_dir)["dictionaries"]
        assert [e["origin"] for e in listed] == ["user"]

    def test_a_collision_with_a_bundled_tag_refuses_by_name(self, tmp_dir):
        _require("en_US")
        aff, dic = self._pair(tmp_dir, "en_US")
        user_dir = os.path.join(tmp_dir, "user")
        os.makedirs(user_dir)
        with pytest.raises(ValueError, match="already ships with the app"):
            add_user_dictionary(aff, dic, user_dir, DICT_DIR)

    def test_adding_the_same_tag_twice_refuses_by_name(self, tmp_dir):
        aff, dic = self._pair(tmp_dir)
        user_dir = os.path.join(tmp_dir, "user")
        os.makedirs(user_dir)
        add_user_dictionary(aff, dic, user_dir)
        with pytest.raises(ValueError, match="has already been added"):
            add_user_dictionary(aff, dic, user_dir)

    def test_a_missing_file_refuses_by_name(self, tmp_dir):
        _, dic = self._pair(tmp_dir)
        user_dir = os.path.join(tmp_dir, "user")
        os.makedirs(user_dir)
        with pytest.raises(ValueError, match="file not found"):
            add_user_dictionary(os.path.join(tmp_dir, "nope.aff"), dic, user_dir)

    def test_wrong_extensions_refuse_by_name(self, tmp_dir):
        aff, dic = self._pair(tmp_dir)
        user_dir = os.path.join(tmp_dir, "user")
        os.makedirs(user_dir)
        with pytest.raises(ValueError, match="an .aff file and a .dic file"):
            add_user_dictionary(dic, aff, user_dir)

    def test_an_unreadable_pair_refuses_and_leaves_nothing_behind(self, tmp_dir):
        aff = os.path.join(tmp_dir, "bad_ZZ.aff")
        dic = os.path.join(tmp_dir, "bad_ZZ.dic")
        with open(aff, "wb") as f:
            f.write(b"SET NOT-A-REAL-ENCODING\n")
        with open(dic, "wb") as f:
            f.write(b"\xff\xfe\x00broken")
        user_dir = os.path.join(tmp_dir, "user")
        os.makedirs(user_dir)
        with pytest.raises(ValueError, match="could not be read"):
            add_user_dictionary(aff, dic, user_dir)
        assert not os.path.isdir(os.path.join(user_dir, "bad_ZZ"))

    def test_an_unusable_name_refuses_by_name(self, tmp_dir):
        aff, dic = self._pair(tmp_dir)
        user_dir = os.path.join(tmp_dir, "user")
        os.makedirs(user_dir)
        with pytest.raises(ValueError, match="not a usable dictionary name"):
            add_user_dictionary(aff, dic, user_dir, tag="../escape")


# ═══════════════════════ the manifest and its gate ═════════════════════════


class TestManifest:
    MANIFEST = os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "scripts", "dictionaries.tsv"
    )

    def rows(self):
        out = []
        with open(self.MANIFEST, encoding="utf-8") as f:
            for line in f:
                if line.startswith("#") or line.startswith("tag\t") or not line.strip():
                    continue
                out.append(line.rstrip("\n").split("\t"))
        return out

    def test_every_row_carries_a_hash_a_licence_and_a_source(self):
        for tag, role, upstream, sha, spdx, source in self.rows():
            assert len(sha) == 64, f"{tag}/{upstream}"
            assert spdx, f"{tag}/{upstream}"
            assert source.startswith("https://"), f"{tag}/{upstream}"

    def test_every_shipped_tag_carries_a_notice_row(self):
        roles: dict[str, set[str]] = {}
        for tag, role, *_ in self.rows():
            roles.setdefault(tag, set()).add(role)
        for tag, present in roles.items():
            if "aff" in present:
                assert "dic" in present, tag
                assert "notice" in present, tag

    def test_the_manifest_and_the_word_lists_name_the_same_tags(self):
        # The morphological tag is smoke-gated like every other but has no
        # word list to pin, so it is manifested by scripts/voikko.tsv instead.
        tags = {tag for tag, role, *_ in self.rows() if role == "aff"}
        assert tags == set(SHIPPED_TAGS) - {VOIKKO_TAG}

    def test_the_provisioned_tree_ships_every_notice_the_manifest_names(self):
        if not _provisioned("en_US"):
            pytest.skip("dictionaries not provisioned")
        for tag, role, upstream, *_ in self.rows():
            if role != "notice":
                continue
            expected = os.path.join(DICT_DIR, tag, "notices", os.path.basename(upstream))
            assert os.path.isfile(expected), expected


class TestVoikkoManifest:
    MANIFEST = os.path.join(
        os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "scripts", "voikko.tsv"
    )

    def rows(self):
        out = []
        with open(self.MANIFEST, encoding="utf-8") as f:
            for line in f:
                if line.startswith("#") or line.startswith("file\t") or not line.strip():
                    continue
                out.append(line.rstrip("\n").split("\t"))
        return out

    def test_every_row_carries_a_licence_a_notice_and_a_source(self):
        notices = {os.path.basename(f) for f, _c, role, *_ in self.rows() if role == "notice"}
        for file, component, role, sha, spdx, notice, source in self.rows():
            assert component, file
            assert spdx, file
            assert source, file
            # A `runtime` row's bytes are whatever bundle-tesseract.ps1
            # vendored, so it pins a notice rather than a hash.
            assert sha == "-" or len(sha) == 64, file
            assert notice in notices, file

    def test_every_shipped_binary_has_a_row(self):
        if not _provisioned(VOIKKO_TAG):
            pytest.skip("Finnish dictionary not provisioned")
        listed = {file for file, *_ in self.rows()}
        root = os.path.join(DICT_DIR, VOIKKO_TAG)
        for dirpath, _dirs, files in os.walk(root):
            for name in files:
                if not name.lower().endswith(".dll"):
                    continue
                shipped = os.path.relpath(os.path.join(dirpath, name), root).replace(os.sep, "/")
                assert shipped in listed, shipped

    def test_the_provisioned_tree_ships_every_file_the_manifest_names(self):
        if not _provisioned(VOIKKO_TAG):
            pytest.skip("Finnish dictionary not provisioned")
        for file, _component, _role, sha, *_ in self.rows():
            path = os.path.join(DICT_DIR, VOIKKO_TAG, file.replace("/", os.sep))
            assert os.path.isfile(path), path
            if sha == "-":
                continue
            with open(path, "rb") as f:
                assert hashlib.sha256(f.read()).hexdigest() == sha, file

    def test_the_runtime_rows_name_binaries_the_ocr_manifest_already_covers(self):
        # The three mingw DLLs libvoikko links already ship beside the OCR
        # runtime with rows there; they are copied rather than re-fetched, and
        # inventoried once. A copy with no row on either side is the failure.
        ocr = os.path.join(
            os.path.dirname(self.MANIFEST), "tesseract-licenses.tsv"
        )
        with open(ocr, encoding="utf-8") as f:
            covered = {
                line.split("\t")[0].strip()
                for line in f
                if not line.startswith("#") and "\t" in line
            }
        runtime = [file for file, _c, role, *_ in self.rows() if role == "runtime"]
        assert runtime
        for file in runtime:
            assert file in covered, file
