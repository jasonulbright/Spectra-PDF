"""The editor's display-only font name seed."""

import pikepdf
import pytest

from engine.text_paragraphs import _display_font_name


@pytest.mark.parametrize(
    "base,expected",
    [
        ("/ABCDEF+Calibri-Bold", "Calibri"),
        ("/TimesNewRomanPS-BoldMT", "Times New Roman"),
        ("/ArialMT", "Arial"),
        ("/Helvetica", "Helvetica"),
        ("/CourierNewPSMT", "Courier New"),
        ("/Bad(Name", None),
    ],
)
def test_name_is_cleaned_for_display(base, expected):
    font = pikepdf.Dictionary(BaseFont=pikepdf.Name(base))
    assert _display_font_name(font) == expected


def test_no_font_gives_no_name():
    assert _display_font_name(None) is None
