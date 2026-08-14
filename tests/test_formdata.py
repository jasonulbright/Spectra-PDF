"""FDF, XFDF and the HTML encoding — the payload half of `/ImportData` and
`/SubmitForm`.

FDF is PDF SYNTAX without a page tree, and qpdf refuses it for exactly that
reason, so `engine/formdata.py` walks the object grammar itself. These rows pin
what that parser accepts: the shapes a producer actually writes (indirect
references, `/Kids` hierarchies, name values, hexadecimal UTF-16 strings,
comments, an incremental redefinition) and the refusals for what is not form
data at all.
"""

import pytest

from engine.formdata import (
    FormDataError,
    parse_fdf,
    parse_form_data,
    parse_xfdf_fields,
    write_fdf,
    write_html_form_data,
    write_xfdf_fields,
)

VALUES = {
    "Item1": "10",
    "Item2": "1,234.5",
    "Group.Child": "nested (paren) \\ backslash",
    "Agree": True,
    "Colours": ["Red", "Blue"],
    "Unicode": "Zürich — 東京",
}

# What VALUES reads back AS: a boolean is a checkbox on-state name in the file,
# and comes back as that name, which is the vocabulary the fill speaks.
ROUND_TRIP = dict(VALUES, Agree="Yes")


def test_fdf_round_trips_every_value_shape():
    assert parse_fdf(write_fdf(VALUES, "invoice.pdf")) == ROUND_TRIP


def test_xfdf_round_trips_every_value_shape():
    text = write_xfdf_fields(VALUES, "invoice.pdf").decode("utf-8")
    assert parse_xfdf_fields(text) == ROUND_TRIP


def test_an_ascii_value_rides_as_a_literal_string_and_the_rest_as_hex():
    """The ASCII case is byte-identical to what the ecosystem writes; anything
    else goes UTF-16BE, which is the only encoding a text string can carry
    those code points in."""
    raw = write_fdf({"Plain": "abc", "Wide": "é"})
    assert b"/V (abc)" in raw
    assert b"/V <FEFF00E9>" in raw


def test_the_html_encoding_is_form_urlencoded():
    assert write_html_form_data({"a b": "1&2", "n": ["x", "y"]}) == b"a%20b=1%262&n=x&n=y"


WILD = (
    b"%FDF-1.2\n"
    b"% a producer comment\n"
    b"1 0 obj\n<< /FDF << /Fields 2 0 R /F (form.pdf) >> >>\nendobj\n"
    b"2 0 obj\n[ 3 0 R << /T (Agree) /V /Yes >> << /T (Empty) >> ]\nendobj\n"
    b"3 0 obj\n<< /T (Group) /Kids [ << /T (Child) /V <FEFF00480069> >> ] >>\nendobj\n"
    b"trailer\n<< /Root 1 0 R >>\n%%EOF\n"
)


def test_the_wild_shapes_parse():
    """Indirect references, a `/Kids` hierarchy, a name value, a hexadecimal
    UTF-16 string, a comment, and a field carrying no value at all."""
    assert parse_fdf(WILD) == {"Group.Child": "Hi", "Agree": "Yes"}


def test_a_later_definition_of_an_object_wins():
    """Which is what an incremental update to an FDF means."""
    data = WILD.replace(
        b"trailer",
        b"2 0 obj\n[ << /T (Agree) /V /Off >> ]\nendobj\ntrailer",
    )
    assert parse_fdf(data) == {"Agree": "Off"}


def test_an_fdf_with_no_trailer_still_reads():
    """A producer that wrote no trailer still wrote the /FDF dictionary."""
    data = WILD.split(b"trailer")[0] + b"%%EOF\n"
    assert parse_fdf(data) == {"Group.Child": "Hi", "Agree": "Yes"}


def test_a_string_with_octal_and_line_continuations_decodes():
    data = (
        b"%FDF-1.2\n1 0 obj\n<< /FDF << /Fields [ << /T (T) /V (a\\101b\\\nc\\(d\\)) >> ] >> >>\n"
        b"endobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n"
    )
    assert parse_fdf(data) == {"T": "aAbc(d)"}


def test_a_file_that_is_not_form_data_refuses_by_what_it_is():
    with pytest.raises(FormDataError):
        parse_fdf(b"%PDF-1.7\n1 0 obj\n<< /Type /Catalog >>\nendobj\n")
    with pytest.raises(FormDataError):
        parse_xfdf_fields("<xfdf><annots/></xfdf>")


def test_the_reader_chooses_by_content_not_by_extension(tmp_path):
    """An FDF saved under an .xfdf name is still an FDF."""
    misnamed = tmp_path / "data.xfdf"
    misnamed.write_bytes(write_fdf({"A": "1"}))
    assert parse_form_data(str(misnamed)) == {"A": "1"}

    other = tmp_path / "data.fdf"
    other.write_bytes(write_xfdf_fields({"A": "1"}))
    assert parse_form_data(str(other)) == {"A": "1"}


def test_a_pdf_handed_to_the_data_reader_says_what_it_is(tmp_path):
    target = tmp_path / "doc.pdf"
    target.write_bytes(b"%PDF-1.7\n%%EOF\n")
    with pytest.raises(FormDataError, match="open it instead"):
        parse_form_data(str(target))


def test_a_deeply_nested_file_refuses_rather_than_recursing():
    data = b"%FDF-1.2\n1 0 obj\n<< /FDF << /Fields " + b"[" * 200 + b" >> >>\nendobj\n"
    with pytest.raises(FormDataError, match="nests too deeply"):
        parse_fdf(data)


def test_a_reference_to_an_object_that_is_not_there_reads_as_nothing():
    data = (
        b"%FDF-1.2\n1 0 obj\n<< /FDF << /Fields [ 9 0 R << /T (A) /V (1) >> ] >> >>\n"
        b"endobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n"
    )
    assert parse_fdf(data) == {"A": "1"}
