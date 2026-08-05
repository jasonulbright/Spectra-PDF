"""P22 slice B — the hardened LibreOffice runner (brief 41 § 9 B, § 10).

Three things here are pins on MEASURED defects rather than on design:

* the conversion must not touch the network (headless soffice fetched a remote
  resource referenced by a converted document — reproduced against a live local
  listener, and reproduced AGAIN in this file as the mutation control);
* a zero exit code proves nothing (a zero-byte `.docx` converted "successfully"
  into a 1-page PDF);
* determinism is SEMANTIC. Two runs of one `.docx` differ in ~18 500 bytes
  (`/CreationDate` plus the two embedded font programs swapping object slots)
  and `SOURCE_DATE_EPOCH` is not honoured by this build, so a byte-identity pin
  over LibreOffice output is impossible and must never be written.

soffice-dependent tests are skip-if-absent (the gs / SoftHSM precedent).
"""

from __future__ import annotations

import http.server
import os
import shutil
import subprocess
import tempfile
import threading
import time
from pathlib import Path

import pikepdf
import pytest

from engine import soffice as soffice_mod
from engine.extract_text import extract_text
from engine.soffice import (
    OFFICE_SUFFIXES,
    PROFILE_SETTINGS,
    declared_faces,
    embedded_faces,
    is_office_source,
    seed_profile,
    substituted_faces,
    to_pdf,
    validate_source,
)

REPO = Path(__file__).resolve().parent.parent
SOFFICE = REPO / "resources" / "libreoffice" / "program" / "soffice.exe"
SOURCES = Path(__file__).resolve().parent / "fixtures" / "sources"
TOKEN = "ZQXJ-2026"

# Skip on the FILE, never on the directory: release.yml stubs `resources/`
# with EMPTY directories, so `isdir` is true where the binary is absent (the
# v1.0.18 dead-tag lesson).
needs_soffice = pytest.mark.skipif(
    not SOFFICE.is_file(), reason="vendored LibreOffice not provisioned"
)
needs_sources = pytest.mark.skipif(
    not (SOURCES / "report.docx").is_file(),
    reason="Office fixtures not built (tests/fixtures/make_sources.py)",
)


def page_boxes(path) -> list[list[float]]:
    with pikepdf.open(str(path)) as pdf:
        return [[round(float(v), 1) for v in p["/MediaBox"]] for p in pdf.pages]


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


def _remote_html(directory: Path, port: int) -> Path:
    path = directory / "net.html"
    path.write_text(
        f"<html><body><p>{TOKEN}</p>"
        f'<img src="http://127.0.0.1:{port}/probe.png" width=80 height=80>'
        f"</body></html>",
        encoding="utf-8",
    )
    return path


@needs_soffice
class TestOffline:
    def test_a_conversion_does_not_touch_the_network(self, tmp_dir):
        with _Listener() as listener:
            src = _remote_html(Path(tmp_dir), listener.port)
            result = to_pdf(src, Path(tmp_dir) / "net.pdf", str(SOFFICE))
        assert result["pages"] >= 1
        assert listener.hits == [], listener.hits

    def test_the_same_document_DOES_reach_the_network_without_the_seed(self, tmp_dir):
        """The mutation control, in the file, so the pin above cannot rot.

        Without the seeded profile this exact document makes an outbound GET.
        If this test ever stops recording a hit, the test above has stopped
        proving anything and both need re-deriving.
        """
        with _Listener() as listener:
            src = _remote_html(Path(tmp_dir), listener.port)
            out_dir = Path(tmp_dir) / "bare"
            out_dir.mkdir()
            profile = Path(tempfile.mkdtemp(prefix="lo-unseeded-"))
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

    def test_the_seed_is_written_where_soffice_reads_it(self, tmp_dir):
        profile = Path(tmp_dir) / "prof"
        seed_profile(profile)
        xcu = profile / "user" / "registrymodifications.xcu"
        assert xcu.is_file()
        body = xcu.read_text(encoding="utf-8")
        assert "BlockUntrustedRefererLinks" in body
        assert "MacroSecurityLevel" in body

    def test_the_setting_that_actually_blocks_is_present(self):
        # LinkUpdateMode is the one you would reach for by name and it does NOT
        # block (measured). Both are seeded; only one is load-bearing.
        assert 'oor:name="BlockUntrustedRefererLinks"' in PROFILE_SETTINGS
        assert "true" in PROFILE_SETTINGS
        assert 'oor:name="LinkUpdateMode"' in PROFILE_SETTINGS


@needs_soffice
@needs_sources
class TestEveryAcceptedFormatConverts:
    @pytest.mark.parametrize(
        "name",
        [
            "report.docx",
            "sheet.xlsx",
            "deck.pptx",
            "report.odt",
            "sheet.ods",
            "note.rtf",
            "note.txt",
            "data.csv",
            "page.html",
        ],
    )
    def test_it_produces_pages_carrying_the_source_text(self, tmp_dir, name):
        out = Path(tmp_dir) / (name + ".pdf")
        result = to_pdf(SOURCES / name, out, str(SOFFICE))
        assert result["pages"] >= 1
        assert result["converter"] == "libreoffice"
        assert TOKEN in extract_text(str(out))["text"]

    def test_a_presentation_keeps_its_own_slide_geometry(self, tmp_dir):
        # The page size comes from the DOCUMENT, not from a paper default:
        # 793.8 x 446.5 pt is 16:9. A converter that normalised every source to
        # Letter would silently reformat every deck it touched.
        out = Path(tmp_dir) / "deck.pdf"
        result = to_pdf(SOURCES / "deck.pptx", out, str(SOFFICE))
        assert result["pages"] == 2
        for box in page_boxes(out):
            width, height = box[2] - box[0], box[3] - box[1]
            assert width > height
            assert abs(width / height - 16 / 9) < 0.02, box


@needs_soffice
@needs_sources
class TestDeterminismIsSemantic:
    def test_two_runs_agree_on_everything_that_matters_and_differ_in_bytes(self, tmp_dir):
        first = Path(tmp_dir) / "a.pdf"
        second = Path(tmp_dir) / "b.pdf"
        r1 = to_pdf(SOURCES / "report.docx", first, str(SOFFICE))
        time.sleep(1.1)  # /CreationDate has second resolution
        r2 = to_pdf(SOURCES / "report.docx", second, str(SOFFICE))

        assert r1["pages"] == r2["pages"]
        assert page_boxes(first) == page_boxes(second)
        assert extract_text(str(first))["text"] == extract_text(str(second))["text"]
        assert embedded_faces(first) == embedded_faces(second)
        # And NOT bytes. Recorded as an assertion rather than a comment so that
        # anyone who "fixes" this into a byte pin has to delete a test that
        # says why: the two embedded font programs swap object slots run to run
        # and SOURCE_DATE_EPOCH is not honoured by this build.
        assert first.read_bytes() != second.read_bytes()


@needs_soffice
@needs_sources
class TestFontSubstitutionIsReported:
    def test_a_face_no_machine_has_is_named(self, tmp_dir):
        out = Path(tmp_dir) / "missing.pdf"
        result = to_pdf(SOURCES / "fonts-missing.docx", out, str(SOFFICE))
        assert result.get("fonts_substituted") == ["NoSuchFace9713"]

    def test_a_flat_odf_source_reports_the_same_face(self, tmp_dir):
        out = Path(tmp_dir) / "missing2.pdf"
        result = to_pdf(SOURCES / "fonts-missing.fodt", out, str(SOFFICE))
        assert result.get("fonts_substituted") == ["NoSuchFace9713"]

    @pytest.mark.parametrize(
        "name", ["report.docx", "sheet.xlsx", "deck.pptx", "report.odt", "sheet.ods", "note.rtf"]
    )
    def test_a_clean_conversion_accuses_nobody(self, tmp_dir, name):
        # The failure mode this guards is noise, not silence: reading the
        # package's font TABLE instead of its drawn runs reported four
        # substitutions on a document that used one face, and a notice that
        # cries wolf is a notice nobody reads.
        out = Path(tmp_dir) / (name + ".pdf")
        result = to_pdf(SOURCES / name, out, str(SOFFICE))
        assert "fonts_substituted" not in result, result


@needs_sources
class TestDeclaredFacesWithoutRunningSoffice:
    def test_an_odf_font_name_resolves_through_its_declaration(self):
        # `style:font-name="Lucida Sans1"` is a REFERENCE to a font-face
        # declaration whose family is "Lucida Sans". Left unresolved it named a
        # face nobody has and reported a substitution that never happened.
        faces = declared_faces(SOURCES / "report.odt")
        assert "Lucida Sans" in faces
        assert not any(name.endswith("1") for name in faces), faces

    def test_an_rtf_font_table_name_excludes_the_control_word(self):
        assert declared_faces(SOURCES / "note.rtf") == {"Liberation Serif"}

    def test_a_pptx_reads_its_SLIDES_not_its_theme(self):
        # The theme declares a minor font ("DejaVu Sans") this deck never draws
        # with; every run in it is Arial.
        assert declared_faces(SOURCES / "deck.pptx") == {"Arial"}

    def test_a_format_with_no_readable_font_data_returns_an_empty_set(self):
        assert declared_faces(SOURCES / "note.txt") == set()
        assert declared_faces(SOURCES / "page.html") == set()

    def test_a_corrupt_package_reports_nothing_rather_than_guessing(self, tmp_dir):
        bad = Path(tmp_dir) / "bad.docx"
        bad.write_bytes(b"PK\x03\x04not a real docx at all")
        assert declared_faces(bad) == set()


class TestNormalisationOfFaceNames:
    @pytest.mark.parametrize(
        "left,right",
        [
            ("Arial", "/BAAAAA+ArialMT"),
            ("Times New Roman", "TimesNewRomanPSMT"),
            ("Liberation Serif", "/CAAAAA+LiberationSerif-Bold"),
            ("Gill Sans MT", "GillSansMT"),
        ],
    )
    def test_a_family_matches_its_postscript_spelling(self, left, right):
        assert soffice_mod._normalise_face(left) == soffice_mod._normalise_face(right)

    def test_two_different_families_do_not_collapse(self):
        assert soffice_mod._normalise_face("Calibri") != soffice_mod._normalise_face(
            "DejaVuSans"
        )

    def test_a_short_name_is_not_eaten_by_the_suffix_rule(self):
        # "MT" as a whole family name must survive; the rule only strips a
        # decoration from a name long enough to still say something.
        assert soffice_mod._normalise_face("MT") == "mt"


class TestSourceRefusals:
    def test_a_missing_source_refuses_by_name(self, tmp_dir):
        with pytest.raises(ValueError, match="input file not found"):
            validate_source(Path(tmp_dir) / "nope.docx")

    def test_a_zero_byte_source_refuses_before_soffice_is_invoked(self, tmp_dir):
        # Measured: soffice returns 0 and writes a 1-page PDF from an empty
        # .docx, so the exit code cannot be the gate — this is.
        src = Path(tmp_dir) / "empty.docx"
        src.write_bytes(b"")
        with pytest.raises(ValueError, match="the input file is empty"):
            validate_source(src)

    def test_an_unaccepted_extension_refuses_and_says_what_IS_accepted(self, tmp_dir):
        src = Path(tmp_dir) / "thing.xyz"
        src.write_bytes(b"data")
        with pytest.raises(ValueError, match="LibreOffice cannot convert") as excinfo:
            validate_source(src)
        assert ".docx" in str(excinfo.value)

    def test_an_image_is_not_an_office_source(self):
        # Deliberate: LibreOffice's image import is not DPI-honest (measured),
        # so images belong to engine/create_pdf.py's own wrap.
        for suffix in (".png", ".jpg", ".tif", ".heic", ".pdf"):
            assert not is_office_source("x" + suffix)

    def test_every_accepted_suffix_is_lowercase_and_dotted(self):
        for suffix in OFFICE_SUFFIXES:
            assert suffix.startswith(".") and suffix == suffix.lower()

    def test_a_password_protected_ooxml_refuses_by_name(self, tmp_dir):
        # An encrypted OOXML package is an OLE2 compound file, not a ZIP.
        # Headless soffice cannot prompt for the password, so refusing here is
        # the only honest outcome.
        src = Path(tmp_dir) / "locked.docx"
        src.write_bytes(b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1" + b"\x00" * 512)
        with pytest.raises(ValueError, match="password-protected"):
            validate_source(src)

    def test_an_encrypted_odf_refuses_by_name(self, tmp_dir):
        import zipfile

        src = Path(tmp_dir) / "locked.odt"
        with zipfile.ZipFile(src, "w") as zf:
            zf.writestr("mimetype", "application/vnd.oasis.opendocument.text")
            zf.writestr(
                "META-INF/manifest.xml",
                '<manifest><encryption-data checksum="x"/></manifest>',
            )
        with pytest.raises(ValueError, match="password-protected"):
            validate_source(src)

    @needs_sources
    def test_an_ordinary_package_is_not_mistaken_for_an_encrypted_one(self):
        for name in ("report.docx", "sheet.xlsx", "deck.pptx", "report.odt"):
            assert validate_source(SOURCES / name).name == name


class TestOutputVerification:
    def test_a_directory_destination_refuses(self, tmp_dir):
        with pytest.raises(ValueError, match="is a directory"):
            to_pdf(SOURCES / "report.docx", Path(tmp_dir), "soffice")

    def test_an_unprovisioned_soffice_refuses_by_name(self, tmp_dir):
        with pytest.raises(RuntimeError, match="LibreOffice is not available"):
            to_pdf(SOURCES / "note.txt", Path(tmp_dir) / "o.pdf", "")
        with pytest.raises(RuntimeError, match="LibreOffice is not available at"):
            to_pdf(SOURCES / "note.txt", Path(tmp_dir) / "o.pdf", str(Path(tmp_dir) / "nope.exe"))

    def test_the_wrote_no_output_path_raises_its_own_message_not_a_NameError(
        self, tmp_dir, monkeypatch
    ):
        # It referenced `result`, a name that does not exist in the function, so
        # the honest message was UNREACHABLE — and the generated engine-message
        # table carried a row for a string that could never be raised.
        out_dir = Path(tmp_dir) / "out"
        out_dir.mkdir()
        src = Path(tmp_dir) / "in.pdf"
        src.write_bytes(b"%PDF-1.4\n")

        class FakeProc:
            pid = 4242

            def __init__(self, *args, **kwargs):
                self.returncode = 0

            def communicate(self, timeout=None):
                return ("", "soffice said something")

        monkeypatch.setattr(soffice_mod.subprocess, "Popen", FakeProc)
        with pytest.raises(RuntimeError, match="reported success but wrote no output"):
            soffice_mod.run_convert("soffice", "html", src, out_dir, ".html")

    def test_an_empty_produced_file_is_not_a_success(self, tmp_dir, monkeypatch):
        out_dir = Path(tmp_dir) / "out"
        out_dir.mkdir()
        src = Path(tmp_dir) / "in.pdf"
        src.write_bytes(b"%PDF-1.4\n")

        class FakeProc:
            pid = 99

            def __init__(self, *args, **kwargs):
                self.returncode = 0
                (out_dir / "in.html").write_bytes(b"")

            def communicate(self, timeout=None):
                return ("", "")

        monkeypatch.setattr(soffice_mod.subprocess, "Popen", FakeProc)
        with pytest.raises(RuntimeError, match="the file it wrote is empty"):
            soffice_mod.run_convert("soffice", "html", src, out_dir, ".html")

    def test_a_nonzero_exit_surfaces_soffices_own_diagnostics(self, tmp_dir, monkeypatch):
        out_dir = Path(tmp_dir) / "out"
        out_dir.mkdir()
        src = Path(tmp_dir) / "in.pdf"
        src.write_bytes(b"%PDF-1.4\n")

        class FakeProc:
            pid = 7

            def __init__(self, *args, **kwargs):
                self.returncode = 1

            def communicate(self, timeout=None):
                return ("", "source file could not be loaded")

        monkeypatch.setattr(soffice_mod.subprocess, "Popen", FakeProc)
        with pytest.raises(RuntimeError, match="source file could not be loaded"):
            soffice_mod.run_convert("soffice", "pdf", src, out_dir, ".pdf")

    @needs_soffice
    def test_a_corrupt_source_refuses_with_the_converters_reason(self, tmp_dir):
        src = Path(tmp_dir) / "corrupt.docx"
        src.write_bytes(b"PK\x03\x04not a real docx at all")
        with pytest.raises(RuntimeError, match="LibreOffice conversion failed"):
            to_pdf(src, Path(tmp_dir) / "o.pdf", str(SOFFICE))

    @needs_soffice
    @needs_sources
    def test_the_output_is_opened_and_its_pages_counted(self, tmp_dir):
        out = Path(tmp_dir) / "counted.pdf"
        result = to_pdf(SOURCES / "deck.pptx", out, str(SOFFICE))
        with pikepdf.open(str(out)) as pdf:
            assert result["pages"] == len(pdf.pages) == 2
        assert result["size_bytes"] == out.stat().st_size


class TestTheBudgetIsDerived:
    def test_a_bigger_source_gets_more_time(self, tmp_dir, monkeypatch):
        seen: list[float] = []

        class FakeProc:
            pid = 5

            def __init__(self, *args, **kwargs):
                self.returncode = 1

            def communicate(self, timeout=None):
                seen.append(timeout)
                return ("", "stop")

        monkeypatch.setattr(soffice_mod.subprocess, "Popen", FakeProc)
        out_dir = Path(tmp_dir) / "o"
        out_dir.mkdir()
        small = Path(tmp_dir) / "small.pdf"
        small.write_bytes(b"%PDF-1.4\n")
        big = Path(tmp_dir) / "big.pdf"
        big.write_bytes(b"%PDF-1.4\n" + b"\0" * (40 * 1024 * 1024))
        for src in (small, big):
            with pytest.raises(RuntimeError):
                soffice_mod.run_convert("soffice", "pdf", src, out_dir, ".pdf")
        assert seen[0] == pytest.approx(240.0, abs=1.0)
        assert seen[1] > seen[0]

    def test_the_floor_is_the_familys_own_old_constant(self, tmp_dir):
        # The defect was "too little time for a big file", never "too much for
        # a small one" — every input still gets at least what it got before.
        assert soffice_mod._BASE_SECONDS == 240.0


@needs_soffice
@needs_sources
def test_the_export_direction_still_works_through_the_shared_runner(tmp_dir, sample_pdf):
    """office_export was rewired onto this module; it must not have lost the
    bridge it needs (PDF imports as a Draw document, and the Writer filters
    cannot write one)."""
    from engine.office_export import export_document

    out = Path(tmp_dir) / "exported.docx"
    result = export_document(str(sample_pdf), str(out), "docx", str(SOFFICE))
    assert result["format"] == "docx"
    assert out.is_file() and out.stat().st_size > 0
    assert os.path.samefile(result["output"], out)
