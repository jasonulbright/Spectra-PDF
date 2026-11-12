"""Read the duplex setting out of the bytes a printer driver wrote.

A driver on a file port writes the job it would send to the printer. This
module reports what that job says about two-sided printing, and nothing it
cannot read. Every decoder returns the raw value it found next to the paper
edge it means; a job whose language is not decoded here is reported as
undecodable, never guessed.

The paper edge is "simplex", "long" or "short". PCL 5, the XPS print ticket, the
IPP `sides` attribute, PWG raster and URF name the edge of the paper. PCL XL and PostScript name the binding against the
page, so the edge also needs the page orientation, which is decoded with it.
"""

from __future__ import annotations

import io
import re
import struct
import zipfile
import zlib
from dataclasses import dataclass, field

SIMPLEX, LONG, SHORT = "simplex", "long", "short"


@dataclass
class Source:
    """One place in the job that states the duplex mode."""

    name: str
    raw: str
    edge: str | None


@dataclass
class Decoded:
    language: str
    sources: list[Source] = field(default_factory=list)
    orientation: str | None = None
    pages: int | None = None
    complete: bool = True
    notes: list[str] = field(default_factory=list)

    def edges(self) -> set[str]:
        return {s.edge for s in self.sources if s.edge}

    @property
    def decodable(self) -> bool:
        return bool(self.edges())

    def summary(self) -> str:
        if not self.decodable:
            return f"undecodable ({self.language})"
        edges = self.edges()
        text = "/".join(sorted(edges))
        return text if len(edges) == 1 else f"CONFLICT {text}"


# --- PJL -------------------------------------------------------------------

_UEL = b"\x1b%-12345X"


def _pjl_lines(data: bytes) -> tuple[list[str], int]:
    """The @PJL lines at the start of the job, and the offset after them."""
    if not data.startswith(_UEL):
        return [], 0
    lines: list[str] = []
    pos = len(_UEL)
    while True:
        end = data.find(b"\n", pos)
        if end == -1:
            break
        line = data[pos:end].decode("latin-1").strip()
        if not line.startswith("@PJL"):
            break
        lines.append(line)
        pos = end + 1
        if line.upper().startswith("@PJL ENTER LANGUAGE"):
            break
    return lines, pos


def _pjl_duplex(lines: list[str]) -> list[Source]:
    duplex = binding = None
    for line in lines:
        m = re.match(r"@PJL\s+SET\s+DUPLEX\s*=\s*(\w+)", line, re.I)
        if m:
            duplex = m.group(1).upper()
        m = re.match(r"@PJL\s+SET\s+BINDING\s*=\s*(\w+)", line, re.I)
        if m:
            binding = m.group(1).upper()
    if duplex is None and binding is None:
        return []
    if duplex == "OFF":
        return [Source("PJL", f"DUPLEX={duplex}", SIMPLEX)]
    edge = {"LONGEDGE": LONG, "SHORTEDGE": SHORT}.get(binding or "")
    if duplex == "ON" and edge:
        return [Source("PJL", f"DUPLEX={duplex} BINDING={binding}", edge)]
    return [Source("PJL", f"DUPLEX={duplex} BINDING={binding}", None)]


# --- PCL 5 -----------------------------------------------------------------


def _decode_pcl5(data: bytes) -> Decoded:
    out = Decoded("PCL")
    names = {0: SIMPLEX, 1: LONG, 2: SHORT}
    for m in re.finditer(rb"\x1b&l(\d+)S", data):
        value = int(m.group(1))
        out.sources.append(Source("PCL &l#S", f"&l{value}S", names.get(value)))
    orient = {int(m.group(1)) for m in re.finditer(rb"\x1b&l(\d+)O", data)}
    if orient:
        out.orientation = ",".join("landscape" if v in (1, 3) else "portrait" for v in sorted(orient))
    out.pages = len(re.findall(rb"\x0c", data)) or None
    return out


# --- PCL XL ----------------------------------------------------------------

_XL_SCALAR = {0xC0: 1, 0xC1: 2, 0xC2: 4, 0xC3: 2, 0xC4: 4, 0xC5: 4}
_ATTR_ORIENTATION, _ATTR_SIMPLEX_MODE, _ATTR_DUPLEX_MODE = 0x28, 0x34, 0x35
_XL_BEGIN_PAGE = 0x43
_XL_PORTRAIT, _XL_LANDSCAPE = {0, 2}, {1, 3}


def paper_edge(binding: int, orientation: int | None) -> str | None:
    """The paper edge a PCL XL binding names, from the page orientation.

    Vertical binding (1) is the left edge of the page: the long edge of a
    portrait sheet and the short edge of a landscape one."""
    if orientation in _XL_PORTRAIT:
        return {1: LONG, 0: SHORT}.get(binding)
    if orientation in _XL_LANDSCAPE:
        return {1: SHORT, 0: LONG}.get(binding)
    return None


def _decode_pclxl(data: bytes) -> Decoded:
    out = Decoded("PCL XL")
    start = data.find(b") HP-PCL XL")
    if start == -1:
        out.notes.append("big-endian or ASCII PCL XL is not decoded")
        out.language = "PCL XL (not little-endian binary)"
        return out
    pos = data.find(b"\n", start) + 1
    n = len(data)
    attrs: dict[int, int] = {}
    last: int | None = None
    pages = 0
    seen: set[tuple[str, str | None]] = set()
    try:
        while pos < n:
            tag = data[pos]
            pos += 1
            if tag in (0x00, 0x09, 0x0A, 0x0D, 0x20):
                continue
            if tag in _XL_SCALAR:
                size = _XL_SCALAR[tag]
                last = int.from_bytes(data[pos : pos + size], "little")
                pos += size
            elif 0xC8 <= tag <= 0xCD:
                size = _XL_SCALAR[tag - 8]
                length_tag = data[pos]
                lsize = _XL_SCALAR[length_tag]
                count = int.from_bytes(data[pos + 1 : pos + 1 + lsize], "little")
                pos += 1 + lsize + count * size
                last = None
            elif 0xD0 <= tag <= 0xD5:
                pos += 2 * _XL_SCALAR[tag - 16]
                last = None
            elif 0xE0 <= tag <= 0xE5:
                pos += 4 * _XL_SCALAR[tag - 32]
                last = None
            elif tag == 0xF8:
                if last is not None:
                    attrs[data[pos]] = last
                pos += 1
                last = None
            elif tag == 0xF9:
                pos += 2
                last = None
            elif tag == 0xFA:
                pos += 4 + int.from_bytes(data[pos : pos + 4], "little")
            elif tag == 0xFB:
                pos += 1 + data[pos]
            elif tag == 0x1B and data.startswith(_UEL, pos - 1):
                break
            elif 0x41 <= tag <= 0xB9:
                if tag == _XL_BEGIN_PAGE:
                    pages += 1
                    orientation = attrs.get(_ATTR_ORIENTATION)
                    if _ATTR_DUPLEX_MODE in attrs:
                        binding = attrs[_ATTR_DUPLEX_MODE]
                        label = {1: "vertical", 0: "horizontal"}.get(binding, str(binding))
                        seen.add((f"DuplexPageMode={label} orient={orientation}", paper_edge(binding, orientation)))
                    elif _ATTR_SIMPLEX_MODE in attrs:
                        seen.add(("SimplexPageMode", SIMPLEX))
                    if orientation is not None:
                        out.orientation = "landscape" if orientation in _XL_LANDSCAPE else "portrait"
                attrs = {}
                last = None
            else:
                out.complete = False
                out.notes.append(f"unknown tag 0x{tag:02x} at offset {pos - 1}")
                break
    except (IndexError, KeyError):
        out.complete = False
        out.notes.append("the stream ends inside a token")
    if pos > n:
        out.complete = False
        out.notes.append("embedded data runs past the end")
    for name, edge in sorted(seen, key=lambda item: item[0]):
        out.sources.append(Source(name, name, edge))
    out.pages = pages or None
    return out


# --- PostScript ------------------------------------------------------------


def _decode_postscript(data: bytes) -> Decoded:
    out = Decoded("PostScript")
    text = data.decode("latin-1")
    orient = re.search(r"^%%(?:Page)?Orientation:\s*(\w+)", text, re.M)
    landscape = bool(orient and orient.group(1).lower() == "landscape")
    if orient:
        out.orientation = "landscape" if landscape else "portrait"
    seen: set[tuple[str, str | None]] = set()
    for m in re.finditer(r"/Duplex\s+(true|false)(?:[^>]{0,200}?/Tumble\s+(true|false))?", text):
        duplex, tumble = m.group(1), m.group(2)
        if duplex == "false":
            seen.add(("/Duplex false", SIMPLEX))
            continue
        if tumble is None or not orient:
            seen.add((f"/Duplex true /Tumble {tumble}", None))
            continue
        long_edge = (tumble == "false") != landscape
        seen.add((f"/Duplex true /Tumble {tumble} ({out.orientation})", LONG if long_edge else SHORT))
    for name, edge in sorted(seen):
        out.sources.append(Source(name, name, edge))
    if not out.sources:
        out.notes.append("no /Duplex entry in the job")
    out.pages = len(re.findall(r"^%%Page:", text, re.M)) or None
    return out


# --- XPS print ticket ------------------------------------------------------

_TICKET_OPTION = {"TwoSidedLongEdge": LONG, "TwoSidedShortEdge": SHORT, "OneSided": SIMPLEX}
_XPS_ENTRY_LIMIT = 4_000_000


def _decode_xps(data: bytes) -> Decoded:
    out = Decoded("XPS")
    try:
        archive = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile:
        out.language = "zip (damaged)"
        return out
    seen: set[str] = set()
    for info in archive.infolist():
        if not info.filename.lower().endswith((".xml", ".ticket")):
            continue
        if info.file_size > _XPS_ENTRY_LIMIT:
            out.complete = False
            out.notes.append(f"{info.filename} is larger than {_XPS_ENTRY_LIMIT} bytes and was not read")
            continue
        try:
            body = archive.read(info).decode("utf-8", "replace")
        except (RuntimeError, NotImplementedError, zlib.error, zipfile.BadZipFile):
            out.complete = False
            out.notes.append(f"{info.filename} could not be read")
            continue
        for m in re.finditer(
            r'name="psk:JobDuplexAllDocumentsContiguously"[^>]*>\s*<[^>]*name="psk:(\w+)"', body
        ):
            seen.add(m.group(1))
    for option in sorted(seen):
        out.sources.append(Source("print ticket", option, _TICKET_OPTION.get(option)))
    if not out.sources:
        out.notes.append("no duplex feature in any print ticket")
    return out


# --- PWG raster and URF ----------------------------------------------------

_PWG_SYNC, _PWG_HEADER = b"RaS2", 1796
_PWG_DUPLEX_AT, _PWG_TUMBLE_AT, _PWG_WIDTH_AT, _PWG_HEIGHT_AT, _PWG_BPP_AT = 272, 368, 372, 376, 388
_URF_SYNC, _URF_HEADER = b"UNIRAST\x00", 32
_URF_EDGE = {1: SIMPLEX, 2: LONG, 3: SHORT}


def _skip_raster(data: bytes, pos: int, width: int, height: int, pixel: int) -> int:
    """The offset after one page of PWG raster / URF pixel data (line repeat plus packed pixels)."""
    if width <= 0 or height <= 0 or pixel <= 0:
        raise ValueError("the page header holds no usable size")
    rows = 0
    while rows < height:
        repeat = data[pos] + 1
        pos += 1
        filled = 0
        while filled < width:
            count = data[pos]
            pos += 1
            if count <= 127:
                filled += count + 1
                pos += pixel
            elif count == 128:
                filled = width
            else:
                run = 257 - count
                filled += run
                pos += run * pixel
        if filled != width or pos > len(data):
            raise ValueError("a raster line does not end at the page width")
        rows += repeat
    if rows != height:
        raise ValueError("the raster has more lines than the page height")
    return pos


def _decode_pwg_raster(data: bytes) -> Decoded:
    out = Decoded("PWG raster")
    seen: set[tuple[str, str | None]] = set()
    pos, pages = len(_PWG_SYNC), 0
    try:
        while pos < len(data):
            header = data[pos : pos + _PWG_HEADER]
            if len(header) < _PWG_HEADER or not header.startswith(b"PwgRaster\x00"):
                raise ValueError("a page header is missing or damaged")
            duplex = struct.unpack_from(">I", header, _PWG_DUPLEX_AT)[0]
            tumble = struct.unpack_from(">I", header, _PWG_TUMBLE_AT)[0]
            width = struct.unpack_from(">I", header, _PWG_WIDTH_AT)[0]
            height = struct.unpack_from(">I", header, _PWG_HEIGHT_AT)[0]
            bits = struct.unpack_from(">I", header, _PWG_BPP_AT)[0]
            if duplex == 0:
                seen.add(("Duplex=0", SIMPLEX))
            elif duplex == 1 and tumble in (0, 1):
                seen.add((f"Duplex=1 Tumble={tumble}", SHORT if tumble else LONG))
            else:
                seen.add((f"Duplex={duplex} Tumble={tumble}", None))
            pages += 1
            pos = _skip_raster(data, pos + _PWG_HEADER, width, height, bits // 8)
    except (IndexError, ValueError, struct.error) as exc:
        out.complete = False
        out.notes.append(f"the raster stream was not read to the end: {exc}")
    for name, edge in sorted(seen, key=lambda item: item[0]):
        out.sources.append(Source("PWG raster header", name, edge))
    out.pages = pages or None
    return out


def _decode_urf(data: bytes) -> Decoded:
    out = Decoded("URF")
    seen: set[tuple[str, str | None]] = set()
    pos, pages = len(_URF_SYNC) + 4, 0
    try:
        declared = struct.unpack_from(">I", data, len(_URF_SYNC))[0]
        while pos < len(data):
            header = data[pos : pos + _URF_HEADER]
            if len(header) < _URF_HEADER:
                raise ValueError("a page header is cut short")
            bits, _color, duplex = header[0], header[1], header[2]
            width, height = struct.unpack_from(">II", header, 12)
            seen.add((f"DuplexMode={duplex}", _URF_EDGE.get(duplex)))
            pages += 1
            pos = _skip_raster(data, pos + _URF_HEADER, width, height, bits // 8)
        if pages != declared:
            out.complete = False
            out.notes.append(f"the file header names {declared} pages, {pages} were read")
    except (IndexError, ValueError, struct.error) as exc:
        out.complete = False
        out.notes.append(f"the raster stream was not read to the end: {exc}")
    for name, edge in sorted(seen, key=lambda item: item[0]):
        out.sources.append(Source("URF page header", name, edge))
    out.pages = pages or None
    return out


# --- IPP job attributes ----------------------------------------------------

_IPP_SIDES = {"one-sided": SIMPLEX, "two-sided-long-edge": LONG, "two-sided-short-edge": SHORT}
_IPP_ORIENTATION = {3: "portrait", 4: "landscape", 5: "landscape", 6: "portrait"}
_IPP_SHOWN = ("orientation-requested", "media", "copies", "print-color-mode", "document-format")


def decode_ipp(record: dict, document: bytes | None = None) -> Decoded:
    """Read the duplex mode of an IPP job: the `sides` attribute the client sent.

    `record` is a job as `ipp_capture` saves it. A job with no `sides` attribute is
    undecodable: an absent attribute does not mean one-sided. A PWG raster or URF
    document states the mode in its page headers; those count as a source only
    when the job has no `sides`, and are otherwise shown in the notes."""
    from ipp_capture import summarize  # noqa: PLC0415  (the lab folder is on sys.path)

    out = Decoded("IPP")
    job = record.get("job_attributes", {})
    operation = record.get("operation_attributes", {})
    sides = job.get("sides") or operation.get("sides") or []
    for value in sides:
        out.sources.append(Source("IPP sides", str(value), _IPP_SIDES.get(value)))
    if not sides:
        out.notes.append("the job names no sides attribute")
    shown = summarize(record)
    orientation = shown.get("orientation-requested")
    out.orientation = _IPP_ORIENTATION.get(orientation) if isinstance(orientation, int) else None
    out.notes.append(" ".join(f"{k}={shown[k]}" for k in _IPP_SHOWN if shown.get(k) is not None))
    if document and document.startswith((_PWG_SYNC, _URF_SYNC)):
        nested = decode(document)
        out.pages = nested.pages
        out.complete = nested.complete
        out.notes.extend(nested.notes)
        header = "; ".join(f"{s.name} {s.raw}" for s in nested.sources)
        if sides:
            differs = nested.edges() and nested.edges() != out.edges()
            out.notes.append(
                f"document {nested.language}: {header}"
                + ("; the header names a different edge than sides, which the lab compares" if differs else "")
            )
        else:
            out.sources.extend(nested.sources)
    return out


# --- entry point -----------------------------------------------------------


def decode(data: bytes) -> Decoded:
    """Decode one job. The language comes from the bytes, not from a name."""
    if data.startswith(b"PK\x03\x04"):
        return _decode_xps(data)
    if data.startswith(_PWG_SYNC):
        return _decode_pwg_raster(data)
    if data.startswith(_URF_SYNC):
        return _decode_urf(data)
    if data.startswith(b"%PDF"):
        d = Decoded("PDF")
        d.notes.append("a PDF carries no printer duplex setting")
        return d
    pjl, offset = _pjl_lines(data)
    body = data[offset:]
    sources = _pjl_duplex(pjl)
    language = None
    for line in pjl:
        m = re.match(r"@PJL\s+ENTER\s+LANGUAGE\s*=\s*(\S+)", line, re.I)
        if m:
            language = m.group(1).upper()
    if b") HP-PCL XL" in body[:200] or language in ("PCLXL", "PCL6"):
        out = _decode_pclxl(body)
    elif body.lstrip().startswith(b"%!PS") or language == "POSTSCRIPT":
        out = _decode_postscript(body)
    elif body.startswith((b"\x1bE", b"\x1b&", b"\x1b%")) or language == "PCL":
        out = _decode_pcl5(body)
    else:
        out = Decoded(f"unknown ({language or 'no PJL language'})")
        out.notes.append(f"first bytes {body[:12].hex(' ')}")
    out.sources = sources + out.sources
    if sources:
        out.notes.append("PJL names the duplex mode")
    return out
