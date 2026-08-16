"""Whether a font's program travels with the document — one answer, one place.

Two properties of the format make the naive read wrong, and both produced a
check that reported a pass it had not earned:

- a program lives on the descriptor under one of three keys, and a composite
  font keeps its descriptor on its DESCENDANT, so a walk that reads
  ``/FontDescriptor`` off the top-level font dict finds nothing on every
  Type0 font and cannot tell "no descriptor here" from "no program anywhere";
- a font dict that will not read is not evidence of embedding.

So the answer is tri-state. ``None`` is neither ``True`` nor ``False``:
reporting an unreadable font as embedded is a passing check the walk did not
earn, and reporting it as not embedded is a false failure on a document that
may be conforming. The caller reports the third state rather than folding it
into either answer.
"""

import pikepdf

FONT_PROGRAM_KEYS = ("/FontFile", "/FontFile2", "/FontFile3")


def font_embedded(font):
    """True, False, or None when the font will not read."""
    # An object that is not a dictionary answers every key with None, so the
    # descriptor read below would report "no program" about something that is
    # not a font at all.
    if not isinstance(font, pikepdf.Dictionary):
        return None
    try:
        subtype = str(font.get("/Subtype"))
    except Exception:
        return None
    if subtype == "/Type0":
        try:
            desc = font.get("/DescendantFonts")
        except Exception:
            return None
        if desc is None:
            return False
        try:
            for df in desc:
                fd = df.get("/FontDescriptor")
                if fd is not None and has_font_program(fd):
                    return True
        except Exception:
            return None
        return False
    if subtype == "/Type3":
        return True  # glyphs are drawn inline — always "embedded"
    try:
        fd = font.get("/FontDescriptor")
    except Exception:
        return None
    if fd is None:
        return False
    try:
        return has_font_program(fd)
    except Exception:
        return None


def has_font_program(fd) -> bool:
    for key in FONT_PROGRAM_KEYS:
        if fd.get(key) is not None:
            return True
    return False
