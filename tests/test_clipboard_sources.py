"""What a Windows clipboard hands over, through the shipped Create PDF door.

P35's clipboard half adds NO engine arm: the Rust side writes the payload to a
scratch file whose extension the engine already accepts, and everything below
is the proof that each of those four shapes really does convert. So the pins
here are about PAYLOADS, not about a new module.

Three of them were measured before a line of product code was written
(`p35-clipboard-probe.local.py`):

* a packed `CF_DIB` is exactly a headerless `.dib`, Pillow reads it, and
  `biXPelsPerMeter` reaches the page size — including the 0 that most
  applications write, which must fall to the default rather than produce a
  page metres across;
* clipboard text written as UTF-8 survives every script this app ships fonts
  for;
* a clipboard HTML fragment referencing a REMOTE image must not fetch it,
  while an inline `data:` image must still render. Headless LibreOffice
  reaches the network for a remote reference unless its profile is seeded;
  `test_soffice.py` pins that for a converted document, and a pasted fragment
  is a different input class, so it is pinned again here — mutation-verified
  against an unseeded profile exactly the same way.
"""

from __future__ import annotations

import base64
import http.server
import io
import shutil
import struct
import subprocess
import tempfile
import threading
import time
from pathlib import Path

import pikepdf
import pytest

from engine.create_pdf import create_pdf, image_to_pdf
from engine.extract_text import extract_text
from engine.soffice import to_pdf

REPO = Path(__file__).resolve().parent.parent
SOFFICE = REPO / "resources" / "libreoffice" / "program" / "soffice.exe"
TOKEN = "CLIP-9713"

needs_soffice = pytest.mark.skipif(
    not SOFFICE.is_file(), reason="vendored LibreOffice not provisioned"
)


def packed_dib(width: int, height: int, dpi: int | None) -> bytes:
    """A 24-bit bottom-up packed DIB — byte for byte what `CF_DIB` carries.

    No `BITMAPFILEHEADER`: the clipboard format begins at the
    `BITMAPINFOHEADER`, which is also what a headerless `.dib` file is.
    """
    ppm = 0 if dpi is None else int(round(dpi / 0.0254))
    stride = ((width * 3 + 3) // 4) * 4
    bits = bytearray()
    for y in range(height):
        row = bytearray()
        for x in range(width):
            row += bytes((0, 128, 255)) if (x + y) % 2 else bytes((255, 0, 0))
        row += b"\x00" * (stride - len(row))
        bits += row
    header = struct.pack(
        "<IiiHHIIiiII", 40, width, height, 1, 24, 0, len(bits), ppm, ppm, 0, 0
    )
    return bytes(header) + bytes(bits)


class TestClipboardImage:
    def test_a_packed_dib_is_read_and_its_stored_dpi_sizes_the_page(self, tmp_dir):
        src = Path(tmp_dir) / "clip.dib"
        src.write_bytes(packed_dib(600, 300, 300))
        report = image_to_pdf(src, Path(tmp_dir) / "clip.pdf")
        assert report["pages"] == 1
        # 600 px at 300 dpi is 2 inches; 300 px is 1 inch.
        assert report["page_size"] == [144.0, 72.0]

    def test_a_screen_resolution_dib_produces_a_screen_sized_page(self, tmp_dir):
        src = Path(tmp_dir) / "clip96.dib"
        src.write_bytes(packed_dib(600, 300, 96))
        report = image_to_pdf(src, Path(tmp_dir) / "clip96.pdf")
        width, height = report["page_size"]
        assert 449 < width < 451
        assert 224 < height < 226

    def test_a_dib_that_stores_no_resolution_falls_to_the_default(self, tmp_dir):
        # 0 in biXPelsPerMeter is what MOST applications write. Honouring it
        # would produce a page metres across.
        src = Path(tmp_dir) / "clip0.dib"
        src.write_bytes(packed_dib(600, 300, None))
        report = image_to_pdf(src, Path(tmp_dir) / "clip0.pdf", dpi_default=200.0)
        assert report["page_size"] == [216.0, 108.0]
        assert report["dpi"] == [200.0]

    def test_a_clipboard_dib_goes_through_the_whole_create_pdf_door(self, tmp_dir):
        src = Path(tmp_dir) / "clip.dib"
        src.write_bytes(packed_dib(400, 400, 200))
        out = Path(tmp_dir) / "out.pdf"
        result = create_pdf([{"path": str(src)}], str(out))
        assert result["pages"] == 1
        assert result["sources"][0]["kind"] == "image"
        assert result["sources"][0]["converter"] == "image"

    def test_a_truncated_dib_refuses_by_name(self, tmp_dir):
        src = Path(tmp_dir) / "bad.dib"
        src.write_bytes(packed_dib(64, 64, 96)[:60])
        with pytest.raises(ValueError, match="unreadable image"):
            image_to_pdf(src, Path(tmp_dir) / "bad.pdf")

    def test_a_clipboard_png_carries_its_own_resolution(self, tmp_dir):
        from PIL import Image

        src = Path(tmp_dir) / "clip.png"
        Image.new("RGB", (600, 300), (12, 34, 56)).save(src, "PNG", dpi=(300, 300))
        report = image_to_pdf(src, Path(tmp_dir) / "clippng.pdf")
        assert report["page_size"] == [144.0, 72.0]


@needs_soffice
class TestClipboardText:
    """Clipboard text goes through the SAME arm a dropped `.txt` does.

    That is the whole reason this route was chosen over a second, engine-side
    text flow: one input, one document, whichever door it arrived through.
    """

    BODY = (
        f"{TOKEN}\r\n"
        "Accented: Rene naive uber\r\n"
        "Greek: αβγδ\r\n"
        "CJK: 日本語\r\n"
        "Hebrew: שלום\r\n"
        "Currency: € £ ¥\r\n"
    ) + "\r\n".join(f"filler line {n}" for n in range(300))

    def _convert(self, tmp_dir, data: bytes) -> Path:
        src = Path(tmp_dir) / "clip.txt"
        src.write_bytes(data)
        out = Path(tmp_dir) / "clip.pdf"
        report = to_pdf(src, out, str(SOFFICE))
        assert report["pages"] >= 2
        return out

    def test_every_script_survives_the_conversion(self, tmp_dir):
        out = self._convert(tmp_dir, self.BODY.encode("utf-8-sig"))
        text = extract_text(str(out))["text"]
        assert TOKEN in text
        assert "αβγ" in text
        assert "日本語" in text
        assert "€" in text
        # Hebrew extracts in VISUAL order, so the string does not survive a
        # naive `in` — the codepoints do, which is what "it converted" means.
        assert sum(1 for c in text if "֐" <= c <= "׿") >= 4

    def test_the_bom_the_rust_side_writes_is_not_left_in_the_document(self, tmp_dir):
        out = self._convert(tmp_dir, self.BODY.encode("utf-8-sig"))
        text = extract_text(str(out))["text"]
        assert "﻿" not in text
        assert text.lstrip().startswith(TOKEN)

    def test_a_page_of_text_becomes_a_real_paper_page(self, tmp_dir):
        out = self._convert(tmp_dir, self.BODY.encode("utf-8-sig"))
        with pikepdf.open(str(out)) as pdf:
            box = [round(float(v)) for v in pdf.pages[0]["/MediaBox"]]
        assert box == [0, 0, 612, 792]

    def test_clipboard_text_reaches_the_create_pdf_door(self, tmp_dir):
        src = Path(tmp_dir) / "note.txt"
        src.write_bytes(f"{TOKEN}\r\nsecond line\r\n".encode("utf-8-sig"))
        out = Path(tmp_dir) / "note.pdf"
        result = create_pdf(
            [{"path": str(src)}], str(out), soffice_path=str(SOFFICE)
        )
        assert result["pages"] == 1
        assert result["sources"][0]["converter"] == "libreoffice"
        assert TOKEN in extract_text(str(out))["text"]


class _Listener:
    """A real HTTP server that records every request it is asked for."""

    def __init__(self) -> None:
        self.hits: list[str] = []
        outer = self

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):  # noqa: N802
                outer.hits.append(self.path)
                png = bytes.fromhex(
                    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4"
                    "890000000a49444154789c6360000002000100fdff03fd0000000049454e44ae426082"
                )
                self.send_response(200)
                self.send_header("Content-Type", "image/png")
                self.send_header("Content-Length", str(len(png)))
                self.end_headers()
                self.wfile.write(png)

            def log_message(self, *args):  # noqa: A003
                pass

        self.server = http.server.HTTPServer(("127.0.0.1", 0), Handler)
        self.port = self.server.server_address[1]

    def __enter__(self):
        threading.Thread(target=self.server.serve_forever, daemon=True).start()
        return self

    def __exit__(self, *exc):
        time.sleep(0.4)  # let a late request land before the count is read
        self.server.shutdown()
        self.server.server_close()


def _inline_png() -> str:
    from PIL import Image

    buf = io.BytesIO()
    Image.new("RGB", (32, 32), (220, 20, 60)).save(buf, "PNG")
    return base64.b64encode(buf.getvalue()).decode("ascii")


def clipboard_fragment(directory: Path, port: int) -> Path:
    """The document the Rust side writes for a `CF_HTML` payload: the
    fragment, wrapped, with an explicit charset and NO base href."""
    path = directory / "clip.html"
    path.write_text(
        "<!DOCTYPE html>\n<html><head><meta charset=\"utf-8\"></head>\n<body>\n"
        f"<p style='color:#c00;font-size:18pt'><b>{TOKEN}</b></p>"
        "<table border=1><tr><th>a</th><th>b</th></tr><tr><td>1</td><td>2</td></tr></table>"
        f"<img src='data:image/png;base64,{_inline_png()}' width=64 height=64>"
        f"<img src='http://127.0.0.1:{port}/remote.png' width=32 height=32>"
        "<p>Accented: Rene — CJK: 日本語</p>"
        "\n</body></html>\n",
        encoding="utf-8",
    )
    return path


@needs_soffice
class TestClipboardHtml:
    def test_a_pasted_fragment_converts_and_keeps_its_content(self, tmp_dir):
        with _Listener() as listener:
            src = clipboard_fragment(Path(tmp_dir), listener.port)
            out = Path(tmp_dir) / "clip.pdf"
            report = to_pdf(src, out, str(SOFFICE))
        assert report["pages"] >= 1
        text = extract_text(str(out))["text"]
        assert TOKEN in text
        assert "日本語" in text

    def test_an_inline_data_uri_image_survives(self, tmp_dir):
        with _Listener() as listener:
            src = clipboard_fragment(Path(tmp_dir), listener.port)
            out = Path(tmp_dir) / "clip.pdf"
            to_pdf(src, out, str(SOFFICE))
        with pikepdf.open(str(out)) as pdf:
            images = sum(
                len((page.get("/Resources") or {}).get("/XObject") or {})
                for page in pdf.pages
            )
        # Exactly the inline one: a copied selection that plainly had a
        # picture in it must produce a document with the picture in it.
        assert images == 1

    def test_a_remote_reference_in_a_pasted_fragment_is_NOT_fetched(self, tmp_dir):
        with _Listener() as listener:
            src = clipboard_fragment(Path(tmp_dir), listener.port)
            to_pdf(src, Path(tmp_dir) / "clip.pdf", str(SOFFICE))
        assert listener.hits == [], listener.hits

    def test_the_same_fragment_DOES_reach_out_without_the_seed(self, tmp_dir):
        """The mutation control, in the file, so the pin above cannot rot.

        If this stops recording a hit, the test above has stopped proving
        anything and both need re-deriving.
        """
        with _Listener() as listener:
            src = clipboard_fragment(Path(tmp_dir), listener.port)
            out_dir = Path(tmp_dir) / "bare"
            out_dir.mkdir()
            profile = Path(tempfile.mkdtemp(prefix="lo-unseeded-clip-"))
            try:
                subprocess.run(
                    [
                        str(SOFFICE),
                        f"-env:UserInstallation={profile.as_uri()}",
                        "--headless",
                        "--norestore",
                        "--convert-to",
                        "pdf",
                        "--outdir",
                        str(out_dir),
                        str(src),
                    ],
                    capture_output=True,
                    stdin=subprocess.DEVNULL,
                    timeout=300,
                )
            finally:
                shutil.rmtree(profile, ignore_errors=True)
        assert listener.hits, "an UNSEEDED profile no longer reaches out — re-measure"

    def test_a_pasted_fragment_reaches_the_create_pdf_door(self, tmp_dir):
        with _Listener() as listener:
            src = clipboard_fragment(Path(tmp_dir), listener.port)
            out = Path(tmp_dir) / "out.pdf"
            result = create_pdf(
                [{"path": str(src)}], str(out), soffice_path=str(SOFFICE)
            )
        assert listener.hits == [], listener.hits
        assert result["pages"] >= 1
        assert result["sources"][0]["kind"] == "office"


@needs_soffice
class TestMixedClipboardList:
    def test_a_pasted_image_and_a_pasted_note_assemble_in_order(self, tmp_dir):
        image = Path(tmp_dir) / "clip.dib"
        image.write_bytes(packed_dib(400, 200, 200))
        note = Path(tmp_dir) / "clip.txt"
        note.write_bytes(f"{TOKEN}\r\n".encode("utf-8-sig"))
        out = Path(tmp_dir) / "both.pdf"
        result = create_pdf(
            [{"path": str(image)}, {"path": str(note)}],
            str(out),
            soffice_path=str(SOFFICE),
        )
        assert result["pages"] == 2
        assert [row["kind"] for row in result["sources"]] == ["image", "office"]
        with pikepdf.open(str(out)) as pdf:
            first = [round(float(v)) for v in pdf.pages[0]["/MediaBox"]]
        # The pasted image keeps its own DPI-derived geometry; the note takes
        # LibreOffice's paper. `auto` is the default for exactly this reason.
        assert first == [0, 0, 144, 72]
