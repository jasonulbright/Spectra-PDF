"""Public version facts against a real catalog override.

Every public reader used to answer with the PHYSICAL header, so a valid file
with a 1.3 header and a catalog `/Version /2.0` was reported as 1.3 by
Advanced Properties and structural Check, and passed a preflight 1.7 ceiling
(BA-42). Table 29 makes the catalog's declaration the document's version when
it is the later of the two.

The fixtures are assembled byte by byte as classic cross-reference tables. A
`pikepdf` save reconciles the header against what the document needs, which
would destroy the very distinction under test, so nothing here is written by a
PDF writer.
"""
import pikepdf
import pytest

from engine.check import check
from engine.doc_properties import get_advanced_properties
from engine.pdf_version import effective_version, parse_version, version_facts
from engine.preflight import preflight
from engine.preflight_profiles import CHECK_IDS

_UNREADABLE = "The PDF version cannot be determined."


def _fixture(path, header: str, catalog: str | None) -> bytes:
    """A minimal, offset-correct PDF whose two declarations are exactly the
    pair the case is about."""
    version_entry = f" /Version {catalog}" if catalog is not None else ""
    objects = [
        f"<< /Type /Catalog /Pages 2 0 R{version_entry} >>".encode(),
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 700] /Resources <<>> >>",
    ]
    data = bytearray(f"%PDF-{header}\n".encode())
    offsets = []
    for number, obj in enumerate(objects, 1):
        offsets.append(len(data))
        data.extend(f"{number} 0 obj\n".encode() + obj + b"\nendobj\n")
    start = len(data)
    data.extend(b"xref\n0 4\n0000000000 65535 f \n")
    for offset in offsets:
        data.extend(f"{offset:010d} 00000 n \n".encode())
    data.extend(f"trailer\n<< /Root 1 0 R /Size 4 >>\nstartxref\n{start}\n%%EOF\n".encode())
    path.write_bytes(bytes(data))
    return bytes(data)


def _version_profile(minimum: str = "1.0", maximum: str = "1.7") -> dict:
    """Only the version check, so the row under test is the whole verdict."""
    rules = {key: {"enabled": False} for key in CHECK_IDS}
    rules["pdf_version"] = {"enabled": True, "min_version": minimum, "max_version": maximum}
    return {"schema": 1, "id": "version_readers", "name": "Version readers", "checks": rules}


def _version_row(path, **bounds) -> dict:
    report = preflight(str(path), profile=_version_profile(**bounds))
    return next(row for row in report["checks"] if row["id"] == "pdf_version")


# ── the grammar ────────────────────────────────────────────────────────────


@pytest.mark.parametrize("value,expected", [
    ("1.0", (1, 0)), ("1.3", (1, 3)), ("1.7", (1, 7)), ("2.0", (2, 0)),
])
def test_parse_accepts_the_canonical_versions(value, expected):
    assert parse_version(value) == expected


@pytest.mark.parametrize("value", [
    "1.8", "2.1", "3.0", "1", "1.", ".7", "1.70", "01.7", "", "x",
    " 1.7", "1.7 ", "1.7\n", None, 1.7, b"1.7",
])
def test_parse_refuses_everything_else(value):
    # No coercion and no stripping: a value this cannot read is a fact the
    # document does not state.
    with pytest.raises(ValueError, match=_UNREADABLE):
        parse_version(value)


# ── the facts ──────────────────────────────────────────────────────────────


@pytest.mark.parametrize("header,catalog,expected", [
    ("1.3", "/2.0", "2.0"),   # catalog higher — the override that matters
    ("2.0", "/1.3", "2.0"),   # header higher — the catalog does not lower it
    ("1.7", "/1.7", "1.7"),   # equal
    ("1.5", None, "1.5"),     # absent
])
def test_facts_report_the_effective_version_and_both_declarations(
    tmp_path, header, catalog, expected,
):
    path = tmp_path / "declared.pdf"
    original = _fixture(path, header, catalog)
    with pikepdf.open(path) as pdf:
        # The fixture really does carry the pair, and it is structurally sound.
        assert pdf.pdf_version == header
        assert not pdf.check_pdf_syntax()
        facts = version_facts(pdf)
        assert facts == {
            "version": expected,
            "header_version": header,
            "catalog_version": None if catalog is None else catalog[1:],
        }
        assert effective_version(pdf) == parse_version(expected)
    assert path.read_bytes() == original


def test_advanced_properties_reports_the_effective_version(tmp_path):
    path = tmp_path / "advanced.pdf"
    original = _fixture(path, "1.3", "/2.0")
    facts = get_advanced_properties(str(path))
    assert facts["version"] == "2.0"
    # The physical facts stay available, each under its own label.
    assert facts["header_version"] == "1.3"
    assert facts["catalog_version"] == "2.0"
    assert path.read_bytes() == original


def test_structural_check_separates_the_header_from_the_version(tmp_path):
    path = tmp_path / "checked.pdf"
    original = _fixture(path, "1.3", "/2.0")
    report = check(str(path))
    assert report["valid"] is True
    assert report["info"]["pdf_version"] == "2.0"
    assert report["info"]["header_version"] == "1.3"
    assert path.read_bytes() == original


def test_every_reader_agrees_on_one_document(tmp_path):
    path = tmp_path / "agreed.pdf"
    _fixture(path, "1.3", "/2.0")
    assert (
        get_advanced_properties(str(path))["version"]
        == check(str(path))["info"]["pdf_version"]
        == "2.0"
    )


# ── preflight ──────────────────────────────────────────────────────────────


def test_preflight_fails_a_ceiling_the_catalog_exceeds(tmp_path):
    path = tmp_path / "too_new.pdf"
    original = _fixture(path, "1.3", "/2.0")
    row = _version_row(path, maximum="1.7")
    # The header alone would have passed this ceiling.
    assert row["status"] == "fail"
    assert any(finding["detail_key"] == "version_above_max" for finding in row["findings"])
    assert path.read_bytes() == original


def test_preflight_passes_a_ceiling_the_document_respects(tmp_path):
    path = tmp_path / "in_range.pdf"
    _fixture(path, "1.3", "/1.6")
    assert _version_row(path, maximum="1.7")["status"] == "pass"


def test_preflight_fails_a_floor_the_document_is_below(tmp_path):
    path = tmp_path / "too_old.pdf"
    _fixture(path, "1.3", None)
    row = _version_row(path, minimum="1.5")
    assert row["status"] == "fail"
    assert any(finding["detail_key"] == "version_below_min" for finding in row["findings"])


def test_preflight_uses_the_higher_header_when_the_catalog_is_lower(tmp_path):
    path = tmp_path / "header_higher.pdf"
    _fixture(path, "2.0", "/1.3")
    # A lower catalog declaration does not bring a 2.0 document into range.
    assert _version_row(path, maximum="1.7")["status"] == "fail"


# ── unreadable declarations ────────────────────────────────────────────────


@pytest.mark.parametrize("catalog", ["/2.1", "/1.8", "/garbage", "(2.0)", "2.0", "/1.70"])
def test_malformed_catalog_declaration_is_unreadable(tmp_path, catalog):
    path = tmp_path / "malformed.pdf"
    original = _fixture(path, "1.3", catalog)
    with pikepdf.open(path) as pdf:
        with pytest.raises(ValueError, match=_UNREADABLE):
            version_facts(pdf)
    assert path.read_bytes() == original


@pytest.mark.parametrize("value", [
    pikepdf.String("2.0"), 2, 2.0, pikepdf.Name("/2.1"), pikepdf.Name("/garbage"),
])
def test_a_catalog_version_that_is_not_a_canonical_name_refuses(value):
    # Table 29: the value shall be a name object, not a number.
    with pikepdf.new() as pdf:
        pdf.Root.Version = value
        with pytest.raises(ValueError, match=_UNREADABLE):
            version_facts(pdf)


def test_structural_check_reports_a_version_defect_not_a_header_fallback(tmp_path):
    path = tmp_path / "unreadable.pdf"
    original = _fixture(path, "1.3", "/2.1")
    report = check(str(path))
    assert report["valid"] is False
    versions = [issue for issue in report["issues"] if issue["category"] == "version"]
    assert len(versions) == 1
    assert versions[0]["severity"] == "error"
    # The named refusal, with nothing of the exception's own making in it.
    assert versions[0]["message"] == _UNREADABLE
    # No effective claim is made, and the physical fact keeps its own label.
    assert "pdf_version" not in report["info"]
    assert report["info"]["header_version"] == "1.3"
    assert path.read_bytes() == original


def test_preflight_reviews_an_unreadable_declaration(tmp_path):
    path = tmp_path / "review.pdf"
    original = _fixture(path, "1.3", "/2.1")
    row = _version_row(path, maximum="1.7")
    # Neither a pass nor a crash: the fact could not be read, so the check
    # says so instead of clearing a ceiling it never measured.
    assert row["status"] == "needs_review"
    assert any(finding["detail_key"] == "read_failed" for finding in row["findings"])
    assert path.read_bytes() == original


def test_an_unreadable_declaration_does_not_end_the_whole_run(tmp_path):
    path = tmp_path / "other_checks.pdf"
    _fixture(path, "1.3", "/2.1")
    rules = {key: {"enabled": False} for key in CHECK_IDS}
    rules["pdf_version"] = {"enabled": True, "min_version": "1.0", "max_version": "1.7"}
    rules["page_count"] = {"enabled": True, "min_pages": 1, "max_pages": 10}
    report = preflight(str(path), profile={
        "schema": 1, "id": "mixed", "name": "Mixed", "checks": rules,
    })
    rows = {row["id"]: row["status"] for row in report["checks"]}
    assert rows["pdf_version"] == "needs_review"
    # A neighbouring check still reached its own verdict.
    assert rows["page_count"] == "pass"


# ── a locked document ──────────────────────────────────────────────────────


def test_a_locked_document_does_not_present_its_header_as_the_version(tmp_path):
    path = tmp_path / "locked.pdf"
    with pikepdf.new() as pdf:
        pdf.add_blank_page()
        pdf.save(path, encryption=pikepdf.Encryption(owner="owner", user="user"))
    report = check(str(path))
    assert report["info"]["encrypted"] is True
    # Its declarations were never read, so no version is claimed — only the
    # physical header, under its own label.
    assert "pdf_version" not in report["info"]
    assert report["info"]["header_version"]
    with pytest.raises(pikepdf.PasswordError):
        get_advanced_properties(str(path))


def test_an_unencrypted_document_does_claim_a_version(tmp_path):
    # The control for the case above: the distinction is about what could be
    # read, not about the reader being cautious everywhere.
    path = tmp_path / "open.pdf"
    _fixture(path, "1.4", "/1.6")
    report = check(str(path))
    assert report["info"]["encrypted"] is False
    assert report["info"]["pdf_version"] == "1.6"
    assert report["info"]["header_version"] == "1.4"
