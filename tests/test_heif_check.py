"""A cut-off HEIF file is imported and reported; a whole one is not reported."""
from __future__ import annotations

import struct
from pathlib import Path

import pytest

from engine import create_pdf as create_pdf_mod
from engine.batch_ocr import _file_line
from engine.create_pdf_folders import create_pdf_folders
from engine.guided_actions import run_action
from engine.create_pdf import create_pdf, image_to_pdf
from engine.heif_check import is_cut_off

CORPUS = Path(__file__).resolve().parent / "fixtures" / "heif"
FIXTURES = sorted(CORPUS.glob("*.heic"))


def _box(kind: bytes, payload: bytes) -> bytes:
    return struct.pack(">I4s", 8 + len(payload), kind) + payload


def _heif(tmp_path: Path, data: bytes, name: str = "x.heic") -> Path:
    path = tmp_path / name
    path.write_bytes(data)
    return path


def _cut(tmp_path: Path, fraction: float = 0.6, source: str = "grid-tiled.heic") -> Path:
    data = (CORPUS / source).read_bytes()
    return _heif(tmp_path, data[: int(len(data) * fraction)], "cut.heic")


@pytest.mark.parametrize("path", FIXTURES, ids=lambda p: p.name)
def test_a_whole_file_is_not_cut_off(path: Path) -> None:
    assert not is_cut_off(path)


@pytest.mark.parametrize("path", FIXTURES, ids=lambda p: p.name)
def test_a_file_that_lost_its_last_byte_is_cut_off(path: Path, tmp_path: Path) -> None:
    assert is_cut_off(_heif(tmp_path, path.read_bytes()[:-1]))


def test_a_file_cut_in_the_middle_is_cut_off(tmp_path: Path) -> None:
    assert is_cut_off(_cut(tmp_path))


def test_bytes_a_camera_appends_after_the_data_are_not_damage(tmp_path: Path) -> None:
    whole = (CORPUS / "rgb8.heic").read_bytes()
    for tail in (b"\x01\x02\x03", struct.pack(">I4s", 999_999, b"SEFT") + b"trailer"):
        assert not is_cut_off(_heif(tmp_path, whole + tail)), tail


def test_an_item_that_points_past_the_end_is_found_when_every_box_is_whole(tmp_path: Path) -> None:
    # iloc version 0, 4-byte offsets and lengths, one item with one extent.
    iloc = bytes([0, 0, 0, 0, 0x44, 0x00]) + struct.pack(">HHHHII", 1, 1, 0, 1, 0, 5000)
    meta = _box(b"meta", bytes(4) + _box(b"iloc", iloc))
    ftyp = _box(b"ftyp", b"heic" + bytes(4))
    assert is_cut_off(_heif(tmp_path, ftyp + meta))
    assert not is_cut_off(_heif(tmp_path, ftyp + meta + bytes(5000)))


@pytest.mark.parametrize(
    "data",
    [
        b"",
        b"\x00\x00",
        b"\x89PNG\r\n\x1a\n" + bytes(40),
        _box(b"ftyp", b"avif" + bytes(4)) + struct.pack(">I4s", 4000, b"mdat"),
        _box(b"ftyp", b"heic" + bytes(4)) + struct.pack(">I4s", 4, b"mdat"),
        _box(b"ftyp", b"heic" + bytes(4)) + struct.pack(">I4s", 1, b"mdat"),
        _box(b"ftyp", b"heic" + bytes(4)) + _box(b"meta", bytes(4) + _box(b"iloc", b"\x00\x00\x00\x00\x44")),
    ],
    ids=["empty", "two bytes", "png", "avif", "box smaller than its header", "short large size", "short iloc"],
)
def test_other_and_malformed_input_is_left_to_the_decoder(data: bytes, tmp_path: Path) -> None:
    assert not is_cut_off(_heif(tmp_path, data))


def test_a_missing_file_is_not_reported(tmp_path: Path) -> None:
    assert not is_cut_off(tmp_path / "absent.heic")


def test_random_damage_never_raises(tmp_path: Path) -> None:
    import random

    rng = random.Random(20261128)
    data = (CORPUS / "multi-3.heic").read_bytes()
    for _ in range(600):
        changed = bytearray(data[: rng.randrange(1, len(data) + 1)])
        for _ in range(rng.randrange(0, 6)):
            changed[rng.randrange(len(changed))] = rng.randrange(256)
        assert is_cut_off(_heif(tmp_path, bytes(changed))) in (True, False)


def test_a_cut_off_picture_is_still_imported_and_says_so(tmp_path: Path) -> None:
    assert create_pdf_mod._register_heif()
    source = _cut(tmp_path)
    report = image_to_pdf(source, tmp_path / "out.pdf")
    assert report["incomplete"] is True and report["pages"] == 1
    assert (tmp_path / "out.pdf").stat().st_size > 0
    assert source.read_bytes() == _cut(tmp_path).read_bytes()
    assert "incomplete" not in image_to_pdf(CORPUS / "rgb8.heic", tmp_path / "whole.pdf")


def test_create_pdf_names_the_cut_off_source_and_its_pages(tmp_path: Path) -> None:
    cut = _cut(tmp_path)
    built = create_pdf(
        [{"path": str(CORPUS / "multi-3.heic")}, {"path": str(cut)}, {"path": str(CORPUS / "rgb8.heic")}],
        str(tmp_path / "all.pdf"),
    )
    assert built["incomplete"] == [{"path": str(cut), "pages": "4"}]
    assert "warnings" not in built
    assert [row.get("incomplete", False) for row in built["sources"]] == [False, True, False]


def test_create_pdf_leaves_the_key_out_for_whole_sources(tmp_path: Path) -> None:
    built = create_pdf([{"path": str(CORPUS / "rgb8.heic")}], str(tmp_path / "one.pdf"))
    assert "incomplete" not in built


def test_a_source_with_several_pages_reports_a_range() -> None:
    rows = [{"path": "a", "pages": 2}, {"path": "b", "pages": 3, "incomplete": True},
            {"path": "c", "pages": 0, "incomplete": True}, {"path": "d", "pages": 1, "incomplete": True}]
    assert create_pdf_mod._incomplete_sources(rows) == [
        {"path": "b", "pages": "3-5"}, {"path": "d", "pages": "6"}]


def _cut_tree(tmp_path: Path) -> Path:
    source = tmp_path / "in" / "set"
    source.mkdir(parents=True)
    data = (CORPUS / "grid-tiled.heic").read_bytes()
    (source / "b-cut.heic").write_bytes(data[: int(len(data) * 0.6)])
    (source / "a-whole.heic").write_bytes((CORPUS / "rgb8.heic").read_bytes())
    return tmp_path / "in"


def test_the_folder_run_and_its_log_name_the_cut_off_file(tmp_path: Path) -> None:
    report = create_pdf_folders(
        str(_cut_tree(tmp_path)), str(tmp_path / "out"), log_dir=str(tmp_path / "log"), write_log=True
    )
    [row] = report["results"]
    assert [(Path(i["path"]).name, i["pages"]) for i in row["incomplete"]] == [("b-cut.heic", "2")]
    log = Path(report["log_path"]).read_text(encoding="utf-8")
    assert "b-cut.heic (PDF pages: 2): the file is cut off" in log
    assert "a-whole.heic" not in log


def test_a_guided_action_that_creates_the_pdf_reports_the_cut_off_file(tmp_path: Path) -> None:
    report = run_action(
        str(_cut_tree(tmp_path)), str(tmp_path / "out"),
        [{"op": "create_pdf_folders", "params": {"sources": "images", "include_subfolders": True}}],
        action_name="scan sets", log_dir=str(tmp_path / "log"), write_log=True,
    )
    [row] = report["results"]
    assert row["status"] == "ok"
    assert [Path(i["path"]).name for i in row["incomplete"]] == ["b-cut.heic"]
    assert "b-cut.heic (PDF pages: 2): the file is cut off" in Path(report["log_path"]).read_text(encoding="utf-8")


def test_the_watermark_report_says_the_picture_is_cut_off(tmp_path: Path) -> None:
    import pikepdf

    from engine.watermark import watermark

    page = tmp_path / "page.pdf"
    with pikepdf.new() as pdf:
        pdf.add_blank_page()
        pdf.save(page)
    cut = watermark(str(page), str(tmp_path / "cut.pdf"), image=str(_cut(tmp_path)))
    whole = watermark(str(page), str(tmp_path / "whole.pdf"), image=str(CORPUS / "rgb8.heic"))
    assert cut["image_incomplete"] is True and whole["image_incomplete"] is False


def test_the_batch_log_line_says_it() -> None:
    line = _file_line({"status": "ocr", "rel": "x.heic", "pagesOcrd": 1, "incomplete": True})
    assert line.endswith("[the file is cut off; parts of the picture can be missing or wrong]")
    assert "cut off" not in _file_line({"status": "ocr", "rel": "x.heic", "pagesOcrd": 1})
