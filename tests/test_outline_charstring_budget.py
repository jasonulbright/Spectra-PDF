"""The outline conversion must bound embedded charstring expansion."""

from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))


def _exercise(depth: int) -> str:
    import test_redact_fonts as fixture
    from pikepdf import Array, Dictionary, Name

    from engine.glyph_outlines import GlyphSource, OutlineRefusal
    from engine.pdf_fonts import font_capability

    t1 = fixture._t1
    fixture._T1_SUBRS = [t1("return")]
    fixture._T1_SUBRS.extend(
        t1(*([index - 1, "callsubr"] * 10), "return")
        for index in range(1, depth + 1)
    )
    fixture._T1_GLYPHS = {
        ".notdef": t1(0, 250, "hsbw", "endchar"),
        "Q": t1(0, 700, "hsbw", 0, 0, "rmoveto", 100, 100, "rlineto", depth, "callsubr", "endchar"),
    }
    document, _ = fixture._type1_doc([[(10, "Q")]])
    with document:
        font = document.pages[0].Resources.Font.F1
        font["/Encoding"] = Dictionary(Type=Name.Encoding, Differences=Array([10, Name.Q]))
        capability = font_capability(font)
        assert capability.editable, capability.diagnostic
        source = GlyphSource(font, capability, "", 1)
        if depth == 4:
            assert source.contours(10, b"\x0a")
            return "normal outline accepted"
        try:
            source.contours(10, b"\x0a")
        except OutlineRefusal as exc:
            assert "embedded font program could not be read" in str(exc)
            return "hostile outline refused"
        raise AssertionError("hostile outline completed without a refusal")


def test_outline_subroutine_expansion_has_an_external_deadline() -> None:
    for depth, expected in ((4, "normal outline accepted"), (8, "hostile outline refused")):
        run = subprocess.run(
            [sys.executable, "-B", str(Path(__file__).resolve()), str(depth)],
            cwd=ROOT, capture_output=True, text=True, timeout=10,
        )
        assert run.returncode == 0, run.stdout + run.stderr
        assert run.stdout.strip() == expected


if __name__ == "__main__":
    print(_exercise(int(sys.argv[1])))
