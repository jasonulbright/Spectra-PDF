"""Shared Helvetica metrics (AFM-derived, pdfminer-cross-checked in tests).

Extracted from watermark.py when forms fill needed the same
tables for appearance-stream layout — one implementation so a future fix
propagates to every consumer (same rationale as pdf_tree.py). The values are
pinned against pdfminer's own font descriptor by the watermark test suite.
"""

# Advance widths for ASCII 32..126 in 1/1000 em (Helvetica AFM). A flat
# average UNDERESTIMATES uppercase text by ~40% — live-caught by the
# watermark e2e; sizing/centering/wrapping all need the real widths.
HELVETICA_ASCII_WIDTHS = (
    278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278,
    556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
    1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778,
    667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
    333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556,
    556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
)

# Fallback advance for non-ASCII Latin-1 (accented forms are near their base
# glyph's width; 0.6 em over-reserves slightly, the safe direction).
NON_ASCII_ADVANCE_EM = 0.6

# Helvetica vertical extent in em: AFM Ascent 718 + |Descent| 207.
HELVETICA_ASCENT_EM = 0.718
HELVETICA_DESCENT_EM = 0.207
GLYPH_HEIGHT_EM = HELVETICA_ASCENT_EM + HELVETICA_DESCENT_EM  # 0.925


# Layout-only characters that are NEVER glyphs -- an embedded subset font's
# coverage check rejects them, so any drawn-text path that embeds a font must
# flatten them to spaces first so a stray control character in otherwise
# renderable text cannot crash or reject the whole value. Covers
# C0 controls (0x00-0x1F), DEL (0x7F), and the Unicode LINE/PARAGRAPH
# separators (0x2028/0x2029).
#
# Use str.translate with explicit integer codepoints. Literal U+2028/U+2029
# characters are invisible in editors and vulnerable to whitespace
# normalization, while regex character ranges trigger CodeQL's
# py/overly-large-range on the
# keeps-newline class (a false positive -- C0 minus 0x0A IS 0x00-0x09 plus
# 0x0B-0x1F -- but removing the construct beats maintaining the exception).
# Integer codepoints avoid both failure modes. Do not replace them with regex
# ranges or literal control characters; prove-metrics-equiv.local.py verifies
# equivalence over U+0000..U+2FFF.
#
# CR (0x0D) is in the tables deliberately -- flatten_control_chars normalises
# CRLF and CR to LF BEFORE translating, so no CR ever reaches the table and
# keep_newline genuinely preserves newlines.
_FLATTEN_CODEPOINTS = [*range(0x00, 0x20), 0x7F, 0x2028, 0x2029]
_FLATTEN_ALL_TABLE = str.maketrans({c: " " for c in _FLATTEN_CODEPOINTS})
_FLATTEN_KEEP_NL_TABLE = str.maketrans(
    {c: " " for c in _FLATTEN_CODEPOINTS if c != 0x0A}
)


def flatten_control_chars(text: str, keep_newline: bool = False) -> str:
    """Replace layout-only control/separator chars with spaces so an embedded
    font's glyph subset never has to express them. `keep_newline` preserves
    `\\n` (after normalising `\\r\\n`/`\\r` → `\\n`) for multi-line wrapping;
    otherwise everything — newlines included — flattens (a single-line stamp)."""
    t = text.replace("\r\n", "\n").replace("\r", "\n")
    return t.translate(_FLATTEN_KEEP_NL_TABLE if keep_newline else _FLATTEN_ALL_TABLE)


def text_width_em(text: str) -> float:
    """Helvetica advance width of `text` in em units."""
    total = 0.0
    for ch in text:
        code = ord(ch)
        if 32 <= code <= 126:
            total += HELVETICA_ASCII_WIDTHS[code - 32] / 1000.0
        else:
            total += NON_ASCII_ADVANCE_EM
    return total
