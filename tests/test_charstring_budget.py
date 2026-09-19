"""Width derivation bounds repeated subroutine execution across a font."""

from pathlib import Path
import subprocess
import sys

import pikepdf
import pytest
from pikepdf import Array, Dictionary, Name

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from engine import pdf_fonts  # noqa: E402


def _type1(depth):
    import test_redact_fonts as fixture

    t1 = fixture._t1
    fixture._T1_SUBRS = [t1("return")]
    fixture._T1_SUBRS.extend(
        t1(*([index - 1, "callsubr"] * 10), "return")
        for index in range(1, depth + 1)
    )
    fixture._T1_GLYPHS = {
        ".notdef": t1(0, 250, "hsbw", "endchar"),
        "A": t1(0, 500, "hsbw", "endchar"),
        "Q": t1(0, 700, "hsbw", depth, "callsubr", "endchar"),
    }
    doc, _program = fixture._type1_doc([[(10, "Q"), (200, "A")]])
    return doc, doc.pages[0].Resources.Font.F1


def _cff(depth, *, global_subrs=False):
    from fontTools.cffLib import SubrsIndex
    from fontTools.fontBuilder import FontBuilder
    from fontTools.misc.psCharStrings import T2CharString

    builder = FontBuilder(1000, isTTF=False)
    builder.setupGlyphOrder([".notdef", "A"])
    builder.setupCharacterMap({65: "A"})
    chars = {
        ".notdef": T2CharString(program=[500, "endchar"]),
        "A": T2CharString(program=[500, "endchar"]),
    }
    builder.setupCFF("WidthProbe", {}, chars, {})
    cff = builder.font["CFF "].cff
    top = cff[cff.fontNames[0]]
    private = top.Private
    subrs = cff.GlobalSubrs if global_subrs else SubrsIndex()
    if not global_subrs:
        private.Subrs = subrs
    op = "callgsubr" if global_subrs else "callsubr"
    programs = [["return"]] + [
        [index - 1 - 107, op] * 10 + ["return"]
        for index in range(1, depth + 1)
    ]
    for program in programs:
        subrs.append(T2CharString(program=program, private=private, globalSubrs=cff.GlobalSubrs))
    chars["A"].program = [500, 0, 0, "rmoveto", depth - 107, op, "endchar"]
    # The fixture compiler must not execute the hostile outline itself.
    builder.font.recalcBBoxes = False
    raw = builder.font.getTableData("CFF ")
    doc = pikepdf.new()
    stream = doc.make_stream(raw)
    stream.Subtype = Name.Type1C
    font = doc.make_indirect(Dictionary(
        Type=Name.Font, Subtype=Name.Type1, BaseFont=Name.WidthProbe,
        FirstChar=65, LastChar=65, Widths=Array([601]),
        FontDescriptor=Dictionary(FontName=Name.WidthProbe, Flags=4, FontFile3=stream),
    ))
    return doc, font


@pytest.mark.parametrize("kind", ["type1", "cff-local", "cff-global"])
def test_subroutine_expansion_refuses_with_a_deadline(kind):
    # The deadline is external: removing the production limit must fail the
    # test without hanging the runner that is checking that limit.
    result = subprocess.run(
        [sys.executable, str(Path(__file__).resolve()), kind],
        capture_output=True, text=True, timeout=15, cwd=ROOT,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert result.stdout.strip() == "normal font accepted; expansion refused"


def test_work_is_shared_across_glyphs_and_counts_decompiled_subroutines(monkeypatch):
    from fontTools.misc.psCharStrings import T1CharString

    monkeypatch.setattr(pdf_fonts, "MAX_CHARSTRING_WORK", 14)
    subr = T1CharString(program=["return"])
    glyph = T1CharString(program=[0, 600, "hsbw", 0, "callsubr", "endchar"], subrs=[subr])
    work = pdf_fonts._CharStringWork()
    assert work.width(glyph) == 600
    assert work.width(glyph) == 600
    with pytest.raises(pdf_fonts._CharStringBudget):
        work.width(glyph)


def test_redaction_bounds_subsetting_even_when_encoding_skips_width_derivation():
    result = subprocess.run(
        [sys.executable, str(Path(__file__).resolve()), "type1", "redact"],
        capture_output=True, text=True, timeout=15, cwd=ROOT,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    assert result.stdout.strip() == "normal font accepted; expansion refused"


if __name__ == "__main__":
    kind = sys.argv[1]
    for depth in (2, 8):
        doc, font = _type1(depth) if kind == "type1" else _cff(depth, global_subrs=kind == "cff-global")
        with doc:
            if len(sys.argv) > 2 and sys.argv[2] == "redact":
                import tempfile
                from engine.redact import redact

                font.Encoding = Name.WinAnsiEncoding
                with tempfile.TemporaryDirectory() as folder:
                    source, output = Path(folder) / "in.pdf", Path(folder) / "out.pdf"
                    doc.save(source)
                    if depth == 2:
                        redact(str(source), str(output), [{"page": 1, "rect": [195, 40, 300, 70]}])
                        assert output.exists()
                    else:
                        try:
                            redact(str(source), str(output), [{"page": 1, "rect": [195, 40, 300, 70]}])
                        except ValueError as exc:
                            assert "font" in str(exc)
                        else:
                            raise AssertionError("unsafe font accepted")
                        assert not output.exists()
                continue
            capability = pdf_fonts.font_capability(font)
            if depth == 2:
                assert capability.editable, capability.diagnostic
            else:
                assert not capability.editable
                assert "charstring work budget" in capability.diagnostic
                code, width = (b"Q", 500) if kind == "type1" else (b"A", 601)
                assert capability.decoded_width(code) == width
    print("normal font accepted; expansion refused")
