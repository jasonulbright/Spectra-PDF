"""The printer lab's decoders and guards, on bytes built here (no printer needed)."""

import io
import struct
import sys
import zipfile
from pathlib import Path

import pytest

LAB = Path(__file__).resolve().parent.parent / "scripts" / "printer-lab"
sys.path.insert(0, str(LAB))

import lab_decode  # noqa: E402
import printer_lab  # noqa: E402

UEL = b"\x1b%-12345X"


def xl_page(orientation: int, binding: int | None, simplex: bool = False) -> bytes:
    """One PCL XL BeginPage with an orientation and a duplex attribute."""
    body = bytes([0xC0, orientation, 0xF8, 0x28])
    if binding is not None:
        body += bytes([0xC0, binding, 0xF8, 0x35])
    if simplex:
        body += bytes([0xC0, 0, 0xF8, 0x34])
    return body + bytes([0x43]) + bytes([0x44])


def xl_job(*pages: bytes, extra: bytes = b"") -> bytes:
    pjl = UEL + b"@PJL SET RESOLUTION=600\n@PJL ENTER LANGUAGE=PCLXL\n"
    return pjl + b") HP-PCL XL;2;0\n" + bytes([0x41]) + extra + b"".join(pages) + bytes([0x42])


class TestPclXl:
    @pytest.mark.parametrize(
        "orientation,binding,edge",
        [(0, 1, "long"), (0, 0, "short"), (1, 1, "short"), (1, 0, "long"), (2, 1, "long"), (3, 0, "long")],
    )
    def test_binding_and_orientation_name_the_paper_edge(self, orientation, binding, edge):
        assert lab_decode.paper_edge(binding, orientation) == edge
        decoded = lab_decode.decode(xl_job(xl_page(orientation, binding)))
        assert decoded.language == "PCL XL"
        assert decoded.edges() == {edge}

    def test_simplex_page(self):
        decoded = lab_decode.decode(xl_job(xl_page(0, None, simplex=True)))
        assert decoded.summary() == "simplex"

    def test_pages_that_disagree_are_reported_as_a_conflict(self):
        decoded = lab_decode.decode(xl_job(xl_page(0, 1), xl_page(0, 0)))
        assert decoded.summary().startswith("CONFLICT")

    def test_embedded_data_is_skipped_not_read_as_operators(self):
        raster = bytes([0xFA]) + struct.pack("<I", 6) + bytes([0x43, 0x43, 0x35, 0xF8, 0xC0, 0x01])
        decoded = lab_decode.decode(xl_job(xl_page(0, 1), extra=raster))
        assert decoded.pages == 1 and decoded.edges() == {"long"}

    def test_array_and_box_values_are_skipped(self):
        array = bytes([0xC8, 0xC0, 3, 1, 2, 3, 0xF8, 0x25])
        box = bytes([0xE1]) + struct.pack("<4H", 1, 2, 3, 4) + bytes([0xF8, 0x24])
        decoded = lab_decode.decode(xl_job(array + xl_page(0, 0), extra=box))
        assert decoded.edges() == {"short"}

    def test_a_truncated_stream_is_marked_incomplete(self):
        data = xl_job(xl_page(0, 1))[:-3] + bytes([0xC1, 0x01])
        decoded = lab_decode.decode(data)
        assert not decoded.complete

    def test_an_unknown_tag_stops_the_read_and_is_noted(self):
        decoded = lab_decode.decode(xl_job(xl_page(0, 1), extra=bytes([0xBF])))
        assert not decoded.complete and any("unknown tag" in n for n in decoded.notes)

    def test_a_job_with_no_duplex_attribute_is_undecodable(self):
        decoded = lab_decode.decode(xl_job(bytes([0xC0, 0, 0xF8, 0x28, 0x43])))
        assert not decoded.decodable and decoded.summary() == "undecodable (PCL XL)"


class TestPcl5AndPjl:
    def test_pcl5_names_the_paper_edge(self):
        for value, edge in ((0, "simplex"), (1, "long"), (2, "short")):
            data = UEL + b"@PJL ENTER LANGUAGE=PCL\n\x1bE\x1b&l26A" + f"\x1b&l{value}S".encode() + b"\x0c"
            decoded = lab_decode.decode(data)
            assert decoded.language == "PCL" and decoded.edges() == {edge}

    def test_pjl_duplex_is_a_source(self):
        data = UEL + b"@PJL SET DUPLEX=ON\n@PJL SET BINDING=SHORTEDGE\n@PJL ENTER LANGUAGE=PCL\n\x1bE\x1b&l2S"
        decoded = lab_decode.decode(data)
        assert decoded.edges() == {"short"} and len(decoded.sources) == 2

    def test_pjl_and_pcl_that_disagree_conflict(self):
        data = UEL + b"@PJL SET DUPLEX=ON\n@PJL SET BINDING=LONGEDGE\n@PJL ENTER LANGUAGE=PCL\n\x1bE\x1b&l2S"
        assert lab_decode.decode(data).summary().startswith("CONFLICT")

    def test_pjl_duplex_off_is_simplex(self):
        data = UEL + b"@PJL SET DUPLEX=OFF\n@PJL ENTER LANGUAGE=PCL\n\x1bE"
        assert lab_decode.decode(data).edges() == {"simplex"}


class TestOtherLanguages:
    def test_postscript_portrait_and_landscape(self):
        portrait = b"%!PS-Adobe-3.0\n%%Orientation: Portrait\n<< /Duplex true /Tumble false >> setpagedevice\n"
        landscape = b"%!PS-Adobe-3.0\n%%Orientation: Landscape\n<< /Duplex true /Tumble false >> setpagedevice\n"
        assert lab_decode.decode(portrait).edges() == {"long"}
        assert lab_decode.decode(landscape).edges() == {"short"}

    def test_postscript_without_an_orientation_names_no_edge(self):
        data = b"%!PS-Adobe-3.0\n<< /Duplex true /Tumble true >> setpagedevice\n"
        decoded = lab_decode.decode(data)
        assert not decoded.decodable and decoded.sources[0].raw.startswith("/Duplex true /Tumble true")

    def test_postscript_duplex_false_is_simplex(self):
        assert lab_decode.decode(b"%!PS\n<< /Duplex false >> setpagedevice\n").edges() == {"simplex"}

    def test_xps_print_ticket(self):
        ticket = (
            '<PrintTicket><Feature name="psk:JobDuplexAllDocumentsContiguously">'
            '<Option name="psk:TwoSidedShortEdge"/></Feature></PrintTicket>'
        )
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w") as archive:
            archive.writestr("[Content_Types].xml", "<Types/>")
            archive.writestr("Documents/1/Metadata/Job_PT.xml", ticket)
        decoded = lab_decode.decode(buffer.getvalue())
        assert decoded.language == "XPS" and decoded.edges() == {"short"}

    def test_pdf_has_no_duplex_setting(self):
        decoded = lab_decode.decode(b"%PDF-1.7\n")
        assert decoded.language == "PDF" and not decoded.decodable

    def test_an_unknown_language_is_undecodable_not_guessed(self):
        decoded = lab_decode.decode(UEL + b"@PJL ENTER LANGUAGE=BRSPOOL\nxyz")
        assert decoded.summary().startswith("undecodable (unknown (BRSPOOL))")

    def test_empty_input(self):
        assert lab_decode.decode(b"").summary().startswith("undecodable")


class TestGuards:
    def test_only_lab_printers_are_accepted(self):
        assert printer_lab.require_lab_name("SpectraLabMfc") == "SpectraLabMfc"
        for name in ("Brother HL-L2400D", "Microsoft Print to PDF", "spectralab", "", "SpectraLab bad", "SpectraLab'x"):
            with pytest.raises(SystemExit):
                printer_lab.require_lab_name(name)

    def test_a_non_lab_name_is_refused_before_any_command_runs(self, monkeypatch):
        monkeypatch.setattr(printer_lab, "_ps", lambda command: pytest.fail("PowerShell ran"))
        with pytest.raises(SystemExit):
            printer_lab.port_file("Brother HL-L2400D")

    def test_a_lab_printer_on_a_physical_port_is_refused(self, monkeypatch):
        monkeypatch.setattr(printer_lab, "_ps", lambda command: "USB001")
        with pytest.raises(SystemExit):
            printer_lab.port_file("SpectraLabUsb")

    def test_a_lab_printer_on_a_file_port_gives_its_file(self, monkeypatch, tmp_path):
        target = str(tmp_path / "SpectraLabMfc.prn")
        monkeypatch.setattr(printer_lab, "_ps", lambda command: target)
        assert printer_lab.port_file("SpectraLabMfc") == Path(target)


class TestFrameComparison:
    base = {"case": [{"page_pt": [595.3, 841.9], "content_px": [37, 38, 1616, 2302]}]}

    def test_a_match_within_the_tolerance(self):
        now = {"case": [{"page_pt": [595.3, 841.9], "content_px": [38, 36, 1617, 2300]}]}
        assert printer_lab.compare_frame(now, self.base) == []

    def test_a_shrunk_page_is_reported(self):
        now = {"case": [{"page_pt": [595.3, 841.9], "content_px": [104, 134, 1549, 2206]}]}
        problems = printer_lab.compare_frame(now, self.base)
        assert problems and "content box" in problems[0]

    def test_a_page_size_change_and_a_missing_case(self):
        now = {"case": [{"page_pt": [612.0, 792.0], "content_px": [37, 38, 1616, 2302]}], "other": []}
        problems = printer_lab.compare_frame(now, self.base)
        assert any("page size" in p for p in problems) and any("not in the baseline" in p for p in problems)


class TestStatusAndExit:
    def decoded(self, edge="long", complete=True):
        d = lab_decode.Decoded("PCL XL", complete=complete)
        if edge:
            d.sources.append(lab_decode.Source("x", "x", edge))
        return d

    def test_row_status(self):
        status = printer_lab.row_status
        assert status(self.decoded("long"), "long", True) == "PASS"
        assert status(self.decoded("short"), "long", True) == "FAIL"
        assert status(self.decoded(None), "long", True) == "UNDECODABLE"
        assert status(self.decoded("long", complete=False), "long", True) == "INCOMPLETE"
        assert status(self.decoded("short", complete=False), "long", True) == "FAIL"
        assert status(self.decoded("long"), "long", False) == "NO DUPLEX UNIT"

    def test_exit_code(self):
        code = printer_lab.exit_code
        assert code([{"status": "PASS"}, {"status": "NO DUPLEX UNIT"}]) == 0
        assert code([{"status": "PASS"}, {"status": "UNDECODABLE"}]) == 2
        assert code([{"status": "INCOMPLETE"}]) == 2
        assert code([{"status": "UNDECODABLE"}, {"status": "FAIL"}]) == 1
        assert code([{"status": "ERROR"}]) == 1


class TestInjectionAndTeardown:
    def test_every_quote_character_powershell_accepts_is_doubled(self):
        for quote in ("'", "\u2018", "\u2019", "\u201a", "\u201b"):
            assert printer_lab._quote("a" + quote + "b") == "'a" + quote + quote + "b'"

    def test_driver_and_folder_text_is_limited(self):
        for bad in ("x\u2019; Remove-Printer -Name 'Real'; \u2019", "a;b", "a`b", "$(x)"):
            with pytest.raises(SystemExit):
                printer_lab._require_plain("driver name", bad, printer_lab._DRIVER_NAME)
        assert printer_lab._require_plain("driver name", "Brother MFC-L8690CDW series", printer_lab._DRIVER_NAME)

    def test_teardown_touches_only_the_port_setup_made(self, monkeypatch, tmp_path):
        calls = []

        def fake(command):
            calls.append(command)
            return "0" if "Count" in command else ""

        monkeypatch.setattr(printer_lab, "_ps", fake)
        printer_lab.teardown("SpectraLabMfc", tmp_path)
        listing = next(c for c in calls if "Get-PrinterPort" in c)
        assert "-eq" in listing and str(tmp_path / "SpectraLabMfc.prn") in listing and "-like" not in listing

    def test_a_printer_on_another_port_is_not_removed(self, monkeypatch, tmp_path):
        def fake(command):
            if "Count" in command:
                return "1"
            if "PortName" in command:
                return str(tmp_path / "elsewhere" / "SpectraLabMfc.prn")
            pytest.fail("a command ran for a printer on another port: " + command)

        monkeypatch.setattr(printer_lab, "_ps", fake)
        with pytest.raises(SystemExit):
            printer_lab.teardown("SpectraLabMfc", tmp_path)


class TestDecoderLimits:
    def test_a_pcl_xl_job_that_ends_with_the_uel_is_complete(self):
        data = xl_job(xl_page(0, 1)) + UEL + b"@PJL EOJ\n"
        decoded = lab_decode.decode(data)
        assert decoded.complete and decoded.edges() == {"long"}

    def test_a_large_xps_entry_is_not_read(self):
        buffer = io.BytesIO()
        with zipfile.ZipFile(buffer, "w", zipfile.ZIP_DEFLATED) as archive:
            archive.writestr("big.xml", b"a" * (lab_decode._XPS_ENTRY_LIMIT + 1))
        decoded = lab_decode.decode(buffer.getvalue())
        assert not decoded.complete and not decoded.decodable and "not read" in decoded.notes[0]


class TestRelativeFolder:
    def test_a_relative_folder_becomes_an_absolute_port(self, monkeypatch, tmp_path):
        calls = []
        monkeypatch.chdir(tmp_path)
        monkeypatch.setattr(printer_lab, "_ps", lambda command: calls.append(command) or "")
        monkeypatch.setattr(printer_lab, "has_duplex_unit", lambda name: True)
        printer_lab.setup("SpectraLabRel", "Some Driver", Path("labdir"), False)
        port = next(c for c in calls if c.startswith("Add-PrinterPort"))
        assert str((tmp_path / "labdir").resolve()) in port


class TestMatrixStopsWhenNoJobIsWritten:
    class FakeEngine:
        def __init__(self):
            self.jobs = 0

        def print_job(self, source, name, **kwargs):
            self.jobs += 1

        def default_duplex(self, name):
            return "simplex"

    def test_the_first_timeout_ends_the_run_with_one_error_row(self, monkeypatch, tmp_path):
        monkeypatch.setattr(printer_lab, "port_file", lambda name: tmp_path / "SpectraLabX.prn")
        monkeypatch.setattr(printer_lab, "has_duplex_unit", lambda name: True)
        monkeypatch.setattr(printer_lab, "make_source", lambda path, pages=4: None)

        def no_job(path):
            raise TimeoutError("no finished job")

        monkeypatch.setattr(printer_lab, "_wait_job", no_job)
        engine = self.FakeEngine()
        rows = printer_lab.run_matrix(engine, "SpectraLabX", tmp_path)
        assert len(rows) == 1 and engine.jobs == 1
        assert rows[0]["status"] == "ERROR" and "event 372" in rows[0]["note"]
        assert printer_lab.exit_code(rows) == 1


def test_a_short_8_3_folder_name_is_accepted():
    assert printer_lab._require_plain("folder", "C:\Users\RUNNER~1\Temp", printer_lab._PATH_TEXT)
