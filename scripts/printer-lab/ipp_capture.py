"""A small IPP printer on 127.0.0.1 that records every job it receives.

The Microsoft IPP Class Driver, the Universal Print Class Driver and the
Microsoft PWG Raster class driver print to a network printer. A lab printer on
this server shows what such a driver sends: the job attributes (`sides`,
`orientation-requested`, `media`, `copies`, `print-color-mode`) and the document.
Nothing is printed. The server answers like an idle printer that finishes each
job at once, so Windows treats the job as done.

Run it alone:

    python scripts/printer-lab/ipp_capture.py --dir <folder> --port 6310

Each finished job is two files in the folder: `job-0001.json` (the attributes)
and `job-0001.doc` (the document bytes). `requests.jsonl` logs every request.
Python standard library only.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import struct
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

# --- operations and status codes ----------------------------------------------

OP_PRINT_JOB = 0x0002
OP_VALIDATE_JOB = 0x0004
OP_CREATE_JOB = 0x0005
OP_SEND_DOCUMENT = 0x0006
OP_CANCEL_JOB = 0x0008
OP_GET_JOB_ATTRIBUTES = 0x0009
OP_GET_JOBS = 0x000A
OP_GET_PRINTER_ATTRIBUTES = 0x000B
OPERATION_NAMES = {
    OP_PRINT_JOB: "Print-Job",
    OP_VALIDATE_JOB: "Validate-Job",
    OP_CREATE_JOB: "Create-Job",
    OP_SEND_DOCUMENT: "Send-Document",
    OP_CANCEL_JOB: "Cancel-Job",
    OP_GET_JOB_ATTRIBUTES: "Get-Job-Attributes",
    OP_GET_JOBS: "Get-Jobs",
    OP_GET_PRINTER_ATTRIBUTES: "Get-Printer-Attributes",
}
SUPPORTED_OPERATIONS = sorted(OPERATION_NAMES)

STATUS_OK = 0x0000
STATUS_BAD_REQUEST = 0x0400
STATUS_NOT_FOUND = 0x0406
STATUS_ATTRIBUTES_NOT_SUPPORTED = 0x040B
STATUS_OPERATION_NOT_SUPPORTED = 0x0501
STATUS_VERSION_NOT_SUPPORTED = 0x0503

# --- value and group tags -----------------------------------------------------

TAG_OPERATION, TAG_JOB, TAG_END, TAG_PRINTER, TAG_UNSUPPORTED = 0x01, 0x02, 0x03, 0x04, 0x05
INTEGER, BOOLEAN, ENUM = 0x21, 0x22, 0x23
OCTET, DATETIME, RESOLUTION, RANGE = 0x30, 0x31, 0x32, 0x33
BEG_COLLECTION, TEXT_LANG, NAME_LANG, END_COLLECTION = 0x34, 0x35, 0x36, 0x37
TEXT, NAME, KEYWORD, URI, URI_SCHEME, CHARSET, NATURAL_LANG, MIME_TYPE, MEMBER_NAME = (
    0x41, 0x42, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4A,
)
_STRING_TAGS = {TEXT, NAME, KEYWORD, URI, URI_SCHEME, CHARSET, NATURAL_LANG, MIME_TYPE, MEMBER_NAME}

JOB_STATE_COMPLETED = 9
MAX_BODY = 256 * 1024 * 1024  # the largest request body (or document) the server accepts
MAX_JOBS = 50  # finished and pending jobs kept in memory; older ones stay on disk only
IO_TIMEOUT_S = 30.0  # per socket read; a stalled client is dropped
READ_STEP = 64 * 1024
MAX_LINE = 1024  # an HTTP chunk-size or trailer line


class IppError(ValueError):
    """The bytes are not a valid IPP message."""


class Message:
    """A parsed IPP request or response.

    `groups` is a list of (group tag, attributes); each attribute maps a name to
    its list of values. A value is an int, bool, str, bytes, a tuple (range or
    resolution), None (an out-of-band value) or a dict (a collection)."""

    def __init__(self, version: tuple[int, int], code: int, request_id: int, groups, body: bytes = b"") -> None:
        self.version = version
        self.code = code
        self.request_id = request_id
        self.groups = groups
        self.body = body

    def group(self, tag: int) -> dict:
        """The first group with this tag (an empty dict when there is none)."""
        for group_tag, attributes in self.groups:
            if group_tag == tag:
                return attributes
        return {}

    def first(self, name: str, tag: int = TAG_OPERATION, default=None):
        values = self.group(tag).get(name)
        return values[0] if values else default


# --- parser -------------------------------------------------------------------


class _Reader:
    def __init__(self, data: bytes, pos: int = 0) -> None:
        self.data, self.pos = data, pos

    def take(self, count: int) -> bytes:
        end = self.pos + count
        if count < 0 or end > len(self.data):
            raise IppError("the message ends inside a value")
        chunk = self.data[self.pos:end]
        self.pos = end
        return chunk

    def u8(self) -> int:
        return self.take(1)[0]

    def u16(self) -> int:
        return struct.unpack(">H", self.take(2))[0]


def _decode_value(tag: int, raw: bytes):
    if tag in (INTEGER, ENUM):
        return struct.unpack(">i", raw)[0] if len(raw) == 4 else int.from_bytes(raw, "big", signed=True)
    if tag == BOOLEAN:
        return bool(raw and raw[0])
    if tag in _STRING_TAGS:
        return raw.decode("utf-8", "replace")
    if tag in (TEXT_LANG, NAME_LANG):
        if len(raw) < 4:
            raise IppError("a text with language is too short")
        try:
            lang_len = struct.unpack(">H", raw[:2])[0]
            start = 2 + lang_len
            text_len = struct.unpack(">H", raw[start:start + 2])[0]
        except struct.error:
            raise IppError("a text with language is cut short") from None
        if start + 2 + text_len > len(raw):
            raise IppError("a text with language is cut short")
        return raw[start + 2:start + 2 + text_len].decode("utf-8", "replace")
    if tag == RANGE and len(raw) == 8:
        return struct.unpack(">ii", raw)
    if tag == RESOLUTION and len(raw) == 9:
        return struct.unpack(">iib", raw)
    if tag == DATETIME and len(raw) == 11:
        y, mo, d, h, mi, s, ds = struct.unpack(">HBBBBBB", raw[:9])
        return f"{y:04d}-{mo:02d}-{d:02d}T{h:02d}:{mi:02d}:{s:02d}.{ds}{raw[9:10].decode('latin-1')}{raw[10]:02d}"
    if tag in (0x10, 0x12, 0x13, 0x15):
        return None
    return raw


def _read_collection(reader: _Reader, depth: int) -> dict:
    """The members of a collection, after its begCollection header."""
    if depth > 8:
        raise IppError("collections are nested too deep")
    members: dict = {}
    while True:
        tag = reader.u8()
        name_len = reader.u16()
        name = reader.take(name_len)
        if tag == END_COLLECTION:
            reader.take(reader.u16())
            return members
        if tag != MEMBER_NAME or name_len:
            raise IppError("a collection holds something other than a member name")
        member = reader.take(reader.u16()).decode("utf-8", "replace")
        values: list = []
        while True:
            peek = reader.data[reader.pos] if reader.pos < len(reader.data) else None
            if peek in (None, MEMBER_NAME, END_COLLECTION):
                break
            vtag = reader.u8()
            if reader.u16():
                raise IppError("a collection value has a name")
            raw = reader.take(reader.u16())
            values.append(_read_collection(reader, depth + 1) if vtag == BEG_COLLECTION else _decode_value(vtag, raw))
        members[member] = values


def parse_message(data: bytes) -> Message:
    """Parse an IPP message. Raises IppError for anything malformed."""
    try:
        return _parse_message(data)
    except struct.error:
        raise IppError("a value has the wrong size") from None


def _parse_message(data: bytes) -> Message:
    reader = _Reader(data)
    major, minor, code, request_id = struct.unpack(">BBHI", reader.take(8))
    groups: list = []
    current: dict | None = None
    last: str | None = None
    while True:
        tag = reader.u8()
        if tag == TAG_END:
            break
        if tag <= 0x0F:
            current, last = {}, None
            groups.append((tag, current))
            continue
        if current is None:
            raise IppError("an attribute comes before any group")
        name = reader.take(reader.u16()).decode("utf-8", "replace")
        raw = reader.take(reader.u16())
        value = _read_collection(reader, 1) if tag == BEG_COLLECTION else _decode_value(tag, raw)
        if name:
            current.setdefault(name, []).append(value)
            last = name
        elif last is None:
            raise IppError("an additional value has no attribute")
        else:
            current[last].append(value)
    return Message((major, minor), code, request_id, groups, data[reader.pos:])


# --- encoder ------------------------------------------------------------------


def _encode_value(tag: int, value) -> bytes:
    if tag in (INTEGER, ENUM):
        return struct.pack(">i", value)
    if tag == BOOLEAN:
        return b"\x01" if value else b"\x00"
    if tag == RANGE:
        return struct.pack(">ii", *value)
    if tag == RESOLUTION:
        return struct.pack(">iib", *value)
    if tag == DATETIME:
        return value
    if tag in (0x10, 0x12, 0x13):
        return b""
    return value if isinstance(value, bytes) else str(value).encode("utf-8")


def _encode_attribute(name: str, tag: int, values: list) -> bytes:
    out = b""
    for index, value in enumerate(values):
        label = name.encode("utf-8") if index == 0 else b""
        if tag == BEG_COLLECTION:
            out += bytes([tag]) + struct.pack(">H", len(label)) + label + struct.pack(">H", 0)
            for member, (member_tag, member_values) in value.items():
                key = member.encode("utf-8")
                out += bytes([MEMBER_NAME]) + b"\x00\x00" + struct.pack(">H", len(key)) + key
                out += _encode_attribute("", member_tag, member_values)
            out += bytes([END_COLLECTION]) + b"\x00\x00\x00\x00"
            continue
        raw = _encode_value(tag, value)
        out += bytes([tag]) + struct.pack(">H", len(label)) + label + struct.pack(">H", len(raw)) + raw
    return out


def encode_message(version: tuple[int, int], code: int, request_id: int, groups, body: bytes = b"") -> bytes:
    """Build an IPP message. `groups` is a list of (group tag, attributes); each
    attribute is (name, value tag, [values]). A collection value is a dict of
    member name -> (value tag, [values])."""
    out = struct.pack(">BBHI", version[0], version[1], code, request_id)
    for group_tag, attributes in groups:
        out += bytes([group_tag])
        for name, tag, values in attributes:
            out += _encode_attribute(name, tag, values)
    return out + bytes([TAG_END]) + body


def _media_collection(width: int, height: int) -> dict:
    """A media-col value: the sheet size, the margins and the source."""
    return {
        "media-size": (BEG_COLLECTION, [{"x-dimension": (INTEGER, [width]), "y-dimension": (INTEGER, [height])}]),
        "media-bottom-margin": (INTEGER, [423]),
        "media-left-margin": (INTEGER, [423]),
        "media-right-margin": (INTEGER, [423]),
        "media-top-margin": (INTEGER, [423]),
        "media-source": (KEYWORD, ["auto"]),
        "media-type": (KEYWORD, ["stationery"]),
    }


def _size_collection(width: int, height: int) -> dict:
    return {"x-dimension": (INTEGER, [width]), "y-dimension": (INTEGER, [height])}


_MEDIA = (("iso_a4_210x297mm", 21000, 29700), ("na_letter_8.5x11in", 21590, 27940))


DEFAULT_FORMATS = ("application/pdf", "image/pwg-raster", "image/urf")


def printer_attributes(
    uri: str, sides_default: str = "one-sided", name: str = "SpectraLab IPP Capture", formats=DEFAULT_FORMATS,
) -> list:
    """Everything the printer reports, as (name, value tag, values)."""
    a4 = _MEDIA[0]
    return [
        ("printer-uri-supported", URI, [uri]),
        ("uri-security-supported", KEYWORD, ["none"]),
        ("uri-authentication-supported", KEYWORD, ["none"]),
        ("printer-name", NAME, [name]),
        ("printer-info", TEXT, ["Spectra PDF printer lab IPP capture server"]),
        ("printer-make-and-model", TEXT, ["Spectra Lab IPP Capture"]),
        ("printer-state", ENUM, [3]),
        ("printer-state-reasons", KEYWORD, ["none"]),
        ("printer-is-accepting-jobs", BOOLEAN, [True]),
        ("queued-job-count", INTEGER, [0]),
        ("ipp-versions-supported", KEYWORD, ["1.0", "1.1", "2.0"]),
        ("ipp-features-supported", KEYWORD, ["ipp-everywhere"]),
        ("printer-device-id", TEXT, ["MFG:Spectra;MDL:Lab IPP Capture;CMD:PDF,PWGRaster,URF;"]),
        ("printer-more-info", URI, [uri]),
        ("operations-supported", ENUM, SUPPORTED_OPERATIONS),
        ("charset-configured", CHARSET, ["utf-8"]),
        ("charset-supported", CHARSET, ["utf-8"]),
        ("natural-language-configured", NATURAL_LANG, ["en"]),
        ("generated-natural-language-supported", NATURAL_LANG, ["en"]),
        ("document-format-default", MIME_TYPE, ["application/pdf"]),
        ("document-format-supported", MIME_TYPE, list(formats)),
        ("document-format-preferred", MIME_TYPE, ["application/pdf"]),
        ("pdf-versions-supported", KEYWORD, ["adobe-1.4"]),
        ("compression-supported", KEYWORD, ["none"]),
        ("multiple-document-jobs-supported", BOOLEAN, [False]),
        ("sides-supported", KEYWORD, ["one-sided", "two-sided-long-edge", "two-sided-short-edge"]),
        ("sides-default", KEYWORD, [sides_default]),
        ("media-supported", KEYWORD, [m[0] for m in _MEDIA]),
        ("media-default", KEYWORD, [a4[0]]),
        ("media-ready", KEYWORD, [m[0] for m in _MEDIA]),
        ("media-size-supported", BEG_COLLECTION, [_size_collection(m[1], m[2]) for m in _MEDIA]),
        ("media-col-default", BEG_COLLECTION, [_media_collection(a4[1], a4[2])]),
        ("media-col-ready", BEG_COLLECTION, [_media_collection(a4[1], a4[2])]),
        ("media-col-database", BEG_COLLECTION, [_media_collection(m[1], m[2]) for m in _MEDIA]),
        ("media-col-supported", KEYWORD, [
            "media-bottom-margin", "media-left-margin", "media-right-margin", "media-size",
            "media-source", "media-top-margin", "media-type",
        ]),
        ("media-bottom-margin-supported", INTEGER, [0, 423]),
        ("media-left-margin-supported", INTEGER, [0, 423]),
        ("media-right-margin-supported", INTEGER, [0, 423]),
        ("media-top-margin-supported", INTEGER, [0, 423]),
        ("media-source-supported", KEYWORD, ["auto", "main"]),
        ("media-source-default", KEYWORD, ["auto"]),
        ("output-bin-supported", KEYWORD, ["face-down"]),
        ("output-bin-default", KEYWORD, ["face-down"]),
        ("print-scaling-supported", KEYWORD, ["auto", "fill", "fit", "none"]),
        ("print-scaling-default", KEYWORD, ["auto"]),
        ("pdf-fit-to-page-supported", BOOLEAN, [False]),
        ("pdf-fit-to-page-default", BOOLEAN, [False]),
        ("multiple-document-handling-supported", KEYWORD, [
            "separate-documents-uncollated-copies", "separate-documents-collated-copies",
        ]),
        ("multiple-document-handling-default", KEYWORD, ["separate-documents-collated-copies"]),
        ("presentation-direction-number-up-supported", KEYWORD, ["tobottom-toright"]),
        ("presentation-direction-number-up-default", KEYWORD, ["tobottom-toright"]),
        ("job-impressions-supported", RANGE, [(1, 10000)]),
        ("job-media-sheets-supported", RANGE, [(1, 10000)]),
        ("job-pages-per-set-supported", BOOLEAN, [False]),
        ("job-password-supported", INTEGER, [4]),
        ("job-password-encryption-supported", KEYWORD, ["none"]),
        ("document-format-details-supported", KEYWORD, ["document-format", "document-source-application-name"]),
        ("client-info-supported", KEYWORD, ["client-name", "client-type", "client-version"]),
        ("printer-location", TEXT, ["Spectra PDF printer lab"]),
        ("printer-dns-sd-name", NAME, [name]),
        ("printer-firmware-name", NAME, ["spectra-lab"]),
        ("printer-firmware-string-version", TEXT, ["1.0"]),
        ("printer-strings-languages-supported", NATURAL_LANG, ["en"]),
        ("mopria-certified", TEXT, ["1.3"]),
        ("media-type-supported", KEYWORD, ["stationery"]),
        ("orientation-requested-supported", ENUM, [3, 4, 5, 6]),
        ("orientation-requested-default", ENUM, [3]),
        ("copies-supported", RANGE, [(1, 99)]),
        ("copies-default", INTEGER, [1]),
        ("print-color-mode-supported", KEYWORD, ["color", "monochrome"]),
        ("print-color-mode-default", KEYWORD, ["color"]),
        ("color-supported", BOOLEAN, [True]),
        ("print-quality-supported", ENUM, [3, 4, 5]),
        ("print-quality-default", ENUM, [4]),
        ("printer-resolution-supported", RESOLUTION, [(600, 600, 3)]),
        ("printer-resolution-default", RESOLUTION, [(600, 600, 3)]),
        ("finishings-supported", ENUM, [3]),
        ("finishings-default", ENUM, [3]),
        ("number-up-supported", INTEGER, [1]),
        ("number-up-default", INTEGER, [1]),
        ("pages-per-minute", INTEGER, [30]),
        ("pages-per-minute-color", INTEGER, [30]),
        ("job-creation-attributes-supported", KEYWORD, [
            "copies", "media", "media-col", "orientation-requested", "print-color-mode",
            "print-quality", "printer-resolution", "sides",
        ]),
        ("pwg-raster-document-resolution-supported", RESOLUTION, [(300, 300, 3)]),
        ("pwg-raster-document-type-supported", KEYWORD, ["sgray_8", "srgb_8"]),
        ("pwg-raster-document-sheet-back", KEYWORD, ["normal"]),
        ("urf-supported", KEYWORD, ["V1.4", "CP1", "W8", "SRGB24", "RS300", "DM1"]),
        ("printer-uuid", URI, ["urn:uuid:5c7ab4a1-5d6c-4f2e-9b6f-2a1d5f0e6c11"]),
        ("printer-up-time", INTEGER, [int(time.time()) & 0x7FFFFFFF]),
    ]


# --- job store ----------------------------------------------------------------

_JOB_ATTRIBUTES = ("sides", "orientation-requested", "media", "media-col", "copies", "print-color-mode")


def _plain(value):
    """JSON-safe form of a parsed value."""
    if isinstance(value, bytes):
        return value.hex()
    if isinstance(value, dict):
        return {k: [_plain(v) for v in vs] for k, vs in value.items()}
    if isinstance(value, tuple):
        return list(value)
    return value


def _plain_group(group: dict) -> dict:
    return {name: [_plain(v) for v in values] for name, values in group.items()}


def _media_name(job: dict) -> str | None:
    """The media a job asks for: `media`, else the size or name inside `media-col`."""
    media = job.get("media")
    if media:
        return str(media[0])
    col = job.get("media-col")
    if col and isinstance(col[0], dict):
        size = col[0].get("media-size", [{}])[0]
        if isinstance(size, dict) and "x-dimension" in size and "y-dimension" in size:
            return f"{size['x-dimension'][0]}x{size['y-dimension'][0]} (1/100 mm)"
        name = col[0].get("media-size-name")
        if name:
            return str(name[0])
    return None


def summarize(record: dict) -> dict:
    """The attributes the lab compares, one value each (None when the job names none)."""
    job = record.get("job_attributes", {})
    operation = record.get("operation_attributes", {})

    def one(name, source=job):
        values = source.get(name)
        return values[0] if values else None

    return {
        "sides": one("sides"),
        "orientation-requested": one("orientation-requested"),
        "media": _media_name(job),
        "copies": one("copies"),
        "print-color-mode": one("print-color-mode"),
        "document-format": one("document-format", operation),
    }


class _Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = False  # on Windows SO_REUSEADDR lets a second process bind the same port

    def handle_error(self, request, client_address) -> None:
        """A client that drops the connection is normal for a print client; show any other error."""
        if not isinstance(sys.exc_info()[1], ConnectionError):
            super().handle_error(request, client_address)


class IppCapture:
    """The server:`start()` it, point a printer at `url`, read `jobs` or the folder."""

    def __init__(
        self, directory: Path, host: str = "127.0.0.1", port: int = 0, sides_default: str = "one-sided",
        printer_name: str = "SpectraLab IPP Capture", formats=DEFAULT_FORMATS,
        io_timeout: float = IO_TIMEOUT_S, max_body: int = MAX_BODY, max_jobs: int = MAX_JOBS,
    ) -> None:
        if host != "127.0.0.1":
            raise ValueError("the capture server binds 127.0.0.1 only")
        self.max_body, self.max_jobs = max_body, max_jobs
        self.printer_name = printer_name
        self.formats = tuple(formats)
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True)
        self.sides_default = sides_default
        self.lock = threading.Lock()
        self.records: dict[int, dict] = {}
        self.documents: dict[int, bytearray] = {}
        self.next_job = 1
        handler = type("Handler", (_Handler,), {"capture": self, "timeout": io_timeout})
        self.httpd = _Server((host, port), handler)
        self.thread: threading.Thread | None = None

    @property
    def port(self) -> int:
        return self.httpd.server_address[1]

    @property
    def url(self) -> str:
        return f"http://{self.httpd.server_address[0]}:{self.port}/ipp/print"

    def start(self) -> "IppCapture":
        self.thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)
        self.thread.start()
        return self

    def stop(self) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()

    # -- jobs
    def _new_job(self, request: Message) -> dict:
        with self.lock:
            job_id = self.next_job
            self.next_job += 1
        record = {
            "job-id": job_id,
            "created_by": OPERATION_NAMES.get(request.code, hex(request.code)),
            "operation_attributes": _plain_group(request.group(TAG_OPERATION)),
            "job_attributes": _plain_group(request.group(TAG_JOB)),
            "state": "pending",
            "document_file": None,
            "document_bytes": 0,
        }
        with self.lock:
            self.records[job_id] = record
            self.documents[job_id] = bytearray()
            while len(self.records) > self.max_jobs:  # the files on disk stay; only memory is bounded
                oldest = next(iter(self.records))
                del self.records[oldest]
                self.documents.pop(oldest, None)
        return record

    def _finish(self, record: dict, document: bytes) -> None:
        """Save the document, then the record (the record's file marks the job as finished)."""
        job_id = record["job-id"]
        doc_path = self.directory / f"job-{job_id:04d}.doc"
        doc_path.write_bytes(document)
        record.update(state="completed", document_file=doc_path.name, document_bytes=len(document))
        record["summary"] = summarize(record)
        self.documents.pop(job_id, None)
        temp = self.directory / f"job-{job_id:04d}.json.part"
        temp.write_text(json.dumps(record, indent=2), encoding="utf-8")
        os.replace(temp, self.directory / f"job-{job_id:04d}.json")

    def log(self, request: Message, status: int) -> None:
        entry = {
            "time": time.strftime("%H:%M:%S"),
            "operation": OPERATION_NAMES.get(request.code, hex(request.code)),
            "version": f"{request.version[0]}.{request.version[1]}",
            "status": hex(status),
            "operation_attributes": _plain_group(request.group(TAG_OPERATION)),
            "job_attributes": _plain_group(request.group(TAG_JOB)),
            "body_bytes": len(request.body),
        }
        with self.lock, (self.directory / "requests.jsonl").open("a", encoding="utf-8") as handle:
            handle.write(json.dumps(entry) + "\n")

    # -- one request
    def handle(self, request: Message, request_uri: str) -> tuple[int, list, int]:
        """The response for one request: (status, groups, job id or 0)."""
        code = request.code
        printer_uri = request.first("printer-uri") or request_uri
        if code == OP_GET_PRINTER_ATTRIBUTES:
            return STATUS_OK, [(TAG_PRINTER, self._filtered(request, printer_uri))], 0
        if code == OP_VALIDATE_JOB:
            return STATUS_OK, [], 0
        if code in (OP_PRINT_JOB, OP_CREATE_JOB):
            record = self._new_job(request)
            if code == OP_PRINT_JOB:
                self._finish(record, request.body)
            return STATUS_OK, [(TAG_JOB, self._job_attributes(record, printer_uri))], record["job-id"]
        if code == OP_SEND_DOCUMENT:
            record = self._job_of(request)
            if record is None:
                return STATUS_NOT_FOUND, [], 0
            buffer = self.documents.get(record["job-id"])
            if buffer is None or record["state"] == "completed":
                return STATUS_NOT_FOUND, [], 0  # the document of this job is already complete
            if len(buffer) + len(request.body) > self.max_body:
                return STATUS_BAD_REQUEST, [], 0
            buffer.extend(request.body)
            for name, values in request.group(TAG_OPERATION).items():
                if name in ("document-format", "document-name"):
                    record["operation_attributes"][name] = _plain_group({name: values})[name]
            if request.first("last-document", default=True):
                self._finish(record, bytes(buffer))
            return STATUS_OK, [(TAG_JOB, self._job_attributes(record, printer_uri))], record["job-id"]
        if code == OP_GET_JOB_ATTRIBUTES:
            record = self._job_of(request)
            if record is None:
                return STATUS_NOT_FOUND, [], 0
            return STATUS_OK, [(TAG_JOB, self._job_attributes(record, printer_uri))], record["job-id"]
        if code == OP_GET_JOBS:
            which = request.first("which-jobs", default="all")
            if which not in ("all", "completed", "not-completed"):
                return STATUS_ATTRIBUTES_NOT_SUPPORTED, [], 0
            limit = request.first("limit")
            if limit is not None and (not isinstance(limit, int) or limit < 1):
                return STATUS_BAD_REQUEST, [], 0
            with self.lock:
                records = list(self.records.values())
            if which != "all":  # no which-jobs means every job here (RFC 8011 says not-completed)
                records = [r for r in records if (r["state"] == "completed") == (which == "completed")]
            groups = [(TAG_JOB, self._job_attributes(r, printer_uri)) for r in records[:limit]]
            return STATUS_OK, groups, 0
        if code == OP_CANCEL_JOB:
            return (STATUS_OK, [], 0) if self._job_of(request) else (STATUS_NOT_FOUND, [], 0)
        return STATUS_OPERATION_NOT_SUPPORTED, [], 0

    def _job_of(self, request: Message) -> dict | None:
        job_id = request.first("job-id")
        if job_id is None:
            uri = request.first("job-uri") or ""
            tail = uri.rsplit("/", 1)[-1]
            job_id = int(tail) if tail.isdigit() else None
        return self.records.get(job_id)

    def _job_attributes(self, record: dict, printer_uri: str) -> list:
        done = record["state"] == "completed"
        base = printer_uri.rstrip("/")
        return [
            ("job-id", INTEGER, [record["job-id"]]),
            ("job-uri", URI, [f"{base}/{record['job-id']}"]),
            ("job-printer-uri", URI, [printer_uri]),
            ("job-state", ENUM, [JOB_STATE_COMPLETED if done else 3]),
            ("job-state-reasons", KEYWORD, ["job-completed-successfully" if done else "none"]),
            ("job-impressions-completed", INTEGER, [0]),
            ("number-of-documents", INTEGER, [1 if done else 0]),
        ]

    def _filtered(self, request: Message, uri: str) -> list:
        attributes = printer_attributes(uri, self.sides_default, self.printer_name, self.formats)
        wanted = set(request.group(TAG_OPERATION).get("requested-attributes", []))
        groups = {"all", "printer-description", "job-template", "media-col-database"}
        if not wanted or wanted & groups:
            return attributes
        return [attribute for attribute in attributes if attribute[0] in wanted]


# --- HTTP ---------------------------------------------------------------------


class _Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    capture: IppCapture

    def log_message(self, format, *args) -> None:  # noqa: A002
        pass

    def _line(self) -> bytes:
        """One short line; a longer line or a closed connection is an error."""
        line = self.rfile.readline(MAX_LINE + 1)
        if not line.endswith(b"\n"):
            raise IppError("a chunk header line is too long or the connection ended")
        return line

    def _read_exact(self, count: int) -> bytes:
        """`count` bytes in 64 KB steps, so a false length allocates nothing up front."""
        out = bytearray()
        while len(out) < count:
            piece = self.rfile.read(min(READ_STEP, count - len(out)))
            if not piece:
                raise IppError("the connection ended before the body was complete")
            out.extend(piece)
        return bytes(out)

    def _read_body(self) -> bytes:
        limit = self.capture.max_body
        if "chunked" in self.headers.get("Transfer-Encoding", "").lower():
            body = bytearray()
            while True:
                size_text = self._line().split(b";")[0].strip()
                if not re.fullmatch(rb"[0-9a-fA-F]{1,8}", size_text):
                    raise IppError("a chunk size is not a plain hexadecimal number")
                size = int(size_text, 16)
                if size == 0:
                    for _ in range(100):  # trailer lines
                        if not self._line().strip():
                            return bytes(body)
                    raise IppError("too many trailer lines")
                if len(body) + size > limit:
                    raise IppError("the request is larger than the lab accepts")
                body.extend(self._read_exact(size))
                if self._line().strip():
                    raise IppError("a chunk does not end with a line break")
        text = (self.headers.get("Content-Length") or "0").strip()
        if not text.isdigit():
            raise IppError("the Content-Length is not a number")
        length = int(text)
        if length > limit:
            raise IppError("the request is larger than the lab accepts")
        return self._read_exact(length)

    def _send(self, status: int, body: bytes, content_type: str) -> None:
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802
        self._send(200, b"Spectra PDF printer lab IPP capture server\n", "text/plain")

    def do_POST(self) -> None:  # noqa: N802
        try:
            data = self._read_body()
        except (IppError, ValueError):
            self.close_connection = True
            self._send(400, b"bad request\n", "text/plain")
            return
        except OSError:  # the read timed out or the client left: nothing to answer
            self.close_connection = True
            return
        host = self.headers.get("Host", "127.0.0.1")
        request_uri = f"http://{host}{self.path}"
        try:
            request = parse_message(data)
        except IppError:
            body = encode_message((1, 1), STATUS_BAD_REQUEST, 1, [(TAG_OPERATION, _operation_attributes("bad-request"))])
            self._send(200, body, "application/ipp")
            return
        if request.version[0] not in (1, 2):
            status, groups, job = STATUS_VERSION_NOT_SUPPORTED, [], 0
        else:
            status, groups, job = self.capture.handle(request, request_uri)
        self.capture.log(request, status)
        response_version = request.version if request.version[0] in (1, 2) else (1, 1)
        message = _operation_attributes("successful-ok" if status == STATUS_OK else "error")
        body = encode_message(response_version, status, request.request_id, [(TAG_OPERATION, message)] + groups)
        self._send(200, body, "application/ipp")


def _operation_attributes(message: str) -> list:
    return [
        ("attributes-charset", CHARSET, ["utf-8"]),
        ("attributes-natural-language", NATURAL_LANG, ["en"]),
        ("status-message", TEXT, [message]),
    ]


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--dir", type=Path, required=True)
    parser.add_argument("--port", type=int, default=6310)
    parser.add_argument("--sides-default", default="one-sided")
    parser.add_argument("--printer-name", default="SpectraLab IPP Capture")
    parser.add_argument("--document-formats", default=",".join(DEFAULT_FORMATS),
                        help="the document-format-supported list, comma separated")
    args = parser.parse_args(argv)
    capture = IppCapture(args.dir, "127.0.0.1", args.port, args.sides_default, args.printer_name,
                          [f for f in args.document_formats.split(",") if f])
    print(f"IPP capture listening on {capture.url}", flush=True)
    try:
        capture.httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
