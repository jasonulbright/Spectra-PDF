"""Colorant names that are not UTF-8, through every path that names an ink.

A name is its byte sequence (ISO 32000-2 §7.3.5): two names whose bytes
differ are two objects, and a colourant name shown as text should be read as
UTF-8 but may hold any other byte. The Separation and DeviceN spaces name
their colourants by such names (§8.6.6.4, §8.6.6.5), and the separation
device writes one plate per name, spelled from its bytes.

The document below paints `/Gr#FCn` and `/Gr#F6n` — Latin-1 spellings that
differ in one byte and are not UTF-8 — a DeviceN component `/Bl#E4u`, and the
UTF-8 spelling of the first, `/Gr#C3#BCn`. Every assertion reads a real
output: the ink list, the written file, the plates the device wrote, the
PostScript a RIP reads.
"""

from __future__ import annotations

import io
import json
import re
from pathlib import Path

import pikepdf
import pytest

np = pytest.importorskip("numpy")
Image = pytest.importorskip("PIL.Image")

LATIN_GREEN = b"Gr\xfcn"
LATIN_GROEN = b"Gr\xf6n"
LATIN_BLUE = b"Bl\xe4u"
UTF8_GREEN = "Grün".encode("utf-8")

FONTS_DIR = Path(__file__).resolve().parent.parent / "resources" / "fonts"
_HAS_FACE = (FONTS_DIR / "LiberationSans-Regular.ttf").is_file()

_INKS = b"""%PDF-1.7
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /TrimBox [20 20 280 180]
 /Resources << /ColorSpace << /CS0 [/Separation /Gr#FCn /DeviceCMYK 6 0 R]
   /CS1 [/Separation /Gr#F6n /DeviceCMYK 7 0 R]
   /CS2 [/DeviceN [/Cyan /Bl#E4u] /DeviceCMYK 8 0 R
         << /Colorants << /Bl#E4u [/Separation /Bl#E4u /DeviceCMYK 9 0 R] >> >>]
   /C#FC [/Separation /Gr#C3#BCn /DeviceCMYK 10 0 R] >> >>
 /Contents 5 0 R >> endobj
5 0 obj << /Length 0 >> stream
/CS0 cs 1 scn 30 30 60 60 re f /CS1 cs 1 scn 100 30 60 60 re f
/CS2 cs 0 1 scn 170 30 60 60 re f /C#FC cs 1 scn 30 110 60 60 re f
endstream endobj
6 0 obj << /FunctionType 2 /Domain [0 1] /C0 [0 0 0 0] /C1 [1 0 1 0] /N 1 >> endobj
7 0 obj << /FunctionType 2 /Domain [0 1] /C0 [0 0 0 0] /C1 [0 1 1 0] /N 1 >> endobj
8 0 obj << /FunctionType 4 /Domain [0 1 0 1] /Range [0 1 0 1 0 1 0 1] /Length 7 >> stream
{ 0 0 }
endstream endobj
9 0 obj << /FunctionType 2 /Domain [0 1] /C0 [0 0 0 0] /C1 [1 1 0 0] /N 1 >> endobj
10 0 obj << /FunctionType 2 /Domain [0 1] /C0 [0 0 0 0] /C1 [0 0 1 0] /N 1 >> endobj
trailer << /Root 1 0 R >>
%%EOF
"""

#: The literal `Gr#FCn` (`/Gr#23FCn` in the file) beside the Latin-1 `Gr#FC n`:
#: two inks whose text is the same.
_ALIKE = b"""%PDF-1.7
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200]
 /Resources << /ColorSpace << /CS0 [/Separation /Gr#FCn /DeviceCMYK 6 0 R]
   /CS1 [/Separation /Gr#23FCn /DeviceCMYK 6 0 R] >> >>
 /Contents 5 0 R >> endobj
5 0 obj << /Length 0 >> stream
/CS0 cs 1 scn 30 30 60 60 re f /CS1 cs 1 scn 100 30 60 60 re f
endstream endobj
6 0 obj << /FunctionType 2 /Domain [0 1] /C0 [0 0 0 0] /C1 [1 0 1 0] /N 1 >> endobj
trailer << /Root 1 0 R >>
%%EOF
"""


def _write(tmp_path, raw: bytes, name: str = "inks.pdf") -> str:
    path = tmp_path / name
    with pikepdf.open(io.BytesIO(raw)) as pdf:
        pdf.save(path)
    return str(path)


def _separation_names(path: str) -> list[bytes]:
    """The colourant name of every Separation space in page 1's resources."""
    out = []
    with pikepdf.open(path) as pdf:
        table = pdf.pages[0].Resources.ColorSpace
        for key in list(table.keys()):
            space = table[key]
            if bytes(space[0]) == b"/Separation":
                out.append(bytes(space[1])[1:])
    return sorted(out)


def _plate_ink(result, key: bytes):
    """One plate's ink coverage in 0…1, found by the ink's key."""
    match = next(p for p in result["plates"] if p["key"] == key.hex())
    with Image.open(match["file"]) as im:
        return (255.0 - np.asarray(im.convert("L")).astype(np.float32)) / 255.0


class TestTheInkList:
    def test_every_ink_is_listed_and_the_list_is_whole(self, tmp_path):
        from engine.separations import list_inks

        result = list_inks(_write(tmp_path, _INKS))
        assert result["unknown"] == []
        by_key = {entry["key"]: entry for entry in result["inks"]}
        assert set(by_key) == {raw.hex() for raw in (
            b"Cyan", LATIN_GREEN, LATIN_GROEN, LATIN_BLUE, UTF8_GREEN)}
        assert by_key[LATIN_GREEN.hex()]["name"] == "Gr#FCn"
        assert by_key[LATIN_GROEN.hex()]["name"] == "Gr#F6n"
        assert by_key[LATIN_BLUE.hex()]["name"] == "Bl#E4u"
        assert by_key[UTF8_GREEN.hex()]["name"] == "Grün"

    def test_names_that_differ_in_one_byte_are_two_inks_with_their_own_colour(self, tmp_path):
        from engine.separations import list_inks

        shown = {e["name"]: e["display_rgb"] for e in list_inks(_write(tmp_path, _INKS))["inks"]}
        assert shown.get("Gr#FCn") == [0, 255, 0]
        assert shown.get("Gr#F6n") == [255, 0, 0]
        assert shown.get("Bl#E4u") == [0, 0, 255]


@pytest.mark.usefixtures("gs_path")
class TestThePlatesTheDeviceWrites:
    def test_each_plate_pairs_with_the_ink_whose_bytes_named_it(self, tmp_path, gs_path):
        from engine.separations import render_separations

        result = render_separations(_write(tmp_path, _INKS), 1, dpi=36, gs_path=gs_path,
                                    reuse=False)
        files = {p["key"]: Path(p["file"]).name for p in result["plates"]}
        assert files[LATIN_GREEN.hex()] == "s1(Gr%FCn).tif"
        assert files[LATIN_GROEN.hex()] == "s1(Gr%F6n).tif"
        assert files[UTF8_GREEN.hex()] == "s1(Gr%C3%BCn).tif"
        assert files[LATIN_BLUE.hex()] == "s1(Bl%E4u).tif"
        # 36 dpi: the Gr#FC n square spans x 15..45 and rows 55..85 of 100.
        green = _plate_ink(result, LATIN_GREEN)
        assert green[70, 30] == pytest.approx(1.0)
        assert green[70, 85] == pytest.approx(0.0)
        groen = _plate_ink(result, LATIN_GROEN)
        assert groen[70, 65] == pytest.approx(1.0)
        assert groen[70, 30] == pytest.approx(0.0)
        # The DeviceN square spans x 85..115: its Bl#E4 u component paints it.
        blue = _plate_ink(result, LATIN_BLUE)
        assert blue[70, 100] == pytest.approx(1.0)
        assert blue[70, 30] == pytest.approx(0.0)

    def test_a_composite_finds_a_plate_by_its_shown_name_and_by_its_key(self, tmp_path, gs_path):
        from engine.separations import composite_separations, render_separations

        plates = render_separations(_write(tmp_path, _INKS), 1, dpi=36, gs_path=gs_path,
                                    reuse=False)
        for tag, request in (("text", ["Gr#FCn"]), ("key", [{"key": LATIN_GREEN.hex()}])):
            result = composite_separations(plates["dir"], request,
                                           output=str(tmp_path / f"{tag}.png"))
            assert result["inks"] == ["Gr#FCn"]
            with Image.open(result["png"]) as im:
                rgb = np.asarray(im.convert("RGB"))
            # Only the Gr#FC n plate is composited: its square carries ink and
            # the Gr#F6 n square beside it is paper.
            assert tuple(rgb[70, 30]) != (255, 255, 255)
            assert tuple(rgb[70, 65]) == (255, 255, 255)

    def test_a_soft_proof_reads_the_spots_own_alternate(self, tmp_path, gs_path):
        from engine.separations import composite_separations, render_separations

        plates = render_separations(_write(tmp_path, _INKS), 1, dpi=36, gs_path=gs_path,
                                    reuse=False)
        wanted = [p for p in plates["plates"]
                  if p["key"] in (b"Cyan".hex(), LATIN_GREEN.hex(), LATIN_GROEN.hex())]
        result = composite_separations(plates["dir"], wanted, output=str(tmp_path / "p.png"),
                                       simulation={"source": "bundled"}, gs_path=gs_path)
        assert result["simulation"]["refusal"] == ""
        assert result["simulation"]["source"] == "bundled"

    def test_the_inspector_names_the_ink_at_a_point(self, tmp_path, gs_path):
        from engine.object_inspector import inspect_point
        from engine.separations import render_separations

        src = _write(tmp_path, _INKS)
        plates = render_separations(src, 1, dpi=36, gs_path=gs_path, reuse=False)
        green = inspect_point(src, 1, 60, 60, plates=plates["plates"],
                              plates_dir=plates["dir"], gs_path=gs_path)
        assert green["objects"][0]["colour"]["colorants"] == ["Gr#FCn"]
        at = {p["key"]: p["pct"] for p in green["ink"]["plates"]}
        assert at[LATIN_GREEN.hex()] == pytest.approx(100.0)
        assert at[LATIN_GROEN.hex()] == pytest.approx(0.0)
        # The UTF-8 green is selected by a resource name that is itself not
        # UTF-8 (`/C#FC`).
        utf8 = inspect_point(src, 1, 60, 140, plates=plates["plates"],
                             plates_dir=plates["dir"], gs_path=gs_path)
        colour = utf8["objects"][0]["colour"]
        assert colour["colorants"] == ["Grün"]
        assert colour["resource"] == "C#FC"


def _mark_spaces(path: str) -> dict:
    """{the mark form's colour-space key: the Separation colourant bytes}."""
    with pikepdf.open(path) as pdf:
        form = pdf.pages[0].Resources.XObject["/SpectraPrinterMarks"]
        table = form.Resources.ColorSpace
        return {
            str(key): bytes(table[key][1])[1:]
            for key in table.keys() if str(key).startswith("/Spot")
        }


def _patch_rect(path: str, key: str) -> tuple[float, float, float, float]:
    """(x, y, width, height) of the patch the mark form paints with `key`."""
    with pikepdf.open(path) as pdf:
        form = pdf.pages[0].Resources.XObject["/SpectraPrinterMarks"]
        content = form.read_bytes().decode("ascii")
    found = re.search(re.escape(key) + r" cs 1 scn (\S+) (\S+) (\S+) (\S+) re", content)
    assert found, key
    return tuple(float(v) for v in found.groups())


class TestPrinterMarkColourBars:
    def test_each_spot_patch_paints_the_documents_own_colorant(self, tmp_path):
        from engine.printer_marks import add_printer_marks

        out = str(tmp_path / "marks.pdf")
        result = add_printer_marks(_write(tmp_path, _INKS), out, marks=["colorbars"])
        assert sorted(_mark_spaces(out).values()) == sorted(
            [LATIN_GREEN, LATIN_GROEN, LATIN_BLUE, UTF8_GREEN])
        assert result["spot_patches"] == ["Bl#E4u", "Grün", "Gr#F6n", "Gr#FCn"]

    @pytest.mark.skipif(not _HAS_FACE, reason="bundled fallback faces not provisioned")
    def test_the_page_information_names_each_spot_by_its_text(self, tmp_path):
        from pdfminer.high_level import extract_text

        from engine.printer_marks import add_printer_marks

        out = str(tmp_path / "info.pdf")
        add_printer_marks(_write(tmp_path, _INKS), out, marks=["colorbars", "pageinfo"],
                          font_dir=str(FONTS_DIR), timestamp="2026-09-19T00:00:00+0000")
        assert "Bl#E4u, Grün, Gr#F6n, Gr#FCn" in extract_text(out)

    def test_each_patch_prints_on_the_plate_its_bytes_name(self, tmp_path, gs_path):
        from engine.printer_marks import add_printer_marks
        from engine.separations import render_separations

        out = str(tmp_path / "marks.pdf")
        add_printer_marks(_write(tmp_path, _INKS), out, marks=["colorbars"])
        spaces = _mark_spaces(out)
        # 144 dpi over the grown media box [-27 -27 327 227].
        plates = render_separations(out, 1, dpi=144, gs_path=gs_path, reuse=False)
        for raw in (LATIN_GREEN, LATIN_GROEN):
            key = next(k for k, v in spaces.items() if v == raw)
            x, y, w, h = _patch_rect(out, key)
            column = int((x + w / 2 + 27) * 2)
            row = int((227 - (y + h / 2)) * 2)
            assert _plate_ink(plates, raw)[row, column] == pytest.approx(1.0), raw
            other = LATIN_GROEN if raw == LATIN_GREEN else LATIN_GREEN
            assert _plate_ink(plates, other)[row, column] == pytest.approx(0.0), raw


class TestInkManager:
    def test_an_alias_writes_the_target_colorants_bytes(self, tmp_path):
        from engine.ink_manager import alias_ink

        out = str(tmp_path / "alias.pdf")
        result = alias_ink(_write(tmp_path, _INKS), out, "Gr#F6n", "Gr#FCn",
                           accept_target_transform=True)
        assert (result["source"], result["target"], result["renamed"]) == ("Gr#F6n", "Gr#FCn", 1)
        assert _separation_names(out) == sorted([LATIN_GREEN, LATIN_GREEN, UTF8_GREEN])

    def test_spot_to_process_converts_the_named_ink_and_no_other(self, tmp_path):
        from engine.ink_manager import spot_to_process

        out = str(tmp_path / "process.pdf")
        result = spot_to_process(_write(tmp_path, _INKS), out, ["Gr#FCn"])
        assert result["inks"] == ["Gr#FCn"]
        assert _separation_names(out) == sorted([LATIN_GROEN, UTF8_GREEN])

    def test_a_key_names_an_ink_exactly(self, tmp_path):
        from engine.ink_manager import compare_tint_transforms

        result = compare_tint_transforms(_write(tmp_path, _INKS), {"key": LATIN_GREEN.hex()},
                                         {"key": LATIN_GROEN.hex()})
        assert (result["match"], result["reason"]) == (False, "transform")


class TestInksShownAlike:
    def test_two_inks_shown_alike_keep_two_keys(self, tmp_path):
        from engine.separations import list_inks

        inks = list_inks(_write(tmp_path, _ALIKE))["inks"]
        assert sorted((e["name"], e.get("key")) for e in inks) == sorted(
            [("Gr#FCn", LATIN_GREEN.hex()), ("Gr#FCn", b"Gr#FCn".hex())])

    def test_a_shown_name_that_names_both_refuses(self, tmp_path):
        from engine.ink_manager import spot_to_process

        with pytest.raises(ValueError, match="More than one ink in this document"):
            spot_to_process(_write(tmp_path, _ALIKE), str(tmp_path / "out.pdf"), ["Gr#FCn"])

    def test_a_key_picks_one_of_them(self, tmp_path):
        from engine.ink_manager import spot_to_process

        out = str(tmp_path / "out.pdf")
        spot_to_process(_write(tmp_path, _ALIKE), out, [{"key": LATIN_GREEN.hex()}])
        assert _separation_names(out) == [b"Gr#FCn"]


class TestTrappingOverrides:
    _PRESET = {"ColorantZoneDetails": {"Gr#FCn": {"StepLimit": 0.5},
                                       "Grün": {"StepLimit": 0.25}}}

    def test_the_stored_override_names_the_colorant_by_its_bytes(self, tmp_path):
        from engine.trapping import assign_presets

        out = str(tmp_path / "trap.pdf")
        assign_presets(_write(tmp_path, _INKS), out,
                       assignments=[{"first": 1, "last": 1, "name": "P", "preset": self._PRESET}])
        with pikepdf.open(out) as pdf:
            zones = pdf.Root["/SpectraTrapPresets"][0].Params.ColorantZoneDetails
            assert sorted(key.encode("utf-8", "surrogateescape")[1:] for key in zones.keys()) \
                == sorted([LATIN_GREEN, UTF8_GREEN])

    def test_the_postscript_names_each_override_with_the_colorants_bytes(self, tmp_path, gs_path):
        from engine.trapping import assign_presets, export_postscript

        out = str(tmp_path / "trap.pdf")
        assign_presets(_write(tmp_path, _INKS), out,
                       assignments=[{"first": 1, "last": 1, "name": "P", "preset": self._PRESET}])
        ps = tmp_path / "trap.ps"
        export_postscript(out, str(ps), gs_path=gs_path)
        data = ps.read_bytes()
        assert b"(Gr\\374n) cvn << /StepLimit 0.5 >>" in data
        assert b"(Gr\\303\\274n) cvn << /StepLimit 0.25 >>" in data

    def test_a_listing_of_a_stored_override_is_json_the_host_reads(self, tmp_path):
        from engine.trapping import list_trap_presets

        src = _write(tmp_path, _INKS)
        with pikepdf.open(src, allow_overwriting_input=True) as pdf:
            zones = pikepdf.Dictionary()
            zones[pikepdf.Object.parse(b"/Gr#FCn")] = pikepdf.Dictionary(StepLimit=0.5)
            pdf.Root["/SpectraTrapPresets"] = pdf.make_indirect(pikepdf.Array([
                pikepdf.Dictionary(First=1, Last=1, Name=pikepdf.String("P"),
                                   Params=pikepdf.Dictionary(ColorantZoneDetails=zones)),
            ]))
            pdf.save(src)
        listing = list_trap_presets(src)
        # The host parses each response line with a strict JSON reader that
        # rejects a lone surrogate escape, and drops the whole line.
        line = json.dumps(listing)
        assert "\\udc" not in line
        zones = listing["assignments"][0]["preset"]["ColorantZoneDetails"]
        assert zones == {"Gr#FCn": {"StepLimit": 0.5}}
        assert listing["unused_colorants"] == []


def _overprint(gstate: bytes, space: bytes) -> bytes:
    """Overprint turned on under the name `gstate`, then a Separation painted
    at tint 0 and 0.5 through the colour space named `space`."""
    return b"""%PDF-1.7
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200]
 /Resources << /ExtGState << /""" + gstate + b""" << /OP true /op true /OPM 1 >> >>
   /ColorSpace << /""" + space + b""" [/Separation /Gr#FCn /DeviceCMYK 6 0 R] >> >>
 /Contents 5 0 R >> endobj
5 0 obj << /Length 0 >> stream
/""" + gstate + b""" gs /""" + space + b""" cs 0 scn 30 30 60 60 re f /""" + space + b""" cs 0.5 scn 100 30 60 60 re f
endstream endobj
6 0 obj << /FunctionType 2 /Domain [0 1] /C0 [0 0 0 0] /C1 [1 0 1 0] /N 1 >> endobj
trailer << /Root 1 0 R >>
%%EOF
"""


class TestOverprintReadsTheSpotItPaints:
    def test_a_spot_paint_is_read_with_its_tint(self, tmp_path):
        from engine.overprint import list_overprint

        paints = list_overprint(_write(tmp_path, _overprint(b"GS0", b"CS0")))["paints"]
        assert [(p["family"], p["components"], p["zero_tint"]) for p in paints] == [
            ("Separation", [0.0], True),
            ("Separation", [0.5], False),
        ]

    def test_resource_names_that_are_not_utf8_select_the_state_and_the_space(self, tmp_path):
        from engine.overprint import list_overprint

        paints = list_overprint(_write(tmp_path, _overprint(b"G#E9", b"C#FC")))["paints"]
        assert [(p["family"], p["zero_tint"]) for p in paints] == [
            ("Separation", True),
            ("Separation", False),
        ]


class TestReportsCompareByBytes:
    def test_a_lost_ink_is_found_by_its_bytes_and_shown_by_its_text(self):
        from engine import standards_report

        row = standards_report.colorants_lost([LATIN_GREEN, b"Gr#FCn"], [b"Gr#FCn"])
        assert [entry["name"] for entry in row["detail"]] == ["Gr#FCn"]
        assert standards_report.colorants_lost([LATIN_GREEN], [LATIN_GREEN]) is None


#: A die line on a Structural processing-step layer paints `/Gr#FCn`, and the
#: artwork paints `/Gr#F6n`. The die line's colorant is not a printing ink.
_DIE_LINE = b"""%PDF-1.7
1 0 obj << /Type /Catalog /Pages 2 0 R
 /OCProperties << /OCGs [7 0 R] /D << /ON [7 0 R] /OFF [] >> >> >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200]
 /Resources << /ColorSpace << /CS0 [/Separation /Gr#FCn /DeviceCMYK 6 0 R]
   /CS1 [/Separation /Gr#F6n /DeviceCMYK 6 0 R] >> /Properties << /MC0 7 0 R >> >>
 /Contents 5 0 R >> endobj
5 0 obj << /Length 0 >> stream
/OC /MC0 BDC /CS0 CS 1 SCN 2 w 20 20 m 280 20 l S EMC /CS1 cs 1 scn 100 30 60 60 re f
endstream endobj
6 0 obj << /FunctionType 2 /Domain [0 1] /C0 [0 0 0 0] /C1 [1 0 1 0] /N 1 >> endobj
7 0 obj << /Type /OCG /Name (Die line)
 /GTS_Metadata << /GTS_ProcStepsGroup /Structural /GTS_ProcStepsType /Cutting >> >> endobj
trailer << /Root 1 0 R >>
%%EOF
"""


class TestProcessingSteps:
    def test_a_die_line_colorant_leaves_the_plate_list_by_its_bytes(self, tmp_path):
        from engine.separations import list_inks

        src = _write(tmp_path, _DIE_LINE)
        default = list_inks(src)
        assert [e["name"] for e in default["inks"] if e["kind"] == "spot"] == ["Gr#F6n"]
        assert default["processing_step_inks"] == ["Gr#FCn"]
        assert default["processing_step_keys"] == [LATIN_GREEN.hex()]
        shown = list_inks(src, show_processing_steps=True)
        assert sorted(e["name"] for e in shown["inks"] if e["kind"] == "spot") == ["Gr#F6n", "Gr#FCn"]

    def test_the_die_line_plate_is_dropped_and_the_set_still_pairs(self, tmp_path, gs_path):
        from engine.separations import render_separations

        result = render_separations(_write(tmp_path, _DIE_LINE), 1, dpi=36, gs_path=gs_path,
                                    reuse=False)
        spots = [p for p in result["plates"] if p["kind"] == "spot"]
        assert [(p["name"], p["key"]) for p in spots] == [("Gr#F6n", LATIN_GROEN.hex())]
        assert not (Path(result["dir"]) / "s1(Gr%FCn).tif").exists()


class TestTheSwatchReadsThroughTheName:
    def test_a_fill_selected_through_a_name_that_is_not_utf8_has_its_colour(self, tmp_path):
        from engine.page_vectors import list_page_vectors

        vectors = list_page_vectors(_write(tmp_path, _INKS), 1)["vectors"]
        # /C#FC selects the UTF-8 Grün spot, whose full tint is DeviceCMYK
        # 0 0 1 0: yellow.
        square = next(v for v in vectors if v["rect"] == [30.0, 110.0, 90.0, 170.0])
        assert square["fill"] == pytest.approx([1.0, 1.0, 0.0])


class TestACompositeOfInksShownAlike:
    def test_a_key_composites_its_own_plate_and_a_shared_text_refuses(self, tmp_path, gs_path):
        from engine.separations import composite_separations, render_separations

        plates = render_separations(_write(tmp_path, _ALIKE), 1, dpi=36, gs_path=gs_path,
                                    reuse=False)
        files = {p["key"]: Path(p["file"]).name for p in plates["plates"]}
        assert files[LATIN_GREEN.hex()] == "s1(Gr%FCn).tif"
        assert files[b"Gr#FCn".hex()] == "s1(Gr#FCn).tif"
        result = composite_separations(plates["dir"], [{"key": LATIN_GREEN.hex()}],
                                       output=str(tmp_path / "one.png"))
        with Image.open(result["png"]) as im:
            rgb = np.asarray(im.convert("RGB"))
        # 36 dpi: /CS0 (Gr#FC n) paints x 15..45, /CS1 (the literal) x 50..80.
        assert tuple(rgb[70, 30]) != (255, 255, 255)
        assert tuple(rgb[70, 65]) == (255, 255, 255)
        with pytest.raises(ValueError, match="More than one ink in this document"):
            composite_separations(plates["dir"], ["Gr#FCn"], output=str(tmp_path / "two.png"))


#: A space named `/CS#E9` read as the base of an indexed space, a space whose
#: family is a name that is not UTF-8, an indexed space over such a base, and
#: a pattern named `/P#E9`.
_SPACES = b"""%PDF-1.7
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200]
 /Resources << /ColorSpace << /CS#E9 /DeviceRGB /CSI [/Indexed /CS#E9 1 <000000FF0000>]
   /CSX [/Ca#FClRGB << /WhitePoint [0.95 1 1.09] >>] /CSB [/Indexed [/IC#FCCBased 6 0 R] 1 <000000FF0000>] >>
   /Pattern << /P#E9 7 0 R >> >>
 /Contents 5 0 R >> endobj
5 0 obj << /Length 0 >> stream
/CSI cs 1 scn 10 10 40 40 re f /CSX cs 0.5 0.5 0.5 scn 60 10 40 40 re f
/CSB cs 1 scn 110 10 40 40 re f /Pattern cs /P#E9 scn 160 10 40 40 re f
endstream endobj
6 0 obj << /N 3 /Length 0 >> stream
endstream endobj
7 0 obj << /PatternType 1 /PaintType 1 /TilingType 1 /BBox [0 0 10 10] /XStep 10 /YStep 10
 /Resources << >> /Length 0 >> stream
0 0 1 rg 0 0 10 10 re f
endstream endobj
trailer << /Root 1 0 R >>
%%EOF
"""


class TestColourSpacesResolveThroughNamesThatAreNotUtf8:
    """A fill's colour resolves through its space by the space's bytes. An
    indexed space whose base is named `/CS#E9` reads its base by those bytes;
    a family name that is not UTF-8 is a family no device knows, so its
    colour is unknown; and a pattern named by such bytes is a pattern, not a
    flat colour. `str()` of each name raised and failed the swatch."""

    def test_each_fill_resolves_or_is_unknown(self, tmp_path):
        from engine.page_vectors import list_page_vectors

        vectors = list_page_vectors(_write(tmp_path, _SPACES), 1)["vectors"]
        fills = {v["rect"][0]: v["fill"] for v in vectors}
        assert fills == {10.0: pytest.approx([1.0, 0.0, 0.0]), 60.0: None, 110.0: None, 160.0: None}


#: A spot whose alternate is a name that is not UTF-8, a spot with no
#: alternate, a DeviceN component with no alternate and one whose tint
#: transform cannot be built.
_UNCONVERTIBLE = b"""%PDF-1.7
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200]
 /Resources << /ColorSpace << /CS0 [/Separation /Gr#FCn /Gar#FC 6 0 R]
   /CS1 [/Separation /Aa#FC null 6 0 R] /CS2 [/Separation /Zz#FC /DeviceCMYK 6 0 R]
   /CS3 [/DeviceN [/Bl#E4u] null 6 0 R] /CS4 [/DeviceN [/Ro#DFt] /DeviceCMYK 7 0 R] >> >>
 /Contents 5 0 R >> endobj
5 0 obj << /Length 0 >> stream
/CS0 cs 1 scn 10 10 40 40 re f /CS1 cs 1 scn 60 10 40 40 re f /CS2 cs 1 scn 110 10 40 40 re f
/CS3 cs 1 scn 160 10 40 40 re f /CS4 cs 1 scn 210 10 40 40 re f
endstream endobj
6 0 obj << /FunctionType 2 /Domain [0 1] /C0 [0 0 0 0] /C1 [1 0 1 0] /N 1 >> endobj
7 0 obj << /FunctionType 99 /Domain [0 1] >> endobj
trailer << /Root 1 0 R >>
%%EOF
"""


class TestInkConversionsNameEachInkByItsText:
    """A conversion that refuses names the ink by its text, whichever check
    refused it, and an alias between two inks shown alike selects each by
    its bytes."""

    @pytest.mark.parametrize(("inks", "shown"), [
        ([{"key": LATIN_GREEN.hex()}], "Gr#FCn"),
        ([{"key": b"Aa\xfc".hex()}, {"key": b"Zz\xfc".hex()}], "Aa#FC"),
        ([{"key": LATIN_BLUE.hex()}], "Bl#E4u"),
        ([{"key": b"Ro\xdft".hex()}], "Ro#DFt"),
    ], ids=["alternate-of-such-a-name", "first-of-two-without-alternate", "devicen-without-alternate",
            "devicen-without-transform"])
    def test_a_refusal_names_the_ink(self, tmp_path, inks, shown):
        from engine.ink_manager import spot_to_process

        with pytest.raises(ValueError, match=f'^Ink "{shown}" declares no alternate colour space.$'):
            spot_to_process(_write(tmp_path, _UNCONVERTIBLE), str(tmp_path / "out.pdf"), inks)

    def test_an_alias_between_two_inks_shown_alike_selects_each_by_its_bytes(self, tmp_path):
        from engine.ink_manager import alias_ink

        out = str(tmp_path / "alias.pdf")
        result = alias_ink(_write(tmp_path, _ALIKE), out, {"key": LATIN_GREEN.hex()}, {"key": b"Gr#FCn".hex()},
                           accept_target_transform=True)
        assert result["renamed"] == 1
        assert _separation_names(out) == [b"Gr#FCn", b"Gr#FCn"]

    def test_an_alias_renames_a_devicen_component_and_its_colorants_entry_by_bytes(self, tmp_path):
        from engine.ink_manager import alias_ink

        out = str(tmp_path / "alias.pdf")
        alias_ink(_write(tmp_path, _INKS), out, {"key": LATIN_BLUE.hex()}, {"key": LATIN_GROEN.hex()},
                  accept_target_transform=True)
        with pikepdf.open(out) as pdf:
            space = pdf.pages[0].Resources.ColorSpace.CS2
            names = [bytes(n) for n in space[1]]
            colorants = sorted(k.encode("utf-8", "surrogateescape") for k in space[4].Colorants.keys())
        assert names == [b"/Cyan", b"/" + LATIN_GROEN]
        assert colorants == [b"/" + LATIN_GROEN]


#: The die line of `_DIE_LINE`, painted in a DeviceN space and selected
#: through a property list named `/MC#FC`.
_DIE_LINE_NAMED = _DIE_LINE.replace(b"/Properties << /MC0 7 0 R >>", b"/Properties << /MC#FC 7 0 R >>").replace(
    b"/OC /MC0 BDC /CS0 CS", b"/OC /MC#FC BDC /CS2 CS").replace(
    b"/CS1 [/Separation /Gr#F6n /DeviceCMYK 6 0 R] >>",
    b"/CS1 [/Separation /Gr#F6n /DeviceCMYK 6 0 R] /CS2 [/DeviceN [/Gr#FCn] /DeviceCMYK 6 0 R] >>").replace(
    b"/CS0 [/Separation /Gr#FCn /DeviceCMYK 6 0 R]\n   ", b"")


class TestProcessingStepsSelectedThroughNamesThatAreNotUtf8:
    def test_a_devicen_die_line_under_such_a_property_name_leaves_the_plate_list(self, tmp_path):
        from engine.separations import list_inks

        listed = list_inks(_write(tmp_path, _DIE_LINE_NAMED))
        assert [e["name"] for e in listed["inks"] if e["kind"] == "spot"] == ["Gr#F6n"]
        assert listed["processing_step_keys"] == [LATIN_GREEN.hex()]


#: A spot and a process fill: a proof composites both.
_SPOT_AND_BLACK = b"""%PDF-1.7
1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj
2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj
3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200]
 /Resources << /ColorSpace << /CS0 [/Separation /Gr#FCn /DeviceCMYK 6 0 R] >> >>
 /Contents 5 0 R >> endobj
5 0 obj << /Length 0 >> stream
/CS0 cs 1 scn 30 30 60 60 re f 0 0 0 1 k 100 30 60 60 re f
endstream endobj
6 0 obj << /FunctionType 2 /Domain [0 1] /C0 [0 0 0 0] /C1 [1 0 1 0] /N 1 >> endobj
trailer << /Root 1 0 R >>
%%EOF
"""


@pytest.mark.usefixtures("gs_path")
class TestPlatesInTheOrderOfTheirBytes:
    def test_spot_plates_come_in_the_order_of_their_names_bytes(self, tmp_path, gs_path):
        from engine.separations import render_separations

        plates = render_separations(_write(tmp_path, _INKS), 1, dpi=36, gs_path=gs_path, reuse=False)
        assert [p["key"] for p in plates["plates"] if p["kind"] == "spot"] == [
            LATIN_BLUE.hex(), UTF8_GREEN.hex(), LATIN_GROEN.hex(), LATIN_GREEN.hex()]

    def test_a_proof_composites_a_process_plate_beside_a_spot(self, tmp_path, gs_path):
        from engine.separations import composite_separations, render_separations

        plates = render_separations(_write(tmp_path, _SPOT_AND_BLACK), 1, dpi=36, gs_path=gs_path, reuse=False)
        wanted = [p for p in plates["plates"] if p["key"] in (b"Black".hex(), LATIN_GREEN.hex())]
        result = composite_separations(plates["dir"], wanted, output=str(tmp_path / "p.png"),
                                       simulation={"source": "bundled"}, gs_path=gs_path)
        assert result["simulation"]["refusal"] == ""


#: `_INKS` with a space ahead of the others whose family is a name that is
#: not UTF-8.
_ODD_FAMILY_FIRST = _INKS.replace(
    b"/Resources << /ColorSpace << /CS0", b"/Resources << /ColorSpace << /CSA [/Sep#FCaration /Gr#FCn /DeviceCMYK 6 0 R] /CS0")


class TestTheAlternateTableKeysEachColorantByItsBytes:
    def test_every_colorant_has_the_alternate_its_own_space_declares(self, tmp_path):
        from engine.soft_proof import page_alternates

        found = page_alternates(_write(tmp_path, _ODD_FAMILY_FIRST), 1)
        assert sorted(found) == sorted(raw.hex() for raw in (
            b"Cyan", LATIN_GREEN, LATIN_GROEN, LATIN_BLUE, UTF8_GREEN))
        # The DeviceN component carries its own `/Colorants` Separation, whose
        # full tint is DeviceCMYK 1 1 0 0.
        assert found[LATIN_BLUE.hex()]["lut"][-1] == pytest.approx([1.0, 1.0, 0.0, 0.0])


class TestReportRowsShowEachColorantByItsText:
    def test_a_rasterized_shading_row_shows_each_colorant_by_its_text(self):
        from engine import standards_report

        row = standards_report.colorant_shadings_lost([LATIN_GREEN, b"Spot", LATIN_GREEN])
        assert (row["count"], [entry["name"] for entry in row["detail"]]) == (2, ["Gr#FCn", "Spot"])

    def test_a_conversion_that_keeps_two_inks_shown_alike_loses_neither(self, tmp_path):
        from engine.prepress import _colour_report

        report = _colour_report([LATIN_GREEN, b"Gr#FCn"], Path(_write(tmp_path, _ALIKE)), [])
        assert [row["kind"] for row in report["altered"]] == []

    def test_an_override_that_is_not_a_set_of_parameters_is_named_in_the_refusal(self):
        from engine.trapping import validate_trap_preset

        with pytest.raises(ValueError, match="^The overrides for Gr#FCn must be trapping parameters.$"):
            validate_trap_preset({"ColorantZoneDetails": {"Gr#FCn": 5}})


class TestTheInkListIsInTheOrderOfTheBytes:
    def test_spots_come_in_the_order_of_their_names_bytes(self, tmp_path):
        from engine.separations import list_inks

        inks = list_inks(_write(tmp_path, _INKS))["inks"]
        assert [e["key"] for e in inks if e["kind"] == "spot"] == [
            LATIN_BLUE.hex(), UTF8_GREEN.hex(), LATIN_GROEN.hex(), LATIN_GREEN.hex()]


class TestAStagedProofReadsGroupTypesThatAreNotUtf8:
    def test_a_property_of_such_a_type_is_not_a_group_and_the_die_line_stays_off(self, tmp_path):
        from engine.separations import _carry_off_configuration, _tag_optional_content_groups
        from engine.split import _render_part

        src = tmp_path / "odd-type.pdf"
        with pikepdf.new() as pdf:
            die = pdf.make_indirect(pikepdf.Dictionary({"/Type": pikepdf.Name("/OCG"), "/Name": pikepdf.String("Die")}))
            odd = pdf.make_indirect(pikepdf.Dictionary({"/Type": pikepdf.Object.parse(b"/OC#FCG"),
                                                        "/Name": pikepdf.String("Odd")}))
            pdf.add_blank_page(page_size=(200, 200))
            pdf.pages[0].obj["/Resources"] = pikepdf.Dictionary(
                {"/Properties": pikepdf.Dictionary({"/oc1": die, "/oc2": odd})})
            pdf.Root["/OCProperties"] = pdf.make_indirect(pikepdf.Dictionary({
                "/OCGs": pikepdf.Array([die]), "/D": pikepdf.Dictionary({"/OFF": pikepdf.Array([die])})}))
            pdf.save(src)
        tagged, off_keys = _tag_optional_content_groups(str(src), tmp_path)
        single = tmp_path / "page.pdf"
        single.write_bytes(_render_part(str(tagged or src), [0]))
        assert tagged is not None and _carry_off_configuration(single, off_keys)
        with pikepdf.open(single) as pdf:
            assert [str(g.get("/Name")) for g in pdf.Root["/OCProperties"]["/D"]["/OFF"]] == ["Die"]


@pytest.mark.usefixtures("gs_path")
class TestAPlateSetWrittenByAnEarlierBuildIsRenderedAgain:
    def test_a_set_whose_manifest_names_inks_by_their_text_is_not_reused(self, tmp_path, gs_path):
        from engine.separations import render_separations

        src = _write(tmp_path, _INKS)
        first = render_separations(src, 1, dpi=36, gs_path=gs_path, reuse=False)
        manifest = Path(first["dir"]) / "plates.done"
        stored = json.loads(manifest.read_text(encoding="utf-8"))
        stored["version"] = 1
        manifest.write_text(json.dumps(stored), encoding="utf-8")
        render_separations(src, 1, dpi=36, gs_path=gs_path)
        assert json.loads(manifest.read_text(encoding="utf-8"))["version"] == 2


class TestAProofRefusalNamesTheInkByItsText:
    def test_an_ink_with_no_readable_alternate_is_named(self):
        from test_separations import DEFAULT_PRESS, _bundled_path

        from engine import soft_proof

        key = LATIN_GREEN.hex()
        profile = str(_bundled_path(DEFAULT_PRESS))
        _tables, _assumed, missing = soft_proof.spot_tables([key], {}, profile, labels={key: "Gr#FCn"})
        _tables, _assumed, empty = soft_proof.spot_tables(
            [key], {key: {"family": "ICCBased", "components": 0, "lut": None}}, profile, labels={key: "Gr#FCn"})
        for refusal in (missing, empty):
            assert "Gr#FCn" in refusal and key not in refusal


#: A spot shading beside a damaged keyword, carved out of the conversion,
#: and a spot shading whose alternate is a name that is not UTF-8.
def _spot_shading(tmp_path, name, alternate: bytes, keyword: bytes) -> str:
    content = keyword + b" q 100 100 50 50 re W n /Sh1 sh Q 0 0 1 rg 300 300 50 50 re f"
    raw = ((b"%PDF-1.7\n1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n"
           b"2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n"
           b"3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Shading << /Sh1 5 0 R >> >> "
           b"/Contents 4 0 R >> endobj\n")
           + (b"4 0 obj << /Length %d >> stream\n" % len(content)) + content + b"\nendstream endobj\n"
           b"5 0 obj << /ShadingType 2 /ColorSpace [/Separation /Spot " + alternate
           + b" << /FunctionType 2 /Domain [0 1] /C0 [0 0 0 0] /C1 [0 1 0 0] /N 1 >>] /Coords [100 0 150 0] "
           b"/Function << /FunctionType 2 /Domain [0 1] /C0 [0] /C1 [1] /N 1 >> >> endobj\n"
           b"trailer << /Root 1 0 R >>\n%%EOF\n")
    return _write(tmp_path, raw, name)


@pytest.mark.usefixtures("gs_path")
class TestAColourConversionPastNamesAndKeywordsThatAreNotUtf8:
    def test_a_spot_shading_is_carved_out_past_a_keyword(self, tmp_path, gs_path):
        from engine.prepress import convert_cmyk

        result = convert_cmyk(_spot_shading(tmp_path, "k.pdf", b"/DeviceCMYK", b"\xfc\xfd"),
                              str(tmp_path / "o.pdf"), gs_path=gs_path)
        assert result["altered"] == []

    def test_a_spot_shading_whose_alternate_is_such_a_name_is_rasterized(self, tmp_path, gs_path):
        from engine.prepress import convert_cmyk

        result = convert_cmyk(_spot_shading(tmp_path, "a.pdf", b"/Gar#FC", b""), str(tmp_path / "o.pdf"),
                              gs_path=gs_path)
        assert [(row["kind"], row["detail"]) for row in result["altered"]] == [
            ("colorant_shadings_rasterized", [{"name": "Spot"}]), ("colorants_removed", [{"name": "Spot"}])]


@pytest.mark.usefixtures("gs_path")
class TestTheInspectorReadsSpacesOfSuchNames:
    def test_an_indexed_space_over_a_base_of_such_a_family_is_read(self, tmp_path, gs_path):
        from engine.object_inspector import inspect_point
        from engine.separations import render_separations

        src = _write(tmp_path, _SPACES)
        plates = render_separations(src, 1, dpi=36, gs_path=gs_path, reuse=False)
        found = inspect_point(src, 1, 130, 30, plates=plates["plates"], plates_dir=plates["dir"], gs_path=gs_path)
        assert [o["colour"]["family"] for o in found["objects"]] == ["Indexed"]
