"""`detect_form_fields` — the candidate door for a flat form.

Every pin here is a rule that failed first when it was written naively: rule
spacing cannot separate a fill-in stack from a table, a per-option nearest-label
search reuses the previous option's label, the first option of a row takes the
group's question as its own label, and one show operator can carry two labels.
Restoring any of those naive versions must fail a test in this file.
"""

import pikepdf
import pytest
from pikepdf import Array, Dictionary, Name, String

from engine.form_detect import detect_form_fields
from engine.form_detect_vocab import is_date_label, is_signature_label


K = 0.5523  # the circle-from-Béziers control-point ratio


def _simple_font(doc):
    return doc.make_indirect(
        Dictionary(
            Type=Name.Font,
            Subtype=Name.Type1,
            BaseFont=Name("/Helvetica"),
            Encoding=Name.WinAnsiEncoding,
        )
    )


def _page_pdf(path, lines, size=(612, 792), xobjects=None):
    doc = pikepdf.new()
    resources = Dictionary(Font=Dictionary(F1=_simple_font(doc)))
    if xobjects:
        resources[Name.XObject] = Dictionary(**xobjects(doc))
    stream = doc.make_stream("\n".join(lines).encode("latin-1"))
    page = Dictionary(
        Type=Name.Page,
        MediaBox=Array([0, 0, size[0], size[1]]),
        Resources=resources,
        Contents=stream,
    )
    doc.pages.append(pikepdf.Page(doc.make_indirect(page)))
    doc.save(str(path))
    return str(path)


def _circle(cx, cy, r):
    return (
        f"{cx + r} {cy} m "
        f"{cx + r} {cy + r * K} {cx + r * K} {cy + r} {cx} {cy + r} c "
        f"{cx - r * K} {cy + r} {cx - r} {cy + r * K} {cx - r} {cy} c "
        f"{cx - r} {cy - r * K} {cx - r * K} {cy - r} {cx} {cy - r} c "
        f"{cx + r * K} {cy - r} {cx + r} {cy - r * K} {cx + r} {cy} c h S"
    )


# ── fixtures ──────────────────────────────────────────────────────────────


RULED_LABELS = ("First name:", "Last name:", "Email address:", "Telephone:")


def _ruled_lines():
    lines = []
    y = 700
    for label in RULED_LABELS:
        lines.append(f"BT /F1 11 Tf 72 {y + 3} Td ({label}) Tj ET")
        lines.append(f"0.7 w 170 {y} m 520 {y} l S")
        y -= 40
    # The other underline idiom: a filled rectangle thinner than a hairline.
    lines.append("BT /F1 11 Tf 72 543 Td (Employer:) Tj ET")
    lines.append("170 540 350 0.6 re f")
    # A page border and a table, neither of which is a field.
    lines.append("0.5 w 36 36 540 720 re S")
    lines.append("BT /F1 9 Tf 72 460 Td (Item) Tj ET")
    lines.append("BT /F1 9 Tf 300 460 Td (Amount) Tj ET")
    for ty in (450, 430, 410):
        lines.append(f"0.4 w 72 {ty} m 540 {ty} l S")
    return lines


def _boxed_lines():
    lines = []
    for label, y, width in (
        ("Full name", 670, 468),
        ("Street address", 610, 468),
    ):
        lines.append(f"BT /F1 11 Tf 72 {y + 33} Td ({label}) Tj ET")
        lines.append(f"0.8 w 72 {y} {width} 26 re S")
    lines.append("BT /F1 11 Tf 72 583 Td (City) Tj ET")
    lines.append("0.8 w 72 550 220 26 re S")
    lines.append("BT /F1 11 Tf 320 583 Td (State) Tj ET")
    lines.append("0.8 w 320 550 220 26 re S")
    lines.append("BT /F1 11 Tf 72 523 Td (Comments) Tj ET")
    lines.append("0.8 w 72 420 468 90 re S")
    for i, option in enumerate(("Yes", "No", "Not sure")):
        bx = 72 + i * 120
        lines.append(f"0.8 w {bx} 380 10 10 re S")
        lines.append(f"BT /F1 10 Tf {bx + 16} 382 Td ({option}) Tj ET")
    lines.append("BT /F1 11 Tf 72 350 Td (Preferred contact method) Tj ET")
    for i, option in enumerate(("Email", "Phone", "Mail", "None")):
        bx = 72 + i * 110
        lines.append(f"0.8 w {bx} 320 9 9 re S")
        lines.append(f"BT /F1 10 Tf {bx + 14} 321 Td ({option}) Tj ET")
    lines.append("0.2 0.4 0.8 rg 470 730 60 40 re f")
    return lines


@pytest.fixture
def ruled(tmp_path):
    return _page_pdf(tmp_path / "ruled.pdf", _ruled_lines())


@pytest.fixture
def boxed(tmp_path):
    return _page_pdf(tmp_path / "boxed.pdf", _boxed_lines())


# ── the ruled form ────────────────────────────────────────────────────────


def test_ruled_form_yields_one_text_field_per_labelled_rule(ruled):
    result = detect_form_fields(ruled)
    names = [c["name"] for c in result["candidates"]]
    assert names == ["First_name", "Last_name", "Email_address", "Telephone", "Employer"]
    assert {c["kind"] for c in result["candidates"]} == {"text"}
    assert all(c["evidence"] == "rule" for c in result["candidates"])


def test_table_rules_are_reported_not_offered(ruled):
    result = detect_form_fields(ruled)
    reasons = {row["reason"]: row["count"] for row in result["unoffered"]}
    assert reasons["rule_without_label"] == 3


def test_page_border_produces_no_candidate(ruled):
    result = detect_form_fields(ruled)
    for candidate in result["candidates"]:
        x0, y0, x1, y1 = candidate["rect"]
        assert (x1 - x0) * (y1 - y0) < 612 * 792 * 0.5


def test_a_rule_field_stands_one_line_above_its_rule(ruled):
    first = detect_form_fields(ruled)["candidates"][0]
    x0, y0, x1, y1 = first["rect"]
    assert (x0, x1) == (170.0, 520.0)
    assert y0 == pytest.approx(700.35, abs=0.01)
    assert (y1 - y0) == pytest.approx(11 * 1.3, abs=0.05)


def test_the_filled_rectangle_underline_is_a_rule(ruled):
    employer = detect_form_fields(ruled)["candidates"][-1]
    assert employer["label"] == "Employer:"
    # A fill paints its own bbox, so the field spans the drawn rectangle with
    # no stroke half-width to remove.
    assert employer["rect"][0] == pytest.approx(170.0, abs=0.01)
    assert employer["rect"][2] == pytest.approx(520.0, abs=0.01)


# ── the boxed form ────────────────────────────────────────────────────────


def test_boxed_fields_bind_the_label_above_them(boxed):
    result = detect_form_fields(boxed)
    text = [c for c in result["candidates"] if c["kind"] == "text"]
    assert [c["label"] for c in text] == [
        "Full name",
        "Street address",
        "City",
        "State",
        "Comments",
    ]
    assert all(c["label_source"] == "above" for c in text)


def test_a_tall_box_is_multiline(boxed):
    text = [c for c in detect_form_fields(boxed)["candidates"] if c["kind"] == "text"]
    assert [c["multiline"] for c in text] == [False, False, False, False, True]


def test_a_boxed_field_is_the_box_interior(boxed):
    first = detect_form_fields(boxed)["candidates"][0]
    assert first["rect"] == [72.0, 670.0, 540.0, 696.0]


def test_each_option_in_a_row_keeps_its_own_label(boxed):
    """A per-option nearest-label search returns Yes / Yes / No here."""
    checkboxes = [c for c in detect_form_fields(boxed)["candidates"] if c["kind"] == "checkbox"]
    assert [c["label"] for c in checkboxes] == ["Yes", "No", "Not sure"]
    assert [c["name"] for c in checkboxes] == ["Yes", "No", "Not_sure"]


def test_a_group_question_names_the_group_and_labels_no_option(boxed):
    """The first option of the row otherwise takes the question as its label."""
    radios = [c for c in detect_form_fields(boxed)["candidates"] if c["kind"] == "radio"]
    assert len(radios) == 4
    assert {c["name"] for c in radios} == {"Preferred_contact_method"}
    assert {c["group"] for c in radios} == {"Preferred_contact_method"}
    assert [c["export"] for c in radios] == ["Email", "Phone", "Mail", "None"]


def test_each_radio_option_carries_its_own_rectangle(boxed):
    radios = [c for c in detect_form_fields(boxed)["candidates"] if c["kind"] == "radio"]
    assert [c["rect"][0] for c in radios] == [72.0, 182.0, 292.0, 402.0]


def test_a_filled_decoration_is_not_a_field(boxed):
    for candidate in detect_form_fields(boxed)["candidates"]:
        assert candidate["rect"][1] < 700


# ── label granularity ─────────────────────────────────────────────────────


def test_one_show_operator_can_carry_two_labels(tmp_path):
    path = _page_pdf(
        tmp_path / "oneline.pdf",
        [
            "BT /F1 11 Tf 72 700 Td (First name:                    Last name:) Tj ET",
            "0.7 w 150 697 m 300 697 l S",
            "0.7 w 380 697 m 540 697 l S",
        ],
    )
    labels = [c["label"] for c in detect_form_fields(path)["candidates"]]
    assert labels == ["First name:", "Last name:"]


# ── the idioms ────────────────────────────────────────────────────────────


def test_a_circle_option_is_a_radio_and_a_square_is_a_checkbox(tmp_path):
    circles = ["BT /F1 11 Tf 72 700 Td (Choose one) Tj ET"]
    for i, option in enumerate(("Alpha", "Beta", "Gamma")):
        cx = 80 + i * 90
        circles.append("0.8 w " + _circle(cx, 680, 5))
        circles.append(f"BT /F1 10 Tf {cx + 10} 677 Td ({option}) Tj ET")
    path = _page_pdf(tmp_path / "round.pdf", circles)
    result = detect_form_fields(path)
    assert {c["kind"] for c in result["candidates"]} == {"radio"}
    assert {c["evidence"] for c in result["candidates"]} == {"box-round"}
    assert {c["name"] for c in result["candidates"]} == {"Choose_one"}


def test_a_dashed_leader_is_one_ordinary_rule(tmp_path):
    path = _page_pdf(
        tmp_path / "dashed.pdf",
        [
            "BT /F1 11 Tf 72 640 Td (Account number) Tj ET",
            "[2 2] 0 d 0.7 w 180 637 m 520 637 l S",
            "[] 0 d",
        ],
    )
    candidates = detect_form_fields(path)["candidates"]
    assert len(candidates) == 1
    assert candidates[0]["label"] == "Account number"


def test_comb_ticks_are_absorbed_into_their_box(tmp_path):
    lines = [
        "BT /F1 11 Tf 72 600 Td (Postcode) Tj ET",
        "0.8 w 180 590 120 20 re S",
    ]
    for i in range(1, 6):
        x = 180 + i * 20
        lines.append(f"0.5 w {x} 590 m {x} 610 l S")
    path = _page_pdf(tmp_path / "comb.pdf", lines)
    candidates = detect_form_fields(path)["candidates"]
    assert len(candidates) == 1
    assert candidates[0]["comb"] == 6
    assert candidates[0]["max_len"] == 6


def test_a_rule_inside_a_form_xobject_is_an_ordinary_candidate(tmp_path):
    def xobjects(doc):
        form = pikepdf.Stream(doc, b"0.7 w 0 0 m 200 0 l S")
        form[Name.Type] = Name.XObject
        form[Name.Subtype] = Name.Form
        form[Name.BBox] = Array([0, -1, 200, 1])
        form[Name.Resources] = Dictionary()
        return {"Fm0": form}

    path = _page_pdf(
        tmp_path / "nested.pdf",
        [
            "BT /F1 11 Tf 72 550 Td (Nested rule label) Tj ET",
            "q 1 0 0 1 200 553 cm /Fm0 Do Q",
        ],
        xobjects=xobjects,
    )
    candidates = detect_form_fields(path)["candidates"]
    assert len(candidates) == 1
    assert candidates[0]["nested"] is True
    assert candidates[0]["label"] == "Nested rule label"


def test_a_rotated_page_yields_the_same_candidates_rect_for_rect(tmp_path, ruled):
    rotated = tmp_path / "rotated.pdf"
    with pikepdf.open(ruled) as pdf:
        pdf.pages[0].obj[Name.Rotate] = 90
        pdf.save(str(rotated))
    upright = detect_form_fields(ruled)["candidates"]
    turned = detect_form_fields(str(rotated))["candidates"]
    assert [c["rect"] for c in turned] == [c["rect"] for c in upright]
    assert [c["name"] for c in turned] == [c["name"] for c in upright]


# ── existing fields ───────────────────────────────────────────────────────


def _with_widget(source, target, name, rect):
    with pikepdf.open(source) as pdf:
        page = pdf.pages[0].obj
        widget = pdf.make_indirect(
            Dictionary(
                Type=Name.Annot,
                Subtype=Name.Widget,
                FT=Name.Tx,
                Rect=Array(rect),
                T=String(name),
                F=4,
                P=page,
            )
        )
        page[Name.Annots] = Array([widget])
        pdf.Root[Name.AcroForm] = Dictionary(
            Fields=Array([widget]), DA=String("/Helv 0 Tf 0 g")
        )
        pdf.save(str(target))
    return str(target)


def test_a_region_an_existing_widget_covers_is_reported_not_offered(tmp_path, ruled):
    path = _with_widget(ruled, tmp_path / "prepared.pdf", "First_name", [170, 698, 520, 714])
    result = detect_form_fields(path)
    assert [c["name"] for c in result["candidates"]] == [
        "Last_name",
        "Email_address",
        "Telephone",
        "Employer",
    ]
    reasons = {row["reason"]: row["count"] for row in result["unoffered"]}
    assert reasons["covered_by_existing_field"] == 1
    assert result["existing_fields"] == 1


def test_detection_is_stable_when_run_twice(tmp_path, ruled):
    path = _with_widget(ruled, tmp_path / "prepared.pdf", "First_name", [170, 698, 520, 714])
    first = detect_form_fields(path)
    second = detect_form_fields(path)
    assert first == second


def test_a_name_already_in_the_document_takes_a_suffix(tmp_path, ruled):
    # The widget sits away from every rule, so nothing is subtracted and the
    # detected `First_name` collides with the existing field's name.
    path = _with_widget(ruled, tmp_path / "named.pdf", "First_name", [40, 100, 200, 120])
    names = [c["name"] for c in detect_form_fields(path)["candidates"]]
    assert names[0] == "First_name_2"


# ── naming ────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "label,expected",
    [
        ("First name:", "First_name"),
        ("E-mail address:", "E-mail_address"),
        ("Zip/Postal", "ZipPostal"),
        ("Ref. number", "Ref_number"),
    ],
)
def test_a_label_becomes_a_field_name(tmp_path, label, expected):
    path = _page_pdf(
        tmp_path / "named.pdf",
        [
            f"BT /F1 11 Tf 72 703 Td ({label}) Tj ET",
            "0.7 w 250 700 m 520 700 l S",
        ],
    )
    assert detect_form_fields(path)["candidates"][0]["name"] == expected


def test_an_unlabelled_box_takes_a_positional_name(tmp_path):
    path = _page_pdf(tmp_path / "bare.pdf", ["0.8 w 72 670 468 26 re S"])
    candidate = detect_form_fields(path)["candidates"][0]
    assert candidate["name"] == "Text_p1_1"
    assert candidate["label"] is None
    assert candidate["warnings"] == ["unlabeled"]


# ── type refinement from the label ────────────────────────────────────────


def test_a_signature_label_types_the_field_as_a_signature(tmp_path):
    path = _page_pdf(
        tmp_path / "sig.pdf",
        [
            "BT /F1 11 Tf 72 703 Td (Signature:) Tj ET",
            "0.7 w 170 700 m 520 700 l S",
        ],
    )
    assert detect_form_fields(path)["candidates"][0]["kind"] == "signature"


def test_a_date_label_stays_a_text_field_and_names_its_format(tmp_path):
    path = _page_pdf(
        tmp_path / "date.pdf",
        [
            "BT /F1 11 Tf 72 703 Td (Date:) Tj ET",
            "0.7 w 170 700 m 520 700 l S",
        ],
    )
    candidate = detect_form_fields(path)["candidates"][0]
    assert candidate["kind"] == "text"
    assert candidate["format"] == "date"


def test_the_vocabularies_span_every_shipped_language():
    for term in ("Signature", "Firma", "Unterschrift", "Assinatura", "署名", "签名"):
        assert is_signature_label(term)
    for term in ("Date", "Fecha", "Datum", "Data", "日付", "日期"):
        assert is_date_label(term)
    # A token match, so a longer word that merely starts the same does not hit.
    assert not is_date_label("Database")
    assert not is_signature_label("Designation")


# ── refusals and limits ───────────────────────────────────────────────────


def test_a_page_out_of_range_refuses_by_name(ruled):
    with pytest.raises(ValueError, match="out of range"):
        detect_form_fields(ruled, pages=[7])


def test_a_string_page_selection_other_than_all_refuses(ruled):
    with pytest.raises(ValueError, match="pages must be"):
        detect_form_fields(ruled, pages="1-3")


def test_max_candidates_must_be_positive(ruled):
    with pytest.raises(ValueError, match="max_candidates"):
        detect_form_fields(ruled, max_candidates=0)


def test_a_truncated_result_says_so(ruled):
    result = detect_form_fields(ruled, max_candidates=2)
    assert result["truncated"] is True
    assert len(result["candidates"]) == 2


def test_a_blank_page_reports_its_own_emptiness(tmp_path):
    path = _page_pdf(tmp_path / "blank.pdf", [])
    result = detect_form_fields(path)
    assert result["candidates"] == []
    assert result["pages_by_source"] == {"1": "empty"}
