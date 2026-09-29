"""Engine temps are never sources, carry the reclaimable stage name, and a
cancel inside MRC or scan enhancement stops at the next page."""

import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pikepdf
import pytest
from PIL import Image

import engine.batch_ocr as batch_mod
import engine.enhance_scan as enhance_mod
import engine.mrc as mrc_mod
from engine.batch_ocr import _list_sources, batch_ocr
from engine.create_pdf import image_to_pdf
from engine.create_pdf_folders import list_source_folders
from engine.inplace import is_spectra_temp_name
from engine.ipc import RequestCancelled, serving


def _dead_pid() -> int:
    proc = subprocess.Popen([sys.executable, "-c", "pass"], stdin=subprocess.DEVNULL)
    proc.wait()
    return proc.pid


def _pdf(path: Path, pages: int = 1) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    pdf = pikepdf.new()
    for _ in range(pages):
        pdf.add_blank_page(page_size=(612, 792))
    pdf.save(str(path))
    pdf.close()


def _scan(path: Path, pages: int = 2) -> None:
    """A PDF of `pages` full-page raster images and nothing else."""
    parts = []
    for n in range(pages):
        png = path.parent / f"page{n}.png"
        image = Image.new("L", (850, 1100), 255)
        for x in range(100, 700, 7):
            for y in range(100 + 40 * n, 300 + 40 * n):
                image.putpixel((x, y), 0)
        image.save(png, dpi=(100, 100))
        part = path.parent / f"part{n}.pdf"
        image_to_pdf(png, part)
        parts.append(part)
        png.unlink()
    out = pikepdf.new()
    for part in parts:
        with pikepdf.open(str(part)) as src:
            out.pages.extend(src.pages)
    out.save(str(path))
    out.close()
    for part in parts:
        part.unlink()


def _stage_litter(root: Path) -> list[str]:
    return sorted(p.name for p in root.rglob("*") if is_spectra_temp_name(p.name))


def _fake_recognition(monkeypatch):
    monkeypatch.setattr(batch_mod, "_pages_needing_ocr", lambda _p, pdf: list(range(len(pdf.pages))))
    monkeypatch.setattr(batch_mod, "recognize", lambda *_a, **_k: {"words": [{"text": "w"}]})
    monkeypatch.setattr(batch_mod, "_to_pdf_rects", lambda _p, _i, words: words)

    def apply(src, out, _pages):
        with pikepdf.open(src) as pdf:
            pdf.save(out)

    monkeypatch.setattr(batch_mod, "apply_ocr_layer", apply)


# ── S-3: a leftover stage is not a source ──────────────────────────────────


def test_predicate_names_stage_and_legacy_temps():
    assert is_spectra_temp_name(".spectra-stage-123-inplace_ab.pdf")
    assert is_spectra_temp_name(".scan.pdf.inplace.tmp")
    assert is_spectra_temp_name(".scan.enhanced.tmp")
    assert not is_spectra_temp_name("scan.pdf")
    assert not is_spectra_temp_name(".hidden.pdf")


def test_batch_listing_skips_a_leftover_stage(tmp_path):
    _pdf(tmp_path / "a.pdf")
    _pdf(tmp_path / "sub" / f".spectra-stage-{_dead_pid()}-inplace_ab12.pdf")
    files, _ = _list_sources(tmp_path, images=False)
    assert [rel for _abs, rel in files] == ["a.pdf"]


def test_mirror_run_never_processes_a_leftover_stage(tmp_path, monkeypatch):
    _fake_recognition(monkeypatch)
    src, dest = tmp_path / "in", tmp_path / "out"
    _pdf(src / "a.pdf")
    stage = src / f".spectra-stage-{_dead_pid()}-zz9.pdf"
    _pdf(stage)
    report = batch_ocr(source=str(src), dest=str(dest), log_dir=str(tmp_path / "logs"))
    assert [r["rel"] for r in report["results"]] == ["a.pdf"]
    assert not (dest / stage.name).exists()


def test_create_pdf_folders_listing_skips_a_leftover_stage(tmp_path):
    _pdf(tmp_path / "doc" / "p1.pdf")
    _pdf(tmp_path / "doc" / f".spectra-stage-{_dead_pid()}-ab.pdf")
    listing = list_source_folders(str(tmp_path), sources="all")
    names = [Path(f).name for g in listing["groups"] for f in g["files"]]
    assert names == ["p1.pdf"]


# ── S-4: temps are stage-named and reclaimed ──────────────────────────────


def test_dead_pid_temps_beside_originals_are_reclaimed_at_batch_start(tmp_path, monkeypatch):
    _fake_recognition(monkeypatch)
    src = tmp_path / "in"
    _pdf(src / "sub" / "a.pdf")
    dead = src / "sub" / f".spectra-stage-{_dead_pid()}-enhanced_ab12.pdf"
    dead.write_bytes(b"torn")
    batch_ocr(source=str(src), in_place=True, log_dir=str(tmp_path / "logs"))
    assert not dead.exists()
    assert _stage_litter(src) == []


def test_batch_temps_carry_the_stage_pattern(tmp_path, monkeypatch):
    _fake_recognition(monkeypatch)
    seen: list[str] = []

    def enhance_step(path, *_a):
        seen.append(Path(path).name)
        return False, "nothing"

    monkeypatch.setattr(batch_mod, "_enhance_step", enhance_step)
    src = tmp_path / "in"
    _pdf(src / "a.pdf")
    batch_ocr(source=str(src), in_place=True, enhance=True, log_dir=str(tmp_path / "logs"))
    assert len(seen) == 1 and seen[0].startswith(".spectra-stage-")
    assert _stage_litter(src) == []


# ── S-4: cancel inside MRC and enhancement ────────────────────────────────


def _trip_after_first(monkeypatch, module, name, flag):
    real = getattr(module, name)

    def wrapped(*args, **kwargs):
        result = real(*args, **kwargs)
        flag[0] = True
        return result

    monkeypatch.setattr(module, name, wrapped)


def test_cancel_stops_mrc_at_the_next_page(tmp_path, monkeypatch):
    src = tmp_path / "scan.pdf"
    _scan(src)
    monkeypatch.setattr(mrc_mod.gs_capability, "require", lambda p: SimpleNamespace(path=p))
    flag = [False]
    _trip_after_first(monkeypatch, mrc_mod, "_lift_image", flag)
    lifted = []
    real_segment = mrc_mod.segment
    monkeypatch.setattr(mrc_mod, "segment", lambda *a, **k: (lifted.append(1), real_segment(*a, **k))[1])
    with serving(lambda: flag[0]):
        with pytest.raises(RequestCancelled):
            mrc_mod.mrc_compress(str(src), str(tmp_path / "out.pdf"))
    assert len(lifted) == 1
    assert sorted(p.name for p in tmp_path.iterdir()) == ["scan.pdf"]


def test_cancel_stops_enhancement_at_the_next_page(tmp_path, monkeypatch):
    src = tmp_path / "scan.pdf"
    _scan(src)
    flag = [False]
    calls = []
    real = enhance_mod._measure

    def measure(*args, **kwargs):
        calls.append(1)
        flag[0] = True
        return real(*args, **kwargs)

    monkeypatch.setattr(enhance_mod, "_measure", measure)
    with serving(lambda: flag[0]):
        with pytest.raises(RequestCancelled):
            enhance_mod.enhance_scan(str(src), str(tmp_path / "out.pdf"), orientation=False)
    assert len(calls) == 1
    assert sorted(p.name for p in tmp_path.iterdir()) == ["scan.pdf"]


@pytest.mark.parametrize("earlier_output", [False, True])
def test_cancel_inside_mrc_stops_the_batch_and_keeps_a_valid_output(
    tmp_path, monkeypatch, earlier_output
):
    _fake_recognition(monkeypatch)

    def compress(_src, _dest, **_kw):
        raise RequestCancelled()

    monkeypatch.setattr(batch_mod, "compress", compress)
    src, dest = tmp_path / "in", tmp_path / "out"
    _pdf(src / "a.pdf")
    _pdf(src / "b.pdf")
    if earlier_output:
        _pdf(dest / "a.pdf", pages=3)
    report = batch_ocr(source=str(src), dest=str(dest), mrc=True,
                       log_dir=str(tmp_path / "logs"))
    assert report["cancelled"] is True
    assert report["results"] == []
    with pikepdf.open(str(dest / "a.pdf")) as out:
        assert len(out.pages) == 1
    assert not (dest / "b.pdf").exists()
    assert _stage_litter(tmp_path) == []


@pytest.mark.parametrize("earlier_output", [False, True])
def test_cancel_inside_enhancement_stops_the_batch(tmp_path, monkeypatch, earlier_output):
    _fake_recognition(monkeypatch)

    def enhance(*_a, **_kw):
        raise RequestCancelled()

    monkeypatch.setattr(batch_mod, "enhance_scan", enhance)
    src, dest = tmp_path / "in", tmp_path / "out"
    _pdf(src / "a.pdf")
    if earlier_output:
        _pdf(dest / "a.pdf", pages=3)
    report = batch_ocr(source=str(src), dest=str(dest), enhance=True,
                       log_dir=str(tmp_path / "logs"))
    assert report["cancelled"] is True
    assert report["results"] == []
    if earlier_output:
        with pikepdf.open(str(dest / "a.pdf")) as out:
            assert len(out.pages) == 3
    else:
        assert not (dest / "a.pdf").exists()
    assert _stage_litter(tmp_path) == []


def test_cancel_during_repair_only_stops_the_batch(tmp_path, monkeypatch):
    flag = [False]

    def repair(_src, _dest):
        flag[0] = True
        return {"damaged": False}

    monkeypatch.setattr(batch_mod, "repair", repair)
    src, dest = tmp_path / "in", tmp_path / "out"
    _pdf(src / "a.pdf")
    _pdf(src / "b.pdf")
    with serving(lambda: flag[0]):
        report = batch_ocr(source=str(src), dest=str(dest), repair_only=True,
                           log_dir=str(tmp_path / "logs"))
    assert report["cancelled"] is True
    assert report["results"] == []
    assert not (dest / "a.pdf").exists() and not (dest / "b.pdf").exists()
    assert _stage_litter(tmp_path) == []
