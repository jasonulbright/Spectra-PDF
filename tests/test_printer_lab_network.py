"""The printer lab's network side: the IPP parser and capture server, the TCP listener and
the IPP, PWG raster and URF decoders. Requests are built by hand; no Windows printer is needed."""

import http.client
import json
import socket
import struct
import sys
import time
from pathlib import Path

import pytest

LAB = Path(__file__).resolve().parent.parent / "scripts" / "printer-lab"
sys.path.insert(0, str(LAB))

import ipp_capture as ipp  # noqa: E402
import lab_decode  # noqa: E402
import printer_lab  # noqa: E402
import tcp_capture  # noqa: E402


# --- a hand-built IPP client ----------------------------------------------------


def attr(tag: int, name: str, value: bytes) -> bytes:
    n = name.encode()
    return bytes([tag]) + struct.pack(">H", len(n)) + n + struct.pack(">H", len(value)) + value


def keyword(name, value):
    return attr(0x44, name, value.encode())


def integer(name, value, tag=0x21):
    return attr(tag, name, struct.pack(">i", value))


def request(op, request_id=7, operation=(), job=(), version=(2, 0), body=b"", with_printer_uri=True):
    out = struct.pack(">BBHI", version[0], version[1], op, request_id)
    out += b"\x01" + attr(0x47, "attributes-charset", b"utf-8") + attr(0x48, "attributes-natural-language", b"en")
    if with_printer_uri:
        out += attr(0x45, "printer-uri", b"ipp://127.0.0.1/ipp/print")
    out += b"".join(operation)
    if job:
        out += b"\x02" + b"".join(job)
    return out + b"\x03" + body


JOB_ATTRIBUTES = (
    keyword("sides", "two-sided-short-edge"),
    integer("orientation-requested", 4, 0x23),
    keyword("media", "iso_a4_210x297mm"),
    integer("copies", 2),
    keyword("print-color-mode", "monochrome"),
)


@pytest.fixture
def server(tmp_path):
    capture = ipp.IppCapture(tmp_path / "caps", port=0, printer_name="SpectraLabTest").start()
    yield capture
    capture.stop()


def post(capture, data, path="/ipp/print", headers=None, chunked=False):
    connection = http.client.HTTPConnection("127.0.0.1", capture.port, timeout=10)
    headers = {"Content-Type": "application/ipp", **(headers or {})}
    if chunked:
        connection.putrequest("POST", path)
        connection.putheader("Content-Type", "application/ipp")
        connection.putheader("Transfer-Encoding", "chunked")
        connection.endheaders()
        for start in range(0, len(data), 40):
            piece = data[start:start + 40]
            connection.send(f"{len(piece):x}\r\n".encode() + piece + b"\r\n")
        connection.send(b"0\r\n\r\n")
    else:
        connection.request("POST", path, body=data, headers=headers)
    response = connection.getresponse()
    body = response.read()
    connection.close()
    assert response.status == 200 and response.getheader("Content-Type") == "application/ipp"
    return ipp.parse_message(body)


# --- parser and encoder ---------------------------------------------------------


class TestParser:
    def test_a_request_is_read_group_by_group(self):
        message = ipp.parse_message(request(ipp.OP_PRINT_JOB, job=JOB_ATTRIBUTES, body=b"%PDF-1.7 data"))
        assert message.version == (2, 0) and message.code == ipp.OP_PRINT_JOB and message.request_id == 7
        assert message.first("printer-uri") == "ipp://127.0.0.1/ipp/print"
        job = message.group(ipp.TAG_JOB)
        assert job["sides"] == ["two-sided-short-edge"]
        assert job["orientation-requested"] == [4] and job["copies"] == [2]
        assert message.body == b"%PDF-1.7 data"

    def test_additional_values_join_the_attribute(self):
        extra = attr(0x44, "requested-attributes", b"sides") + attr(0x44, "", b"media") + attr(0x44, "", b"copies")
        message = ipp.parse_message(request(ipp.OP_GET_PRINTER_ATTRIBUTES, operation=[extra]))
        assert message.group(ipp.TAG_OPERATION)["requested-attributes"] == ["sides", "media", "copies"]

    def test_a_collection_is_read_with_its_nested_members(self):
        size = (
            attr(0x4A, "", b"x-dimension") + attr(0x21, "", struct.pack(">i", 21000))
            + attr(0x4A, "", b"y-dimension") + attr(0x21, "", struct.pack(">i", 29700))
        )
        col = (
            attr(0x34, "media-col", b"")
            + attr(0x4A, "", b"media-size") + attr(0x34, "", b"") + size + b"\x37\x00\x00\x00\x00"
            + attr(0x4A, "", b"media-type") + attr(0x44, "", b"stationery")
            + b"\x37\x00\x00\x00\x00"
        )
        message = ipp.parse_message(request(ipp.OP_CREATE_JOB, job=[col, *JOB_ATTRIBUTES[:1]]))
        media = message.group(ipp.TAG_JOB)["media-col"][0]
        assert media["media-size"][0] == {"x-dimension": [21000], "y-dimension": [29700]}
        assert media["media-type"] == ["stationery"]
        assert message.group(ipp.TAG_JOB)["sides"] == ["two-sided-short-edge"]

    def test_value_types(self):
        values = (
            attr(0x22, "flag", b"\x01") + attr(0x33, "span", struct.pack(">ii", 1, 9))
            + attr(0x32, "res", struct.pack(">iib", 600, 600, 3)) + attr(0x13, "none", b"")
            + attr(0x35, "text", struct.pack(">H", 2) + b"en" + struct.pack(">H", 3) + b"abc")
        )
        message = ipp.parse_message(request(ipp.OP_VALIDATE_JOB, operation=[values]))
        got = message.group(ipp.TAG_OPERATION)
        assert got["flag"] == [True] and got["span"] == [(1, 9)] and got["res"] == [(600, 600, 3)]
        assert got["none"] == [None] and got["text"] == ["abc"]

    @pytest.mark.parametrize("cut", [3, 9, 20, 40])
    def test_a_truncated_message_is_refused(self, cut):
        with pytest.raises(ipp.IppError):
            ipp.parse_message(request(ipp.OP_PRINT_JOB, job=JOB_ATTRIBUTES)[:cut])

    def test_an_attribute_before_a_group_is_refused(self):
        with pytest.raises(ipp.IppError):
            ipp.parse_message(struct.pack(">BBHI", 2, 0, 2, 1) + attr(0x44, "sides", b"x") + b"\x03")

    def test_a_deeply_nested_collection_is_refused(self):
        nested = b"".join(attr(0x4A, "", b"m") + attr(0x34, "", b"") for _ in range(12))
        data = struct.pack(">BBHI", 2, 0, 2, 1) + b"\x02" + attr(0x34, "media-col", b"") + nested
        with pytest.raises(ipp.IppError):
            ipp.parse_message(data)

    def test_encode_then_parse_round_trips_a_collection(self):
        groups = [(ipp.TAG_PRINTER, [
            ("sides-supported", ipp.KEYWORD, ["one-sided", "two-sided-long-edge"]),
            ("media-col-default", ipp.BEG_COLLECTION, [ipp._media_collection(21000, 29700)]),
            ("copies-supported", ipp.RANGE, [(1, 99)]),
        ])]
        message = ipp.parse_message(ipp.encode_message((2, 0), 0, 5, groups))
        printer = message.group(ipp.TAG_PRINTER)
        assert printer["sides-supported"] == ["one-sided", "two-sided-long-edge"]
        assert printer["copies-supported"] == [(1, 99)]
        col = printer["media-col-default"][0]
        assert col["media-size"][0]["x-dimension"] == [21000] and col["media-source"] == ["auto"]


# --- the server -------------------------------------------------------------------


class TestServer:
    def test_get_printer_attributes_advertises_what_windows_needs(self, server):
        reply = post(server, request(ipp.OP_GET_PRINTER_ATTRIBUTES))
        assert reply.code == ipp.STATUS_OK and reply.request_id == 7 and reply.version == (2, 0)
        assert reply.first("attributes-charset") == "utf-8"
        printer = reply.group(ipp.TAG_PRINTER)
        assert printer["sides-supported"] == ["one-sided", "two-sided-long-edge", "two-sided-short-edge"]
        assert printer["document-format-supported"] == ["application/pdf", "image/pwg-raster", "image/urf"]
        assert printer["printer-state"] == [3] and printer["printer-is-accepting-jobs"] == [True]
        assert printer["printer-name"] == ["SpectraLabTest"]
        assert {"iso_a4_210x297mm", "na_letter_8.5x11in"} <= set(printer["media-supported"])
        assert printer["media-default"] == ["iso_a4_210x297mm"]
        assert printer["orientation-requested-supported"] == [3, 4, 5, 6]
        for operation in (ipp.OP_PRINT_JOB, ipp.OP_VALIDATE_JOB, ipp.OP_CREATE_JOB, ipp.OP_SEND_DOCUMENT,
                          ipp.OP_GET_JOB_ATTRIBUTES, ipp.OP_GET_JOBS, ipp.OP_GET_PRINTER_ATTRIBUTES):
            assert operation in printer["operations-supported"]

    def test_a_version_1_request_is_answered_in_version_1(self, server):
        reply = post(server, request(ipp.OP_GET_PRINTER_ATTRIBUTES, version=(1, 0)))
        assert reply.version == (1, 0) and reply.code == ipp.STATUS_OK

    def test_requested_attributes_limit_the_answer(self, server):
        wanted = [keyword("requested-attributes", "sides-supported")]
        printer = post(server, request(ipp.OP_GET_PRINTER_ATTRIBUTES, operation=wanted)).group(ipp.TAG_PRINTER)
        assert list(printer) == ["sides-supported"]

    def test_the_sides_default_is_set_by_the_command_line(self, tmp_path):
        capture = ipp.IppCapture(tmp_path, port=0, sides_default="two-sided-long-edge").start()
        try:
            printer = post(capture, request(ipp.OP_GET_PRINTER_ATTRIBUTES)).group(ipp.TAG_PRINTER)
            assert printer["sides-default"] == ["two-sided-long-edge"]
        finally:
            capture.stop()

    def test_print_job_records_attributes_and_saves_the_document(self, server):
        operation = [attr(0x49, "document-format", b"application/pdf"), attr(0x42, "job-name", b"test.pdf")]
        reply = post(server, request(ipp.OP_PRINT_JOB, operation=operation, job=JOB_ATTRIBUTES, body=b"%PDF-1.7\nbody"))
        assert reply.code == ipp.STATUS_OK
        job = reply.group(ipp.TAG_JOB)
        assert job["job-id"] == [1] and job["job-state"] == [9]
        assert job["job-state-reasons"] == ["job-completed-successfully"]
        record = json.loads((server.directory / "job-0001.json").read_text())
        assert record["summary"] == {
            "sides": "two-sided-short-edge", "orientation-requested": 4, "media": "iso_a4_210x297mm",
            "copies": 2, "print-color-mode": "monochrome", "document-format": "application/pdf",
        }
        assert (server.directory / "job-0001.doc").read_bytes() == b"%PDF-1.7\nbody"

    def test_a_chunked_upload_is_read_to_the_end(self, server):
        body = b"%PDF-1.7\n" + bytes(range(256)) * 20
        reply = post(server, request(ipp.OP_PRINT_JOB, job=JOB_ATTRIBUTES, body=body), chunked=True)
        assert reply.code == ipp.STATUS_OK
        assert (server.directory / "job-0001.doc").read_bytes() == body

    def test_create_job_then_send_document(self, server):
        created = post(server, request(ipp.OP_CREATE_JOB, job=JOB_ATTRIBUTES))
        job_id = created.group(ipp.TAG_JOB)["job-id"][0]
        assert created.group(ipp.TAG_JOB)["job-state"] == [3]
        assert not list(server.directory.glob("job-*.json"))
        send = [integer("job-id", job_id), attr(0x49, "document-format", b"application/pdf"),
                attr(0x22, "last-document", b"\x01")]
        sent = post(server, request(ipp.OP_SEND_DOCUMENT, operation=send, body=b"%PDF-1.7 doc", with_printer_uri=False))
        assert sent.code == ipp.STATUS_OK and sent.group(ipp.TAG_JOB)["job-state"] == [9]
        record = json.loads((server.directory / "job-0001.json").read_text())
        assert record["summary"]["sides"] == "two-sided-short-edge"
        assert record["summary"]["document-format"] == "application/pdf"
        assert (server.directory / "job-0001.doc").read_bytes() == b"%PDF-1.7 doc"

    def test_send_document_in_two_parts_waits_for_the_last_one(self, server):
        created = post(server, request(ipp.OP_CREATE_JOB, job=JOB_ATTRIBUTES))
        job_id = created.group(ipp.TAG_JOB)["job-id"][0]
        first = [integer("job-id", job_id), attr(0x22, "last-document", b"\x00")]
        last = [integer("job-id", job_id), attr(0x22, "last-document", b"\x01")]
        post(server, request(ipp.OP_SEND_DOCUMENT, operation=first, body=b"AAA"))
        assert not list(server.directory.glob("job-*.json"))
        post(server, request(ipp.OP_SEND_DOCUMENT, operation=last, body=b"BBB"))
        assert (server.directory / "job-0001.doc").read_bytes() == b"AAABBB"

    def test_get_job_attributes_and_get_jobs_report_a_finished_job(self, server):
        post(server, request(ipp.OP_PRINT_JOB, job=JOB_ATTRIBUTES, body=b"x"))
        one = post(server, request(ipp.OP_GET_JOB_ATTRIBUTES, operation=[integer("job-id", 1)]))
        assert one.group(ipp.TAG_JOB)["job-state"] == [9]
        by_uri = post(server, request(ipp.OP_GET_JOB_ATTRIBUTES,
                                      operation=[attr(0x45, "job-uri", b"ipp://127.0.0.1/ipp/print/1")]))
        assert by_uri.group(ipp.TAG_JOB)["job-id"] == [1]
        jobs = post(server, request(ipp.OP_GET_JOBS))
        assert [g[1]["job-id"] for g in jobs.groups if g[0] == ipp.TAG_JOB] == [[1]]
        missing = post(server, request(ipp.OP_GET_JOB_ATTRIBUTES, operation=[integer("job-id", 99)]))
        assert missing.code == ipp.STATUS_NOT_FOUND

    def test_validate_job_succeeds_and_records_nothing(self, server):
        assert post(server, request(ipp.OP_VALIDATE_JOB, job=JOB_ATTRIBUTES)).code == ipp.STATUS_OK
        assert not list(server.directory.glob("job-*"))

    def test_an_unknown_operation_a_new_version_and_garbage_are_refused(self, server):
        assert post(server, request(0x4000)).code == ipp.STATUS_OPERATION_NOT_SUPPORTED
        assert post(server, request(ipp.OP_GET_PRINTER_ATTRIBUTES, version=(3, 0))).code == ipp.STATUS_VERSION_NOT_SUPPORTED
        assert post(server, b"not ipp at all").code == ipp.STATUS_BAD_REQUEST

    def test_every_request_is_logged(self, server):
        post(server, request(ipp.OP_GET_PRINTER_ATTRIBUTES))
        post(server, request(ipp.OP_PRINT_JOB, job=JOB_ATTRIBUTES, body=b"x"))
        lines = [json.loads(line) for line in (server.directory / "requests.jsonl").read_text().splitlines()]
        assert [entry["operation"] for entry in lines] == ["Get-Printer-Attributes", "Print-Job"]
        assert lines[1]["job_attributes"]["sides"] == ["two-sided-short-edge"] and lines[1]["body_bytes"] == 1

    def test_a_plain_get_answers_for_a_browser_probe(self, server):
        connection = http.client.HTTPConnection("127.0.0.1", server.port, timeout=5)
        connection.request("GET", "/")
        assert connection.getresponse().status == 200

    def test_a_job_with_media_col_and_no_media_gets_its_size_as_media(self):
        record = {"job_attributes": {"media-col": [{"media-size": [{"x-dimension": [21590], "y-dimension": [27940]}]}]},
                  "operation_attributes": {}}
        assert ipp.summarize(record)["media"] == "21590x27940 (1/100 mm)"
        assert ipp.summarize({})["sides"] is None


# --- the raw TCP listener ---------------------------------------------------------


class TestTcpCapture:
    def wait_for(self, folder, count):
        deadline = time.time() + 10
        while time.time() < deadline:
            found = sorted(folder.glob("job-*.bin"))
            if len(found) >= count:
                return found
            time.sleep(0.05)
        raise AssertionError("no job file")

    def test_each_connection_is_one_job(self, tmp_path):
        capture = tcp_capture.TcpCapture(tmp_path, port=0, idle=2).start()
        try:
            pcl = b"\x1bE\x1b&l1S text \x0c\x1bE"
            for payload in (pcl, b"second job"):
                with socket.create_connection(("127.0.0.1", capture.port)) as connection:
                    connection.sendall(payload)
                self.wait_for(tmp_path, 1 if payload is pcl else 2)
            first, second = sorted(tmp_path.glob("job-*.bin"))
            assert first.read_bytes() == pcl and second.read_bytes() == b"second job"
            assert lab_decode.decode(first.read_bytes()).edges() == {"long"}
        finally:
            capture.stop()

    def test_a_connection_that_sends_nothing_makes_no_job(self, tmp_path):
        capture = tcp_capture.TcpCapture(tmp_path, port=0, idle=1).start()
        try:
            socket.create_connection(("127.0.0.1", capture.port)).close()
            time.sleep(0.5)
            assert not list(tmp_path.glob("job-*"))
        finally:
            capture.stop()

    def test_a_sender_that_stays_open_is_cut_after_the_idle_time(self, tmp_path):
        capture = tcp_capture.TcpCapture(tmp_path, port=0, idle=0.5).start()
        try:
            connection = socket.create_connection(("127.0.0.1", capture.port))
            connection.sendall(b"held open")
            assert self.wait_for(tmp_path, 1)[0].read_bytes() == b"held open"
            connection.close()
        finally:
            capture.stop()


# --- decoders -----------------------------------------------------------------------


def ipp_record(sides=None, orientation=3, **extra):
    job = {"orientation-requested": [orientation], "media": ["iso_a4_210x297mm"], "copies": [1],
           "print-color-mode": ["color"]}
    if sides is not None:
        job["sides"] = [sides]
    return {"job_attributes": job, "operation_attributes": {"document-format": ["application/pdf"]}, **extra}


class TestIppDecoder:
    @pytest.mark.parametrize(
        "sides,edge",
        [("one-sided", "simplex"), ("two-sided-long-edge", "long"), ("two-sided-short-edge", "short")],
    )
    def test_sides_names_the_paper_edge(self, sides, edge):
        decoded = lab_decode.decode_ipp(ipp_record(sides))
        assert decoded.language == "IPP" and decoded.edges() == {edge} and decoded.complete
        assert printer_lab.row_status(decoded, edge, True) == "PASS"
        assert printer_lab.row_status(decoded, "long" if edge != "long" else "short", True) == "FAIL"

    def test_the_other_attributes_are_shown_in_the_notes(self):
        decoded = lab_decode.decode_ipp(ipp_record("one-sided", orientation=4))
        assert decoded.orientation == "landscape"
        assert "media=iso_a4_210x297mm" in decoded.notes[0] and "copies=1" in decoded.notes[0]
        assert "print-color-mode=color" in decoded.notes[0] and "document-format=application/pdf" in decoded.notes[0]

    def test_a_job_with_no_sides_is_undecodable_not_simplex(self):
        decoded = lab_decode.decode_ipp(ipp_record(None))
        assert not decoded.decodable and decoded.summary() == "undecodable (IPP)"
        assert printer_lab.row_status(decoded, "simplex", True) == "UNDECODABLE"

    def test_an_unknown_sides_value_is_undecodable(self):
        decoded = lab_decode.decode_ipp(ipp_record("two-sided-sideways"))
        assert not decoded.decodable and decoded.sources[0].raw == "two-sided-sideways"

    def test_sides_in_the_operation_group_is_read(self):
        record = {"job_attributes": {}, "operation_attributes": {"sides": ["two-sided-long-edge"]}}
        assert lab_decode.decode_ipp(record).edges() == {"long"}

    def test_two_different_sides_values_are_a_conflict(self):
        record = ipp_record("one-sided")
        record["job_attributes"]["sides"].append("two-sided-long-edge")
        assert lab_decode.decode_ipp(record).summary().startswith("CONFLICT")

    def test_a_record_saved_by_the_server_decodes(self, tmp_path):
        capture = ipp.IppCapture(tmp_path, port=0).start()
        try:
            post(capture, request(ipp.OP_PRINT_JOB, job=JOB_ATTRIBUTES, body=b"%PDF-1.7"))
        finally:
            capture.stop()
        record = json.loads((tmp_path / "job-0001.json").read_text())
        decoded = lab_decode.decode_ipp(record, (tmp_path / "job-0001.doc").read_bytes())
        assert decoded.edges() == {"short"} and decoded.orientation == "landscape"


def pwg_page(duplex, tumble, width=3, height=2, bits=8, rows=None):
    header = bytearray(1796)
    header[:9] = b"PwgRaster"
    struct.pack_into(">I", header, 272, duplex)
    struct.pack_into(">I", header, 368, tumble)
    struct.pack_into(">III", header, 372, width, height, 0)
    struct.pack_into(">I", header, 388, bits)  # cupsBitsPerPixel; cupsMediaType sits at 380
    if rows is None:
        # line repeat 0 (one line), then one run of `width` grey pixels; repeated for each line
        rows = (bytes([0, width - 1, 0x80])) * height
    return bytes(header) + rows


def urf_job(duplex, width=3, height=2, pages=1):
    header = bytes([8, 0, duplex, 4]) + b"\x00" * 8 + struct.pack(">III", width, height, 300) + b"\x00" * 8
    page = header + bytes([0, width - 1, 0x80]) * height
    return b"UNIRAST\x00" + struct.pack(">I", pages) + page * pages


class TestRasterDecoders:
    @pytest.mark.parametrize("duplex,tumble,edge", [(0, 0, "simplex"), (1, 0, "long"), (1, 1, "short")])
    def test_a_pwg_raster_header_names_the_edge(self, duplex, tumble, edge):
        decoded = lab_decode.decode(b"RaS2" + pwg_page(duplex, tumble) + pwg_page(duplex, tumble))
        assert decoded.language == "PWG raster" and decoded.edges() == {edge}
        assert decoded.complete and decoded.pages == 2

    def test_pwg_pages_that_disagree_are_a_conflict(self):
        decoded = lab_decode.decode(b"RaS2" + pwg_page(1, 0) + pwg_page(1, 1))
        assert decoded.summary().startswith("CONFLICT")

    def test_a_pwg_header_with_a_value_outside_the_spec_is_undecodable(self):
        decoded = lab_decode.decode(b"RaS2" + pwg_page(5, 0))
        assert not decoded.decodable

    def test_a_cut_pwg_stream_is_incomplete(self):
        decoded = lab_decode.decode(b"RaS2" + pwg_page(1, 1)[:-3])
        assert not decoded.complete and decoded.edges() == {"short"}
        assert printer_lab.row_status(decoded, "short", True) == "INCOMPLETE"

    def test_pwg_literal_runs_and_line_repeats_are_walked(self):
        # line 1 repeats once (2 lines): a literal run of 257-254=3 pixels; line 3 is a fill-to-end run
        page = pwg_page(1, 0, width=3, height=3, rows=bytes([1, 254, 7, 8, 9]) + bytes([0, 0x80]))
        decoded = lab_decode.decode(b"RaS2" + page)
        assert decoded.complete and decoded.edges() == {"long"}

    def test_a_colour_page_of_three_bytes_per_pixel_is_walked(self):
        # as Windows sends it: a line repeat byte, then 128 white pixels and 2 more (3 bytes each)
        rows = bytes([4, 127, 255, 255, 255, 1, 16, 32, 48])
        decoded = lab_decode.decode(b"RaS2" + pwg_page(1, 0, width=130, height=5, bits=24, rows=rows))
        assert decoded.complete and decoded.edges() == {"long"}

    @pytest.mark.parametrize("duplex,edge", [(1, "simplex"), (2, "long"), (3, "short")])
    def test_a_urf_page_header_names_the_edge(self, duplex, edge):
        decoded = lab_decode.decode(urf_job(duplex, pages=2))
        assert decoded.language == "URF" and decoded.edges() == {edge} and decoded.complete and decoded.pages == 2

    def test_a_urf_duplex_value_outside_the_spec_is_undecodable(self):
        assert not lab_decode.decode(urf_job(9)).decodable

    def test_a_urf_file_with_a_wrong_page_count_is_incomplete(self):
        data = urf_job(2)
        data = data[:8] + struct.pack(">I", 3) + data[12:]
        assert not lab_decode.decode(data).complete

    def test_the_raster_header_counts_only_when_the_job_has_no_sides(self):
        raster = b"RaS2" + pwg_page(1, 0)
        with_sides = lab_decode.decode_ipp(ipp_record("two-sided-short-edge"), raster)
        assert with_sides.edges() == {"short"} and any("different edge" in n for n in with_sides.notes)
        without = lab_decode.decode_ipp(ipp_record(None), raster)
        assert without.edges() == {"long"}


# --- the lab commands (PowerShell and the listener are replaced) ----------------------


class TestNetworkGuards:
    def test_a_non_lab_name_is_refused_before_anything_runs(self, monkeypatch, tmp_path):
        monkeypatch.setattr(printer_lab, "_ps", lambda command: pytest.fail("PowerShell ran"))
        monkeypatch.setattr(printer_lab, "start_listener", lambda *a: pytest.fail("a listener started"))
        for kind in ("ipp", "tcp"):
            with pytest.raises(SystemExit):
                printer_lab.setup_network("Brother HL-L2400D", kind, "Driver", tmp_path, True, 9101)
        with pytest.raises(SystemExit):
            printer_lab.teardown_network("Brother HL-L2400D", tmp_path)

    def test_bad_driver_names_ports_and_sides_defaults_are_refused(self, monkeypatch, tmp_path):
        monkeypatch.setattr(printer_lab, "_ps", lambda command: pytest.fail("PowerShell ran"))
        with pytest.raises(SystemExit):
            printer_lab.setup_network("SpectraLabIpp", "ipp", "x'; Remove-Printer -Name 'Real", tmp_path, True, 6310)
        with pytest.raises(SystemExit):
            printer_lab.setup_network("SpectraLabIpp", "ipp", None, tmp_path, True, 6310, "two-sided-sideways")
        with pytest.raises(SystemExit):
            printer_lab.setup_network("SpectraLabTcp", "tcp", "Some Driver", tmp_path, True, 9101, "one-sided")
        with pytest.raises(SystemExit):
            printer_lab.setup_network("SpectraLabTcp", "tcp", None, tmp_path, True, 9101)
        with pytest.raises(SystemExit):
            printer_lab.setup_network("SpectraLabTcp", "tcp", "Some Driver", tmp_path, True, 80)

    def test_ipp_setup_needs_an_elevated_session(self, monkeypatch, tmp_path):
        monkeypatch.setattr(printer_lab, "_ps", lambda command: "0")
        monkeypatch.setattr(printer_lab, "_is_admin", lambda: False)
        monkeypatch.setattr(printer_lab, "start_listener", lambda *a: pytest.fail("a listener started"))
        with pytest.raises(SystemExit, match="elevated"):
            printer_lab.setup_network("SpectraLabIpp", "ipp", None, tmp_path, True, 6310)

    def test_an_existing_printer_is_not_taken_over(self, monkeypatch, tmp_path):
        monkeypatch.setattr(printer_lab, "_ps", lambda command: "1")
        monkeypatch.setattr(printer_lab, "start_listener", lambda *a: pytest.fail("a listener started"))
        with pytest.raises(SystemExit, match="already exists"):
            printer_lab.setup_network("SpectraLabTcp", "tcp", "Some Driver", tmp_path, True, 9101)

    def test_tcp_setup_makes_the_loopback_port_then_the_printer(self, monkeypatch, tmp_path):
        calls = []

        def fake(command):
            calls.append(command)
            return "0" if "Count" in command else ""

        monkeypatch.setattr(printer_lab, "_ps", fake)
        monkeypatch.setattr(printer_lab, "_listening", lambda port: False)
        monkeypatch.setattr(printer_lab, "start_listener", lambda *a: 4242)
        monkeypatch.setattr(printer_lab, "has_duplex_unit", lambda name: True)
        printer_lab.setup_network("SpectraLabTcp", "tcp", "Universal Print Class Driver", tmp_path, False, 9101)
        add_port = next(c for c in calls if c.startswith("Add-PrinterPort"))
        assert "IP_127.0.0.1_9101" in add_port and "-PrinterHostAddress 127.0.0.1" in add_port and "-PortNumber 9101" in add_port
        add_printer = next(c for c in calls if c.startswith("Add-Printer "))
        assert "'SpectraLabTcp'" in add_printer and "'Universal Print Class Driver'" in add_printer
        state = printer_lab.read_state(tmp_path, "SpectraLabTcp")
        assert state["kind"] == "tcp" and state["port_name"] == "IP_127.0.0.1_9101" and state["pid"] == 4242

    def test_ipp_setup_uses_ippurl_and_records_the_port_windows_made(self, monkeypatch, tmp_path):
        calls = []

        def fake(command):
            calls.append(command)
            if "Count" in command:
                return "0"
            if "PortName" in command:
                return "WSD-8745ecf7-c31f-474e-aa39-3a2e2ea8db9d"
            return ""

        monkeypatch.setattr(printer_lab, "_ps", fake)
        monkeypatch.setattr(printer_lab, "_is_admin", lambda: True)
        monkeypatch.setattr(printer_lab, "_listening", lambda port: False)
        monkeypatch.setattr(printer_lab, "start_listener", lambda *a: 4243)
        monkeypatch.setattr(printer_lab, "has_duplex_unit", lambda name: True)
        printer_lab.setup_network("SpectraLabIpp", "ipp", None, tmp_path, True, 6310)
        add = next(c for c in calls if c.startswith("Add-Printer "))
        assert "-IppURL 'http://127.0.0.1:6310/ipp/print'" in add and "'SpectraLabIpp'" in add
        assert printer_lab.read_state(tmp_path, "SpectraLabIpp")["port_name"].startswith("WSD-")

    def test_ipp_setup_with_a_driver_switches_the_queue_and_passes_the_sides_default(self, monkeypatch, tmp_path):
        calls, started = [], []

        def fake(command):
            calls.append(command)
            if "Count" in command:
                return "0"
            return "WSD-8745ecf7-c31f-474e-aa39-3a2e2ea8db9d" if "PortName" in command else ""

        monkeypatch.setattr(printer_lab, "_ps", fake)
        monkeypatch.setattr(printer_lab, "_is_admin", lambda: True)
        monkeypatch.setattr(printer_lab, "_listening", lambda port: False)
        monkeypatch.setattr(printer_lab, "start_listener", lambda *a: started.append(a) or 4245)
        monkeypatch.setattr(printer_lab, "has_duplex_unit", lambda name: True)
        printer_lab.setup_network("SpectraLabIpp", "ipp", "Microsoft PWG Raster Class Driver", tmp_path, True, 6310,
                                  "two-sided-long-edge")
        order = [c.split(" ")[0] for c in calls if c.startswith(("Add-Printer ", "Set-Printer "))]
        assert order == ["Add-Printer", "Set-Printer"]
        assert "'Microsoft PWG Raster Class Driver'" in next(c for c in calls if c.startswith("Set-Printer "))
        assert started[0][4] == "two-sided-long-edge"

    def test_a_failed_setup_is_undone(self, monkeypatch, tmp_path):
        calls = []

        def fake(command):
            calls.append(command)
            if "Count" in command:
                return "0"
            if command.startswith("Add-Printer "):
                raise RuntimeError("driver refused")
            return "IP_127.0.0.1_9101" if command.startswith("Get-PrinterPort") and len(calls) > 4 else ""

        monkeypatch.setattr(printer_lab, "_ps", fake)
        monkeypatch.setattr(printer_lab, "_listening", lambda port: False)
        monkeypatch.setattr(printer_lab, "start_listener", lambda *a: 4244)
        stopped = []
        monkeypatch.setattr(printer_lab, "stop_listener", lambda state: stopped.append(state["pid"]))
        with pytest.raises(SystemExit, match="was undone"):
            printer_lab.setup_network("SpectraLabTcp", "tcp", "Bad Driver", tmp_path, True, 9101)
        assert stopped == [4244] and printer_lab.read_state(tmp_path, "SpectraLabTcp") is None
        assert any(c.startswith("Remove-PrinterPort") and "IP_127.0.0.1_9101" in c for c in calls)

    def write_state(self, tmp_path, **changes):
        state = {"kind": "tcp", "name": "SpectraLabTcp", "port": 9101, "port_name": "IP_127.0.0.1_9101",
                 "capture_dir": str(tmp_path / "SpectraLabTcp-capture"), "pid": 4242, **changes}
        (tmp_path / "SpectraLabTcp-capture").mkdir()
        printer_lab.write_state(tmp_path, "SpectraLabTcp", state)

    def test_teardown_removes_the_recorded_port_the_listener_and_the_captures(self, monkeypatch, tmp_path):
        self.write_state(tmp_path)
        calls = []

        def fake(command):
            calls.append(command)
            if "Count" in command:
                return "1"
            if "PortName" in command:
                return "IP_127.0.0.1_9101"
            if "Get-PrinterPort" in command:
                return "IP_127.0.0.1_9101"
            return ""

        monkeypatch.setattr(printer_lab, "_ps", fake)
        stopped = []
        monkeypatch.setattr(printer_lab, "stop_listener", lambda state: stopped.append(state["pid"]))
        printer_lab.teardown("SpectraLabTcp", tmp_path)
        assert any(c.startswith("Remove-Printer ") for c in calls)
        assert any(c.startswith("Remove-PrinterPort") and "IP_127.0.0.1_9101" in c for c in calls)
        assert stopped == [4242]
        assert not (tmp_path / "SpectraLabTcp-capture").exists()
        assert printer_lab.read_state(tmp_path, "SpectraLabTcp") is None

    def test_teardown_refuses_a_printer_that_moved_to_another_port(self, monkeypatch, tmp_path):
        self.write_state(tmp_path)

        def fake(command):
            if "Count" in command:
                return "1"
            if "PortName" in command:
                return "USB001"
            pytest.fail("a command ran: " + command)

        monkeypatch.setattr(printer_lab, "_ps", fake)
        with pytest.raises(SystemExit):
            printer_lab.teardown("SpectraLabTcp", tmp_path)

    @pytest.mark.parametrize("port", ["USB001", "COM1:", "IP_192.168.1.5_9100", "http://127.0.0.1:631/ipp/print", "FILE:"])
    def test_teardown_never_removes_a_port_that_is_not_a_loopback_lab_port(self, monkeypatch, tmp_path, port):
        self.write_state(tmp_path, port_name=port)
        monkeypatch.setattr(printer_lab, "_ps", lambda command: pytest.fail("a command ran: " + command))
        with pytest.raises(SystemExit, match="not a lab port"):
            printer_lab.teardown("SpectraLabTcp", tmp_path)

    def test_the_listener_is_stopped_only_when_the_pid_runs_that_listener(self, monkeypatch, tmp_path):
        state = {"pid": 4242, "capture_dir": str(tmp_path / "caps")}
        killed = []
        monkeypatch.setattr(printer_lab.subprocess, "run", lambda cmd, **kw: killed.append(cmd))
        monkeypatch.setattr(printer_lab, "_ps", lambda command: "notepad.exe")
        printer_lab.stop_listener(state)
        assert not killed
        monkeypatch.setattr(printer_lab, "_ps", lambda command: f"python.exe tcp_capture.py --dir {tmp_path / 'caps'} --port 1")
        printer_lab.stop_listener(state)
        assert killed and killed[0][:3] == ["taskkill", "/PID", "4242"]


class FakePrintEngine:
    """Writes the job a driver would send: an IPP record or TCP bytes, into the capture folder."""

    def __init__(self, folder, kind, sides_by_mode):
        self.folder, self.kind, self.sides = Path(folder), kind, sides_by_mode

    def default_duplex(self, name):
        return "simplex"

    def print_job(self, source, name, duplex="printer", **kwargs):
        sides = self.sides[duplex]
        if self.kind == "ipp":
            record = {"job-id": 1, "document_file": "job-0001.doc", "job_attributes": {"sides": [sides]},
                      "operation_attributes": {"document-format": ["application/pdf"]}}
            (self.folder / "job-0001.doc").write_bytes(b"%PDF-1.7")
            (self.folder / "job-0001.json").write_text(json.dumps(record))
        else:
            (self.folder / "job-0001.bin").write_bytes(sides)


class TestMatrixOnNetworkTargets:
    def target(self, monkeypatch, tmp_path, kind):
        folder = tmp_path / "caps"
        folder.mkdir()
        monkeypatch.setattr(printer_lab, "_printer_port", lambda name: "PORT")
        monkeypatch.setattr(printer_lab, "_listening", lambda port: True)
        monkeypatch.setattr(printer_lab, "SETTLE_S", 0)
        monkeypatch.setattr(printer_lab, "has_duplex_unit", lambda name: True)
        monkeypatch.setattr(printer_lab, "make_source", lambda path, pages=4: None)
        state = {"kind": kind, "capture_dir": str(folder), "port_name": "PORT", "port": 1}
        return folder, printer_lab.CaptureTarget("SpectraLabX", state, timeout=2)

    def test_an_ipp_printer_passes_when_sides_follows_the_request(self, monkeypatch, tmp_path):
        folder, target = self.target(monkeypatch, tmp_path, "ipp")
        engine = FakePrintEngine(folder, "ipp", {
            "printer": "one-sided", "simplex": "one-sided", "long": "two-sided-long-edge", "short": "two-sided-short-edge"})
        rows = printer_lab.run_matrix(engine, "SpectraLabX", tmp_path, target)
        assert len(rows) == 12 and {r["status"] for r in rows} == {"PASS"}
        assert {r["language"] for r in rows} == {"IPP"} and printer_lab.exit_code(rows) == 0

    def test_a_wrong_edge_fails_its_cells_only(self, monkeypatch, tmp_path):
        folder, target = self.target(monkeypatch, tmp_path, "ipp")
        engine = FakePrintEngine(folder, "ipp", {
            "printer": "one-sided", "simplex": "one-sided", "long": "two-sided-long-edge", "short": "two-sided-long-edge"})
        rows = printer_lab.run_matrix(engine, "SpectraLabX", tmp_path, target)
        failed = [r for r in rows if r["status"] == "FAIL"]
        assert len(failed) == 3 and {r["duplex"] for r in failed} == {"short"}
        assert printer_lab.exit_code(rows) == 1

    def test_a_tcp_job_with_no_duplex_command_is_undecodable(self, monkeypatch, tmp_path):
        folder, target = self.target(monkeypatch, tmp_path, "tcp")
        engine = FakePrintEngine(folder, "tcp", dict.fromkeys(("printer", "simplex", "long", "short"), b"\x1bE text \x0c"))
        rows = printer_lab.run_matrix(engine, "SpectraLabX", tmp_path, target)
        assert {r["status"] for r in rows} == {"UNDECODABLE"} and printer_lab.exit_code(rows) == 2

    def test_a_job_that_never_arrives_ends_the_run_with_one_error(self, monkeypatch, tmp_path):
        folder, target = self.target(monkeypatch, tmp_path, "tcp")
        engine = FakePrintEngine(folder, "tcp", {})
        engine.print_job = lambda *a, **k: None
        rows = printer_lab.run_matrix(engine, "SpectraLabX", tmp_path, target)
        assert len(rows) == 1 and rows[0]["status"] == "ERROR" and "capture listener" in rows[0]["note"]

    def test_a_printer_on_another_port_is_refused(self, monkeypatch, tmp_path):
        monkeypatch.setattr(printer_lab, "_printer_port", lambda name: "USB001")
        state = {"kind": "ipp", "capture_dir": str(tmp_path), "port_name": "WSD-x", "port": 1}
        with pytest.raises(SystemExit):
            printer_lab.CaptureTarget("SpectraLabX", state)

    def test_a_dead_listener_is_reported(self, monkeypatch, tmp_path):
        monkeypatch.setattr(printer_lab, "_printer_port", lambda name: "PORT")
        monkeypatch.setattr(printer_lab, "_listening", lambda port: False)
        state = {"kind": "tcp", "capture_dir": str(tmp_path), "port_name": "PORT", "port": 9101}
        with pytest.raises(SystemExit, match="not running"):
            printer_lab.CaptureTarget("SpectraLabX", state)

    def test_resolve_target_uses_the_file_port_when_there_is_no_state(self, monkeypatch, tmp_path):
        monkeypatch.setattr(printer_lab, "port_file", lambda name: tmp_path / "SpectraLabX.prn")
        assert isinstance(printer_lab.resolve_target("SpectraLabX", tmp_path), printer_lab.FileTarget)
        with pytest.raises(SystemExit):
            printer_lab.resolve_target("Brother HL-L2400D", tmp_path)


class TestEngineTimeout:
    def engine(self, error):
        class FakePrinter:
            @staticmethod
            def print_pdf(*args, **kwargs):
                raise error

        engine = object.__new__(printer_lab.Engine)
        engine.gs, engine.printer = Path("gs.exe"), FakePrinter
        return engine

    def test_a_print_that_timed_out_is_a_timeout_error(self):
        message = "Print job timed out after 90s - the printer driver did not respond"
        with pytest.raises(TimeoutError):
            self.engine(RuntimeError(message)).print_job(Path("x.pdf"), "SpectraLabX")

    def test_any_other_engine_error_is_passed_on(self):
        with pytest.raises(RuntimeError, match="Ghostscript print failed"):
            self.engine(RuntimeError("Ghostscript print failed: x")).print_job(Path("x.pdf"), "SpectraLabX")


class TestDocumentFormats:
    def test_the_server_advertises_the_formats_it_is_given(self, tmp_path):
        capture = ipp.IppCapture(tmp_path, port=0, formats=["application/postscript", "application/pdf"]).start()
        try:
            printer = post(capture, request(ipp.OP_GET_PRINTER_ATTRIBUTES)).group(ipp.TAG_PRINTER)
            assert printer["document-format-supported"] == ["application/postscript", "application/pdf"]
        finally:
            capture.stop()

    def test_a_bad_format_list_is_refused(self, monkeypatch, tmp_path):
        monkeypatch.setattr(printer_lab, "_ps", lambda command: pytest.fail("PowerShell ran"))
        for formats, kind in (("x; Remove-Printer", "ipp"), ("application/pdf", "tcp")):
            with pytest.raises(SystemExit):
                printer_lab.setup_network("SpectraLabIpp", kind, "Some Driver", tmp_path, True, 9101, None, formats)


class TestAllModes:
    def run(self, monkeypatch, tmp_path, all_modes):
        folder = tmp_path / "caps"
        folder.mkdir()
        monkeypatch.setattr(printer_lab, "_printer_port", lambda name: "PORT")
        monkeypatch.setattr(printer_lab, "_listening", lambda port: True)
        monkeypatch.setattr(printer_lab, "SETTLE_S", 0)
        monkeypatch.setattr(printer_lab, "has_duplex_unit", lambda name: False)
        monkeypatch.setattr(printer_lab, "make_source", lambda path, pages=4: None)
        state = {"kind": "tcp", "capture_dir": str(folder), "port_name": "PORT", "port": 1}
        target = printer_lab.CaptureTarget("SpectraLabX", state, timeout=2)
        modes = dict.fromkeys(("printer", "simplex", "long", "short"), b"\x1bE text \x0c")
        engine = FakePrintEngine(folder, "tcp", modes)
        return printer_lab.run_matrix(engine, "SpectraLabX", tmp_path, target, all_modes)

    def test_without_a_duplex_unit_only_the_printer_default_runs(self, monkeypatch, tmp_path):
        rows = self.run(monkeypatch, tmp_path, False)
        assert len(rows) == 3 and {r["status"] for r in rows} == {"NO DUPLEX UNIT"}

    def test_all_modes_prints_every_cell_and_shows_what_the_job_carries(self, monkeypatch, tmp_path):
        rows = self.run(monkeypatch, tmp_path, True)
        assert len(rows) == 12 and {r["status"] for r in rows} == {"NO DUPLEX UNIT"}
        assert {r["found"] for r in rows} == {"undecodable (PCL)"}


# --- hostile and broken clients -----------------------------------------------------


def raw_exchange(port, payload, wait=5.0):
    """Send raw bytes, return (everything received, seconds taken); stops at close or `wait`."""
    started = time.monotonic()
    received = b""
    with socket.create_connection(("127.0.0.1", port), timeout=wait) as connection:
        connection.sendall(payload)
        try:
            while True:
                piece = connection.recv(65536)
                if not piece:
                    break
                received += piece
        except socket.timeout:
            received += b"<timed out>"
    return received, time.monotonic() - started


HEAD = b"POST /ipp/print HTTP/1.1\r\nHost: x\r\nContent-Type: application/ipp\r\n"


class TestBindingAndPorts:
    def test_both_servers_bind_the_loopback_address_only(self, tmp_path):
        server = ipp.IppCapture(tmp_path / "i", port=0)
        listener = tcp_capture.TcpCapture(tmp_path / "t", port=0)
        try:
            assert server.httpd.server_address[0] == "127.0.0.1"
            assert listener.sock.getsockname()[0] == "127.0.0.1"
        finally:
            server.httpd.server_close()
            listener.stop()
        with pytest.raises(ValueError):
            ipp.IppCapture(tmp_path / "i2", host="0.0.0.0", port=0)
        with pytest.raises(ValueError):
            tcp_capture.TcpCapture(tmp_path / "t2", host="0.0.0.0", port=0)

    def test_a_second_ipp_server_cannot_take_a_used_port(self, tmp_path, server):
        with pytest.raises(OSError):
            ipp.IppCapture(tmp_path / "again", port=server.port)

    def test_a_second_tcp_listener_cannot_take_a_used_port(self, tmp_path):
        first = tcp_capture.TcpCapture(tmp_path / "a", port=0).start()
        try:
            with pytest.raises(OSError):
                tcp_capture.TcpCapture(tmp_path / "b", port=first.port)
        finally:
            first.stop()


class TestIppBadClients:
    def test_a_huge_content_length_with_no_body_gets_a_clean_error_at_once(self, server):
        reply, took = raw_exchange(server.port, HEAD + b"Content-Length: 99999999999\r\n\r\n")
        assert reply.startswith(b"HTTP/1.1 400") and took < 3

    def test_a_length_above_the_cap_is_refused_before_it_is_read(self, tmp_path):
        capture = ipp.IppCapture(tmp_path, port=0, max_body=1000).start()
        try:
            reply, took = raw_exchange(capture.port, HEAD + b"Content-Length: 1001\r\n\r\n")
            assert reply.startswith(b"HTTP/1.1 400") and took < 3
        finally:
            capture.stop()

    @pytest.mark.parametrize("length", [b"-5", b"abc", b"1e3"])
    def test_a_bad_content_length_is_refused(self, server, length):
        reply, _ = raw_exchange(server.port, HEAD + b"Content-Length: " + length + b"\r\n\r\n")
        assert reply.startswith(b"HTTP/1.1 400")

    def test_a_stalled_body_is_dropped_after_the_timeout(self, tmp_path):
        capture = ipp.IppCapture(tmp_path, port=0, io_timeout=0.5).start()
        try:
            reply, took = raw_exchange(capture.port, HEAD + b"Content-Length: 1000\r\n\r\n" + b"x" * 10)
            assert b"<timed out>" not in reply and took < 4
        finally:
            capture.stop()

    def test_a_stalled_chunked_body_is_dropped_after_the_timeout(self, tmp_path):
        capture = ipp.IppCapture(tmp_path, port=0, io_timeout=0.5).start()
        try:
            reply, took = raw_exchange(capture.port, HEAD + b"Transfer-Encoding: chunked\r\n\r\n10\r\nabc")
            assert b"<timed out>" not in reply and took < 4
        finally:
            capture.stop()

    @pytest.mark.parametrize("size", [b"-1", b"-8000000000", b"zz", b"", b"FFFFFFFFF", b"100000000"])
    def test_a_bad_or_oversized_chunk_size_is_refused(self, server, size):
        reply, took = raw_exchange(server.port, HEAD + b"Transfer-Encoding: chunked\r\n\r\n" + size + b"\r\nabc\r\n")
        assert reply.startswith(b"HTTP/1.1 400") and took < 3

    def test_a_chunk_size_line_with_no_end_is_cut_off(self, server):
        reply, took = raw_exchange(server.port, HEAD + b"Transfer-Encoding: chunked\r\n\r\n" + b"a" * 5000)
        assert reply.startswith(b"HTTP/1.1 400") and took < 3

    def test_the_chunk_total_is_capped(self, tmp_path):
        capture = ipp.IppCapture(tmp_path, port=0, max_body=100).start()
        try:
            payload = HEAD + b"Transfer-Encoding: chunked\r\n\r\n" + (b"40\r\n" + b"x" * 64 + b"\r\n") * 2 + b"0\r\n\r\n"
            reply, _ = raw_exchange(capture.port, payload)
            assert reply.startswith(b"HTTP/1.1 400")
        finally:
            capture.stop()

    def test_a_truncated_text_with_language_gets_a_bad_request_reply(self, server):
        broken = attr(0x35, "job-name", b"\x00\x05ab")  # a 5 byte language, 2 bytes present
        reply = post(server, request(ipp.OP_PRINT_JOB, operation=[broken], body=b"x"))
        assert reply.code == ipp.STATUS_BAD_REQUEST
        assert not list(server.directory.glob("job-*.json"))
        short_text = attr(0x35, "job-name", struct.pack(">H", 0) + struct.pack(">H", 9) + b"ab")
        assert post(server, request(ipp.OP_PRINT_JOB, operation=[short_text])).code == ipp.STATUS_BAD_REQUEST
        with pytest.raises(ipp.IppError):
            ipp.parse_message(request(ipp.OP_PRINT_JOB, operation=[attr(0x35, "x", b"\x00")]))

    def test_a_wrong_sized_number_is_an_ipp_error_not_a_crash(self):
        bad = attr(0x33, "span", b"\x00\x00")  # a range value must be 8 bytes; it stays raw bytes
        assert ipp.parse_message(request(ipp.OP_VALIDATE_JOB, operation=[bad])).group(ipp.TAG_OPERATION)["span"]
        with pytest.raises(ipp.IppError):
            ipp.parse_message(struct.pack(">BBHI", 2, 0, 2, 1)[:6])


class TestJobStore:
    def jobs(self, capture, **extra):
        operation = [keyword("which-jobs", extra["which"])] if "which" in extra else []
        if "limit" in extra:
            operation.append(integer("limit", extra["limit"]))
        reply = post(capture, request(ipp.OP_GET_JOBS, operation=operation))
        return reply, [g[1]["job-id"][0] for g in reply.groups if g[0] == ipp.TAG_JOB]

    def test_get_jobs_honors_which_jobs_and_limit(self, server):
        for _ in range(3):
            post(server, request(ipp.OP_PRINT_JOB, job=JOB_ATTRIBUTES, body=b"x"))
        pending = post(server, request(ipp.OP_CREATE_JOB, job=JOB_ATTRIBUTES)).group(ipp.TAG_JOB)["job-id"][0]
        assert self.jobs(server)[1] == [1, 2, 3, 4]
        assert self.jobs(server, which="completed")[1] == [1, 2, 3]
        assert self.jobs(server, which="not-completed")[1] == [pending]
        assert self.jobs(server, limit=2)[1] == [1, 2]
        assert self.jobs(server, which="completed", limit=1)[1] == [1]
        assert self.jobs(server, which="sideways")[0].code == ipp.STATUS_ATTRIBUTES_NOT_SUPPORTED
        assert self.jobs(server, limit=0)[0].code == ipp.STATUS_BAD_REQUEST

    def test_memory_keeps_only_the_last_jobs_while_the_disk_keeps_all(self, tmp_path):
        capture = ipp.IppCapture(tmp_path, port=0, max_jobs=3).start()
        try:
            for _ in range(6):
                post(capture, request(ipp.OP_PRINT_JOB, job=JOB_ATTRIBUTES, body=b"x"))
            assert sorted(capture.records) == [4, 5, 6] and capture.documents == {}
            assert len(list(tmp_path.glob("job-*.json"))) == 6
            assert self.jobs(capture)[1] == [4, 5, 6]
        finally:
            capture.stop()

    def test_pending_documents_are_evicted_with_their_jobs(self, tmp_path):
        capture = ipp.IppCapture(tmp_path, port=0, max_jobs=2).start()
        try:
            for _ in range(5):
                post(capture, request(ipp.OP_CREATE_JOB, job=JOB_ATTRIBUTES))
            assert len(capture.records) == 2 and len(capture.documents) == 2
        finally:
            capture.stop()

    def test_a_document_cannot_grow_past_the_cap_or_be_sent_twice(self, tmp_path):
        capture = ipp.IppCapture(tmp_path, port=0, max_body=1000).start()
        try:
            job_id = post(capture, request(ipp.OP_CREATE_JOB, job=JOB_ATTRIBUTES)).group(ipp.TAG_JOB)["job-id"][0]
            more = [integer("job-id", job_id), attr(0x22, "last-document", b"\x00")]
            assert post(capture, request(ipp.OP_SEND_DOCUMENT, operation=more, body=b"x" * 600)).code == ipp.STATUS_OK
            assert post(capture, request(ipp.OP_SEND_DOCUMENT, operation=more, body=b"x" * 600)).code == ipp.STATUS_BAD_REQUEST
            last = [integer("job-id", job_id), attr(0x22, "last-document", b"\x01")]
            assert post(capture, request(ipp.OP_SEND_DOCUMENT, operation=last, body=b"y")).code == ipp.STATUS_OK
            assert post(capture, request(ipp.OP_SEND_DOCUMENT, operation=last, body=b"z")).code == ipp.STATUS_NOT_FOUND
        finally:
            capture.stop()


class TestTcpBadSenders:
    def wait_for(self, folder, name, seconds=5.0):
        deadline = time.time() + seconds
        while time.time() < deadline:
            if (folder / name).exists():
                return folder / name
            time.sleep(0.05)
        raise AssertionError(f"{name} not written")

    def test_an_endless_fast_sender_is_cut_at_the_byte_cap(self, tmp_path):
        capture = tcp_capture.TcpCapture(tmp_path, port=0, idle=5, max_bytes=1000, deadline=30).start()
        try:
            connection = socket.create_connection(("127.0.0.1", capture.port))
            try:
                connection.sendall(b"A" * 200_000)
            except OSError:
                pass  # the listener closed first
            job = self.wait_for(tmp_path, "job-0001.bin")
            assert job.stat().st_size == 1000
            assert "byte cap" in (tmp_path / "job-0001.cut").read_text()
            connection.close()
        finally:
            capture.stop()

    def test_a_slow_sender_that_never_stops_is_cut_at_the_deadline(self, tmp_path):
        capture = tcp_capture.TcpCapture(tmp_path, port=0, idle=2, max_bytes=10**6, deadline=0.6).start()
        stop = False
        connection = socket.create_connection(("127.0.0.1", capture.port))

        def drip():
            while not stop:
                try:
                    connection.sendall(b".")
                except OSError:
                    return
                time.sleep(0.1)

        thread = __import__("threading").Thread(target=drip, daemon=True)
        thread.start()
        try:
            started = time.monotonic()
            job = self.wait_for(tmp_path, "job-0001.bin", 4)
            assert time.monotonic() - started < 3 and 0 < job.stat().st_size < 50
            assert "deadline" in (tmp_path / "job-0001.cut").read_text()
        finally:
            stop = True
            connection.close()
            capture.stop()

    def test_a_job_under_both_limits_is_not_marked_cut(self, tmp_path):
        capture = tcp_capture.TcpCapture(tmp_path, port=0, idle=1, max_bytes=1000, deadline=5).start()
        try:
            with socket.create_connection(("127.0.0.1", capture.port)) as connection:
                connection.sendall(b"small job")
            assert self.wait_for(tmp_path, "job-0001.bin").read_bytes() == b"small job"
            assert not (tmp_path / "job-0001.cut").exists()
        finally:
            capture.stop()


class TestCutJobsAndCaps:
    def test_a_cut_tcp_job_is_not_complete(self, monkeypatch, tmp_path):
        monkeypatch.setattr(printer_lab, "_printer_port", lambda name: "PORT")
        monkeypatch.setattr(printer_lab, "_listening", lambda port: True)
        (tmp_path / "job-0001.bin").write_bytes(b"\x1bE\x1b&l1S text \x0c")
        state = {"kind": "tcp", "capture_dir": str(tmp_path), "port_name": "PORT", "port": 1}
        target = printer_lab.CaptureTarget("SpectraLabX", state, timeout=2)
        whole = target._decode(tmp_path / "job-0001.bin")
        assert whole.complete and printer_lab.row_status(whole, "long", True) == "PASS"
        (tmp_path / "job-0001.cut").write_text("the job was cut at the byte cap")
        cut = target._decode(tmp_path / "job-0001.bin")
        assert not cut.complete and any(n.startswith("cut:") for n in cut.notes)
        assert printer_lab.row_status(cut, "long", True) == "INCOMPLETE"

    def test_the_default_caps_hold_a_large_raster_job(self):
        assert ipp.MAX_BODY == tcp_capture.MAX_BYTES == 256 * 1024 * 1024
        assert ipp.READ_STEP == 64 * 1024


class TestIppSetupRollback:
    def test_a_queue_made_before_add_printer_threw_is_removed_with_its_port(self, monkeypatch, tmp_path):
        calls, state = [], {"made": False, "gone": False}
        guid_port = "WSD-8745ecf7-c31f-474e-aa39-3a2e2ea8db9d"

        def fake(command):
            calls.append(command)
            if command.startswith("Add-Printer "):
                state["made"] = True
                raise RuntimeError("Add-Printer threw after it made the queue")
            if command.startswith("Remove-Printer "):
                state["gone"] = True
            if "Count" in command:
                return "1" if state["made"] and not state["gone"] else "0"
            if "PortName" in command:
                return guid_port
            if command.startswith("Get-PrinterPort"):
                return guid_port if not any(c.startswith("Remove-PrinterPort") for c in calls) else ""
            return ""

        stopped = []
        monkeypatch.setattr(printer_lab, "_ps", fake)
        monkeypatch.setattr(printer_lab, "_is_admin", lambda: True)
        monkeypatch.setattr(printer_lab, "_listening", lambda port: False)
        monkeypatch.setattr(printer_lab, "start_listener", lambda *a: 4246)
        monkeypatch.setattr(printer_lab, "stop_listener", lambda s: stopped.append(s["pid"]))
        with pytest.raises(SystemExit, match="was undone"):
            printer_lab.setup_network("SpectraLabIpp", "ipp", None, tmp_path, True, 6310)
        assert any(c.startswith("Remove-Printer ") for c in calls)
        assert any(c.startswith("Remove-PrinterPort") and guid_port in c for c in calls)
        assert stopped == [4246] and printer_lab.read_state(tmp_path, "SpectraLabIpp") is None
        assert not (tmp_path / "SpectraLabIpp-capture").exists()

    def test_a_queue_on_a_port_that_is_not_a_lab_port_is_left_and_reported(self, monkeypatch, tmp_path):
        made = {"yes": False}

        def fake(command):
            if command.startswith("Add-Printer "):
                made["yes"] = True
                raise RuntimeError("threw")
            if "Count" in command:
                return "1" if made["yes"] else "0"
            if "PortName" in command:
                return "USB001"
            if command.startswith(("Remove-Printer", "Remove-PrinterPort")):
                pytest.fail("a command touched a port that is not a lab port: " + command)
            return ""

        monkeypatch.setattr(printer_lab, "_ps", fake)
        monkeypatch.setattr(printer_lab, "_is_admin", lambda: True)
        monkeypatch.setattr(printer_lab, "_listening", lambda port: False)
        monkeypatch.setattr(printer_lab, "start_listener", lambda *a: 4247)
        monkeypatch.setattr(printer_lab, "stop_listener", lambda s: None)
        with pytest.raises(SystemExit, match="could not be undone"):
            printer_lab.setup_network("SpectraLabIpp", "ipp", None, tmp_path, True, 6310)
