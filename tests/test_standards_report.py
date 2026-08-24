"""A standards conversion reports what reaching conformance cost.

Every assertion here fails against the behaviour that returned a size delta
and nothing else: the old result carried no `altered` key at all, so each
`kinds(...)` read raises KeyError and each refusal case returns a file.
"""

import os

import pikepdf
import pytest

from engine import standards_report
from engine.pdfa import convert_pdfa
from engine.prepress import convert_pdfx

from pdfa_builders import (
    encrypted_pdf,
    launch_action_pdf,
    layered_pdf,
    pdfua_declared_pdf,
    plain_pdf,
    scripted_pdf,
    tagged_form_pdf,
    transparent_pdf,
)


def kinds(result):
    assert "altered" in result, (
        f"the conversion result names no alterations at all: {sorted(result)}"
    )
    return [row["kind"] for row in result["altered"]]


def row_of(result, kind):
    for row in result["altered"]:
        if row["kind"] == kind:
            return row
    raise AssertionError(f"no {kind} row in {kinds(result)}")


class TestSilentLosses:
    """The alterations Ghostscript performs without saying so."""

    def test_a_rasterized_page_is_named_though_nothing_reported_it(
        self, tmp_dir, gs_path
    ):
        """PDF/A-1 cannot carry transparency, so the whole page becomes a
        picture and the producer emits no diagnostic whatever."""
        src = transparent_pdf(os.path.join(tmp_dir, "alpha.pdf"))
        out = os.path.join(tmp_dir, "alpha-a1.pdf")
        result = convert_pdfa(src, out, level="1b", gs_path=gs_path)

        row = row_of(result, "page_content_rasterized")
        assert row["count"] == 1
        assert row["detail"][0]["page"] == 1
        assert "text" in row["detail"][0]["was"]
        # The loss is real: no glyph survives as text.
        with pikepdf.open(out) as pdf:
            assert "/Font" not in pdf.pages[0].get("/Resources", {})

    def test_the_same_page_keeps_its_text_where_the_level_allows_it(
        self, tmp_dir, gs_path
    ):
        src = transparent_pdf(os.path.join(tmp_dir, "alpha.pdf"))
        out = os.path.join(tmp_dir, "alpha-a2.pdf")
        result = convert_pdfa(src, out, level="2b", gs_path=gs_path)
        assert "page_content_rasterized" not in kinds(result)

    def test_a_dropped_form_is_named(self, tmp_dir, gs_path):
        src = tagged_form_pdf(os.path.join(tmp_dir, "form.pdf"))
        out = os.path.join(tmp_dir, "form-a2.pdf")
        result = convert_pdfa(src, out, level="2b", gs_path=gs_path)

        assert row_of(result, "form_fields_removed")["count"] == 1
        removed = row_of(result, "annotations_removed")
        assert {d["subtype"] for d in removed["detail"]} == {"Widget"}
        with pikepdf.open(out) as pdf:
            assert "/AcroForm" not in pdf.Root

    def test_dropped_tagging_is_named(self, tmp_dir, gs_path):
        src = tagged_form_pdf(os.path.join(tmp_dir, "tagged.pdf"))
        out = os.path.join(tmp_dir, "tagged-a2.pdf")
        result = convert_pdfa(src, out, level="2b", gs_path=gs_path)

        parts = {d["part"] for d in row_of(result, "tagged_structure_removed")["detail"]}
        assert parts == {"structure tree", "mark information", "document language"}

    def test_dropped_document_scripts_are_named(self, tmp_dir, gs_path):
        src = scripted_pdf(os.path.join(tmp_dir, "js.pdf"))
        out = os.path.join(tmp_dir, "js-a2.pdf")
        result = convert_pdfa(src, out, level="2b", gs_path=gs_path)
        assert "document_scripts_removed" in kinds(result)

    def test_dropped_optional_content_is_named(self, tmp_dir, gs_path):
        src = layered_pdf(os.path.join(tmp_dir, "ocg.pdf"))
        out = os.path.join(tmp_dir, "ocg-a1.pdf")
        result = convert_pdfa(src, out, level="1b", gs_path=gs_path)
        assert "optional_content_removed" in kinds(result)

    def test_removed_encryption_is_named(self, tmp_dir, gs_path):
        src = encrypted_pdf(os.path.join(tmp_dir, "locked.pdf"))
        out = os.path.join(tmp_dir, "locked-a2.pdf")
        result = convert_pdfa(src, out, level="2b", gs_path=gs_path)
        assert "encryption_removed" in kinds(result)

    def test_a_substituted_font_is_named_with_both_faces(self, tmp_dir, gs_path):
        src = plain_pdf(os.path.join(tmp_dir, "plain.pdf"))
        out = os.path.join(tmp_dir, "plain-a2.pdf")
        result = convert_pdfa(src, out, level="2b", gs_path=gs_path)

        detail = row_of(result, "fonts_substituted")["detail"][0]
        assert detail["requested"] == "Helvetica"
        assert detail["used"] and detail["used"] != detail["requested"]


class TestProducerNotices:
    """What Ghostscript itself says survives to the caller."""

    def test_a_removed_annotation_is_reported_by_the_producer_too(
        self, tmp_dir, gs_path
    ):
        src = launch_action_pdf(os.path.join(tmp_dir, "launch.pdf"))
        out = os.path.join(tmp_dir, "launch-a2.pdf")
        result = convert_pdfa(src, out, level="2b", gs_path=gs_path)

        assert row_of(result, "annotations_removed")["count"] == 1
        named = row_of(result, "producer_removed_feature")
        assert "not permitted in PDF/A" in named["detail"][0]["message"]

    def test_progress_output_is_not_a_notice(self, tmp_dir, gs_path):
        src = plain_pdf(os.path.join(tmp_dir, "plain.pdf"))
        out = os.path.join(tmp_dir, "plain-a2.pdf")
        result = convert_pdfa(src, out, level="2b", gs_path=gs_path)
        assert result["producer_notices"] == []


class TestLosslessConversion:
    def test_an_unchanged_document_reports_nothing_altered(
        self, sample_pdf, tmp_dir, gs_path
    ):
        out = os.path.join(tmp_dir, "sample-a2.pdf")
        result = convert_pdfa(sample_pdf, out, level="2b", gs_path=gs_path)
        assert result["altered"] == []
        assert result["producer_notices"] == []
        assert result["declared_conformance"] == "PDF/A-2B"


class TestDeclaredConformance:
    @pytest.mark.parametrize("level,declared", [
        ("1b", "PDF/A-1B"), ("2b", "PDF/A-2B"), ("3b", "PDF/A-3B"),
    ])
    def test_the_output_declares_the_level_that_was_asked_for(
        self, sample_pdf, tmp_dir, gs_path, level, declared
    ):
        out = os.path.join(tmp_dir, f"s-{level}.pdf")
        result = convert_pdfa(sample_pdf, out, level=level, gs_path=gs_path)
        assert result["declared_conformance"] == declared

    def test_a_missing_declaration_refuses_and_leaves_no_file(
        self, monkeypatch, sample_pdf, tmp_dir, gs_path
    ):
        """A file whose only claim is the caller's own word is the failure this
        op exists to prevent, so it is never left on disk."""
        monkeypatch.setattr(standards_report, "declared_pdfa", lambda _p: "")
        out = os.path.join(tmp_dir, "unclaimed.pdf")
        # A refusal of its own rather than a fallback value inside the
        # wrong-declaration one: the message boundary interpolates a captured
        # value verbatim, so a fallback phrase would reach every other
        # language as English.
        with pytest.raises(
            RuntimeError, match="no PDF/A conformance at all, so PDF/A-2b"
        ):
            convert_pdfa(sample_pdf, out, level="2b", gs_path=gs_path)
        assert not os.path.exists(out)

    def test_the_wrong_declaration_refuses_and_names_both(
        self, monkeypatch, sample_pdf, tmp_dir, gs_path
    ):
        monkeypatch.setattr(standards_report, "declared_pdfa", lambda _p: "PDF/A-1B")
        out = os.path.join(tmp_dir, "wrong.pdf")
        with pytest.raises(RuntimeError, match="PDF/A-1B"):
            convert_pdfa(sample_pdf, out, level="2b", gs_path=gs_path)

    def test_a_refused_in_place_conversion_keeps_the_original(
        self, monkeypatch, tmp_pdf, gs_path
    ):
        monkeypatch.setattr(standards_report, "declared_pdfa", lambda _p: "")
        before = open(tmp_pdf, "rb").read()
        with pytest.raises(RuntimeError, match="declares no PDF/A conformance"):
            convert_pdfa(tmp_pdf, tmp_pdf, level="2b", gs_path=gs_path)
        assert open(tmp_pdf, "rb").read() == before


class TestInPlace:
    def test_an_in_place_conversion_compares_against_the_original(
        self, tmp_dir, gs_path
    ):
        """The census must run before the staged file replaces the source: a
        comparison made afterwards would read the result against itself."""
        work = tagged_form_pdf(os.path.join(tmp_dir, "work.pdf"))
        result = convert_pdfa(work, work, level="2b", gs_path=gs_path)
        assert row_of(result, "form_fields_removed")["count"] == 1
        assert "tagged_structure_removed" in kinds(result)


class TestStandardIdentifiers:
    """A conformance claim the input carried and the output does not.

    DISCLOSURE, not preservation: the converter is not asked to keep the other
    standard's declaration, only to stop dropping it in silence.
    """

    def test_a_dropped_pdfua_declaration_is_named(self, tmp_dir, gs_path):
        src = pdfua_declared_pdf(os.path.join(tmp_dir, "ua.pdf"))
        assert standards_report.census(src).values["standard_identifiers"] == ["PDF/UA"]
        out = os.path.join(tmp_dir, "ua-a2.pdf")
        result = convert_pdfa(src, out, level="2b", gs_path=gs_path)
        assert "standard_identifiers_removed" in kinds(result)
        row = row_of(result, "standard_identifiers_removed")
        assert row["detail"] == [{"name": "PDF/UA"}]
        with pikepdf.open(out) as pdf:
            assert b"pdfuaid" not in bytes(pdf.Root.Metadata.read_bytes())

    def test_a_document_declaring_nothing_else_gets_no_row(self, tmp_dir, gs_path):
        src = plain_pdf(os.path.join(tmp_dir, "plain.pdf"))
        out = os.path.join(tmp_dir, "plain-a2.pdf")
        result = convert_pdfa(src, out, level="2b", gs_path=gs_path)
        assert "standard_identifiers_removed" not in kinds(result)

    def test_the_legacy_pdfx_namespace_declares_only_through_its_own_key(
        self, tmp_dir
    ):
        """Adobe's `pdfx` namespace carries arbitrary custom properties, so
        only `GTS_PDFXVersion` inside it is a conformance declaration."""
        src = plain_pdf(os.path.join(tmp_dir, "legacy.pdf"))
        head = (
            b'<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>'
            b'<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF '
            b'xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
            b'<rdf:Description rdf:about="" '
            b'xmlns:pdfx="http://ns.adobe.com/pdfx/1.3/">'
        )
        tail = b"</rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end=\"w\"?>"
        for body, expected in (
            (b"<pdfx:Company>Acme</pdfx:Company>", []),
            (b"<pdfx:GTS_PDFXVersion>PDF/X-4</pdfx:GTS_PDFXVersion>", ["PDF/X"]),
        ):
            with pikepdf.open(src, allow_overwriting_input=True) as pdf:
                pdf.Root.Metadata = pdf.make_stream(head + body + tail)
                pdf.Root.Metadata[pikepdf.Name.Type] = pikepdf.Name.Metadata
                pdf.Root.Metadata[pikepdf.Name.Subtype] = pikepdf.Name.XML
                pdf.save(src)
            got = standards_report.census(src).values["standard_identifiers"]
            assert got == expected, f"{body!r} read as {got}"

    def test_a_declared_namespace_nothing_uses_states_nothing(self, tmp_dir):
        src = plain_pdf(os.path.join(tmp_dir, "bare-ns.pdf"))
        with pikepdf.open(src, allow_overwriting_input=True) as pdf:
            xmp = (
                b'<?xpacket begin="" id="W5M0MpCehiHzreSzNTczkc9d"?>'
                b'<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF '
                b'xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">'
                b'<rdf:Description rdf:about="" '
                b'xmlns:pdfuaid="http://www.aiim.org/pdfua/ns/id/"/>'
                b'</rdf:RDF></x:xmpmeta><?xpacket end="w"?>'
            )
            pdf.Root.Metadata = pdf.make_stream(xmp)
            pdf.Root.Metadata[pikepdf.Name.Type] = pikepdf.Name.Metadata
            pdf.Root.Metadata[pikepdf.Name.Subtype] = pikepdf.Name.XML
            pdf.save(src)
        assert standards_report.census(src).values["standard_identifiers"] == []


class TestUndeterminedIsNotClean:
    def test_a_census_that_could_not_run_leaves_a_row(self):
        before = standards_report.census("no-such-file.local.pdf")
        after = standards_report.census("no-such-file.local.pdf")
        rows = standards_report.compare(before, after)
        assert len(rows) == len(standards_report.FACT_NAMES)
        assert all(row["undetermined"] for row in rows)
        assert all(row["reason"] for row in rows)

    def test_one_unreadable_fact_costs_only_its_own_row(self, tmp_dir):
        src = plain_pdf(os.path.join(tmp_dir, "plain.pdf"))
        before = standards_report.census(src)
        after = standards_report.census(src)
        after.values.pop("images")
        after.reasons["images"] = "probe raised"
        rows = standards_report.compare(before, after)
        assert [row["kind"] for row in rows] == ["images"]
        assert rows[0]["undetermined"] is True


class TestNoticeParsing:
    def test_a_continuation_line_joins_the_notice_above_it(self):
        text = (
            "GPL Ghostscript 10.07.1: Annotation set to non-printing,\n"
            " not permitted in PDF/A, annotation will not be present in output file\n"
        )
        lines = standards_report.notices(text)
        assert len(lines) == 1
        assert "not permitted in PDF/A" in lines[0]

    def test_progress_lines_are_dropped(self):
        text = (
            "GPL Ghostscript 10.07.1 (2026-05-19)\n"
            "Copyright (C) 2026 Artifex Software, Inc.  All rights reserved.\n"
            "This software is supplied under the GNU AGPLv3 and comes with NO WARRANTY:\n"
            "see the file COPYING for details.\n"
            "Processing pages 1 through 3.\n"
            "Page 1\n"
        )
        assert standards_report.notices(text) == []

    def test_unrecognised_producer_text_is_carried_verbatim(self):
        rows, unmatched = standards_report.classify(["A brand new warning nobody wrote a rule for"])
        assert rows == []
        assert unmatched == ["A brand new warning nobody wrote a rule for"]

    def test_the_retreat_marker_outranks_the_removal_marker(self):
        """One notice carries both; a conversion that abandoned the standard is
        not merely one dropped feature."""
        line = ("GPL Ghostscript 10.07.1: Annotation set to non-printing, "
                "not permitted in PDF/A, reverting to normal PDF output")
        rows, unmatched = standards_report.classify([line])
        assert [r["kind"] for r in rows] == ["conformance_abandoned"]
        assert unmatched == []


class TestPdfxCarriesTheSameReport:
    def test_a_dropped_form_is_named(self, tmp_dir, gs_path):
        src = tagged_form_pdf(os.path.join(tmp_dir, "form.pdf"))
        out = os.path.join(tmp_dir, "form-x3.pdf")
        result = convert_pdfx(src, out, version=3, gs_path=gs_path)
        assert row_of(result, "form_fields_removed")["count"] == 1
        assert "tagged_structure_removed" in kinds(result)

    def test_the_standard_is_no_longer_abandoned_for_an_annotation(
        self, tmp_dir, gs_path
    ):
        """The version key is written by the preamble, so a producer retreat
        used to leave a file claiming PDF/X that the producer had disowned."""
        src = launch_action_pdf(os.path.join(tmp_dir, "launch.pdf"))
        out = os.path.join(tmp_dir, "launch-x3.pdf")
        result = convert_pdfx(src, out, version=3, gs_path=gs_path)

        assert "conformance_abandoned" not in kinds(result)
        assert result["pdfx_version"] == "PDF/X-3:2002"
        assert row_of(result, "annotations_removed")["count"] == 1
        with pikepdf.open(out) as pdf:
            assert not any(p.get("/Annots") for p in pdf.pages)

    def test_an_announced_retreat_refuses_and_leaves_no_file(
        self, monkeypatch, tmp_dir, gs_path
    ):
        src = plain_pdf(os.path.join(tmp_dir, "plain.pdf"))
        out = os.path.join(tmp_dir, "retreat.pdf")
        real = standards_report.build

        def retreating(source, produced, *streams):
            report = real(source, produced, *streams)
            report["altered"].append({
                "kind": "conformance_abandoned", "count": 1,
                "detail": [{"message": "reverting to normal PDF output"}],
            })
            return report

        monkeypatch.setattr(standards_report, "build", retreating)
        with pytest.raises(RuntimeError, match="abandoned the standard"):
            convert_pdfx(src, out, version=3, gs_path=gs_path)
        assert not os.path.exists(out)
